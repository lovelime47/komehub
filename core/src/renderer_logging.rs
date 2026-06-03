//! Electron renderer プロセス専用のログ出力モジュール (= `renderer.log` への書き込み)。
//!
//! renderer からの log 出力は preload `api.log.create('Tag').info(...)` で始まり、
//! IPC → main → coreBridge.logRenderer → napi `log_renderer()` → 本 module の
//! `log_renderer_event()` に到達する。 mpsc channel に行データを送り、
//! 専用 writer task が `renderer.log` に書き込む。
//!
//! 設計判断:
//! - **専用 channel + 専用 writer task**: app.log (= log.js stream) / core.log
//!   (= tracing subscriber) と writer thread を分離してファイル書き込み競合 / 順序
//!   乱れを回避する。 また renderer ログが大量に来ても他経路を blocking しない。
//! - **fire-and-forget**: `log_renderer_event()` は呼出元に即返却。 mpsc::Sender
//!   は unbounded で、 send は同期的に成功する (= writer task が遅れても block しない)。
//! - **3 世代ローテーション**: app.log / core.log と同等 (= `renderer.log →
//!   renderer.1.log → renderer.2.log → 削除`)。
//! - **フォーマット統一**: `{timestamp} [{LEVEL}] [{tag}] {message}` で 3 経路揃える。
//!
//! 詳細仕様: `docs/logging.md`。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

use tokio::runtime::Handle;
use tokio::sync::mpsc;

use crate::logging::format_timestamp;

const MAX_RENDERER_GENERATIONS: u32 = 3;

static RENDERER_LOG_SENDER: OnceLock<mpsc::UnboundedSender<String>> = OnceLock::new();

/// renderer ロガーを初期化する。 `napi_bridge::init()` で 1 回呼ぶ前提。
/// - 3 世代ローテ (= `renderer.log → renderer.1.log → renderer.2.log → 削除`)
/// - 専用 writer task を spawn して mpsc channel から行データを受信して書き込む
/// - 2 回目以降の呼出は no-op (= sender 初期化済を検知してスキップ)
pub fn init_renderer_logging(data_dir: &Path, rt_handle: &Handle) -> Result<(), String> {
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(|err| {
        format!(
            "failed to create renderer log directory {:?}: {}",
            log_dir, err
        )
    })?;

    if RENDERER_LOG_SENDER.get().is_some() {
        return Ok(());
    }

    rotate_renderer_logs(&log_dir);

    let log_path = log_dir.join("renderer.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("failed to open renderer log file {:?}: {}", log_path, err))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if RENDERER_LOG_SENDER.set(tx).is_err() {
        // 競合: 別スレッドから先に set 済。 自身で開いた file は drop で閉じる。
        return Ok(());
    }

    let init_msg = format!(
        "{} [INFO ] [RendererLogging] renderer logging initialized: {:?}",
        format_timestamp(),
        log_path
    );

    rt_handle.spawn(async move {
        let mut file = file;
        let _ = writeln!(file, "{}", init_msg);
        let _ = file.flush();

        while let Some(line) = rx.recv().await {
            if writeln!(file, "{}", line).is_err() {
                break;
            }
            let _ = file.flush();
        }
    });

    Ok(())
}

/// renderer から受け取った log event を専用 channel に送る (= 即返却 / fire-and-forget)。
/// `init_renderer_logging()` が呼ばれていない場合は drop (= core 起動完了前の log は
/// app.log の `[Renderer]` 経路に fallback されている前提)。
pub fn log_renderer_event(level: &str, tag: &str, message: &str) {
    let Some(tx) = RENDERER_LOG_SENDER.get() else {
        return;
    };
    let level_label = level_label_for_str(level);
    let line = format!(
        "{} [{}] [{}] {}",
        format_timestamp(),
        level_label,
        tag,
        message
    );
    let _ = tx.send(line);
}

/// renderer ロガーが初期化済か (= main 側 IPC handler が Rust 経路に流すか
/// app.log fallback を使うかを判定するために使用)。
pub fn is_initialized() -> bool {
    RENDERER_LOG_SENDER.get().is_some()
}

fn level_label_for_str(level: &str) -> &'static str {
    match level {
        "trace" => "TRACE",
        "debug" => "DEBUG",
        "info" => "INFO ",
        "warn" => "WARN ",
        "error" => "ERROR",
        _ => "INFO ",
    }
}

/// `renderer.log` を 3 世代ローテーション (= `logging::rotate_logs` と同等のロジック)。
fn rotate_renderer_logs(log_dir: &Path) {
    // 保持上限を超えた世代を削除 (= renderer.3.log 〜 renderer.8.log、 保険として MAX+5 まで掃除)
    for g in (MAX_RENDERER_GENERATIONS..=MAX_RENDERER_GENERATIONS + 5).rev() {
        let old = log_dir.join(format!("renderer.{}.log", g));
        if old.exists() {
            let _ = fs::remove_file(&old);
        }
    }
    // 世代シフト: renderer.log → renderer.1.log、 renderer.1.log → renderer.2.log
    // (= 逆順 rename しないと上書きで先頭が消える)
    for i in (1..MAX_RENDERER_GENERATIONS).rev() {
        let from = if i == 1 {
            log_dir.join("renderer.log")
        } else {
            log_dir.join(format!("renderer.{}.log", i - 1))
        };
        let to = log_dir.join(format!("renderer.{}.log", i));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}
