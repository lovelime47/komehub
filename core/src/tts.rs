use std::collections::VecDeque;
use std::env;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::state::comment::RawComment;
use crate::surface::sse::SseBroadcaster;

/// Windows で powershell.exe を起動するときに、 一瞬出る黒いコンソールウィンドウを
/// 抑制した Command を返す。 CREATE_NO_WINDOW = 0x08000000 を creation_flags に渡す。
/// 非 Windows ビルドでは普通の Command::new("powershell.exe") を返す
/// (= ビルドは通るが実行時には PowerShell 自体が無いので呼ばれない想定)。
fn powershell_command() -> Command {
    let mut cmd = Command::new("powershell.exe");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// 外部 TTS プロバイダ (voicevox / bouyomi) の生死状態。
/// builtin は常に Ok 扱いで管理対象外。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HealthStatus {
    Idle,
    Checking,
    Ok,
    Unreachable,
}

impl HealthStatus {
    fn as_str(&self) -> &'static str {
        match self {
            HealthStatus::Idle => "idle",
            HealthStatus::Checking => "checking",
            HealthStatus::Ok => "ok",
            HealthStatus::Unreachable => "unreachable",
        }
    }
}

#[derive(Clone, Debug)]
struct ProviderHealth {
    status: HealthStatus,
    last_error: Option<String>,
}

impl Default for ProviderHealth {
    fn default() -> Self {
        ProviderHealth {
            status: HealthStatus::Idle,
            last_error: None,
        }
    }
}

// TtsJob は 「これからどのコメントを読むか」 だけを持ち、再生時の設定 (provider / voice 等) は
// 持たない。run_tts_queue が pop する度に最新の CURRENT_TTS_SETTINGS を読みに行くので、
// 設定変更は次の発話から即座に反映される (キューを破棄する必要が無い)。
struct TtsJob {
    comment: RawComment,
    generation: u64,
    sse: Arc<SseBroadcaster>,
}

/// 通知ジョブ (Phase C / D)。 通知は「コメ読み上げと違って設定の hot-swap が要らない」 ため、
/// pop 時に再評価せず enqueue 時の provider / outputDevice / text をそのまま使う。
/// (= 通知 1 件単位で「鳴って→読み上げて」 の sequence が確定している方が UX 自然)。
///
/// Phase D: sound_file (Some なら通知音再生) + sound_volume (0.0..=1.0) を追加。
/// Phase D-3: voicevox_settings / bouyomi_settings (Some なら test_speech の対応 object に
///   merge)。 host / port / executablePath は TTS 側を共有、 dispatch で merge 済。
pub struct NotificationJob {
    pub event_type: String,
    pub listener_name: String,
    pub text: String,
    pub sound_file: Option<String>,
    pub sound_volume: f32,
    pub provider: String,
    pub output_device: String,
    pub voicevox_settings: Option<Value>,
    pub bouyomi_settings: Option<Value>,
    pub builtin_settings: Option<Value>,
    pub generation: u64,
    // sse は run_notification_job 内で push_tts_state を呼ぶための受け渡し用。
    // Phase C 現状は使われていないが、 Phase D で「通知中…」 状態 push に使う想定で残す。
    #[allow(dead_code)]
    pub sse: Arc<SseBroadcaster>,
}

/// TTS_RUNTIME に流れる単一キューのジョブ種別。 同一キュー上でシーケンシャル再生される
/// (= コメ TTS の途中に通知が割り込まない、 通知音→通知 TTS の連続再生も保証される)。
enum TtsJobKind {
    Comment(TtsJob),
    Notification(NotificationJob),
}

struct TtsRuntime {
    queue: Mutex<VecDeque<TtsJobKind>>,
    notify: Notify,
    queue_count: AtomicUsize,
    speaking: AtomicBool,
    generation: AtomicU64,
    current_text: Mutex<String>,
}

static TTS_RUNTIME: OnceLock<Arc<TtsRuntime>> = OnceLock::new();
// paused は TtsRuntime の lazy init とは独立にプロセス起動時から有効である必要があるため
// (= 最初のコメ enqueue 前に set_paused が呼ばれても効くように) static AtomicBool で保持する。
// notification_settings::NOTIFICATION_PAUSED と同パターン。
static TTS_PAUSED: AtomicBool = AtomicBool::new(false);
static CURRENT_PLAYBACK_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
// run_tts_queue がいま再生中のジョブの設定スナップショット (中断・kill 用)。
// bouyomi の場合も Talk 送信〜完了 polling が終わるまでの間ここにセットされる。
static CURRENT_PLAYBACK_SETTINGS: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
// 棒読みちゃん専用: clear_pending (= OFF / Clear) で即時停止コマンドを送るため、
// 最後に Talk を送った bouyomi 設定を保持する。
static LAST_BOUYOMI_SETTINGS: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
// ModelQueue が SetTtsSettings/SetTtsEnabled/SetTtsPaused 等を処理する度に
// 最新の正規化済み設定をここに書き込む。run_tts_queue / enqueue_comment が
// pop / フィルタの度にこれを読んで「最新設定で再生」を実現する。
static CURRENT_TTS_SETTINGS: OnceLock<Mutex<Value>> = OnceLock::new();

// 外部プロバイダの生死を保持する。voicevox / bouyomi のみ管理 (builtin は常に Ok 扱い)。
static VOICEVOX_HEALTH: OnceLock<Mutex<ProviderHealth>> = OnceLock::new();
static BOUYOMI_HEALTH: OnceLock<Mutex<ProviderHealth>> = OnceLock::new();
// 復旧 polling task の二重起動防止フラグ。Unreachable 化と同時に CAS で立てる。
static VOICEVOX_RECOVERY_RUNNING: AtomicBool = AtomicBool::new(false);
static BOUYOMI_RECOVERY_RUNNING: AtomicBool = AtomicBool::new(false);

fn health_slot(provider: &str) -> Option<&'static Mutex<ProviderHealth>> {
    match provider {
        "voicevox" => Some(VOICEVOX_HEALTH.get_or_init(|| Mutex::new(ProviderHealth::default()))),
        "bouyomi" => Some(BOUYOMI_HEALTH.get_or_init(|| Mutex::new(ProviderHealth::default()))),
        _ => None,
    }
}

fn read_health(provider: &str) -> ProviderHealth {
    if let Some(slot) = health_slot(provider) {
        if let Ok(guard) = slot.lock() {
            return guard.clone();
        }
    }
    // builtin / 不明プロバイダは常に Ok を返す
    ProviderHealth { status: HealthStatus::Ok, last_error: None }
}

fn write_health(provider: &str, status: HealthStatus, error: Option<String>) -> bool {
    let Some(slot) = health_slot(provider) else {
        return false;
    };
    let Ok(mut guard) = slot.lock() else {
        return false;
    };
    let changed = guard.status != status || guard.last_error != error;
    guard.status = status;
    guard.last_error = error;
    changed
}

fn recovery_flag(provider: &str) -> Option<&'static AtomicBool> {
    match provider {
        "voicevox" => Some(&VOICEVOX_RECOVERY_RUNNING),
        "bouyomi" => Some(&BOUYOMI_RECOVERY_RUNNING),
        _ => None,
    }
}

/// ModelQueue が settings を更新した直後に呼ぶ。run_tts_queue / enqueue_comment が
/// 以降この値を読む。
pub fn update_current_settings(settings: Value) {
    let lock = CURRENT_TTS_SETTINGS.get_or_init(|| Mutex::new(default_settings()));
    if let Ok(mut s) = lock.lock() {
        *s = settings;
    }
}

pub fn current_settings() -> Value {
    CURRENT_TTS_SETTINGS
        .get()
        .and_then(|lock| lock.lock().ok().map(|s| s.clone()))
        .unwrap_or_else(default_settings)
}

pub fn default_settings() -> Value {
    // paused は永続化せず TtsRuntime.paused (= AtomicBool) で memory 保持
    // (= 「セッション内一時停止」 の意味、 ハブ再起動で必ず解除)
    json!({
        "enabled": false,
        "provider": "builtin",
        "maxLength": 120,
        "readName": false,
        "readUrl": false,
        "readEmojiName": false,
        // 出力デバイス (SAPI audio output token id)。空文字列はシステム既定を意味する。
        // builtin / voicevox にだけ適用される (bouyomi は棒読み側で設定するため非適用)。
        "outputDevice": "",
        "volume": 100,
        "speed": 0,
        "pitch": 0,
        "categories": {
            "normal": true,
            "superchat": true,
            "membership": true,
            "membershipGift": true
        },
        "roles": {
            "owner": false,
            "moderator": true,
            "member": true
        },
        "pausePolicy": {
            "queuePaid": true,
            "queueNormal": false
        },
        "bouyomi": {
            "executablePath": "",
            "host": "127.0.0.1",
            "port": 50001,
            "speed": -1,
            "tone": -1,
            "volume": -1,
            "voice": 0
        },
        "voicevox": {
            "executablePath": "",
            "host": "127.0.0.1",
            "port": 50021,
            "speakerUuid": "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9",
            "styleId": 3,
            "speedScale": 1.0,
            "pitchScale": 0.0,
            "intonationScale": 1.0,
            "volumeScale": 1.0
        },
        "builtin": {
            "voice": "",
            "rate": 0,
            "volume": 100
        }
    })
}

pub fn merge_settings(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_obj), Value::Object(patch_obj)) => {
            for (key, val) in patch_obj {
                if val.is_object() {
                    let entry = base_obj.entry(key).or_insert_with(|| json!({}));
                    merge_settings(entry, val);
                } else {
                    base_obj.insert(key, val);
                }
            }
        }
        (base_slot, patch_val) => {
            *base_slot = patch_val;
        }
    }
}

pub fn normalize_settings(settings: Option<Value>) -> Value {
    let mut merged = default_settings();
    if let Some(settings) = settings {
        merge_settings(&mut merged, settings);
    }
    merged
}

pub fn state(settings: &Value) -> Value {
    let queue_count = TTS_RUNTIME
        .get()
        .map(|rt| rt.queue_count.load(Ordering::SeqCst))
        .unwrap_or(0);
    let speaking = TTS_RUNTIME
        .get()
        .map(|rt| rt.speaking.load(Ordering::SeqCst))
        .unwrap_or(false);
    let current_text = TTS_RUNTIME
        .get()
        .and_then(|rt| rt.current_text.lock().ok().map(|text| text.clone()))
        .unwrap_or_default();
    let provider = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("builtin");
    let health = read_health(provider);
    let paused = is_paused();
    json!({
        "enabled": settings.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "paused": paused,
        "speaking": speaking,
        "queueCount": queue_count,
        "provider": provider,
        "providerStatus": health.status.as_str(),
        "providerError": health.last_error.clone().unwrap_or_default(),
        "currentText": current_text
    })
}

pub async fn check_provider(settings: Value, provider: String) -> Value {
    let provider = selected_provider(&settings, &provider);
    // チェック開始を Checking として記録 (UI 側で「接続確認中…」表示できるように)
    write_health(&provider, HealthStatus::Checking, None);
    let result = match provider.as_str() {
        "voicevox" => check_voicevox(&settings).await,
        "bouyomi" => {
            let settings_clone = settings.clone();
            tokio::task::spawn_blocking(move || check_bouyomi(&settings_clone))
                .await
                .unwrap_or_else(|err| {
                    json!({ "ok": false, "provider": "bouyomi", "error": err.to_string() })
                })
        }
        _ => json!({ "ok": true, "provider": "builtin" }),
    };
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        write_health(&provider, HealthStatus::Ok, None);
    } else {
        let err = result
            .get("error")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        write_health(&provider, HealthStatus::Unreachable, err);
    }
    result
}

pub async fn launch_provider(settings: Value, provider: String) -> Value {
    let provider = selected_provider(&settings, &provider);
    if provider == "builtin" {
        return json!({
            "ok": false,
            "provider": "builtin",
            "error": "内蔵読み上げは起動不要です。"
        });
    }

    let provider_for_error = provider.clone();
    tokio::task::spawn_blocking(move || launch_provider_blocking(&settings, &provider))
        .await
        .unwrap_or_else(|err| json!({ "ok": false, "provider": provider_for_error, "error": err.to_string() }))
}

pub async fn detect_provider_executable(settings: Value, provider: String) -> Value {
    let provider = selected_provider(&settings, &provider);
    if provider == "builtin" {
        return json!({ "ok": false, "provider": "builtin", "error": "内蔵読み上げは起動ファイルを使いません。" });
    }
    let provider_for_error = provider.clone();
    tokio::task::spawn_blocking(move || detect_provider_executable_blocking(&settings, &provider))
        .await
        .unwrap_or_else(|err| json!({ "ok": false, "provider": provider_for_error, "error": err.to_string() }))
}

fn detect_provider_executable_blocking(settings: &Value, provider: &str) -> Value {
    let configured_path = provider_executable_path(settings, provider);
    if !configured_path.trim().is_empty() {
        let path = PathBuf::from(configured_path.trim());
        return json!({
            "ok": path.is_file(),
            "provider": provider,
            "path": path.to_string_lossy(),
            "source": "configured",
            "error": if path.is_file() { "" } else { "指定された起動ファイルが見つかりません。" }
        });
    }
    if let Some(path) = running_provider_executable_path(provider) {
        return json!({
            "ok": true,
            "provider": provider,
            "path": path.to_string_lossy(),
            "source": "runningProcess"
        });
    }
    if let Some(path) = default_executable_path(provider) {
        return json!({
            "ok": true,
            "provider": provider,
            "path": path.to_string_lossy(),
            "source": "defaultPath"
        });
    }
    json!({ "ok": false, "provider": provider, "error": "起動ファイルを検出できませんでした。" })
}

fn launch_provider_blocking(settings: &Value, provider: &str) -> Value {
    let configured_path = provider_executable_path(settings, provider);
    let (path, is_configured) = if configured_path.trim().is_empty() {
        if let Some(path) = running_provider_executable_path(provider) {
            return json!({
                "ok": true,
                "provider": provider,
                "path": path.to_string_lossy(),
                "alreadyRunning": true
            });
        }
        match default_executable_path(provider) {
            Some(path) => (path, false),
            None => {
                return json!({
                    "ok": false,
                    "provider": provider,
                    "error": "起動ファイルが未設定です。設定で exe ファイルを指定してください。"
                });
            }
        }
    } else {
        (PathBuf::from(configured_path.trim()), true)
    };

    if !path.is_file() {
        return json!({
            "ok": false,
            "provider": provider,
            "path": path.to_string_lossy(),
            "error": if is_configured {
                "指定された起動ファイルが見つかりません。"
            } else {
                "起動ファイルを自動検出できませんでした。設定で exe ファイルを指定してください。"
            }
        });
    }

    match spawn_external_provider(&path) {
        Ok(()) => json!({ "ok": true, "provider": provider, "path": path.to_string_lossy() }),
        Err(err) => json!({
            "ok": false,
            "provider": provider,
            "path": path.to_string_lossy(),
            "error": err.to_string()
        }),
    }
}

#[cfg(windows)]
fn spawn_external_provider(path: &Path) -> io::Result<()> {
    let quoted_path = path.to_string_lossy().replace('\'', "''");
    let quoted_workdir = path
        .parent()
        .map(|parent| parent.to_string_lossy().replace('\'', "''"))
        .unwrap_or_default();
    let script = format!(
        "$p = Start-Process -FilePath '{}' -WorkingDirectory '{}' -PassThru; if (-not $p) {{ exit 1 }}",
        quoted_path, quoted_workdir
    );
    let output = powershell_command()
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(io::Error::new(
            io::ErrorKind::Other,
            if stderr.is_empty() {
                "Start-Process failed".to_string()
            } else {
                stderr
            },
        ))
    }
}

#[cfg(not(windows))]
fn spawn_external_provider(path: &Path) -> io::Result<()> {
    let mut command = Command::new(path);
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn().map(|_| ())
}

fn provider_executable_path(settings: &Value, provider: &str) -> String {
    settings
        .get(provider)
        .and_then(|cfg| cfg.get("executablePath"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn running_provider_executable_path(provider: &str) -> Option<PathBuf> {
    let process_name = match provider {
        "bouyomi" => "BouyomiChan.exe",
        _ => return None,
    };
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         $p = Get-CimInstance Win32_Process -Filter \"Name='{}'\" | Select-Object -First 1; \
         if ($p -and $p.ExecutablePath) {{ $p.ExecutablePath }}",
        process_name
    );
    let output = powershell_command()
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn default_executable_path(provider: &str) -> Option<PathBuf> {
    let candidates = match provider {
        "voicevox" => voicevox_executable_candidates(),
        _ => Vec::new(),
    };
    candidates.into_iter().find(|path| path.is_file())
}

fn voicevox_executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local_app_data).join("Programs").join("VOICEVOX").join("VOICEVOX.exe"));
        candidates.push(PathBuf::from(local_app_data).join("VOICEVOX").join("VOICEVOX.exe"));
    }
    if let Ok(program_files) = env::var("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("VOICEVOX").join("VOICEVOX.exe"));
    }
    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("VOICEVOX").join("VOICEVOX.exe"));
    }
    candidates
}

/// `check_provider` を呼び、結果に応じて health を更新したうえで SSE に
/// 最新 state を流す。ModelQueue の init / SetTtsSettings から spawn される。
/// `provider` 空のときは settings の値を使う。
pub async fn refresh_health(
    settings: Value,
    provider: String,
    sse: Arc<SseBroadcaster>,
) {
    let resolved = selected_provider(&settings, &provider);
    if resolved == "builtin" {
        // builtin は管理対象外
        return;
    }
    // 進行中表示を即時 push (UI が「接続確認中…」を出せるように)
    write_health(&resolved, HealthStatus::Checking, None);
    sse.push_tts_state(&state(&settings));
    let _ = check_provider(settings.clone(), resolved.clone()).await;
    sse.push_tts_state(&state(&settings));

    // Unreachable 化したなら復旧 polling を起動
    if read_health(&resolved).status == HealthStatus::Unreachable {
        spawn_recovery_polling(resolved, sse);
    }
}

/// Unreachable になった provider の復旧を 10 秒間隔で監視する。Ok に戻ったら
/// SSE 通知して終了。provider が切り替わったら終了。二重起動は AtomicBool で防止。
fn spawn_recovery_polling(provider: String, sse: Arc<SseBroadcaster>) {
    let Some(flag) = recovery_flag(&provider) else {
        return;
    };
    if flag
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        // 既に走っている
        return;
    }
    let provider_clone = provider.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let settings = current_settings();
            let active = settings
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("builtin")
                .to_string();
            if active != provider_clone {
                tracing::debug!(
                    "TTS recovery polling: provider switched away ({} -> {}), stopping",
                    provider_clone,
                    active
                );
                break;
            }
            if read_health(&provider_clone).status != HealthStatus::Unreachable {
                // 別経路で復旧していた
                break;
            }
            let result = check_provider(settings.clone(), provider_clone.clone()).await;
            let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
            sse.push_tts_state(&state(&settings));
            if ok {
                tracing::info!("TTS recovery polling: {} is back online", provider_clone);
                break;
            }
        }
        if let Some(flag) = recovery_flag(&provider_clone) {
            flag.store(false, Ordering::SeqCst);
        }
    });
}

/// `run_tts_queue` が再生失敗を検知したときに呼ぶ。provider を Unreachable に
/// 落とし、キューを clear して、復旧 polling を起動する。
fn mark_provider_unreachable(provider: &str, error: Option<String>, sse: &Arc<SseBroadcaster>) {
    if provider == "builtin" {
        // builtin の失敗は SAPI/PowerShell 側の一時障害なので unreachable 扱いしない
        return;
    }
    let changed = write_health(provider, HealthStatus::Unreachable, error);
    if !changed {
        return;
    }
    tracing::warn!("TTS provider {} marked unreachable", provider);
    // 詰まり防止: 残キューを破棄
    if let Some(runtime) = TTS_RUNTIME.get() {
        if let Ok(mut queue) = runtime.queue.lock() {
            queue.clear();
        }
        runtime.queue_count.store(0, Ordering::SeqCst);
    }
    sse.push_tts_state(&state(&current_settings()));
    spawn_recovery_polling(provider.to_string(), sse.clone());
}

pub async fn get_voices(settings: Value, provider: String) -> Value {
    let provider = selected_provider(&settings, &provider);
    match provider.as_str() {
        "voicevox" => get_voicevox_speakers(&settings).await,
        "builtin" => tokio::task::spawn_blocking(get_builtin_voices)
            .await
            .unwrap_or_else(|err| json!({ "ok": false, "provider": "builtin", "error": err.to_string() })),
        _ => json!({ "ok": true, "provider": "bouyomi", "voices": [] }),
    }
}

pub async fn test_speech(settings: Value, text: String) -> Value {
    let provider = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("builtin")
        .to_string();
    let text = if text.trim().is_empty() {
        "こめはぶの読み上げテストです。コメントを読み上げます。".to_string()
    } else {
        text
    };
    match provider.as_str() {
        "voicevox" => test_voicevox(settings, text).await,
        "bouyomi" => tokio::task::spawn_blocking(move || send_bouyomi_talk(&settings, &text))
            .await
            .unwrap_or_else(|err| json!({ "ok": false, "provider": "bouyomi", "error": err.to_string() })),
        _ => tokio::task::spawn_blocking(move || speak_builtin(&settings, &text))
            .await
            .unwrap_or_else(|err| json!({ "ok": false, "provider": "builtin", "error": err.to_string() })),
    }
}

pub fn enqueue_comment(comment: &RawComment, sse: Arc<SseBroadcaster>) {
    // enqueue 時のフィルタは「明らかに対象外」を切り捨てるため。enabled / categories 等は
    // pop 時にも再評価される (設定が変わっていれば次の発話から即時反映される)。
    let settings = current_settings();
    if !should_read_comment(&settings, comment) {
        let enabled_flag = settings
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        tracing::debug!(
            "TTS enqueue skipped: enabled={} comment_id={}",
            enabled_flag,
            comment.id
        );
        return;
    }
    // 選択中 provider が Unreachable のときはキューに積まない (詰まり防止)。
    // 復旧 polling が Ok に戻すまで TTS は無音、UI は providerStatus=unreachable で警告表示。
    let provider = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("builtin");
    if read_health(provider).status == HealthStatus::Unreachable {
        tracing::debug!(
            "TTS enqueue skipped: provider {} unreachable, comment_id={}",
            provider,
            comment.id
        );
        return;
    }
    let runtime = tts_runtime();
    let generation = runtime.generation.load(Ordering::SeqCst);
    runtime.queue_count.fetch_add(1, Ordering::SeqCst);
    {
        let Ok(mut queue) = runtime.queue.lock() else {
            runtime.queue_count.fetch_sub(1, Ordering::SeqCst);
            return;
        };
        queue.push_back(TtsJobKind::Comment(TtsJob {
            comment: comment.clone(),
            generation,
            sse: sse.clone(),
        }));
    }
    sse.push_tts_state(&state(&settings));
    runtime.notify.notify_one();
    tracing::debug!(
        "TTS enqueued: kind=Comment comment_id={} queue_len={}",
        comment.id,
        runtime.queue_count.load(Ordering::SeqCst)
    );
}

/// 通知ジョブを TTS_RUNTIME に enqueue する (Phase C)。 同一キュー上でコメ TTS と
/// シーケンシャル再生される (= 被らない)。 設定 filter は呼出側 (model_queue/notification.rs)
/// で実施済を前提とする (= ここに来た時点で「鳴らす/読む」 確定)。
pub fn enqueue_notification(job: NotificationJob) {
    let runtime = tts_runtime();
    let event_type = job.event_type.clone();
    let has_sound = job.sound_file.is_some();
    let has_text = !job.text.trim().is_empty();
    runtime.queue_count.fetch_add(1, Ordering::SeqCst);
    {
        let Ok(mut queue) = runtime.queue.lock() else {
            runtime.queue_count.fetch_sub(1, Ordering::SeqCst);
            return;
        };
        queue.push_back(TtsJobKind::Notification(job));
    }
    runtime.notify.notify_one();
    tracing::info!(
        "Notification enqueued: event={} sound={} tts={} queue_len={}",
        event_type,
        has_sound,
        has_text,
        runtime.queue_count.load(Ordering::SeqCst)
    );
}

/// 通知 OFF / 一時停止時に queue 内の Notification ジョブだけを削除する。 TTS コメ
/// 読み上げ (Comment ジョブ) は残し、 generation bump もしない (= コメ TTS に影響
/// なし)。 現在再生中の 1 つは最後まで鳴る (= run_notification_job 進行中は中断
/// しない、 sound 数秒 / 短文 TTS なら直に終わる)。 enqueue 段階の dispatch 側で
/// should_fire_tts / should_fire_sound が master 状態を見るので、 以降の発火は止まる。
pub fn clear_pending_notifications() {
    if let Some(runtime) = TTS_RUNTIME.get() {
        let pre_queue = runtime.queue_count.load(Ordering::SeqCst);
        let mut removed = 0usize;
        if let Ok(mut queue) = runtime.queue.lock() {
            let before = queue.len();
            queue.retain(|kind| !matches!(kind, TtsJobKind::Notification(_)));
            removed = before - queue.len();
            runtime.queue_count.store(queue.len(), Ordering::SeqCst);
        }
        runtime.notify.notify_waiters();
        tracing::info!(
            "TTS clear_pending_notifications: removed={} pre_queue={}",
            removed,
            pre_queue
        );
    }
}

pub fn clear_pending() {
    let pre_queue = TTS_RUNTIME
        .get()
        .map(|rt| rt.queue_count.load(Ordering::SeqCst))
        .unwrap_or(0);
    let pre_speaking = TTS_RUNTIME
        .get()
        .map(|rt| rt.speaking.load(Ordering::SeqCst))
        .unwrap_or(false);
    let next_generation = if let Some(runtime) = TTS_RUNTIME.get() {
        let next = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut queue) = runtime.queue.lock() {
            queue.clear();
        }
        runtime.queue_count.store(0, Ordering::SeqCst);
        runtime.speaking.store(false, Ordering::SeqCst);
        if let Ok(mut text) = runtime.current_text.lock() {
            text.clear();
        }
        runtime.notify.notify_waiters();
        next
    } else {
        0
    };
    stop_current_playback();
    tracing::info!(
        "TTS clear_pending: gen={} pre_queue={} pre_speaking={}",
        next_generation,
        pre_queue,
        pre_speaking
    );
}

pub fn set_paused(paused: bool) {
    TTS_PAUSED.store(paused, Ordering::SeqCst);
    // resume 時は queue worker を起こす (= TTS_RUNTIME 未初期化なら enqueue 時に起動するので無視可)
    if !paused {
        if let Some(runtime) = TTS_RUNTIME.get() {
            runtime.notify.notify_one();
        }
    }
}

pub fn is_paused() -> bool {
    TTS_PAUSED.load(Ordering::SeqCst)
}

/// 現在の generation を取得する (= 通知 enqueue 側が「clear_pending された?」 を見るため)。
/// 未初期化のときは 0。
pub fn current_generation() -> u64 {
    TTS_RUNTIME
        .get()
        .map(|rt| rt.generation.load(Ordering::SeqCst))
        .unwrap_or(0)
}

fn tts_runtime() -> Arc<TtsRuntime> {
    TTS_RUNTIME
        .get_or_init(|| {
            let runtime = Arc::new(TtsRuntime {
                queue: Mutex::new(VecDeque::new()),
                notify: Notify::new(),
                queue_count: AtomicUsize::new(0),
                speaking: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                current_text: Mutex::new(String::new()),
            });
            tokio::spawn(run_tts_queue(runtime.clone()));
            runtime
        })
        .clone()
}

async fn run_tts_queue(runtime: Arc<TtsRuntime>) {
    loop {
        // pause 中は Comment ジョブを取らず、 Notification ジョブだけ拾う
        // (= コメ読み上げを一時停止しても通知は独立して鳴らす設計、 ユーザー要望)。
        // Notification 側の一時停止は呼出側 (model_queue/notification.rs::dispatch) の
        // settings.paused で early-return している (= 通知 paused とコメ paused は別軸)。
        let paused_for_comments = is_paused();

        let job = {
            let Ok(mut queue) = runtime.queue.lock() else {
                runtime.notify.notified().await;
                continue;
            };
            if paused_for_comments {
                // Comment ジョブは queue に残し、 先頭にある Notification を取り出す。
                // 通常 queue 長は数件なので O(n) でも問題なし。
                let mut idx = None;
                for (i, j) in queue.iter().enumerate() {
                    if matches!(j, TtsJobKind::Notification(_)) {
                        idx = Some(i);
                        break;
                    }
                }
                idx.and_then(|i| queue.remove(i))
            } else {
                queue.pop_front()
            }
        };

        let Some(job_kind) = job else {
            runtime.notify.notified().await;
            continue;
        };

        // Phase C: コメ TTS / 通知 TTS を分岐。 同一キュー上でシーケンシャル再生される。
        // 通知ジョブは設定 hot-swap せず、 enqueue 時の provider/outputDevice/text を使う
        // (= 通知 1 件単位で「鳴って→読む」 sequence が確定するため hot-swap 不要)。
        let job = match job_kind {
            TtsJobKind::Comment(j) => j,
            TtsJobKind::Notification(n) => {
                run_notification_job(&runtime, n).await;
                continue;
            }
        };

        if job.generation != runtime.generation.load(Ordering::SeqCst) {
            continue;
        }

        decrement_queue_count(&runtime);

        // pop の度に最新の settings を読む。これが今回の設計の中核:
        //   - provider が切り替わっていれば新しいプロバイダで再生する
        //   - voicevox のキャラ / bouyomi の voice / builtin の voice もここで決まる
        //   - 設定が変わって enabled=false になっていれば skip
        //   - categories / readName / maxLength の変更も即時反映
        let settings = current_settings();
        if !settings
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || !should_read_comment(&settings, &job.comment)
        {
            continue;
        }
        let text = build_comment_text(&settings, &job.comment);
        if text.trim().is_empty() {
            continue;
        }

        runtime.speaking.store(true, Ordering::SeqCst);
        if let Ok(mut text_buf) = runtime.current_text.lock() {
            *text_buf = truncate_chars(&text, 80);
        }
        set_current_playback_settings(Some(settings.clone()));

        // 開始直前で世代を再確認 (clear_pending が pop と push の間に走ったケース)
        if job.generation != runtime.generation.load(Ordering::SeqCst) {
            runtime.speaking.store(false, Ordering::SeqCst);
            set_current_playback_settings(None);
            if let Ok(mut text_buf) = runtime.current_text.lock() {
                text_buf.clear();
            }
            continue;
        }
        job.sse.push_tts_state(&state(&settings));

        // 再生 (test_speech は voicevox / builtin は完了まで await、bouyomi は内部で
        // GetTaskCount を polling して完了を待つ)
        if job.generation != runtime.generation.load(Ordering::SeqCst) {
            runtime.speaking.store(false, Ordering::SeqCst);
            set_current_playback_settings(None);
            if let Ok(mut text_buf) = runtime.current_text.lock() {
                text_buf.clear();
            }
            continue;
        }

        let result = test_speech(settings.clone(), text).await;
        let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
        // ユーザー操作 (OFF / Clear) による中断は clear_pending が generation を bump
        // するので、ここで世代が進んでいたら test_speech の失敗は「強制終了の副作用」
        // (= taskkill された PowerShell child の non-zero exit / VOICEVOX synthesis の
        // 中断) であり、プロバイダ障害ではない。Unreachable 化を抑制する。
        let generation_still_current =
            job.generation == runtime.generation.load(Ordering::SeqCst);
        let provider = settings
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("builtin");
        // 失敗の原因が「再生プロセス側」(= 出力デバイス互換性なし、SAPI COM 内部
        // クラス未登録など) の場合は provider 障害ではないので Unreachable 化しない。
        // 再生プロセス側のエラーは run_interruptible_powershell が
        // `playback exited with ...` 形式で返してくる。
        let err_str = result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_playback_error = err_str.contains("playback exited with");
        if !ok && generation_still_current && !is_playback_error {
            tracing::warn!("TTS playback failed (provider issue): {}", result);
            let err = if err_str.is_empty() { None } else { Some(err_str.to_string()) };
            mark_provider_unreachable(provider, err, &job.sse);
        } else if !ok && is_playback_error {
            // デバイス起因の失敗。provider 自体は健全なのでキューだけ捨てる
            // (= 該当 1 件が無音になるだけ、後続コメントは引き続き読み上げを試みる)
            tracing::warn!(
                "TTS playback failed (device issue, not provider): {}",
                result
            );
        } else if !ok {
            tracing::debug!(
                "TTS playback aborted by user action (generation bumped): {}",
                result
            );
        } else {
            // 連続成功時は health を確実に Ok にしておく (起動時 Idle のまま稀に
            // ここに来るケースの保険)
            if provider != "builtin" && read_health(provider).status != HealthStatus::Ok
                && write_health(provider, HealthStatus::Ok, None) {
                    job.sse.push_tts_state(&state(&settings));
                }
        }

        runtime.speaking.store(false, Ordering::SeqCst);
        set_current_playback_settings(None);
        if let Ok(mut text_buf) = runtime.current_text.lock() {
            text_buf.clear();
        }
        if job.generation == runtime.generation.load(Ordering::SeqCst) {
            job.sse.push_tts_state(&state(&settings));
        }
    }
}

fn set_current_playback_settings(settings: Option<Value>) {
    let lock = CURRENT_PLAYBACK_SETTINGS.get_or_init(|| Mutex::new(None));
    if let Ok(mut current) = lock.lock() {
        *current = settings;
    }
}

/// 通知ジョブを実行する (Phase C)。
/// 1. 通知音再生 (= Phase D 実装、 Phase C は skip + ログ)
/// 2. 通知 TTS 再生 (= enqueue 時の provider/outputDevice/text を使って test_speech)
///
/// 設定 hot-swap せず enqueue 時の値を使う理由:
/// 通知は「コメ読み上げと違って 1 件単位で確定」 した sequence (= 鳴って→読む) であり、
/// 途中で provider 切替 / 出力デバイス切替が起きても今鳴っているものは完走するのが自然。
async fn run_notification_job(runtime: &Arc<TtsRuntime>, job: NotificationJob) {
    if job.generation != runtime.generation.load(Ordering::SeqCst) {
        decrement_queue_count(runtime);
        return;
    }
    decrement_queue_count(runtime);

    // Phase D: 通知音再生 (= rodio 経由、 完了まで block)。
    // sound_file が Some なら spawn_blocking で 1 回再生 → 完了待ち → 続けて TTS。
    // この順序保証が「鳴って → 読む」 シーケンスの本体。
    if let Some(path) = job.sound_file.as_ref() {
        let path = path.clone();
        let volume = job.sound_volume;
        let device = job.output_device.clone();
        let event_type = job.event_type.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::notification_sound::play_notification_sound(&path, volume, &device)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                tracing::debug!("notification sound played: event={}", event_type);
            }
            Ok(Err(err)) => {
                tracing::warn!(
                    "notification sound failed: event={} err={}",
                    event_type,
                    err
                );
            }
            Err(join_err) => {
                tracing::warn!(
                    "notification sound task join error: event={} err={}",
                    event_type,
                    join_err
                );
            }
        }
    }

    let text = job.text.trim().to_string();
    if text.is_empty() {
        tracing::debug!("notification tts skipped (empty text): event={}", job.event_type);
        return;
    }

    runtime.speaking.store(true, Ordering::SeqCst);
    if let Ok(mut text_buf) = runtime.current_text.lock() {
        *text_buf = truncate_chars(&text, 80);
    }

    // 通知専用 settings: provider/outputDevice + provider 別詳細 (= voicevox 等) で
    // test_speech を呼ぶ。 CURRENT_TTS_SETTINGS とは分離 (= 通知の provider/device は別軸)。
    let mut settings = json!({
        "enabled": true,
        "provider": job.provider,
        "outputDevice": job.output_device,
    });
    if let Some(vv) = job.voicevox_settings.as_ref() {
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("voicevox".to_string(), vv.clone());
        }
    }
    if let Some(by) = job.bouyomi_settings.as_ref() {
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("bouyomi".to_string(), by.clone());
        }
    }
    if let Some(bi) = job.builtin_settings.as_ref() {
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("builtin".to_string(), bi.clone());
        }
    }
    set_current_playback_settings(Some(settings.clone()));

    tracing::info!(
        "notification tts: event={} listener={} provider={} text={:?}",
        job.event_type,
        job.listener_name,
        job.provider,
        truncate_chars(&text, 60)
    );

    let result = test_speech(settings, text).await;
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        tracing::warn!(
            "notification tts failed: event={} provider={} result={}",
            job.event_type,
            job.provider,
            result
        );
    }

    runtime.speaking.store(false, Ordering::SeqCst);
    set_current_playback_settings(None);
    if let Ok(mut text_buf) = runtime.current_text.lock() {
        text_buf.clear();
    }
}

fn stop_current_playback() {
    // 棒読みちゃんは Talk 送信完了で run_tts_queue の speaking が false に戻ってしまうため、
    // CURRENT_PLAYBACK_SETTINGS では捕まえられない。LAST_BOUYOMI_SETTINGS を take して
    // 「停止 (Skip) → キュークリア → 停止 (Skip)」の 3 段階で必ず止める。
    let last_bouyomi = LAST_BOUYOMI_SETTINGS
        .get()
        .and_then(|lock| lock.lock().ok().and_then(|mut s| s.take()));
    if let Some(settings) = last_bouyomi {
        let _ = send_bouyomi_command(&settings, 0x0030); // Skip (stop current)
        std::thread::sleep(Duration::from_millis(30));
        let _ = send_bouyomi_command(&settings, 0x0040); // Clear queue
        std::thread::sleep(Duration::from_millis(30));
        let _ = send_bouyomi_command(&settings, 0x0030); // Skip again (race 保険)
    }

    let pid = CURRENT_PLAYBACK_PID
        .get()
        .and_then(|lock| lock.lock().ok().and_then(|pid| *pid));
    if let Some(pid) = pid {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}

fn decrement_queue_count(runtime: &TtsRuntime) {
    let _ = runtime.queue_count.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        Some(value.saturating_sub(1))
    });
}

fn should_read_comment(settings: &Value, comment: &RawComment) -> bool {
    if !settings.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    if settings.get("paused").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    if !comment.comment_visible && comment.auto_moderated {
        return false;
    }

    let roles = settings.get("roles").unwrap_or(&Value::Null);
    if comment.is_owner && !roles.get("owner").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    if comment.is_moderator && !roles.get("moderator").and_then(Value::as_bool).unwrap_or(true) {
        return false;
    }
    if comment.is_member && !roles.get("member").and_then(Value::as_bool).unwrap_or(true) {
        return false;
    }

    let categories = settings.get("categories").unwrap_or(&Value::Null);
    let key = if comment.is_membership_gift {
        "membershipGift"
    } else if comment.is_membership {
        "membership"
    } else if comment.has_gift || comment.amount > 0.0 {
        "superchat"
    } else {
        "normal"
    };
    categories.get(key).and_then(Value::as_bool).unwrap_or(true)
}

fn build_comment_text(settings: &Value, comment: &RawComment) -> String {
    let source = if !comment.speech_text.trim().is_empty() {
        comment.speech_text.trim()
    } else if !comment.comment.trim().is_empty() {
        comment.comment.trim()
    } else if !comment.membership_header.trim().is_empty() {
        comment.membership_header.trim()
    } else {
        ""
    };
    let mut text = strip_html(source);
    if settings.get("readName").and_then(Value::as_bool).unwrap_or(false) {
        let name = if !comment.display_name.trim().is_empty() {
            comment.display_name.trim()
        } else {
            comment.name.trim()
        };
        if !name.is_empty() {
            text = format!("{}さん、{}", name, text);
        }
    }
    let max_len = settings
        .get("maxLength")
        .and_then(Value::as_u64)
        .unwrap_or(120) as usize;
    truncate_chars(text.trim(), max_len)
}

fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn truncate_chars(input: &str, max_len: usize) -> String {
    if max_len == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (idx, ch) in input.chars().enumerate() {
        if idx >= max_len {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

fn selected_provider(settings: &Value, provider: &str) -> String {
    if provider.trim().is_empty() {
        settings
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("builtin")
            .to_string()
    } else {
        provider.to_string()
    }
}

async fn check_voicevox(settings: &Value) -> Value {
    let base = voicevox_base_url(settings);
    match reqwest::get(format!("{}/version", base)).await {
        Ok(resp) if resp.status().is_success() => {
            let version = resp.text().await.unwrap_or_default();
            json!({ "ok": true, "provider": "voicevox", "version": version.trim_matches('"') })
        }
        Ok(resp) => json!({ "ok": false, "provider": "voicevox", "error": format!("HTTP {}", resp.status()) }),
        Err(err) => json!({ "ok": false, "provider": "voicevox", "error": err.to_string() }),
    }
}

async fn get_voicevox_speakers(settings: &Value) -> Value {
    let base = voicevox_base_url(settings);
    match reqwest::get(format!("{}/speakers", base)).await {
        Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
            Ok(speakers) => json!({ "ok": true, "provider": "voicevox", "speakers": speakers }),
            Err(err) => json!({ "ok": false, "provider": "voicevox", "error": err.to_string() }),
        },
        Ok(resp) => json!({ "ok": false, "provider": "voicevox", "error": format!("HTTP {}", resp.status()) }),
        Err(err) => json!({ "ok": false, "provider": "voicevox", "error": err.to_string() }),
    }
}

async fn test_voicevox(settings: Value, text: String) -> Value {
    let base = voicevox_base_url(&settings);
    let speaker = voicevox_style_id(&settings);
    let client = reqwest::Client::new();
    let query_resp = client
        .post(format!("{}/audio_query", base))
        .query(&[("text", text.as_str()), ("speaker", &speaker.to_string())])
        .send()
        .await;
    let Ok(query_resp) = query_resp else {
        return json!({ "ok": false, "provider": "voicevox", "error": "audio_query failed" });
    };
    if !query_resp.status().is_success() {
        return json!({ "ok": false, "provider": "voicevox", "error": format!("audio_query HTTP {}", query_resp.status()) });
    }
    let mut query = match query_resp.json::<Value>().await {
        Ok(value) => value,
        Err(err) => return json!({ "ok": false, "provider": "voicevox", "error": err.to_string() }),
    };
    apply_voicevox_scales(&mut query, &settings);
    let synth_resp = client
        .post(format!("{}/synthesis", base))
        .query(&[("speaker", speaker.to_string())])
        .json(&query)
        .send()
        .await;
    let Ok(synth_resp) = synth_resp else {
        return json!({ "ok": false, "provider": "voicevox", "error": "synthesis failed" });
    };
    if !synth_resp.status().is_success() {
        return json!({ "ok": false, "provider": "voicevox", "error": format!("synthesis HTTP {}", synth_resp.status()) });
    }
    let bytes = match synth_resp.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => return json!({ "ok": false, "provider": "voicevox", "error": err.to_string() }),
    };
    let wav_path = temp_wav_path();
    if let Err(err) = std::fs::write(&wav_path, bytes) {
        return json!({ "ok": false, "provider": "voicevox", "error": err.to_string() });
    }
    let settings_for_playback = settings.clone();
    let result = tokio::task::spawn_blocking({
        let wav_path = wav_path.clone();
        move || play_wav_with_powershell(&wav_path, &settings_for_playback)
    })
    .await
    .unwrap_or_else(|err| json!({ "ok": false, "provider": "voicevox", "error": err.to_string() }));
    let _ = std::fs::remove_file(&wav_path);
    result
}

fn voicevox_base_url(settings: &Value) -> String {
    let vv = settings.get("voicevox").unwrap_or(&Value::Null);
    let host = vv.get("host").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = vv.get("port").and_then(Value::as_u64).unwrap_or(50021);
    format!("http://{}:{}", host, port)
}

fn voicevox_style_id(settings: &Value) -> u64 {
    settings
        .get("voicevox")
        .and_then(|v| v.get("styleId"))
        .and_then(Value::as_u64)
        .unwrap_or(3)
}

fn apply_voicevox_scales(query: &mut Value, settings: &Value) {
    let Some(obj) = query.as_object_mut() else {
        return;
    };
    let vv = settings.get("voicevox").unwrap_or(&Value::Null);
    for (src, dst, default_value) in [
        ("speedScale", "speedScale", 1.0),
        ("pitchScale", "pitchScale", 0.0),
        ("intonationScale", "intonationScale", 1.0),
        ("volumeScale", "volumeScale", 1.0),
    ] {
        let value = vv.get(src).and_then(Value::as_f64).unwrap_or(default_value);
        obj.insert(dst.to_string(), json!(value));
    }
}

fn temp_wav_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "komehub-voicevox-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ))
}

fn play_wav_with_powershell(path: &Path, settings: &Value) -> Value {
    // VOICEVOX 生成 WAV を SAPI 経路 (SpFileStream + SpVoice.SpeakStream) で再生する。
    // builtin と同じ AudioOutput 設定経路を共有することで、共通設定の出力デバイス
    // 選択を VOICEVOX にも適用できる。SpFileStream は PCM WAV を読めるので
    // VOICEVOX の出力 (24kHz / 16bit / mono PCM) と互換。SpeakStream は同期再生
    // (SVSFDefault=0)、再生中に PowerShell child を taskkill すれば中断される。
    let playback_path = path_for_powershell(path);
    let select_output = build_sapi_output_selection(settings);
    let script = format!(
        "$voice = New-Object -ComObject SAPI.SpVoice; {} \
         $stream = New-Object -ComObject SAPI.SpFileStream; \
         $stream.Open({}, 0, $false); \
         $voice.SpeakStream($stream, 0) | Out-Null; \
         $stream.Close();",
        select_output,
        ps_quote(&playback_path)
    );
    run_interruptible_powershell(&script, "voicevox")
}

/// SAPI の AudioOutput 設定 PowerShell スニペットを構築する。
/// outputDevice が空文字列ならシステム既定 (= 何も設定しない)、それ以外は
/// `SpVoice.GetAudioOutputs()` から token を探して `AudioOutput` に代入する。
/// 該当 token が見つからない場合は既定にフォールバック。
fn build_sapi_output_selection(settings: &Value) -> String {
    let device_id = settings
        .get("outputDevice")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if device_id.is_empty() {
        return String::new();
    }
    format!(
        "try {{ \
           foreach ($t in $voice.GetAudioOutputs()) {{ \
             if ($t.Id -eq {}) {{ $voice.AudioOutput = $t; break }} \
           }} \
         }} catch {{}};",
        ps_quote(device_id)
    )
}

fn path_for_powershell(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    if cfg!(windows) || !raw.starts_with('/') {
        return raw;
    }
    let output = Command::new("wslpath").args(["-w", &raw]).output();
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => raw,
    }
}

fn speak_builtin(settings: &Value, text: &str) -> Value {
    let builtin = settings.get("builtin").unwrap_or(&Value::Null);
    let voice = builtin.get("voice").and_then(Value::as_str).unwrap_or("");
    let rate = builtin.get("rate").and_then(Value::as_i64).unwrap_or(0).clamp(-10, 10);
    let volume = builtin.get("volume").and_then(Value::as_i64).unwrap_or(100).clamp(0, 100);
    let select_voice = if voice.trim().is_empty() {
        String::new()
    } else {
        format!("$voice.SelectVoice({});", ps_quote(voice))
    };
    let select_output = build_sapi_output_selection(settings);
    let script = format!(
        "$voice = New-Object -ComObject SAPI.SpVoice; {} {} $voice.Rate = {}; $voice.Volume = {}; $voice.Speak({}) | Out-Null;",
        select_voice,
        select_output,
        rate,
        volume,
        ps_quote(text)
    );
    run_interruptible_powershell(&script, "builtin")
}

fn get_builtin_voices() -> Value {
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $v = New-Object -ComObject SAPI.SpVoice; @($v.GetVoices() | ForEach-Object { @{name=$_.GetDescription()} }) | ConvertTo-Json -Compress";
    let output = powershell_command()
        .args(["-NoProfile", "-Command", script])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let voices: Value = serde_json::from_str(&stdout).unwrap_or_else(|_| json!([]));
            let voices = if voices.is_array() { voices } else { json!([voices]) };
            json!({ "ok": true, "provider": "builtin", "voices": voices })
        }
        Ok(output) => json!({
            "ok": false,
            "provider": "builtin",
            "error": String::from_utf8_lossy(&output.stderr).trim()
        }),
        Err(err) => json!({ "ok": false, "provider": "builtin", "error": err.to_string() }),
    }
}

/// 共通設定の出力デバイス選択肢として、SAPI が認識している audio output token の
/// {id, description} 一覧を返す。builtin / voicevox 共通で使う。bouyomi は対象外。
/// 失敗時は ok=false + 空配列で返す (UI では「システム既定のみ」表示にフォールバック)。
pub async fn get_audio_outputs() -> Value {
    tokio::task::spawn_blocking(query_audio_outputs)
        .await
        .unwrap_or_else(|err| json!({ "ok": false, "outputs": [], "error": err.to_string() }))
}

fn query_audio_outputs() -> Value {
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
        $v = New-Object -ComObject SAPI.SpVoice; \
        @($v.GetAudioOutputs() | ForEach-Object { @{id=$_.Id; description=$_.GetDescription()} }) \
        | ConvertTo-Json -Compress";
    let output = powershell_command()
        .args(["-NoProfile", "-Command", script])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // ConvertTo-Json は要素 1 つだと object を返すので array に正規化する
            let parsed: Value = serde_json::from_str(&stdout).unwrap_or_else(|_| json!([]));
            let outputs = if parsed.is_array() {
                parsed
            } else if parsed.is_null() {
                json!([])
            } else {
                json!([parsed])
            };
            json!({ "ok": true, "outputs": outputs })
        }
        Ok(output) => json!({
            "ok": false,
            "outputs": [],
            "error": String::from_utf8_lossy(&output.stderr).trim()
        }),
        Err(err) => json!({ "ok": false, "outputs": [], "error": err.to_string() }),
    }
}

fn run_interruptible_powershell(script: &str, provider: &str) -> Value {
    // stdout/stderr を継承で流すと PowerShell の native error (例:
    // 「クラスが登録されていません」+ COMException スタックトレース) がハブの
    // ログにレベル無し・タイムスタンプ無しで混入してしまう。capture して
    // [WARN] レベルでロガー経由に揃える。
    let child = powershell_command()
        .args(["-NoProfile", "-Command", script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(err) => return json!({ "ok": false, "provider": provider, "error": err.to_string() }),
    };
    let pid = child.id();
    let lock = CURRENT_PLAYBACK_PID.get_or_init(|| Mutex::new(None));
    if let Ok(mut current) = lock.lock() {
        *current = Some(pid);
    }

    let result = match child.wait_with_output() {
        Ok(output) if output.status.success() => json!({ "ok": true, "provider": provider }),
        Ok(output) => {
            let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !stderr_text.is_empty() {
                tracing::warn!("PowerShell ({}) stderr: {}", provider, stderr_text);
            }
            // UI 用の error 文字列には先頭行だけ載せる (長い stack trace は warn ログ側で確認)
            let mut error_msg = format!("playback exited with {}", output.status);
            if let Some(first_line) = stderr_text.lines().next() {
                if !first_line.is_empty() {
                    error_msg = format!("{}: {}", error_msg, first_line);
                }
            }
            json!({ "ok": false, "provider": provider, "error": error_msg })
        }
        Err(err) => json!({ "ok": false, "provider": provider, "error": err.to_string() }),
    };

    if let Some(lock) = CURRENT_PLAYBACK_PID.get() {
        if let Ok(mut current) = lock.lock() {
            if *current == Some(pid) {
                *current = None;
            }
        }
    }
    result
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn check_bouyomi(settings: &Value) -> Value {
    match bouyomi_connect(settings) {
        Ok(_) => json!({ "ok": true, "provider": "bouyomi" }),
        Err(err) => json!({ "ok": false, "provider": "bouyomi", "error": err }),
    }
}

fn send_bouyomi_talk(settings: &Value, text: &str) -> Value {
    // 1) Talk パケット送信
    let send_result = {
        let mut stream = match bouyomi_connect(settings) {
            Ok(stream) => stream,
            Err(err) => return json!({ "ok": false, "provider": "bouyomi", "error": err }),
        };
        let cfg = settings.get("bouyomi").unwrap_or(&Value::Null);
        let message = text.as_bytes();
        let mut packet = Vec::with_capacity(15 + message.len());
        packet.extend_from_slice(&1i16.to_le_bytes());
        packet.extend_from_slice(&(cfg.get("speed").and_then(Value::as_i64).unwrap_or(-1) as i16).to_le_bytes());
        packet.extend_from_slice(&(cfg.get("tone").and_then(Value::as_i64).unwrap_or(-1) as i16).to_le_bytes());
        packet.extend_from_slice(&(cfg.get("volume").and_then(Value::as_i64).unwrap_or(-1) as i16).to_le_bytes());
        packet.extend_from_slice(&(cfg.get("voice").and_then(Value::as_i64).unwrap_or(0) as i16).to_le_bytes());
        packet.push(0);
        packet.extend_from_slice(&(message.len() as u32).to_le_bytes());
        packet.extend_from_slice(message);
        stream.write_all(&packet)
    };
    if let Err(err) = send_result {
        return json!({ "ok": false, "provider": "bouyomi", "error": err.to_string() });
    }

    // OFF / Clear 時に外から確実に止められるよう、最後に Talk を送った設定を保持。
    let lock = LAST_BOUYOMI_SETTINGS.get_or_init(|| Mutex::new(None));
    if let Ok(mut current) = lock.lock() {
        *current = Some(settings.clone());
    }

    // 2) 完了 polling: 棒読みちゃんの公式コマンド
    //    - GetRemainTasks (0x0130) → u32 LE 4 byte: 待機キュー数
    //    - GetNowPlaying  (0x0120) → 1 byte (0/1): 再生中か
    //    両方 0 になったら「空かつ非再生」= 完了。
    //    Talk 送信直後は bouyomi-chan が処理を始めるまで一瞬だけ両方 0 を返す race が
    //    あるため、最初に 200ms 待ってから polling を開始する。
    std::thread::sleep(Duration::from_millis(200));

    let max_wait = Duration::from_secs(180); // 異常に長文の保険
    let start = Instant::now();
    loop {
        if start.elapsed() > max_wait {
            tracing::warn!("bouyomi: completion polling timed out after {:?}", max_wait);
            break;
        }
        match bouyomi_busy(settings) {
            Some(true) => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Some(false) => break,
            None => {
                // bouyomi-chan が応答しない (落ちた/プロトコル mismatch) → 上限まで待っても
                // 意味がないので、フェイルセーフに 1 件ぶん相当の time-estimate で待ってから抜ける。
                tracing::warn!(
                    "bouyomi: status query unreachable, falling back to time estimate"
                );
                let chars = text.chars().count() as u64;
                let speed = settings
                    .get("bouyomi")
                    .and_then(|v| v.get("speed"))
                    .and_then(Value::as_i64)
                    .map(|s| if s < 0 { 100 } else { s.max(20) as u64 })
                    .unwrap_or(100);
                // 標準速度で 180ms/char。speed=100 で 1 文字 180ms、speed=200 で 90ms。
                let ms_per_char = (180 * 100) / speed.max(1);
                let estimated = Duration::from_millis(
                    (chars * ms_per_char).clamp(1500, 120_000),
                );
                std::thread::sleep(estimated);
                break;
            }
        }
    }

    json!({ "ok": true, "provider": "bouyomi" })
}

/// 棒読みちゃんが処理中 (キューに残あり OR 現在再生中) なら Some(true)、空闲なら Some(false)。
/// 接続失敗 / プロトコル不一致なら None (呼び出し側で fallback)。
/// GetRemainTasks (0x0130, 4 byte) と GetNowPlaying (0x0120, 1 byte) を両方確認する。
fn bouyomi_busy(settings: &Value) -> Option<bool> {
    let remain = bouyomi_query_u32(settings, 0x0130i16)?;
    if remain > 0 {
        return Some(true);
    }
    let playing = bouyomi_query_u8(settings, 0x0120i16)?;
    Some(playing != 0)
}

fn bouyomi_query_u32(settings: &Value, command: i16) -> Option<u32> {
    let mut stream = bouyomi_connect(settings).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
    if stream.write_all(&command.to_le_bytes()).is_err() {
        return None;
    }
    let mut buf = [0u8; 4];
    if stream.read_exact(&mut buf).is_err() {
        return None;
    }
    Some(u32::from_le_bytes(buf))
}

fn bouyomi_query_u8(settings: &Value, command: i16) -> Option<u8> {
    let mut stream = bouyomi_connect(settings).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
    if stream.write_all(&command.to_le_bytes()).is_err() {
        return None;
    }
    let mut buf = [0u8; 1];
    if stream.read_exact(&mut buf).is_err() {
        return None;
    }
    Some(buf[0])
}

fn send_bouyomi_command(settings: &Value, command: i16) -> Value {
    let mut stream = match bouyomi_connect(settings) {
        Ok(stream) => stream,
        Err(err) => return json!({ "ok": false, "provider": "bouyomi", "error": err }),
    };
    match stream.write_all(&command.to_le_bytes()) {
        Ok(_) => json!({ "ok": true, "provider": "bouyomi", "command": command }),
        Err(err) => json!({ "ok": false, "provider": "bouyomi", "error": err.to_string() }),
    }
}

fn bouyomi_connect(settings: &Value) -> Result<TcpStream, String> {
    let cfg = settings.get("bouyomi").unwrap_or(&Value::Null);
    let host = cfg.get("host").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = cfg.get("port").and_then(Value::as_u64).unwrap_or(50001);
    let addr = format!("{}:{}", host, port);
    let socket = addr
        .to_socket_addrs()
        .map_err(|err| err.to_string())?
        .next()
        .ok_or_else(|| "address not found".to_string())?;
    // 棒読みちゃんは 127.0.0.1 が想定なので 1 秒で十分。落ちている時にコメントが連続して
    // 流入してもキューが詰まらないようにする (Unreachable 化後は enqueue_comment が
    // この関数を呼ばないので、想定外の事態以外で 1 秒待つことはない)。
    TcpStream::connect_timeout(&socket, Duration::from_secs(1)).map_err(|err| err.to_string())
}

#[cfg(test)]
mod health_tests {
    use super::*;

    /// 同一テストプロセス内で health 状態が他テストに漏れないよう、専用の provider 名で
    /// 直接 slot を mutate せず、provider="bouyomi" / "voicevox" を順に通す形で書く。
    /// (テスト間の static 共有を許容しつつ、各テスト内で確定値まで遷移させる)

    #[test]
    fn builtin_health_is_always_ok() {
        // builtin は管理対象外で、状態問い合わせは常に Ok を返す
        let h = read_health("builtin");
        assert_eq!(h.status, HealthStatus::Ok);
        assert_eq!(h.last_error, None);
    }

    #[test]
    fn write_and_read_voicevox_health() {
        // 起動状態 (Ok)
        let changed = write_health("voicevox", HealthStatus::Ok, None);
        assert!(changed);
        let h = read_health("voicevox");
        assert_eq!(h.status, HealthStatus::Ok);

        // 落ちた状態 (Unreachable + エラー)
        let changed = write_health(
            "voicevox",
            HealthStatus::Unreachable,
            Some("connection refused".to_string()),
        );
        assert!(changed);
        let h = read_health("voicevox");
        assert_eq!(h.status, HealthStatus::Unreachable);
        assert_eq!(h.last_error.as_deref(), Some("connection refused"));

        // 同じ状態を書き直しても changed=false (no-op で SSE flood を防ぐ)
        let changed = write_health(
            "voicevox",
            HealthStatus::Unreachable,
            Some("connection refused".to_string()),
        );
        assert!(!changed);

        // テスト間で漏れないよう Ok に戻す
        write_health("voicevox", HealthStatus::Ok, None);
    }

    #[test]
    fn state_includes_provider_status_and_error() {
        write_health(
            "bouyomi",
            HealthStatus::Unreachable,
            Some("timeout".to_string()),
        );
        let settings = json!({
            "enabled": true,
            "provider": "bouyomi",
        });
        let s = state(&settings);
        assert_eq!(s.get("provider").and_then(Value::as_str), Some("bouyomi"));
        assert_eq!(
            s.get("providerStatus").and_then(Value::as_str),
            Some("unreachable")
        );
        assert_eq!(
            s.get("providerError").and_then(Value::as_str),
            Some("timeout")
        );
        // テスト間で漏れないよう Ok に戻す
        write_health("bouyomi", HealthStatus::Ok, None);
    }

    #[test]
    fn state_for_builtin_reports_ok() {
        let settings = json!({
            "enabled": true,
            "provider": "builtin",
        });
        let s = state(&settings);
        assert_eq!(
            s.get("providerStatus").and_then(Value::as_str),
            Some("ok")
        );
    }

    #[test]
    fn unknown_provider_treated_as_ok() {
        // 念のため unknown の provider 名でも write_health が落ちないこと確認
        let changed = write_health("unknown", HealthStatus::Unreachable, None);
        assert!(!changed);
        let h = read_health("unknown");
        assert_eq!(h.status, HealthStatus::Ok);
    }

    #[test]
    fn default_settings_has_empty_output_device() {
        // outputDevice の既定はシステム既定 (空文字列)
        let s = default_settings();
        assert_eq!(
            s.get("outputDevice").and_then(Value::as_str),
            Some("")
        );
    }

    #[test]
    fn build_sapi_output_selection_empty_for_default() {
        // 空文字列 = システム既定 → SetOutput を呼ばない (空 string)
        let settings = json!({ "outputDevice": "" });
        assert_eq!(build_sapi_output_selection(&settings), "");
        // outputDevice キー無しでも空
        let settings = json!({});
        assert_eq!(build_sapi_output_selection(&settings), "");
        // 空白だけでも空扱い
        let settings = json!({ "outputDevice": "   " });
        assert_eq!(build_sapi_output_selection(&settings), "");
    }

    #[test]
    fn build_sapi_output_selection_includes_device_id() {
        let settings = json!({
            "outputDevice": "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\AudioOutput\\TokenEnums\\MMAudioOut\\Speakers"
        });
        let snippet = build_sapi_output_selection(&settings);
        assert!(snippet.contains("foreach"));
        assert!(snippet.contains("$voice.AudioOutput = $t"));
        assert!(snippet.contains("Speakers"));
    }

    #[test]
    fn build_sapi_output_selection_escapes_quote() {
        // PowerShell single-quote escaping (' → '')
        let settings = json!({ "outputDevice": "id'with'quote" });
        let snippet = build_sapi_output_selection(&settings);
        assert!(snippet.contains("'id''with''quote'"));
    }
}
