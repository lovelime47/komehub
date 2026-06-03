//! RemoteSurface — LAN 端末から開くリモート画面 (= スマホ閲覧 + 配信中操作)。
//!
//! 設計正本: docs/architecture/remote-viewing-redesign.md
//!
//! 画面構成 (= URL マップ §5.1、 2026-05 SPA 化で旧多 HTML を撤廃):
//!   /remote/                    SPA shell (= ホーム view を表示)
//!   /remote/comments            SPA shell (= コメ view)
//!   /remote/listeners           SPA shell (= リスナー view)
//!   /remote/listeners/{ch}      SPA shell (= リスナー詳細 view)
//!   /remote/search              SPA shell (= コメ検索結果 view)
//!   /remote/ponout/             既存ポン出し (= touch しない、 別 SPA)
//!
//! すべての画面 URL は app.html を返す。 view 切替はクライアント側
//! (= app.js + view-*.js + history.pushState) が担う。 これにより:
//! - タブ切替で SSE 接続が切れない (= 「コメが消える」体験の根本解消)
//! - state は module-level に保持されて view 再 init 時に rehydrate
//!
//! 各 HTML/CSS/JS は include_str! でバイナリに焼き込む (= 配布 1 ファイルで完結)。

use axum::{
    extract::Path,
    http::{header, HeaderValue, StatusCode},
    response::Response,
    routing::get,
    Router,
};

use super::AppState;

// 旧ポン出し (= 既存実装、touch しない)
const PONOUT_HTML: &str = include_str!("../../../electron/renderer/ponout-remote.html");
const PONOUT_CSS: &str = include_str!("../../../electron/renderer/ponout.css");
const PONOUT_API_JS: &str = include_str!("../../../electron/renderer/ponout-remote-api.js");
const PONOUT_JS: &str = include_str!("../../../electron/renderer/ponout.js");

// SPA shell + 共通アセット
const APP_HTML: &str = include_str!("../../../electron/renderer/remote/app.html");
const APP_JS: &str = include_str!("../../../electron/renderer/remote/app.js");
const STYLE_CSS: &str = include_str!("../../../electron/renderer/remote/style.css");
const COMMON_JS: &str = include_str!("../../../electron/renderer/remote/common.js");
const BOTTOM_SHEET_JS: &str =
    include_str!("../../../electron/renderer/remote/bottom-sheet.js");

// SPA view modules (= 各 view が window.KomehubViews.{name} に登録)
const VIEW_HOME_JS: &str = include_str!("../../../electron/renderer/remote/view-home.js");
const VIEW_COMMENTS_JS: &str = include_str!("../../../electron/renderer/remote/view-comments.js");
const VIEW_GIFTS_JS: &str = include_str!("../../../electron/renderer/remote/view-gifts.js");
const VIEW_LISTENERS_JS: &str =
    include_str!("../../../electron/renderer/remote/view-listeners.js");
const VIEW_LISTENER_DETAIL_JS: &str =
    include_str!("../../../electron/renderer/remote/view-listener-detail.js");
const VIEW_SEARCH_JS: &str = include_str!("../../../electron/renderer/remote/view-search.js");
const VIEW_ARCHIVE_JS: &str =
    include_str!("../../../electron/renderer/remote/view-archive.js");
const VIEW_ARCHIVE_STREAMS_JS: &str =
    include_str!("../../../electron/renderer/remote/view-archive-streams.js");
const VIEW_ARCHIVE_COMMENT_SEARCH_JS: &str =
    include_str!("../../../electron/renderer/remote/view-archive-comment-search.js");
const VIEW_ARCHIVE_LISTENER_SEARCH_JS: &str =
    include_str!("../../../electron/renderer/remote/view-archive-listener-search.js");
const VIEW_STREAM_DETAIL_JS: &str =
    include_str!("../../../electron/renderer/remote/view-stream-detail.js");

// shared/ モジュール群 (= 本体 Electron renderer と同じファイル)
const SHARED_CSS: &str = include_str!("../../../electron/renderer/shared/shared.css");
const SHARED_SANITIZE_JS: &str =
    include_str!("../../../electron/renderer/shared/comment-sanitize.js");
const SHARED_SUPERCHAT_JS: &str =
    include_str!("../../../electron/renderer/shared/comment-superchat.js");
const SHARED_COMMENT_ITEM_JS: &str =
    include_str!("../../../electron/renderer/shared/comment-item.js");
const SHARED_UNDO_JS: &str =
    include_str!("../../../electron/renderer/shared/undo-snackbar.js");
const SHARED_LISTENER_BADGES_JS: &str =
    include_str!("../../../electron/renderer/shared/listener-badges.js");

pub fn routes() -> Router<AppState> {
    Router::new()
        // ───── SPA ルート (= URL は client-side ルーターが解釈) ─────
        .route("/remote", get(serve_app_html))
        .route("/remote/", get(serve_app_html))
        .route("/remote/comments", get(serve_app_html))
        .route("/remote/gifts", get(serve_app_html))
        .route("/remote/listeners", get(serve_app_html))
        .route("/remote/listeners/{channel_id}", get(serve_app_html))
        .route("/remote/search", get(serve_app_html))
        .route("/remote/archive", get(serve_app_html))
        .route("/remote/streams/{video_id}", get(serve_app_html))
        // ───── SPA アセット ─────
        .route("/remote/style.css", get(serve_style_css))
        .route("/remote/common.js", get(serve_common_js))
        .route("/remote/app.js", get(serve_app_js))
        .route("/remote/bottom-sheet.js", get(serve_bottom_sheet_js))
        .route("/remote/view-home.js", get(serve_view_home_js))
        .route("/remote/view-comments.js", get(serve_view_comments_js))
        .route("/remote/view-gifts.js", get(serve_view_gifts_js))
        .route("/remote/view-listeners.js", get(serve_view_listeners_js))
        .route("/remote/view-listener-detail.js", get(serve_view_listener_detail_js))
        .route("/remote/view-search.js", get(serve_view_search_js))
        .route("/remote/view-archive.js", get(serve_view_archive_js))
        .route("/remote/view-archive-streams.js", get(serve_view_archive_streams_js))
        .route(
            "/remote/view-archive-comment-search.js",
            get(serve_view_archive_comment_search_js),
        )
        .route(
            "/remote/view-archive-listener-search.js",
            get(serve_view_archive_listener_search_js),
        )
        .route("/remote/view-stream-detail.js", get(serve_view_stream_detail_js))
        // shared/* は path parameter で 1 ハンドラに集約
        .route("/remote/shared/{file}", get(serve_shared_asset))
        // ───── 既存ポン出し (= touch しない) ─────
        .route("/remote/ponout", get(serve_ponout_html))
        .route("/remote/ponout/", get(serve_ponout_html))
        .route("/remote/ponout.css", get(serve_ponout_css))
        .route("/remote/ponout-remote-api.js", get(serve_ponout_api_js))
        .route("/remote/ponout.js", get(serve_ponout_js))
}

// ───────── SPA shell ハンドラ ─────────

async fn serve_app_html() -> Response<String> {
    text_response(APP_HTML, "text/html; charset=utf-8")
}

async fn serve_app_js() -> Response<String> {
    text_response(APP_JS, "application/javascript; charset=utf-8")
}

async fn serve_style_css() -> Response<String> {
    text_response(STYLE_CSS, "text/css; charset=utf-8")
}

async fn serve_common_js() -> Response<String> {
    text_response(COMMON_JS, "application/javascript; charset=utf-8")
}

async fn serve_view_home_js() -> Response<String> {
    text_response(VIEW_HOME_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_comments_js() -> Response<String> {
    text_response(VIEW_COMMENTS_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_gifts_js() -> Response<String> {
    text_response(VIEW_GIFTS_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_listeners_js() -> Response<String> {
    text_response(VIEW_LISTENERS_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_listener_detail_js() -> Response<String> {
    text_response(VIEW_LISTENER_DETAIL_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_search_js() -> Response<String> {
    text_response(VIEW_SEARCH_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_archive_js() -> Response<String> {
    text_response(VIEW_ARCHIVE_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_archive_streams_js() -> Response<String> {
    text_response(VIEW_ARCHIVE_STREAMS_JS, "application/javascript; charset=utf-8")
}
async fn serve_view_archive_comment_search_js() -> Response<String> {
    text_response(
        VIEW_ARCHIVE_COMMENT_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}
async fn serve_view_archive_listener_search_js() -> Response<String> {
    text_response(
        VIEW_ARCHIVE_LISTENER_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}
async fn serve_view_stream_detail_js() -> Response<String> {
    text_response(VIEW_STREAM_DETAIL_JS, "application/javascript; charset=utf-8")
}
async fn serve_bottom_sheet_js() -> Response<String> {
    text_response(BOTTOM_SHEET_JS, "application/javascript; charset=utf-8")
}

/// `/remote/shared/{file}` の単一ハンドラ。
/// ファイル名で content-type を決め、許可リストに無いものは 404。
async fn serve_shared_asset(Path(file): Path<String>) -> Response<String> {
    let (body, ctype): (&'static str, &'static str) = match file.as_str() {
        "shared.css" => (SHARED_CSS, "text/css; charset=utf-8"),
        "comment-sanitize.js" => (SHARED_SANITIZE_JS, "application/javascript; charset=utf-8"),
        "comment-superchat.js" => (SHARED_SUPERCHAT_JS, "application/javascript; charset=utf-8"),
        "comment-item.js" => (SHARED_COMMENT_ITEM_JS, "application/javascript; charset=utf-8"),
        "undo-snackbar.js" => (SHARED_UNDO_JS, "application/javascript; charset=utf-8"),
        "listener-badges.js" => {
            (SHARED_LISTENER_BADGES_JS, "application/javascript; charset=utf-8")
        }
        _ => {
            let mut response = Response::new("Not Found".to_string());
            *response.status_mut() = StatusCode::NOT_FOUND;
            return response;
        }
    };
    text_response(body, ctype)
}

// ───────── 既存ポン出しハンドラ (= touch しない) ─────────

async fn serve_ponout_html() -> Response<String> {
    text_response(PONOUT_HTML, "text/html; charset=utf-8")
}
async fn serve_ponout_css() -> Response<String> {
    text_response(PONOUT_CSS, "text/css; charset=utf-8")
}
async fn serve_ponout_api_js() -> Response<String> {
    text_response(PONOUT_API_JS, "application/javascript; charset=utf-8")
}
async fn serve_ponout_js() -> Response<String> {
    text_response(PONOUT_JS, "application/javascript; charset=utf-8")
}

fn text_response(body: &str, content_type: &'static str) -> Response<String> {
    let mut response = Response::new(body.to_string());
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}
