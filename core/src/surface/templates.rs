//! TemplateSurface — コメント表示テンプレートの静的ファイル配信 + SSEストリーム。
//!
//! OBS ブラウザソースから以下のURLでアクセスされる:
//! - GET /templates/{sceneId}/one/{seq}/...        → OneComme テンプレート
//! - GET /templates/{sceneId}/built-in/{shortName}/... → built-in テンプレート
//! - GET /templates/{sceneId}/comehub/{id}/...     → custom/imported テンプレート

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response, Sse},
    routing::get,
    Router,
};
use std::fs;
use std::path::{Component, Path as StdPath, PathBuf};
use std::pin::Pin;
use tokio_stream::StreamExt;

use super::AppState;
use crate::engine::template_manager::{collect_manifest_font_sources, TemplateType};
use crate::model_queue::ModelCommand;
use crate::state::scene::Scene;

type TemplateSseStream = Pin<Box<dyn tokio_stream::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>> + Send>>;

#[derive(Clone)]
struct TemplateLookupRecord {
    template_id: String,
    short_name: String,
    template_type: TemplateType,
    dir: PathBuf,
    aliases: Vec<String>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/templates/__runtime/{*path}", get(serve_runtime_asset))
        // __origin プリセットファイル群
        // テンプレート側は ../__origin/ を使うため、bucket ごとの別名も受ける
        .route("/templates/__origin/{*path}", get(serve_origin))
        .route("/templates/{scene_id}/__origin/{*path}", get(serve_origin_with_scene))
        .route("/templates/{scene_id}/one/__origin/{*path}", get(serve_origin_with_bucket))
        .route("/templates/{scene_id}/built-in/__origin/{*path}", get(serve_origin_with_bucket))
        .route("/templates/{scene_id}/comehub/__origin/{*path}", get(serve_origin_with_bucket))
        .route("/templates/{scene_id}/selected/", get(serve_selected_template_wrapper))
        .route("/templates/{scene_id}/selected/meta", get(get_selected_template_meta))
        // 新 bucket ルート
        .route("/templates/{scene_id}/one/{seq}/stream", get(template_sse_one))
        .route("/templates/{scene_id}/one/{seq}/", get(serve_index_one))
        .route("/templates/{scene_id}/one/{seq}/{*path}", get(serve_template_file_one))
        .route("/templates/{scene_id}/built-in/{short_name}/stream", get(template_sse_builtin))
        .route("/templates/{scene_id}/built-in/{short_name}/", get(serve_index_builtin))
        .route("/templates/{scene_id}/built-in/{short_name}/{*path}", get(serve_template_file_builtin))
        .route("/templates/{scene_id}/comehub/{id}/stream", get(template_sse_comehub))
        .route("/templates/{scene_id}/comehub/{id}/", get(serve_index_comehub))
        .route("/templates/{scene_id}/comehub/{id}/{*path}", get(serve_template_file_comehub))
        // わんコメ community プラグインは未同梱。テンプレが参照すると 404 になり、
        // silent に黒画面化する。ここで catch して WARN ログ + 説明付き 404 を返す。
        .route("/plugins/{*path}", get(serve_missing_onecomme_plugin))
}

/// わんコメの community プラグイン依存 (`/plugins/onecomme.plugin.XXX/...`) が
/// テンプレから呼ばれたときのハンドラ。こめはぶは community プラグインを同梱
/// しないため 404 を返すが、作者と user が原因を追えるよう:
///   - plugin id を含む説明文を本文に入れる
///   - 初回アクセス時に WARN ログを出す（ログスパム回避のため plugin id ごとに
///     dedupe、dedupe state は process lifetime 内のみ）
async fn serve_missing_onecomme_plugin(Path(path): Path<String>) -> Response {
    use std::collections::HashSet;
    use std::sync::{LazyLock, Mutex};

    static WARNED: LazyLock<Mutex<HashSet<String>>> =
        LazyLock::new(|| Mutex::new(HashSet::new()));

    // plugin id 抽出（"onecomme.plugin.template-utils/template.js" → "onecomme.plugin.template-utils"）
    let plugin_id = path.split('/').next().unwrap_or("").to_string();
    let should_warn = {
        if plugin_id.is_empty() {
            false
        } else {
            let mut warned = WARNED.lock().unwrap();
            warned.insert(plugin_id.clone())
        }
    };
    if should_warn {
        tracing::warn!(
            "わんコメ community プラグイン '{}' が要求されましたが、こめはぶには同梱されていません。テンプレートは正しく動作しない可能性があります (要求パス: /plugins/{})",
            plugin_id,
            path
        );
    }

    let body = format!(
        "// こめはぶは わんコメ community プラグイン '{}' を同梱していません。\n// このテンプレートは正しく動作しない可能性があります。\n// 詳細: docs/onecomme-migration-guide.md の「非対応プラグイン」節を参照してください。\n",
        plugin_id
    );
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn template_sse_one(
    State(state): State<AppState>,
    Path((scene_id, seq)): Path<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Sse<TemplateSseStream>, StatusCode> {
    let template_id = resolve_onecomme_template_id(&state, &scene_id, &seq)?;
    let is_preview = query.get("preview").map(|v| v == "1").unwrap_or(false);
    Ok(template_sse_inner(state, scene_id, template_id, is_preview).await)
}

async fn template_sse_builtin(
    State(state): State<AppState>,
    Path((scene_id, short_name)): Path<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Sse<TemplateSseStream>, StatusCode> {
    let template_id = resolve_builtin_template_id(&state, &short_name)?;
    let is_preview = query.get("preview").map(|v| v == "1").unwrap_or(false);
    Ok(template_sse_inner(state, scene_id, template_id, is_preview).await)
}

async fn template_sse_comehub(
    State(state): State<AppState>,
    Path((scene_id, id)): Path<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Sse<TemplateSseStream>, StatusCode> {
    let template_id = resolve_comehub_template_id(&state, &id)?;
    let is_preview = query.get("preview").map(|v| v == "1").unwrap_or(false);
    Ok(template_sse_inner(state, scene_id, template_id, is_preview).await)
}

async fn template_sse_inner(
    state: AppState,
    scene_id: String,
    template_id: String,
    is_preview: bool,
) -> Sse<TemplateSseStream> {
    // 初回 config を Model Queue から取得
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetSceneTemplateSettings {
        scene_id: scene_id.clone(),
        template_name: template_id.clone(),
        reply: tx,
    });
    let initial_config = rx.await.unwrap_or(serde_json::json!({}));
    let replay_limit = initial_config
        .get("maxComments")
        .and_then(|value| value.as_u64())
        .map(|value| value.clamp(1, 50) as usize)
        .unwrap_or(20);
    let initial_event = serde_json::json!({ "type": "config", "data": initial_config }).to_string();

    let (recent_tx, recent_rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetRecentComments {
        limit: replay_limit,
        reply: recent_tx,
    });
    let recent_comments = recent_rx.await.unwrap_or(serde_json::json!([]));
    let initial_comments_event = recent_comments
        .as_array()
        .filter(|comments| !comments.is_empty())
        .map(|comments| serde_json::json!({ "type": "comments", "data": comments }).to_string());

    let broadcast_rx = state.sse_broadcaster.subscribe();

    let mut initial_events = vec![initial_event];
    if let Some(comments_event) = initial_comments_event {
        initial_events.push(comments_event);
    }
    let initial = tokio_stream::iter(initial_events);
    let broadcast = tokio_stream::wrappers::BroadcastStream::new(broadcast_rx)
        .filter_map(move |result: Result<String, _>| {
            match result {
                Ok(data) => {
                    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&data) {
                        let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match msg_type {
                            "session-comment" if is_preview => {
                                let wrapped = serde_json::json!({
                                    "type": "comments",
                                    "data": [msg.get("data")]
                                });
                                Some(wrapped.to_string())
                            }
                            "template-comment" => {
                                if is_preview {
                                    return None;
                                }
                                let msg_scene = msg.get("sceneId").and_then(|s| s.as_str()).unwrap_or("");
                                if msg_scene != scene_id {
                                    return None;
                                }
                                let enabled = msg.get("enabledTemplates")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| arr.iter().any(|t| t.as_str() == Some(&template_id)))
                                    .unwrap_or(false);
                                if !enabled {
                                    return None;
                                }
                                let wrapped = serde_json::json!({
                                    "type": "comments",
                                    "data": [msg.get("data")]
                                });
                                Some(wrapped.to_string())
                            }
                            "comment-deleted" => {
                                let wrapped = serde_json::json!({
                                    "type": "deleted",
                                    "data": msg.get("data")
                                });
                                Some(wrapped.to_string())
                            }
                            "template-config" => {
                                let msg_scene = msg.get("sceneId").and_then(|s| s.as_str()).unwrap_or("");
                                let msg_tmpl = msg.get("templateName").and_then(|s| s.as_str()).unwrap_or("");
                                if msg_scene == scene_id && msg_tmpl == template_id {
                                    let wrapped = serde_json::json!({
                                        "type": "config",
                                        "data": msg.get("data")
                                    });
                                    Some(wrapped.to_string())
                                } else {
                                    None
                                }
                            }
                            _ => None,
                        }
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        });

    let combined = initial
        .chain(broadcast)
        .map(|data| Ok(axum::response::sse::Event::default().data(data)));
    // shutdown signal で stream を打ち切る (SSE が listener を握り続けるのを防ぐ)
    let stream: TemplateSseStream = Box::pin(super::take_until_shutdown(
        combined,
        state.shutdown_signal.clone(),
    ));

    Sse::new(stream)
}

/// テンプレートの index.html を配信
/// CSS/JS の参照にキャッシュバスターを付与し、OBS 再接続時に最新ファイルを取得させる
async fn serve_index_one(
    State(state): State<AppState>,
    Path((scene_id, seq)): Path<(String, String)>,
) -> impl IntoResponse {
    match resolve_onecomme_template_id(&state, &scene_id, &seq) {
        Ok(template_id) => {
            let stream_path = format!("/templates/{}/one/{}/stream", scene_id, seq);
            serve_index_inner(&state, &scene_id, &template_id, "onecomme", &stream_path, true).await
        }
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_index_builtin(
    State(state): State<AppState>,
    Path((scene_id, short_name)): Path<(String, String)>,
) -> impl IntoResponse {
    match resolve_builtin_template_id(&state, &short_name) {
        Ok(template_id) => {
            let stream_path = format!("/templates/{}/built-in/{}/stream", scene_id, short_name);
            serve_index_inner(&state, &scene_id, &template_id, "builtin", &stream_path, true).await
        }
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_index_comehub(
    State(state): State<AppState>,
    Path((scene_id, id)): Path<(String, String)>,
) -> impl IntoResponse {
    match resolve_comehub_template_id(&state, &id) {
        Ok(template_id) => {
            let stream_path = format!("/templates/{}/comehub/{}/stream", scene_id, id);
            serve_index_inner(&state, &scene_id, &template_id, "comehub", &stream_path, true).await
        }
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_selected_template_wrapper(
    Path(scene_id): Path<String>,
) -> impl IntoResponse {
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body {{
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: transparent;
    }}
    body {{
      font-family: sans-serif;
    }}
    #template-frame {{
      width: 100%;
      height: 100%;
      border: 0;
      background: transparent;
      display: none;
    }}
  </style>
</head>
<body>
  <iframe id="template-frame" allowtransparency="true"></iframe>
  <script>
    (function () {{
      'use strict';
      var sceneId = {scene_id_json};
      var frame = document.getElementById('template-frame');
      var currentRoute = '';
      // ハブ起動 ID。selected/meta のレスポンスから取得し、変化を観測したら
      // 「ハブ再起動」とみなしてラッパページ自体を再読込する (= ラッパ HTML/JS の
      // コード変更も含め確実に最新化、 張り直し不要)。「fetch 失敗→成功」検知より確実。
      var lastBootId = '';

      function ensureFrameVisible(route) {{
        frame.style.display = 'block';
      }}

      function attachFrameSrc(targetFrame, route) {{
        // src に bootId クエリを付与して URL を物理的に変える。
        // これで OBS / CEF が同一 URL のキャッシュを使う余地を消す。
        var bust = (route.indexOf('?') >= 0 ? '&' : '?') + '_kh=' + encodeURIComponent(lastBootId || Date.now());
        targetFrame.src = route + bust;
      }}

      function applyRoute(route) {{
        if (!route) {{
          currentRoute = '';
          frame.removeAttribute('src');
          frame.style.display = 'none';
          return;
        }}
        ensureFrameVisible(route);
        if (currentRoute === route) return;
        currentRoute = route;
        attachFrameSrc(frame, route);
      }}

      function refresh() {{
        fetch('/templates/' + encodeURIComponent(sceneId) + '/selected/meta', {{ cache: 'no-store' }})
          .then(function (response) {{
            if (!response.ok) throw new Error('meta request failed');
            return response.json();
          }})
          .then(function (meta) {{
            var nextBootId = meta && meta.bootId ? String(meta.bootId) : '';
            var nextRoute = meta && meta.route ? meta.route : '';
            // bootId 変化を検知 = ハブ再起動。ラッパページ自体を location.replace で
            // 再読込し、ラッパ HTML/JS のコード変更も含めて最新化する (= 張り直し不要)。
            // キャッシュバストクエリで CEF のキャッシュも回避。初回 (lastBootId 空) は
            // baseline 記録のみで再読込しない。
            if (lastBootId && nextBootId && nextBootId !== lastBootId) {{
              location.replace(location.pathname + '?_kh=' + encodeURIComponent(nextBootId));
              return;
            }}
            if (nextBootId) lastBootId = nextBootId;
            applyRoute(nextRoute);
          }})
          .catch(function () {{
            // 通信失敗中は iframe をそのまま残す (次回成功時に bootId 比較で再起動を検出)
          }});
      }}

      refresh();
      setInterval(refresh, 1000);
    }})();
  </script>
</body>
</html>"#,
        scene_id_json = serde_json::to_string(&scene_id).unwrap_or_else(|_| "\"\"".to_string())
    );

    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
        .body(Body::from(html))
        .unwrap()
}

async fn get_selected_template_meta(
    State(state): State<AppState>,
    Path(scene_id): Path<String>,
) -> impl IntoResponse {
    let boot_id = state.boot_id.clone();
    match resolve_selected_template_route(&state, &scene_id) {
        Ok((template_id, route)) => Response::builder()
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
            .body(Body::from(
                serde_json::json!({
                    "templateId": template_id,
                    "route": route,
                    "bootId": boot_id
                })
                .to_string(),
            ))
            .unwrap(),
        Err(StatusCode::NOT_FOUND) => Response::builder()
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
            .body(Body::from(
                serde_json::json!({
                    "templateId": "",
                    "route": "",
                    "bootId": boot_id
                })
                .to_string(),
            ))
            .unwrap(),
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_index_inner(
    state: &AppState,
    scene_id: &str,
    template_id: &str,
    template_kind: &str,
    stream_path: &str,
    reset_on_visible: bool,
) -> Response {
    let path = match resolve_template_path(state, template_id, "index.html") {
        Ok(path) => path,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    let template_dir = resolve_template_dir(state, template_id).ok();
    let manifest = template_dir
        .as_ref()
        .and_then(|dir| read_template_manifest(dir));
    let fonts = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("fonts").cloned())
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let font_sources = collect_manifest_font_sources(manifest.as_ref()).unwrap_or_default();
    match tokio::fs::read_to_string(&path).await {
        Ok(html) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let runtime_url = format!("/templates/__runtime/runtime.js?v={}", ts);
            let style_url = format!("style.css?v={}", ts);
            let script_url = format!("script.js?v={}", ts);
            let resource_debug = serde_json::json!({
                "html": {
                    "servedAtUnixMs": ts,
                    "cacheBust": ts.to_string(),
                },
                "assets": {
                    "runtime": build_resource_debug_entry(
                        "runtime.js",
                        &runtime_url,
                        Some(state.overlay_dir.join("template-runtime").join("runtime.js")),
                        ts,
                    ),
                    "style": build_resource_debug_entry(
                        "style.css",
                        &style_url,
                        resolve_template_path(state, template_id, "style.css").ok(),
                        ts,
                    ),
                    "script": build_resource_debug_entry(
                        "script.js",
                        &script_url,
                        resolve_template_path(state, template_id, "script.js").ok(),
                        ts,
                    ),
                }
            });
            let runtime_config = serde_json::to_string(&serde_json::json!({
                "contractVersion": 1,
                "sceneId": scene_id,
                "templateId": template_id,
                "templateKind": template_kind,
                "streamPath": stream_path,
                "previewDefaultBackground": "#111827",
                "resetOnVisible": reset_on_visible,
                "fonts": fonts,
                "fontSources": font_sources,
                "resourceDebug": resource_debug,
            }))
            .unwrap_or_else(|_| "{}".to_string());
            let runtime_loader = format!(
                r#"<script>window.__KOMEHUB_TEMPLATE_RUNTIME_CONFIG = Object.assign({{}}, window.__KOMEHUB_TEMPLATE_RUNTIME_CONFIG, {});</script>
<script src="/templates/__runtime/runtime.js?v={}"></script>"#,
                runtime_config, ts
            );
            // Vue 2 テンプレート救済: script.js に new Vue( があれば vue.min.js → vue2.min.js
            let busted = if html.contains("vue.min.js") && !html.contains("vue2.min.js") && !html.contains("vue3.min.js") {
                let needs_vue2 = template_dir
                    .as_ref()
                    .map(|dir| template_uses_legacy_vue2(dir))
                    .unwrap_or(false);
                if needs_vue2 {
                    html.replace("vue.min.js", "vue2.min.js")
                } else {
                    html
                }
            } else {
                html
            };
            let busted = replace_template_asset_ref(&busted, "href", "style.css", &style_url);
            let busted = replace_template_asset_ref(&busted, "src", "script.js", &script_url);
            let busted = if busted.contains("</head>") {
                busted.replacen("</head>", &format!("{}\n</head>", runtime_loader), 1)
            } else {
                format!("{}\n{}", runtime_loader, busted)
            };
            Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
                .body(Body::from(busted))
                .unwrap()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

fn build_resource_debug_entry(
    label: &str,
    url: &str,
    full_path: Option<PathBuf>,
    cache_bust: u128,
) -> serde_json::Value {
    let metadata = full_path.as_ref().and_then(|path| fs::metadata(path).ok());
    let modified_unix_ms = metadata
        .as_ref()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    let size_bytes = metadata.as_ref().map(|meta| meta.len());
    serde_json::json!({
        "label": label,
        "url": url,
        "cacheBust": cache_bust.to_string(),
        "path": full_path.map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
        "sizeBytes": size_bytes,
        "modifiedUnixMs": modified_unix_ms,
    })
}

/// テンプレート内の任意のファイルを配信（CSS, JS, 画像等）
async fn serve_template_file_one(
    State(state): State<AppState>,
    Path((scene_id, seq, file_path)): Path<(String, String, String)>,
) -> impl IntoResponse {
    if seq == "__origin" {
        return serve_origin_file(&state, &file_path).await;
    }
    match resolve_onecomme_template_id(&state, &scene_id, &seq) {
        Ok(template_id) => serve_template_file_inner(&state, &scene_id, &template_id, &file_path).await,
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_template_file_builtin(
    State(state): State<AppState>,
    Path((scene_id, short_name, file_path)): Path<(String, String, String)>,
) -> impl IntoResponse {
    if short_name == "__origin" {
        return serve_origin_file(&state, &file_path).await;
    }
    match resolve_builtin_template_id(&state, &short_name) {
        Ok(template_id) => serve_template_file_inner(&state, &scene_id, &template_id, &file_path).await,
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_template_file_comehub(
    State(state): State<AppState>,
    Path((scene_id, id, file_path)): Path<(String, String, String)>,
) -> impl IntoResponse {
    if id == "__origin" {
        return serve_origin_file(&state, &file_path).await;
    }
    match resolve_comehub_template_id(&state, &id) {
        Ok(template_id) => serve_template_file_inner(&state, &scene_id, &template_id, &file_path).await,
        Err(status) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn serve_template_file_inner(
    state: &AppState,
    scene_id: &str,
    template_id: &str,
    file_path: &str,
) -> Response {
    let full_path = match resolve_template_or_scene_asset_path(state, scene_id, template_id, file_path) {
        Ok(path) => path,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    serve_file(full_path).await
}

/// __origin プリセットファイルを配信（シーン付きパス: /templates/{sceneId}/__origin/...）
async fn serve_origin_with_scene(
    State(state): State<AppState>,
    Path((_scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    serve_origin_file(&state, &file_path).await
}

/// __origin プリセットファイルを配信（bucket 付きパス: /templates/{sceneId}/{bucket}/__origin/...）
async fn serve_origin_with_bucket(
    State(state): State<AppState>,
    Path((_scene_id, file_path)): Path<(String, String)>,
) -> impl IntoResponse {
    serve_origin_file(&state, &file_path).await
}

/// __origin プリセットファイルを配信（/templates/__origin/...）
async fn serve_origin(State(state): State<AppState>, Path(file_path): Path<String>) -> impl IntoResponse {
    serve_origin_file(&state, &file_path).await
}

async fn serve_runtime_asset(State(state): State<AppState>, Path(file_path): Path<String>) -> impl IntoResponse {
    let runtime_dir = state.overlay_dir.join("template-runtime");
    let full_path = match resolve_safe_child_path(&runtime_dir, &file_path) {
        Ok(path) => path,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    serve_file(full_path).await
}

async fn serve_origin_file(state: &AppState, file_path: &str) -> Response {
    let origin_dir = state.overlay_dir.join("onecomme").join("__origin");
    let full_path = match resolve_safe_child_path(&origin_dir, file_path) {
        Ok(path) => path,
        Err(status) => return (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    };
    serve_file(full_path).await
}

/// テンプレートディレクトリを解決する。template id と legacy name の両方を受け付ける。
fn resolve_template_dir(state: &AppState, template_id_or_name: &str) -> Result<PathBuf, StatusCode> {
    resolve_template_record(state, template_id_or_name).map(|record| record.dir)
}

/// テンプレート内のファイルパスを解決する。
fn resolve_template_path(state: &AppState, template_id_or_name: &str, file: &str) -> Result<PathBuf, StatusCode> {
    let template_dir = resolve_template_dir(state, template_id_or_name)?;
    resolve_safe_child_path(&template_dir, file)
}

fn resolve_template_or_scene_asset_path(
    state: &AppState,
    scene_id: &str,
    template_id_or_name: &str,
    file: &str,
) -> Result<PathBuf, StatusCode> {
    let template_path = resolve_template_path(state, template_id_or_name, file)?;
    if template_path.exists() {
        return Ok(template_path);
    }

    if let Some(asset_relative) = file.strip_prefix("assets/") {
        let scene_assets_dir = state.data_dir.join("scenes").join(scene_id).join("performances");
        let scene_asset_path = resolve_safe_child_path(&scene_assets_dir, asset_relative)?;
        if scene_asset_path.exists() {
            return Ok(scene_asset_path);
        }
    }

    Ok(template_path)
}

fn validate_template_name(name: &str) -> Result<String, StatusCode> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(name.to_string())
}

fn resolve_template_record(state: &AppState, template_id_or_name: &str) -> Result<TemplateLookupRecord, StatusCode> {
    let safe_identifier = validate_template_name(template_id_or_name)?;
    scan_template_records(state)
        .into_iter()
        .find(|record| record.aliases.iter().any(|alias| alias == &safe_identifier))
        .ok_or(StatusCode::NOT_FOUND)
}

fn resolve_builtin_template_id(state: &AppState, short_name: &str) -> Result<String, StatusCode> {
    let safe_short_name = validate_template_name(short_name)?;
    scan_template_records(state)
        .into_iter()
        .find(|record| record.template_type == TemplateType::Builtin && record.short_name == safe_short_name)
        .map(|record| record.template_id)
        .ok_or(StatusCode::NOT_FOUND)
}

fn resolve_comehub_template_id(state: &AppState, template_id: &str) -> Result<String, StatusCode> {
    let safe_id = validate_template_name(template_id)?;
    scan_template_records(state)
        .into_iter()
        .find(|record| record.template_type == TemplateType::Custom && record.template_id == safe_id)
        .map(|record| record.template_id)
        .ok_or(StatusCode::NOT_FOUND)
}

fn resolve_onecomme_template_id(state: &AppState, scene_id: &str, seq: &str) -> Result<String, StatusCode> {
    let seq_index = seq.parse::<usize>().map_err(|_| StatusCode::BAD_REQUEST)?;
    if seq_index == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let scene = load_scene_from_disk(state, scene_id)?;
    let mut current_index = 0usize;
    for template in scene.templates {
        let identifier = if !template.id.is_empty() {
            template.id
        } else {
            template.name
        };
        let Ok(record) = resolve_template_record(state, &identifier) else {
            continue;
        };
        if record.template_type != TemplateType::OneComme {
            continue;
        }
        current_index += 1;
        if current_index == seq_index {
            return Ok(record.template_id);
        }
    }
    Err(StatusCode::NOT_FOUND)
}

fn resolve_selected_template_route(state: &AppState, scene_id: &str) -> Result<(String, String), StatusCode> {
    let mut scene = load_scene_from_disk(state, scene_id)?;
    crate::state::scene::normalize_scene_selected_template_id(&mut scene);
    // シーン無効 / テンプレ無効 / 未選択 (= 全削除含む) のときは空 route を返し、
    // オーバーレイを空白にする (= OBS に「テンプレートが選択されていません」等を出さない)。
    if !scene.enabled || !scene.templates_enabled || scene.selected_template_id.is_empty() {
        return Err(StatusCode::NOT_FOUND);
    }

    let selected_id = scene.selected_template_id.clone();
    let record = resolve_template_record(state, &selected_id)?;
    let route = match record.template_type {
        TemplateType::Builtin => format!("/templates/{}/built-in/{}/", scene_id, record.short_name),
        TemplateType::Custom => format!("/templates/{}/comehub/{}/", scene_id, record.template_id),
        TemplateType::OneComme => {
            let mut current_index = 0usize;
            let mut seq = None;
            for template in &scene.templates {
                let identifier = if !template.id.is_empty() {
                    template.id.as_str()
                } else {
                    template.name.as_str()
                };
                let Ok(template_record) = resolve_template_record(state, identifier) else {
                    continue;
                };
                if template_record.template_type != TemplateType::OneComme {
                    continue;
                }
                current_index += 1;
                if template_record.template_id == record.template_id {
                    seq = Some(current_index);
                    break;
                }
            }
            let seq = seq.ok_or(StatusCode::NOT_FOUND)?;
            format!("/templates/{}/one/{}/", scene_id, seq)
        }
    };

    Ok((record.template_id, route))
}

fn load_scene_from_disk(state: &AppState, scene_id: &str) -> Result<Scene, StatusCode> {
    let safe_scene_id = validate_template_name(scene_id)?;
    let scene_path = state.data_dir.join("scenes").join(safe_scene_id).join("scene.json");
    let content = fs::read_to_string(scene_path).map_err(|_| StatusCode::NOT_FOUND)?;
    serde_json::from_str::<Scene>(&content).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn scan_template_records(state: &AppState) -> Vec<TemplateLookupRecord> {
    let mut records = Vec::new();
    for dir in [&state.builtin_templates_dir, &state.user_templates_dir] {
        let is_builtin_dir = dir == &state.builtin_templates_dir;
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !path.join("index.html").exists() {
                continue;
            }
            let storage_name = entry.file_name().to_string_lossy().to_string();
            let manifest = read_template_manifest(&path);
            let meta = read_template_meta(&path);
            let template_id = meta
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(|value| value.as_str())
                .or_else(|| manifest.as_ref().and_then(|value| value.get("id")).and_then(|value| value.as_str()))
                .unwrap_or(storage_name.as_str())
                .to_string();
            let short_name = manifest
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .unwrap_or(storage_name.as_str())
                .to_string();
            let template_type = detect_template_type(&path, is_builtin_dir);
            let mut aliases = vec![template_id.clone(), storage_name];
            if let Some(name) = manifest
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
            {
                aliases.push(name.to_string());
            }
            aliases.sort();
            aliases.dedup();
            records.push(TemplateLookupRecord {
                template_id,
                short_name,
                template_type,
                dir: path,
                aliases,
            });
        }
    }
    records
}

fn read_template_manifest(template_dir: &StdPath) -> Option<serde_json::Value> {
    let content = fs::read_to_string(template_dir.join("manifest.json")).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_template_meta(template_dir: &StdPath) -> Option<serde_json::Value> {
    let content = fs::read_to_string(template_dir.join(".template-meta.json")).ok()?;
    serde_json::from_str(&content).ok()
}

fn detect_template_type(template_dir: &StdPath, is_builtin_dir: bool) -> TemplateType {
    if template_uses_onecomme_sdk(template_dir) {
        return TemplateType::OneComme;
    }
    if is_builtin_dir {
        TemplateType::Builtin
    } else {
        TemplateType::Custom
    }
}

fn file_contains_any(path: &StdPath, needles: &[&str]) -> bool {
    fs::read_to_string(path)
        .map(|content| needles.iter().any(|needle| content.contains(needle)))
        .unwrap_or(false)
}

fn any_template_file_contains(template_dir: &StdPath, extensions: &[&str], needles: &[&str]) -> bool {
    let mut stack = vec![template_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("");
            if extensions.iter().any(|candidate| ext.eq_ignore_ascii_case(candidate))
                && file_contains_any(&path, needles)
            {
                return true;
            }
        }
    }
    false
}

fn template_uses_onecomme_sdk(template_dir: &StdPath) -> bool {
    file_contains_any(&template_dir.join("index.html"), &["onesdk.js", "onesdk.legacy.js", "OneSDK"])
        || any_template_file_contains(template_dir, &["js", "html"], &["onesdk.js", "onesdk.legacy.js", "OneSDK."])
}

fn template_uses_legacy_vue2(template_dir: &StdPath) -> bool {
    any_template_file_contains(template_dir, &["js", "html"], &["new Vue(", "Vue.extend(", "Vue.component("])
}

fn replace_template_asset_ref(html: &str, attr: &str, file_name: &str, busted_url: &str) -> String {
    let mut replaced = html.to_string();
    let patterns = [
        format!(r#"{}="{}""#, attr, file_name),
        format!(r#"{}="./{}""#, attr, file_name),
        format!(r#"{}='{}'"#, attr, file_name),
        format!(r#"{}='./{}'"#, attr, file_name),
    ];
    for pattern in patterns {
        if replaced.contains(&pattern) {
            let replacement = if pattern.contains('\'') {
                format!(r#"{}='{}'"#, attr, busted_url)
            } else {
                format!(r#"{}="{}""#, attr, busted_url)
            };
            replaced = replaced.replace(&pattern, &replacement);
        }
    }
    replaced
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

/// ファイルを読んでMIMEタイプ付きでレスポンスする
async fn serve_file(path: PathBuf) -> Response {
    match tokio::fs::read(&path).await {
        Ok(content) => {
            let mime = mime_from_ext(&path);
            Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
                .body(Body::from(content))
                .unwrap()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

fn mime_from_ext(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}
