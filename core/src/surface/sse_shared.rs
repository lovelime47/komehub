use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::broadcast;

use crate::state::comment::{RawComment, RawReaction};
use crate::state::scene::Instruction;

/// SSE で配信されるメッセージ
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SseMessage {
    /// Static 更新 (Electron のローカルコピーを上書き)
    #[serde(rename = "static")]
    StaticUpdate {
        path: String,
        data: serde_json::Value,
    },
    /// Session コメント追記
    #[serde(rename = "session-comment")]
    SessionComment {
        data: serde_json::Value,
        timestamp: u64,
    },
    /// Session リアクション追記
    #[serde(rename = "session-reaction")]
    SessionReaction {
        data: serde_json::Value,
        timestamp: u64,
    },
    /// 演出発火指示
    #[serde(rename = "performance")]
    Performance {
        #[serde(rename = "sceneId")]
        scene_id: String,
        data: serde_json::Value,
        timestamp: u64,
    },
    /// 演出クリア指示
    #[serde(rename = "performance-clear")]
    PerformanceClear {
        #[serde(rename = "sceneId")]
        scene_id: String,
        timestamp: u64,
    },
    /// オーバーレイ再読み込み通知
    #[serde(rename = "reload")]
    Reload,
    /// テンプレート向けコメント配信
    #[serde(rename = "template-comment")]
    TemplateComment {
        #[serde(rename = "sceneId")]
        scene_id: String,
        /// 有効なテンプレート名のリスト（SSE フィルタ用）
        #[serde(rename = "enabledTemplates")]
        enabled_templates: Vec<String>,
        data: serde_json::Value,
    },
    /// コメント削除通知
    #[serde(rename = "comment-deleted")]
    CommentDeleted { data: serde_json::Value },
    /// TTS runtime state 更新
    #[serde(rename = "tts-state")]
    TtsState { data: serde_json::Value },
    /// テンプレート設定変更通知
    #[serde(rename = "template-config")]
    TemplateConfig {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "templateName")]
        template_name: String,
        data: serde_json::Value,
    },
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicStatus {
    pub connected: bool,
    pub video_id: Option<String>,
    pub viewer_count: u64,
    /// リモート閲覧 redesign §5.3: 接続中の配信が自チャンネル枠 (= configured owner と
    /// stream owner が一致) かどうか。自枠コメだけ listeners.db に記録されるため、
    /// remote 側が「対応済みトグルを表示するか」の判定に使う。
    #[serde(default)]
    pub is_own_stream: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PublicEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub event: String,
    pub data: serde_json::Value,
    pub timestamp: u64,
}

impl PublicEvent {
    fn new(event: &str, data: serde_json::Value, timestamp: u64) -> Self {
        Self {
            event_type: "event",
            event: event.to_string(),
            data,
            timestamp,
        }
    }
}

pub struct SseBroadcaster {
    tx: broadcast::Sender<String>,
    public_client_count: AtomicUsize,
    current_status: Mutex<PublicStatus>,
    recent_events: Mutex<VecDeque<PublicEvent>>,
    /// 2026-05-09 仕様変更: コメリスト非表示の listener id 集合 (= raw、yt- prefix なし)。
    /// `/api/comments` 取り出し時に filter するために保持。
    /// ModelQueue が起動時 / SetListenerHidden 時に書き換える単一所有者。
    /// テンプレート / OBS 公開経路 (= broadcast 自体) には適用しない (= 配信者の管理 UI のみ)。
    hidden_for_comments: Mutex<std::collections::HashSet<String>>,
}

impl Default for SseBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

impl SseBroadcaster {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            public_client_count: AtomicUsize::new(0),
            current_status: Mutex::new(PublicStatus::default()),
            recent_events: Mutex::new(VecDeque::with_capacity(500)),
            hidden_for_comments: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// コメリスト非表示の listener id 集合を更新する (= 起動時 / SetListenerHidden 時に呼ぶ)。
    pub fn set_hidden_for_comments(&self, ids: std::collections::HashSet<String>) {
        if let Ok(mut guard) = self.hidden_for_comments.lock() {
            *guard = ids;
        }
    }

    /// 指定 listener が「コメリスト非表示」状態か。/api/comments の filter で使う。
    pub fn is_hidden_for_comments(&self, listener_id: &str) -> bool {
        let stripped = listener_id.trim_start_matches("yt-");
        match self.hidden_for_comments.lock() {
            Ok(guard) => guard.contains(stripped),
            Err(_) => false,
        }
    }

    /// Static 更新を配信
    pub fn push_static_update<T: serde::Serialize>(&self, path: &str, data: &T) {
        let data = serde_json::to_value(data).unwrap_or_default();
        if path == "connection" {
            self.update_status_from_connection(&data);
        }
        let msg = SseMessage::StaticUpdate {
            path: path.to_string(),
            data,
        };
        self.broadcast(msg);
    }

    /// Session コメントを配信
    pub fn push_session_comment(&self, comment: &RawComment) {
        let timestamp = current_millis();
        let data = serde_json::to_value(comment).unwrap_or_default();
        self.record_event("comment", data.clone(), timestamp);
        let msg = SseMessage::SessionComment {
            data,
            timestamp,
        };
        self.broadcast(msg);
    }

    /// Session リアクションを配信
    pub fn push_session_reaction(&self, reaction: &RawReaction) {
        let timestamp = current_millis();
        let data = serde_json::to_value(reaction).unwrap_or_default();
        self.record_event("reaction", data.clone(), timestamp);
        let msg = SseMessage::SessionReaction {
            data,
            timestamp,
        };
        self.broadcast(msg);
    }

    /// テンプレート向けコメント配信
    pub fn push_template_comment(&self, scene_id: &str, enabled_templates: Vec<String>, comment: &RawComment) {
        let msg = SseMessage::TemplateComment {
            scene_id: scene_id.to_string(),
            enabled_templates,
            data: serde_json::to_value(comment).unwrap_or_default(),
        };
        self.broadcast(msg);
    }

    /// コメント削除を配信
    pub fn push_comment_deleted(&self, comment_id: &str) {
        let msg = SseMessage::CommentDeleted {
            data: serde_json::json!({ "id": comment_id }),
        };
        self.broadcast(msg);
    }

    /// TTS runtime state を配信
    pub fn push_tts_state(&self, state: &serde_json::Value) {
        let msg = SseMessage::TtsState {
            data: state.clone(),
        };
        self.broadcast(msg);
    }

    /// テンプレート設定変更を配信
    pub fn push_template_config(&self, scene_id: &str, template_name: &str, config: &serde_json::Value) {
        let msg = SseMessage::TemplateConfig {
            scene_id: scene_id.to_string(),
            template_name: template_name.to_string(),
            data: config.clone(),
        };
        self.broadcast(msg);
    }

    /// 演出発火指示を配信
    pub fn push_performance(&self, instruction: &Instruction) {
        let msg = SseMessage::Performance {
            scene_id: instruction.scene_id.clone(),
            data: serde_json::to_value(instruction).unwrap_or_default(),
            timestamp: current_millis(),
        };
        self.broadcast(msg);
    }

    /// 演出クリア指示を配信
    pub fn push_performance_clear(&self, scene_id: &str) {
        let msg = SseMessage::PerformanceClear {
            scene_id: scene_id.to_string(),
            timestamp: current_millis(),
        };
        self.broadcast(msg);
    }

    /// オーバーレイ再読み込みを配信
    #[allow(dead_code)]
    pub fn push_reload(&self) {
        self.broadcast(SseMessage::Reload);
    }

    fn broadcast(&self, msg: SseMessage) {
        if let Ok(json) = serde_json::to_string(&msg) {
            // 受信者がいなくても送信エラーは無視
            let _ = self.tx.send(json);
        }
    }

    fn update_status_from_connection(&self, data: &serde_json::Value) {
        let mut status = self.current_status.lock().unwrap();
        status.connected = data
            .get("connected")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        status.video_id = data
            .get("videoId")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        // is_own_stream は connection static-update 経由で渡してもらう
        // (= ModelQueue が configured_owner_channel_ids と stream_owner を比較した結果)
        status.is_own_stream = data
            .get("isOwnStream")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
    }

    fn record_event(&self, event: &str, data: serde_json::Value, timestamp: u64) {
        let mut events = self.recent_events.lock().unwrap();
        if events.len() >= 500 {
            events.pop_front();
        }
        events.push_back(PublicEvent::new(event, data, timestamp));
    }

    /// `recent_events` cache 内の該当コメ data の `respondedAt` を更新する。
    /// remote-viewing redesign §5.3: `/api/comments` 経由でリロード時に取得した
    /// コメ一覧に最新の対応済み状態が反映されるようにするため、`SetCommentResponded`
    /// ハンドラから呼ぶ。コメ broadcast 後に DB が更新されても event cache は古いままなので、
    /// このメソッドで in-place 更新する。
    pub fn update_comment_responded(&self, comment_id: &str, responded_at: i64) {
        let mut events = self.recent_events.lock().unwrap();
        for event in events.iter_mut() {
            if event.event != "comment" {
                continue;
            }
            let Some(obj) = event.data.as_object_mut() else {
                continue;
            };
            if obj.get("id").and_then(|v| v.as_str()) == Some(comment_id) {
                obj.insert(
                    "respondedAt".to_string(),
                    serde_json::Value::Number(responded_at.into()),
                );
            }
        }
    }

    pub fn current_status(&self) -> PublicStatus {
        self.current_status.lock().unwrap().clone()
    }

    pub fn recent_events(&self, event_filter: Option<&str>, limit: usize) -> Vec<PublicEvent> {
        let events = self.recent_events.lock().unwrap();
        let mut filtered: Vec<PublicEvent> = events
            .iter()
            .filter(|event| event_filter.map(|filter| filter == event.event).unwrap_or(true))
            .cloned()
            .collect();
        if filtered.len() > limit {
            filtered.drain(0..(filtered.len() - limit));
        }
        filtered
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub fn public_client_connected(&self) {
        self.public_client_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn public_client_disconnected(&self) {
        self.public_client_count.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
            Some(count.saturating_sub(1))
        }).ok();
    }

    #[allow(dead_code)]
    pub fn public_client_count(&self) -> usize {
        self.public_client_count.load(Ordering::Relaxed)
    }
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
