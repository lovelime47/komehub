//! ListenersSurface — Step 3 リスナー管理 HTTP API。
//!
//! HTTP からは **読み取り系 + 自チャンネル設定のみ** を公開する。
//! インポート / エクスポート / わんコメ同期などのファイル I/O 操作は、
//! 任意パス書き込み・読み込みリスクを避けるため Electron IPC + napi 経由のみで提供する
//! (フェーズ 3.3 第 8 ラウンドのレビュー対応)。
//!
//! 設計詳細は docs/step3-design.md § 4.5 を参照。

use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};

use super::AppState;
use crate::model_queue::ModelCommand;
use crate::state::listener::{
    CommentsQuery, ListenersActivityQuery, ListenersQuery, StreamListenersQuery, StreamsQuery,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/listeners", get(list_listeners))
        .route("/api/listeners/activity", get(list_listeners_activity))
        .route(
            "/api/listeners/stream-scoped-counts",
            get(get_stream_scoped_listener_counts),
        )
        .route("/api/listeners/by-channel/{channel_id}", get(get_listener_detail))
        .route("/api/listeners/by-channel/{channel_id}/chip-counts", get(get_listener_chip_counts))
        .route(
            "/api/listeners/owner-channel",
            get(get_owner_channel).put(set_owner_channel),
        )
        .route("/api/listeners/streams", get(list_streams))
        .route("/api/listeners/streams/{video_id}", get(get_stream_detail))
        // アーカイブ 配信詳細サブ画面 (= Phase B3) 用
        .route(
            "/api/listeners/streams/{video_id}/listeners",
            get(list_stream_listeners),
        )
        .route(
            "/api/listeners/streams/{video_id}/stats",
            get(get_stream_stats),
        )
        .route(
            "/api/listeners/streams/{video_id}/comment-chip-counts",
            get(get_comment_chip_counts),
        )
        // タグ一覧 (= Phase C3/C4 popover で利用)
        .route("/api/listener-tags", get(list_all_listener_tags))
        .route("/api/listener-tag-assignments", get(list_all_listener_tag_assignments))
        .route("/api/stream-tags", get(list_all_stream_tags))
        .route("/api/stream-tag-assignments", get(list_all_stream_tag_assignments))
        .route("/api/listeners/comments/search", get(search_comments).post(search_comments_post))
        // リモート閲覧 redesign §4.1: 「挨拶済み」「対応済み」「BAN」トグル
        .route("/api/listeners/by-channel/{channel_id}/greeted", post(post_listener_greeted))
        .route("/api/comments/{comment_id}/responded", post(post_comment_responded))
        .route("/api/listeners/by-channel/{channel_id}/hidden", post(post_listener_hidden))
        // リスナープロファイル編集 (nickname / notes / label) と タグ編集
        .route("/api/listeners/by-channel/{channel_id}/profile", post(post_listener_profile))
        .route("/api/listeners/by-channel/{channel_id}/tags", post(post_listener_tags))
    // PT 注: export / import は HTTP からは公開しない (任意パス書き込み・読み込みの
    // セキュリティリスクを避けるため、Electron IPC + napi 経由のみ提供する。
    // 設計書 § 7 / 第 8 ラウンドのレビュー対応)
}

/// remote port 公開ルート。
/// 公開する書き込み: 「挨拶済み」「対応済み」「BAN」の 3 トグルだけ
/// (= remote-viewing-redesign.md §4.3 の絶対除外リストに載っているもの以外)。
#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new()
        .route("/api/listeners", get(list_listeners))
        .route(
            "/api/listeners/stream-scoped-counts",
            get(get_stream_scoped_listener_counts),
        )
        .route("/api/listeners/by-channel/{channel_id}", get(get_listener_detail))
        .route("/api/listeners/by-channel/{channel_id}/chip-counts", get(get_listener_chip_counts))
        .route("/api/listeners/by-channel/{channel_id}/greeted", post(post_listener_greeted))
        .route("/api/comments/{comment_id}/responded", post(post_comment_responded))
        .route("/api/listeners/by-channel/{channel_id}/hidden", post(post_listener_hidden))
        // リスナープロファイル / タグ編集 (= 2026-05-14: 旧「remote 書き込み 3 種限定」 原則
        // を撤回し、 LAN リモート手帳から手元の編集を可能にする。 docs/session-status.md 参照)
        .route("/api/listeners/by-channel/{channel_id}/profile", post(post_listener_profile))
        .route("/api/listeners/by-channel/{channel_id}/tags", post(post_listener_tags))
        .route("/api/listeners/comments/search", get(search_comments).post(search_comments_post))
        // SPA ホーム画面の配信情報パネル用 (= B-2、 配信タイトル / 経過時間 / 累計 KPI)
        .route("/api/listeners/streams/{video_id}", get(get_stream_detail))
        // アーカイブ配信ログ一覧 (= Phase B2、 全期間の配信枠リスト)
        .route("/api/listeners/streams", get(list_streams))
        // アーカイブ 配信詳細サブ画面 (= Phase B3) 用
        .route(
            "/api/listeners/streams/{video_id}/listeners",
            get(list_stream_listeners),
        )
        .route(
            "/api/listeners/streams/{video_id}/stats",
            get(get_stream_stats),
        )
        .route(
            "/api/listeners/streams/{video_id}/comment-chip-counts",
            get(get_comment_chip_counts),
        )
        // タグ一覧 (= Phase C3/C4 popover で利用)
        .route("/api/listener-tags", get(list_all_listener_tags))
        .route("/api/listener-tag-assignments", get(list_all_listener_tag_assignments))
        .route("/api/stream-tags", get(list_all_stream_tags))
        .route("/api/stream-tag-assignments", get(list_all_stream_tag_assignments))
        // SPA リスナー詳細の heatmap 用 (= B-4、 直近 N 枠の活動量)
        .route("/api/listeners/activity", get(list_listeners_activity))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChipCountsQuery {
    /// per-stream context (= 当該枠でのコメ数 / 挨拶状態を取得する場合に指定)。
    /// 空文字 / 未指定で context 無し (= greetedAt = 0 / thisStream = 0)。
    #[serde(default)]
    context_video_id: String,
}

async fn get_listener_chip_counts(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<ChipCountsQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetListenerChipCounts {
        channel_id,
        context_video_id: q.context_video_id,
        reply: tx,
    });
    await_reply(rx).await
}

/// リスナータブのミニタブ件数バッジ用。 stream context 毎の
/// { all, unGreeted, firstTime, returning, comeback, newMember } を返す。
/// `q` (任意) が指定されると name フィルタとして合成される。
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StreamScopedCountsQuery {
    /// 対象 stream の video_id (必須相当、 空文字なら全 0 を返す)。
    #[serde(default)]
    stream_video_id: String,
    /// 名前検索クエリ (任意)。 大文字小文字無視で listener 名 / ニックネームに含まれる行のみ
    /// 計測する。
    #[serde(default)]
    q: Option<String>,
}

async fn get_stream_scoped_listener_counts(
    State(state): State<AppState>,
    Query(query): Query<StreamScopedCountsQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetStreamScopedListenerCounts {
        stream_video_id: query.stream_video_id,
        q: query.q,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GreetedRequest {
    stream_video_id: String,
    /// 1 = 挨拶済みにする / 0 = 解除
    value: u8,
}

async fn post_listener_greeted(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Json(req): Json<GreetedRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetListenerGreeted {
        stream_video_id: req.stream_video_id,
        listener_channel_id: channel_id,
        value: req.value != 0,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondedRequest {
    /// 1 = 対応済みにする / 0 = 解除
    value: u8,
}

async fn post_comment_responded(
    State(state): State<AppState>,
    Path(comment_id): Path<String>,
    Json(req): Json<RespondedRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetCommentResponded {
        comment_id,
        value: req.value != 0,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiddenRequest {
    /// コメリスト非表示 (= 配信者の管理 UI のみ。テンプレート / OBS には影響しない)
    hide_from_comments: bool,
    /// リスナーリスト非表示 (= 配信者の管理 UI のみ)
    hide_from_listeners: bool,
}

async fn post_listener_hidden(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Json(req): Json<HiddenRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetListenerHidden {
        listener_channel_id: channel_id,
        hide_from_comments: req.hide_from_comments,
        hide_from_listeners: req.hide_from_listeners,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRequest {
    /// null は触らない、 空文字 "" は明示クリア。 既存 napi update_listener_metadata と整合。
    #[serde(default)]
    nickname: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

async fn post_listener_profile(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Json(req): Json<ProfileRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::UpdateListenerMetadata {
        channel_id,
        nickname: req.nickname,
        notes: req.notes,
        label: req.label,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagsRequest {
    /// 全タグ置換 (= 既存タグはすべて消し、 渡された配列に差し替え)。 空配列でクリア。
    tags: Vec<String>,
}

async fn post_listener_tags(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Json(req): Json<TagsRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetListenerTags {
        channel_id,
        tags: req.tags,
        reply: tx,
    });
    await_reply(rx).await
}

async fn list_listeners(
    State(state): State<AppState>,
    Query(query): Query<ListenersQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetListeners {
        query,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DetailQuery {
    /// 直近コメントの取得件数 (1〜200、既定 50)
    recent_comment_limit: Option<usize>,
    /// 指定時、 ListenerRow.per_stream_* (= この枠コメ / SC / 最終 / greetedAt) を
    /// 当該枠コメから集計して埋める。 SPA リスナー詳細の現枠 KPI 用 (B-4)。
    /// stream detail 側 (= get_stream_detail) では無視。
    #[serde(default)]
    stream_video_id: Option<String>,
}

async fn get_listener_detail(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<DetailQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetListenerDetail {
        channel_id,
        recent_comment_limit: q.recent_comment_limit.unwrap_or(50),
        stream_video_id: q.stream_video_id.filter(|s| !s.is_empty()),
        reply: tx,
    });
    await_reply(rx).await
}

async fn get_owner_channel(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetOwnerChannels { reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetOwnerChannelRequest {
    /// `OwnerChannel { channelId, handle? }` の配列。空配列で「設定解除」相当。
    owner_channels: Vec<crate::state::listener::OwnerChannel>,
}

async fn set_owner_channel(
    State(state): State<AppState>,
    Json(req): Json<SetOwnerChannelRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetOwnerChannels {
        channels: req.owner_channels,
        reply: tx,
    });
    await_reply(rx).await
}

async fn list_streams(
    State(state): State<AppState>,
    Query(query): Query<StreamsQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetStreams { query, reply: tx });
    await_reply(rx).await
}

async fn get_stream_detail(
    State(state): State<AppState>,
    Path(video_id): Path<String>,
    Query(q): Query<DetailQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetStreamDetail {
        video_id,
        recent_comment_limit: q.recent_comment_limit.unwrap_or(100),
        reply: tx,
    });
    await_reply(rx).await
}

async fn search_comments(
    State(state): State<AppState>,
    Query(query): Query<CommentsQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SearchComments { query, reply: tx });
    await_reply(rx).await
}

/// POST 版 search_comments。
/// 理由: axum 標準の Query (= serde_urlencoded) は `?key=a&key=b` 形式の Vec<String> を
/// デシリアライズできず、複数値フィールド (listenerChannelIds / streamIds など) を渡すと
/// 400 になる。remote 端末から複数 channelId / streamId で絞り込むユースケース向けに
/// JSON body で受ける経路を追加。サーバ側は CommentsQuery 1 本で済む。
async fn search_comments_post(
    State(state): State<AppState>,
    Json(query): Json<CommentsQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SearchComments { query, reply: tx });
    await_reply(rx).await
}

async fn list_stream_listeners(
    State(state): State<AppState>,
    Path(video_id): Path<String>,
    Query(query): Query<StreamListenersQuery>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ListStreamListeners {
        video_id,
        query,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StreamStatsQuery {
    /// bin の幅 (分単位)。 既定 15 分。 1〜120 にクランプ。
    bin_minutes: Option<i64>,
}

async fn get_stream_stats(
    State(state): State<AppState>,
    Path(video_id): Path<String>,
    Query(q): Query<StreamStatsQuery>,
) -> Json<serde_json::Value> {
    let bin_minutes = q.bin_minutes.unwrap_or(15).clamp(1, 120);
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetStreamStats {
        video_id,
        bin_minutes,
        reply: tx,
    });
    await_reply(rx).await
}

async fn get_comment_chip_counts(
    State(state): State<AppState>,
    Path(video_id): Path<String>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetCommentChipCounts {
        video_id,
        reply: tx,
    });
    await_reply(rx).await
}

async fn list_all_listener_tags(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::ListAllListenerTags { reply: tx });
    await_reply(rx).await
}

async fn list_all_stream_tags(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::ListAllStreamTags { reply: tx });
    await_reply(rx).await
}

async fn list_all_listener_tag_assignments(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::ListAllListenerTagAssignments { reply: tx });
    await_reply(rx).await
}

async fn list_all_stream_tag_assignments(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::ListAllStreamTagAssignments { reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ActivityQueryRaw {
    /// listener.channel_id を comma-separated で渡す (例: `yt-UC1,yt-UC2`)。
    channel_ids: Option<String>,
    /// 直近 N 配信枠 (default 14, max 60)。
    stream_count: Option<u32>,
}

async fn list_listeners_activity(
    State(state): State<AppState>,
    Query(q): Query<ActivityQueryRaw>,
) -> Json<serde_json::Value> {
    let channel_ids: Vec<String> = q
        .channel_ids
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let query = ListenersActivityQuery {
        channel_ids,
        stream_count: q.stream_count,
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::GetListenersActivity { query, reply: tx });
    await_reply(rx).await
}

async fn await_reply(rx: tokio::sync::oneshot::Receiver<serde_json::Value>) -> Json<serde_json::Value> {
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "ok": false, "error": "Queue error" })),
    }
}
