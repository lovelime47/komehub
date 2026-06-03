//! napi-rs バインディング — Node.js ネイティブアドオンとしての公開インターフェース。
//!
//! axum Surface 層の代替として機能する。
//! Model Queue へのコマンド投入パターンは Surface 層と同一。
//! axum サーバーは OBS オーバーレイ配信用に引き続き起動する。

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use qrcode::render::svg;
use qrcode::QrCode;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::task::JoinHandle;

use crate::model_queue::{ModelCommand, ModelTx};
use crate::shared_memory;
use crate::surface::sse::SseBroadcaster;
use crate::surface::sse_shared::SseMessage;

// ---------------------------------------------------------------------------
// グローバル状態
// ---------------------------------------------------------------------------

struct CoreState {
    model_tx: ModelTx,
    sse_broadcaster: Arc<SseBroadcaster>,
    app_state: crate::surface::AppState,
    rt_handle: tokio::runtime::Handle,
    port: u16,
    queue_task: JoinHandle<()>,
    server_task: JoinHandle<()>,
    remote_server_task: Mutex<Option<JoinHandle<()>>>,
    remote_port: Mutex<Option<u16>>,
    sse_tasks: Mutex<Vec<JoinHandle<()>>>,
    /// graceful shutdown 通知。`shutdown_core` で `true` を送ると、
    /// `axum::serve(..).with_graceful_shutdown(..)` が drain を開始し、
    /// SSE / WS handler は stream を end する。これで listener socket が解放される。
    shutdown_tx: tokio::sync::watch::Sender<bool>,
}

static CORE: OnceLock<Mutex<Option<CoreState>>> = OnceLock::new();

fn core_cell() -> &'static Mutex<Option<CoreState>> {
    CORE.get_or_init(|| Mutex::new(None))
}

fn with_core<T>(f: impl FnOnce(&CoreState) -> T) -> Result<T> {
    let guard = core_cell()
        .lock()
        .map_err(|_| Error::from_reason("komehub-core state lock poisoned"))?;
    let core = guard
        .as_ref()
        .ok_or_else(|| Error::from_reason("komehub-core not initialized. Call init() first."))?;
    Ok(f(core))
}

// ---------------------------------------------------------------------------
// tokio ランタイム初期化
// ---------------------------------------------------------------------------

#[napi_derive::module_init]
fn module_init() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("komehub-core")
        .build()
        .expect("Failed to create tokio runtime");

    create_custom_tokio_runtime(rt);
}

// ---------------------------------------------------------------------------
// ヘルパー: oneshot 応答待ち
// ---------------------------------------------------------------------------

async fn send_and_await(
    cmd_fn: impl FnOnce(tokio::sync::oneshot::Sender<serde_json::Value>) -> ModelCommand,
) -> Result<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    with_core(|core| core.model_tx.clone())?.send(cmd_fn(tx));
    match rx.await {
        Ok(val) => Ok(val.to_string()),
        Err(_) => Ok(r#"{"error":"Queue error"}"#.to_string()),
    }
}

fn fire_and_forget(cmd: ModelCommand) -> String {
    match with_core(|core| core.model_tx.clone()) {
        Ok(model_tx) => {
            model_tx.send(cmd);
            r#"{"ok":true}"#.to_string()
        }
        Err(error) => serde_json::json!({ "error": error.to_string() }).to_string(),
    }
}

// ---------------------------------------------------------------------------
// init / shutdown / health
// ---------------------------------------------------------------------------

/// コアエンジンを初期化し、OBS 配信用 axum サーバーを起動する。
/// 戻り値: axum サーバーのポート番号。
#[napi]
pub async fn init(data_dir: String, plugins_dir: String) -> Result<u16> {
    if core_cell()
        .lock()
        .map_err(|_| Error::from_reason("komehub-core state lock poisoned"))?
        .is_some()
    {
        return Err(Error::from_reason("Already initialized"));
    }

    let data_dir = std::path::PathBuf::from(&data_dir);
    let plugins_dir = std::path::PathBuf::from(&plugins_dir);
    let hub_version = env!("CARGO_PKG_VERSION");
    let overlay_dir = plugins_dir
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| data_dir.clone());
    let app_root_dir = overlay_dir
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| data_dir.clone());
    let builtin_templates_dir = overlay_dir.join("templates");
    let user_templates_dir = data_dir.join("templates");
    let media_cache_dir = data_dir.join("media-cache");

    crate::logging::init_logging(&data_dir)
        .map_err(|err| Error::from_reason(format!("Failed to initialize core logging: {}", err)))?;
    tracing::info!("komehub-core (napi) starting");
    tracing::info!("Data directory: {:?}", data_dir);
    tracing::info!(
        "Core log file: {:?}",
        crate::logging::core_log_path(&data_dir)
    );

    // renderer process 専用ログ (= renderer.log への書き込み) を初期化。
    // app.log / core.log と別ファイル + 別 writer task で運用する設計 (= 詳細は
    // docs/logging.md)。 失敗しても core 起動は続行する (= warn ログのみ)。
    if let Err(err) = crate::renderer_logging::init_renderer_logging(
        &data_dir,
        &tokio::runtime::Handle::current(),
    ) {
        tracing::warn!("Failed to initialize renderer logging: {}", err);
    }

    let requested_port = crate::infra::config::configured_public_http_port();
    let bind_addr = crate::infra::config::configured_public_http_bind_addr();
    let listener = tokio::net::TcpListener::bind(format!("{}:{}", bind_addr, requested_port))
        .await
        .map_err(|e| {
            // EADDRINUSE は JS 側でバナー表示判定に使うので code:"EADDRINUSE" を含める
            // (= ゾンビハブが LISTEN を握っている / 他アプリと衝突 をユーザーに通知するため)
            let kind = e.kind();
            let payload = if kind == std::io::ErrorKind::AddrInUse {
                serde_json::json!({
                    "code": "EADDRINUSE",
                    "port": requested_port,
                    "bindAddr": bind_addr,
                    "message": format!("port {} is already in use", requested_port),
                })
            } else {
                serde_json::json!({
                    "code": "EBIND",
                    "port": requested_port,
                    "bindAddr": bind_addr,
                    "message": format!("failed to bind port {}: {}", requested_port, e),
                })
            };
            Error::from_reason(payload.to_string())
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| Error::from_reason(format!("Failed to read bound port: {}", e)))?
        .port();

    // 通知設定の per-event default 解決に使う overlay_dir を notification_settings に渡す。
    // (= ModelQueue::init が default_settings() を呼んで sound.file / tts.template を埋める
    //   タイミングまでに set しておく必要がある。)
    crate::notification_settings::set_overlay_dir(overlay_dir.clone());

    // Store/Session 初期化
    let main_store = crate::state::MainStore::new();
    let main_session = crate::state::MainSession::new();

    // Model Queue 起動
    let (model_tx, model_queue) = crate::model_queue::ModelQueue::new(
        main_store,
        main_session,
        &data_dir,
        &plugins_dir,
        hub_version,
        port,
    );

    // SSE broadcaster
    let sse_broadcaster = Arc::new(SseBroadcaster::new());

    // graceful shutdown signal
    // shutdown_tx を保持: shutdown_core() で `true` を送ると、axum / SSE / WS が drain を開始する。
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // axum Router 構築（OBS オーバーレイ配信 + SSE 用）
    let boot_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let app_state = crate::surface::AppState {
        model_tx: model_tx.clone(),
        sse_broadcaster: sse_broadcaster.clone(),
        data_dir: data_dir.clone(),
        media_cache_dir,
        app_root_dir,
        builtin_templates_dir,
        user_templates_dir,
        overlay_dir,
        hub_version: hub_version.to_string(),
        boot_id,
        shutdown_signal: shutdown_rx.clone(),
    };
    let router = crate::surface::build_router(app_state.clone());

    // Model Queue をバックグラウンドタスクとして起動
    let sse_for_queue = sse_broadcaster.clone();
    let queue_task = tokio::spawn(async move {
        model_queue.run(sse_for_queue).await;
    });

    tracing::info!("komehub-core (napi) listening on port {}", port);

    let mut server_shutdown_rx = shutdown_rx.clone();
    let server_task = tokio::spawn(async move {
        let service = router.into_make_service_with_connect_info::<std::net::SocketAddr>();
        let server = axum::serve(listener, service)
            .with_graceful_shutdown(async move {
                // false → true に変わるまで待つ。watch::Receiver::changed() は
                // sender が drop されても返るので、shutdown_tx が落ちた場合も終了する。
                let _ = server_shutdown_rx.changed().await;
            });
        if let Err(e) = server.await {
            tracing::error!("axum server error: {}", e);
        }
    });

    // グローバル状態を登録
    let rt_handle = tokio::runtime::Handle::current();
    let mut guard = core_cell()
        .lock()
        .map_err(|_| Error::from_reason("komehub-core state lock poisoned"))?;
    if guard.is_some() {
        return Err(Error::from_reason("Already initialized"));
    }
    *guard = Some(CoreState {
        model_tx,
        sse_broadcaster,
        app_state,
        rt_handle,
        port,
        queue_task,
        server_task,
        remote_server_task: Mutex::new(None),
        remote_port: Mutex::new(None),
        sse_tasks: Mutex::new(Vec::new()),
        shutdown_tx,
    });

    Ok(port)
}

#[napi(js_name = "shutdownCore")]
pub async fn shutdown_core() -> Result<bool> {
    let core = {
        let mut guard = core_cell()
            .lock()
            .map_err(|_| Error::from_reason("komehub-core state lock poisoned"))?;
        guard
            .take()
            .ok_or_else(|| Error::from_reason("komehub-core not initialized. Call init() first."))?
    };

    tracing::info!("komehub-core (napi) shutting down");

    core.model_tx.send(ModelCommand::Shutdown);

    // 1. shutdown signal を全 SSE / WS / axum::serve へ broadcast
    //    SSE/WS handler は stream を end し、axum::serve(.with_graceful_shutdown(..))
    //    は新規接続受付停止 + 既存接続の drain を開始する。
    let _ = core.shutdown_tx.send(true);

    let remote_handle = core
        .remote_server_task
        .lock()
        .ok()
        .and_then(|mut remote_server_task| remote_server_task.take());

    if let Ok(mut sse_tasks) = core.sse_tasks.lock() {
        for handle in sse_tasks.drain(..) {
            handle.abort();
        }
    }

    let _ = core.queue_task.await;

    // 2. 各 server_task が graceful drain で自然終了するのを待つ。
    //    SHUTDOWN_GRACE_MS 以内に終わらなければ force abort で listener を強制解放する。
    //    (= SSE handler が shutdown_signal を見落としているバグや、
    //       OBS 等の client が close を遅延させているケースの保険。
    //       listener socket だけは最低限解放されるようにする)
    const SHUTDOWN_GRACE_MS: u64 = 1500;
    let main_abort = core.server_task.abort_handle();
    match tokio::time::timeout(
        std::time::Duration::from_millis(SHUTDOWN_GRACE_MS),
        core.server_task,
    )
    .await
    {
        Ok(Ok(())) => tracing::info!("axum main server shut down gracefully"),
        Ok(Err(join_err)) => tracing::warn!("axum main server task error: {}", join_err),
        Err(_) => {
            tracing::warn!(
                "axum main server graceful shutdown timed out ({}ms), aborting listener",
                SHUTDOWN_GRACE_MS
            );
            main_abort.abort();
        }
    }

    if let Some(handle) = remote_handle {
        let abort = handle.abort_handle();
        match tokio::time::timeout(
            std::time::Duration::from_millis(SHUTDOWN_GRACE_MS),
            handle,
        )
        .await
        {
            Ok(Ok(())) => tracing::info!("axum remote server shut down gracefully"),
            Ok(Err(join_err)) => tracing::warn!("axum remote server task error: {}", join_err),
            Err(_) => {
                tracing::warn!(
                    "axum remote server graceful shutdown timed out ({}ms), aborting listener",
                    SHUTDOWN_GRACE_MS
                );
                abort.abort();
            }
        }
    }

    // OS のファイルハンドル解放を待つ短い遅延 (Windows で SQLite WAL/SHM ファイルが
    // ロックされたまま残るのを回避)。queue_task 完了で Engines の Drop は呼ばれているが、
    // OS が即座にハンドルをリリースしない場合があるため。
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    tracing::info!("komehub-core (napi) shutdown complete");
    Ok(true)
}

#[napi]
pub fn health() -> String {
    serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

#[napi]
pub fn get_port() -> u16 {
    with_core(|core| core.port).unwrap_or(0)
}

/// デモモード専用: `<data_dir>/data/listeners.db` に架空 VTuber「雫宮ねむ」の
/// デモデータを投入する。`--demo` 起動時に **core init より前** に呼ばれる前提
/// (= 別データ dir なので本番データは汚さない)。`seed_json` は `demo/demo-seed.json`
/// の中身そのもの。
#[napi(js_name = "seedDemoData")]
pub fn seed_demo_data(data_dir: String, seed_json: String) -> Result<()> {
    crate::engine::demo_seed::seed(&data_dir, &seed_json)
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi(js_name = "startPonoutRemote")]
pub async fn start_ponout_remote(host: String) -> Result<String> {
    let port = ensure_remote_server_running().await?;
    let url = remote_url(&host, port, "/remote/ponout/");
    remote_ponout_info_json(port, &url)
}

/// LAN リモート閲覧 (= スマホで `/remote/` を開く) 用の起動 + QR.
/// インフラ (TCP listener / router) は ponout と完全共有。URL の path だけ違う。
#[napi(js_name = "startListenerRemote")]
pub async fn start_listener_remote(host: String) -> Result<String> {
    let port = ensure_remote_server_running().await?;
    let url = remote_url(&host, port, "/remote/");
    remote_ponout_info_json(port, &url)
}

/// LAN リモート専用 HTTP サーバ (= 11281 / fallback 任意) を一度だけ起動し、port を返す。
/// 既に起動済みの場合は既存 port を返すだけ (= 冪等)。ponout / listener 双方の `start_*_remote` から呼ぶ。
async fn ensure_remote_server_running() -> Result<u16> {
    let existing = with_core(|core| core.remote_port.lock().ok().and_then(|guard| *guard))?;
    if let Some(port) = existing {
        return Ok(port);
    }

    let app_state = with_core(|core| core.app_state.clone())?;
    let listener = match tokio::net::TcpListener::bind("0.0.0.0:11281").await {
        Ok(listener) => listener,
        Err(_) => tokio::net::TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| Error::from_reason(format!("Failed to bind remote ponout port: {}", e)))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| Error::from_reason(format!("Failed to read remote ponout port: {}", e)))?
        .port();
    // remote 側も main と同じ shutdown signal を観測 (= AppState 経由で共有済み)
    let mut remote_shutdown_rx = app_state.shutdown_signal.clone();
    let router = crate::surface::build_remote_ponout_router(app_state);
    let server_task = tokio::spawn(async move {
        let service = router.into_make_service_with_connect_info::<std::net::SocketAddr>();
        let server = axum::serve(listener, service)
            .with_graceful_shutdown(async move {
                let _ = remote_shutdown_rx.changed().await;
            });
        if let Err(e) = server.await {
            tracing::error!("remote ponout server error: {}", e);
        }
    });

    with_core(|core| {
        if let Ok(mut remote_port) = core.remote_port.lock() {
            *remote_port = Some(port);
        }
        if let Ok(mut remote_server_task) = core.remote_server_task.lock() {
            if let Some(handle) = remote_server_task.replace(server_task) {
                handle.abort();
            }
        }
    })?;

    tracing::info!("remote server listening on port {}", port);
    Ok(port)
}

fn remote_url(host: &str, port: u16, path: &str) -> String {
    let host = host.trim();
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    format!("http://{}:{}{}", host, port, path)
}

fn remote_ponout_info_json(port: u16, url: &str) -> Result<String> {
    let code = QrCode::new(url.as_bytes())
        .map_err(|e| Error::from_reason(format!("Failed to build remote QR code: {}", e)))?;
    let qr_svg = code
        .render::<svg::Color>()
        .min_dimensions(280, 280)
        .dark_color(svg::Color("#0f172a"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Ok(serde_json::json!({
        "ok": true,
        "port": port,
        "url": url,
        "qrSvg": qr_svg
    })
    .to_string())
}

#[napi]
pub fn get_public_client_count() -> u32 {
    with_core(|core| core.sse_broadcaster.public_client_count() as u32).unwrap_or(0)
}

#[napi]
pub async fn ensure_template_fonts(
    fonts_json: String,
    progress_callback: ThreadsafeFunction<String>,
) -> Result<String> {
    let fonts: Vec<String> = serde_json::from_str(&fonts_json)
        .map_err(|error| Error::from_reason(format!("Invalid fonts JSON: {}", error)))?;
    send_and_await(|reply| ModelCommand::EnsureTemplateFonts {
        fonts,
        progress_callback,
        reply,
    })
    .await
}

#[napi]
pub async fn cache_comment_images(comments_json: String) -> Result<String> {
    send_and_await(|reply| ModelCommand::CacheCommentImages {
        comments_json,
        reply,
    })
    .await
}

/// 配信サムネを media-cache に DL → ローカル URL を返す。
/// 既存ヒット (= 既に DL 済み) なら即時 return。
/// 戻り: `{ ok, localUrl, hit, fileName }` の JSON 文字列。
#[napi]
pub async fn cache_stream_thumbnail(video_id: String) -> Result<String> {
    let (media_cache_dir, port) =
        with_core(|core| (core.app_state.media_cache_dir.clone(), core.port))?;
    match crate::image_cache::cache_stream_thumbnail(&media_cache_dir, port, &video_id).await {
        Ok(result) => Ok(serde_json::json!({
            "ok": true,
            "localUrl": result.local_url,
            "hit": result.hit,
            "fileName": result.file_name,
        })
        .to_string()),
        Err(error) => Ok(serde_json::json!({ "ok": false, "error": error }).to_string()),
    }
}

#[napi]
pub fn broadcast_reload() -> Result<String> {
    with_core(|core| core.sse_broadcaster.push_reload())?;
    Ok(serde_json::json!({ "ok": true }).to_string())
}

#[napi]
pub fn get_shared_buffer_layout(name: String) -> String {
    match shared_memory::get_layout(&name) {
        Some(layout) => serde_json::to_string(&layout).unwrap_or_else(|_| {
            r#"{"error":"Failed to serialize shared buffer layout"}"#.to_string()
        }),
        None => {
            serde_json::json!({ "error": format!("Unknown shared buffer: {}", name) }).to_string()
        }
    }
}

#[napi]
pub fn register_shared_buffer(name: String, buffer: Buffer) -> String {
    match shared_memory::register_buffer(&name, buffer) {
        Ok(()) => serde_json::json!({ "ok": true }).to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[napi]
pub fn read_reaction_counts_snapshot() -> String {
    match shared_memory::read_reaction_counts_snapshot() {
        Ok(snapshot) => snapshot.to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[napi]
pub fn read_performance_log_snapshot(cursor: u32) -> String {
    match shared_memory::read_performance_log_snapshot(cursor) {
        Ok(snapshot) => snapshot.to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[napi]
pub fn read_comment_timeline_snapshot(cursor: u32) -> String {
    match shared_memory::read_comment_timeline_snapshot(cursor) {
        Ok(snapshot) => snapshot.to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[napi]
pub fn read_connection_state_snapshot() -> String {
    match shared_memory::read_connection_state_snapshot() {
        Ok(snapshot) => snapshot.to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[napi]
pub fn read_performance_engine_state_snapshot() -> String {
    match shared_memory::read_performance_engine_state_snapshot() {
        Ok(snapshot) => snapshot.to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

// ---------------------------------------------------------------------------
// SSE コールバック登録
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
enum RuntimeEvent {
    #[serde(rename = "static")]
    Static {
        path: String,
        data: serde_json::Value,
    },
    #[serde(rename = "session-comment")]
    SessionComment { data: serde_json::Value },
    #[serde(rename = "session-reaction")]
    SessionReaction { data: serde_json::Value },
    #[serde(rename = "comment-deleted")]
    CommentDeleted { data: serde_json::Value },
    #[serde(rename = "tts-state")]
    TtsState { data: serde_json::Value },
}

fn merge_comment_entry_with_authoritative(
    entry: &serde_json::Value,
    authoritative: &serde_json::Value,
) -> serde_json::Value {
    let mut merged = authoritative.as_object().cloned().unwrap_or_default();
    if let Some(entry_object) = entry.as_object() {
        for (key, value) in entry_object {
            if key != "cursor" {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    serde_json::Value::Object(merged)
}

fn runtime_events_from_sse(message: SseMessage, comment_cursor: &mut u32) -> Vec<RuntimeEvent> {
    match message {
        SseMessage::Performance { .. } => Vec::new(),
        SseMessage::StaticUpdate { path, data } => {
            if path == "connection" {
                // ConnectionState は shared_memory layout が struct と完全同期しているため、
                // snapshot 経由読み直しで派生値 (= isOwnStream) も含めて取れる
                // (state/connection.rs の struct doc 参照)。SSE message data は使わない。
                match shared_memory::read_connection_state_snapshot() {
                    Ok(snapshot) => vec![RuntimeEvent::Static {
                        path,
                        data: snapshot
                            .get("data")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    }],
                    Err(_) => {
                        tracing::error!(
                            "connection shared-memory read failed during runtime dispatch"
                        );
                        Vec::new()
                    }
                }
            } else if path == "performanceEngineState" {
                match shared_memory::read_performance_engine_state_snapshot() {
                    Ok(snapshot) => vec![RuntimeEvent::Static {
                        path,
                        data: snapshot
                            .get("data")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    }],
                    Err(_) => {
                        tracing::error!("performanceEngineState shared-memory read failed during runtime dispatch");
                        Vec::new()
                    }
                }
            } else {
                vec![RuntimeEvent::Static { path, data }]
            }
        }
        SseMessage::SessionComment { data, .. } => {
            let Ok(snapshot) = shared_memory::read_comment_timeline_snapshot(*comment_cursor)
            else {
                tracing::error!(
                    "commentTimeline shared-memory read failed during runtime dispatch"
                );
                return Vec::new();
            };
            let Some(entries) = snapshot.get("entries").and_then(|value| value.as_array()) else {
                return Vec::new();
            };
            let last_index = entries.len().saturating_sub(1);
            let mut events = Vec::with_capacity(entries.len());
            for (index, entry) in entries.iter().enumerate() {
                let Some(entry_object) = entry.as_object() else {
                    continue;
                };
                if let Some(cursor) = entry_object.get("cursor").and_then(|value| value.as_u64()) {
                    *comment_cursor = cursor as u32;
                }
                let merged = if index == last_index {
                    merge_comment_entry_with_authoritative(entry, &data)
                } else {
                    merge_comment_entry_with_authoritative(entry, &serde_json::Value::Null)
                };
                events.push(RuntimeEvent::SessionComment { data: merged });
            }
            events
        }
        SseMessage::SessionReaction { .. } => {
            match shared_memory::read_reaction_counts_snapshot() {
                Ok(snapshot) => vec![RuntimeEvent::SessionReaction { data: snapshot }],
                Err(_) => {
                    tracing::error!(
                        "reactionCounts shared-memory read failed during runtime dispatch"
                    );
                    Vec::new()
                }
            }
        }
        SseMessage::CommentDeleted { data } => vec![RuntimeEvent::CommentDeleted { data }],
        SseMessage::TtsState { data } => vec![RuntimeEvent::TtsState { data }],
        SseMessage::Reload
        | SseMessage::PerformanceClear { .. }
        | SseMessage::TemplateComment { .. }
        | SseMessage::TemplateConfig { .. } => Vec::new(),
    }
}

/// Electron から「未知 video_id の owner を Cookie 共有 HTTP fetch で解決する callback」 を登録する。
///
/// 型: `(videoIds: string[]) => Promise<{videoId, ownerChannelId, channelName?, title?}[]>`
///
/// `import_from_onecomme` (= わんコメ書き戻し DB 取り込み) 中に streams に未登録の video_id が
/// 出てきたとき、 spawn_blocking 内から この callback を同期呼び出しして owner を取得する。
/// 詳細は `crate::engine::video_owner_resolver` のドキュメント参照。
#[napi(
    ts_args_type = "callback: (videoIds: string[]) => Promise<{videoId: string, ownerChannelId: string, channelName?: string, title?: string}[]>"
)]
pub fn register_video_owner_resolver(
    callback: crate::engine::video_owner_resolver::ResolverCallback,
) -> Result<()> {
    crate::engine::video_owner_resolver::set_resolver(callback);
    Ok(())
}

/// わんコメ書き戻し import の進捗通知用 callback を登録する。
/// JS には `phase / current / total / message` を含む JSON 文字列が渡される。
/// 詳細は `crate::engine::import_progress_reporter` のドキュメント参照。
#[napi]
pub fn register_import_progress_reporter(callback: ThreadsafeFunction<String>) -> Result<()> {
    crate::engine::import_progress_reporter::set_reporter(callback);
    Ok(())
}

/// わんコメ書き戻し export の進捗通知用 callback を登録する。
/// JS には `phase / current / total / message / overallPercent` を含む JSON 文字列が渡される。
/// 詳細は `crate::engine::export_progress_reporter` のドキュメント参照。
#[napi]
pub fn register_export_progress_reporter(callback: ThreadsafeFunction<String>) -> Result<()> {
    crate::engine::export_progress_reporter::set_reporter(callback);
    Ok(())
}

#[napi]
pub fn subscribe_runtime_events(callback: ThreadsafeFunction<String>) -> Result<()> {
    let broadcaster = with_core(|core| core.sse_broadcaster.clone())?;
    let rt_handle = with_core(|core| core.rt_handle.clone())?;
    let rx = broadcaster.subscribe();

    let handle = rt_handle.spawn(async move {
        let mut comment_cursor = 0u32;
        let mut stream = tokio_stream::wrappers::BroadcastStream::new(rx);
        use tokio_stream::StreamExt;
        // Lagged 耐性: 受信者遅延で broadcast channel が overflow しても subscriber を
        // 死なせず、 drop された件数を warn ログに記録して継続する。 旧実装
        // (= while let Some(Ok(data))) は Lagged で Err パターンに不一致 → loop exit
        // → 以降の runtime event が一切 JS に届かない致命バグだった。
        // HTTP SSE 経路 (= surface/sse.rs) と同じ Lagged 受容方針に揃える。
        while let Some(result) = stream.next().await {
            let data = match result {
                Ok(data) => data,
                Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                    tracing::warn!(
                        "subscribe_runtime_events: broadcast lagged, dropped {} messages (renderer may have stuttered)",
                        n
                    );
                    continue;
                }
            };
            let Ok(message) = serde_json::from_str::<SseMessage>(&data) else {
                continue;
            };
            for event in runtime_events_from_sse(message, &mut comment_cursor) {
                let Ok(json) = serde_json::to_string(&event) else {
                    continue;
                };
                if callback.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking)
                    != napi::Status::Ok
                {
                    return;
                }
            }
        }
    });
    with_core(|core| {
        if let Ok(mut tasks) = core.sse_tasks.lock() {
            tasks.push(handle);
        }
    })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// CommentSurface
// ---------------------------------------------------------------------------

#[napi]
pub fn push_comments(comments_json: String) -> String {
    fire_and_forget(ModelCommand::IncomingCommentsJson { comments_json })
}

#[napi]
pub fn push_innertube_actions(actions_json: String) -> String {
    fire_and_forget(ModelCommand::IncomingInnertubeActions { actions_json })
}

#[napi]
pub fn push_comment_deleted(ids_json: String) -> String {
    let ids: Vec<String> = serde_json::from_str(&ids_json).unwrap_or_default();
    fire_and_forget(ModelCommand::CommentDeleted { comment_ids: ids })
}

#[napi]
pub fn push_reaction(reaction_json: String) -> String {
    match serde_json::from_str(&reaction_json) {
        Ok(reaction) => fire_and_forget(ModelCommand::IncomingReaction { reaction }),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    }
}

#[napi]
pub fn push_connection_state(connected: bool, video_id: Option<String>) -> String {
    fire_and_forget(ModelCommand::ConnectionStateChanged {
        connected,
        video_id,
    })
}

#[napi]
pub fn announce_stream_owner(video_id: String, owner_channel_id: String) -> String {
    fire_and_forget(ModelCommand::AnnounceStreamOwner {
        video_id,
        owner_channel_id,
    })
}

// ---------------------------------------------------------------------------
// Step 3 リスナー管理 (フェーズ 3.2a)
// ---------------------------------------------------------------------------

/// napi 用 owner_channel 入力 (channel_id + handle?)。
#[napi(object)]
pub struct OwnerChannelInput {
    pub channel_id: String,
    pub handle: Option<String>,
}

/// 自チャンネル設定一覧を取得 (channel_id + handle?)。複数 = サブチャンネル等。
#[napi]
pub async fn get_owner_channels() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetOwnerChannels { reply: tx }).await
}

/// 自チャンネル設定一覧を一括上書き保存。空配列で全クリア。
#[napi]
pub async fn set_owner_channels(channels: Vec<OwnerChannelInput>) -> Result<String> {
    let parsed: Vec<crate::state::listener::OwnerChannel> = channels
        .into_iter()
        .map(|c| crate::state::listener::OwnerChannel {
            channel_id: c.channel_id,
            handle: c.handle,
        })
        .collect();
    send_and_await(|tx| ModelCommand::SetOwnerChannels {
        channels: parsed,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn list_listeners(query_json: String) -> Result<String> {
    let query: crate::state::listener::ListenersQuery =
        serde_json::from_str(&query_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::GetListeners { query, reply: tx }).await
}

#[napi]
pub async fn get_listener_detail(
    channel_id: String,
    recent_comment_limit: u32,
    stream_video_id: Option<String>,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetListenerDetail {
        channel_id,
        recent_comment_limit: recent_comment_limit as usize,
        stream_video_id,
        reply: tx,
    })
    .await
}

/// リスナー一覧 UI の heatmap 用 (直近 N 日 daily activity) を一括取得。
/// query_json は `{ "channelIds": ["yt-UC..."], "days": 14 }`。
#[napi]
pub async fn list_listeners_activity(query_json: String) -> Result<String> {
    let query: crate::state::listener::ListenersActivityQuery =
        serde_json::from_str(&query_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::GetListenersActivity { query, reply: tx }).await
}

/// 配信メタデータ (タイトル / チャンネル名 / 同時接続数 等) の部分更新。
/// 静的・動的フィールドを 1 コマンドで扱う。null は触らない (既存値維持)。
/// `live_metadata_updated_at` を Some(現在 ms) にすれば動的更新の最終時刻が記録される。
/// 戻り値: `{"ok": true, "updated": n}` 形式の JSON 文字列。
#[napi]
#[allow(clippy::too_many_arguments)]
pub async fn update_stream_metadata(
    video_id: String,
    stream_url: Option<String>,
    title: Option<String>,
    owner_channel_id: Option<String>,
    channel_name: Option<String>,
    channel_icon_url: Option<String>,
    description: Option<String>,
    subscriber_count: Option<i64>,
    current_viewers: Option<i64>,
    peak_concurrent_viewers: Option<i64>,
    likes: Option<i64>,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    live_metadata_updated_at: Option<i64>,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::UpdateStreamMetadata {
        video_id,
        stream_url,
        title,
        owner_channel_id,
        channel_name,
        channel_icon_url,
        description,
        subscriber_count,
        current_viewers,
        peak_concurrent_viewers,
        likes,
        started_at,
        ended_at,
        live_metadata_updated_at,
        reply: tx,
    })
    .await
}

/// nickname / notes / label の部分更新。null は触らず、空文字 "" は明示クリア。
#[napi]
pub async fn update_listener_metadata(
    channel_id: String,
    nickname: Option<String>,
    notes: Option<String>,
    label: Option<String>,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::UpdateListenerMetadata {
        channel_id,
        nickname,
        notes,
        label,
        reply: tx,
    })
    .await
}

/// リモート閲覧 redesign §3.1 / §4.1: 配信枠 × リスナーの「挨拶済み」トグル。
/// per-stream リセットなので stream_video_id と一緒に渡す。
#[napi]
pub async fn set_listener_greeted(
    stream_video_id: String,
    listener_channel_id: String,
    value: bool,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetListenerGreeted {
        stream_video_id,
        listener_channel_id,
        value,
        reply: tx,
    })
    .await
}

/// リモート閲覧 redesign §3.2 / §4.1: コメント単位の「対応済み」トグル。
#[napi]
pub async fn set_comment_responded(comment_id: String, value: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetCommentResponded {
        comment_id,
        value,
        reply: tx,
    })
    .await
}

/// 2026-05-09 仕様変更: リスナー単位の「コメ非表示 / リスナー非表示」2 軸独立トグル。
/// 演出フィルタは撤廃 (= UI 表示抑制のみ)。両方 false なら record 削除。
#[napi]
pub async fn set_listener_hidden(
    listener_channel_id: String,
    hide_from_comments: bool,
    hide_from_listeners: bool,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetListenerHidden {
        listener_channel_id,
        hide_from_comments,
        hide_from_listeners,
        reply: tx,
    })
    .await
}

/// 指定リスナー (複数可) を listeners 行 + アバター画像ファイルだけ削除する。
/// **コメントは残す** (= 配信履歴として永続化)、streams 集計値も触らない。
/// 同 channel_id のリスナーが再登場したら過去コメントが自動で再紐付け。
/// わんコメ DB は触らない。
#[napi]
pub async fn delete_listeners(channel_ids: Vec<String>) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteListeners {
        channel_ids,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn list_streams(query_json: String) -> Result<String> {
    let query: crate::state::listener::StreamsQuery =
        serde_json::from_str(&query_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::GetStreams { query, reply: tx }).await
}

#[napi]
pub async fn delete_streams(video_ids: Vec<String>) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteStreams {
        video_ids,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_stream_detail(video_id: String, recent_comment_limit: u32) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetStreamDetail {
        video_id,
        recent_comment_limit: recent_comment_limit as usize,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn search_comments(query_json: String) -> Result<String> {
    let query: crate::state::listener::CommentsQuery =
        serde_json::from_str(&query_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::SearchComments { query, reply: tx }).await
}

#[napi]
pub async fn list_stream_listeners(video_id: String, query_json: String) -> Result<String> {
    let query: crate::state::listener::StreamListenersQuery =
        serde_json::from_str(&query_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::ListStreamListeners {
        video_id,
        query,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_stream_stats(video_id: String, bin_minutes: i32) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetStreamStats {
        video_id,
        bin_minutes: bin_minutes as i64,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_comment_chip_counts(video_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetCommentChipCounts {
        video_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_listener_chip_counts(
    channel_id: String,
    context_video_id: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetListenerChipCounts {
        channel_id,
        context_video_id,
        reply: tx,
    })
    .await
}

/// リスナー詳細モーダル「SC のみ」chip 用: 全期間 SC コメ取得。
#[napi]
pub async fn list_listener_superchats(channel_id: String, limit: u32) -> Result<String> {
    send_and_await(|tx| ModelCommand::ListListenerSuperchats {
        channel_id,
        limit: limit as usize,
        reply: tx,
    })
    .await
}

/// リスナー詳細モーダル「この枠」chip 用: 指定 stream_video_id でのコメを全件取得。
#[napi]
pub async fn list_listener_comments_in_stream(
    channel_id: String,
    stream_video_id: String,
    limit: u32,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::ListListenerCommentsInStream {
        channel_id,
        stream_video_id,
        limit: limit as usize,
        reply: tx,
    })
    .await
}

/// 設定画面「リスナー判定」ライブプレビュー用: baseline 基準で 6 ランクの件数を取得。
#[napi]
pub async fn get_listener_search_rank_counts(baseline_video_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetListenerSearchRankCounts {
        baseline_video_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_stream_scoped_listener_counts(
    stream_video_id: String,
    q: Option<String>,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetStreamScopedListenerCounts {
        stream_video_id,
        q,
        reply: tx,
    })
    .await
}

/// 配信詳細モーダルのリスナータブ system pill 件数。
/// query_json は `{ "nameQ"?, "bodyQ"?, "textQ"?, "userTags"?: string[] }` 形式。
/// textQ が指定されている場合は nameQ / bodyQ を無視 (= name OR body の横断検索)。
#[napi]
pub async fn get_stream_listener_pill_counts(
    video_id: String,
    query_json: String,
) -> Result<String> {
    let q: crate::state::listener::StreamListenerPillCountsQuery =
        serde_json::from_str(&query_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::GetStreamListenerPillCounts {
        video_id,
        name_q: q.name_q,
        body_q: q.body_q,
        text_q: q.text_q,
        user_tags: q.user_tags,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_listener_tags(channel_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetListenerTags {
        channel_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_listener_tags(channel_id: String, tags_json: String) -> Result<String> {
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::SetListenerTags {
        channel_id,
        tags,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn list_all_listener_tags() -> Result<String> {
    send_and_await(|tx| ModelCommand::ListAllListenerTags { reply: tx }).await
}

#[napi]
pub async fn list_all_listener_tag_assignments() -> Result<String> {
    send_and_await(|tx| ModelCommand::ListAllListenerTagAssignments { reply: tx }).await
}

#[napi]
pub async fn get_stream_tags(video_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetStreamTags {
        video_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_stream_tags(video_id: String, tags_json: String) -> Result<String> {
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::SetStreamTags {
        video_id,
        tags,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn list_all_stream_tags() -> Result<String> {
    send_and_await(|tx| ModelCommand::ListAllStreamTags { reply: tx }).await
}

#[napi]
pub async fn list_all_stream_tag_assignments() -> Result<String> {
    send_and_await(|tx| ModelCommand::ListAllStreamTagAssignments { reply: tx }).await
}

#[napi]
pub async fn rename_stream_tag(old_name: String, new_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RenameStreamTag {
        old_name,
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn delete_stream_tag(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteStreamTag { name, reply: tx }).await
}

#[napi]
pub async fn rename_listener_tag(old_name: String, new_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RenameListenerTag {
        old_name,
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn delete_listener_tag(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteListenerTag { name, reply: tx }).await
}

#[napi]
pub async fn list_saved_searches(scope: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ListSavedSearches { scope, reply: tx }).await
}

#[napi]
pub async fn create_saved_search(
    scope: String,
    name: String,
    conditions_json: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::CreateSavedSearch {
        scope,
        name,
        conditions_json,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn update_saved_search(
    id: i32,
    name: Option<String>,
    conditions_json: Option<String>,
    sort_order: Option<i32>,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::UpdateSavedSearch {
        id: id as i64,
        name,
        conditions_json,
        sort_order: sort_order.map(|v| v as i64),
        reply: tx,
    })
    .await
}

#[napi]
pub async fn delete_saved_search(id: i32) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteSavedSearch {
        id: id as i64,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn export_komehub_jsonl(out_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ExportKomehubJsonl {
        out_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn import_komehub_jsonl(src_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportKomehubJsonl {
        src_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn import_from_onecomme(onecomme_dir: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportFromOnecomme {
        onecomme_dir,
        reply: tx,
    })
    .await
}

/// 空 title/channel_name の自チャ過去 stream を Electron resolver で後追い補完する
/// (= 起動時 backfill)。fire-and-forget。registerVideoOwnerResolver 後に呼ぶこと。
#[napi]
pub fn backfill_stream_meta() -> String {
    fire_and_forget(ModelCommand::BackfillStreamMeta)
}

#[napi]
pub async fn export_to_onecomme(onecomme_dir: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ExportToOnecomme {
        onecomme_dir,
        reply: tx,
    })
    .await
}

/// listeners.db にわんコメ書き戻し対象のデータ変更があるかを問い合わせる
/// (= JS close ハンドラの shutdown export skip 判定用)。
/// 戻り値 JSON: `{ "ok": true, "dirty": bool }`
#[napi]
pub async fn is_listener_db_dirty() -> Result<String> {
    send_and_await(|tx| ModelCommand::IsListenerDbDirty { reply: tx }).await
}

#[napi]
pub async fn detect_onecomme_running() -> Result<String> {
    send_and_await(|tx| ModelCommand::DetectOnecommeRunning { reply: tx }).await
}

#[napi]
pub async fn reset_onecomme_watermarks(onecomme_dir: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ResetOnecommeWatermarks {
        onecomme_dir,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn run_bidirectional_sync(onecomme_dir: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RunBidirectionalSync {
        onecomme_dir,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// PerformanceSurface
// ---------------------------------------------------------------------------

#[napi]
pub fn trigger_performance(scene_id: String, performance_id: String) -> String {
    fire_and_forget(ModelCommand::TriggerPerformance {
        scene_id,
        performance_id,
    })
}

#[napi]
pub async fn trigger_test(scene_id: String, performance_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::TriggerTest {
        scene_id,
        performance_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn trigger_test_with_context(
    scene_id: String,
    performance_id: String,
    context_json: String,
) -> Result<String> {
    let context: serde_json::Value = serde_json::from_str(&context_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::TriggerTestWithContext {
        scene_id,
        performance_id,
        context,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn trigger_test_reaction(scene_id: String, performance_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::TriggerTestReaction {
        scene_id,
        performance_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn trigger_test_reaction_custom(
    scene_id: String,
    performance_id: String,
    reaction_key: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::TriggerTestReactionCustom {
        scene_id,
        performance_id,
        reaction_key,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn send_template_test_comment(scene_id: String, context_json: String) -> Result<String> {
    let context: serde_json::Value = serde_json::from_str(&context_json)
        .map_err(|e| Error::from_reason(format!("Invalid context JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::SendTemplateTestComment {
        scene_id,
        context,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_paused(paused: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetPaused {
        paused,
        reply: Some(tx),
    })
    .await
}

#[napi]
pub async fn get_paused() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetPaused { reply: tx }).await
}

#[napi]
pub async fn clear_performances(scene_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ClearPerformances {
        scene_id,
        reply: tx,
    })
    .await
}

// 2026-05-09 仕様変更: 旧 update/get/set_banned_users (= 演出フィルタ向け) を hidden_listeners に rename。
// 旧 update_banned_users (= performance engine からの fire-and-forget) は撤廃 (= 演出フィルタ廃止)。

#[napi]
pub async fn get_hidden_listeners() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetHiddenListeners { reply: tx }).await
}

#[napi]
pub async fn set_hidden_listeners(users_json: String) -> Result<String> {
    let users: Vec<crate::model_queue::HiddenListenerRecord> =
        serde_json::from_str(&users_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::SetHiddenListeners { users, reply: tx }).await
}

#[napi]
pub async fn get_global_cooldown() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetGlobalCooldown { reply: tx }).await
}

#[napi]
pub fn update_global_cooldown(max_effects: u32, user_interval: f64) -> String {
    fire_and_forget(ModelCommand::UpdateGlobalCooldown {
        max_effects: max_effects as usize,
        user_interval,
    })
}

#[napi]
pub async fn get_membership_gift_pricing() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetMembershipGiftPricing { reply: tx }).await
}

#[napi]
pub async fn set_membership_gift_pricing(settings_json: String) -> Result<String> {
    let settings: serde_json::Value =
        serde_json::from_str(&settings_json).unwrap_or_else(|_| serde_json::json!({}));
    send_and_await(|tx| ModelCommand::SetMembershipGiftPricing {
        settings,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_listener_classification_config() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetListenerClassificationConfig { reply: tx }).await
}

#[napi]
pub async fn set_listener_classification_config(
    regular_stream_window: u32,
    regular_min_streams: u32,
    newcomer_first_seen_days: u32,
    veteran_first_seen_days: u32,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::UpdateListenerClassificationConfig {
        regular_stream_window: regular_stream_window as usize,
        regular_min_streams: regular_min_streams as usize,
        newcomer_first_seen_days,
        veteran_first_seen_days,
        reply: Some(tx),
    })
    .await
}

#[napi]
pub async fn get_tts_settings() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetTtsSettings { reply: tx }).await
}

#[napi]
pub async fn set_tts_settings(settings_json: String) -> Result<String> {
    let settings: serde_json::Value =
        serde_json::from_str(&settings_json).unwrap_or_else(|_| serde_json::json!({}));
    send_and_await(|tx| ModelCommand::SetTtsSettings {
        settings,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_tts_state() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetTtsState { reply: tx }).await
}

#[napi]
pub async fn set_tts_enabled(enabled: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetTtsEnabled { enabled, reply: tx }).await
}

#[napi]
pub async fn set_tts_paused(paused: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetTtsPaused { paused, reply: tx }).await
}

#[napi]
pub async fn clear_tts() -> Result<String> {
    send_and_await(|tx| ModelCommand::ClearTts { reply: tx }).await
}

// --- Notification IPC (Phase C) ---

#[napi]
pub async fn get_notification_settings() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetNotificationSettings { reply: tx }).await
}

#[napi]
pub async fn set_notification_settings(settings_json: String) -> Result<String> {
    let settings: serde_json::Value =
        serde_json::from_str(&settings_json).unwrap_or_else(|_| serde_json::json!({}));
    send_and_await(|tx| ModelCommand::SetNotificationSettings {
        settings,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_notification_enabled(enabled: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetNotificationEnabled { enabled, reply: tx }).await
}

#[napi]
pub async fn set_notification_paused(paused: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetNotificationPaused { paused, reply: tx }).await
}

/// 通知音の試聴 (= Phase D 設定モーダルの ▶ 試聴 ボタン用)。
/// volume は 0.0..=1.0、 output_device は cpal name (空文字で既定)。
/// ModelQueue を経由せず直接 spawn_blocking で再生する (= 設定保存と関係ない一過性 op)。
#[napi]
pub async fn test_notification_sound(
    file: String,
    volume: f64,
    output_device: String,
) -> Result<String> {
    let result = tokio::task::spawn_blocking(move || {
        crate::notification_sound::play_notification_sound(
            &file,
            volume as f32,
            &output_device,
        )
    })
    .await;
    let payload = match result {
        Ok(Ok(())) => serde_json::json!({ "ok": true }),
        Ok(Err(err)) => serde_json::json!({ "ok": false, "error": err }),
        Err(join_err) => serde_json::json!({
            "ok": false,
            "error": format!("task join error: {}", join_err)
        }),
    };
    Ok(payload.to_string())
}

/// 通知 TTS のプレビュー (= Phase D 設定モーダルの ▶ プレビュー ボタン用)。
/// 通知の provider / outputDevice + 保存済の voicevox 設定を組合せて 1 回 test_speech する。
/// 通常 TTS の CURRENT_TTS_SETTINGS には影響なし (= 通知設定をその場で組んで渡す)。
/// voicevox 選択時は host/port を TTS 側設定から merge する (= 通知 UI では host/port を
/// 出さない仕様)。
#[napi]
pub async fn preview_notification_tts(
    text: String,
    provider: String,
    output_device: String,
) -> Result<String> {
    let mut settings = serde_json::json!({
        "enabled": true,
        "provider": provider.clone(),
        "outputDevice": output_device,
    });
    let notif_settings = crate::notification_settings::current_settings();
    let tts_settings = crate::tts::current_settings();
    if provider == "voicevox" {
        let mut vv = notif_settings
            .get("voicevox")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(tts_vv) = tts_settings.get("voicevox") {
            if let Some(obj) = vv.as_object_mut() {
                if !obj.contains_key("host") {
                    obj.insert(
                        "host".to_string(),
                        tts_vv.get("host").cloned().unwrap_or(serde_json::Value::String("127.0.0.1".to_string())),
                    );
                }
                if !obj.contains_key("port") {
                    obj.insert(
                        "port".to_string(),
                        tts_vv.get("port").cloned().unwrap_or(serde_json::Value::Number(50021.into())),
                    );
                }
            }
        }
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("voicevox".to_string(), vv);
        }
    } else if provider == "builtin" {
        let bi = notif_settings
            .get("builtin")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("builtin".to_string(), bi);
        }
    } else if provider == "bouyomi" {
        let mut by = notif_settings
            .get("bouyomi")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(tts_by) = tts_settings.get("bouyomi") {
            if let Some(obj) = by.as_object_mut() {
                if !obj.contains_key("host") {
                    obj.insert(
                        "host".to_string(),
                        tts_by.get("host").cloned().unwrap_or(serde_json::Value::String("127.0.0.1".to_string())),
                    );
                }
                if !obj.contains_key("port") {
                    obj.insert(
                        "port".to_string(),
                        tts_by.get("port").cloned().unwrap_or(serde_json::Value::Number(50001.into())),
                    );
                }
                if !obj.contains_key("executablePath") {
                    if let Some(p) = tts_by.get("executablePath") {
                        obj.insert("executablePath".to_string(), p.clone());
                    }
                }
            }
        }
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("bouyomi".to_string(), by);
        }
    }
    let result = crate::tts::test_speech(settings, text).await;
    Ok(result.to_string())
}

/// 通知音用の出力デバイス名一覧 (cpal)。 設定 UI の select オプション用。
#[napi]
pub fn list_notification_sound_devices() -> Result<String> {
    let names = crate::notification_sound::list_output_device_names();
    Ok(serde_json::json!(names).to_string())
}

/// プリセット音源 8 種の一覧 (Phase D-2)。 file_path 絶対パス + available 判定付き。
/// presets_dir = effects-overlay/notification-sounds/ の絶対パス (= main.js が解決して渡す)。
#[napi]
pub fn list_notification_sound_presets(presets_dir: String) -> Result<String> {
    let dir = std::path::Path::new(&presets_dir);
    let presets = crate::notification_sound::list_presets(dir);
    Ok(serde_json::to_string(&presets).unwrap_or_else(|_| "[]".to_string()))
}

/// 8 イベント毎の default テンプレ文言 + sound preset id (= 旧 JS NOTIFICATION_EVENT_DEFS
/// 内の tplDefault / soundPreset 二重正本を解消した結果の Rust 正本)。 JS UI 起動時に 1 度
/// fetch して module-scoped cache に保持、 placeholder 表示 / 「↺ デフォルトに戻す」 で参照する。
/// 戻り値 JSON: [{ "event_id": "...", "template": "...", "sound_preset_id": "..." }, ...]
#[napi]
pub fn get_notification_event_defaults() -> Result<String> {
    let entries: Vec<serde_json::Value> = crate::notification_settings::EVENT_IDS
        .iter()
        .map(|id| {
            serde_json::json!({
                "event_id": id,
                "template": crate::notification_settings::default_template_for(id),
                "sound_preset_id": crate::notification_settings::default_sound_preset_id_for(id),
            })
        })
        .collect();
    Ok(serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string()))
}

/// SAPI token → cpal name の対応表を再構築する (Phase D-3 デバイス橋渡し)。
/// 起動時 1 回 + UI でデバイス一覧を引くタイミング (= mousedown) に呼ぶ想定。
/// PowerShell SAPI を 1 回起動する (= 数百 ms オーダー)、 完了まで await。
#[napi]
pub async fn refresh_notification_sound_device_map() -> Result<String> {
    crate::notification_sound::refresh_device_map().await;
    Ok(serde_json::json!({ "ok": true, "size": crate::notification_sound::device_map_size() })
        .to_string())
}

async fn current_tts_settings() -> Result<serde_json::Value> {
    let json = get_tts_settings().await?;
    Ok(serde_json::from_str(&json).unwrap_or_else(|_| crate::tts::default_settings()))
}

#[napi]
pub async fn check_tts_provider(provider: String) -> Result<String> {
    let settings = current_tts_settings().await?;
    Ok(crate::tts::check_provider(settings, provider)
        .await
        .to_string())
}

#[napi]
pub async fn launch_tts_provider(provider: String) -> Result<String> {
    let settings = current_tts_settings().await?;
    Ok(crate::tts::launch_provider(settings, provider)
        .await
        .to_string())
}

#[napi]
pub async fn detect_tts_provider_executable(provider: String) -> Result<String> {
    let settings = current_tts_settings().await?;
    Ok(crate::tts::detect_provider_executable(settings, provider)
        .await
        .to_string())
}

#[napi]
pub async fn get_tts_voices(provider: String) -> Result<String> {
    let settings = current_tts_settings().await?;
    Ok(crate::tts::get_voices(settings, provider).await.to_string())
}

#[napi]
pub async fn test_tts_speech(text: String) -> Result<String> {
    let settings = current_tts_settings().await?;
    Ok(crate::tts::test_speech(settings, text).await.to_string())
}

#[napi]
pub async fn get_tts_audio_outputs() -> Result<String> {
    Ok(crate::tts::get_audio_outputs().await.to_string())
}

#[napi]
pub async fn has_reaction_trigger() -> Result<String> {
    send_and_await(|tx| ModelCommand::HasReactionTrigger { reply: tx }).await
}

// ---------------------------------------------------------------------------
// SceneSurface
// ---------------------------------------------------------------------------

#[napi]
pub async fn get_scene_list() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetSceneList { reply: tx }).await
}

#[napi]
pub async fn get_scenes() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetScenes { reply: tx }).await
}

#[napi]
pub fn reload_scenes() -> String {
    fire_and_forget(ModelCommand::ReloadScenes)
}

#[napi]
pub async fn create_scene(scene_id: String, name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::CreateScene {
        scene_id,
        name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn create_scene_with_generated_id(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::CreateSceneWithGeneratedId { name, reply: tx }).await
}

#[napi]
pub async fn delete_scene(scene_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteScene {
        scene_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn save_scene(scene_id: String, scene_json: String) -> Result<String> {
    let scene: crate::state::scene::Scene = serde_json::from_str(&scene_json)
        .map_err(|e| Error::from_reason(format!("Invalid scene JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::SaveScene {
        scene_id,
        scene,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn rename_scene(scene_id: String, new_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RenameScene {
        scene_id,
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn duplicate_scene(
    source_id: String,
    new_id: String,
    new_name: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::DuplicateScene {
        source_id,
        new_id,
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn duplicate_scene_with_generated_id(
    source_id: String,
    new_name: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::DuplicateSceneWithGeneratedId {
        source_id,
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub fn reorder_scenes(order: Vec<String>) -> String {
    fire_and_forget(ModelCommand::ReorderScenes { order })
}

#[napi]
pub fn set_active_scene(scene_id: String) -> String {
    fire_and_forget(ModelCommand::SetActiveScene { scene_id })
}

#[napi]
pub async fn set_scene_enabled(scene_id: String, enabled: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetSceneEnabled {
        scene_id,
        enabled,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_scene_templates_enabled(scene_id: String, enabled: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetSceneTemplatesEnabled {
        scene_id,
        enabled,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// PerformanceCrudSurface
// ---------------------------------------------------------------------------

#[napi]
pub async fn get_performances(scene_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetPerformances {
        scene_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn save_performance(scene_id: String, performance_json: String) -> Result<String> {
    let performance: serde_json::Value = serde_json::from_str(&performance_json)
        .map_err(|e| Error::from_reason(format!("Invalid performance JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::SavePerformance {
        scene_id,
        performance,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn delete_performance(scene_id: String, performance_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeletePerformance {
        scene_id,
        performance_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_performance_enabled(
    scene_id: String,
    performance_id: String,
    enabled: bool,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetPerformanceEnabled {
        scene_id,
        performance_id,
        enabled,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn reorder_performances(scene_id: String, ordered_ids: Vec<String>) -> Result<String> {
    send_and_await(|tx| ModelCommand::ReorderPerformances {
        scene_id,
        ordered_ids,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// AppConfigSurface
// ---------------------------------------------------------------------------

#[napi]
pub fn set_app_root_dir(dir: String) -> String {
    fire_and_forget(ModelCommand::SetAppRootDir { dir })
}

#[napi]
pub fn set_active_scene_and_save(scene_id: String) -> String {
    fire_and_forget(ModelCommand::SetActiveSceneAndSave { scene_id })
}

#[napi]
pub async fn get_active_scene() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetActiveScene { reply: tx }).await
}

#[napi]
pub async fn restore_default_scene(scene_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RestoreDefaultScene {
        scene_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn check_default_template_context(effect_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::CheckDefaultTemplateContext {
        effect_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn copy_performance_asset(
    scene_id: String,
    src_path: String,
    performance_id: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::CopyPerformanceAsset {
        scene_id,
        src_path,
        performance_id,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// TemplateSurface
// ---------------------------------------------------------------------------

#[napi]
pub async fn get_templates() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetTemplates { reply: tx }).await
}

#[napi]
pub async fn install_template(zip_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::InstallTemplate {
        zip_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn create_template_from_starter(
    starter_type: String,
    template_id: String,
    display_name: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::CreateTemplateFromStarter {
        starter_type,
        template_id,
        display_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn create_template_from_builtin(
    source_template_id: String,
    template_id: String,
    display_name: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::CreateTemplateFromBuiltin {
        source_template_id,
        template_id,
        display_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn remove_template(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RemoveTemplate { name, reply: tx }).await
}

#[napi]
pub async fn get_template_directory(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetTemplateDirectory { name, reply: tx }).await
}

#[napi]
pub async fn import_template_bundled_font(
    name: String,
    src_path: String,
    family: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportTemplateBundledFont {
        name,
        src_path,
        family,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_template_manifest(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetTemplateManifest { name, reply: tx }).await
}

#[napi]
pub async fn get_scene_templates(scene_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetSceneTemplates {
        scene_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn add_scene_template(scene_id: String, template_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::AddSceneTemplate {
        scene_id,
        template_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn remove_scene_template(scene_id: String, template_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RemoveSceneTemplate {
        scene_id,
        template_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_selected_scene_template(
    scene_id: String,
    template_name: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetSelectedSceneTemplate {
        scene_id,
        template_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_scene_template_enabled(
    scene_id: String,
    template_name: String,
    enabled: bool,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetSceneTemplateEnabled {
        scene_id,
        template_name,
        enabled,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn set_scene_template_config(
    scene_id: String,
    template_name: String,
    settings_json: String,
) -> Result<String> {
    let settings: serde_json::Value = serde_json::from_str(&settings_json)
        .map_err(|e| Error::from_reason(format!("Invalid settings JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::SetSceneTemplateConfig {
        scene_id,
        template_name,
        settings,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_template_manifests() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetTemplateManifests { reply: tx }).await
}

#[napi]
pub async fn save_template_manifest(name: String, manifest_json: String) -> Result<String> {
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| Error::from_reason(format!("Invalid manifest JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::SaveTemplateManifest {
        name,
        manifest,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// EffectCrudSurface
// ---------------------------------------------------------------------------

#[napi]
pub async fn get_effects() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetEffects { reply: tx }).await
}

#[napi]
pub async fn get_effect(effect_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::GetEffect {
        effect_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn add_effect(effect_json: String) -> Result<String> {
    let effect: serde_json::Value = serde_json::from_str(&effect_json)
        .map_err(|e| Error::from_reason(format!("Invalid effect JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::AddEffect { effect, reply: tx }).await
}

#[napi]
pub async fn update_effect(effect_json: String) -> Result<String> {
    let effect: serde_json::Value = serde_json::from_str(&effect_json)
        .map_err(|e| Error::from_reason(format!("Invalid effect JSON: {}", e)))?;
    send_and_await(|tx| ModelCommand::UpdateEffect { effect, reply: tx }).await
}

#[napi]
pub async fn remove_effect(effect_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RemoveEffect {
        effect_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn duplicate_effect(effect_id: String, new_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DuplicateEffect {
        effect_id,
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn get_plugin_manifests() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetPluginManifests { reply: tx }).await
}

// ---------------------------------------------------------------------------
// PresetSurface
// ---------------------------------------------------------------------------

#[napi]
pub async fn get_preset_list() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetPresetList { reply: tx }).await
}

#[napi]
pub async fn get_current_preset() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetCurrentPreset { reply: tx }).await
}

#[napi]
pub fn set_current_preset(name: String) -> String {
    fire_and_forget(ModelCommand::SetCurrentPreset { name })
}

#[napi]
pub async fn switch_preset(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::SwitchPreset { name, reply: tx }).await
}

#[napi]
pub async fn duplicate_preset(new_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DuplicatePreset {
        new_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn delete_preset(name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeletePreset { name, reply: tx }).await
}

#[napi]
pub async fn export_preset(dest_path: String, export_name: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ExportPreset {
        dest_path,
        export_name,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn import_preset(zip_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportPreset {
        zip_path,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// BackupSurface
// ---------------------------------------------------------------------------

#[napi]
pub async fn get_backup_list() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetBackupList { reply: tx }).await
}

#[napi]
pub async fn create_backup(options_json: String) -> Result<String> {
    let options: serde_json::Value = serde_json::from_str(&options_json).unwrap_or_default();
    send_and_await(|tx| ModelCommand::CreateBackup { options, reply: tx }).await
}

#[napi]
pub async fn create_full_backup(name: Option<String>) -> Result<String> {
    send_and_await(|tx| ModelCommand::CreateFullBackup { name, reply: tx }).await
}

#[napi]
pub async fn delete_backup(backup_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::DeleteBackup {
        backup_id,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn restore_backup(backup_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::RestoreBackup {
        backup_id,
        reply: tx,
    })
    .await
}

#[napi]
pub fn set_backups_dir(dir: String) -> String {
    fire_and_forget(ModelCommand::SetBackupsDir { dir })
}

#[napi]
pub async fn get_backups_dir() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetBackupsDir { reply: tx }).await
}

#[napi]
pub async fn get_data_overview() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetDataOverview { reply: tx }).await
}

#[napi]
pub async fn confirm_upgrade_effect(zip_path: String, effect_id: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ConfirmUpgradeEffect {
        zip_path,
        effect_id,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// Export/Import Surface
// ---------------------------------------------------------------------------

#[napi]
pub async fn export_scene(scene_id: String, dest_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ExportScene {
        scene_id,
        dest_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn export_performance(
    scene_id: String,
    performance_id: String,
    dest_path: String,
) -> Result<String> {
    send_and_await(|tx| ModelCommand::ExportPerformance {
        scene_id,
        performance_id,
        dest_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn export_effect(effect_id: String, dest_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ExportEffect {
        effect_id,
        dest_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn export_template(
    template_name: String,
    export_name: Option<String>,
    scene_id: Option<String>,
    template_settings_json: String,
    dest_path: String,
) -> Result<String> {
    let template_settings = serde_json::from_str(&template_settings_json).map_err(|error| {
        Error::from_reason(format!("Invalid template settings JSON: {}", error))
    })?;
    send_and_await(|tx| ModelCommand::ExportTemplate {
        template_name,
        export_name,
        scene_id,
        template_settings,
        dest_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn import_effect(zip_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportEffect {
        zip_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn import_scene(zip_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportScene {
        zip_path,
        reply: tx,
    })
    .await
}

#[napi]
pub async fn import_performance(scene_id: String, zip_path: String) -> Result<String> {
    send_and_await(|tx| ModelCommand::ImportPerformance {
        scene_id,
        zip_path,
        reply: tx,
    })
    .await
}

// ---------------------------------------------------------------------------
// RendererLoggingSurface (= renderer プロセスから renderer.log への書き込み)
// ---------------------------------------------------------------------------

/// renderer プロセスから受け取った log event を `renderer.log` に書く。
/// fire-and-forget で即返却 (= Rust 側の専用 mpsc + writer task が非同期書き込み)。
/// 詳細仕様: `docs/logging.md`。
#[napi]
pub fn log_renderer(level: String, tag: String, message: String) {
    crate::renderer_logging::log_renderer_event(&level, &tag, &message);
}

/// renderer ロガーが初期化完了か (= main.js から「Rust 経路に流すか app.log
/// fallback を使うか」 の判定に使用)。 init 失敗 / 競合等で false を返す。
#[napi]
pub fn is_renderer_logging_initialized() -> bool {
    crate::renderer_logging::is_initialized()
}

// ---------------------------------------------------------------------------
// DebugSupportSurface (= デバッグログ ON/OFF)
// ---------------------------------------------------------------------------

/// デバッグログ ON/OFF の現在値を取得する。
/// 戻り値 JSON: `{ "enabled": bool }`。
#[napi]
pub async fn get_debug_logging_enabled() -> Result<String> {
    send_and_await(|tx| ModelCommand::GetDebugLoggingEnabled { reply: tx }).await
}

/// デバッグログ ON/OFF を保存する (= 再起動で反映、 logging::init_logging が
/// 起動時に app-config.json を peek して EnvFilter を決定する)。
/// 戻り値 JSON: `{ "ok": true, "enabled": bool }`。
#[napi]
pub async fn set_debug_logging_enabled(enabled: bool) -> Result<String> {
    send_and_await(|tx| ModelCommand::SetDebugLoggingEnabled { enabled, reply: tx }).await
}
