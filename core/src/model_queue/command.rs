use napi::threadsafe_function::ThreadsafeFunction;

use crate::engine::EngineQueueKind;

use super::HiddenListenerRecord;

pub(crate) struct AsyncWriteback {
    pub(crate) queue: EngineQueueKind,
    pub(crate) apply: AsyncApply,
    pub(crate) reply: Option<tokio::sync::oneshot::Sender<serde_json::Value>>,
    pub(crate) response: serde_json::Value,
}

pub(crate) enum AsyncApply {
    None,
    IncomingComments {
        comments: Vec<crate::state::comment::RawComment>,
    },
    ReplaceScenes {
        scenes: crate::state::scene::SceneStore,
        sync_effects: bool,
    },
    ReloadScenesAndSyncEffects,
    SyncEffectsToStore,
    SetCurrentPreset {
        current_preset: Option<String>,
    },
    /// フルバックアップ復元後: listener_manager を再 open + scenes / effects も reload。
    /// `data_dir` は ListenerManager::open に渡す。
    ReopenListenerManagerAndReloadScenes {
        data_dir: std::path::PathBuf,
    },
    /// わんコメ書き戻し成功時に pristine backup を作成した onecommeDir を app_config に記録。
    /// 次回以降の export ではこの値と一致する onecommeDir なら backup をスキップする
    /// (= 1 度書き戻したら DB は汚染されており、 戻しても pristine ではないという設計判断)。
    MarkOnecommePristineBackupTaken {
        onecomme_dir: String,
    },
}

pub(crate) enum PresetCommand {
    GetPresetList {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetCurrentPreset {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SwitchPreset {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicatePreset {
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeletePreset {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportPreset {
        dest_path: String,
        export_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportPreset {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetCurrentPreset {
        name: String,
    },
}

pub(crate) enum BackupCommand {
    GetBackupList {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateBackup {
        options: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateFullBackup {
        name: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteBackup {
        backup_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RestoreBackup {
        backup_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetBackupsDir {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetBackupsDir {
        dir: String,
    },
    GetDataOverview {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ConfirmUpgradeEffect {
        zip_path: String,
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

pub(crate) enum EffectCommand {
    GetEffects {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetEffect {
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    AddEffect {
        effect: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateEffect {
        effect: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RemoveEffect {
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicateEffect {
        effect_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetPluginManifests {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

pub(crate) enum TemplateCommand {
    GetTemplates {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    InstallTemplate {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateTemplateFromStarter {
        starter_type: String,
        template_id: String,
        display_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateTemplateFromBuiltin {
        source_template_id: String,
        template_id: String,
        display_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RemoveTemplate {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTemplateDirectory {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetSceneTemplates {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    AddSceneTemplate {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RemoveSceneTemplate {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSelectedSceneTemplate {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSceneTemplateEnabled {
        scene_id: String,
        template_name: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

pub(crate) enum ListenerCommand {
    GetOwnerChannels {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// わんコメ書き戻し対象のデータ変更が listeners.db にあるか問い合わせる。
    /// JS 側 close ハンドラが shutdown export を実行するか / skip するかの判定に使う
    /// (= 接続せず編集もせず close したら skip して即終了)。
    IsListenerDbDirty {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetOwnerChannels {
        channels: Vec<crate::state::listener::OwnerChannel>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListeners {
        query: crate::state::listener::ListenersQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenerDetail {
        channel_id: String,
        recent_comment_limit: usize,
        /// 指定時、 ListenerRow.per_stream_* (= 当該枠コメ数 / SC / 最終) を計算して埋める。
        /// None なら従来通り per_stream_* は 0 (= 累計のみ表示用途)。
        stream_video_id: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenersActivity {
        query: crate::state::listener::ListenersActivityQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateListenerMetadata {
        channel_id: String,
        nickname: Option<String>,
        notes: Option<String>,
        label: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetListenerGreeted {
        stream_video_id: String,
        listener_channel_id: String,
        value: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetCommentResponded {
        comment_id: String,
        value: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetListenerHidden {
        listener_channel_id: String,
        hide_from_comments: bool,
        hide_from_listeners: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteListeners {
        channel_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteStreams {
        video_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateStreamMetadata {
        video_id: String,
        stream_url: Option<String>,
        title: Option<String>,
        owner_channel_id: Option<String>,
        channel_name: Option<String>,
        channel_icon_url: Option<String>,
        description: Option<String>,
        subscriber_count: Option<i64>,
        current_viewers: Option<i64>,
        peak_concurrent_viewers: Option<i64>,
        likes: Option<i64>,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        live_metadata_updated_at: Option<i64>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStreams {
        query: crate::state::listener::StreamsQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStreamDetail {
        video_id: String,
        recent_comment_limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SearchComments {
        query: crate::state::listener::CommentsQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListStreamListeners {
        video_id: String,
        query: crate::state::listener::StreamListenersQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStreamStats {
        video_id: String,
        bin_minutes: i64,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetCommentChipCounts {
        video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenerChipCounts {
        channel_id: String,
        context_video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListListenerSuperchats {
        channel_id: String,
        limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListListenerCommentsInStream {
        channel_id: String,
        stream_video_id: String,
        limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenerSearchRankCounts {
        baseline_video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStreamScopedListenerCounts {
        stream_video_id: String,
        q: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStreamListenerPillCounts {
        video_id: String,
        name_q: Option<String>,
        body_q: Option<String>,
        text_q: Option<String>,
        user_tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenerTags {
        channel_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetListenerTags {
        channel_id: String,
        tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListAllListenerTags {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListAllListenerTagAssignments {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStreamTags {
        video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetStreamTags {
        video_id: String,
        tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListAllStreamTags {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListAllStreamTagAssignments {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RenameStreamTag {
        old_name: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteStreamTag {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RenameListenerTag {
        old_name: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteListenerTag {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ListSavedSearches {
        scope: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateSavedSearch {
        scope: String,
        name: String,
        conditions_json: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateSavedSearch {
        id: i64,
        name: Option<String>,
        conditions_json: Option<String>,
        sort_order: Option<i64>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteSavedSearch {
        id: i64,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportKomehubJsonl {
        out_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportKomehubJsonl {
        src_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportFromOnecomme {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportToOnecomme {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DetectOnecommeRunning {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RunBidirectionalSync {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// わんコメ DB リセット検出後、 ユーザー確認を経て watermark をクリアする (= 次回 export で全件書き直し)
    ResetOnecommeWatermarks {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SendTemplateTestComment {
        scene_id: String,
        context: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

pub(crate) enum RealtimeCommand {
    ApplyAsyncWriteback {
        writeback: AsyncWriteback,
    },
    ApplyAsyncWritebackSync {
        writeback: AsyncWriteback,
        ack: tokio::sync::oneshot::Sender<()>,
    },
    IncomingCommentsJson {
        comments_json: String,
    },
    IncomingInnertubeActions {
        actions_json: String,
    },
    IncomingComments {
        comments: Vec<crate::state::comment::RawComment>,
    },
    CacheCommentImages {
        comments_json: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetRecentComments {
        limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 現枠 in-memory 集計 (= MainSession.live_stream_stats) のスナップショット取得。
    /// 主に test の副作用順序検証 (= ConnectionStateChanged で reset されるか) と、
    /// 将来 UI で「現枠 SC 累計 / コメ数」の pull 表示が要求された時の経路確保。
    GetLiveStreamStats {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    IncomingReaction {
        reaction: crate::state::comment::RawReaction,
    },
    CommentDeleted {
        comment_ids: Vec<String>,
    },
    ConnectionStateChanged {
        connected: bool,
        video_id: Option<String>,
    },
    AnnounceStreamOwner {
        video_id: String,
        owner_channel_id: String,
    },
}

pub(crate) enum PerformanceCommand {
    TriggerPerformance {
        scene_id: String,
        performance_id: String,
    },
    TriggerTest {
        scene_id: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    TriggerTestWithContext {
        scene_id: String,
        performance_id: String,
        context: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    TriggerTestReaction {
        scene_id: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    TriggerTestReactionCustom {
        scene_id: String,
        performance_id: String,
        reaction_key: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ClearPerformances {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetPaused {
        paused: bool,
        reply: Option<tokio::sync::oneshot::Sender<serde_json::Value>>,
    },
    GetPaused {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetHiddenListeners {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetHiddenListeners {
        users: Vec<HiddenListenerRecord>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetGlobalCooldown {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateGlobalCooldown {
        max_effects: usize,
        user_interval: f64,
    },
    GetMembershipGiftPricing {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetMembershipGiftPricing {
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenerClassificationConfig {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateListenerClassificationConfig {
        regular_stream_window: usize,
        regular_min_streams: usize,
        newcomer_first_seen_days: u32,
        veteran_first_seen_days: u32,
        reply: Option<tokio::sync::oneshot::Sender<serde_json::Value>>,
    },
    GetTtsSettings {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetTtsSettings {
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTtsState {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetTtsEnabled {
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetTtsPaused {
        paused: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ClearTts {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetNotificationSettings {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetNotificationSettings {
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetNotificationEnabled {
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetNotificationPaused {
        paused: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    EvaluateReaction {
        reaction_type: String,
    },
    HasReactionTrigger {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

pub(crate) enum SceneCommand {
    GetSceneList {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetScenes {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ReloadScenes,
    CreateSceneWithGeneratedId {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateScene {
        scene_id: String,
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteScene {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicateSceneWithGeneratedId {
        source_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicateScene {
        source_id: String,
        new_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RenameScene {
        scene_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SaveScene {
        scene_id: String,
        scene: crate::state::scene::Scene,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ReorderScenes {
        order: Vec<String>,
    },
    SetActiveScene {
        scene_id: String,
    },
    SetSceneEnabled {
        scene_id: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSceneTemplatesEnabled {
        scene_id: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSceneTemplateConfig {
        scene_id: String,
        template_name: String,
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetSceneTemplateSettings {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTemplateManifests {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTemplateManifest {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SaveTemplateManifest {
        name: String,
        manifest: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportTemplateBundledFont {
        name: String,
        src_path: String,
        family: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    EnsureTemplateFonts {
        fonts: Vec<String>,
        progress_callback: ThreadsafeFunction<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetPerformances {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SavePerformance {
        scene_id: String,
        performance: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeletePerformance {
        scene_id: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetPerformanceEnabled {
        scene_id: String,
        performance_id: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ReorderPerformances {
        scene_id: String,
        ordered_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetAppRootDir {
        dir: String,
    },
    SetActiveSceneAndSave {
        scene_id: String,
    },
    GetActiveScene {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RestoreDefaultScene {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CheckDefaultTemplateContext {
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CopyPerformanceAsset {
        scene_id: String,
        src_path: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

pub(crate) enum ImportExportCommand {
    ImportEffect {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportScene {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportPerformance {
        scene_id: String,
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportScene {
        scene_id: String,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportPerformance {
        scene_id: String,
        performance_id: String,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportEffect {
        effect_id: String,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportTemplate {
        template_name: String,
        export_name: Option<String>,
        scene_id: Option<String>,
        template_settings: serde_json::Value,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

/// Model Queue に投入されるコマンド。
/// 全Surface・全エンジンの操作がここに列挙される。
#[allow(dead_code)] // cdylib / HTTP bin / tests で入口が分かれるため target ごとに未使用 variant が出る。
pub(crate) enum ModelCommand {
    // --- CommentSurface ---
    IncomingComments {
        comments: Vec<crate::state::comment::RawComment>,
    },
    IncomingCommentsJson {
        comments_json: String,
    },
    IncomingInnertubeActions {
        actions_json: String,
    },
    CacheCommentImages {
        comments_json: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetRecentComments {
        limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 現枠 in-memory 集計 (= MainSession.live_stream_stats) のスナップショット取得。
    /// 主に test の副作用順序検証 (= ConnectionStateChanged で reset されるか) と、
    /// 将来 UI で「現枠 SC 累計 / コメ数」の pull 表示が要求された時の経路確保。
    GetLiveStreamStats {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    IncomingReaction {
        reaction: crate::state::comment::RawReaction,
    },
    CommentDeleted {
        comment_ids: Vec<String>,
    },
    ConnectionStateChanged {
        connected: bool,
        video_id: Option<String>,
    },
    /// PT-1b: 配信の owner channel id を chat-scraper / main.js から通知
    /// (Step 3 リスナー管理の自チャンネル判定に使う)
    AnnounceStreamOwner {
        video_id: String,
        owner_channel_id: String,
    },
    /// Step 3: 自チャンネル設定一覧 (channel_id + handle?) 取得。複数 ID 対応。
    GetOwnerChannels {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// わんコメ書き戻し対象のデータ変更があるかを問い合わせる
    /// (= JS close ハンドラの shutdown export skip 判定用)。
    IsListenerDbDirty {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3: 自チャンネル設定一覧の一括上書き保存。
    /// owner_channels テーブルへの永続化と MainStore.configured_owner_channel_ids 更新。
    /// 空配列で全クリア (= 未設定)。各要素は (channel_id, handle?)。
    SetOwnerChannels {
        channels: Vec<crate::state::listener::OwnerChannel>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.2a: リスナー一覧取得
    GetListeners {
        query: crate::state::listener::ListenersQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.2a: リスナー詳細 (リスナー単体 + 直近コメント) 取得
    GetListenerDetail {
        channel_id: String,
        recent_comment_limit: usize,
        /// 指定時、 ListenerRow.per_stream_* を当該枠コメで集計して埋める (B-4 で追加)。
        stream_video_id: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リスナー一覧 UI の heatmap 用 (直近 N 日 daily activity)。
    /// channel_ids 単位で 1 日 1 セル (count + has_sc)。
    GetListenersActivity {
        query: crate::state::listener::ListenersActivityQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3: ユーザー編集メタデータ (nickname / notes / label) の部分更新。
    /// `Some("")` 明示クリア / `None` 未指定 (既存維持) の 3 値セマンティクス。
    UpdateListenerMetadata {
        channel_id: String,
        nickname: Option<String>,
        notes: Option<String>,
        label: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リモート閲覧 redesign §3.1 / §4.1: 配信枠 × リスナーの「挨拶済み」トグル。
    /// per-stream リセット (= 各配信ごとに改めて挨拶する運用)。
    SetListenerGreeted {
        stream_video_id: String,
        listener_channel_id: String,
        value: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リモート閲覧 redesign §3.2 / §4.1: コメント単位の「対応済み」トグル。
    SetCommentResponded {
        comment_id: String,
        value: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 2026-05-09 仕様変更: リスナー単位の「コメ非表示」「リスナー非表示」2 軸独立フラグ。
    /// 演出への影響は撤廃済 (= 旧 SetListenerBanned)。両方 false なら record を削除する。
    /// listener の display_name / iconUrl は listeners.db から取得。
    SetListenerHidden {
        listener_channel_id: String,
        hide_from_comments: bool,
        hide_from_listeners: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3: 指定リスナー (複数可) を listeners 行 + アバター画像ファイルだけ削除する。
    /// **コメントは残す** (= 配信履歴として永続化)、streams 集計値も触らない
    /// (= comments が残るので集計は元から正しい)。同 channel_id のリスナーが
    /// 将来再登場すると過去コメントが自動で再紐付けされる (= 「常連さんの帰還」)。
    /// わんコメ DB は触らない (= 越権防止)。
    DeleteListeners {
        channel_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 指定配信を削除する。comments / stream_tags / stream_listener_state と、
    /// その配信だけに紐付いていた orphan listeners も削除する。
    DeleteStreams {
        video_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 配信メタデータ (タイトル / チャンネル名 / 同時接続数 等) の部分更新。
    /// 静的・動的フィールドを 1 コマンドで扱う。`None` は触らず、`Some` のみ更新。
    UpdateStreamMetadata {
        video_id: String,
        stream_url: Option<String>,
        title: Option<String>,
        owner_channel_id: Option<String>,
        channel_name: Option<String>,
        channel_icon_url: Option<String>,
        description: Option<String>,
        subscriber_count: Option<i64>,
        current_viewers: Option<i64>,
        peak_concurrent_viewers: Option<i64>,
        likes: Option<i64>,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        live_metadata_updated_at: Option<i64>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.2b: 配信一覧取得
    GetStreams {
        query: crate::state::listener::StreamsQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.2b: 配信詳細 (配信単体 + 直近コメント) 取得
    GetStreamDetail {
        video_id: String,
        recent_comment_limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.2b: コメント検索 (stream_id / listener / type / keyword の任意組合せ)
    SearchComments {
        query: crate::state::listener::CommentsQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 配信詳細モーダル: この配信でコメントしたリスナー一覧 (per-stream 集計 + heatmap)
    ListStreamListeners {
        video_id: String,
        query: crate::state::listener::StreamListenersQuery,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 配信詳細モーダル: 統計タブ (時系列 / 累積 / 構成 / 頻出語 / misc) を一括返却
    GetStreamStats {
        video_id: String,
        bin_minutes: i64,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 配信詳細モーダル: コメ tab の filter chip 表示用 5 種 COUNT を 1 SQL で取得
    GetCommentChipCounts {
        video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リスナー詳細モーダル: chip (全期間 / SC / この枠) 用 3 種 COUNT を取得
    GetListenerChipCounts {
        channel_id: String,
        context_video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リスナー詳細モーダル「SC のみ」chip 用: 全期間 SC コメ取得 (= recent_comments
    /// (= 直近 50 件) と独立に SC 専用で別取得、chip 数字と表示の整合を保つ)
    ListListenerSuperchats {
        channel_id: String,
        limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リスナー詳細モーダル「この枠」chip 用: 指定 stream_video_id でのコメを全件取得
    /// (= recent_comments 50 件圏外を含む)。 過去配信を開いた時に chipCounts.thisStream と
    /// 表示の乖離が起きるのを防ぐ (= count-vs-filter consistency、 2026-05-14)。
    ListListenerCommentsInStream {
        channel_id: String,
        stream_video_id: String,
        limit: usize,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 設定画面「リスナー判定」ライブプレビュー用: baseline 基準で全 audience の
    /// 6 ランク件数 (新規 / 新参 / 常連 / 古参 / 復帰 / 離脱) を 1 SQL で集計 (2026-05-14)。
    GetListenerSearchRankCounts {
        baseline_video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// リスナータブのミニタブ件数バッジ: 接続中の枠で 6 種 (全て / 未挨拶 / 新規 /
    /// 再訪 / 復帰 / 新メンバー) の COUNT を 1 SQL で取得。
    GetStreamScopedListenerCounts {
        stream_video_id: String,
        q: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 配信詳細モーダル: system pill 件数 (= 全て / 新規 / 新参 / 常連 / 古参 / 復帰
    /// / 新メンバー) を 1 SQL で取得。list_stream_listeners のページング (limit 1000)
    /// と独立して全 audience に対して計算する (2026-05-13)。
    GetStreamListenerPillCounts {
        video_id: String,
        name_q: Option<String>,
        body_q: Option<String>,
        text_q: Option<String>,
        user_tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 1 リスナーに付けられた user-attached タグ一覧
    GetListenerTags {
        channel_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 1 リスナーのタグ集合を完全置換 (空 Vec で全削除)
    SetListenerTags {
        channel_id: String,
        tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 全 user-attached タグの一覧 + 利用リスナー数
    ListAllListenerTags {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: listener_tags 全行をフラットに返す (popover 用 channel_id → tags[] map)
    ListAllListenerTagAssignments {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 配信枠タグ - 1 配信のタグ取得
    GetStreamTags {
        video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 配信枠タグ - 1 配信のタグを完全置換
    SetStreamTags {
        video_id: String,
        tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 配信枠タグ - 全タグ + 利用配信数
    ListAllStreamTags {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 配信枠タグ - 全 assignment 行をフラット
    ListAllStreamTagAssignments {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 配信枠タグ - リネーム
    RenameStreamTag {
        old_name: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 配信枠タグ - 削除
    DeleteStreamTag {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: タグ名を一括変更 (新名と既存衝突は統合)
    RenameListenerTag {
        old_name: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: タグ名を全リスナーから削除
    DeleteListenerTag {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 指定 scope の保存検索一覧 (= 2026-05-14 Phase 2c)
    ListSavedSearches {
        scope: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 保存検索を新規作成 (scope + name + JSON conditions)
    CreateSavedSearch {
        scope: String,
        name: String,
        conditions_json: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 保存検索の部分更新 (None は触らない)
    UpdateSavedSearch {
        id: i64,
        name: Option<String>,
        conditions_json: Option<String>,
        sort_order: Option<i64>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 拡張: 保存検索を id 指定で削除
    DeleteSavedSearch {
        id: i64,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.3: こめはぶ形式 JSON Lines エクスポート
    /// listener_sync_queue 経由で実行 (重い I/O)
    ExportKomehubJsonl {
        out_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.3: こめはぶ形式 JSON Lines インポート
    /// listener_sync_queue 経由で実行
    ImportKomehubJsonl {
        src_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.4: わんコメ DB から listeners.db へインポート (Plan A)
    /// listener_sync_queue 経由で実行
    ImportFromOnecomme {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 空 title/channel_name の自チャ過去 stream を Electron resolver で後追い補完する
    /// (= 起動時 backfill。import の Pass 0 と同じロジックを単独実行)。fire-and-forget、
    /// 完了時に SSE stream-meta-repaired を push して 配信ログ UI を更新する。
    BackfillStreamMeta,
    /// Step 3 フェーズ 3.5: わんコメ DB へ書き戻し (Plan A)
    /// listener_sync_queue 経由 + バックアップ + スキーマ照合
    ExportToOnecomme {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.5: わんコメ起動検知 (HTTP 11180 を 200ms タイムアウトで GET)
    DetectOnecommeRunning {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// Step 3 フェーズ 3.5: 双方向同期 (import → export 一気通貫)
    /// 起動時自動同期 (F-20) と「今すぐ同期」(F-21) ボタンから呼ばれる。
    /// 配信中・わんコメ起動中・自チャンネル未設定時はスキップして reason を返す。
    RunBidirectionalSync {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// わんコメ DB リセット検出後、 watermark を初期化 (= 次回 export で全件書き直し)
    ResetOnecommeWatermarks {
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SendTemplateTestComment {
        scene_id: String,
        context: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- PerformanceSurface ---
    TriggerPerformance {
        scene_id: String,
        performance_id: String,
    },
    TriggerTest {
        scene_id: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    TriggerTestWithContext {
        scene_id: String,
        performance_id: String,
        context: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    TriggerTestReaction {
        scene_id: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    TriggerTestReactionCustom {
        scene_id: String,
        performance_id: String,
        reaction_key: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ClearPerformances {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetPaused {
        paused: bool,
        reply: Option<tokio::sync::oneshot::Sender<serde_json::Value>>,
    },
    GetPaused {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// 2026-05-09 仕様変更: 旧 BannedUsers (= 演出フィルタ用) を hidden_listeners (= UI 表示抑制用) に rename。
    /// 旧 UpdateBannedUsers (= 演出側からの fire-and-forget) は撤廃 (= 演出フィルタ廃止のため不要)。
    GetHiddenListeners {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetHiddenListeners {
        users: Vec<HiddenListenerRecord>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetGlobalCooldown {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateGlobalCooldown {
        max_effects: usize,
        user_interval: f64,
    },
    GetMembershipGiftPricing {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetMembershipGiftPricing {
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetListenerClassificationConfig {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateListenerClassificationConfig {
        regular_stream_window: usize,
        regular_min_streams: usize,
        newcomer_first_seen_days: u32,
        veteran_first_seen_days: u32,
        reply: Option<tokio::sync::oneshot::Sender<serde_json::Value>>,
    },
    GetTtsSettings {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetTtsSettings {
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTtsState {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetTtsEnabled {
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetTtsPaused {
        paused: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ClearTts {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    // --- Notification (Phase C) ---
    GetNotificationSettings {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetNotificationSettings {
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetNotificationEnabled {
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetNotificationPaused {
        paused: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    EvaluateReaction {
        reaction_type: String,
    },
    HasReactionTrigger {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- SceneSurface ---
    GetSceneList {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetScenes {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ReloadScenes,
    CreateSceneWithGeneratedId {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateScene {
        scene_id: String,
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteScene {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicateSceneWithGeneratedId {
        source_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicateScene {
        source_id: String,
        new_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RenameScene {
        scene_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SaveScene {
        scene_id: String,
        scene: crate::state::scene::Scene,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ReorderScenes {
        order: Vec<String>,
    },
    SetActiveScene {
        scene_id: String,
    },
    SetSceneEnabled {
        scene_id: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- PerformanceCrudSurface ---
    GetPerformances {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SavePerformance {
        scene_id: String,
        performance: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeletePerformance {
        scene_id: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetPerformanceEnabled {
        scene_id: String,
        performance_id: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ReorderPerformances {
        scene_id: String,
        ordered_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- AppConfigSurface ---
    SetAppRootDir {
        dir: String,
    },
    SetActiveSceneAndSave {
        scene_id: String,
    },
    GetActiveScene {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RestoreDefaultScene {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CheckDefaultTemplateContext {
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CopyPerformanceAsset {
        scene_id: String,
        src_path: String,
        performance_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- PresetSurface ---
    GetPresetList {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetCurrentPreset {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SwitchPreset {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicatePreset {
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeletePreset {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportPreset {
        dest_path: String,
        export_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportPreset {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetCurrentPreset {
        name: String,
    },

    // --- BackupSurface ---
    GetBackupList {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateBackup {
        options: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateFullBackup {
        name: Option<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DeleteBackup {
        backup_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RestoreBackup {
        backup_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetBackupsDir {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetBackupsDir {
        dir: String,
    },
    GetDataOverview {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ConfirmUpgradeEffect {
        zip_path: String,
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- ImportSurface ---
    ImportEffect {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportScene {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportPerformance {
        scene_id: String,
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- ExportSurface ---
    ExportScene {
        scene_id: String,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportPerformance {
        scene_id: String,
        performance_id: String,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportEffect {
        effect_id: String,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ExportTemplate {
        template_name: String,
        export_name: Option<String>,
        scene_id: Option<String>,
        template_settings: serde_json::Value,
        dest_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- TemplateSurface ---
    GetTemplates {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    InstallTemplate {
        zip_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateTemplateFromStarter {
        starter_type: String,
        template_id: String,
        display_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    CreateTemplateFromBuiltin {
        source_template_id: String,
        template_id: String,
        display_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RemoveTemplate {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTemplateDirectory {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTemplateManifest {
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetSceneTemplates {
        scene_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    AddSceneTemplate {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RemoveSceneTemplate {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSelectedSceneTemplate {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSceneTemplateEnabled {
        scene_id: String,
        template_name: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSceneTemplatesEnabled {
        scene_id: String,
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SetSceneTemplateConfig {
        scene_id: String,
        template_name: String,
        settings: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetSceneTemplateSettings {
        scene_id: String,
        template_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetTemplateManifests {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SaveTemplateManifest {
        name: String,
        manifest: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ImportTemplateBundledFont {
        name: String,
        src_path: String,
        family: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    EnsureTemplateFonts {
        fonts: Vec<String>,
        progress_callback: ThreadsafeFunction<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- EffectSurface ---
    GetEffects {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetEffect {
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    AddEffect {
        effect: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    UpdateEffect {
        effect: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    RemoveEffect {
        effect_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    DuplicateEffect {
        effect_id: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetPluginManifests {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    ApplyAsyncWriteback {
        writeback: AsyncWriteback,
    },
    ApplyAsyncWritebackSync {
        writeback: AsyncWriteback,
        ack: tokio::sync::oneshot::Sender<()>,
    },

    // --- DebugSupportSurface (= デバッグログ ON/OFF) ---
    /// デバッグログ ON/OFF の現在値を取得する (= 設定 UI の初期表示用)。
    GetDebugLoggingEnabled {
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    /// デバッグログ ON/OFF を保存する (= 設定切替時、 反映は再起動)。
    /// AppConfig.debug_logging_enabled に書き込み、 app-config.json を save する。
    SetDebugLoggingEnabled {
        enabled: bool,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    },

    // --- LifecycleSurface ---
    Shutdown,
}
