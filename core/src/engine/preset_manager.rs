//! PresetManager — アバタープリセットの管理。
//!
//! %APPDATA%/live-comment-hub/presets/ 配下のプリセットディレクトリと
//! assets/ ディレクトリ間のコピー・切替を管理する。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::infra::zip_utils;

#[derive(Clone)]
pub struct PresetManager {
    presets_dir: PathBuf,
    assets_dir: PathBuf,
    current_preset: String,
}

impl PresetManager {
    pub fn new(data_dir: &Path) -> Self {
        let presets_dir = data_dir.join("presets");
        let assets_dir = data_dir.join("assets");
        fs::create_dir_all(&presets_dir).ok();
        Self {
            presets_dir,
            assets_dir,
            current_preset: String::new(),
        }
    }

    pub fn set_current_preset(&mut self, name: &str) {
        self.current_preset = name.to_string();
    }

    pub fn current_preset(&self) -> &str {
        &self.current_preset
    }

    pub fn has_preset(&self, name: &str) -> bool {
        self.resolve_preset_dir(name)
            .map(|dir| dir.exists())
            .unwrap_or(false)
    }

    // ========== CRUD ==========

    /// プリセット名一覧を返す。
    pub fn list_presets(&self) -> Vec<String> {
        let entries = match fs::read_dir(&self.presets_dir) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// プリセットを切り替える。現在の assets を保存してから切替先を展開する。
    pub fn switch_preset(&mut self, name: &str, skip_save: bool) -> Result<String, String> {
        let preset_dir = self.resolve_preset_dir(name)?;
        if !preset_dir.exists() {
            return Err("プリセットが見つかりません。".to_string());
        }

        // 現在のプリセットを保存（スキップしない場合）
        if !skip_save && !self.current_preset.is_empty() {
            self.save_current_assets()?;
        }

        // 切替先を assets に展開
        self.replace_assets_with(&preset_dir)?;

        let preset_name = preset_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        self.current_preset = preset_name.clone();
        tracing::info!("Switched to preset: {}", preset_name);
        Ok(preset_name)
    }

    /// 現在の assets を新しいプリセットとして複製する。
    pub fn duplicate_preset(&self, new_name: &str) -> Result<String, String> {
        let sanitized = sanitize_preset_name(new_name);
        if sanitized.is_empty() {
            return Err("プリセット名が不正です。".to_string());
        }

        let new_dir = self.find_available_dir(&sanitized)?;
        zip_utils::copy_dir_recursive(&self.assets_dir, &new_dir)
            .map_err(|e| format!("プリセット複製失敗: {}", e))?;

        let name = new_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        tracing::info!("Duplicated preset: {}", name);
        Ok(name)
    }

    /// プリセットを削除する。削除したのが現在のプリセットなら残りに切り替え。
    pub fn delete_preset(&mut self, name: &str) -> Result<bool, String> {
        let preset_dir = self.resolve_preset_dir(name)?;
        if preset_dir.exists() {
            fs::remove_dir_all(&preset_dir)
                .map_err(|e| format!("プリセット削除失敗: {}", e))?;
        }

        // 削除したのが現在のプリセットなら切り替え
        if self.current_preset == name {
            let remaining = self.list_presets();
            if !remaining.is_empty() {
                let _ = self.switch_preset(&remaining[0], true);
            } else {
                self.current_preset.clear();
            }
        }

        tracing::info!("Deleted preset: {}", name);
        Ok(true)
    }

    /// プリセットを ZIP にエクスポートする。
    pub fn export_preset(&self, dest_path: &Path, export_name: &str) -> Result<(), String> {
        let file = fs::File::create(dest_path)
            .map_err(|e| format!("ZIPファイル作成失敗: {}", e))?;
        let mut writer = zip::ZipWriter::new(file);

        // preset.json（メタデータ）
        let meta = serde_json::json!({ "name": export_name });
        zip_utils::add_json_to_zip(&mut writer, "preset.json", &meta)?;

        // assets ディレクトリ内容
        zip_utils::add_dir_to_zip(&mut writer, &self.assets_dir, "")?;

        writer.finish().map_err(|e| format!("ZIP完了失敗: {}", e))?;
        tracing::info!("Exported preset: {}", export_name);
        Ok(())
    }

    /// ZIP からプリセットをインポートし、即座に切り替える。
    pub fn import_preset(&mut self, zip_path: &Path) -> Result<String, String> {
        let mut archive = zip_utils::open_validated_zip(zip_path)?;

        // プリセット名を取得
        let preset_name = read_preset_name_from_zip(&mut archive, zip_path);
        let sanitized = sanitize_preset_name(&preset_name);
        if sanitized.is_empty() {
            return Err("不正なプリセット名です。".to_string());
        }

        let preset_dir = self.find_available_dir(&sanitized)?;

        // 展開
        fs::create_dir_all(&preset_dir).ok();
        zip_utils::extract_entries_to_dir(&mut archive, "", &preset_dir)?;

        // preset.json は不要なので削除
        let meta_path = preset_dir.join("preset.json");
        if meta_path.exists() {
            fs::remove_file(&meta_path).ok();
        }

        // 即座に切り替え
        let name = preset_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        self.switch_preset(&name, false)?;

        Ok(self.current_preset.clone())
    }

    // ========== 内部ヘルパー ==========

    /// 現在の assets をプリセットディレクトリに保存する。
    fn save_current_assets(&self) -> Result<(), String> {
        if self.current_preset.is_empty() {
            return Ok(());
        }
        let preset_dir = match self.resolve_preset_dir(&self.current_preset) {
            Ok(d) => d,
            Err(_) => return Ok(()), // 不正なプリセット名は無視
        };

        // assets → preset に上書きコピー
        if preset_dir.exists() {
            fs::remove_dir_all(&preset_dir).ok();
        }
        zip_utils::copy_dir_recursive(&self.assets_dir, &preset_dir)
            .map_err(|e| format!("プリセット保存失敗: {}", e))?;
        Ok(())
    }

    /// プリセットディレクトリの内容を assets に展開する。
    fn replace_assets_with(&self, preset_dir: &Path) -> Result<(), String> {
        if self.assets_dir.exists() {
            fs::remove_dir_all(&self.assets_dir).ok();
        }
        zip_utils::copy_dir_recursive(preset_dir, &self.assets_dir)
            .map_err(|e| format!("プリセット切り替え失敗: {}", e))?;
        Ok(())
    }

    /// プリセット名からパスを解決する（パストラバーサル防止）。
    fn resolve_preset_dir(&self, name: &str) -> Result<PathBuf, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() || sanitize_preset_name(trimmed) != trimmed {
            return Err("プリセット名が不正です。".to_string());
        }
        let dir = self.presets_dir.join(trimmed);
        if !zip_utils::is_path_inside(&self.presets_dir, &dir) {
            return Err("不正なプリセットパスです。".to_string());
        }
        Ok(dir)
    }

    /// 重複しないプリセットディレクトリを見つける。
    fn find_available_dir(&self, name: &str) -> Result<PathBuf, String> {
        let dir = self.resolve_preset_dir(name)?;
        if !dir.exists() {
            return Ok(dir);
        }
        for i in 1..100 {
            let candidate_name = format!("{} ({})", name, i);
            let candidate = self.resolve_preset_dir(&candidate_name)?;
            if !candidate.exists() {
                return Ok(candidate);
            }
        }
        Err("利用可能なプリセット名が見つかりません。".to_string())
    }
}

/// プリセット名をサニタイズする。
fn sanitize_preset_name(name: &str) -> String {
    let mut s = name.to_string();
    s = s.chars().filter(|c| !"/\\".contains(*c) && !c.is_control()).collect();
    s = s.chars().filter(|c| !"<>:\"|?*".contains(*c)).collect();
    s = s.trim_start_matches('.').trim().to_string();
    s
}

/// ZIP 内の preset.json からプリセット名を読み取る。
fn read_preset_name_from_zip(archive: &mut zip::ZipArchive<fs::File>, zip_path: &Path) -> String {
    let fallback = zip_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "imported".to_string());

    if let Ok(mut entry) = archive.by_name("preset.json") {
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_ok() {
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(name) = meta.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        return name.to_string();
                    }
                }
            }
        }
    }

    fallback
}
