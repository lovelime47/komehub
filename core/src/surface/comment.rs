//! CommentSurface — chat-scraper からのコメント・リアクション受信。

use axum::{extract::State, routing::post, Json, Router};

use super::AppState;
use crate::model_queue::ModelCommand;
use crate::state::comment::RawReaction;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/comments", post(receive_comments))
        .route("/api/reactions", post(receive_reaction))
        .route("/api/connection", post(update_connection))
}

async fn receive_comments(
    State(state): State<AppState>,
    Json(comments): Json<Vec<serde_json::Value>>,
) -> Json<serde_json::Value> {
    let comments_json = serde_json::to_string(&comments).unwrap_or_else(|_| "[]".to_string());
    state
        .model_tx
        .send(ModelCommand::IncomingCommentsJson { comments_json });
    Json(serde_json::json!({ "ok": true }))
}

async fn receive_reaction(
    State(state): State<AppState>,
    Json(reaction): Json<RawReaction>,
) -> Json<serde_json::Value> {
    state
        .model_tx
        .send(ModelCommand::IncomingReaction { reaction });
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionUpdate {
    connected: bool,
    video_id: Option<String>,
}

async fn update_connection(
    State(state): State<AppState>,
    Json(update): Json<ConnectionUpdate>,
) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::ConnectionStateChanged {
        connected: update.connected,
        video_id: update.video_id,
    });
    Json(serde_json::json!({ "ok": true }))
}
