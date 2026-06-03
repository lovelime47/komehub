//! SavedSearchesSurface — 保存検索 (= cs-saved-strip / ls-saved-strip) の HTTP API。
//!
//! scope は 'comment-search' / 'listener-search' 等の自由文字列。 念のため
//! 既知 scope のみ受け付ける (= 任意 scope 注入を防ぐ)。
//!
//! LAN 公開ポリシー: 2026-05-14 にユーザー判断で remote から saved_searches の
//! CRUD を許可した (= スマホ手帳としての利便性を優先、 旧「3 種限定」原則を
//! さらに撤回)。 削除も含めて remote から実行可能。

use axum::{
    extract::{Path, Query, State},
    routing::{delete, get},
    Json, Router,
};

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/saved-searches",
            get(list_saved_searches).post(create_saved_search),
        )
        .route(
            "/api/saved-searches/{id}",
            delete(delete_saved_search).put(update_saved_search),
        )
}

/// remote port 公開ルート (= LAN 端末からアクセス可能)。
#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/saved-searches",
            get(list_saved_searches).post(create_saved_search),
        )
        .route(
            "/api/saved-searches/{id}",
            delete(delete_saved_search).put(update_saved_search),
        )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    /// 'comment-search' / 'listener-search' のいずれか。 不明 scope は 400 相当の
    /// 空リストを返す (= JS 側が安全に扱える)。
    #[serde(default)]
    scope: String,
}

async fn list_saved_searches(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Json<serde_json::Value> {
    if !is_known_scope(&q.scope) {
        return Json(serde_json::json!({ "ok": false, "error": "unknown scope" }));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::ListSavedSearches { scope: q.scope, reply: tx });
    await_reply(rx).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    scope: String,
    name: String,
    /// JSON 文字列。 中身は scope 依存 (= CommentsQuery 相当 or ListenersQuery 相当)。
    /// surface 側ではバリデートしない。
    conditions: String,
}

async fn create_saved_search(
    State(state): State<AppState>,
    Json(req): Json<CreateRequest>,
) -> Json<serde_json::Value> {
    if !is_known_scope(&req.scope) {
        return Json(serde_json::json!({ "ok": false, "error": "unknown scope" }));
    }
    if req.name.trim().is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "name is empty" }));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::CreateSavedSearch {
        scope: req.scope,
        name: req.name,
        conditions_json: req.conditions,
        reply: tx,
    });
    await_reply(rx).await
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    name: Option<String>,
    conditions: Option<String>,
    sort_order: Option<i64>,
}

async fn update_saved_search(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateRequest>,
) -> Json<serde_json::Value> {
    if req.name.is_none() && req.conditions.is_none() && req.sort_order.is_none() {
        return Json(serde_json::json!({ "ok": true, "updated": 0 }));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::UpdateSavedSearch {
        id,
        name: req.name,
        conditions_json: req.conditions,
        sort_order: req.sort_order,
        reply: tx,
    });
    await_reply(rx).await
}

async fn delete_saved_search(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::DeleteSavedSearch { id, reply: tx });
    await_reply(rx).await
}

fn is_known_scope(scope: &str) -> bool {
    matches!(scope, "comment-search" | "listener-search")
}

async fn await_reply(
    rx: tokio::sync::oneshot::Receiver<serde_json::Value>,
) -> Json<serde_json::Value> {
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "ok": false, "error": "Queue error" })),
    }
}
