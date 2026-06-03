//! デモモード用 `listeners.db` シード。
//!
//! `--demo` 起動時に **core init より前** に呼ばれ、専用データ dir
//! (`<userData>/demo-data`) の `listeners.db` へ架空 VTuber「雫宮ねむ」の
//! デモデータ (配信 / リスナー / コメント / タグ) を投入する。実データ dir とは
//! 別なので本番データは一切汚さない。
//!
//! リスナーランク (新規/新参/常連/古参/復帰/離脱) は read 時に
//! `classify_listener_rank` が `first_seen_at` と対象配信 `started_at` の時間差 +
//! active 判定から算出する。そのため seed は `first_seen_at` / 各配信 `started_at` /
//! 各リスナーの発言枠 (`presentInStreams`) を制御してランクが分散して出るようにする。
//!
//! データセット本体は `demo/demo-seed.json` (= 中身は再ビルド不要で編集可能)。
//! 本モジュールはその JSON を読んで SQL 投入するだけ。

// napi 経由 (cdylib = .node) でのみ使用。bin target (komehub-core-exe) では
// napi 登録が無効化され `seed` / 各 Spec struct が未参照になるため dead_code
// 警告が出るが、Electron が読む .node では使われる (= target 差分の正当な allow)。
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Seed {
    owner: Owner,
    streams: Vec<StreamSpec>,
    listeners: Vec<ListenerSpec>,
    #[serde(default)]
    comment_templates: HashMap<String, Vec<String>>,
    /// 全リスナーの commentsPerStream に掛ける倍率 (= コメント総数の見栄え調整)。
    /// 実コメント行を増やすので一覧/統計/ヒートマップが整合して増える。default 1。
    #[serde(default)]
    comment_multiplier: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    channel_id: String,
    handle: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamSpec {
    key: String,
    video_id: String,
    title: String,
    start_days_ago: f64,
    #[serde(default)]
    duration_min: i64,
    #[serde(default)]
    peak_viewers: i64,
    #[serde(default)]
    likes: i64,
    #[serde(default)]
    live: bool,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenerSpec {
    channel_id: String,
    name: String,
    first_seen_days_ago: f64,
    #[serde(default)]
    is_member: bool,
    #[serde(default)]
    member_months: i64,
    #[serde(default)]
    is_mod: bool,
    #[serde(default)]
    tags: Vec<String>,
    present_in_streams: Vec<String>,
    #[serde(default)]
    comments_per_stream: Option<i64>,
    /// stream key -> superchat 金額 (JPY)。該当枠で 1 件を superchat 化。
    #[serde(default)]
    sc_in_streams: HashMap<String, i64>,
    /// stream key -> ギフト数。該当枠で 1 件を gift 化。
    #[serde(default)]
    gift_in_streams: HashMap<String, i64>,
    /// 新規メンバー加入アナウンスを出す stream key (= membership 1 件)。
    #[serde(default)]
    new_member_in_streams: Vec<String>,
}

/// `<data_dir>/data/listeners.db` にデモデータを投入する。
/// `seed_json` は `demo/demo-seed.json` の中身そのもの (= main.js が読んで渡す)。
pub fn seed(data_dir: &str, seed_json: &str) -> Result<(), String> {
    let spec: Seed = serde_json::from_str(seed_json).map_err(|e| format!("parse seed json: {e}"))?;

    let db_path = Path::new(data_dir).join("data").join("listeners.db");
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create data dir: {e}"))?;
    }
    let mut conn = Connection::open(&db_path).map_err(|e| format!("open db: {e}"))?;
    crate::engine::listener_manager::run_migrations(&conn).map_err(|e| format!("migrate: {e}"))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock: {e}"))?
        .as_millis() as i64;
    let day: i64 = 86_400_000;

    // stream key -> (started_at, window_end (= ended_at or now for live), video_id)
    let mut win: HashMap<String, (i64, i64, String)> = HashMap::new();
    for s in &spec.streams {
        let started = if s.live {
            now - 35 * 60_000
        } else {
            now - (s.start_days_ago * day as f64) as i64
        };
        let ended = if s.live { 0 } else { started + s.duration_min * 60_000 };
        let window_end = if ended == 0 { now } else { ended };
        win.insert(s.key.clone(), (started, window_end, s.video_id.clone()));
    }

    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;

    // 既存デモデータを一掃 (= 冪等再シード)
    for t in [
        "comments",
        "listeners",
        "streams",
        "owner_channels",
        "listener_tags",
        "stream_tags",
        "stream_listener_state",
    ] {
        tx.execute(&format!("DELETE FROM {t}"), [])
            .map_err(|e| format!("clear {t}: {e}"))?;
    }

    // owner
    tx.execute(
        "INSERT INTO owner_channels(channel_id, handle) VALUES (?1, ?2)",
        params![spec.owner.channel_id, spec.owner.handle],
    )
    .map_err(|e| format!("insert owner: {e}"))?;

    // icon_url は本番同様 **絶対 URL** で保存する (= デスクトップ renderer は icon_url を
    // そのまま img src / background-image に使うため、相対 /cache/... だと file:// 起点で
    // 解決できず表示されない)。コア既定ポート 11280 固定 (= napi_bridge の DEFAULT_PORT)。
    let owner_icon = format!(
        "http://127.0.0.1:11280/cache/avatars/{}.png",
        spec.owner.channel_id
    );

    // streams.owner_channel_id は **yt- prefix 付き** で保存する。
    // 本番では record_comment が `yt-{UC}` に正規化し、list_listeners / heatmap /
    // active 判定の SQL は `owner_channel_id IN (SELECT 'yt-' || channel_id FROM owner_channels)`
    // で突き合わせる (owner_channels 側は raw UC)。これに合わせないと直近 N 枠が 0 件になり
    // ヒートマップ・常連/古参の active 判定・復帰窓が全て機能しない。
    // isOwnStream は両側 yt- strip 比較なので prefix 有無に依らず一致する。
    let stream_owner = if spec.owner.channel_id.starts_with("yt-") {
        spec.owner.channel_id.clone()
    } else {
        format!("yt-{}", spec.owner.channel_id)
    };

    // streams
    for s in &spec.streams {
        let (started, _window_end, _vid) = win.get(&s.key).unwrap();
        let ended = if s.live {
            0
        } else {
            started + s.duration_min * 60_000
        };
        let url = format!("https://www.youtube.com/watch?v={}", s.video_id);
        let cur_viewers = if s.live { s.peak_viewers } else { 0 };
        tx.execute(
            "INSERT INTO streams(video_id, owner_channel_id, title, started_at, ended_at, \
                stream_url, channel_name, channel_icon_url, peak_concurrent_viewers, \
                current_viewers, likes, live_metadata_updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                s.video_id,
                stream_owner,
                s.title,
                started,
                ended,
                url,
                spec.owner.name,
                owner_icon,
                s.peak_viewers,
                cur_viewers,
                s.likes,
                now,
            ],
        )
        .map_err(|e| format!("insert stream {}: {e}", s.video_id))?;
        for tag in &s.tags {
            tx.execute(
                "INSERT OR IGNORE INTO stream_tags(video_id, tag, attached_at) VALUES (?1,?2,?3)",
                params![s.video_id, tag, now],
            )
            .map_err(|e| format!("stream tag: {e}"))?;
        }
    }

    let live_key = spec
        .streams
        .iter()
        .find(|s| s.live)
        .map(|s| s.key.clone());

    // listeners + comments
    for l in &spec.listeners {
        let first_seen = now - (l.first_seen_days_ago * day as f64) as i64;
        let icon = format!("http://127.0.0.1:11280/cache/avatars/{}.png", l.channel_id);
        tx.execute(
            "INSERT INTO listeners(channel_id, display_name, icon_url, first_seen_at, \
                last_seen_at, comment_count, superchat_count, superchat_amount_jpy, \
                is_member, is_moderator, member_months_max) \
             VALUES (?1,?2,?3,?4,?4,0,0,0,?5,?6,?7)",
            params![
                l.channel_id,
                l.name,
                icon,
                first_seen,
                l.is_member,
                l.is_mod,
                l.member_months,
            ],
        )
        .map_err(|e| format!("insert listener {}: {e}", l.channel_id))?;

        for tag in &l.tags {
            tx.execute(
                "INSERT OR IGNORE INTO listener_tags(channel_id, tag, attached_at) VALUES (?1,?2,?3)",
                params![l.channel_id, tag, now],
            )
            .map_err(|e| format!("listener tag: {e}"))?;
        }

        let mult = spec.comment_multiplier.unwrap_or(1).max(1);
        let per = (l.comments_per_stream.unwrap_or(5) * mult).max(1);
        // listener 別 seed (= channel_id バイト和)。全 channel_id が同じ文字数だと
        // len ベースのオフセットが全員同一になり、時刻ソートで同一文が連続するため、
        // 内容のばらつく seed を使う。
        let seed: usize = l.channel_id.bytes().map(|b| b as usize).sum();
        for skey in &l.present_in_streams {
            let Some((started, window_end, vid)) = win.get(skey) else {
                continue;
            };
            let templates = spec.comment_templates.get(skey);
            for i in 0..per {
                // listener ごとに位相 (phase) をずらして投稿時刻を desync させる
                // (= 全員同じ frac で同時投稿 → 時刻ソートで塊になるのを防ぐ)。
                let phase = (seed % 997) as f64 / 997.0;
                let base = i as f64 / per as f64;
                let frac = (base + phase) % 1.0;
                let posted = started + ((*window_end - *started) as f64 * (0.05 + 0.9 * frac)) as i64;

                // テンプレ選択をばらけさせる (= 連番 % len だと同一文が周期的に並ぶ)。
                // 13 (素数) ステップ + listener 別オフセットで隣接重複を避ける。
                let body = match templates {
                    Some(t) if !t.is_empty() => {
                        let idx = (i as usize * 13 + seed) % t.len();
                        t[idx].clone()
                    }
                    _ => "コメントありがとう〜".to_string(),
                };

                // 特殊 type は各枠の先頭コメント 1 件に割り当て
                let mut ctype = "chat";
                let mut sc_amount: Option<i64> = None;
                if i == 0 {
                    if let Some(a) = l.sc_in_streams.get(skey) {
                        ctype = "superchat";
                        sc_amount = Some(*a);
                    } else if l.new_member_in_streams.iter().any(|s| s == skey) {
                        ctype = "membership";
                    } else if l.gift_in_streams.contains_key(skey) {
                        ctype = "gift";
                    }
                }

                let id = format!("demo-{skey}-{}-{i}", l.channel_id);
                // 移行後の comments には raw 列は無い (= raw_zst BLOB + comment_html TEXT)。
                // アーカイブ詳細/検索のコメントセルは raw.profileImage からアバターを描く
                // (renderer.js: profileImage: raw.profileImage) ため icon を埋める。
                let raw = serde_json::json!({ "commentHtml": body, "profileImage": icon }).to_string();
                let raw_zst =
                    zstd::encode_all(raw.as_bytes(), 3).map_err(|e| format!("zstd: {e}"))?;
                tx.execute(
                    "INSERT INTO comments(id, stream_id, listener_channel_id, posted_at, body, \
                        comment_type, superchat_amount_jpy, raw_zst, comment_html) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![id, vid, l.channel_id, posted, body, ctype, sc_amount, raw_zst, body],
                )
                .map_err(|e| format!("insert comment {id}: {e}"))?;
            }
        }

        // 現在ライブ枠に居るベテラン (= first_seen 30 日超) は挨拶済みにしておく
        if let Some(lk) = &live_key {
            if l.present_in_streams.iter().any(|s| s == lk) && l.first_seen_days_ago > 30.0 {
                if let Some((_, _, vid)) = win.get(lk) {
                    tx.execute(
                        "INSERT OR IGNORE INTO stream_listener_state(stream_video_id, listener_channel_id, greeted_at) VALUES (?1,?2,?3)",
                        params![vid, l.channel_id, now],
                    )
                    .map_err(|e| format!("greet state: {e}"))?;
                }
            }
        }
    }

    // 集計値を実コメントから再計算 (= 本番の listener_manager と同じ式)
    tx.execute(
        "UPDATE listeners SET \
            comment_count = (SELECT COUNT(*) FROM comments WHERE listener_channel_id = listeners.channel_id), \
            superchat_count = (SELECT COUNT(*) FROM comments WHERE listener_channel_id = listeners.channel_id AND comment_type IN ('superchat','sticker','gift')), \
            superchat_amount_jpy = (SELECT COALESCE(SUM(superchat_amount_jpy),0) FROM comments WHERE listener_channel_id = listeners.channel_id), \
            last_seen_at = COALESCE((SELECT MAX(posted_at) FROM comments WHERE listener_channel_id = listeners.channel_id), last_seen_at)",
        [],
    )
    .map_err(|e| format!("agg listeners: {e}"))?;

    tx.execute(
        "UPDATE streams SET \
            comment_count = COALESCE((SELECT COUNT(*) FROM comments WHERE stream_id = streams.video_id),0), \
            superchat_count = COALESCE((SELECT COUNT(*) FROM comments WHERE stream_id = streams.video_id AND comment_type IN ('superchat','sticker','gift')),0), \
            superchat_amount_jpy = COALESCE((SELECT SUM(COALESCE(superchat_amount_jpy,0)) FROM comments WHERE stream_id = streams.video_id),0)",
        [],
    )
    .map_err(|e| format!("agg streams: {e}"))?;

    tx.commit().map_err(|e| format!("commit: {e}"))?;

    let n_listeners = spec.listeners.len();
    let n_streams = spec.streams.len();
    Ok::<(), String>(()).map(|_| {
        tracing::info!(
            "demo seed done: {} listeners, {} streams -> {}",
            n_listeners,
            n_streams,
            db_path.display()
        );
    })
}
