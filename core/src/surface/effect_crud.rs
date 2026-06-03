//! EffectCrudSurface — エフェクト定義の CRUD 操作。

use axum::{
    extract::{Path, State},
    routing::{delete, get, post, put},
    Json, Router,
};

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/effects", get(get_effects))
        .route("/api/effects/{effect_id}", get(get_effect))
        .route("/api/effects", post(add_effect))
        .route("/api/effects/{effect_id}", put(update_effect))
        .route("/api/effects/{effect_id}", delete(remove_effect))
        .route("/api/effects/{effect_id}/duplicate", post(duplicate_effect))
        .route("/api/plugins/manifests", get(get_plugin_manifests))
}

async fn get_effects(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetEffects { reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn get_effect(
    State(state): State<AppState>,
    Path(effect_id): Path<String>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetEffect { effect_id, reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn add_effect(
    State(state): State<AppState>,
    Json(effect): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::AddEffect { effect, reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn update_effect(
    State(state): State<AppState>,
    Path(effect_id): Path<String>,
    Json(mut effect): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    // URL の effect_id を body に注入
    if let Some(obj) = effect.as_object_mut() {
        obj.insert("id".to_string(), serde_json::Value::String(effect_id));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::UpdateEffect { effect, reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn remove_effect(
    State(state): State<AppState>,
    Path(effect_id): Path<String>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::RemoveEffect { effect_id, reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateRequest {
    new_name: String,
}

async fn duplicate_effect(
    State(state): State<AppState>,
    Path(effect_id): Path<String>,
    Json(req): Json<DuplicateRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DuplicateEffect {
        effect_id,
        new_name: req.new_name,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn get_plugin_manifests(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetPluginManifests { reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}
