//! Export/Import — シーン・演出・エフェクトの ZIP エクスポート/インポート。
//!
//! EffectManager と SceneManager のデータを使い、ZIP パッケージの
//! 作成・展開・バージョン解決を行う。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use crate::engine::effect_manager::{self, is_valid_effect_id, migrate_legacy_effect_id, EffectManager};
use crate::infra::zip_utils;
use crate::state::scene::{EffectDefinition, EffectsFile, PluginManifest, Scene, SceneStore};

// ========== Export ==========

/// シーンを ZIP にエクスポートする。
pub fn export_scene(
    scene_id: &str,
    dest_path: &Path,
    scenes_dir: &Path,
    scenes: &SceneStore,
    plugins_dir: &Path,
) -> Result<(), String> {
    let scene = scenes.scenes.get(scene_id)
        .ok_or_else(|| format!("シーンが見つかりません: {}", scene_id))?;

    let file = fs::File::create(dest_path)
        .map_err(|e| format!("ZIPファイル作成失敗: {}", e))?;
    let mut writer = zip::ZipWriter::new(file);

    // scene.json
    let scene_json = serde_json::to_value(scene).unwrap_or_default();
    zip_utils::add_json_to_zip(&mut writer, "scene.json", &scene_json)?;

    let scene_dir = scenes_dir.join(scene_id);

    // mascot/
    let mascot_dir = scene_dir.join("mascot");
    if mascot_dir.exists() {
        zip_utils::add_dir_to_zip(&mut writer, &mascot_dir, "mascot/")?;
    }

    // performances/
    let perf_dir = scene_dir.join("performances");
    if perf_dir.exists() {
        zip_utils::add_dir_to_zip(&mut writer, &perf_dir, "performances/")?;
    }

    // 使用するエフェクト定義を収集
    let used_effects = collect_unique_scene_effects(scene, &scenes.effects);
    if !used_effects.is_empty() {
        let effects_file = EffectsFile { effects: used_effects.clone() };
        let effects_json = serde_json::to_value(&effects_file).unwrap_or_default();
        zip_utils::add_json_to_zip(&mut writer, "effects/effects.json", &effects_json)?;

        // 各エフェクトのプラグインディレクトリを同梱
        for eff in &used_effects {
            add_effect_plugin_to_zip(&mut writer, &eff.id, &format!("plugins/{}/", eff.id), plugins_dir)?;
        }
    }

    writer.finish().map_err(|e| format!("ZIP完了失敗: {}", e))?;
    tracing::info!("Exported scene: {}", scene_id);
    Ok(())
}

/// 演出を ZIP にエクスポートする。
pub fn export_performance(
    scene_id: &str,
    performance_id: &str,
    dest_path: &Path,
    scenes_dir: &Path,
    scenes: &SceneStore,
    plugins_dir: &Path,
) -> Result<(), String> {
    let scene = scenes.scenes.get(scene_id)
        .ok_or_else(|| format!("シーンが見つかりません: {}", scene_id))?;

    let perf = scene.performances.iter().find(|p| p.id == performance_id)
        .ok_or_else(|| format!("演出が見つかりません: {}", performance_id))?;

    let file = fs::File::create(dest_path)
        .map_err(|e| format!("ZIPファイル作成失敗: {}", e))?;
    let mut writer = zip::ZipWriter::new(file);

    // performance.json
    let perf_json = serde_json::to_value(perf).unwrap_or_default();
    zip_utils::add_json_to_zip(&mut writer, "performance.json", &perf_json)?;

    // エフェクト定義
    let effect = scenes.effects.iter().find(|e| e.id == perf.effect);
    if let Some(eff) = effect {
        let eff_json = serde_json::to_value(eff).unwrap_or_default();
        zip_utils::add_json_to_zip(&mut writer, "effect.json", &eff_json)?;

        // プラグインディレクトリ
        add_effect_plugin_to_zip(&mut writer, &eff.id, "plugin/", plugins_dir)?;
    }

    // 演出素材
    let perf_dir = scenes_dir.join(scene_id).join("performances");
    add_performance_assets_to_zip(&mut writer, &perf_dir, perf)?;

    writer.finish().map_err(|e| format!("ZIP完了失敗: {}", e))?;
    tracing::info!("Exported performance: {}", performance_id);
    Ok(())
}

/// エフェクトを ZIP にエクスポートする。
pub fn export_effect(
    effect_id: &str,
    dest_path: &Path,
    effects_dir: &Path,
    scenes: &SceneStore,
    plugins_dir: &Path,
) -> Result<(), String> {
    let eff = scenes.effects.iter().find(|e| e.id == effect_id)
        .ok_or_else(|| format!("エフェクトが見つかりません: {}", effect_id))?;

    let file = fs::File::create(dest_path)
        .map_err(|e| format!("ZIPファイル作成失敗: {}", e))?;
    let mut writer = zip::ZipWriter::new(file);

    // effect.json
    let eff_json = serde_json::to_value(eff).unwrap_or_default();
    zip_utils::add_json_to_zip(&mut writer, "effect.json", &eff_json)?;

    // プラグインディレクトリ
    add_effect_plugin_to_zip(&mut writer, &eff.id, "plugin/", plugins_dir)?;

    // エフェクトの素材ディレクトリ（存在すれば）
    let assets_dir = effects_dir.join("assets").join(effect_id);
    if assets_dir.exists() {
        zip_utils::add_dir_to_zip(&mut writer, &assets_dir, "assets/")?;
    }

    writer.finish().map_err(|e| format!("ZIP完了失敗: {}", e))?;
    tracing::info!("Exported effect: {}", effect_id);
    Ok(())
}

// ========== 内部ヘルパー ==========

/// シーンで使用されているエフェクトをユニークに収集する。
fn collect_unique_scene_effects(scene: &Scene, effects: &[EffectDefinition]) -> Vec<EffectDefinition> {
    let mut used = Vec::new();
    for perf in &scene.performances {
        if let Some(eff) = effects.iter().find(|e| e.id == perf.effect) {
            if !used.iter().any(|u: &EffectDefinition| u.id == eff.id) {
                used.push(eff.clone());
            }
        }
    }
    used
}

/// エフェクトのプラグインディレクトリを ZIP に追加する。
fn add_effect_plugin_to_zip<W: Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    effect_id: &str,
    zip_prefix: &str,
    plugins_dir: &Path,
) -> Result<(), String> {
    if !plugins_dir.exists() {
        return Ok(());
    }

    // manifest.id で照合してディレクトリを探す
    let entries = match fs::read_dir(plugins_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let content = match fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let manifest: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if manifest.get("id").and_then(|v| v.as_str()) == Some(effect_id) {
            zip_utils::add_dir_to_zip(writer, &entry.path(), zip_prefix)?;
            return Ok(());
        }
    }

    Ok(())
}

/// 演出の素材ファイル（assets + sounds）を ZIP に追加する。
fn add_performance_assets_to_zip<W: Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    perf_dir: &Path,
    perf: &crate::state::scene::Performance,
) -> Result<(), String> {
    // assets
    for asset in &perf.assets {
        if let Some(filename) = asset.as_str() {
            let asset_path = perf_dir.join(filename);
            if asset_path.exists() {
                let zip_path = format!("assets/{}", filename.replace('\\', "/"));
                zip_utils::add_file_to_zip(writer, &asset_path, &zip_path)?;
            }
        } else if let Some(obj) = asset.as_object() {
            if let Some(filename) = obj.get("filename").and_then(|v| v.as_str()) {
                let asset_path = perf_dir.join(filename);
                if asset_path.exists() {
                    let zip_path = format!("assets/{}", filename.replace('\\', "/"));
                    zip_utils::add_file_to_zip(writer, &asset_path, &zip_path)?;
                }
            }
        }
    }

    // sounds
    for sound in &perf.sounds {
        let sound_path = perf_dir.join(sound);
        if sound_path.exists() {
            let zip_path = format!("assets/{}", sound.replace('\\', "/"));
            zip_utils::add_file_to_zip(writer, &sound_path, &zip_path)?;
        }
    }

    Ok(())
}

// ========== Upgrade ==========

/// バージョンアップ確認後の実行: バックアップ → プラグイン上書き → マイグレーション。
pub fn confirm_and_upgrade_effect(
    zip_path: &Path,
    effect_id: &str,
    effect_manager: &mut EffectManager,
    backup_manager: &crate::engine::backup_manager::BackupManager,
    scenes_dir: &Path,
    scenes: &mut SceneStore,
) -> Result<serde_json::Value, String> {
    let existing = effect_manager.get_effect(effect_id)
        .ok_or("エフェクトが見つかりません")?.clone();

    let mut archive = zip_utils::open_validated_zip(zip_path)?;
    let prefix = zip_utils::detect_zip_prefix(&mut archive);
    let (imported_eff, plugin_manifest) = match load_effect_package(&mut archive, &prefix) {
        (Some(e), m) => (e, m),
        _ => return Err("effect.json の読み込みに失敗".to_string()),
    };

    // ハブバージョン互換性チェック
    if let Some(ref m) = plugin_manifest {
        if let Some(reason) = effect_manager.check_hub_version_compat_raw(&m.min_hub_version, &m.name) {
            return Err(reason);
        }
    }

    // 1. バックアップ作成
    let backup_name = format!("{} v{} → v{}", existing.name, existing.version, imported_eff.version);
    backup_manager.create_backup(
        &crate::engine::backup_manager::BackupOptions {
            backup_type: Some("auto-upgrade".to_string()),
            name: Some(backup_name),
            reason: Some("pre-upgrade".to_string()),
            scene_ids: None,
            effect_ids: Some(vec![effect_id.to_string()]),
            plugin_ids: Some(vec![effect_id.to_string()]),
        },
        scenes_dir,
        effect_manager,
    )?;

    // 2. プラグインファイルの上書き展開
    if let Some(ref manifest) = plugin_manifest {
        extract_plugin_from_zip(&mut archive, &prefix, effect_id, effect_manager.plugins_dir(), manifest)?;
    }

    // 3. エフェクト定義のバージョン更新
    let old_version = existing.version.clone();
    let mut updated = existing;
    updated.version = imported_eff.version.clone();
    // インポート側の新パラメータデフォルトを補完
    if let Some(imported_params) = imported_eff.params.as_object() {
        if let Some(existing_params) = updated.params.as_object_mut() {
            for (key, val) in imported_params {
                if !existing_params.contains_key(key) {
                    existing_params.insert(key.clone(), val.clone());
                }
            }
        }
    }
    effect_manager.update_effect(updated);

    // 4. 全シーンの該当演出のパラメータをマイグレーション
    if let Some(ref manifest) = plugin_manifest {
        let manifest_typed: crate::state::scene::PluginManifest = serde_json::from_value(
            serde_json::to_value(manifest).unwrap_or_default()
        ).unwrap_or_default();

        let perf_system_keys: std::collections::HashSet<&str> = [
            "id", "name", "enabled", "trigger", "effect", "assets", "sounds",
            "cooldown", "assetMeta", "soundMeta", "sound", "requiresContext",
        ].iter().cloned().collect();

        let mut migrated_count = 0;
        let scene_ids: Vec<String> = scenes.scenes.keys().cloned().collect();
        for scene_id in &scene_ids {
            let scene = match scenes.scenes.get_mut(scene_id) {
                Some(s) => s,
                None => continue,
            };
            let mut changed = false;
            for perf in &mut scene.performances {
                if perf.effect != effect_id { continue; }

                // パラメータキーのみ抽出（extra からシステムキーを除外）
                let params: serde_json::Value = {
                    let mut map = serde_json::Map::new();
                    for (k, v) in &perf.extra {
                        if !perf_system_keys.contains(k.as_str()) {
                            map.insert(k.clone(), v.clone());
                        }
                    }
                    serde_json::Value::Object(map)
                };

                let migrated = effect_manager::migrate_params(&params, &old_version, &manifest_typed);

                // 旧キーを削除
                if let Some(old_obj) = params.as_object() {
                    for k in old_obj.keys() {
                        if migrated.get(k).is_none() {
                            perf.extra.remove(k);
                        }
                    }
                }
                // 新キーを書き込み
                if let Some(new_obj) = migrated.as_object() {
                    for (k, v) in new_obj {
                        perf.extra.insert(k.clone(), v.clone());
                    }
                }
                changed = true;
                migrated_count += 1;
            }
            if changed {
                let json = serde_json::to_string_pretty(scene).unwrap_or_default();
                fs::write(scenes_dir.join(scene_id).join("scene.json"), json).ok();
            }
        }
        if migrated_count > 0 {
            tracing::info!("Migrated params for {} performances", migrated_count);
        }
    }

    tracing::info!("Upgraded effect: {} {} -> {}", effect_id, old_version, imported_eff.version);
    Ok(serde_json::json!({ "upgraded": true, "effectId": effect_id }))
}

// ========== Import ==========

/// Import 結果
#[derive(Debug)]
pub enum ImportResult {
    Ok(serde_json::Value),
    NeedsUpgrade { zip_path: String, upgrade_info: serde_json::Value },
    Err(String),
}

/// エフェクトを ZIP からインポートする。
pub fn import_effect(zip_path: &Path, effect_manager: &mut EffectManager) -> ImportResult {
    let mut archive = match zip_utils::open_validated_zip(zip_path) {
        Ok(a) => a, Err(e) => return ImportResult::Err(e),
    };
    let prefix = zip_utils::detect_zip_prefix(&mut archive);
    let (mut eff, plugin_manifest) = match load_effect_package(&mut archive, &prefix) {
        (Some(e), m) => (e, m), _ => return ImportResult::Err("effect.json が見つかりません".into()),
    };
    if !is_valid_effect_id(&eff.id) { return ImportResult::Err(format!("無効なエフェクトID: {}", eff.id)); }
    if let Some(ref m) = plugin_manifest {
        if let Some(reason) = effect_manager.check_hub_version_compat_raw(&m.min_hub_version, &m.name) {
            return ImportResult::Err(reason);
        }
    }

    use crate::state::scene::EffectResolution;
    match effect_manager.resolve_imported_effect(&mut eff) {
        EffectResolution::UpgradeAvailable { effect_id, effect_name, current_version, new_version } => {
            ImportResult::NeedsUpgrade {
                zip_path: zip_path.to_string_lossy().into(),
                upgrade_info: serde_json::json!({ "effectId": effect_id, "effectName": effect_name, "currentVersion": current_version, "newVersion": new_version }),
            }
        }
        EffectResolution::UseExisting { effect } => ImportResult::Ok(serde_json::json!(effect.id)),
        EffectResolution::Error { error } => ImportResult::Err(error),
        EffectResolution::Repair { effect } => {
            if let Some(m) = &plugin_manifest {
                if let Err(e) = extract_plugin_from_zip(&mut archive, &prefix, &effect.id, effect_manager.plugins_dir(), m) { return ImportResult::Err(e); }
            }
            ImportResult::Ok(serde_json::json!(effect.id))
        }
        EffectResolution::Add { mut effect } => {
            effect.builtin = false;
            if effect.version.is_empty() { effect.version = "1.0.0".into(); }
            if let Some(m) = &plugin_manifest {
                if let Err(e) = extract_plugin_from_zip(&mut archive, &prefix, &effect.id, effect_manager.plugins_dir(), m) { return ImportResult::Err(e); }
            }
            let assets_prefix = format!("{}assets/", prefix);
            if has_entries_with_prefix(&mut archive, &assets_prefix) {
                let target = effect_manager.effects_dir().join("assets").join(&effect.id);
                let _ = zip_utils::extract_entries_to_dir(&mut archive, &assets_prefix, &target);
            }
            let id = effect.id.clone();
            effect_manager.add_effect(effect);
            ImportResult::Ok(serde_json::json!(id))
        }
    }
}

/// シーンを ZIP からインポートする。
pub fn import_scene(zip_path: &Path, effect_manager: &mut EffectManager, scenes_dir: &Path, scenes: &mut SceneStore) -> ImportResult {
    let mut archive = match zip_utils::open_validated_zip(zip_path) {
        Ok(a) => a, Err(e) => return ImportResult::Err(e),
    };
    let scene_json = match zip_utils::read_zip_json(&mut archive, "", "scene.json") {
        Some(v) => v, None => return ImportResult::Err("scene.json が見つかりません".into()),
    };
    let mut scene_data: Scene = match serde_json::from_value(scene_json) {
        Ok(s) => s, Err(e) => return ImportResult::Err(format!("scene.json パース失敗: {}", e)),
    };

    let scene_id = allocate_scene_id(&scene_data.name, scenes_dir);
    let scene_dir = scenes_dir.join(&scene_id);
    fs::create_dir_all(&scene_dir).ok();
    if let Err(e) = zip_utils::extract_entries_to_dir(&mut archive, "", &scene_dir) {
        let _ = fs::remove_dir_all(&scene_dir); return ImportResult::Err(e);
    }

    let mut warnings = Vec::new();
    let mut skipped: HashMap<String, bool> = HashMap::new();

    let eff_path = scene_dir.join("effects").join("effects.json");
    if eff_path.exists() {
        if let Ok(content) = fs::read_to_string(&eff_path) {
            if let Ok(imported) = serde_json::from_str::<EffectsFile>(&content) {
                use crate::state::scene::EffectResolution;
                for mut eff in imported.effects {
                    match effect_manager.resolve_imported_effect(&mut eff) {
                        EffectResolution::Add { mut effect } => { effect.builtin = false; effect_manager.add_effect(effect); }
                        EffectResolution::Repair { .. } | EffectResolution::UseExisting { .. } => {}
                        EffectResolution::UpgradeAvailable { effect_name, current_version, new_version, .. } => {
                            warnings.push(format!("エフェクト「{}」は v{} が必要（現在 v{}）", effect_name, new_version, current_version));
                            skipped.insert(eff.id.clone(), true);
                        }
                        EffectResolution::Error { error } => { warnings.push(error); skipped.insert(eff.id.clone(), true); }
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(scene_dir.join("effects"));
    }

    if !skipped.is_empty() { scene_data.performances.retain(|p| !skipped.contains_key(&p.effect)); }
    for perf in &mut scene_data.performances {
        if let Some(new_id) = migrate_legacy_effect_id(&perf.effect) { perf.effect = new_id.to_string(); }
    }

    scene_data.id = scene_id.clone();
    fs::write(scene_dir.join("scene.json"), serde_json::to_string_pretty(&scene_data).unwrap_or_default()).ok();

    let plugins_src = scene_dir.join("plugins");
    if plugins_src.exists() {
        install_scene_plugins(&plugins_src, &skipped, effect_manager.plugins_dir());
        let _ = fs::remove_dir_all(&plugins_src);
    }

    scenes.scenes.insert(scene_id.clone(), scene_data);
    scenes.scene_order.push(scene_id.clone());
    tracing::info!("Imported scene: {}", scene_id);

    if warnings.is_empty() { ImportResult::Ok(serde_json::json!({ "sceneId": scene_id })) }
    else { ImportResult::Ok(serde_json::json!({ "sceneId": scene_id, "warnings": warnings })) }
}

/// 演出を ZIP からインポートする。
pub fn import_performance(scene_id: &str, zip_path: &Path, effect_manager: &mut EffectManager, scenes_dir: &Path, scenes: &mut SceneStore) -> ImportResult {
    if !scenes.scenes.contains_key(scene_id) { return ImportResult::Err(format!("シーンが見つかりません: {}", scene_id)); }

    let mut archive = match zip_utils::open_validated_zip(zip_path) {
        Ok(a) => a, Err(e) => return ImportResult::Err(e),
    };
    let perf_json = match zip_utils::read_zip_json(&mut archive, "", "performance.json") {
        Some(v) => v, None => return ImportResult::Err("performance.json が見つかりません".into()),
    };
    let mut perf: crate::state::scene::Performance = match serde_json::from_value(perf_json) {
        Ok(p) => p, Err(e) => return ImportResult::Err(format!("performance.json パース失敗: {}", e)),
    };

    let (eff_opt, manifest_opt) = load_effect_package(&mut archive, "");
    if let Some(mut eff) = eff_opt {
        if let Some(ref m) = manifest_opt {
            if let Some(reason) = effect_manager.check_hub_version_compat_raw(&m.min_hub_version, &m.name) { return ImportResult::Err(reason); }
        }
        use crate::state::scene::EffectResolution;
        match effect_manager.resolve_imported_effect(&mut eff) {
            EffectResolution::Add { mut effect } => {
                effect.builtin = false; if effect.version.is_empty() { effect.version = "1.0.0".into(); }
                perf.effect = effect.id.clone();
                if let Some(m) = &manifest_opt { let _ = extract_plugin_from_zip(&mut archive, "", &effect.id, effect_manager.plugins_dir(), m); }
                effect_manager.add_effect(effect);
            }
            EffectResolution::Repair { effect } => {
                perf.effect = effect.id.clone();
                if let Some(m) = &manifest_opt { let _ = extract_plugin_from_zip(&mut archive, "", &effect.id, effect_manager.plugins_dir(), m); }
            }
            EffectResolution::UseExisting { effect } => { perf.effect = effect.id.clone(); }
            EffectResolution::Error { error } => return ImportResult::Err(error),
            EffectResolution::UpgradeAvailable { .. } => return ImportResult::Err("エフェクトのアップグレードが必要です".into()),
        }
    }
    if let Some(new_id) = migrate_legacy_effect_id(&perf.effect) { perf.effect = new_id.to_string(); }

    let perf_dir = scenes_dir.join(scene_id).join("performances");
    extract_performance_assets(&mut archive, &perf_dir);

    let scene = scenes.scenes.get(scene_id).unwrap();
    if perf.id.is_empty() || scene.performances.iter().any(|p| p.id == perf.id) {
        perf.id = effect_manager::generate_id_pub();
    }

    let scene = scenes.scenes.get_mut(scene_id).unwrap();
    scene.performances.push(perf.clone());
    fs::write(scenes_dir.join(scene_id).join("scene.json"), serde_json::to_string_pretty(scene).unwrap_or_default()).ok();
    tracing::info!("Imported performance: {} into {}", perf.id, scene_id);
    ImportResult::Ok(serde_json::json!(true))
}

// ========== Import ヘルパー ==========

fn load_effect_package(archive: &mut zip::ZipArchive<fs::File>, prefix: &str) -> (Option<EffectDefinition>, Option<PluginManifest>) {
    let eff: Option<EffectDefinition> = zip_utils::read_zip_json(archive, prefix, "effect.json").and_then(|v| serde_json::from_value(v).ok());
    let manifest: Option<PluginManifest> = zip_utils::read_zip_json(archive, prefix, "plugin/manifest.json").and_then(|v| serde_json::from_value(v).ok());
    match (eff, &manifest) {
        (Some(mut e), Some(m)) if !m.id.is_empty() => { e.id = m.id.clone(); (Some(e), manifest) }
        (eff, _) => (eff, manifest),
    }
}

fn extract_plugin_from_zip(archive: &mut zip::ZipArchive<fs::File>, prefix: &str, effect_id: &str, plugins_dir: &Path, manifest: &PluginManifest) -> Result<(), String> {
    let target = plugins_dir.join(effect_id);
    fs::create_dir_all(&target).ok();
    zip_utils::extract_entries_to_dir(archive, &format!("{}plugin/", prefix), &target)?;
    let mut m = manifest.clone(); m.id = effect_id.to_string();
    fs::write(target.join("manifest.json"), serde_json::to_string_pretty(&m).unwrap_or_default()).ok();
    Ok(())
}

fn extract_performance_assets(archive: &mut zip::ZipArchive<fs::File>, perf_dir: &Path) {
    fs::create_dir_all(perf_dir).ok();
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() || name == "performance.json" || name == "effect.json" || name.starts_with("plugin/") { continue; }
        let rel = name.strip_prefix("assets/").unwrap_or(&name);
        let target = perf_dir.join(rel);
        if !zip_utils::is_path_inside(perf_dir, &target) { continue; }
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).ok(); }
        let mut data = Vec::new();
        use std::io::Read;
        if entry.read_to_end(&mut data).is_ok() { fs::write(&target, &data).ok(); }
    }
}

fn allocate_scene_id(name: &str, scenes_dir: &Path) -> String {
    let base = sanitize_scene_id(name);
    if !scenes_dir.join(&base).exists() { return base; }
    format!("{}-{}", base, effect_manager::generate_id_pub())
}

fn sanitize_scene_id(name: &str) -> String {
    let s: String = name.chars().filter(|c| !"/\\<>:\"|?*".contains(*c) && !c.is_control()).collect();
    let s = s.trim_matches(|c: char| c.is_whitespace() || c == '.').to_string();
    let s = s.split_whitespace().collect::<Vec<_>>().join("-").to_lowercase();
    if s.is_empty() { "imported".into() } else { s }
}

fn install_scene_plugins(src: &Path, skipped: &HashMap<String, bool>, target_plugins_dir: &Path) {
    let entries = match fs::read_dir(src) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        if !entry.path().is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_valid_effect_id(&id) || skipped.contains_key(&id) { continue; }
        if !entry.path().join("manifest.json").exists() { continue; }
        let target = target_plugins_dir.join(&id);
        if target.exists() { continue; }
        if let Err(e) = zip_utils::copy_dir_recursive(&entry.path(), &target) {
            tracing::warn!("Plugin install failed {}: {}", id, e);
        }
    }
}

fn has_entries_with_prefix(archive: &mut zip::ZipArchive<fs::File>, prefix: &str) -> bool {
    (0..archive.len()).any(|i| archive.by_index(i).map(|e| !e.is_dir() && e.name().replace('\\', "/").starts_with(prefix)).unwrap_or(false))
}
