//! Model Queue — 全Surfaceからのコマンドを単一スレッドで順序実行する。
//!
//! Static/Session の読み書きはこのキュー上でのみ行われるため、
//! ロック不要で不整合が構造的に起きない。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::engine::{EngineQueueKind, Engines};
use crate::shared_memory;
use crate::state::{MainSession, MainStore};
use crate::surface::sse::SseBroadcaster;

#[path = "model_queue/backup_handlers.rs"]
mod backup_handlers;
#[path = "model_queue/command.rs"]
mod command;
#[path = "model_queue/dispatch.rs"]
mod dispatch;
#[path = "model_queue/effect_handlers.rs"]
mod effect_handlers;
#[path = "model_queue/import_export_dispatch.rs"]
mod import_export_dispatch;
#[path = "model_queue/import_export_handlers.rs"]
mod import_export_handlers;
#[path = "model_queue/listener_dispatch.rs"]
mod listener_dispatch;
#[path = "model_queue/listener_handlers.rs"]
mod listener_handlers;
#[path = "model_queue/listener_owner_handlers.rs"]
mod listener_owner_handlers;
#[path = "model_queue/listener_sync_handlers.rs"]
mod listener_sync_handlers;
#[path = "model_queue/listener_tag_handlers.rs"]
mod listener_tag_handlers;
#[path = "model_queue/notification.rs"]
mod notification;
#[path = "model_queue/performance_dispatch.rs"]
mod performance_dispatch;
#[path = "model_queue/performance_handlers.rs"]
mod performance_handlers;
#[path = "model_queue/preset_handlers.rs"]
mod preset_handlers;
#[path = "model_queue/realtime_dispatch.rs"]
mod realtime_dispatch;
#[path = "model_queue/realtime_handlers.rs"]
mod realtime_handlers;
#[path = "model_queue/scene_dispatch.rs"]
mod scene_dispatch;
#[path = "model_queue/scene_handlers.rs"]
mod scene_handlers;
#[path = "model_queue/template_handlers.rs"]
mod template_handlers;
#[path = "model_queue/trace.rs"]
mod trace;

pub(crate) use command::{AsyncApply, AsyncWriteback, ModelCommand};
pub(super) use command::{
    BackupCommand, EffectCommand, ImportExportCommand, ListenerCommand, PerformanceCommand,
    PresetCommand, RealtimeCommand, SceneCommand, TemplateCommand,
};
pub(crate) use trace::{
    comment_superchat_jpy, current_millis, format_unix_ms_iso, parse_comment_timestamp_ms,
    stamp_comments_trace, stamp_value_trace,
};

/// Model Queue への送信ハンドル。各Surfaceがこれを保持する。
#[derive(Clone)]
pub struct ModelTx {
    tx: mpsc::UnboundedSender<ModelCommand>,
}

impl ModelTx {
    pub(crate) fn send(&self, cmd: ModelCommand) {
        if let Err(e) = self.tx.send(cmd) {
            tracing::error!("Model Queue send failed: {}", e);
        }
    }
}

/// PT-1b B 案: AnnounceStreamOwner 受信時に video_id がまだ未確定だった場合の保留領域。
/// chat-scraper の status と watch ページ fetch の race condition を吸収する。
#[derive(Debug, Clone)]
struct PendingStreamOwner {
    video_id: String,
    owner_channel_id: String,
}

/// Model Queue 本体。単一タスクで順序実行する。
pub struct ModelQueue {
    rx: mpsc::UnboundedReceiver<ModelCommand>,
    model_tx: ModelTx,
    main_store: MainStore,
    main_session: MainSession,
    engines: Engines,
    app_config: AppConfig,
    media_cache_dir: PathBuf,
    public_http_port: u16,
    /// PT-1b B 案: AnnounceStreamOwner が ConnectionStateChanged より先に
    /// 来た場合、ここに保留して次の ConnectionStateChanged で適用する。
    pending_stream_owner: Option<PendingStreamOwner>,
    /// listener DB 記録は非同期なので、同一起動中に連続したコメントへ
    /// 初見 / 再訪 / 今北タグを二重付与しないための軽量キャッシュ。
    listener_seen_in_current_stream: HashSet<String>,
    listener_seen_in_session: HashSet<String>,
    listener_current_stream_comment_counts: HashMap<String, u32>,
    listener_current_stream_superchat_amounts_jpy: HashMap<String, i64>,
    listener_last_comment_at_ms: HashMap<String, i64>,
}

impl ModelQueue {
    pub fn new(
        main_store: MainStore,
        main_session: MainSession,
        data_dir: &Path,
        plugins_dir: &Path,
        hub_version: &str,
        public_http_port: u16,
    ) -> (ModelTx, Self) {
        let (tx, rx) = mpsc::unbounded_channel();
        let model_tx = ModelTx { tx };
        let engines = Engines::new(data_dir, plugins_dir, hub_version);
        let queue = Self {
            rx,
            model_tx: model_tx.clone(),
            main_store,
            main_session,
            engines,
            app_config: AppConfig::default(),
            media_cache_dir: data_dir.join("media-cache"),
            public_http_port,
            pending_stream_owner: None,
            listener_seen_in_current_stream: HashSet::new(),
            listener_seen_in_session: HashSet::new(),
            listener_current_stream_comment_counts: HashMap::new(),
            listener_current_stream_superchat_amounts_jpy: HashMap::new(),
            listener_last_comment_at_ms: HashMap::new(),
        };

        (model_tx, queue)
    }

    /// 初期ロード: シーンデータをディスクから読み込んで Store に格納する。
    /// Model Queue の run() 前に呼ぶ。
    pub fn init(&mut self, sse: &SseBroadcaster) {
        tracing::info!("ModelQueue init: starting");
        // シーンを読み込み
        self.main_store.scenes = self.engines.scene_manager.load_all();
        self.migrate_scene_template_references();

        // エフェクト定義を SceneStore に格納（EffectManager が書き込みオーナー、他エンジンは読み取り）
        self.main_store.scenes.effects = self.engines.effect_manager.effects().to_vec();
        self.main_store.scenes.effect_params = self.engines.effect_manager.build_effect_params();

        sse.push_static_update("scenes", &self.main_store.scenes);

        // Store 更新後にイベント関数を呼ぶ
        self.engines.performance.initialized();
        self.main_store.performance_engine_state = self.engines.performance.state();
        shared_memory::publish_performance_engine_state(self.main_store.performance_engine_state);
        sse.push_static_update(
            "performanceEngineState",
            &self.main_store.performance_engine_state,
        );

        // app-config.json から軽量設定を復元
        tracing::info!("ModelQueue init: loading app-config");
        let data_dir = self
            .engines
            .scene_manager
            .scenes_dir()
            .parent()
            .unwrap_or(Path::new("."));
        if let Some(config) = load_app_config(data_dir) {
            self.app_config = config;
            if let Some(saved_scene_id) = self.app_config.active_scene_id.clone() {
                if self.main_store.scenes.scenes.contains_key(&saved_scene_id) {
                    self.main_store.scenes.active_scene_id = Some(saved_scene_id);
                }
            }
            if let Some(current_preset) = self.app_config.current_preset.clone() {
                if self.engines.preset_manager.has_preset(&current_preset) {
                    self.engines
                        .preset_manager
                        .set_current_preset(&current_preset);
                }
            }
            // 2026-05-09 仕様変更: 演出フィルタは撤廃。hidden_listeners は UI 表示抑制のみ
            // (= 配信者が視認したくない人を演出から除外しない設計、相手に気付かれない)。
            // コメリスト非表示分は SseBroadcaster に snapshot を渡し、/api/comments 取り出し時に filter させる。
            sse.set_hidden_for_comments(
                self.app_config
                    .hidden_listeners
                    .iter()
                    .filter(|u| u.hide_from_comments)
                    .map(|u| u.id.trim_start_matches("yt-").to_string())
                    .collect(),
            );
            if let Some(global_cooldown) = self.app_config.global_cooldown.as_ref() {
                self.engines.performance.set_global_cooldown(
                    global_cooldown.max_effects,
                    global_cooldown.user_interval,
                );
            }
            if let Some(backups_dir) = self
                .app_config
                .backups_dir
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                self.engines
                    .backup_manager
                    .set_backups_dir(Path::new(backups_dir));
            }
            // listener classification (= 新参境界 / 古参境界 / 活動条件) を listener_manager にも通知
            // SQL 計算で使う (新規 / 新参 / 常連 / 古参 / 復帰 の境界)
            if let Some(lc) = self.app_config.listener_classification.as_ref() {
                if let Some(mgr) = self.engines.listener_manager.as_ref() {
                    mgr.set_classification_thresholds(
                        lc.newcomer_first_seen_days,
                        lc.veteran_first_seen_days,
                        lc.regular_stream_window as u32,
                        lc.regular_min_streams as u32,
                    );
                }
            }
        }

        // Step 3: 自チャンネル設定一覧を listeners.db の owner_channels テーブルから load
        if let Some(listener_mgr) = self.engines.listener_manager.as_ref() {
            match listener_mgr.get_owner_channels() {
                Ok(channels) if !channels.is_empty() => {
                    let ids: Vec<String> = channels.iter().map(|c| c.channel_id.clone()).collect();
                    tracing::info!(
                        "Loaded configured owner channels ({}): {:?}",
                        ids.len(),
                        ids
                    );
                    self.main_store.configured_owner_channel_ids = ids;
                }
                Ok(_) => {
                    tracing::info!(
                        "No configured owner channels (Step 3 リスナー記録は自チャンネル設定後に有効化)"
                    );
                }
                Err(err) => {
                    tracing::warn!("Failed to load configured_owner_channel_ids: {}", err);
                }
            }
        }

        // run_tts_queue / enqueue_comment が読みに来る最新 TTS 設定を初期化する。
        tracing::info!("ModelQueue init: initializing TTS / notification settings");
        let initial_tts = crate::tts::normalize_settings(self.app_config.tts.clone());
        crate::tts::update_current_settings(initial_tts);

        // 通知設定も同様に CURRENT_NOTIFICATION_SETTINGS を初期化する (Phase C)。
        // paused は memory (= NOTIFICATION_PAUSED AtomicBool) で持つようになったので、
        // ハブ起動時点で自然と false (= AtomicBool 初期値)。 settings 側に paused field を
        // 強制 false で書き込む必要はもうない (= 永続化撤去)。
        let initial_notification =
            crate::notification_settings::normalize(self.app_config.notification.clone());
        self.app_config.notification = Some(initial_notification.clone());
        crate::notification_settings::update_current_settings(initial_notification);
        self.save_app_config();

        tracing::info!("Model Queue initialized");
    }

    fn template_identifier_matches(
        template: &crate::state::scene::SceneTemplate,
        identifier: &str,
    ) -> bool {
        template.id == identifier || template.name == identifier
    }

    fn build_template_config_from_parts(
        settings: &std::collections::HashMap<String, serde_json::Value>,
        scene_enabled: bool,
        templates_enabled: bool,
        template_enabled: bool,
    ) -> serde_json::Value {
        let mut config = serde_json::to_value(settings).unwrap_or_default();
        if let Some(obj) = config.as_object_mut() {
            obj.insert(
                "sceneVisible".to_string(),
                serde_json::json!(scene_enabled && templates_enabled && template_enabled),
            );
        }
        config
    }

    fn apply_connection_state_changed(
        connection: &mut crate::state::connection::ConnectionState,
        pending_stream_owner: &mut Option<PendingStreamOwner>,
        connected: bool,
        video_id: Option<String>,
    ) {
        let video_id_changed = connection.video_id != video_id;
        if video_id_changed {
            connection.current_stream_owner_channel_id = None;
        }
        connection.connected = connected;
        connection.video_id = video_id;

        if let Some(pending) = pending_stream_owner.take() {
            let new_video_id = connection.video_id.as_deref();
            if new_video_id == Some(pending.video_id.as_str()) {
                connection.current_stream_owner_channel_id = Some(pending.owner_channel_id);
                tracing::info!(
                    "Applied pending stream owner channel id (video_id={})",
                    pending.video_id
                );
            } else if !video_id_changed {
                *pending_stream_owner = Some(pending);
            }
        }
    }

    fn apply_stream_owner_announcement(
        connection: &mut crate::state::connection::ConnectionState,
        pending_stream_owner: &mut Option<PendingStreamOwner>,
        video_id: String,
        owner_channel_id: String,
    ) -> bool {
        if connection.video_id.as_deref() == Some(video_id.as_str()) {
            connection.current_stream_owner_channel_id = Some(owner_channel_id);
            *pending_stream_owner = None;
            true
        } else {
            tracing::debug!(
                "AnnounceStreamOwner pending (current video_id={:?}, announced={})",
                connection.video_id,
                video_id
            );
            *pending_stream_owner = Some(PendingStreamOwner {
                video_id,
                owner_channel_id,
            });
            false
        }
    }

    /// connection static-update を SSE と shared_memory の両経路に publish する。
    ///
    /// 設計: docs/architecture/remote-viewing-redesign.md §5.3
    /// remote / 本体 renderer は `isOwnStream` を見て対応済み/挨拶済みトグルの表示可否を決める。
    ///
    /// `is_own_stream` は派生値 (= configured ∋ owner) だが、ConnectionState struct の
    /// field として持ち、shared_memory layout にも同期する設計
    /// (state/connection.rs の struct doc 参照)。本 helper はその派生値を **再計算してから**
    /// MainStore.connection に書き込み、SSE と shared_memory に publish する。
    fn push_connection_status(main_store: &mut MainStore, sse: &SseBroadcaster) {
        main_store.connection.is_own_stream = Self::is_current_stream_own(main_store);
        sse.push_static_update("connection", &main_store.connection);
        shared_memory::publish_connection_state(&main_store.connection);
    }

    /// 現在接続中の配信枠が自チャンネルかどうか (= configured owner ∈ stream owner)。
    /// connection.current_stream_owner_channel_id は経路によって yt- prefix が付いたり
    /// 付かなかったり、configured_owner_channel_ids は SetOwnerChannels 時に UC のまま
    /// 保存される (= line 1247)。両方を yt- prefix を剥がした形に正規化して比較する。
    fn is_current_stream_own(main_store: &MainStore) -> bool {
        let owner = match main_store
            .connection
            .current_stream_owner_channel_id
            .as_deref()
        {
            Some(s) if !s.is_empty() => s,
            _ => return false,
        };
        let owner_uc = owner.trim_start_matches("yt-");
        main_store
            .configured_owner_channel_ids
            .iter()
            .any(|c| c.trim_start_matches("yt-") == owner_uc)
    }

    async fn handle_async_writeback(
        &mut self,
        writeback: AsyncWriteback,
        sse: &Arc<SseBroadcaster>,
    ) {
        let gate = self.engines.writeback_gate(writeback.queue);
        let _permit = gate
            .acquire_owned()
            .await
            .expect("engine writeback semaphore closed");
        self.apply_async_writeback(writeback, sse);
    }

    fn handle_connection_state_changed(
        &mut self,
        connected: bool,
        video_id: Option<String>,
        sse: &Arc<SseBroadcaster>,
    ) {
        tracing::info!(
            "connection: state changed (connected={}, video_id={:?})",
            connected,
            video_id.as_deref()
        );
        let previous_video_id = self.main_store.connection.video_id.clone();
        Self::apply_connection_state_changed(
            &mut self.main_store.connection,
            &mut self.pending_stream_owner,
            connected,
            video_id,
        );
        if self.main_store.connection.video_id != previous_video_id {
            self.listener_seen_in_current_stream.clear();
            self.listener_current_stream_comment_counts.clear();
            self.listener_current_stream_superchat_amounts_jpy.clear();
            // live_stream_stats も新枠で 0 リセット (= 切断時は video_id="" で
            // 0 のまま、別枠切替時は新 video_id で 0 から開始)。
            // stream_title もリセット (= UpdateStreamMetadata で再注入される)。
            let stats = &mut self.main_session.live_stream_stats;
            stats.video_id = self
                .main_store
                .connection
                .video_id
                .as_deref()
                .unwrap_or("")
                .to_string();
            stats.stream_title = String::new();
            stats.comment_count = 0;
            stats.superchat_amount_jpy = 0;
            // 旧枠の in-memory コメ cache を clear する。これらは初回 backfill
            // (= テンプレ SSE / わんコメ WS 接続時の recent_cloned リプレイ) の
            // ソースなので、clear しないと別枠の旧コメが新枠クライアントに
            // 漏れて見える (= 2026-05-10 検出の cross-stream 汚染)。
            // dedup スコープは per-comment-id なので clear しても問題なし。
            self.main_session.canonical_comment_store.clear();
            self.main_session.comment_timeline.clear();
            // seen_comment_ids も枠スコープ。clear しないと前枠の id 集合に
            // 引きずられて新枠の同 id (= 偶然衝突) を「処理済」扱いで skip する
            // (= 実用上ほぼ無いが、配信跨ぎでの memory 解放にも貢献)。
            self.main_session.seen_comment_ids.clear();
            // reaction_counts も累計リセット + shared_memory を 0 で publish。
            // renderer の totalReactions は data.total (= shared_memory snapshot
            // の SUM) を直接表示するため、ここで clear しないと「配信 A の累計 +
            // 配信 B の 1 件」と混入表示される (= 2026-05-10 検出)。
            self.main_session.reaction_counts.clear();
            shared_memory::publish_reaction_counts(&self.main_session.reaction_counts);
        }
        Self::push_connection_status(&mut self.main_store, sse);
    }

    fn handle_shutdown(&self) {
        tracing::info!("Model Queue shutting down");
        // SQLite WAL チェックポイント: Windows で .db-wal がロックされたまま残る
        // 問題を回避するため、shutdown 時に明示的に main DB にマージする
        if let Some(lm) = self.engines.listener_manager.as_ref() {
            match lm.checkpoint_wal() {
                Ok(_) => tracing::info!("model_queue: WAL checkpoint completed during shutdown"),
                Err(e) => tracing::warn!("WAL checkpoint failed during shutdown: {}", e),
            }
        }
    }

    fn push_scene_template_configs(
        scene_id: &str,
        scene: &crate::state::scene::Scene,
        sse: &SseBroadcaster,
        template_manager: &crate::engine::template_manager::TemplateManager,
    ) {
        for template in &scene.templates {
            let template_id = if !template.id.is_empty() {
                template.id.clone()
            } else {
                template.name.clone()
            };
            if template_id.is_empty() {
                continue;
            }
            // uiSchema 変更に追随させるため、配信前に現行 schema と reconcile する
            let ui_schema_keys = template_manager.get_template_ui_schema_keys(&template_id);
            let ui_schema_defaults = template_manager.get_template_default_settings(&template_id);
            let reconciled = crate::state::scene::reconcile_template_settings_with_ui_schema(
                &template.settings,
                &ui_schema_keys,
                &ui_schema_defaults,
            );
            let config = Self::build_template_config_from_parts(
                &reconciled,
                scene.enabled,
                scene.templates_enabled,
                template.enabled,
            );
            sse.push_template_config(scene_id, &template_id, &config);
        }
    }

    fn normalize_scene_templates(
        scene: &mut crate::state::scene::Scene,
        template_manager: &crate::engine::template_manager::TemplateManager,
    ) -> bool {
        let mut changed = false;
        for template in &mut scene.templates {
            let canonical_id = template_manager
                .resolve_template_id(&template.id)
                .or_else(|| template_manager.resolve_template_id(&template.name))
                .unwrap_or_else(|| {
                    if !template.id.is_empty() {
                        template.id.clone()
                    } else {
                        template.name.clone()
                    }
                });
            if template.id != canonical_id {
                template.id = canonical_id.clone();
                changed = true;
            }
            if template.name != canonical_id {
                template.name = canonical_id;
                changed = true;
            }
            changed |= crate::state::scene::normalize_template_settings_map_in_place(
                &mut template.settings,
            );
        }
        changed |= crate::state::scene::normalize_scene_selected_template_id(scene);
        changed
    }

    fn migrate_scene_template_references(&mut self) {
        let scene_ids: Vec<String> = self.main_store.scenes.scenes.keys().cloned().collect();
        for scene_id in scene_ids {
            let mut changed = false;
            if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                changed |= Self::normalize_scene_templates(scene, &self.engines.template_manager);
                if changed {
                    let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                }
            }
        }
    }

    fn rename_scene_template_references(
        scene: &mut crate::state::scene::Scene,
        previous_template_id: &str,
        next_template_id: &str,
    ) -> bool {
        if previous_template_id.is_empty()
            || next_template_id.is_empty()
            || previous_template_id == next_template_id
        {
            return false;
        }
        let mut changed = false;
        for template in &mut scene.templates {
            if Self::template_identifier_matches(template, previous_template_id) {
                if template.id != next_template_id {
                    template.id = next_template_id.to_string();
                    changed = true;
                }
                if template.name != next_template_id {
                    template.name = next_template_id.to_string();
                    changed = true;
                }
            }
        }
        if scene.selected_template_id == previous_template_id {
            scene.selected_template_id = next_template_id.to_string();
            changed = true;
        }
        changed |= crate::state::scene::normalize_scene_selected_template_id(scene);
        changed
    }

    /// Model Queue のメインループ。単一タスクとして起動する。
    /// 全コマンドがここで順序実行される。
    pub async fn run(mut self, sse: Arc<SseBroadcaster>) {
        // 初期ロード
        self.init(&sse);

        // 起動時の TTS provider health-check を非同期で発火
        // (voicevox/bouyomi が選ばれていれば接続確認、builtin は no-op)
        let initial_tts = crate::tts::normalize_settings(self.app_config.tts.clone());
        let provider = initial_tts
            .get("provider")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("builtin")
            .to_string();
        tokio::spawn(crate::tts::refresh_health(
            initial_tts,
            provider,
            sse.clone(),
        ));

        tracing::info!("Model Queue started");

        while let Some(cmd) = self.rx.recv().await {
            if !self.dispatch_command(cmd, &sse).await {
                break;
            }
        }

        tracing::info!("Model Queue stopped");
    }

    fn save_app_config(&mut self) {
        self.app_config.active_scene_id =
            normalize_optional_string(self.main_store.scenes.active_scene_id.as_deref());
        self.app_config.current_preset =
            normalize_optional_string(Some(self.engines.preset_manager.current_preset()));
        save_app_config(
            self.engines
                .scene_manager
                .scenes_dir()
                .parent()
                .unwrap_or(Path::new(".")),
            &self.app_config,
        );
    }

    fn handle_incoming_comments(
        &mut self,
        comments: Vec<crate::state::comment::RawComment>,
        sse: &Arc<SseBroadcaster>,
    ) {
        let batch_size = comments.len();
        if batch_size == 0 {
            return;
        }
        let started_at = std::time::Instant::now();
        tracing::debug!(
            "handle_incoming_comments: processing {} comments (vid={:?})",
            batch_size,
            self.main_store.connection.video_id.as_deref()
        );
        for mut comment in comments {
            comment.set_trace_ms("modelQueueHandleAtMs", current_millis());
            normalize_comment_for_delivery(&mut comment);
            // メンバーシップギフト (= 贈り主) に推定金額を付与する。
            // YouTube はギフト購入アナウンスに金額を載せないため、自チャンネル群の枠でのみ
            // gift_count × 単価 (= per-channel override か既定 ¥490) で推定する。受領者
            // (is_membership_gift_redemption) は贈り主が支払うので対象外 (= is_membership_gift
            // は立たない)。他チャンネル枠は集計対象外なので推定しない (= is_own_stream で gate)。
            // amount を設定すると comment_superchat_jpy 経由で live_stream_stats / KPI /
            // listener 集計 / わんコメ書き戻し (= 課金集計に gift 含む) に自動反映される。
            if comment.is_membership_gift
                && comment.gift_count > 0
                && self.main_store.connection.is_own_stream
            {
                let owner_uc = self
                    .main_store
                    .connection
                    .current_stream_owner_channel_id
                    .as_deref()
                    .map(|s| s.trim_start_matches("yt-"))
                    .unwrap_or("");
                let unit_price = match self.app_config.membership_gift_pricing.as_ref() {
                    Some(pricing) => pricing.price_for(owner_uc),
                    None => MembershipGiftPricingConfig::default().default_price_jpy,
                };
                if unit_price > 0 {
                    let amount = i64::from(comment.gift_count) * unit_price;
                    comment.amount = amount as f64;
                    comment.currency = "JPY".to_string();
                    comment.amount_display = format!(
                        "{} (推定)",
                        crate::common::superchat::format_amount_display(amount as f64, "JPY")
                    );
                    // ギフト (= 贈り主) は課金なのでスパチャと同格に扱い、推定金額帯で色を
                    // 変える。runtime は amount > 0 で .is-superchat を付け、superchatTier から
                    // tier-X class を決めるため、ここで再計算しないと tier-blue 固定になる
                    // (= 直前の normalize は amount=0 で計算していた)。
                    comment.superchat_tier = crate::common::superchat::superchat_tier_key(
                        comment.amount,
                        &comment.currency,
                        &comment.tier_color,
                    );
                }
            }
            // live_id 補完: chat-scraper.js / innertube_parser はどちらも comment payload に
            // liveId を埋めない (= 空文字のまま流入)。 そのままだと /api/comments の
            // streamVideoId filter (= public_api::get_comments) が常に 0 件を返すなど
            // 下流の不具合の原因になる。 main.js の connectChat (= line 1518-) で
            // pushConnectionState(false, videoId) を先に呼ぶ「PT-1b A 案」 により、
            // ここに到達した時点で main_store.connection.video_id は必ず確定済。
            // 受信時の現在接続枠で焼く (= backfill / record_display も同枠なので問題なし)。
            if comment.live_id.is_empty() {
                if let Some(vid) = self.main_store.connection.video_id.as_deref() {
                    comment.live_id = vid.to_string();
                }
            }
            self.annotate_listener_comment_status(&mut comment);
            // 重複検出: seen_comment_ids は枠スコープの cap-less HashSet で、
            // canonical_comment_store の eviction (cap 2000) を補完する。
            // 長時間配信 (= 累計コメ > 2000) で reconnect 時の backfill が
            // evicted 済の古い id を含むケースで、live_stream_stats /
            // comment_timeline / sse push が二重実行されるのを防ぐ
            // (= 2026-05-10 #5 調査で検出)。空 id のコメは dedup 対象外
            // (= 全件処理、責任は呼出元)。
            if !comment.id.is_empty() {
                let inserted = self
                    .main_session
                    .seen_comment_ids
                    .insert(comment.id.clone());
                if !inserted {
                    tracing::debug!(
                        "duplicate comment detected: id={}, skipping effects/tts/sse (replay only)",
                        comment.id
                    );
                    // 同一 ID の更新は副作用 (演出 / TTS / SSE / DB 記録) を再実行しない。
                    // ただし replay と runtime snapshot は最新内容に揃える。
                    self.main_session
                        .canonical_comment_store
                        .upsert(comment.clone());
                    if let Some(entry) = self.main_session.comment_timeline.update_by_id(comment) {
                        shared_memory::publish_comment_timeline_entry(
                            &entry,
                            &self.main_session.comment_timeline,
                        );
                    }
                    continue;
                }
            }
            // canonical_comment_store にも push (= recent_cloned リプレイ用)。
            self.main_session
                .canonical_comment_store
                .upsert(comment.clone());
            let entry = self.main_session.comment_timeline.push(comment.clone());
            shared_memory::publish_comment_timeline_entry(
                &entry,
                &self.main_session.comment_timeline,
            );

            // live_stream_stats: 現接続中の枠の comment count + SC 累計 JPY を in-memory で
            // 更新する。他枠 (= record_comment skip 経路) でも path 1 ephemeral push に
            // commentCount/SC を出せるようにこちらで正本を持つ。
            // 自枠でも redundant に貯まるが、path 2 (= detail.stream) は DB 集計を返すので
            // 競合しない (= renderer 側は payload の値をそのまま使う)。
            if let Some(current_video_id) = self.main_store.connection.video_id.as_deref() {
                let stats = &mut self.main_session.live_stream_stats;
                // ConnectionStateChanged 側で reset 済みのはずだが、安全側で sync (= 別枠
                // のまま increment しない)
                if stats.video_id != current_video_id {
                    stats.video_id = current_video_id.to_string();
                    stats.stream_title = String::new();
                    stats.comment_count = 0;
                    stats.superchat_amount_jpy = 0;
                }
                stats.comment_count += 1;
                stats.superchat_amount_jpy += comment_superchat_jpy(&comment);
            }

            // is_backfill (= chat-scraper の ytInitialData 由来「接続直前の過去コメ」) は
            // 演出 / TTS を skip する。過去コメで cracker が走る / 過去コメが TTS で
            // 読み上げられるのを防ぐ。それ以外 (= listener_record / SSE / テンプレ /
            // わんコメ書き戻し) は通常通り処理し、ユーザが「接続前の流れ」を画面で
            // 見られるようにする。
            if !comment.is_backfill {
                let result = self
                    .engines
                    .performance
                    .evaluate(&comment, &self.main_store.scenes);
                self.emit_performances(result.fired, sse);

                // 設定スナップショットは tts 側 (CURRENT_TTS_SETTINGS) で持つので
                // ここではフィルタの一貫性のため paused だけ反映して enqueue する。
                let tts_settings = crate::tts::normalize_settings(self.app_config.tts.clone());
                crate::tts::set_paused(
                    tts_settings
                        .get("paused")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                );
                crate::tts::enqueue_comment(&comment, sse.clone());

                // コメント通知 (Phase B〜D): 8 種イベント判定 + 設定 filter + tts enqueue。
                // is_backfill / is_template_test は通知から除外する
                // (= 過去コメ / テスト送信で通知音が鳴るのを防ぐ)。
                // stream_title はテンプレ {streamTitle} 置換用 (= 未取得時は空文字)。
                if !comment.is_template_test {
                    let stream_title = self.main_session.live_stream_stats.stream_title.as_str();
                    notification::dispatch(&comment, sse, stream_title);
                }
            }

            // Step 3: 自チャンネル判定 → listener_record_queue に投入 (フェーズ 3.1)
            // sse を渡して record 完了時に runtime event "listener-updated" を発火する
            // (フェーズ 3.2a の UI 自動更新サポート)
            self.dispatch_listener_record(&comment, sse);

            comment.set_trace_ms("sessionBroadcastAtMs", current_millis());
            sse.push_session_comment(&comment);

            // テンプレート配信: 有効な各シーンの selected template に送る
            let template_targets = self
                .main_store
                .scenes
                .scenes
                .iter()
                .filter_map(|(scene_id, scene)| {
                    tracing::debug!(
                        "Template delivery: scene={} templates_enabled={} selected={} templates={:?}",
                        scene_id,
                        scene.templates_enabled,
                        scene.selected_template_id,
                        scene.templates
                            .iter()
                            .map(|t| format!("{}:{}", t.id, t.enabled))
                            .collect::<Vec<_>>()
                    );
                    if !scene.enabled || !scene.templates_enabled {
                        return None;
                    }
                    scene.templates
                        .iter()
                        .find(|t| {
                            !scene.selected_template_id.is_empty()
                                && (t.id == scene.selected_template_id
                                    || t.name == scene.selected_template_id)
                        })
                        .map(|t| {
                            let selected_id = if !t.id.is_empty() {
                                t.id.clone()
                            } else {
                                t.name.clone()
                            };
                            (scene_id.clone(), selected_id)
                        })
                })
                .collect::<Vec<_>>();
            for (scene_id, selected_id) in template_targets {
                comment.set_trace_ms("templateBroadcastAtMs", current_millis());
                sse.push_template_comment(&scene_id, vec![selected_id], &comment);
            }
        }
        tracing::debug!(
            "handle_incoming_comments: done in {} ms (batch_size={})",
            started_at.elapsed().as_millis(),
            batch_size
        );
    }

    fn annotate_listener_comment_status(
        &mut self,
        comment: &mut crate::state::comment::RawComment,
    ) {
        comment.listener_status.clear();
        comment.listener_tag.clear();
        comment.has_prior_listener_comment = false;
        comment.is_first_comment_in_stream = false;
        comment.listener_previous_stream_last_seen_at.clear();
        comment.listener_previous_stream_last_seen_at_ms = 0;
        comment.listener_previous_comment_at.clear();
        comment.listener_previous_comment_at_ms = 0;
        comment.listener_current_stream_comment_count = 0;
        comment.listener_current_stream_superchat_amount_jpy = 0;
        comment
            .listener_current_stream_superchat_amount_display
            .clear();
        comment.listener_previous_stream_id.clear();
        comment.listener_previous_stream_title.clear();
        comment.listener_previous_stream_started_at.clear();
        comment.listener_previous_stream_started_at_ms = 0;
        comment.listener_regular_stream_count = 0;
        comment.listener_regular_window_streams = 0;
        comment.listener_regular_min_streams = 0;
        comment.is_first_time_listener = false;
        comment.is_returning_listener = false;
        comment.is_regular_listener = false;
        comment.is_regular_arrival = false;

        let manager = match self.engines.listener_manager.as_ref() {
            Some(m) => m,
            None => return,
        };
        let configured_ids = &self.main_store.configured_owner_channel_ids;
        if configured_ids.is_empty() {
            return;
        }
        let stream_owner = match self
            .main_store
            .connection
            .current_stream_owner_channel_id
            .as_deref()
        {
            Some(s) if !s.is_empty() => s,
            _ => return,
        };
        if !configured_ids.iter().any(|c| c == stream_owner) {
            return;
        }
        let video_id = match self.main_store.connection.video_id.as_deref() {
            Some(v) if !v.is_empty() => v,
            _ => return,
        };
        if comment.user_id.is_empty() {
            return;
        }

        let listener_id_yt = if comment.user_id.starts_with("yt-") {
            comment.user_id.clone()
        } else {
            format!("yt-{}", comment.user_id)
        };
        let configured_yt: Vec<String> = configured_ids
            .iter()
            .map(|id| {
                if id.starts_with("yt-") {
                    id.clone()
                } else {
                    format!("yt-{}", id)
                }
            })
            .collect();

        let listener_config = self
            .app_config
            .listener_classification
            .clone()
            .unwrap_or_default();
        let classification = match manager.classify_comment_before_record(
            &listener_id_yt,
            video_id,
            &configured_yt,
            listener_config.regular_stream_window as u32,
            listener_config.regular_min_streams as u32,
        ) {
            Ok(c) => c,
            Err(err) => {
                tracing::warn!("listener classification failed: {}", err);
                return;
            }
        };

        let stream_seen_key = format!("{}:{}", video_id, listener_id_yt);
        let already_seen_in_stream = self
            .listener_seen_in_current_stream
            .contains(&stream_seen_key);
        let already_seen_in_session = self.listener_seen_in_session.contains(&listener_id_yt);
        let first_in_stream =
            !classification.has_comment_in_current_stream && !already_seen_in_stream;
        let first_time = !classification.has_prior_comment && !already_seen_in_session;
        let current_comment_at_ms = parse_comment_timestamp_ms(&comment.timestamp)
            .unwrap_or_else(|| current_millis() as i64);
        let previous_comment_at_ms = self
            .listener_last_comment_at_ms
            .get(&listener_id_yt)
            .copied()
            .unwrap_or(classification.previous_comment_at_ms)
            .max(classification.previous_comment_at_ms);
        let current_stream_count = self
            .listener_current_stream_comment_counts
            .entry(stream_seen_key.clone())
            .or_insert(classification.current_stream_comment_count);
        *current_stream_count += 1;
        let current_superchat_total = self
            .listener_current_stream_superchat_amounts_jpy
            .entry(stream_seen_key.clone())
            .or_insert(classification.current_stream_superchat_amount_jpy);
        *current_superchat_total += comment_superchat_jpy(comment);

        comment.has_prior_listener_comment =
            classification.has_prior_comment || already_seen_in_session;
        comment.is_first_comment_in_stream = first_in_stream;
        comment.listener_previous_stream_last_seen_at =
            classification.previous_stream_last_seen_at.clone();
        comment.listener_previous_stream_last_seen_at_ms =
            classification.previous_stream_last_seen_at_ms;
        comment.listener_previous_comment_at_ms = previous_comment_at_ms;
        comment.listener_previous_comment_at = format_unix_ms_iso(previous_comment_at_ms);
        comment.listener_current_stream_comment_count = *current_stream_count;
        comment.listener_current_stream_superchat_amount_jpy = *current_superchat_total;
        comment.listener_current_stream_superchat_amount_display =
            crate::common::superchat::format_amount_display(*current_superchat_total as f64, "¥");
        comment.listener_previous_stream_id = classification.previous_stream_id.clone();
        comment.listener_previous_stream_title = classification.previous_stream_title.clone();
        comment.listener_previous_stream_started_at =
            classification.previous_stream_started_at.clone();
        comment.listener_previous_stream_started_at_ms =
            classification.previous_stream_started_at_ms;
        comment.listener_regular_stream_count = classification.regular_stream_count;
        comment.listener_regular_window_streams = classification.regular_window_streams;
        comment.listener_regular_min_streams = classification.regular_min_streams;

        if classification.is_regular_listener {
            comment.is_regular_listener = true;
        }

        if first_in_stream && first_time {
            comment.listener_status = "first-time".to_string();
            comment.listener_tag = "初見".to_string();
            comment.is_first_time_listener = true;
            comment.is_first_time = true;
        } else if first_in_stream && classification.is_regular_listener {
            comment.listener_status = "regular-arrival".to_string();
            comment.listener_tag = "今北".to_string();
            comment.is_regular_arrival = true;
        } else if first_in_stream
            && classification.regular_stream_count == 0
            && classification.first_seen_at_ms > 0
            && classification.first_seen_at_ms
                < current_comment_at_ms
                    - (listener_config.newcomer_first_seen_days as i64) * 24 * 3600 * 1000
        {
            // 帰還 = 「離脱判定状態からの返り咲き」per-comment イベント (2026-05-14)。
            // 条件:
            //   1. この枠で初発言 (first_in_stream)
            //   2. 過去枠で発言経験あり (!first_time)
            //   3. 直近 N 枠中 0 枠発言 (regular_stream_count == 0)
            //   4. 初コメから X 日以上経過 (first_seen_at < baseline - X日)
            // = リスナーランクで言うと 離脱 → 復帰 への per-comment 遷移瞬間。
            // baseline は first_in_stream のとき current_comment_at_ms と等価 (= streams.started_at
            // を MIN-merge する仕様で、 1 コメ目の posted_at が started_at になる)。
            comment.listener_status = "long-absence".to_string();
            comment.listener_tag = "帰還".to_string();
            comment.is_returning_listener = true;
            comment.is_repeater = true;
        } else if first_in_stream {
            comment.listener_status = "returning".to_string();
            comment.listener_tag = "再訪".to_string();
            comment.is_returning_listener = true;
            comment.is_repeater = true;
        }

        self.listener_seen_in_current_stream.insert(stream_seen_key);
        self.listener_seen_in_session.insert(listener_id_yt.clone());
        self.listener_last_comment_at_ms
            .insert(listener_id_yt, current_comment_at_ms);
    }

    /// Step 3: コメントを listener_record_queue に投入する。
    /// 自チャンネル判定 (configured == stream_owner) を ModelQueue 側で完結させ、
    /// engine 側は判定済みコメントを書くだけに専念する (設計書 § 4.4)。
    /// 投入条件:
    /// - listener_manager が利用可能 (open 済み)
    /// - configured_owner_channel_id が設定済み (フェーズ 3.2a の SetOwnerChannelId 後)
    /// - current_stream_owner_channel_id が確定済み (PT-1b の AnnounceStreamOwner 後)
    /// - current_video_id が確定済み
    ///
    /// 自チャンネル配信は累計集計も更新する。他チャンネル配信は comments / streams /
    /// listener 表示メタデータだけ保存し、自チャンネル累計には含めない。
    fn dispatch_listener_record(
        &self,
        comment: &crate::state::comment::RawComment,
        sse: &Arc<SseBroadcaster>,
    ) {
        // テストコメントはコメント管理 (= listener / streams / comments DB 集計) を
        // 一切実行しない。配信実績として混ざるのを防ぐため。
        // (= 配信側 = performance / TTS / SSE は handle_incoming_comments 内で通常通り処理)
        if comment.is_template_test {
            return;
        }
        let manager = match self.engines.listener_manager.as_ref() {
            Some(m) => m,
            None => return, // open 失敗時の no-op
        };
        let stream_owner = match self
            .main_store
            .connection
            .current_stream_owner_channel_id
            .as_deref()
        {
            Some(s) if !s.is_empty() => s,
            _ => return, // PT-1b の AnnounceStreamOwner 受信前
        };
        // 自チャンネル判定は正本 is_current_stream_own に集約する (= yt- prefix を剥がして
        // configured_owner_channel_ids と比較、複数 ID / サブチャンネルにも対応)。
        // 以前はここで configured_ids と stream_owner を yt- 正規化なしで直接比較しており、
        // current_stream_owner_channel_id が yt- prefix 付きで来た枠 (= 経路によって付く) では
        // own 判定が false になり、自チャンネルのコメントが display-only (= 集計対象外) で
        // 記録されて listener / streams の SC 累計に乗らない不具合があった。connection.is_own_stream
        // (= push_connection_status が is_current_stream_own で計算、メンバーシップギフトの推定
        // 金額付与もこれを gate に使う) と必ず一致させ、判定の二重実装による乖離を防ぐ。
        let is_own_stream = Self::is_current_stream_own(&self.main_store);
        let video_id = match self.main_store.connection.video_id.as_deref() {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => return,
        };
        // owner を yt- prefix 付きで snapshot (listeners.channel_id 形式と統一、
        // streams.owner_channel_id にもこの値を保存する)
        let owner_yt = if stream_owner.starts_with("yt-") {
            stream_owner.to_string()
        } else {
            format!("yt-{}", stream_owner)
        };

        // 軽量な fire-and-forget で record_queue に投入。
        // record_comment 内部は spawn_blocking で SQLite トランザクションを実行する。
        // 完了時に sse 経由で runtime event "listener-updated" を発火し、
        // renderer 側で listener 一覧 / 配信ログを debounce 付き再読込させる
        // (フェーズ 3.2a の UI 自動更新サポート、第 12 ラウンドレビュー対応)。
        let manager = manager.clone();
        let comment = comment.clone();
        let sse_for_event = sse.clone();
        self.engines.listener_record_queue.send(async move {
            let task_result = tokio::task::spawn_blocking(move || {
                if is_own_stream {
                    manager.record_comment(&comment, &video_id, &owner_yt)
                } else {
                    manager.record_display_comment(&comment, &video_id, &owner_yt)
                }
            })
            .await;
            match task_result {
                Ok(Ok(summary)) => {
                    // INSERT 成功 (新規 or 集計加算) のみ event を出す。
                    // 重複スキップ (inserted=false) では UI 更新の必要がないので skip。
                    if summary.inserted {
                        sse_for_event.push_static_update(
                            "listener-updated",
                            &serde_json::json!({
                                "channelId": summary.channel_id,
                                "isFirstTimeListener": summary.is_first_time_listener,
                            }),
                        );
                    }
                }
                Ok(Err(err)) => {
                    tracing::warn!("listener_manager.record_comment failed: {}", err);
                }
                Err(join_err) => {
                    tracing::warn!("listener record_comment task join error: {}", join_err);
                }
            }
        });
    }

    fn handle_incoming_reaction(
        &mut self,
        reaction: crate::state::comment::RawReaction,
        sse: &SseBroadcaster,
    ) {
        self.main_session
            .reaction_counts
            .increment_by(&reaction.emoji, reaction.count as u64);
        shared_memory::publish_reaction_counts(&self.main_session.reaction_counts);
        sse.push_session_reaction(&reaction);

        // リアクションによる演出判定
        let result = self
            .engines
            .performance
            .evaluate_reaction(&reaction.emoji, &self.main_store.scenes);
        self.emit_performances(result.fired, sse);
    }

    fn handle_trigger(&mut self, scene_id: &str, performance_id: &str, sse: &SseBroadcaster) {
        let result = self.engines.performance.trigger_manual(
            scene_id,
            performance_id,
            &self.main_store.scenes,
        );
        self.emit_performances(result.fired, sse);
    }

    /// EffectManager のキャッシュを SceneStore に同期し SSE で通知する。
    fn sync_effects_to_store(&mut self, sse: &SseBroadcaster) {
        self.main_store.scenes.effects = self.engines.effect_manager.effects().to_vec();
        self.main_store.scenes.effect_params = self.engines.effect_manager.build_effect_params();
        sse.push_static_update("scenes", &self.main_store.scenes);
    }

    fn flush_performance_queue(&mut self, sse: &SseBroadcaster) {
        // ダミーの evaluate を使ってキューを処理（resume 後）
        let dummy = crate::state::comment::RawComment {
            id: String::new(),
            user_id: String::new(),
            live_id: String::new(),
            name: String::new(),
            display_name: String::new(),
            screen_name: String::new(),
            nickname: String::new(),
            comment: String::new(),
            comment_html: String::new(),
            speech_text: String::new(),
            profile_image: String::new(),
            original_profile_image: String::new(),
            timestamp: String::new(),
            has_gift: false,
            amount: 0.0,
            currency: String::new(),
            amount_display: String::new(),
            sticker_image: String::new(),
            tier_color: String::new(),
            superchat_tier: String::new(),
            is_member: false,
            member_months: 0,
            is_membership: false,
            membership_header: String::new(),
            is_membership_gift: false,
            is_membership_milestone: false,
            gift_count: 0,
            member_badge_url: String::new(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
            is_membership_gift_redemption: false,
            comment_visible: true,
            auto_moderated: false,
            listener_status: String::new(),
            listener_tag: String::new(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: false,
            listener_previous_stream_last_seen_at: String::new(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: String::new(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: String::new(),
            listener_previous_stream_id: String::new(),
            listener_previous_stream_title: String::new(),
            listener_previous_stream_started_at: String::new(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 0,
            listener_regular_min_streams: 0,
            is_first_time_listener: false,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
            is_template_test: false,
            is_backfill: false,
            komehub_trace: serde_json::Value::Null,
        };
        let result = self
            .engines
            .performance
            .evaluate(&dummy, &self.main_store.scenes);
        self.emit_performances(result.fired, sse);
    }

    fn emit_performances(
        &mut self,
        fired: Vec<crate::state::scene::Instruction>,
        sse: &SseBroadcaster,
    ) {
        for inst in fired {
            let entry = self.main_session.performance_log.push_instruction(&inst);
            shared_memory::publish_performance_log_entry(
                &entry,
                &self.main_session.performance_log,
            );
            sse.push_performance(&inst);
        }
    }

    fn apply_async_writeback(&mut self, writeback: AsyncWriteback, sse: &Arc<SseBroadcaster>) {
        match writeback.apply {
            AsyncApply::None => {}
            AsyncApply::IncomingComments { mut comments } => {
                stamp_comments_trace(&mut comments, "commentAuxReadyAtMs");
                self.handle_incoming_comments(comments, sse);
            }
            AsyncApply::ReplaceScenes {
                scenes,
                sync_effects,
            } => {
                self.main_store.scenes = scenes;
                if sync_effects {
                    self.main_store.scenes.effects = self.engines.effect_manager.effects().to_vec();
                    self.main_store.scenes.effect_params =
                        self.engines.effect_manager.build_effect_params();
                }
                sse.push_static_update("scenes", &self.main_store.scenes);
            }
            AsyncApply::ReloadScenesAndSyncEffects => {
                self.engines.effect_manager.load_effects();
                self.main_store.scenes = self.engines.scene_manager.load_all();
                self.sync_effects_to_store(sse);
            }
            AsyncApply::SyncEffectsToStore => {
                self.engines.effect_manager.load_effects();
                self.sync_effects_to_store(sse);
            }
            AsyncApply::SetCurrentPreset { current_preset } => {
                match current_preset {
                    Some(current_preset) => self
                        .engines
                        .preset_manager
                        .set_current_preset(&current_preset),
                    None => self.engines.preset_manager.set_current_preset(""),
                }
                self.save_app_config();
            }
            AsyncApply::ReopenListenerManagerAndReloadScenes { data_dir } => {
                // フルバックアップ復元後の後処理。
                // 1) listener_manager を再 open (DB ファイル置換 済)
                match crate::engine::listener_manager::ListenerManager::open(&data_dir) {
                    Ok(mgr) => {
                        self.engines.listener_manager = Some(std::sync::Arc::new(mgr));
                        tracing::info!("listener_manager re-opened after restore");
                    }
                    Err(err) => {
                        tracing::error!("Failed to re-open listener_manager after restore: {}", err);
                        // None のままにしておく (= 復元 DB が壊れていたら次回起動で再試行可能)
                    }
                }
                // 2) app-config.json を再ロードして UI / 内部設定に反映
                if let Some(config) = load_app_config(&data_dir) {
                    self.app_config = config;
                    // classification thresholds を listener_manager に再通知
                    if let (Some(lc), Some(mgr)) = (
                        self.app_config.listener_classification.as_ref(),
                        self.engines.listener_manager.as_ref(),
                    ) {
                        mgr.set_classification_thresholds(
                            lc.newcomer_first_seen_days,
                            lc.veteran_first_seen_days,
                            lc.regular_stream_window as u32,
                            lc.regular_min_streams as u32,
                        );
                    }
                }
                // 3) scenes / effects を再ロード + SSE で renderer に通知
                // (= 復元で消えたシーンが UI に残らないように。 sync_effects_to_store は
                //  effects だけ push するので、 scenes 自体は別途明示 push が必要)
                self.engines.effect_manager.load_effects();
                self.main_store.scenes = self.engines.scene_manager.load_all();
                self.sync_effects_to_store(sse);
                sse.push_static_update("scenes", &self.main_store.scenes);
                // 4) configured_owner_channel_ids を listeners.db から再ロード + SSE 通知
                // (= 復元で listeners.db が backup の中身に置換されたあと、 backup 時点の
                //  owner_channels を MainStore に反映する。 これをしないと「自チャ配信」 を
                //  判定する KPI 集計が空の owner で動いて 0 件扱いになる。
                //  さらに renderer 側に SSE push しないと「自チャ未設定警告」 が UI に残る)
                if let Some(listener_mgr) = self.engines.listener_manager.as_ref() {
                    match listener_mgr.get_owner_channels() {
                        Ok(channels) if !channels.is_empty() => {
                            let ids: Vec<String> =
                                channels.iter().map(|c| c.channel_id.clone()).collect();
                            tracing::info!(
                                "Reloaded configured owner channels after restore ({}): {:?}",
                                ids.len(),
                                ids
                            );
                            self.main_store.configured_owner_channel_ids = ids;
                            sse.push_static_update(
                                "configuredOwnerChannels",
                                &serde_json::json!({ "ownerChannels": channels }),
                            );
                        }
                        Ok(_) => {
                            tracing::info!(
                                "No configured owner channels after restore (= backup 時点で未設定)"
                            );
                            self.main_store.configured_owner_channel_ids.clear();
                            sse.push_static_update(
                                "configuredOwnerChannels",
                                &serde_json::json!({
                                    "ownerChannels": Vec::<crate::state::listener::OwnerChannel>::new()
                                }),
                            );
                        }
                        Err(err) => {
                            tracing::warn!(
                                "Failed to reload configured_owner_channel_ids after restore: {}",
                                err
                            );
                        }
                    }
                }
                // connection state も再 push (= isOwnStream 判定結果が変わる可能性あるため)
                Self::push_connection_status(&mut self.main_store, sse);
                // 6) backup-progress dialog に done 100% を発火 (= 復元経路で dialog が
                //    SSE done を待機している、 reply restored:true は migration 前に
                //    返っているので、 ここで初めて「完了」 UX に到達する)。
                //    migration_progress reporter も clear (= 通常起動時に reporter が
                //    残っていても害はないが、 明示的にクリア)。
                sse.push_static_update(
                    "backup-progress",
                    &serde_json::json!({ "phase": "done", "percent": 100 }),
                );
                crate::engine::listener_manager::migration_progress::clear();
            }
            AsyncApply::MarkOnecommePristineBackupTaken { onecomme_dir } => {
                // わんコメ書き戻し成功 + pristine backup 作成完了の post-process。
                // 次回 export ではこの値と一致する onecommeDir なら backup スキップ。
                self.app_config.onecomme_pristine_for = Some(onecomme_dir);
                self.save_app_config();
            }
        }

        if let Some(reply) = writeback.reply {
            let _ = reply.send(writeback.response);
        }
    }
}

// ========== ヘルパー関数 ==========

fn normalize_comment_for_delivery(comment: &mut crate::state::comment::RawComment) {
    comment.amount_display =
        crate::common::superchat::format_amount_display(comment.amount, &comment.currency);
    comment.superchat_tier = crate::common::superchat::superchat_tier_key(
        comment.amount,
        &comment.currency,
        &comment.tier_color,
    );
}

fn build_template_test_comment_id(context: &serde_json::Value) -> String {
    if let Some(id) = context
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
    {
        return id.to_string();
    }
    if let Some(id) = context
        .get("commentId")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
    {
        return id.to_string();
    }
    format!(
        "__template_test__{}_{}",
        crate::engine::effect_manager::generate_id_pub(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn build_test_comment_from_context(
    context: &serde_json::Value,
) -> crate::state::comment::RawComment {
    let amount = context
        .get("amount")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let is_membership_gift = context
        .get("isMembershipGift")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let user_name = context
        .get("userName")
        .and_then(|v| v.as_str())
        .unwrap_or("テストユーザー")
        .to_string();
    let gift_count = context
        .get("giftCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let comment = context
        .get("comment")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let resolved_comment = if is_membership_gift && comment.trim().is_empty() {
        format!(
            "{}さんがメンバーシップギフトを{}個送りました。",
            user_name, gift_count
        )
    } else if comment.trim().is_empty() {
        "テストコメント".to_string()
    } else {
        comment
    };
    crate::state::comment::RawComment {
        id: build_template_test_comment_id(context),
        user_id: context
            .get("userId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        live_id: context
            .get("liveId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        name: user_name,
        display_name: context
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        screen_name: context
            .get("screenName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        nickname: context
            .get("nickname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        comment: resolved_comment.clone(),
        comment_html: context
            .get("commentHtml")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or(&resolved_comment)
            .to_string(),
        speech_text: context
            .get("speechText")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        profile_image: context
            .get("profileImage")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        original_profile_image: context
            .get("originalProfileImage")
            .or_else(|| context.get("_originalProfileImage"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        timestamp: String::new(),
        has_gift: amount > 0.0 || is_membership_gift,
        amount,
        currency: context
            .get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("¥")
            .to_string(),
        amount_display: context
            .get("amountDisplay")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .unwrap_or_else(|| {
                crate::common::superchat::format_amount_display(
                    amount,
                    context
                        .get("currency")
                        .and_then(|v| v.as_str())
                        .unwrap_or("¥"),
                )
            }),
        sticker_image: context
            .get("stickerImage")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        tier_color: context
            .get("tierColor")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        superchat_tier: context
            .get("superchatTier")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .unwrap_or_else(|| {
                crate::common::superchat::superchat_tier_key(
                    amount,
                    context
                        .get("currency")
                        .and_then(|v| v.as_str())
                        .unwrap_or("¥"),
                    context
                        .get("tierColor")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                )
            }),
        is_member: context
            .get("isMember")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        member_months: context
            .get("memberMonths")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        is_membership: context
            .get("isMembership")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        membership_header: context
            .get("membershipHeader")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_membership_gift,
        is_membership_gift_redemption: false,
        is_membership_milestone: context
            .get("isMembershipMilestone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        gift_count,
        member_badge_url: context
            .get("memberBadgeUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_moderator: context
            .get("isModerator")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_owner: context
            .get("isOwner")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_verified: context
            .get("isVerified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_first_time: context
            .get("isFirstTime")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_repeater: context
            .get("isRepeater")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        listener_status: context
            .get("listenerStatus")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_tag: context
            .get("listenerTag")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        has_prior_listener_comment: context
            .get("hasPriorListenerComment")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_first_comment_in_stream: context
            .get("isFirstCommentInStream")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        listener_previous_stream_last_seen_at: context
            .get("listenerPreviousStreamLastSeenAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_previous_stream_last_seen_at_ms: context
            .get("listenerPreviousStreamLastSeenAtMs")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        listener_previous_comment_at: context
            .get("listenerPreviousCommentAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_previous_comment_at_ms: context
            .get("listenerPreviousCommentAtMs")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        listener_current_stream_comment_count: context
            .get("listenerCurrentStreamCommentCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        listener_current_stream_superchat_amount_jpy: context
            .get("listenerCurrentStreamSuperchatAmountJpy")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        listener_current_stream_superchat_amount_display: context
            .get("listenerCurrentStreamSuperchatAmountDisplay")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_previous_stream_id: context
            .get("listenerPreviousStreamId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_previous_stream_title: context
            .get("listenerPreviousStreamTitle")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_previous_stream_started_at: context
            .get("listenerPreviousStreamStartedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        listener_previous_stream_started_at_ms: context
            .get("listenerPreviousStreamStartedAtMs")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        listener_regular_stream_count: context
            .get("listenerRegularStreamCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        listener_regular_window_streams: context
            .get("listenerRegularWindowStreams")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        listener_regular_min_streams: context
            .get("listenerRegularMinStreams")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        is_first_time_listener: context
            .get("isFirstTimeListener")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_returning_listener: context
            .get("isReturningListener")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_regular_listener: context
            .get("isRegularListener")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_regular_arrival: context
            .get("isRegularArrival")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        comment_visible: context
            .get("commentVisible")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        auto_moderated: context
            .get("autoModerated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        // テンプレ / 演出のテスト送信由来であることをマーク。listener_record / 配信ログ
        // 集計はこのフラグで全部 skip する。
        is_template_test: true,
        is_backfill: false,
        komehub_trace: serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        build_test_comment_from_context, is_valid_owner_channel_id, MainSession, MainStore,
        ModelCommand, ModelQueue, SseBroadcaster,
    };

    fn test_queue() -> (tempfile::TempDir, ModelQueue) {
        let data_dir = tempfile::tempdir().expect("create data dir");
        let plugins_dir = data_dir.path().join("plugins");
        std::fs::create_dir_all(&plugins_dir).expect("create plugins dir");
        let (_, queue) = ModelQueue::new(
            MainStore::default(),
            MainSession::default(),
            data_dir.path(),
            &plugins_dir,
            "test",
            0,
        );
        (data_dir, queue)
    }

    #[test]
    fn owner_channel_id_validator_accepts_uc_prefix() {
        assert!(is_valid_owner_channel_id("UCWP0eKdviJduJKazDqIxzpA"));
        assert!(is_valid_owner_channel_id("UC_-_-_-"));
        assert!(is_valid_owner_channel_id("UC1"));
    }

    #[test]
    fn owner_channel_id_validator_rejects_invalid() {
        // 空 / UC で始まらない / 無効文字 / yt- prefix 付き
        assert!(!is_valid_owner_channel_id(""));
        assert!(!is_valid_owner_channel_id("UC"));
        assert!(!is_valid_owner_channel_id("invalid"));
        assert!(!is_valid_owner_channel_id("yt-UCabc"));
        assert!(!is_valid_owner_channel_id("UC abc"));
        assert!(!is_valid_owner_channel_id("UC@bc"));
        assert!(!is_valid_owner_channel_id("ucabc"));
    }

    #[test]
    fn template_test_comments_use_unique_ids_by_default() {
        let ctx = serde_json::json!({
            "userName": "Template Tester",
            "comment": "hello"
        });
        let first = build_test_comment_from_context(&ctx);
        let second = build_test_comment_from_context(&ctx);

        assert_ne!(first.id, second.id);
        assert!(first.id.starts_with("__template_test__"));
        assert!(second.id.starts_with("__template_test__"));
    }

    #[test]
    fn template_test_comments_allow_explicit_ids() {
        let ctx = serde_json::json!({
            "id": "custom-template-test-id",
            "userName": "Template Tester",
            "comment": "hello"
        });
        let comment = build_test_comment_from_context(&ctx);

        assert_eq!(comment.id, "custom-template-test-id");
    }

    #[tokio::test]
    async fn dispatch_routes_preset_list_command() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();

        assert!(
            queue
                .dispatch_command(ModelCommand::GetPresetList { reply: reply_tx }, &sse)
                .await
        );
        let response = reply_rx.await.expect("preset list response");

        assert!(response.is_array());
    }

    #[tokio::test]
    async fn dispatch_routes_owner_channels_command() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();

        assert!(
            queue
                .dispatch_command(ModelCommand::GetOwnerChannels { reply: reply_tx }, &sse)
                .await
        );
        let response = reply_rx.await.expect("owner channels response");

        assert!(response.get("ownerChannels").is_some());
    }

    #[tokio::test]
    async fn dispatch_routes_listener_query_stream_tag_and_sync_commands() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        let (listeners_tx, listeners_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::GetListeners {
                        query: crate::state::listener::ListenersQuery::default(),
                        reply: listeners_tx,
                    },
                    &sse,
                )
                .await
        );
        assert_eq!(
            listeners_rx.await.expect("listeners response")["ok"],
            serde_json::Value::Bool(true)
        );

        let (streams_tx, streams_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::GetStreams {
                        query: crate::state::listener::StreamsQuery::default(),
                        reply: streams_tx,
                    },
                    &sse,
                )
                .await
        );
        assert_eq!(
            streams_rx.await.expect("streams response")["ok"],
            serde_json::Value::Bool(true)
        );

        let (tags_tx, tags_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(ModelCommand::ListAllListenerTags { reply: tags_tx }, &sse)
                .await
        );
        assert_eq!(
            tags_rx.await.expect("tags response")["ok"],
            serde_json::Value::Bool(true)
        );

        let (sync_tx, sync_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::RunBidirectionalSync {
                        onecomme_dir: "unused".to_string(),
                        reply: sync_tx,
                    },
                    &sse,
                )
                .await
        );
        let sync_response = sync_rx.await.expect("sync response");
        assert_eq!(sync_response["skipped"], serde_json::Value::Bool(true));
        assert_eq!(sync_response["reason"], "owner_unset");

        let (hidden_tx, hidden_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::SetListenerHidden {
                        listener_channel_id: "UC_hidden_test".to_string(),
                        hide_from_comments: true,
                        hide_from_listeners: false,
                        reply: hidden_tx,
                    },
                    &sse,
                )
                .await
        );
        assert_eq!(
            hidden_rx.await.expect("hidden response")["ok"],
            serde_json::Value::Bool(true)
        );

        let (template_test_tx, template_test_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::SendTemplateTestComment {
                        scene_id: "inactive".to_string(),
                        context: serde_json::json!({ "comment": "test" }),
                        reply: template_test_tx,
                    },
                    &sse,
                )
                .await
        );
        assert_eq!(
            template_test_rx.await.expect("template test response")["ok"],
            serde_json::Value::Bool(false)
        );
    }

    #[tokio::test]
    async fn dispatch_routes_backup_and_effect_query_commands() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        let (backup_tx, backup_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(ModelCommand::GetBackupList { reply: backup_tx }, &sse)
                .await
        );
        assert!(backup_rx.await.expect("backup list response").is_array());

        let (effects_tx, effects_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(ModelCommand::GetEffects { reply: effects_tx }, &sse)
                .await
        );
        assert!(effects_rx.await.expect("effects response").is_array());
    }

    #[tokio::test]
    async fn dispatch_routes_scene_template_boundary_commands() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        let (scene_list_tx, scene_list_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::GetSceneList {
                        reply: scene_list_tx
                    },
                    &sse
                )
                .await
        );
        assert!(scene_list_rx.await.expect("scene list response").is_array());

        let (scene_templates_tx, scene_templates_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::GetSceneTemplates {
                        scene_id: "missing".to_string(),
                        reply: scene_templates_tx,
                    },
                    &sse,
                )
                .await
        );
        let scene_templates = scene_templates_rx.await.expect("scene templates response");
        assert!(scene_templates.get("sceneTemplates").is_some());
        assert!(scene_templates.get("availableTemplates").is_some());

        let (settings_tx, settings_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::GetSceneTemplateSettings {
                        scene_id: "missing".to_string(),
                        template_name: "missing-template".to_string(),
                        reply: settings_tx,
                    },
                    &sse,
                )
                .await
        );
        assert!(settings_rx
            .await
            .expect("template settings response")
            .is_object());

        let (manifests_tx, manifests_rx) = tokio::sync::oneshot::channel();
        assert!(
            queue
                .dispatch_command(
                    ModelCommand::GetTemplateManifests {
                        reply: manifests_tx,
                    },
                    &sse,
                )
                .await
        );
        assert!(manifests_rx.await.is_ok());
    }

    // ----------------------------------------------------------------
    // 副作用順序の不変条件 (= ConnectionStateChanged reset / seen_comment_ids dedup)
    //
    // codex の model_queue 分割リファクタ (de6ebdd / dc37d0f / 4559f72 / 9d1066a)
    // 後も、副作用 chain の中核 (handle_incoming_comments / handle_connection_state_changed)
    // は model_queue.rs に集約されている。これらの順序が壊れると cross-stream 残留
    // (= data-integrity-patterns.md パターン E) や eviction-bound dedup 漏れ
    // (= パターン F) が発生する。public ModelCommand 経由で観測可能な範囲を assert
    // し、将来のリファクタ時の安全網にする。
    // ----------------------------------------------------------------

    /// テスト用 RawComment 構築 helper。`#[serde(default)]` フィールド以外は最小限
    /// (= id / name / comment) のみ埋め、残りは Default で構築する。
    /// `is_template_test=false` / `is_backfill=false` で、通常の配信中コメ扱い。
    fn make_runtime_comment(id: &str) -> crate::state::comment::RawComment {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": "Tester",
            "comment": "hello",
        }))
        .expect("RawComment from JSON")
    }

    /// 接続枠を vid1 → vid2 に切り替えた時、canonical_comment_store が clear され、
    /// 旧枠コメ が新枠の GetRecentComments に漏れないことを確認する。
    /// 順序が壊れると cross-stream 汚染 (= パターン E) になる。
    #[tokio::test]
    async fn connection_state_change_clears_canonical_store_on_video_id_switch() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        // vid1 に接続
        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: true,
                    video_id: Some("vid1".to_string()),
                },
                &sse,
            )
            .await;

        // コメ 1 件投入
        queue
            .dispatch_command(
                ModelCommand::IncomingComments {
                    comments: vec![make_runtime_comment("c1")],
                },
                &sse,
            )
            .await;

        // canonical_store に入っているか確認
        let (tx, rx) = tokio::sync::oneshot::channel();
        queue
            .dispatch_command(
                ModelCommand::GetRecentComments {
                    limit: 10,
                    reply: tx,
                },
                &sse,
            )
            .await;
        let recent = rx.await.expect("recent before switch");
        assert_eq!(
            recent.as_array().map(|a| a.len()),
            Some(1),
            "vid1 のコメは canonical_store に入る"
        );

        // vid2 に切替 (= ConnectionStateChanged で reset 経路発火)
        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: true,
                    video_id: Some("vid2".to_string()),
                },
                &sse,
            )
            .await;

        // canonical_store が clear されたか確認
        let (tx, rx) = tokio::sync::oneshot::channel();
        queue
            .dispatch_command(
                ModelCommand::GetRecentComments {
                    limit: 10,
                    reply: tx,
                },
                &sse,
            )
            .await;
        let recent = rx.await.expect("recent after switch");
        assert_eq!(
            recent.as_array().map(|a| a.len()),
            Some(0),
            "vid1 のコメは vid2 切替後に漏れない (= cross-stream 残留なし)"
        );
    }

    /// 同 ID コメが 2 回投入された時、seen_comment_ids gate で 2 回目は新規処理
    /// されず、canonical_store に重複登録されない (= update のみ) ことを確認する。
    /// canonical_comment_store は id をキーに upsert するため件数は 1 のまま。
    #[tokio::test]
    async fn seen_comment_ids_dedup_skips_double_processing() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: true,
                    video_id: Some("vid1".to_string()),
                },
                &sse,
            )
            .await;

        // 同 ID コメを 2 回投入
        queue
            .dispatch_command(
                ModelCommand::IncomingComments {
                    comments: vec![make_runtime_comment("c1")],
                },
                &sse,
            )
            .await;
        queue
            .dispatch_command(
                ModelCommand::IncomingComments {
                    comments: vec![make_runtime_comment("c1")],
                },
                &sse,
            )
            .await;

        // canonical_store には 1 件のみ
        let (tx, rx) = tokio::sync::oneshot::channel();
        queue
            .dispatch_command(
                ModelCommand::GetRecentComments {
                    limit: 10,
                    reply: tx,
                },
                &sse,
            )
            .await;
        let recent = rx.await.expect("recent");
        assert_eq!(
            recent.as_array().map(|a| a.len()),
            Some(1),
            "同 ID コメ 2 回投入 → canonical_store には 1 件 (= dedup gate が機能)"
        );
    }

    /// `live_stream_stats` (= 現枠の comment_count / superchat_amount_jpy / video_id) が
    /// IncomingComments で増分し、ConnectionStateChanged で 0 リセットされることを
    /// 確認する。`GetLiveStreamStats` 経由で内部 state を観察するため、
    /// `handle_connection_state_changed` 内の `live_stream_stats` reset コードが
    /// regression していないことを直接 assert できる。
    #[tokio::test]
    async fn live_stream_stats_resets_on_video_id_switch() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        // vid1 接続
        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: true,
                    video_id: Some("vid1".to_string()),
                },
                &sse,
            )
            .await;

        // コメ 2 件投入
        queue
            .dispatch_command(
                ModelCommand::IncomingComments {
                    comments: vec![make_runtime_comment("c1"), make_runtime_comment("c2")],
                },
                &sse,
            )
            .await;

        // commentCount=2, videoId="vid1" を確認
        let (tx, rx) = tokio::sync::oneshot::channel();
        queue
            .dispatch_command(ModelCommand::GetLiveStreamStats { reply: tx }, &sse)
            .await;
        let stats = rx.await.expect("stats before switch");
        assert_eq!(stats["videoId"], "vid1");
        assert_eq!(stats["commentCount"], 2);

        // vid2 に切替
        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: true,
                    video_id: Some("vid2".to_string()),
                },
                &sse,
            )
            .await;

        // commentCount=0, videoId="vid2" を確認 (= reset 経路が走った)
        let (tx, rx) = tokio::sync::oneshot::channel();
        queue
            .dispatch_command(ModelCommand::GetLiveStreamStats { reply: tx }, &sse)
            .await;
        let stats = rx.await.expect("stats after switch");
        assert_eq!(stats["videoId"], "vid2", "video_id が新枠に更新されている");
        assert_eq!(
            stats["commentCount"], 0,
            "comment_count が 0 リセットされる"
        );
        assert_eq!(
            stats["superchatAmountJpy"], 0,
            "superchat_amount_jpy も 0 リセットされる"
        );
    }

    /// 切断 (= connected=false) 時も `previous_video_id != new_video_id` であれば
    /// reset 経路が走る。video_id=None で接続を切ると、旧枠の canonical_store が
    /// clear されることを確認する。
    #[tokio::test]
    async fn disconnect_with_video_id_change_clears_caches() {
        let (_data_dir, mut queue) = test_queue();
        let sse = Arc::new(SseBroadcaster::new());

        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: true,
                    video_id: Some("vid1".to_string()),
                },
                &sse,
            )
            .await;
        queue
            .dispatch_command(
                ModelCommand::IncomingComments {
                    comments: vec![make_runtime_comment("c1")],
                },
                &sse,
            )
            .await;

        // 切断 (= connected=false, video_id=None)
        queue
            .dispatch_command(
                ModelCommand::ConnectionStateChanged {
                    connected: false,
                    video_id: None,
                },
                &sse,
            )
            .await;

        let (tx, rx) = tokio::sync::oneshot::channel();
        queue
            .dispatch_command(
                ModelCommand::GetRecentComments {
                    limit: 10,
                    reply: tx,
                },
                &sse,
            )
            .await;
        let recent = rx.await.expect("recent after disconnect");
        assert_eq!(
            recent.as_array().map(|a| a.len()),
            Some(0),
            "切断 (video_id None) でも reset 経路が走り canonical_store が clear される"
        );
    }
}

/// 配信者が「見たくない」リスナーを記録する非表示リスト。
///
/// # 設計 (= 2026-05-09 仕様変更)
///
/// 旧名 `BannedUserRecord` (= 演出フィルタ用) を改名 + 2 フラグ追加。
/// 演出への影響は **完全撤廃** している (= BAN されたユーザーが「演出が出ない」ことで
/// 気付かないように)。荒らし対策は YouTube 純正 BAN に委ねる。
///
/// 用途は「配信者の精神安定」: 嫌な常連を視認したくないが相手に気付かれたくない場合に使う。
/// データは DB / 集計には残し、UI 表示だけ抑制する。
///
/// - `hide_from_comments=true` → 本体・remote のコメリストに表示しない (= テンプレート / OBS には表示する)
/// - `hide_from_listeners=true` → 本体・remote のリスナーリストに表示しない
///
/// 2 フラグは独立。両方 false なら record 自体を削除すべき (= ノイズ回避)。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenListenerRecord {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub profile_image: String,
    #[serde(default)]
    pub hide_from_comments: bool,
    #[serde(default)]
    pub hide_from_listeners: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalCooldownConfig {
    max_effects: usize,
    user_interval: f64,
}

impl Default for GlobalCooldownConfig {
    fn default() -> Self {
        Self {
            max_effects: 30,
            user_interval: 5.0,
        }
    }
}

/// メンバーシップギフト (= 贈り主) の推定単価設定。
///
/// YouTube はギフト購入アナウンス (`liveChatSponsorshipsGiftPurchaseAnnouncementRenderer`) に
/// 金額を載せないため、`gift_count × 単価` で推定金額を算出する。単価は自チャンネル群
/// (owner_channels) ごとに設定でき、未設定のチャンネルは `default_price_jpy` を使う。
/// 他チャンネル枠は集計対象外なので推定しない (= `handle_incoming_comments` で
/// `connection.is_own_stream` を gate)。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipGiftPricingConfig {
    /// per-channel 未設定の自チャンネル枠に適用する既定単価 (JPY)。既定 ¥490
    /// (= YouTube メンバーシップのベース帯。¥500 ではない)。
    #[serde(default = "default_membership_gift_price")]
    default_price_jpy: i64,
    /// owner channel UC (= `yt-` prefix なし) → 単価 JPY のオーバーライド。
    /// 比較は `is_current_stream_own` と揃えて UC 形式 (yt- 剥がし) で行う。
    #[serde(default)]
    per_channel: std::collections::HashMap<String, i64>,
}

fn default_membership_gift_price() -> i64 {
    490
}

impl Default for MembershipGiftPricingConfig {
    fn default() -> Self {
        Self {
            default_price_jpy: default_membership_gift_price(),
            per_channel: std::collections::HashMap::new(),
        }
    }
}

impl MembershipGiftPricingConfig {
    /// owner UC (= yt- 剥がし済) に対応する単価を返す。per-channel 設定があればそれ、
    /// なければ既定単価。
    fn price_for(&self, owner_uc: &str) -> i64 {
        self.per_channel
            .get(owner_uc)
            .copied()
            .unwrap_or(self.default_price_jpy)
    }
}

/// UI / 外部から受け取った JSON を正規化して `MembershipGiftPricingConfig` にする。
/// 単価は 0 以上に丸め (= 負値を弾く、0 は「推定しない」を意味する)、per-channel の
/// key は UC 形式 (yt- 剥がし) に正規化して保存側と比較側を揃える。
fn normalize_membership_gift_pricing(value: serde_json::Value) -> MembershipGiftPricingConfig {
    let parsed: MembershipGiftPricingConfig = serde_json::from_value(value).unwrap_or_default();
    let default_price_jpy = parsed.default_price_jpy.max(0);
    let per_channel = parsed
        .per_channel
        .into_iter()
        .map(|(k, v)| (k.trim_start_matches("yt-").to_string(), v.max(0)))
        .collect();
    MembershipGiftPricingConfig {
        default_price_jpy,
        per_channel,
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenerClassificationConfig {
    /// 活動チェック: 直近 N 配信中 M 配信以上でコメント = 「常連 / 古参 として活動中」。
    /// 演出トリガー (= is_regular_listener) と system pill 計算で共有。
    regular_stream_window: usize,
    regular_min_streams: usize,
    /// 「新参」判定: 初コメから X 日以内のリスナーを 新参 とみなす (= 30 日デフォルト)。
    /// この境界より古い + 活動条件未満 = 「復帰」になる。
    #[serde(default = "default_newcomer_first_seen_days")]
    newcomer_first_seen_days: u32,
    /// 「古参」判定: 初コメから X 日以上経過したリスナーを 古参 とみなす。
    /// system pill (新規 / 新参 / 常連 / 古参 / 復帰) の境界として使う。
    /// 既存ハードコード 365 日を踏襲。
    #[serde(default = "default_veteran_first_seen_days")]
    veteran_first_seen_days: u32,
}

fn default_newcomer_first_seen_days() -> u32 {
    30
}

fn default_veteran_first_seen_days() -> u32 {
    365
}

impl Default for ListenerClassificationConfig {
    fn default() -> Self {
        Self {
            regular_stream_window: 10,
            regular_min_streams: 3,
            newcomer_first_seen_days: default_newcomer_first_seen_days(),
            veteran_first_seen_days: default_veteran_first_seen_days(),
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(default)]
    active_scene_id: Option<String>,
    #[serde(default)]
    current_preset: Option<String>,
    /// 旧名 `banned_users` (= 演出フィルタ用)。2026-05-09 仕様変更で「配信者が UI 上で
    /// 視認したくないリスナー」という意味に変更し、演出フィルタは撤廃した。
    /// 既存ユーザー向け migration: 起動時に初期化される (= electron/migration.js 担当)。
    #[serde(default, alias = "bannedUsers")]
    hidden_listeners: Vec<HiddenListenerRecord>,
    #[serde(default)]
    global_cooldown: Option<GlobalCooldownConfig>,
    /// メンバーシップギフトの推定単価 (= 自チャンネル群ごと + 既定 ¥490)。
    /// None の時は既定 (= 全チャンネル ¥490) として扱う。
    #[serde(default)]
    membership_gift_pricing: Option<MembershipGiftPricingConfig>,
    #[serde(default)]
    listener_classification: Option<ListenerClassificationConfig>,
    #[serde(default)]
    tts: Option<serde_json::Value>,
    /// コメント通知 (Phase C 〜)。 構造は JS 側 NOTIFICATION_EVENT_DEFS と 1:1。
    /// JSON 形: { enabled, paused, provider, outputDevice, events: { <id>: { enabled, sound: {enabled,file,volume}, tts: {enabled,template} } } }
    /// typed struct ではなく Value で持つのは既存 tts と同じ理由 (= UI 進化に追従しやすい)。
    #[serde(default)]
    notification: Option<serde_json::Value>,
    #[serde(default)]
    backups_dir: Option<String>,
    /// わんコメ DB の pristine backup 対象 onecommeDir path。
    /// この値と現在の onecommeDir が一致していれば既に pristine backup 取得済 →
    /// 書き戻し時に再 backup 不要 (= 1 度書き戻したら DB は既に「こめはぶ汚染」 状態で、
    /// 戻しても pristine ではないので意味がない、 という設計判断)。
    /// onecommeDir 変更時はリセットして新規 pristine を取り直す。
    #[serde(default)]
    onecomme_pristine_for: Option<String>,
    /// デバッグログ出力 ON/OFF。
    /// `true` の時のみ trace / debug レベルが app.log / core.log に出力される
    /// (= 通常運用は false、 設定画面の「デバッグ・サポート」 から ON にする)。
    /// 反映は再起動が必要 (= 起動時に logging::init_logging が app-config.json を
    /// peek して EnvFilter を決定する。 設定切替時は UI 側でモーダル案内)。
    /// 詳細仕様: `docs/logging.md`。
    #[serde(default)]
    debug_logging_enabled: bool,
}

/// app-config.json に軽量設定を永続化する。
fn save_app_config(data_dir: &Path, config: &AppConfig) {
    let config_path = data_dir.join("app-config.json");
    let json = match serde_json::to_string_pretty(config) {
        Ok(json) => json,
        Err(err) => {
            tracing::error!("save_app_config: serialize failed: {}", err);
            return;
        }
    };
    if let Err(err) = fs::write(&config_path, json) {
        tracing::error!(
            "save_app_config: write failed at {:?}: {}",
            config_path,
            err
        );
    }
}

/// app-config.json から軽量設定を読み込む。
fn load_app_config(data_dir: &Path) -> Option<AppConfig> {
    let config_path = data_dir.join("app-config.json");
    let content = fs::read_to_string(config_path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Step 3: 自チャンネル ID として受け入れる文字列の検証。
/// `UC` で始まり、ASCII 英数 / `-` / `_` で構成される文字列のみ許可する。
/// (renderer 側だけでなく backend 側でも検証することで、HTTP / NAPI 直叩きから
///  不正値が永続化されるのを防ぐ。docs/step3-design.md § 3.4 / § 4.4)
fn is_valid_owner_channel_id(s: &str) -> bool {
    if !s.starts_with("UC") {
        return false;
    }
    // 残り部分が ASCII 英数 / - / _ のみで構成されていて 1 文字以上
    let rest = &s[2..];
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn background_error_json(task: &str, error: tokio::task::JoinError) -> serde_json::Value {
    serde_json::json!({
        "error": format!("background task failed ({}): {}", task, error),
    })
}

fn import_result_to_json(result: crate::engine::export_import::ImportResult) -> serde_json::Value {
    match result {
        crate::engine::export_import::ImportResult::Ok(value) => value,
        crate::engine::export_import::ImportResult::NeedsUpgrade {
            zip_path,
            upgrade_info,
        } => {
            serde_json::json!({
                "needsUpgrade": true,
                "zipPath": zip_path,
                "upgradeInfo": upgrade_info,
            })
        }
        crate::engine::export_import::ImportResult::Err(error) => {
            serde_json::json!({ "error": error })
        }
    }
}

/// デフォルトシーンを復元する。
fn restore_default_scene(
    scene_id: &str,
    defaults_dir: &Path,
    scenes_dir: &Path,
    scenes: &mut crate::state::scene::SceneStore,
) -> Result<(), String> {
    let default_path = defaults_dir
        .join("scenes")
        .join(format!("{}.json", scene_id));
    if !default_path.exists() {
        return Err("デフォルトシーンが見つかりません".into());
    }

    let content = fs::read_to_string(&default_path)
        .map_err(|e| format!("デフォルトシーン読み取り失敗: {}", e))?;
    let mut scene_data: crate::state::scene::Scene =
        serde_json::from_str(&content).map_err(|e| format!("デフォルトシーンパース失敗: {}", e))?;
    scene_data.id = scene_id.to_string();

    let scene_dir = scenes_dir.join(scene_id);
    if scene_dir.exists() {
        fs::remove_dir_all(&scene_dir).ok();
    }

    fs::create_dir_all(scene_dir.join("mascot/frames")).ok();
    fs::create_dir_all(scene_dir.join("mascot/particles")).ok();
    fs::create_dir_all(scene_dir.join("performances")).ok();

    // mascot config
    if let Some(mascot) = scene_data.mascot.as_object() {
        let mascot_json = serde_json::to_string_pretty(&mascot).unwrap_or_default();
        fs::write(scene_dir.join("mascot/config.json"), mascot_json).ok();
    }

    // scene.json
    let scene_json = serde_json::to_string_pretty(&scene_data).unwrap_or_default();
    fs::write(scene_dir.join("scene.json"), scene_json).ok();

    scenes.scenes.insert(scene_id.to_string(), scene_data);
    tracing::info!("Restored default scene: {}", scene_id);
    Ok(())
}

/// デフォルトテンプレートにプレースホルダーがあるかチェックする。
fn check_default_template_context(effect_id: &str, defaults_dir: &Path) -> bool {
    let templates_dir = defaults_dir.join(format!("{}-templates", effect_id));
    if !templates_dir.exists() {
        return false;
    }

    let placeholder_re = regex::Regex::new(
        r"\{\{(userName|comment|profileImage|amount|currency|memberBadge|memberMonths|membershipHeader|giftCount|amountDisplay|stickerImage|tierBorder|tierBg|tierIcon|tierNameColor|tierAmountColor)\}\}"
    ).unwrap();

    if let Ok(entries) = fs::read_dir(&templates_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("html") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if placeholder_re.is_match(&content) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// ファイルを演出ディレクトリにコピーする。
fn copy_performance_asset(
    src_path: &str,
    perf_dir: &Path,
    performance_id: &str,
) -> Option<serde_json::Value> {
    fs::create_dir_all(perf_dir).ok()?;

    let src = Path::new(src_path);
    let original_name = src.file_name()?.to_string_lossy().to_string();
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();

    // 安全なファイル名を生成
    let prefix: String = performance_id
        .chars()
        .filter(|c| !"/\\<>:\"|?*".contains(*c) && !c.is_control())
        .collect();
    let prefix = if prefix.is_empty() {
        "asset".to_string()
    } else {
        prefix
    };
    let uid = format!(
        "{}{:04x}",
        crate::engine::effect_manager::generate_id_pub(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
            & 0xFFFF
    );
    let filename = format!("{}_{}{}", prefix, uid, ext);

    let dest = perf_dir.join(&filename);
    if !crate::infra::zip_utils::is_path_inside(perf_dir, &dest) {
        return None;
    }

    fs::copy(src, &dest).ok()?;

    // HTML の場合はプレースホルダーチェック
    let requires_context = if ext == ".html" {
        let placeholder_re = regex::Regex::new(
            r"\{\{(userName|comment|profileImage|amount|currency|memberBadge|memberMonths|membershipHeader|giftCount|amountDisplay|stickerImage|tierBorder|tierBg|tierIcon|tierNameColor|tierAmountColor)\}\}"
        ).unwrap();
        fs::read_to_string(&dest)
            .map(|c| placeholder_re.is_match(&c))
            .unwrap_or(false)
    } else {
        false
    };

    Some(serde_json::json!({
        "filename": filename,
        "originalName": original_name,
        "requiresContext": requires_context
    }))
}

#[cfg(test)]
mod stream_owner_tests {
    use super::*;
    use crate::state::connection::ConnectionState;

    #[test]
    fn stream_owner_announcement_is_applied_after_late_connection_state() {
        let mut connection = ConnectionState::new();
        let mut pending = None;

        let applied = ModelQueue::apply_stream_owner_announcement(
            &mut connection,
            &mut pending,
            "video-1".to_string(),
            "UCowner1".to_string(),
        );

        assert!(!applied);
        assert!(connection.current_stream_owner_channel_id.is_none());
        assert_eq!(
            pending.as_ref().map(|p| p.video_id.as_str()),
            Some("video-1")
        );

        ModelQueue::apply_connection_state_changed(
            &mut connection,
            &mut pending,
            false,
            Some("video-1".to_string()),
        );

        assert_eq!(connection.video_id.as_deref(), Some("video-1"));
        assert_eq!(
            connection.current_stream_owner_channel_id.as_deref(),
            Some("UCowner1")
        );
        assert!(pending.is_none());
    }

    #[test]
    fn stream_owner_announcement_is_applied_immediately_when_video_is_known() {
        let mut connection = ConnectionState::new();
        let mut pending = None;
        ModelQueue::apply_connection_state_changed(
            &mut connection,
            &mut pending,
            false,
            Some("video-1".to_string()),
        );

        let applied = ModelQueue::apply_stream_owner_announcement(
            &mut connection,
            &mut pending,
            "video-1".to_string(),
            "UCowner1".to_string(),
        );

        assert!(applied);
        assert_eq!(
            connection.current_stream_owner_channel_id.as_deref(),
            Some("UCowner1")
        );
        assert!(pending.is_none());
    }

    #[test]
    fn pending_stream_owner_is_dropped_when_switching_to_another_video() {
        let mut connection = ConnectionState::new();
        let mut pending = None;

        ModelQueue::apply_stream_owner_announcement(
            &mut connection,
            &mut pending,
            "video-1".to_string(),
            "UCowner1".to_string(),
        );
        ModelQueue::apply_connection_state_changed(
            &mut connection,
            &mut pending,
            false,
            Some("video-2".to_string()),
        );

        assert_eq!(connection.video_id.as_deref(), Some("video-2"));
        assert!(connection.current_stream_owner_channel_id.is_none());
        assert!(pending.is_none());
    }

    #[test]
    fn stream_owner_is_cleared_when_connection_video_changes() {
        let mut connection = ConnectionState::new();
        let mut pending = None;
        ModelQueue::apply_connection_state_changed(
            &mut connection,
            &mut pending,
            true,
            Some("video-1".to_string()),
        );
        ModelQueue::apply_stream_owner_announcement(
            &mut connection,
            &mut pending,
            "video-1".to_string(),
            "UCowner1".to_string(),
        );

        ModelQueue::apply_connection_state_changed(
            &mut connection,
            &mut pending,
            false,
            Some("video-2".to_string()),
        );

        assert_eq!(connection.video_id.as_deref(), Some("video-2"));
        assert!(connection.current_stream_owner_channel_id.is_none());
    }

    /// 自チャンネル判定は configured (= UC 保存) と stream owner (= 経路によって yt- prefix が
    /// 付く) の両方を yt- 剥がして比較する。これが崩れると、yt- 付き owner の自枠コメントが
    /// display-only で記録され listener / streams の SC 累計に乗らない (= 推定金額付与は
    /// 別 gate で発火するため「カードは ¥X だが累計は ¥0」になる) 不具合が再発する。
    #[test]
    fn is_current_stream_own_normalizes_yt_prefix() {
        use crate::state::MainStore;
        let mut store = MainStore::new();

        // configured=UC、owner=yt- 付き → 自チャンネルと判定される
        store.configured_owner_channel_ids = vec!["UCowner".to_string()];
        store.connection.current_stream_owner_channel_id = Some("yt-UCowner".to_string());
        assert!(ModelQueue::is_current_stream_own(&store));

        // 逆向き (configured=yt-、owner=UC) でも一致する
        store.configured_owner_channel_ids = vec!["yt-UCowner".to_string()];
        store.connection.current_stream_owner_channel_id = Some("UCowner".to_string());
        assert!(ModelQueue::is_current_stream_own(&store));

        // 別チャンネルは false
        store.configured_owner_channel_ids = vec!["UCowner".to_string()];
        store.connection.current_stream_owner_channel_id = Some("yt-UCother".to_string());
        assert!(!ModelQueue::is_current_stream_own(&store));
    }
}

#[cfg(test)]
mod membership_gift_pricing_tests {
    use super::*;

    #[test]
    fn default_price_is_490() {
        let config = MembershipGiftPricingConfig::default();
        assert_eq!(config.default_price_jpy, 490);
        // per-channel 未設定なら既定単価
        assert_eq!(config.price_for("UCanything"), 490);
    }

    #[test]
    fn per_channel_overrides_default() {
        let config = normalize_membership_gift_pricing(serde_json::json!({
            "defaultPriceJpy": 200,
            "perChannel": { "UCfoo": 1000 }
        }));
        assert_eq!(config.price_for("UCfoo"), 1000); // override
        assert_eq!(config.price_for("UCbar"), 200); // 既定にフォールバック
    }

    #[test]
    fn normalize_strips_yt_prefix_and_clamps_negative() {
        let config = normalize_membership_gift_pricing(serde_json::json!({
            "defaultPriceJpy": -5,
            "perChannel": { "yt-UCfoo": -10, "UCbar": 300 }
        }));
        // 負値は 0 に丸め
        assert_eq!(config.default_price_jpy, 0);
        // key は yt- 剥がし、値は 0 クランプ
        assert_eq!(config.price_for("UCfoo"), 0);
        assert_eq!(config.price_for("UCbar"), 300);
    }

    #[test]
    fn normalize_empty_value_yields_default() {
        // 欠損フィールドは serde default で補完される (= 既定 ¥490 / 空 map)
        let config = normalize_membership_gift_pricing(serde_json::json!({}));
        assert_eq!(config.default_price_jpy, 490);
        assert!(config.per_channel.is_empty());
    }
}
