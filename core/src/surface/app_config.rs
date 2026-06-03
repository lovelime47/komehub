//! AppConfigSurface — アプリ設定、デフォルト復元、素材コピー。

use super::AppState;
use crate::model_queue::ModelCommand;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/app/root-dir", post(set_app_root_dir))
        .route("/api/app/active-scene", get(get_active_scene))
        .route("/api/app/active-scene", post(set_active_scene))
        .route(
            "/api/app/restore-default-scene",
            post(restore_default_scene),
        )
        .route(
            "/api/app/check-template-context",
            post(check_template_context),
        )
        .route("/api/app/copy-asset", post(copy_asset))
}

#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new()
        .route("/api/app/active-scene", get(get_active_scene))
        .route("/api/app/active-scene", post(set_active_scene))
}

#[derive(serde::Deserialize)]
struct DirRequest {
    dir: String,
}

async fn set_app_root_dir(
    State(state): State<AppState>,
    Json(req): Json<DirRequest>,
) -> Json<serde_json::Value> {
    state
        .model_tx
        .send(ModelCommand::SetAppRootDir { dir: req.dir });
    Json(serde_json::json!({ "ok": true }))
}

async fn get_active_scene(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::GetActiveScene { reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSceneRequest {
    scene_id: String,
}

async fn set_active_scene(
    State(state): State<AppState>,
    Json(req): Json<ActiveSceneRequest>,
) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::SetActiveSceneAndSave {
        scene_id: req.scene_id,
    });
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneIdRequest {
    scene_id: String,
}

async fn restore_default_scene(
    State(state): State<AppState>,
    Json(req): Json<SceneIdRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::RestoreDefaultScene {
        scene_id: req.scene_id,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectIdRequest {
    effect_id: String,
}

async fn check_template_context(
    State(state): State<AppState>,
    Json(req): Json<EffectIdRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::CheckDefaultTemplateContext {
            effect_id: req.effect_id,
            reply: tx,
        });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyAssetRequest {
    scene_id: String,
    src_path: String,
    performance_id: String,
}

async fn copy_asset(
    State(state): State<AppState>,
    Json(req): Json<CopyAssetRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::CopyPerformanceAsset {
        scene_id: req.scene_id,
        src_path: req.src_path,
        performance_id: req.performance_id,
        reply: tx,
    });
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
