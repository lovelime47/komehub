//! SSE Broadcaster — Electron および OBS へのリアルタイム配信。
//!
//! Model Queue から呼び出され、Static更新やSession追記をSSEで配信する。
//! axum の SSE ストリームハンドラも提供する。

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

pub use super::sse_shared::SseBroadcaster;
use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/stream", get(sse_handler))
}

#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new().route("/api/stream", get(sse_handler))
}

async fn sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    state.sse_broadcaster.public_client_connected();
    let rx = state.sse_broadcaster.subscribe();
    let initial_events = vec![
        serde_json::json!({
            "type": "version",
            "data": env!("CARGO_PKG_VERSION"),
        })
        .to_string(),
        serde_json::json!({
            "type": "status",
            "data": state.sse_broadcaster.current_status(),
        })
        .to_string(),
    ];
    let initial = tokio_stream::iter(initial_events).map(|data| Ok(Event::default().data(data)));

    let broadcast = BroadcastStream::new(rx)
        .filter_map(|result: Result<String, _>| result.ok())
        .filter_map(|data| translate_public_stream_message(&data))
        .map(|data| Ok(Event::default().data(data)));

    let stream = initial.chain(broadcast);
    // shutdown signal を観測して stream を end する。
    // これがないと axum::serve(.with_graceful_shutdown(..)) が SSE の長期接続を待ち続け、
    // listener socket が解放されない (= ゾンビ化の主原因)。
    let stream = super::take_until_shutdown(stream, state.shutdown_signal.clone());
    let stream = PublicClientStream {
        inner: Box::pin(stream),
        broadcaster: state.sse_broadcaster.clone(),
    };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("keepalive"),
    )
}

pub struct PublicClientStream {
    inner: Pin<Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>>,
    broadcaster: Arc<SseBroadcaster>,
}

impl Stream for PublicClientStream {
    type Item = Result<Event, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

impl Drop for PublicClientStream {
    fn drop(&mut self) {
        self.broadcaster.public_client_disconnected();
    }
}

fn translate_public_stream_message(data: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(data).ok()?;
    let msg_type = parsed.get("type").and_then(|value| value.as_str())?;
    match msg_type {
        "static" => {
            let path = parsed
                .get("path")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            match path {
                "connection" => Some(
                    serde_json::json!({
                        "type": "status",
                        "data": {
                            "connected": parsed.get("data").and_then(|value| value.get("connected")).and_then(|value| value.as_bool()).unwrap_or(false),
                            "videoId": parsed.get("data").and_then(|value| value.get("videoId")).cloned().unwrap_or(serde_json::Value::Null),
                            "viewerCount": 0,
                            // remote の対応済み / 挨拶トグル表示判定に必要 (= push_connection_status helper が injection 済みの値を中継)
                            "isOwnStream": parsed.get("data").and_then(|value| value.get("isOwnStream")).and_then(|value| value.as_bool()).unwrap_or(false),
                        }
                    })
                    .to_string(),
                ),
                "performanceEngineState" => Some(
                    serde_json::json!({
                        "type": "pause",
                        "data": {
                            "paused": parsed.get("data").and_then(|value| value.as_str()).unwrap_or("") == "paused"
                        }
                    })
                    .to_string(),
                ),
                // リモート閲覧 redesign §7.4: トグル状態を本体・remote 双方で同期する。
                // {type:"static",path:"comment-responded",data:{commentId,respondedAt}} 等を
                // {type:"static",path:..,data:..} としてそのまま中継する (remote 側 JS が
                // path で分岐して DOM 同期する設計、common.js::connectStream)。
                "comment-responded" | "listener-greeted" | "listener-hidden"
                | "listener-updated" => Some(
                    serde_json::json!({
                        "type": "static",
                        "path": path,
                        "data": parsed.get("data").cloned().unwrap_or(serde_json::Value::Null),
                    })
                    .to_string(),
                ),
                _ => None,
            }
        }
        "session-comment" => Some(
            serde_json::json!({
                "type": "event",
                "event": "comment",
                "data": parsed.get("data").cloned().unwrap_or(serde_json::Value::Null),
                "timestamp": parsed.get("timestamp").and_then(|value| value.as_u64()).unwrap_or(0),
            })
            .to_string(),
        ),
        "session-reaction" => Some(
            serde_json::json!({
                "type": "event",
                "event": "reaction",
                "data": parsed.get("data").cloned().unwrap_or(serde_json::Value::Null),
                "timestamp": parsed.get("timestamp").and_then(|value| value.as_u64()).unwrap_or(0),
            })
            .to_string(),
        ),
        "performance" => Some(
            serde_json::json!({
                "type": "performance",
                "sceneId": parsed.get("sceneId").cloned().unwrap_or(serde_json::Value::Null),
                "data": parsed.get("data").cloned().unwrap_or(serde_json::Value::Null),
                "timestamp": parsed.get("timestamp").and_then(|value| value.as_u64()).unwrap_or(0),
            })
            .to_string(),
        ),
        "performance-clear" => Some(
            serde_json::json!({
                "type": "performance-clear",
                "sceneId": parsed.get("sceneId").cloned().unwrap_or(serde_json::Value::Null),
                "timestamp": parsed.get("timestamp").and_then(|value| value.as_u64()).unwrap_or(0),
            })
            .to_string(),
        ),
        "tts-state" => Some(
            serde_json::json!({
                "type": "tts-state",
                "data": parsed.get("data").cloned().unwrap_or(serde_json::Value::Null),
            })
            .to_string(),
        ),
        // リモート閲覧 redesign §5.3: コメ削除を remote 側で反映するため中継
        "comment-deleted" => Some(
            serde_json::json!({
                "type": "event",
                "event": "comment-deleted",
                "data": parsed.get("data").cloned().unwrap_or(serde_json::Value::Null),
            })
            .to_string(),
        ),
        "reload" => Some(serde_json::json!({ "type": "reload" }).to_string()),
        _ => None,
    }
}
