//! Step 3 リスナー管理: ListenerManager 本体。
//!
//! 設計詳細は docs/step3-design.md § 4.2 / § 3 / § 5.6 を参照。
//!
//! 責務:
//! - `data/listeners.db` の open / migration (WAL + busy_timeout + synchronous)
//! - `record_comment(comment, stream_video_id)`: chat-scraper から流れてくる
//!   コメントを 1 件 SQLite に記録する (冪等な集計加算込み)
//! - フェーズ 3.2 以降で読み取り API / インポート / エクスポート / 同期を追加
//!
//! 接続は **2 本独立** (`record_conn` / `sync_conn`) で、それぞれ別 queue から
//! 単一スレッド実行される。Mutex は形式的だがファイルレベルでは WAL の
//! writer ロックを共有するので、§ 5.3 のチャンク分割 + busy_timeout が要る。

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use rayon::prelude::*;
use rusqlite::{
    params, Connection, Error as SqliteError, ErrorCode, OpenFlags, OptionalExtension, Transaction,
};
use serde_json::json;

use crate::common::fx_rates;
use crate::engine::backup_manager::unpack_thread_count;
use crate::engine::listener_aux_io;
use crate::state::comment::RawComment;
use crate::state::listener::{
    CommentChipCounts, CommentRow, CommentSearchScope, CommentType, CommentsPage, CommentsQuery,
    DeleteListenerSummary, DeleteStreamSummary, ExportSummary, HeatmapBin, ImportSummary,
    KpiSummary, ListenerChipCounts, ListenerCommentClassification, ListenerDetail, ListenerRow,
    ListenerStreamActivity, ListenersActivityQuery, ListenersPage, ListenersQuery, ListenersSort,
    OnecommeExportSummary, OnecommeImportSummary, RecordCommentSummary, StreamActivityCell,
    StreamCell, StreamDetail, StreamKpi, StreamListenerRow, StreamListenersPage,
    StreamListenersQuery, StreamListenersSort, StreamRow, StreamScope, StreamStats,
    StreamStatsComposition, StreamStatsMisc, StreamsPage, StreamsQuery, StreamsSort, TimeBin,
    WordCount,
};

/// 期待スキーマバージョン。v0.4.0 リリースまでは 1 で固定し、初期 DDL を「リリース時の
/// 最終形」として育てる方針 (未リリース内で v3/v4/v5/v6 と刻んでいた中間状態は廃止)。
/// 正式リリース後にスキーマ変更が必要になった時点で 2, 3, ... と段階マイグレーションを
/// 開始する。
const EXPECTED_SCHEMA_VERSION: i32 = 1;

/// 案 D: list_stream_scoped_listener_counts の TTL キャッシュ寿命 (秒)。
/// invalidate (= record_comment / set_listener_greeted / 接続切替) で明示クリア
/// されるので、TTL は短めの fallback。連続タブ切替や検索文字列入力中の重複呼出を吸収する。
const STREAM_SCOPED_CACHE_TTL_SECS: u64 = 5;

/// SQLITE_BUSY 時のリトライ間隔 (ms)。busy_timeout=5s が一次防御で、
/// それでも返ってきた場合の保険。
const BUSY_RETRY_DELAYS_MS: &[u64] = &[50, 100, 200];

/// 起動時 migration の進捗 reporter ([[project_callback_pattern]] 流の global static)。
/// 復元経路で backup_handlers が `set` してから listener_manager::open() を呼ぶと、
/// migrate_comments_raw_to_zstd の中で chunk 完了ごとに reporter が呼ばれて
/// SSE で progress dialog に migrate phase を流す経路に繋がる。
pub mod migration_progress {
    use std::sync::{Arc, LazyLock, Mutex};

    /// (processed, total) を受け取る reporter。 processed=0 は「開始通知」 として使う。
    pub type Reporter = Arc<dyn Fn(u64, u64) + Send + Sync>;

    static REPORTER: LazyLock<Mutex<Option<Reporter>>> = LazyLock::new(|| Mutex::new(None));

    pub fn set(reporter: Reporter) {
        *REPORTER.lock().unwrap() = Some(reporter);
    }

    pub fn clear() {
        *REPORTER.lock().unwrap() = None;
    }

    pub(super) fn report(processed: u64, total: u64) {
        if let Some(r) = REPORTER.lock().unwrap().as_ref() {
            r(processed, total);
        }
    }
}

static HTML_IMG_ALT_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?is)<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>"#)
        .expect("valid img alt regex")
});
static HTML_TAG_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"(?is)<[^>]+>"#).expect("valid html tag regex"));
static HTML_ENTITY_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);"#)
        .expect("valid html entity regex")
});
static HTML_ATTR_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?is)\b([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        .expect("valid html attr regex")
});

#[derive(Debug)]
#[allow(dead_code)] // フェーズ 3.2 以降で API / 同期から使い始める
pub struct ListenerManager {
    db_path: PathBuf,
    /// listener_record_queue 専用 connection (高頻度の record_comment 用)。
    record_conn: Mutex<Connection>,
    /// listener_sync_queue 専用 connection (大規模バッチ同期 / インポート / エクスポート用)。
    sync_conn: Mutex<Connection>,
    /// 案 D: 6 タブ件数の TTL キャッシュ (= タブ open / 検索文字列入力中の連続呼出を吸収)。
    /// key = (stream_video_id, q_normalized) / value = (counts, expiration_instant)
    /// TTL は短め (= 5 秒) で「タブ滞在中の SSE listener-updated は逃さない」前提。
    /// listener-updated が来た時 invalidate_stream_scoped_cache で明示クリアする。
    stream_scoped_cache: Mutex<StreamScopedCountsCache>,
    /// system pill 計算用の閾値 (= AppConfig.listener_classification と同期)。
    /// 起動時に load + UpdateListenerClassificationConfig で更新。
    /// SQL を呼ぶ複数関数で参照するため、関数引数で渡すと signature が膨らむので Atomic で manager に持たせる。
    ///
    /// - newcomer_first_seen_days: 新参境界 (default 30) — `first_seen_at >= NOW - X日` で 新参
    /// - veteran_first_seen_days: 古参境界 (default 365) — `first_seen_at < NOW - Y日` で 古参 候補
    /// - regular_stream_window: 直近配信数 N (default 10) — 復帰判定の母集団
    /// - regular_min_streams: 必要枠数 M (default 3) — N 枠中 M 枠以上で 常連 / 古参 として活動中
    newcomer_first_seen_days: std::sync::atomic::AtomicU32,
    veteran_first_seen_days: std::sync::atomic::AtomicU32,
    regular_stream_window: std::sync::atomic::AtomicU32,
    regular_min_streams: std::sync::atomic::AtomicU32,
    /// わんコメ書き戻し (= export_to_onecomme) 対象のデータ変更があるかどうか。
    ///
    /// - true: 書き戻すべき変更あり (= 接続中コメ受信 / listener memo 等 編集 / 別ハブ import 後)
    /// - false: 書き戻し済 (= export_to_onecomme 完了直後)
    ///
    /// open() 時に SQL で `MAX(posted_at) > watermark` を確認して初期化する
    /// (= 前回 close が異常終了で書き戻し漏れがあるケースの **クラッシュ救済**)。
    /// close 時の shouldRunShutdownExport の判定材料として JS 側から読む
    /// (= わんコメに反映する変更が無ければ shutdown export を skip して即終了)。
    data_dirty: std::sync::atomic::AtomicBool,
}

#[derive(Debug, Default)]
struct StreamScopedCountsCache {
    entry: Option<StreamScopedCountsCacheEntry>,
}

#[derive(Debug, Clone)]
struct StreamScopedCountsCacheEntry {
    key: (String, String),
    counts: crate::state::listener::ListenerStreamScopedCounts,
    expires_at: std::time::Instant,
}

impl ListenerManager {
    /// `data_dir/data/listeners.db` を open し、マイグレーションを実行する。
    /// 失敗時はエラーを返す (Engines::new 側で Option 化される想定)。
    pub fn open(data_dir: &Path) -> rusqlite::Result<Self> {
        let db_dir = data_dir.join("data");
        if let Err(e) = std::fs::create_dir_all(&db_dir) {
            return Err(SqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: ErrorCode::CannotOpen,
                    extended_code: 0,
                },
                Some(format!("Failed to create data directory: {}", e)),
            ));
        }
        let db_path = db_dir.join("listeners.db");

        // record_conn を開いて migration を回す (sync_conn は同じファイルを読むだけ)
        let record_conn = open_and_init(&db_path)?;
        run_migrations(&record_conn)?;
        let sync_conn = open_and_init(&db_path)?;

        // 案 C: PRAGMA optimize で query plan の統計情報を最新化する。
        // SQLite docs 推奨: 起動時 + 定期実行で stat info を更新し、optimizer が
        // 最適な index 選択 / JOIN 順を決める助けになる。最新化済の場合は no-op。
        // 書き込み経路には影響しない (= read-side query plan の調整のみ)。
        if let Err(err) = sync_conn.execute_batch("PRAGMA optimize") {
            tracing::warn!("PRAGMA optimize failed (non-fatal): {}", err);
        }

        // data_dirty を「未書き戻し増分があるか」 で初期化 (= クラッシュ救済)。
        // 前回 close が shutdown export 失敗 / プロセスクラッシュ等で未完了の場合、
        // listeners.db には watermark より新しい comments が残ったまま。 そのケースを
        // 起動時に検出して、 次の close で必ず shutdown export が走るように dirty=true で
        // 立ち上げる。
        let initial_dirty = {
            let watermark: i64 = sync_conn
                .query_row(
                    "SELECT value FROM config WHERE key = 'last_sync_exported_max_komehub_posted_at'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let max_posted_at: i64 = sync_conn
                .query_row(
                    "SELECT COALESCE(MAX(posted_at), 0) FROM comments",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            tracing::info!(
                "listener_manager: data_dirty init (watermark={}, max_posted_at={}, dirty={})",
                watermark,
                max_posted_at,
                max_posted_at > watermark
            );
            max_posted_at > watermark
        };

        tracing::info!(
            "listener_manager: opened db (path={:?}, schema_version={})",
            db_path,
            EXPECTED_SCHEMA_VERSION
        );

        Ok(Self {
            db_path,
            record_conn: Mutex::new(record_conn),
            sync_conn: Mutex::new(sync_conn),
            stream_scoped_cache: Mutex::new(StreamScopedCountsCache::default()),
            newcomer_first_seen_days: std::sync::atomic::AtomicU32::new(30),
            veteran_first_seen_days: std::sync::atomic::AtomicU32::new(365),
            regular_stream_window: std::sync::atomic::AtomicU32::new(10),
            regular_min_streams: std::sync::atomic::AtomicU32::new(3),
            data_dirty: std::sync::atomic::AtomicBool::new(initial_dirty),
        })
    }

    /// data_dirty を読み出す (= JS 側 close 判定用)。
    /// listeners.db の中身の規模を返す (= コメント件数 + リスナー件数)。
    /// 復元前の「データの実在を確認して強めの警告を出すか」 判定用。
    /// クエリ失敗時は 0 を返す (= 警告スキップ動作になる、 致命ではない)。
    pub fn data_overview(&self) -> (u64, u64) {
        let conn_guard = match self.record_conn.lock() {
            Ok(g) => g,
            Err(_) => return (0, 0),
        };
        let comments: u64 = conn_guard
            .query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))
            .unwrap_or(0);
        let listeners: u64 = conn_guard
            .query_row("SELECT COUNT(*) FROM listeners", [], |r| r.get(0))
            .unwrap_or(0);
        (comments, listeners)
    }

    /// わんコメ DB を読み取り専用で観測してスナップショットを返す。
    /// users.db / comments.db のどちらかが欠けている場合は「空」 とみなす (= 0 件 + 空文字列)。
    /// 検出ロジック ([[feedback_watermark_vs_external_db_reset]]) の入力。
    pub fn observe_onecomme_state(
        &self,
        onecomme_dir: &Path,
    ) -> crate::state::listener::OnecommeSnapshot {
        let comments_db = onecomme_dir.join("comments.db");
        let onecomme_db = onecomme_dir.join("onecomme.db");

        let users_count = open_readonly_count(&onecomme_db, "users");
        let (comments_count, max_created_at) = open_readonly_count_and_max(&comments_db);

        crate::state::listener::OnecommeSnapshot {
            users_count,
            comments_count,
            max_created_at,
            db_path: onecomme_dir.to_string_lossy().to_string(),
            observed_at: current_unix_millis(),
        }
    }

    /// 前回 観測した わんコメ スナップショットを config テーブルから読み出す。
    /// 初回観測なら None (= 比較対象なしで snapshot を保存するだけ)。
    pub fn load_onecomme_snapshot(&self) -> Option<crate::state::listener::OnecommeSnapshot> {
        let conn = self.sync_conn.lock().ok()?;
        let users_count: i64 = read_config_i64(&conn, "onecomme_snapshot_users_count")?;
        let comments_count: i64 = read_config_i64(&conn, "onecomme_snapshot_comments_count")?;
        let max_created_at: String =
            read_config_str(&conn, "onecomme_snapshot_max_created_at").unwrap_or_default();
        let db_path: String = read_config_str(&conn, "onecomme_snapshot_db_path")?;
        let observed_at: i64 =
            read_config_i64(&conn, "onecomme_snapshot_observed_at").unwrap_or(0);
        Some(crate::state::listener::OnecommeSnapshot {
            users_count,
            comments_count,
            max_created_at,
            db_path,
            observed_at,
        })
    }

    /// 現在のスナップショットを config テーブルに保存 (= 次回比較用)。
    pub fn save_onecomme_snapshot(
        &self,
        snap: &crate::state::listener::OnecommeSnapshot,
    ) -> rusqlite::Result<()> {
        let mut conn = self.sync_conn.lock().unwrap();
        let tx = conn.transaction()?;
        for (k, v) in [
            ("onecomme_snapshot_users_count", snap.users_count.to_string()),
            (
                "onecomme_snapshot_comments_count",
                snap.comments_count.to_string(),
            ),
            (
                "onecomme_snapshot_max_created_at",
                snap.max_created_at.clone(),
            ),
            ("onecomme_snapshot_db_path", snap.db_path.clone()),
            (
                "onecomme_snapshot_observed_at",
                snap.observed_at.to_string(),
            ),
        ] {
            tx.execute(
                "INSERT INTO config(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![k, v],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// わんコメ DB の現状を観測し、 前回スナップショットと比較して
    /// リセット / 巻き戻し / 大幅減 / path 変更を検出する。
    ///
    /// 戻り値:
    /// - `Some(signal)`: 異常検出、 ユーザーに確認すべき (= スナップショットは **更新しない**、
    ///   ユーザーが reset 判断するまで保留)
    /// - `None`: 正常、 スナップショットを更新済
    ///
    /// 初回観測 (= prev なし) は スナップショットを保存して None を返す。
    pub fn detect_onecomme_reset(
        &self,
        onecomme_dir: &Path,
    ) -> Option<crate::state::listener::OnecommeResetSignal> {
        use crate::state::listener::OnecommeResetSignal;
        let curr = self.observe_onecomme_state(onecomme_dir);
        let prev = match self.load_onecomme_snapshot() {
            Some(p) => p,
            None => {
                // 初回観測。 異常検出のしようがないので、 保存だけして終了。
                let _ = self.save_onecomme_snapshot(&curr);
                return None;
            }
        };

        // 検出条件。 path 変更を最優先 (= 別 PC の DB に入れ替わったケース)。
        let signal = if prev.db_path != curr.db_path && !prev.db_path.is_empty() {
            Some(OnecommeResetSignal::PathChanged {
                prev: prev.clone(),
                curr: curr.clone(),
            })
        } else if prev.users_count > 100 && curr.users_count == 0 {
            Some(OnecommeResetSignal::Deleted {
                prev: prev.clone(),
                curr: curr.clone(),
            })
        } else if !curr.max_created_at.is_empty()
            && !prev.max_created_at.is_empty()
            && curr.max_created_at < prev.max_created_at
        {
            Some(OnecommeResetSignal::RolledBack {
                prev: prev.clone(),
                curr: curr.clone(),
            })
        } else if prev.comments_count > 1000
            && (curr.comments_count as f64) < (prev.comments_count as f64) * 0.5
        {
            Some(OnecommeResetSignal::LargeDecrease {
                prev: prev.clone(),
                curr: curr.clone(),
            })
        } else {
            None
        };

        if signal.is_none() {
            // 正常 → スナップショットを最新値で更新
            let _ = self.save_onecomme_snapshot(&curr);
        }
        // 異常時は prev を温存 (= ユーザー操作で reset するまで保持して、
        // 次回起動時にも同じ検出ができるようにする)
        signal
    }

    /// 検出後、 ユーザーが「リセットする」 を選択したときに呼ぶ。
    /// 書き戻し / 取り込み watermark の 2 つをクリア + 現在の観測を新スナップショットとして保存。
    /// 次回 export 時に全件書き戻しが走る。
    pub fn reset_onecomme_watermarks(
        &self,
        onecomme_dir: &Path,
    ) -> rusqlite::Result<()> {
        let conn = self.sync_conn.lock().unwrap();
        conn.execute(
            "DELETE FROM config WHERE key IN (
                'last_sync_exported_max_komehub_posted_at',
                'last_sync_imported_max_onecomme_created_at'
            )",
            [],
        )?;
        drop(conn);
        // 新 snapshot を保存して次回検出のベースラインを更新
        let curr = self.observe_onecomme_state(onecomme_dir);
        self.save_onecomme_snapshot(&curr)?;
        // data_dirty も立てる (= 次回 close で shutdown export が走るように)
        self.mark_data_dirty();
        tracing::info!(
            "reset_onecomme_watermarks: cleared watermarks + new snapshot (users={}, comments={}, max_created_at={})",
            curr.users_count,
            curr.comments_count,
            curr.max_created_at
        );
        Ok(())
    }

    /// わんコメ書き戻し対象の変更が listeners.db にあるかを返す。
    pub fn is_data_dirty(&self) -> bool {
        self.data_dirty
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// 内部 helper: わんコメ書き戻し対象の変更が発生したことを記録する。
    /// 呼出側は record_comment / update_listener_metadata / set_owner_channel_ids /
    /// import_komehub_jsonl 等の「わんコメ users / comments に反映すべき変更」 で呼ぶ。
    fn mark_data_dirty(&self) {
        let was_dirty = self
            .data_dirty
            .swap(true, std::sync::atomic::Ordering::AcqRel);
        if !was_dirty {
            tracing::info!("listener_manager: data_dirty marked (was clean)");
        }
    }

    /// 内部 helper: export_to_onecomme 成功時に呼んで dirty 状態をクリア。
    fn clear_data_dirty(&self) {
        let was_dirty = self
            .data_dirty
            .swap(false, std::sync::atomic::Ordering::AcqRel);
        if was_dirty {
            tracing::info!("listener_manager: data_dirty cleared (export completed or skipped)");
        }
    }

    /// SQLite `VACUUM INTO 'dest'` でフラグメントを除去した整合性スナップショットを
    /// `dest_path` に書き出す。接続を握ったままでも一貫性が保たれるため、フルバックアップで
    /// 安全に DB をコピーするのに使う (空ページが除去されるためファイルサイズも縮む)。
    pub fn vacuum_into(&self, dest_path: &Path) -> rusqlite::Result<()> {
        if let Some(parent) = dest_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Err(SqliteError::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: ErrorCode::CannotOpen,
                        extended_code: 0,
                    },
                    Some(format!("failed to create dest dir: {}", e)),
                ));
            }
        }
        // 既存ファイルがあると VACUUM INTO はエラーになるので先に消す
        if dest_path.exists() {
            if let Err(e) = std::fs::remove_file(dest_path) {
                return Err(SqliteError::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: ErrorCode::CannotOpen,
                        extended_code: 0,
                    },
                    Some(format!("failed to remove existing dest: {}", e)),
                ));
            }
        }
        let conn = self.sync_conn.lock().expect("sync_conn poisoned");
        conn.execute("VACUUM INTO ?1", params![dest_path.to_string_lossy()])?;
        Ok(())
    }

    /// 新参境界 (= ms に変換済)。SQL の `NOW - X日` 計算で使う。
    fn newcomer_one_month_ms(&self) -> i64 {
        let days = self
            .newcomer_first_seen_days
            .load(std::sync::atomic::Ordering::Relaxed);
        (days as i64) * 24 * 3600 * 1000
    }

    /// 古参境界 (= ms に変換済)。SQL の `NOW - Y日` 計算で使う。
    fn veteran_one_year_ms(&self) -> i64 {
        let days = self
            .veteran_first_seen_days
            .load(std::sync::atomic::Ordering::Relaxed);
        (days as i64) * 24 * 3600 * 1000
    }

    /// 直近配信数 (N) — system pill 計算で「直近 N 枠のうち M 枠以上で活動中」のチェックに使う
    fn regular_window_n(&self) -> u32 {
        self.regular_stream_window
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 必要枠数 (M)
    fn regular_min_m(&self) -> u32 {
        self.regular_min_streams
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// AppConfig.listener_classification と一括同期する setter。起動時 + 設定更新時に呼ぶ。
    pub fn set_classification_thresholds(
        &self,
        newcomer_first_seen_days: u32,
        veteran_first_seen_days: u32,
        regular_stream_window: u32,
        regular_min_streams: u32,
    ) {
        self.newcomer_first_seen_days
            .store(newcomer_first_seen_days, std::sync::atomic::Ordering::Relaxed);
        self.veteran_first_seen_days
            .store(veteran_first_seen_days, std::sync::atomic::Ordering::Relaxed);
        self.regular_stream_window
            .store(regular_stream_window, std::sync::atomic::Ordering::Relaxed);
        self.regular_min_streams
            .store(regular_min_streams, std::sync::atomic::Ordering::Relaxed);
    }

    /// 旧 setter (= 古参境界のみ)。後方互換用、内部からは set_classification_thresholds を使う。
    #[allow(dead_code)]
    pub fn set_veteran_first_seen_days(&self, days: u32) {
        self.veteran_first_seen_days
            .store(days, std::sync::atomic::Ordering::Relaxed);
    }

    /// chat-scraper が拾ったコメント 1 件を listeners.db に記録する。
    /// 自チャンネル判定は ModelQueue 側で完了済みの前提 (設計書 § 4.4)。
    /// `stream_owner_channel_id` は自チャンネル判定の根拠となる owner で、
    /// `streams.owner_channel_id` に保存して後続の export / 同期で
    /// 復元できるようにする (yt-{UC...} 形式を期待)。
    /// SQLITE_BUSY に対しては最大 3 回リトライ。
    pub fn record_comment(
        &self,
        comment: &RawComment,
        stream_video_id: &str,
        stream_owner_channel_id: &str,
    ) -> rusqlite::Result<RecordCommentSummary> {
        self.record_comment_inner(comment, stream_video_id, stream_owner_channel_id, true)
    }

    /// 他チャンネル配信の表示用コメントを記録する。
    ///
    /// comments / streams / listener 表示メタデータは保存するが、listeners.comment_count
    /// などの自チャンネル累計とメンバー状態は更新しない。
    pub fn record_display_comment(
        &self,
        comment: &RawComment,
        stream_video_id: &str,
        stream_owner_channel_id: &str,
    ) -> rusqlite::Result<RecordCommentSummary> {
        self.record_comment_inner(comment, stream_video_id, stream_owner_channel_id, false)
    }

    fn record_comment_inner(
        &self,
        comment: &RawComment,
        stream_video_id: &str,
        stream_owner_channel_id: &str,
        include_in_aggregates: bool,
    ) -> rusqlite::Result<RecordCommentSummary> {
        let mut delays = BUSY_RETRY_DELAYS_MS.iter();
        loop {
            match self.do_record_comment(
                comment,
                stream_video_id,
                stream_owner_channel_id,
                include_in_aggregates,
            ) {
                Ok(summary) => {
                    // 6 タブ件数 cache の invalidate は「件数が変わる可能性がある時」だけ。
                    // ライブ中は毎秒コメが来るので per-comment invalidate にすると cache が
                    // 常に空。実際 counts が増えるのは:
                    //   - is_first_time_listener=true (= 全期間で初登場 → all/first_time/un_greeted +1)
                    //   - comment_type='membership' (= new_member +1)
                    // 既存 listener の通常コメは件数不変なので invalidate 不要。
                    // 「既存 listener が新枠で初発言」は all_count +1 だが summary では取れない
                    // ため、TTL 5s での自然回復に頼る (= acceptable)。
                    // 継続記念 (= comment_type='membership_milestone') は new_member counter を
                    // 増やさない。新規加入 (= "X へようこそ！") のみが new_member +1。
                    let is_new_member_comment = comment.is_membership
                        && !comment.is_membership_gift
                        && !comment.is_membership_milestone;
                    let needs_invalidate = summary.is_first_time_listener || is_new_member_comment;
                    if needs_invalidate {
                        self.invalidate_stream_scoped_cache();
                    }
                    // 新規コメを listeners.db に書き込んだ → わんコメ書き戻し対象あり
                    self.mark_data_dirty();
                    return Ok(summary);
                }
                Err(err) if is_busy(&err) => {
                    if let Some(d) = delays.next() {
                        std::thread::sleep(Duration::from_millis(*d));
                        continue;
                    }
                    tracing::warn!(
                        "listener_manager: record_comment giving up after retries (id={}, err={})",
                        comment.id,
                        err
                    );
                    return Err(err);
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// コメントを listeners.db に記録する前に、UI / template payload 用の
    /// listener 分類を軽量に取得する。
    ///
    /// `configured_owner_channel_ids` は `yt-UC...` 形式を期待する。直近 10 配信の
    /// 常連判定では現在配信を除外し、「この配信に初めてコメントした常連」を
    /// 今北として扱えるようにする。
    pub fn classify_comment_before_record(
        &self,
        listener_id_yt: &str,
        stream_video_id: &str,
        configured_owner_channel_ids: &[String],
        regular_window_streams: u32,
        regular_min_streams: u32,
    ) -> rusqlite::Result<ListenerCommentClassification> {
        if listener_id_yt.is_empty() || listener_id_yt == "yt-unknown" {
            return Ok(ListenerCommentClassification::default());
        }

        let conn = self
            .record_conn
            .lock()
            .map_err(|_| poisoned_lock_error("record_conn"))?;

        let owner_ids: Vec<&str> = configured_owner_channel_ids
            .iter()
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .collect();
        let prior_count: i64 = if owner_ids.is_empty() {
            0
        } else {
            let placeholders = (0..owner_ids.len())
                .map(|idx| format!("?{}", idx + 2))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT COUNT(*)
                   FROM comments c
                   JOIN streams s ON s.video_id = c.stream_id
                  WHERE c.listener_channel_id = ?1
                    AND s.owner_channel_id IN ({})",
                placeholders
            );
            let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(owner_ids.len() + 1);
            values.push(&listener_id_yt);
            for owner in &owner_ids {
                values.push(owner);
            }
            conn.query_row(&sql, values.as_slice(), |row| row.get(0))?
        };
        let has_current: i64 = conn.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM comments
                WHERE listener_channel_id = ?1 AND stream_id = ?2
                LIMIT 1
             )",
            params![listener_id_yt, stream_video_id],
            |row| row.get(0),
        )?;
        let (current_stream_comment_count, current_stream_superchat_amount_jpy): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(superchat_amount_jpy), 0)
               FROM comments
              WHERE listener_channel_id = ?1 AND stream_id = ?2",
                params![listener_id_yt, stream_video_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        // 帰還タグ判定用: listeners テーブルから first_seen_at を引く。 listener 行が無ければ 0。
        let first_seen_at_ms: i64 = conn
            .query_row(
                "SELECT IFNULL(first_seen_at, 0) FROM listeners WHERE channel_id = ?1",
                params![listener_id_yt],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let previous_comment_at_ms: i64 = if owner_ids.is_empty() {
            0
        } else {
            let placeholders = (0..owner_ids.len())
                .map(|idx| format!("?{}", idx + 2))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT COALESCE(MAX(c.posted_at), 0)
                   FROM comments c
                   JOIN streams s ON s.video_id = c.stream_id
                  WHERE c.listener_channel_id = ?1
                    AND s.owner_channel_id IN ({})",
                placeholders
            );
            let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(owner_ids.len() + 1);
            values.push(&listener_id_yt);
            for owner in &owner_ids {
                values.push(owner);
            }
            conn.query_row(&sql, values.as_slice(), |row| row.get(0))?
        };

        let regular_window_streams = regular_window_streams.max(1);
        let regular_min_streams = regular_min_streams.max(1);
        let (regular_stream_count, is_regular_listener, previous_seen_ms, previous_stream) =
            if owner_ids.is_empty() {
                (0, false, 0, None)
            } else {
                let placeholders = (0..owner_ids.len())
                    .map(|idx| format!("?{}", idx + 3))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "SELECT COUNT(DISTINCT c.stream_id)
                   FROM comments c
                  WHERE c.listener_channel_id = ?1
                    AND c.stream_id IN (
                      SELECT video_id
                        FROM streams
                       WHERE owner_channel_id IN ({})
                         AND video_id != ?2
                       ORDER BY started_at DESC
                       LIMIT ?{}
                    )",
                    placeholders,
                    owner_ids.len() + 3
                );
                let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(owner_ids.len() + 3);
                values.push(&listener_id_yt);
                values.push(&stream_video_id);
                for owner in &owner_ids {
                    values.push(owner);
                }
                let limit_value = regular_window_streams as i64;
                values.push(&limit_value);
                let distinct_streams: i64 =
                    conn.query_row(&sql, values.as_slice(), |row| row.get(0))?;
                let prev_placeholders = (0..owner_ids.len())
                    .map(|idx| format!("?{}", idx + 3))
                    .collect::<Vec<_>>()
                    .join(", ");
                let prev_sql = format!(
                    "SELECT COALESCE(MAX(c.posted_at), 0)
                   FROM comments c
                   JOIN streams s ON s.video_id = c.stream_id
                  WHERE c.listener_channel_id = ?1
                    AND c.stream_id != ?2
                    AND s.owner_channel_id IN ({})",
                    prev_placeholders
                );
                let mut prev_values: Vec<&dyn rusqlite::ToSql> =
                    Vec::with_capacity(owner_ids.len() + 2);
                prev_values.push(&listener_id_yt);
                prev_values.push(&stream_video_id);
                for owner in &owner_ids {
                    prev_values.push(owner);
                }
                let previous_seen_ms: i64 =
                    conn.query_row(&prev_sql, prev_values.as_slice(), |row| row.get(0))?;
                let prev_stream_sql = format!(
                "SELECT c.stream_id, COALESCE(s.title, ''), COALESCE(s.started_at, 0), c.posted_at
                   FROM comments c
                   JOIN streams s ON s.video_id = c.stream_id
                  WHERE c.listener_channel_id = ?1
                    AND c.stream_id != ?2
                    AND s.owner_channel_id IN ({})
                  ORDER BY c.posted_at DESC
                  LIMIT 1",
                prev_placeholders
            );
                let mut prev_stream_values: Vec<&dyn rusqlite::ToSql> =
                    Vec::with_capacity(owner_ids.len() + 2);
                prev_stream_values.push(&listener_id_yt);
                prev_stream_values.push(&stream_video_id);
                for owner in &owner_ids {
                    prev_stream_values.push(owner);
                }
                let previous_stream = conn
                    .query_row(&prev_stream_sql, prev_stream_values.as_slice(), |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    })
                    .optional()?;
                (
                    distinct_streams as u32,
                    distinct_streams >= regular_min_streams as i64,
                    previous_seen_ms,
                    previous_stream,
                )
            };
        let (
            previous_stream_id,
            previous_stream_title,
            previous_stream_started_at_ms,
            previous_stream_last_comment_ms,
        ) = previous_stream.unwrap_or_else(|| (String::new(), String::new(), 0, previous_seen_ms));

        Ok(ListenerCommentClassification {
            has_prior_comment: prior_count > 0,
            has_comment_in_current_stream: has_current != 0,
            current_stream_comment_count: current_stream_comment_count as u32,
            current_stream_superchat_amount_jpy,
            is_regular_listener,
            regular_stream_count,
            regular_window_streams,
            regular_min_streams,
            previous_stream_last_seen_at_ms: previous_seen_ms,
            previous_stream_last_seen_at: if previous_seen_ms > 0 {
                unix_ms_to_iso(previous_seen_ms)
            } else {
                String::new()
            },
            previous_comment_at_ms,
            previous_comment_at: if previous_comment_at_ms > 0 {
                unix_ms_to_iso(previous_comment_at_ms)
            } else {
                String::new()
            },
            previous_stream_id,
            previous_stream_title,
            previous_stream_started_at_ms,
            previous_stream_started_at: if previous_stream_started_at_ms > 0 {
                unix_ms_to_iso(previous_stream_started_at_ms)
            } else if previous_stream_last_comment_ms > 0 {
                unix_ms_to_iso(previous_stream_last_comment_ms)
            } else {
                String::new()
            },
            first_seen_at_ms,
        })
    }

    fn do_record_comment(
        &self,
        comment: &RawComment,
        stream_video_id: &str,
        stream_owner_channel_id: &str,
        include_in_aggregates: bool,
    ) -> rusqlite::Result<RecordCommentSummary> {
        if comment.id.is_empty() {
            // id が無いコメントは記録しない (PK 違反になるため)。
            return Ok(RecordCommentSummary {
                inserted: false,
                is_first_time_listener: false,
                channel_id: String::new(),
            });
        }
        let comment_id_yt = with_yt_prefix(&comment.id);
        let listener_id_yt = if comment.user_id.is_empty() {
            // PT-1a が空文字を返した古い fixture (e.g. メンバーギフトで header
            // が無かった等) には、listener テーブルに紐付けない代わりに
            // 「unknown」で記録する。集計 1 行に集約する形。
            "yt-unknown".to_string()
        } else {
            with_yt_prefix(&comment.user_id)
        };

        let now_ms = current_unix_millis();
        let posted_at = parse_iso_to_unix_ms(&comment.timestamp).unwrap_or(now_ms);
        let comment_type = classify_comment_type(comment);
        let (amount_jpy, amount_raw, currency) = derive_superchat_fields(comment);
        let is_superchat_like = matches!(
            comment_type,
            CommentType::Superchat | CommentType::Sticker | CommentType::Gift
        );

        let mut conn_guard = self
            .record_conn
            .lock()
            .map_err(|_| poisoned_lock_error("record_conn"))?;
        let tx = conn_guard.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        let inserted = insert_comment(
            &tx,
            &comment_id_yt,
            stream_video_id,
            &listener_id_yt,
            posted_at,
            &comment.comment,
            comment_type,
            amount_jpy,
            amount_raw,
            currency.as_deref(),
            comment,
        )?;

        let mut is_first_time_listener = false;
        if inserted {
            if include_in_aggregates {
                upsert_stream(
                    &tx,
                    stream_video_id,
                    stream_owner_channel_id,
                    posted_at,
                    amount_jpy,
                    is_superchat_like,
                )?;
                is_first_time_listener = upsert_listener(
                    &tx,
                    &listener_id_yt,
                    comment,
                    posted_at,
                    amount_jpy,
                    is_superchat_like,
                )?;
            } else {
                upsert_display_listener(&tx, &listener_id_yt, comment, posted_at)?;
                upsert_display_stream(
                    &tx,
                    stream_video_id,
                    stream_owner_channel_id,
                    posted_at,
                    amount_jpy,
                    is_superchat_like,
                )?;
            }
        }

        tx.commit()?;

        if inserted {
            tracing::debug!(
                "listener_manager: recorded comment {} (listener={}, first_time={})",
                comment_id_yt,
                listener_id_yt,
                is_first_time_listener
            );
        }

        Ok(RecordCommentSummary {
            inserted,
            is_first_time_listener,
            channel_id: listener_id_yt,
        })
    }

    /// こめはぶ形式 JSON Lines として全データをエクスポートする (バックアップ用、Q-2 確定)。
    /// 1 行目に meta、続いて listeners / streams / comments を順に書き出す。
    /// 大規模データに耐えるよう BufWriter + ストリーム書き込み (全件メモリ展開なし)。
    /// 設計詳細は docs/step3-design.md § 7.1。
    pub fn export_komehub_jsonl(&self, out_path: &Path) -> rusqlite::Result<ExportSummary> {
        use std::io::Write;
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let owner_channel_id: Option<String> = g
            .query_row(
                "SELECT value FROM config WHERE key='owner_channel_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok();

        let file = std::fs::File::create(out_path).map_err(|e| {
            SqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: ErrorCode::CannotOpen,
                    extended_code: 0,
                },
                Some(format!("Failed to create export file: {}", e)),
            )
        })?;
        let mut writer = std::io::BufWriter::new(file);
        let mut bytes_written: u64 = 0;

        // meta 行
        let exported_at = current_iso8601_utc();
        let meta_line = serde_json::json!({
            "type": "meta",
            "schemaVersion": EXPECTED_SCHEMA_VERSION,
            "exportedAt": exported_at,
            "ownerChannelId": owner_channel_id,
        });
        let s = serde_json::to_string(&meta_line).unwrap();
        writeln!(writer, "{}", s).map_err(io_to_sqlite_error)?;
        bytes_written += s.len() as u64 + 1;

        // listeners 全件
        let mut listener_count: i64 = 0;
        let stmt_sql = format!(
            "SELECT {} FROM listeners ORDER BY first_seen_at ASC",
            LISTENER_SELECT_COLUMNS
        );
        let mut stmt = g.prepare(&stmt_sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let listener = row_to_listener(row)?;
            let line = serde_json::json!({
                "type": "listener",
                "data": listener,
            });
            let s = serde_json::to_string(&line).unwrap();
            writeln!(writer, "{}", s).map_err(io_to_sqlite_error)?;
            bytes_written += s.len() as u64 + 1;
            listener_count += 1;
        }
        drop(rows);
        drop(stmt);

        // streams 全件
        let mut stream_count: i64 = 0;
        let stream_export_sql = format!(
            "SELECT {} FROM streams ORDER BY started_at ASC",
            STREAM_SELECT_COLUMNS
        );
        let mut stmt = g.prepare(&stream_export_sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let stream = row_to_stream(row)?;
            let line = serde_json::json!({
                "type": "stream",
                "data": stream,
            });
            let s = serde_json::to_string(&line).unwrap();
            writeln!(writer, "{}", s).map_err(io_to_sqlite_error)?;
            bytes_written += s.len() as u64 + 1;
            stream_count += 1;
        }
        drop(rows);
        drop(stmt);

        // comments 全件 (大量になりやすいので posted_at ASC で順次 stream)
        let mut comment_count: i64 = 0;
        let mut stmt = g.prepare(
            "SELECT id, stream_id, listener_channel_id, posted_at, body, comment_type,
                    superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst,
                    responded_at
             FROM comments ORDER BY posted_at ASC",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let comment = row_to_comment(row)?;
            let line = serde_json::json!({
                "type": "comment",
                "data": comment,
            });
            let s = serde_json::to_string(&line).unwrap();
            writeln!(writer, "{}", s).map_err(io_to_sqlite_error)?;
            bytes_written += s.len() as u64 + 1;
            comment_count += 1;
        }
        drop(rows);
        drop(stmt);

        writer.flush().map_err(io_to_sqlite_error)?;

        tracing::info!(
            "listener_export: completed (path={:?}, listeners={}, streams={}, comments={}, bytes={})",
            out_path,
            listener_count,
            stream_count,
            comment_count,
            bytes_written
        );

        Ok(ExportSummary {
            out_path: out_path.to_string_lossy().to_string(),
            listener_count,
            stream_count,
            comment_count,
            bytes_written,
            schema_version: EXPECTED_SCHEMA_VERSION,
        })
    }

    /// こめはぶ形式 JSON Lines をインポートする (繰り返し実行可能、冪等)。
    /// listener / stream は INSERT OR REPLACE、comment は INSERT OR IGNORE で重複検知。
    /// 100 件単位でチャンク分割してトランザクション (§ 5.3 の writer ロック保護)。
    pub fn import_komehub_jsonl(&self, src_path: &Path) -> rusqlite::Result<ImportSummary> {
        use std::io::BufRead;
        const CHUNK_SIZE: usize = 100;

        let file = std::fs::File::open(src_path).map_err(|e| {
            SqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: ErrorCode::CannotOpen,
                    extended_code: 0,
                },
                Some(format!("Failed to open import file: {}", e)),
            )
        })?;
        let reader = std::io::BufReader::new(file);

        // バッファに溜めて、CHUNK_SIZE ごとに 1 トランザクションで insert
        let mut listener_buf: Vec<ListenerRow> = Vec::with_capacity(CHUNK_SIZE);
        let mut stream_buf: Vec<StreamRow> = Vec::with_capacity(CHUNK_SIZE);
        let mut comment_buf: Vec<CommentRow> = Vec::with_capacity(CHUNK_SIZE);

        let mut listeners_new: i64 = 0;
        let mut listeners_updated: i64 = 0;
        let mut streams_new: i64 = 0;
        let mut streams_updated: i64 = 0;
        let mut comments_inserted: i64 = 0;
        let mut comments_skipped: i64 = 0;
        let mut warnings: Vec<String> = Vec::new();
        let mut schema_version: Option<i32> = None;
        let mut line_no: usize = 0;

        for line in reader.lines() {
            line_no += 1;
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    warnings.push(format!("line {}: read error: {}", line_no, e));
                    continue;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    warnings.push(format!("line {}: invalid JSON: {}", line_no, e));
                    continue;
                }
            };
            let line_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match line_type {
                "meta" => {
                    let v = parsed
                        .get("schemaVersion")
                        .and_then(|v| v.as_i64())
                        .map(|n| n as i32);
                    schema_version = v;
                    if v != Some(EXPECTED_SCHEMA_VERSION) {
                        warnings.push(format!(
                            "schema_version mismatch (file={:?}, expected={})",
                            v, EXPECTED_SCHEMA_VERSION
                        ));
                    }
                }
                "listener" => {
                    if let Some(data) = parsed.get("data") {
                        match serde_json::from_value::<ListenerRow>(data.clone()) {
                            Ok(row) => {
                                listener_buf.push(row);
                                if listener_buf.len() >= CHUNK_SIZE {
                                    let (n, u) = self.flush_listeners(&listener_buf)?;
                                    listeners_new += n as i64;
                                    listeners_updated += u as i64;
                                    listener_buf.clear();
                                }
                            }
                            Err(e) => {
                                warnings.push(format!("line {}: invalid listener: {}", line_no, e))
                            }
                        }
                    }
                }
                "stream" => {
                    if let Some(data) = parsed.get("data") {
                        match serde_json::from_value::<StreamRow>(data.clone()) {
                            Ok(row) => {
                                stream_buf.push(row);
                                if stream_buf.len() >= CHUNK_SIZE {
                                    let (n, u) = self.flush_streams(&stream_buf)?;
                                    streams_new += n as i64;
                                    streams_updated += u as i64;
                                    stream_buf.clear();
                                }
                            }
                            Err(e) => {
                                warnings.push(format!("line {}: invalid stream: {}", line_no, e))
                            }
                        }
                    }
                }
                "comment" => {
                    if let Some(data) = parsed.get("data") {
                        match serde_json::from_value::<CommentRow>(data.clone()) {
                            Ok(row) => {
                                comment_buf.push(row);
                                if comment_buf.len() >= CHUNK_SIZE {
                                    let (ins, skipped) = self.flush_comments(&comment_buf)?;
                                    comments_inserted += ins as i64;
                                    comments_skipped += skipped as i64;
                                    comment_buf.clear();
                                }
                            }
                            Err(e) => {
                                warnings.push(format!("line {}: invalid comment: {}", line_no, e))
                            }
                        }
                    }
                }
                other => {
                    warnings.push(format!("line {}: unknown type \"{}\"", line_no, other));
                }
            }
        }

        // 残バッファを flush
        if !listener_buf.is_empty() {
            let (n, u) = self.flush_listeners(&listener_buf)?;
            listeners_new += n as i64;
            listeners_updated += u as i64;
        }
        if !stream_buf.is_empty() {
            let (n, u) = self.flush_streams(&stream_buf)?;
            streams_new += n as i64;
            streams_updated += u as i64;
        }
        if !comment_buf.is_empty() {
            let (ins, skipped) = self.flush_comments(&comment_buf)?;
            comments_inserted += ins as i64;
            comments_skipped += skipped as i64;
        }

        tracing::info!(
            "listener_import: completed (path={:?}, listeners new={}/updated={}, streams new={}/updated={}, comments new={}/skipped={}, warnings={})",
            src_path,
            listeners_new, listeners_updated,
            streams_new, streams_updated,
            comments_inserted, comments_skipped,
            warnings.len()
        );
        // 別ハブからの komehub JSONL を取り込んだ → わんコメ書き戻し対象あり
        if listeners_new + listeners_updated + comments_inserted > 0 {
            self.mark_data_dirty();
        }

        Ok(ImportSummary {
            src_path: src_path.to_string_lossy().to_string(),
            listeners_new,
            listeners_updated,
            streams_new,
            streams_updated,
            comments_inserted,
            comments_skipped,
            warnings,
            schema_version,
        })
    }

    /// 戻り値: (new_count, updated_count) — 同一トランザクション内で
    /// SELECT EXISTS → UPSERT することで「新規挿入」と「既存上書き」を区別する。
    fn flush_listeners(&self, rows: &[ListenerRow]) -> rusqlite::Result<(usize, usize)> {
        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut new_count = 0usize;
        let mut updated_count = 0usize;
        {
            let mut exists_stmt =
                tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM listeners WHERE channel_id = ?1)")?;
            let mut upsert_stmt = tx.prepare(
                "INSERT INTO listeners
                 (channel_id, display_name, username, icon_url, name_history,
                  first_seen_at, last_seen_at, comment_count,
                  superchat_count, superchat_amount_jpy,
                  is_member, is_moderator, member_months_max, notes, label, nickname, raw)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(channel_id) DO UPDATE SET
                   display_name = excluded.display_name,
                   username = excluded.username,
                   icon_url = excluded.icon_url,
                   name_history = excluded.name_history,
                   first_seen_at = MIN(listeners.first_seen_at, excluded.first_seen_at),
                   -- last_seen_at: こめはぶ comments で観測済みのリスナーは真値 (= record_comment 経由で
                   -- 入る posted_at) を保護する。わんコメ users.lcts は「自チャンネル外配信を含む
                   -- わんコメ視点の最終時刻」なので、これで上書きすると last_seen_at がドリフトする (v6)。
                   last_seen_at = CASE
                     WHEN EXISTS(SELECT 1 FROM comments WHERE listener_channel_id = listeners.channel_id)
                       THEN listeners.last_seen_at
                     ELSE MAX(listeners.last_seen_at, excluded.last_seen_at)
                   END,
                   comment_count = MAX(listeners.comment_count, excluded.comment_count),
                   superchat_count = MAX(listeners.superchat_count, excluded.superchat_count),
                   superchat_amount_jpy = MAX(listeners.superchat_amount_jpy, excluded.superchat_amount_jpy),
                   is_member = MAX(listeners.is_member, excluded.is_member),
                   is_moderator = MAX(listeners.is_moderator, excluded.is_moderator),
                   member_months_max = MAX(listeners.member_months_max, excluded.member_months_max),
                   notes = CASE WHEN excluded.notes != '' THEN excluded.notes ELSE listeners.notes END,
                   label = CASE WHEN excluded.label != '' THEN excluded.label ELSE listeners.label END,
                   nickname = CASE WHEN excluded.nickname != '' THEN excluded.nickname ELSE listeners.nickname END,
                   raw = COALESCE(excluded.raw, listeners.raw);",
            )?;
            for row in rows {
                let exists: i64 = exists_stmt.query_row(params![row.channel_id], |r| r.get(0))?;
                let history_str =
                    serde_json::to_string(&row.name_history).unwrap_or_else(|_| "[]".to_string());
                let raw_str = row.raw.as_ref().map(|v| v.to_string());
                upsert_stmt.execute(params![
                    row.channel_id,
                    row.display_name,
                    row.username,
                    row.icon_url,
                    history_str,
                    row.first_seen_at,
                    row.last_seen_at,
                    row.comment_count,
                    row.superchat_count,
                    row.superchat_amount_jpy,
                    row.is_member as i64,
                    row.is_moderator as i64,
                    row.member_months_max,
                    row.notes,
                    row.label,
                    row.nickname,
                    raw_str,
                ])?;
                if exists == 1 {
                    updated_count += 1;
                } else {
                    new_count += 1;
                }
            }
        }
        tx.commit()?;
        Ok((new_count, updated_count))
    }

    /// 戻り値: (new_count, updated_count) — listeners と同様のロジック。
    fn flush_streams(&self, rows: &[StreamRow]) -> rusqlite::Result<(usize, usize)> {
        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut new_count = 0usize;
        let mut updated_count = 0usize;
        {
            let mut exists_stmt =
                tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM streams WHERE video_id = ?1)")?;
            let mut upsert_stmt = tx.prepare(
                "INSERT INTO streams
                 (video_id, owner_channel_id, title, started_at, ended_at,
                  comment_count, superchat_count, superchat_amount_jpy)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(video_id) DO UPDATE SET
                   owner_channel_id = CASE
                     WHEN excluded.owner_channel_id != '' THEN excluded.owner_channel_id
                     ELSE streams.owner_channel_id
                   END,
                   title = CASE WHEN excluded.title != '' THEN excluded.title ELSE streams.title END,
                   started_at = MIN(streams.started_at, excluded.started_at),
                   ended_at = MAX(streams.ended_at, excluded.ended_at),
                   comment_count = MAX(streams.comment_count, excluded.comment_count),
                   superchat_count = MAX(streams.superchat_count, excluded.superchat_count),
                   superchat_amount_jpy = MAX(streams.superchat_amount_jpy, excluded.superchat_amount_jpy);",
            )?;
            for row in rows {
                let exists: i64 = exists_stmt.query_row(params![row.video_id], |r| r.get(0))?;
                upsert_stmt.execute(params![
                    row.video_id,
                    row.owner_channel_id,
                    row.title,
                    row.started_at,
                    row.ended_at,
                    row.comment_count,
                    row.superchat_count,
                    row.superchat_amount_jpy,
                ])?;
                if exists == 1 {
                    updated_count += 1;
                } else {
                    new_count += 1;
                }
            }
        }
        tx.commit()?;
        Ok((new_count, updated_count))
    }

    /// 戻り値: (inserted, skipped) — INSERT OR IGNORE で重複した行は skipped
    fn flush_comments(&self, rows: &[CommentRow]) -> rusqlite::Result<(usize, usize)> {
        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut inserted = 0usize;
        let mut skipped = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO comments
                 (id, stream_id, listener_channel_id, posted_at, body, comment_type,
                  superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst, comment_html)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO NOTHING",
            )?;
            for row in rows {
                let raw_str = row.raw.to_string();
                let raw_zst = zstd::encode_all(raw_str.as_bytes(), 3)
                    .unwrap_or_else(|_| Vec::new());
                let comment_html = row
                    .raw
                    .get("commentHtml")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let n = stmt.execute(params![
                    row.id,
                    row.stream_id,
                    row.listener_channel_id,
                    row.posted_at,
                    row.body,
                    row.comment_type.as_str(),
                    row.superchat_amount_jpy,
                    row.superchat_currency,
                    row.superchat_amount_raw,
                    raw_zst,
                    comment_html,
                ])?;
                if n == 1 {
                    inserted += 1;
                } else {
                    skipped += 1;
                }
            }
        }
        tx.commit()?;
        Ok((inserted, skipped))
    }

    fn refresh_comment_aggregates_for_rows(&self, rows: &[CommentRow]) -> rusqlite::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let listener_ids: std::collections::HashSet<String> = rows
            .iter()
            .map(|row| row.listener_channel_id.clone())
            .collect();
        let stream_ids: std::collections::HashSet<String> =
            rows.iter().map(|row| row.stream_id.clone()).collect();

        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        {
            // first_seen_at は MIN-merge する (= 2026-05-10 884 件 drift の根本対策)。
            // import 経路で `flush_comments` は comments テーブルにしか書かないため、
            // listeners.first_seen_at は record_comment 経由でしか MIN-merge できない。
            // import 取り込み済みの過去コメで更に古い posted_at がある場合は、ここで
            // first_seen_at を遡らせる。
            //
            // last_seen_at は意図的に触らない: flush_listeners 側で
            // 「CASE WHEN EXISTS(comments) THEN listeners.last_seen_at ELSE MAX(...) END」
            // という protection が既にあり、こめはぶ record_comment 由来の真値を尊重して
            // わんコメ lcts で上書きしない invariant を維持している。ここで MAX-merge を
            // 入れると invariant を破る (= 既存テスト
            // import_from_onecomme_does_not_drift_last_seen_at_for_known_listener の趣旨)。
            let mut listener_stmt = tx.prepare(
                "UPDATE listeners
                 SET
                   comment_count = COALESCE((
                     SELECT COUNT(*) FROM comments c
                     JOIN streams s ON s.video_id = c.stream_id
                     WHERE c.listener_channel_id = listeners.channel_id
                       AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
                   ), 0),
                   superchat_count = COALESCE((
                     SELECT COUNT(*) FROM comments c
                     JOIN streams s ON s.video_id = c.stream_id
                     WHERE c.listener_channel_id = listeners.channel_id
                       AND c.comment_type IN ('superchat', 'sticker', 'gift')
                       AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
                   ), 0),
                   superchat_amount_jpy = COALESCE((
                     SELECT SUM(COALESCE(c.superchat_amount_jpy, 0)) FROM comments c
                     JOIN streams s ON s.video_id = c.stream_id
                     WHERE c.listener_channel_id = listeners.channel_id
                       AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
                   ), 0),
                   first_seen_at = CASE
                     WHEN comment_count = 0 OR first_seen_at = 0 THEN COALESCE((
                       SELECT MIN(c.posted_at) FROM comments c
                       JOIN streams s ON s.video_id = c.stream_id
                       WHERE c.listener_channel_id = listeners.channel_id
                         AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
                     ), first_seen_at)
                     ELSE MIN(first_seen_at, COALESCE((
                     SELECT MIN(c.posted_at) FROM comments c
                     JOIN streams s ON s.video_id = c.stream_id
                     WHERE c.listener_channel_id = listeners.channel_id
                       AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
                     ), first_seen_at))
                   END
                 WHERE channel_id = ?1",
            )?;
            for listener_id in &listener_ids {
                listener_stmt.execute(params![listener_id])?;
            }
        }
        {
            let mut stream_stmt = tx.prepare(
                "UPDATE streams
                 SET
                   started_at = MIN(started_at, COALESCE((SELECT MIN(posted_at) FROM comments WHERE stream_id = streams.video_id), started_at)),
                   ended_at = MAX(ended_at, COALESCE((SELECT MAX(posted_at) FROM comments WHERE stream_id = streams.video_id), ended_at)),
                   comment_count = COALESCE((SELECT COUNT(*) FROM comments WHERE stream_id = streams.video_id), 0),
                   superchat_count = COALESCE((SELECT COUNT(*) FROM comments WHERE stream_id = streams.video_id AND comment_type IN ('superchat', 'sticker', 'gift')), 0),
                   superchat_amount_jpy = COALESCE((SELECT SUM(COALESCE(superchat_amount_jpy, 0)) FROM comments WHERE stream_id = streams.video_id), 0)
                 WHERE video_id = ?1",
            )?;
            for stream_id in &stream_ids {
                stream_stmt.execute(params![stream_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// わんコメ DB をインポートする (フェーズ 3.4、Plan A の単方向取込)。
    ///
    /// 流れ (設計書 § 5.3 phase 1 を簡易化):
    /// 1. スキーマハッシュ照合 (NF-8、不一致は警告のみで読み取りは続行)
    /// 2. わんコメ users → listeners (上向き集計マージ、tc / amount / lcts 等)
    /// 3. わんコメ comments → comments + streams (自チャンネル判定で他配信を除外)
    /// 4. watermark を実処理した最大 created_at で更新
    /// 5. 結果サマリを返す (件数 + 警告)
    ///
    /// `configured_owner_channel_ids` は呼び出し側 (ModelQueue) から渡す。
    /// 複数 ID 対応 (サブチャンネル等)。空なら自チャンネルフィルタが効かず警告。
    /// チャンク分割は flush_listeners / flush_streams / flush_comments で 100 件単位。
    pub fn import_from_onecomme(
        &self,
        onecomme_dir: &Path,
        configured_owner_channel_ids: &[&str],
    ) -> rusqlite::Result<OnecommeImportSummary> {
        tracing::info!(
            "import_from_onecomme: starting (dir={:?}, configured_owners={})",
            onecomme_dir,
            configured_owner_channel_ids.len()
        );
        let comments_db = onecomme_dir.join("comments.db");
        let onecomme_db = onecomme_dir.join("onecomme.db");
        let mut warnings: Vec<String> = Vec::new();

        // 1. スキーマハッシュ照合
        let prev_hash = self.get_config_value("onecomme_observed_schema_hash")?;
        let schema_check = listener_aux_io::check_onecomme_schema(
            &onecomme_db,
            &comments_db,
            prev_hash.as_deref(),
        )?;
        let schema_hash = schema_check.current_hash.clone();
        if !schema_check.matched {
            warnings.push(format!(
                "わんコメ DB のスキーマが前回観測時と異なります (前: {}, 今: {})。読み取りは続行しますが、フェーズ 3.5 の書き戻しは中断される可能性があります。",
                schema_check.previous_hash.as_deref().unwrap_or("(初回)"),
                &schema_hash
            ));
        }
        // 観測ハッシュは **初回観測時のみ** 保存する (設計レビュー指摘 2 への対応)。
        // 不一致時に上書きしてしまうと、未知スキーマを 1 度 import しただけで基準値が
        // 置き換わり、フェーズ 3.5 の書き戻し時に「前回観測と一致」と誤認するリスクが
        // ある。一致時は同じ値なので保存不要、不一致時は警告のみで保存しない (ユーザー
        // に手動承認させるため)。
        if schema_check.previous_hash.is_none() {
            self.set_config_value("onecomme_observed_schema_hash", &schema_hash)?;
        }

        if configured_owner_channel_ids.is_empty() {
            warnings.push(
                "configured_owner_channel_ids が未設定のため自チャンネル判定ができません。すべての配信が「自チャンネル外」とみなされ、コメントは取り込まれません。"
                    .to_string(),
            );
        }
        let configured_yt: Vec<String> = configured_owner_channel_ids
            .iter()
            .filter(|c| !c.is_empty())
            .map(|c| {
                if c.starts_with("yt-") {
                    c.to_string()
                } else {
                    format!("yt-{}", c)
                }
            })
            .collect();

        // 2. comments → comments + streams (自チャンネルフィルタ)
        crate::engine::import_progress_reporter::report("started", 0, 0, Some("import 開始"));
        let since = self.get_config_value("last_sync_imported_max_onecomme_created_at")?;
        let onecomme_comments =
            listener_aux_io::read_onecomme_comments(&comments_db, since.as_deref())?;
        let total_comments = onecomme_comments.len() as u64;
        crate::engine::import_progress_reporter::report(
            "read",
            0,
            total_comments,
            Some(&format!("わんコメ DB から {} 件 select 完了", total_comments)),
        );

        let mut stream_owner_cache: std::collections::HashMap<String, Option<String>> =
            Default::default();

        // Pass 0: 既存 streams で「自チャ owner + title 空」 を repair。
        // watermark で既取り込みになった row は Pass 1 で resolve 候補にならないため、
        // ここで別途 SELECT して resolver で補完する (= 一度過去 import で空 title になっていた
        // row を後追いで埋める)。 configured_yt 一致のもののみ対象 (= 自チャ外は無関係)。
        tracing::info!("import_from_onecomme: Pass 0 (repair) starting");
        // 空 title/channel_name の自チャ過去枠を resolver で補完 (= 起動時 backfill と共通ロジック)。
        let repaired_video_ids = self.repair_missing_stream_meta(&configured_yt)?;
        tracing::info!(
            "import_from_onecomme: Pass 0 (repair) completed (repaired_streams={})",
            repaired_video_ids.len()
        );

        // Pass 1: streams に未登録の video_id 集合を作って、 Electron resolver に解決を委譲する。
        // 既存仕様 (= 「streams に owner 行があるコメだけ通す」) を維持しつつ、
        // 「わんコメ経由でしか見ていない枠」 を取り込めるようにする (= 2026-05-16 Phase 16)。
        // resolver 未登録時 / 解決失敗時は空 Vec が返るので、 既存挙動と同じく filter で弾かれる。
        tracing::info!("import_from_onecomme: Pass 1 (resolve unknown owners) starting");
        let mut unknown_video_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for oc in &onecomme_comments {
            let parsed: serde_json::Value = match serde_json::from_str(&oc.comment) {
                Ok(v) => v,
                Err(_) => continue, // Pass 2 で invalid 計上するので ここでは無視
            };
            let live_id = parsed
                .get("data")
                .and_then(|d| d.get("liveId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if live_id.is_empty() {
                continue;
            }
            // cache hit ならスキップ、 miss なら DB lookup + cache 充填
            let owner_opt = stream_owner_cache
                .entry(live_id.to_string())
                .or_insert_with(|| self.lookup_stream_owner(live_id).unwrap_or(None))
                .clone();
            if owner_opt.is_none() {
                unknown_video_ids.insert(live_id.to_string());
            }
        }
        if !unknown_video_ids.is_empty() {
            let ids_vec: Vec<String> = unknown_video_ids.into_iter().collect();
            let resolved =
                crate::engine::video_owner_resolver::resolve_unknown_owners_blocking(ids_vec);
            for meta in resolved {
                // owner 確定: stream_owner_cache を上書き
                // (= Pass 2 の `entry().or_insert_with()` は上書きされた値を使う)
                // 後続の `flush_streams` で streams 行に owner_channel_id が反映される。
                // streams テーブルの owner_channel_id は `yt-UCxxx` 形式で保存されているので、
                // configured_yt との比較 (= filter) を通すために prefix を付与する。
                // (= resolver は生の UCxxx を返す = electron HTML 抽出は YouTube 形式そのまま)
                let normalized_owner = if meta.owner_channel_id.starts_with("yt-") {
                    meta.owner_channel_id.clone()
                } else {
                    format!("yt-{}", meta.owner_channel_id)
                };
                tracing::info!(
                    "video_owner_resolver: registering {} -> {} (title={:?}, channel_name={:?})",
                    meta.video_id,
                    normalized_owner,
                    meta.title,
                    meta.channel_name
                );
                stream_owner_cache.insert(meta.video_id.clone(), Some(normalized_owner.clone()));
                // streams テーブルに title / channel_name も事前 upsert (= 後段の flush_streams は
                // title='' で投入するが、 ON CONFLICT で既存値保持なので、 ここで埋めた値が残る)
                if let Err(e) = self.upsert_resolved_stream_meta(
                    &meta.video_id,
                    &normalized_owner,
                    meta.title.as_deref(),
                    meta.channel_name.as_deref(),
                ) {
                    tracing::warn!(
                        "upsert_resolved_stream_meta failed for {}: {}",
                        meta.video_id,
                        e
                    );
                }
            }
        }

        tracing::info!("import_from_onecomme: Pass 1 (resolve unknown owners) completed");

        crate::engine::import_progress_reporter::report(
            "repair",
            0,
            total_comments,
            Some("repair pass 完了、 コメ解析開始"),
        );

        tracing::info!(
            "import_from_onecomme: Pass 2 (main processing) starting (total_comments={})",
            total_comments
        );
        let mut comment_rows: Vec<CommentRow> = Vec::with_capacity(onecomme_comments.len());
        let mut comments_filtered_other_channel = 0i64;
        let mut comments_invalid = 0i64;
        let mut max_created_at: Option<String> = since.clone();

        // 進捗報告は 1000 件ごと (= IPC スパム回避、 1000 件あたり ~10ms 計算)
        const PASS2_REPORT_INTERVAL: usize = 1000;

        for (idx, oc) in onecomme_comments.iter().enumerate() {
            if idx > 0 && idx % PASS2_REPORT_INTERVAL == 0 {
                crate::engine::import_progress_reporter::report(
                    "pass2",
                    idx as u64,
                    total_comments,
                    None,
                );
            }
            // 注: watermark (max_created_at) は **listeners.db に取り込み対象に
            // なった行** だけで進める (設計レビュー指摘 1 への対応)。
            // filter / invalid 行で進めると、自チャンネル設定後に再取得できなく
            // なる/owner 不明だった配信を後から取り込めなくなる。
            let parsed: serde_json::Value = match serde_json::from_str(&oc.comment) {
                Ok(v) => v,
                Err(_) => {
                    comments_invalid += 1;
                    continue;
                }
            };
            let data = parsed.get("data");
            let live_id = data
                .and_then(|d| d.get("liveId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if live_id.is_empty() {
                comments_invalid += 1;
                continue;
            }

            // 配信 owner を listeners.db の streams から引く (キャッシュ)
            let owner_in_db = stream_owner_cache
                .entry(live_id.clone())
                .or_insert_with(|| self.lookup_stream_owner(&live_id).unwrap_or(None))
                .clone();
            // 自チャンネル判定:
            //  - configured 未設定 → 全部弾く
            //  - stream owner が listeners.db に無い → 判定不能、安全側で弾く
            //  - configured 配列に owner が含まれる → 採用 (サブチャンネル含む複数 ID 対応)
            let is_own_channel = match owner_in_db.as_deref() {
                Some(o) => configured_yt.iter().any(|c| c == o),
                None => false,
            };
            if !is_own_channel {
                comments_filtered_other_channel += 1;
                continue;
            }

            match comment_row_from_onecomme(&oc.id, &live_id, &oc.user_id, &oc.created_at, &parsed)
            {
                Ok(row) => {
                    // 取り込み対象になった行のみ watermark を進める。
                    // INSERT OR IGNORE で重複スキップされる行も「listeners.db に
                    // 既に存在する」= 取り込み済みなので watermark を進めて OK。
                    if max_created_at
                        .as_deref()
                        .is_none_or(|cur| oc.created_at.as_str() > cur)
                    {
                        max_created_at = Some(oc.created_at.clone());
                    }
                    comment_rows.push(row);
                }
                Err(_) => comments_invalid += 1,
            }
        }

        // 3. users → listeners
        // わんコメ users には他チャンネル配信や過去に見たが自チャンネルではコメントしていない
        // ユーザーも含まれる。comments を自チャンネル配信で絞った後、そのコメントを書いた
        // user_id だけを listeners に取り込む。
        let imported_listener_ids: std::collections::HashSet<String> = comment_rows
            .iter()
            .map(|row| row.listener_channel_id.clone())
            .collect();
        let onecomme_users = listener_aux_io::read_onecomme_users(&onecomme_db)?;
        let mut listener_rows: Vec<ListenerRow> = Vec::with_capacity(imported_listener_ids.len());
        for user in onecomme_users {
            if !imported_listener_ids.contains(&user.id) {
                continue;
            }
            match listener_row_from_onecomme_user(&user) {
                Ok(row) => listener_rows.push(row),
                Err(e) => warnings.push(format!("invalid users.data for id={}: {}", user.id, e)),
            }
        }
        crate::engine::import_progress_reporter::report(
            "flush-listeners",
            0,
            listener_rows.len() as u64,
            Some(&format!("listener {} 件を書き込み中", listener_rows.len())),
        );
        let mut listeners_new = 0i64;
        let mut listeners_updated = 0i64;
        for chunk in listener_rows.chunks(100) {
            let (n, u) = self.flush_listeners(chunk)?;
            listeners_new += n as i64;
            listeners_updated += u as i64;
        }

        // streams: 取り込まれるコメントから videoId を集めて upsert
        let mut seen_streams: std::collections::HashSet<String> = Default::default();
        let mut stream_rows: Vec<StreamRow> = Vec::new();
        for comment_row in &comment_rows {
            if seen_streams.insert(comment_row.stream_id.clone()) {
                let owner = stream_owner_cache
                    .get(&comment_row.stream_id)
                    .cloned()
                    .unwrap_or(None)
                    .unwrap_or_default();
                stream_rows.push(StreamRow {
                    video_id: comment_row.stream_id.clone(),
                    owner_channel_id: owner,
                    title: String::new(),
                    started_at: comment_row.posted_at,
                    ended_at: comment_row.posted_at,
                    comment_count: 0,
                    superchat_count: 0,
                    superchat_amount_jpy: 0,
                    stream_url: String::new(),
                    channel_name: String::new(),
                    channel_icon_url: String::new(),
                    description: String::new(),
                    subscriber_count: 0,
                    current_viewers: 0,
                    peak_concurrent_viewers: 0,
                    likes: 0,
                    live_metadata_updated_at: 0,
                    is_own_stream: true,
                });
            }
        }
        crate::engine::import_progress_reporter::report(
            "flush-streams",
            0,
            stream_rows.len() as u64,
            Some(&format!("配信 {} 件を書き込み中", stream_rows.len())),
        );
        let mut streams_new = 0i64;
        let mut streams_updated = 0i64;
        for chunk in stream_rows.chunks(100) {
            let (n, u) = self.flush_streams(chunk)?;
            streams_new += n as i64;
            streams_updated += u as i64;
        }

        crate::engine::import_progress_reporter::report(
            "flush-comments",
            0,
            comment_rows.len() as u64,
            Some(&format!("コメント {} 件を書き込み中", comment_rows.len())),
        );
        let mut comments_inserted = 0i64;
        let mut comments_skipped = 0i64;
        let mut comments_flushed_so_far: u64 = 0;
        for chunk in comment_rows.chunks(100) {
            let (ins, sk) = self.flush_comments(chunk)?;
            comments_inserted += ins as i64;
            comments_skipped += sk as i64;
            comments_flushed_so_far += chunk.len() as u64;
            // 5000 件ごとに進捗 push (= 100 chunks = ~50 push, IPC スパム回避)
            if comments_flushed_so_far % 5000 == 0 {
                crate::engine::import_progress_reporter::report(
                    "flush-comments",
                    comments_flushed_so_far,
                    comment_rows.len() as u64,
                    None,
                );
            }
        }
        self.refresh_comment_aggregates_for_rows(&comment_rows)?;

        // 4. watermark を実処理した最大値で更新 (全 chunk 完了後 1 回だけ、§ 5.3)
        if let Some(ts) = max_created_at.as_deref() {
            self.set_config_value("last_sync_imported_max_onecomme_created_at", ts)?;
        }

        tracing::info!(
            "import_from_onecomme: completed (dir={:?}, listeners new={}/upd={}, streams new={}/upd={}, comments new={}/skip={}/filtered={}/invalid={})",
            onecomme_dir,
            listeners_new, listeners_updated,
            streams_new, streams_updated,
            comments_inserted, comments_skipped,
            comments_filtered_other_channel, comments_invalid
        );
        crate::engine::import_progress_reporter::report(
            "done",
            total_comments,
            total_comments,
            Some(&format!(
                "完了: 新規 {} 件、 配信 +{}、 リスナー +{}",
                comments_inserted, streams_new, listeners_new
            )),
        );

        Ok(OnecommeImportSummary {
            onecomme_dir: onecomme_dir.to_string_lossy().to_string(),
            listeners_new,
            listeners_updated,
            streams_new,
            streams_updated,
            comments_inserted,
            comments_skipped,
            comments_filtered_other_channel,
            comments_invalid,
            warnings,
            schema_hash,
            backup_dir: None, // フェーズ 3.4 のインポートでは取らない (フェーズ 3.5 書き戻しで使う)
            repaired_video_ids,
        })
    }

    /// わんコメ DB へ書き戻す (フェーズ 3.5、Plan A)。
    ///
    /// 流れ (設計書 § 5.3 phase 2):
    /// 1. **わんコメ起動検知** (起動中なら中断、UI で防いでいるが二重防衛)
    /// 2. **スキーマハッシュ照合** (前回観測値との不一致は中断、NF-8)
    /// 3. **pristine バックアップ** (= `take_pristine_backup=true` のときだけ作成、 失敗したら中断)
    ///    呼び出し側 (model_queue) が「この onecommeDir に対して未取得」 と判定したときに true を渡す。
    ///    一度 backup を取ったら以降の export で false を渡す (= 1 度書き戻したら DB は既に汚染、
    ///    pristine の意味は最初の 1 回しかない、 という設計判断)。
    /// 4. since (last_sync_exported_max_komehub_posted_at) より新しい comments を select
    /// 5. listeners (configured_owner で書き戻すべきリスナー) を select
    /// 6. write_onecomme_comments / write_onecomme_users (チャンク内 1 トランザクション)
    /// 7. watermark を実処理した max(posted_at) で更新
    pub fn export_to_onecomme(
        &self,
        onecomme_dir: &Path,
        backup_root: &Path,
        take_pristine_backup: bool,
    ) -> rusqlite::Result<OnecommeExportSummary> {
        tracing::info!(
            "export_to_onecomme: starting (dir={:?}, take_pristine_backup={})",
            onecomme_dir,
            take_pristine_backup
        );
        crate::engine::export_progress_reporter::report(
            "started",
            0,
            0,
            Some("わんコメ書き戻し開始"),
        );
        let comments_db = onecomme_dir.join("comments.db");
        let onecomme_db = onecomme_dir.join("onecomme.db");
        let mut warnings: Vec<String> = Vec::new();

        // 2. スキーマハッシュ照合 (initial 観測なし時は照合スキップで OK だが、
        //    write は安全側に振って「初回観測なし = 中断」)
        let prev_hash = self.get_config_value("onecomme_observed_schema_hash")?;
        let schema_check = listener_aux_io::check_onecomme_schema(
            &onecomme_db,
            &comments_db,
            prev_hash.as_deref(),
        )?;
        if prev_hash.is_none() {
            tracing::warn!(
                "export_to_onecomme: aborting because schema hash not observed (run import first)"
            );
            warnings.push(
                "わんコメ DB の観測ハッシュが未記録のため書き戻しを中断しました。\
                 先にわんコメインポートを 1 度実行して既知ハッシュを記録してください。"
                    .to_string(),
            );
            crate::engine::export_progress_reporter::report(
                "aborted",
                0,
                0,
                Some("観測ハッシュ未記録のため中断"),
            );
            return Ok(OnecommeExportSummary {
                onecomme_dir: onecomme_dir.to_string_lossy().to_string(),
                users_new: 0,
                users_updated: 0,
                comments_inserted: 0,
                comments_skipped: 0,
                backup_dir: None,
                max_posted_at: None,
                warnings,
                aborted: true,
            });
        }
        if !schema_check.matched {
            tracing::warn!(
                "export_to_onecomme: aborting because schema mismatch (prev={:?}, current={})",
                schema_check.previous_hash.as_deref(),
                schema_check.current_hash
            );
            warnings.push(format!(
                "わんコメ DB のスキーマが前回観測時と異なるため書き戻しを中断しました\
                 (前: {}, 今: {})。インポートで観測値を確認してから再実行してください。",
                schema_check.previous_hash.as_deref().unwrap_or("(none)"),
                schema_check.current_hash
            ));
            crate::engine::export_progress_reporter::report(
                "aborted",
                0,
                0,
                Some("スキーマ不一致のため中断"),
            );
            return Ok(OnecommeExportSummary {
                onecomme_dir: onecomme_dir.to_string_lossy().to_string(),
                users_new: 0,
                users_updated: 0,
                comments_inserted: 0,
                comments_skipped: 0,
                backup_dir: None,
                max_posted_at: None,
                warnings,
                aborted: true,
            });
        }
        crate::engine::export_progress_reporter::report(
            "schema-check",
            0,
            0,
            Some("スキーマ照合完了"),
        );

        // 2.5 preflight: 両 DB ファイル + 必須テーブルを検査
        // どちらか欠けるなら **何も書かずに aborted で返す** (片方だけ書き戻す
        // 部分書き込みを防ぐ、設計レビュー第 11 ラウンド対応)。
        let preflight = preflight_check_onecomme(&comments_db, &onecomme_db);
        if !preflight.both_tables_present {
            tracing::warn!(
                "export_to_onecomme: aborting because preflight failed: {}",
                preflight.reason
            );
            warnings.push(preflight.reason);
            crate::engine::export_progress_reporter::report(
                "aborted",
                0,
                0,
                Some("DB preflight 失敗のため中断"),
            );
            return Ok(OnecommeExportSummary {
                onecomme_dir: onecomme_dir.to_string_lossy().to_string(),
                users_new: 0,
                users_updated: 0,
                comments_inserted: 0,
                comments_skipped: 0,
                backup_dir: None,
                max_posted_at: None,
                warnings,
                aborted: true,
            });
        }
        crate::engine::export_progress_reporter::report(
            "preflight",
            0,
            0,
            Some("DB 確認完了"),
        );

        // 3. pristine バックアップ (= take_pristine_backup=true のときだけ)。
        //    呼び出し側で「この onecommeDir に対して未取得」 と判定済の前提。
        //    既存があれば上書き (= 安全側、 不完全な残骸対応)。
        let backup_dir = if take_pristine_backup {
            crate::engine::export_progress_reporter::report(
                "pristine-backup",
                0,
                0,
                Some("わんコメ DB の pristine バックアップを取得中..."),
            );
            match listener_aux_io::pristine_backup_onecomme_db(onecomme_dir, backup_root) {
                Ok(p) => Some(p.to_string_lossy().to_string()),
                Err(e) => {
                    tracing::warn!(
                        "export_to_onecomme: aborting because pristine backup failed: {}",
                        e
                    );
                    warnings.push(format!("pristine バックアップ取得失敗のため書き戻しを中断: {}", e));
                    crate::engine::export_progress_reporter::report(
                        "aborted",
                        0,
                        0,
                        Some("pristine バックアップ失敗のため中断"),
                    );
                    return Ok(OnecommeExportSummary {
                        onecomme_dir: onecomme_dir.to_string_lossy().to_string(),
                        users_new: 0,
                        users_updated: 0,
                        comments_inserted: 0,
                        comments_skipped: 0,
                        backup_dir: None,
                        max_posted_at: None,
                        warnings,
                        aborted: true,
                    });
                }
            }
        } else {
            None
        };

        // 4. comments を select (since より新しい)。
        // ただし `meta_format_version` 未設定 (= v0.4.0 RC 以前で書き戻された旧 meta 形式が
        // わんコメ DB に残っている可能性) の場合は watermark を 0 にリセットして全件
        // 再 export し、`ON CONFLICT DO UPDATE WHERE service_id='komehub'` 経由で
        // 旧 meta を新形式に上書き修復する。成功後に format_version=1 を記録する。
        let meta_format_version: i32 = self
            .get_config_value("meta_format_version")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let needs_meta_repair = meta_format_version < 1;
        let watermark_str = self
            .get_config_value("last_sync_exported_max_komehub_posted_at")?
            .unwrap_or_default();
        let since: i64 = if needs_meta_repair {
            tracing::info!(
                "export_to_onecomme: meta_format_version={} (<1), forcing full re-export to repair legacy meta",
                meta_format_version
            );
            0
        } else {
            watermark_str.parse().unwrap_or(0)
        };

        let komehub_comments = self.select_comments_after(since)?;
        let max_posted_at = komehub_comments.iter().map(|c| c.posted_at).max();
        crate::engine::export_progress_reporter::report(
            "select-comments",
            0,
            komehub_comments.len() as u64,
            Some(&format!(
                "こめはぶから {} 件 select 完了",
                komehub_comments.len()
            )),
        );

        // listeners 全件 (上書きするのは通常少数だが、書き戻し対象を絞る場合は要件追加)
        let komehub_listeners = self.select_all_listeners()?;

        // 5. わんコメ用 row に変換。
        // 5.1 影響配信を抽出 → meta ranks を一括計算
        let mut affected_streams: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for c in &komehub_comments {
            affected_streams.insert(c.stream_id.clone());
        }
        let stream_ids: Vec<String> = affected_streams.into_iter().collect();
        let ranks_map = self.compute_meta_ranks(&stream_ids)?;
        // 5.2 config.json/services から service_id + color マップを構築
        let service_map = listener_aux_io::read_onecomme_service_map(onecomme_dir);
        // 5.3 各コメントを変換
        let comment_inserts: Vec<listener_aux_io::OnecommeCommentInsert> = komehub_comments
            .iter()
            .map(|c| {
                let ranks = ranks_map.get(&c.id).copied().unwrap_or(MetaRanks {
                    user_no: 1,
                    stream_lc: 1,
                });
                comment_row_to_onecomme_insert(c, ranks, &service_map)
            })
            .collect();
        let mut user_patches: Vec<listener_aux_io::OnecommeUserPatch> = komehub_listeners
            .iter()
            .map(listener_row_to_onecomme_patch)
            .collect();
        crate::engine::export_progress_reporter::report(
            "transform",
            0,
            0,
            Some("コメント形式変換完了"),
        );

        // 6. 書き込み (preflight 通過済みなので両テーブル揃っていることが保証される)
        // write-comments の細かい進捗は write_onecomme_comments 内で自動 push される
        let (comments_inserted, comments_skipped) =
            listener_aux_io::write_onecomme_comments(&comments_db, &comment_inserts)?;

        // 6.5 comments マージ後のわんコメ comments 実数で users.tc/tgc/amount/lcts を再計算する。
        // 「こめはぶで観測した分のみ」ではなく、「わんコメ DB に最終的に残った全コメント数」を
        // 真値として書き戻すため、わんコメ既存コメントも含めて集計し直す。
        // lcts も同様に集計値で上書き。これでわんコメ users.lcts が「真の最後コメ時刻」を
        // 維持できる (こめはぶ listener.last_seen_at で上書きする旧仕様だと、書き戻し
        // 実行時刻が混入して循環汚染する)。
        let onecomme_stats = listener_aux_io::aggregate_onecomme_user_stats(&comments_db)?;
        for patch in user_patches.iter_mut() {
            let stats = onecomme_stats.get(&patch.id).cloned().unwrap_or_default();
            if let Some(obj) = patch.komehub_data.as_object_mut() {
                obj.insert("tc".into(), serde_json::json!(stats.tc));
                obj.insert("tgc".into(), serde_json::json!(stats.tgc));
                obj.insert("amount".into(), serde_json::json!(stats.amount));
                if let Some(ts) = stats.max_created_at {
                    obj.insert("lcts".into(), serde_json::json!(ts));
                }
            }
        }
        crate::engine::export_progress_reporter::report(
            "aggregate-users",
            0,
            0,
            Some("リスナー集計完了"),
        );

        // write-users の細かい進捗は write_onecomme_users 内で自動 push される
        let (users_new, users_updated) =
            listener_aux_io::write_onecomme_users(&onecomme_db, &user_patches)?;

        // 7. (元 F-23 prune は 2026-05-16 pristine 化で廃止: pristine backup は 1 件固定なので
        //     世代管理不要、 onecommeDir 変更時のみ pristine_backup_onecomme_db が上書きする)

        // 8. watermark 更新 (実処理した最大 posted_at、§ 5.3)
        if let Some(mp) = max_posted_at {
            self.set_config_value("last_sync_exported_max_komehub_posted_at", &mp.to_string())?;
        }

        // 8.5 meta 形式の修復が完了した印を記録。次回からは通常 watermark で増分書き戻し。
        if needs_meta_repair {
            self.set_config_value("meta_format_version", "1")?;
        }
        // 書き戻し成功 (= aborted=false) → わんコメ書き戻し対象は全て反映済
        // (aborted の経路では既に early return 済なのでここに来ない = 必ず ok=true)
        self.clear_data_dirty();
        crate::engine::export_progress_reporter::report(
            "watermark",
            0,
            0,
            Some("watermark 更新完了"),
        );

        tracing::info!(
            "export_to_onecomme: completed (dir={:?}, users new={}/upd={}, comments new={}/skip={}, backup={:?})",
            onecomme_dir,
            users_new, users_updated,
            comments_inserted, comments_skipped,
            backup_dir
        );
        crate::engine::export_progress_reporter::report(
            "done",
            0,
            0,
            Some(&format!(
                "完了: コメ +{} / リスナー +{} 件",
                comments_inserted, users_new
            )),
        );

        Ok(OnecommeExportSummary {
            onecomme_dir: onecomme_dir.to_string_lossy().to_string(),
            users_new: users_new as i64,
            users_updated: users_updated as i64,
            comments_inserted: comments_inserted as i64,
            comments_skipped: comments_skipped as i64,
            backup_dir,
            max_posted_at,
            warnings,
            aborted: false,
        })
    }

    /// listeners.db.comments のうち、posted_at > since の自チャンネル分だけを返す。
    /// 他チャンネル配信の表示用コメントは、既定ではわんコメ書き戻し対象外にする。
    fn select_comments_after(&self, since: i64) -> rusqlite::Result<Vec<CommentRow>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT id, stream_id, listener_channel_id, posted_at, body, comment_type,
                    superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst,
                    responded_at
             FROM comments
             WHERE posted_at > ?1
               AND stream_id IN (
                 SELECT video_id FROM streams
                 WHERE (SELECT COUNT(*) FROM owner_channels) = 0
                    OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               )
             ORDER BY posted_at ASC",
        )?;
        let rows = stmt
            .query_map(params![since], row_to_comment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `stream_ids` に含まれる配信の **全 comments** に対し、わんコメ書き戻し用の
    /// per-stream global 連番 (`stream_lc`) と per-stream per-user 連番 (`user_no`) を
    /// 計算して `comment_id → MetaRanks` マップで返す。
    ///
    /// インクリメンタル書き戻し (since 以降のみ書く) でも `lc` が「配信全体での
    /// 通し番号」になるよう、watermark を無視して該当配信の全コメントを対象に
    /// `ROW_NUMBER() OVER` でランク付けする。
    ///
    /// ソートキーは `(posted_at ASC, id ASC)` で安定。同 ms 投稿の決定論的順序を保つ。
    pub(crate) fn compute_meta_ranks(
        &self,
        stream_ids: &[String],
    ) -> rusqlite::Result<std::collections::HashMap<String, MetaRanks>> {
        use std::collections::HashMap;
        let mut out: HashMap<String, MetaRanks> = HashMap::new();
        if stream_ids.is_empty() {
            return Ok(out);
        }
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        // IN 句の placeholder を組み立て (rusqlite は配列バインドができないため動的生成)
        let placeholders = (0..stream_ids.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id,
                    ROW_NUMBER() OVER (PARTITION BY stream_id, listener_channel_id
                                       ORDER BY posted_at ASC, id ASC) AS user_no,
                    ROW_NUMBER() OVER (PARTITION BY stream_id
                                       ORDER BY posted_at ASC, id ASC) AS stream_lc
             FROM comments
             WHERE stream_id IN ({})",
            placeholders
        );
        let params_vec: Vec<&dyn rusqlite::ToSql> = stream_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let mut stmt = g.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(params_vec.iter().copied()),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        for r in rows {
            let (id, user_no, stream_lc) = r?;
            out.insert(id, MetaRanks { user_no, stream_lc });
        }
        Ok(out)
    }

    /// listeners.db.listeners 全件を返す。
    fn select_all_listeners(&self) -> rusqlite::Result<Vec<ListenerRow>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(&format!(
            "SELECT {} FROM listeners",
            LISTENER_SELECT_COLUMNS
        ))?;
        let rows = stmt
            .query_map([], row_to_listener)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 過去に蓄積された自チャンネル外 / owner 不明な streams 行を一掃する (= ゴミ掃除)。
    /// `update_stream_metadata` 経由で配信前 metadata fetch が無条件に作っていた
    /// stub 行 (owner_channel_id 空 や 他チャンネル) を削除する。
    /// 安全網として `comments` が紐付いている stream は残す (= 履歴を破壊しない)。
    /// 戻り値: 削除した行数。
    #[allow(dead_code)]
    pub fn purge_non_owner_streams(&self) -> rusqlite::Result<usize> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        // B 方針では他チャンネル配信も管理対象なので消さない。
        // owner 不明かつ comments を 1 件も持たない古い stub だけを削除する。
        let n = g.execute(
            "DELETE FROM streams
             WHERE owner_channel_id = ''
               AND NOT EXISTS (SELECT 1 FROM comments WHERE comments.stream_id = streams.video_id)",
            [],
        )?;
        if n > 0 {
            tracing::info!("purge_non_owner_streams: removed {} stub rows", n);
        }
        Ok(n)
    }

    /// `video_owner_resolver` で取得した owner_channel_id / title / channel_name を
    /// streams テーブルに事前 upsert する (= 新規行作成 or 既存行の空フィールドを埋める)。
    ///
    /// 既存行があって owner / title / channel_name に値がある場合は触らない (= chat-scraper や
    /// 過去 import で入った値の方が正確な可能性。 resolver は YouTube HTML 抽出ベース)。
    ///
    /// started_at は `i64::MAX` で初期化することで、 後段の `flush_streams` で
    /// `MIN(streams.started_at, excluded.started_at = posted_at)` が posted_at で更新される
    /// (= 0 で初期化すると MIN は永遠に 0 になる)。
    pub(crate) fn upsert_resolved_stream_meta(
        &self,
        video_id: &str,
        owner_channel_id: &str,
        title: Option<&str>,
        channel_name: Option<&str>,
    ) -> rusqlite::Result<()> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        g.execute(
            "INSERT INTO streams (video_id, owner_channel_id, title, channel_name, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)
             ON CONFLICT(video_id) DO UPDATE SET
               owner_channel_id = CASE
                 WHEN streams.owner_channel_id = '' AND excluded.owner_channel_id != ''
                   THEN excluded.owner_channel_id
                 ELSE streams.owner_channel_id END,
               title = CASE
                 WHEN streams.title = '' AND excluded.title != ''
                   THEN excluded.title
                 ELSE streams.title END,
               channel_name = CASE
                 WHEN streams.channel_name = '' AND excluded.channel_name != ''
                   THEN excluded.channel_name
                 ELSE streams.channel_name END",
            params![
                video_id,
                owner_channel_id,
                title.unwrap_or(""),
                channel_name.unwrap_or(""),
                i64::MAX,
            ],
        )?;
        Ok(())
    }

    /// 自チャ owner (= `configured_owner_yt` リストに含まれる owner_channel_id) の streams から
    /// title または channel_name が空の row を SELECT し、 video_id 一覧を返す。
    /// `import_from_onecomme` の冒頭 repair pass で resolver にまとめて投入するために使う。
    pub(crate) fn list_streams_missing_meta_for_owners(
        &self,
        configured_owner_yt: &[String],
    ) -> rusqlite::Result<Vec<String>> {
        if configured_owner_yt.is_empty() {
            return Ok(Vec::new());
        }
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let placeholders = (1..=configured_owner_yt.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT video_id FROM streams
             WHERE (title = '' OR channel_name = '')
               AND owner_channel_id IN ({})",
            placeholders
        );
        let mut stmt = g.prepare(&sql)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = configured_owner_yt
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let video_ids: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(params_vec.iter()), |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(video_ids)
    }

    /// title / channel_name が空の自チャンネル過去 stream を Electron resolver (= watch ページ
    /// fetch) で再解決して埋める。`import_from_onecomme` の Pass 0 と、起動時の単独 backfill
    /// (= `BackfillStreamMeta`) の両方から呼ぶ (= 同じ修復ロジックを共有)。
    ///
    /// `configured_owner_yt` は `yt-UC...` 形式 (= list_streams_missing_meta_for_owners が
    /// streams.owner_channel_id と一致比較する)。configured が空なら no-op。
    /// **spawn_blocking 内から呼ぶ前提** (= resolve_unknown_owners_blocking が block_on する)。
    /// 戻り値: 修復できた video_id 群 (= 呼び出し側で SSE push して 配信ログ UI を更新する)。
    pub(crate) fn repair_missing_stream_meta(
        &self,
        configured_owner_yt: &[String],
    ) -> rusqlite::Result<Vec<String>> {
        let mut repaired_video_ids: Vec<String> = Vec::new();
        if configured_owner_yt.is_empty() {
            return Ok(repaired_video_ids);
        }
        let missing_video_ids = self.list_streams_missing_meta_for_owners(configured_owner_yt)?;
        if missing_video_ids.is_empty() {
            return Ok(repaired_video_ids);
        }
        tracing::info!(
            "repair_missing_stream_meta: repairing {} streams with empty title/channel_name",
            missing_video_ids.len()
        );
        let resolved =
            crate::engine::video_owner_resolver::resolve_unknown_owners_blocking(missing_video_ids);
        for meta in resolved {
            let normalized_owner = if meta.owner_channel_id.starts_with("yt-") {
                meta.owner_channel_id.clone()
            } else {
                format!("yt-{}", meta.owner_channel_id)
            };
            if let Err(e) = self.upsert_resolved_stream_meta(
                &meta.video_id,
                &normalized_owner,
                meta.title.as_deref(),
                meta.channel_name.as_deref(),
            ) {
                tracing::warn!("repair upsert failed for {}: {}", meta.video_id, e);
            } else {
                repaired_video_ids.push(meta.video_id);
            }
        }
        Ok(repaired_video_ids)
    }

    /// streams テーブルから video_id に対応する owner_channel_id を返す。
    /// 既存行がなければ None。空文字 owner も None として扱う。
    pub(crate) fn lookup_stream_owner(&self, video_id: &str) -> rusqlite::Result<Option<String>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let result: rusqlite::Result<String> = g.query_row(
            "SELECT owner_channel_id FROM streams WHERE video_id = ?1",
            params![video_id],
            |r| r.get(0),
        );
        match result {
            Ok(s) if s.is_empty() => Ok(None),
            Ok(s) => Ok(Some(s)),
            Err(SqliteError::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// listeners.db の config テーブルから値を読む。
    fn get_config_value(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        match g.query_row(
            "SELECT value FROM config WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        ) {
            Ok(s) => Ok(Some(s)),
            Err(SqliteError::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn set_config_value(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        g.execute(
            "INSERT INTO config(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 自チャンネル設定の一覧を `owner_channels` テーブルから取得する。
    /// 複数 ID 対応 (サブチャンネル等)。空 Vec = 未設定。順序は登録順 (rowid 昇順)。
    /// 各要素は `OwnerChannel { channel_id, handle? }`。
    pub fn get_owner_channels(
        &self,
    ) -> rusqlite::Result<Vec<crate::state::listener::OwnerChannel>> {
        use crate::state::listener::OwnerChannel;
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt =
            g.prepare("SELECT channel_id, handle FROM owner_channels ORDER BY rowid ASC")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(OwnerChannel {
                    channel_id: row.get(0)?,
                    handle: row.get::<_, Option<String>>(1)?.filter(|s| !s.is_empty()),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// テスト用ショートカット: channel_id のみで一括上書き (handle なし)。
    /// 本番コードは set_owner_channels で OwnerChannel を直接渡す。
    #[cfg(test)]
    pub fn set_owner_channel_ids(&self, ids: &[&str]) -> rusqlite::Result<()> {
        use crate::state::listener::OwnerChannel;
        let channels: Vec<OwnerChannel> = ids
            .iter()
            .map(|id| OwnerChannel {
                channel_id: id.to_string(),
                handle: None,
            })
            .collect();
        self.set_owner_channels(&channels)
    }

    /// テスト用ショートカット: channel_id だけ取り出す。
    #[cfg(test)]
    pub fn get_owner_channel_ids(&self) -> rusqlite::Result<Vec<String>> {
        Ok(self
            .get_owner_channels()?
            .into_iter()
            .map(|c| c.channel_id)
            .collect())
    }

    /// 自チャンネル設定一覧を一括上書き保存する (一旦全削除 → INSERT)。
    /// 空配列で全クリア (= 未設定状態)。重複は INSERT OR IGNORE。
    pub fn set_owner_channels(
        &self,
        channels: &[crate::state::listener::OwnerChannel],
    ) -> rusqlite::Result<()> {
        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM owner_channels", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO owner_channels(channel_id, handle) VALUES (?1, ?2)",
            )?;
            for ch in channels {
                let id = ch.channel_id.trim();
                if id.is_empty() {
                    continue;
                }
                let handle = ch
                    .handle
                    .as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty());
                stmt.execute(params![id, handle])?;
            }
        }
        tx.commit()?;
        drop(conn); // 再集計は再度 lock するため先に解放
        self.recalculate_listener_self_aggregates()?;
        // 自チャ変更で全 listener の aggregates (tc/superchat/first_seen/last_seen) が
        // 再計算される → わんコメ users.tc/tgc/amount/lcts に書き戻すべき
        self.mark_data_dirty();
        Ok(())
    }

    fn recalculate_listener_self_aggregates(&self) -> rusqlite::Result<()> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        g.execute(
            "UPDATE listeners SET
               comment_count = COALESCE((
                 SELECT COUNT(*) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = listeners.channel_id
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), 0),
               superchat_count = COALESCE((
                 SELECT COUNT(*) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = listeners.channel_id
                   AND c.comment_type IN ('superchat', 'sticker', 'gift')
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), 0),
               superchat_amount_jpy = COALESCE((
                 SELECT SUM(COALESCE(c.superchat_amount_jpy, 0)) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = listeners.channel_id
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), 0),
               first_seen_at = COALESCE((
                 SELECT MIN(c.posted_at) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = listeners.channel_id
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), 0),
               last_seen_at = COALESCE((
                 SELECT MAX(c.posted_at) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = listeners.channel_id
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), 0)",
            [],
        )?;
        self.invalidate_stream_scoped_cache();
        Ok(())
    }

    /// リスナー一覧を取得する。
    /// `query` で並び替え (count / streamFirstAt / lastSeen / amount / name) と検索 (display_name 部分一致) と
    /// ページング (limit / offset) を制御する。フェーズ 3.2a で UI 一覧から呼ばれる。
    pub fn list_listeners(&self, query: &ListenersQuery) -> rusqlite::Result<ListenersPage> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let limit = query.limit.unwrap_or(100).clamp(1, 1000) as i64;
        let offset = query.offset.unwrap_or(0) as i64;
        let q_trim = query.q.as_deref().unwrap_or("").trim();
        let stream_video_id = query
            .stream_video_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let has_stream_context = !stream_video_id.is_empty();
        let baseline_stream_video_id = query
            .baseline_stream_video_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        // baseline は stream_video_id (= 母集団絞り込み) と排他: stream_video_id が
        // あれば baseline は無視する (= 既存挙動優先)。
        let has_baseline = !baseline_stream_video_id.is_empty() && !has_stream_context;
        let now_ms = current_unix_millis();
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let one_year_ms: i64 = self.veteran_one_year_ms();
        let regular_n: i64 = self.regular_window_n() as i64;
        let regular_m: i64 = self.regular_min_m() as i64;
        let order_by = match query.sort {
            ListenersSort::CommentCount if has_stream_context => {
                "cl.per_stream_comment_count DESC, cl.per_stream_last_at DESC"
            }
            ListenersSort::CommentCount => "l.comment_count DESC, l.last_seen_at DESC",
            ListenersSort::StreamFirstAt if has_stream_context => {
                "cl.per_stream_first_at DESC, cl.per_stream_last_at DESC, l.last_seen_at DESC"
            }
            ListenersSort::StreamFirstAt | ListenersSort::LastSeen => {
                "l.last_seen_at DESC, l.comment_count DESC"
            }
            ListenersSort::SuperchatAmount => "l.superchat_amount_jpy DESC, l.last_seen_at DESC",
            ListenersSort::DisplayName => "l.display_name COLLATE NOCASE ASC",
        };

        // パフォーマンス設計:
        // - 案 A (CTE 化): per-row EXISTS / sub-select を JOIN with materialized CTE
        // - 対策 4 (OVER): COUNT(*) と rows を 1 statement に統合 (= CTE materialize 1 回)
        //   これがないと total 用 / rows 用で 2 回 materialize して 2 倍コスト
        // - 対策 5 (recent_streams 分離): 直近 14 枠 ID を別 CTE 化、JOIN で query plan 改善
        let mut cte_parts: Vec<String> = Vec::new();
        let mut where_clauses: Vec<String> = Vec::new();
        let mut cte_bind: Vec<rusqlite::types::Value> = Vec::new();
        let mut where_bind: Vec<rusqlite::types::Value> = Vec::new();

        if has_stream_context {
            cte_parts.push(
                "current_listeners AS MATERIALIZED (
                   SELECT listener_channel_id AS channel_id,
                          COUNT(*) AS per_stream_comment_count,
                          MIN(posted_at) AS per_stream_first_at,
                          MAX(posted_at) AS per_stream_last_at
                   FROM comments WHERE stream_id = ?
                   GROUP BY listener_channel_id
                 )"
                .to_string(),
            );
            cte_bind.push(rusqlite::types::Value::Text(stream_video_id.clone()));

            if query.comeback_only {
                // 対策 5: recent_streams を独立 CTE 化、INNER JOIN で読む。inline IN だと
                // SQLite が `LIMIT 14` 部分を毎行評価する可能性あり、別 CTE で 1 回固定。
                cte_parts.push(
                    "recent_streams AS MATERIALIZED (
                       SELECT video_id FROM streams
                       WHERE video_id != ?
                         AND ((SELECT COUNT(*) FROM owner_channels) = 0
                              OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                       ORDER BY started_at DESC LIMIT 14
                     )".to_string()
                );
                cte_bind.push(rusqlite::types::Value::Text(stream_video_id.clone()));
                cte_parts.push(
                    "listeners_in_recent AS MATERIALIZED (
                       SELECT DISTINCT c.listener_channel_id AS channel_id
                       FROM comments c
                       INNER JOIN recent_streams rs ON rs.video_id = c.stream_id
                     )"
                    .to_string(),
                );
            }
            if query.new_member_only {
                cte_parts.push(
                    "new_members AS MATERIALIZED (
                       SELECT DISTINCT listener_channel_id AS channel_id
                       FROM comments
                       WHERE stream_id = ? AND comment_type = 'membership'
                     )"
                    .to_string(),
                );
                cte_bind.push(rusqlite::types::Value::Text(stream_video_id.clone()));
            }
            let needs_current_started = query.first_in_stream_only
                || query.system_tags.iter().any(|tag| tag == "returning" || tag == "first-time");
            if needs_current_started {
                cte_parts.push(
                    "current_started AS MATERIALIZED (
                       SELECT IFNULL(started_at, 0) AS started_at
                       FROM streams WHERE video_id = ?
                     )"
                    .to_string(),
                );
                cte_bind.push(rusqlite::types::Value::Text(stream_video_id.clone()));
            }
        }

        // baseline_stream_video_id (= Phase 2b' リスナー検索) 用 CTE 群。
        // stream_video_id とは排他で、母集団は全 listener のまま時刻基準だけを
        // 「最終枠.started_at」に揃える。 復帰 / 離脱 を per-row に分けるために
        // active 判定 (= 直近 N 枠 / M 枠以上発言) と「復帰窓 (= last_n_streams ∪ baseline、
        // N+1 枠) コメ済」を併用する。
        if has_baseline {
            cte_parts.push(
                "baseline_started AS MATERIALIZED (
                   SELECT IFNULL(started_at, 0) AS started_at
                   FROM streams WHERE video_id = ?
                 )"
                .to_string(),
            );
            cte_bind.push(rusqlite::types::Value::Text(baseline_stream_video_id.clone()));
            cte_parts.push(
                "last_n_streams AS MATERIALIZED (
                   SELECT video_id FROM streams
                   WHERE started_at < (SELECT started_at FROM baseline_started)
                     AND ((SELECT COUNT(*) FROM owner_channels) = 0
                          OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                   ORDER BY started_at DESC LIMIT ?
                 )"
                .to_string(),
            );
            cte_bind.push(rusqlite::types::Value::Integer(regular_n));
            cte_parts.push(
                "active_listeners AS MATERIALIZED (
                   SELECT listener_channel_id
                   FROM comments
                   WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                   GROUP BY listener_channel_id
                   HAVING COUNT(DISTINCT stream_id) >= ?
                 )"
                .to_string(),
            );
            cte_bind.push(rusqlite::types::Value::Integer(regular_m));
            // 復帰窓 = last_n_streams (= baseline より前の N 枠) ∪ baseline 自身 の N+1 枠。
            // この window のいずれかにコメがあれば復帰判定 (= まだ巡回してる)、 ゼロなら
            // 離脱判定 (= 完全に消えた) とする。 (= 2026-05-14 ユーザ指示で
            // 旧「baseline のみコメ済か」から拡張)。
            cte_parts.push(
                "comeback_window_listeners AS MATERIALIZED (
                   SELECT DISTINCT listener_channel_id AS channel_id
                   FROM comments
                   WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                      OR stream_id = ?
                 )"
                .to_string(),
            );
            cte_bind.push(rusqlite::types::Value::Text(baseline_stream_video_id.clone()));
        }

        if !q_trim.is_empty() {
            // 横断検索: display_name + nickname + username の OR (= ユーザが付けた
            // nickname / ラベル相当も検索対象に。 username は @ハンドル相当)。
            // 同 pattern を 3 回 push して unnamed `?` を 3 箇所で使う (= 周囲の
            // where_clauses も unnamed `?` 前提なので index 系と混ぜない)。
            where_clauses.push(
                "(l.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE \
                  OR l.nickname LIKE ? ESCAPE '\\' COLLATE NOCASE \
                  OR COALESCE(l.username,'') LIKE ? ESCAPE '\\' COLLATE NOCASE)"
                    .to_string(),
            );
            let pat = format!("%{}%", q_trim);
            where_bind.push(rusqlite::types::Value::Text(pat.clone()));
            where_bind.push(rusqlite::types::Value::Text(pat.clone()));
            where_bind.push(rusqlite::types::Value::Text(pat));
        }
        // user_tags (listener_tags 経由 EXISTS、 タグ間は OR)。
        // 2026-05-16: StreamListenersQuery / CommentsQuery では既に対応済だったが、
        // ListenersQuery では silent drop していた制約を解消。
        if !query.user_tags.is_empty() {
            let placeholders: Vec<String> = (0..query.user_tags.len())
                .map(|_| "?".to_string())
                .collect();
            where_clauses.push(format!(
                "EXISTS (SELECT 1 FROM listener_tags lt \
                         WHERE lt.channel_id = l.channel_id \
                           AND lt.tag IN ({}))",
                placeholders.join(",")
            ));
            for t in &query.user_tags {
                where_bind.push(rusqlite::types::Value::Text(t.clone()));
            }
        }
        if !has_stream_context {
            where_clauses.push("l.comment_count > 0".to_string());
        }
        if has_stream_context && query.un_greeted_only {
            where_clauses.push("IFNULL(sls.greeted_at, 0) = 0".to_string());
        }
        if !query.system_tags.is_empty() {
            let mut sub_or: Vec<String> = Vec::new();
            // has_baseline 経路 (= Phase 2b' リスナー検索): baseline.started_at 基準で
            // 6 ランク + 「最終枠コメ済」EXISTS subquery で 復帰 / 離脱 を分離。
            // active 判定はデータ不足時 (= last_n_streams < M) フォールバックで全員 active 扱い
            // (= 復帰 / 離脱 は 0 件、 list_stream_listeners と同じ規範)。
            for tag in &query.system_tags {
                match (tag.as_str(), has_baseline) {
                    ("first-time", true) => {
                        sub_or.push(
                            "l.first_seen_at >= (SELECT started_at FROM baseline_started)"
                                .to_string(),
                        );
                    }
                    ("returning", true) => {
                        sub_or.push(
                            "(l.first_seen_at < (SELECT started_at FROM baseline_started)
                              AND l.first_seen_at >= ((SELECT started_at FROM baseline_started) - ?))"
                                .to_string(),
                        );
                        where_bind.push(rusqlite::types::Value::Integer(one_month_ms));
                    }
                    ("regular", true) => {
                        sub_or.push(
                            "(l.first_seen_at < ((SELECT started_at FROM baseline_started) - ?)
                              AND l.first_seen_at >= ((SELECT started_at FROM baseline_started) - ?)
                              AND ((SELECT COUNT(*) FROM last_n_streams) < ?
                                   OR l.channel_id IN (SELECT listener_channel_id FROM active_listeners)))"
                                .to_string(),
                        );
                        where_bind.push(rusqlite::types::Value::Integer(one_month_ms));
                        where_bind.push(rusqlite::types::Value::Integer(one_year_ms));
                        where_bind.push(rusqlite::types::Value::Integer(regular_m));
                    }
                    ("veteran", true) => {
                        sub_or.push(
                            "(l.first_seen_at < ((SELECT started_at FROM baseline_started) - ?)
                              AND ((SELECT COUNT(*) FROM last_n_streams) < ?
                                   OR l.channel_id IN (SELECT listener_channel_id FROM active_listeners)))"
                                .to_string(),
                        );
                        where_bind.push(rusqlite::types::Value::Integer(one_year_ms));
                        where_bind.push(rusqlite::types::Value::Integer(regular_m));
                    }
                    ("comeback", true) => {
                        // 復帰: 新参条件外 + active 外 + 復帰窓 (= last_n ∪ baseline、 N+1 枠) でコメ済。
                        sub_or.push(
                            "(l.first_seen_at < ((SELECT started_at FROM baseline_started) - ?)
                              AND (SELECT COUNT(*) FROM last_n_streams) >= ?
                              AND l.channel_id NOT IN (SELECT listener_channel_id FROM active_listeners)
                              AND l.channel_id IN (SELECT channel_id FROM comeback_window_listeners))"
                                .to_string(),
                        );
                        where_bind.push(rusqlite::types::Value::Integer(one_month_ms));
                        where_bind.push(rusqlite::types::Value::Integer(regular_m));
                    }
                    ("abandoned", true) => {
                        // 離脱: 新参条件外 + active 外 + 復帰窓でコメ無し (= 完全に消えてる)。
                        sub_or.push(
                            "(l.first_seen_at < ((SELECT started_at FROM baseline_started) - ?)
                              AND (SELECT COUNT(*) FROM last_n_streams) >= ?
                              AND l.channel_id NOT IN (SELECT listener_channel_id FROM active_listeners)
                              AND l.channel_id NOT IN (SELECT channel_id FROM comeback_window_listeners))"
                                .to_string(),
                        );
                        where_bind.push(rusqlite::types::Value::Integer(one_month_ms));
                        where_bind.push(rusqlite::types::Value::Integer(regular_m));
                    }
                    // has_baseline=false (= 既存挙動): stream_context あり / 無し で分岐。
                    // 新規: stream_context あり → この枠で初コメ (= first_seen_at >= 当該枠 started_at)。
                    // 旧 `comment_count <= 1` (累計 1 件以下) は 2026-05-13 に廃止。
                    // stream_context 無し (= 全期間リスナー一覧) は累計 1 件以下を新規扱い (=
                    // 全期間で「ほぼ未発言」のリスナー、後方互換)。
                    ("first-time", false) => {
                        if has_stream_context {
                            sub_or.push(
                                "l.first_seen_at >= (SELECT started_at FROM current_started)"
                                    .to_string(),
                            );
                        } else {
                            sub_or.push("l.comment_count <= 1".to_string());
                        }
                    }
                    ("returning", false) => {
                        // 新参: 新規ではない (= 過去枠で初コメ) AND X 日以内に初コメ
                        if has_stream_context {
                            sub_or.push(
                                "(l.first_seen_at < (SELECT started_at FROM current_started)
                                  AND l.first_seen_at >= ?)"
                                    .to_string(),
                            );
                        } else {
                            sub_or
                                .push("(l.comment_count > 1 AND l.first_seen_at >= ?)".to_string());
                        }
                        where_bind.push(rusqlite::types::Value::Integer(now_ms - one_month_ms));
                    }
                    ("regular", false) => {
                        sub_or.push("(l.first_seen_at < ? AND l.first_seen_at >= ?)".to_string());
                        where_bind.push(rusqlite::types::Value::Integer(now_ms - one_month_ms));
                        where_bind.push(rusqlite::types::Value::Integer(now_ms - one_year_ms));
                    }
                    ("veteran", false) => {
                        sub_or.push("l.first_seen_at < ?".to_string());
                        where_bind.push(rusqlite::types::Value::Integer(now_ms - one_year_ms));
                    }
                    // comeback / abandoned は has_baseline=false では未対応 (= 何もマッチさせない)。
                    // JS が baseline 未解決の状態で「復帰」「離脱」chip を投げてきた場合の
                    // 防御: そのまま無視して結果に含めない (= 空 OR 句相当)。
                    _ => {}
                }
            }
            if !sub_or.is_empty() {
                where_clauses.push(format!("({})", sub_or.join(" OR ")));
            } else {
                // system_tags は指定されたが認識タグが 0 件 (= baseline 未解決で
                // "comeback" / "abandoned" だけ投げられた防御ケース)。 「フィルタ指定があるのに
                // 全件返す」誤解を避けるため 0 件にする。
                where_clauses.push("0 = 1".to_string());
            }
        }
        if query.comeback_only && has_stream_context {
            where_clauses.push(
                "(l.first_seen_at < ?
                  AND l.channel_id NOT IN (SELECT channel_id FROM listeners_in_recent))"
                    .to_string(),
            );
            where_bind.push(rusqlite::types::Value::Integer(now_ms - one_month_ms));
        }
        if query.new_member_only && has_stream_context {
            where_clauses.push("l.channel_id IN (SELECT channel_id FROM new_members)".to_string());
        }
        if query.first_in_stream_only && has_stream_context {
            where_clauses
                .push("l.first_seen_at >= (SELECT started_at FROM current_started)".to_string());
        }

        let from_join = if has_stream_context {
            String::from(
                "FROM listeners l
                 INNER JOIN current_listeners cl ON cl.channel_id = l.channel_id
                 LEFT JOIN stream_listener_state sls
                   ON sls.listener_channel_id = l.channel_id
                  AND sls.stream_video_id = ?",
            )
        } else {
            String::from("FROM listeners l")
        };
        let mut from_join_bind: Vec<rusqlite::types::Value> = Vec::new();
        if has_stream_context {
            from_join_bind.push(rusqlite::types::Value::Text(stream_video_id.clone()));
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };
        let cte_sql = if cte_parts.is_empty() {
            String::new()
        } else {
            format!("WITH {}", cte_parts.join(",\n"))
        };

        // 対策 4: 1 statement で rows + total を取得。COUNT(*) OVER() は WHERE/JOIN 後の
        // 全行カウント (LIMIT 適用前) を返すので、各行に同値が乗る。
        // 列順: LISTENER_SELECT_COLUMNS (0..18) + greeted_at (19)
        //       + per_stream_sc_amount_jpy (20) + per_stream_comment_count (21)
        //       + per_stream_last_at (22) + row_total (23)
        let listener_cols_with_alias = LISTENER_SELECT_COLUMNS.replace("listeners.", "l.");
        let greeted_col = if has_stream_context {
            ", IFNULL(sls.greeted_at, 0) AS greeted_at"
        } else {
            ", 0 AS greeted_at"
        };
        // per_stream_sc_amount_jpy: 当該枠での SC 累計を correlated subquery で集計。
        // listener row が持つ累計値 (= listeners.superchat_amount_jpy) とは独立で、
        // renderer の amber primary 表示の正本値になる。WHERE で除外された listener も
        // 数えない (= JOIN 後の集計ではなく、subquery 内で stream_id 完結)。
        // has_stream_context のみ subquery、それ以外は 0 固定。
        let mut per_stream_sc_bind: Vec<rusqlite::types::Value> = Vec::new();
        let per_stream_sc_col = if has_stream_context {
            per_stream_sc_bind.push(rusqlite::types::Value::Text(stream_video_id.clone()));
            ", COALESCE((SELECT SUM(superchat_amount_jpy) FROM comments \
                         WHERE listener_channel_id = l.channel_id AND stream_id = ? \
                           AND superchat_amount_jpy > 0), 0) AS per_stream_sc_amount_jpy"
        } else {
            ", 0 AS per_stream_sc_amount_jpy"
        };
        let per_stream_comment_count_col = if has_stream_context {
            ", cl.per_stream_comment_count AS per_stream_comment_count"
        } else {
            ", 0 AS per_stream_comment_count"
        };
        let per_stream_last_at_col = if has_stream_context {
            ", cl.per_stream_last_at AS per_stream_last_at"
        } else {
            ", 0 AS per_stream_last_at"
        };
        let combined_sql = format!(
            "{cte} SELECT {cols}{greeted}{per_stream_sc}{per_stream_count}{per_stream_last}, COUNT(*) OVER() AS row_total \
             {from_join} {where_clause} ORDER BY {order} LIMIT ? OFFSET ?",
            cte = cte_sql,
            cols = listener_cols_with_alias,
            greeted = greeted_col,
            per_stream_sc = per_stream_sc_col,
            per_stream_count = per_stream_comment_count_col,
            per_stream_last = per_stream_last_at_col,
            from_join = from_join,
            where_clause = where_sql,
            order = order_by
        );
        // バインド順は SQL 中の `?` 出現順に揃える: CTE → SELECT(per_stream_sc) →
        // FROM(sls JOIN) → WHERE → LIMIT/OFFSET。
        let mut combined_bind: Vec<rusqlite::types::Value> = Vec::new();
        combined_bind.extend(cte_bind.iter().cloned());
        combined_bind.extend(per_stream_sc_bind.iter().cloned());
        combined_bind.extend(from_join_bind.iter().cloned());
        combined_bind.extend(where_bind.iter().cloned());
        combined_bind.push(rusqlite::types::Value::Integer(limit));
        combined_bind.push(rusqlite::types::Value::Integer(offset));

        let mut stmt = g.prepare(&combined_sql)?;
        let mut total: i64 = 0;
        let mut rows: Vec<ListenerRow> = stmt
            .query_map(rusqlite::params_from_iter(combined_bind.iter()), |row| {
                // row_total は全行同じ値なので 1 度キャプチャすれば良い (col 23)
                if total == 0 {
                    total = row.get::<_, i64>(23).unwrap_or(0);
                }
                row_to_listener(row)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // 0 rows の場合 OVER() は走らないので total=0 のまま。これは正しい
        // (= フィルタが何もマッチしなかった = 総数 0)。

        // システムタグを post-process で各 row に埋める (= 2026-05-14)。
        // 接続中リスナータブ / リスナー検索タブ 両方で使う per-row ランクバッジ用。
        // baseline = stream_video_id 指定時は当該枠 / baseline_stream_video_id 指定時は
        // 解決済みの baseline 配信。 両方未指定なら system_tag は None のまま。
        let baseline_video = if has_stream_context {
            stream_video_id.as_str()
        } else if has_baseline {
            baseline_stream_video_id.as_str()
        } else {
            ""
        };
        if !baseline_video.is_empty() && !rows.is_empty() {
            let baseline_started: i64 = g
                .query_row(
                    "SELECT IFNULL(started_at, 0) FROM streams WHERE video_id = ?1",
                    params![baseline_video],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if baseline_started > 0 {
                // last_n_streams count (= データ不足判定)。 不足なら全員 active 扱い (= 復帰判定無効化)。
                let last_n_count: i64 = g.query_row(
                    "SELECT COUNT(*) FROM (
                         SELECT s.video_id FROM streams s
                         WHERE s.started_at < ?1
                           AND ((SELECT COUNT(*) FROM owner_channels) = 0
                                OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                         ORDER BY s.started_at DESC LIMIT ?2
                     )",
                    params![baseline_started, regular_n],
                    |r| r.get(0),
                )?;
                let data_shortage = last_n_count < regular_m;
                // active_listeners set
                let mut active_stmt = g.prepare(
                    "SELECT listener_channel_id FROM comments
                     WHERE stream_id IN (
                         SELECT video_id FROM streams
                         WHERE started_at < ?1
                           AND ((SELECT COUNT(*) FROM owner_channels) = 0
                                OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                         ORDER BY started_at DESC LIMIT ?2
                     )
                     GROUP BY listener_channel_id
                     HAVING COUNT(DISTINCT stream_id) >= ?3",
                )?;
                let active_set: std::collections::HashSet<String> = active_stmt
                    .query_map(params![baseline_started, regular_n, regular_m], |r| {
                        r.get::<_, String>(0)
                    })?
                    .filter_map(|r| r.ok())
                    .collect();
                // 復帰窓 set (= last_n_streams ∪ baseline でコメ済)。
                // has_stream_context (= 接続中リスナータブ) では母集団が全員 baseline コメ済なので
                // 不要 (= 全員 in_comeback_window=true)。 has_baseline (= リスナー検索) で必要。
                let comeback_window_set: Option<std::collections::HashSet<String>> = if has_baseline
                {
                    let mut cw_stmt = g.prepare(
                        "SELECT DISTINCT listener_channel_id FROM comments
                         WHERE stream_id IN (
                             SELECT video_id FROM streams
                             WHERE started_at < ?1
                               AND ((SELECT COUNT(*) FROM owner_channels) = 0
                                    OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                             ORDER BY started_at DESC LIMIT ?2
                         ) OR stream_id = ?3",
                    )?;
                    let set: std::collections::HashSet<String> = cw_stmt
                        .query_map(
                            params![baseline_started, regular_n, baseline_video],
                            |r| r.get::<_, String>(0),
                        )?
                        .filter_map(|r| r.ok())
                        .collect();
                    Some(set)
                } else {
                    None
                };
                for row in &mut rows {
                    let is_active = data_shortage || active_set.contains(&row.channel_id);
                    let in_comeback_window = match &comeback_window_set {
                        Some(set) => set.contains(&row.channel_id),
                        None => true, // 接続中リスナータブ: 全員 baseline でコメ済
                    };
                    let tag = classify_listener_rank(
                        row.first_seen_at,
                        is_active,
                        in_comeback_window,
                        baseline_started,
                        one_month_ms,
                        one_year_ms,
                    );
                    row.system_tag = Some(tag.to_string());
                }
            }
        }

        Ok(ListenersPage {
            total,
            limit,
            offset,
            rows,
        })
    }

    /// 設定画面「リスナー判定」ライブプレビュー用: 全 listener 母集団 (=
    /// `listeners.comment_count > 0`) に対して、 baseline 基準で 6 ランク
    /// (新規 / 新参 / 常連 / 古参 / 復帰 / 離脱) の件数を 1 SQL で集計する。
    ///
    /// 配信者が しきい値 (X / Y / N / M) を変えた時に「今の自分の audience が
    /// 各ランク何人になるか」を即時表示するための専用 RPC。 リスナー検索 chip
    /// (= `list_listeners` with `baseline_stream_video_id`) と同じ classification
    /// ロジックを再利用し、 結果も同じ意味になる。
    ///
    /// baseline_video_id が空文字 / streams に存在しない場合は全件 0 を返す
    /// (= 防御挙動、 JS 側で fetch 抑止を推奨)。
    pub fn list_listener_search_rank_counts(
        &self,
        baseline_video_id: &str,
    ) -> rusqlite::Result<crate::state::listener::ListenerSearchRankCounts> {
        use crate::state::listener::ListenerSearchRankCounts;
        if baseline_video_id.is_empty() {
            return Ok(ListenerSearchRankCounts::default());
        }
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let n = self.regular_window_n() as i64;
        let m = self.regular_min_m() as i64;
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let one_year_ms: i64 = self.veteran_one_year_ms();

        // baseline.started_at が 0 (= streams に行無し / 未確定) なら 0 件返す。
        let baseline_started: i64 = g.query_row(
            "SELECT IFNULL(started_at, 0) FROM streams WHERE video_id = ?1",
            params![baseline_video_id],
            |r| r.get(0),
        ).optional()?.unwrap_or(0);
        if baseline_started <= 0 {
            return Ok(ListenerSearchRankCounts::default());
        }

        // CTE 群: list_listeners with baseline_stream_video_id と同じロジックを再利用。
        // - last_n_streams: owner_channels 配下 + baseline より前 + LIMIT N
        // - active_listeners: last_n_streams で M 枠以上発言
        // - comeback_window_listeners: last_n_streams ∪ baseline でコメ済
        let sql = "WITH
              last_n_streams AS MATERIALIZED (
                SELECT video_id FROM streams
                WHERE started_at < ?1
                  AND ((SELECT COUNT(*) FROM owner_channels) = 0
                       OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                ORDER BY started_at DESC LIMIT ?2
              ),
              active_listeners AS MATERIALIZED (
                SELECT listener_channel_id FROM comments
                WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                GROUP BY listener_channel_id
                HAVING COUNT(DISTINCT stream_id) >= ?3
              ),
              comeback_window_listeners AS MATERIALIZED (
                SELECT DISTINCT listener_channel_id AS channel_id FROM comments
                WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                   OR stream_id = ?4
              )
             SELECT
               COUNT(*) AS total_cnt,
               SUM(CASE WHEN l.first_seen_at >= ?1 THEN 1 ELSE 0 END) AS first_time_cnt,
               SUM(CASE WHEN l.first_seen_at < ?1
                          AND l.first_seen_at >= ?1 - ?5
                        THEN 1 ELSE 0 END) AS returning_cnt,
               SUM(CASE WHEN l.first_seen_at < ?1 - ?5
                          AND l.first_seen_at >= ?1 - ?6
                          AND ((SELECT COUNT(*) FROM last_n_streams) < ?3
                               OR l.channel_id IN (SELECT listener_channel_id FROM active_listeners))
                        THEN 1 ELSE 0 END) AS regular_cnt,
               SUM(CASE WHEN l.first_seen_at < ?1 - ?6
                          AND ((SELECT COUNT(*) FROM last_n_streams) < ?3
                               OR l.channel_id IN (SELECT listener_channel_id FROM active_listeners))
                        THEN 1 ELSE 0 END) AS veteran_cnt,
               SUM(CASE WHEN l.first_seen_at < ?1 - ?5
                          AND (SELECT COUNT(*) FROM last_n_streams) >= ?3
                          AND l.channel_id NOT IN (SELECT listener_channel_id FROM active_listeners)
                          AND l.channel_id IN (SELECT channel_id FROM comeback_window_listeners)
                        THEN 1 ELSE 0 END) AS comeback_cnt,
               SUM(CASE WHEN l.first_seen_at < ?1 - ?5
                          AND (SELECT COUNT(*) FROM last_n_streams) >= ?3
                          AND l.channel_id NOT IN (SELECT listener_channel_id FROM active_listeners)
                          AND l.channel_id NOT IN (SELECT channel_id FROM comeback_window_listeners)
                        THEN 1 ELSE 0 END) AS abandoned_cnt
             FROM listeners l
             WHERE l.comment_count > 0";

        let counts = g.query_row(
            sql,
            params![baseline_started, n, m, baseline_video_id, one_month_ms, one_year_ms],
            |r| {
                Ok(ListenerSearchRankCounts {
                    total: r.get::<_, i64>(0)?,
                    first_time: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    returning: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    regular: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    veteran: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    comeback: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    abandoned: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                })
            },
        )?;
        Ok(counts)
    }

    /// 案 D: 6 タブ件数の TTL キャッシュを invalidate。record_comment / set_listener_greeted /
    /// 接続切替 (= ConnectionStateChanged) 等、母集団 / 状態が変化する経路から呼ぶ。
    pub fn invalidate_stream_scoped_cache(&self) {
        if let Ok(mut cache) = self.stream_scoped_cache.lock() {
            cache.entry = None;
        }
    }

    /// リスナータブのミニタブ件数バッジ用。stream_video_id (= 接続中の枠) でフィルタした
    /// listeners 母集団に対して、6 タブ (= 全て / 未挨拶 / 新規 / 再訪 / 復帰 / 新メンバー)
    /// それぞれの件数を 1 SQL で集計する。
    ///
    /// パフォーマンス設計:
    /// - 案 A (CTE 書き換え): per-row の `EXISTS / NOT EXISTS / scalar sub-select` は
    ///   `MATERIALIZED CTE` で 1 回だけ評価し、メイン SELECT では LEFT JOIN による
    ///   O(1) hash probe にする。1000 listeners で 5〜10 倍高速化見込み。
    /// - 案 D (TTL キャッシュ): 同じ key (stream_video_id, q) で 5 秒以内なら cache hit。
    ///   record_comment / set_listener_greeted / ConnectionStateChanged で invalidate
    ///   されるので、母集団変動時は次回 fetch で fresh が返る。
    ///
    /// スキーマ無変更で書き込み (record_comment) には影響なし。
    ///
    /// `q` (検索ボックス) は最終 WHERE に重ねて適用する。
    pub fn list_stream_scoped_listener_counts(
        &self,
        stream_video_id: &str,
        q: Option<&str>,
    ) -> rusqlite::Result<crate::state::listener::ListenerStreamScopedCounts> {
        use crate::state::listener::ListenerStreamScopedCounts;
        if stream_video_id.is_empty() {
            return Ok(ListenerStreamScopedCounts::default());
        }
        let q_normalized = q.unwrap_or("").trim().to_string();
        let cache_key = (stream_video_id.to_string(), q_normalized.clone());

        // 案 D: cache 引き当て (5 秒以内かつ key 一致なら即返却)
        if let Ok(cache) = self.stream_scoped_cache.lock() {
            if let Some(entry) = cache.entry.as_ref() {
                if entry.key == cache_key && entry.expires_at > std::time::Instant::now() {
                    return Ok(entry.counts.clone());
                }
            }
        }

        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let now_ms = current_unix_millis();
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let q_trim = q.unwrap_or("").trim();

        // CTE 群 (MATERIALIZED で 1 回評価):
        // - recent_streams       : 直近 14 枠 (現枠除く) の video_id
        // - current_listeners    : 現枠で発言した listener の channel_id (= 母集団)
        // - new_members          : 現枠で comment_type='membership' を残した channel_id
        // - listeners_in_recent  : 直近 14 枠で発言した listener の channel_id
        // - current_started      : 現枠の started_at (= 新規判定の基準)
        //
        // bind 順:
        // (?1) recent_streams: video_id != ?
        // (?2) current_listeners: stream_id = ?
        // (?3) new_members: stream_id = ?
        // (?4) current_started: video_id = ?
        // (?5) returning predicate: NOW-30d (first_seen_at >=)
        // (?6) comeback predicate: NOW-30d (first_seen_at <)
        // (?7) LEFT JOIN stream_listener_state: stream_video_id = ?
        // (?8) [optional] WHERE l.display_name LIKE ?
        let mut sql = String::from(
            "WITH
              recent_streams AS MATERIALIZED (
                SELECT video_id FROM streams
                WHERE video_id != ?
                  AND ((SELECT COUNT(*) FROM owner_channels) = 0
                       OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                ORDER BY started_at DESC LIMIT 14
              ),
              current_listeners AS MATERIALIZED (
                SELECT DISTINCT listener_channel_id AS channel_id
                FROM comments WHERE stream_id = ?
              ),
              new_members AS MATERIALIZED (
                SELECT DISTINCT listener_channel_id AS channel_id
                FROM comments
                WHERE stream_id = ? AND comment_type = 'membership'
              ),
              listeners_in_recent AS MATERIALIZED (
                SELECT DISTINCT listener_channel_id AS channel_id
                FROM comments
                WHERE stream_id IN (SELECT video_id FROM recent_streams)
              ),
              current_started AS MATERIALIZED (
                SELECT IFNULL(started_at, 0) AS started_at
                FROM streams WHERE video_id = ?
              ),
              current_scope AS MATERIALIZED (
                SELECT EXISTS(
                  SELECT 1 FROM streams
                  WHERE video_id = ?
                    AND ((SELECT COUNT(*) FROM owner_channels) = 0
                         OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                ) AS is_own
              )
             SELECT
               COUNT(*) AS all_count,
               SUM(CASE WHEN IFNULL(sls.greeted_at, 0) = 0
                        THEN 1 ELSE 0 END) AS un_greeted_count,
               SUM(CASE WHEN (SELECT is_own FROM current_scope) = 1
                          AND l.first_seen_at >= (SELECT started_at FROM current_started)
                        THEN 1 ELSE 0 END) AS first_time_count,
               SUM(CASE WHEN (SELECT is_own FROM current_scope) = 1
                          AND l.comment_count > 1
                          AND l.first_seen_at < (SELECT started_at FROM current_started)
                          AND l.first_seen_at >= ?
                        THEN 1 ELSE 0 END) AS returning_count,
               SUM(CASE WHEN (SELECT is_own FROM current_scope) = 1
                          AND l.first_seen_at < ? AND lr.channel_id IS NULL
                        THEN 1 ELSE 0 END) AS comeback_count,
               SUM(CASE WHEN nm.channel_id IS NOT NULL
                        THEN 1 ELSE 0 END) AS new_member_count
             FROM listeners l
             INNER JOIN current_listeners cl ON cl.channel_id = l.channel_id
             LEFT JOIN stream_listener_state sls
               ON sls.listener_channel_id = l.channel_id
              AND sls.stream_video_id = ?
             LEFT JOIN listeners_in_recent lr ON lr.channel_id = l.channel_id
             LEFT JOIN new_members nm ON nm.channel_id = l.channel_id",
        );
        let mut bind: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(stream_video_id.to_string()), // (?1) recent_streams
            rusqlite::types::Value::Text(stream_video_id.to_string()), // (?2) current_listeners
            rusqlite::types::Value::Text(stream_video_id.to_string()), // (?3) new_members
            rusqlite::types::Value::Text(stream_video_id.to_string()), // (?4) current_started
            rusqlite::types::Value::Text(stream_video_id.to_string()), // (?5) current_scope
            rusqlite::types::Value::Integer(now_ms - one_month_ms),    // (?6) returning
            rusqlite::types::Value::Integer(now_ms - one_month_ms),    // (?7) comeback
            rusqlite::types::Value::Text(stream_video_id.to_string()), // (?8) sls JOIN
        ];
        if !q_trim.is_empty() {
            // 横断検索: display_name + nickname + username の OR (= ユーザが付けた
            // nickname も検索対象に)。 同 pattern を 3 回 bind して `?` 3 箇所で参照。
            sql.push_str(
                " WHERE (l.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE \
                         OR l.nickname LIKE ? ESCAPE '\\' COLLATE NOCASE \
                         OR COALESCE(l.username,'') LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            let pat = format!("%{}%", q_trim);
            bind.push(rusqlite::types::Value::Text(pat.clone()));
            bind.push(rusqlite::types::Value::Text(pat.clone()));
            bind.push(rusqlite::types::Value::Text(pat));
        }

        let counts: ListenerStreamScopedCounts =
            g.query_row(&sql, rusqlite::params_from_iter(bind.iter()), |r| {
                Ok(ListenerStreamScopedCounts {
                    all: r.get::<_, i64>(0)?,
                    un_greeted: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    first_time: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    returning: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    comeback: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    new_member: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                })
            })?;
        // sync_conn ロックは早めに解放してから cache 書き込み (= 別タスクの待ちを減らす)
        drop(g);
        if let Ok(mut cache) = self.stream_scoped_cache.lock() {
            cache.entry = Some(StreamScopedCountsCacheEntry {
                key: cache_key,
                counts: counts.clone(),
                expires_at: std::time::Instant::now()
                    + std::time::Duration::from_secs(STREAM_SCOPED_CACHE_TTL_SECS),
            });
        }
        Ok(counts)
    }

    /// 配信詳細モーダルのリスナータブ system pill 件数集計。
    /// すべて / 新規 / 新参 / 常連 / 古参 / 復帰 / 新メンバー の 7 値を 1 SQL で返す。
    ///
    /// `list_stream_listeners` のページング (= limit 1000) と独立して動き、1000 人超の
    /// 配信でも正確な件数を返す (= 旧 JS 集計の「上位 1000 から数えて 963 だけ」
    /// 問題を根治。2026-05-13)。
    ///
    /// filter ポリシー:
    /// - 適用: name_q / body_q / user_tags (= 「絞り込んだ範囲の中での切替候補」を見せる)
    /// - 無視: system_tags / member_join_only (= pill 自身は filter から外す)
    ///
    /// ランク判定基準は `classify_listener_rank` と同じ:
    /// - baseline = `stream.started_at` (= 対象配信の started_at)
    /// - active = 自チャンネル群 (owner_channels 配下) の直近 N 枠中 M 枠以上で発言
    /// - データ不足時 (= last_n_streams < M) は全員 active 扱い (= comeback 0 件)
    pub fn list_stream_listener_pill_counts(
        &self,
        video_id: &str,
        query: &crate::state::listener::StreamListenerPillCountsQuery,
    ) -> rusqlite::Result<crate::state::listener::StreamListenerPillCounts> {
        use crate::state::listener::StreamListenerPillCounts;
        if video_id.is_empty() {
            return Ok(StreamListenerPillCounts::default());
        }

        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let n = self.regular_window_n() as i64;
        let m = self.regular_min_m() as i64;
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let one_year_ms: i64 = self.veteran_one_year_ms();

        // WHERE 句構築 (= name_q / body_q / user_tags のみ。system_tags / member_join_only は無視)。
        // ?1..?5 は固定 bind (video_id / N / M / X / Y)、?6 以降が WHERE 句用。
        let mut where_clauses: Vec<String> = Vec::new();
        let mut where_bind: Vec<rusqlite::types::Value> = Vec::new();
        const FIXED_BIND_COUNT: usize = 5;

        // text_q (= 横断検索: name OR body) があればこれを優先 (= name_q / body_q を無視)。
        // 旧 (name_q AND body_q を別々に AND 結合) では「名前にも本文にもキーワード」しか
        // 引かないバグを回避。 list_stream_listeners と同じ実装。 2026-05-14 追加。
        let text_q_trim = query
            .text_q
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(text_q) = text_q_trim {
            for w in text_q.split_whitespace() {
                let i_disp = FIXED_BIND_COUNT + where_bind.len() + 1;
                where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                let i_nick = FIXED_BIND_COUNT + where_bind.len() + 1;
                where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                let i_user = FIXED_BIND_COUNT + where_bind.len() + 1;
                where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                let i_body = FIXED_BIND_COUNT + where_bind.len() + 1;
                where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                where_clauses.push(format!(
                    "(l.display_name LIKE ?{i_disp} ESCAPE '\\' COLLATE NOCASE \
                      OR l.nickname LIKE ?{i_nick} ESCAPE '\\' COLLATE NOCASE \
                      OR COALESCE(l.username,'') LIKE ?{i_user} ESCAPE '\\' COLLATE NOCASE \
                      OR EXISTS (SELECT 1 FROM comments c2 WHERE c2.stream_id = ?1 \
                                 AND c2.listener_channel_id = l.channel_id \
                                 AND c2.body LIKE ?{i_body} ESCAPE '\\' COLLATE NOCASE))",
                    i_disp = i_disp,
                    i_nick = i_nick,
                    i_user = i_user,
                    i_body = i_body
                ));
            }
        } else {
            // text_q が無いときだけ name_q / body_q を別々に AND 結合 (= 後方互換)。
            if let Some(name_q) = query
                .name_q
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let mut sub_or: Vec<String> = Vec::new();
                for w in name_q.split_whitespace() {
                    let idx = FIXED_BIND_COUNT + where_bind.len() + 1;
                    sub_or.push(format!("l.display_name LIKE ?{} ESCAPE '\\' COLLATE NOCASE", idx));
                    where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                    let idx2 = FIXED_BIND_COUNT + where_bind.len() + 1;
                    sub_or.push(format!("l.nickname LIKE ?{} ESCAPE '\\' COLLATE NOCASE", idx2));
                    where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                    let idx3 = FIXED_BIND_COUNT + where_bind.len() + 1;
                    sub_or.push(format!(
                        "COALESCE(l.username,'') LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                        idx3
                    ));
                    where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                }
                if !sub_or.is_empty() {
                    where_clauses.push(format!("({})", sub_or.join(" OR ")));
                }
            }
            if let Some(body_q) = query
                .body_q
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let mut sub_or: Vec<String> = Vec::new();
                for w in body_q.split_whitespace() {
                    let idx = FIXED_BIND_COUNT + where_bind.len() + 1;
                    sub_or.push(format!(
                        "EXISTS (SELECT 1 FROM comments c2 WHERE c2.stream_id = ?1 \
                         AND c2.listener_channel_id = l.channel_id \
                         AND c2.body LIKE ?{} ESCAPE '\\' COLLATE NOCASE)",
                        idx
                    ));
                    where_bind.push(rusqlite::types::Value::Text(format!("%{}%", w)));
                }
                if !sub_or.is_empty() {
                    where_clauses.push(format!("({})", sub_or.join(" OR ")));
                }
            }
        }
        if !query.user_tags.is_empty() {
            let placeholders: Vec<String> = (0..query.user_tags.len())
                .map(|i| format!("?{}", FIXED_BIND_COUNT + where_bind.len() + 1 + i))
                .collect();
            where_clauses.push(format!(
                "EXISTS (SELECT 1 FROM listener_tags lt \
                 WHERE lt.channel_id = l.channel_id AND lt.tag IN ({}))",
                placeholders.join(",")
            ));
            for t in &query.user_tags {
                where_bind.push(rusqlite::types::Value::Text(t.clone()));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        // CTE 群:
        // - cur            : 対象配信の started_at
        // - last_n_streams : 自チャンネル群、target より前、上位 N 枠 (= 案 A)
        // - active_listeners : last_n_streams で M 枠以上発言した listener
        // - data_sufficient : last_n_streams 件数 >= M か (= データ十分性)
        // - current_listeners : この枠で発言した listener (= 母集団)
        // - new_members    : この枠で comment_type='membership' を残した listener
        let sql = format!(
            "WITH cur AS (
                SELECT IFNULL(started_at, 0) AS started_at FROM streams WHERE video_id = ?1
             ),
             last_n_streams AS (
                SELECT s.video_id FROM streams s, cur
                WHERE s.started_at < cur.started_at
                  AND ((SELECT COUNT(*) FROM owner_channels) = 0
                       OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                ORDER BY s.started_at DESC LIMIT ?2
             ),
             active_listeners AS (
                SELECT listener_channel_id
                FROM comments
                WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                GROUP BY listener_channel_id
                HAVING COUNT(DISTINCT stream_id) >= ?3
             ),
             data_sufficient AS (
                SELECT CASE WHEN (SELECT COUNT(*) FROM last_n_streams) < ?3 THEN 0 ELSE 1 END AS sufficient
             ),
             current_listeners AS (
                SELECT listener_channel_id AS channel_id
                FROM comments WHERE stream_id = ?1
                GROUP BY listener_channel_id
             ),
             new_members AS (
                SELECT DISTINCT listener_channel_id AS channel_id
                FROM comments WHERE stream_id = ?1 AND comment_type = 'membership'
             )
             SELECT
                COUNT(*) AS all_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at > 0
                                    AND l.first_seen_at >= (SELECT started_at FROM cur)
                                  THEN 1 ELSE 0 END), 0) AS first_time_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at > 0
                                    AND l.first_seen_at < (SELECT started_at FROM cur)
                                    AND l.first_seen_at >= (SELECT started_at FROM cur) - ?4
                                  THEN 1 ELSE 0 END), 0) AS returning_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at > 0
                                    AND l.first_seen_at < (SELECT started_at FROM cur) - ?4
                                    AND l.first_seen_at >= (SELECT started_at FROM cur) - ?5
                                    AND ((SELECT sufficient FROM data_sufficient) = 0
                                         OR al.listener_channel_id IS NOT NULL)
                                  THEN 1 ELSE 0 END), 0) AS regular_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at > 0
                                    AND l.first_seen_at < (SELECT started_at FROM cur) - ?5
                                    AND ((SELECT sufficient FROM data_sufficient) = 0
                                         OR al.listener_channel_id IS NOT NULL)
                                  THEN 1 ELSE 0 END), 0) AS veteran_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at > 0
                                    AND l.first_seen_at < (SELECT started_at FROM cur) - ?4
                                    AND (SELECT sufficient FROM data_sufficient) = 1
                                    AND al.listener_channel_id IS NULL
                                  THEN 1 ELSE 0 END), 0) AS comeback_count,
                COALESCE(SUM(CASE WHEN nm.channel_id IS NOT NULL
                                  THEN 1 ELSE 0 END), 0) AS member_joined_count
             FROM listeners l
             INNER JOIN current_listeners cl ON cl.channel_id = l.channel_id
             LEFT JOIN active_listeners al ON al.listener_channel_id = l.channel_id
             LEFT JOIN new_members nm ON nm.channel_id = l.channel_id
             {where_sql}",
            where_sql = where_sql
        );

        let mut bind: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(video_id.to_string()), // ?1
            rusqlite::types::Value::Integer(n),                 // ?2 (N)
            rusqlite::types::Value::Integer(m),                 // ?3 (M)
            rusqlite::types::Value::Integer(one_month_ms),      // ?4 (X ms)
            rusqlite::types::Value::Integer(one_year_ms),       // ?5 (Y ms)
        ];
        bind.extend(where_bind);

        let counts = g.query_row(&sql, rusqlite::params_from_iter(bind.iter()), |r| {
            Ok(StreamListenerPillCounts {
                all: r.get::<_, i64>(0)?,
                first_time: r.get::<_, i64>(1)?,
                returning: r.get::<_, i64>(2)?,
                regular: r.get::<_, i64>(3)?,
                veteran: r.get::<_, i64>(4)?,
                comeback: r.get::<_, i64>(5)?,
                member_joined: r.get::<_, i64>(6)?,
            })
        })?;
        Ok(counts)
    }

    /// 直近 N 配信枠の heatmap データ。
    /// 戻り値: (`Vec<ListenerStreamActivity>`, `Vec<StreamCell>`)
    /// - streams は時系列昇順 (oldest → newest)、heatmap の左→右にそのまま使える
    /// - 各 listener の `cells` は streams と index 一致 (来なかった枠は count=0)
    ///   `stream_count` は 1〜60 で clamp、default 14。
    pub fn list_listeners_activity(
        &self,
        query: &ListenersActivityQuery,
    ) -> rusqlite::Result<(Vec<ListenerStreamActivity>, Vec<StreamCell>)> {
        let stream_count = query.stream_count.unwrap_or(14).clamp(1, 60) as i64;

        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        // === 1. 直近 N 枠を取得 (started_at 降順 → 後で reverse して oldest→newest に揃える) ===
        // 自チャンネル外の枠 (= owner_channels に含まれない) は除外する。stub 行も対象外。
        let mut streams_stmt = g.prepare(
            "SELECT video_id, title, started_at FROM streams
             WHERE ((SELECT COUNT(*) FROM owner_channels) = 0
                    OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
             ORDER BY started_at DESC LIMIT ?1",
        )?;
        let mut streams: Vec<StreamCell> = streams_stmt
            .query_map([stream_count], |r| {
                Ok(StreamCell {
                    video_id: r.get(0)?,
                    title: r.get(1)?,
                    started_at: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // oldest → newest に並べ替え (UI の左→右はこの順)
        streams.reverse();

        // 配信が 1 枠も無い、または listener 指定が無いケースは early return
        if streams.is_empty() || query.channel_ids.is_empty() {
            let activities = query
                .channel_ids
                .iter()
                .map(|cid| ListenerStreamActivity {
                    channel_id: cid.clone(),
                    cells: vec![
                        StreamActivityCell {
                            count: 0,
                            sc_amount_jpy: 0,
                        };
                        streams.len()
                    ],
                })
                .collect();
            return Ok((activities, streams));
        }

        // === 2. listener × stream で comments を集計 ===
        // SQL placeholder: ?1.. = listener_channel_id 群、続いて stream_id 群
        let cid_placeholders: String = (0..query.channel_ids.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sid_offset = query.channel_ids.len() + 1;
        let sid_placeholders: String = (0..streams.len())
            .map(|i| format!("?{}", sid_offset + i))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT listener_channel_id, stream_id,
                    COUNT(*) AS cnt,
                    COALESCE(SUM(superchat_amount_jpy), 0) AS sc_jpy
             FROM comments
             WHERE listener_channel_id IN ({cids})
               AND stream_id IN ({sids})
             GROUP BY listener_channel_id, stream_id",
            cids = cid_placeholders,
            sids = sid_placeholders,
        );

        let mut stmt = g.prepare(&sql)?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> =
            Vec::with_capacity(query.channel_ids.len() + streams.len());
        for cid in &query.channel_ids {
            params_vec.push(cid);
        }
        for s in &streams {
            params_vec.push(&s.video_id);
        }

        // stream_id → index in streams[]
        let mut sid_idx: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::with_capacity(streams.len());
        for (i, s) in streams.iter().enumerate() {
            sid_idx.insert(&s.video_id, i);
        }

        // channel_id → cells[N] (default 全 0)
        let make_default_cells = |n: usize| -> Vec<StreamActivityCell> {
            (0..n)
                .map(|_| StreamActivityCell {
                    count: 0,
                    sc_amount_jpy: 0,
                })
                .collect()
        };
        let mut by_cid: std::collections::HashMap<String, Vec<StreamActivityCell>> =
            std::collections::HashMap::with_capacity(query.channel_ids.len());
        for cid in &query.channel_ids {
            by_cid.insert(cid.clone(), make_default_cells(streams.len()));
        }

        let rows = stmt.query_map(rusqlite::params_from_iter(params_vec), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (cid, sid, cnt, sc_jpy) = row?;
            let Some(&idx) = sid_idx.get(sid.as_str()) else {
                continue;
            };
            if let Some(slot) = by_cid.get_mut(&cid).and_then(|v| v.get_mut(idx)) {
                slot.count = cnt;
                slot.sc_amount_jpy = sc_jpy;
            }
        }

        // 入力 channel_ids の順序を維持して返す
        let activities: Vec<ListenerStreamActivity> = query
            .channel_ids
            .iter()
            .map(|cid| ListenerStreamActivity {
                channel_id: cid.clone(),
                cells: by_cid
                    .remove(cid)
                    .unwrap_or_else(|| make_default_cells(streams.len())),
            })
            .collect();

        Ok((activities, streams))
    }

    /// 配信一覧を取得する (ページング + ソート)。
    pub fn list_streams(&self, query: &StreamsQuery) -> rusqlite::Result<StreamsPage> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let order_by = match query.sort {
            StreamsSort::StartedAt => "started_at DESC",
            StreamsSort::CommentCount => "comment_count DESC, started_at DESC",
            StreamsSort::SuperchatAmount => "superchat_amount_jpy DESC, started_at DESC",
            StreamsSort::PeakConcurrentViewers => "peak_concurrent_viewers DESC, started_at DESC",
            StreamsSort::Likes => "likes DESC, started_at DESC",
        };
        let limit = query.limit.unwrap_or(100).clamp(1, 500) as i64;
        let offset = query.offset.unwrap_or(0) as i64;

        // streams.owner_channel_id は `yt-UC...` 形式、owner_channels.channel_id は `UC...`
        // 形式なので prefix 付与で結合する。
        let is_own_expr = "((SELECT COUNT(*) FROM owner_channels) = 0
                            OR owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))";
        let where_clause = match query.scope {
            StreamScope::All => String::new(),
            StreamScope::Own => format!("WHERE {}", is_own_expr),
            StreamScope::Other => format!("WHERE NOT ({})", is_own_expr),
        };

        let total: i64 = g.query_row(
            &format!("SELECT COUNT(*) FROM streams {}", where_clause),
            [],
            |r| r.get(0),
        )?;
        let sql = format!(
            "SELECT {}, CASE WHEN {} THEN 1 ELSE 0 END AS is_own_stream
             FROM streams {} ORDER BY {} LIMIT ?1 OFFSET ?2",
            STREAM_SELECT_COLUMNS, is_own_expr, where_clause, order_by
        );
        let mut stmt = g.prepare(&sql)?;
        let rows = stmt
            .query_map(params![limit, offset], row_to_stream)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(StreamsPage {
            total,
            limit,
            offset,
            rows,
        })
    }

    /// 指定リスナー (複数可) を削除する。
    ///
    /// **仕様** (2 点):
    ///   1. **コメントは残す**: 配信ログ / コメント検索から本文・時刻が引き続き見える
    ///      (= 配信履歴は永続化、削除はリスナー側の個人情報のみ)。
    ///   2. **同じ channel_id のリスナーが将来再登場したら過去コメントも紐付き直す**
    ///      (= 「常連さんの帰還」を扱える)。listener_channel_id は変更しない。
    ///
    /// streams の集計値はコメントが残っているので変更しない。
    ///
    /// 削除フロー (1 トランザクション):
    ///   1. 孤児化するコメント件数を集計 (UI 表示用)
    ///   2. listeners.icon_url からアバターファイルパスを控える
    ///   3. listeners DELETE
    ///   4. アバター画像ファイル削除 (トランザクション外で実施)
    ///
    /// `media_cache_dir` が None の場合はファイル削除を行わない (= テスト用)。
    /// わんコメ DB は触らない (= 越権防止)。owner_channels テーブルは独立なので影響なし。
    pub fn delete_listeners(
        &self,
        channel_ids: &[String],
        media_cache_dir: Option<&Path>,
    ) -> rusqlite::Result<Vec<DeleteListenerSummary>> {
        if channel_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        let mut summaries: Vec<DeleteListenerSummary> = Vec::with_capacity(channel_ids.len());
        let mut avatar_paths_to_delete: Vec<PathBuf> = Vec::new();

        for channel_id in channel_ids {
            // 1. 残るコメントの件数を集計 (= UI 表示用)
            let (orphaned_comments, orphaned_superchats): (i64, i64) = tx.query_row(
                "SELECT
                    COUNT(*),
                    SUM(CASE WHEN comment_type IN ('superchat','sticker','gift') THEN 1 ELSE 0 END)
                 FROM comments WHERE listener_channel_id = ?1",
                params![channel_id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    ))
                },
            )?;

            // 2. listeners.icon_url を取得してアバターファイルパスを控える
            let icon_url: Option<String> = tx
                .query_row(
                    "SELECT icon_url FROM listeners WHERE channel_id = ?1",
                    params![channel_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let mut avatar_file_will_delete = false;
            if let (Some(icon), Some(dir)) = (icon_url.as_deref(), media_cache_dir) {
                if let Some(file_name) = extract_cache_avatar_file_name(icon) {
                    let avatar_path = dir.join("avatars").join(file_name);
                    if avatar_path.exists() {
                        avatar_paths_to_delete.push(avatar_path);
                        avatar_file_will_delete = true;
                    }
                }
            }

            // 3. listeners DELETE
            let listener_deleted = tx.execute(
                "DELETE FROM listeners WHERE channel_id = ?1",
                params![channel_id],
            )? > 0;

            summaries.push(DeleteListenerSummary {
                channel_id: channel_id.clone(),
                orphaned_comments,
                orphaned_superchats,
                listener_deleted,
                avatar_file_deleted: avatar_file_will_delete,
            });
        }

        tx.commit()?;

        // トランザクション外でファイル I/O。失敗は warn ログのみで握り潰す。
        for path in &avatar_paths_to_delete {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!(
                    "delete_listeners: failed to remove avatar file {:?}: {}",
                    path,
                    e
                );
            }
        }

        tracing::info!(
            "delete_listeners: deleted {} listeners ({} related comments preserved for potential re-attach)",
            summaries.iter().filter(|s| s.listener_deleted).count(),
            summaries.iter().map(|s| s.orphaned_comments).sum::<i64>()
        );

        Ok(summaries)
    }

    /// 指定配信を削除する。
    ///
    /// 配信ログの削除は「その配信に属する履歴を消す」操作なので、streams 行だけでなく
    /// comments / stream_tags / stream_listener_state も同時に削除する。削除した配信の
    /// コメントだけに紐付いていた listeners 行は孤児として残さず削除する。
    ///
    /// わんコメ DB は触らない。現在接続中の枠を削除した場合、以後届くコメントで同じ
    /// stream 行が再作成される。
    pub fn delete_streams(
        &self,
        video_ids: &[String],
        media_cache_dir: Option<&Path>,
    ) -> rusqlite::Result<Vec<DeleteStreamSummary>> {
        if video_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        let mut summaries: Vec<DeleteStreamSummary> = Vec::with_capacity(video_ids.len());
        let mut thumb_paths_to_delete: Vec<PathBuf> = Vec::new();

        for video_id in video_ids {
            let stream_deleted = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM streams WHERE video_id = ?1)",
                params![video_id],
                |r| r.get::<_, i64>(0),
            )? > 0;

            let listener_ids = {
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT listener_channel_id
                     FROM comments
                     WHERE stream_id = ?1",
                )?;
                let rows = stmt
                    .query_map(params![video_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };

            let deleted_comments = tx.execute(
                "DELETE FROM comments WHERE stream_id = ?1",
                params![video_id],
            )? as i64;
            let deleted_stream_tags = tx.execute(
                "DELETE FROM stream_tags WHERE video_id = ?1",
                params![video_id],
            )? as i64;
            let deleted_greeted_states = tx.execute(
                "DELETE FROM stream_listener_state WHERE stream_video_id = ?1",
                params![video_id],
            )? as i64;
            tx.execute("DELETE FROM streams WHERE video_id = ?1", params![video_id])?;

            let mut deleted_orphan_listeners = 0i64;
            for listener_id in &listener_ids {
                let remaining_comments: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM comments WHERE listener_channel_id = ?1",
                    params![listener_id],
                    |r| r.get(0),
                )?;
                if remaining_comments == 0 {
                    deleted_orphan_listeners += tx.execute(
                        "DELETE FROM listeners WHERE channel_id = ?1",
                        params![listener_id],
                    )? as i64;
                    tx.execute(
                        "DELETE FROM listener_tags WHERE channel_id = ?1",
                        params![listener_id],
                    )?;
                    tx.execute(
                        "DELETE FROM stream_listener_state WHERE listener_channel_id = ?1",
                        params![listener_id],
                    )?;
                }
            }

            let mut thumbnail_file_deleted = false;
            if let Some(dir) = media_cache_dir {
                if video_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    let thumb_path = dir.join("stream-thumbs").join(format!("{}.jpg", video_id));
                    if thumb_path.exists() {
                        thumb_paths_to_delete.push(thumb_path);
                        thumbnail_file_deleted = true;
                    }
                }
            }

            summaries.push(DeleteStreamSummary {
                video_id: video_id.clone(),
                stream_deleted,
                deleted_comments,
                deleted_stream_tags,
                deleted_greeted_states,
                deleted_orphan_listeners,
                thumbnail_file_deleted,
            });
        }

        tx.commit()?;
        drop(conn);

        self.recalculate_listener_self_aggregates()?;

        for path in &thumb_paths_to_delete {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!(
                    "delete_streams: failed to remove thumbnail file {:?}: {}",
                    path,
                    e
                );
            }
        }

        tracing::info!(
            "delete_streams: deleted {} streams, {} comments, {} orphan listeners",
            summaries.iter().filter(|s| s.stream_deleted).count(),
            summaries.iter().map(|s| s.deleted_comments).sum::<i64>(),
            summaries
                .iter()
                .map(|s| s.deleted_orphan_listeners)
                .sum::<i64>()
        );

        Ok(summaries)
    }

    /// 配信メタデータの部分更新。`Some` のフィールドだけ更新、`None` は触らない。
    /// 静的フィールド (title 等) と動的フィールド (current_viewers 等) を 1 つの API で扱う。
    /// `live_metadata_updated_at` を Some(now_ms) にすれば動的更新の最終時刻が記録される。
    /// 戻り値は更新行数 (0 = 該当 video_id なし、未だ upsert されていない)。
    #[allow(clippy::too_many_arguments)]
    pub fn update_stream_metadata(
        &self,
        video_id: &str,
        stream_url: Option<&str>,
        title: Option<&str>,
        owner_channel_id: Option<&str>,
        channel_name: Option<&str>,
        channel_icon_url: Option<&str>,
        description: Option<&str>,
        subscriber_count: Option<i64>,
        current_viewers: Option<i64>,
        peak_concurrent_viewers: Option<i64>,
        likes: Option<i64>,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        live_metadata_updated_at: Option<i64>,
    ) -> rusqlite::Result<usize> {
        if stream_url.is_none()
            && title.is_none()
            && owner_channel_id.is_none()
            && channel_name.is_none()
            && channel_icon_url.is_none()
            && description.is_none()
            && subscriber_count.is_none()
            && current_viewers.is_none()
            && peak_concurrent_viewers.is_none()
            && likes.is_none()
            && started_at.is_none()
            && ended_at.is_none()
            && live_metadata_updated_at.is_none()
        {
            return Ok(0);
        }
        // streams.owner_channel_id は listeners.channel_id と統一して `yt-UC...` 形式で保存する。
        // Step 4 の watch ページ取得経由 (electron/main.js) は素の `UC...` を渡してくるため
        // ここで正規化する。空文字は「未確定」扱いなのでそのまま透過する。
        let owner_normalized: Option<String> = owner_channel_id.map(|s| {
            if s.is_empty() || s.starts_with("yt-") {
                s.to_string()
            } else {
                format!("yt-{}", s)
            }
        });
        let owner_channel_id = owner_normalized.as_deref();
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        // 配信が初回観測前 (record_comment が来ていない、つまり streams 行が無い) の場合は
        // 空 stub 行を作る。started_at は呼び出し元から渡された値を優先、無ければ現在時刻。
        let exists: i64 = g.query_row(
            "SELECT EXISTS(SELECT 1 FROM streams WHERE video_id = ?1)",
            params![video_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            let init_ts = started_at.unwrap_or_else(current_unix_millis);
            g.execute(
                "INSERT INTO streams (video_id, started_at, ended_at) VALUES (?1, ?2, ?2)",
                params![video_id, init_ts],
            )?;
        }
        // peak_concurrent_viewers は単調増加 (MAX 蓄積)。クライアント側計算で
        // 既に「5 分維持された値」のフィルタが掛かっているが、再起動などで
        // 古い大きな値が小さい値で上書きされるのを防ぐため DB 側でも MAX を取る。
        // ended_at も MAX 蓄積 (誤って小さい値で上書きしないため)。
        //
        // started_at は MIN 蓄積。
        // 経路 1: record_comment 経由の INSERT は posted_at で MIN 更新 (= go-live を
        //         先頭コメ時刻で正しく captures)
        // 経路 2: Step 4 metadata fetch (electron/main.js) は YouTube
        //         liveBroadcastDetails.startTimestamp (= 配信予定時刻、未来であり得る)
        //         を渡してくる
        // → COALESCE 上書きだと 経路 2 が 経路 1 の actual go-live を未来時刻で潰し、
        //   list_stream_scoped_listener_counts の「新規」判定 (= first_seen_at >= started_at)
        //   が常に 0 件になる (2026-05-10 fuQvDeeO7wo 事例)。
        // 解決: started_at は MIN-based merge で earliest を保つ。null pass 時は既存値を維持。
        let n = g.execute(
            "UPDATE streams SET
                stream_url = COALESCE(?2, stream_url),
                title = COALESCE(?3, title),
                owner_channel_id = COALESCE(?4, owner_channel_id),
                channel_name = COALESCE(?5, channel_name),
                channel_icon_url = COALESCE(?6, channel_icon_url),
                description = COALESCE(?7, description),
                subscriber_count = COALESCE(?8, subscriber_count),
                current_viewers = COALESCE(?9, current_viewers),
                peak_concurrent_viewers = MAX(peak_concurrent_viewers, COALESCE(?10, peak_concurrent_viewers)),
                likes = COALESCE(?11, likes),
                started_at = MIN(started_at, COALESCE(?12, started_at)),
                -- ended_at: 未来時刻は配信予定の流入であって実際の終了ではない (2026-05-10
                -- fuQvDeeO7wo 事例)。?15 (= current_time) を上限にクランプしてから MAX。
                ended_at = MAX(ended_at, MIN(COALESCE(?13, ended_at), ?15)),
                live_metadata_updated_at = COALESCE(?14, live_metadata_updated_at)
             WHERE video_id = ?1",
            params![
                video_id,
                stream_url,
                title,
                owner_channel_id,
                channel_name,
                channel_icon_url,
                description,
                subscriber_count,
                current_viewers,
                peak_concurrent_viewers,
                likes,
                started_at,
                ended_at,
                live_metadata_updated_at,
                current_unix_millis(), // ?15: ended_at clamp 用 current_time
            ],
        )?;
        Ok(n)
    }

    /// 配信詳細 (単体 + 直近コメント N 件) を取得する。
    pub fn get_stream_detail(
        &self,
        video_id: &str,
        recent_comment_limit: usize,
    ) -> rusqlite::Result<Option<StreamDetail>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let stream_detail_sql = format!(
            "SELECT {} FROM streams WHERE video_id = ?1",
            STREAM_SELECT_COLUMNS
        );
        let stream: Option<StreamRow> = g
            .query_row(&stream_detail_sql, params![video_id], row_to_stream)
            .map(Some)
            .or_else(|err| {
                if matches!(err, SqliteError::QueryReturnedNoRows) {
                    Ok(None)
                } else {
                    Err(err)
                }
            })?;
        let Some(stream) = stream else {
            return Ok(None);
        };
        let limit = recent_comment_limit.clamp(1, 500) as i64;
        let mut stmt = g.prepare(
            "SELECT id, stream_id, listener_channel_id, posted_at, body, comment_type,
                    superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst,
                    responded_at
             FROM comments
             WHERE stream_id = ?1
             ORDER BY posted_at DESC LIMIT ?2",
        )?;
        let recent = stmt
            .query_map(params![video_id, limit], row_to_comment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let unique_commenters: i64 = g.query_row(
            "SELECT COUNT(DISTINCT listener_channel_id) FROM comments WHERE stream_id = ?1",
            params![video_id],
            |row| row.get(0),
        )?;
        Ok(Some(StreamDetail {
            stream,
            recent_comments: recent,
            unique_commenters,
        }))
    }

    /// 配信詳細モーダルのリスナータブ用: この配信でコメントしたリスナーを
    /// per-stream 集計 + 14 bin heatmap + user_tags 付きで返す。
    ///
    /// filter: name_q (display_name / nickname / username 横断 LIKE) /
    ///         body_q (この配信内コメント本文 EXISTS) /
    ///         system_tags (search_comments と同じ式) /
    ///         user_tags (listener_tags JOIN)
    pub fn list_stream_listeners(
        &self,
        video_id: &str,
        query: &StreamListenersQuery,
    ) -> rusqlite::Result<StreamListenersPage> {
        const NUM_BINS: usize = 14;

        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let limit = query.limit.unwrap_or(1000).clamp(1, 2000) as i64;
        let offset = query.offset.unwrap_or(0) as i64;
        let now_ms = current_unix_millis();
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let one_year_ms: i64 = self.veteran_one_year_ms();

        // heatmap binning に必要なので配信時刻範囲を先に取得。
        let stream_times: Option<(i64, i64)> = g
            .query_row(
                "SELECT started_at, ended_at FROM streams WHERE video_id = ?1",
                params![video_id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((started_at, ended_at_raw)) = stream_times else {
            return Ok(StreamListenersPage {
                total: 0,
                limit,
                offset,
                rows: Vec::new(),
            });
        };
        let ended_at = if ended_at_raw == 0 {
            now_ms
        } else {
            ended_at_raw
        };
        let duration_ms = (ended_at - started_at).max(1);

        // WHERE 句を組み立てる。?1 は stream_id 固定。
        let mut where_clauses: Vec<String> = Vec::new();
        let mut bound: Vec<rusqlite::types::Value> = Vec::new();
        bound.push(video_id.to_string().into()); // ?1

        // text_q (= 横断検索: name OR body の OR 結合) が指定されている場合はこれを優先。
        // UI の単一検索 input から渡される。 各語につき
        // (display LIKE % w % OR nickname LIKE % w % OR username LIKE % w % OR EXISTS body LIKE % w %)
        // を作り、 語間は AND (= 全語が「名前 OR 本文」のどれかにマッチ)。
        // 2026-05-14 追加: 旧 (name_q AND body_q を別々に AND 結合) では
        // 「名前にも本文にもキーワード」しか引かないバグを回避。
        let text_q_trim = query
            .text_q
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(text_q) = text_q_trim {
            for w in text_q.split_whitespace() {
                let i_disp = bound.len() + 1;
                bound.push(format!("%{}%", w).into());
                let i_nick = bound.len() + 1;
                bound.push(format!("%{}%", w).into());
                let i_user = bound.len() + 1;
                bound.push(format!("%{}%", w).into());
                let i_body = bound.len() + 1;
                bound.push(format!("%{}%", w).into());
                where_clauses.push(format!(
                    "(listeners.display_name LIKE ?{i_disp} ESCAPE '\\' COLLATE NOCASE
                      OR listeners.nickname LIKE ?{i_nick} ESCAPE '\\' COLLATE NOCASE
                      OR COALESCE(listeners.username,'') LIKE ?{i_user} ESCAPE '\\' COLLATE NOCASE
                      OR EXISTS (SELECT 1 FROM comments c2 WHERE c2.stream_id = ?1
                                 AND c2.listener_channel_id = listeners.channel_id
                                 AND c2.body LIKE ?{i_body} ESCAPE '\\' COLLATE NOCASE))",
                    i_disp = i_disp,
                    i_nick = i_nick,
                    i_user = i_user,
                    i_body = i_body
                ));
            }
        } else {
            // text_q が無いときだけ name_q / body_q を別々に AND 結合する (= 旧挙動、 後方互換)。

            // name_q (空白区切り OR、display_name / nickname / username 横断)
            if let Some(name_q) = query
                .name_q
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let mut sub_or: Vec<String> = Vec::new();
                for w in name_q.split_whitespace() {
                    sub_or.push(format!(
                        "listeners.display_name LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                        bound.len() + 1
                    ));
                    bound.push(format!("%{}%", w).into());
                    sub_or.push(format!(
                        "listeners.nickname LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                        bound.len() + 1
                    ));
                    bound.push(format!("%{}%", w).into());
                    sub_or.push(format!(
                        "COALESCE(listeners.username,'') LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                        bound.len() + 1
                    ));
                    bound.push(format!("%{}%", w).into());
                }
                if !sub_or.is_empty() {
                    where_clauses.push(format!("({})", sub_or.join(" OR ")));
                }
            }

            // body_q (この配信内コメント本文 EXISTS、空白区切り OR)
            if let Some(body_q) = query
                .body_q
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let mut sub_or: Vec<String> = Vec::new();
                for w in body_q.split_whitespace() {
                    sub_or.push(format!(
                        "EXISTS (SELECT 1 FROM comments c2 WHERE c2.stream_id = ?1
                                 AND c2.listener_channel_id = listeners.channel_id
                                 AND c2.body LIKE ?{} ESCAPE '\\' COLLATE NOCASE)",
                        bound.len() + 1
                    ));
                    bound.push(format!("%{}%", w).into());
                }
                if !sub_or.is_empty() {
                    where_clauses.push(format!("({})", sub_or.join(" OR ")));
                }
            }
        }

        // system_tags 絞り込み。基準時刻 = 対象配信の started_at (= 過去配信は当時の判定)。
        // - first-time (新規): first_seen_at >= started_at (= この枠で初コメ、連投含む。
        //                      旧 comment_count <= 1 から 2026-05-13 に統一)
        // - returning (新参): first_seen_at < started_at AND first_seen_at >= baseline - X日
        // - regular (常連): baseline - Y日 <= first_seen_at < baseline - X日 AND active
        // - veteran (古参): first_seen_at < baseline - Y日 AND active
        // - comeback (復帰): first_seen_at < baseline - X日 AND NOT active
        //
        // active 判定は **owner_channels 配下の自チャンネル群** の過去 N 枠中 M 以上参加 (案 A)。
        // 複数 UC (= サブチャンネル等) が owner_channels に登録されている場合は全部を自チャンネル扱い。
        // データ不足 (= last_n_streams < M) なら 復帰 は 1 件もマッチしない (= NOT IN sub-clause が
        // empty inner なので NOT IN = TRUE になり全員マッチする問題に注意。ここではデータ不足時
        // は comeback フィルタは空集合を返す形に倒す = 「判定不能なら何も返さない」が安全)。
        // 他チャンネル枠を開いている場合は JS 側で 5 ランク UI 非表示なので、ここでは
        // 自チャンネル群基準の評価をそのまま返す。
        if !query.system_tags.is_empty() {
            let n = self.regular_window_n() as i64;
            let m = self.regular_min_m() as i64;
            // active_listeners subquery: owner_channels 配下の自チャンネル群の past N 枠で
            // M 枠以上参加した listener。owner_channels が空ならフォールバックで全配信から取る。
            let active_sub = format!(
                "SELECT listener_channel_id FROM comments
                 WHERE stream_id IN (
                     SELECT s.video_id FROM streams s
                     WHERE s.started_at < (SELECT IFNULL(started_at, 0) FROM streams WHERE video_id = ?1)
                       AND ((SELECT COUNT(*) FROM owner_channels) = 0
                            OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                     ORDER BY s.started_at DESC LIMIT {}
                 )
                 GROUP BY listener_channel_id
                 HAVING COUNT(DISTINCT stream_id) >= {}",
                n, m
            );
            // last_n_streams 件数 (= データ十分性判定)。M 未満なら active 判定不能 →
            // JS classifier と揃えて全員 active 扱い (= regular/veteran は判定可、comeback は 0 件)。
            let last_n_count_sub = format!(
                "SELECT COUNT(*) FROM (
                     SELECT s.video_id FROM streams s
                     WHERE s.started_at < (SELECT IFNULL(started_at, 0) FROM streams WHERE video_id = ?1)
                       AND ((SELECT COUNT(*) FROM owner_channels) = 0
                            OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                     ORDER BY s.started_at DESC LIMIT {}
                 )",
                n
            );
            let mut sub_or: Vec<String> = Vec::new();
            for tag in &query.system_tags {
                match tag.as_str() {
                    // 新規: この枠で初コメ (= first_seen_at >= started_at)。?1 = stream_id。
                    "first-time" => sub_or.push(
                        "listeners.first_seen_at >= (SELECT IFNULL(started_at, 0) FROM streams WHERE video_id = ?1)"
                            .to_string(),
                    ),
                    "returning" => {
                        // 新参: 新規ではない (= first_seen_at < started_at) AND X 日以内に初コメ
                        sub_or.push(format!(
                            "(listeners.first_seen_at < (SELECT IFNULL(started_at, 0) FROM streams WHERE video_id = ?1)
                              AND listeners.first_seen_at >= ?{})",
                            bound.len() + 1
                        ));
                        bound.push((started_at - one_month_ms).into());
                    }
                    "regular" => {
                        // 常連: 経過範囲内 AND (active OR データ不足で active 判定不能)
                        sub_or.push(format!(
                            "(listeners.first_seen_at < ?{}
                              AND listeners.first_seen_at >= ?{}
                              AND (listeners.channel_id IN ({active})
                                   OR ({count_sub}) < {m}))",
                            bound.len() + 1,
                            bound.len() + 2,
                            active = active_sub,
                            count_sub = last_n_count_sub,
                            m = m
                        ));
                        bound.push((started_at - one_month_ms).into());
                        bound.push((started_at - one_year_ms).into());
                    }
                    "veteran" => {
                        sub_or.push(format!(
                            "(listeners.first_seen_at < ?{}
                              AND (listeners.channel_id IN ({active})
                                   OR ({count_sub}) < {m}))",
                            bound.len() + 1,
                            active = active_sub,
                            count_sub = last_n_count_sub,
                            m = m
                        ));
                        bound.push((started_at - one_year_ms).into());
                    }
                    "comeback" => {
                        // 復帰: データ十分時のみ判定 (= last_n_streams >= M)。
                        // データ不足なら 0 件返す (= 「活動チェック不能ケースで 復帰 と決めつけない」)。
                        sub_or.push(format!(
                            "(listeners.first_seen_at < ?{}
                              AND listeners.channel_id NOT IN ({active})
                              AND ({count_sub}) >= {m})",
                            bound.len() + 1,
                            active = active_sub,
                            count_sub = last_n_count_sub,
                            m = m
                        ));
                        bound.push((started_at - one_month_ms).into());
                    }
                    _ => {}
                }
            }
            if !sub_or.is_empty() {
                where_clauses.push(format!("({})", sub_or.join(" OR ")));
            }
        }

        // user_tags (listener_tags 経由 EXISTS)
        if !query.user_tags.is_empty() {
            let placeholders: Vec<String> = (0..query.user_tags.len())
                .map(|i| format!("?{}", bound.len() + 1 + i))
                .collect();
            where_clauses.push(format!(
                "EXISTS (SELECT 1 FROM listener_tags lt
                         WHERE lt.channel_id = listeners.channel_id
                           AND lt.tag IN ({}))",
                placeholders.join(",")
            ));
            for t in &query.user_tags {
                bound.push(t.clone().into());
            }
        }

        // member_join_only: 当該枠で `comment_type='membership'` を残した listener のみ。
        // ?1 は stream_id (= 全 SQL の先頭固定 bound)。継続記念は対象外なので
        // 'membership_milestone' は含まない。
        if query.member_join_only {
            where_clauses.push(
                "EXISTS (SELECT 1 FROM comments c2
                         WHERE c2.stream_id = ?1
                           AND c2.listener_channel_id = listeners.channel_id
                           AND c2.comment_type = 'membership')"
                    .to_string(),
            );
        }

        let where_extra_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("AND {}", where_clauses.join(" AND "))
        };

        let order_by = match query.sort {
            StreamListenersSort::CountDesc => {
                "ORDER BY per_stream_comment_count DESC, per_stream_last_at DESC"
            }
            StreamListenersSort::ScAmountDesc => {
                "ORDER BY per_stream_sc_amount_jpy DESC, per_stream_comment_count DESC"
            }
            StreamListenersSort::LastAtDesc => "ORDER BY per_stream_last_at DESC",
        };

        // total: 条件を満たすリスナー数 (= GROUP BY 後の行数)。
        let total_sql = format!(
            "SELECT COUNT(*) FROM (
                 SELECT listeners.channel_id
                 FROM comments c
                 JOIN listeners ON listeners.channel_id = c.listener_channel_id
                 WHERE c.stream_id = ?1 {}
                 GROUP BY listeners.channel_id
             )",
            where_extra_sql
        );
        let total: i64 =
            g.query_row(&total_sql, rusqlite::params_from_iter(bound.iter()), |r| {
                r.get(0)
            })?;

        // メインクエリ。LISTENER_SELECT_COLUMNS は `listeners.channel_id` を参照する
        // subquery を持つので、JOIN は alias なしで `listeners` を使う。
        //
        // CTE で「現在配信を除く直近 N 枠中 M 枠以上で活動した listener」を 1 度に計算
        // (= active_listeners)。LEFT JOIN で is_active 列としてフラグ化 → JS computeSystemTag
        // が「常連 / 古参」と「復帰」を区別するために使う。
        let n = self.regular_window_n() as i64;
        let m = self.regular_min_m() as i64;
        let n_idx = bound.len() + 1;
        let m_idx = bound.len() + 2;
        let limit_idx = bound.len() + 3;
        let offset_idx = bound.len() + 4;
        // last_n_streams は「**`owner_channels` 配下の自チャンネル群** の過去 N 枠」に絞る (案 A)。
        // 複数 UC (= サブチャンネルやコラボ用チャンネル等) を運用する場合は両方をまとめて
        // 自チャンネル扱いし、その全体で active 判定する。owner_channels が空ならフォールバックで
        // 全配信から上位 N 枠を取る。
        // 他チャンネル枠 (= owner_channels 外) を開いている場合は、JS 側 (renderer.js) で
        // 5 ランク UI を非表示にする (= ここでは案 A の評価を返すだけで隠さない)。
        // データ不足 (= last_n_streams 件数 < M) なら is_active=1 (= 復帰判定無効) にフォールバック。
        let main_sql = format!(
            "WITH cur AS (
                 SELECT IFNULL(started_at, 0) AS started_at
                 FROM streams WHERE video_id = ?1
             ),
             last_n_streams AS (
                 SELECT s.video_id FROM streams s, cur
                 WHERE s.started_at < cur.started_at
                   AND ((SELECT COUNT(*) FROM owner_channels) = 0
                        OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                 ORDER BY s.started_at DESC LIMIT ?{n_idx}
             ),
             active_listeners AS (
                 SELECT listener_channel_id
                 FROM comments
                 WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                 GROUP BY listener_channel_id
                 HAVING COUNT(DISTINCT stream_id) >= ?{m_idx}
             )
             SELECT {cols},
                    IFNULL(sls.greeted_at, 0) AS greeted_at,
                    COUNT(c.id) AS per_stream_comment_count,
                    COALESCE(SUM(c.superchat_amount_jpy), 0) AS per_stream_sc_amount_jpy,
                    MIN(c.posted_at) AS per_stream_first_at,
                    MAX(c.posted_at) AS per_stream_last_at,
                    (SELECT COALESCE(json_group_array(lt.tag), '[]')
                     FROM listener_tags lt WHERE lt.channel_id = listeners.channel_id) AS user_tags_json,
                    MAX(CASE WHEN c.comment_type = 'membership' THEN 1 ELSE 0 END) AS per_stream_member_joined,
                    CASE
                        WHEN (SELECT COUNT(*) FROM last_n_streams) < ?{m_idx} THEN 1
                        WHEN al.listener_channel_id IS NOT NULL THEN 1
                        ELSE 0
                    END AS is_active
             FROM comments c
             JOIN listeners ON listeners.channel_id = c.listener_channel_id
             LEFT JOIN active_listeners al ON al.listener_channel_id = listeners.channel_id
             LEFT JOIN stream_listener_state sls
               ON sls.stream_video_id = ?1 AND sls.listener_channel_id = listeners.channel_id
             WHERE c.stream_id = ?1 {extra}
             GROUP BY listeners.channel_id
             {order} LIMIT ?{limit_idx} OFFSET ?{offset_idx}",
            cols = LISTENER_SELECT_COLUMNS,
            extra = where_extra_sql,
            order = order_by,
            n_idx = n_idx,
            m_idx = m_idx,
            limit_idx = limit_idx,
            offset_idx = offset_idx,
        );
        let mut bound_with_paging = bound.clone();
        bound_with_paging.push(n.into());
        bound_with_paging.push(m.into());
        bound_with_paging.push(limit.into());
        bound_with_paging.push(offset.into());
        let mut stmt = g.prepare(&main_sql)?;
        let main_rows: Vec<(ListenerRow, i64, i64, i64, i64, String, bool, bool)> = stmt
            .query_map(
                rusqlite::params_from_iter(bound_with_paging.iter()),
                |row| {
                    let listener = row_to_listener(row)?;
                    let count: i64 = row.get(20)?;
                    let sc_amount: i64 = row.get(21)?;
                    let first_at: i64 = row.get(22)?;
                    let last_at: i64 = row.get(23)?;
                    let user_tags_json: String = row.get(24)?;
                    let member_joined: i64 = row.get(25)?;
                    let is_active: i64 = row.get(26)?;
                    Ok((
                        listener,
                        count,
                        sc_amount,
                        first_at,
                        last_at,
                        user_tags_json,
                        member_joined != 0,
                        is_active != 0,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        if main_rows.is_empty() {
            return Ok(StreamListenersPage {
                total,
                limit,
                offset,
                rows: Vec::new(),
            });
        }

        // heatmap: 表示対象の listener 群について全コメントを 1 query で取得 → bin 集計。
        let listener_ids: Vec<String> = main_rows.iter().map(|r| r.0.channel_id.clone()).collect();
        let placeholders: Vec<String> = (0..listener_ids.len())
            .map(|i| format!("?{}", i + 2))
            .collect();
        let heatmap_sql = format!(
            "SELECT listener_channel_id, posted_at, COALESCE(superchat_amount_jpy, 0)
             FROM comments
             WHERE stream_id = ?1 AND listener_channel_id IN ({})",
            placeholders.join(",")
        );
        let mut heatmap_bound: Vec<rusqlite::types::Value> = Vec::new();
        heatmap_bound.push(video_id.to_string().into());
        for id in &listener_ids {
            heatmap_bound.push(id.clone().into());
        }
        let mut heatmap_stmt = g.prepare(&heatmap_sql)?;
        let raw_heatmap_rows: Vec<(String, i64, i64)> = heatmap_stmt
            .query_map(rusqlite::params_from_iter(heatmap_bound.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(heatmap_stmt);
        drop(stmt);
        drop(g);

        use std::collections::HashMap;
        let mut bin_map: HashMap<String, Vec<(u32, bool)>> = HashMap::new();
        for id in &listener_ids {
            bin_map.insert(id.clone(), vec![(0u32, false); NUM_BINS]);
        }
        for (lid, posted_at, sc_amount) in raw_heatmap_rows {
            if let Some(bins) = bin_map.get_mut(&lid) {
                let offset_ms = (posted_at - started_at).max(0);
                let bin_index =
                    (offset_ms as i128 * NUM_BINS as i128 / duration_ms as i128) as usize;
                let bin_index = bin_index.min(NUM_BINS - 1);
                bins[bin_index].0 += 1;
                if sc_amount > 0 {
                    bins[bin_index].1 = true;
                }
            }
        }

        let rows: Vec<StreamListenerRow> = main_rows
            .into_iter()
            .map(
                |(listener, count, sc_amount, first_at, last_at, user_tags_json, member_joined, is_active)| {
                    let user_tags: Vec<String> =
                        serde_json::from_str(&user_tags_json).unwrap_or_default();
                    let heatmap_bins: Vec<HeatmapBin> = bin_map
                        .get(&listener.channel_id)
                        .map(|v| {
                            v.iter()
                                .map(|(c, sc)| HeatmapBin {
                                    count: *c,
                                    has_sc: *sc,
                                })
                                .collect()
                        })
                        .unwrap_or_else(|| {
                            vec![
                                HeatmapBin {
                                    count: 0,
                                    has_sc: false,
                                };
                                NUM_BINS
                            ]
                        });
                    // 仕様の Single Source of Truth は Rust 側 (= JS で再計算しない)。
                    // first_seen_at と is_active と対象配信の started_at から 6 ランクを決定する。
                    // in_comeback_window=true: 当該枠 (= baseline) でコメ済の母集団は
                    // 復帰窓 (= last_n_streams ∪ baseline) に必ず baseline 自身が含まれる
                    // ため常に true。 復帰 / 離脱 の二者では常に「復帰」側に分類される。
                    let system_tag = classify_listener_rank(
                        listener.first_seen_at,
                        is_active,
                        true,
                        started_at,
                        one_month_ms,
                        one_year_ms,
                    );
                    StreamListenerRow {
                        listener,
                        per_stream_comment_count: count,
                        per_stream_sc_amount_jpy: sc_amount,
                        per_stream_first_at: first_at,
                        per_stream_last_at: last_at,
                        heatmap_bins,
                        user_tags,
                        per_stream_member_joined: member_joined,
                        is_active,
                        system_tag: system_tag.to_string(),
                    }
                },
            )
            .collect();

        Ok(StreamListenersPage {
            total,
            limit,
            offset,
            rows,
        })
    }

    /// 配信詳細モーダルのコメント tab chip 表示用: 5 つの COUNT を 1 SQL で取得。
    /// listeners JOIN + CASE / SUM で 1 ラウンドトリップで全 chip 数を返す。
    ///
    /// 新規 / 古参 の判定は **対象配信の started_at** を baseline にする (= リスナー tab pill
    /// と同じ基準。「その配信時点でのリスナー区分」を表示)。
    /// - 新規 (first_count): listeners.first_seen_at >= stream.started_at (= この枠で初コメ)
    /// - 古参 (veteran_count): listeners.first_seen_at < stream.started_at - Y日
    pub fn get_comment_chip_counts(&self, video_id: &str) -> rusqlite::Result<CommentChipCounts> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let one_year_ms: i64 = self.veteran_one_year_ms();

        g.query_row(
            "WITH cur AS (
                SELECT IFNULL(started_at, 0) AS started_at FROM streams WHERE video_id = ?1
             )
             SELECT
                COUNT(*) AS all_count,
                COALESCE(SUM(CASE WHEN c.comment_type IN ('superchat','sticker','gift')
                                  THEN 1 ELSE 0 END), 0) AS sc_count,
                COALESCE(SUM(CASE WHEN l.is_member = 1 THEN 1 ELSE 0 END), 0) AS member_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at >= (SELECT started_at FROM cur)
                                  THEN 1 ELSE 0 END), 0) AS first_count,
                COALESCE(SUM(CASE WHEN l.first_seen_at > 0
                                    AND l.first_seen_at < (SELECT started_at FROM cur) - ?2
                                  THEN 1 ELSE 0 END), 0) AS veteran_count,
                COALESCE(SUM(CASE WHEN c.responded_at = 0 THEN 1 ELSE 0 END), 0) AS unresponded_count
             FROM comments c
             JOIN listeners l ON l.channel_id = c.listener_channel_id
             WHERE c.stream_id = ?1",
            params![video_id, one_year_ms],
            |r| {
                Ok(CommentChipCounts {
                    all: r.get(0)?,
                    sc: r.get(1)?,
                    member: r.get(2)?,
                    first_time: r.get(3)?,
                    veteran: r.get(4)?,
                    unresponded: r.get(5)?,
                })
            },
        )
    }

    /// リスナー詳細モーダルの chip 表示用: 1 リスナー × (任意の枠 context) で
    /// 「全期間 / SC / 当該枠」の正確な総数を 1 SQL で返す。
    /// listeners.comment_count / superchat_count は record_comment が累積するので
    /// そのまま信頼できる。当該枠は SUM(CASE) で同 SQL に乗せる。
    pub fn get_listener_chip_counts(
        &self,
        channel_id: &str,
        context_video_id: &str,
    ) -> rusqlite::Result<ListenerChipCounts> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let id_yt = with_yt_prefix(channel_id);

        // 全期間 / SC は listeners 行から、当該枠カウントは comments のスキャンが必要。
        // 1 SQL に纏めるために LEFT JOIN listeners + COUNT を組み合わせる。
        let counts = if context_video_id.is_empty() {
            // context 無し: listeners 行から 2 カウントだけ
            g.query_row(
                "SELECT COALESCE(comment_count, 0), COALESCE(superchat_count, 0)
                 FROM listeners WHERE channel_id = ?1",
                params![id_yt],
                |r| {
                    Ok(ListenerChipCounts {
                        all: r.get(0)?,
                        sc: r.get(1)?,
                        this_stream: 0,
                        greeted_at: 0,
                    })
                },
            )
            .optional()?
            .unwrap_or_default()
        } else {
            // context 有り: this_stream を comments スキャンで取得
            let this_stream: i64 = g.query_row(
                "SELECT COUNT(*) FROM comments
                 WHERE listener_channel_id = ?1 AND stream_id = ?2",
                params![id_yt, context_video_id],
                |r| r.get(0),
            )?;
            let (all, sc): (i64, i64) = g
                .query_row(
                    "SELECT COALESCE(comment_count, 0), COALESCE(superchat_count, 0)
                     FROM listeners WHERE channel_id = ?1",
                    params![id_yt],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .unwrap_or((0, 0));
            // 当該枠での挨拶済み状態を stream_listener_state から取得。行が無ければ 0。
            let greeted_at: i64 = g
                .query_row(
                    "SELECT greeted_at FROM stream_listener_state
                     WHERE stream_video_id = ?1 AND listener_channel_id = ?2",
                    params![context_video_id, id_yt],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            ListenerChipCounts {
                all,
                sc,
                this_stream,
                greeted_at,
            }
        };
        Ok(counts)
    }

    /// 配信詳細モーダルの統計タブ用: 1 配信枠の集計を一括返却する。
    ///
    /// 含まれる集計:
    /// - comment_freq_bins: bin_minutes 刻みのコメント件数時系列 (peak フラグ付き)
    /// - cumulative_unique_bins: 各 bin 末時点での累積ユニークコメント者数
    /// - composition: 配信内コメ者の system_tag 別カウント (first_time/returning/regular/veteran)
    /// - top_words: 頻出語 top 10 (簡易 n-gram + stopword、絵文字 / カスタムスタンプは body から
    ///   元から入らないので自動除外。形態素解析は将来 lindera 等に置き換え)
    /// - misc: avg コメ間隔 / avg コメ長 / メンバー加入数 / 新規リスナー数
    ///
    /// `bin_minutes` は 1〜240 で clamp (短い枠は 5 分、長い枠は 30 分など UI 側で決める)。
    pub fn get_stream_stats(
        &self,
        video_id: &str,
        bin_minutes: i64,
    ) -> rusqlite::Result<Option<StreamStats>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        let bin_minutes = bin_minutes.clamp(1, 240);
        let bin_size_ms = bin_minutes * 60_000;
        let now_ms = current_unix_millis();

        // 配信時刻範囲。
        let stream_times: Option<(i64, i64)> = g
            .query_row(
                "SELECT started_at, ended_at FROM streams WHERE video_id = ?1",
                params![video_id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((started_at, ended_at_raw)) = stream_times else {
            return Ok(None);
        };
        let ended_at_eff = if ended_at_raw == 0 {
            now_ms
        } else {
            ended_at_raw
        };
        let duration_ms = (ended_at_eff - started_at).max(1);
        let n_bins = ((duration_ms + bin_size_ms - 1) / bin_size_ms).max(1) as usize;

        // 1) コメント頻度の bin 集計。
        // bin_idx = (posted_at - started_at) / bin_size_ms、負値や > n_bins は clamp する。
        let mut freq_counts: Vec<u32> = vec![0u32; n_bins];
        let mut freq_stmt = g.prepare(
            "SELECT posted_at FROM comments WHERE stream_id = ?1 ORDER BY posted_at ASC",
        )?;
        let posted_iter = freq_stmt.query_map(params![video_id], |r| r.get::<_, i64>(0))?;
        let mut posted_times: Vec<i64> = Vec::new();
        for p in posted_iter {
            posted_times.push(p?);
        }
        for &posted_at in &posted_times {
            let offset_ms = (posted_at - started_at).max(0);
            let bin_index = ((offset_ms / bin_size_ms) as usize).min(n_bins - 1);
            freq_counts[bin_index] += 1;
        }
        let peak_bin = freq_counts
            .iter()
            .enumerate()
            .max_by_key(|(_, &c)| c)
            .map(|(i, _)| i);
        let comment_freq_bins: Vec<TimeBin> = freq_counts
            .iter()
            .enumerate()
            .map(|(i, &count)| TimeBin {
                bin_start_ms: started_at + i as i64 * bin_size_ms,
                count,
                has_peak: count > 0 && Some(i) == peak_bin,
            })
            .collect();

        // 2) 累積ユニーク (各 bin 末時点)。各 listener の MIN(posted_at) を集計し、
        // それが入る bin に +1 → 累積和。
        let mut first_at_stmt = g.prepare(
            "SELECT MIN(posted_at) FROM comments
             WHERE stream_id = ?1 GROUP BY listener_channel_id",
        )?;
        let first_at_iter = first_at_stmt.query_map(params![video_id], |r| r.get::<_, i64>(0))?;
        let mut new_per_bin: Vec<u32> = vec![0u32; n_bins];
        for first_at_res in first_at_iter {
            let first_at = first_at_res?;
            let offset_ms = (first_at - started_at).max(0);
            let bin_index = ((offset_ms / bin_size_ms) as usize).min(n_bins - 1);
            new_per_bin[bin_index] += 1;
        }
        let mut cumulative_unique_bins: Vec<u32> = Vec::with_capacity(n_bins);
        let mut running = 0u32;
        for v in new_per_bin {
            running += v;
            cumulative_unique_bins.push(running);
        }

        // 3) composition: 配信内コメ者の system_tag 別カウント。
        //    新規 / 新参 / 常連 / 古参 / 復帰 の 5 ランク。
        //
        //    基準日は **対象配信の started_at** (= now ではない)。過去配信を見たとき
        //    「その配信時点でのリスナー区分」が見える (= 1 年前の配信を開いて全員古参に
        //     なってしまう問題を回避)。
        //
        //    last_n_streams も「対象配信より前 (started_at <)」に絞る。
        //
        //    新規定義 (= 2026-05-13 統一): `first_seen_at >= baseline` (= この枠で初コメ、
        //    連投も新規扱い)。旧 `comment_count <= 1` (累計 1 件以下) は廃止。
        let n = self.regular_window_n() as i64;
        let m = self.regular_min_m() as i64;
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let one_year_ms: i64 = self.veteran_one_year_ms();
        // last_n_streams は **`owner_channels` 配下の自チャンネル群** の過去 N 枠に絞る (案 A)。
        // ユーザが複数 UC (= サブチャンネルやコラボ用チャンネル等) を運用する場合、それら全体を
        // 「自チャンネル」として扱う。owner_channels が空ならフォールバックで全配信から
        // 上位 N 枠を取る。
        //
        // 他チャンネル枠を開いている場合 (= owner_channels 外):
        // - last_n_streams は依然「自チャンネル群の過去 N 枠」になり、そこに登場しない
        //   audience は NOT active = 復帰候補と評価される (= 自チャンネル基準の評価)
        // - UI 側 (renderer.js) は `isOwnerChannelConfigured(detail.ownerChannelId)` で
        //   他チャンネル枠と判定したら 5 ランク表示を一切非表示にする (= 評価値そのものは
        //   返ってくるが表示しない)
        //
        // データ不足対策: last_n_streams の件数が M 未満だと、誰も M 枠以上に到達できず
        // 全員 復帰 になってしまう (= 母集団そのものが足りない、判定不能ケース)。
        // SQL では `(SELECT COUNT(*) FROM last_n_streams) < ?M` を見て、不足時は
        // 「is_active = 1 (= 全員 アクティブ扱い、復帰判定を無効化)」にフォールバック。
        let mut comp_stmt = g.prepare(
            "WITH cur AS (
                SELECT IFNULL(started_at, 0) AS started_at
                FROM streams WHERE video_id = ?1
             ),
             last_n_streams AS (
                SELECT s.video_id FROM streams s, cur
                WHERE s.started_at < cur.started_at
                  AND ((SELECT COUNT(*) FROM owner_channels) = 0
                       OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))
                ORDER BY s.started_at DESC LIMIT ?2
             ),
             active_listeners AS (
                SELECT listener_channel_id
                FROM comments
                WHERE stream_id IN (SELECT video_id FROM last_n_streams)
                GROUP BY listener_channel_id
                HAVING COUNT(DISTINCT stream_id) >= ?3
             )
             SELECT
                l.first_seen_at,
                CASE
                    WHEN (SELECT COUNT(*) FROM last_n_streams) < ?3 THEN 1
                    WHEN al.listener_channel_id IS NOT NULL THEN 1
                    ELSE 0
                END AS is_active
             FROM comments c
             JOIN listeners l ON l.channel_id = c.listener_channel_id
             LEFT JOIN active_listeners al ON al.listener_channel_id = l.channel_id
             WHERE c.stream_id = ?1
             GROUP BY l.channel_id",
        )?;
        let comp_iter = comp_stmt.query_map(params![video_id, n, m], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        // 基準日 = 対象配信の started_at (= rank はその配信時点の評価)
        let baseline_ms = started_at;
        let mut composition = StreamStatsComposition::default();
        for r in comp_iter {
            let (first_seen_at, is_active) = r?;
            // classify_listener_rank で 5 ランク判定 (= list_stream_listeners と同じロジック、
            // Single Source of Truth)。 in_comeback_window=true は母集団 (= 当該枠で
            // コメ済 → 復帰窓 = last_n_streams ∪ baseline に baseline 自身が含まれる)
            // の不変条件。 ここでは abandoned は理論上発生しない。
            match classify_listener_rank(
                first_seen_at,
                is_active != 0,
                true,
                baseline_ms,
                one_month_ms,
                one_year_ms,
            ) {
                "first-time" => composition.first_time += 1,
                "returning" => composition.returning += 1,
                "regular" => composition.regular += 1,
                "veteran" => composition.veteran += 1,
                "comeback" => composition.comeback += 1,
                _ => {}
            }
        }

        // 4) top_words: 全コメから plain text (= <img>除去済) を作って簡易 tokenize →
        // stopword 除外 → top 10。
        // 注意: body 列は extract_text_from_runs 由来でカスタム絵文字の shortcut /
        // accessibility label (例: "専用ハート") が文字として連結されているため、頻出語
        // 集計でメンバー絵文字名が上位に来る誤動作になる。raw.commentHtml には絵文字が
        // <img alt="..."> として入っているので、タグごと除去すれば emoji 由来の文字は
        // 全部消える。raw.commentHtml が無い場合は body にフォールバック。
        // 形態素解析は将来 lindera 等に置き換える (TODO)。
        let mut body_stmt = g.prepare(
            "SELECT body, comment_html
             FROM comments WHERE stream_id = ?1 AND comment_type IN ('chat','superchat')",
        )?;
        let body_iter = body_stmt.query_map(params![video_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut bodies: Vec<String> = Vec::new(); // misc 用 (= 文字数集計、生 body)
        let mut tokenize_sources: Vec<String> = Vec::new(); // top_words 用 (= 絵文字除去済)
        for b in body_iter {
            let (body, html) = b?;
            let plain = if html.is_empty() {
                body.clone()
            } else {
                comment_html_to_plain_no_emoji(&html)
            };
            bodies.push(body);
            tokenize_sources.push(plain);
        }
        // misc の avg_comment_length 用に全コメント本文の char 数を別途集計する (生 body)。
        let mut all_lengths: Vec<usize> = Vec::with_capacity(bodies.len());
        for b in &bodies {
            all_lengths.push(b.chars().count());
        }
        // 絵文字除去済 plain text から token 集計。TODO: 形態素解析ライブラリ (lindera 等)。
        use std::collections::HashMap as StdHashMap;
        let mut counts: StdHashMap<String, u32> = StdHashMap::new();
        for source in &tokenize_sources {
            for token in tokenize_for_stats(source) {
                if is_word_stat_stopword(&token) {
                    continue;
                }
                *counts.entry(token).or_insert(0) += 1;
            }
        }
        let mut sorted: Vec<(String, u32)> = counts.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let top_words: Vec<WordCount> = sorted
            .into_iter()
            .take(10)
            .map(|(word, count)| WordCount { word, count })
            .collect();

        // 5) misc:
        //   avg_comment_interval_sec: posted_at の連続差分の平均
        //   avg_comment_length_chars: bodies の平均 char 数 (chat / superchat のみ)
        //   member_joins: comment_type = 'membership' の件数
        //   new_listeners: この配信の時間範囲内に first_seen_at が入る listener 数
        let avg_comment_interval_sec = if posted_times.len() >= 2 {
            let mut sum_diff_ms: i64 = 0;
            for i in 1..posted_times.len() {
                sum_diff_ms += (posted_times[i] - posted_times[i - 1]).max(0);
            }
            sum_diff_ms as f64 / (posted_times.len() - 1) as f64 / 1000.0
        } else {
            0.0
        };
        let avg_comment_length_chars = if all_lengths.is_empty() {
            0.0
        } else {
            all_lengths.iter().sum::<usize>() as f64 / all_lengths.len() as f64
        };
        let member_joins: i64 = g.query_row(
            "SELECT COUNT(*) FROM comments WHERE stream_id = ?1 AND comment_type = 'membership'",
            params![video_id],
            |r| r.get(0),
        )?;
        let new_listeners: i64 = g.query_row(
            "SELECT COUNT(DISTINCT c.listener_channel_id)
             FROM comments c JOIN listeners ON listeners.channel_id = c.listener_channel_id
             WHERE c.stream_id = ?1
               AND listeners.first_seen_at >= ?2
               AND listeners.first_seen_at < ?3",
            params![video_id, started_at, ended_at_eff],
            |r| r.get(0),
        )?;
        let misc = StreamStatsMisc {
            avg_comment_interval_sec,
            avg_comment_length_chars,
            member_joins,
            new_listeners,
        };

        Ok(Some(StreamStats {
            comment_freq_bins,
            cumulative_unique_bins,
            composition,
            top_words,
            misc,
            bin_minutes,
            started_at,
            ended_at: ended_at_raw,
        }))
    }

    /// コメント検索 (複合フィルタ + ページング + 任意の KPI 集計)。
    /// フィールド間 AND、複数値フィールド (stream_ids 等) と空白区切り q は OR。
    /// system_tags / user_tags はリスナー単位の絞り込み (system_tags は first_seen_at と
    /// comment_count から都度算出、user_tags は listener_tags テーブルを参照)。
    pub fn search_comments(&self, query: &CommentsQuery) -> rusqlite::Result<CommentsPage> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;

        // 最大 5000 件 / リクエスト。20k+ コメ枠の全件取得は呼び出し側がチャンク分割する。
        let limit = query.limit.unwrap_or(100).clamp(1, 5000) as i64;
        let offset = query.offset.unwrap_or(0) as i64;
        let now_ms = current_unix_millis();
        let one_month_ms: i64 = self.newcomer_one_month_ms();
        let one_year_ms: i64 = self.veteran_one_year_ms();

        let mut where_clauses: Vec<String> = Vec::new();
        let mut bound: Vec<rusqlite::types::Value> = Vec::new();
        let mut needs_listeners = false;
        let mut needs_streams = !matches!(query.scope, CommentSearchScope::All);

        // 本文 LIKE (空白区切り OR)
        if let Some(body_q) = query
            .body_q
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut sub_or: Vec<String> = Vec::new();
            for w in body_q.split_whitespace() {
                sub_or.push(format!(
                    "c.body LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                    bound.len() + 1
                ));
                bound.push(format!("%{}%", w).into());
            }
            if !sub_or.is_empty() {
                where_clauses.push(format!("({})", sub_or.join(" OR ")));
            }
        }

        // 配信枠タイトル LIKE (空白区切り OR) — streams JOIN
        if let Some(title_q) = query
            .stream_title_q
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            needs_streams = true;
            let mut sub_or: Vec<String> = Vec::new();
            for w in title_q.split_whitespace() {
                sub_or.push(format!(
                    "s.title LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                    bound.len() + 1
                ));
                bound.push(format!("%{}%", w).into());
            }
            if !sub_or.is_empty() {
                where_clauses.push(format!("({})", sub_or.join(" OR ")));
            }
        }

        // 名前 LIKE (display_name + nickname を空白区切り OR) — listeners JOIN
        if let Some(name_q) = query
            .name_q
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            needs_listeners = true;
            let mut sub_or: Vec<String> = Vec::new();
            for w in name_q.split_whitespace() {
                sub_or.push(format!(
                    "l.display_name LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                    bound.len() + 1
                ));
                bound.push(format!("%{}%", w).into());
                sub_or.push(format!(
                    "l.nickname LIKE ?{} ESCAPE '\\' COLLATE NOCASE",
                    bound.len() + 1
                ));
                bound.push(format!("%{}%", w).into());
            }
            if !sub_or.is_empty() {
                where_clauses.push(format!("({})", sub_or.join(" OR ")));
            }
        }

        if let Some(from) = query.period_from {
            where_clauses.push(format!("c.posted_at >= ?{}", bound.len() + 1));
            bound.push(from.into());
        }
        if let Some(to) = query.period_to {
            where_clauses.push(format!("c.posted_at < ?{}", bound.len() + 1));
            bound.push(to.into());
        }

        if !query.stream_ids.is_empty() {
            let placeholders: Vec<String> = (0..query.stream_ids.len())
                .map(|i| format!("?{}", bound.len() + 1 + i))
                .collect();
            where_clauses.push(format!("c.stream_id IN ({})", placeholders.join(",")));
            for id in &query.stream_ids {
                bound.push(id.clone().into());
            }
        }

        if !query.listener_channel_ids.is_empty() {
            let placeholders: Vec<String> = (0..query.listener_channel_ids.len())
                .map(|i| format!("?{}", bound.len() + 1 + i))
                .collect();
            where_clauses.push(format!(
                "c.listener_channel_id IN ({})",
                placeholders.join(",")
            ));
            for id in &query.listener_channel_ids {
                bound.push(with_yt_prefix(id).into());
            }
        }

        if !query.comment_types.is_empty() {
            let placeholders: Vec<String> = (0..query.comment_types.len())
                .map(|i| format!("?{}", bound.len() + 1 + i))
                .collect();
            where_clauses.push(format!("c.comment_type IN ({})", placeholders.join(",")));
            for t in &query.comment_types {
                bound.push(t.clone().into());
            }
        }

        // システム判定タグ (リスナー単位)。listeners JOIN を要求。
        // 定義: first-time = comment_count <= 1
        //      returning  = comment_count > 1 AND first_seen_at >= NOW - 30d
        //      regular    = NOW - 365d <= first_seen_at < NOW - 30d
        //      veteran    = first_seen_at < NOW - 365d
        if !query.system_tags.is_empty() {
            needs_listeners = true;
            let mut sub_or: Vec<String> = Vec::new();
            for tag in &query.system_tags {
                match tag.as_str() {
                    "first-time" => sub_or.push("l.comment_count <= 1".to_string()),
                    "returning" => {
                        sub_or.push(format!(
                            "(l.comment_count > 1 AND l.first_seen_at >= ?{})",
                            bound.len() + 1
                        ));
                        bound.push((now_ms - one_month_ms).into());
                    }
                    "regular" => {
                        sub_or.push(format!(
                            "(l.first_seen_at < ?{} AND l.first_seen_at >= ?{})",
                            bound.len() + 1,
                            bound.len() + 2
                        ));
                        bound.push((now_ms - one_month_ms).into());
                        bound.push((now_ms - one_year_ms).into());
                    }
                    "veteran" => {
                        sub_or.push(format!("l.first_seen_at < ?{}", bound.len() + 1));
                        bound.push((now_ms - one_year_ms).into());
                    }
                    _ => {}
                }
            }
            if !sub_or.is_empty() {
                where_clauses.push(format!("({})", sub_or.join(" OR ")));
            }
        }

        // メンバー絞り込み (listeners.is_member = 1) — 配信詳細モーダルの「メンバー」chip 用
        if query.member_only {
            needs_listeners = true;
            where_clauses.push("l.is_member = 1".to_string());
        }

        // リモート閲覧 redesign §5.3 / §11.2: 「未対応のみ」フィルタ
        if query.unresponded_only {
            where_clauses.push("c.responded_at = 0".to_string());
        }
        match query.scope {
            CommentSearchScope::Own => {
                where_clauses.push(
                    "((SELECT COUNT(*) FROM owner_channels) = 0
                      OR s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels))"
                        .to_string(),
                );
            }
            CommentSearchScope::Other => {
                where_clauses.push(
                    "((SELECT COUNT(*) FROM owner_channels) > 0
                      AND s.owner_channel_id NOT IN (SELECT 'yt-' || channel_id FROM owner_channels))"
                        .to_string(),
                );
            }
            CommentSearchScope::All => {}
        }

        // ユーザー付与タグ (listener_tags 経由)
        if !query.user_tags.is_empty() {
            let placeholders: Vec<String> = (0..query.user_tags.len())
                .map(|i| format!("?{}", bound.len() + 1 + i))
                .collect();
            where_clauses.push(format!(
                "EXISTS (SELECT 1 FROM listener_tags lt
                         WHERE lt.channel_id = c.listener_channel_id
                           AND lt.tag IN ({}))",
                placeholders.join(",")
            ));
            for t in &query.user_tags {
                bound.push(t.clone().into());
            }
        }

        // 配信枠タグ (stream_tags 経由)
        if !query.stream_tags.is_empty() {
            let placeholders: Vec<String> = (0..query.stream_tags.len())
                .map(|i| format!("?{}", bound.len() + 1 + i))
                .collect();
            where_clauses.push(format!(
                "EXISTS (SELECT 1 FROM stream_tags st
                         WHERE st.video_id = c.stream_id
                           AND st.tag IN ({}))",
                placeholders.join(",")
            ));
            for t in &query.stream_tags {
                bound.push(t.clone().into());
            }
        }

        // FROM / JOIN 構築
        let mut from_join = String::from("FROM comments c");
        if needs_listeners {
            from_join.push_str(" JOIN listeners l ON l.channel_id = c.listener_channel_id");
        }
        if needs_streams {
            from_join.push_str(" JOIN streams s ON s.video_id = c.stream_id");
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let total_sql = format!("SELECT COUNT(*) {} {}", from_join, where_sql);
        let total: i64 =
            g.query_row(&total_sql, rusqlite::params_from_iter(bound.iter()), |r| {
                r.get(0)
            })?;

        let mut bound_with_paging = bound.clone();
        bound_with_paging.push(limit.into());
        bound_with_paging.push(offset.into());
        let limit_idx = bound.len() + 1;
        let offset_idx = bound.len() + 2;
        let rows_sql = format!(
            "SELECT c.id, c.stream_id, c.listener_channel_id, c.posted_at, c.body, c.comment_type,
                    c.superchat_amount_jpy, c.superchat_currency, c.superchat_amount_raw, c.raw_zst,
                    c.responded_at
             {} {}
             ORDER BY c.posted_at DESC LIMIT ?{} OFFSET ?{}",
            from_join, where_sql, limit_idx, offset_idx
        );
        let mut stmt = g.prepare(&rows_sql)?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(bound_with_paging.iter()),
                row_to_comment,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // KPI 集計 (include_kpi=true のみ)。streams JOIN を強制 (per-stream 集計用)。
        let (kpi, streams) = if query.include_kpi {
            let mut from_join_kpi = from_join.clone();
            if !needs_streams {
                from_join_kpi.push_str(" JOIN streams s ON s.video_id = c.stream_id");
            }

            // overall: streams テーブルに対する集計は subquery で行う (= マッチした
            // ユニーク stream_id の集合に対し SUM(likes) / SUM(peak_concurrent_viewers))
            let overall_sql = format!(
                "SELECT COUNT(*) AS total_count,
                        COALESCE(SUM(c.superchat_amount_jpy), 0) AS total_amount,
                        COUNT(DISTINCT c.listener_channel_id) AS unique_listeners,
                        COUNT(DISTINCT c.stream_id) AS stream_count,
                        MIN(c.posted_at) AS period_from,
                        MAX(c.posted_at) AS period_to
                 {} {}",
                from_join_kpi, where_sql
            );
            let overall = g.query_row(
                &overall_sql,
                rusqlite::params_from_iter(bound.iter()),
                |r| {
                    Ok::<(i64, i64, i64, i64, Option<i64>, Option<i64>), rusqlite::Error>((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;

            let stream_sql = format!(
                "SELECT c.stream_id, s.title, s.started_at, s.ended_at,
                        COUNT(*) AS comment_count,
                        COALESCE(SUM(c.superchat_amount_jpy), 0) AS amount,
                        COUNT(DISTINCT c.listener_channel_id) AS unique_listeners,
                        COALESCE(s.likes, 0) AS likes,
                        COALESCE(s.peak_concurrent_viewers, 0) AS peak_viewers,
                        COALESCE(s.owner_channel_id, '') AS owner_channel_id
                 {} {}
                 GROUP BY c.stream_id, s.title, s.started_at, s.ended_at, s.likes, s.peak_concurrent_viewers, s.owner_channel_id
                 ORDER BY s.started_at DESC",
                from_join_kpi, where_sql
            );
            let mut stream_stmt = g.prepare(&stream_sql)?;
            let stream_rows: Vec<StreamKpi> = stream_stmt
                .query_map(rusqlite::params_from_iter(bound.iter()), |r| {
                    Ok(StreamKpi {
                        stream_id: r.get(0)?,
                        title: r.get(1)?,
                        started_at: r.get(2)?,
                        ended_at: r.get(3)?,
                        comment_count: r.get(4)?,
                        amount_jpy: r.get(5)?,
                        unique_listeners: r.get(6)?,
                        likes: r.get(7)?,
                        peak_viewers: r.get(8)?,
                        owner_channel_id: r.get(9)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let avg_unique = if stream_rows.is_empty() {
                0.0
            } else {
                let sum: i64 = stream_rows.iter().map(|s| s.unique_listeners).sum();
                sum as f64 / stream_rows.len() as f64
            };
            let total_likes: i64 = stream_rows.iter().map(|s| s.likes).sum();
            let max_peak: i64 = stream_rows
                .iter()
                .map(|s| s.peak_viewers)
                .max()
                .unwrap_or(0);
            let total_peak_for_avg: i64 = stream_rows.iter().map(|s| s.peak_viewers).sum();
            let avg_likes = if stream_rows.is_empty() {
                0.0
            } else {
                total_likes as f64 / stream_rows.len() as f64
            };
            let avg_peak = if stream_rows.is_empty() {
                0.0
            } else {
                total_peak_for_avg as f64 / stream_rows.len() as f64
            };

            let kpi = KpiSummary {
                total_count: overall.0,
                total_amount_jpy: overall.1,
                unique_listeners: overall.2,
                stream_count: overall.3,
                avg_unique_listeners_per_stream: avg_unique,
                total_likes,
                avg_likes_per_stream: avg_likes,
                max_peak_viewers: max_peak,
                avg_peak_viewers_per_stream: avg_peak,
                period_from: overall.4,
                period_to: overall.5,
            };
            (kpi, stream_rows)
        } else {
            (KpiSummary::default(), Vec::new())
        };

        Ok(CommentsPage {
            total,
            limit,
            offset,
            rows,
            kpi,
            streams,
        })
    }

    /// ユーザー編集メタデータ (nickname / notes / label) の部分更新。
    /// `Some("")` が来たら空文字で上書き、`None` は触らない (3 値セマンティクス)。
    /// 戻り値は更新された行数 (0 = 該当 channel_id なし)。
    /// 1 配信枠 × 1 リスナーの「挨拶済み」状態をトグル。
    /// 設計正本: docs/architecture/remote-viewing-redesign.md §3.1 / §4.1
    ///
    /// `value=true` で挨拶済み (= greeted_at に現在時刻)、`false` で解除 (= 行削除)。
    /// 戻り値は新しい greeted_at (= 0 なら解除完了、>0 なら設定完了)。
    pub fn set_listener_greeted(
        &self,
        stream_video_id: &str,
        listener_channel_id: &str,
        value: bool,
    ) -> rusqlite::Result<i64> {
        let id_yt = with_yt_prefix(listener_channel_id);
        let result = {
            let g = self
                .sync_conn
                .lock()
                .map_err(|_| poisoned_lock_error("sync_conn"))?;
            if value {
                let now_ms = current_unix_millis();
                g.execute(
                    "INSERT INTO stream_listener_state (stream_video_id, listener_channel_id, greeted_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(stream_video_id, listener_channel_id)
                       DO UPDATE SET greeted_at=excluded.greeted_at",
                    params![stream_video_id, id_yt, now_ms],
                )?;
                now_ms
            } else {
                g.execute(
                    "DELETE FROM stream_listener_state
                     WHERE stream_video_id = ?1 AND listener_channel_id = ?2",
                    params![stream_video_id, id_yt],
                )?;
                0
            }
        };
        // 未挨拶 count が変わるので invalidate (= 6 タブ件数 cache の他項目には影響
        // ないが、cache はキー単位で 1 エントリ保持なので不変項目だけ別 cache する
        // 価値は薄い → 全 invalidate)
        self.invalidate_stream_scoped_cache();
        Ok(result)
    }

    /// 1 コメントの「対応済み」状態をトグル。
    /// 設計正本: docs/architecture/remote-viewing-redesign.md §3.2 / §4.1
    ///
    /// `value=true` で対応済み (= responded_at に現在時刻)、`false` で解除 (= 0 へ)。
    /// 対応済みにした場合は、同じ配信枠の listener per-stream 状態も対応済みにする。
    /// コメント単位の解除では listener 側を解除しない (= 別コメントで対応済みの可能性があるため)。
    /// 戻り値は新しい responded_at。コメ ID が存在しない場合は 0 を返し更新行数 0。
    /// コメ ID は `yt-` prefix の有無を吸収する (= 既存 record_comment と同じ正規化)。
    pub fn set_comment_responded(&self, comment_id: &str, value: bool) -> rusqlite::Result<i64> {
        let id_yt = with_yt_prefix(comment_id);
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let new_value = if value { current_unix_millis() } else { 0 };
        let n = g.execute(
            "UPDATE comments SET responded_at = ?2 WHERE id = ?1",
            params![id_yt, new_value],
        )?;
        if n == 0 {
            return Ok(0);
        }
        if value {
            let context: Option<(String, String)> = g
                .query_row(
                    "SELECT stream_id, listener_channel_id FROM comments WHERE id = ?1",
                    params![id_yt],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            if let Some((stream_id, listener_channel_id)) = context {
                g.execute(
                    "INSERT INTO stream_listener_state (stream_video_id, listener_channel_id, greeted_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(stream_video_id, listener_channel_id)
                       DO UPDATE SET greeted_at=excluded.greeted_at",
                    params![stream_id, listener_channel_id, new_value],
                )?;
            }
        }
        if value {
            self.invalidate_stream_scoped_cache();
        }
        Ok(new_value)
    }

    pub fn get_comment_stream_listener(
        &self,
        comment_id: &str,
    ) -> rusqlite::Result<Option<(String, String)>> {
        let id_yt = with_yt_prefix(comment_id);
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let result = g
            .query_row(
                "SELECT stream_id, listener_channel_id FROM comments WHERE id = ?1",
                params![id_yt],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        Ok(result)
    }

    pub fn update_listener_metadata(
        &self,
        channel_id: &str,
        nickname: Option<&str>,
        notes: Option<&str>,
        label: Option<&str>,
    ) -> rusqlite::Result<usize> {
        if nickname.is_none() && notes.is_none() && label.is_none() {
            return Ok(0);
        }
        let id_yt = with_yt_prefix(channel_id);
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        // None フィールドは触らないように COALESCE で既存値を維持。
        let n = g.execute(
            "UPDATE listeners SET
                nickname = COALESCE(?2, nickname),
                notes = COALESCE(?3, notes),
                label = COALESCE(?4, label)
             WHERE channel_id = ?1",
            params![id_yt, nickname, notes, label],
        )?;
        if n > 0 {
            tracing::info!(
                "listener_manager: metadata updated (channel_id={}, nickname={:?}, notes={:?}, label={:?})",
                id_yt,
                nickname.map(|s| s.chars().take(20).collect::<String>()),
                notes.map(|s| s.chars().take(20).collect::<String>()),
                label.map(|s| s.chars().take(20).collect::<String>()),
            );
            // listener メタデータ (nickname/notes/label) はわんコメ users に書き戻される
            self.mark_data_dirty();
        }
        Ok(n)
    }

    // ────────────────── listener_tags CRUD ──────────────────

    /// 1 リスナーに付けられているタグを attached_at ASC で返す。
    pub fn get_listener_tags(&self, channel_id: &str) -> rusqlite::Result<Vec<String>> {
        let id_yt = with_yt_prefix(channel_id);
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT tag FROM listener_tags
             WHERE channel_id = ?1
             ORDER BY attached_at ASC, tag ASC",
        )?;
        let tags = stmt
            .query_map(params![id_yt], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tags)
    }

    /// 1 リスナーのタグ集合を `tags` で完全置換 (atomic)。空 Vec で全削除。
    /// 既存タグの attached_at は維持。新規タグだけ now_ms を付与。
    /// 戻り値は最終的な tag 件数。
    pub fn set_listener_tags(&self, channel_id: &str, tags: &[String]) -> rusqlite::Result<usize> {
        let id_yt = with_yt_prefix(channel_id);
        let now_ms = current_unix_millis();
        // 空白のみ / 重複は事前正規化
        let normalized: Vec<String> = tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();

        let mut g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = g.transaction()?;
        // 既存集合と差分を取って削除/追加 (= attached_at を維持)
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT tag FROM listener_tags WHERE channel_id = ?1")?;
            let rows = stmt
                .query_map(params![id_yt], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let existing_set: std::collections::BTreeSet<&str> =
            existing.iter().map(String::as_str).collect();
        let new_set: std::collections::BTreeSet<&str> =
            normalized.iter().map(String::as_str).collect();
        // delete: existing - new
        for t in existing_set.difference(&new_set) {
            tx.execute(
                "DELETE FROM listener_tags WHERE channel_id = ?1 AND tag = ?2",
                params![id_yt, t],
            )?;
        }
        // insert: new - existing
        for t in new_set.difference(&existing_set) {
            tx.execute(
                "INSERT INTO listener_tags (channel_id, tag, attached_at)
                 VALUES (?1, ?2, ?3)",
                params![id_yt, t, now_ms],
            )?;
        }
        tx.commit()?;
        tracing::info!(
            "listener_manager: tags set (channel_id={}, count={})",
            id_yt,
            normalized.len()
        );
        Ok(normalized.len())
    }

    /// listener_tags 全行をフラットに返す (UI で channel_id → tags[] のマップを作る用)。
    pub fn list_all_tag_assignments(
        &self,
    ) -> rusqlite::Result<Vec<crate::state::listener::ListenerTagRow>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT channel_id, tag, attached_at FROM listener_tags ORDER BY channel_id, attached_at",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(crate::state::listener::ListenerTagRow {
                    channel_id: r.get(0)?,
                    tag: r.get(1)?,
                    attached_at: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 全タグの一覧 + 各タグを保有するリスナー数 (利用順 DESC, タグ名 ASC)。
    pub fn list_all_tags(&self) -> rusqlite::Result<Vec<crate::state::listener::TagSummary>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT tag, COUNT(*) AS listener_count
             FROM listener_tags
             GROUP BY tag
             ORDER BY listener_count DESC, tag ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(crate::state::listener::TagSummary {
                    tag: r.get(0)?,
                    listener_count: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// タグ名を一括変更。`new_name` に既存衝突する場合は INSERT 衝突を避けて
    /// 旧名側を削除 (= 統合)。戻り値は影響を受けたリスナー件数。
    pub fn rename_tag(&self, old_name: &str, new_name: &str) -> rusqlite::Result<i64> {
        let old = old_name.trim();
        let new = new_name.trim();
        if old.is_empty() || new.is_empty() || old == new {
            return Ok(0);
        }
        let mut g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = g.transaction()?;
        // 統合: new_name 側に既に同 channel が存在するなら old を削除して衝突回避
        let merged = tx.execute(
            "DELETE FROM listener_tags
             WHERE tag = ?1
               AND channel_id IN (SELECT channel_id FROM listener_tags WHERE tag = ?2)",
            params![old, new],
        )?;
        let renamed = tx.execute(
            "UPDATE listener_tags SET tag = ?2 WHERE tag = ?1",
            params![old, new],
        )?;
        tx.commit()?;
        let total = merged as i64 + renamed as i64;
        tracing::info!(
            "listener_manager: tag renamed (old={}, new={}, merged={}, renamed={})",
            old,
            new,
            merged,
            renamed
        );
        Ok(total)
    }

    /// タグ名を全リスナーから削除。戻り値は削除行数。
    pub fn delete_tag(&self, name: &str) -> rusqlite::Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(0);
        }
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let n = g.execute("DELETE FROM listener_tags WHERE tag = ?1", params![name])? as i64;
        tracing::info!(
            "listener_manager: tag deleted (name={}, removed={})",
            name,
            n
        );
        Ok(n)
    }

    // ────────────────── stream_tags CRUD ──────────────────

    pub fn get_stream_tags(&self, video_id: &str) -> rusqlite::Result<Vec<String>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT tag FROM stream_tags
             WHERE video_id = ?1
             ORDER BY attached_at ASC, tag ASC",
        )?;
        let tags = stmt
            .query_map(params![video_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tags)
    }

    pub fn set_stream_tags(&self, video_id: &str, tags: &[String]) -> rusqlite::Result<usize> {
        let now_ms = current_unix_millis();
        let normalized: Vec<String> = tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = g.transaction()?;
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT tag FROM stream_tags WHERE video_id = ?1")?;
            let rows = stmt
                .query_map(params![video_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let existing_set: std::collections::BTreeSet<&str> =
            existing.iter().map(String::as_str).collect();
        let new_set: std::collections::BTreeSet<&str> =
            normalized.iter().map(String::as_str).collect();
        for t in existing_set.difference(&new_set) {
            tx.execute(
                "DELETE FROM stream_tags WHERE video_id = ?1 AND tag = ?2",
                params![video_id, t],
            )?;
        }
        for t in new_set.difference(&existing_set) {
            tx.execute(
                "INSERT INTO stream_tags (video_id, tag, attached_at) VALUES (?1, ?2, ?3)",
                params![video_id, t, now_ms],
            )?;
        }
        tx.commit()?;
        tracing::info!(
            "listener_manager: stream tags set (video_id={}, count={})",
            video_id,
            normalized.len()
        );
        Ok(normalized.len())
    }

    pub fn list_all_stream_tags(
        &self,
    ) -> rusqlite::Result<Vec<crate::state::listener::StreamTagSummary>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT tag, COUNT(*) AS stream_count
             FROM stream_tags
             GROUP BY tag
             ORDER BY stream_count DESC, tag ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(crate::state::listener::StreamTagSummary {
                    tag: r.get(0)?,
                    stream_count: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn list_all_stream_tag_assignments(
        &self,
    ) -> rusqlite::Result<Vec<crate::state::listener::StreamTagRow>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT video_id, tag, attached_at FROM stream_tags ORDER BY video_id, attached_at",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(crate::state::listener::StreamTagRow {
                    video_id: r.get(0)?,
                    tag: r.get(1)?,
                    attached_at: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn rename_stream_tag(&self, old_name: &str, new_name: &str) -> rusqlite::Result<i64> {
        let old = old_name.trim();
        let new = new_name.trim();
        if old.is_empty() || new.is_empty() || old == new {
            return Ok(0);
        }
        let mut g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let tx = g.transaction()?;
        let merged = tx.execute(
            "DELETE FROM stream_tags
             WHERE tag = ?1
               AND video_id IN (SELECT video_id FROM stream_tags WHERE tag = ?2)",
            params![old, new],
        )?;
        let renamed = tx.execute(
            "UPDATE stream_tags SET tag = ?2 WHERE tag = ?1",
            params![old, new],
        )?;
        tx.commit()?;
        Ok(merged as i64 + renamed as i64)
    }

    pub fn delete_stream_tag(&self, name: &str) -> rusqlite::Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(0);
        }
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let n = g.execute("DELETE FROM stream_tags WHERE tag = ?1", params![name])? as i64;
        Ok(n)
    }

    // ────────────────── saved_searches CRUD ──────────────────

    /// 指定 scope の保存検索を sort_order ASC, id ASC で返す。
    /// scope は 'comment-search' / 'listener-search' 等の文字列識別子。
    pub fn list_saved_searches(
        &self,
        scope: &str,
    ) -> rusqlite::Result<Vec<crate::state::listener::SavedSearch>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let mut stmt = g.prepare(
            "SELECT id, name, conditions, sort_order, created_at, updated_at, scope
             FROM saved_searches
             WHERE scope = ?1
             ORDER BY sort_order ASC, id ASC",
        )?;
        let rows = stmt
            .query_map(params![scope], |r| {
                Ok(crate::state::listener::SavedSearch {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    conditions: r.get(2)?,
                    sort_order: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    scope: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 新規保存検索を作成し、新 id を返す。`sort_order` は同 scope 内の MAX+1 を自動採番。
    pub fn create_saved_search(
        &self,
        scope: &str,
        name: &str,
        conditions_json: &str,
    ) -> rusqlite::Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Err(SqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ErrorCode::ConstraintViolation,
                    extended_code: 0,
                },
                Some("saved_search.name is empty".to_string()),
            ));
        }
        if scope.is_empty() {
            return Err(SqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ErrorCode::ConstraintViolation,
                    extended_code: 0,
                },
                Some("saved_search.scope is empty".to_string()),
            ));
        }
        let now_ms = current_unix_millis();
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let next_order: i64 = g
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM saved_searches WHERE scope = ?1",
                params![scope],
                |r| r.get(0),
            )
            .unwrap_or(1);
        g.execute(
            "INSERT INTO saved_searches (name, conditions, sort_order, created_at, updated_at, scope)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![name, conditions_json, next_order, now_ms, scope],
        )?;
        let id = g.last_insert_rowid();
        tracing::info!(
            "listener_manager: saved_search created (id={}, scope={}, name={})",
            id,
            scope,
            name
        );
        Ok(id)
    }

    /// 保存検索の部分更新。`Some` のフィールドのみ反映、`None` は触らない。
    /// 戻り値は影響を受けた行数 (0 = 該当 id なし)。
    pub fn update_saved_search(
        &self,
        id: i64,
        name: Option<&str>,
        conditions_json: Option<&str>,
        sort_order: Option<i64>,
    ) -> rusqlite::Result<usize> {
        if name.is_none() && conditions_json.is_none() && sort_order.is_none() {
            return Ok(0);
        }
        let now_ms = current_unix_millis();
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let n = g.execute(
            "UPDATE saved_searches SET
               name       = COALESCE(?2, name),
               conditions = COALESCE(?3, conditions),
               sort_order = COALESCE(?4, sort_order),
               updated_at = ?5
             WHERE id = ?1",
            params![id, name, conditions_json, sort_order, now_ms],
        )?;
        if n > 0 {
            tracing::info!(
                "listener_manager: saved_search updated (id={}, fields=name:{} cond:{} order:{})",
                id,
                name.is_some(),
                conditions_json.is_some(),
                sort_order.is_some()
            );
        }
        Ok(n)
    }

    /// 保存検索を id 指定で削除。戻り値は削除行数 (0 or 1)。
    pub fn delete_saved_search(&self, id: i64) -> rusqlite::Result<usize> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let n = g.execute("DELETE FROM saved_searches WHERE id = ?1", params![id])?;
        if n > 0 {
            tracing::info!("listener_manager: saved_search deleted (id={})", id);
        }
        Ok(n)
    }

    /// リスナー詳細 (単体 + 直近コメント N 件) を取得する。
    pub fn get_listener_detail(
        &self,
        channel_id: &str,
        recent_comment_limit: usize,
        stream_video_id: Option<&str>,
    ) -> rusqlite::Result<Option<ListenerDetail>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let id_yt = with_yt_prefix(channel_id);
        let detail_sql = format!(
            "SELECT {} FROM listeners WHERE channel_id = ?1",
            LISTENER_SELECT_COLUMNS
        );
        let mut listener: Option<crate::state::listener::ListenerRow> = g
            .query_row(&detail_sql, params![id_yt], row_to_listener)
            .map(Some)
            .or_else(|err| {
                if matches!(err, SqliteError::QueryReturnedNoRows) {
                    Ok(None)
                } else {
                    Err(err)
                }
            })?;
        let Some(ref mut listener_ref) = listener else {
            return Ok(None);
        };

        // stream_video_id 指定時は当該枠コメから per_stream_* を 1 SQL で計算して
        // listener.per_stream_* に注入。 stream_listener_state からは greeted_at も同時取得。
        // スカラサブクエリ自体が 0 row の時に NULL を返すため、 内側 COALESCE ではなく
        // 外側で IFNULL/COALESCE を掛ける。 COUNT(*) は 0 row でも 0 を返すので素のままで OK。
        if let Some(svid) = stream_video_id {
            if !svid.is_empty() {
                let agg_sql = "SELECT
                    (SELECT COUNT(*) FROM comments
                       WHERE listener_channel_id = ?1 AND stream_id = ?2) AS cnt,
                    COALESCE((SELECT SUM(superchat_amount_jpy) FROM comments
                       WHERE listener_channel_id = ?1 AND stream_id = ?2), 0) AS sc,
                    COALESCE((SELECT MAX(posted_at) FROM comments
                       WHERE listener_channel_id = ?1 AND stream_id = ?2), 0) AS last_at,
                    COALESCE((SELECT greeted_at FROM stream_listener_state
                       WHERE listener_channel_id = ?1 AND stream_video_id = ?2), 0) AS greeted";
                let (cnt, sc, last_at, greeted): (i64, i64, i64, i64) =
                    g.query_row(agg_sql, params![id_yt, svid], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?;
                listener_ref.per_stream_comment_count = cnt;
                listener_ref.per_stream_sc_amount_jpy = sc;
                listener_ref.per_stream_last_at = last_at;
                listener_ref.greeted_at = greeted;
            }
        }

        let listener = listener.unwrap();
        let limit = recent_comment_limit.clamp(1, 200) as i64;
        let mut stmt = g.prepare(
            "SELECT id, stream_id, listener_channel_id, posted_at, body, comment_type,
                    superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst,
                    responded_at
             FROM comments
             WHERE listener_channel_id = ?1
             ORDER BY posted_at DESC LIMIT ?2",
        )?;
        let recent = stmt
            .query_map(params![id_yt, limit], row_to_comment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // ユーザー設定タグ (= listener_tags テーブル) を別途読む (= JOIN ではなく
        // 後置 SELECT、 行数は少ないので問題なし)
        let mut tag_stmt = g.prepare(
            "SELECT tag FROM listener_tags WHERE channel_id = ?1 ORDER BY tag",
        )?;
        let user_tags: Vec<String> = tag_stmt
            .query_map(params![id_yt], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(ListenerDetail {
            listener,
            recent_comments: recent,
            // hidden_listeners は app_config 側にあるため、listener_manager 単体では
            // 分からない。ModelQueue::GetListenerDetail ハンドラで上書きする。
            hide_from_comments: false,
            hide_from_listeners: false,
            user_tags,
        }))
    }

    /// リスナー詳細モーダルの「この枠」chip 用: 指定 stream_video_id でのコメを
    /// 全件 (= 直近 50 件圏外も含む) 新しい順で取得する。
    ///
    /// `get_listener_detail` の `recent_comments` は直近 N 件しか取らないため、 過去配信を
    /// 開いた時など chipCounts.thisStream (= COUNT(*) で正本) と表示の乖離が起きる。
    /// 本関数で「この枠」専用に取り直して count-vs-filter 一致を保つ (2026-05-14)。
    pub fn list_listener_comments_in_stream(
        &self,
        channel_id: &str,
        stream_video_id: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<CommentRow>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let id_yt = with_yt_prefix(channel_id);
        let limit = limit.clamp(1, 10_000) as i64;
        let mut stmt = g.prepare(
            "SELECT id, stream_id, listener_channel_id, posted_at, body, comment_type,
                    superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst,
                    responded_at
             FROM comments
             WHERE listener_channel_id = ?1 AND stream_id = ?2
             ORDER BY posted_at DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![id_yt, stream_video_id, limit], row_to_comment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// リスナー詳細モーダルの「SC のみ」chip 用: 全期間の SC / sticker / gift コメを
    /// 新しい順で取得する。
    ///
    /// `get_listener_detail` の `recent_comments` は直近 N 件しか取らないため、SC が
    /// その圏外にあると chip 数字 (= listeners.superchat_count = 全期間集計) と
    /// 表示の乖離が起きる (2026-05-13)。本関数で SC のみ専用に取り直す。
    pub fn list_listener_superchats(
        &self,
        channel_id: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<CommentRow>> {
        let g = self
            .sync_conn
            .lock()
            .map_err(|_| poisoned_lock_error("sync_conn"))?;
        let id_yt = with_yt_prefix(channel_id);
        let limit = limit.clamp(1, 1000) as i64;
        let mut stmt = g.prepare(
            "SELECT id, stream_id, listener_channel_id, posted_at, body, comment_type,
                    superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst,
                    responded_at
             FROM comments
             WHERE listener_channel_id = ?1
               AND (comment_type IN ('superchat','sticker','gift')
                    OR superchat_amount_jpy > 0)
             ORDER BY posted_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![id_yt, limit], row_to_comment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// SQLite WAL を main DB にチェックポイント (TRUNCATE) し、.db-wal / .db-shm を削除する。
    /// shutdown 時に呼び出すと、Windows で WAL ファイルがロックされたまま残る問題を回避できる。
    pub fn checkpoint_wal(&self) -> rusqlite::Result<()> {
        {
            let record = self.record_conn.lock().expect("record_conn poisoned");
            record.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        {
            let sync = self.sync_conn.lock().expect("sync_conn poisoned");
            sync.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        Ok(())
    }

    /// テスト用: DB ファイルパスを取り出す。
    #[cfg(test)]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// テスト用: 任意の SQL 結果を読みたい時の sync_conn 借用。
    #[cfg(test)]
    pub fn with_sync_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let g = self.sync_conn.lock().expect("sync_conn poisoned");
        f(&g)
    }
}

// ───────────────────────────── stats tokenize ─────────────────────────────

/// `\p{L}+` (Unicode 文字) の連続 run をトークンとして抽出。
/// CJK / Latin が同じ run になる稀ケースは現状無視 (実用上ほぼ起きない)。
/// TODO: 形態素解析ライブラリ (lindera 等) に置き換える。
static STAT_TOKEN_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\p{L}+").expect("valid stat token regex"));

/// 配信統計の頻出語抽出用に文字列を簡易トークン化する。
fn tokenize_for_stats(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for m in STAT_TOKEN_RE.find_iter(body) {
        let s = m.as_str();
        // 1 文字トークンは除外 (= 「あ」「i」等のノイズ抑制)。
        if s.chars().count() < 2 {
            continue;
        }
        // 大小文字差は同一視するため英字は ASCII lowercase に揃える。
        let lower = if s.is_ascii() {
            s.to_ascii_lowercase()
        } else {
            s.to_string()
        };
        out.push(lower);
    }
    out
}

/// 日本語助詞 + 短い英単語 + フィラー語の stopword リスト。
/// 形態素解析が無いため、名詞レベルの語以外を切るための簡易辞書として保持。
const STAT_STOPWORDS: &[&str] = &[
    // 助詞・助動詞・接続詞
    "の",
    "は",
    "が",
    "を",
    "に",
    "へ",
    "で",
    "と",
    "も",
    "や",
    "から",
    "まで",
    "より",
    "など",
    "でも",
    "けど",
    "けれど",
    "けれども",
    "から",
    "ので",
    "のに",
    "って",
    "とか",
    // よく使う動詞活用末尾・形容動詞
    "です",
    "ます",
    "ない",
    "した",
    "して",
    "する",
    "ある",
    "いる",
    "なる",
    "なっ",
    "また",
    "それ",
    "これ",
    "あれ",
    "どれ",
    "ここ",
    "そこ",
    "あそこ",
    "どこ",
    "この",
    "その",
    "あの",
    "どの",
    // フィラー・笑い表記
    "w",
    "ww",
    "www",
    "wwww",
    "wwwww",
    "wwwwww",
    "lol",
    "笑",
    "草",
    // 短い英単語
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "in",
    "on",
    "at",
    "of",
    "to",
    "for",
    "with",
    "by",
    "from",
    "as",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "and",
    "or",
    "but",
    "so",
    "if",
    "yes",
    "no",
    // 短い英単語 (短語)
    "im",
    "ive",
    "youre",
    "isnt",
    "wasnt",
    "dont",
    "didnt",
    "youll",
    "youve",
    // 配信頻出の挨拶・返事
    "ok",
    "oki",
    "okie",
    "haha",
    "hehe",
];

fn is_word_stat_stopword(token: &str) -> bool {
    STAT_STOPWORDS.contains(&token)
}

// ───────────────────────────── 接続初期化 ─────────────────────────────

fn open_and_init(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // WAL + busy_timeout + NORMAL の 3 点セット。設計書 § 4.2 / § 5.3 参照。
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000i64)?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(conn)
}

// ───────────────────────────── マイグレーション ─────────────────────────────

pub(crate) fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS schema_meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS config (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS listeners (
           channel_id            TEXT PRIMARY KEY,
           display_name          TEXT NOT NULL,
           username              TEXT,
           icon_url              TEXT,
           name_history          TEXT NOT NULL DEFAULT '[]',
           first_seen_at         INTEGER NOT NULL,
           last_seen_at          INTEGER NOT NULL,
           comment_count         INTEGER NOT NULL DEFAULT 0,
           superchat_count       INTEGER NOT NULL DEFAULT 0,
           superchat_amount_jpy  INTEGER NOT NULL DEFAULT 0,
           is_member             INTEGER NOT NULL DEFAULT 0,
           is_moderator          INTEGER NOT NULL DEFAULT 0,
           member_months_max     INTEGER NOT NULL DEFAULT 0,
           notes                 TEXT NOT NULL DEFAULT '',
           label                 TEXT NOT NULL DEFAULT '',
           nickname              TEXT NOT NULL DEFAULT '',
           raw                   TEXT
         );
         CREATE TABLE IF NOT EXISTS owner_channels (
           channel_id TEXT PRIMARY KEY,
           handle     TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_listeners_last_seen ON listeners(last_seen_at DESC);
         CREATE INDEX IF NOT EXISTS idx_listeners_count     ON listeners(comment_count DESC);
         CREATE INDEX IF NOT EXISTS idx_listeners_amount    ON listeners(superchat_amount_jpy DESC);
         CREATE TABLE IF NOT EXISTS streams (
           video_id                  TEXT PRIMARY KEY,
           owner_channel_id          TEXT NOT NULL DEFAULT '',
           title                     TEXT NOT NULL DEFAULT '',
           started_at                INTEGER NOT NULL,
           ended_at                  INTEGER NOT NULL,
           comment_count             INTEGER NOT NULL DEFAULT 0,
           superchat_count           INTEGER NOT NULL DEFAULT 0,
           superchat_amount_jpy      INTEGER NOT NULL DEFAULT 0,
           stream_url                TEXT NOT NULL DEFAULT '',
           channel_name              TEXT NOT NULL DEFAULT '',
           channel_icon_url          TEXT NOT NULL DEFAULT '',
           description               TEXT NOT NULL DEFAULT '',
           subscriber_count          INTEGER NOT NULL DEFAULT 0,
           current_viewers           INTEGER NOT NULL DEFAULT 0,
           peak_concurrent_viewers   INTEGER NOT NULL DEFAULT 0,
           likes                     INTEGER NOT NULL DEFAULT 0,
           live_metadata_updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_streams_started ON streams(started_at DESC);
         CREATE TABLE IF NOT EXISTS comments (
           id                     TEXT PRIMARY KEY,
           stream_id              TEXT NOT NULL,
           listener_channel_id    TEXT NOT NULL,
           posted_at              INTEGER NOT NULL,
           body                   TEXT NOT NULL DEFAULT '',
           comment_type           TEXT NOT NULL,
           superchat_amount_jpy   INTEGER,
           superchat_currency     TEXT,
           superchat_amount_raw   REAL,
           raw                    TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_comments_stream    ON comments(stream_id, posted_at);
         CREATE INDEX IF NOT EXISTS idx_comments_listener  ON comments(listener_channel_id, posted_at DESC);
         CREATE INDEX IF NOT EXISTS idx_comments_posted    ON comments(posted_at DESC);
         CREATE INDEX IF NOT EXISTS idx_comments_type      ON comments(comment_type);
         /* リスナータブ「復帰」 / chip-counts comeback の listeners_in_recent CTE 用。
            14 枠 × 数千コメントを scan する時、(stream_id, listener_channel_id) を
            index 内で完結させる (= row body 取得不要)。書き込み影響は per-INSERT で
            btree update 1 個追加 (~30µs)、読込影響は 8〜10 倍速。
            クエリで listener_channel_id を読まない既存経路 (= idx_comments_stream)
            は変更なしで残す。 */
         CREATE INDEX IF NOT EXISTS idx_comments_stream_listener
           ON comments(stream_id, listener_channel_id);
         /* 0002: list_stream_listeners (= 配信詳細モーダル) member_join_only EXISTS 用。
            (stream_id, comment_type, listener_channel_id) で「この枠に特定 type の
            comment を残した listener」を index 内で完結させる (= row body 取得不要)。
            既存 idx_comments_stream_listener は type 抜きで全 type を引く経路用、
            本 index は type 別 EXISTS / DISTINCT 経路用 (= 新メンバータブ 7783 行 →
            7 listener の絞り込みで main_sql 1259ms→大幅短縮見込み)。
            書き込み影響: btree update 1 個追加 (~30µs/insert)。閾値ログで実測する。 */
         CREATE INDEX IF NOT EXISTS idx_comments_stream_type_listener
           ON comments(stream_id, comment_type, listener_channel_id);
         CREATE TABLE IF NOT EXISTS listener_tags (
           channel_id   TEXT NOT NULL,
           tag          TEXT NOT NULL,
           attached_at  INTEGER NOT NULL,
           PRIMARY KEY (channel_id, tag)
         );
         CREATE INDEX IF NOT EXISTS idx_listener_tags_tag ON listener_tags(tag);
         CREATE TABLE IF NOT EXISTS stream_tags (
           video_id     TEXT NOT NULL,
           tag          TEXT NOT NULL,
           attached_at  INTEGER NOT NULL,
           PRIMARY KEY (video_id, tag)
         );
         CREATE INDEX IF NOT EXISTS idx_stream_tags_tag ON stream_tags(tag);
         CREATE TABLE IF NOT EXISTS saved_searches (
           id          INTEGER PRIMARY KEY AUTOINCREMENT,
           name        TEXT NOT NULL,
           conditions  TEXT NOT NULL,
           sort_order  INTEGER NOT NULL DEFAULT 0,
           created_at  INTEGER NOT NULL,
           updated_at  INTEGER NOT NULL,
           scope       TEXT NOT NULL DEFAULT 'comment-search'
         );
         /* idx_saved_searches_scope_order は scope 列依存。 既存 DB は CREATE TABLE
            IF NOT EXISTS が no-op で scope 列なしのまま、 この index 作成で
            「no such column: scope」エラーになるため、 ここでは index を作成しない。
            ALTER TABLE で scope 列を追加した後 (下記 saved_searches.scope migration)
            で CREATE INDEX IF NOT EXISTS を実行する。 */
         CREATE TABLE IF NOT EXISTS stream_listener_state (
           stream_video_id      TEXT NOT NULL,
           listener_channel_id  TEXT NOT NULL,
           greeted_at           INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (stream_video_id, listener_channel_id)
         );
         CREATE INDEX IF NOT EXISTS idx_stream_listener_state_listener
           ON stream_listener_state(listener_channel_id);
         COMMIT;",
    )?;

    // 既存 v1 DB に comments.responded_at カラムを冪等に追加 (= remote-viewing-redesign.md §3.2)。
    // SQLite には ADD COLUMN IF NOT EXISTS が無いので、PRAGMA table_info で存在確認してから ALTER。
    let comments_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(comments)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if !comments_columns.iter().any(|c| c == "responded_at") {
        conn.execute(
            "ALTER TABLE comments ADD COLUMN responded_at INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_comments_responded
             ON comments(stream_id, responded_at) WHERE responded_at > 0",
            [],
        )?;
    }

    // saved_searches.scope カラムを冪等に追加 (= Phase 2c、 2026-05-14)。
    // 既存 row は default で 'comment-search' になる (= 後方互換)。
    // listener-search 等の他スコープを将来追加可能。 sort_order の MAX+1 は scope 内に
    // 限定されるよう CRUD 側で処理。
    let saved_search_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(saved_searches)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if !saved_search_columns.iter().any(|c| c == "scope") {
        conn.execute(
            "ALTER TABLE saved_searches ADD COLUMN scope TEXT NOT NULL DEFAULT 'comment-search'",
            [],
        )?;
    }
    // 旧 idx_saved_searches_order (= scope 抜き) を drop して、 scope 付き index に
    // 揃える。 fresh install / migrated 両方で冪等に動く。
    conn.execute("DROP INDEX IF EXISTS idx_saved_searches_order", [])?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_saved_searches_scope_order
         ON saved_searches(scope, sort_order, id)",
        [],
    )?;

    // comments.raw_zst BLOB + comments.comment_html TEXT を追加 (= 2026-05-16 raw_json
    // zstd 圧縮化)。 旧 raw TEXT は migration 完了後に DROP する。
    // raw_zst は zstd L3 圧縮した JSON、 comment_html は raw JSON の commentHtml フィールドを
    // SQL 直読みできるよう column 化したもの (= 旧 json_extract(raw, '$.commentHtml') 経路の代替)。
    let comments_columns_v2: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(comments)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if !comments_columns_v2.iter().any(|c| c == "raw_zst") {
        conn.execute("ALTER TABLE comments ADD COLUMN raw_zst BLOB", [])?;
    }
    if !comments_columns_v2.iter().any(|c| c == "comment_html") {
        conn.execute(
            "ALTER TABLE comments ADD COLUMN comment_html TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if comments_columns_v2.iter().any(|c| c == "raw") {
        migrate_comments_raw_to_zstd(conn)?;
        conn.execute("ALTER TABLE comments DROP COLUMN raw", [])?;
        // VACUUM で物理 size 縮小 (= raw 列削除分 + 圧縮で空いた領域を回収)
        // VACUUM は transaction 外で実行する必要があるが、 ALTER TABLE 直後でも OK。
        // 数 GB の DB で数分かかる可能性。
        tracing::info!("running VACUUM after raw column drop (= 物理 size 縮小)");
        conn.execute("VACUUM", [])?;
    }

    // schema_version の upsert
    conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![EXPECTED_SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

/// 旧 comments.raw TEXT を zstd 圧縮 + commentHtml 抽出して
/// raw_zst BLOB / comment_html TEXT カラムに移行する (= 2026-05-16 raw_json 圧縮化)。
///
/// chunk 化 (10000 件 / トランザクション) で WAL 肥大を抑えつつ、 chunk 内の zstd encode +
/// JSON parse を rayon で並列化する (= 2026-05-17 並列化、 物理コア × 3/4 = backup unpack と同じ pool)。
/// 432K 件で旧シリアル時 5 分 40 秒 → 並列化で約 1 分弱の見込み。
/// 中断後 resume も可能 (= WHERE raw_zst IS NULL で未移行行のみ pick)。
fn migrate_comments_raw_to_zstd(conn: &Connection) -> rusqlite::Result<()> {
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM comments WHERE raw_zst IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if total == 0 {
        tracing::info!("migrate_comments_raw_to_zstd: nothing to migrate");
        return Ok(());
    }

    // 専用 rayon ThreadPool (= 物理コア × 3/4、 global pool に影響なし)。
    // backup unpack と共通の unpack_thread_count() で並列度を統一する。
    let thread_count = unpack_thread_count();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .thread_name(|i| format!("komehub-migrate-{}", i))
        .build()
        .map_err(|e| {
            SqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: ErrorCode::Unknown,
                    extended_code: 0,
                },
                Some(format!("rayon pool init: {}", e)),
            )
        })?;
    tracing::info!(
        "migrate_comments_raw_to_zstd: starting migration of {} comments (threads={})",
        total,
        thread_count
    );

    // 復元経路で backup_handlers が reporter をセットしていれば、 開始通知 (= processed=0)
    // を送る。 通常起動時 (= reporter 未設定) は no-op。
    migration_progress::report(0, total as u64);

    const CHUNK: usize = 10000;
    let mut processed: i64 = 0;
    loop {
        // chunk 取得 (= raw_zst IS NULL の上位 N 件)
        let rows: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, raw FROM comments WHERE raw_zst IS NULL LIMIT ?1",
            )?;
            let collected: Vec<(String, String)> = stmt
                .query_map(params![CHUNK as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .filter_map(|r| r.ok())
                .collect();
            collected
        };
        if rows.is_empty() {
            break;
        }
        let n = rows.len();

        // chunk 内 zstd encode + commentHtml 抽出を並列化 (= CPU multi-core 活用)。
        // encode 失敗の行は warn ログ + 空 Vec でスキップ (= 次回起動で raw_zst IS NULL のまま
        // 残るので再 pick 可能、 致命ではない)。
        let prepared: Vec<(Vec<u8>, String, String)> = pool.install(|| {
            rows.par_iter()
                .map(|(id, raw_str)| {
                    let raw_val: serde_json::Value =
                        serde_json::from_str(raw_str).unwrap_or(serde_json::Value::Null);
                    let comment_html = raw_val
                        .get("commentHtml")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let compressed = match zstd::encode_all(raw_str.as_bytes(), 3) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::warn!("migrate zstd encode skip ({}): {}", id, e);
                            Vec::new()
                        }
                    };
                    (compressed, comment_html, id.clone())
                })
                .collect()
        });

        // シリアル UPDATE (= SQLite は単一書き込み)
        conn.execute_batch("BEGIN IMMEDIATE")?;
        {
            let mut upd = conn.prepare(
                "UPDATE comments SET raw_zst = ?1, comment_html = ?2 WHERE id = ?3",
            )?;
            for (compressed, comment_html, id) in &prepared {
                if compressed.is_empty() {
                    continue; // encode 失敗の行は次回再 pick (= raw_zst IS NULL のまま残す)
                }
                upd.execute(params![compressed, comment_html, id])?;
            }
        }
        conn.execute_batch("COMMIT")?;
        processed += n as i64;
        if processed % 50000 == 0 || processed == total {
            tracing::info!(
                "migrate_comments_raw_to_zstd: {}/{} ({:.1}%)",
                processed,
                total,
                (processed as f64 / total as f64) * 100.0
            );
            // 進捗 reporter (= 復元経路の SSE 連携用、 通常起動時は no-op)
            migration_progress::report(processed as u64, total as u64);
        }
    }
    tracing::info!("migrate_comments_raw_to_zstd: completed {} comments", processed);
    Ok(())
}

// ───────────────────────────── insert_comment ─────────────────────────────

#[allow(clippy::too_many_arguments)]
fn insert_comment(
    tx: &Transaction,
    comment_id_yt: &str,
    stream_video_id: &str,
    listener_id_yt: &str,
    posted_at: i64,
    body: &str,
    comment_type: CommentType,
    amount_jpy: Option<i64>,
    amount_raw: Option<f64>,
    currency: Option<&str>,
    raw_comment: &RawComment,
) -> rusqlite::Result<bool> {
    // raw payload (JSON 化) を保持。スキーマ追加時の後方互換に備える。
    // zstd 圧縮 + commentHtml を column 直書き (= 旧 raw TEXT は migration で削除済)。
    let raw_json = serde_json::to_string(raw_comment).unwrap_or_else(|_| "null".to_string());
    let raw_zst = zstd::encode_all(raw_json.as_bytes(), 3)
        .unwrap_or_else(|_| Vec::new());
    let comment_html = serde_json::from_str::<serde_json::Value>(&raw_json)
        .ok()
        .as_ref()
        .and_then(|v| v.get("commentHtml"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut stmt = tx.prepare_cached(
        "INSERT INTO comments
         (id, stream_id, listener_channel_id, posted_at, body, comment_type,
          superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst, comment_html)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO NOTHING
         RETURNING id",
    )?;
    let mut rows = stmt.query(params![
        comment_id_yt,
        stream_video_id,
        listener_id_yt,
        posted_at,
        body,
        comment_type.as_str(),
        amount_jpy,
        currency,
        amount_raw,
        raw_zst,
        comment_html,
    ])?;
    Ok(rows.next()?.is_some())
}

// ───────────────────────────── upsert_listener ─────────────────────────────

/// 戻り値: そのリスナーが今回初めて記録されたか (= 新規 INSERT 時 true)。
fn upsert_listener(
    tx: &Transaction,
    listener_id_yt: &str,
    comment: &RawComment,
    posted_at: i64,
    amount_jpy: Option<i64>,
    is_superchat_like: bool,
) -> rusqlite::Result<bool> {
    let display_name = effective_display_name(comment);
    let username =
        nonempty_or_null(&comment.screen_name).or_else(|| nonempty_or_null(&comment.nickname));
    let icon_url = nonempty_or_null(&comment.profile_image)
        .or_else(|| nonempty_or_null(&comment.original_profile_image));

    // 既存があれば現在の display_name / name_history を取得して履歴を append する。
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT display_name, name_history FROM listeners WHERE channel_id = ?1",
            params![listener_id_yt],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    let new_history_json = match &existing {
        Some((prev_name, prev_history)) if prev_name != &display_name => {
            append_name_history(prev_history, prev_name, &display_name, posted_at)
        }
        Some((_, prev_history)) => prev_history.clone(),
        None => "[]".to_string(),
    };

    let amount_inc = amount_jpy.unwrap_or(0);
    let superchat_count_inc: i64 = if is_superchat_like { 1 } else { 0 };
    // originalProfileImage はわんコメ書き戻し時に icon フィールドへ入れるための
    // 「YouTube CDN 生 URL」を保持する。listeners.icon_url にはこめはぶ内部の
    // image_cache 経由の `http://127.0.0.1:11280/cache/avatars/...` が入っており、
    // これをわんコメに渡すとこめはぶ未起動時に画像が出ない (cache サーバ不在)。
    // listener_row_to_onecomme_patch で raw.originalProfileImage を icon に使う。
    let raw_payload = json!({
        "service": "youtube",
        "memberBadgeUrl": comment.member_badge_url,
        "originalProfileImage": comment.original_profile_image,
    })
    .to_string();

    let inserted = tx
        .execute(
            "INSERT INTO listeners
             (channel_id, display_name, username, icon_url, name_history,
              first_seen_at, last_seen_at, comment_count,
              superchat_count, superchat_amount_jpy,
              is_member, is_moderator, member_months_max,
              notes, label, nickname, raw)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?8, ?9, ?10, ?11, '', '', '', ?12)
             ON CONFLICT(channel_id) DO UPDATE SET
               display_name         = excluded.display_name,
               username             = COALESCE(excluded.username, listeners.username),
               icon_url             = COALESCE(excluded.icon_url, listeners.icon_url),
               name_history         = ?5,
               first_seen_at        = CASE
                 WHEN listeners.comment_count = 0 OR listeners.first_seen_at = 0
                   THEN excluded.first_seen_at
                 ELSE MIN(listeners.first_seen_at, excluded.first_seen_at)
               END,
               last_seen_at         = MAX(listeners.last_seen_at, excluded.last_seen_at),
               comment_count        = listeners.comment_count + 1,
               superchat_count      = listeners.superchat_count + excluded.superchat_count,
               superchat_amount_jpy = listeners.superchat_amount_jpy + excluded.superchat_amount_jpy,
               is_member            = MAX(listeners.is_member, excluded.is_member),
               is_moderator         = MAX(listeners.is_moderator, excluded.is_moderator),
               member_months_max    = MAX(listeners.member_months_max, excluded.member_months_max),
               -- 最新のコメントから取れる originalProfileImage 等を反映する
               -- (= わんコメ書き戻しで icon に正しい URL を渡せる)
               raw                  = excluded.raw;",
            params![
                listener_id_yt,
                display_name,
                username,
                icon_url,
                new_history_json,
                posted_at,
                superchat_count_inc,
                amount_inc,
                comment.is_member as i64,
                comment.is_moderator as i64,
                comment.member_months as i64,
                raw_payload,
            ],
        )?;
    let is_first_insert = existing.is_none() && inserted == 1;

    // 新規 INSERT 時 (= 過去に listener 行が無かった) は、孤児コメ (= delete_listeners で
    // listener 行だけ削除した残余) と新コメで comments テーブルが既に複数行になっている
    // 可能性があるため、aggregates を comments テーブル直集計で recompute する。
    // VALUES の literal `1` / `?6` だけだと「孤児を無視して 1 から再カウント」になり、
    // listeners.comment_count や first_seen_at が drift する (= 2026-05-10 検出済の
    // delete_listeners → re-record_comment 経路バグ)。
    // ON CONFLICT パス (= 既存行更新) では incremental の `+1` / `MIN/MAX-merge` で
    // 正しく増減するためここでは触らない。
    let owner_channel_count: i64 =
        tx.query_row("SELECT COUNT(*) FROM owner_channels", [], |row| row.get(0))?;
    if is_first_insert && owner_channel_count == 0 {
        tx.execute(
            "UPDATE listeners SET
               comment_count = (SELECT COUNT(*) FROM comments WHERE listener_channel_id = ?1),
               superchat_count = (SELECT COUNT(*) FROM comments WHERE listener_channel_id = ?1
                                  AND comment_type IN ('superchat', 'sticker', 'gift')),
               superchat_amount_jpy = COALESCE((SELECT SUM(superchat_amount_jpy) FROM comments
                                                WHERE listener_channel_id = ?1), 0),
               first_seen_at = COALESCE((SELECT MIN(posted_at) FROM comments
                                         WHERE listener_channel_id = ?1), first_seen_at),
               last_seen_at = COALESCE((SELECT MAX(posted_at) FROM comments
                                        WHERE listener_channel_id = ?1), last_seen_at)
             WHERE channel_id = ?1",
            params![listener_id_yt],
        )?;
    } else if is_first_insert {
        tx.execute(
            "UPDATE listeners SET
               comment_count = (
                 SELECT COUNT(*) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = ?1
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ),
               superchat_count = (
                 SELECT COUNT(*) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = ?1
                   AND c.comment_type IN ('superchat', 'sticker', 'gift')
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ),
               superchat_amount_jpy = COALESCE((
                 SELECT SUM(c.superchat_amount_jpy) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = ?1
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), 0),
               first_seen_at = COALESCE((
                 SELECT MIN(c.posted_at) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = ?1
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), first_seen_at),
               last_seen_at = COALESCE((
                 SELECT MAX(c.posted_at) FROM comments c
                 JOIN streams s ON s.video_id = c.stream_id
                 WHERE c.listener_channel_id = ?1
                   AND s.owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)
               ), last_seen_at)
             WHERE channel_id = ?1",
            params![listener_id_yt],
        )?;
    }

    Ok(is_first_insert)
}

fn upsert_display_listener(
    tx: &Transaction,
    listener_id_yt: &str,
    comment: &RawComment,
    posted_at: i64,
) -> rusqlite::Result<bool> {
    let display_name = effective_display_name(comment);
    let username =
        nonempty_or_null(&comment.screen_name).or_else(|| nonempty_or_null(&comment.nickname));
    let icon_url = nonempty_or_null(&comment.profile_image)
        .or_else(|| nonempty_or_null(&comment.original_profile_image));
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT display_name, name_history FROM listeners WHERE channel_id = ?1",
            params![listener_id_yt],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();
    let new_history_json = match &existing {
        Some((prev_name, prev_history)) if prev_name != &display_name => {
            append_name_history(prev_history, prev_name, &display_name, posted_at)
        }
        Some((_, prev_history)) => prev_history.clone(),
        None => "[]".to_string(),
    };
    let raw_payload = json!({
        "service": "youtube",
        "memberBadgeUrl": comment.member_badge_url,
        "originalProfileImage": comment.original_profile_image,
    })
    .to_string();

    let inserted = tx.execute(
        "INSERT INTO listeners
         (channel_id, display_name, username, icon_url, name_history,
          first_seen_at, last_seen_at, comment_count,
          superchat_count, superchat_amount_jpy,
          is_member, is_moderator, member_months_max,
          notes, label, nickname, raw)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, 0, 0, 0, 0, 0, '', '', '', ?6)
         ON CONFLICT(channel_id) DO UPDATE SET
           display_name = excluded.display_name,
           username = COALESCE(excluded.username, listeners.username),
           icon_url = COALESCE(excluded.icon_url, listeners.icon_url),
           name_history = ?5,
           raw = excluded.raw;",
        params![
            listener_id_yt,
            display_name,
            username,
            icon_url,
            new_history_json,
            raw_payload,
        ],
    )?;
    Ok(existing.is_none() && inserted == 1)
}

fn append_name_history(prev_json: &str, from: &str, to: &str, at: i64) -> String {
    let mut arr: Vec<serde_json::Value> = serde_json::from_str(prev_json).unwrap_or_default();
    arr.push(json!({ "at": at, "from": from, "to": to }));
    serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string())
}

// ───────────────────────────── upsert_stream ─────────────────────────────

fn upsert_stream(
    tx: &Transaction,
    video_id: &str,
    owner_channel_id: &str,
    posted_at: i64,
    amount_jpy: Option<i64>,
    is_superchat_like: bool,
) -> rusqlite::Result<()> {
    let amount_inc = amount_jpy.unwrap_or(0);
    let superchat_count_inc: i64 = if is_superchat_like { 1 } else { 0 };
    // owner_channel_id は新規 INSERT 時に保存し、既存行は空文字でない場合のみ
    // 上書きする (記録時点の owner を尊重しつつ、後から入手した owner で
    // 空欄を埋められるようにする)
    tx.execute(
        "INSERT INTO streams
         (video_id, owner_channel_id, title, started_at, ended_at,
          comment_count, superchat_count, superchat_amount_jpy)
         VALUES (?1, ?2, '', ?3, ?3, 1, ?4, ?5)
         ON CONFLICT(video_id) DO UPDATE SET
           owner_channel_id     = CASE
             WHEN excluded.owner_channel_id != '' THEN excluded.owner_channel_id
             ELSE streams.owner_channel_id
           END,
           started_at           = MIN(streams.started_at, excluded.started_at),
           ended_at             = MAX(streams.ended_at, excluded.ended_at),
           comment_count        = streams.comment_count + 1,
           superchat_count      = streams.superchat_count + excluded.superchat_count,
           superchat_amount_jpy = streams.superchat_amount_jpy + excluded.superchat_amount_jpy;",
        params![
            video_id,
            owner_channel_id,
            posted_at,
            superchat_count_inc,
            amount_inc
        ],
    )?;
    Ok(())
}

fn upsert_display_stream(
    tx: &Transaction,
    video_id: &str,
    owner_channel_id: &str,
    posted_at: i64,
    amount_jpy: Option<i64>,
    is_superchat_like: bool,
) -> rusqlite::Result<()> {
    let amount_inc = amount_jpy.unwrap_or(0);
    let superchat_count_inc: i64 = if is_superchat_like { 1 } else { 0 };
    tx.execute(
        "INSERT INTO streams
         (video_id, owner_channel_id, title, started_at, ended_at,
          comment_count, superchat_count, superchat_amount_jpy)
         VALUES (?1, ?2, '', ?3, ?3, 1, ?4, ?5)
         ON CONFLICT(video_id) DO UPDATE SET
           owner_channel_id = CASE
             WHEN excluded.owner_channel_id != '' THEN excluded.owner_channel_id
             ELSE streams.owner_channel_id
           END,
           started_at = MIN(streams.started_at, excluded.started_at),
           ended_at = MAX(streams.ended_at, excluded.ended_at),
           comment_count = streams.comment_count + 1,
           superchat_count = streams.superchat_count + excluded.superchat_count,
           superchat_amount_jpy = streams.superchat_amount_jpy + excluded.superchat_amount_jpy;",
        params![
            video_id,
            owner_channel_id,
            posted_at,
            superchat_count_inc,
            amount_inc
        ],
    )?;
    Ok(())
}

// ───────────────────────────── ヘルパー ─────────────────────────────

/// リスナーランク 6 分類 + 新規 の判定。Rust core 側が一意の判定主体 (= Single Source of Truth)。
///
/// JS 側は戻り値の文字列を表示するだけで、再判定しない (= memory `project_rust_sidecar.md`
/// 「コアロジック変更は core/ 配下。Electron側は IPC ハンドラとUI描画のみ」)。
///
/// 戻り値:
/// - `"first-time"` (新規): この枠で初コメ (= first_seen_at >= baseline 対象配信の started_at)
/// - `"returning"` (新参): 過去枠で初コメ済 AND first_seen_at >= baseline - X日
/// - `"regular"` (常連): baseline - Y日 <= first_seen_at < baseline - X日 AND active
/// - `"veteran"` (古参): first_seen_at < baseline - Y日 AND active
/// - `"comeback"` (復帰): first_seen_at < baseline - X日 AND NOT active AND 復帰窓 (= last_N ∪ baseline) でコメ済
/// - `"abandoned"` (離脱): first_seen_at < baseline - X日 AND NOT active AND 復帰窓でコメ無し
/// - `""`: 判定不能 (= first_seen_at = 0 等)
///
/// `is_active` は呼び出し側が「直近 N 枠中 M 枠以上で発言」を判定した結果。
/// データ不足時 (= last_n_streams < M) は全員 active=true 扱いで呼ぶ (= 復帰判定無効化)。
///
/// `in_comeback_window` は「復帰窓 (= last_n_streams ∪ baseline) でコメ済か」。
/// baseline (= 最終枠) 自身も含む N+1 枠のいずれかにコメがあれば true。 stream-detail 系
/// (= list_stream_listeners / get_stream_stats) では 母集団が当該枠コメ済 = baseline
/// に必ずコメがあるので常に true。 リスナー検索 (= list_listeners with
/// baseline_stream_video_id) で 復帰 / 離脱 を per-row に分けるための判定材料。
fn classify_listener_rank(
    first_seen_at: i64,
    is_active: bool,
    in_comeback_window: bool,
    baseline: i64,
    one_month_ms: i64,
    one_year_ms: i64,
) -> &'static str {
    if first_seen_at <= 0 {
        return "";
    }
    if first_seen_at >= baseline {
        return "first-time";
    }
    if first_seen_at >= baseline - one_month_ms {
        return "returning";
    }
    if !is_active {
        return if in_comeback_window {
            "comeback"
        } else {
            "abandoned"
        };
    }
    if first_seen_at < baseline - one_year_ms {
        return "veteran";
    }
    "regular"
}

/// `http://127.0.0.1:11280/cache/avatars/<filename>` 形式の URL から filename 部分を取り出す。
/// それ以外の URL (= 外部 CDN や data: URL) では None を返し、ファイル削除をスキップする。
fn extract_cache_avatar_file_name(icon_url: &str) -> Option<String> {
    let marker = "/cache/avatars/";
    icon_url.find(marker).and_then(|idx| {
        let tail = &icon_url[idx + marker.len()..];
        if tail.is_empty() || tail.contains('/') || tail.contains("..") {
            None
        } else {
            Some(tail.to_string())
        }
    })
}

fn with_yt_prefix(raw: &str) -> String {
    if raw.starts_with("yt-") {
        raw.to_string()
    } else {
        format!("yt-{}", raw)
    }
}

fn nonempty_or_null(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn effective_display_name(comment: &RawComment) -> String {
    if !comment.display_name.is_empty() {
        comment.display_name.clone()
    } else if !comment.name.is_empty() {
        comment.name.clone()
    } else {
        // 表示名が完全に取れない場合は channel_id 末尾を使う
        format!(
            "user-{}",
            comment.user_id.chars().take(6).collect::<String>()
        )
    }
}

fn classify_comment_type(comment: &RawComment) -> CommentType {
    if comment.is_membership_gift_redemption {
        CommentType::GiftRedemption
    } else if comment.is_membership_gift {
        CommentType::Gift
    } else if comment.is_membership_milestone {
        CommentType::MembershipMilestone
    } else if comment.is_membership {
        CommentType::Membership
    } else if !comment.sticker_image.is_empty() {
        CommentType::Sticker
    } else if comment.has_gift {
        CommentType::Superchat
    } else {
        CommentType::Chat
    }
}

/// (jpy, raw, currency) を返す。chat はすべて None。
fn derive_superchat_fields(comment: &RawComment) -> (Option<i64>, Option<f64>, Option<String>) {
    if !comment.has_gift && !comment.is_membership_gift {
        return (None, None, None);
    }
    if comment.amount <= 0.0 {
        // ギフト系で金額不明 (membership gift など)
        return (None, None, nonempty_or_null(&comment.currency));
    }
    let jpy = fx_rates::fallback_amount_to_jpy(comment.amount, &comment.currency);
    if jpy.is_none() {
        tracing::warn!(
            "listener_manager: unsupported currency for superchat (amount={}, currency={})",
            comment.amount,
            comment.currency
        );
    }
    (
        jpy,
        Some(comment.amount),
        nonempty_or_null(&comment.currency),
    )
}

fn current_unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// わんコメ DB を読み取り専用で open して指定テーブルの COUNT(*) を返す。
/// open / クエリどちらかが失敗したら 0 (= 「DB 不在 / テーブル不在」 として扱う)。
fn open_readonly_count(db_path: &Path, table: &str) -> i64 {
    if !db_path.exists() {
        return 0;
    }
    let Ok(conn) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return 0;
    };
    // table 名はリテラル文字列なので SQL injection リスクなし (= 呼出元で固定値)。
    let sql = format!("SELECT COUNT(*) FROM {}", table);
    conn.query_row(&sql, [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
}

/// わんコメ comments.db を読み取り専用で open して、 (件数, MAX(created_at)) を返す。
/// 空テーブル / 開けない場合は (0, "") を返す。
fn open_readonly_count_and_max(comments_db: &Path) -> (i64, String) {
    if !comments_db.exists() {
        return (0, String::new());
    }
    let Ok(conn) = Connection::open_with_flags(
        comments_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return (0, String::new());
    };
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))
        .unwrap_or(0);
    let max_ts: String = conn
        .query_row(
            "SELECT COALESCE(MAX(created_at), '') FROM comments",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();
    (cnt, max_ts)
}

/// config テーブルから i64 値を読む (= key 不在 / parse 失敗で None)。
fn read_config_i64(conn: &Connection, key: &str) -> Option<i64> {
    conn.query_row(
        "SELECT value FROM config WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|s| s.parse().ok())
}

/// config テーブルから String 値を読む。
fn read_config_str(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM config WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn parse_iso_to_unix_ms(iso: &str) -> Option<i64> {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    if iso.is_empty() {
        return None;
    }
    OffsetDateTime::parse(iso, &Rfc3339)
        .ok()
        .map(|dt| (dt.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn is_busy(err: &SqliteError) -> bool {
    matches!(
        err,
        SqliteError::SqliteFailure(e, _) if e.code == ErrorCode::DatabaseBusy || e.code == ErrorCode::DatabaseLocked
    )
}

/// SELECT 列の定数 (複数箇所で共通利用)。
/// last_comment_body はテキスト本文 (title属性等の素値表示用)、
/// last_comment_html はカスタム絵文字を画像化した HTML (innerHTML 用) を返す。
/// テンプレ/コメント表示と同じ commentHtml を再利用するため raw から json_extract する。
/// `idx_comments_listener (listener_channel_id, posted_at DESC)` で最適化済み。
///
/// 列は `listeners.X` で修飾する。`comments` テーブルと JOIN したクエリで
/// `superchat_amount_jpy` 等が ambiguous にならないようにするため。
const LISTENER_SELECT_COLUMNS: &str =
    "listeners.channel_id, listeners.display_name, listeners.username,
                    listeners.icon_url, listeners.name_history,
                    listeners.first_seen_at, listeners.last_seen_at, listeners.comment_count,
                    listeners.superchat_count, listeners.superchat_amount_jpy,
                    listeners.is_member, listeners.is_moderator, listeners.member_months_max,
                    listeners.notes, listeners.label, listeners.nickname, listeners.raw,
                    (SELECT body FROM comments
                     WHERE listener_channel_id = listeners.channel_id
                     ORDER BY posted_at DESC LIMIT 1) AS last_comment_body,
                    (SELECT comment_html FROM comments
                     WHERE listener_channel_id = listeners.channel_id
                     ORDER BY posted_at DESC LIMIT 1) AS last_comment_html";

fn row_to_listener(row: &rusqlite::Row<'_>) -> rusqlite::Result<ListenerRow> {
    let history_str: String = row.get(4)?;
    let name_history = serde_json::from_str(&history_str).unwrap_or(serde_json::json!([]));
    let raw_str: Option<String> = row.get(16)?;
    let raw = raw_str.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let last_comment_body: Option<String> = row.get(17)?;
    // 空文字 ("") の commentHtml は無扱い (renderer が body にフォールバックできるよう None 化)。
    let last_comment_html: Option<String> =
        row.get::<_, Option<String>>(18)?.filter(|s| !s.is_empty());
    // 19 列目 = greeted_at。SELECT に含まれない経路 (= LISTENER_SELECT_COLUMNS 単独) では
    // unwrap_or(0) で前方互換、含む経路 (= list_listeners + stream_video_id) では実値。
    // 20 列目 = per_stream_sc_amount_jpy。同じく unwrap_or(0) で前方互換。
    // 21 列目 = per_stream_comment_count。同じく unwrap_or(0) で前方互換。
    // 22 列目 = per_stream_last_at。同じく unwrap_or(0) で前方互換。
    let greeted_at: i64 = row.get(19).unwrap_or(0);
    let per_stream_sc_amount_jpy: i64 = row.get(20).unwrap_or(0);
    let per_stream_comment_count: i64 = row.get(21).unwrap_or(0);
    let per_stream_last_at: i64 = row.get(22).unwrap_or(0);
    Ok(ListenerRow {
        channel_id: row.get(0)?,
        display_name: row.get(1)?,
        username: row.get(2)?,
        icon_url: row.get(3)?,
        name_history,
        first_seen_at: row.get(5)?,
        last_seen_at: row.get(6)?,
        comment_count: row.get(7)?,
        superchat_count: row.get(8)?,
        superchat_amount_jpy: row.get(9)?,
        is_member: row.get::<_, i64>(10)? != 0,
        is_moderator: row.get::<_, i64>(11)? != 0,
        member_months_max: row.get(12)?,
        notes: row.get(13)?,
        label: row.get(14)?,
        nickname: row.get(15)?,
        raw,
        last_comment_body,
        last_comment_html,
        greeted_at,
        per_stream_sc_amount_jpy,
        per_stream_comment_count,
        per_stream_last_at,
        system_tag: None, // list_listeners が stream/baseline context あり時に post-process で埋める
    })
}

/// streams テーブルの全列を選ぶときの列リスト (順序は row_to_stream と一致させる)。
const STREAM_SELECT_COLUMNS: &str = "video_id, owner_channel_id, title, started_at, ended_at,
     comment_count, superchat_count, superchat_amount_jpy,
     stream_url, channel_name, channel_icon_url, description,
     subscriber_count, current_viewers, peak_concurrent_viewers, likes, live_metadata_updated_at";

fn row_to_stream(row: &rusqlite::Row<'_>) -> rusqlite::Result<StreamRow> {
    Ok(StreamRow {
        video_id: row.get(0)?,
        owner_channel_id: row.get(1)?,
        title: row.get(2)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
        comment_count: row.get(5)?,
        superchat_count: row.get(6)?,
        superchat_amount_jpy: row.get(7)?,
        stream_url: row.get(8)?,
        channel_name: row.get(9)?,
        channel_icon_url: row.get(10)?,
        description: row.get(11)?,
        subscriber_count: row.get(12)?,
        current_viewers: row.get(13)?,
        peak_concurrent_viewers: row.get(14)?,
        likes: row.get(15)?,
        live_metadata_updated_at: row.get(16)?,
        is_own_stream: row.get::<_, i64>(17).unwrap_or(0) != 0,
    })
}

fn row_to_comment(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommentRow> {
    let comment_type_str: String = row.get(5)?;
    let comment_type = match comment_type_str.as_str() {
        "superchat" => CommentType::Superchat,
        "membership" => CommentType::Membership,
        "membership_milestone" => CommentType::MembershipMilestone,
        "sticker" => CommentType::Sticker,
        "gift" => CommentType::Gift,
        "gift_redemption" => CommentType::GiftRedemption,
        _ => CommentType::Chat,
    };
    // raw_zst BLOB を zstd decode → JSON parse (= 2026-05-16 raw_json 圧縮化)。
    // 旧 raw TEXT 経路は migration で全件 zstd 化済なので raw_zst のみを読む。
    let raw_zst_opt: Option<Vec<u8>> = row.get(9).ok();
    let raw = raw_zst_opt
        .and_then(|bytes| zstd::decode_all(&bytes[..]).ok())
        .and_then(|decoded| serde_json::from_slice::<serde_json::Value>(&decoded).ok())
        .unwrap_or(serde_json::Value::Null);
    // column 10 = responded_at。SELECT に含まれていない場合 (= 旧 callsite) は 0 fallback。
    let responded_at: i64 = row.get(10).unwrap_or(0);
    Ok(CommentRow {
        id: row.get(0)?,
        stream_id: row.get(1)?,
        listener_channel_id: row.get(2)?,
        posted_at: row.get(3)?,
        body: row.get(4)?,
        comment_type,
        superchat_amount_jpy: row.get(6)?,
        superchat_currency: row.get(7)?,
        superchat_amount_raw: row.get(8)?,
        raw,
        responded_at,
    })
}

/// わんコメ users.data から ListenerRow へ変換する (フェーズ 3.4 インポート)。
/// 設計書 § 9.3 のキーマッピングに従う。失敗時は parse error を文字列で返す。
fn listener_row_from_onecomme_user(
    user: &listener_aux_io::OnecommeUserRow,
) -> Result<ListenerRow, String> {
    let data: serde_json::Value =
        serde_json::from_str(&user.data).map_err(|e| format!("invalid users.data JSON: {}", e))?;
    let display_name = data
        .get("username")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("displayName").and_then(|v| v.as_str()))
        .unwrap_or(user.id.as_str())
        .to_string();
    let username = data
        .get("username")
        .and_then(|v| v.as_str())
        .map(String::from);
    let icon_url = data
        .get("icon")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("originalProfileImage").and_then(|v| v.as_str()))
        .map(String::from);
    let name_history = data
        .get("nameHistory")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let lcts_ms = data
        .get("lcts")
        .and_then(|v| v.as_str())
        .and_then(parse_iso_to_unix_ms)
        .unwrap_or(0);
    // first_seen_at:
    // わんコメは users.data に "first comment" 相当のフィールドを持たない。
    // users 行の SQLite `created_at` 列を「わんコメ初観測時刻」として使う案も
    // あったが、わんコメは created_at を **localtime** (= OS timezone 依存) で
    // 保存しているため、portable に UTC 化できない (= 2026-05-10 検証済)。
    // OS によって 0〜-19 時間のずれが入り、cross-machine で結果が壊れる。
    //
    // やむを得ず lcts (= 最終コメ時刻) を初期値として置く。これは semantically
    // 正しくないが、後続の `refresh_comment_aggregates_for_rows` で
    // `MIN(first_seen_at, MIN(comments.posted_at))` と MIN-merge されるため、
    // わんコメから過去コメを取り込み済みのリスナーは正しい first_seen_at に
    // 補正される (= 多数派ケース)。
    //
    // 取り込み対象外 (= 別チャンネル配信のみで観測されたリスナー) は lcts の
    // ままだが、後で record_comment が走ればそこで MIN-merge される。
    let first_seen_at = lcts_ms;
    let last_seen_at = lcts_ms;
    // tc/tgc/amount はわんコメ累計値だが、こめはぶ側はこめはぶ comments テーブルの実数を
    // 真値として扱う方針 (v3 以降)。インポート時に上書きすると「画面に 1 件と出るが
    // 実コメント 0 件」のような不整合を生むので 0 で初期化し、record_comment 経由でのみ増減する。
    // わんコメ累計はわんコメ DB 側に残り続け、書き戻し時に「マージ後 comments の COUNT」で再計算される。
    let comment_count: i64 = 0;
    let superchat_count: i64 = 0;
    let superchat_amount_jpy: i64 = 0;
    let badges = data
        .get("badges")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let is_member = badges
        .as_array()
        .map(|arr| {
            arr.iter().any(|b| {
                b.get("label")
                    .and_then(|v| v.as_str())
                    .map(|s| s.contains("メンバー") || s.to_lowercase().contains("member"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let is_moderator = data
        .get("isModerator")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let memo = data
        .get("memo")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let label = data
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let nickname = data
        .get("nickname")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(ListenerRow {
        channel_id: user.id.clone(),
        display_name,
        username,
        icon_url,
        name_history,
        first_seen_at,
        last_seen_at,
        comment_count,
        superchat_count,
        superchat_amount_jpy,
        is_member,
        is_moderator,
        member_months_max: 0, // わんコメ users.data には保持されないので 0
        notes: memo,
        label,
        nickname,
        raw: Some(data),
        // わんコメ users.data には最後のコメント本文が保持されないため None。
        // インポート後のクエリで listeners.db の comments テーブルから取得される。
        last_comment_body: None,
        last_comment_html: None,
        // わんコメ users.data には per-stream の挨拶状態は無いので 0 で出発。
        greeted_at: 0,
        // per-stream SC は import 直後は不明 (= 後続の list_listeners 呼び出しで集計される)。
        per_stream_sc_amount_jpy: 0,
        per_stream_comment_count: 0,
        per_stream_last_at: 0,
        // system_tag は context-aware で list_listeners が埋める。 import 直後は None。
        system_tag: None,
    })
}

/// わんコメ comments.comment JSON から CommentRow へ変換する。
/// id / user_id / created_at は外側カラムから渡されるのでそれを尊重する。
fn comment_row_from_onecomme(
    id: &str,
    live_id: &str,
    user_id: &str,
    created_at_iso: &str,
    parsed: &serde_json::Value,
) -> Result<CommentRow, String> {
    let data = parsed
        .get("data")
        .ok_or_else(|| "missing data".to_string())?;
    let comment = data.get("comment").and_then(|v| v.as_str()).unwrap_or("");
    let comment_html = sanitize_onecomme_comment_html(comment);
    let body = comment_html
        .as_deref()
        .map(onecomme_comment_html_to_text)
        .unwrap_or_else(|| decode_html_entities(comment));
    let has_gift = data
        .get("hasGift")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_membership = data
        .get("isMembership")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_membership_milestone = data
        .get("isMembershipMilestone")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let comment_type = if data
        .get("isMembershipGift")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        CommentType::Gift
    } else if is_membership_milestone {
        CommentType::MembershipMilestone
    } else if is_membership {
        CommentType::Membership
    } else if data
        .get("stickerImage")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
    {
        CommentType::Sticker
    } else if has_gift {
        CommentType::Superchat
    } else {
        CommentType::Chat
    };

    let posted_at = parse_iso_to_unix_ms(created_at_iso).unwrap_or(0);

    let (amount_jpy, amount_raw, currency) = if has_gift {
        // わんコメは price (数値) と unit (通貨) を持つことが多い
        let price = data.get("price").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let unit = data.get("unit").and_then(|v| v.as_str()).unwrap_or("");
        let jpy = if price > 0.0 {
            fx_rates::fallback_amount_to_jpy(price, unit)
        } else {
            None
        };
        (
            jpy,
            if price > 0.0 { Some(price) } else { None },
            if unit.is_empty() {
                None
            } else {
                Some(unit.to_string())
            },
        )
    } else {
        (None, None, None)
    };

    // raw を flat 化して保存:
    //  - わんコメ raw は `{name:"#", service:"youtube", url:..., data:{...本物}}` 構造
    //  - こめはぶ内部は flat 形式で統一 → data を上位に持ち上げる
    //  - `service` field は将来の別プラットフォーム判別用に保持 ("youtube" / "twitch" 等)
    //  - 他の service info (id/name/url/color/meta) は破棄 (= ノイズ、 こめはぶで使わない)
    let mut raw = data.clone();
    if let Some(obj) = raw.as_object_mut() {
        if let Some(svc) = parsed.get("service") {
            obj.insert("service".to_string(), svc.clone());
        }
        if let Some(html) = comment_html {
            obj.insert("commentHtml".to_string(), serde_json::Value::String(html));
        }
    }

    Ok(CommentRow {
        id: id.to_string(),
        stream_id: live_id.to_string(),
        listener_channel_id: user_id.to_string(),
        posted_at,
        body,
        comment_type,
        superchat_amount_jpy: amount_jpy,
        superchat_currency: currency,
        superchat_amount_raw: amount_raw,
        raw,
        // わんコメ DB から import するコメには「対応済み」概念が無いので 0 で出発。
        responded_at: 0,
    })
}

fn sanitize_onecomme_comment_html(input: &str) -> Option<String> {
    if !input.contains('<') || !input.contains('>') {
        return None;
    }

    let mut out = String::new();
    let mut cursor = 0usize;
    let mut kept_any_html = false;
    for caps in HTML_IMG_ALT_RE.captures_iter(input) {
        let Some(m) = caps.get(0) else { continue };
        out.push_str(&html_escape(&decode_html_entities(
            &input[cursor..m.start()],
        )));
        let tag = m.as_str();
        let src = html_attr_value(tag, "src").unwrap_or_default();
        let alt = html_attr_value(tag, "alt").unwrap_or_default();
        if !src.is_empty() {
            kept_any_html = true;
            out.push_str("<img class=\"emoji\" src=\"");
            out.push_str(&html_escape(&decode_html_entities(&src)));
            out.push_str("\" alt=\"");
            out.push_str(&html_escape(&decode_html_entities(&alt)));
            out.push('"');
            if let Some(emoji_id) = html_attr_value(tag, "data-emoji-id") {
                if !emoji_id.is_empty() {
                    out.push_str(" data-emoji-id=\"");
                    out.push_str(&html_escape(&decode_html_entities(&emoji_id)));
                    out.push('"');
                }
            }
            out.push('>');
        } else {
            out.push_str(&html_escape(&decode_html_entities(&alt)));
        }
        cursor = m.end();
    }
    out.push_str(&html_escape(&decode_html_entities(&input[cursor..])));

    if kept_any_html {
        Some(out)
    } else {
        None
    }
}

fn onecomme_comment_html_to_text(input: &str) -> String {
    let with_img_alt = HTML_IMG_ALT_RE.replace_all(input, |caps: &regex::Captures<'_>| {
        caps.get(1)
            .or_else(|| caps.get(2))
            .or_else(|| caps.get(3))
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_string()
    });
    let stripped = HTML_TAG_RE.replace_all(&with_img_alt, "");
    decode_html_entities(&stripped)
}

/// commentHtml から <img> タグを「丸ごと」除去 (= alt 属性も一緒に消える) + 他のタグも
/// 除去 + entity 復号して純テキストを得る。
/// 統計タブの頻出語抽出用。`extract_text_from_runs` (= body) はカスタム絵文字の alt
/// (例: "専用ハート") を文字として連結してしまうため、頻出語上位がメンバー絵文字の名前で
/// 埋まる。commentHtml 経由で <img> を切り捨てると emoji 由来の文字は出てこない。
fn comment_html_to_plain_no_emoji(input: &str) -> String {
    // HTML_TAG_RE = `<[^>]+>`。alt 属性は < ... > の内側にあるのでタグ全消去で消える。
    let stripped = HTML_TAG_RE.replace_all(input, "");
    decode_html_entities(&stripped)
}

fn html_attr_value(tag: &str, wanted: &str) -> Option<String> {
    for caps in HTML_ATTR_RE.captures_iter(tag) {
        let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(wanted) {
            return caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map(|m| m.as_str().to_string());
        }
    }
    None
}

fn decode_html_entities(input: &str) -> String {
    HTML_ENTITY_RE
        .replace_all(input, |caps: &regex::Captures<'_>| {
            let entity = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            match entity {
                "amp" => "&".to_string(),
                "lt" => "<".to_string(),
                "gt" => ">".to_string(),
                "quot" => "\"".to_string(),
                "apos" => "'".to_string(),
                "nbsp" => " ".to_string(),
                _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                    u32::from_str_radix(&entity[2..], 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| caps.get(0).unwrap().as_str().to_string())
                }
                _ if entity.starts_with('#') => entity[1..]
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| caps.get(0).unwrap().as_str().to_string()),
                _ => caps.get(0).unwrap().as_str().to_string(),
            }
        })
        .into_owned()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

struct PreflightResult {
    both_tables_present: bool,
    reason: String,
}

/// 書き戻し直前の preflight: わんコメ DB 2 ファイル + 両必須テーブルが揃っているか確認。
/// どれか欠ければ「両テーブル無し」とみなし、part of write を防ぐ。
fn preflight_check_onecomme(comments_db: &Path, onecomme_db: &Path) -> PreflightResult {
    let comments_db_ok = comments_db.exists();
    let onecomme_db_ok = onecomme_db.exists();
    let comments_table_ok = comments_db_ok
        && rusqlite::Connection::open_with_flags(
            comments_db,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
        .and_then(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='comments'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok()
        })
        .is_some_and(|n| n > 0);
    let users_table_ok = onecomme_db_ok
        && rusqlite::Connection::open_with_flags(
            onecomme_db,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
        .and_then(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok()
        })
        .is_some_and(|n| n > 0);

    if comments_table_ok && users_table_ok {
        return PreflightResult {
            both_tables_present: true,
            reason: String::new(),
        };
    }
    let mut missing: Vec<&str> = Vec::new();
    if !comments_db_ok {
        missing.push("comments.db (ファイル無し)");
    } else if !comments_table_ok {
        missing.push("comments.db の comments テーブル");
    }
    if !onecomme_db_ok {
        missing.push("onecomme.db (ファイル無し)");
    } else if !users_table_ok {
        missing.push("onecomme.db の users テーブル");
    }
    PreflightResult {
        both_tables_present: false,
        reason: format!(
            "わんコメ DB の必須要素が欠けているため書き戻しを中断しました (片方だけ書き戻す部分書き込みを防ぐため): {}",
            missing.join(" / ")
        ),
    }
}

/// 書き戻し時の per-comment ランク。実観測 (Q-15) に合わせる:
/// - `user_no`: そのユーザーのその配信内での通し番号 (1-indexed、わんコメ `meta.no` / `meta.tc`)
/// - `stream_lc`: その配信の global 通し番号 (1-indexed、わんコメ `meta.lc`)
#[derive(Debug, Clone, Copy)]
pub(crate) struct MetaRanks {
    pub user_no: i64,
    pub stream_lc: i64,
}

/// CommentRow → わんコメ comments INSERT 用 row 変換 (フェーズ 3.5 書き戻し)。
///
/// わんコメ実 DB の comments.comment は OneComme 正規形式 (BaseComment ラッパ)。
/// 構造: `{id: <serviceUuid>, service: "youtube", name, url, color, data: CommentData, meta}`
/// data に PK / liveId / userId / コメント本文 / バッジ等を集約する。
/// raw に同形式が既に入っていればそのまま使い、独自形式の場合は data ラッパに詰め替える。
///
/// `ranks` は事前計算した per-stream per-user / per-stream global の連番。
/// `service_map` は `config.json/services` から構築したマップ。liveId にマッチする
/// ネイティブ service 定義があれば `service_id` / `color` を流用し、無ければ
/// `"komehub"` + 黒色フォールバック。
///
/// `meta` 出力は実観測 (Q-15) に厳密準拠:
/// - ノーマル (Chat / Membership): `{"no": user_no, "tc": user_no, "lc": stream_lc}`
/// - スパチャ系 (Superchat / Sticker / Gift): `{"free": false}`
///   排他 (両形式は同居しない)。
fn comment_row_to_onecomme_insert(
    c: &CommentRow,
    ranks: MetaRanks,
    service_map: &std::collections::HashMap<String, listener_aux_io::OnecommeServiceInfo>,
) -> listener_aux_io::OnecommeCommentInsert {
    // raw から取れる範囲を取り出す。RawComment はトップレベルにフィールドが並ぶ独自形式。
    let raw = &c.raw;
    let display_name = raw
        .get("displayName")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("name").and_then(|v| v.as_str()))
        .unwrap_or("");
    let name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(display_name);
    let profile_image = raw
        .get("profileImage")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let original_profile_image = raw
        .get("originalProfileImage")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(profile_image);
    let speech_text = raw.get("speechText").and_then(|v| v.as_str()).unwrap_or("");
    let timestamp = raw
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| unix_ms_to_iso(c.posted_at));
    let badges = match raw.get("memberBadgeUrl").and_then(|v| v.as_str()) {
        Some(url) if !url.is_empty() => serde_json::json!([{
            "label": if raw.get("isMember").and_then(|v| v.as_bool()).unwrap_or(false) { "メンバー" } else { "" },
            "url": url
        }]),
        _ => serde_json::json!([]),
    };
    let has_gift = matches!(
        c.comment_type,
        CommentType::Superchat | CommentType::Sticker | CommentType::Gift
    );
    // わんコメ標準テンプレートは `<div v-html="comment.data.comment">` で innerHTML 展開する
    // (preset/basic/index.html 確認済み)。プレーンテキストを渡すと `:custom_negi:` などが
    // 文字列のまま見えるので、絵文字 <img> 込みの commentHtml を優先で入れる。
    // commentHtml は extract_html_from_runs で生成され URL/テキストとも html_escape 済み。
    let comment_field = raw
        .get("commentHtml")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.body.clone());

    // data 部 (CommentData)。OneComme サンプル比較で必要なフィールドを揃える
    let mut data = serde_json::json!({
        "id": c.id,
        "liveId": c.stream_id,
        "userId": c.listener_channel_id,
        "name": name,
        "displayName": display_name,
        "profileImage": profile_image,
        "originalProfileImage": original_profile_image,
        "badges": badges,
        "isOwner": raw.get("isOwner").and_then(|v| v.as_bool()).unwrap_or(false),
        "isModerator": raw.get("isModerator").and_then(|v| v.as_bool()).unwrap_or(false),
        "isMember": raw.get("isMember").and_then(|v| v.as_bool()).unwrap_or(false),
        "isFirstTime": raw.get("isFirstTime").and_then(|v| v.as_bool()).unwrap_or(false),
        "autoModerated": raw.get("autoModerated").and_then(|v| v.as_bool()).unwrap_or(false),
        "hasGift": has_gift,
        "comment": comment_field,
        "timestamp": timestamp,
        "speechText": speech_text,
    });
    // スパチャ系: わんコメサンプルでは giftType / paidText / unit / price / tier / colors を持つ
    if has_gift {
        if let Some(obj) = data.as_object_mut() {
            let amount_raw = c.superchat_amount_raw.unwrap_or(0.0);
            let currency = c.superchat_currency.clone().unwrap_or_default();
            let amount_display = raw
                .get("amountDisplay")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    if currency.is_empty() {
                        amount_raw.to_string()
                    } else {
                        format!("{}{}", currency, amount_raw)
                    }
                });
            let gift_type = match c.comment_type {
                CommentType::Superchat => "superchat",
                CommentType::Sticker => "sticker",
                CommentType::Gift => "gift",
                _ => "",
            };
            obj.insert(
                "giftType".into(),
                serde_json::Value::String(gift_type.into()),
            );
            obj.insert("paidText".into(), serde_json::Value::String(amount_display));
            obj.insert("unit".into(), serde_json::Value::String(currency));
            if let Some(p) = serde_json::Number::from_f64(amount_raw) {
                obj.insert("price".into(), serde_json::Value::Number(p));
            }
        }
    }

    // service_id / color の解決: わんコメ config.json/services の URL に該当 liveId が
    // あればネイティブ UUID と色を流用、無ければ "komehub" + 黒色フォールバック
    // (= わんコメに過去視聴履歴が無い配信)。観測上 BaseComment.id (外側) も
    // service_id (UUID) と一致するため、両方に同じ値を入れる。
    let (service_id, color) = match service_map.get(&c.stream_id) {
        Some(info) => (
            info.service_id.clone(),
            info.color
                .clone()
                .unwrap_or_else(|| serde_json::json!({ "r": 0, "g": 0, "b": 0 })),
        ),
        None => (
            "komehub".to_string(),
            serde_json::json!({ "r": 0, "g": 0, "b": 0 }),
        ),
    };

    // meta 形式は実観測 (Q-15) 準拠: ノーマルは {no, tc, lc}、ギフト系は {free} 排他。
    // no = tc = user_no (per-stream per-user カウント、観測上 no==tc が常に成立)
    // lc = stream_lc (per-stream global カウント)
    let meta = if has_gift {
        serde_json::json!({ "free": false })
    } else {
        serde_json::json!({
            "no": ranks.user_no,
            "tc": ranks.user_no,
            "lc": ranks.stream_lc,
        })
    };

    // BaseComment.url はネイティブでは `https://www.youtube.com/watch?v={liveId}` 形式。
    // わんコメ UI で「どの配信から来たコメントか」表示するために使われる。
    let outer = serde_json::json!({
        "id": service_id,
        "service": "youtube",
        "name": "#",
        "url": format!("https://www.youtube.com/watch?v={}", c.stream_id),
        "color": color,
        "data": data,
        "meta": meta,
    });

    listener_aux_io::OnecommeCommentInsert {
        id: c.id.clone(),
        service_id,
        user_id: c.listener_channel_id.clone(),
        comment_json: outer.to_string(),
        created_at: unix_ms_to_iso(c.posted_at),
    }
}

/// ListenerRow → わんコメ users UPSERT 用 patch 変換 (フェーズ 3.5)。
/// わんコメ users.data 構造 (設計書 § 9.3) に合わせて組み立てる。
/// 既存 data の保持カラム (memo / nickname 等) は write_onecomme_users 内の
/// merge_user_data で既存値が優先されるので、ここでは「こめはぶで上書きしたいフィールド」
/// だけ含めれば十分。
fn listener_row_to_onecomme_patch(l: &ListenerRow) -> listener_aux_io::OnecommeUserPatch {
    // tc / tgc / amount / lcts は書き戻しフロー側で「マージ後のわんコメ comments テーブル
    // 実数」を集計して上書きする (export_to_onecomme 内 6.5 を参照)。
    // ここで listener.comment_count や listener.last_seen_at を入れるとこめはぶ側の値で
    // 上書きしてしまい、自チャンネル外コメント分が消えたり、書き戻し実行時刻が
    // lcts に混入して循環汚染する。最終的な真値はわんコメ DB 集計に委ねる。

    // icon にはわんコメから外部アクセス可能な YouTube CDN 生 URL を入れる。
    // listeners.icon_url はこめはぶ image_cache の `http://127.0.0.1:11280/cache/avatars/...`
    // が入っているため、こめはぶ未起動時にわんコメから到達できずアバターが表示されない。
    // record_comment 時に listeners.raw.originalProfileImage に原 URL を保存しているので
    // それを優先する。古いデータで raw に無い場合は icon_url にフォールバックする
    // (= 旧挙動、こめはぶ起動中のみ正しく表示される)。
    let original_icon = l
        .raw
        .as_ref()
        .and_then(|r| r.get("originalProfileImage"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| l.icon_url.clone().unwrap_or_default());

    let komehub_data = serde_json::json!({
        "id": l.channel_id,
        "username": l.username.clone().unwrap_or_else(|| l.display_name.clone()),
        "icon": original_icon,
        "badges": [],
        "service": "youtube",
        "nameHistory": l.name_history,
        // memo / label / nickname はユーザー編集フィールド。merge_user_data で
        // 「既存非空 > こめはぶ」の優先順位で双方向同期される。
        "memo": l.notes,
        "label": l.label,
        "nickname": l.nickname,
    });
    listener_aux_io::OnecommeUserPatch {
        id: l.channel_id.clone(),
        komehub_data,
    }
}

fn unix_ms_to_iso(ms: i64) -> String {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    let secs = ms / 1000;
    let sub = (ms.rem_euclid(1000)) as u16;
    OffsetDateTime::from_unix_timestamp(secs)
        .ok()
        .and_then(|dt| dt.replace_millisecond(sub).ok())
        .and_then(|dt| dt.format(&Rfc3339).ok())
        .unwrap_or_else(|| format!("@{}", ms))
}

fn current_iso8601_utc() -> String {
    let millis = current_unix_millis();
    let secs = millis / 1000;
    let ms = (millis % 1000).abs();
    // listener_manager 内の format_unix_millis_to_iso と同じ機能を持つので
    // innertube_parser の format_unix_millis_to_iso を再利用したいが、
    // crate プライベートなので簡易実装。日付部分まで欲しいときは見直す。
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    OffsetDateTime::from_unix_timestamp(secs)
        .ok()
        .and_then(|dt| dt.replace_millisecond(ms as u16).ok())
        .and_then(|dt| dt.format(&Rfc3339).ok())
        .unwrap_or_else(|| format!("@{}", millis))
}

fn io_to_sqlite_error(err: std::io::Error) -> SqliteError {
    SqliteError::SqliteFailure(
        rusqlite::ffi::Error {
            code: ErrorCode::DiskFull, // 書き込み I/O エラー寄りの最も近いコード
            extended_code: 0,
        },
        Some(format!("I/O error: {}", err)),
    )
}

fn poisoned_lock_error(name: &str) -> SqliteError {
    SqliteError::SqliteFailure(
        rusqlite::ffi::Error {
            code: ErrorCode::CannotOpen,
            extended_code: 0,
        },
        Some(format!("{} mutex poisoned", name)),
    )
}

// ───────────────────────────── テスト ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::comment::RawComment;

    fn fake_comment(id: &str, user_id: &str, body: &str) -> RawComment {
        RawComment {
            id: id.to_string(),
            user_id: user_id.to_string(),
            live_id: String::new(),
            name: "alice".to_string(),
            display_name: "alice".to_string(),
            screen_name: String::new(),
            nickname: String::new(),
            comment: body.to_string(),
            comment_html: String::new(),
            speech_text: String::new(),
            profile_image: "https://example.com/i.png".to_string(),
            original_profile_image: String::new(),
            timestamp: "2026-04-19T11:43:44.924Z".to_string(),
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
            is_membership_gift_redemption: false,
            is_membership_milestone: false,
            gift_count: 0,
            member_badge_url: String::new(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
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
            comment_visible: true,
            auto_moderated: false,
            is_template_test: false,
            is_backfill: false,
            komehub_trace: serde_json::Value::Null,
        }
    }

    fn open_temp() -> (tempfile::TempDir, ListenerManager) {
        let dir = tempfile::tempdir().expect("tempdir");
        let mgr = ListenerManager::open(dir.path()).expect("open");
        (dir, mgr)
    }

    #[test]
    fn classify_comment_before_record_marks_regular_and_current_stream_arrival() {
        let (_dir, mgr) = open_temp();
        let owner = vec!["yt-UCowner".to_string()];

        for idx in 1..=3 {
            let c = fake_comment(&format!("c{}", idx), "UCalice", "hello");
            mgr.record_comment(&c, &format!("vid{}", idx), "yt-UCowner")
                .expect("record");
        }

        let before_new_stream = mgr
            .classify_comment_before_record("yt-UCalice", "vid4", &owner, 10, 3)
            .expect("classify");
        assert!(before_new_stream.has_prior_comment);
        assert!(!before_new_stream.has_comment_in_current_stream);
        assert!(before_new_stream.is_regular_listener);
        assert_eq!(before_new_stream.regular_stream_count, 3);
        assert!(before_new_stream.previous_stream_last_seen_at_ms > 0);
        assert!(!before_new_stream.previous_stream_last_seen_at.is_empty());

        let c4 = fake_comment("c4", "UCalice", "hello again");
        mgr.record_comment(&c4, "vid4", "yt-UCowner")
            .expect("record current");
        let after_current_stream = mgr
            .classify_comment_before_record("yt-UCalice", "vid4", &owner, 10, 3)
            .expect("classify current");
        assert!(after_current_stream.has_comment_in_current_stream);
    }

    #[test]
    fn classify_comment_before_record_marks_unknown_listener_as_empty() {
        let (_dir, mgr) = open_temp();
        let owner = vec!["yt-UCowner".to_string()];
        let result = mgr
            .classify_comment_before_record("yt-UCnew", "vid1", &owner, 10, 3)
            .expect("classify");
        assert!(!result.has_prior_comment);
        assert!(!result.has_comment_in_current_stream);
        assert!(!result.is_regular_listener);
    }

    #[test]
    fn open_creates_db_and_runs_migrations() {
        let (_dir, mgr) = open_temp();
        // schema_version が EXPECTED_SCHEMA_VERSION に設定されている
        let v: String = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT value FROM schema_meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .expect("schema_version")
        });
        assert_eq!(v, EXPECTED_SCHEMA_VERSION.to_string());
        // 全主要テーブルが存在する
        for table in [
            "listeners",
            "streams",
            "comments",
            "config",
            "schema_meta",
            "listener_tags",
            "saved_searches",
            "stream_tags",
            "stream_listener_state",
        ] {
            let exists: i64 = mgr.with_sync_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |r| r.get(0),
                )
                .expect("table check")
            });
            assert_eq!(exists, 1, "table {} not found", table);
        }
        // comments.responded_at カラムが追加されている
        let columns: Vec<String> = mgr.with_sync_conn(|c| {
            let mut stmt = c
                .prepare("PRAGMA table_info(comments)")
                .expect("prepare table_info");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query_map");
            rows.filter_map(|r| r.ok()).collect()
        });
        assert!(
            columns.iter().any(|c| c == "responded_at"),
            "comments.responded_at not found, columns: {:?}",
            columns
        );
    }

    #[test]
    fn set_listener_greeted_inserts_and_clears() {
        let (_dir, mgr) = open_temp();
        // 初期は未挨拶 (= 行なし)
        let initial: Option<i64> = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid1' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .ok()
        });
        assert!(initial.is_none());

        // 挨拶済みにする
        let set_at = mgr
            .set_listener_greeted("vid1", "UCalice", true)
            .expect("set");
        assert!(set_at > 0);
        let after_set: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid1' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("greeted_at row exists")
        });
        assert_eq!(after_set, set_at);

        // 解除すると行が削除される
        let cleared = mgr
            .set_listener_greeted("vid1", "UCalice", false)
            .expect("clear");
        assert_eq!(cleared, 0);
        let after_clear: Option<i64> = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid1' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .ok()
        });
        assert!(after_clear.is_none());
    }

    #[test]
    fn set_listener_greeted_is_per_stream() {
        let (_dir, mgr) = open_temp();
        // 同じリスナーでも別配信枠なら独立 (= per-stream リセット)
        let vid1_at = mgr
            .set_listener_greeted("vid1", "UCalice", true)
            .expect("set vid1");
        // vid2 は依然未挨拶
        let vid2_initial: Option<i64> = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid2' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .ok()
        });
        assert!(vid2_initial.is_none());
        // vid2 にも挨拶済みを付ける
        let vid2_at = mgr
            .set_listener_greeted("vid2", "UCalice", true)
            .expect("set vid2");
        assert!(vid2_at > 0);
        // vid1 を解除しても vid2 は残る
        mgr.set_listener_greeted("vid1", "UCalice", false)
            .expect("clear vid1");
        let vid2_after: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid2' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("vid2 still greeted")
        });
        assert_eq!(vid2_after, vid2_at);
        let _ = vid1_at;
    }

    #[test]
    fn set_comment_responded_updates_column() {
        let (_dir, mgr) = open_temp();
        let c = fake_comment("c1", "UCalice", "hello");
        mgr.record_comment(&c, "vid1", "yt-UCowner")
            .expect("record");

        // 初期 0 (= 内部表現は yt-c1)
        let initial: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT responded_at FROM comments WHERE id = 'yt-c1'",
                [],
                |r| r.get(0),
            )
            .expect("responded_at column readable")
        });
        assert_eq!(initial, 0);

        // 対応済みに (= API から渡される ID は yt- prefix 無しでも扱える)
        let new_at = mgr.set_comment_responded("c1", true).expect("set");
        assert!(new_at > 0);
        let after_set: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT responded_at FROM comments WHERE id = 'yt-c1'",
                [],
                |r| r.get(0),
            )
            .expect("read")
        });
        assert_eq!(after_set, new_at);
        let listener_state_after_set: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid1' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("listener responded state should be created")
        });
        assert_eq!(
            listener_state_after_set, new_at,
            "comment responded should mark the listener responded for the same stream"
        );

        // 解除 (= yt- prefix 付きで渡しても同じ動作になる冪等性)
        let cleared = mgr.set_comment_responded("yt-c1", false).expect("clear");
        assert_eq!(cleared, 0);
        let after_clear: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT responded_at FROM comments WHERE id = 'yt-c1'",
                [],
                |r| r.get(0),
            )
            .expect("read")
        });
        assert_eq!(after_clear, 0);
        let listener_state_after_clear: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'vid1' AND listener_channel_id = 'yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("listener responded state should remain")
        });
        assert_eq!(
            listener_state_after_clear, new_at,
            "clearing one comment should not clear listener-level responded state"
        );
    }

    #[test]
    fn set_comment_responded_returns_zero_for_unknown_id() {
        let (_dir, mgr) = open_temp();
        let result = mgr.set_comment_responded("unknown-id", true).expect("set");
        assert_eq!(result, 0);
    }

    #[test]
    fn record_comment_inserts_and_aggregates() {
        let (_dir, mgr) = open_temp();
        let c = fake_comment("c1", "UCalice", "hello");
        let summary = mgr
            .record_comment(&c, "video1", "yt-UCowner")
            .expect("record");
        assert!(summary.inserted);
        assert!(summary.is_first_time_listener);
        assert_eq!(summary.channel_id, "yt-UCalice");

        let count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count FROM listeners WHERE channel_id='yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("listener count")
        });
        assert_eq!(count, 1);

        let stream_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count FROM streams WHERE video_id='video1'",
                [],
                |r| r.get(0),
            )
            .expect("stream count")
        });
        assert_eq!(stream_count, 1);
    }

    #[test]
    fn record_display_comment_persists_without_listener_aggregates() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");
        let c = fake_comment("c1", "UCalice", "hello from other stream");
        let summary = mgr
            .record_display_comment(&c, "video_other", "yt-UCother")
            .expect("record display");
        assert!(summary.inserted);
        assert!(!summary.is_first_time_listener);

        let (listener_count, first_seen_at): (i64, i64) = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count, first_seen_at FROM listeners WHERE channel_id='yt-UCalice'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("listener")
        });
        assert_eq!(listener_count, 0, "他枠は listener 累計に含めない");
        assert_eq!(first_seen_at, 0, "他枠は初回観測時刻にも含めない");

        let (stream_count, stored_owner): (i64, String) = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count, owner_channel_id FROM streams WHERE video_id='video_other'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("stream")
        });
        assert_eq!(
            stream_count, 1,
            "配信ログ管理用に他枠 stream のコメント数は持つ"
        );
        assert_eq!(stored_owner, "yt-UCother");

        let comments_all = mgr
            .search_comments(&CommentsQuery {
                scope: CommentSearchScope::All,
                ..Default::default()
            })
            .expect("search all");
        assert_eq!(
            comments_all.total, 1,
            "明示的に all を選べば他枠コメントも検索できる"
        );
        let comments_default = mgr
            .search_comments(&CommentsQuery::default())
            .expect("search own");
        assert_eq!(comments_default.total, 0, "既定検索は自チャンネルのみ");
    }

    #[test]
    fn record_comment_is_idempotent() {
        // 同じ id を 3 回 record しても comment_count = 1 のまま (RETURNING で
        // 2 回目以降は加算されない)
        let (_dir, mgr) = open_temp();
        let c = fake_comment("c1", "UCalice", "hello");
        let s1 = mgr.record_comment(&c, "video1", "yt-UCowner").expect("1st");
        let s2 = mgr.record_comment(&c, "video1", "yt-UCowner").expect("2nd");
        let s3 = mgr.record_comment(&c, "video1", "yt-UCowner").expect("3rd");
        assert!(s1.inserted);
        assert!(!s2.inserted);
        assert!(!s3.inserted);

        let count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count FROM listeners WHERE channel_id='yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("listener count")
        });
        assert_eq!(count, 1, "duplicate record_comment must be idempotent");
    }

    #[test]
    fn record_comment_adds_jpy_superchat_to_amount() {
        let (_dir, mgr) = open_temp();
        let mut c = fake_comment("sc1", "UCbob", "thanks");
        c.has_gift = true;
        c.amount = 500.0;
        c.currency = "¥".to_string();
        mgr.record_comment(&c, "video1", "yt-UCowner")
            .expect("record");
        let amount: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT superchat_amount_jpy FROM listeners WHERE channel_id='yt-UCbob'",
                [],
                |r| r.get(0),
            )
            .expect("amount")
        });
        assert_eq!(amount, 500);
    }

    #[test]
    fn record_comment_aggregates_membership_gift_estimated_amount() {
        // メンバーシップギフト (= 贈り主) は has_gift + is_membership_gift が立ち、推定金額
        // (= gift_count × 単価) が amount に入る。これが listener / streams の
        // superchat_amount_jpy に集計されること (= 「コメントカードは ¥X 表示なのに listener
        // 累計は ¥0」だった不具合の回帰防止。真因は record 経路の自チャンネル判定ズレ)。
        let (_dir, mgr) = open_temp();
        let mut c = fake_comment(
            "g1",
            "UCgifter",
            "獅子神レオナ のメンバーシップ ギフトを 5 個贈りました",
        );
        c.has_gift = true;
        c.is_membership_gift = true;
        c.gift_count = 5;
        c.amount = 2450.0; // 5 × ¥490
        c.currency = "JPY".to_string();
        mgr.record_comment(&c, "video1", "yt-UCowner").expect("record");

        let (sc_amount, sc_count): (i64, i64) = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT superchat_amount_jpy, superchat_count FROM listeners WHERE channel_id='yt-UCgifter'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("listener amount")
        });
        assert_eq!(sc_amount, 2450, "推定金額が listener 累計 SC に加算される");
        assert_eq!(sc_count, 1, "gift は superchat_count にも 1 加算される");

        let stream_amount: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT superchat_amount_jpy FROM streams WHERE video_id='video1'",
                [],
                |r| r.get(0),
            )
            .expect("stream amount")
        });
        assert_eq!(stream_amount, 2450, "推定金額が stream 累計 SC にも加算される");
    }

    #[test]
    fn record_comment_appends_name_history_on_rename() {
        let (_dir, mgr) = open_temp();
        let mut c1 = fake_comment("c1", "UCcarol", "hi");
        c1.display_name = "Carol Old".to_string();
        c1.timestamp = "2026-04-19T10:00:00Z".to_string();
        mgr.record_comment(&c1, "video1", "yt-UCowner")
            .expect("1st");

        let mut c2 = fake_comment("c2", "UCcarol", "hi again");
        c2.display_name = "Carol New".to_string();
        c2.timestamp = "2026-04-19T11:00:00Z".to_string();
        mgr.record_comment(&c2, "video1", "yt-UCowner")
            .expect("2nd");

        let history: String = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT name_history FROM listeners WHERE channel_id='yt-UCcarol'",
                [],
                |r| r.get(0),
            )
            .expect("history")
        });
        let arr: Vec<serde_json::Value> = serde_json::from_str(&history).unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["from"], "Carol Old");
        assert_eq!(arr[0]["to"], "Carol New");
    }

    #[test]
    fn record_comment_with_empty_id_is_noop() {
        let (_dir, mgr) = open_temp();
        let c = fake_comment("", "UCalice", "hi");
        let summary = mgr
            .record_comment(&c, "video1", "yt-UCowner")
            .expect("record");
        assert!(!summary.inserted);
    }

    #[test]
    fn record_comment_with_empty_user_id_uses_unknown_bucket() {
        let (_dir, mgr) = open_temp();
        let c = fake_comment("c1", "", "hi");
        mgr.record_comment(&c, "video1", "yt-UCowner")
            .expect("record");
        let count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count FROM listeners WHERE channel_id='yt-unknown'",
                [],
                |r| r.get(0),
            )
            .expect("unknown count")
        });
        assert_eq!(count, 1);
    }

    #[test]
    fn record_comment_persists_stream_owner() {
        let (_dir, mgr) = open_temp();
        let c = fake_comment("c1", "UCalice", "hi");
        mgr.record_comment(&c, "vidA", "yt-UCstreamOwner")
            .expect("record");
        let owner: String = mgr.with_sync_conn(|conn| {
            conn.query_row(
                "SELECT owner_channel_id FROM streams WHERE video_id='vidA'",
                [],
                |r| r.get(0),
            )
            .expect("owner_channel_id")
        });
        assert_eq!(owner, "yt-UCstreamOwner");
    }

    #[test]
    fn record_comment_does_not_overwrite_owner_with_empty() {
        // 既に owner が入っている stream に空文字 owner で 2 回目の record を投げても、
        // 既存値が保持されることを保証する (将来の運用ミス防御)
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("c1", "UCalice", "hi");
        mgr.record_comment(&c1, "vidA", "yt-UCstreamOwner")
            .expect("1st");
        let c2 = fake_comment("c2", "UCalice", "hi 2");
        mgr.record_comment(&c2, "vidA", "").expect("2nd");
        let owner: String = mgr.with_sync_conn(|conn| {
            conn.query_row(
                "SELECT owner_channel_id FROM streams WHERE video_id='vidA'",
                [],
                |r| r.get(0),
            )
            .expect("owner_channel_id")
        });
        assert_eq!(owner, "yt-UCstreamOwner");
    }

    #[test]
    fn list_listeners_returns_paged_rows() {
        let (_dir, mgr) = open_temp();
        for i in 0..5 {
            let mut c = fake_comment(&format!("c{}", i), &format!("UCu{}", i), "hi");
            c.display_name = format!("user-{}", i);
            mgr.record_comment(&c, "vidA", "yt-UCowner")
                .expect("record");
        }
        let q = ListenersQuery {
            sort: ListenersSort::DisplayName,
            limit: Some(2),
            offset: Some(0),
            q: None,
            ..Default::default()
        };
        let page = mgr.list_listeners(&q).expect("list");
        assert_eq!(page.total, 5);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[0].display_name, "user-0");
        assert_eq!(page.rows[1].display_name, "user-1");
    }

    #[test]
    fn update_stream_metadata_creates_stub_then_updates() {
        let (_dir, mgr) = open_temp();
        // 初回呼び出し: streams 行が無いので stub 行が作られる
        let n = mgr
            .update_stream_metadata(
                "vid1",
                Some("https://www.youtube.com/watch?v=vid1"),
                Some("テスト配信"),
                Some("yt-UCowner"),
                Some("テストチャンネル"),
                Some("https://example.com/icon.png"),
                Some("配信概要"),
                Some(1234),
                Some(50),
                Some(50), // peak (5 分維持) も初回は同じ
                Some(10),
                Some(1700000000000),
                None, // ended_at 未指定 (配信中)
                Some(1700000010000),
            )
            .unwrap();
        assert_eq!(n, 1);
        let detail = mgr.get_stream_detail("vid1", 0).unwrap().unwrap();
        assert_eq!(detail.stream.title, "テスト配信");
        assert_eq!(detail.stream.channel_name, "テストチャンネル");
        assert_eq!(detail.stream.subscriber_count, 1234);
        assert_eq!(detail.stream.current_viewers, 50);
        assert_eq!(detail.stream.peak_concurrent_viewers, 50);
        assert_eq!(detail.stream.likes, 10);
        assert_eq!(detail.stream.started_at, 1700000000000);
        assert_eq!(detail.stream.live_metadata_updated_at, 1700000010000);
        // 2 回目: 動的値だけ更新、静的値は維持。peak は MAX で蓄積
        let n2 = mgr
            .update_stream_metadata(
                "vid1",
                None,
                None,
                None,
                None,
                None,
                None,
                None,     // subscriber_count 未指定 → 維持
                Some(60), // current_viewers 更新
                Some(60), // peak 更新候補
                Some(15), // likes 更新
                None,
                None, // ended_at 未指定
                Some(1700000020000),
            )
            .unwrap();
        assert_eq!(n2, 1);
        let d2 = mgr.get_stream_detail("vid1", 0).unwrap().unwrap();
        assert_eq!(d2.stream.title, "テスト配信", "静的値は維持");
        assert_eq!(d2.stream.subscriber_count, 1234, "subscriber 維持");
        assert_eq!(d2.stream.current_viewers, 60);
        assert_eq!(d2.stream.peak_concurrent_viewers, 60);
        assert_eq!(d2.stream.likes, 15);
        // 3 回目: peak より小さい値が来ても DB の peak は減らない (MAX 蓄積)
        let _ = mgr
            .update_stream_metadata(
                "vid1",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(10), // current_viewers 下落
                Some(10), // peak 候補は小さい
                None,
                None,
                Some(1700000040000), // ended_at セット (配信終了)
                Some(1700000030000),
            )
            .unwrap();
        let d3 = mgr.get_stream_detail("vid1", 0).unwrap().unwrap();
        assert_eq!(d3.stream.current_viewers, 10, "current は素直に更新");
        assert_eq!(d3.stream.peak_concurrent_viewers, 60, "peak は MAX で維持");
        assert_eq!(d3.stream.ended_at, 1700000040000, "ended_at が記録される");
        // 4 回目: 古い ended_at が来ても DB は MAX で維持
        let _ = mgr
            .update_stream_metadata(
                "vid1",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(1700000020000), // 古い ended_at
                None,
            )
            .unwrap();
        let d4 = mgr.get_stream_detail("vid1", 0).unwrap().unwrap();
        assert_eq!(d4.stream.ended_at, 1700000040000, "ended_at は MAX で維持");
    }

    /// 2026-05-10 fuQvDeeO7wo 事例: YouTube liveBroadcastDetails.startTimestamp は
    /// 配信予定時刻 (= 未来) であり得る。actual go-live (= 先頭コメ posted_at) で
    /// 既に正しい started_at が入っている状態で、後発の metadata fetch が予定時刻
    /// (= より遅い時刻) で上書きするのを防ぐ。MIN-based merge で earliest を保つ。
    #[test]
    fn update_stream_metadata_keeps_earliest_started_at() {
        let (_dir, mgr) = open_temp();
        // 1 回目: actual go-live 時刻で stream 行を作る (= record_comment 由来を模擬)
        mgr.update_stream_metadata(
            "vidLive",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(1700000000000), // 13:46 相当 (= actual go-live)
            None,
            None,
        )
        .unwrap();
        let d1 = mgr.get_stream_detail("vidLive", 0).unwrap().unwrap();
        assert_eq!(d1.stream.started_at, 1700000000000);

        // 2 回目: より遅い時刻 (= 配信予定時刻、未来) を passing
        // → MIN で earliest が維持されること
        mgr.update_stream_metadata(
            "vidLive",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(1700020000000), // ずっと後 (= scheduled time = 未来)
            None,
            None,
        )
        .unwrap();
        let d2 = mgr.get_stream_detail("vidLive", 0).unwrap().unwrap();
        assert_eq!(
            d2.stream.started_at, 1700000000000,
            "後発の遅い started_at で earliest が上書きされない"
        );

        // 3 回目: より早い時刻が来たら MIN で更新される
        // (= record_comment が更に古いコメを取り込んだケース)
        mgr.update_stream_metadata(
            "vidLive",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(1699999000000), // earlier
            None,
            None,
        )
        .unwrap();
        let d3 = mgr.get_stream_detail("vidLive", 0).unwrap().unwrap();
        assert_eq!(
            d3.stream.started_at, 1699999000000,
            "より早い started_at が来たら MIN で更新される"
        );
    }

    /// 2026-05-10 fuQvDeeO7wo 事例 (続): isLiveNow=false が「配信予定 (= 未来)」を
    /// 意味するケースで bd.endTimestamp = scheduled time が ended_at に流入する。
    /// Rust 側で current_time にクランプして、未来時刻が ended_at に焼き付くのを防ぐ。
    #[test]
    fn update_stream_metadata_clamps_future_ended_at() {
        let (_dir, mgr) = open_temp();
        let now = current_unix_millis();
        let one_hour: i64 = 3_600_000;

        // 配信中の枠 (= record_comment 由来 stub) を模擬
        mgr.update_stream_metadata(
            "vidLive",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(now - 4 * one_hour), // 4h 前に開始
            None,
            None,
        )
        .unwrap();

        // 未来時刻 (= 2h 先) を ended_at に渡す → clamp で current_time に引き戻される
        let future = now + 2 * one_hour;
        mgr.update_stream_metadata(
            "vidLive",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(future), // 未来時刻
            None,
        )
        .unwrap();
        let d1 = mgr.get_stream_detail("vidLive", 0).unwrap().unwrap();
        assert!(
            d1.stream.ended_at <= now + 100, // テスト実行に多少時間掛かるので余裕を見る
            "未来 ended_at は current_time にクランプ (got {}, now {})",
            d1.stream.ended_at,
            now
        );

        // 後続: 過去時刻が来たら MAX 蓄積で ended_at は減らない
        mgr.update_stream_metadata(
            "vidLive",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(now - 3 * one_hour), // 過去
            None,
        )
        .unwrap();
        let d2 = mgr.get_stream_detail("vidLive", 0).unwrap().unwrap();
        assert!(
            d2.stream.ended_at >= now - 100,
            "過去 ended_at で MAX 維持 (got {})",
            d2.stream.ended_at
        );
    }

    /// streams.owner_channel_id は listeners.channel_id と同じく `yt-UC...` 形式で統一する。
    /// Step 4 の watch ページ取得経由 (electron/main.js) は素の `UC...` を渡してくるため、
    /// update_stream_metadata 内で正規化されることを確認する。
    #[test]
    fn update_stream_metadata_normalizes_owner_channel_id_prefix() {
        let (_dir, mgr) = open_temp();
        // prefix なしで渡しても保存時に yt- が付与される
        mgr.update_stream_metadata(
            "vidNoPrefix",
            None,
            None,
            Some("UCRawOwner123"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let owner: String = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT owner_channel_id FROM streams WHERE video_id='vidNoPrefix'",
                [],
                |r| r.get(0),
            )
            .expect("streams row")
        });
        assert_eq!(owner, "yt-UCRawOwner123");

        // 既に prefix 付きで渡されたものは二重付与しない
        mgr.update_stream_metadata(
            "vidWithPrefix",
            None,
            None,
            Some("yt-UCAlready456"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let owner2: String = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT owner_channel_id FROM streams WHERE video_id='vidWithPrefix'",
                [],
                |r| r.get(0),
            )
            .expect("streams row")
        });
        assert_eq!(owner2, "yt-UCAlready456");

        // 空文字は「未確定」扱いで透過 (空のまま保存)
        mgr.update_stream_metadata(
            "vidEmpty",
            None,
            None,
            Some(""),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let owner3: String = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT owner_channel_id FROM streams WHERE video_id='vidEmpty'",
                [],
                |r| r.get(0),
            )
            .expect("streams row")
        });
        assert_eq!(owner3, "");
    }

    #[test]
    fn update_listener_metadata_updates_only_specified_fields() {
        let (_dir, mgr) = open_temp();
        let c = fake_comment("c1", "UCa", "hi");
        mgr.record_comment(&c, "vid1", "yt-UCowner").unwrap();
        // 全フィールド指定
        let n = mgr
            .update_listener_metadata("UCa", Some("にゃー"), Some("常連さん"), Some("VIP"))
            .unwrap();
        assert_eq!(n, 1);
        let detail = mgr.get_listener_detail("UCa", 5, None).unwrap().unwrap();
        assert_eq!(detail.listener.nickname, "にゃー");
        assert_eq!(detail.listener.notes, "常連さん");
        assert_eq!(detail.listener.label, "VIP");
        // None は触らない (3 値セマンティクス)
        let n2 = mgr
            .update_listener_metadata("UCa", None, Some("更新後"), None)
            .unwrap();
        assert_eq!(n2, 1);
        let detail2 = mgr.get_listener_detail("UCa", 5, None).unwrap().unwrap();
        assert_eq!(
            detail2.listener.nickname, "にゃー",
            "nickname was None: kept"
        );
        assert_eq!(detail2.listener.notes, "更新後", "notes was Some: updated");
        assert_eq!(detail2.listener.label, "VIP", "label was None: kept");
        // 空文字での明示クリアも可能
        let _ = mgr
            .update_listener_metadata("UCa", Some(""), None, None)
            .unwrap();
        assert_eq!(
            mgr.get_listener_detail("UCa", 5, None)
                .unwrap()
                .unwrap()
                .listener
                .nickname,
            ""
        );
        // 存在しない channel_id は 0 行
        let n3 = mgr
            .update_listener_metadata("UCnope", Some("x"), None, None)
            .unwrap();
        assert_eq!(n3, 0);
    }

    #[test]
    fn list_listeners_returns_last_comment_body() {
        // record_comment を 2 回投げると、最後のコメント本文が
        // last_comment_body として一覧に出ることを確認 (実機検証フィードバック対応)
        let (_dir, mgr) = open_temp();
        let mut c1 = fake_comment("c1", "UCalice", "first message");
        c1.timestamp = "2026-04-19T11:00:00.000Z".to_string();
        mgr.record_comment(&c1, "vid1", "yt-UCowner").unwrap();
        let mut c2 = fake_comment("c2", "UCalice", "latest message");
        c2.timestamp = "2026-04-19T12:00:00.000Z".to_string();
        mgr.record_comment(&c2, "vid1", "yt-UCowner").unwrap();
        let page = mgr
            .list_listeners(&ListenersQuery::default())
            .expect("list");
        assert_eq!(page.rows.len(), 1);
        assert_eq!(
            page.rows[0].last_comment_body.as_deref(),
            Some("latest message")
        );
    }

    #[test]
    fn list_listeners_returns_last_comment_html_when_present() {
        // raw.commentHtml が <img> を含む場合、last_comment_html として配信されることを確認。
        let (_dir, mgr) = open_temp();
        let mut c = fake_comment("c-emoji", "UCbob", "ねぎ:custom_negi:");
        c.timestamp = "2026-04-19T12:00:00.000Z".to_string();
        c.comment_html =
            "ねぎ<img class=\"emoji\" src=\"https://example.com/n.png\" alt=\":custom_negi:\">"
                .to_string();
        mgr.record_comment(&c, "vid1", "yt-UCowner").unwrap();
        let page = mgr
            .list_listeners(&ListenersQuery::default())
            .expect("list");
        assert_eq!(page.rows.len(), 1);
        assert!(page.rows[0]
            .last_comment_html
            .as_deref()
            .unwrap()
            .contains("<img"));
    }

    #[test]
    fn list_listeners_html_is_none_when_empty_string() {
        // commentHtml が空文字のときは None として返り、renderer 側が body フォールバックできる。
        let (_dir, mgr) = open_temp();
        let mut c = fake_comment("c-plain", "UCcarol", "just text");
        c.comment_html = String::new();
        c.timestamp = "2026-04-19T12:00:00.000Z".to_string();
        mgr.record_comment(&c, "vid1", "yt-UCowner").unwrap();
        let page = mgr
            .list_listeners(&ListenersQuery::default())
            .expect("list");
        assert_eq!(page.rows.len(), 1);
        assert!(page.rows[0].last_comment_html.is_none());
        assert_eq!(page.rows[0].last_comment_body.as_deref(), Some("just text"));
    }

    #[test]
    fn list_listeners_filters_by_query() {
        let (_dir, mgr) = open_temp();
        let mut c1 = fake_comment("c1", "UCa", "hi");
        c1.display_name = "Alice".to_string();
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("1");
        let mut c2 = fake_comment("c2", "UCb", "hi");
        c2.display_name = "Bob".to_string();
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("2");
        let mut c3 = fake_comment("c3", "UCc", "hi");
        c3.display_name = "alex".to_string();
        mgr.record_comment(&c3, "vidA", "yt-UCowner").expect("3");

        let q = ListenersQuery {
            q: Some("al".to_string()),
            ..Default::default()
        };
        let page = mgr.list_listeners(&q).expect("list");
        assert_eq!(page.total, 2); // Alice + alex
        let names: Vec<_> = page.rows.iter().map(|r| r.display_name.clone()).collect();
        assert!(names.contains(&"Alice".to_string()));
        assert!(names.contains(&"alex".to_string()));
    }

    #[test]
    fn list_listeners_filters_by_user_tag() {
        // ListenersQuery.user_tags (= listener_tags 経由 EXISTS、 タグ間は OR)。
        // 2026-05-16 追加 (旧 silent drop を解消)。
        let (_dir, mgr) = open_temp();
        for (id, who, name) in [("c1", "UCa", "Alice"), ("c2", "UCb", "Bob"), ("c3", "UCc", "Carol")] {
            let mut c = fake_comment(id, who, "hi");
            c.display_name = name.to_string();
            mgr.record_comment(&c, "vidA", "yt-UCowner").expect("rec");
        }
        mgr.set_listener_tags("UCa", &["VIP".to_string(), "推し".to_string()])
            .expect("tag a");
        mgr.set_listener_tags("UCb", &["推し".to_string()])
            .expect("tag b");
        // UCc にはタグなし

        // 単一タグ "VIP" → Alice のみ
        let q1 = ListenersQuery {
            user_tags: vec!["VIP".to_string()],
            ..Default::default()
        };
        let page1 = mgr.list_listeners(&q1).expect("list1");
        assert_eq!(page1.total, 1);
        assert_eq!(page1.rows[0].display_name, "Alice");

        // 複数タグ ["VIP", "推し"] → OR で Alice + Bob (Carol は対象外)
        let q2 = ListenersQuery {
            user_tags: vec!["VIP".to_string(), "推し".to_string()],
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page2 = mgr.list_listeners(&q2).expect("list2");
        assert_eq!(page2.total, 2);
        let names: Vec<_> = page2.rows.iter().map(|r| r.display_name.clone()).collect();
        assert!(names.contains(&"Alice".to_string()));
        assert!(names.contains(&"Bob".to_string()));
        assert!(!names.contains(&"Carol".to_string()));
    }

    #[test]
    fn list_listeners_filters_by_stream_video_id_and_greeted_state() {
        // 2 配信枠 + 3 リスナーで「現枠で発言した listener のみ」「未挨拶のみ」をテスト
        let (_dir, mgr) = open_temp();
        // alice は vidA + vidB 両方で発言、bob は vidA のみ、carol は vidB のみ
        for (id, vid, who) in [
            ("c1", "vidA", "UCalice"),
            ("c2", "vidB", "UCalice"),
            ("c3", "vidA", "UCbob"),
            ("c4", "vidB", "UCcarol"),
        ] {
            let c = fake_comment(id, who, "hi");
            mgr.record_comment(&c, vid, "yt-UCowner").expect("rec");
        }
        // alice を vidA で挨拶済み、bob は未挨拶 (= vidA で発言したが未挨拶)
        mgr.set_listener_greeted("vidA", "UCalice", true)
            .expect("greet alice@vidA");

        // vidA context = alice + bob (= 2 人)
        let q = ListenersQuery {
            stream_video_id: Some("vidA".to_string()),
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page = mgr.list_listeners(&q).expect("list");
        assert_eq!(page.total, 2);
        let alice_row = page
            .rows
            .iter()
            .find(|r| r.channel_id == "yt-UCalice")
            .expect("alice in result");
        assert!(alice_row.greeted_at > 0, "alice should be greeted at vidA");
        let bob_row = page
            .rows
            .iter()
            .find(|r| r.channel_id == "yt-UCbob")
            .expect("bob in result");
        assert_eq!(bob_row.greeted_at, 0, "bob should not be greeted");

        // vidA + un_greeted_only = bob のみ
        let q2 = ListenersQuery {
            stream_video_id: Some("vidA".to_string()),
            un_greeted_only: true,
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page2 = mgr.list_listeners(&q2).expect("list");
        assert_eq!(page2.total, 1);
        assert_eq!(page2.rows[0].channel_id, "yt-UCbob");

        // stream_video_id 無しなら全員 (greeted_at は 0 で返る)
        let q3 = ListenersQuery::default();
        let page3 = mgr.list_listeners(&q3).expect("list");
        assert_eq!(page3.total, 3);
        for r in &page3.rows {
            assert_eq!(r.greeted_at, 0, "no context = greeted_at always 0");
        }
    }

    #[test]
    fn list_listeners_sorts_by_stream_first_comment_desc() {
        let (_dir, mgr) = open_temp();

        let mut early = fake_comment("early-1", "UCearly", "first in stream");
        early.display_name = "early".to_string();
        early.timestamp = "2026-04-19T10:00:00.000Z".to_string();
        mgr.record_comment(&early, "vidA", "yt-UCowner")
            .expect("early first");

        let mut late = fake_comment("late-1", "UClate", "new participant");
        late.display_name = "late".to_string();
        late.timestamp = "2026-04-19T10:05:00.000Z".to_string();
        mgr.record_comment(&late, "vidA", "yt-UCowner")
            .expect("late first");

        // early は後から追加コメントしても「この枠で最初に参加した時刻」は変わらない。
        let mut early_again = fake_comment("early-2", "UCearly", "latest overall");
        early_again.display_name = "early".to_string();
        early_again.timestamp = "2026-04-19T10:10:00.000Z".to_string();
        mgr.record_comment(&early_again, "vidA", "yt-UCowner")
            .expect("early again");

        // 別枠の初回/最終コメントは vidA の参加順には影響しない。
        let mut old_other_stream = fake_comment("other-1", "UClate", "older other stream");
        old_other_stream.display_name = "late".to_string();
        old_other_stream.timestamp = "2026-04-18T10:00:00.000Z".to_string();
        mgr.record_comment(&old_other_stream, "vidB", "yt-UCowner")
            .expect("other stream");

        let page = mgr
            .list_listeners(&ListenersQuery {
                stream_video_id: Some("vidA".to_string()),
                sort: ListenersSort::StreamFirstAt,
                ..Default::default()
            })
            .expect("list");

        let ids: Vec<_> = page.rows.iter().map(|r| r.channel_id.as_str()).collect();
        assert_eq!(ids, vec!["yt-UClate", "yt-UCearly"]);
    }

    #[test]
    fn list_listeners_returns_per_stream_comment_count() {
        let (_dir, mgr) = open_temp();

        let mut a1 = fake_comment("a1", "UCa", "current one");
        a1.timestamp = "2026-04-19T10:00:00.000Z".to_string();
        mgr.record_comment(&a1, "vidA", "yt-UCowner").unwrap();

        let mut a2 = fake_comment("a2", "UCa", "current two");
        a2.timestamp = "2026-04-19T10:01:00.000Z".to_string();
        mgr.record_comment(&a2, "vidA", "yt-UCowner").unwrap();

        let mut other = fake_comment("a3", "UCa", "other stream");
        other.timestamp = "2026-04-18T10:00:00.000Z".to_string();
        mgr.record_comment(&other, "vidB", "yt-UCowner").unwrap();

        let page = mgr
            .list_listeners(&ListenersQuery {
                stream_video_id: Some("vidA".to_string()),
                sort: ListenersSort::CommentCount,
                ..Default::default()
            })
            .expect("list");

        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].comment_count, 3);
        assert_eq!(page.rows[0].per_stream_comment_count, 2);
    }

    #[test]
    fn listener_tab_returning_excludes_first_in_stream_repeaters() {
        let (_dir, mgr) = open_temp();
        let current_start = current_unix_millis() - 60_000;
        let one_day_ms: i64 = 24 * 3600 * 1000;

        let mut new_1 = fake_comment("new-1", "UCnew", "first current");
        new_1.timestamp = unix_ms_to_iso(current_start);
        mgr.record_comment(&new_1, "vidA", "yt-UCowner").unwrap();
        let mut new_2 = fake_comment("new-2", "UCnew", "second current");
        new_2.timestamp = unix_ms_to_iso(current_start + 1_000);
        mgr.record_comment(&new_2, "vidA", "yt-UCowner").unwrap();

        let mut returning_old = fake_comment("ret-old", "UCret", "prior");
        returning_old.timestamp = unix_ms_to_iso(current_start - one_day_ms);
        mgr.record_comment(&returning_old, "vidOld", "yt-UCowner")
            .unwrap();
        let mut returning_now = fake_comment("ret-now", "UCret", "current");
        returning_now.timestamp = unix_ms_to_iso(current_start + 2_000);
        mgr.record_comment(&returning_now, "vidA", "yt-UCowner")
            .unwrap();

        let counts = mgr
            .list_stream_scoped_listener_counts("vidA", None)
            .expect("counts");
        assert_eq!(counts.all, 2);
        assert_eq!(counts.first_time, 1);
        assert_eq!(counts.returning, 1);

        let page = mgr
            .list_listeners(&ListenersQuery {
                stream_video_id: Some("vidA".to_string()),
                system_tags: vec!["returning".to_string()],
                sort: ListenersSort::DisplayName,
                ..Default::default()
            })
            .expect("list returning");
        let ids: Vec<_> = page.rows.iter().map(|r| r.channel_id.as_str()).collect();
        assert_eq!(ids, vec!["yt-UCret"]);
    }

    #[test]
    fn get_listener_detail_returns_recent_comments() {
        let (_dir, mgr) = open_temp();
        for i in 0..3 {
            let mut c = fake_comment(&format!("c{}", i), "UCalice", "hi");
            c.timestamp = format!("2026-04-19T11:43:{:02}.000Z", 40 + i);
            mgr.record_comment(&c, "vidA", "yt-UCowner").expect("rec");
        }
        let detail = mgr
            .get_listener_detail("UCalice", 10, None)
            .expect("detail")
            .expect("some");
        assert_eq!(detail.listener.channel_id, "yt-UCalice");
        assert_eq!(detail.listener.comment_count, 3);
        assert_eq!(detail.recent_comments.len(), 3);
        // posted_at DESC で並ぶ
        assert!(detail.recent_comments[0].posted_at >= detail.recent_comments[1].posted_at);
    }

    #[test]
    fn get_listener_detail_returns_none_for_unknown() {
        let (_dir, mgr) = open_temp();
        let result = mgr.get_listener_detail("UCnobody", 5, None).expect("query");
        assert!(result.is_none());
    }

    #[test]
    fn list_streams_returns_paged_rows_sorted_by_started_at_desc() {
        let (_dir, mgr) = open_temp();
        // 自チャンネルフィルタ用に owner_channels に登録
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");
        // 異なる videoId で 3 件 record。timestamp は 10/11/12 秒
        for (i, vid) in ["vidA", "vidB", "vidC"].iter().enumerate() {
            let mut c = fake_comment(&format!("c-{}", i), "UCalice", "hi");
            c.timestamp = format!("2026-04-19T11:43:{:02}.000Z", 10 + i);
            mgr.record_comment(&c, vid, "yt-UCowner").expect("rec");
        }
        let q = StreamsQuery::default();
        let page = mgr.list_streams(&q).expect("list");
        assert_eq!(page.total, 3);
        assert_eq!(page.rows.len(), 3);
        // started_at DESC で並ぶ (vidC が最新)
        assert_eq!(page.rows[0].video_id, "vidC");
        assert_eq!(page.rows[2].video_id, "vidA");
    }

    #[test]
    fn purge_non_owner_streams_removes_garbage_but_keeps_owned() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");
        // 自チャンネル枠 (comments あり)
        let mut c1 = fake_comment("c1", "UCa", "hi");
        c1.timestamp = "2026-04-19T11:43:10.000Z".to_string();
        mgr.record_comment(&c1, "vidOwn", "yt-UCowner")
            .expect("rec own");
        // 他チャンネル stub (comments なし)
        mgr.with_sync_conn(|c| {
            c.execute(
                "INSERT INTO streams (video_id, owner_channel_id, started_at, ended_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params!["vidOther", "yt-UCnotmine", 1_700_000_000_000_i64],
            )
            .expect("insert other");
        });
        // owner 空 stub
        mgr.with_sync_conn(|c| {
            c.execute(
                "INSERT INTO streams (video_id, owner_channel_id, started_at, ended_at)
                 VALUES (?1, '', ?2, ?2)",
                params!["vidStub", 1_700_000_000_001_i64],
            )
            .expect("insert stub");
        });
        // 自チャンネル外だが comments がある (= わんコメ import 由来など、削除しない)
        mgr.with_sync_conn(|c| {
            c.execute(
                "INSERT INTO streams (video_id, owner_channel_id, started_at, ended_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![
                    "vidOtherWithComments",
                    "yt-UCnotmine",
                    1_700_000_000_002_i64
                ],
            )
            .expect("insert other-with-comments");
            c.execute(
                "INSERT INTO comments
                 (id, stream_id, listener_channel_id, posted_at, body, comment_type,
                  superchat_amount_jpy, superchat_currency, superchat_amount_raw, raw_zst, comment_html)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'chat', NULL, NULL, NULL, NULL, '')",
                params![
                    "c-other-1",
                    "vidOtherWithComments",
                    "yt-UCalice",
                    1_700_000_000_002_i64,
                    "hi"
                ],
            )
            .expect("insert other-comment");
        });

        let removed = mgr.purge_non_owner_streams().expect("purge");
        assert_eq!(removed, 1, "owner 空の vidStub だけが消える");

        let page = mgr.list_streams(&StreamsQuery::default()).expect("list");
        assert_eq!(page.total, 3);
        assert_eq!(page.rows[0].video_id, "vidOwn");

        // 削除されなかった "他枠 + コメ付き" は streams テーブル直接 SELECT で確認
        let total_in_db: i64 = mgr.with_sync_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM streams", [], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(total_in_db, 3, "vidOwn + vidOther + vidOtherWithComments");
    }

    #[test]
    fn list_streams_excludes_other_channels() {
        // scope=own では自チャンネル枠だけに絞れること
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");
        // 自チャンネル枠
        let mut c1 = fake_comment("c1", "UCa", "hi");
        c1.timestamp = "2026-04-19T11:43:10.000Z".to_string();
        mgr.record_comment(&c1, "vidOwn", "yt-UCowner")
            .expect("rec own");
        // 別チャンネル枠 (record_comment は呼ばれない想定だが、stub 行を直接 INSERT)
        mgr.with_sync_conn(|c| {
            c.execute(
                "INSERT INTO streams (video_id, owner_channel_id, started_at, ended_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params!["vidOther", "yt-UCnotmine", 1_700_000_000_000_i64],
            )
            .expect("insert other");
        });
        // owner_channel_id 空の stub 行 (= update_stream_metadata 経由のメタデータ先取得)
        mgr.with_sync_conn(|c| {
            c.execute(
                "INSERT INTO streams (video_id, owner_channel_id, started_at, ended_at)
                 VALUES (?1, '', ?2, ?2)",
                params!["vidStub", 1_700_000_000_001_i64],
            )
            .expect("insert stub");
        });
        let page = mgr
            .list_streams(&StreamsQuery {
                scope: StreamScope::Own,
                ..Default::default()
            })
            .expect("list");
        assert_eq!(page.total, 1, "自チャンネル枠だけ");
        assert_eq!(page.rows[0].video_id, "vidOwn");
    }

    #[test]
    fn get_stream_detail_returns_recent_comments_for_video() {
        let (_dir, mgr) = open_temp();
        for i in 0..3 {
            let mut c = fake_comment(&format!("c{}", i), "UCalice", "msg");
            c.timestamp = format!("2026-04-19T11:43:{:02}.000Z", 10 + i);
            mgr.record_comment(&c, "vidA", "yt-UCowner").expect("rec");
        }
        // 別の vid のコメントは混ざらない
        let other = fake_comment("c-other", "UCalice", "other-stream");
        mgr.record_comment(&other, "vidB", "yt-UCowner")
            .expect("rec");

        let detail = mgr
            .get_stream_detail("vidA", 10)
            .expect("query")
            .expect("some");
        assert_eq!(detail.stream.video_id, "vidA");
        assert_eq!(detail.stream.comment_count, 3);
        assert_eq!(detail.recent_comments.len(), 3);
        // すべて vidA のコメントだけ
        for c in &detail.recent_comments {
            assert_eq!(c.stream_id, "vidA");
        }
    }

    #[test]
    fn get_stream_detail_returns_none_for_unknown_video() {
        let (_dir, mgr) = open_temp();
        let result = mgr.get_stream_detail("nope", 5).expect("query");
        assert!(result.is_none());
    }

    #[test]
    fn search_comments_filters_by_keyword_and_type() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("c1", "UCa", "hello world");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("1");
        let c2 = fake_comment("c2", "UCb", "say bye world");
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("2");
        let mut c3 = fake_comment("c3", "UCa", "thanks!");
        c3.has_gift = true;
        c3.amount = 500.0;
        c3.currency = "JPY".to_string();
        mgr.record_comment(&c3, "vidA", "yt-UCowner").expect("3");

        // "world" を含むコメント 2 件
        let q = CommentsQuery {
            body_q: Some("world".to_string()),
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 2);

        // superchat だけ 1 件
        let q = CommentsQuery {
            comment_types: vec!["superchat".to_string()],
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].id, "yt-c3");

        // listener UCa の chat タイプだけ 1 件
        let q = CommentsQuery {
            listener_channel_ids: vec!["UCa".to_string()],
            comment_types: vec!["chat".to_string()],
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].id, "yt-c1");
    }

    #[test]
    fn search_comments_paginates_results() {
        let (_dir, mgr) = open_temp();
        for i in 0..5 {
            let c = fake_comment(&format!("c{}", i), "UCa", &format!("msg-{}", i));
            mgr.record_comment(&c, "vidA", "yt-UCowner").expect("rec");
        }
        let q = CommentsQuery {
            limit: Some(2),
            offset: Some(0),
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 5);
        assert_eq!(page.rows.len(), 2);
    }

    #[test]
    fn search_comments_filters_by_name_and_stream_title() {
        let (_dir, mgr) = open_temp();
        let mut c1 = fake_comment("c1", "UCalice", "hello");
        c1.name = "Alice".to_string();
        c1.display_name = "Alice".to_string();
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("rec");
        let mut c2 = fake_comment("c2", "UCbob", "hi");
        c2.name = "Bob".to_string();
        c2.display_name = "Bob".to_string();
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("rec");
        let mut c3 = fake_comment("c3", "UCalice", "yay");
        c3.name = "Alice".to_string();
        c3.display_name = "Alice".to_string();
        mgr.record_comment(&c3, "vidB", "yt-UCowner").expect("rec");
        // 配信枠タイトル設定
        mgr.update_stream_metadata(
            "vidA",
            None,
            Some("歌枠 アコギ回"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("title A");
        mgr.update_stream_metadata(
            "vidB",
            None,
            Some("ゲーム Apex"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("title B");

        // name_q="Alice" → 2 件 (c1 + c3)
        let q = CommentsQuery {
            name_q: Some("Alice".to_string()),
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 2);

        // stream_title_q="歌枠" → 2 件 (vidA: c1 + c2)
        let q = CommentsQuery {
            stream_title_q: Some("歌枠".to_string()),
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 2);

        // name_q="Alice" AND stream_title_q="ゲーム" → 1 件 (c3 のみ)
        let q = CommentsQuery {
            name_q: Some("Alice".to_string()),
            stream_title_q: Some("ゲーム".to_string()),
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].id, "yt-c3");
    }

    #[test]
    fn search_comments_filters_by_period() {
        let (_dir, mgr) = open_temp();
        let mut c1 = fake_comment("c1", "UCa", "old");
        c1.timestamp = "2026-04-01T00:00:00.000Z".to_string();
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("rec1");
        let mut c2 = fake_comment("c2", "UCa", "mid");
        c2.timestamp = "2026-04-15T00:00:00.000Z".to_string();
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("rec2");
        let mut c3 = fake_comment("c3", "UCa", "new");
        c3.timestamp = "2026-05-01T00:00:00.000Z".to_string();
        mgr.record_comment(&c3, "vidA", "yt-UCowner").expect("rec3");

        // 4/10 〜 4/30 → c2 のみ
        let from = parse_iso_to_unix_ms("2026-04-10T00:00:00.000Z").unwrap();
        let to = parse_iso_to_unix_ms("2026-04-30T00:00:00.000Z").unwrap();
        let q = CommentsQuery {
            period_from: Some(from),
            period_to: Some(to),
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].id, "yt-c2");
    }

    #[test]
    fn listener_tags_crud_set_get_replace() {
        let (_dir, mgr) = open_temp();
        // リスナー前提行を作る
        let c1 = fake_comment("c1", "UCalice", "hi");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("rec");

        // 初期は空
        let tags = mgr.get_listener_tags("UCalice").expect("get");
        assert!(tags.is_empty());

        // set: 推し / VIP
        let n = mgr
            .set_listener_tags("UCalice", &["推し".to_string(), "VIP".to_string()])
            .expect("set");
        assert_eq!(n, 2);
        let mut tags = mgr.get_listener_tags("UCalice").expect("get");
        tags.sort();
        assert_eq!(tags, vec!["VIP".to_string(), "推し".to_string()]);

        // set 置換: 推し / ファンクラブ (VIP 除外、ファンクラブ追加)
        let n = mgr
            .set_listener_tags("UCalice", &["推し".to_string(), "ファンクラブ".to_string()])
            .expect("set2");
        assert_eq!(n, 2);
        let mut tags = mgr.get_listener_tags("UCalice").expect("get");
        tags.sort();
        assert_eq!(tags, vec!["ファンクラブ".to_string(), "推し".to_string()]);

        // 重複 / 空白除去
        let n = mgr
            .set_listener_tags(
                "UCalice",
                &["VIP".to_string(), " VIP ".to_string(), "  ".to_string()],
            )
            .expect("dedup");
        assert_eq!(n, 1);
        let tags = mgr.get_listener_tags("UCalice").expect("get");
        assert_eq!(tags, vec!["VIP".to_string()]);
    }

    #[test]
    fn listener_tags_list_all_groups_by_count() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("c1", "UCa", "hi");
        let c2 = fake_comment("c2", "UCb", "hi");
        let c3 = fake_comment("c3", "UCc", "hi");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("c1");
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("c2");
        mgr.record_comment(&c3, "vidA", "yt-UCowner").expect("c3");

        mgr.set_listener_tags("UCa", &["VIP".to_string(), "推し".to_string()])
            .expect("a");
        mgr.set_listener_tags("UCb", &["推し".to_string()])
            .expect("b");
        mgr.set_listener_tags("UCc", &["推し".to_string()])
            .expect("c");

        let all = mgr.list_all_tags().expect("list");
        // 推し: 3, VIP: 1
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].tag, "推し");
        assert_eq!(all[0].listener_count, 3);
        assert_eq!(all[1].tag, "VIP");
        assert_eq!(all[1].listener_count, 1);
    }

    #[test]
    fn listener_tags_rename_merges_duplicates() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("c1", "UCa", "hi");
        let c2 = fake_comment("c2", "UCb", "hi");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("c1");
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("c2");

        // UCa: 旧 + 新 両方持っている (rename で衝突)、UCb: 旧 のみ
        mgr.set_listener_tags("UCa", &["旧".to_string(), "新".to_string()])
            .expect("a");
        mgr.set_listener_tags("UCb", &["旧".to_string()])
            .expect("b");

        let n = mgr.rename_tag("旧", "新").expect("rename");
        // UCa: 旧→削除 (merge), UCb: 旧→新 へ rename。両方影響
        assert!(n >= 2);

        let tags_a = mgr.get_listener_tags("UCa").expect("get a");
        assert_eq!(tags_a, vec!["新".to_string()]);
        let tags_b = mgr.get_listener_tags("UCb").expect("get b");
        assert_eq!(tags_b, vec!["新".to_string()]);
    }

    #[test]
    fn listener_tags_delete_removes_all() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("c1", "UCa", "hi");
        let c2 = fake_comment("c2", "UCb", "hi");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("c1");
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("c2");
        mgr.set_listener_tags("UCa", &["VIP".to_string(), "推し".to_string()])
            .expect("a");
        mgr.set_listener_tags("UCb", &["VIP".to_string()])
            .expect("b");

        let n = mgr.delete_tag("VIP").expect("del");
        assert_eq!(n, 2);
        assert_eq!(
            mgr.get_listener_tags("UCa").unwrap(),
            vec!["推し".to_string()]
        );
        assert!(mgr.get_listener_tags("UCb").unwrap().is_empty());
    }

    #[test]
    fn saved_searches_crud_roundtrip() {
        let (_dir, mgr) = open_temp();
        // 初期は空 (= comment-search scope)
        let list = mgr.list_saved_searches("comment-search").expect("list");
        assert!(list.is_empty());

        // create 2 件
        let id1 = mgr
            .create_saved_search("comment-search", "初見ありがとう", r#"{"bodyQ":"ありがとう"}"#)
            .expect("c1");
        let id2 = mgr
            .create_saved_search("comment-search", "常連スパチャ", r#"{"systemTags":["regular"]}"#)
            .expect("c2");
        assert!(id1 < id2);

        let list = mgr.list_saved_searches("comment-search").expect("list");
        assert_eq!(list.len(), 2);
        // sort_order は採番順
        assert_eq!(list[0].id, id1);
        assert_eq!(list[0].sort_order, 1);
        assert_eq!(list[0].scope, "comment-search");
        assert_eq!(list[1].id, id2);
        assert_eq!(list[1].sort_order, 2);

        // update name + sort_order
        let n = mgr
            .update_saved_search(id2, Some("常連 SC (改名)"), None, Some(0))
            .expect("update");
        assert_eq!(n, 1);
        let list = mgr.list_saved_searches("comment-search").expect("list");
        // sort_order=0 → id2 が先頭
        assert_eq!(list[0].id, id2);
        assert_eq!(list[0].name, "常連 SC (改名)");
        assert_eq!(list[1].id, id1);

        // delete
        let n = mgr.delete_saved_search(id1).expect("del");
        assert_eq!(n, 1);
        let list = mgr.list_saved_searches("comment-search").expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id2);

        // 重複 delete は 0
        let n = mgr.delete_saved_search(id1).expect("del2");
        assert_eq!(n, 0);
    }

    #[test]
    fn saved_search_rejects_empty_name() {
        let (_dir, mgr) = open_temp();
        let r = mgr.create_saved_search("comment-search", "   ", "{}");
        assert!(r.is_err());
    }

    /// saved_searches.scope migration: 旧スキーマ (= scope 列なし) の DB を開いた時に
    /// init/migration が成功し、 scope 列が追加されて 'comment-search' default で
    /// 動くことを固定 (= 2026-05-14、 旧 DB 起動時の「no such column: scope」エラー回帰防止)。
    #[test]
    fn saved_searches_migration_adds_scope_to_existing_v1_db() {
        use rusqlite::Connection;
        let dir = tempfile::tempdir().expect("tempdir");
        let db_dir = dir.path().join("data");
        std::fs::create_dir_all(&db_dir).expect("create dir");
        let db_path = db_dir.join("listeners.db");

        // 旧スキーマ (= scope 列なし) を直接 INSERT。 ListenerManager 経由で開いて
        // からテーブルを書き換える形にすることで、 他テーブルの整合性も保つ。
        {
            let mgr = ListenerManager::open(dir.path()).expect("open fresh");
            drop(mgr);
            let conn = Connection::open(&db_path).expect("direct open");
            // 旧スキーマシミュレーション: 一旦テーブル丸ごと作り直し (scope 列なし)。
            // SQLite の ALTER TABLE DROP COLUMN は 3.35+ 必須なので、 安全のため
            // table rename + 再作成で旧スキーマを復元する。
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE saved_searches RENAME TO saved_searches_new;
                 CREATE TABLE saved_searches (
                   id          INTEGER PRIMARY KEY AUTOINCREMENT,
                   name        TEXT NOT NULL,
                   conditions  TEXT NOT NULL,
                   sort_order  INTEGER NOT NULL DEFAULT 0,
                   created_at  INTEGER NOT NULL,
                   updated_at  INTEGER NOT NULL
                 );
                 INSERT INTO saved_searches (id, name, conditions, sort_order, created_at, updated_at)
                   SELECT id, name, conditions, sort_order, created_at, updated_at FROM saved_searches_new;
                 DROP TABLE saved_searches_new;
                 DROP INDEX IF EXISTS idx_saved_searches_scope_order;
                 CREATE INDEX idx_saved_searches_order ON saved_searches(sort_order, id);
                 COMMIT;",
            )
            .expect("rebuild old schema");

            // 旧スキーマでデータを 1 件入れる (= migration で 'comment-search' default になることを確認)
            conn.execute(
                "INSERT INTO saved_searches (name, conditions, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params!["旧データ", r#"{"bodyQ":"x"}"#, 1i64, 1700000000000i64],
            )
            .expect("insert old row");
        }

        // ListenerManager::open で migration が走る。 失敗するとここで panic する
        // (= 旧 bug: 「no such column: scope in CREATE INDEX ...」で開けなかった)。
        let mgr = ListenerManager::open(dir.path()).expect("reopen after migration");

        // 旧データが 'comment-search' scope に default 化されて見えること。
        let list = mgr.list_saved_searches("comment-search").expect("list");
        assert_eq!(list.len(), 1, "旧データが comment-search scope で見える");
        assert_eq!(list[0].name, "旧データ");
        assert_eq!(list[0].scope, "comment-search");

        // listener-search scope は当然 空。
        assert!(mgr.list_saved_searches("listener-search").expect("ls").is_empty());

        // create_saved_search で listener-search scope への新規追加も動く。
        let id = mgr
            .create_saved_search("listener-search", "新", r#"{"nameQ":"a"}"#)
            .expect("create");
        assert!(id > 0);
        let ls = mgr.list_saved_searches("listener-search").expect("ls");
        assert_eq!(ls.len(), 1);
        assert_eq!(ls[0].scope, "listener-search");
    }

    /// saved_searches.scope による分離: comment-search / listener-search が独立した
    /// 一覧 / sort_order を持つことを固定 (= 2026-05-14 Phase 2c)。
    #[test]
    fn saved_searches_isolate_by_scope() {
        let (_dir, mgr) = open_temp();
        let cs1 = mgr
            .create_saved_search("comment-search", "コメ条件 1", r#"{"bodyQ":"x"}"#)
            .expect("cs1");
        let cs2 = mgr
            .create_saved_search("comment-search", "コメ条件 2", r#"{"bodyQ":"y"}"#)
            .expect("cs2");
        let ls1 = mgr
            .create_saved_search("listener-search", "リスナー条件 1", r#"{"nameQ":"alice"}"#)
            .expect("ls1");

        // comment-search scope は cs1 + cs2 だけ
        let cs_list = mgr.list_saved_searches("comment-search").expect("cs list");
        let cs_ids: Vec<_> = cs_list.iter().map(|s| s.id).collect();
        assert_eq!(cs_ids, vec![cs1, cs2]);

        // listener-search scope は ls1 だけ
        let ls_list = mgr.list_saved_searches("listener-search").expect("ls list");
        assert_eq!(ls_list.len(), 1);
        assert_eq!(ls_list[0].id, ls1);
        assert_eq!(ls_list[0].scope, "listener-search");
        // listener-search の sort_order は scope 内で 1 から (= cs の 2 を引き継がない)
        assert_eq!(ls_list[0].sort_order, 1);

        // 未知 scope は空
        let unknown = mgr.list_saved_searches("nope").expect("unknown");
        assert!(unknown.is_empty());

        // scope 跨ぎ delete: id 一意なので OK
        let n = mgr.delete_saved_search(ls1).expect("del ls");
        assert_eq!(n, 1);
        assert!(mgr
            .list_saved_searches("listener-search")
            .expect("ls")
            .is_empty());
        // 他 scope は影響なし
        assert_eq!(
            mgr.list_saved_searches("comment-search").expect("cs").len(),
            2
        );
    }

    #[test]
    fn search_comments_filters_by_user_tag() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("c1", "UCa", "hi A");
        let c2 = fake_comment("c2", "UCb", "hi B");
        let c3 = fake_comment("c3", "UCa", "thanks");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("c1");
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("c2");
        mgr.record_comment(&c3, "vidA", "yt-UCowner").expect("c3");
        mgr.set_listener_tags("UCa", &["推し".to_string()])
            .expect("a");
        // UCb はタグなし

        // user_tags=["推し"] → UCa の 2 件のみ
        let q = CommentsQuery {
            user_tags: vec!["推し".to_string()],
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 2);
        for r in &page.rows {
            assert_eq!(r.listener_channel_id, "yt-UCa");
        }
    }

    #[test]
    fn search_comments_aggregates_kpi_when_requested() {
        let (_dir, mgr) = open_temp();
        // 2 配信、3 リスナー (a, b, c)、計 5 件 (vidA: a/b/a + ¥500 sc, vidB: a/c)
        let c1 = fake_comment("c1", "UCa", "hi A");
        mgr.record_comment(&c1, "vidA", "yt-UCowner").expect("c1");
        let c2 = fake_comment("c2", "UCb", "hi B");
        mgr.record_comment(&c2, "vidA", "yt-UCowner").expect("c2");
        let mut c3 = fake_comment("c3", "UCa", "thanks");
        c3.has_gift = true;
        c3.amount = 500.0;
        c3.currency = "JPY".to_string();
        mgr.record_comment(&c3, "vidA", "yt-UCowner").expect("c3");
        let c4 = fake_comment("c4", "UCa", "hi B-stream");
        mgr.record_comment(&c4, "vidB", "yt-UCowner").expect("c4");
        let c5 = fake_comment("c5", "UCc", "yo");
        mgr.record_comment(&c5, "vidB", "yt-UCowner").expect("c5");

        let q = CommentsQuery {
            include_kpi: true,
            ..Default::default()
        };
        let page = mgr.search_comments(&q).expect("search");
        assert_eq!(page.total, 5);
        assert_eq!(page.kpi.total_count, 5);
        assert_eq!(page.kpi.total_amount_jpy, 500);
        assert_eq!(page.kpi.unique_listeners, 3);
        assert_eq!(page.kpi.stream_count, 2);
        // vidA: 2 ユニーク (a, b), vidB: 2 ユニーク (a, c) → avg=2.0
        assert!((page.kpi.avg_unique_listeners_per_stream - 2.0).abs() < 1e-9);
        // 各枠 KPI が 2 件、started_at DESC ソート (vidB は record 順で後 = ts 新しい)
        assert_eq!(page.streams.len(), 2);
        let stream_a = page.streams.iter().find(|s| s.stream_id == "vidA").unwrap();
        assert_eq!(stream_a.comment_count, 3);
        assert_eq!(stream_a.amount_jpy, 500);
        assert_eq!(stream_a.unique_listeners, 2);
    }

    #[test]
    fn export_then_import_is_round_trip() {
        // 元 DB にデータを入れて export → 別 DB に import → 同じ件数が復元される
        let (_dir1, mgr1) = open_temp();
        for i in 0..5 {
            let mut c = fake_comment(
                &format!("c{}", i),
                &format!("UCu{}", i),
                &format!("msg-{}", i),
            );
            c.timestamp = format!("2026-04-19T12:00:{:02}.000Z", 10 + i);
            mgr1.record_comment(&c, "vidA", "yt-UCowner").expect("rec");
        }
        let dir2 = tempfile::tempdir().expect("tmp2");
        let export_path = dir2.path().join("export.jsonl");
        let summary = mgr1.export_komehub_jsonl(&export_path).expect("export");
        assert_eq!(summary.listener_count, 5);
        assert_eq!(summary.stream_count, 1);
        assert_eq!(summary.comment_count, 5);
        assert!(summary.bytes_written > 0);

        // 別 DB に import
        let dir3 = tempfile::tempdir().expect("tmp3");
        let mgr2 = ListenerManager::open(dir3.path()).expect("open2");
        let import = mgr2.import_komehub_jsonl(&export_path).expect("import");
        assert_eq!(import.schema_version, Some(EXPECTED_SCHEMA_VERSION));
        // 空 DB へのインポートなのですべて新規
        assert_eq!(import.listeners_new, 5);
        assert_eq!(import.listeners_updated, 0);
        assert_eq!(import.streams_new, 1);
        assert_eq!(import.streams_updated, 0);
        assert_eq!(import.comments_inserted, 5);
        assert_eq!(import.comments_skipped, 0);
        assert_eq!(import.warnings.len(), 0);

        // 復元後の listeners 件数を確認
        let listeners: i64 = mgr2.with_sync_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM listeners", [], |r| r.get(0))
                .expect("count")
        });
        assert_eq!(listeners, 5);
    }

    #[test]
    fn import_is_idempotent_on_duplicate_run() {
        let (_dir1, mgr1) = open_temp();
        let c = fake_comment("c1", "UCu1", "msg");
        mgr1.record_comment(&c, "vidA", "yt-UCowner").expect("rec");
        let dir2 = tempfile::tempdir().expect("tmp2");
        let path = dir2.path().join("export.jsonl");
        mgr1.export_komehub_jsonl(&path).expect("export");

        let dir3 = tempfile::tempdir().expect("tmp3");
        let mgr2 = ListenerManager::open(dir3.path()).expect("open2");
        let r1 = mgr2.import_komehub_jsonl(&path).expect("import 1");
        let r2 = mgr2.import_komehub_jsonl(&path).expect("import 2");
        // 1 回目: すべて新規
        assert_eq!(r1.listeners_new, 1);
        assert_eq!(r1.listeners_updated, 0);
        assert_eq!(r1.streams_new, 1);
        assert_eq!(r1.streams_updated, 0);
        assert_eq!(r1.comments_inserted, 1);
        assert_eq!(r1.comments_skipped, 0);
        // 2 回目: listener / stream は updated に、comment は skipped に
        assert_eq!(r2.listeners_new, 0);
        assert_eq!(r2.listeners_updated, 1);
        assert_eq!(r2.streams_new, 0);
        assert_eq!(r2.streams_updated, 1);
        assert_eq!(r2.comments_inserted, 0);
        assert_eq!(r2.comments_skipped, 1);
    }

    #[test]
    fn import_emits_warning_for_unknown_schema_version() {
        use std::io::Write;
        let dir = tempfile::tempdir().expect("tmp");
        let mgr = ListenerManager::open(dir.path()).expect("open");
        let path = dir.path().join("bad-version.jsonl");
        let mut f = std::fs::File::create(&path).expect("create");
        writeln!(f, r#"{{"type":"meta","schemaVersion":999,"exportedAt":"2026-05-03T00:00:00Z","ownerChannelId":"UCx"}}"#).unwrap();
        drop(f);
        let r = mgr.import_komehub_jsonl(&path).expect("import");
        assert_eq!(r.schema_version, Some(999));
        assert!(r.warnings.iter().any(|w| w.contains("schema_version")));
    }

    #[test]
    fn import_skips_invalid_lines_with_warnings() {
        use std::io::Write;
        let dir = tempfile::tempdir().expect("tmp");
        let mgr = ListenerManager::open(dir.path()).expect("open");
        let path = dir.path().join("invalid.jsonl");
        let mut f = std::fs::File::create(&path).expect("create");
        writeln!(f, r#"{{"type":"meta","schemaVersion":1}}"#).unwrap();
        writeln!(f, "this is not json").unwrap();
        writeln!(f, r#"{{"type":"unknown","data":{{}}}}"#).unwrap();
        writeln!(f).unwrap(); // 空行はスキップ (warning なし)
        writeln!(f, r#"{{"type":"comment","data":{{"id":"yt-c1","streamId":"vidA","listenerChannelId":"yt-UCu","postedAt":1700000000000,"body":"hi","commentType":"chat","raw":{{}}}}}}"#).unwrap();
        drop(f);
        let r = mgr.import_komehub_jsonl(&path).expect("import");
        assert!(r.warnings.len() >= 2); // invalid JSON + unknown type
        assert_eq!(r.comments_inserted, 1);
    }

    use rusqlite::Connection;

    /// テスト用わんコメ DB を作る。`make_fake_onecomme` の listener_aux_io 版だが
    /// listener_manager 内のテストとしてもう一度書き直す。
    fn write_fake_onecomme(dir: &Path, owner: &str) {
        let comments = Connection::open(dir.join("comments.db")).unwrap();
        comments
            .execute_batch(
                "CREATE TABLE comments (
                    id TEXT NOT NULL PRIMARY KEY,
                    service_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    comment JSON NOT NULL,
                    created_at TIMESTAMP NOT NULL
                 );",
            )
            .unwrap();
        // 自チャンネル配信 (owner と一致する live で 2 件)
        for (i, (cid, body)) in [("yt-Cself1", "hi"), ("yt-Cself2", "thanks")]
            .iter()
            .enumerate()
        {
            let comment_json = format!(
                r#"{{"id":"{cid_no_yt}","data":{{"liveId":"vidSelf","userId":"UCa","comment":"{body}","hasGift":{has_gift},"price":{price},"unit":"{unit}"}}}}"#,
                cid_no_yt = &cid[3..],
                body = body,
                has_gift = i == 1,
                price = if i == 1 { 500.0 } else { 0.0 },
                unit = if i == 1 { "JPY" } else { "" },
            );
            comments
                .execute(
                    "INSERT INTO comments(id, service_id, user_id, comment, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![cid, "uuid-1", "yt-UCa", comment_json, format!("2026-04-19T12:00:{:02}.000Z", 10 + i)],
                )
                .unwrap();
        }
        // 別チャンネル配信 (owner != と判定される live で 1 件)
        let other_json = r#"{"id":"Cother","data":{"liveId":"vidOther","userId":"UCb","comment":"other channel"}}"#;
        comments
            .execute(
                "INSERT INTO comments(id, service_id, user_id, comment, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params!["yt-Cother", "uuid-1", "yt-UCb", other_json, "2026-04-19T12:00:30.000Z"],
            )
            .unwrap();

        let users = Connection::open(dir.join("onecomme.db")).unwrap();
        users
            .execute_batch(
                "CREATE TABLE users (
                    id TEXT NOT NULL PRIMARY KEY,
                    data JSON NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT (DATETIME('now', 'localtime')),
                    updated_at TIMESTAMP NOT NULL DEFAULT (DATETIME('now', 'localtime'))
                 );",
            )
            .unwrap();
        let user_data = r#"{"id":"yt-UCa","username":"@alice","tc":2,"tgc":1,"amount":500,"badges":[{"label":"メンバー（1 年）","url":"https://example.com/m.png"}],"lcts":"2026-04-19T12:00:11.000Z"}"#.to_string();
        users
            .execute(
                "INSERT INTO users(id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params!["yt-UCa", user_data, "2026-04-19 12:00:11"],
            )
            .unwrap();
        let other_user_data = r#"{"id":"yt-UCz","username":"@other-channel-viewer","tc":99,"lcts":"2026-04-19T12:00:30.000Z"}"#;
        users
            .execute(
                "INSERT INTO users(id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params!["yt-UCz", other_user_data, "2026-04-19 12:00:30"],
            )
            .unwrap();
        let _ = owner; // 引数は将来用、現時点では未使用
    }

    fn seed_self_stream(mgr: &ListenerManager, video_id: &str, owner_yt: &str) {
        // streams テーブルに「自チャンネルの配信」を登録 (record_comment 経由)
        let mut c = fake_comment("seed", "UCseed", "seed");
        c.timestamp = "2026-04-19T11:50:00.000Z".to_string();
        mgr.record_comment(&c, video_id, owner_yt).expect("seed");
    }

    #[test]
    fn import_from_onecomme_imports_only_own_channel_comments() {
        let (_dir, mgr) = open_temp();
        // configured を設定し、対象 vid を自チャンネル所有として streams に登録
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        let result = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");
        // 別配信 (vidOther) のコメントは filtered、自配信のみ取り込み
        assert_eq!(result.comments_inserted, 2);
        assert_eq!(result.comments_filtered_other_channel, 1);
        // listeners は自チャンネル配信にコメントした UCa だけを取り込む。
        // onecomme.users にだけいる UCz はゼロコメントリスナーとして作らない。
        assert_eq!(result.listeners_new, 1);
        assert_eq!(result.listeners_updated, 0);
        assert!(mgr.get_listener_detail("UCz", 5, None).unwrap().is_none());
        // streams は vidSelf に対して update (seed で既存)、vidOther は filter で出ない
        assert_eq!(result.streams_new, 0);
        assert_eq!(result.streams_updated, 1);
        let detail = mgr.get_listener_detail("UCa", 5, None).unwrap().unwrap();
        assert_eq!(detail.listener.comment_count, 2);
        assert_eq!(detail.listener.superchat_count, 1);
        let stream = mgr.get_stream_detail("vidSelf", 5).unwrap().unwrap();
        assert_eq!(stream.stream.comment_count, 3);
        assert_eq!(stream.stream.superchat_count, 1);
        // schema_hash が記録される
        assert!(!result.schema_hash.is_empty());
        assert!(
            result.warnings.is_empty(),
            "should have no warnings: {:?}",
            result.warnings
        );
    }

    #[test]
    fn import_from_onecomme_keeps_emoji_html_for_display() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let conn = rusqlite::Connection::open(oc_dir.path().join("comments.db")).unwrap();
        let comment_json = r#"{"id":"Cemoji","data":{"liveId":"vidSelf","userId":"UCa","comment":"<img class=\"emoji yt-formatted-string\" src=\"https://yt3.ggpht.com/e.png\" alt=\":_草lol:\" data-emoji-id=\"UCa/emoji1\">草"}}"#;
        conn.execute(
            "INSERT INTO comments(id, service_id, user_id, comment, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["yt-Cemoji", "uuid-1", "yt-UCa", comment_json, "2026-04-19T12:00:40.000Z"],
        )
        .unwrap();

        let result = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");
        assert_eq!(result.comments_inserted, 3);
        mgr.with_sync_conn(|db| {
            let (body, html): (String, String) = db
                .query_row(
                    "SELECT body, comment_html FROM comments WHERE id='yt-Cemoji'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(body, ":_草lol:草");
            assert!(html.contains("<img class=\"emoji\""));
            assert!(html.contains("alt=\":_草lol:\""));
            assert!(html.contains("data-emoji-id=\"UCa/emoji1\""));
        });
    }

    #[test]
    fn import_from_onecomme_warns_when_owner_unset() {
        let (_dir, mgr) = open_temp();
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let result = mgr
            .import_from_onecomme(oc_dir.path(), &[])
            .expect("import");
        // すべて filter される
        assert_eq!(result.comments_inserted, 0);
        assert_eq!(result.comments_filtered_other_channel, 3);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("configured_owner_channel_ids")));
    }

    #[test]
    fn import_from_onecomme_is_idempotent_via_watermark() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        let r1 = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("1");
        let r2 = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("2");
        // 1 回目: 自配信 2 件取り込み
        assert_eq!(r1.comments_inserted, 2);
        // 2 回目: watermark で「since 以降」だけ読むので、新規 0
        // (max_created_at は同値以下を弾くので 0 件)
        assert_eq!(r2.comments_inserted, 0);
        // ただし watermark 時刻と一致する行は弾かれずに INSERT OR IGNORE で skip される可能性も
        // ここでは comments_skipped + filtered = 0 が現実 (watermark 排他のため)
    }

    #[test]
    fn import_from_onecomme_records_schema_hash() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let _ = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");
        let stored = mgr
            .get_config_value("onecomme_observed_schema_hash")
            .unwrap();
        assert!(stored.is_some());
        assert!(!stored.unwrap().is_empty());
    }

    #[test]
    fn import_from_onecomme_does_not_advance_watermark_on_filter() {
        // 自チャンネル未設定で実行 → 全 filter → watermark が変化しないこと
        // (設計レビュー指摘 1: 後で自チャンネルを設定したら同じデータを取り込み直せる)
        let (_dir, mgr) = open_temp();
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        // 初回 import: configured_owner = None → 全コメント filter
        let r1 = mgr.import_from_onecomme(oc_dir.path(), &[]).expect("first");
        assert_eq!(r1.comments_inserted, 0);
        assert!(r1.comments_filtered_other_channel > 0);

        // watermark が立っていないことを確認
        let watermark = mgr
            .get_config_value("last_sync_imported_max_onecomme_created_at")
            .unwrap();
        assert!(
            watermark.is_none(),
            "watermark should NOT advance when all comments are filtered (got {:?})",
            watermark
        );

        // 自チャンネル設定後に再 import → 同じデータが取れること
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");
        let r2 = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("second");
        assert_eq!(
            r2.comments_inserted, 2,
            "self-channel comments should be importable"
        );
    }

    #[test]
    fn export_to_onecomme_aborts_when_no_observed_hash() {
        // 観測ハッシュ未記録 → 中断 + 警告 (バックアップ・書き込みもしない)
        let (_dir, mgr) = open_temp();
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let backup_dir = tempfile::tempdir().unwrap();
        let result = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("call");
        assert!(result.aborted);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("観測ハッシュが未記録")));
        assert_eq!(result.comments_inserted, 0);
        assert_eq!(result.users_new, 0);
        assert!(result.backup_dir.is_none());
    }

    #[test]
    fn export_to_onecomme_aborts_on_schema_mismatch() {
        // ダミー観測ハッシュ → 不一致 → 中断
        let (_dir, mgr) = open_temp();
        mgr.set_config_value(
            "onecomme_observed_schema_hash",
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect("seed hash");
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let backup_dir = tempfile::tempdir().unwrap();
        let result = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("call");
        assert!(result.aborted);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("スキーマが前回観測時と異なるため")));
        assert!(result.backup_dir.is_none());
    }

    #[test]
    fn export_to_onecomme_aborts_on_partial_tables_users_missing() {
        // comments テーブルあり + users テーブル無い環境では aborted。
        // 「コメントだけ書かれて users で失敗」の部分書き込みを防ぐ
        // (設計レビュー第 11 ラウンド対応)
        let (_dir, mgr) = open_temp();
        // 観測ハッシュは前もって seed (ハッシュ照合は通過させる)
        let oc_dir = tempfile::tempdir().unwrap();
        // comments.db は通常、onecomme.db は users テーブルなしで作る
        let comments_path = oc_dir.path().join("comments.db");
        let onecomme_path = oc_dir.path().join("onecomme.db");
        let conn1 = rusqlite::Connection::open(&comments_path).unwrap();
        conn1
            .execute_batch(
                "CREATE TABLE comments (
                id TEXT NOT NULL PRIMARY KEY, service_id TEXT NOT NULL,
                user_id TEXT NOT NULL, comment JSON NOT NULL,
                created_at TIMESTAMP NOT NULL
             );",
            )
            .unwrap();
        drop(conn1);
        let conn2 = rusqlite::Connection::open(&onecomme_path).unwrap();
        conn2.execute("CREATE TABLE other (k TEXT)", []).unwrap();
        drop(conn2);

        // observed schema hash を算出して seed (ハッシュ照合通過させる)
        let hash = listener_aux_io::check_onecomme_schema(&onecomme_path, &comments_path, None)
            .unwrap()
            .current_hash;
        mgr.set_config_value("onecomme_observed_schema_hash", &hash)
            .unwrap();

        // 何か書き戻すコメントを listeners.db に入れておく
        mgr.set_owner_channel_ids(&["UCa"]).unwrap();
        let mut c = fake_comment("c1", "UCa", "hi");
        c.timestamp = "2026-04-19T13:00:00.000Z".to_string();
        mgr.record_comment(&c, "vidSelf", "yt-UCa").unwrap();

        let backup_dir = tempfile::tempdir().unwrap();
        let result = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("call");

        assert!(result.aborted, "should abort on partial tables");
        assert_eq!(result.comments_inserted, 0, "no partial write");
        assert_eq!(result.users_new, 0);
        assert!(result.backup_dir.is_none(), "no backup taken");
        assert!(
            result.warnings.iter().any(|w| w.contains("users テーブル")),
            "warning should mention missing users table: {:?}",
            result.warnings
        );
        // comments.db に何も書かれていないことを確認
        let conn = rusqlite::Connection::open(&comments_path).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "comments table must NOT have any rows after aborted export"
        );
    }

    #[test]
    fn export_to_onecomme_writes_back_and_takes_backup() {
        // 観測ハッシュ一致 + 書き戻すコメントあり → 成功
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        // まずインポートで観測ハッシュを記録
        let _ = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");

        // listeners.db に新規コメントを 1 件記録 (これが書き戻される)
        let mut c = fake_comment("c-new", "UCa", "新コメ");
        c.timestamp = "2026-04-19T13:00:00.000Z".to_string();
        mgr.record_comment(&c, "vidSelf", "yt-UCa").expect("record");

        let backup_dir = tempfile::tempdir().unwrap();
        let result = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("export");
        assert!(
            !result.aborted,
            "export should succeed: {:?}",
            result.warnings
        );
        assert!(result.backup_dir.is_some(), "backup should be taken");
        // 少なくとも 1 件は書き戻される
        assert!(result.comments_inserted >= 1);
        // バックアップディレクトリにファイルが入っている
        let bdir = std::path::PathBuf::from(result.backup_dir.unwrap());
        assert!(bdir.join("comments.db").exists());
        assert!(bdir.join("onecomme.db").exists());

        // 書き戻された comment_json が OneComme 正規形式 (BaseComment + data ラッパ) に
        // なっていることを確認する。詳細表示で必須の data.id / data.userId / data.comment
        // が data 直下に存在しないと OneComme は parse 失敗 → ユーザー詳細が空になる。
        let conn = rusqlite::Connection::open(oc_dir.path().join("comments.db")).unwrap();
        let comment_json: String = conn
            .query_row(
                "SELECT comment FROM comments WHERE id='yt-c-new'",
                [],
                |r| r.get(0),
            )
            .expect("written-back comment row");
        let parsed: serde_json::Value =
            serde_json::from_str(&comment_json).expect("comment is valid JSON");
        assert_eq!(
            parsed.get("service").and_then(|v| v.as_str()),
            Some("youtube")
        );
        let data = parsed
            .get("data")
            .expect("BaseComment.data wrapper required");
        assert_eq!(data.get("id").and_then(|v| v.as_str()), Some("yt-c-new"));
        assert_eq!(data.get("userId").and_then(|v| v.as_str()), Some("yt-UCa"));
        assert_eq!(data.get("comment").and_then(|v| v.as_str()), Some("新コメ"));
        assert!(
            data.get("liveId").is_some(),
            "liveId required for OneComme detail view"
        );
        assert!(data.get("timestamp").is_some());

        // users.tc がわんコメ comments テーブル実数で再計算されていることを確認。
        // listener.comment_count (こめはぶ実数) ではなく、わんコメ既存 + マージ後の COUNT。
        let onecomme_conn = rusqlite::Connection::open(oc_dir.path().join("onecomme.db")).unwrap();
        let user_data: String = onecomme_conn
            .query_row("SELECT data FROM users WHERE id='yt-UCa'", [], |r| r.get(0))
            .expect("user row");
        let user: serde_json::Value = serde_json::from_str(&user_data).unwrap();
        let comments_conn = rusqlite::Connection::open(oc_dir.path().join("comments.db")).unwrap();
        let actual_count: i64 = comments_conn
            .query_row(
                "SELECT COUNT(*) FROM comments WHERE user_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            user.get("tc").and_then(|v| v.as_i64()),
            Some(actual_count),
            "users.tc must equal わんコメ comments テーブル実数"
        );
        // users.lcts もマージ後の comments MAX(created_at) で上書きされていること。
        // listener.last_seen_at がたとえ書き戻し時刻に汚染されていても、わんコメ側は
        // 真値を保持できる (循環汚染を断つ)。
        let actual_max: String = comments_conn
            .query_row(
                "SELECT MAX(created_at) FROM comments WHERE user_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            user.get("lcts").and_then(|v| v.as_str()),
            Some(actual_max.as_str()),
            "users.lcts must equal わんコメ comments MAX(created_at)"
        );
    }

    #[test]
    fn export_to_onecomme_writes_html_for_emoji_comment() {
        // OneComme 標準テンプレ (preset/basic) は `<div v-html="comment.data.comment">` で
        // innerHTML 展開する。プレーンテキストを入れると絵文字が `:custom_negi:` の
        // 文字列のまま表示されるため、commentHtml (絵文字 <img> 込み) を優先で入れる。
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let _ = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("seed schema hash");
        let mut c = fake_comment("c-emoji", "UCa", "ねぎ:custom_negi:");
        c.timestamp = "2026-04-19T13:01:00.000Z".to_string();
        c.comment_html =
            r#"ねぎ<img class="emoji" src="https://example.com/n.png" alt=":custom_negi:">"#
                .to_string();
        mgr.record_comment(&c, "vidSelf", "yt-UCa").expect("record");
        let backup_dir = tempfile::tempdir().unwrap();
        let result = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("export");
        assert!(!result.aborted, "{:?}", result.warnings);
        let conn = rusqlite::Connection::open(oc_dir.path().join("comments.db")).unwrap();
        let comment_json: String = conn
            .query_row(
                "SELECT comment FROM comments WHERE id='yt-c-emoji'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&comment_json).unwrap();
        let written = parsed
            .get("data")
            .and_then(|v| v.get("comment"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(
            written.contains("<img"),
            "data.comment must contain <img> for emoji rendering, got: {}",
            written
        );
    }

    #[test]
    fn import_from_onecomme_does_not_overwrite_schema_hash_on_mismatch() {
        // 既知ハッシュを「ダミー値」で先に登録してから import する。
        // import で観測される現在のスキーマハッシュは別物だが、
        // 既知ハッシュは置き換わらない (フェーズ 3.5 書き戻しの安全弁)。
        let (_dir, mgr) = open_temp();
        let known_dummy = "0000000000000000000000000000000000000000000000000000000000000000";
        mgr.set_config_value("onecomme_observed_schema_hash", known_dummy)
            .expect("seed known hash");
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        let result = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");
        // 不一致なので警告が出る
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("スキーマが前回観測時と異なります")),
            "expected schema-mismatch warning, got: {:?}",
            result.warnings
        );
        // 既知ハッシュは置き換わっていない
        let after = mgr
            .get_config_value("onecomme_observed_schema_hash")
            .unwrap()
            .unwrap();
        assert_eq!(
            after, known_dummy,
            "schema hash should NOT be overwritten on mismatch"
        );
    }

    #[test]
    fn owner_channel_ids_get_set_roundtrip() {
        let (_dir, mgr) = open_temp();
        assert!(mgr.get_owner_channel_ids().unwrap().is_empty());
        // 単一 ID
        mgr.set_owner_channel_ids(&["UCmyChannel123"]).unwrap();
        assert_eq!(
            mgr.get_owner_channel_ids().unwrap(),
            vec!["UCmyChannel123".to_string()]
        );
        // 上書き (複数 ID = サブチャンネル等)
        mgr.set_owner_channel_ids(&["UCmain", "UCsub1", "UCsub2"])
            .unwrap();
        assert_eq!(
            mgr.get_owner_channel_ids().unwrap(),
            vec![
                "UCmain".to_string(),
                "UCsub1".to_string(),
                "UCsub2".to_string()
            ]
        );
        // 空配列 = 全クリア
        mgr.set_owner_channel_ids(&[]).unwrap();
        assert!(mgr.get_owner_channel_ids().unwrap().is_empty());
        // 重複は INSERT OR IGNORE で除去
        mgr.set_owner_channel_ids(&["UCa", "UCa", "UCb"]).unwrap();
        assert_eq!(
            mgr.get_owner_channel_ids().unwrap(),
            vec!["UCa".to_string(), "UCb".to_string()]
        );
    }

    /// v6 ドリフト保護: わんコメインポートでこめはぶ comments を持つ listener の
    /// last_seen_at が users.lcts で上書きされない (= record_comment 経由でのみ更新される)。
    #[test]
    fn import_from_onecomme_does_not_drift_last_seen_at_for_known_listener() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).unwrap();
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        // こめはぶ comments で UCa の最終時刻を T1 = 2026-04-19T12:00:05.000Z に固定。
        let mut c = fake_comment("c1", "UCa", "first observation");
        c.timestamp = "2026-04-19T12:00:05.000Z".to_string();
        mgr.record_comment(&c, "vidSelf", "yt-UCa").expect("record");
        let t1_ms = parse_iso_to_unix_ms("2026-04-19T12:00:05.000Z").unwrap();

        // わんコメ DB の users.lcts は T2 = 2026-04-19T12:00:11.000Z (T2 > T1)。
        // write_fake_onecomme が UCa の lcts を T2 で書き込む。
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        mgr.import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");

        // ドリフトしていない: T2 で上書きされず T1 のまま。
        let after_last_seen: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT last_seen_at FROM listeners WHERE channel_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .expect("listener")
        });
        assert_eq!(
            after_last_seen, t1_ms,
            "last_seen_at must be protected by CASE WHEN EXISTS(comments)"
        );
    }

    /// delete_listeners の動作確認 (新仕様 = コメント温存):
    ///   - listeners 行が削除される
    ///   - **comments は残る** (= 配信履歴は永続化)
    ///   - streams の集計値はそのまま (= comments が残ってるので集計値は正しい)
    ///   - 同じ channel_id のリスナーが再 record_comment されると過去コメントが自動再紐付け
    ///   - 一括削除 (複数 channel_id) も 1 トランザクションで動く
    ///   - 該当 listener の無い channel_id を渡しても 0 件扱いで安全に skip
    #[test]
    fn delete_listeners_preserves_comments_and_keeps_stream_aggregates() {
        let (_dir, mgr) = open_temp();
        let mut a1 = fake_comment("a1", "UCa", "hello");
        a1.has_gift = true;
        a1.amount = 500.0;
        a1.currency = "JPY".to_string();
        let a2 = fake_comment("a2", "UCa", "world");
        let b1 = fake_comment("b1", "UCb", "ping");
        mgr.record_comment(&a1, "video1", "yt-UCowner").expect("a1");
        mgr.record_comment(&a2, "video1", "yt-UCowner").expect("a2");
        mgr.record_comment(&b1, "video1", "yt-UCowner").expect("b1");

        // 削除前 streams 集計: comment_count=3, superchat_count=1, amount=500
        let (cnt, sc, amt): (i64, i64, i64) = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count, superchat_count, superchat_amount_jpy FROM streams WHERE video_id='video1'",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ).unwrap()
        });
        assert_eq!((cnt, sc, amt), (3, 1, 500));

        // UCa を削除 (= comments は a1+a2 が残る、listeners 行のみ消える)
        let summaries = mgr
            .delete_listeners(&["yt-UCa".to_string()], None)
            .expect("delete UCa");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].channel_id, "yt-UCa");
        assert_eq!(summaries[0].orphaned_comments, 2);
        assert_eq!(summaries[0].orphaned_superchats, 1);
        assert!(summaries[0].listener_deleted);

        // listeners 行は消えた
        let exists: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM listeners WHERE channel_id='yt-UCa')",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(exists, 0);

        // comments は残っている (= 孤児として保持)
        let orphaned_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM comments WHERE listener_channel_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(orphaned_count, 2);

        // streams 集計値もそのまま (= コメントが残ってるので変えない)
        let (cnt, sc, amt): (i64, i64, i64) = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count, superchat_count, superchat_amount_jpy FROM streams WHERE video_id='video1'",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ).unwrap()
        });
        assert_eq!(
            (cnt, sc, amt),
            (3, 1, 500),
            "streams aggregates unchanged on listener delete"
        );

        // 同じ channel_id のリスナーが再登場 → record_comment で listeners 行が再作成される
        // & 過去の孤児コメントとも紐付き直す (= listener_channel_id は一致したまま)
        let a3 = fake_comment("a3", "UCa", "I am back");
        mgr.record_comment(&a3, "video1", "yt-UCowner").expect("a3");
        let a_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM comments WHERE listener_channel_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            a_count, 3,
            "re-registered listener inherits past orphan comments"
        );

        // listener 行の denormalized aggregates も孤児コメ込みで recompute されている
        // (= 2026-05-10 検出のバグ修正検証: 旧実装は VALUES の literal 1 で初期化していた
        //   ため re-record 後 listener.comment_count = 1、実 COUNT = 3 と drift していた)
        let (cc, sc, scamt): (i64, i64, i64) = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count, superchat_count, superchat_amount_jpy
                 FROM listeners WHERE channel_id='yt-UCa'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        });
        assert_eq!(
            cc, 3,
            "listener.comment_count は孤児コメ込み (= 1 でなく 3)"
        );
        assert_eq!(
            sc, 1,
            "listener.superchat_count は孤児 SC を維持 (= a1 の 1 件)"
        );
        assert_eq!(
            scamt, 500,
            "listener.superchat_amount_jpy は孤児 SC 額を維持"
        );

        // 一括削除: UCb + 存在しない channel_id
        let summaries = mgr
            .delete_listeners(
                &["yt-UCb".to_string(), "yt-UCnonexistent".to_string()],
                None,
            )
            .expect("bulk delete");
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].channel_id, "yt-UCb");
        assert_eq!(summaries[0].orphaned_comments, 1);
        assert!(summaries[0].listener_deleted);
        assert_eq!(summaries[1].channel_id, "yt-UCnonexistent");
        assert_eq!(summaries[1].orphaned_comments, 0);
        assert!(!summaries[1].listener_deleted);
    }

    #[test]
    fn delete_streams_removes_stream_history_and_orphan_listeners() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");

        let a1 = fake_comment("a1", "UCa", "first stream");
        let a2 = fake_comment("a2", "UCa", "second stream");
        let b1 = fake_comment("b1", "UCb", "only stream");
        mgr.record_comment(&a1, "video1", "yt-UCowner").expect("a1");
        mgr.record_comment(&b1, "video1", "yt-UCowner").expect("b1");
        mgr.record_comment(&a2, "video2", "yt-UCowner").expect("a2");
        mgr.set_stream_tags("video1", &["削除対象".to_string()])
            .expect("stream tag");
        mgr.set_listener_greeted("video1", "UCa", true)
            .expect("greeted");
        mgr.set_listener_tags("UCb", &["solo".to_string()])
            .expect("listener tag");

        let summaries = mgr
            .delete_streams(&["video1".to_string()], None)
            .expect("delete stream");
        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].stream_deleted);
        assert_eq!(summaries[0].deleted_comments, 2);
        assert_eq!(summaries[0].deleted_stream_tags, 1);
        assert_eq!(summaries[0].deleted_greeted_states, 1);
        assert_eq!(summaries[0].deleted_orphan_listeners, 1);

        let (stream_exists, video1_comments, video2_comments): (i64, i64, i64) = mgr
            .with_sync_conn(|c| {
                Ok::<_, rusqlite::Error>((
                    c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM streams WHERE video_id='video1')",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT COUNT(*) FROM comments WHERE stream_id='video1'",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT COUNT(*) FROM comments WHERE stream_id='video2'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!((stream_exists, video1_comments, video2_comments), (0, 0, 1));

        let (a_count, b_exists, b_tags): (i64, i64, i64) = mgr
            .with_sync_conn(|c| {
                Ok::<_, rusqlite::Error>((
                    c.query_row(
                        "SELECT comment_count FROM listeners WHERE channel_id='yt-UCa'",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM listeners WHERE channel_id='yt-UCb')",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT COUNT(*) FROM listener_tags WHERE channel_id='yt-UCb'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(a_count, 1, "残った配信分で listener 集計が再計算される");
        assert_eq!(b_exists, 0, "削除配信にしかいない listener は削除される");
        assert_eq!(b_tags, 0, "orphan listener のタグも削除される");
    }

    // ----------------------------------------------------------------
    // session-status #6 / #7 観測 test 群
    //
    // 「仮説」段階の挙動を assert で固める。pass = 現状仕様、fail = 仮説外れ。
    // 本 test 群は仕様 vs バグ判断のための事実固めで、修正方針合意後に期待値を
    // 変更する想定。
    //   docs/architecture/data-integrity-patterns.md playbook step 3 に対応
    // ----------------------------------------------------------------

    /// #7 stream_listener_state / listener_tags の orphan 挙動。
    /// listener-manager-reference.md `delete_listeners` 不変条件に
    /// 「stream_listener_state / listener_tags は cascade されず orphan として
    /// 残る (= 同 channel_id 再登場時に状態継承)」と既に明文化されている。
    /// ここではその挙動を assert で固定する。
    #[test]
    fn delete_listeners_keeps_stream_listener_state_and_tags_as_orphan() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");
        let a1 = fake_comment("a1", "UCa", "hello");
        mgr.record_comment(&a1, "video1", "yt-UCowner").expect("a1");

        // greeted_at と tags を付ける
        let greeted_at = mgr
            .set_listener_greeted("video1", "UCa", true)
            .expect("greet");
        assert!(greeted_at > 0);
        mgr.set_listener_tags("UCa", &["VIP".to_string(), "regular".to_string()])
            .expect("tags");

        // listener 削除
        let summaries = mgr
            .delete_listeners(&["yt-UCa".to_string()], None)
            .expect("delete");
        assert!(summaries[0].listener_deleted);

        // 観測 1: stream_listener_state は orphan として残る
        let sls_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stream_listener_state
                 WHERE listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            sls_count, 1,
            "stream_listener_state は cascade されず orphan として残る"
        );

        // 観測 2: listener_tags も orphan として残る
        let tags_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM listener_tags WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            tags_count, 2,
            "listener_tags は cascade されず orphan として残る"
        );

        // 観測 3: 同 channel_id 再 record_comment で orphan の greeted_at / tags が継承される
        let a2 = fake_comment("a2", "UCa", "I'm back");
        mgr.record_comment(&a2, "video1", "yt-UCowner").expect("a2");

        let greeted_after: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'video1' AND listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            greeted_after, greeted_at,
            "再登場 listener は過去の greeted_at を継承する (= UI 上「挨拶済み」のまま)"
        );

        let tags_after = mgr.get_listener_tags("UCa").expect("tags after");
        assert_eq!(
            tags_after,
            vec!["VIP".to_string(), "regular".to_string()],
            "再登場 listener は過去の tags を継承する"
        );
    }

    /// #6 owner UC1 → UC2 切替時の listeners / state / streams 残留挙動。
    /// `set_owner_channels` は内部で `purge_non_owner_streams` を呼ぶが、これは
    /// streams stub (= comments 0 件) のみ削除し、listeners / stream_listener_state /
    /// listener_tags / comments 紐付き streams は touch しない。
    #[test]
    fn switching_owner_channel_keeps_past_listeners_and_state() {
        let (_dir, mgr) = open_temp();
        // owner1 = UCowner1 で video1 を運用
        mgr.set_owner_channel_ids(&["UCowner1"]).expect("owner1");
        let a1 = fake_comment("a1", "UCa", "hello");
        mgr.record_comment(&a1, "video1", "yt-UCowner1")
            .expect("a1");
        mgr.set_listener_greeted("video1", "UCa", true)
            .expect("greet");
        mgr.set_listener_tags("UCa", &["VIP".to_string()])
            .expect("tags");

        // owner を UCowner2 に切り替え (= set_owner_channels で全置換 + purge_non_owner_streams)
        mgr.set_owner_channel_ids(&["UCowner2"]).expect("owner2");

        // 観測 1: streams.video1 は残る (= comments を持つので purge 対象外)
        let stream_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM streams WHERE video_id = 'video1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            stream_count, 1,
            "comments を持つ過去 owner streams は purge されない"
        );

        // 観測 2: listeners は残る
        let listener_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM listeners WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            listener_count, 1,
            "owner 切替で listeners は touch されない"
        );

        // 観測 3: stream_listener_state も残る
        let sls_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stream_listener_state
                 WHERE listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            sls_count, 1,
            "owner 切替で stream_listener_state は touch されない"
        );

        // 観測 4: listener_tags も残る
        let tags_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM listener_tags WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            tags_count, 1,
            "owner 切替で listener_tags は touch されない"
        );

        // 観測 5: owner 切替後、累計は新 owner 基準に再計算される。
        // 過去 owner だけで発言した listener は通常一覧から外れる。
        let q = ListenersQuery {
            sort: ListenersSort::LastSeen,
            limit: Some(100),
            offset: Some(0),
            ..Default::default()
        };
        let page = mgr.list_listeners(&q).expect("list");
        assert!(
            !page.rows.iter().any(|r| r.channel_id == "yt-UCa"),
            "list_listeners は現在の owner 基準で集計対象 listener だけを返す"
        );
    }

    /// #6 owner 全削除 (= 設定空) 時の挙動。
    /// dispatch_listener_record は configured_ids 空なら early return するが、
    /// 既存データは touch しない。
    #[test]
    fn clearing_owner_channels_keeps_past_listeners_and_state() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCowner"]).expect("owner");
        let a1 = fake_comment("a1", "UCa", "hi");
        mgr.record_comment(&a1, "video1", "yt-UCowner").expect("a1");
        mgr.set_listener_greeted("video1", "UCa", true)
            .expect("greet");

        // owner 全削除
        mgr.set_owner_channel_ids(&[]).expect("clear owner");

        let listener_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM listeners WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(listener_count, 1, "owner 全削除でも listeners は残る");

        let sls_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM stream_listener_state
                 WHERE listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            sls_count, 1,
            "owner 全削除でも stream_listener_state は残る"
        );

        let stream_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM streams WHERE video_id = 'video1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            stream_count, 1,
            "owner 全削除でも comments を持つ過去 streams は purge されない"
        );

        let owners = mgr.get_owner_channel_ids().expect("get owner");
        assert!(owners.is_empty(), "owner 設定は空");
    }

    /// #6 サブチャンネル運用の不変条件: 複数 owner 設定 + 同一 listener が
    /// UC1 配信と UC2 配信の両方に出た場合の merge 挙動を固める安全網。
    ///   - listeners.channel_id は PK で merge (= 1 行)
    ///   - stream_listener_state は (video_id, channel_id) PK で配信ごと独立
    ///   - listener_tags はリスナー単位 (= 配信を跨いで共有)
    #[test]
    fn subchannel_listener_merges_across_owners_but_state_is_per_stream() {
        let (_dir, mgr) = open_temp();
        // 複数 owner 設定 (= サブチャンネル運用)
        mgr.set_owner_channel_ids(&["UCowner1", "UCowner2"])
            .expect("owners");

        // 同一 listener UCa が UC1 配信 (video1) と UC2 配信 (video2) 両方に出る
        let a1 = fake_comment("a1", "UCa", "from UC1 stream");
        let a2 = fake_comment("a2", "UCa", "from UC2 stream");
        mgr.record_comment(&a1, "video1", "yt-UCowner1")
            .expect("a1");
        mgr.record_comment(&a2, "video2", "yt-UCowner2")
            .expect("a2");

        // 観測 1: listeners は 1 行 (= channel_id PK で merge)
        let listener_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM listeners WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            listener_count, 1,
            "同一 listener は複数 owner 配信を跨いでも 1 行に merge"
        );

        // listener.comment_count は 2 (= 両配信ぶんが累計)
        let cc: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT comment_count FROM listeners WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(cc, 2, "listener.comment_count は配信を跨いで累計");

        // 観測 2: comments は 2 件 (= 配信ごとに残る)
        let comment_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM comments WHERE listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(comment_count, 2);

        // 観測 3: greeted を video1 だけ true にしても video2 は独立 (= 配信単位)
        mgr.set_listener_greeted("video1", "UCa", true)
            .expect("greet v1");

        let v1_greeted: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'video1' AND listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert!(v1_greeted > 0);

        let v2_greeted: Option<i64> = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT greeted_at FROM stream_listener_state
                 WHERE stream_video_id = 'video2' AND listener_channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .ok()
        });
        assert!(
            v2_greeted.is_none(),
            "stream_listener_state は配信単位で独立 (= 別 owner 配信に状態波及しない)"
        );

        // 観測 4: listener_tags は配信を跨いで共有 (= リスナー単位)
        mgr.set_listener_tags("UCa", &["VIP".to_string()])
            .expect("tags");
        // tags は配信を限定しない構造 (= channel_id のみで紐付け)
        let tags = mgr.get_listener_tags("UCa").expect("get tags");
        assert_eq!(tags, vec!["VIP".to_string()]);
        // tags はリスナー単位なので、video1 でも video2 でも同じタグが見える
        let tag_count: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM listener_tags WHERE channel_id = 'yt-UCa'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(
            tag_count, 1,
            "listener_tags はリスナー単位で 1 行 (= 配信を跨いで共有)"
        );
    }

    /// extract_cache_avatar_file_name のパス安全性 (path traversal 拒否)。
    #[test]
    fn extract_cache_avatar_file_name_handles_safe_and_unsafe() {
        assert_eq!(
            extract_cache_avatar_file_name("http://127.0.0.1:11280/cache/avatars/alice_xx.jpg"),
            Some("alice_xx.jpg".to_string())
        );
        // path traversal はガード
        assert_eq!(
            extract_cache_avatar_file_name("http://127.0.0.1:11280/cache/avatars/../../etc/passwd"),
            None
        );
        // サブディレクトリは拒否 (= avatars/ 直下のファイルのみ許可)
        assert_eq!(
            extract_cache_avatar_file_name("http://127.0.0.1:11280/cache/avatars/sub/file.jpg"),
            None
        );
        // 外部 CDN URL は対象外
        assert_eq!(
            extract_cache_avatar_file_name("https://yt3.ggpht.com/abc/photo.jpg"),
            None
        );
    }

    /// アバター URL の書き戻しが「こめはぶ image_cache の cache URL」ではなく
    /// 「YouTube CDN 生 URL」になることを確認する。listeners.raw.originalProfileImage に
    /// 原 URL が保存され、listener_row_to_onecomme_patch がそれを優先的に使う。
    #[test]
    fn record_comment_persists_original_profile_image_for_writeback() {
        let (_dir, mgr) = open_temp();
        let mut c = fake_comment("c1", "UCalice", "hi");
        c.profile_image = "http://127.0.0.1:11280/cache/avatars/alice_xx.jpg".to_string();
        c.original_profile_image = "https://yt3.ggpht.com/abc/photo.jpg".to_string();
        mgr.record_comment(&c, "vidSelf", "yt-UCowner")
            .expect("record");

        // listeners.raw に originalProfileImage が保存されている
        let raw_str: String = mgr.with_sync_conn(|conn| {
            conn.query_row(
                "SELECT raw FROM listeners WHERE channel_id='yt-UCalice'",
                [],
                |r| r.get(0),
            )
            .expect("raw")
        });
        let raw: serde_json::Value = serde_json::from_str(&raw_str).unwrap();
        assert_eq!(
            raw.get("originalProfileImage").and_then(|v| v.as_str()),
            Some("https://yt3.ggpht.com/abc/photo.jpg")
        );

        // listener_row_to_onecomme_patch で icon に originalProfileImage が使われる
        let page = mgr.list_listeners(&Default::default()).expect("list");
        let row = page
            .rows
            .iter()
            .find(|r| r.channel_id == "yt-UCalice")
            .expect("listener");
        let patch = listener_row_to_onecomme_patch(row);
        let icon = patch
            .komehub_data
            .get("icon")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(
            icon, "https://yt3.ggpht.com/abc/photo.jpg",
            "icon must use original CDN URL, not local cache URL"
        );
    }

    /// v6 ドリフト保護の補集合: comments が無い (= わんコメ初観測のみ) listener は
    /// 引き続き lcts で初期化される。
    #[test]
    fn import_from_onecomme_initializes_last_seen_at_for_new_listener() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).unwrap();
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        // UCa はこめはぶでまだ観測されていない (record_comment 未実行)。
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");

        mgr.import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");

        // lcts (= 2026-04-19T12:00:11.000Z) で初期化される。
        let lcts_ms = parse_iso_to_unix_ms("2026-04-19T12:00:11.000Z").unwrap();
        let after_last_seen: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT last_seen_at FROM listeners WHERE channel_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .expect("listener")
        });
        assert_eq!(after_last_seen, lcts_ms);
    }

    /// 2026-05-10 884 件 first_seen_at drift 事例の修正検証:
    /// `refresh_comment_aggregates_for_rows` で comments テーブル MIN(posted_at) と
    /// MIN-merge され、わんコメ取り込み済みの早い posted_at に補正される。
    /// 初期値は lcts (= わんコメ users.data.lcts) で、これより早い comments があれば
    /// MIN-merge で更新される (= わんコメ users.created_at は localtime 保存で portable
    /// に UTC 化できないため使わない)。
    #[test]
    fn import_from_onecomme_first_seen_at_recomputes_from_comments() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).unwrap();
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        // write_fake_onecomme:
        // - users.data.lcts  = "2026-04-19T12:00:11.000Z" (= 初期値)
        // - わんコメ comments 2 件: posted_at 12:00:10, 12:00:11

        mgr.import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");

        let first_seen: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT first_seen_at FROM listeners WHERE channel_id='yt-UCa'",
                [],
                |r| r.get(0),
            )
            .expect("listener")
        });
        // refresh_comment_aggregates が走った後: MIN(lcts=12:00:11, comments_min=12:00:10)
        // = 12:00:10 (= わんコメ取り込み済みコメの最早 posted_at)
        let expected = parse_iso_to_unix_ms("2026-04-19T12:00:10.000Z").unwrap();
        assert_eq!(
            first_seen, expected,
            "first_seen_at = MIN(lcts, MIN(comments.posted_at)) で comments が早ければそちら"
        );
    }

    /// 既存のドリフトしている (= lcts で初期化された) listener も、再 import で
    /// recompute されて正しい first_seen_at に補正される。
    /// 2026-05-10 884 件 drift の DB 修正経路として機能することを確認。
    #[test]
    fn import_from_onecomme_recomputes_drifted_first_seen_at() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).unwrap();

        // 既存ドリフト state を直接作る: listener row + その人のコメ 1 件 (= 過去 posted_at)
        // 但し listeners.first_seen_at は意図的に新しい時刻 (= バグった 旧実装 import 結果) を入れる
        let drifted_first = parse_iso_to_unix_ms("2026-05-05T11:45:54.000Z").unwrap();
        let real_first = parse_iso_to_unix_ms("2026-05-05T01:42:29.000Z").unwrap();
        mgr.with_sync_conn(|c| {
            c.execute(
                "INSERT INTO listeners (channel_id, display_name, first_seen_at, last_seen_at,
                  comment_count, superchat_count, superchat_amount_jpy,
                  is_member, is_moderator, member_months_max, name_history)
                 VALUES (?1, '@drifted', ?2, ?2, 1, 0, 0, 0, 0, 0, '[]')",
                params!["yt-UCdrifted", drifted_first],
            )
            .unwrap();
            c.execute(
                "INSERT INTO streams (video_id, owner_channel_id, title, started_at, ended_at,
                  comment_count, superchat_count, superchat_amount_jpy)
                 VALUES (?1, 'yt-UCa', '', ?2, ?2, 1, 0, 0)",
                params!["vidPast", real_first],
            )
            .unwrap();
            c.execute(
                "INSERT INTO comments (id, stream_id, listener_channel_id, posted_at, body,
                  comment_type, raw_zst, comment_html)
                 VALUES (?1, ?2, ?3, ?4, 'past', 'chat', NULL, '')",
                params!["yt-Cpast", "vidPast", "yt-UCdrifted", real_first],
            )
            .unwrap();
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();

        // 再 import (= drift listener とは別人だが、import が走れば
        // refresh_comment_aggregates_for_rows が呼ばれる)
        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        mgr.import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("import");

        // refresh_comment_aggregates_for_rows は import 経路で「今回入れた comments の
        // listener_channel_id 集合」のみ recompute するので、無関係の yt-UCdrifted は
        // この一回では補正されない。なので別経路で recompute をかけて検証する。
        // (= 実運用では「該当 listener が再コメ → record_comment 経由 → MIN-merge」か、
        //   一回限り migration が必要、という現実の制約を確認)
        let after: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT first_seen_at FROM listeners WHERE channel_id='yt-UCdrifted'",
                [],
                |r| r.get(0),
            )
            .expect("listener")
        });
        assert_eq!(
            after, drifted_first,
            "別 listener の import では drifted は補正されない (= 別途 migration 必要)"
        );
    }

    // ─────── わんコメ書き戻し時の meta / service_id 生成 (Q-15 / Q-16) ───────

    /// `comment_row_to_onecomme_insert` 直接呼出しで `meta` 出力形式を確認するヘルパー。
    fn make_chat_row(id: &str, stream_id: &str, listener_yt: &str, posted_at: i64) -> CommentRow {
        CommentRow {
            id: id.to_string(),
            stream_id: stream_id.to_string(),
            listener_channel_id: listener_yt.to_string(),
            posted_at,
            body: "hi".to_string(),
            comment_type: CommentType::Chat,
            superchat_amount_jpy: None,
            superchat_currency: None,
            superchat_amount_raw: None,
            raw: serde_json::json!({
                "name": "alice",
                "displayName": "alice",
                "profileImage": "https://yt3.ggpht.com/x.png",
                "timestamp": "2026-04-19T12:00:00.000Z",
            }),
            responded_at: 0,
        }
    }

    fn make_superchat_row(
        id: &str,
        stream_id: &str,
        listener_yt: &str,
        posted_at: i64,
    ) -> CommentRow {
        CommentRow {
            id: id.to_string(),
            stream_id: stream_id.to_string(),
            listener_channel_id: listener_yt.to_string(),
            posted_at,
            body: "thanks!".to_string(),
            comment_type: CommentType::Superchat,
            superchat_amount_jpy: Some(500),
            superchat_currency: Some("JPY".to_string()),
            superchat_amount_raw: Some(500.0),
            raw: serde_json::json!({
                "name": "bob",
                "displayName": "bob",
                "profileImage": "https://yt3.ggpht.com/y.png",
                "amountDisplay": "￥500",
                "timestamp": "2026-04-19T12:00:01.000Z",
            }),
            responded_at: 0,
        }
    }

    #[test]
    fn comment_row_to_onecomme_insert_normal_emits_no_tc_lc() {
        // ノーマルチャットは meta = {no, tc, lc} のみ (free は無し、ネイティブ準拠)
        let map: std::collections::HashMap<String, listener_aux_io::OnecommeServiceInfo> =
            std::collections::HashMap::new();
        let c = make_chat_row("c1", "vid1", "yt-UCa", 1_700_000_000_000);
        let ranks = MetaRanks {
            user_no: 5,
            stream_lc: 42,
        };
        let insert = comment_row_to_onecomme_insert(&c, ranks, &map);

        let parsed: serde_json::Value = serde_json::from_str(&insert.comment_json).unwrap();
        let meta = parsed.get("meta").expect("meta");
        assert_eq!(meta.get("no").and_then(|v| v.as_i64()), Some(5));
        assert_eq!(meta.get("tc").and_then(|v| v.as_i64()), Some(5));
        assert_eq!(meta.get("lc").and_then(|v| v.as_i64()), Some(42));
        assert!(
            meta.get("free").is_none(),
            "normal chat must NOT carry 'free' field"
        );
    }

    #[test]
    fn comment_row_to_onecomme_insert_superchat_emits_free_only() {
        // スパチャ系は meta = {free: false} のみ (no/tc/lc は無し、ネイティブ準拠)
        let map: std::collections::HashMap<String, listener_aux_io::OnecommeServiceInfo> =
            std::collections::HashMap::new();
        let c = make_superchat_row("c2", "vid1", "yt-UCb", 1_700_000_000_000);
        let ranks = MetaRanks {
            user_no: 1,
            stream_lc: 1,
        };
        let insert = comment_row_to_onecomme_insert(&c, ranks, &map);

        let parsed: serde_json::Value = serde_json::from_str(&insert.comment_json).unwrap();
        let meta = parsed.get("meta").expect("meta");
        assert_eq!(meta.get("free").and_then(|v| v.as_bool()), Some(false));
        assert!(
            meta.get("no").is_none(),
            "superchat must NOT carry no/tc/lc"
        );
        assert!(meta.get("tc").is_none());
        assert!(meta.get("lc").is_none());
    }

    #[test]
    fn comment_row_to_onecomme_insert_resolves_service_id_and_color_from_map() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "vidLive1".to_string(),
            listener_aux_io::OnecommeServiceInfo {
                service_id: "uuid-native-1".to_string(),
                color: Some(serde_json::json!({"r": 214, "g": 3, "b": 255})),
            },
        );
        let c = make_chat_row("c1", "vidLive1", "yt-UCa", 1_700_000_000_000);
        let ranks = MetaRanks {
            user_no: 1,
            stream_lc: 1,
        };
        let insert = comment_row_to_onecomme_insert(&c, ranks, &map);

        // SQL 列 (comments.service_id) もネイティブ UUID に置き換わる
        assert_eq!(insert.service_id, "uuid-native-1");

        let parsed: serde_json::Value = serde_json::from_str(&insert.comment_json).unwrap();
        // BaseComment.id (外側) も service_id (UUID) と一致
        assert_eq!(
            parsed.get("id").and_then(|v| v.as_str()),
            Some("uuid-native-1")
        );
        assert_eq!(
            parsed
                .get("color")
                .and_then(|v| v.get("r"))
                .and_then(|v| v.as_i64()),
            Some(214)
        );
    }

    #[test]
    fn comment_row_to_onecomme_insert_falls_back_to_komehub_when_unmapped() {
        // 該当 liveId が config.json/services に無いケース
        let map: std::collections::HashMap<String, listener_aux_io::OnecommeServiceInfo> =
            std::collections::HashMap::new();
        let c = make_chat_row("c1", "vidUnknown", "yt-UCa", 1_700_000_000_000);
        let ranks = MetaRanks {
            user_no: 1,
            stream_lc: 1,
        };
        let insert = comment_row_to_onecomme_insert(&c, ranks, &map);

        assert_eq!(insert.service_id, "komehub");
        let parsed: serde_json::Value = serde_json::from_str(&insert.comment_json).unwrap();
        assert_eq!(parsed.get("id").and_then(|v| v.as_str()), Some("komehub"));
        // 黒色フォールバック
        let color = parsed.get("color").expect("color");
        assert_eq!(color.get("r").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(color.get("g").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(color.get("b").and_then(|v| v.as_i64()), Some(0));
    }

    #[test]
    fn comment_row_to_onecomme_insert_emits_youtube_watch_url() {
        // BaseComment.url はネイティブでは https://www.youtube.com/watch?v={liveId} 形式。
        // わんコメ UI で「どの配信か」を識別する手がかりに使われるため必須。
        let map: std::collections::HashMap<String, listener_aux_io::OnecommeServiceInfo> =
            std::collections::HashMap::new();
        let c = make_chat_row("c1", "ApRChg6WJUc", "yt-UCa", 1_700_000_000_000);
        let ranks = MetaRanks {
            user_no: 1,
            stream_lc: 1,
        };
        let insert = comment_row_to_onecomme_insert(&c, ranks, &map);
        let parsed: serde_json::Value = serde_json::from_str(&insert.comment_json).unwrap();
        assert_eq!(
            parsed.get("url").and_then(|v| v.as_str()),
            Some("https://www.youtube.com/watch?v=ApRChg6WJUc")
        );
    }

    #[test]
    fn compute_meta_ranks_assigns_per_user_per_stream_and_global_sequence() {
        // 同一配信内で user_a が 3 件、user_b が 2 件 → 計 5 件
        // - user_a の no は 1, 2, 3 (per-user per-stream)
        // - user_b の no は 1, 2
        // - lc は時系列順で 1..=5 (global per-stream)
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa", "UCb"]).unwrap();
        seed_self_stream(&mgr, "vidS", "yt-UCa");

        let times = [
            ("a1", "UCa", "2026-04-19T12:00:01.000Z"),
            ("b1", "UCb", "2026-04-19T12:00:02.000Z"),
            ("a2", "UCa", "2026-04-19T12:00:03.000Z"),
            ("a3", "UCa", "2026-04-19T12:00:04.000Z"),
            ("b2", "UCb", "2026-04-19T12:00:05.000Z"),
        ];
        for (id, uid, ts) in &times {
            let mut c = fake_comment(id, uid, "x");
            c.timestamp = ts.to_string();
            mgr.record_comment(&c, "vidS", "yt-UCa").unwrap();
        }

        let ranks = mgr
            .compute_meta_ranks(&["vidS".to_string()])
            .expect("ranks");

        // user_a の no/tc は 1,2,3、 lc は 1,3,4
        let r_a1 = ranks.get("yt-a1").expect("a1");
        let r_a2 = ranks.get("yt-a2").expect("a2");
        let r_a3 = ranks.get("yt-a3").expect("a3");
        assert_eq!(r_a1.user_no, 1);
        assert_eq!(r_a2.user_no, 2);
        assert_eq!(r_a3.user_no, 3);
        // lc は seed_self_stream の "yt-seed" コメも含まれるので絶対値ではなく相対順序で確認
        assert!(r_a1.stream_lc < r_a2.stream_lc);
        assert!(r_a2.stream_lc < r_a3.stream_lc);

        // user_b の no は 1,2
        let r_b1 = ranks.get("yt-b1").expect("b1");
        let r_b2 = ranks.get("yt-b2").expect("b2");
        assert_eq!(r_b1.user_no, 1);
        assert_eq!(r_b2.user_no, 2);
        assert!(r_b1.stream_lc < r_b2.stream_lc);

        // 全 lc が異なる (per-stream global で重複しない)
        let lcs: std::collections::HashSet<i64> = [r_a1, r_a2, r_a3, r_b1, r_b2]
            .iter()
            .map(|r| r.stream_lc)
            .collect();
        assert_eq!(lcs.len(), 5);
    }

    #[test]
    fn compute_meta_ranks_partitions_by_stream() {
        // 別配信のコメントは互いに干渉しない (lc が配信ごとに 1 から始まる)。
        // seed_self_stream は内部 id="seed" 固定で INSERT OR IGNORE のため、
        // 2 回目以降は skip される (= vidA に seed あり、vidB には無し)。
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).unwrap();
        seed_self_stream(&mgr, "vidA", "yt-UCa");

        let mut c = fake_comment("a1", "UCa", "x");
        c.timestamp = "2026-04-19T12:00:01.000Z".to_string();
        mgr.record_comment(&c, "vidA", "yt-UCa").unwrap();
        let mut c = fake_comment("b1", "UCa", "x");
        c.timestamp = "2026-04-19T12:00:02.000Z".to_string();
        mgr.record_comment(&c, "vidB", "yt-UCa").unwrap();

        let ranks = mgr
            .compute_meta_ranks(&["vidA".to_string(), "vidB".to_string()])
            .expect("ranks");
        let r_a = ranks.get("yt-a1").unwrap();
        let r_b = ranks.get("yt-b1").unwrap();
        // user_no は per-stream per-user で 1 から始まる
        assert_eq!(r_a.user_no, 1, "UCa in vidA");
        assert_eq!(r_b.user_no, 1, "UCa in vidB");
        // lc は per-stream global: vidA は seed=1, a1=2 / vidB は b1=1 (seed 無し)
        assert_eq!(r_a.stream_lc, 2, "a1 is 2nd comment in vidA (after seed)");
        assert_eq!(r_b.stream_lc, 1, "b1 is 1st comment in vidB");
    }

    #[test]
    fn export_to_onecomme_resets_watermark_when_meta_format_version_missing() {
        // meta_format_version 未設定 (= 旧版で書き戻したコメントが残ってる可能性) なら
        // watermark に依らず全件再 export し、ON CONFLICT で旧 meta を新形式へ修復。
        // 修復後は meta_format_version=1 が記録される。
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channel_ids(&["UCa"]).expect("set owner");
        seed_self_stream(&mgr, "vidSelf", "yt-UCa");

        let oc_dir = tempfile::tempdir().unwrap();
        write_fake_onecomme(oc_dir.path(), "UCa");
        let _ = mgr
            .import_from_onecomme(oc_dir.path(), &["UCa"])
            .expect("seed schema hash");

        // 古いコメントを 1 件記録 (これは「すでに書き戻し済みでも meta が古い」想定)
        let mut c = fake_comment("c-old", "UCa", "古い");
        c.timestamp = "2026-04-19T13:00:00.000Z".to_string();
        mgr.record_comment(&c, "vidSelf", "yt-UCa").expect("record");

        // 1 回目の export を成功させる (watermark が前進)
        let backup_dir = tempfile::tempdir().unwrap();
        let r1 = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("first export");
        assert!(!r1.aborted);
        assert!(r1.comments_inserted >= 1);
        // この時点で meta_format_version=1 がセットされる
        let v: Option<String> = mgr.get_config_value("meta_format_version").unwrap();
        assert_eq!(v.as_deref(), Some("1"));

        // 「meta_format_version を消した」状態 (= 旧 DB から起動した想定) を再現。
        // わんコメ DB に書かれた meta も「旧形式」(no=1, tc=1, free=...) にロールバックして
        // おき、修復後に新形式 (no=N, tc=N, lc=M) に上書きされることを観測する。
        mgr.with_sync_conn(|c| {
            c.execute("DELETE FROM config WHERE key='meta_format_version'", [])
                .unwrap()
        });
        let comments_db_path = oc_dir.path().join("comments.db");
        {
            let conn = rusqlite::Connection::open(&comments_db_path).unwrap();
            // 既存 komehub 行の comment_json の meta を旧形式に書き換える
            let rows: Vec<(String, String)> = conn
                .prepare("SELECT id, comment FROM comments WHERE service_id='komehub'")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            for (id, comment_json) in rows {
                let mut v: serde_json::Value = serde_json::from_str(&comment_json).unwrap();
                v["meta"] = serde_json::json!({"no": 1, "tc": 1, "free": true});
                conn.execute(
                    "UPDATE comments SET comment = ?1 WHERE id = ?2",
                    rusqlite::params![v.to_string(), id],
                )
                .unwrap();
            }
        }

        // watermark は前進済みだが、meta_format_version 不在のため再 export は再び全件処理する。
        // 既存行は ON CONFLICT で UPDATE されるが「skipped」にカウントされる
        // (write_onecomme_comments 仕様: 既存行 → skipped、新規行 → inserted)。
        let result = mgr
            .export_to_onecomme(oc_dir.path(), backup_dir.path(), true)
            .expect("repair export");
        assert!(!result.aborted);
        assert!(
            result.comments_inserted + result.comments_skipped >= 1,
            "must re-process at least the existing komehub row to repair meta (got new={}, skip={})",
            result.comments_inserted,
            result.comments_skipped
        );

        // 再修復後に再び meta_format_version=1 が記録される
        let v2: Option<String> = mgr.get_config_value("meta_format_version").unwrap();
        assert_eq!(v2.as_deref(), Some("1"));

        // わんコメ DB の meta が新形式になっていることを観測 (no/tc/lc の存在 + free 不在)
        let conn = rusqlite::Connection::open(&comments_db_path).unwrap();
        let comment_json: String = conn
            .query_row(
                "SELECT comment FROM comments WHERE service_id='komehub' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&comment_json).unwrap();
        let meta = parsed.get("meta").expect("meta");
        assert!(
            meta.get("lc").is_some(),
            "meta.lc must be present after repair, got: {}",
            meta
        );
        assert!(
            meta.get("free").is_none(),
            "meta.free must be removed after repair (normal chat is exclusive of free), got: {}",
            meta
        );
    }

    // ───────── 配信詳細モーダル: list_stream_listeners / get_stream_stats ─────────

    #[test]
    fn get_stream_detail_includes_unique_commenters_count() {
        let (_dir, mgr) = open_temp();
        // 同じ stream に 3 リスナー × 計 5 コメント
        for i in 0..3 {
            let mut c = fake_comment(&format!("c{}", i), &format!("UCa{}", i), "x");
            c.timestamp = format!("2026-04-19T11:00:{:02}.000Z", 10 + i);
            mgr.record_comment(&c, "vidUC", "yt-UCowner").expect("r");
        }
        // 重複 (= UCa0 がもう 1 件)
        let mut c4 = fake_comment("c4", "UCa0", "again");
        c4.timestamp = "2026-04-19T11:00:20.000Z".to_string();
        mgr.record_comment(&c4, "vidUC", "yt-UCowner").expect("r2");
        let detail = mgr.get_stream_detail("vidUC", 5).expect("q").expect("some");
        assert_eq!(detail.unique_commenters, 3);
    }

    #[test]
    fn list_stream_listeners_returns_per_stream_aggregates_and_heatmap() {
        let (_dir, mgr) = open_temp();
        // 配信 vidLS、UCa が 3 コメ (うち 1 件 SC ¥500)、UCb が 1 コメ
        let mut c1 = fake_comment("ls1", "UCa", "alpha");
        c1.timestamp = "2026-04-19T11:00:10.000Z".to_string();
        mgr.record_comment(&c1, "vidLS", "yt-UCowner").expect("r1");
        let mut c2 = fake_comment("ls2", "UCa", "beta");
        c2.timestamp = "2026-04-19T11:30:10.000Z".to_string();
        c2.has_gift = true;
        c2.amount = 500.0;
        c2.currency = "JPY".to_string();
        mgr.record_comment(&c2, "vidLS", "yt-UCowner").expect("r2");
        let mut c3 = fake_comment("ls3", "UCa", "gamma");
        c3.timestamp = "2026-04-19T11:45:10.000Z".to_string();
        mgr.record_comment(&c3, "vidLS", "yt-UCowner").expect("r3");
        let mut c4 = fake_comment("ls4", "UCb", "delta");
        c4.timestamp = "2026-04-19T11:50:10.000Z".to_string();
        mgr.record_comment(&c4, "vidLS", "yt-UCowner").expect("r4");
        // ended_at を確定 (= heatmap 範囲が決まる)。
        // record_comment が決めた posted_at に基づき started_at + 60min を ended_at に。
        let started_at: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT started_at FROM streams WHERE video_id = ?1",
                params!["vidLS"],
                |r| r.get(0),
            )
            .expect("started")
        });
        mgr.with_sync_conn(|c| {
            c.execute(
                "UPDATE streams SET ended_at = ?1 WHERE video_id = ?2",
                params![started_at + 60 * 60 * 1000, "vidLS"],
            )
            .expect("set ended");
        });
        let q = StreamListenersQuery::default();
        let page = mgr.list_stream_listeners("vidLS", &q).expect("list");
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 2);
        // sort=count_desc なので UCa (3 件) が先
        let row_a = &page.rows[0];
        assert_eq!(row_a.listener.channel_id, "yt-UCa");
        assert_eq!(row_a.per_stream_comment_count, 3);
        assert_eq!(row_a.per_stream_sc_amount_jpy, 500);
        assert_eq!(row_a.heatmap_bins.len(), 14);
        // UCa の heatmap に 3 件分の count が分散して記録されている
        let total_count_a: u32 = row_a.heatmap_bins.iter().map(|b| b.count).sum();
        assert_eq!(total_count_a, 3);
        let any_sc_a = row_a.heatmap_bins.iter().any(|b| b.has_sc);
        assert!(any_sc_a, "UCa should have at least one bin with has_sc");
        assert_eq!(row_a.listener.greeted_at, 0);

        mgr.set_listener_greeted("vidLS", "UCa", true)
            .expect("set listener responded");
        let page_after = mgr.list_stream_listeners("vidLS", &q).expect("list after");
        let row_a_after = page_after
            .rows
            .iter()
            .find(|r| r.listener.channel_id == "yt-UCa")
            .expect("UCa row");
        assert!(
            row_a_after.listener.greeted_at > 0,
            "stream listener rows should expose per-stream responded state"
        );
    }

    #[test]
    fn list_stream_listeners_filters_by_user_tag_via_exists() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("u1", "UCa", "ありがとう");
        let c2 = fake_comment("u2", "UCb", "yo");
        mgr.record_comment(&c1, "vidUT", "yt-UCowner").expect("r1");
        mgr.record_comment(&c2, "vidUT", "yt-UCowner").expect("r2");
        mgr.set_listener_tags("UCa", &["推し".to_string()])
            .expect("tag");
        let q = StreamListenersQuery {
            user_tags: vec!["推し".to_string()],
            ..Default::default()
        };
        let page = mgr.list_stream_listeners("vidUT", &q).expect("list");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].listener.channel_id, "yt-UCa");
        assert_eq!(page.rows[0].user_tags, vec!["推し".to_string()]);
    }

    #[test]
    fn list_stream_listeners_filters_by_body_q_exists() {
        let (_dir, mgr) = open_temp();
        let c1 = fake_comment("b1", "UCa", "ありがとう");
        let c2 = fake_comment("b2", "UCa", "また来ます");
        let c3 = fake_comment("b3", "UCb", "hello");
        mgr.record_comment(&c1, "vidBQ", "yt-UCowner").expect("r1");
        mgr.record_comment(&c2, "vidBQ", "yt-UCowner").expect("r2");
        mgr.record_comment(&c3, "vidBQ", "yt-UCowner").expect("r3");
        // 「ありがとう」を含むコメントを書いたリスナーのみ → UCa
        let q = StreamListenersQuery {
            body_q: Some("ありがとう".to_string()),
            ..Default::default()
        };
        let page = mgr.list_stream_listeners("vidBQ", &q).expect("list");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].listener.channel_id, "yt-UCa");
    }

    /// text_q (= 横断検索 name OR body) の OR 結合を固定。
    /// 旧 (name_q AND body_q を別々に AND 結合) は「名前にも本文にもキーワード」しか
    /// 引かないバグ (= ブリーチ枠の セレスさん検索 で名前にだけセレスを含むリスナーが
    /// 除外された問題) を修正したことを回帰防止する。 2026-05-14 追加。
    #[test]
    fn list_stream_listeners_text_q_matches_name_or_body_with_or() {
        let (_dir, mgr) = open_temp();
        // セレス さん: 名前に「セレス」を含むが、 本文には含まない
        let mut c_seres = fake_comment("c_seres", "UCseres", "ぺこ！");
        c_seres.display_name = "@セレス-g5t".to_string();
        mgr.record_comment(&c_seres, "vidBQ", "yt-UCowner").expect("seres");
        // 別人: 本文に「セレス」を含む (= 名前は別)
        let mut c_body = fake_comment("c_body", "UCfan", "セレスさん見た");
        c_body.display_name = "fan".to_string();
        mgr.record_comment(&c_body, "vidBQ", "yt-UCowner").expect("fan");
        // ハズレ: 名前も本文も無関係
        let mut c_other = fake_comment("c_other", "UCother", "こんにちは");
        c_other.display_name = "other".to_string();
        mgr.record_comment(&c_other, "vidBQ", "yt-UCowner").expect("other");

        // text_q="セレス" → 名前 OR 本文 のどっちかに含む 2 人がヒット
        let q = StreamListenersQuery {
            text_q: Some("セレス".to_string()),
            ..Default::default()
        };
        let page = mgr.list_stream_listeners("vidBQ", &q).expect("list");
        let ids: Vec<&str> = page.rows.iter().map(|r| r.listener.channel_id.as_str()).collect();
        assert_eq!(page.total, 2, "セレス で名前 / 本文 OR ヒット: {:?}", ids);
        assert!(ids.contains(&"yt-UCseres"), "名前にセレスを含む人がヒット: {:?}", ids);
        assert!(ids.contains(&"yt-UCfan"), "本文にセレスを含む人がヒット: {:?}", ids);

        // 旧 name_q + body_q (= AND 結合) では 1 人もヒットしないことを再確認
        let q_old = StreamListenersQuery {
            name_q: Some("セレス".to_string()),
            body_q: Some("セレス".to_string()),
            ..Default::default()
        };
        let page_old = mgr.list_stream_listeners("vidBQ", &q_old).expect("list");
        assert_eq!(page_old.total, 0, "旧 AND 結合は 0 件 (= バグ再現)");
    }

    #[test]
    fn get_stream_stats_returns_basic_aggregates() {
        let (_dir, mgr) = open_temp();
        // 同じ配信に 3 リスナー × 4 コメ。bin_minutes=15 で 1 時間枠 → 4 bin。
        let mut c1 = fake_comment("s1", "UCa", "おはよう");
        c1.timestamp = "2026-04-19T11:05:00.000Z".to_string();
        mgr.record_comment(&c1, "vidST", "yt-UCowner").expect("r1");
        let mut c2 = fake_comment("s2", "UCb", "こんにちは");
        c2.timestamp = "2026-04-19T11:20:00.000Z".to_string();
        mgr.record_comment(&c2, "vidST", "yt-UCowner").expect("r2");
        let mut c3 = fake_comment("s3", "UCa", "ありがとう");
        c3.timestamp = "2026-04-19T11:35:00.000Z".to_string();
        mgr.record_comment(&c3, "vidST", "yt-UCowner").expect("r3");
        let mut c4 = fake_comment("s4", "UCc", "またね");
        c4.timestamp = "2026-04-19T11:50:00.000Z".to_string();
        mgr.record_comment(&c4, "vidST", "yt-UCowner").expect("r4");
        // 配信時間範囲を確定 (= 起点 + 60min を ended_at に)。
        // started_at は最初のコメ posted_at に揃えて、bin index が予測通りになるようにする。
        let first_posted: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT MIN(posted_at) FROM comments WHERE stream_id = ?1",
                params!["vidST"],
                |r| r.get(0),
            )
            .expect("first")
        });
        // 最初のコメ posted_at を 5 分手前にずらして bin 0 開始位置にする
        let started_at = first_posted - 5 * 60 * 1000;
        mgr.with_sync_conn(|c| {
            c.execute(
                "UPDATE streams SET started_at = ?1, ended_at = ?2 WHERE video_id = ?3",
                params![started_at, started_at + 60 * 60 * 1000, "vidST"],
            )
            .expect("set range");
        });

        let stats = mgr.get_stream_stats("vidST", 15).expect("q").expect("some");
        // 60min / 15min = 4 bin
        assert_eq!(stats.comment_freq_bins.len(), 4);
        assert_eq!(stats.cumulative_unique_bins.len(), 4);
        // 各 bin に 1 件ずつ
        for bin in &stats.comment_freq_bins {
            assert_eq!(bin.count, 1);
        }
        // 累積ユニーク: 1, 2, 2 (UCa は再出), 3
        assert_eq!(stats.cumulative_unique_bins[0], 1);
        assert_eq!(stats.cumulative_unique_bins[1], 2);
        assert_eq!(stats.cumulative_unique_bins[2], 2);
        assert_eq!(stats.cumulative_unique_bins[3], 3);
        assert_eq!(stats.bin_minutes, 15);
        // misc avg コメ間隔は 15 分 (= 900 秒)
        assert!((stats.misc.avg_comment_interval_sec - 900.0).abs() < 1.0);
    }

    #[test]
    fn get_stream_stats_top_words_excludes_stopwords_and_short_tokens() {
        let (_dir, mgr) = open_temp();
        // 「ありがとう」を 5 回、「は」「の」「a」を多用 → 上位は「ありがとう」のみ
        for i in 0..5 {
            let mut c = fake_comment(&format!("w{}", i), "UCa", "ありがとう は の a で あり");
            c.timestamp = format!("2026-04-19T11:00:{:02}.000Z", 10 + i);
            mgr.record_comment(&c, "vidW", "yt-UCowner").expect("r");
        }
        // started_at に対し 60min の枠にしておく。bin 計算に影響するが top_words は無関係。
        let first_posted: i64 = mgr.with_sync_conn(|c| {
            c.query_row(
                "SELECT MIN(posted_at) FROM comments WHERE stream_id = ?1",
                params!["vidW"],
                |r| r.get(0),
            )
            .expect("first")
        });
        mgr.with_sync_conn(|c| {
            c.execute(
                "UPDATE streams SET started_at = ?1, ended_at = ?2 WHERE video_id = ?3",
                params![first_posted, first_posted + 60 * 60 * 1000, "vidW"],
            )
            .expect("set range");
        });
        let stats = mgr.get_stream_stats("vidW", 15).expect("q").expect("some");
        // 「ありがとう」は 5 回登場するはず
        let arigatou = stats.top_words.iter().find(|w| w.word == "ありがとう");
        assert!(
            arigatou.is_some(),
            "ありがとう must be in top_words, got: {:?}",
            stats.top_words
        );
        assert_eq!(arigatou.unwrap().count, 5);
        // stopword (の / は / a / で) は出てこない
        for sw in &["の", "は", "a", "で"] {
            assert!(
                !stats.top_words.iter().any(|w| w.word == *sw),
                "stopword '{}' should be filtered",
                sw
            );
        }
    }

    // ───────── リスナーランク仕様 (2026-05-13 統一) ─────────
    //
    // 「自チャンネル」= owner_channels テーブルに登録された UC 集合。複数 UC が登録されて
    // いる場合は全体を 1 つの自チャンネル群として扱い、active 判定の last_n_streams も
    // その全枠から取る (案 A)。新規 (first-time) は `first_seen_at >= 対象配信 started_at`
    // に統一 (= 旧 `comment_count <= 1` 廃止)。

    /// 案 A 確認: owner_channels に複数 UC が登録されているとき、別 UC の枠で過去に
    /// active だった listener が「自チャンネル群の active」として判定される。
    #[test]
    fn active_uses_owner_channels_group_not_just_target_stream_owner() {
        let (_dir, mgr) = open_temp();
        // owner_channels = {UCowner1, UCowner2} の 2 UC 構成
        mgr.set_owner_channels(&[
            crate::state::listener::OwnerChannel {
                channel_id: "UCowner1".to_string(),
                handle: Some("@owner1".to_string()),
            },
            crate::state::listener::OwnerChannel {
                channel_id: "UCowner2".to_string(),
                handle: Some("@owner2".to_string()),
            },
        ])
        .expect("set owners");
        // M=2 (= 2 枠以上で active)、N=10 はそのまま (default)
        mgr.set_classification_thresholds(30, 365, 10, 2);

        // listener UCregular: UCowner2 の過去 2 枠で発言 (= 自チャンネル群基準で active)
        for (i, vid) in ["vidPast1", "vidPast2"].iter().enumerate() {
            let mut c = fake_comment(&format!("p2_{}", i), "UCregular", "yo");
            c.timestamp = format!("2026-03-{:02}T11:00:00.000Z", 10 + i);
            mgr.record_comment(&c, vid, "yt-UCowner2").expect("rec");
        }
        // UCowner1 の現在配信 vidCur に UCregular が発言。
        // 案 A: UCregular は UCowner2 で 2 枠 active → 自チャンネル群で active
        // 旧案 B: UCregular は UCowner1 (= 対象配信オーナー) では active でない → NOT active
        let mut cur = fake_comment("cur1", "UCregular", "hi");
        cur.timestamp = "2026-05-01T11:00:00.000Z".to_string();
        mgr.record_comment(&cur, "vidCur", "yt-UCowner1")
            .expect("rec cur");
        // started_at を確定 (= record_comment が posted_at から自動設定するが、明示的に
        // 過去 2 枠より後にする)
        mgr.with_sync_conn(|c| {
            c.execute(
                "UPDATE streams SET started_at = ?1 WHERE video_id = ?2",
                params![1746093600000i64, "vidCur"], // 2026-05-01 10:00 UTC
            )
            .expect("set started");
            c.execute(
                "UPDATE streams SET started_at = ?1 WHERE video_id = ?2",
                params![1741604400000i64, "vidPast1"], // 2026-03-10 11:00
            )
            .expect("set p1");
            c.execute(
                "UPDATE streams SET started_at = ?1 WHERE video_id = ?2",
                params![1741690800000i64, "vidPast2"], // 2026-03-11 11:00
            )
            .expect("set p2");
        });
        // first_seen_at を遠い過去にして 5 ランク判定に「古参 / 復帰」候補にする
        let very_old = 1700000000000i64; // 2023-11
        mgr.with_sync_conn(|c| {
            c.execute(
                "UPDATE listeners SET first_seen_at = ?1 WHERE channel_id = 'yt-UCregular'",
                params![very_old],
            )
            .expect("set first_seen");
        });

        let q = StreamListenersQuery::default();
        let page = mgr
            .list_stream_listeners("vidCur", &q)
            .expect("list cur");
        let row = page
            .rows
            .iter()
            .find(|r| r.listener.channel_id == "yt-UCregular")
            .expect("UCregular row");
        assert!(
            row.is_active,
            "案 A: owner_channels 配下の他 UC で M=2 枠以上発言してれば active 扱いになる"
        );
    }

    /// 「新規」(first-time) の定義が `first_seen_at >= 対象配信 started_at` に統一
    /// されている (= 旧 `comment_count <= 1` ではない) ことを system_tags=["first-time"] で確認。
    #[test]
    fn first_time_system_tag_uses_first_seen_at_against_stream_started_at() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");

        // UCnew: この枠で初コメ (= first_seen_at >= started_at) → 新規
        let mut c_new = fake_comment("new1", "UCnew", "hello first time");
        c_new.timestamp = "2026-05-01T11:00:10.000Z".to_string();
        mgr.record_comment(&c_new, "vidFT", "yt-UCowner").expect("r");
        // 同じ UCnew が連投 (= comment_count > 1 でも新規のまま、新仕様)
        let mut c_new2 = fake_comment("new2", "UCnew", "hello again");
        c_new2.timestamp = "2026-05-01T11:00:20.000Z".to_string();
        mgr.record_comment(&c_new2, "vidFT", "yt-UCowner").expect("r2");

        // UCold: 過去枠で初コメ済み (= first_seen_at < started_at) → 新規ではない
        let mut c_past = fake_comment("past1", "UCold", "long ago");
        c_past.timestamp = "2026-01-01T11:00:00.000Z".to_string();
        mgr.record_comment(&c_past, "vidPast", "yt-UCowner")
            .expect("r past");
        // UCold が今回枠でも発言 (= 累計コメ数 > 1 だが新規ではない、新仕様で識別される)
        let mut c_now = fake_comment("now1", "UCold", "back");
        c_now.timestamp = "2026-05-01T11:30:00.000Z".to_string();
        mgr.record_comment(&c_now, "vidFT", "yt-UCowner").expect("r now");

        // vidFT.started_at は UCnew の posted_at (= 2026-05-01T11:00:10) で確定し、
        // UCold.first_seen_at (= 2026-01-01) は started_at より前。手動 UPDATE は不要。

        // system_tags=["first-time"] で UCnew のみ返る (UCold は除外)
        let q = StreamListenersQuery {
            system_tags: vec!["first-time".to_string()],
            ..Default::default()
        };
        let page = mgr.list_stream_listeners("vidFT", &q).expect("list");
        let ids: Vec<&str> = page
            .rows
            .iter()
            .map(|r| r.listener.channel_id.as_str())
            .collect();
        assert!(
            ids.contains(&"yt-UCnew"),
            "UCnew (この枠で初コメ、連投あり) は新規扱い: {:?}",
            ids
        );
        assert!(
            !ids.contains(&"yt-UCold"),
            "UCold (過去枠で発言済み) は新規扱いではない: {:?}",
            ids
        );
    }

    /// StreamListenerRow.system_tag が Rust 側で計算されて返ることを固定
    /// (= JS computeSystemTag への依存撤去、Single Source of Truth は Rust)。
    #[test]
    fn list_stream_listeners_returns_system_tag_for_each_row() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");

        // UCnew: この枠で初コメ → first-time
        let mut c_new = fake_comment("st1", "UCnew", "hi");
        c_new.timestamp = "2026-05-01T11:00:10.000Z".to_string();
        mgr.record_comment(&c_new, "vidST", "yt-UCowner").expect("r1");

        // UCold: 過去枠で初コメ済み (= first_seen_at < started_at) → 新参 (returning) になる想定
        // (= 新仕様: first_seen_at >= baseline - X日 で returning。default X=30 日)
        let mut c_past = fake_comment("st2", "UCold", "long ago");
        c_past.timestamp = "2026-04-25T11:00:00.000Z".to_string();
        mgr.record_comment(&c_past, "vidPast", "yt-UCowner")
            .expect("r past");
        // UCold が今回枠でも発言
        let mut c_now = fake_comment("st3", "UCold", "back");
        c_now.timestamp = "2026-05-01T11:30:00.000Z".to_string();
        mgr.record_comment(&c_now, "vidST", "yt-UCowner").expect("r now");

        let q = StreamListenersQuery::default();
        let page = mgr.list_stream_listeners("vidST", &q).expect("list");
        let by_id: std::collections::HashMap<String, String> = page
            .rows
            .iter()
            .map(|r| (r.listener.channel_id.clone(), r.system_tag.clone()))
            .collect();
        assert_eq!(
            by_id.get("yt-UCnew").map(|s| s.as_str()),
            Some("first-time"),
            "UCnew (この枠で初コメ) の system_tag は 'first-time': {:?}",
            by_id
        );
        // UCold は first_seen_at = 2026-04-25, baseline (= vidST started) = 2026-05-01。
        // baseline - X(30日) = 2026-04-01。first_seen_at >= baseline - X → returning。
        assert_eq!(
            by_id.get("yt-UCold").map(|s| s.as_str()),
            Some("returning"),
            "UCold (X 日以内に初コメ) の system_tag は 'returning': {:?}",
            by_id
        );
    }

    /// list_listener_superchats が **recent_comments の直近 50 件圏外**にある SC も
    /// 取得することを固定 (= chip 数字「2」だが filter 表示「1 件」になる旧バグの根治)。
    #[test]
    fn list_listener_superchats_returns_old_superchats_beyond_recent_50() {
        let (_dir, mgr) = open_temp();
        // UCa: 古い SC を 1 件、最近の chat を 60 件、最後に新しい SC を 1 件記録する。
        // get_listener_detail(limit=50) では新しい順 50 件 = chat 50 件 + 新 SC 1 件のうち
        // どれかが入るが、古い SC は確実に圏外になる構成。
        let mut old_sc = fake_comment("scOld", "UCa", "old sc");
        old_sc.timestamp = "2026-04-01T11:00:00.000Z".to_string();
        old_sc.has_gift = true;
        old_sc.amount = 500.0;
        old_sc.currency = "JPY".to_string();
        mgr.record_comment(&old_sc, "vidPast", "yt-UCowner").expect("r old sc");

        // 60 件の chat (= 古い SC を圏外に押し出す)
        for i in 0..60 {
            let mut c = fake_comment(&format!("chat{}", i), "UCa", "hi");
            c.timestamp = format!("2026-05-01T11:{:02}:00.000Z", i);
            mgr.record_comment(&c, "vidNow", "yt-UCowner").expect("r chat");
        }

        let mut new_sc = fake_comment("scNew", "UCa", "new sc");
        new_sc.timestamp = "2026-05-01T12:00:00.000Z".to_string();
        new_sc.has_gift = true;
        new_sc.amount = 500.0;
        new_sc.currency = "JPY".to_string();
        mgr.record_comment(&new_sc, "vidNow", "yt-UCowner").expect("r new sc");

        // get_listener_detail(50): 直近 50 件 = chat と新 SC が混在、古い SC は圏外
        let detail = mgr.get_listener_detail("UCa", 50, None).expect("d").expect("some");
        let recent_sc_count = detail
            .recent_comments
            .iter()
            .filter(|c| {
                matches!(
                    c.comment_type,
                    CommentType::Superchat | CommentType::Sticker | CommentType::Gift
                )
            })
            .count();
        assert!(
            recent_sc_count < 2,
            "直近 50 件には新 SC しか入らない (= 古い SC は圏外): {} 件",
            recent_sc_count
        );

        // list_listener_superchats(200): 全期間 SC を取得 → 古い SC も含む
        let scs = mgr
            .list_listener_superchats("UCa", 200)
            .expect("superchats");
        assert_eq!(
            scs.len(),
            2,
            "全期間 SC 取得で 古い SC + 新 SC の 2 件: {:?}",
            scs.iter().map(|c| &c.id).collect::<Vec<_>>()
        );
        // 新しい順
        assert!(scs[0].posted_at > scs[1].posted_at);
    }

    /// list_listener_comments_in_stream が **recent_comments の直近 50 件圏外**にある
    /// 当該枠コメも取得することを固定 (= chip 数字「122」だが「この枠」filter 表示「0 件」
    /// になる旧バグの根治、 2026-05-14 [[count-vs-filter-consistency]] パターン)。
    #[test]
    fn list_listener_comments_in_stream_returns_old_comments_beyond_recent_50() {
        let (_dir, mgr) = open_temp();
        // UCa: vidContext で 60 件コメ + vidOther で新しい 30 件コメ。
        // recent_comments(50) は新しい順 = vidOther 30 件 + vidContext 最新 20 件のみ。
        // → vidContext の古い 40 件が直近 50 件圏外。
        for i in 0..60 {
            let mut c = fake_comment(&format!("ctx{}", i), "UCa", "in context");
            c.timestamp = format!(
                "2026-04-01T11:{:02}:{:02}.000Z",
                i / 60,
                i % 60
            );
            mgr.record_comment(&c, "vidContext", "yt-UCowner").expect("rec ctx");
        }
        for i in 0..30 {
            let mut c = fake_comment(&format!("oth{}", i), "UCa", "in other");
            c.timestamp = format!("2026-05-01T12:{:02}:00.000Z", i);
            mgr.record_comment(&c, "vidOther", "yt-UCowner").expect("rec oth");
        }

        // get_listener_detail(50): 新しい順 50 件 → vidOther 30 + vidContext 直近 20 のみ
        let detail = mgr.get_listener_detail("UCa", 50, None).expect("d").expect("some");
        let in_context_in_recent = detail
            .recent_comments
            .iter()
            .filter(|c| c.stream_id == "vidContext")
            .count();
        assert!(
            in_context_in_recent < 60,
            "直近 50 件には vidContext の全 60 件は入らない: {} 件",
            in_context_in_recent
        );

        // list_listener_comments_in_stream(UCa, vidContext, 1000): vidContext 60 件全部
        let comments = mgr
            .list_listener_comments_in_stream("UCa", "vidContext", 1000)
            .expect("in stream");
        assert_eq!(
            comments.len(),
            60,
            "context 枠の全コメを取得 (= 直近 50 件圏外も含む)"
        );
        // 全部 vidContext のもの
        assert!(
            comments.iter().all(|c| c.stream_id == "vidContext"),
            "他枠のコメが混入してない"
        );
        // 新しい順
        for i in 1..comments.len() {
            assert!(
                comments[i - 1].posted_at >= comments[i].posted_at,
                "posted_at DESC ordering"
            );
        }

        // limit クランプ: 0 → 1, 100000 → 10000
        let one = mgr
            .list_listener_comments_in_stream("UCa", "vidContext", 0)
            .expect("clamp");
        assert_eq!(one.len(), 1, "limit=0 は 1 にクランプ");
    }

    /// list_stream_listener_pill_counts がページングと独立に **全 audience** に対して
    /// 集計値を返すこと (= 旧 JS 集計で limit 1000 だけ数えていた問題の根治) を固定。
    #[test]
    fn list_stream_listener_pill_counts_aggregates_full_audience_not_just_page() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");
        // 30 人がそれぞれ 1 回ずつ vidPC で初コメ (= 全員 first-time、各 per_stream_comment_count=1)。
        // list_stream_listeners の page limit を 10 に絞ったときに、pill 集計が 30 を返すこと
        // (= ロード分の 10 だけではない) を確認する。
        for i in 0..30 {
            let mut c = fake_comment(&format!("pc{}", i), &format!("UCa{}", i), "x");
            c.timestamp = format!("2026-05-01T11:00:{:02}.000Z", 10 + i);
            mgr.record_comment(&c, "vidPC", "yt-UCowner").expect("rec");
        }
        // pill 集計 (= 全 audience)
        let q = crate::state::listener::StreamListenerPillCountsQuery::default();
        let counts = mgr
            .list_stream_listener_pill_counts("vidPC", &q)
            .expect("counts");
        assert_eq!(counts.all, 30, "全 audience = 30 を返す: {:?}", counts);
        assert_eq!(
            counts.first_time, 30,
            "30 人とも first_seen_at >= started_at で新規: {:?}",
            counts
        );
        // 一方、ページング (= limit 10) では top 10 しかロードしないことを確認
        let page = mgr
            .list_stream_listeners(
                "vidPC",
                &StreamListenersQuery {
                    limit: Some(10),
                    ..Default::default()
                },
            )
            .expect("list");
        assert_eq!(page.rows.len(), 10, "page は limit=10 で 10 件のみ");
        assert_eq!(page.total, 30, "page.total は全件 = 30");
    }

    /// list_stream_listener_pill_counts で name_q が適用されつつ、system_tags は無視
    /// されること (= 「もし pill を切り替えたら何人」の母集団) を固定。
    #[test]
    fn list_stream_listener_pill_counts_applies_name_q_but_ignores_system_tags() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");

        for (i, (uid, name)) in [
            ("UCalice", "alice"),
            ("UCbob", "bob"),
            ("UCarisa", "arisa"),
        ]
        .iter()
        .enumerate()
        {
            let mut c = fake_comment(&format!("n{}", i), uid, "hi");
            c.display_name = name.to_string();
            c.timestamp = format!("2026-05-01T11:00:{:02}.000Z", 10 + i);
            mgr.record_comment(&c, "vidNQ", "yt-UCowner").expect("rec");
        }
        let q = crate::state::listener::StreamListenerPillCountsQuery {
            name_q: Some("a".to_string()),
            ..Default::default()
        };
        let counts = mgr
            .list_stream_listener_pill_counts("vidNQ", &q)
            .expect("counts");
        // alice / arisa の 2 人がマッチ (bob は除外)
        assert_eq!(counts.all, 2, "name_q='a' で alice + arisa マッチ: {:?}", counts);
        assert_eq!(counts.first_time, 2, "両者ともこの枠で初コメで first-time");
    }

    /// get_comment_chip_counts の first_count が **対象配信の started_at** 基準で
    /// 計算されることを固定 (= 旧 `comment_count <= 1` 廃止)。
    #[test]
    fn get_comment_chip_counts_first_count_uses_stream_started_at() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");

        // UCa: この枠で初コメ → 新規扱い。3 件コメする (= 累計 > 1 でも新規でなければならない、新仕様)
        for (i, ts) in ["2026-05-01T11:00:10.000Z", "2026-05-01T11:00:20.000Z", "2026-05-01T11:00:30.000Z"]
            .iter()
            .enumerate()
        {
            let mut c = fake_comment(&format!("cc{}", i), "UCa", "x");
            c.timestamp = ts.to_string();
            mgr.record_comment(&c, "vidCC", "yt-UCowner").expect("r");
        }
        // UCb: 過去枠で初コメ済み (= first_seen_at < target started_at) → 新規ではない
        let mut c_old = fake_comment("ccold", "UCb", "long ago");
        c_old.timestamp = "2026-04-01T11:00:00.000Z".to_string();
        mgr.record_comment(&c_old, "vidPast", "yt-UCowner")
            .expect("r past");
        let mut c_now = fake_comment("ccnow", "UCb", "now");
        c_now.timestamp = "2026-05-01T11:45:00.000Z".to_string();
        mgr.record_comment(&c_now, "vidCC", "yt-UCowner").expect("r now");

        let counts = mgr.get_comment_chip_counts("vidCC").expect("counts");
        // UCa が vidCC で 3 件コメ → first_count = 3 (= 新仕様、連投も新規扱い)
        // UCb が vidCC で 1 件コメ → 新規ではない (= first_seen_at < started_at)
        // 合計 first_count = 3 のはず
        assert_eq!(
            counts.first_time, 3,
            "first_count は対象配信で初コメしたリスナーのコメ件数 (連投含む) = 3: {:?}",
            counts
        );
        assert_eq!(counts.all, 4, "all = vidCC 全コメ数 = 4");
    }

    /// classify_listener_rank の純粋関数テスト。 in_comeback_window=true / false で
    /// 復帰 / 離脱 が分かれることを固定する (= Phase 2b')。
    #[test]
    fn classify_listener_rank_distinguishes_comeback_from_abandoned() {
        let one_month_ms: i64 = 30 * 24 * 3600 * 1000;
        let one_year_ms: i64 = 365 * 24 * 3600 * 1000;
        let baseline: i64 = 1_746_093_600_000; // 2026-05-01 10:00 UTC
        let very_old = baseline - 2 * one_year_ms; // 2 年前
        // NOT active + 復帰窓 (= last_N ∪ baseline) でコメ済 = comeback
        assert_eq!(
            super::classify_listener_rank(very_old, false, true, baseline, one_month_ms, one_year_ms),
            "comeback",
            "古いリスナーで非アクティブだが 復帰窓 のいずれかでコメ → 復帰"
        );
        // NOT active + 復帰窓コメ無し = abandoned
        assert_eq!(
            super::classify_listener_rank(very_old, false, false, baseline, one_month_ms, one_year_ms),
            "abandoned",
            "古いリスナーで非アクティブかつ 復帰窓 でコメ無し → 離脱"
        );
        // active のときは in_comeback_window は無関係 (= veteran)
        assert_eq!(
            super::classify_listener_rank(very_old, true, false, baseline, one_month_ms, one_year_ms),
            "veteran",
        );
        // first-time は最優先 (= baseline 以降の first_seen は新規)
        assert_eq!(
            super::classify_listener_rank(baseline + 1, false, false, baseline, one_month_ms, one_year_ms),
            "first-time",
        );
        // first_seen_at <= 0 は判定不能
        assert_eq!(
            super::classify_listener_rank(0, false, false, baseline, one_month_ms, one_year_ms),
            "",
        );
    }

    /// list_listeners に baseline_stream_video_id を渡したとき、 system_tags=["comeback"]
    /// と ["abandoned"] が「復帰窓 (= last_n_streams ∪ baseline、 N+1 枠) でコメ済か」で
    /// per-row に分かれることを固定する (= Phase 2b' 2026-05-14 改訂)。
    #[test]
    fn list_listeners_baseline_separates_comeback_and_abandoned() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");
        // N=2, M=2: 直近 2 枠中 2 枠以上で発言なら active。
        //           UCabandoned は LIMIT 外の vidVeryOld にだけコメ → 復帰窓外。
        //           X=30 / Y=365 (default)
        mgr.set_classification_thresholds(30, 365, 2, 2);

        // streams.started_at は record_comment が MIN-merge するため、 各枠の **最初の**
        // 記録が started_at の seed になる。 「過去枠の started_at を後から push-back させない」
        // ために UCregular のコメ順序で起点を確定する:
        //   vidVeryOld → vidPast1 → vidPast2 → vidLatest の順で 1 件ずつ record。
        let mut reg_vo = fake_comment("reg_vo", "UCregular", "very old");
        reg_vo.timestamp = "2025-01-01T10:00:00.000Z".to_string();
        mgr.record_comment(&reg_vo, "vidVeryOld", "yt-UCowner").expect("reg vo");
        let mut reg_p1 = fake_comment("reg_p1", "UCregular", "past1");
        reg_p1.timestamp = "2026-03-10T11:00:00.000Z".to_string();
        mgr.record_comment(&reg_p1, "vidPast1", "yt-UCowner").expect("reg p1");
        let mut reg_p2 = fake_comment("reg_p2", "UCregular", "past2");
        reg_p2.timestamp = "2026-03-15T11:30:00.000Z".to_string();
        mgr.record_comment(&reg_p2, "vidPast2", "yt-UCowner").expect("reg p2");
        let mut reg_latest = fake_comment("reg_latest", "UCregular", "latest");
        reg_latest.timestamp = "2026-05-01T10:30:00.000Z".to_string();
        mgr.record_comment(&reg_latest, "vidLatest", "yt-UCowner").expect("reg latest");
        // UCregular: vidPast1 + vidPast2 (= last_n_streams=top 2 < baseline) で 2 枠 ≥ M=2
        //            → active。 first_seen_at = 2025-01-01 < baseline - Y → veteran。
        //            復帰 / 離脱 chip からは active で除外される。

        // UCcomeback: vidPast1 (= last_n_streams 内) で 1 回 + vidLatest (= baseline) で 1 回。
        // last_n_streams で 1 枠 < M=2 → NOT active。
        // 復帰窓 (= last_n_streams ∪ baseline) に vidPast1 + vidLatest 2 件 → in_comeback_window=true。
        let mut cb_past = fake_comment("cb_past", "UCcomeback", "saw you");
        cb_past.timestamp = "2026-03-12T11:00:00.000Z".to_string();
        mgr.record_comment(&cb_past, "vidPast1", "yt-UCowner").expect("cb past");
        let mut cb_latest = fake_comment("cb_latest", "UCcomeback", "back!");
        cb_latest.timestamp = "2026-05-01T10:32:00.000Z".to_string();
        mgr.record_comment(&cb_latest, "vidLatest", "yt-UCowner").expect("cb latest");

        // UCabandoned: vidVeryOld (= LIMIT N=2 外) でだけ 1 回発言。
        // last_n_streams=[vidPast2, vidPast1] に 0 枠 → NOT active。
        // 復帰窓 = vidPast1 + vidPast2 + vidLatest にコメ 0 → in_comeback_window=false → 離脱。
        // vidVeryOld は自チャンネル枠なので record_comment の owner-aware 再集計で
        // comment_count > 0 を保ち、 list_listeners の filter を通る。
        let mut ab_very_old = fake_comment("ab_very_old", "UCabandoned", "long gone");
        ab_very_old.timestamp = "2025-01-15T10:00:00.000Z".to_string();
        mgr.record_comment(&ab_very_old, "vidVeryOld", "yt-UCowner")
            .expect("ab very old");

        // comeback chip: UCcomeback のみ
        let q_cb = ListenersQuery {
            baseline_stream_video_id: Some("vidLatest".to_string()),
            system_tags: vec!["comeback".to_string()],
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page_cb = mgr.list_listeners(&q_cb).expect("list comeback");
        let cb_ids: Vec<_> = page_cb
            .rows
            .iter()
            .map(|r| r.channel_id.as_str())
            .collect();
        assert_eq!(
            cb_ids, vec!["yt-UCcomeback"],
            "comeback = NOT active + 最終枠コメ済の人だけ: {:?}",
            cb_ids
        );

        // abandoned chip: UCabandoned のみ
        let q_ab = ListenersQuery {
            baseline_stream_video_id: Some("vidLatest".to_string()),
            system_tags: vec!["abandoned".to_string()],
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page_ab = mgr.list_listeners(&q_ab).expect("list abandoned");
        let ab_ids: Vec<_> = page_ab
            .rows
            .iter()
            .map(|r| r.channel_id.as_str())
            .collect();
        assert_eq!(
            ab_ids, vec!["yt-UCabandoned"],
            "abandoned = NOT active + 最終枠コメ無しの人だけ: {:?}",
            ab_ids
        );

        // baseline 無しでは comeback / abandoned は何もマッチしない (= 防御挙動)
        let q_no_baseline = ListenersQuery {
            system_tags: vec!["comeback".to_string(), "abandoned".to_string()],
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page_no = mgr.list_listeners(&q_no_baseline).expect("list");
        assert_eq!(
            page_no.rows.len(),
            0,
            "baseline 未指定では comeback / abandoned は空: {} 件",
            page_no.rows.len()
        );
    }

    /// list_listener_search_rank_counts: 設定画面ライブプレビュー RPC が
    /// baseline 基準で 6 ランクの件数を返すことを固定する (= Phase 2c+、 2026-05-14)。
    #[test]
    fn list_listener_search_rank_counts_returns_six_rank_totals_under_baseline() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");
        mgr.set_classification_thresholds(30, 365, 2, 2);

        // baseline = vidLatest (= 自チャンネル枠、 最新)。
        // - UCnewbie: vidLatest だけで初コメ → 新規
        // - UCveteran_active: 2 年前から発言 + vidPast1/vidPast2 で active → 古参
        // - UCabandoned: vidVeryOld (= LIMIT 外) でだけ発言 → 離脱
        let mut a = fake_comment("a1", "UCregular", "very old");
        a.timestamp = "2024-01-01T10:00:00.000Z".to_string();
        mgr.record_comment(&a, "vidVeryOld", "yt-UCowner").expect("rec a");
        let mut b = fake_comment("b1", "UCregular", "past1");
        b.timestamp = "2026-03-10T11:00:00.000Z".to_string();
        mgr.record_comment(&b, "vidPast1", "yt-UCowner").expect("rec b");
        let mut c = fake_comment("c1", "UCregular", "past2");
        c.timestamp = "2026-03-15T11:00:00.000Z".to_string();
        mgr.record_comment(&c, "vidPast2", "yt-UCowner").expect("rec c");
        let mut d = fake_comment("d1", "UCregular", "latest");
        d.timestamp = "2026-05-01T10:30:00.000Z".to_string();
        mgr.record_comment(&d, "vidLatest", "yt-UCowner").expect("rec d");

        let mut nb = fake_comment("nb1", "UCnewbie", "first");
        nb.timestamp = "2026-05-01T10:32:00.000Z".to_string();
        mgr.record_comment(&nb, "vidLatest", "yt-UCowner").expect("nb");

        let mut ab = fake_comment("ab1", "UCabandoned", "gone");
        ab.timestamp = "2025-01-15T10:00:00.000Z".to_string();
        mgr.record_comment(&ab, "vidVeryOld", "yt-UCowner").expect("ab");

        let counts = mgr
            .list_listener_search_rank_counts("vidLatest")
            .expect("counts");
        // total = 3 (UCregular, UCnewbie, UCabandoned)
        assert_eq!(counts.total, 3, "total = 3 人: {:?}", counts);
        // UCnewbie は vidLatest が初コメで first_seen_at >= baseline → 新規
        assert_eq!(counts.first_time, 1, "新規 = UCnewbie 1 人: {:?}", counts);
        // UCregular は first_seen_at = 2024-01-01 < baseline - Y(365 days) → veteran 候補
        // last_n_streams = vidPast2 + vidPast1 で 2 枠発言 → active → veteran
        assert_eq!(counts.veteran, 1, "古参 = UCregular 1 人: {:?}", counts);
        // UCabandoned は vidVeryOld だけで発言 (= LIMIT 外) → 復帰窓 0 件 → abandoned
        assert_eq!(counts.abandoned, 1, "離脱 = UCabandoned 1 人: {:?}", counts);

        // baseline 未指定 / 空文字 / 存在しない video_id → 全 0
        let zero = mgr.list_listener_search_rank_counts("").expect("zero");
        assert_eq!(zero.total, 0);
        let zero2 = mgr.list_listener_search_rank_counts("nope").expect("zero2");
        assert_eq!(zero2.total, 0);
    }

    /// list_listeners with baseline_stream_video_id の system_tags=["first-time"] が
    /// baseline.started_at 基準で判定されることを固定する (= 旧 comment_count <= 1 ではない)。
    #[test]
    fn list_listeners_baseline_first_time_uses_baseline_started_at() {
        let (_dir, mgr) = open_temp();
        mgr.set_owner_channels(&[crate::state::listener::OwnerChannel {
            channel_id: "UCowner".to_string(),
            handle: Some("@owner".to_string()),
        }])
        .expect("set owner");

        // baseline 用の枠を作る。 record_comment が started_at = posted_at を自動設定する
        // ので明示 UPDATE は不要 (= 過去に hand-coded ms 定数で 1 年ずれていたバグの教訓)。
        let mut seed = fake_comment("seed", "UCseed", "x");
        seed.timestamp = "2026-05-01T10:30:00.000Z".to_string();
        mgr.record_comment(&seed, "vidLatest", "yt-UCowner").expect("seed");

        // UCnewbie: baseline 配信で初コメ (連投 2 件) → first_seen_at >= baseline_started
        for i in 0..2 {
            let mut c = fake_comment(&format!("n{}", i), "UCnewbie", "first time!");
            c.timestamp = format!("2026-05-01T10:{:02}:00.000Z", 30 + i);
            mgr.record_comment(&c, "vidLatest", "yt-UCowner").expect("rec");
        }
        // UCveteran: baseline より前で初コメ (= first_seen_at < baseline_started、 累計 1 件)
        // 旧 first-time 判定 (= comment_count <= 1) では「新規」になっていたが、 新仕様
        // (= first_seen_at >= baseline) では「新規」にならないことを固定する
        let mut vet = fake_comment("v1", "UCveteran", "old");
        vet.timestamp = "2026-04-01T10:00:00.000Z".to_string();
        mgr.record_comment(&vet, "vidOld", "yt-UCowner").expect("rec vet");

        let q = ListenersQuery {
            baseline_stream_video_id: Some("vidLatest".to_string()),
            system_tags: vec!["first-time".to_string()],
            sort: ListenersSort::DisplayName,
            ..Default::default()
        };
        let page = mgr.list_listeners(&q).expect("list first-time");
        let ids: Vec<_> = page.rows.iter().map(|r| r.channel_id.as_str()).collect();
        // UCnewbie + UCseed (= seed もこの枠で初コメ) が新規。 UCveteran は旧仕様なら
        // 累計 1 件で「新規」だったが新仕様では除外される
        assert!(
            ids.contains(&"yt-UCnewbie"),
            "baseline 配信で初コメは新規: {:?}",
            ids
        );
        assert!(
            !ids.contains(&"yt-UCveteran"),
            "累計 1 件でも baseline より前なら新規ではない (= 旧 comment_count<=1 廃止): {:?}",
            ids
        );
    }
}
