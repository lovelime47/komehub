//! 通知音再生 (Phase D)。 rodio + cpal で wav/mp3/ogg/flac を再生する。
//!
//! 設計:
//! - 出力デバイスは指定可能だが、 Phase D-1 では cpal の **name match** で検索し、
//!   一致しなければシステム既定にフォールバックする (= SAPI token とは別系統のため、
//!   ユーザー UI で TTS と同じ「outputDevice」 文字列を流しても通知音側では best-effort)。
//! - 再生は **同期** (= sink.sleep_until_end で完了まで block)。 呼出側で
//!   tokio::task::spawn_blocking に乗せる前提。 これにより
//!   「通知音 → 完了待ち → 通知 TTS」 のシーケンシャル再生が成立する。

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, OutputStream, Sink};
use serde::Serialize;

/// プリセット音源 8 種 (Phase D-2)。 effects-overlay/notification-sounds/ に置かれた
/// CC0 音源ファイルを指す。 ファイル不在のときも UI に「未配置」 として表示する。
struct PresetMeta {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    description: &'static str,
    file_name: &'static str,
}

const PRESET_METADATA: &[PresetMeta] = &[
    PresetMeta { id: "chime",   name: "チャイム",         icon: "🔔", description: "やわらかいチャイム音",       file_name: "chime.mp3" },
    PresetMeta { id: "bell",    name: "ベル",             icon: "🛎",  description: "鈴の音",                     file_name: "bell.mp3" },
    PresetMeta { id: "pop",     name: "ポップ",           icon: "💫", description: "短い「ポン」 音",            file_name: "pop.mp3" },
    PresetMeta { id: "coin",    name: "コイン",           icon: "🪙", description: "コイン獲得風",               file_name: "coin.mp3" },
    PresetMeta { id: "fanfare", name: "ファンファーレ",   icon: "🎺", description: "祝福のファンファーレ",       file_name: "game-start.mp3" },
    PresetMeta { id: "sparkle", name: "キラキラ",         icon: "✨", description: "高音きらきら",               file_name: "sparkle-magic.mp3" },
    PresetMeta { id: "drum",    name: "ドラム",           icon: "🥁", description: "低音ドラム",                 file_name: "drum.mp3" },
    PresetMeta { id: "glass",   name: "ガラス",           icon: "🔮", description: "ガラス系の透明感ある音",     file_name: "glass-ting.mp3" },
];

#[derive(Serialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub file_name: String,
    pub file_path: String,
    pub available: bool,
}

/// プリセット一覧を返す。 dir = effects-overlay/notification-sounds/ の絶対パス。
/// ファイル存在判定して available フラグを付ける (= 未配置でも UI で「未配置」 表示するため)。
pub fn list_presets(dir: &Path) -> Vec<Preset> {
    PRESET_METADATA
        .iter()
        .map(|m| {
            let file_path = dir.join(m.file_name);
            let available = file_path.exists();
            Preset {
                id: m.id.to_string(),
                name: m.name.to_string(),
                icon: m.icon.to_string(),
                description: m.description.to_string(),
                file_name: m.file_name.to_string(),
                file_path: file_path.to_string_lossy().to_string(),
                available,
            }
        })
        .collect()
}

/// 通知音を 1 ファイル再生する。 完了まで block。
///
/// volume: 0.0 〜 1.0 (= 範囲外は clamp)。
/// output_device: 空文字列なら システム既定。 cpal の name match で検索、 一致なしなら 既定。
///
/// 失敗時は Err(String)。 致命的ではないので呼出側で warn ログだけ出す想定。
pub fn play_notification_sound(
    file_path: &str,
    volume: f32,
    output_device: &str,
) -> Result<(), String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("notification sound file not found: {}", file_path));
    }

    let device = find_output_device(output_device);
    let (_stream, stream_handle) = match device {
        Some(d) => OutputStream::try_from_device(&d)
            .map_err(|e| format!("rodio OutputStream::try_from_device failed: {}", e))?,
        None => OutputStream::try_default()
            .map_err(|e| format!("rodio OutputStream::try_default failed: {}", e))?,
    };

    let file = File::open(path).map_err(|e| format!("open sound file failed: {}", e))?;
    let source = Decoder::new(BufReader::new(file))
        .map_err(|e| format!("decode sound file failed: {}", e))?;

    let sink = Sink::try_new(&stream_handle)
        .map_err(|e| format!("rodio Sink::try_new failed: {}", e))?;
    sink.set_volume(volume.clamp(0.0, 1.0));
    sink.append(source);
    sink.sleep_until_end();
    Ok(())
}

/// cpal の output device を name で検索する。 空文字 / 該当なし は None。
///
/// 2 段階 fallback (= 設定 UI の outputDevice 値は TTS と共有のため、 SAPI token が
/// 渡されるケースが大半):
/// 1. 渡された name が cpal device name そのものなら直接 match
/// 2. SAPI token なら SAPI_TO_CPAL_MAP を引いて cpal name に変換してから match
fn find_output_device(name: &str) -> Option<rodio::cpal::Device> {
    if name.is_empty() {
        return None;
    }
    if let Some(dev) = find_output_device_by_cpal_name(name) {
        return Some(dev);
    }
    if let Some(cpal_name) = lookup_sapi_token(name) {
        if let Some(dev) = find_output_device_by_cpal_name(&cpal_name) {
            return Some(dev);
        }
    }
    None
}

fn find_output_device_by_cpal_name(name: &str) -> Option<rodio::cpal::Device> {
    let host = rodio::cpal::default_host();
    let devices = host.output_devices().ok()?;
    for dev in devices {
        if let Ok(dev_name) = dev.name() {
            if dev_name == name {
                return Some(dev);
            }
        }
    }
    None
}

/// SAPI token → cpal device name の対応表 (= Phase D-3 デバイス橋渡し)。
/// SAPI と cpal は同じ物理デバイス (= Windows MMDevice) を別 ID で呼ぶため、
/// description (= friendly name) で string match して 1 つの outputDevice 値で
/// 両系統 (= TTS と通知音) が同じデバイスを使えるようにする。
static SAPI_TO_CPAL_MAP: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn map_slot() -> &'static Mutex<HashMap<String, String>> {
    SAPI_TO_CPAL_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lookup_sapi_token(token: &str) -> Option<String> {
    map_slot().lock().ok().and_then(|g| g.get(token).cloned())
}

/// SAPI token → cpal name の table を構築する。 PowerShell SAPI を 1 回起動する
/// ので数百 ms オーダー。 起動時 1 回 + UI mousedown で必要時 refresh の想定。
pub async fn refresh_device_map() {
    let sapi_outputs = crate::tts::get_audio_outputs().await;
    let outputs = sapi_outputs
        .get("outputs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let cpal_names = list_output_device_names();
    let mut new_map: HashMap<String, String> = HashMap::new();
    for entry in outputs {
        let token = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let description = entry
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if token.is_empty() || description.is_empty() {
            continue;
        }
        if let Some(matched) = cpal_names.iter().find(|n| n.as_str() == description) {
            new_map.insert(token, matched.clone());
        }
    }
    let count = new_map.len();
    if let Ok(mut g) = map_slot().lock() {
        *g = new_map;
    }
    tracing::info!(
        "notification sound device map refreshed: {} entries (SAPI tokens mapped to cpal names)",
        count
    );
}

/// テスト / 動作確認用: 現在の map サイズ を返す。
pub fn device_map_size() -> usize {
    map_slot().lock().map(|g| g.len()).unwrap_or(0)
}

/// 利用可能な出力デバイス名一覧を返す (= UI の select オプション用)。
/// 取得失敗時は空 Vec、 失敗はログのみ。
pub fn list_output_device_names() -> Vec<String> {
    let host = rodio::cpal::default_host();
    let devices = match host.output_devices() {
        Ok(d) => d,
        Err(err) => {
            tracing::warn!("cpal output_devices failed: {}", err);
            return Vec::new();
        }
    };
    devices
        .filter_map(|d| d.name().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_err() {
        let result = play_notification_sound("nonexistent.wav", 0.5, "");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("not found"), "got: {}", msg);
    }

    #[test]
    fn volume_clamped_to_range() {
        // 範囲外 volume が panic しない (= 範囲チェックの sanity)。
        // 実ファイル無いので Err になるが、 clamp 前に bail する。
        let _ = play_notification_sound("nonexistent.wav", -5.0, "");
        let _ = play_notification_sound("nonexistent.wav", 99.0, "");
    }

    #[test]
    fn find_device_returns_none_for_empty_name() {
        assert!(find_output_device("").is_none());
    }

    #[test]
    fn find_device_returns_none_for_unknown_name() {
        assert!(find_output_device("definitely-not-a-real-audio-device-xyz123").is_none());
    }

    #[test]
    fn list_output_devices_does_not_panic() {
        // CI 環境では空でも OK、 panic しなければよい。
        let _ = list_output_device_names();
    }

    #[test]
    fn list_presets_returns_all_eight() {
        let dir = std::path::Path::new("nonexistent-dir-for-test");
        let presets = list_presets(dir);
        assert_eq!(presets.len(), 8);
        let ids: Vec<&str> = presets.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"chime"));
        assert!(ids.contains(&"bell"));
        assert!(ids.contains(&"pop"));
        assert!(ids.contains(&"coin"));
        assert!(ids.contains(&"fanfare"));
        assert!(ids.contains(&"sparkle"));
        assert!(ids.contains(&"drum"));
        assert!(ids.contains(&"glass"));
    }

    #[test]
    fn list_presets_marks_unavailable_when_files_missing() {
        let dir = std::path::Path::new("nonexistent-dir-for-test-unique-xyz");
        let presets = list_presets(dir);
        assert!(presets.iter().all(|p| !p.available));
        assert!(presets.iter().all(|p| !p.file_path.is_empty()));
    }

    #[test]
    fn device_map_starts_empty() {
        // 他テストとの順序差で 0 を保証できないため、 「panic しない」 だけ確認
        let _ = device_map_size();
    }

    #[test]
    fn lookup_unknown_token_returns_none() {
        assert!(lookup_sapi_token("definitely-not-a-real-sapi-token-xyz").is_none());
    }

    #[test]
    fn lookup_empty_returns_none() {
        // 空文字 token は map に入っていないので None
        assert!(lookup_sapi_token("").is_none());
    }

    #[test]
    fn list_presets_marks_available_when_file_exists() {
        let tmpdir = std::env::temp_dir().join(format!("komehub-preset-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmpdir);
        let target = tmpdir.join("chime.mp3");
        std::fs::write(&target, b"fake mp3").unwrap();
        let presets = list_presets(&tmpdir);
        let chime = presets.iter().find(|p| p.id == "chime").unwrap();
        assert!(chime.available, "chime should be available when file exists");
        let bell = presets.iter().find(|p| p.id == "bell").unwrap();
        assert!(!bell.available, "bell should be unavailable when file missing");
        // cleanup
        let _ = std::fs::remove_dir_all(&tmpdir);
    }
}
