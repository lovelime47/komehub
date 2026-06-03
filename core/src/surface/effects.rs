//! EffectsSurface — 演出オーバーレイの静的ファイル配信 + シーン別SSEストリーム。
//!
//! OBS ブラウザソースから以下のURLでアクセスされる:
//! - GET /effects/{sceneId}/           → index.html
//! - GET /effects/{sceneId}/stream     → シーン別SSE
//! - GET /effects/{sceneId}/assets/*   → 素材ファイル
//! - GET /effects/{sceneId}/js/*       → JS ファイル
//! - GET /effects/{sceneId}/css/*      → CSS ファイル
//! - GET /effects/{sceneId}/plugins/*  → プラグインファイル

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{sse::KeepAlive, IntoResponse, Response, Sse},
    routing::get,
    Json, Router,
};
use std::path::{Component, Path as StdPath, PathBuf};
use std::time::Duration;
use tokio_stream::StreamExt;

use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/effects/{scene_id}/stream", get(scene_sse))
        .route("/effects/{scene_id}", get(serve_index))
        .route("/effects/{scene_id}/", get(serve_index))
        .route("/effects/{scene_id}/assets/{*path}", get(serve_asset))
        .route("/effects/{scene_id}/mascot/{*path}", get(serve_mascot))
        .route("/effects/{scene_id}/js/{*path}", get(serve_overlay_static))
        .route(
            "/effects/{scene_id}/css/{*path}",
            get(serve_overlay_static_css),
        )
        .route("/effects/{scene_id}/plugins", get(list_plugins))
        .route("/effects/{scene_id}/plugins/", get(list_plugins))
        .route("/effects/{scene_id}/plugins/{*path}", get(serve_plugin))
}

#[allow(dead_code)]
pub fn remote_asset_routes() -> Router<AppState> {
    Router::new()
        .route("/effects/{scene_id}/assets/{*path}", get(serve_asset))
        .route("/effects/{scene_id}/mascot/{*path}", get(serve_mascot))
}

async fn scene_sse(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
) -> Sse<
    impl tokio_stream::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    let rx = state.sse_broadcaster.subscribe();
    let version = state.hub_version.clone();
    let initial = tokio_stream::once(Ok(axum::response::sse::Event::default().data(
        serde_json::json!({
            "type": "version",
            "data": version,
        })
        .to_string(),
    )));

    let broadcast = tokio_stream::wrappers::BroadcastStream::new(rx)
        .filter_map(move |result: Result<String, _>| match result {
            Ok(data) => translate_scene_stream_message(&scene_id, &data),
            Err(_) => None,
        })
        .map(|data| Ok(axum::response::sse::Event::default().data(data)));

    let stream = initial.chain(broadcast);
    let stream = super::take_until_shutdown(stream, state.shutdown_signal.clone());
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("keepalive"),
    )
}

async fn serve_index(
    State(state): State<AppState>,
    Path(_scene_id): Path<String>,
) -> impl IntoResponse {
    serve_file(
        state.overlay_dir.join("index.html"),
        Some("text/html; charset=utf-8"),
        Some("no-cache, no-store, must-revalidate"),
    )
    .await
}

async fn serve_asset(
    State(state): State<AppState>,
    Path((scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    let base_dir = state
        .data_dir
        .join("scenes")
        .join(scene_id)
        .join("performances");
    let asset_path = match resolve_safe_child_path(&base_dir, &file_path) {
        Ok(path) => path,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response()
        }
    };
    let mime = mime_from_ext(&asset_path);
    serve_file(
        asset_path,
        Some(mime),
        Some("no-cache, no-store, must-revalidate"),
    )
    .await
}

async fn serve_mascot(
    State(state): State<AppState>,
    Path((scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    let base_dir = state.data_dir.join("scenes").join(scene_id).join("mascot");
    let asset_path = match resolve_safe_child_path(&base_dir, &file_path) {
        Ok(path) => path,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response()
        }
    };
    let mime = mime_from_ext(&asset_path);
    serve_file(
        asset_path,
        Some(mime),
        Some("no-cache, no-store, must-revalidate"),
    )
    .await
}

async fn serve_overlay_static(
    State(state): State<AppState>,
    Path((_scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    let full_path = match resolve_safe_child_path(&state.overlay_dir.join("js"), &file_path) {
        Ok(path) => path,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response()
        }
    };
    serve_file(
        full_path,
        Some("application/javascript"),
        Some("no-cache, no-store, must-revalidate"),
    )
    .await
}

async fn serve_overlay_static_css(
    State(state): State<AppState>,
    Path((_scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    let full_path = match resolve_safe_child_path(&state.overlay_dir.join("css"), &file_path) {
        Ok(path) => path,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response()
        }
    };
    serve_file(
        full_path,
        Some("text/css"),
        Some("no-cache, no-store, must-revalidate"),
    )
    .await
}

async fn list_plugins(
    State(state): State<AppState>,
    Path(_scene_id): Path<String>,
) -> Json<serde_json::Value> {
    let plugins_dir = state.overlay_dir.join("plugins");
    let mut plugin_list = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(&plugins_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }

            let plugin_dir_name = entry.file_name().to_string_lossy().to_string();
            let manifest_path = entry.path().join("manifest.json");
            let Ok(manifest_content) = tokio::fs::read_to_string(&manifest_path).await else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&manifest_content) else {
                continue;
            };

            let entry_name = manifest
                .get("entry")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if entry_name.is_empty() {
                continue;
            }
            if !entry.path().join(entry_name).exists() {
                continue;
            }
            if !manifest_is_compatible(&manifest, &state.hub_version) {
                continue;
            }

            plugin_list.push(serde_json::json!({
                "type": manifest.get("id").and_then(|value| value.as_str()).unwrap_or(&plugin_dir_name),
                "basePath": format!("plugins/{}/", plugin_dir_name),
                "manifest": manifest,
            }));
        }
    }

    Json(serde_json::to_value(plugin_list).unwrap_or_else(|_| serde_json::json!([])))
}

async fn serve_plugin(
    State(state): State<AppState>,
    Path((_scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    let full_path = match resolve_safe_child_path(&state.overlay_dir.join("plugins"), &file_path) {
        Ok(path) => path,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response()
        }
    };
    let mime = mime_from_ext(&full_path);
    serve_file(
        full_path,
        Some(mime),
        Some("no-cache, no-store, must-revalidate"),
    )
    .await
}

async fn serve_file(
    path: PathBuf,
    mime: Option<&'static str>,
    cache_control: Option<&'static str>,
) -> Response {
    match tokio::fs::read(&path).await {
        Ok(content) => {
            let mut builder = Response::builder();
            if let Some(mime) = mime {
                builder = builder.header(header::CONTENT_TYPE, mime);
            }
            if let Some(cache_control) = cache_control {
                builder = builder.header(header::CACHE_CONTROL, cache_control);
            }
            builder.body(Body::from(content)).unwrap()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

fn translate_scene_stream_message(scene_id: &str, data: &str) -> Option<String> {
    let msg = serde_json::from_str::<serde_json::Value>(data).ok()?;
    let msg_type = msg
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    match msg_type {
        "performance" => {
            let msg_scene = msg
                .get("sceneId")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if msg_scene != scene_id {
                return None;
            }
            Some(
                serde_json::json!({
                    "type": "performance",
                    "data": msg.get("data"),
                    "timestamp": msg.get("timestamp")
                })
                .to_string(),
            )
        }
        "performance-clear" => {
            let msg_scene = msg
                .get("sceneId")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if msg_scene != scene_id && msg_scene != "*" && !msg_scene.is_empty() {
                return None;
            }
            Some(
                serde_json::json!({
                    "type": "performance-clear",
                    "timestamp": msg.get("timestamp")
                })
                .to_string(),
            )
        }
        "reload" => Some(data.to_string()),
        "static" => {
            let path = msg
                .get("path")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if path != "performanceEngineState" {
                return None;
            }
            Some(
                serde_json::json!({
                    "type": "pause",
                    "data": {
                        "paused": msg.get("data").and_then(|value| value.as_str()).unwrap_or("") == "paused"
                    }
                })
                .to_string(),
            )
        }
        _ => None,
    }
}

fn resolve_safe_child_path(base_dir: &StdPath, child_path: &str) -> Result<PathBuf, StatusCode> {
    let relative = sanitize_relative_path(child_path)?;
    Ok(base_dir.join(relative))
}

fn sanitize_relative_path(path: &str) -> Result<PathBuf, StatusCode> {
    let candidate = StdPath::new(path);
    if candidate.as_os_str().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut sanitized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => sanitized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(StatusCode::FORBIDDEN);
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(sanitized)
}

fn manifest_is_compatible(manifest: &serde_json::Value, hub_version: &str) -> bool {
    let Some(min_version) = manifest
        .get("minHubVersion")
        .and_then(|value| value.as_str())
    else {
        return true;
    };
    compare_semver(hub_version, min_version) >= 0
}

fn compare_semver(left: &str, right: &str) -> i32 {
    let left_parts: Vec<u32> = left
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect();
    let right_parts: Vec<u32> = right
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect();
    for index in 0..3 {
        let a = *left_parts.get(index).unwrap_or(&0);
        let b = *right_parts.get(index).unwrap_or(&0);
        if a > b {
            return 1;
        }
        if a < b {
            return -1;
        }
    }
    0
}

fn mime_from_ext(path: &StdPath) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("apng") => "image/apng",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}
