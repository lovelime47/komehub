use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, Once, OnceLock};

use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;
use time::macros::format_description;
use time::OffsetDateTime;

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();
static LOGGING_INIT: Once = Once::new();

const MAX_GENERATIONS: u32 = 3;

/// core.log を 3 世代ローテーションする (= JS 側 electron/log.js::rotate と同等)。
/// 起動時に 1 回呼ばれる: `core.log → core.1.log → core.2.log → 削除`。
/// 過去のクラッシュ等で残った余分な世代 (= core.3.log 以降) も保険として削除する。
fn rotate_logs(log_dir: &Path) {
    // 保持上限を超えた世代 (= core.3.log 〜 core.8.log) を削除
    for g in (MAX_GENERATIONS..=MAX_GENERATIONS + 5).rev() {
        let old = log_dir.join(format!("core.{}.log", g));
        if old.exists() {
            let _ = fs::remove_file(&old);
        }
    }
    // 世代シフト: core.log → core.1.log、 core.1.log → core.2.log
    // (= 逆順に rename しないと上書きで先頭が消える)
    for i in (1..MAX_GENERATIONS).rev() {
        let from = if i == 1 {
            log_dir.join("core.log")
        } else {
            log_dir.join(format!("core.{}.log", i - 1))
        };
        let to = log_dir.join(format!("core.{}.log", i));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

pub fn init_logging(data_dir: &Path) -> Result<(), String> {
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|err| format!("failed to create core log directory {:?}: {}", log_dir, err))?;

    let log_path = log_dir.join("core.log");
    if LOG_FILE.get().is_none() {
        rotate_logs(&log_dir);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|err| format!("failed to open core log file {:?}: {}", log_path, err))?;
        let _ = LOG_FILE.set(Mutex::new(file));
    }

    // app-config.json を peek して debug_logging_enabled を確認 (= 通常運用 OFF、
    // 設定で ON のとき trace まで落とす)。 RUST_LOG が設定されていればそちらが優先
    // (= dev 開発者のエスケープハッチ)。 詳細仕様: docs/logging.md。
    let default_level = if peek_debug_logging_enabled(data_dir) {
        "trace"
    } else {
        "info"
    };

    let initialized_path = log_path.clone();
    LOGGING_INIT.call_once(move || {
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new(default_level)),
            )
            .with_ansi(false)
            .with_writer(CoreLogWriter)
            .event_format(CoreEventFormat)
            .init();

        install_panic_hook();
        tracing::info!(
            "core logging initialized: {:?} (default_level={})",
            initialized_path,
            default_level
        );
    });

    Ok(())
}

/// 起動時に app-config.json を peek して `debug_logging_enabled` の現在値を
/// 取得する。 ModelQueue 初期化前に呼べるよう、 fs + serde_json で直接読む
/// (= ModelQueue::load_app_config と同じファイルだが、 logging 初期化はそれより
/// 先に行うため独自経路)。 ファイル不在 / parse 失敗時は false (= 通常運用)。
fn peek_debug_logging_enabled(data_dir: &Path) -> bool {
    let config_path = data_dir.join("app-config.json");
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };
    value
        .get("debugLoggingEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

struct CoreLogWriter;
struct CoreEventFormat;

struct CoreLogWriterGuard<'a> {
    stdout: io::Stdout,
    file: Option<MutexGuard<'a, File>>,
}

impl<'a> MakeWriter<'a> for CoreLogWriter {
    type Writer = CoreLogWriterGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        let file = LOG_FILE.get().and_then(|mutex| mutex.lock().ok());
        CoreLogWriterGuard {
            stdout: io::stdout(),
            file,
        }
    }
}

impl Write for CoreLogWriterGuard<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stdout.write_all(buf)?;
        if let Some(file) = self.file.as_mut() {
            file.write_all(buf)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stdout.flush()?;
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

impl<S, N> FormatEvent<S, N> for CoreEventFormat
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
    N: for<'writer> FormatFields<'writer> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let metadata = event.metadata();
        write!(
            writer,
            "{} [{}] [{}] ",
            format_timestamp(),
            level_label(metadata.level()),
            short_target(metadata.target())
        )?;
        ctx.format_fields(writer.by_ref(), event)?;
        writeln!(writer)
    }
}

fn install_panic_hook() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        tracing::error!("core panic: {}", format_panic_info(panic_info));
        previous_hook(panic_info);
    }));
}

fn format_panic_info(panic_info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_string()
    };

    match panic_info.location() {
        Some(location) => format!(
            "{} at {}:{}:{}",
            payload,
            location.file(),
            location.line(),
            location.column()
        ),
        None => payload,
    }
}

pub(crate) fn format_timestamp() -> String {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    now.format(format_description!(
        "[year]-[month repr:numerical padding:zero]-[day padding:zero] [hour padding:zero]:[minute padding:zero]:[second padding:zero].[subsecond digits:3]"
    ))
    .unwrap_or_else(|_| "1970-01-01 00:00:00.000".to_string())
}

fn level_label(level: &Level) -> &'static str {
    match *level {
        Level::TRACE => "TRACE",
        Level::DEBUG => "DEBUG",
        Level::INFO => "INFO ",
        Level::WARN => "WARN ",
        Level::ERROR => "ERROR",
    }
}

fn short_target(target: &str) -> &str {
    target.rsplit("::").next().unwrap_or(target)
}

pub fn core_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("core.log")
}
