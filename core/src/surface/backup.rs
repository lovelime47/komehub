//! BackupSurface — バックアップ管理 + エフェクトアップグレード。

use axum::{extract::{Path, State}, routing::{get, post, delete}, Json, Router};
use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/backups", get(get_backup_list))
        .route("/api/backups", post(create_backup))
        .route("/api/backups/full", post(create_full_backup))
        .route("/api/backups/{backup_id}", delete(delete_backup))
        .route("/api/backups/{backup_id}/restore", post(restore_backup))
        .route("/api/backups/dir", post(set_backups_dir))
        .route("/api/confirm-upgrade-effect", post(confirm_upgrade_effect))
}

async fn get_backup_list(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetBackupList { reply: tx });
    await_reply(rx).await
}

async fn create_backup(State(state): State<AppState>, Json(options): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::CreateBackup { options, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
struct FullBackupRequest { name: Option<String> }

async fn create_full_backup(State(state): State<AppState>, Json(req): Json<FullBackupRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::CreateFullBackup { name: req.name, reply: tx });
    await_reply(rx).await
}

async fn delete_backup(State(state): State<AppState>, Path(backup_id): Path<String>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::DeleteBackup { backup_id, reply: tx });
    await_reply(rx).await
}

async fn restore_backup(State(state): State<AppState>, Path(backup_id): Path<String>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::RestoreBackup { backup_id, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
struct SetDirRequest { dir: String }

async fn set_backups_dir(State(state): State<AppState>, Json(req): Json<SetDirRequest>) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::SetBackupsDir { dir: req.dir });
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpgradeRequest { zip_path: String, effect_id: String }

async fn confirm_upgrade_effect(State(state): State<AppState>, Json(req): Json<UpgradeRequest>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ConfirmUpgradeEffect { zip_path: req.zip_path, effect_id: req.effect_id, reply: tx });
    await_reply(rx).await
}

async fn await_reply(rx: tokio::sync::oneshot::Receiver<serde_json::Value>) -> Json<serde_json::Value> {
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "error": "Queue error" })),
    }
}
