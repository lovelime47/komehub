use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::path::{Component, Path as StdPath, PathBuf};

use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/template-preview", get(serve_template_preview))
        .route("/cache/fonts/{family}/font.css", get(serve_font_css))
        .route("/cache/fonts/{family}/{file}", get(serve_font_file))
        .route("/cache/{cache_type}/{file}", get(serve_cached_image))
}

// 注: build_remote_ponout_router は既に cache::routes() を merge しているので、
// remote port でも /cache/{cache_type}/{file} は配信される。専用の remote_routes は不要。

async fn serve_template_preview(State(state): State<AppState>) -> Response {
    let preview_path = state
        .app_root_dir
        .join("docs")
        .join("analysis")
        .join("template-preview.html");
    serve_file(preview_path, Some("text/html; charset=utf-8"), None).await
}

async fn serve_font_css(
    State(state): State<AppState>,
    Path(family): Path<String>,
) -> impl IntoResponse {
    let family = match sanitize_family(&family) {
        Ok(value) => value,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    let path = state
        .media_cache_dir
        .join("fonts")
        .join(family)
        .join("font.css");
    serve_file(
        path,
        Some("text/css"),
        Some("public, max-age=604800"),
    )
    .await
}

async fn serve_font_file(
    State(state): State<AppState>,
    Path((family, file)): Path<(String, String)>,
) -> impl IntoResponse {
    let family = match sanitize_family(&family) {
        Ok(value) => value,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    let file = match sanitize_relative_file(&file) {
        Ok(value) => value,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    let path = state
        .media_cache_dir
        .join("fonts")
        .join(family)
        .join(file);
    let mime = font_mime_from_ext(&path);
    serve_file(
        path,
        Some(mime),
        Some("public, max-age=31536000"),
    )
    .await
}

async fn serve_cached_image(
    State(state): State<AppState>,
    Path((cache_type, file)): Path<(String, String)>,
) -> impl IntoResponse {
    if !matches!(
        cache_type.as_str(),
        "avatars" | "badges" | "emojis" | "stickers" | "stream-thumbs"
    ) {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let file = match sanitize_relative_file(&file) {
        Ok(value) => value,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    let path = state.media_cache_dir.join(cache_type).join(file);
    let mime = image_mime_from_ext(&path);
    serve_file(
        path,
        Some(mime),
        Some("public, max-age=86400"),
    )
    .await
}

async fn serve_file(path: PathBuf, mime: Option<&'static str>, cache_control: Option<&'static str>) -> Response {
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

fn sanitize_family(family: &str) -> Result<String, StatusCode> {
    if family.is_empty() || family == "." || family == ".." || family.contains('/') || family.contains('\\') {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(family.to_string())
}

fn sanitize_relative_file(path: &str) -> Result<PathBuf, StatusCode> {
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

fn font_mime_from_ext(path: &StdPath) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        _ => "application/octet-stream",
    }
}

fn image_mime_from_ext(path: &StdPath) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        _ => "image/jpeg",
    }
}
