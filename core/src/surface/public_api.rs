use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};

use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/status", get(get_status))
        .route("/api/events", get(get_events))
        .route("/api/comments", get(get_comments))
}

#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new()
        .route("/api/status", get(get_status))
        .route("/api/events", get(get_events))
        .route("/api/comments", get(get_comments))
}

#[derive(Debug, serde::Deserialize)]
struct EventQuery {
    limit: Option<String>,
    #[serde(rename = "type")]
    event_type: Option<String>,
    /// remote-viewing redesign §4.2: 現枠コメだけ返すフィルタ。
    /// 指定時は recent_events cache 内の comment.data.liveId と一致するものだけ返す。
    /// 接続切替時にも cache に旧枠コメが残るケースの誤表示を防ぐ。
    #[serde(rename = "streamVideoId")]
    stream_video_id: Option<String>,
}

async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(state.sse_broadcaster.current_status()).unwrap_or_default())
}

async fn get_events(
    State(state): State<AppState>,
    Query(query): Query<EventQuery>,
) -> Json<serde_json::Value> {
    let limit = parse_limit(query.limit.as_deref(), 500);
    let events = state
        .sse_broadcaster
        .recent_events(query.event_type.as_deref(), limit);
    Json(serde_json::to_value(events).unwrap_or_else(|_| serde_json::json!([])))
}

async fn get_comments(
    State(state): State<AppState>,
    Query(query): Query<EventQuery>,
) -> Json<serde_json::Value> {
    let limit = parse_limit(query.limit.as_deref(), 200);
    // streamVideoId 指定時 / hidden_for_comments 適用時は cache から多めに取得して filter 後に take。
    // hidden は配信者の管理 UI 専用 (= テンプレ / OBS の SSE には適用しない、broadcast は素のまま)。
    let fetch_count = 500;
    let target_stream = query.stream_video_id.as_deref();
    let broadcaster = &state.sse_broadcaster;
    let comments: Vec<serde_json::Value> = broadcaster
        .recent_events(Some("comment"), fetch_count)
        .into_iter()
        .map(|event| event.data)
        .filter(|data| match target_stream {
            None => true,
            Some(target) => data.get("liveId").and_then(|v| v.as_str()) == Some(target),
        })
        .filter(|data| {
            // 2026-05-09 仕様変更: コメ非表示 listener の発言を除外。userId が空の場合は素通し。
            let listener_id = data.get("userId").and_then(|v| v.as_str()).unwrap_or("");
            if listener_id.is_empty() {
                return true;
            }
            !broadcaster.is_hidden_for_comments(listener_id)
        })
        .take(limit)
        .collect();
    Json(serde_json::to_value(comments).unwrap_or_else(|_| serde_json::json!([])))
}

fn parse_limit(raw_limit: Option<&str>, fallback_limit: usize) -> usize {
    let Some(raw_limit) = raw_limit else {
        return fallback_limit;
    };
    raw_limit
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .map(|value| value.min(500))
        .unwrap_or(fallback_limit)
}

#[cfg(test)]
mod tests {
    use super::parse_limit;

    #[test]
    fn parse_limit_uses_fallback_for_invalid_input() {
        assert_eq!(parse_limit(Some("abc"), 200), 200);
        assert_eq!(parse_limit(Some("0"), 200), 200);
        assert_eq!(parse_limit(None, 200), 200);
    }

    #[test]
    fn parse_limit_caps_large_values() {
        assert_eq!(parse_limit(Some("9999"), 200), 500);
    }
}
