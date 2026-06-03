//! EffectManager — エフェクト CRUD・プラグイン管理・バージョン解決。
//!
//! SceneManager の一部として動作し、effects.json の読み書きと
//! プラグインディレクトリの走査を担当する。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::state::scene::{
    EffectDefinition, EffectResolution, EffectsFile, PluginManifest,
};

/// エフェクトID バリデーション用正規表現パターン
static VALID_EFFECT_ID_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9.\-]*[a-zA-Z0-9]$").unwrap());

/// ビルトインエフェクトの旧ID→新ID マッピング
static LEGACY_EFFECT_ID_MAP: std::sync::LazyLock<HashMap<&'static str, &'static str>> =
    std::sync::LazyLock::new(|| {
        let mut m = HashMap::new();
        m.insert("cracker", "com.comment-hub.cracker");
        m.insert("fall", "com.comment-hub.fall");
        m.insert("rise", "com.comment-hub.rise");
        m.insert("fixed", "com.comment-hub.fixed");
        m.insert("sprout", "com.comment-hub.sprout");
        m.insert("slide", "com.comment-hub.slide");
        m.insert("firework", "com.comment-hub.firework");
        m.insert("screen-overlay", "com.comment-hub.screen-overlay");
        m
    });

#[derive(Clone)]
pub struct EffectManager {
    effects_dir: PathBuf,
    plugins_dir: PathBuf,
    hub_version: String,
    /// エフェクト定義キャッシュ
    effects: Vec<EffectDefinition>,
}

impl EffectManager {
    pub fn new(data_dir: &Path, plugins_dir: &Path, hub_version: &str) -> Self {
        let effects_dir = data_dir.join("effects");
        let mut mgr = Self {
            effects_dir,
            plugins_dir: plugins_dir.to_path_buf(),
            hub_version: hub_version.to_string(),
            effects: Vec::new(),
        };
        mgr.load_effects();
        mgr
    }

    pub fn effects_dir(&self) -> &Path {
        &self.effects_dir
    }

    pub fn plugins_dir(&self) -> &Path {
        &self.plugins_dir
    }

    // ========== 読み込み ==========

    /// effects.json を読み込んでキャッシュする。
    pub fn load_effects(&mut self) {
        let effects_file = self.effects_dir.join("effects.json");
        if !effects_file.exists() {
            tracing::warn!("effects.json not found: {:?}", effects_file);
            self.effects = Vec::new();
            return;
        }

        match fs::read_to_string(&effects_file) {
            Ok(content) => match serde_json::from_str::<EffectsFile>(&content) {
                Ok(ef) => {
                    tracing::info!("Loaded {} effect definitions", ef.effects.len());
                    self.effects = ef.effects;
                }
                Err(e) => {
                    tracing::error!("Failed to parse effects.json: {}", e);
                }
            },
            Err(e) => {
                tracing::error!("Failed to read effects.json: {}", e);
            }
        }
    }

    /// エフェクトID → デフォルトパラメータのマップを構築する。
    pub fn build_effect_params(&self) -> HashMap<String, serde_json::Value> {
        self.effects
            .iter()
            .map(|e| (e.id.clone(), e.params.clone()))
            .collect()
    }

    /// キャッシュされたエフェクト一覧のクローンを返す。
    pub fn effects(&self) -> &[EffectDefinition] {
        &self.effects
    }

    // ========== CRUD ==========

    /// エフェクト一覧を返す（プラグイン健全性・互換性チェック付き）。
    pub fn get_effects_with_status(&self) -> Vec<serde_json::Value> {
        self.effects
            .iter()
            .map(|eff| {
                let mut val = serde_json::to_value(eff).unwrap_or_default();
                let obj = val.as_object_mut().unwrap();

                match self.find_plugin_dir(&eff.id) {
                    None => {
                        obj.insert("broken".to_string(), serde_json::Value::Bool(true));
                        obj.insert("incompatible".to_string(), serde_json::Value::Bool(false));
                    }
                    Some(dir_name) => {
                        let manifest_path = self.plugins_dir.join(&dir_name).join("manifest.json");
                        match Self::read_manifest(&manifest_path) {
                            None => {
                                obj.insert("broken".to_string(), serde_json::Value::Bool(true));
                            }
                            Some(manifest) => {
                                // entry ファイル存在チェック
                                let entry_missing = !manifest.entry.is_empty()
                                    && !self.plugins_dir.join(&dir_name).join(&manifest.entry).exists();
                                obj.insert("broken".to_string(), serde_json::Value::Bool(entry_missing));

                                // ハブバージョン互換性
                                if let Some(reason) = self.check_hub_version_compat(&manifest) {
                                    obj.insert("incompatible".to_string(), serde_json::Value::Bool(true));
                                    obj.insert("incompatibleReason".to_string(), serde_json::Value::String(reason));
                                } else {
                                    obj.insert("incompatible".to_string(), serde_json::Value::Bool(false));
                                }
                            }
                        }
                    }
                }
                val
            })
            .collect()
    }

    /// エフェクトをIDで検索する。
    pub fn get_effect(&self, effect_id: &str) -> Option<&EffectDefinition> {
        self.effects.iter().find(|e| e.id == effect_id)
    }

    /// エフェクトを追加する。IDが空なら生成する。
    pub fn add_effect(&mut self, mut effect: EffectDefinition) -> String {
        if effect.id.is_empty() {
            effect.id = generate_id();
        }
        let id = effect.id.clone();
        self.effects.push(effect);
        self.save_effects();
        tracing::debug!("Added effect: {}", id);
        id
    }

    /// エフェクトを更新する。
    pub fn update_effect(&mut self, effect: EffectDefinition) -> bool {
        let idx = self.effects.iter().position(|e| e.id == effect.id);
        match idx {
            Some(i) => {
                tracing::debug!("Updated effect: {}", effect.id);
                self.effects[i] = effect;
                self.save_effects();
                true
            }
            None => false,
        }
    }

    /// エフェクトを削除する（ビルトインは削除不可）。プラグインディレクトリも削除。
    pub fn remove_effect(&mut self, effect_id: &str) -> bool {
        let is_builtin = self.effects.iter().any(|e| e.id == effect_id && e.builtin);
        if is_builtin {
            return false;
        }

        let before_len = self.effects.len();
        self.effects.retain(|e| e.id != effect_id);
        if self.effects.len() == before_len {
            return false;
        }

        self.save_effects();

        // プラグインディレクトリ削除
        if let Some(dir_name) = self.find_plugin_dir(effect_id) {
            let plugin_path = self.plugins_dir.join(&dir_name);
            if let Err(e) = fs::remove_dir_all(&plugin_path) {
                tracing::warn!("Failed to remove plugin directory: {:?} {}", plugin_path, e);
            } else {
                tracing::debug!("Removed plugin directory: {:?}", plugin_path);
            }
        }

        tracing::debug!("Removed effect: {}", effect_id);
        true
    }

    /// エフェクトを複製する。プラグインはコピーしない。
    pub fn duplicate_effect(&mut self, effect_id: &str, new_name: &str) -> Option<String> {
        let source = self.get_effect(effect_id)?.clone();
        let mut new_effect = source;
        new_effect.id = generate_id();
        new_effect.name = new_name.to_string();
        new_effect.builtin = false;
        let new_id = new_effect.id.clone();
        self.effects.push(new_effect);
        self.save_effects();
        tracing::debug!("Duplicated effect: {} -> {}", effect_id, new_id);
        Some(new_id)
    }

    /// エフェクトキャッシュ全体を上書き保存する。
    pub fn save_all_effects(&mut self, effects: Vec<EffectDefinition>) {
        self.effects = effects;
        self.save_effects();
    }

    // ========== プラグイン管理 ==========

    /// manifest.id がプラグインIDに一致するディレクトリ名を返す。
    pub fn find_plugin_dir(&self, plugin_id: &str) -> Option<String> {
        if !self.plugins_dir.exists() {
            return None;
        }
        let entries = fs::read_dir(&self.plugins_dir).ok()?;
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let manifest_path = entry.path().join("manifest.json");
            if let Some(manifest) = Self::read_manifest(&manifest_path) {
                if manifest.id == plugin_id {
                    return Some(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        None
    }

    /// 全プラグインのマニフェストを読み込む（健全性・互換性フラグ付き）。
    pub fn get_plugin_manifests(&self) -> HashMap<String, serde_json::Value> {
        let mut result = HashMap::new();
        if !self.plugins_dir.exists() {
            return result;
        }

        let entries = match fs::read_dir(&self.plugins_dir) {
            Ok(e) => e,
            Err(_) => return result,
        };

        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let manifest_path = entry.path().join("manifest.json");

            if let Some(manifest) = Self::read_manifest(&manifest_path) {
                let mut val = serde_json::to_value(&manifest).unwrap_or_default();
                let obj = val.as_object_mut().unwrap();

                // entry ファイル健全性
                if !manifest.entry.is_empty()
                    && !self.plugins_dir.join(&dir_name).join(&manifest.entry).exists()
                {
                    tracing::warn!("Plugin entry missing: {} {}", dir_name, manifest.entry);
                    obj.insert("broken".to_string(), serde_json::Value::Bool(true));
                }

                // ハブバージョン互換性
                if let Some(reason) = self.check_hub_version_compat(&manifest) {
                    obj.insert("incompatible".to_string(), serde_json::Value::Bool(true));
                    obj.insert("incompatibleReason".to_string(), serde_json::Value::String(reason));
                }

                let key = if manifest.id.is_empty() { dir_name } else { manifest.id.clone() };
                result.insert(key, val);
            }
        }

        result
    }

    // ========== バージョン解決 ==========

    /// インポートされたエフェクトを環境と照合しバージョン解決する。
    pub fn resolve_imported_effect(&self, imported: &mut EffectDefinition) -> EffectResolution {
        // 旧IDマイグレーション
        if let Some(&new_id) = LEGACY_EFFECT_ID_MAP.get(imported.id.as_str()) {
            imported.id = new_id.to_string();
        }
        // type フィールド廃止
        imported.extra.remove("type");

        let existing = match self.get_effect(&imported.id) {
            None => {
                // 環境に存在しない → 新規追加
                if imported.version.is_empty() {
                    imported.version = "1.0.0".to_string();
                }
                return EffectResolution::Add {
                    effect: imported.clone(),
                };
            }
            Some(e) => e.clone(),
        };

        let cmp = compare_versions(&existing.version, &imported.version);
        if cmp >= 0 {
            // 環境が同等以上 → プラグイン健全性を確認
            let plugin_broken = self.is_plugin_broken(&existing.id);
            if plugin_broken {
                if cmp == 0 {
                    return EffectResolution::Repair { effect: existing };
                }
                return EffectResolution::Error {
                    error: format!(
                        "エフェクト「{}」のプラグインが破損しています。修復には同一バージョン（v{}）のインポートが必要です（提供: v{}）。",
                        if existing.name.is_empty() { existing.id.as_str() } else { existing.name.as_str() },
                        existing.version,
                        imported.version
                    ),
                };
            }
            return EffectResolution::UseExisting { effect: existing };
        }

        // 環境が古い → アップグレード提案
        // プラグインマニフェストがインポート版以上ならマイグレーション可能
        let manifests = self.get_plugin_manifests();
        if let Some(manifest_val) = manifests.get(&imported.id) {
            if let Some(manifest_ver) = manifest_val.get("version").and_then(|v| v.as_str()) {
                if compare_versions(manifest_ver, &imported.version) >= 0 {
                    return EffectResolution::UseExisting { effect: existing };
                }
            }
        }

        EffectResolution::UpgradeAvailable {
            effect_id: existing.id.clone(),
            effect_name: if imported.name.is_empty() {
                existing.name.clone()
            } else {
                imported.name.clone()
            },
            current_version: if existing.version.is_empty() {
                "不明".to_string()
            } else {
                existing.version.clone()
            },
            new_version: imported.version.clone(),
        }
    }

    // ========== バージョン・互換ヘルパー ==========

    /// ハブバージョン互換性チェック（raw 版: フィールド値を直接受け取る）。
    pub fn check_hub_version_compat_raw(&self, min_hub_version: &str, name: &str) -> Option<String> {
        if min_hub_version.is_empty() {
            return None;
        }
        if compare_versions(&self.hub_version, min_hub_version) < 0 {
            Some(format!(
                "エフェクト「{}」はハブ v{} 以上が必要です（現在 v{}）",
                name, min_hub_version, self.hub_version
            ))
        } else {
            None
        }
    }

    /// ハブバージョン互換性チェック。非互換ならエラーメッセージを返す。
    pub fn check_hub_version_compat(&self, manifest: &PluginManifest) -> Option<String> {
        if manifest.min_hub_version.is_empty() {
            return None;
        }
        if compare_versions(&self.hub_version, &manifest.min_hub_version) < 0 {
            Some(format!(
                "ハブ v{} 以上が必要（現在 v{}）",
                manifest.min_hub_version, self.hub_version
            ))
        } else {
            None
        }
    }

    /// プラグインが破損しているかチェック。
    fn is_plugin_broken(&self, effect_id: &str) -> bool {
        let dir_name = match self.find_plugin_dir(effect_id) {
            None => return true,
            Some(d) => d,
        };
        let manifest_path = self.plugins_dir.join(&dir_name).join("manifest.json");
        match Self::read_manifest(&manifest_path) {
            None => true,
            Some(manifest) => {
                !manifest.entry.is_empty()
                    && !self.plugins_dir.join(&dir_name).join(&manifest.entry).exists()
            }
        }
    }

    // ========== 内部ヘルパー ==========

    /// effects.json をディスクに書き出す。
    fn save_effects(&self) {
        let effects_file = EffectsFile {
            effects: self.effects.clone(),
        };
        let json = match serde_json::to_string_pretty(&effects_file) {
            Ok(j) => j,
            Err(e) => {
                tracing::error!("Failed to serialize effects.json: {}", e);
                return;
            }
        };
        if let Err(e) = fs::create_dir_all(&self.effects_dir) {
            tracing::error!("Failed to create effects dir: {}", e);
            return;
        }
        if let Err(e) = fs::write(self.effects_dir.join("effects.json"), json) {
            tracing::error!("Failed to write effects.json: {}", e);
        }
    }

    /// manifest.json を読み込む。
    fn read_manifest(path: &Path) -> Option<PluginManifest> {
        let content = fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }
}

// ========== 公開ユーティリティ関数 ==========

/// semver バージョン比較。a > b なら正, a < b なら負, 等しければ 0。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<i32> = a.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    let pb: Vec<i32> = b.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    for i in 0..3 {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va != vb {
            return va - vb;
        }
    }
    0
}

/// エフェクトID バリデーション。
pub fn is_valid_effect_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    if !VALID_EFFECT_ID_RE.is_match(id) {
        return false;
    }
    // 連続ドット禁止（パストラバーサル防止）
    if id.contains("..") {
        return false;
    }
    true
}

/// マニフェストの migrations を適用してパラメータをマイグレーションする。
pub fn migrate_params(
    params: &serde_json::Value,
    from_version: &str,
    manifest: &PluginManifest,
) -> serde_json::Value {
    if manifest.migrations.is_empty() {
        return params.clone();
    }

    let mut result = params.clone();

    // バージョンキーをソートして順番に適用
    let mut versions: Vec<&String> = manifest.migrations.keys().collect();
    versions.sort_by(|a, b| compare_versions(a, b).cmp(&0));

    for ver in versions {
        if compare_versions(ver, from_version) <= 0 {
            continue; // fromVersion 以下はスキップ
        }
        if compare_versions(ver, &manifest.version) > 0 {
            break; // 現行版より先はスキップ
        }

        let step = &manifest.migrations[ver];
        if let Some(obj) = result.as_object_mut() {
            // リネーム
            for (old_key, new_key) in &step.renamed {
                if let Some(val) = obj.remove(old_key) {
                    obj.insert(new_key.clone(), val);
                }
            }
            // 削除
            for key in &step.removed {
                obj.remove(key);
            }
            // 追加（既存キーは上書きしない）
            for (key, val) in &step.added {
                if !obj.contains_key(key) {
                    obj.insert(key.clone(), val.clone());
                }
            }
        }
    }

    result
}

/// 旧短縮IDをリバースドメインIDにマイグレーションする。変換された場合 Some を返す。
pub fn migrate_legacy_effect_id(id: &str) -> Option<&'static str> {
    LEGACY_EFFECT_ID_MAP.get(id).copied()
}

/// ユニークIDを生成する（外部公開版）。
pub fn generate_id_pub() -> String {
    generate_id()
}

/// ユニークIDを生成する（base36タイムスタンプ + ランダム）。
fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random: u32 = rand_simple();
    format!("{}{:04x}", base36(ts as u64), random & 0xFFFF)
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let chars = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut result = Vec::new();
    while n > 0 {
        result.push(chars[(n % 36) as usize]);
        n /= 36;
    }
    result.reverse();
    String::from_utf8(result).unwrap()
}

fn rand_simple() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    seed.wrapping_mul(1103515245).wrapping_add(12345)
}
