//! SceneManager — シーンの CRUD とディスク永続化。
//!
//! %APPDATA%/live-comment-hub/scenes/ 以下のディレクトリを管理する。
//! 読み込み・保存・作成・削除・複製・名前変更・並べ替えを担当。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::state::scene::{Scene, SceneStore};

#[derive(Clone)]
pub struct SceneManager {
    scenes_dir: PathBuf,
}

impl SceneManager {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            scenes_dir: data_dir.join("scenes"),
        }
    }

    pub fn scenes_dir(&self) -> &Path {
        &self.scenes_dir
    }

    // --- 読み込み ---

    /// 全シーンをディスクから読み込み、SceneStore を返す。
    pub fn load_all(&self) -> SceneStore {
        let mut store = SceneStore::new();

        if !self.scenes_dir.exists() {
            tracing::warn!("Scenes directory not found: {:?}", self.scenes_dir);
            return store;
        }

        let entries = match fs::read_dir(&self.scenes_dir) {
            Ok(entries) => entries,
            Err(e) => {
                tracing::error!("Failed to read scenes directory: {}", e);
                return store;
            }
        };

        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }

            let scene_id = entry.file_name().to_string_lossy().to_string();
            let scene_path = entry.path().join("scene.json");

            match self.load_scene(&scene_id, &scene_path) {
                Some(scene) => {
                    tracing::debug!("Loaded scene: {} - {}", scene_id, scene.name);
                    store.scenes.insert(scene_id, scene);
                }
                None => {
                    tracing::warn!("Failed to load scene: {}", scene_id);
                }
            }
        }

        store.scene_order = self.load_scene_order();
        // sceneOrder.json に重複 id が混入していたら de-dup (= 順序維持)。
        // 過去バグ (= 復元後に scene を再作成すると scene_order に append され重複) で
        // 既存ファイルが汚れていても起動時に self-heal する。
        {
            let mut seen = std::collections::HashSet::new();
            let before = store.scene_order.len();
            store.scene_order.retain(|id| seen.insert(id.clone()));
            if store.scene_order.len() != before {
                tracing::warn!(
                    "load_scene_order: removed {} duplicate id(s) from sceneOrder.json",
                    before - store.scene_order.len()
                );
                let _ = self.save_scene_order(&store.scene_order);
            }
        }
        // sceneOrder.json が無い/空の場合はシーンキーでフォールバックし、ファイルを生成
        if store.scene_order.is_empty() && !store.scenes.is_empty() {
            let mut keys: Vec<String> = store.scenes.keys().cloned().collect();
            keys.sort();
            store.scene_order = keys;
            let _ = self.save_scene_order(&store.scene_order);
            tracing::info!("Created missing sceneOrder.json with {} scenes", store.scene_order.len());
        }
        store.active_scene_id = store
            .scene_order
            .first()
            .cloned();

        // エフェクト定義は EffectManager が所有。
        // SceneStore への格納は ModelQueue.init() で EffectManager から行う。

        tracing::info!(
            "Loaded {} scenes, {} effects, active: {:?}",
            store.scenes.len(),
            store.effect_params.len(),
            store.active_scene_id
        );

        store
    }

    fn load_scene(&self, scene_id: &str, path: &Path) -> Option<Scene> {
        let content = fs::read_to_string(path).ok()?;
        let mut scene: Scene = serde_json::from_str(&content)
            .map_err(|e| {
                tracing::error!("Failed to parse scene.json for {}: {}", scene_id, e);
                e
            })
            .ok()?;
        scene.id = scene_id.to_string();
        Some(scene)
    }

    fn load_scene_order(&self) -> Vec<String> {
        let order_path = self.scenes_dir.join("sceneOrder.json");
        let content = fs::read_to_string(&order_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    }

    // --- 保存 ---

    /// シーンをディスクに保存する。
    pub fn save_scene(&self, scene_id: &str, scene: &Scene) -> Result<(), String> {
        let scene_dir = self.scenes_dir.join(scene_id);
        fs::create_dir_all(&scene_dir)
            .map_err(|e| format!("Failed to create scene dir: {}", e))?;

        let scene_path = scene_dir.join("scene.json");
        let json = serde_json::to_string_pretty(scene)
            .map_err(|e| format!("Failed to serialize scene: {}", e))?;
        fs::write(&scene_path, json)
            .map_err(|e| format!("Failed to write scene.json: {}", e))?;

        tracing::debug!("Saved scene: {}", scene_id);
        Ok(())
    }

    /// シーン順序を保存する。
    pub fn save_scene_order(&self, order: &[String]) -> Result<(), String> {
        let order_path = self.scenes_dir.join("sceneOrder.json");
        let json = serde_json::to_string_pretty(order)
            .map_err(|e| format!("Failed to serialize scene order: {}", e))?;
        fs::write(&order_path, json)
            .map_err(|e| format!("Failed to write sceneOrder.json: {}", e))?;
        Ok(())
    }

    // --- 作成 ---

    /// 新しい空のシーンを作成する。
    pub fn create_scene(&self, scene_id: &str, name: &str) -> Result<Scene, String> {
        let scene_dir = self.scenes_dir.join(scene_id);
        if scene_dir.exists() {
            return Err(format!("Scene already exists: {}", scene_id));
        }

        fs::create_dir_all(&scene_dir)
            .map_err(|e| format!("Failed to create scene dir: {}", e))?;
        fs::create_dir_all(scene_dir.join("mascot/frames"))
            .map_err(|e| format!("Failed to create mascot dir: {}", e))?;
        fs::create_dir_all(scene_dir.join("mascot/particles"))
            .map_err(|e| format!("Failed to create particles dir: {}", e))?;
        fs::create_dir_all(scene_dir.join("performances"))
            .map_err(|e| format!("Failed to create performances dir: {}", e))?;

        let scene = Scene {
            id: scene_id.to_string(),
            name: name.to_string(),
            enabled: true,
            performances_enabled: true,
            performances: Vec::new(),
            templates_enabled: true,
            templates: Vec::new(),
            selected_template_id: String::new(),
            mascot: serde_json::Value::Object(serde_json::Map::new()),
        };

        self.save_scene(scene_id, &scene)?;

        tracing::info!("Created scene: {} - {}", scene_id, name);
        Ok(scene)
    }

    pub fn generate_scene_id(&self, name: &str) -> String {
        sanitize_scene_id_fragment(name, "untitled")
    }

    // --- 削除 ---

    /// シーンを削除する（ディレクトリごと削除）。
    pub fn delete_scene(&self, scene_id: &str) -> Result<(), String> {
        let scene_dir = self.scenes_dir.join(scene_id);
        if !scene_dir.exists() {
            return Err(format!("Scene not found: {}", scene_id));
        }

        fs::remove_dir_all(&scene_dir)
            .map_err(|e| format!("Failed to delete scene: {}", e))?;

        tracing::info!("Deleted scene: {}", scene_id);
        Ok(())
    }

    // --- 複製 ---

    /// シーンを複製する。
    pub fn duplicate_scene(
        &self,
        source_id: &str,
        new_id: &str,
        new_name: &str,
    ) -> Result<Scene, String> {
        let source_dir = self.scenes_dir.join(source_id);
        if !source_dir.exists() {
            return Err(format!("Source scene not found: {}", source_id));
        }

        let new_dir = self.scenes_dir.join(new_id);
        if new_dir.exists() {
            return Err(format!("Target scene already exists: {}", new_id));
        }

        // ディレクトリごとコピー
        copy_dir_recursive(&source_dir, &new_dir)
            .map_err(|e| format!("Failed to copy scene: {}", e))?;

        // scene.json を読み直して名前を変更
        let scene_path = new_dir.join("scene.json");
        if let Ok(content) = fs::read_to_string(&scene_path) {
            if let Ok(mut scene) = serde_json::from_str::<Scene>(&content) {
                scene.id = new_id.to_string();
                scene.name = new_name.to_string();
                self.save_scene(new_id, &scene)?;

                tracing::info!("Duplicated scene: {} -> {} ({})", source_id, new_id, new_name);
                return Ok(scene);
            }
        }

        Err("Failed to update duplicated scene".to_string())
    }

    pub fn generate_duplicate_scene_id(&self, new_name: &str) -> String {
        let base = sanitize_scene_id_fragment(new_name, "copy");
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let suffix = encode_base36(millis);
        let mut candidate = format!("{}-{}", base, suffix);
        let mut counter = 1u32;
        while self.scenes_dir.join(&candidate).exists() {
            candidate = format!("{}-{}-{}", base, suffix, counter);
            counter += 1;
        }
        candidate
    }

    // --- 名前変更 ---

    /// シーンの名前を変更する（scene.jsonのnameフィールドのみ）。
    pub fn rename_scene(&self, scene_id: &str, new_name: &str, store: &mut SceneStore) -> Result<(), String> {
        let scene = store.scenes.get_mut(scene_id)
            .ok_or_else(|| format!("Scene not found: {}", scene_id))?;
        scene.name = new_name.to_string();
        self.save_scene(scene_id, scene)?;
        tracing::info!("Renamed scene: {} -> {}", scene_id, new_name);
        Ok(())
    }
}

/// ディレクトリを再帰的にコピーする。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn sanitize_scene_id_fragment(name: &str, fallback: &str) -> String {
    let mut sanitized = String::with_capacity(name.len());
    let mut last_was_hyphen = false;
    for ch in name.chars() {
        let lowered = ch.to_ascii_lowercase();
        if matches!(lowered, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            continue;
        }
        if lowered.is_ascii_whitespace() || lowered == '-' {
            if !sanitized.is_empty() && !last_was_hyphen {
                sanitized.push('-');
                last_was_hyphen = true;
            }
            continue;
        }
        sanitized.push(lowered);
        last_was_hyphen = false;
    }
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn encode_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        chars.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + (digit - 10)) as char
        });
        value /= 36;
    }
    chars.iter().rev().collect()
}
