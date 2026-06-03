//! Export/Import Surface — シーン・演出・エフェクトの ZIP エクスポート/インポート。

use axum::{extract::State, routing::post, Json, Router};

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/export/scene", post(export_scene))
        .route("/api/export/performance", post(export_performance))
        .route("/api/export/effect", post(export_effect))
        .route("/api/import/effect", post(import_effect))
        .route("/api/import/scene", post(import_scene))
        .route("/api/import/performance", post(import_performance))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSceneRequest {
    scene_id: String,
    dest_path: String,
}

async fn export_scene(
    State(state): State<AppState>,
    Json(req): Json<ExportSceneRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ExportScene {
        scene_id: req.scene_id,
        dest_path: req.dest_path,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPerformanceRequest {
    scene_id: String,
    performance_id: String,
    dest_path: String,
}

async fn export_performance(
    State(state): State<AppState>,
    Json(req): Json<ExportPerformanceRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ExportPerformance {
        scene_id: req.scene_id,
        performance_id: req.performance_id,
        dest_path: req.dest_path,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEffectRequest {
    effect_id: String,
    dest_path: String,
}

async fn export_effect(
    State(state): State<AppState>,
    Json(req): Json<ExportEffectRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ExportEffect {
        effect_id: req.effect_id,
        dest_path: req.dest_path,
        reply: tx,
    });
    await_reply(rx).await
}

// ========== Import ==========

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportEffectRequest { zip_path: String }

async fn import_effect(State(state): State<AppState>, Json(req): Json<ImportEffectRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ImportEffect { zip_path: req.zip_path, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSceneRequest { zip_path: String }

async fn import_scene(State(state): State<AppState>, Json(req): Json<ImportSceneRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ImportScene { zip_path: req.zip_path, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPerformanceRequest { scene_id: String, zip_path: String }

async fn import_performance(State(state): State<AppState>, Json(req): Json<ImportPerformanceRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ImportPerformance { scene_id: req.scene_id, zip_path: req.zip_path, reply: tx });
    await_reply(rx).await
}

async fn await_reply(rx: tokio::sync::oneshot::Receiver<serde_json::Value>) -> Json<serde_json::Value> {
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}
