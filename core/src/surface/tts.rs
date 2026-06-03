//! TtsSurface — リモート操作用の読み上げ最小 API。

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tts/state", get(get_tts_state))
        .route("/api/tts/enabled", post(set_tts_enabled))
        .route("/api/tts/paused", post(set_tts_paused))
        .route("/api/tts/clear", post(clear_tts))
}

async fn get_tts_state(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetTtsState { reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn set_tts_enabled(
    State(state): State<AppState>,
    Json(body): Json<EnabledBody>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetTtsEnabled {
        enabled: body.enabled,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
struct PausedBody {
    paused: bool,
}

async fn set_tts_paused(
    State(state): State<AppState>,
    Json(body): Json<PausedBody>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetTtsPaused {
        paused: body.paused,
        reply: tx,
    });
    await_reply(rx).await
}

async fn clear_tts(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ClearTts { reply: tx });
    await_reply(rx).await
}

async fn await_reply(
    rx: tokio::sync::oneshot::Receiver<serde_json::Value>,
) -> Json<serde_json::Value> {
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}
