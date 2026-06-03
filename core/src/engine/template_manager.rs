//! TemplateManager — コメント表示テンプレートの CRUD 管理。
//!
//! ビルトイン（effects-overlay/templates/）とユーザー（%APPDATA%/templates/）を統合管理する。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use reqwest::Url;
use ttf_parser::name_id;

/// テンプレート種別
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TemplateType {
    Builtin,
    Custom,
    OneComme,
}

/// テンプレート情報
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub short_name: String,
    pub template_type: TemplateType,
    pub builtin: bool,
    pub storage_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateManifestSaveResult {
    pub previous_template_id: String,
    pub template_id: String,
    pub display_name: String,
    pub manifest: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateBundledFontImportItem {
    pub family: String,
    pub css_path: String,
    pub imported_files: Vec<String>,
    pub font_source: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateBundledFontImportResult {
    pub imports: Vec<TemplateBundledFontImportItem>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TemplateMeta {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: String,
}

#[derive(Debug, Clone)]
enum TemplateFontSourceKind {
    AssetCss { css: String },
    RemoteCss { url: String },
}

#[derive(Debug, Clone)]
struct TemplateFontSource {
    family: String,
    kind: TemplateFontSourceKind,
}

#[derive(Debug, Clone, Default)]
struct TemplateExportPolicy {
    allow_template_export: Option<bool>,
    note: Option<String>,
}

#[derive(Debug, Clone)]
struct TemplateRecord {
    info: TemplateInfo,
    path: PathBuf,
    manifest: Option<serde_json::Value>,
    aliases: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum TemplateStarterKind {
    List,
    Ticker,
    Custom,
}

impl TemplateStarterKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "list" => Ok(Self::List),
            "ticker" => Ok(Self::Ticker),
            "custom" => Ok(Self::Custom),
            _ => Err("starterType は list / ticker / custom のいずれかである必要があります。".to_string()),
        }
    }

    fn obs_hint(self) -> &'static str {
        match self {
            Self::List => "OBS幅 420px 前後 / 高さは任意",
            Self::Ticker => "OBS幅 1280px 前後 / 高さ 160px 前後",
            Self::Custom => "OBS幅 1280px 前後 / 高さ 720px 前後",
        }
    }
}

const LIST_STARTER_INDEX_HTML: &str =
    include_str!("../../../docs/examples/template-list-basic/index.html");
const LIST_STARTER_STYLE_CSS: &str =
    include_str!("../../../docs/examples/template-list-basic/style.css");
const LIST_STARTER_SCRIPT_JS: &str =
    include_str!("../../../docs/examples/template-list-basic/script.js");
const TICKER_STARTER_INDEX_HTML: &str =
    include_str!("../../../docs/examples/template-ticker-basic/index.html");
const TICKER_STARTER_STYLE_CSS: &str =
    include_str!("../../../docs/examples/template-ticker-basic/style.css");
const TICKER_STARTER_SCRIPT_JS: &str =
    include_str!("../../../docs/examples/template-ticker-basic/script.js");
const CUSTOM_STARTER_INDEX_HTML: &str =
    include_str!("../../../docs/examples/template-custom-basic/index.html");
const CUSTOM_STARTER_STYLE_CSS: &str =
    include_str!("../../../docs/examples/template-custom-basic/style.css");
const CUSTOM_STARTER_SCRIPT_JS: &str =
    include_str!("../../../docs/examples/template-custom-basic/script.js");

#[derive(Clone)]
pub struct TemplateManager {
    builtin_dir: PathBuf,
    user_dir: PathBuf,
}

impl TemplateManager {
    pub fn new(builtin_dir: &Path, user_dir: &Path) -> Self {
        if let Err(e) = fs::create_dir_all(user_dir) {
            tracing::warn!("Failed to create user templates dir: {}", e);
        }
        Self {
            builtin_dir: builtin_dir.to_path_buf(),
            user_dir: user_dir.to_path_buf(),
        }
    }

    /// テンプレート一覧を返す（ビルトイン + ユーザー）
    pub fn get_templates(&self) -> Vec<TemplateInfo> {
        self.scan_templates(true)
            .into_iter()
            .map(|record| record.info)
            .collect()
    }

    /// ZIP からテンプレートをインストールする
    ///
    /// 戻り値のタプル 2 つ目は、テンプレートが参照している未同梱の
    /// わんコメ community プラグイン ID のリスト（例:
    /// `["onecomme.plugin.template-utils"]`）。空なら問題なし。
    /// 非空の場合、呼び出し側でユーザーに「このテンプレは XX プラグインを
    /// 要求します。表示が正しくない可能性があります」と警告すべき。
    pub fn install_template(&self, zip_path: &Path) -> Result<(TemplateInfo, Vec<String>), String> {
        let file = fs::File::open(zip_path)
            .map_err(|e| format!("ZIP を開けません: {}", e))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("ZIP の読み込みに失敗: {}", e))?;

        // index.html を含むディレクトリを探す
        let template_root = self.find_template_root(&mut archive)?;

        let temp_storage_name = self.next_template_storage_name();
        let temp_dest_dir = self.user_dir.join(&temp_storage_name);

        // 既存があれば削除して上書き
        if temp_dest_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dest_dir);
        }
        fs::create_dir_all(&temp_dest_dir)
            .map_err(|e| format!("ディレクトリ作成失敗: {}", e))?;

        // 展開
        let prefix = if template_root.is_empty() {
            String::new()
        } else {
            format!("{}/", template_root)
        };

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)
                .map_err(|e| format!("ZIP エントリ読み込み失敗: {}", e))?;

            let entry_name = Self::decode_zip_name(entry.name_raw());
            if !entry_name.starts_with(&prefix) {
                continue;
            }

            let rel_path = &entry_name[prefix.len()..];
            if rel_path.is_empty() || entry.is_dir() {
                continue;
            }

            // パストラバーサル防止
            if rel_path.contains("..") {
                continue;
            }

            let dest_path = temp_dest_dir.join(rel_path);
            if let Some(parent) = dest_path.parent() {
                let _ = fs::create_dir_all(parent);
            }

            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)
                .map_err(|e| format!("ファイル読み込み失敗: {}", e))?;
            fs::write(&dest_path, &buf)
                .map_err(|e| format!("ファイル書き込み失敗: {}", e))?;
        }

        let manifest = self.read_manifest(&temp_dest_dir);
        if let Err(error) = validate_manifest_font_sources(manifest.as_ref(), &temp_dest_dir) {
            let _ = fs::remove_dir_all(&temp_dest_dir);
            return Err(error);
        }
        let template_type = self.detect_type(&temp_dest_dir);
        let zip_display_name = self.extract_display_name_from_zip(&template_root);
        let display_name = self
            .template_display_name(&temp_dest_dir, manifest.as_ref())
            .or(zip_display_name)
            .unwrap_or_else(|| temp_storage_name.clone());
        let mut desired_id = self.template_id_from_sources(&temp_dest_dir, manifest.as_ref(), false);
        let existing_templates = self.scan_templates(true);
        let existing_user = existing_templates.iter().find(|record| {
            !record.info.builtin && !desired_id.is_empty() && record.info.id == desired_id
        });
        let builtin_conflict = existing_templates.iter().any(|record| {
            record.info.builtin && !desired_id.is_empty() && record.info.id == desired_id
        });
        let mut used_ids: HashSet<String> = existing_templates.iter().map(|record| record.info.id.clone()).collect();

        if desired_id.is_empty() || builtin_conflict {
            desired_id = self.generate_template_id(
                &template_type,
                &display_name,
                &temp_storage_name,
                &used_ids,
            );
        }
        used_ids.insert(desired_id.clone());

        let final_storage_name = existing_user
            .map(|record| record.info.storage_name.clone())
            .unwrap_or_else(|| temp_storage_name.clone());
        let final_dest_dir = self.user_dir.join(&final_storage_name);
        if final_dest_dir != temp_dest_dir {
            if final_dest_dir.exists() {
                let _ = fs::remove_dir_all(&final_dest_dir);
            }
            fs::rename(&temp_dest_dir, &final_dest_dir)
                .map_err(|e| format!("テンプレート配置失敗: {}", e))?;
        }

        self.persist_user_template_identity(
            &final_dest_dir,
            &desired_id,
            &display_name,
            manifest.as_ref(),
        );

        // わんコメ community プラグイン依存を検出。例: hana-ticket 系は
        // `/plugins/onecomme.plugin.template-utils/template.js` を読み込む。
        // こめはぶは community プラグインを同梱しないため、黒画面化する。
        let unsupported_plugins = scan_unsupported_onecomme_plugins(&final_dest_dir);
        if !unsupported_plugins.is_empty() {
            tracing::warn!(
                "Imported template '{}' requires unsupported OneComme community plugins: {}",
                display_name,
                unsupported_plugins.join(", ")
            );
        }

        tracing::info!(
            "Template installed: id={} storage={} display={} ({:?})",
            desired_id,
            final_storage_name,
            display_name,
            template_type
        );

        Ok((
            TemplateInfo {
                id: desired_id.clone(),
                name: desired_id,
                display_name,
                short_name: self.template_short_name(manifest.as_ref(), &final_storage_name),
                template_type,
                builtin: false,
                storage_name: final_storage_name,
            },
            unsupported_plugins,
        ))
    }

    /// テンプレートの manifest.json を一括読み込みする（テンプレート名 → manifest）
    pub fn get_template_manifests(&self) -> HashMap<String, serde_json::Value> {
        let mut result = HashMap::new();
        for record in self.scan_templates(true) {
            let Some(mut manifest) = record.manifest.clone() else {
                continue;
            };
            if let Some(obj) = manifest.as_object_mut() {
                obj.insert("id".to_string(), serde_json::Value::String(record.info.id.clone()));
                obj.insert(
                    "displayName".to_string(),
                    serde_json::Value::String(record.info.display_name.clone()),
                );
            }
            result.insert(record.info.id.clone(), manifest);
        }
        result
    }

    pub fn get_template_manifest(&self, template_id: &str) -> Option<serde_json::Value> {
        let record = self.find_template_record(template_id)?;
        let mut manifest = record.manifest?;
        if let Some(obj) = manifest.as_object_mut() {
            obj.insert("id".to_string(), serde_json::Value::String(record.info.id));
            obj.insert(
                "displayName".to_string(),
                serde_json::Value::String(record.info.display_name),
            );
        }
        Some(manifest)
    }

    pub fn save_template_manifest(
        &self,
        template_id: &str,
        manifest: &serde_json::Value,
    ) -> Result<TemplateManifestSaveResult, String> {
        let record = self
            .find_template_record(template_id)
            .ok_or_else(|| "テンプレートが見つかりません。".to_string())?;
        if record.info.builtin {
            return Err("ビルトインテンプレートの manifest は編集できません。".to_string());
        }

        let mut manifest_obj = manifest
            .as_object()
            .cloned()
            .ok_or_else(|| "manifest は object である必要があります。".to_string())?;
        let normalized_id = manifest_obj
            .get("id")
            .and_then(|value| value.as_str())
            .and_then(Self::normalize_template_id)
            .ok_or_else(|| {
                "manifest.id は英小文字・数字・ドット・ハイフンのみ使用できます。".to_string()
            })?;
        let short_name = manifest_obj
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "manifest.name は必須です。".to_string())?
            .to_string();
        let display_name = manifest_obj
            .get("displayName")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "manifest.displayName は必須です。".to_string())?
            .to_string();
        let version = manifest_obj
            .get("version")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "manifest.version は必須です。".to_string())?
            .to_string();
        let obs_hint = manifest_obj
            .get("obsHint")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "manifest.obsHint は必須です。".to_string())?
            .to_string();
        let fonts = manifest_obj
            .get("fonts")
            .and_then(|value| value.as_array())
            .ok_or_else(|| "manifest.fonts は配列である必要があります。".to_string())?;
        if fonts.iter().any(|value| value.as_str().map(str::trim).unwrap_or("").is_empty()) {
            return Err("manifest.fonts には空文字を含められません。".to_string());
        }
        if !manifest_obj
            .get("uiSchema")
            .map(|value| value.is_array())
            .unwrap_or(false)
        {
            return Err("manifest.uiSchema は配列である必要があります。".to_string());
        }

        let existing_templates = self.scan_templates(true);
        if existing_templates.iter().any(|existing| {
            existing.path != record.path && existing.info.id == normalized_id
        }) {
            return Err(format!("テンプレート ID が重複しています: {}", normalized_id));
        }

        manifest_obj.insert("id".to_string(), serde_json::Value::String(normalized_id.clone()));
        manifest_obj.insert("name".to_string(), serde_json::Value::String(short_name));
        manifest_obj.insert(
            "displayName".to_string(),
            serde_json::Value::String(display_name.clone()),
        );
        manifest_obj.insert(
            "version".to_string(),
            serde_json::Value::String(version),
        );
        manifest_obj.insert(
            "obsHint".to_string(),
            serde_json::Value::String(obs_hint),
        );
        let next_manifest = serde_json::Value::Object(manifest_obj);

        parse_manifest_font_sources(Some(&next_manifest))?;
        parse_template_export_policy(Some(&next_manifest))?;
        validate_manifest_font_sources(Some(&next_manifest), &record.path)?;

        let manifest_path = record.path.join("manifest.json");
        let content = serde_json::to_string_pretty(&next_manifest)
            .map_err(|e| format!("manifest.json 生成失敗: {}", e))?;
        fs::write(&manifest_path, content)
            .map_err(|e| format!("manifest.json 書き込み失敗: {}", e))?;
        self.persist_user_template_identity(
            &record.path,
            &normalized_id,
            &display_name,
            Some(&next_manifest),
        );

        Ok(TemplateManifestSaveResult {
            previous_template_id: record.info.id,
            template_id: normalized_id,
            display_name,
            manifest: next_manifest,
        })
    }

    pub fn get_template_default_settings(
        &self,
        template_id: &str,
    ) -> HashMap<String, serde_json::Value> {
        let mut settings = HashMap::new();
        let Some(record) = self.find_template_record(template_id) else {
            return settings;
        };
        let Some(manifest) = record.manifest else {
            return settings;
        };
        let Some(schema) = manifest.get("uiSchema").and_then(|value| value.as_array()) else {
            return settings;
        };

        for item in schema {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let Some(key) = obj.get("key").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(default_value) = obj.get("default") else {
                continue;
            };
            settings.insert(key.to_string(), default_value.clone());
        }

        // 共通レイアウト (表示位置 左/右 + 横幅) のデフォルトを注入。
        // manifest が自前の width/position を持つ場合は上の loop で既に入っているので
        // entry().or_insert で上書きしない。renderer COMMON_LAYOUT_UI_SCHEMA の default と一致。
        if template_supports_common_layout(&record.info, &manifest) {
            settings
                .entry("width".to_string())
                .or_insert_with(|| serde_json::json!(480));
            settings
                .entry("position".to_string())
                .or_insert_with(|| serde_json::json!("left"));
        }

        crate::state::scene::normalize_template_settings_map_in_place(&mut settings);
        settings
    }

    /// 現行 manifest.uiSchema に含まれる key の集合を返す。
    /// `default` が未設定の key（例: `backgroundImage` 等の image 型）も含む。
    /// reconcile で「uiSchema に存在する key のユーザー値は維持、存在しない key は除外」
    /// を正確に判定するために使う。
    pub fn get_template_ui_schema_keys(
        &self,
        template_id: &str,
    ) -> std::collections::HashSet<String> {
        let mut keys = std::collections::HashSet::new();
        let Some(record) = self.find_template_record(template_id) else {
            return keys;
        };
        let Some(manifest) = record.manifest else {
            return keys;
        };
        let Some(schema) = manifest.get("uiSchema").and_then(|value| value.as_array()) else {
            return keys;
        };
        for item in schema {
            if let Some(obj) = item.as_object() {
                if let Some(key) = obj.get("key").and_then(|value| value.as_str()) {
                    keys.insert(key.to_string());
                }
            }
        }
        // 共通レイアウト (表示位置 + 横幅) は renderer 側で自動付与されるため、
        // reconcile で「uiSchema 外」 と誤判定して捨てないよう有効キーに含める。
        if template_supports_common_layout(&record.info, &manifest) {
            keys.insert("width".to_string());
            keys.insert("position".to_string());
        }
        keys
    }

    /// テンプレートを ZIP にエクスポートする。
    pub fn export_template(
        &self,
        template_id: &str,
        export_name: Option<&str>,
        scene_id: Option<&str>,
        template_settings: Option<&serde_json::Value>,
        scenes_dir: &Path,
        dest_path: &Path,
    ) -> Result<(), String> {
        let record = self.find_template_record(template_id)
            .ok_or_else(|| "テンプレートが見つかりません。".to_string())?;
        let src_dir = record.path.clone();
        let export_template_id = record.info.id.clone();
        let export_display_name = export_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(record.info.display_name.as_str());
        let zip_dir_name = export_display_name;
        let source_manifest = record.manifest.clone();
        validate_manifest_font_sources(source_manifest.as_ref(), &src_dir)?;
        validate_template_export_policy(
            source_manifest.as_ref(),
            &record.info.display_name,
        )?;

        let file = fs::File::create(dest_path)
            .map_err(|e| format!("ZIPファイル作成失敗: {}", e))?;
        let mut writer = zip::ZipWriter::new(file);
        let mut normalized_template_settings = template_settings.cloned().unwrap_or_else(|| serde_json::json!({}));
        crate::state::scene::normalize_template_settings_json_in_place(&mut normalized_template_settings);
        let image_assets = collect_image_assets(
            scene_id,
            Some(&normalized_template_settings),
            scenes_dir,
            &src_dir,
        );
        let mut added_zip_paths = HashSet::new();
        add_template_tree_to_zip(
            &mut writer,
            &src_dir,
            &src_dir,
            zip_dir_name,
            &export_template_id,
            export_name,
            Some(&normalized_template_settings),
            &mut added_zip_paths,
        )?;

        for (filename, asset_path) in image_assets {
            let zip_path = format!("{}/assets/{}", zip_dir_name, filename);
            if added_zip_paths.insert(zip_path.clone()) {
                crate::infra::zip_utils::add_file_to_zip(&mut writer, &asset_path, &zip_path)?;
            }
        }

        let meta_value = serde_json::json!({
            "id": export_template_id,
            "displayName": export_display_name,
        });
        crate::infra::zip_utils::add_json_to_zip(
            &mut writer,
            &format!("{}/.template-meta.json", zip_dir_name),
            &meta_value,
        )?;

        if source_manifest.is_none() {
            tracing::debug!("Template exported without manifest.json: {}", record.info.id);
        }

        writer.finish().map_err(|e| format!("ZIP完了失敗: {}", e))?;
        tracing::info!("Template exported: {} -> {:?}", record.info.id, dest_path);
        Ok(())
    }

    /// ユーザーテンプレートを削除する（ビルトインは拒否）
    pub fn remove_template(&self, template_id: &str) -> bool {
        let Some(record) = self.find_template_record(template_id) else {
            tracing::warn!("Template not found: {}", template_id);
            return false;
        };
        if record.info.builtin {
            tracing::warn!("Cannot remove builtin template: {}", template_id);
            return false;
        }
        match fs::remove_dir_all(&record.path) {
            Ok(_) => {
                tracing::info!("Template removed: {}", template_id);
                true
            }
            Err(e) => {
                tracing::error!("Failed to remove template {}: {}", template_id, e);
                false
            }
        }
    }

    pub fn create_starter_template(
        &self,
        starter_type: &str,
        template_id: &str,
        display_name: &str,
    ) -> Result<TemplateInfo, String> {
        let starter_kind = TemplateStarterKind::parse(starter_type)?;
        let normalized_id = Self::normalize_template_id(template_id)
            .ok_or_else(|| "テンプレート ID は英小文字・数字・ドット・ハイフンのみ使用できます。".to_string())?;
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("テンプレート名は必須です。".to_string());
        }
        if self.find_template_record(&normalized_id).is_some() {
            return Err(format!("テンプレート ID が重複しています: {}", normalized_id));
        }

        let storage_name = self.next_template_storage_name();
        let dest_dir = self.user_dir.join(&storage_name);
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("テンプレートディレクトリ作成失敗: {}", e))?;

        let manifest = build_starter_manifest(starter_kind, &normalized_id, display_name);
        let write_result = (|| -> Result<(), String> {
            fs::write(
                dest_dir.join("manifest.json"),
                serde_json::to_string_pretty(&manifest)
                    .map_err(|e| format!("manifest.json 生成失敗: {}", e))?,
            )
            .map_err(|e| format!("manifest.json 書き込み失敗: {}", e))?;
            fs::write(dest_dir.join("index.html"), starter_index_html(starter_kind))
                .map_err(|e| format!("index.html 書き込み失敗: {}", e))?;
            fs::write(dest_dir.join("style.css"), starter_style_css(starter_kind))
                .map_err(|e| format!("style.css 書き込み失敗: {}", e))?;
            fs::write(dest_dir.join("script.js"), starter_script_js(starter_kind))
                .map_err(|e| format!("script.js 書き込み失敗: {}", e))?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_dir_all(&dest_dir);
            return Err(error);
        }

        self.persist_user_template_identity(&dest_dir, &normalized_id, display_name, Some(&manifest));

        Ok(TemplateInfo {
            id: normalized_id.clone(),
            name: normalized_id,
            display_name: display_name.to_string(),
            short_name: starter_short_name(&manifest),
            template_type: TemplateType::Custom,
            builtin: false,
            storage_name,
        })
    }

    pub fn create_template_from_builtin(
        &self,
        source_template_id: &str,
        template_id: &str,
        display_name: &str,
    ) -> Result<TemplateInfo, String> {
        let source_record = self
            .find_template_record(source_template_id)
            .ok_or_else(|| "複製元テンプレートが見つかりません。".to_string())?;
        if !source_record.info.builtin {
            return Err("開発用コピーは built-in テンプレートのみ対応しています。".to_string());
        }

        let normalized_id = Self::normalize_template_id(template_id)
            .ok_or_else(|| "テンプレート ID は英小文字・数字・ドット・ハイフンのみ使用できます。".to_string())?;
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("テンプレート名は必須です。".to_string());
        }
        if self.find_template_record(&normalized_id).is_some() {
            return Err(format!("テンプレート ID が重複しています: {}", normalized_id));
        }

        let Some(mut manifest) = source_record.manifest.clone() else {
            return Err("複製元テンプレートの manifest.json が見つかりません。".to_string());
        };

        let storage_name = self.next_template_storage_name();
        let dest_dir = self.user_dir.join(&storage_name);
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("テンプレートディレクトリ作成失敗: {}", e))?;

        let copy_result = copy_template_dir_recursive(&source_record.path, &dest_dir);
        if let Err(error) = copy_result {
            let _ = fs::remove_dir_all(&dest_dir);
            return Err(error);
        }

        if let Some(obj) = manifest.as_object_mut() {
            obj.insert("id".to_string(), serde_json::Value::String(normalized_id.clone()));
            obj.insert(
                "name".to_string(),
                serde_json::Value::String(starter_name_from_id(&normalized_id)),
            );
            obj.insert(
                "displayName".to_string(),
                serde_json::Value::String(display_name.to_string()),
            );
        }

        let manifest_path = dest_dir.join("manifest.json");
        let write_result = (|| -> Result<(), String> {
            fs::write(
                &manifest_path,
                serde_json::to_string_pretty(&manifest)
                    .map_err(|e| format!("manifest.json 生成失敗: {}", e))?,
            )
            .map_err(|e| format!("manifest.json 書き込み失敗: {}", e))?;
            validate_manifest_font_sources(Some(&manifest), &dest_dir)?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_dir_all(&dest_dir);
            return Err(error);
        }

        self.persist_user_template_identity(&dest_dir, &normalized_id, display_name, Some(&manifest));

        Ok(TemplateInfo {
            id: normalized_id.clone(),
            name: normalized_id,
            display_name: display_name.to_string(),
            short_name: starter_short_name(&manifest),
            template_type: TemplateType::Custom,
            builtin: false,
            storage_name,
        })
    }

    pub fn get_template_directory(&self, template_id: &str) -> Option<PathBuf> {
        self.find_template_record(template_id)
            .filter(|record| !record.info.builtin)
            .map(|record| record.path)
    }

    pub fn import_bundled_font_source(
        &self,
        template_id: &str,
        src_path: &Path,
        family: &str,
    ) -> Result<TemplateBundledFontImportResult, String> {
        let family = family.trim();
        let template_dir = self
            .get_template_directory(template_id)
            .ok_or_else(|| "custom template のフォルダが見つかりません。".to_string())?;
        if !src_path.exists() {
            return Err(format!("取り込み元ファイルが見つかりません: {}", src_path.display()));
        }

        let fonts_dir = template_dir.join("fonts");
        fs::create_dir_all(&fonts_dir)
            .map_err(|e| format!("fonts ディレクトリ作成失敗: {}", e))?;

        let batch_slug = next_available_font_batch_slug(&fonts_dir, family);
        let imported_faces = import_font_faces_into_dir(src_path, &fonts_dir, &batch_slug)?;
        if imported_faces.is_empty() {
            return Err("対応フォントが見つかりませんでした。woff2 / woff / otf / ttf を確認してください。".to_string());
        }
        let grouped_faces = group_imported_faces_by_family(family, imported_faces, src_path)?;
        let mut imports = Vec::with_capacity(grouped_faces.len());
        for (resolved_family, group_faces) in grouped_faces {
            let family_slug = TemplateManager::slugify(&resolved_family).replace('.', "-");
            let css_rel_path = next_available_font_css_path(&template_dir, &format!("{}-{}", batch_slug, family_slug));
            let css_abs_path = template_dir.join(&css_rel_path);
            let css_content = build_imported_font_css(&resolved_family, &group_faces);
            fs::write(&css_abs_path, css_content)
                .map_err(|e| format!("フォントCSS書き込み失敗: {}", e))?;

            let css_normalized = normalize_relative_font_asset_path(&css_rel_path)
                .ok_or_else(|| "生成した CSS パスが不正です。".to_string())?;
            let imported_files = group_faces
                .iter()
                .map(|face| format!("fonts/{}", face.file_name))
                .collect::<Vec<_>>();
            let font_source = serde_json::json!({
                "family": resolved_family,
                "type": "assetCss",
                "css": css_normalized,
            });
            imports.push(TemplateBundledFontImportItem {
                family: resolved_family,
                css_path: css_normalized,
                imported_files,
                font_source,
            });
        }
        Ok(TemplateBundledFontImportResult { imports })
    }

    pub fn resolve_template_id(&self, template_id_or_name: &str) -> Option<String> {
        self.find_template_record(template_id_or_name)
            .map(|record| record.info.id)
    }

    /// 次の連番テンプレート格納名を生成する（tmpl-1, tmpl-2, ...）
    fn next_template_storage_name(&self) -> String {
        let mut max_id = 0u32;
        if let Ok(entries) = fs::read_dir(&self.user_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(num_str) = name.strip_prefix("tmpl-") {
                    if let Ok(num) = num_str.parse::<u32>() {
                        if num > max_id { max_id = num; }
                    }
                }
            }
        }
        format!("tmpl-{}", max_id + 1)
    }

    /// ZIP の template_root から表示名を抽出する。
    ///
    /// わんコメ系テンプレの zip は典型的に次のどちらかの構造:
    ///   1. `テンプレ名/index.html` (1 階層 wrapper)
    ///   2. `親/テンプレ名/index.html` (2 階層)
    ///
    /// どちらの場合も **先頭のディレクトリ名** が人間可読な表示名である。
    /// template.json / manifest.json に displayName が無いテンプレは、これが
    /// 唯一の表示名候補になるため、1 階層でも拾えるようにする（以前は
    /// `parts.len() >= 2` 条件で 1 階層 zip が storage 名 "tmpl-N" に落ちていた）。
    fn extract_display_name_from_zip(&self, template_root: &str) -> Option<String> {
        template_root
            .split('/')
            .find_map(|segment| {
                let trimmed = segment.trim();
                if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
            })
    }

    /// index.html の内容から テンプレート種別を判定する
    fn detect_type(&self, template_dir: &Path) -> TemplateType {
        if Self::template_uses_onecomme_sdk(template_dir) {
            return TemplateType::OneComme;
        }
        if template_dir.starts_with(&self.builtin_dir) {
            TemplateType::Builtin
        } else {
            TemplateType::Custom
        }
    }

    fn file_contains_any(path: &Path, needles: &[&str]) -> bool {
        fs::read_to_string(path)
            .map(|content| needles.iter().any(|needle| content.contains(needle)))
            .unwrap_or(false)
    }

    fn any_template_file_contains(template_dir: &Path, extensions: &[&str], needles: &[&str]) -> bool {
        let mut stack = vec![template_dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("");
                if extensions.iter().any(|candidate| ext.eq_ignore_ascii_case(candidate))
                    && Self::file_contains_any(&path, needles)
                {
                    return true;
                }
            }
        }
        false
    }

    fn template_uses_onecomme_sdk(template_dir: &Path) -> bool {
        Self::file_contains_any(&template_dir.join("index.html"), &["onesdk.js", "onesdk.legacy.js", "OneSDK"])
            || Self::any_template_file_contains(template_dir, &["js", "html"], &["onesdk.js", "onesdk.legacy.js", "OneSDK."])
    }

    /// ZIP エントリ名をデコードする（Shift_JIS → UTF-8 フォールバック）
    fn decode_zip_name(raw: &[u8]) -> String {
        // まず UTF-8 を試す
        if let Ok(s) = std::str::from_utf8(raw) {
            return s.to_string();
        }
        // Shift_JIS (Windows-31J) でデコード
        let (decoded, _, _) = encoding_rs::SHIFT_JIS.decode(raw);
        decoded.to_string()
    }

    /// ZIP 内で index.html を含むディレクトリを探す
    fn find_template_root(&self, archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
        let mut candidates: Vec<String> = Vec::new();

        for i in 0..archive.len() {
            let entry = archive.by_index_raw(i)
                .map_err(|e| format!("ZIP エントリ読み込み失敗: {}", e))?;
            let decoded_name = Self::decode_zip_name(entry.name_raw());
            if decoded_name.ends_with("index.html") {
                let parent = Path::new(&decoded_name)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let parent = parent.trim_end_matches('/').to_string();
                candidates.push(parent);
            }
        }

        if candidates.is_empty() {
            return Err("ZIP 内に index.html が見つかりません".to_string());
        }

        // 最も深い index.html を含むディレクトリを選択（テンプレート本体）
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.matches('/').count()));
        Ok(candidates.into_iter().next().unwrap())
    }

    fn scan_templates(&self, persist_user_identity: bool) -> Vec<TemplateRecord> {
        let mut records = Vec::new();
        let mut used_ids = HashSet::new();
        for (dir, builtin) in [(&self.builtin_dir, true), (&self.user_dir, false)] {
            let mut entries: Vec<_> = match fs::read_dir(dir) {
                Ok(entries) => entries.flatten().collect(),
                Err(_) => continue,
            };
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                if !path.is_dir() || !path.join("index.html").exists() {
                    continue;
                }
                let storage_name = entry.file_name().to_string_lossy().to_string();
                let template_type = self.detect_type(&path);
                let manifest = self.read_manifest(&path);
                let meta = self.read_meta(&path);
                let display_name = meta
                    .as_ref()
                    .and_then(|value| {
                        let trimmed = value.display_name.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .or_else(|| self.template_display_name(&path, manifest.as_ref()))
                    .unwrap_or_else(|| storage_name.clone());
                let mut template_id = self.template_id_from_sources(&path, manifest.as_ref(), builtin);
                if template_id.is_empty() {
                    template_id = self.generate_template_id(&template_type, &display_name, &storage_name, &used_ids);
                }
                if used_ids.contains(&template_id) {
                    template_id = self.generate_template_id(&template_type, &display_name, &storage_name, &used_ids);
                }
                used_ids.insert(template_id.clone());
                if persist_user_identity && !builtin {
                    self.persist_user_template_identity(&path, &template_id, &display_name, manifest.as_ref());
                }
                let mut aliases = vec![storage_name.clone()];
                if let Some(name) = manifest
                    .as_ref()
                    .and_then(|value| value.get("name"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    aliases.push(name.to_string());
                }
                aliases.push(template_id.clone());
                aliases.sort();
                aliases.dedup();
                records.push(TemplateRecord {
                    info: TemplateInfo {
                        id: template_id.clone(),
                        name: template_id,
                        display_name,
                        short_name: self.template_short_name(manifest.as_ref(), &storage_name),
                        template_type,
                        builtin,
                        storage_name,
                    },
                    path,
                    manifest,
                    aliases,
                });
            }
        }
        records
    }

    fn find_template_record(&self, template_id_or_name: &str) -> Option<TemplateRecord> {
        self.scan_templates(true)
            .into_iter()
            .find(|record| record.aliases.iter().any(|alias| alias == template_id_or_name))
    }

    fn read_manifest(&self, template_dir: &Path) -> Option<serde_json::Value> {
        let manifest_path = template_dir.join("manifest.json");
        let content = fs::read_to_string(&manifest_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn read_meta(&self, template_dir: &Path) -> Option<TemplateMeta> {
        let meta_path = template_dir.join(".template-meta.json");
        let content = fs::read_to_string(&meta_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn template_display_name(
        &self,
        template_dir: &Path,
        manifest: Option<&serde_json::Value>,
    ) -> Option<String> {
        manifest
            .and_then(|value| value.get("displayName").and_then(|value| value.as_str()))
            .or_else(|| manifest.and_then(|value| value.get("name").and_then(|value| value.as_str())))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| {
                self.read_meta(template_dir)
                    .and_then(|meta| (!meta.display_name.trim().is_empty()).then_some(meta.display_name))
            })
            .or_else(|| {
                // わんコメ形式の template.json からの name 取得
                self.read_onecomme_template_json(template_dir)
                    .and_then(|value| value.get("name").and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty()).map(|value| value.to_string()))
            })
    }

    fn read_onecomme_template_json(&self, template_dir: &Path) -> Option<serde_json::Value> {
        let path = template_dir.join("template.json");
        let content = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn template_short_name(&self, manifest: Option<&serde_json::Value>, storage_name: &str) -> String {
        manifest
            .and_then(|value| value.get("name").and_then(|value| value.as_str()))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| storage_name.to_string())
    }

    fn template_id_from_sources(
        &self,
        template_dir: &Path,
        manifest: Option<&serde_json::Value>,
        builtin: bool,
    ) -> String {
        if let Some(meta_id) = self
            .read_meta(template_dir)
            .and_then(|meta| Self::normalize_template_id(&meta.id))
        {
            return meta_id;
        }
        if let Some(manifest_id) = manifest
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
            .and_then(Self::normalize_template_id)
        {
            return manifest_id;
        }
        if builtin {
            let storage_name = template_dir.file_name().and_then(|value| value.to_str()).unwrap_or("template");
            return format!("com.comment-hub.template.{}", Self::slugify(storage_name));
        }
        String::new()
    }

    fn persist_user_template_identity(
        &self,
        template_dir: &Path,
        template_id: &str,
        display_name: &str,
        manifest: Option<&serde_json::Value>,
    ) {
        let meta = TemplateMeta {
            id: template_id.to_string(),
            display_name: display_name.to_string(),
        };
        let meta_path = template_dir.join(".template-meta.json");
        if let Ok(content) = serde_json::to_string_pretty(&meta) {
            let _ = fs::write(&meta_path, content);
        }

        let manifest_path = template_dir.join("manifest.json");
        if let Some(mut manifest_value) = manifest.cloned() {
            if let Some(obj) = manifest_value.as_object_mut() {
                obj.insert("id".to_string(), serde_json::Value::String(template_id.to_string()));
                if !display_name.trim().is_empty() {
                    obj.insert(
                        "displayName".to_string(),
                        serde_json::Value::String(display_name.to_string()),
                    );
                }
            }
            if let Ok(content) = serde_json::to_string_pretty(&manifest_value) {
                let _ = fs::write(manifest_path, content);
            }
        }
    }

    fn generate_template_id(
        &self,
        template_type: &TemplateType,
        display_name: &str,
        storage_name: &str,
        used_ids: &HashSet<String>,
    ) -> String {
        let type_segment = match template_type {
            TemplateType::Builtin => "builtin",
            TemplateType::Custom => "custom",
            TemplateType::OneComme => "onecomme",
        };
        let mut slug = Self::slugify(display_name);
        if slug.is_empty() {
            slug = Self::slugify(storage_name);
        }
        if slug.is_empty() {
            slug = "template".to_string();
        }
        let base = format!("com.comment-hub.template.{}.{}", type_segment, slug);
        if !used_ids.contains(&base) {
            return base;
        }
        for index in 2.. {
            let candidate = format!("{}.{}", base, index);
            if !used_ids.contains(&candidate) {
                return candidate;
            }
        }
        unreachable!()
    }

    fn normalize_template_id(value: &str) -> Option<String> {
        let trimmed = value.trim().to_ascii_lowercase();
        if trimmed.is_empty() {
            return None;
        }
        let valid = trimmed
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '-');
        if !valid || trimmed.starts_with('.') || trimmed.ends_with('.') || trimmed.contains("..") {
            return None;
        }
        Some(trimmed)
    }

    fn slugify(value: &str) -> String {
        let mut slug = String::new();
        let mut prev_dot = false;
        for ch in value.chars() {
            let next = match ch {
                'a'..='z' | '0'..='9' => Some(ch),
                'A'..='Z' => Some(ch.to_ascii_lowercase()),
                _ => Some('.'),
            };
            if let Some(next) = next {
                if next == '.' {
                    if slug.is_empty() || prev_dot {
                        continue;
                    }
                    prev_dot = true;
                    slug.push(next);
                } else {
                    prev_dot = false;
                    slug.push(next);
                }
            }
        }
        slug.trim_matches('.').to_string()
    }
}

fn starter_index_html(kind: TemplateStarterKind) -> &'static str {
    match kind {
        TemplateStarterKind::List => LIST_STARTER_INDEX_HTML,
        TemplateStarterKind::Ticker => TICKER_STARTER_INDEX_HTML,
        TemplateStarterKind::Custom => CUSTOM_STARTER_INDEX_HTML,
    }
}

fn starter_style_css(kind: TemplateStarterKind) -> &'static str {
    match kind {
        TemplateStarterKind::List => LIST_STARTER_STYLE_CSS,
        TemplateStarterKind::Ticker => TICKER_STARTER_STYLE_CSS,
        TemplateStarterKind::Custom => CUSTOM_STARTER_STYLE_CSS,
    }
}

fn starter_script_js(kind: TemplateStarterKind) -> &'static str {
    match kind {
        TemplateStarterKind::List => LIST_STARTER_SCRIPT_JS,
        TemplateStarterKind::Ticker => TICKER_STARTER_SCRIPT_JS,
        TemplateStarterKind::Custom => CUSTOM_STARTER_SCRIPT_JS,
    }
}

fn starter_short_name(manifest: &serde_json::Value) -> String {
    manifest
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("template")
        .to_string()
}

fn starter_name_from_id(template_id: &str) -> String {
    template_id
        .rsplit('.')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("template")
        .to_string()
}

/// 共通レイアウト設定 (表示位置 左/右 + 横幅) を配信デフォルト / 有効キーに
/// 含めるテンプレか。renderer 側 templateSupportsCommonLayout と判定を揃える。
/// OneComme 形式 (common.css 非依存) と commonLayout=false (ticker) は対象外。
fn template_supports_common_layout(info: &TemplateInfo, manifest: &serde_json::Value) -> bool {
    !matches!(info.template_type, TemplateType::OneComme)
        && manifest.get("commonLayout").and_then(|v| v.as_bool()) != Some(false)
}

fn build_starter_manifest(
    starter_kind: TemplateStarterKind,
    template_id: &str,
    display_name: &str,
) -> serde_json::Value {
    let short_name = starter_name_from_id(template_id);
    let ui_schema = match starter_kind {
        TemplateStarterKind::List => serde_json::json!([
            {
                "key": "maxComments",
                "type": "slider",
                "label": "最大表示数",
                "min": 3,
                "max": 30,
                "step": 1,
                "default": 10
            },
            {
                "key": "fontSize",
                "type": "slider",
                "label": "文字サイズ",
                "min": 14,
                "max": 48,
                "step": 1,
                "default": 24,
                "suffix": "px"
            },
            {
                "key": "accentColor",
                "type": "color",
                "label": "アクセント色",
                "default": "#60a5fa"
            },
            {
                "key": "showAvatar",
                "type": "toggle",
                "label": "アバター表示",
                "default": true,
                "onLabel": "表示",
                "offLabel": "非表示"
            },
            {
                "key": "rounded",
                "type": "toggle",
                "label": "角丸を強める",
                "default": true,
                "onLabel": "ON",
                "offLabel": "OFF"
            },
            {
                "key": "customCss",
                "type": "textarea",
                "label": "カスタムCSS",
                "placeholder": ".comment { letter-spacing: 0.05em; }"
            }
        ]),
        TemplateStarterKind::Ticker => serde_json::json!([
            {
                "key": "maxComments",
                "type": "slider",
                "label": "最大表示数",
                "min": 3,
                "max": 20,
                "step": 1,
                "default": 10
            },
            {
                "key": "fontSize",
                "type": "slider",
                "label": "文字サイズ",
                "min": 18,
                "max": 56,
                "step": 1,
                "default": 28,
                "suffix": "px"
            },
            {
                "key": "travelSeconds",
                "type": "slider",
                "label": "流れる時間",
                "min": 4,
                "max": 20,
                "step": 1,
                "default": 8,
                "suffix": "s"
            },
            {
                "key": "positionY",
                "type": "slider",
                "label": "表示位置・縦",
                "min": -100,
                "max": 100,
                "step": 1,
                "default": 0,
                "suffix": "px"
            },
            {
                "key": "nameColor",
                "type": "color",
                "label": "名前色",
                "default": "#fde68a"
            },
            {
                "key": "textColor",
                "type": "color",
                "label": "本文色",
                "default": "#ffffff"
            },
            {
                "key": "showBadge",
                "type": "toggle",
                "label": "メンバーバッジ表示",
                "default": true,
                "onLabel": "表示",
                "offLabel": "非表示"
            },
            {
                "key": "customCss",
                "type": "textarea",
                "label": "カスタムCSS",
                "placeholder": ".comment { letter-spacing: 0.08em; }"
            }
        ]),
        TemplateStarterKind::Custom => serde_json::json!([
            {
                "key": "fontSize",
                "type": "slider",
                "label": "本文サイズ",
                "min": 18,
                "max": 72,
                "step": 1,
                "default": 36,
                "suffix": "px"
            },
            {
                "key": "accentColor",
                "type": "color",
                "label": "アクセント色",
                "default": "#f472b6"
            },
            {
                "key": "panelColor",
                "type": "color",
                "label": "パネル色",
                "default": "rgba(15, 23, 42, 0.78)"
            },
            {
                "key": "showAvatar",
                "type": "toggle",
                "label": "アバター表示",
                "default": true,
                "onLabel": "表示",
                "offLabel": "非表示"
            },
            {
                "key": "customCss",
                "type": "textarea",
                "label": "カスタムCSS",
                "placeholder": ".latest-card { backdrop-filter: blur(12px); }"
            }
        ]),
    };
    // ticker (横スクロール) は共通レイアウト設定 (表示位置 左/右 + 横幅) の対象外。
    // renderer 側 templateSupportsCommonLayout が commonLayout=false を見て除外する。
    let common_layout = !matches!(starter_kind, TemplateStarterKind::Ticker);
    serde_json::json!({
        "id": template_id,
        "name": short_name,
        "displayName": display_name,
        "version": "1.0.0",
        "obsHint": starter_kind.obs_hint(),
        "commonLayout": common_layout,
        "fonts": ["Noto Sans JP"],
        "uiSchema": ui_schema
    })
}

pub fn collect_manifest_font_sources(manifest: Option<&serde_json::Value>) -> Result<Vec<serde_json::Value>, String> {
    parse_manifest_font_sources(manifest).map(|sources| {
        sources
            .into_iter()
            .map(|source| match source.kind {
                TemplateFontSourceKind::AssetCss { css } => serde_json::json!({
                    "family": source.family,
                    "type": "assetCss",
                    "css": css,
                }),
                TemplateFontSourceKind::RemoteCss { url } => serde_json::json!({
                    "family": source.family,
                    "type": "remoteCss",
                    "url": url,
                }),
            })
            .collect()
    })
}

pub fn validate_manifest_font_sources(
    manifest: Option<&serde_json::Value>,
    template_dir: &Path,
) -> Result<(), String> {
    let sources = parse_manifest_font_sources(manifest)?;
    for source in sources {
        if let TemplateFontSourceKind::AssetCss { css } = source.kind {
            let css_path = template_dir.join(css);
            if !css_path.exists() {
                return Err(format!(
                    "manifest.fontSources の CSS が見つかりません: {}",
                    css_path.display()
                ));
            }
        }
    }
    Ok(())
}

fn validate_template_export_policy(
    manifest: Option<&serde_json::Value>,
    display_name: &str,
) -> Result<(), String> {
    let sources = parse_manifest_font_sources(manifest)?;
    let policy = parse_template_export_policy(manifest)?;
    let uses_asset_css = sources.iter().any(|source| matches!(source.kind, TemplateFontSourceKind::AssetCss { .. }));

    match policy.allow_template_export {
        Some(true) => Ok(()),
        Some(false) => Err(build_template_export_denied_message(
            display_name,
            policy.note.as_deref(),
        )),
        None if uses_asset_css => Err(format!(
            "{} は assetCss を使っています。再配布が許可されるフォントや画像などの同梱リソースだけを使っているか確認し、manifest.json の exportPolicy.allowTemplateExport を明示してください。{}",
            display_name,
            default_template_export_guidance()
        )),
        None => Ok(()),
    }
}

fn collect_image_assets(
    scene_id: Option<&str>,
    template_settings: Option<&serde_json::Value>,
    scenes_dir: &Path,
    template_dir: &Path,
) -> HashMap<String, PathBuf> {
    let mut image_assets = HashMap::new();
    let Some(settings) = template_settings else {
        return image_assets;
    };
    let Some(settings_obj) = settings.as_object() else {
        return image_assets;
    };
    for value in settings_obj.values() {
        let Some(raw_value) = value.as_str() else {
            continue;
        };
        let Some(relative_path) = crate::state::scene::template_asset_relative_path(raw_value) else {
            continue;
        };
        let template_asset_path = template_dir.join("assets").join(&relative_path);
        if template_asset_path.exists() {
            image_assets.insert(relative_path.clone(), template_asset_path);
            continue;
        }
        let Some(scene_id) = scene_id else {
            continue;
        };
        let perf_asset_path = scenes_dir.join(scene_id).join("performances").join(&relative_path);
        if perf_asset_path.exists() {
            image_assets.insert(relative_path, perf_asset_path);
        }
    }

    image_assets
}

fn rewrite_manifest_json(
    content: &str,
    template_id: &str,
    export_name: Option<&str>,
    template_settings: Option<&serde_json::Value>,
) -> String {
    let Ok(mut manifest) = serde_json::from_str::<serde_json::Value>(content) else {
        return content.to_string();
    };

    if let Some(obj) = manifest.as_object_mut() {
        obj.insert("id".to_string(), serde_json::Value::String(template_id.to_string()));
        if let Some(name) = export_name.map(str::trim).filter(|value| !value.is_empty()) {
            obj.insert("name".to_string(), serde_json::Value::String(name.to_string()));
            obj.insert("displayName".to_string(), serde_json::Value::String(name.to_string()));
        }
    }

    if let (Some(settings), Some(schema)) = (
        template_settings.and_then(|value| value.as_object()),
        manifest.get_mut("uiSchema").and_then(|value| value.as_array_mut()),
    ) {
        for item in schema.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            let Some(key) = item_obj.get("key").and_then(|value| value.as_str()) else {
                continue;
            };
            if let Some(default_value) = settings.get(key) {
                item_obj.insert("default".to_string(), default_value.clone());
            }
        }
    }

    serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| content.to_string())
}

fn copy_template_dir_recursive(src_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(src_dir)
        .map_err(|e| format!("テンプレートディレクトリ読み取り失敗: {}", e))?
        .flatten()
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let entry_path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dest_dir.join(file_name);
        let file_type = entry
            .file_type()
            .map_err(|e| format!("テンプレートファイル種別取得失敗: {}", e))?;
        if file_type.is_dir() {
            fs::create_dir_all(&dest_path)
                .map_err(|e| format!("テンプレートサブディレクトリ作成失敗: {}", e))?;
            copy_template_dir_recursive(&entry_path, &dest_path)?;
            continue;
        }
        fs::copy(&entry_path, &dest_path)
            .map_err(|e| format!("テンプレートファイルコピー失敗: {}", e))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)] // 再帰処理の共有状態を明示引数で渡し、暗黙 mutable context を避ける。
fn add_template_tree_to_zip(
    writer: &mut zip::ZipWriter<fs::File>,
    template_root: &Path,
    current_dir: &Path,
    zip_dir_name: &str,
    template_id: &str,
    export_name: Option<&str>,
    template_settings: Option<&serde_json::Value>,
    added_zip_paths: &mut HashSet<String>,
) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(current_dir)
        .map_err(|e| format!("テンプレートディレクトリ読み取り失敗: {}", e))?
        .flatten()
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            add_template_tree_to_zip(
                writer,
                template_root,
                &entry_path,
                zip_dir_name,
                template_id,
                export_name,
                template_settings,
                added_zip_paths,
            )?;
            continue;
        }
        if !entry_path.is_file() {
            continue;
        }

        let Ok(relative_path) = entry_path.strip_prefix(template_root) else {
            continue;
        };
        let relative_path = relative_path
            .components()
            .filter_map(|component| match component {
                Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<String>>()
            .join("/");
        if relative_path.is_empty() || relative_path == ".template-meta.json" {
            continue;
        }

        let zip_path = format!("{}/{}", zip_dir_name, relative_path);
        if !added_zip_paths.insert(zip_path.clone()) {
            continue;
        }

        if relative_path == "manifest.json" {
            let content = fs::read_to_string(&entry_path)
                .map_err(|e| format!("manifest.json 読み込み失敗: {}", e))?;
            let manifest_json = rewrite_manifest_json(&content, template_id, export_name, template_settings);
            let manifest_value: serde_json::Value = serde_json::from_str(&manifest_json)
                .map_err(|e| format!("manifest.json パース失敗: {}", e))?;
            crate::infra::zip_utils::add_json_to_zip(writer, &zip_path, &manifest_value)?;
            continue;
        }

        crate::infra::zip_utils::add_file_to_zip(writer, &entry_path, &zip_path)?;
    }

    Ok(())
}

fn parse_manifest_font_sources(
    manifest: Option<&serde_json::Value>,
) -> Result<Vec<TemplateFontSource>, String> {
    let Some(items) = manifest
        .and_then(|value| value.get("fontSources"))
        .and_then(|value| value.as_array())
    else {
        return Ok(Vec::new());
    };

    let mut sources = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Some(obj) = item.as_object() else {
            return Err(format!("manifest.fontSources[{}] は object である必要があります。", index));
        };
        let family = obj
            .get("family")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("manifest.fontSources[{}].family は必須です。", index))?
            .to_string();
        let source_type = obj
            .get("type")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("manifest.fontSources[{}].type は必須です。", index))?;

        let kind = match source_type {
            "assetCss" => {
                let css = obj
                    .get("css")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("manifest.fontSources[{}].css は必須です。", index))?;
                let normalized_css = normalize_relative_font_asset_path(css)
                    .ok_or_else(|| format!("manifest.fontSources[{}].css が不正です。", index))?;
                TemplateFontSourceKind::AssetCss { css: normalized_css }
            }
            "remoteCss" => {
                let url = obj
                    .get("url")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("manifest.fontSources[{}].url は必須です。", index))?;
                let normalized_url = normalize_remote_font_css_url(url)
                    .ok_or_else(|| format!("manifest.fontSources[{}].url が不正です。", index))?;
                TemplateFontSourceKind::RemoteCss { url: normalized_url }
            }
            _ => {
                return Err(format!(
                    "manifest.fontSources[{}].type は assetCss または remoteCss を指定してください。",
                    index
                ));
            }
        };

        sources.push(TemplateFontSource { family, kind });
    }
    Ok(sources)
}

fn parse_template_export_policy(
    manifest: Option<&serde_json::Value>,
) -> Result<TemplateExportPolicy, String> {
    let Some(obj) = manifest
        .and_then(|value| value.get("exportPolicy"))
        .and_then(|value| value.as_object())
    else {
        return Ok(TemplateExportPolicy::default());
    };

    let allow_template_export = match obj.get("allowTemplateExport") {
        Some(serde_json::Value::Bool(value)) => Some(*value),
        Some(_) => {
            return Err("manifest.exportPolicy.allowTemplateExport は boolean である必要があります。".to_string());
        }
        None => None,
    };
    let note = match obj.get("note") {
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed.to_string())
        }
        Some(serde_json::Value::Null) | None => None,
        Some(_) => {
            return Err("manifest.exportPolicy.note は string である必要があります。".to_string());
        }
    };

    Ok(TemplateExportPolicy {
        allow_template_export,
        note,
    })
}

fn normalize_relative_font_asset_path(path: &str) -> Option<String> {
    let candidate = Path::new(path);
    if candidate.as_os_str().is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn normalize_remote_font_css_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    parsed.host_str()?;
    Some(parsed.to_string())
}

#[derive(Debug, Clone)]
struct ImportedFontFace {
    detected_family: Option<String>,
    file_name: String,
    format: &'static str,
    weight: u16,
    style: &'static str,
}

fn next_available_font_batch_slug(fonts_dir: &Path, family: &str) -> String {
    let base = TemplateManager::slugify(family).replace('.', "-");
    let base = if base.is_empty() { "font".to_string() } else { base };
    let mut index = 1usize;
    loop {
        let candidate = if index == 1 {
            base.clone()
        } else {
            format!("{}-{}", base, index)
        };
        let css_path = fonts_dir.join(format!("imported-{}.css", candidate));
        if !css_path.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn next_available_font_css_path(template_dir: &Path, batch_slug: &str) -> String {
    let relative = format!("fonts/imported-{}.css", batch_slug);
    if !template_dir.join(&relative).exists() {
        return relative;
    }
    for index in 2.. {
        let candidate = format!("fonts/imported-{}-{}.css", batch_slug, index);
        if !template_dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// テンプレートの index.html / template-script.js 等を走査し、`/plugins/onecomme.plugin.XXX/`
/// への参照が見つかった場合はその plugin id を重複排除して返す。
///
/// こめはぶは わんコメ community プラグインを同梱しないため、これらに依存した
/// テンプレートは黒画面になる。インポート時に検出してユーザーに警告するために
/// 使う。スキャンは文字列マッチで、script タグ / link タグ / CSS import のどこに
/// 書かれていても拾える。
fn scan_unsupported_onecomme_plugins(template_dir: &Path) -> Vec<String> {
    const MARKER: &str = "/plugins/onecomme.plugin.";
    // 代表的な参照点のみスキャン（template-utils 系は index.html にだいたい書いてある）。
    let candidates = ["index.html", "template-script.js", "script.js", "style.css"];
    let mut found: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for name in candidates.iter() {
        let path = template_dir.join(name);
        let Ok(content) = fs::read_to_string(&path) else { continue };
        let mut rest = content.as_str();
        while let Some(pos) = rest.find(MARKER) {
            let after = &rest[pos + MARKER.len()..];
            let end = after
                .find(['/', '"', '\'', ' ', ')', '\n', '\r', '\t'])
                .unwrap_or(after.len());
            let plugin_name = &after[..end];
            if !plugin_name.is_empty() {
                found.insert(format!("onecomme.plugin.{}", plugin_name));
            }
            rest = &after[end..];
        }
    }
    found.into_iter().collect()
}

fn import_font_faces_into_dir(
    src_path: &Path,
    fonts_dir: &Path,
    batch_slug: &str,
) -> Result<Vec<ImportedFontFace>, String> {
    let extension = src_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if extension == "zip" {
        return import_font_faces_from_zip(src_path, fonts_dir, batch_slug);
    }
    import_single_font_face(src_path, fonts_dir, batch_slug)
}

fn import_single_font_face(
    src_path: &Path,
    fonts_dir: &Path,
    batch_slug: &str,
) -> Result<Vec<ImportedFontFace>, String> {
    let extension = src_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let format = font_format_for_extension(&extension)
        .ok_or_else(|| "対応フォントは woff2 / woff / otf / ttf です。".to_string())?;
    let source_name = src_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("font");
    let copied_name = unique_imported_font_file_name(fonts_dir, batch_slug, source_name, &extension);
    let bytes = fs::read(src_path)
        .map_err(|e| format!("フォントファイルの読み込みに失敗しました: {}", e))?;
    fs::write(fonts_dir.join(&copied_name), &bytes)
        .map_err(|e| format!("フォントファイルのコピーに失敗しました: {}", e))?;
    let metadata = detect_font_face_metadata(&bytes, source_name, &extension);
    Ok(vec![ImportedFontFace {
        detected_family: metadata.family,
        file_name: copied_name,
        format,
        weight: metadata.weight,
        style: metadata.style,
    }])
}

fn import_font_faces_from_zip(
    zip_path: &Path,
    fonts_dir: &Path,
    batch_slug: &str,
) -> Result<Vec<ImportedFontFace>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("ZIP を開けません: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP の読み込みに失敗しました: {}", e))?;
    if archive.len() > 500 {
        return Err("ZIP 内のファイル数が多すぎます。".to_string());
    }

    let mut faces = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("ZIP エントリ読み込み失敗: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        let entry_name = entry.name().replace('\\', "/");
        if entry_name.contains("..") {
            return Err(format!("ZIP 内に不正なパスがあります: {}", entry_name));
        }
        if entry.size() > 100 * 1024 * 1024 {
            return Err(format!("ZIP 内のフォントが大きすぎます: {}", entry_name));
        }
        let file_name = Path::new(&entry_name)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("ZIP 内のファイル名を解釈できません: {}", entry_name))?;
        let extension = Path::new(file_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let Some(format) = font_format_for_extension(&extension) else {
            continue;
        };

        let copied_name = unique_imported_font_file_name(fonts_dir, batch_slug, file_name, &extension);
        let dest_path = fonts_dir.join(&copied_name);
        let mut data = Vec::new();
        entry.read_to_end(&mut data)
            .map_err(|e| format!("ZIP 内フォントの読み込みに失敗しました: {}", e))?;
        fs::write(&dest_path, data)
            .map_err(|e| format!("フォントファイルの展開に失敗しました: {}", e))?;
        let bytes = fs::read(&dest_path)
            .map_err(|e| format!("展開したフォントの再読み込みに失敗しました: {}", e))?;
        let metadata = detect_font_face_metadata(&bytes, file_name, &extension);
        faces.push(ImportedFontFace {
            detected_family: metadata.family,
            file_name: copied_name,
            format,
            weight: metadata.weight,
            style: metadata.style,
        });
    }
    if faces.is_empty() {
        return Err("ZIP 内に対応フォントが見つかりませんでした。woff2 / woff / otf / ttf を確認してください。".to_string());
    }
    Ok(faces)
}

fn unique_imported_font_file_name(
    fonts_dir: &Path,
    batch_slug: &str,
    source_name: &str,
    extension: &str,
) -> String {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| TemplateManager::slugify(value).replace('.', "-"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "font".to_string());
    let base = format!("{}-{}", batch_slug, stem);
    let ext = extension.trim_start_matches('.');
    let mut index = 1usize;
    loop {
        let candidate = if index == 1 {
            format!("{}.{}", base, ext)
        } else {
            format!("{}-{}.{}", base, index, ext)
        };
        if !fonts_dir.join(&candidate).exists() {
            return candidate;
        }
        index += 1;
    }
}

fn font_format_for_extension(extension: &str) -> Option<&'static str> {
    match extension.trim().to_ascii_lowercase().as_str() {
        "woff2" => Some("woff2"),
        "woff" => Some("woff"),
        "otf" => Some("opentype"),
        "ttf" => Some("truetype"),
        _ => None,
    }
}

fn guess_font_face_descriptor(file_name: &str) -> (u16, &'static str) {
    let lower = file_name.to_ascii_lowercase();
    let style = if lower.contains("italic") || lower.contains("oblique") {
        "italic"
    } else {
        "normal"
    };
    let weight = if lower.contains("thin") {
        100
    } else if lower.contains("extra-light")
        || lower.contains("extralight")
        || lower.contains("ultra-light")
        || lower.contains("ultralight")
    {
        200
    } else if lower.contains("light") {
        300
    } else if lower.contains("medium") {
        500
    } else if lower.contains("semi-bold")
        || lower.contains("semibold")
        || lower.contains("demi-bold")
        || lower.contains("demibold")
    {
        600
    } else if lower.contains("extra-bold")
        || lower.contains("extrabold")
        || lower.contains("ultra-bold")
        || lower.contains("ultrabold")
        || lower.contains("heavy")
    {
        800
    } else if lower.contains("black") {
        900
    } else if lower.contains("bold") {
        700
    } else {
        400
    };
    (weight, style)
}

#[derive(Debug, Clone)]
struct DetectedFontMetadata {
    family: Option<String>,
    weight: u16,
    style: &'static str,
}

fn detect_font_face_metadata(bytes: &[u8], source_name: &str, extension: &str) -> DetectedFontMetadata {
    let (fallback_weight, fallback_style) = guess_font_face_descriptor(source_name);
    let parse_bytes = match extension.to_ascii_lowercase().as_str() {
        "woff" => match wuff::decompress_woff1(bytes) {
            Ok(decoded) => decoded,
            Err(_) => {
                return DetectedFontMetadata {
                    family: None,
                    weight: fallback_weight,
                    style: fallback_style,
                };
            }
        },
        "woff2" => match wuff::decompress_woff2(bytes) {
            Ok(decoded) => decoded,
            Err(_) => {
                return DetectedFontMetadata {
                    family: None,
                    weight: fallback_weight,
                    style: fallback_style,
                };
            }
        },
        _ => bytes.to_vec(),
    };

    let Ok(face) = ttf_parser::Face::parse(&parse_bytes, 0) else {
        return DetectedFontMetadata {
            family: None,
            weight: fallback_weight,
            style: fallback_style,
        };
    };

    let family = extract_font_family_name(&face);
    let style = if face.is_italic() || face.is_oblique() {
        "italic"
    } else {
        "normal"
    };
    DetectedFontMetadata {
        family,
        weight: face.weight().to_number(),
        style,
    }
}

fn extract_font_family_name(face: &ttf_parser::Face<'_>) -> Option<String> {
    let preferred_ids = [
        name_id::TYPOGRAPHIC_FAMILY,
        name_id::FAMILY,
        name_id::WWS_FAMILY,
        name_id::FULL_NAME,
        name_id::POST_SCRIPT_NAME,
    ];
    for preferred in preferred_ids {
        let value = face
            .names()
            .into_iter()
            .find(|name| name.is_unicode() && name.name_id == preferred)
            .and_then(|name| name.to_string())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if value.is_some() {
            return value;
        }
    }
    None
}

fn fallback_font_family_name(source_name: &str) -> Option<String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let trimmed = stem
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn group_imported_faces_by_family(
    family_override: &str,
    faces: Vec<ImportedFontFace>,
    src_path: &Path,
) -> Result<Vec<(String, Vec<ImportedFontFace>)>, String> {
    let family_override = family_override.trim();
    if !family_override.is_empty() {
        return Ok(vec![(family_override.to_string(), faces)]);
    }

    let mut detected_families = HashSet::new();
    let mut missing_family_count = 0usize;
    for family in faces.iter().filter_map(|face| face.detected_family.as_ref()) {
        let trimmed = family.trim();
        if !trimmed.is_empty() {
            detected_families.insert(trimmed.to_string());
        }
    }
    for face in &faces {
        if face
            .detected_family
            .as_ref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            missing_family_count += 1;
        }
    }

    if detected_families.is_empty() {
        let fallback_family = fallback_font_family_name(
            src_path.file_name().and_then(|value| value.to_str()).unwrap_or("Imported Font"),
        )
        .ok_or_else(|| "フォント名を自動判定できませんでした。".to_string())?;
        return Ok(vec![(fallback_family, faces)]);
    }

    if detected_families.len() == 1 {
        let family = detected_families
            .into_iter()
            .next()
            .unwrap_or_else(|| "Imported Font".to_string());
        return Ok(vec![(family, faces)]);
    }

    if missing_family_count > 0 {
        return Err("ZIP 内に複数の font family があり、一部ファイルの family を判定できませんでした。family ごとに分けて取り込んでください。".to_string());
    }

    let mut grouped: HashMap<String, Vec<ImportedFontFace>> = HashMap::new();
    for face in faces {
        let family = face
            .detected_family
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "font family の自動判定に失敗しました。".to_string())?;
        grouped.entry(family).or_default().push(face);
    }
    let mut entries = grouped.into_iter().collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

fn build_imported_font_css(family: &str, faces: &[ImportedFontFace]) -> String {
    let escaped_family = family.replace('\\', "\\\\").replace('\'', "\\'");
    faces
        .iter()
        .map(|face| {
            format!(
                "@font-face {{\n  font-family: '{}';\n  src: url('./{}') format('{}');\n  font-weight: {};\n  font-style: {};\n  font-display: swap;\n}}\n",
                escaped_family,
                face.file_name,
                face.format,
                face.weight,
                face.style
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_template_export_denied_message(display_name: &str, note: Option<&str>) -> String {
    match note.map(str::trim).filter(|value| !value.is_empty()) {
        Some(note) => format!(
            "{} はテンプレート作者の設定によりエクスポートできません。理由: {} {}",
            display_name,
            note,
            default_template_export_guidance()
        ),
        None => format!(
            "{} はテンプレート作者の設定によりエクスポートできません。{}",
            display_name,
            default_template_export_guidance()
        ),
    }
}

fn default_template_export_guidance() -> &'static str {
    "自作コードだけでなく、同梱したフォント・画像・音声などの再配布ライセンスも確認してください。"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn imported_face(family: Option<&str>, file_name: &str) -> ImportedFontFace {
        ImportedFontFace {
            detected_family: family.map(|value| value.to_string()),
            file_name: file_name.to_string(),
            format: "opentype",
            weight: 400,
            style: "normal",
        }
    }

    #[test]
    fn group_imported_faces_by_family_splits_multiple_detected_families() {
        let faces = vec![
            imported_face(Some("Alpha Sans"), "alpha-regular.otf"),
            imported_face(Some("Alpha Sans"), "alpha-bold.otf"),
            imported_face(Some("Beta Serif"), "beta-regular.otf"),
        ];
        let grouped = group_imported_faces_by_family("", faces, Path::new("bundle.zip")).unwrap();
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].0, "Alpha Sans");
        assert_eq!(grouped[0].1.len(), 2);
        assert_eq!(grouped[1].0, "Beta Serif");
        assert_eq!(grouped[1].1.len(), 1);
    }

    #[test]
    fn group_imported_faces_by_family_merges_unknown_into_single_detected_family() {
        let faces = vec![
            imported_face(Some("Alpha Sans"), "alpha-regular.otf"),
            imported_face(None, "alpha-bold.woff2"),
        ];
        let grouped = group_imported_faces_by_family("", faces, Path::new("bundle.zip")).unwrap();
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].0, "Alpha Sans");
        assert_eq!(grouped[0].1.len(), 2);
    }

    #[test]
    fn group_imported_faces_by_family_rejects_ambiguous_unknown_faces() {
        let faces = vec![
            imported_face(Some("Alpha Sans"), "alpha-regular.otf"),
            imported_face(Some("Beta Serif"), "beta-regular.otf"),
            imported_face(None, "mystery.woff2"),
        ];
        let error = group_imported_faces_by_family("", faces, Path::new("bundle.zip")).unwrap_err();
        assert!(error.contains("複数の font family"));
    }
}
