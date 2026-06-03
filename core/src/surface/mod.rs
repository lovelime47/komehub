mod app_config;
mod backup;
mod cache;
mod comment;
mod effect_crud;
mod effects;
mod export;
mod health;
mod listeners;
mod onecomme;
mod performance;
mod preset;
mod public_api;
mod remote;
mod saved_searches;
mod scene;
pub mod sse;
pub(crate) mod sse_shared;
mod templates;
mod tts;

use axum::{
    body::Body,
    extract::connect_info::ConnectInfo,
    http::{header, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use crate::model_queue::ModelTx;
use sse::SseBroadcaster;

/// 任意の `Stream` を shutdown signal で打ち切る。
/// `shutdown_rx` が `true` に変わった時点で stream を終了する。
/// SSE の長期接続が graceful shutdown 時に listener socket を握り続けるのを防ぐ。
pub(crate) fn take_until_shutdown<S>(
    stream: S,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> impl futures::Stream<Item = S::Item>
where
    S: futures::Stream + Send + 'static,
    S::Item: Send,
{
    use futures::StreamExt;
    stream.take_until(async move {
        let mut rx = shutdown_rx;
        let _ = rx.wait_for(|v| *v).await;
    })
}

/// 全Surfaceが共有するアプリケーション状態。
/// axum の State として各ハンドラに渡される。
#[derive(Clone)]
pub struct AppState {
    pub model_tx: ModelTx,
    pub sse_broadcaster: Arc<SseBroadcaster>,
    pub data_dir: PathBuf,
    pub media_cache_dir: PathBuf,
    pub app_root_dir: PathBuf,
    pub builtin_templates_dir: PathBuf,
    pub user_templates_dir: PathBuf,
    pub overlay_dir: PathBuf,
    pub hub_version: String,
    /// プロセス起動ごとに変わる識別子。OBS ブラウザソースが
    /// テンプレラッパ経由で hub 再起動を検知するために `selected/meta` で配信する。
    /// 「fetch 失敗→成功」検知より確実。値は起動時刻 (UNIX ms) を文字列化。
    pub boot_id: String,
    /// graceful shutdown signal。`true` に変わると SSE / WS handler は stream を end して、
    /// axum::serve の `with_graceful_shutdown` が drain 完了 → listener socket を解放する。
    /// 入れない場合、long-lived な SSE/WS が掴んだ接続が残り、Windows 上で
    /// LISTEN ソケットがゾンビ化する (= 11280 が PID 8388 のまま再利用不可になる現象)。
    pub shutdown_signal: tokio::sync::watch::Receiver<bool>,
}

/// axum Router を構築する。
/// 各Surface が自分のルートを登録する。
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(app_config::routes())
        .merge(backup::routes())
        .merge(comment::routes())
        .merge(performance::routes())
        .merge(public_api::routes())
        .merge(cache::routes())
        .merge(scene::routes())
        .merge(effect_crud::routes())
        .merge(export::routes())
        .merge(preset::routes())
        .merge(effects::routes())
        .merge(templates::routes())
        .merge(onecomme::routes())
        .merge(listeners::routes())
        .merge(saved_searches::routes())
        .merge(remote::routes())
        .merge(tts::routes())
        .merge(health::routes())
        .merge(sse::routes())
        .layer(middleware::from_fn(local_http_policy))
        .with_state(state)
}

/// スマホ操作用の別ポートで公開する最小 Router。
/// 通常の管理 API やテンプレート編集 API は載せない。
#[allow(dead_code)]
pub fn build_remote_ponout_router(state: AppState) -> Router {
    Router::new()
        .merge(remote::routes())
        .merge(public_api::remote_routes())
        .merge(scene::remote_routes())
        .merge(app_config::remote_routes())
        .merge(listeners::remote_routes())
        .merge(saved_searches::remote_routes())
        .merge(performance::remote_routes())
        .merge(tts::routes())
        .merge(sse::remote_routes())
        .merge(effects::remote_asset_routes())
        .merge(cache::routes())
        .layer(middleware::from_fn(local_http_policy))
        .with_state(state)
}

async fn local_http_policy(request: Request<Body>, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let method = request.method().clone();
    let path = request.uri().path().to_string();

    if method == Method::OPTIONS {
        if !origin.is_empty() && !is_allowed_origin(&origin) {
            let mut response = Response::new(Body::from("Forbidden"));
            *response.status_mut() = StatusCode::FORBIDDEN;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("null"),
            );
            return response;
        }

        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        apply_cors_headers(response.headers_mut(), &origin);
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        return response;
    }

    if !is_loopback_request(&request) && !is_lan_remote_allowed(&method, &path) {
        let mut response = Response::new(Body::from("Forbidden"));
        *response.status_mut() = StatusCode::FORBIDDEN;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        apply_cors_headers(response.headers_mut(), &origin);
        return response;
    }

    let mut response = next.run(request).await;
    apply_cors_headers(response.headers_mut(), &origin);
    response
}

fn is_loopback_request(request: &Request<Body>) -> bool {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().is_loopback())
        .unwrap_or(true)
}

fn is_lan_remote_allowed(method: &Method, path: &str) -> bool {
    if method == Method::GET {
        return path == "/api/health"
            || path == "/api/status"
            || path == "/api/events"
            || path == "/api/comments"
            || path == "/api/listeners"
            // /api/listeners/by-channel/{id} と /chip-counts と /comments/search を含む
            || path.starts_with("/api/listeners/by-channel/")
            || path == "/api/listeners/comments/search"
            // SPA リスナー画面のミニタブ件数バッジ用 (= Y-2)
            || path == "/api/listeners/stream-scoped-counts"
            // アーカイブ配信ログ一覧 (= Phase B2、 全期間の配信枠リスト)
            || path == "/api/listeners/streams"
            // アーカイブ コメ検索 popover 用タグ一覧 (= Phase C3/C4)
            || path == "/api/listener-tags"
            || path == "/api/listener-tag-assignments"
            || path == "/api/stream-tags"
            || path == "/api/stream-tag-assignments"
            // SPA ホーム画面の配信情報パネル用 (= B-2、 配信タイトル / 経過時間 / 累計 KPI)
            || path.starts_with("/api/listeners/streams/")
            // SPA リスナー詳細の heatmap 用 (= B-4、 直近 N 枠の活動量)
            || path == "/api/listeners/activity"
            // アーカイブ保存検索 (= Phase C5 / D2、 listener-search / comment-search 共用)
            || path == "/api/saved-searches"
            || path == "/api/stream"
            || path == "/api/scenes"
            || path == "/api/app/active-scene"
            || path == "/api/paused"
            || path == "/api/tts/state"
            || path == "/remote"
            || path.starts_with("/remote/")
            || path.starts_with("/effects/")
            || path.starts_with("/cache/");
    }

    if method == Method::POST {
        return path == "/api/app/active-scene"
            || path == "/api/paused"
            || path.starts_with("/api/trigger/")
            || path.starts_with("/api/tts/")
            || (path.starts_with("/api/scenes/") && path.ends_with("/performances/clear"))
            // リモート閲覧 redesign §4.1: 旧「挨拶済み / 対応済み / コメ・リスナー非表示」 3 トグル に加え、
            // 2026-05-14 にプロファイル編集 (nickname/label/notes) と タグ編集も remote 許可
            // (= session-status.md の「3 種限定」 原則撤回、 5 種に拡張)。
            || (path.starts_with("/api/listeners/by-channel/") && path.ends_with("/greeted"))
            || (path.starts_with("/api/listeners/by-channel/") && path.ends_with("/hidden"))
            || (path.starts_with("/api/listeners/by-channel/") && path.ends_with("/profile"))
            || (path.starts_with("/api/listeners/by-channel/") && path.ends_with("/tags"))
            || (path.starts_with("/api/comments/") && path.ends_with("/responded"))
            // リモート閲覧 §5.6: 複数値クエリは axum 標準の Query で扱えないため POST 経路で
            || path == "/api/listeners/comments/search"
            // アーカイブ保存検索 作成 (= Phase C5 / D2)
            || path == "/api/saved-searches";
    }

    if method == Method::PUT {
        // 保存検索の更新 (= rename / 並び替え)
        return path.starts_with("/api/saved-searches/");
    }

    if method == Method::DELETE {
        // 保存検索の削除
        return path.starts_with("/api/saved-searches/");
    }

    false
}

fn apply_cors_headers(headers: &mut axum::http::HeaderMap, origin: &str) {
    if is_allowed_origin(origin) {
        let allow_origin = if origin.is_empty() {
            HeaderValue::from_static("*")
        } else {
            HeaderValue::from_str(origin).unwrap_or_else(|_| HeaderValue::from_static("null"))
        };
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    } else {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("null"),
        );
    }
}

fn is_allowed_origin(origin: &str) -> bool {
    if origin.is_empty() || origin == "null" {
        return true;
    }
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };

    let host = rest.split('/').next().unwrap_or("");
    host == "localhost"
        || host == "127.0.0.1"
        || host.starts_with("localhost:")
        || host.starts_with("127.0.0.1:")
}
