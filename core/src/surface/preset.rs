//! PresetSurface — アバタープリセット管理。

use axum::{extract::{Path, State}, routing::{get, post, delete}, Json, Router};
use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/presets", get(get_preset_list))
        .route("/api/presets/current", get(get_current_preset))
        .route("/api/presets/current", post(set_current_preset))
        .route("/api/presets/switch", post(switch_preset))
        .route("/api/presets/duplicate", post(duplicate_preset))
        .route("/api/presets/{name}", delete(delete_preset))
        .route("/api/presets/export", post(export_preset))
        .route("/api/presets/import", post(import_preset))
}

async fn get_preset_list(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetPresetList { reply: tx });
    await_reply(rx).await
}

async fn get_current_preset(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetCurrentPreset { reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
struct SetCurrentRequest { name: String }

async fn set_current_preset(State(state): State<AppState>, Json(req): Json<SetCurrentRequest>) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::SetCurrentPreset { name: req.name });
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
struct SwitchRequest { name: String }

async fn switch_preset(State(state): State<AppState>, Json(req): Json<SwitchRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SwitchPreset { name: req.name, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateRequest { new_name: String }

async fn duplicate_preset(State(state): State<AppState>, Json(req): Json<DuplicateRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DuplicatePreset { new_name: req.new_name, reply: tx });
    await_reply(rx).await
}

async fn delete_preset(State(state): State<AppState>, Path(name): Path<String>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DeletePreset { name, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest { dest_path: String, export_name: String }

async fn export_preset(State(state): State<AppState>, Json(req): Json<ExportRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ExportPreset { dest_path: req.dest_path, export_name: req.export_name, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRequest { zip_path: String }

async fn import_preset(State(state): State<AppState>, Json(req): Json<ImportRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ImportPreset { zip_path: req.zip_path, reply: tx });
    await_reply(rx).await
}

async fn await_reply(rx: tokio::sync::oneshot::Receiver<serde_json::Value>) -> Json<serde_json::Value> {
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}
