//! PerformanceSurface — 演出の手動発火・テスト発火・一時停止・BAN・クールダウン。

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/trigger/{scene_id}/{performance_id}",
            post(trigger_performance),
        )
        .route(
            "/api/trigger-test/{scene_id}/{performance_id}",
            post(trigger_test),
        )
        .route(
            "/api/trigger-test-context/{scene_id}/{performance_id}",
            post(trigger_test_with_context),
        )
        .route(
            "/api/trigger-test-reaction/{scene_id}/{performance_id}",
            post(trigger_test_reaction),
        )
        .route(
            "/api/trigger-test-reaction-custom/{scene_id}/{performance_id}",
            post(trigger_test_reaction_custom),
        )
        .route("/api/paused", get(get_paused))
        .route("/api/paused", post(set_paused))
        .route(
            "/api/scenes/{scene_id}/performances/clear",
            post(clear_performances),
        )
        // 2026-05-09 仕様変更: 旧 /api/banned-users (= 演出フィルタ向け) は撤廃。
        // 演出フィルタは廃止 (= UI 表示抑制のみ)、新規追加先は /api/listeners/by-channel/.../hidden。
        .route("/api/global-cooldown", post(update_global_cooldown))
}

#[allow(dead_code)]
pub fn remote_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/trigger/{scene_id}/{performance_id}",
            post(trigger_performance),
        )
        .route("/api/paused", get(get_paused))
        .route("/api/paused", post(set_paused))
        .route(
            "/api/scenes/{scene_id}/performances/clear",
            post(clear_performances),
        )
}

async fn trigger_performance(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::TriggerPerformance {
        scene_id,
        performance_id,
    });
    Json(serde_json::json!({ "success": true }))
}

async fn trigger_test(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::TriggerTest {
        scene_id,
        performance_id,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!(false)),
    }
}

#[derive(serde::Deserialize)]
struct TestContext {
    #[serde(flatten)]
    context: serde_json::Value,
}

async fn trigger_test_with_context(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
    Json(body): Json<TestContext>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::TriggerTestWithContext {
        scene_id,
        performance_id,
        context: body.context,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn trigger_test_reaction(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::TriggerTestReaction {
        scene_id,
        performance_id,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!(false)),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactionCustomBody {
    reaction_key: String,
}

async fn trigger_test_reaction_custom(
    State(state): State<AppState>,
    Path((scene_id, performance_id)): Path<(String, String)>,
    Json(body): Json<ReactionCustomBody>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .model_tx
        .send(ModelCommand::TriggerTestReactionCustom {
            scene_id,
            performance_id,
            reaction_key: body.reaction_key,
            reply: tx,
        });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn get_paused(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetPaused { reply: tx });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!(false)),
    }
}

#[derive(serde::Deserialize)]
struct PausedBody {
    paused: bool,
}

async fn set_paused(
    State(state): State<AppState>,
    Json(body): Json<PausedBody>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::SetPaused {
        paused: body.paused,
        reply: Some(tx),
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!(false)),
    }
}

async fn clear_performances(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
) -> Json<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::ClearPerformances {
        scene_id,
        reply: tx,
    });
    match rx.await {
        Ok(val) => Json(val),
        Err(_) => Json(serde_json::json!({ "ok": false })),
    }
}

// 2026-05-09 仕様変更: update_banned_users (= 演出フィルタ向け fire-and-forget) を撤廃。
// 演出フィルタは廃止し、UI 表示抑制 (= /api/listeners/by-channel/.../hidden) に集約。

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalCooldownBody {
    max_effects: usize,
    user_interval: f64,
}

async fn update_global_cooldown(
    State(state): State<AppState>,
    Json(body): Json<GlobalCooldownBody>,
) -> Json<serde_json::Value> {
    state.model_tx.send(ModelCommand::UpdateGlobalCooldown {
        max_effects: body.max_effects,
        user_interval: body.user_interval,
    });
    Json(serde_json::json!({ "ok": true }))
}
