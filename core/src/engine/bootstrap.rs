use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde_json::json;

use crate::engine::effect_manager::{self, EffectManager};
use crate::engine::scene_manager::SceneManager;
use crate::state::scene::{EffectDefinition, EffectsFile, Scene, SceneTemplate};

const DEFAULT_CHAT_TEMPLATE_ID: &str = "com.comment-hub.template.framed-list-renderless";

/// お蔵入りした「リアクション連動アバター」エフェクトの ID。
/// プラグイン本体は将来の復活に備えて残すが、既定データ / 既存環境からは除去する。
const SHELVED_AVATAR_EFFECT_ID: &str = "com.comment-hub.avatar";

pub fn bootstrap_runtime_data(
    data_dir: &Path,
    app_root_dir: &Path,
    scene_manager: &SceneManager,
    effect_manager: &mut EffectManager,
) -> Result<(), String> {
    tracing::info!("bootstrap_runtime_data: starting (data_dir={:?})", data_dir);
    let defaults_dir = app_root_dir.join("electron").join("defaults");
    let scenes_dir = scene_manager.scenes_dir();
    if data_dir.join("assets").exists() && !scenes_dir.exists() {
        migrate_from_legacy(data_dir, &defaults_dir, scenes_dir)?;
    }

    if !scenes_dir.exists() {
        fs::create_dir_all(scenes_dir)
            .map_err(|e| format!("Failed to create scenes dir: {}", e))?;
        create_default_scenes(&defaults_dir, scene_manager)?;
    }

    ensure_default_effects_file(effect_manager, &defaults_dir)?;
    ensure_scene_mascot_icons(data_dir, scenes_dir)?;
    ensure_default_chat_template(scene_manager)?;
    migrate_effect_ids(effect_manager, scene_manager, &defaults_dir)?;
    remove_shelved_avatar_effect(scene_manager, effect_manager)?;

    tracing::info!("bootstrap_runtime_data: completed");
    Ok(())
}

fn ensure_default_chat_template(scene_manager: &SceneManager) -> Result<(), String> {
    let mut store = scene_manager.load_all();
    let Some(scene) = store.scenes.get_mut("chat") else {
        tracing::debug!("ensure_default_chat_template: chat scene not found, skipping");
        return Ok(());
    };
    if !scene.templates.is_empty() {
        tracing::debug!(
            "ensure_default_chat_template: skipped (already has {} templates)",
            scene.templates.len()
        );
        return Ok(());
    }

    scene.templates_enabled = true;
    scene.templates.push(SceneTemplate {
        id: DEFAULT_CHAT_TEMPLATE_ID.to_string(),
        name: DEFAULT_CHAT_TEMPLATE_ID.to_string(),
        enabled: true,
        settings: HashMap::new(),
    });
    scene.selected_template_id = DEFAULT_CHAT_TEMPLATE_ID.to_string();
    scene_manager.save_scene("chat", scene)?;
    tracing::info!("Configured default chat template: {}", DEFAULT_CHAT_TEMPLATE_ID);
    Ok(())
}

fn create_default_scenes(
    defaults_dir: &Path,
    scene_manager: &SceneManager,
) -> Result<(), String> {
    for scene_id in ["game", "singing", "chat"] {
        let scene_dir = scene_manager.scenes_dir().join(scene_id);
        if scene_dir.exists() {
            continue;
        }

        fs::create_dir_all(scene_dir.join("mascot").join("frames"))
            .map_err(|e| format!("Failed to create mascot frames dir: {}", e))?;
        fs::create_dir_all(scene_dir.join("mascot").join("particles"))
            .map_err(|e| format!("Failed to create mascot particles dir: {}", e))?;
        fs::create_dir_all(scene_dir.join("performances"))
            .map_err(|e| format!("Failed to create performances dir: {}", e))?;

        let mut scene = read_default_scene(defaults_dir, scene_id)?;
        scene.id = scene_id.to_string();
        let mascot_config = scene.mascot.clone();
        scene_manager.save_scene(scene_id, &scene)?;

        let mascot_config_json = serde_json::to_string_pretty(&mascot_config)
            .map_err(|e| format!("Failed to serialize mascot config: {}", e))?;
        fs::write(scene_dir.join("mascot").join("config.json"), mascot_config_json)
            .map_err(|e| format!("Failed to write mascot config: {}", e))?;

        // リアクションアバターのフレーム / アイコンは配信者が「素材」UI から
        // 個別にアップロードする運用。デフォルト素材は同梱しない。

        tracing::info!("Created default scene: {}", scene_id);
    }

    Ok(())
}

fn ensure_default_effects_file(effect_manager: &mut EffectManager, defaults_dir: &Path) -> Result<(), String> {
    let effects_path = effect_manager.effects_dir().join("effects.json");
    if effects_path.exists() {
        effect_manager.load_effects();
        return Ok(());
    }

    let defaults_path = defaults_dir.join("effects.json");
    let content = fs::read_to_string(&defaults_path)
        .map_err(|e| format!("Failed to read default effects.json: {}", e))?;
    fs::create_dir_all(effect_manager.effects_dir())
        .map_err(|e| format!("Failed to create effects dir: {}", e))?;
    fs::write(&effects_path, content)
        .map_err(|e| format!("Failed to write effects.json: {}", e))?;
    effect_manager.load_effects();
    tracing::info!("Created default effects.json");
    Ok(())
}

fn ensure_scene_mascot_icons(data_dir: &Path, scenes_dir: &Path) -> Result<(), String> {
    if !scenes_dir.exists() {
        return Ok(());
    }

    let legacy_icon = data_dir.join("assets").join("icon.png");
    if !legacy_icon.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(scenes_dir)
        .map_err(|e| format!("Failed to read scenes dir for icon repair: {}", e))?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let mascot_dir = entry.path().join("mascot");
        let icon_path = mascot_dir.join("icon.png");
        if icon_path.exists() {
            continue;
        }
        fs::create_dir_all(&mascot_dir)
            .map_err(|e| format!("Failed to create mascot dir for icon repair: {}", e))?;
        fs::copy(&legacy_icon, &icon_path)
            .map_err(|e| format!("Failed to repair mascot icon: {}", e))?;
    }

    Ok(())
}

fn migrate_from_legacy(
    data_dir: &Path,
    defaults_dir: &Path,
    scenes_dir: &Path,
) -> Result<(), String> {
    tracing::info!("Migrating legacy layout to scenes");
    let legacy_assets_dir = data_dir.join("assets");
    let legacy_presets_dir = data_dir.join("presets");

    let game_dir = scenes_dir.join("game");
    fs::create_dir_all(game_dir.join("performances"))
        .map_err(|e| format!("Failed to create legacy game performances dir: {}", e))?;
    copy_dir_recursive(&legacy_assets_dir, &game_dir.join("mascot"))?;

    let mut default_game_scene = read_default_scene(defaults_dir, "game")?;
    default_game_scene.id = "game".to_string();
    if let Some(legacy_config) = read_json_value(&legacy_assets_dir.join("config.json")) {
        default_game_scene.mascot = mascot_config_from_legacy(&legacy_config);
    }
    write_scene_json(&game_dir.join("scene.json"), &default_game_scene)?;

    if legacy_presets_dir.exists() {
        let presets = fs::read_dir(&legacy_presets_dir)
            .map_err(|e| format!("Failed to read legacy presets dir: {}", e))?;
        for preset in presets.flatten() {
            if !preset.path().is_dir() {
                continue;
            }
            let preset_name = preset.file_name().to_string_lossy().to_string();
            let mut scene_id = sanitize_scene_id(&preset_name);
            if scene_id == "game" {
                continue;
            }
            if scenes_dir.join(&scene_id).exists() {
                scene_id = format!("{}-{}", scene_id, effect_manager::generate_id_pub());
            }

            let new_scene_dir = scenes_dir.join(&scene_id);
            fs::create_dir_all(new_scene_dir.join("performances"))
                .map_err(|e| format!("Failed to create migrated scene performances dir: {}", e))?;
            copy_dir_recursive(&preset.path(), &new_scene_dir.join("mascot"))?;

            let mut scene = read_default_scene(defaults_dir, "game")?;
            scene.id = scene_id.clone();
            scene.name = preset_name.clone();
            if let Some(preset_config) = read_json_value(&preset.path().join("config.json")) {
                scene.mascot = mascot_config_from_legacy(&preset_config);
            }
            write_scene_json(&new_scene_dir.join("scene.json"), &scene)?;
            tracing::info!("Migrated preset: {} -> {}", preset_name, scene_id);
        }
    }

    create_default_scenes(defaults_dir, &SceneManager::new(data_dir))?;
    tracing::info!("Legacy migration complete");
    Ok(())
}

fn migrate_effect_ids(
    effect_manager: &mut EffectManager,
    scene_manager: &SceneManager,
    defaults_dir: &Path,
) -> Result<(), String> {
    effect_manager.load_effects();
    let defaults = read_default_effects(defaults_dir)?;
    let default_by_id: HashMap<String, EffectDefinition> = defaults
        .effects
        .iter()
        .cloned()
        .map(|effect| (effect.id.clone(), effect))
        .collect();
    let legacy_map = legacy_effect_id_map();

    let mut migrated_effects = effect_manager.effects().to_vec();
    let mut effects_changed = false;
    for effect in &mut migrated_effects {
        if let Some(new_id) = legacy_map.get(effect.id.as_str()) {
            effect.id = (*new_id).to_string();
            effects_changed = true;
        }
        if effect.extra.remove("type").is_some() {
            effects_changed = true;
        }
        if effect.version.is_empty() {
            effect.version = "1.0.0".to_string();
            effects_changed = true;
        }
        if effect.builtin {
            if let Some(default_effect) = default_by_id.get(&effect.id) {
                if !effect.extra.contains_key("icon") {
                    if let Some(icon) = default_effect.extra.get("icon") {
                        effect.extra.insert("icon".to_string(), icon.clone());
                        effects_changed = true;
                    }
                }
                if !effect.extra.contains_key("badgeColor") {
                    if let Some(badge_color) = default_effect.extra.get("badgeColor") {
                        effect.extra.insert("badgeColor".to_string(), badge_color.clone());
                        effects_changed = true;
                    }
                }
            }
        }
    }

    for default_effect in &defaults.effects {
        if !default_effect.builtin {
            continue;
        }
        if !migrated_effects.iter().any(|effect| effect.id == default_effect.id) {
            migrated_effects.push(default_effect.clone());
            effects_changed = true;
        }
    }

    if effects_changed {
        effect_manager.save_all_effects(migrated_effects);
        effect_manager.load_effects();
    }

    let mut scene_store = scene_manager.load_all();
    let scene_ids: Vec<String> = scene_store.scenes.keys().cloned().collect();
    for scene_id in scene_ids {
        let Some(scene) = scene_store.scenes.get_mut(&scene_id) else {
            continue;
        };
        let mut scene_changed = false;
        for performance in &mut scene.performances {
            if let Some(new_id) = legacy_map.get(performance.effect.as_str()) {
                performance.effect = (*new_id).to_string();
                scene_changed = true;
            }
        }
        if scene_changed {
            scene_manager.save_scene(&scene_id, scene)?;
            tracing::info!("Migrated scene {} to reverse-domain effect IDs", scene_id);
        }
    }

    Ok(())
}

/// リアクション連動アバター (= com.comment-hub.avatar) はクオリティ未達のため
/// お蔵入りした。既存環境のシーン performance と effects.json builtin 登録から
/// 除去する。プラグイン本体 (= effects-overlay/plugins/avatar/) は将来の復活に
/// 備えて残すため、`EffectManager::remove_effect` (= builtin 拒否 + プラグイン dir 削除)
/// は使わず、フィルタ後の一覧を `save_all_effects` で書き戻す。
///
/// 冪等: 除去対象が無ければ何もしない。新規インストールは既定データに avatar を
/// 含まないため即 no-op、 既存インストールは次回起動で 1 回除去される。
fn remove_shelved_avatar_effect(
    scene_manager: &SceneManager,
    effect_manager: &mut EffectManager,
) -> Result<(), String> {
    // 1. 全シーンの performance から avatar を除去
    let mut scene_store = scene_manager.load_all();
    let scene_ids: Vec<String> = scene_store.scenes.keys().cloned().collect();
    for scene_id in scene_ids {
        let Some(scene) = scene_store.scenes.get_mut(&scene_id) else {
            continue;
        };
        let before = scene.performances.len();
        scene
            .performances
            .retain(|perf| perf.effect != SHELVED_AVATAR_EFFECT_ID);
        if scene.performances.len() != before {
            scene_manager.save_scene(&scene_id, scene)?;
            tracing::info!(
                "Removed shelved avatar performance(s) from scene: {}",
                scene_id
            );
        }
    }

    // 2. effects.json の builtin 登録から avatar を除去 (= プラグイン dir は温存)
    if effect_manager
        .effects()
        .iter()
        .any(|e| e.id == SHELVED_AVATAR_EFFECT_ID)
    {
        let filtered: Vec<EffectDefinition> = effect_manager
            .effects()
            .iter()
            .filter(|e| e.id != SHELVED_AVATAR_EFFECT_ID)
            .cloned()
            .collect();
        effect_manager.save_all_effects(filtered);
        tracing::info!("Removed shelved avatar effect from effects.json registry");
    }

    Ok(())
}

fn legacy_effect_id_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("cracker", "com.comment-hub.cracker"),
        ("fall", "com.comment-hub.fall"),
        ("rise", "com.comment-hub.rise"),
        ("fixed", "com.comment-hub.fixed"),
        ("sprout", "com.comment-hub.sprout"),
        ("slide", "com.comment-hub.slide"),
        ("firework", "com.comment-hub.firework"),
        ("screen-overlay", "com.comment-hub.screen-overlay"),
    ])
}

fn read_default_scene(defaults_dir: &Path, scene_id: &str) -> Result<Scene, String> {
    let content = fs::read_to_string(defaults_dir.join("scenes").join(format!("{}.json", scene_id)))
        .map_err(|e| format!("Failed to read default scene {}: {}", scene_id, e))?;
    serde_json::from_str::<Scene>(&content)
        .map_err(|e| format!("Failed to parse default scene {}: {}", scene_id, e))
}

fn read_default_effects(defaults_dir: &Path) -> Result<EffectsFile, String> {
    let content = fs::read_to_string(defaults_dir.join("effects.json"))
        .map_err(|e| format!("Failed to read default effects: {}", e))?;
    serde_json::from_str::<EffectsFile>(&content)
        .map_err(|e| format!("Failed to parse default effects: {}", e))
}

fn read_json_value(path: &Path) -> Option<serde_json::Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_scene_json(path: &Path, scene: &Scene) -> Result<(), String> {
    let content = serde_json::to_string_pretty(scene)
        .map_err(|e| format!("Failed to serialize scene: {}", e))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create scene parent dir: {}", e))?;
    }
    fs::write(path, content).map_err(|e| format!("Failed to write scene json: {}", e))
}

fn mascot_config_from_legacy(config: &serde_json::Value) -> serde_json::Value {
    json!({
        "frameInterval": config_number(config, "frameInterval", 150.0),
        "reactDuration": config_number(config, "reactDuration", 2000.0),
        "particles": config.get("particles").cloned().unwrap_or_else(|| json!({})),
        "patterns": config.get("patterns").cloned().unwrap_or_else(|| json!({}))
    })
}

fn config_number(config: &serde_json::Value, key: &str, default: f64) -> serde_json::Value {
    match config.get(key).and_then(|value| value.as_f64()) {
        Some(number) => json!(number),
        None => json!(default),
    }
}

fn sanitize_scene_id(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .filter(|ch| !matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .filter(|ch| !ch.is_control())
        .collect();
    let trimmed = sanitized.trim_matches(|ch: char| ch.is_whitespace() || ch == '.');
    let normalized = trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    if normalized.is_empty() {
        "untitled".to_string()
    } else {
        normalized
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {:?}: {}", dest, e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir {:?}: {}", src, e))? {
        let entry = entry.map_err(|e| format!("Failed to read dir entry in {:?}: {}", src, e))?;
        let entry_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &dest_path)?;
        } else {
            fs::copy(&entry_path, &dest_path)
                .map_err(|e| format!("Failed to copy {:?} to {:?}: {}", entry_path, dest_path, e))?;
        }
    }
    Ok(())
}
