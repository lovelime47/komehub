//! コメント通知設定の正本管理 (Phase C 〜)。
//!
//! AppConfig.notification (= JSON) と CURRENT_NOTIFICATION_SETTINGS (= hot-swap) の
//! 2 表現を扱う。 既存 `crate::tts` の normalize/merge/update_current パターンを踏襲。
//!
//! 構造 (JS 側 NOTIFICATION_EVENT_DEFS と 1:1):
//! ```json
//! {
//!   "enabled": false, "paused": false,
//!   "provider": "builtin", "outputDevice": "",
//!   "events": {
//!     "<id>": {
//!       "enabled": true,
//!       "sound": { "enabled": true, "file": "", "volume": 0.7 },
//!       "tts":   { "enabled": true, "template": "" }
//!     },
//!     ...
//!   }
//! }
//! ```

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

/// 8 イベント id。 JS 側 NOTIFICATION_EVENT_DEFS と 1:1。
pub const EVENT_IDS: &[&str] = &[
    "first_seen",
    "revisit",
    "comeback",
    "latecomer",
    "superchat",
    "new_member",
    "member_gift",
    "moderator",
];

/// per-event default TTS テンプレ文言 (= 「変数も含めて何を読み上げるか」 の正本)。
/// JS UI の placeholder 表示 / Rust 側の TTS 文言生成のどちらもここを参照する。
/// 旧 JS NOTIFICATION_EVENT_DEFS.tplDefault と旧 build_notification_text の hardcoded
/// fallback の **二重正本** を解消するために 2026-05-17 Rust 集約。 JS 側は napi
/// get_notification_event_defaults で読み取る。
const EVENT_TEMPLATE_DEFAULTS: &[(&str, &str)] = &[
    ("first_seen", "しょけんの{name} さんがコメントしました"),
    ("revisit", "{name} さんが {daysAway} 日ぶりに帰ってきました"),
    ("comeback", ""),
    ("latecomer", "{name} さんがはつコメしました"),
    ("superchat", "{name} さんから {amount} のスパチャです"),
    ("new_member", ""),
    ("member_gift", "{name} さんが {tier} を{amount}ギフトしました"),
    ("moderator", " (モデレータ)の{name} さん: {message}"),
];

/// per-event default 通知音 preset id (= effects-overlay/notification-sounds/<file_name> を指す)。
/// 旧 JS NOTIFICATION_EVENT_DEFS.soundPreset の唯一正本。
const EVENT_SOUND_PRESET_DEFAULTS: &[(&str, &str)] = &[
    ("first_seen", "chime"),
    ("revisit", "bell"),
    ("comeback", "sparkle"),
    ("latecomer", "bell"),
    ("superchat", "coin"),
    ("new_member", "fanfare"),
    ("member_gift", "coin"),
    ("moderator", "glass"),
];

/// effects-overlay/ の絶対 path。 napi init で set されてから normalize 等が呼ばれる前提。
/// default_sound_file_for() で preset id → 絶対 file path を解決するために使う。
static OVERLAY_DIR: OnceLock<PathBuf> = OnceLock::new();

/// napi_bridge::init から ModelQueue 起動前に 1 度だけ呼ぶ。 既に set 済なら何もしない。
pub fn set_overlay_dir(dir: PathBuf) {
    let _ = OVERLAY_DIR.set(dir);
}

/// このイベントの default TTS テンプレ文言を返す (= unknown id なら "")。
pub fn default_template_for(event_id: &str) -> &'static str {
    EVENT_TEMPLATE_DEFAULTS
        .iter()
        .find(|(id, _)| *id == event_id)
        .map(|(_, tpl)| *tpl)
        .unwrap_or("")
}

/// このイベントの default 通知音 preset id を返す (= unknown id なら "")。
pub fn default_sound_preset_id_for(event_id: &str) -> &'static str {
    EVENT_SOUND_PRESET_DEFAULTS
        .iter()
        .find(|(id, _)| *id == event_id)
        .map(|(_, p)| *p)
        .unwrap_or("")
}

/// このイベントの default 通知音 file の絶対 path を返す。 preset 未配置 / overlay_dir
/// 未設定 のいずれかなら空文字列 (= 「未設定」 扱い、 should_fire_sound で false 化)。
fn default_sound_file_for(event_id: &str) -> String {
    let preset_id = default_sound_preset_id_for(event_id);
    if preset_id.is_empty() {
        return String::new();
    }
    let Some(overlay_dir) = OVERLAY_DIR.get() else {
        return String::new();
    };
    let presets_dir = overlay_dir.join("notification-sounds");
    let presets = crate::notification_sound::list_presets(presets_dir.as_path());
    presets
        .iter()
        .find(|p| p.id == preset_id && p.available)
        .map(|p| p.file_path.clone())
        .unwrap_or_default()
}

fn default_event_settings(event_id: &str) -> Value {
    json!({
        "enabled": true,
        "sound": {
            "enabled": true,
            "file": default_sound_file_for(event_id),
            "volume": 0.7
        },
        "tts": {
            "enabled": true,
            "template": default_template_for(event_id)
        }
    })
}

fn default_settings() -> Value {
    let mut events = serde_json::Map::new();
    for id in EVENT_IDS {
        events.insert(id.to_string(), default_event_settings(id));
    }
    // paused は永続化しないので default_settings には含めない (= runtime NOTIFICATION_PAUSED)
    json!({
        "enabled": false,
        "provider": "builtin",
        "outputDevice": "",
        // VOICEVOX 詳細 (= 通知だけの speaker / style / speed)。 host / port は持たない =
        // TTS 側 (= CURRENT_TTS_SETTINGS.voicevox) を共有する設計 (= UI で「コメント読み上げ
        // 側で設定」 と表示)。 dispatch で merge してから NotificationJob に渡す。
        "voicevox": {
            "speakerUuid": "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9",
            "styleId": 3,
            "speedScale": 1.0
        },
        // 棒読みちゃん詳細 (= 通知だけの speed/tone/volume/voice、 -1 は棒読み側設定維持)。
        // executablePath / host / port は持たない = TTS 側 (= CURRENT_TTS_SETTINGS.bouyomi)
        // を共有する設計。 UI で「コメント読み上げ側で設定」 と表示。
        "bouyomi": {
            "speed": -1,
            "tone": -1,
            "volume": -1,
            "voice": 0
        },
        // 内蔵 (SAPI) 詳細 (= 通知だけの voice / rate / volume)。
        "builtin": {
            "voice": "",
            "rate": 0,
            "volume": 100
        },
        "events": Value::Object(events)
    })
}

/// Option<Value> をデフォルト値合流済の Value に整える。 missing field を全て補う。
pub fn normalize(stored: Option<Value>) -> Value {
    let mut base = default_settings();
    if let Some(patch) = stored {
        merge_in_place(&mut base, patch);
    }
    base
}

/// 既存 Value に patch を deep merge する (= scalar は上書き、 object は再帰、 array は上書き)。
pub fn merge(base: &mut Value, patch: Value) {
    merge_in_place(base, patch);
}

fn merge_in_place(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_obj), Value::Object(patch_obj)) => {
            for (k, v) in patch_obj {
                match base_obj.get_mut(&k) {
                    Some(existing) if existing.is_object() && v.is_object() => {
                        merge_in_place(existing, v);
                    }
                    _ => {
                        base_obj.insert(k, v);
                    }
                }
            }
        }
        (base_slot, patch) => {
            *base_slot = patch;
        }
    }
}

static CURRENT_NOTIFICATION_SETTINGS: OnceLock<Mutex<Value>> = OnceLock::new();

fn settings_slot() -> &'static Mutex<Value> {
    CURRENT_NOTIFICATION_SETTINGS.get_or_init(|| Mutex::new(default_settings()))
}

/// 現在の正本設定を JSON Value で返す (= clone)。
pub fn current_settings() -> Value {
    settings_slot().lock().map(|g| g.clone()).unwrap_or_else(|_| default_settings())
}

/// hot-swap: ModelQueue から SetNotificationXxx の度に呼ばれる。
pub fn update_current_settings(value: Value) {
    if let Ok(mut g) = settings_slot().lock() {
        *g = value;
    }
}

/// 通知 paused (= 一時停止) は永続化せずプロセスメモリのみ保持する (= 「セッション内一時停止」
/// の意味、 ハブ再起動で必ず解除される)。 OFF (= enabled=false) でも reset する
/// (= SetNotificationEnabled handler 参照)。
static NOTIFICATION_PAUSED: AtomicBool = AtomicBool::new(false);

pub fn is_paused() -> bool {
    NOTIFICATION_PAUSED.load(Ordering::SeqCst)
}

pub fn set_paused(paused: bool) {
    NOTIFICATION_PAUSED.store(paused, Ordering::SeqCst);
}

/// UI 向けサマリ (= apps card のバッジで使う件数 + provider 等)。 paused は runtime
/// (= NOTIFICATION_PAUSED) から取る、 settings.paused は使わない。
pub fn state(settings: &Value) -> Value {
    let events = settings.get("events").and_then(Value::as_object);
    let total = EVENT_IDS.len() as u32;
    let enabled_count = events
        .map(|map| {
            EVENT_IDS
                .iter()
                .filter(|id| {
                    map.get(**id)
                        .and_then(|ev| ev.get("enabled"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .count() as u32
        })
        .unwrap_or(0);
    json!({
        "enabled": settings.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "paused": is_paused(),
        "provider": settings.get("provider").and_then(Value::as_str).unwrap_or("builtin"),
        "enabledEventCount": enabled_count,
        "totalEventCount": total,
    })
}

/// イベント別 settings を引く。 unknown id なら None。
pub fn event_settings<'a>(settings: &'a Value, event_id: &str) -> Option<&'a Value> {
    settings.get("events")?.get(event_id)
}

/// 「このイベント、 通知 TTS を発火する?」 の判定 (= master / paused / event.enabled /
/// event.tts.enabled のすべてが OK のときだけ true)。 通知 provider が "none" (= 読み上げ無し)
/// なら全イベント TTS 発火を抑制する (= 通知音だけ鳴らす運用)。
pub fn should_fire_tts(settings: &Value, event_id: &str) -> bool {
    if !is_master_active(settings) {
        return false;
    }
    // provider="none" は全イベント TTS スキップ (= 通知音は別経路 should_fire_sound が制御)
    let provider = settings.get("provider").and_then(Value::as_str).unwrap_or("builtin");
    if provider == "none" {
        return false;
    }
    let ev = match event_settings(settings, event_id) {
        Some(v) => v,
        None => return false,
    };
    if !ev.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    ev.get("tts")
        .and_then(|t: &Value| t.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 「このイベント、 通知音を鳴らす?」 の判定 (= master / paused / event.enabled /
/// event.sound.enabled / sound.file 非空 のすべてが OK のときだけ true)。 Phase D。
pub fn should_fire_sound(settings: &Value, event_id: &str) -> bool {
    if !is_master_active(settings) {
        return false;
    }
    let ev = match event_settings(settings, event_id) {
        Some(v) => v,
        None => return false,
    };
    if !ev.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    let sound = match ev.get("sound") {
        Some(s) => s,
        None => return false,
    };
    if !sound.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    let file = sound.get("file").and_then(Value::as_str).unwrap_or("");
    !file.is_empty()
}

/// このイベントの通知音ファイルパス + 音量を取り出す。 sound 未設定 / file 空なら None。
pub fn event_sound(settings: &Value, event_id: &str) -> Option<(String, f32)> {
    let sound = event_settings(settings, event_id)?.get("sound")?;
    let file = sound.get("file").and_then(Value::as_str)?;
    if file.is_empty() {
        return None;
    }
    let volume = sound
        .get("volume")
        .and_then(Value::as_f64)
        .unwrap_or(0.7) as f32;
    Some((file.to_string(), volume))
}

fn is_master_active(settings: &Value) -> bool {
    if !settings.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    // paused は runtime (= NOTIFICATION_PAUSED) から取る
    if is_paused() {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // NOTIFICATION_PAUSED は process-wide な AtomicBool。 並列 test で互いに干渉
    // しないよう「paused に触る test」 はこの mutex でシリアル化する。
    static PAUSED_TEST_MUTEX: StdMutex<()> = StdMutex::new(());

    #[test]
    fn default_has_all_events() {
        let s = default_settings();
        let events = s.get("events").unwrap().as_object().unwrap();
        for id in EVENT_IDS {
            assert!(events.contains_key(*id), "missing event: {}", id);
        }
    }

    #[test]
    fn normalize_fills_missing_fields() {
        let stored = json!({ "enabled": true });
        let n = normalize(Some(stored));
        assert_eq!(n.get("enabled").unwrap().as_bool().unwrap(), true);
        assert_eq!(n.get("provider").unwrap().as_str().unwrap(), "builtin");
        assert!(n.get("events").unwrap().is_object());
    }

    #[test]
    fn merge_deep_object_preserves_siblings() {
        let mut base = default_settings();
        let patch = json!({ "events": { "first_seen": { "enabled": false } } });
        merge(&mut base, patch);
        let fs = &base["events"]["first_seen"];
        assert_eq!(fs["enabled"].as_bool().unwrap(), false);
        assert_eq!(fs["sound"]["volume"].as_f64().unwrap(), 0.7);
    }

    #[test]
    fn should_fire_tts_requires_master_on() {
        let mut s = default_settings();
        s["enabled"] = json!(false);
        assert!(!should_fire_tts(&s, "first_seen"));
    }

    #[test]
    fn should_fire_tts_requires_event_on() {
        let mut s = default_settings();
        s["enabled"] = json!(true);
        s["events"]["first_seen"]["enabled"] = json!(false);
        assert!(!should_fire_tts(&s, "first_seen"));
    }

    #[test]
    fn should_fire_tts_blocked_when_paused() {
        let _guard = PAUSED_TEST_MUTEX.lock().unwrap();
        let mut s = default_settings();
        s["enabled"] = json!(true);
        set_paused(true);
        let result = should_fire_tts(&s, "first_seen");
        set_paused(false);  // 他 test のため reset
        assert!(!result);
    }

    #[test]
    fn should_fire_tts_unknown_event_id() {
        let mut s = default_settings();
        s["enabled"] = json!(true);
        assert!(!should_fire_tts(&s, "nonexistent"));
    }

    #[test]
    fn should_fire_tts_happy_path() {
        let _guard = PAUSED_TEST_MUTEX.lock().unwrap();
        set_paused(false);  // 並列 test で paused=true が残ってる可能性に保険
        let mut s = default_settings();
        s["enabled"] = json!(true);
        assert!(should_fire_tts(&s, "first_seen"));
    }

    #[test]
    fn should_fire_tts_skipped_when_provider_is_none() {
        let mut s = default_settings();
        s["enabled"] = json!(true);
        // event.tts.enabled は true のまま、 provider="none" だけで全イベント TTS 抑制
        s["events"]["first_seen"]["tts"]["enabled"] = json!(true);
        s["provider"] = json!("none");
        assert!(!should_fire_tts(&s, "first_seen"));
    }

    #[test]
    fn state_summarizes_enabled_count() {
        let mut s = default_settings();
        s["enabled"] = json!(true);
        s["events"]["first_seen"]["enabled"] = json!(false);
        s["events"]["revisit"]["enabled"] = json!(false);
        let st = state(&s);
        assert_eq!(st["enabledEventCount"].as_u64().unwrap(), 6);
        assert_eq!(st["totalEventCount"].as_u64().unwrap(), 8);
    }
}
