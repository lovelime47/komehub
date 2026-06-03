#![cfg_attr(test, allow(dead_code))]

mod common;
mod engine;
mod font_cache;
mod image_cache;
mod infra;
mod innertube_parser;
mod logging;
mod model_queue;
#[allow(dead_code)]
mod notification_settings;
#[allow(dead_code)]
mod notification_sound;
mod shared_memory;
mod state;
mod surface;
#[allow(dead_code)]
mod tts;

use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // データディレクトリ: コマンドライン引数 or デフォルト (%APPDATA%/live-comment-hub)
    let data_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let appdata = std::env::var("APPDATA").expect("APPDATA not set");
            PathBuf::from(appdata).join("live-comment-hub")
        });

    logging::init_logging(&data_dir)
        .unwrap_or_else(|err| panic!("Failed to initialize core logging: {}", err));

    tracing::info!("komehub-core starting");
    tracing::info!("Data directory: {:?}", data_dir);
    tracing::info!("Core log file: {:?}", logging::core_log_path(&data_dir));

    // Store/Session 初期化
    let main_store = state::MainStore::new();
    let main_session = state::MainSession::new();

    // プラグインディレクトリ:
    // - 配布物: 実行バイナリの隣の effects-overlay/plugins/
    // - 開発時: カレントディレクトリ配下の effects-overlay/plugins/
    let plugins_dir = std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent()
                .map(|d| d.join("effects-overlay").join("plugins"))
        })
        .filter(|path| path.exists())
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|dir| dir.join("effects-overlay").join("plugins"))
                .filter(|path| path.exists())
        })
        .unwrap_or_else(|| PathBuf::from("effects-overlay/plugins"));

    let hub_version = env!("CARGO_PKG_VERSION");
    let overlay_dir = plugins_dir
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("effects-overlay"));
    let app_root_dir = overlay_dir
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let builtin_templates_dir = overlay_dir.join("templates");
    let user_templates_dir = data_dir.join("templates");
    let media_cache_dir = data_dir.join("media-cache");

    let requested_port = infra::config::configured_public_http_port();
    let bind_addr = infra::config::configured_public_http_bind_addr();
    let listener = tokio::net::TcpListener::bind(format!("{}:{}", bind_addr, requested_port))
        .await
        .expect("Failed to bind port");
    let port = listener
        .local_addr()
        .expect("Failed to read bound port")
        .port();

    // Model Queue 起動
    let (model_tx, model_queue) = model_queue::ModelQueue::new(
        main_store,
        main_session,
        &data_dir,
        &plugins_dir,
        hub_version,
        port,
    );

    // SSE broadcaster
    let sse_broadcaster = Arc::new(surface::sse::SseBroadcaster::new());

    // graceful shutdown signal (standalone はシグナル送信元が無いため未使用だが、
    // AppState の必須フィールドなので channel だけ作る)
    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // アプリケーション共有状態
    let boot_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let app_state = surface::AppState {
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
        shutdown_signal: shutdown_rx,
    };

    // axum Router 構築
    let router = surface::build_router(app_state);

    // Model Queue をバックグラウンドタスクとして起動
    let sse_for_queue = sse_broadcaster.clone();
    tokio::spawn(async move {
        model_queue.run(sse_for_queue).await;
    });

    tracing::info!("komehub-core listening on port {}", port);
    tracing::info!("komehub-core bind address {}", bind_addr);

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("Server error");
}
