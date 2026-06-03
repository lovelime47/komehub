//! SceneSurface — シーンのCRUD操作。

use axum::{
    extract::{Path, State},
    routing::{delete, get, post, put},
    Json, Router,
};

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/scenes", get(get_scenes))
        .route("/api/scenes/reload", post(reload_scenes))
        .route("/api/scenes", post(create_scene))
        .route("/api/scenes/{scene_id}", delete(delete_scene))
        .route("/api/scenes/{scene_id}", put(save_scene))
        .route("/api/scenes/{scene_id}/rename", post(rename_scene))
        .route("/api/scenes/{scene_id}/duplicate", post(duplicate_scene))
        .route("/api/scenes/reorder", post(reorder_scenes))
        .route("/api/scenes/active/{scene_id}", post(set_active_scene))
        .route("/api/scenes/{scene_id}/enabled", post(set_scene_enabled))
        .route("/api/scenes/{scene_id}/performances", get(get_performances))
        .route(
            "/api/scenes/{scene_id}/performances",
            post(save_performance),
        )
        .route(
            "/api/scenes/{scene_id}/performances/{performance_id}",
            delete(delete_performance),
        )
        .route(
            "/api/scenes/{scene_id}/performances/{performance_id}/enabled",
            post(set_performance_enabled),
        )
        .route(
            "/api/scenes/{scene_id}/performances/reorder",
            post(reorder_performances),
        )
}

#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new().route("/api/scenes", get(get_scenes))
}

async fn get_scenes(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetScenes { reply: tx });
    match rx.await {
        Ok(scenes) => Json(scenes),
        Err(_) => Json(serde_json::json!({ "error": "Failed to get scenes" })),
    }
}

async fn reload_scenes(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::ReloadScenes);
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSceneRequest {
    scene_id: String,
    name: String,
}

async fn create_scene(
    State(state): State<AppState>,
    Json(req): Json<CreateSceneRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::CreateScene {
        scene_id: req.scene_id,
        name: req.name,
        reply: tx,
    });
    match rx.await {
        Ok(resp) => Json(resp),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn delete_scene(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DeleteScene {
        scene_id,
        reply: tx,
    });
    match rx.await {
        Ok(resp) => Json(resp),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn save_scene(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
    Json(scene): Json<crate::state::scene::Scene>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SaveScene {
        scene_id,
        scene,
        reply: tx,
    });
    match rx.await {
        Ok(resp) => Json(resp),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameRequest {
    name: String,
}

async fn rename_scene(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
    Json(req): Json<RenameRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::RenameScene {
        scene_id,
        new_name: req.name,
        reply: tx,
    });
    match rx.await {
        Ok(resp) => Json(resp),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateRequest {
    new_id: String,
    new_name: String,
}

async fn duplicate_scene(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
    Json(req): Json<DuplicateRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DuplicateScene {
        source_id: scene_id,
        new_id: req.new_id,
        new_name: req.new_name,
        reply: tx,
    });
    match rx.await {
        Ok(resp) => Json(resp),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}

async fn reorder_scenes(
    State(state): State<AppState>,
    Json(order): Json<Vec<String>>,
) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::ReorderScenes { order });
    Json(serde_json::json!({ "ok": true }))
}

async fn set_active_scene(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
) -> Json<serde_json::Value> {
    state
        .model_tx
        .send(ModelCommand::SetActiveScene { scene_id });
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
struct EnabledRequest {
    enabled: bool,
}

async fn set_scene_enabled(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
    Json(req): Json<EnabledRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetSceneEnabled {
        scene_id,
        enabled: req.enabled,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn get_performances(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetPerformances {
        scene_id,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v),
        Err(_) => Json(serde_json::json!([])),
    }
}

async fn save_performance(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
    Json(performance): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SavePerformance {
        scene_id,
        performance,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn delete_performance(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DeletePerformance {
        scene_id,
        performance_id,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn set_performance_enabled(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
    Json(req): Json<EnabledRequest>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetPerformanceEnabled {
        scene_id,
        performance_id,
        enabled: req.enabled,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn reorder_performances(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
    Json(ordered_ids): Json<Vec<String>>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ReorderPerformances {
        scene_id,
        ordered_ids,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v),
        Err(_) => Json(serde_json::json!(false)),
    }
}
