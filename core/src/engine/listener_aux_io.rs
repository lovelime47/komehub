//! Step 3 リスナー管理: わんコメ DB 直 I/O アダプタ。
//!
//! 設計詳細: docs/step3-design.md § 5.3 / § 9 (Appendix: わんコメ DB 観測スキーマ)。
//!
//! 担う責務:
//! - わんコメ DB (`%APPDATA%\onecomme\comments.db` / `onecomme.db`) を **read-only で開いて**
//!   listeners.db に取り込むためのデータ抽出
//! - スキーマハッシュ (sqlite_master.sql の SHA256) の取得 ─ わんコメ側のスキーマ変更を
//!   検知して書き戻し中断 (NF-8)
//! - F-22 バックアップ機構: `comments.db` / `onecomme.db` を `data/onecomme-backup-{ts}/`
//!   へコピー (フェーズ 3.5 書き戻しの前提)
//!
//! 注意:
//! - **わんコメが起動中の場合は触らない** こと (NF-7、フェーズ 3.5 で起動検知を入れる)
//! - 読み込みは SQLITE_OPEN_READ_ONLY で排他しないモード

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, Error as SqliteError, ErrorCode, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// わんコメ `comments.db` の `comments` テーブル 1 行 (生のまま)。
/// `comment` は JSON 文字列のまま保持し、Step 3 の listener_manager 側で
/// 中の `data` フィールドを取り出してこめはぶ形式へ変換する。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnecommeCommentRow {
    /// 例: `yt-ChwKGkNPclNwNDdyLVpNREZTcnp3Z1FkbllJUnVn`
    pub id: String,
    /// わんコメ内 YouTube 接続を表す UUID (例: `e931b59f-...`)。
    pub service_id: String,
    /// 例: `yt-UCQyn...`
    pub user_id: String,
    /// `comment` カラムの JSON 文字列をそのまま保持。
    pub comment: String,
    /// ISO 8601 文字列 (例: `2026-04-19T11:43:44.924Z`)
    pub created_at: String,
}

/// わんコメ `onecomme.db` の `users` テーブル 1 行 (生のまま)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnecommeUserRow {
    /// 例: `yt-UCWP0eKdviJduJKazDqIxzpA`
    pub id: String,
    /// `data` カラムの JSON 文字列。
    pub data: String,
    pub created_at: String,
    pub updated_at: String,
}

/// スキーマハッシュ照合の結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCheck {
    /// 観測した `comments.db` + `onecomme.db` の `sqlite_master.sql` 連結を
    /// SHA256 した hex 文字列。
    pub current_hash: String,
    /// 既知のハッシュ (`schema_meta('onecomme_observed_schema_hash')`)。
    /// 初回観測時 (None) は照合せず観測値を新規記録するだけ。
    pub previous_hash: Option<String>,
    /// `current_hash == previous_hash` か (None なら true 扱い)。
    pub matched: bool,
}

/// わんコメ DB ファイル群 (フェーズ 3.5 書き戻しの前提となるバックアップで使う)。
const ONECOMME_DB_FILES: &[&str] = &["comments.db", "onecomme.db"];

/// pristine backup の固定ディレクトリ名。
/// onecommeDir ごとに 1 個だけ持つ (= 一度書き戻したら DB は既に「こめはぶ汚染」
/// 状態なので、 戻したい救済対象は「pristine = まだ書き戻していない state」 のみ)。
const PRISTINE_BACKUP_DIR_NAME: &str = "onecomme-pristine-backup";

/// `onecomme_dir/{comments.db, onecomme.db}` を **pristine backup** として固定 path にコピー。
///
/// 配置先: `dest_dir/onecomme-pristine-backup/{comments.db, onecomme.db}` (= 1 個固定)。
/// 既存があれば上書き (= 通常は app-config の pristine フラグで「未取得」 と判定されたときだけ
/// 呼ばれるため、 既存 = 想定外。 ただし安全のため上書き)。
///
/// **設計**: 「1 度書き戻したら こめはぶ が DB を改変しているため、 そこから先の backup は
/// pristine ではない = 戻しても意味がない」 という再定義により、 backup は 1 onecommeDir につき
/// 1 個固定。 retain / prune は不要。
pub fn pristine_backup_onecomme_db(
    onecomme_dir: &Path,
    dest_dir: &Path,
) -> std::io::Result<PathBuf> {
    let backup_dir = dest_dir.join(PRISTINE_BACKUP_DIR_NAME);
    // 既存があれば一旦削除 (= 不完全な過去 backup の残骸対応)
    if backup_dir.exists() {
        std::fs::remove_dir_all(&backup_dir)?;
    }
    std::fs::create_dir_all(&backup_dir)?;
    for name in ONECOMME_DB_FILES {
        let src = onecomme_dir.join(name);
        if !src.exists() {
            // 一部 DB が無くてもバックアップ自体は続行 (例: comments.db が
            // ログ無効の環境では存在しない可能性がある)
            tracing::debug!("pristine_backup_onecomme_db: skip non-existent file {:?}", src);
            continue;
        }
        let dest = backup_dir.join(name);
        std::fs::copy(&src, &dest)?;
    }
    tracing::info!(
        "pristine_backup_onecomme_db: created pristine backup at {:?}",
        backup_dir
    );
    Ok(backup_dir)
}

/// わんコメ `comments.db` を read-only で開き、`since` (ISO 8601) より新しい
/// コメントを `created_at` 昇順で返す。`since == None` で全件。
pub fn read_onecomme_comments(
    comments_db: &Path,
    since: Option<&str>,
) -> rusqlite::Result<Vec<OnecommeCommentRow>> {
    if !comments_db.exists() {
        // ファイルがない = ログ無効 / わんコメ未起動。空で返す
        return Ok(Vec::new());
    }
    let conn = open_readonly(comments_db)?;
    let (sql, rows) = if let Some(s) = since {
        (
            "SELECT id, service_id, user_id, comment, created_at
             FROM comments WHERE created_at > ?1 ORDER BY created_at ASC",
            Some(s.to_string()),
        )
    } else {
        (
            "SELECT id, service_id, user_id, comment, created_at
             FROM comments ORDER BY created_at ASC",
            None,
        )
    };
    let mut stmt = conn.prepare(sql)?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(OnecommeCommentRow {
            id: row.get(0)?,
            service_id: row.get(1)?,
            user_id: row.get(2)?,
            comment: row.get(3)?,
            created_at: row.get(4)?,
        })
    };
    let collected: Vec<OnecommeCommentRow> = if let Some(s) = rows {
        stmt.query_map(params![s], mapper)?
            .collect::<rusqlite::Result<_>>()?
    } else {
        stmt.query_map([], mapper)?
            .collect::<rusqlite::Result<_>>()?
    };
    Ok(collected)
}

/// わんコメ `onecomme.db` の `users` テーブル全件を読む (read-only)。
pub fn read_onecomme_users(onecomme_db: &Path) -> rusqlite::Result<Vec<OnecommeUserRow>> {
    if !onecomme_db.exists() {
        return Ok(Vec::new());
    }
    let conn = open_readonly(onecomme_db)?;
    // 一部のわんコメ環境では users テーブルが無い場合もある (リスナー記録機能未使用 etc.)
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'",
        [],
        |row| row.get(0),
    )?;
    if table_exists == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id, data, created_at, updated_at FROM users ORDER BY updated_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(OnecommeUserRow {
                id: row.get(0)?,
                data: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// わんコメ DB のスキーマハッシュを取得し、既知ハッシュと照合する。
/// 初回 (`previous_hash == None`) は照合せず matched=true で返す。
pub fn check_onecomme_schema(
    onecomme_db: &Path,
    comments_db: &Path,
    previous_hash: Option<&str>,
) -> rusqlite::Result<SchemaCheck> {
    let mut concat = String::new();
    for db in [onecomme_db, comments_db] {
        if !db.exists() {
            continue;
        }
        let conn = open_readonly(db)?;
        let mut stmt = conn.prepare(
            "SELECT type, name, sql FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name",
        )?;
        let rows = stmt.query_map([], |row| {
            let t: String = row.get(0)?;
            let n: String = row.get(1)?;
            let s: Option<String> = row.get(2)?;
            Ok(format!("{}\t{}\t{}\n", t, n, s.unwrap_or_default()))
        })?;
        for r in rows {
            concat.push_str(&r?);
        }
        concat.push_str("---\n");
    }
    let mut hasher = Sha256::new();
    hasher.update(concat.as_bytes());
    let current_hash = format!("{:x}", hasher.finalize());
    let matched = match previous_hash {
        None => true, // 初回観測
        Some(prev) => prev == current_hash,
    };
    Ok(SchemaCheck {
        current_hash,
        previous_hash: previous_hash.map(|s| s.to_string()),
        matched,
    })
}

/// 指定 connection で `name` テーブルが存在するかを返す。
/// 書き込み前の preflight として使う。
fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

fn open_readwrite(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // わんコメ書き込み時はわんコメ自身のロック設定を尊重するが、busy_timeout だけは
    // 安全のため short-pulse でセットする (わんコメが起動中の SQLITE_BUSY 即時失敗を回避)
    conn.pragma_update(None, "busy_timeout", 2000i64)?;
    Ok(conn)
}

/// わんコメ起動検知 (NF-7、設計書 § 5.1)。
/// `http://127.0.0.1:11180/api/comments` を 200ms タイムアウトで GET し、
/// HTTP 200 が返れば「起動中」と判定する。
/// 誤検出側に倒す方針: 接続失敗 / タイムアウト = 起動していない、と扱う。
pub async fn detect_onecomme_running() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(200))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get("http://127.0.0.1:11180/api/comments").send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// わんコメ comments テーブルへの書き戻し (Plan A、フェーズ 3.5)。
/// PK は `yt-{原id}` 形式で INSERT OR IGNORE → 重複行は skip される。
/// 100 件チャンクで 1 トランザクション。戻り値は (inserted, skipped)。
///
/// `OnecommeCommentInsert` の created_at は文字列 (ISO 8601 想定、わんコメ既存形式)。
pub fn write_onecomme_comments(
    comments_db: &Path,
    rows: &[OnecommeCommentInsert],
) -> rusqlite::Result<(usize, usize)> {
    if rows.is_empty() || !comments_db.exists() {
        return Ok((0, 0));
    }
    const CHUNK: usize = 100;
    // 5000 件ごとに進捗 push (= 100 chunks = ~50 push, IPC スパム回避)。 reporter 未登録時は no-op。
    const REPORT_INTERVAL: usize = 5000;
    let total = rows.len() as u64;
    let mut conn = open_readwrite(comments_db)?;
    // preflight: comments テーブルの存在確認 (read 側と挙動を揃える)
    if !table_exists(&conn, "comments")? {
        tracing::warn!(
            "write_onecomme_comments: skipped, 'comments' table not found in {:?}",
            comments_db
        );
        return Ok((0, 0));
    }
    crate::engine::export_progress_reporter::report(
        "write-comments",
        0,
        total,
        Some(&format!("コメント {} 件を書き込み中", total)),
    );
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let mut processed_since_report = 0usize;
    let mut total_processed = 0usize;
    for chunk in rows.chunks(CHUNK) {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        {
            // 既存行の comment_json 構造を直すため、こめはぶ起源 (service_id='komehub') の
            // ものだけ ON CONFLICT で上書き。わんコメネイティブ行 (実 service_id) は触らない。
            // INSERT カウントを正確に取るため `excluded.comment IS NOT comments.comment` の
            // チェックは不要 (重複ヒット = skip としてカウントしないと利用側 UX が崩れるが、
            // 修復目的の上書きは update 扱いで insert にカウントしない)。
            let mut stmt = tx.prepare(
                "INSERT INTO comments (id, service_id, user_id, comment, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     comment = excluded.comment,
                     user_id = excluded.user_id,
                     created_at = excluded.created_at
                 WHERE comments.service_id = 'komehub'",
            )?;
            for row in chunk {
                // INSERT も UPDATE も execute は 1 を返すので、行が新規かどうかは別途判定する
                let exists_before: bool = tx
                    .query_row(
                        "SELECT 1 FROM comments WHERE id = ?1",
                        params![row.id],
                        |_| Ok(true),
                    )
                    .optional()?
                    .unwrap_or(false);
                stmt.execute(params![
                    row.id,
                    row.service_id,
                    row.user_id,
                    row.comment_json,
                    row.created_at,
                ])?;
                if exists_before {
                    skipped += 1;
                } else {
                    inserted += 1;
                }
            }
        }
        tx.commit()?;
        total_processed += chunk.len();
        processed_since_report += chunk.len();
        if processed_since_report >= REPORT_INTERVAL {
            crate::engine::export_progress_reporter::report(
                "write-comments",
                total_processed as u64,
                total,
                None,
            );
            processed_since_report = 0;
        }
    }
    Ok((inserted, skipped))
}

/// わんコメ users テーブルへの書き戻し (Plan A、フェーズ 3.5)。
/// 既存行があれば `data` を読んで「保持カラム」(memo / nickname / screenName /
/// label / allowIcon / lang) を保持しつつ、必須カラム (tc / tgc / amount / lcts /
/// badges / username / icon) を上書き。`nameHistory` はマージ。
/// 戻り値は (new_count, updated_count)。
///
/// 設計書 § 5.3 phase 2 / § 9.3 のマッピングに基づく。
pub fn write_onecomme_users(
    onecomme_db: &Path,
    rows: &[OnecommeUserPatch],
) -> rusqlite::Result<(usize, usize)> {
    if rows.is_empty() || !onecomme_db.exists() {
        return Ok((0, 0));
    }
    const CHUNK: usize = 100;
    // 1000 件ごとに進捗 push (= users は通常 comments より少ない、 もう少し細かく)。
    const REPORT_INTERVAL: usize = 1000;
    let total = rows.len() as u64;
    let mut conn = open_readwrite(onecomme_db)?;
    // preflight: users テーブルの存在確認 (read 側と挙動を揃える)。
    // わんコメでリスナー記録機能を使ったことがない環境では users テーブルが
    // 存在しないことがあるため、欠落時は no-op で正常終了する。
    if !table_exists(&conn, "users")? {
        tracing::warn!(
            "write_onecomme_users: skipped, 'users' table not found in {:?}",
            onecomme_db
        );
        return Ok((0, 0));
    }
    crate::engine::export_progress_reporter::report(
        "write-users",
        0,
        total,
        Some(&format!("リスナー {} 件を書き込み中", total)),
    );
    let mut new_count = 0usize;
    let mut updated_count = 0usize;
    let mut total_processed = 0usize;
    let mut processed_since_report = 0usize;
    for chunk in rows.chunks(CHUNK) {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        {
            // 1. 既存 data を読む (なければ None)
            let mut select_stmt = tx.prepare(
                "SELECT data FROM users WHERE id = ?1",
            )?;
            // 2. INSERT or UPDATE
            let mut upsert_stmt = tx.prepare(
                "INSERT INTO users(id, data) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data,
                                              updated_at = DATETIME('now', 'localtime')",
            )?;
            for row in chunk {
                let existing: Option<String> = select_stmt
                    .query_row(params![row.id], |r| r.get(0))
                    .ok();
                let merged_json = merge_user_data(existing.as_deref(), &row.komehub_data);
                let n = upsert_stmt.execute(params![row.id, merged_json])?;
                // ON CONFLICT DO UPDATE では rows_affected が 1 (新規 or 更新どちらでも 1)。
                // existing が None だったかで判別。
                if existing.is_none() {
                    new_count += 1;
                } else if n == 1 {
                    updated_count += 1;
                }
            }
        }
        tx.commit()?;
        total_processed += chunk.len();
        processed_since_report += chunk.len();
        if processed_since_report >= REPORT_INTERVAL {
            crate::engine::export_progress_reporter::report(
                "write-users",
                total_processed as u64,
                total,
                None,
            );
            processed_since_report = 0;
        }
    }
    Ok((new_count, updated_count))
}

/// listener (user_id) ごとに、わんコメ comments テーブルから真値を集計する。
/// 書き戻しで comments をマージした「後」に呼んで、その実数で users の
/// tc/tgc/amount/lcts を上書きするのが正しい運用。tgc は data.hasGift = true。
/// max_created_at は ISO 8601 文字列 (わんコメ users.lcts と同じ形式)、未存在なら None。
pub fn aggregate_onecomme_user_stats(
    comments_db: &Path,
) -> rusqlite::Result<std::collections::HashMap<String, OnecommeUserAggregate>> {
    if !comments_db.exists() {
        return Ok(Default::default());
    }
    let conn = open_readonly(comments_db)?;
    if !table_exists(&conn, "comments")? {
        return Ok(Default::default());
    }
    // 注意: json_extract($.data.price) は数値が小数の通貨でも (例: USD 1.99) NULL でなく
    // REAL を返すため、CAST AS INTEGER で必ず整数化する (rusqlite で i64 として読むため)。
    //
    // 安全化: わんコメ DB に過去の不正 JSON が混じっていると json_extract が
    // SqliteFailure(SQLITE_ERROR, "malformed JSON") を吐いて集計全体が失敗する。
    // この関数は書き戻しの後段 (write_onecomme_comments の後 / write_onecomme_users の前) で
    // 呼ばれるため、ここで失敗すると users / watermark が未更新のまま部分書き込みが残る。
    // json_valid(comment) で不正行を除外し、tc は COUNT(*) のまま全行カウントする
    // (件数だけは JSON 形式に依存しないため)。
    let mut stmt = conn.prepare(
        "SELECT user_id,
                COUNT(*) AS tc,
                COALESCE(SUM(CASE
                    WHEN json_valid(comment) AND json_extract(comment, '$.data.hasGift') = 1
                    THEN 1 ELSE 0 END), 0) AS tgc,
                CAST(COALESCE(SUM(CASE
                    WHEN json_valid(comment) AND json_extract(comment, '$.data.hasGift') = 1
                    THEN COALESCE(json_extract(comment, '$.data.price'), 0)
                    ELSE 0 END), 0) AS INTEGER) AS amount,
                MAX(created_at) AS max_created
         FROM comments
         GROUP BY user_id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut map = std::collections::HashMap::with_capacity(rows.len());
    for (id, tc, tgc, amount, max_created) in rows {
        map.insert(
            id,
            OnecommeUserAggregate {
                tc,
                tgc,
                amount,
                max_created_at: max_created,
            },
        );
    }
    Ok(map)
}

/// `aggregate_onecomme_user_stats` の戻り値要素。
#[derive(Debug, Clone, Default)]
pub struct OnecommeUserAggregate {
    pub tc: i64,
    pub tgc: i64,
    pub amount: i64,
    /// わんコメ comments.created_at の MAX (ISO 8601)。`users.lcts` の真値として使う。
    pub max_created_at: Option<String>,
}

/// わんコメ comments への INSERT 用 row。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnecommeCommentInsert {
    pub id: String,
    pub service_id: String,
    pub user_id: String,
    /// `comment` カラムに入れる JSON 文字列 (わんコメ仕様に整形済み)。
    pub comment_json: String,
    pub created_at: String,
}

/// わんコメ users への UPSERT 用 row。
/// `komehub_data` はこめはぶ集計から作成した `data` JSON (集計値・最新表示名等を含む)。
/// 既存 data があれば保持カラムをマージしてから書き戻す。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnecommeUserPatch {
    pub id: String,
    /// こめはぶ側で組み立てた users.data JSON Value (オブジェクト想定)。
    pub komehub_data: serde_json::Value,
}

/// わんコメ `config.json/services[]` の 1 要素から取り出した、書き戻し時に
/// 流用したい接続情報。
#[derive(Debug, Clone)]
pub struct OnecommeServiceInfo {
    /// service UUID (例: `e931b59f-...`)。`BaseComment.id` および
    /// `comments.service_id` 列に流用する。
    pub service_id: String,
    /// 接続定義に紐づくユーザー定義色 `{r,g,b}`。わんコメ UI で
    /// コメントを色分けに使う。`config.json` に色が無ければ `None`。
    pub color: Option<serde_json::Value>,
}

/// わんコメ `config.json` の `services` 配列を読み、`liveId → OnecommeServiceInfo` の
/// マップを返す。`url` から `?v=...` を抽出して liveId とする。
/// 観測仕様 (Q-16): わんコメ services は接続定義ごとに固定 UUID を持ち、
/// 配信ごとには変わらない。書き戻し時に該当 liveId のネイティブ UUID と色を流用すると
/// わんコメ UI 上で「不明な接続」扱いを避け、色分けも整合する。
///
/// ファイル不在 / parse 失敗 / `services` 不在は空 Map で返す (= フォールバック発動)。
pub fn read_onecomme_service_map(onecomme_dir: &Path) -> HashMap<String, OnecommeServiceInfo> {
    let cfg_path = onecomme_dir.join("config.json");
    let bytes = match std::fs::read(&cfg_path) {
        Ok(b) => b,
        Err(_) => {
            tracing::debug!(
                "read_onecomme_service_map: config.json not found at {:?}, using empty map",
                cfg_path
            );
            return HashMap::new();
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "read_onecomme_service_map: parse failed for {:?}: {}",
                cfg_path,
                e
            );
            return HashMap::new();
        }
    };
    let services = match value.get("services").and_then(|s| s.as_array()) {
        Some(arr) => arr,
        None => {
            tracing::debug!("read_onecomme_service_map: no 'services' array in config.json");
            return HashMap::new();
        }
    };
    let mut map = HashMap::new();
    for svc in services {
        let id = match svc.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let url = match svc.get("url").and_then(|v| v.as_str()) {
            Some(s) => s,
            _ => continue,
        };
        if let Some(live_id) = extract_live_id_from_url(url) {
            let color = svc.get("color").cloned();
            map.insert(
                live_id,
                OnecommeServiceInfo {
                    service_id: id,
                    color,
                },
            );
        }
    }
    map
}

/// `https://www.youtube.com/watch?v={liveId}` 形式から liveId を抽出。
/// クエリ無し / `v=` 以外 / 空値は None。
fn extract_live_id_from_url(url: &str) -> Option<String> {
    let q = url.split_once('?').map(|(_, q)| q)?;
    for pair in q.split('&') {
        if let Some(rest) = pair.strip_prefix("v=") {
            // 後続の '&' は split で削除済み。空値は除外。
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// わんコメ users.data の merge ロジック。
/// 設計書 § 9.3 / § 5.3 phase 2 の方針:
/// - 必須カラム (id, username, icon, badges, service, lcts, tc, tgc, amount):
///   こめはぶ集計値で上書き
/// - 保持カラム (nickname, screenName, memo, label, allowIcon, lang):
///   既存値があれば保持、なければこめはぶ側 (空) を入れる
///   - 追記カラム (nameHistory): 既存配列とこめはぶ側配列をマージ (重複除去)
///   - 独自カラム (interval, lst, anonymity): 既存値があれば保持、なければ既定値
fn merge_user_data(existing_data_json: Option<&str>, komehub_data: &serde_json::Value) -> String {
    let komehub_obj = match komehub_data.as_object() {
        Some(o) => o.clone(),
        None => return komehub_data.to_string(),
    };
    let mut merged = serde_json::Map::new();
    let existing: serde_json::Map<String, serde_json::Value> = existing_data_json
        .and_then(|s| serde_json::from_str(s).ok())
        .and_then(|v: serde_json::Value| v.as_object().cloned())
        .unwrap_or_default();

    const OVERWRITE_KEYS: &[&str] = &[
        "id", "username", "icon", "badges", "service", "lcts", "tc", "tgc", "amount",
    ];
    const PRESERVE_KEYS: &[&str] = &[
        "nickname", "screenName", "memo", "label", "allowIcon", "lang",
    ];
    const APPEND_KEYS: &[&str] = &["nameHistory"];
    const KEEP_OR_DEFAULT_KEYS: &[(&str, serde_json::Value)] = &[
        ("interval", serde_json::Value::Null),
        ("lst", serde_json::Value::Null),
        ("anonymity", serde_json::Value::Null),
    ];

    // Overwrite keys
    for k in OVERWRITE_KEYS {
        if let Some(v) = komehub_obj.get(*k) {
            merged.insert(k.to_string(), v.clone());
        } else if let Some(v) = existing.get(*k) {
            // こめはぶに無くて既存にある場合は維持 (例: 古いキー定義が残るケース)
            merged.insert(k.to_string(), v.clone());
        }
    }
    // Preserve keys (既存非空 > こめはぶ)。
    // ユーザー編集フィールド (nickname / memo / label 等) は両側から編集できるよう
    // 「既存に非空文字列があれば既存を採用、空文字 or 不在ならこめはぶ値で初期化/更新」とする。
    // 従来の単純な「既存 > こめはぶ」は、わんコメ側に空文字レコードが残っているだけで
    // こめはぶの編集が反映されない問題があったため改善。
    for k in PRESERVE_KEYS {
        let existing_v = existing.get(*k);
        let existing_nonempty = existing_v
            .map(|v| match v {
                serde_json::Value::String(s) => !s.is_empty(),
                serde_json::Value::Null => false,
                _ => true,
            })
            .unwrap_or(false);
        if existing_nonempty {
            merged.insert(k.to_string(), existing_v.unwrap().clone());
        } else if let Some(v) = komehub_obj.get(*k) {
            merged.insert(k.to_string(), v.clone());
        }
    }
    // Append keys (両方の配列をマージ + 重複除去 順序は既存→新着)
    for k in APPEND_KEYS {
        let existing_arr = existing.get(*k).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let komehub_arr = komehub_obj.get(*k).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut combined: Vec<serde_json::Value> = Vec::with_capacity(existing_arr.len() + komehub_arr.len());
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for v in existing_arr.into_iter().chain(komehub_arr) {
            let key = v.to_string();
            if seen.insert(key) {
                combined.push(v);
            }
        }
        if !combined.is_empty() {
            merged.insert(k.to_string(), serde_json::Value::Array(combined));
        }
    }
    // Keep-or-default keys (既存 > 既定値)
    for (k, default) in KEEP_OR_DEFAULT_KEYS {
        if let Some(v) = existing.get(*k) {
            merged.insert(k.to_string(), v.clone());
        } else if !default.is_null() {
            merged.insert(k.to_string(), default.clone());
        }
    }

    // 既存にしか無いキー (上記 4 種に該当しないもの) も維持
    for (k, v) in &existing {
        if merged.contains_key(k) {
            continue;
        }
        if OVERWRITE_KEYS.contains(&k.as_str())
            || PRESERVE_KEYS.contains(&k.as_str())
            || APPEND_KEYS.contains(&k.as_str())
            || KEEP_OR_DEFAULT_KEYS.iter().any(|(kk, _)| kk == k)
        {
            continue;
        }
        merged.insert(k.clone(), v.clone());
    }

    serde_json::Value::Object(merged).to_string()
}

#[allow(dead_code)] // CannotOpen 系のエラーを統一形式で返したい場合の保険
fn cannot_open_error(msg: String) -> SqliteError {
    SqliteError::SqliteFailure(
        rusqlite::ffi::Error {
            code: ErrorCode::CannotOpen,
            extended_code: 0,
        },
        Some(msg),
    )
}

// ───────────────────────────── テスト ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// テスト用: わんコメ comments.db / onecomme.db を tempdir に作る。
    fn make_fake_onecomme_dir(dir: &Path) {
        let comments = Connection::open(dir.join("comments.db")).unwrap();
        comments
            .execute_batch(
                "CREATE TABLE comments (
                    id TEXT NOT NULL PRIMARY KEY,
                    service_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    comment JSON NOT NULL,
                    created_at TIMESTAMP NOT NULL
                 );
                 CREATE INDEX useridindex ON comments(user_id);
                 CREATE INDEX useridcreatedat ON comments(created_at);",
            )
            .unwrap();
        comments
            .execute(
                "INSERT INTO comments(id, service_id, user_id, comment, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "yt-Chwk1",
                    "uuid-1",
                    "yt-UCa",
                    r#"{"id":"Chwk1","data":{"liveId":"vid1","userId":"UCa","comment":"hi"}}"#,
                    "2026-04-19T11:43:00.000Z"
                ],
            )
            .unwrap();
        comments
            .execute(
                "INSERT INTO comments(id, service_id, user_id, comment, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "yt-Chwk2",
                    "uuid-1",
                    "yt-UCa",
                    r#"{"id":"Chwk2","data":{"liveId":"vid1","userId":"UCa","comment":"thanks","hasGift":true}}"#,
                    "2026-04-19T11:44:00.000Z"
                ],
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
        users
            .execute(
                "INSERT INTO users(id, data, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params![
                    "yt-UCa",
                    r#"{"id":"yt-UCa","username":"@alice","tc":2,"tgc":1,"amount":500}"#,
                    "2026-04-19 11:44:00"
                ],
            )
            .unwrap();
    }

    #[test]
    fn read_onecomme_comments_returns_all_rows() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let rows = read_onecomme_comments(&dir.path().join("comments.db"), None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "yt-Chwk1");
        assert_eq!(rows[1].id, "yt-Chwk2");
    }

    #[test]
    fn read_onecomme_comments_respects_since() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let rows = read_onecomme_comments(
            &dir.path().join("comments.db"),
            Some("2026-04-19T11:43:30.000Z"),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "yt-Chwk2");
    }

    #[test]
    fn read_onecomme_users_returns_rows() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let rows = read_onecomme_users(&dir.path().join("onecomme.db")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "yt-UCa");
    }

    #[test]
    fn read_onecomme_users_returns_empty_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let rows = read_onecomme_users(&dir.path().join("onecomme.db")).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn check_onecomme_schema_first_observation_matches() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let result = check_onecomme_schema(
            &dir.path().join("onecomme.db"),
            &dir.path().join("comments.db"),
            None,
        )
        .unwrap();
        assert!(result.matched);
        assert!(!result.current_hash.is_empty());
    }

    #[test]
    fn check_onecomme_schema_detects_change() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let result = check_onecomme_schema(
            &dir.path().join("onecomme.db"),
            &dir.path().join("comments.db"),
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        )
        .unwrap();
        assert!(!result.matched);
        assert_eq!(
            result.previous_hash.as_deref(),
            Some("0000000000000000000000000000000000000000000000000000000000000000")
        );
    }

    #[test]
    fn check_onecomme_schema_is_stable_across_calls() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let h1 = check_onecomme_schema(
            &dir.path().join("onecomme.db"),
            &dir.path().join("comments.db"),
            None,
        )
        .unwrap()
        .current_hash;
        let h2 = check_onecomme_schema(
            &dir.path().join("onecomme.db"),
            &dir.path().join("comments.db"),
            None,
        )
        .unwrap()
        .current_hash;
        assert_eq!(h1, h2);
    }

    #[test]
    fn pristine_backup_creates_fixed_dir_with_dbs() {
        let src = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(src.path());
        let dest = tempfile::tempdir().unwrap();
        let backup = pristine_backup_onecomme_db(src.path(), dest.path()).unwrap();
        assert!(backup.exists());
        assert!(backup.join("comments.db").exists());
        assert!(backup.join("onecomme.db").exists());
        // 固定ディレクトリ名 (= retain/timestamp なし)
        assert_eq!(
            backup.file_name().unwrap().to_string_lossy(),
            "onecomme-pristine-backup"
        );
    }

    #[test]
    fn pristine_backup_overwrites_existing() {
        let src = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(src.path());
        let dest = tempfile::tempdir().unwrap();
        // 1 回目
        let first = pristine_backup_onecomme_db(src.path(), dest.path()).unwrap();
        let first_size = std::fs::metadata(first.join("comments.db")).unwrap().len();
        // src の comments.db を変えてもう一度 (= 上書きされること)
        std::fs::write(src.path().join("comments.db"), b"different content").unwrap();
        let second = pristine_backup_onecomme_db(src.path(), dest.path()).unwrap();
        assert_eq!(first, second); // 同じ path
        let second_size = std::fs::metadata(second.join("comments.db")).unwrap().len();
        assert_ne!(first_size, second_size); // 内容が更新された
    }

    #[test]
    fn write_onecomme_comments_inserts_new_and_skips_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        // 既存の "yt-Chwk1" は重複、"yt-Chwk3" は新規
        let inserts = vec![
            OnecommeCommentInsert {
                id: "yt-Chwk1".to_string(),
                service_id: "uuid-1".to_string(),
                user_id: "yt-UCa".to_string(),
                comment_json: r#"{"id":"Chwk1","data":{"liveId":"vid1","comment":"dup"}}"#.to_string(),
                created_at: "2026-04-19T11:43:00.000Z".to_string(),
            },
            OnecommeCommentInsert {
                id: "yt-Chwk3".to_string(),
                service_id: "uuid-1".to_string(),
                user_id: "yt-UCa".to_string(),
                comment_json: r#"{"id":"Chwk3","data":{"liveId":"vid1","comment":"new one"}}"#.to_string(),
                created_at: "2026-04-19T11:50:00.000Z".to_string(),
            },
        ];
        let (inserted, skipped) =
            write_onecomme_comments(&dir.path().join("comments.db"), &inserts).unwrap();
        assert_eq!(inserted, 1);
        assert_eq!(skipped, 1);
        // 重複はスキップされ既存値が保持される
        let conn = Connection::open(dir.path().join("comments.db")).unwrap();
        let row1: String = conn
            .query_row(
                "SELECT comment FROM comments WHERE id='yt-Chwk1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(row1.contains(r#""comment":"hi""#), "duplicate should not overwrite existing");
        let row3: String = conn
            .query_row(
                "SELECT comment FROM comments WHERE id='yt-Chwk3'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(row3.contains(r#""comment":"new one""#));
    }

    #[test]
    fn aggregate_onecomme_user_stats_tolerates_invalid_json_rows() {
        // わんコメ DB に過去の不正 JSON 行があっても、集計が失敗せず、
        // 正常行だけが tgc/amount/max_created に反映されることを確認する。
        // tc は件数 (COUNT(*)) なので不正行も含む。
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let comments_db = dir.path().join("comments.db");
        let conn = Connection::open(&comments_db).unwrap();
        // 不正 JSON の行を 1 件 + 正常スパチャを 1 件投入
        conn.execute(
            "INSERT INTO comments(id, service_id, user_id, comment, created_at) VALUES
             ('yt-broken', 'svc', 'yt-UCx', 'NOT_JSON_AT_ALL', '2026-04-19T10:00:00Z'),
             ('yt-valid', 'svc', 'yt-UCx', '{\"data\":{\"hasGift\":true,\"price\":300}}', '2026-04-19T10:01:00Z')",
            [],
        ).unwrap();
        let stats = aggregate_onecomme_user_stats(&comments_db).unwrap();
        let x = stats.get("yt-UCx").expect("UCx stats");
        assert_eq!(x.tc, 2, "tc は不正行も件数に含む");
        assert_eq!(x.tgc, 1, "tgc は正常行だけカウント (json_valid フィルタ)");
        assert_eq!(x.amount, 300);
    }

    #[test]
    fn write_onecomme_comments_repairs_komehub_origin_rows() {
        // service_id='komehub' の壊れた既存行を上書き、ネイティブ (uuid-1) は保持。
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let comments_db = dir.path().join("comments.db");
        // こめはぶ起源の旧形式行を流し込む
        {
            let conn = Connection::open(&comments_db).unwrap();
            conn.execute(
                "INSERT INTO comments(id, service_id, user_id, comment, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "yt-broken1",
                    "komehub",
                    "yt-UCx",
                    r#"{"id":"broken1","comment":"OLD","userId":"UCx"}"#,
                    "2026-04-19T11:50:00.000Z"
                ],
            )
            .unwrap();
        }
        let inserts = vec![
            // komehub 起源 → 上書きされる
            OnecommeCommentInsert {
                id: "yt-broken1".to_string(),
                service_id: "komehub".to_string(),
                user_id: "yt-UCx".to_string(),
                comment_json: r#"{"id":"komehub","service":"youtube","data":{"id":"yt-broken1","comment":"FIXED"}}"#.to_string(),
                created_at: "2026-04-19T11:50:00.000Z".to_string(),
            },
            // ネイティブ → 保持 (skipped)
            OnecommeCommentInsert {
                id: "yt-Chwk1".to_string(),
                service_id: "komehub".to_string(),
                user_id: "yt-UCa".to_string(),
                comment_json: r#"{"id":"komehub","service":"youtube","data":{"id":"yt-Chwk1","comment":"WOULD_OVERWRITE"}}"#.to_string(),
                created_at: "2026-04-19T11:43:00.000Z".to_string(),
            },
        ];
        let (inserted, skipped) = write_onecomme_comments(&comments_db, &inserts).unwrap();
        assert_eq!(inserted, 0);
        assert_eq!(skipped, 2);
        let conn = Connection::open(&comments_db).unwrap();
        let repaired: String = conn
            .query_row(
                "SELECT comment FROM comments WHERE id='yt-broken1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(repaired.contains(r#""comment":"FIXED""#), "broken1 should be repaired");
        let untouched: String = conn
            .query_row("SELECT comment FROM comments WHERE id='yt-Chwk1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            untouched.contains(r#""comment":"hi""#),
            "OneComme native (uuid-1) row must not be overwritten"
        );
    }

    #[test]
    fn aggregate_onecomme_user_stats_counts_real_rows() {
        // わんコメ comments に 4 件 (チャット 2 + 有料 2) を入れて user 別の集計を確認。
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        let comments_db = dir.path().join("comments.db");
        let conn = Connection::open(&comments_db).unwrap();
        // Alice: チャット 2、有料 1 (price=500)
        conn.execute(
            "INSERT INTO comments(id, service_id, user_id, comment, created_at) VALUES
             ('yt-A1', 'svc', 'yt-UCa', '{\"data\":{\"hasGift\":false}}', '2026-04-19T10:00:00Z'),
             ('yt-A2', 'svc', 'yt-UCa', '{\"data\":{\"hasGift\":false}}', '2026-04-19T10:01:00Z'),
             ('yt-A3', 'svc', 'yt-UCa', '{\"data\":{\"hasGift\":true,\"price\":500}}', '2026-04-19T10:02:00Z')",
            [],
        ).unwrap();
        // Bob: 有料 1 (price=1000、float リテラル) — float でも i64 で受け取れることを保証
        conn.execute(
            "INSERT INTO comments(id, service_id, user_id, comment, created_at) VALUES
             ('yt-B1', 'svc', 'yt-UCb', '{\"data\":{\"hasGift\":true,\"price\":1000.0}}', '2026-04-19T10:03:00Z'),
             ('yt-B2', 'svc', 'yt-UCb', '{\"data\":{\"hasGift\":true,\"price\":1.99}}', '2026-04-19T10:04:00Z')",
            [],
        ).unwrap();
        let stats = aggregate_onecomme_user_stats(&comments_db).unwrap();
        // 既存 fixture: yt-UCa に 2 件 (Chwk1: hasGift=false, Chwk2: hasGift=true price なし)
        // 上で追加: 3 件 (チャット 2 + 有料 1 price=500)
        // 期待: tc=5, tgc=2 (Chwk2 + A3), amount=500 (Chwk2 は price 不在=0)
        let alice = stats.get("yt-UCa").expect("UCa stats");
        assert_eq!(alice.tc, 5, "tc=5 (fixture 2 + new 3)");
        assert_eq!(alice.tgc, 2, "tgc=2 (Chwk2 + A3)");
        assert_eq!(alice.amount, 500, "amount=500");
        // 最新 created_at (= 2026-04-19T11:44:00.000Z fixture vs 上で追加した 2026-04-19T10:02 系)
        // → fixture が最新
        assert_eq!(
            alice.max_created_at.as_deref(),
            Some("2026-04-19T11:44:00.000Z")
        );
        // Bob: 2 件、両方有料、合計 1001.99 → CAST INTEGER で 1001 (切り捨て)
        let bob = stats.get("yt-UCb").expect("UCb stats");
        assert_eq!(bob.tc, 2);
        assert_eq!(bob.tgc, 2);
        assert_eq!(bob.amount, 1001);
        assert_eq!(bob.max_created_at.as_deref(), Some("2026-04-19T10:04:00Z"));
    }

    #[test]
    fn write_onecomme_users_creates_and_merges() {
        let dir = tempfile::tempdir().unwrap();
        make_fake_onecomme_dir(dir.path());
        // 既存ユーザーは "yt-UCa" のみ。新規 "yt-UCnew" + 既存更新の 2 件
        let patches = vec![
            OnecommeUserPatch {
                id: "yt-UCa".to_string(),
                komehub_data: serde_json::json!({
                    "id": "yt-UCa",
                    "username": "@alice",
                    "icon": "https://example.com/i2.png",
                    "badges": [],
                    "service": "youtube",
                    "lcts": "2026-05-03T00:00:00Z",
                    "tc": 99, "tgc": 5, "amount": 5000
                }),
            },
            OnecommeUserPatch {
                id: "yt-UCnew".to_string(),
                komehub_data: serde_json::json!({
                    "id": "yt-UCnew",
                    "username": "@bob",
                    "tc": 1, "tgc": 0, "amount": 0
                }),
            },
        ];
        let (new_count, updated_count) =
            write_onecomme_users(&dir.path().join("onecomme.db"), &patches).unwrap();
        assert_eq!(new_count, 1);
        assert_eq!(updated_count, 1);
        let conn = Connection::open(dir.path().join("onecomme.db")).unwrap();
        let data_a: String = conn
            .query_row("SELECT data FROM users WHERE id='yt-UCa'", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&data_a).unwrap();
        // 集計値はこめはぶ側で上書き
        assert_eq!(parsed["tc"], 99);
        assert_eq!(parsed["amount"], 5000);
    }

    #[test]
    fn merge_user_data_keeps_preserve_keys() {
        // 注: わんコメ users.data の "lst" は "#" が観測値なので raw string は r##...##
        let existing = r##"{
            "id": "yt-UCa",
            "username": "@oldname",
            "tc": 5,
            "memo": "重要な配信メモ",
            "label": "VIP",
            "nickname": "あー",
            "interval": 0,
            "lst": "#",
            "anonymity": false
        }"##;
        let komehub = serde_json::json!({
            "id": "yt-UCa",
            "username": "@newname",
            "icon": "https://example.com/new.png",
            "tc": 100,
            "amount": 5000,
            "service": "youtube",
            "memo": "" // こめはぶ側は空 → 既存の memo を保持すべき
        });
        let merged = merge_user_data(Some(existing), &komehub);
        let parsed: serde_json::Value = serde_json::from_str(&merged).unwrap();
        // 上書きされる
        assert_eq!(parsed["username"], "@newname");
        assert_eq!(parsed["tc"], 100);
        assert_eq!(parsed["amount"], 5000);
        // 既存値が保持される
        assert_eq!(parsed["memo"], "重要な配信メモ");
        assert_eq!(parsed["label"], "VIP");
        assert_eq!(parsed["nickname"], "あー");
        assert_eq!(parsed["interval"], 0);
        assert_eq!(parsed["lst"], "#");
        assert_eq!(parsed["anonymity"], false);
    }

    #[test]
    fn merge_user_data_komehub_fills_when_existing_is_empty_string() {
        // 既存に空文字 nickname があるだけで komehub の nickname が反映されない
        // という旧バグの回帰テスト。空文字 = 未設定として扱い、こめはぶ値で初期化する。
        let existing = r#"{"id":"yt-UCa","nickname":"","memo":"","label":""}"#;
        let komehub = serde_json::json!({
            "id": "yt-UCa",
            "nickname": "ぴん",
            "memo": "こめはぶで設定したメモ",
            "label": "常連"
        });
        let merged = merge_user_data(Some(existing), &komehub);
        let parsed: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(parsed["nickname"], "ぴん");
        assert_eq!(parsed["memo"], "こめはぶで設定したメモ");
        assert_eq!(parsed["label"], "常連");
    }

    #[test]
    fn merge_user_data_appends_name_history_dedup() {
        let existing = r#"{"id":"yt-UCa","nameHistory":[{"at":1,"to":"old"}]}"#;
        let komehub = serde_json::json!({
            "id": "yt-UCa",
            "nameHistory": [
                {"at": 1, "to": "old"},   // 既存と同じ → 重複除去
                {"at": 2, "to": "new"}
            ]
        });
        let merged = merge_user_data(Some(existing), &komehub);
        let parsed: serde_json::Value = serde_json::from_str(&merged).unwrap();
        let arr = parsed["nameHistory"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn write_onecomme_users_skips_when_table_missing() {
        // users テーブルが無い onecomme.db (リスナー記録機能未使用環境) でも
        // no-op で正常終了する (read 側と挙動を揃える、High 指摘対応)
        let dir = tempfile::tempdir().unwrap();
        // users テーブル無しの onecomme.db を作る (comments.db 側だけ make)
        let onecomme_path = dir.path().join("onecomme.db");
        let conn = Connection::open(&onecomme_path).unwrap();
        conn.execute("CREATE TABLE other_table (k TEXT)", []).unwrap();
        drop(conn);
        let patches = vec![OnecommeUserPatch {
            id: "yt-UCa".to_string(),
            komehub_data: serde_json::json!({"id":"yt-UCa","tc":1}),
        }];
        let result = write_onecomme_users(&onecomme_path, &patches);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), (0, 0));
    }

    #[test]
    fn write_onecomme_comments_skips_when_table_missing() {
        let dir = tempfile::tempdir().unwrap();
        let comments_path = dir.path().join("comments.db");
        let conn = Connection::open(&comments_path).unwrap();
        conn.execute("CREATE TABLE other_table (k TEXT)", []).unwrap();
        drop(conn);
        let inserts = vec![OnecommeCommentInsert {
            id: "yt-Cnew".to_string(),
            service_id: "uuid-1".to_string(),
            user_id: "yt-UCa".to_string(),
            comment_json: r#"{"id":"Cnew"}"#.to_string(),
            created_at: "2026-04-19T11:43:00.000Z".to_string(),
        }];
        let result = write_onecomme_comments(&comments_path, &inserts);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), (0, 0));
    }

    #[test]
    fn merge_user_data_handles_no_existing() {
        let komehub = serde_json::json!({
            "id": "yt-UCnew",
            "username": "@new",
            "tc": 1
        });
        let merged = merge_user_data(None, &komehub);
        let parsed: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(parsed["id"], "yt-UCnew");
        assert_eq!(parsed["username"], "@new");
    }

    // prune_onecomme_backups は 2026-05-16 pristine 化で廃止 (= 1 backup 固定なので prune 不要)

    // ─────── read_onecomme_service_map (Q-16 service_id 解決) ───────

    #[test]
    fn read_service_map_extracts_id_color_and_live_id_from_url() {
        // 観測した config.json/services 構造に近い形式を put する
        let dir = tempfile::tempdir().unwrap();
        let cfg = serde_json::json!({
            "services": [
                {
                    "id": "uuid-aaaa",
                    "url": "https://www.youtube.com/watch?v=Y505e4FZ9dA",
                    "color": { "r": 214, "g": 3, "b": 255 }
                },
                {
                    "id": "uuid-bbbb",
                    "url": "https://www.youtube.com/watch?v=ApRChg6WJUc&pp=foo",
                    "color": { "r": 55, "g": 23, "b": 255 }
                }
            ],
            "other": "ignored"
        });
        std::fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();

        let map = read_onecomme_service_map(dir.path());
        assert_eq!(map.len(), 2);

        let info_a = map.get("Y505e4FZ9dA").expect("first live_id");
        assert_eq!(info_a.service_id, "uuid-aaaa");
        assert_eq!(
            info_a.color.as_ref().and_then(|v| v.get("r")).and_then(|v| v.as_i64()),
            Some(214)
        );

        let info_b = map.get("ApRChg6WJUc").expect("second live_id");
        assert_eq!(info_b.service_id, "uuid-bbbb");
    }

    #[test]
    fn read_service_map_returns_empty_when_config_missing() {
        let dir = tempfile::tempdir().unwrap();
        // config.json を作らない
        let map = read_onecomme_service_map(dir.path());
        assert!(map.is_empty());
    }

    #[test]
    fn read_service_map_returns_empty_when_services_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"version": "9.x"}"#,
        )
        .unwrap();
        let map = read_onecomme_service_map(dir.path());
        assert!(map.is_empty());
    }

    #[test]
    fn read_service_map_returns_empty_for_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "this is not json").unwrap();
        let map = read_onecomme_service_map(dir.path());
        assert!(map.is_empty());
    }

    #[test]
    fn read_service_map_skips_services_without_v_param() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = serde_json::json!({
            "services": [
                { "id": "uuid-a", "url": "https://www.youtube.com/" },         // 無 v
                { "id": "uuid-b", "url": "https://www.youtube.com/watch?v=" }, // 空 v
                { "id": "uuid-c", "url": "https://www.youtube.com/watch?other=foo" },
                { "id": "uuid-d", "url": "https://www.youtube.com/watch?v=goodId" },
            ]
        });
        std::fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();
        let map = read_onecomme_service_map(dir.path());
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("goodId").unwrap().service_id, "uuid-d");
    }
}
