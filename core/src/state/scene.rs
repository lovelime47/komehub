use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const TEMPLATE_ASSET_PREFIX: &str = "assets/";

/// シーンストア（全シーンのデータを保持）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneStore {
    pub scenes: HashMap<String, Scene>,
    pub active_scene_id: Option<String>,
    pub scene_order: Vec<String>,
    /// エフェクト定義キャッシュ (effects.json)。
    /// SceneManager が所有・管理し、他エンジンは読み取り専用でアクセスする。
    #[serde(skip)]
    pub effects: Vec<EffectDefinition>,
    /// エフェクトID → デフォルトパラメータ（effects から構築した高速参照用マップ）。
    #[serde(skip)]
    pub effect_params: HashMap<String, serde_json::Value>,
}

impl Default for SceneStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneStore {
    pub fn new() -> Self {
        Self {
            scenes: HashMap::new(),
            active_scene_id: None,
            scene_order: Vec::new(),
            effects: Vec::new(),
            effect_params: HashMap::new(),
        }
    }

    pub fn has_enabled_reaction_trigger(&self) -> bool {
        self.scenes.values().any(|scene| {
            scene.enabled
                && scene.performances.iter().any(|performance| {
                    performance.enabled && performance.trigger.trigger_type == "reaction"
                })
        })
    }

    pub fn scene_list_items(&self) -> Vec<SceneListItem> {
        let order = if self.scene_order.is_empty() {
            let mut ids: Vec<String> = self.scenes.keys().cloned().collect();
            ids.sort();
            ids
        } else {
            self.scene_order.clone()
        };
        let mut items = Vec::new();
        for scene_id in order {
            let Some(scene) = self.scenes.get(&scene_id) else {
                continue;
            };
            items.push(SceneListItem {
                id: scene_id,
                name: scene.name.clone(),
                enabled: scene.enabled,
                performance_count: scene.performances.len() as u32,
            });
        }
        items
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneListItem {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub performance_count: u32,
}

/// scene.json のルート構造。
/// performances の各要素にはエフェクト固有パラメータがフラットに含まれるため、
/// 既知フィールド以外は extra に格納する。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    /// シーンID（ディレクトリ名から設定。JSONには含まれない）
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub performances_enabled: bool,
    #[serde(default)]
    pub performances: Vec<Performance>,
    #[serde(default = "default_true")]
    pub templates_enabled: bool,
    #[serde(default)]
    pub templates: Vec<SceneTemplate>,
    #[serde(default)]
    pub selected_template_id: String,
    #[serde(default)]
    pub mascot: serde_json::Value,
}

/// シーンに紐づくテンプレート設定。
/// テンプレート固有パラメータ（maxComments, customCss 等）は settings にフラット格納される。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTemplate {
    #[serde(default)]
    pub id: String,
    /// 旧データ互換用。新規保存では canonical template id を保持する。
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// テンプレート固有設定（uiSchema で定義されたキーがフラット格納）
    #[serde(default)]
    pub settings: HashMap<String, serde_json::Value>,
}

fn default_true() -> bool { true }

pub fn normalize_scene_selected_template_id(scene: &mut Scene) -> bool {
    let next_selected = if scene.templates.is_empty() {
        String::new()
    } else if let Some(template) = scene
        .templates
        .iter()
        .find(|template| {
            (!scene.selected_template_id.is_empty())
                && (template.id == scene.selected_template_id || template.name == scene.selected_template_id)
        })
    {
        if !template.id.is_empty() {
            template.id.clone()
        } else {
            template.name.clone()
        }
    } else if let Some(template) = scene.templates.iter().find(|template| template.enabled) {
        if !template.id.is_empty() {
            template.id.clone()
        } else {
            template.name.clone()
        }
    } else {
        let template = &scene.templates[0];
        if !template.id.is_empty() {
            template.id.clone()
        } else {
            template.name.clone()
        }
    };

    if scene.selected_template_id == next_selected {
        return false;
    }
    scene.selected_template_id = next_selected;
    true
}

pub fn normalize_template_settings_map_in_place(
    settings: &mut HashMap<String, serde_json::Value>,
) -> bool {
    let mut changed = false;

    if let Some(serde_json::Value::String(value)) = settings.get_mut("backgroundImage") {
        if let Some(canonical) = canonicalize_template_background_image(value) {
            if *value != canonical {
                *value = canonical;
                changed = true;
            }
        }
    }

    changed
}

/// scene.json に保存された template.settings を、現行 manifest.uiSchema の
/// 定義と突き合わせて整合を取った HashMap を返す。scene.json 側は書き換えない
/// （SSE 配信直前の読み取り側で適用することを想定した pure 関数）。
///
/// ルール:
/// - `ui_schema_keys` にある key で `scene_settings` に値があれば、その値を採用（ユーザー設定維持）
/// - `ui_schema_keys` にある key で `scene_settings` に値が無く、`ui_schema_defaults` に default が
///   あれば補完（新 key 対応）
/// - `ui_schema_keys` にある key で `scene_settings` にも default にも値が無い場合は結果に含めない
///   （例: `backgroundImage` のような image 型で default 未設定・ユーザー未選択）
/// - `ui_schema_keys` に無い key は結果に含めない（古い key を配信から除外、scene.json には残す）
///
/// **Why:** uiSchema には default 値が無い key（image 型など）が含まれうるため、
/// 「default マップのキー集合」だけでは「uiSchema に属する key 集合」を正確に表現できない。
/// 前版では default 無しの key が落ちて配信から消える不具合があった（chat-standard の
/// backgroundImage テスト失敗で顕在化）。
///
/// **How to apply:** `TemplateManager::get_template_ui_schema_keys` でキー集合、
/// `get_template_default_settings` で default マップを取得して渡す。
pub fn reconcile_template_settings_with_ui_schema(
    scene_settings: &HashMap<String, serde_json::Value>,
    ui_schema_keys: &std::collections::HashSet<String>,
    ui_schema_defaults: &HashMap<String, serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
    let mut result = HashMap::with_capacity(ui_schema_keys.len());
    for key in ui_schema_keys {
        if let Some(value) = scene_settings.get(key) {
            result.insert(key.clone(), value.clone());
        } else if let Some(default_value) = ui_schema_defaults.get(key) {
            result.insert(key.clone(), default_value.clone());
        }
        // scene 値も default も無い key は配信に含めない
    }
    result
}

pub fn normalize_template_settings_json_in_place(settings: &mut serde_json::Value) -> bool {
    let Some(obj) = settings.as_object_mut() else {
        return false;
    };
    let mut map: HashMap<String, serde_json::Value> = obj.clone().into_iter().collect();
    let changed = normalize_template_settings_map_in_place(&mut map);
    if changed {
        *obj = map.into_iter().collect();
    }
    changed
}

pub fn canonicalize_template_background_image(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with(TEMPLATE_ASSET_PREFIX) {
        return Some(trimmed.to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains(':') {
        return None;
    }
    if is_image_asset_name(trimmed) {
        return Some(format!("{}{}", TEMPLATE_ASSET_PREFIX, trimmed));
    }
    None
}

pub fn template_asset_relative_path(value: &str) -> Option<String> {
    let canonical = canonicalize_template_background_image(value)?;
    canonical
        .strip_prefix(TEMPLATE_ASSET_PREFIX)
        .map(|relative| relative.to_string())
}

fn is_image_asset_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 演出定義。エフェクト固有のパラメータ（count, scale等）は extra に格納。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Performance {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub effect: String,
    #[serde(default)]
    pub trigger: Trigger,
    #[serde(default)]
    pub cooldown: u64,
    #[serde(default)]
    pub assets: Vec<serde_json::Value>,
    #[serde(default)]
    pub sounds: Vec<String>,
    #[serde(default)]
    pub asset_meta: serde_json::Value,
    #[serde(default)]
    pub sound_meta: serde_json::Value,
    /// エフェクト固有パラメータ（count, scale, originY 等）
    /// Performance の JSON からシステムキー以外を全て収集する
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// トリガー定義。JS版のキーワード構造に対応。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    #[serde(rename = "type", default)]
    pub trigger_type: String,
    #[serde(default)]
    pub keywords: Vec<Keyword>,
    #[serde(default)]
    pub regex: bool,
    /// リアクショントリガーで反応する種別（空=全種類）
    #[serde(default)]
    pub reaction_types: Vec<String>,
    /// スパチャトリガーの最低金額（0=全額）
    #[serde(default)]
    pub min_amount: f64,
    /// スパチャトリガーでメンバー加入を含むか（デフォルトtrue）
    #[serde(default = "default_true")]
    pub include_membership: bool,
    /// listener DB 由来の追加条件。空なら listener 条件なし。
    ///
    /// 値は `first-time`, `returning`, `regular-arrival`, `regular`。
    /// 既存の keyword / superchat 条件に AND で適用する。
    #[serde(default)]
    pub listener_status: String,
    /// listener DB 原子条件。空なら条件なし、`yes` / `no` で AND 条件。
    #[serde(default)]
    pub listener_has_prior_comment: String,
    #[serde(default)]
    pub listener_first_comment_in_stream: String,
    #[serde(default)]
    pub listener_regular: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyword {
    pub text: String,
    #[serde(default)]
    pub regex: bool,
}

/// 演出エンジンが生成する発火指示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    pub scene_id: String,
    pub performance_id: String,
    pub effect: InstructionEffect,
    #[serde(default)]
    pub assets: Vec<serde_json::Value>,
    #[serde(default)]
    pub sounds: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<InstructionContext>,
    /// エフェクト固有パラメータをそのまま転送
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionEffect {
    pub id: String,
    #[serde(rename = "type")]
    pub effect_type: String,
    /// エフェクト定義のデフォルトパラメータ（effects.json から読み込み）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// effects.json のエフェクト定義。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub params: serde_json::Value,
    /// icon, badgeColor 等のその他フィールド
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// effects.json のルート
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectsFile {
    #[serde(default)]
    pub effects: Vec<EffectDefinition>,
}

/// プラグインの manifest.json
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub entry: String,
    #[serde(default)]
    pub min_hub_version: String,
    #[serde(default)]
    pub migrations: HashMap<String, MigrationStep>,
    /// その他フィールド（interface 等）
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// manifest.json の migrations 内の1バージョン分
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationStep {
    #[serde(default)]
    pub renamed: HashMap<String, String>,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub added: HashMap<String, serde_json::Value>,
}

/// エフェクトバージョン解決結果
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "action")]
pub enum EffectResolution {
    /// 新規追加
    Add { effect: EffectDefinition },
    /// 既存を使用（プラグイン健全）
    UseExisting { effect: EffectDefinition },
    /// 修復（同一バージョンでプラグイン上書き）
    Repair { effect: EffectDefinition },
    /// アップグレード可能（ユーザー確認が必要）
    UpgradeAvailable {
        effect_id: String,
        effect_name: String,
        current_version: String,
        new_version: String,
    },
    /// エラー（古いバージョンでの修復不可等）
    Error { error: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionContext {
    #[serde(default)]
    pub user_name: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub comment_html: String,
    #[serde(default)]
    pub profile_image: String,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub amount_display: String,
    #[serde(default)]
    pub sticker_image: String,
    #[serde(default)]
    pub tier_color: String,
    #[serde(default)]
    pub superchat_tier: String,
    #[serde(default)]
    pub is_member: bool,
    #[serde(default)]
    pub member_months: u32,
    #[serde(default)]
    pub is_membership: bool,
    #[serde(default)]
    pub membership_header: String,
    #[serde(default)]
    pub is_membership_gift: bool,
    /// `RawComment.is_membership_milestone` を参照。継続記念 (= "X カ月メンバー") か。
    #[serde(default)]
    pub is_membership_milestone: bool,
    #[serde(default)]
    pub gift_count: u32,
    #[serde(default)]
    pub member_badge_url: String,
    #[serde(default)]
    pub is_moderator: bool,
    #[serde(default)]
    pub is_owner: bool,
    #[serde(default)]
    pub is_verified: bool,
    #[serde(default)]
    pub is_first_time: bool,
    #[serde(default)]
    pub is_repeater: bool,
    #[serde(default)]
    pub listener_status: String,
    #[serde(default)]
    pub listener_tag: String,
    #[serde(default)]
    pub has_prior_listener_comment: bool,
    #[serde(default)]
    pub is_first_comment_in_stream: bool,
    #[serde(default)]
    pub listener_previous_stream_last_seen_at: String,
    #[serde(default)]
    pub listener_previous_stream_last_seen_at_ms: i64,
    #[serde(default)]
    pub listener_previous_comment_at: String,
    #[serde(default)]
    pub listener_previous_comment_at_ms: i64,
    #[serde(default)]
    pub listener_current_stream_comment_count: u32,
    #[serde(default)]
    pub listener_current_stream_superchat_amount_jpy: i64,
    #[serde(default)]
    pub listener_current_stream_superchat_amount_display: String,
    #[serde(default)]
    pub listener_previous_stream_id: String,
    #[serde(default)]
    pub listener_previous_stream_title: String,
    #[serde(default)]
    pub listener_previous_stream_started_at: String,
    #[serde(default)]
    pub listener_previous_stream_started_at_ms: i64,
    #[serde(default)]
    pub listener_regular_stream_count: u32,
    #[serde(default)]
    pub listener_regular_window_streams: u32,
    #[serde(default)]
    pub listener_regular_min_streams: u32,
    #[serde(default)]
    pub is_first_time_listener: bool,
    #[serde(default)]
    pub is_returning_listener: bool,
    #[serde(default)]
    pub is_regular_listener: bool,
    #[serde(default)]
    pub is_regular_arrival: bool,
}
