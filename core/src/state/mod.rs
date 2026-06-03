pub mod comment;
pub mod performance_log;
pub mod scene;
pub mod engine_status;
pub mod connection;
pub mod listener;

use comment::CanonicalCommentStore;
use comment::CommentTimeline;
use comment::ReactionCounts;
use connection::ConnectionState;
use engine_status::EngineState;
use performance_log::PerformanceLog;
use scene::SceneStore;

/// Static — 低頻度・状態系データを保持する MainStore。
/// 変更時に SSE で Electron 側のコピーを更新する。
pub struct MainStore {
    pub performance_engine_state: EngineState,
    pub connection: ConnectionState,
    pub scenes: SceneStore,
    /// アプリのルートディレクトリ（electron/ の親、defaults/ を含む）
    pub app_root_dir: std::path::PathBuf,
    /// Step 3: 自チャンネル設定 (UC..., 複数 ID = サブチャンネル等)。
    /// listeners.db の owner_channels テーブルから起動時に load し、
    /// SetOwnerChannelIds で更新する。
    /// `connection.current_stream_owner_channel_id` がこの集合に含まれるときだけ
    /// listener_record_queue に投入される (自チャンネル判定)。
    pub configured_owner_channel_ids: Vec<String>,
}

impl Default for MainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MainStore {
    pub fn new() -> Self {
        Self {
            performance_engine_state: EngineState::Initializing,
            connection: ConnectionState::new(),
            scenes: SceneStore::new(),
            app_root_dir: std::path::PathBuf::new(),
            configured_owner_channel_ids: Vec::new(),
        }
    }
}

/// Session — 高頻度・ストリーム系データを保持する MainSession。
/// 継続的に SSE で Electron に配信される。
pub struct MainSession {
    pub comment_timeline: CommentTimeline,
    pub canonical_comment_store: CanonicalCommentStore,
    pub reaction_counts: ReactionCounts,
    pub performance_log: PerformanceLog,
    /// 現接続中の配信枠の live 集計 (= comment count / SC 累計 JPY)。
    /// 自枠 (= configured owner) では `streams.comment_count` 等の DB 集計が path 2
    /// (= persisted) で配信されるが、他枠では DB に記録しない (= record_comment skip)
    /// ため、ephemeral push (path 1) に同等の値を載せたい。これがその source。
    /// `handle_incoming_comments` で increment、接続切替 / 切断で reset する。
    pub live_stream_stats: LiveStreamStats,
    /// 現接続枠で processing 済の comment.id 集合 (= permanent dedup gate)。
    /// canonical_comment_store は cap 2000 で eviction するため、長時間配信で
    /// reconnect backfill が来た時に「evicted 済の古い id」を `is_new` 扱いで
    /// 再 process してしまい、live_stream_stats / comment_timeline の二重カウント
    /// 等が発生していた (2026-05-10 検出)。これを防ぐため id だけ cap なしで
    /// 保持する (= memory 効率: 1 id ≒ 30 bytes、4 時間配信 50k コメで ~1.5 MB)。
    /// 接続切替時に clear する (= canonical_comment_store と同じトリガー)。
    pub seen_comment_ids: std::collections::HashSet<String>,
}

impl Default for MainSession {
    fn default() -> Self {
        Self::new()
    }
}

impl MainSession {
    pub fn new() -> Self {
        Self {
            comment_timeline: CommentTimeline::new(1000),
            canonical_comment_store: CanonicalCommentStore::new(2000),
            reaction_counts: ReactionCounts::new(),
            performance_log: PerformanceLog::new(64),
            live_stream_stats: LiveStreamStats::default(),
            seen_comment_ids: std::collections::HashSet::new(),
        }
    }
}

/// 現接続中の配信枠の live 集計 (in-memory only、再起動 / 切断で消える前提)。
/// 接続切替時に `video_id` を更新して count / amount を 0 リセットする。
/// stream_title は UpdateStreamMetadata 受信時に更新、 通知テンプレ `{streamTitle}` で参照。
#[derive(Debug, Clone, Default)]
pub struct LiveStreamStats {
    pub video_id: String,
    pub stream_title: String,
    pub comment_count: i64,
    pub superchat_amount_jpy: i64,
}
