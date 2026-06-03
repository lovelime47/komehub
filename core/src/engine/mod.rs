pub mod bootstrap;
pub mod backup_manager;
pub mod comment_aux_io;
pub mod demo_seed;
pub mod effect_manager;
pub mod export_import;
pub mod listener_aux_io;
pub mod listener_manager;
pub mod performance;
pub mod preset_manager;
pub mod scene_manager;
pub mod template_manager;
pub mod template_aux_io;
pub mod video_owner_resolver;
pub mod import_progress_reporter;
pub mod export_progress_reporter;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use backup_manager::BackupManager;
use effect_manager::EffectManager;
use listener_manager::ListenerManager;
use performance::PerformanceEngine;
use preset_manager::PresetManager;
use scene_manager::SceneManager;
use template_manager::TemplateManager;
use tokio::sync::{mpsc, Semaphore};

type BoxedEngineTask = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineQueueKind {
    Backup,
    Preset,
    Template,
    CommentAux,
    ImportExport,
    SceneIo,
    EffectIo,
    /// Step 3: 配信中の record_comment 専用 (高頻度・軽量)。
    #[allow(dead_code)] // queue は用意済み。record_comment 分離投入の有効化時に構築される。
    ListenerRecord,
    /// Step 3: インポート/エクスポート/同期専用 (低頻度・大規模バッチ)。
    #[allow(dead_code)] // queue は用意済み。同期系 writeback の分離投入時に構築される。
    ListenerSync,
}

#[derive(Clone)]
pub struct EngineTaskQueue {
    tx: mpsc::UnboundedSender<BoxedEngineTask>,
    writeback_gate: Arc<Semaphore>,
}

impl EngineTaskQueue {
    pub fn new(name: &'static str) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<BoxedEngineTask>();
        let writeback_gate = Arc::new(Semaphore::new(1));
        let worker_name = name.to_string();
        tokio::spawn(async move {
            while let Some(task) = rx.recv().await {
                tracing::debug!("Engine queue start: {}", worker_name);
                task.await;
                tracing::debug!("Engine queue complete: {}", worker_name);
            }
        });
        Self { tx, writeback_gate }
    }

    pub fn send<F>(&self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        if let Err(error) = self.tx.send(Box::pin(task)) {
            tracing::error!("Engine queue send failed: {}", error);
        }
    }

    pub fn writeback_gate(&self) -> Arc<Semaphore> {
        self.writeback_gate.clone()
    }
}

/// 全エンジンを束ねる構造体。
/// Model Queue が所有し、コマンドに応じて各エンジンを呼び出す。
pub struct Engines {
    pub performance: PerformanceEngine,
    pub scene_manager: SceneManager,
    pub effect_manager: EffectManager,
    pub backup_manager: BackupManager,
    pub preset_manager: PresetManager,
    pub template_manager: TemplateManager,
    /// Step 3: リスナー管理 (`data/listeners.db`)。open 失敗時は None に
    /// なり、record_comment は no-op + WARN ログとなる (起動継続を優先)。
    pub listener_manager: Option<Arc<ListenerManager>>,
    pub backup_queue: EngineTaskQueue,
    pub preset_queue: EngineTaskQueue,
    pub template_queue: EngineTaskQueue,
    pub comment_aux_queue: EngineTaskQueue,
    pub import_export_queue: EngineTaskQueue,
    pub scene_io_queue: EngineTaskQueue,
    pub effect_io_queue: EngineTaskQueue,
    /// Step 3: 配信中の record_comment 専用 (高頻度)。
    pub listener_record_queue: EngineTaskQueue,
    /// Step 3: インポート/エクスポート/同期専用 (低頻度・大規模バッチ)。
    pub listener_sync_queue: EngineTaskQueue,
    /// `data/media-cache/` 配下 (avatars / badges / stickers / emojis)。
    /// リスナー削除でアバター画像ファイルを削除する際に使う。
    pub media_cache_dir: Option<PathBuf>,
}

impl Engines {
    pub fn new(data_dir: &Path, plugins_dir: &Path, hub_version: &str) -> Self {
        let backups_dir = data_dir.join("backups");
        let scene_manager = SceneManager::new(data_dir);
        let mut effect_manager = EffectManager::new(data_dir, plugins_dir, hub_version);
        let app_root_dir = plugins_dir
            .parent()
            .and_then(|dir| dir.parent())
            .unwrap_or(Path::new("."))
            .to_path_buf();
        if let Err(error) = bootstrap::bootstrap_runtime_data(
            data_dir,
            &app_root_dir,
            &scene_manager,
            &mut effect_manager,
        ) {
            tracing::error!("Failed to bootstrap runtime data: {}", error);
        }
        effect_manager.load_effects();
        // ビルトインテンプレート: effects-overlay/templates/
        let builtin_templates_dir = plugins_dir.parent().unwrap_or(Path::new(".")).join("templates");
        let user_templates_dir = data_dir.join("templates");
        // Step 3: ListenerManager は open 失敗時に Option::None として進める
        // (DB 初期化失敗で他機能が止まらないようにするため)
        let listener_manager = match ListenerManager::open(data_dir) {
            Ok(mgr) => Some(Arc::new(mgr)),
            Err(err) => {
                tracing::error!(
                    "Failed to open listener_manager (Step 3 リスナー管理が無効になります): {}",
                    err
                );
                None
            }
        };
        Self {
            performance: PerformanceEngine::new(),
            scene_manager,
            effect_manager,
            backup_manager: BackupManager::new(&backups_dir),
            preset_manager: PresetManager::new(data_dir),
            template_manager: TemplateManager::new(&builtin_templates_dir, &user_templates_dir),
            listener_manager,
            backup_queue: EngineTaskQueue::new("backup"),
            preset_queue: EngineTaskQueue::new("preset"),
            template_queue: EngineTaskQueue::new("template"),
            comment_aux_queue: EngineTaskQueue::new("comment-aux"),
            import_export_queue: EngineTaskQueue::new("import-export"),
            scene_io_queue: EngineTaskQueue::new("scene-io"),
            effect_io_queue: EngineTaskQueue::new("effect-io"),
            listener_record_queue: EngineTaskQueue::new("listener-record"),
            listener_sync_queue: EngineTaskQueue::new("listener-sync"),
            media_cache_dir: Some(data_dir.join("media-cache")),
        }
    }

    pub fn writeback_gate(&self, kind: EngineQueueKind) -> Arc<Semaphore> {
        match kind {
            EngineQueueKind::Backup => self.backup_queue.writeback_gate(),
            EngineQueueKind::Preset => self.preset_queue.writeback_gate(),
            EngineQueueKind::Template => self.template_queue.writeback_gate(),
            EngineQueueKind::CommentAux => self.comment_aux_queue.writeback_gate(),
            EngineQueueKind::ImportExport => self.import_export_queue.writeback_gate(),
            EngineQueueKind::SceneIo => self.scene_io_queue.writeback_gate(),
            EngineQueueKind::EffectIo => self.effect_io_queue.writeback_gate(),
            EngineQueueKind::ListenerRecord => self.listener_record_queue.writeback_gate(),
            EngineQueueKind::ListenerSync => self.listener_sync_queue.writeback_gate(),
        }
    }
}
