//! HealthSurface — ヘルスチェックとアプリ情報。

use axum::{extract::State, routing::get, Json, Router};

use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health_check))
}

async fn health_check(State(state): State<AppState>) -> Json<serde_json::Value> {
    // bootId = ハブ起動毎の一意値。オーバーレイ等がポーリングしてハブ再起動を
    // 検知し、EventSource 再接続に依存せず自己回復するために使う。
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "bootId": state.boot_id,
    }))
}
