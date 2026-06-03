//! 演出エンジン — コメント/リアクションに対するトリガー評価、クールダウン、キュー管理。
//!
//! JS版 performance-engine.js の完全移植。
//! Model Queue から呼び出され、Static/Session を読み取って Instruction を生成する。

use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

use crate::common::state_machine::StateMachine;
use crate::common::superchat::{format_amount_display, superchat_tier_key};
use crate::state::comment::RawComment;
use crate::state::engine_status::EngineState;
use crate::state::scene::{
    Instruction, InstructionContext, InstructionEffect, SceneStore, Trigger,
};

const MAX_QUEUE_SUPERCHAT: usize = 10000;
const MAX_QUEUE_MANUAL: usize = 20;
const DEFAULT_EFFECT_DURATION_MS: u64 = 2000;

pub struct PerformanceEngine {
    sm: StateMachine<EngineState>,
    // 2026-05-09 仕様変更: 旧 banned_users (= 演出フィルタ) を撤廃。
    // BAN されたユーザーが「演出が出ない」ことで気付かないように、演出フィルタは廃止。
    // 視認抑制は app_config.hidden_listeners + UI 側 filter で行う。
    max_effects: usize,
    user_interval_sec: f64,

    // クールダウン（演出別・ユーザー別）
    cooldown_map: HashMap<String, Instant>,
    user_cooldown_map: HashMap<String, Instant>,

    // キュー（スパチャ優先・手動）
    superchat_queue: VecDeque<Instruction>,
    manual_queue: VecDeque<Instruction>,
    active_effect_count: usize,

    // アクティブエフェクトの終了予定時刻
    active_effects: VecDeque<(Instant, String)>,

    // テスト発火用巡回インデックス
    test_context_index: usize,
    test_reaction_index: usize,
}

// --- テスト発火用データ ---

struct TestContext {
    user_name: &'static str,
    comment: &'static str,
    amount: f64,
    currency: &'static str,
    is_member: bool,
    member_months: u32,
    is_membership: bool,
    membership_header: &'static str,
    is_membership_gift: bool,
    gift_count: u32,
    label: &'static str,
}

impl TestContext {
    fn to_instruction_context(&self) -> InstructionContext {
        InstructionContext {
            user_name: self.user_name.to_string(),
            comment: self.comment.to_string(),
            comment_html: String::new(),
            profile_image: String::new(),
            amount: self.amount,
            currency: self.currency.to_string(),
            amount_display: format_amount_display(self.amount, self.currency),
            sticker_image: String::new(),
            tier_color: String::new(),
            superchat_tier: superchat_tier_key(self.amount, self.currency, ""),
            is_member: self.is_member,
            member_months: self.member_months,
            is_membership: self.is_membership,
            membership_header: self.membership_header.to_string(),
            is_membership_gift: self.is_membership_gift,
            is_membership_milestone: false,
            gift_count: self.gift_count,
            member_badge_url: String::new(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
            listener_status: String::new(),
            listener_tag: String::new(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: false,
            listener_previous_stream_last_seen_at: String::new(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: String::new(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: String::new(),
            listener_previous_stream_id: String::new(),
            listener_previous_stream_title: String::new(),
            listener_previous_stream_started_at: String::new(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 0,
            listener_regular_min_streams: 0,
            is_first_time_listener: false,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
        }
    }
}

struct TestReaction {
    key: &'static str,
    label: &'static str,
}

static TEST_CONTEXTS: &[TestContext] = &[
    TestContext {
        user_name: "リスナーさん",
        comment: "こんばんは〜！",
        amount: 0.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "通常コメント",
    },
    TestContext {
        user_name: "メンバーさん",
        comment: "今日も配信ありがとう！",
        amount: 0.0,
        currency: "¥",
        is_member: true,
        member_months: 6,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "メンバーチャット（6か月）",
    },
    TestContext {
        user_name: "ゲストA",
        comment: "がんばれ〜",
        amount: 100.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥100（青）",
    },
    TestContext {
        user_name: "ゲストB",
        comment: "ナイス！",
        amount: 200.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥200（ティール）",
    },
    TestContext {
        user_name: "リスナーA",
        comment: "応援してます！",
        amount: 500.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥500（シアン）",
    },
    TestContext {
        user_name: "常連さん",
        comment: "最高の配信！",
        amount: 1000.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥1,000（黄）",
    },
    TestContext {
        user_name: "太客さん",
        comment: "今日の配信神回だった",
        amount: 2000.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥2,000（橙）",
    },
    TestContext {
        user_name: "推し活ガチ勢",
        comment: "推しが最高すぎる",
        amount: 5000.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥5,000（マゼンタ）",
    },
    TestContext {
        user_name: "大スポンサー",
        comment: "記念日おめでとう！",
        amount: 50000.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: false,
        gift_count: 0,
        label: "スパチャ ¥50,000（赤）",
    },
    TestContext {
        user_name: "新メンバー",
        comment: "よろしくお願いします！",
        amount: 0.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: true,
        membership_header: "メンバーになりました",
        is_membership_gift: false,
        gift_count: 0,
        label: "メンバー加入",
    },
    TestContext {
        user_name: "太っ腹さん",
        comment: "",
        amount: 0.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: true,
        gift_count: 5,
        label: "メンバーシップギフト（5人）",
    },
    TestContext {
        user_name: "大太っ腹さん",
        comment: "",
        amount: 0.0,
        currency: "¥",
        is_member: false,
        member_months: 0,
        is_membership: false,
        membership_header: "",
        is_membership_gift: true,
        gift_count: 20,
        label: "メンバーシップギフト（20人・オーラ）",
    },
];

static TEST_REACTIONS: &[TestReaction] = &[
    TestReaction {
        key: "heart",
        label: "❤ ハート",
    },
    TestReaction {
        key: "smile",
        label: "😄 スマイル",
    },
    TestReaction {
        key: "celebration",
        label: "🎉 お祝い",
    },
    TestReaction {
        key: "surprise",
        label: "😮 驚き",
    },
    TestReaction {
        key: "hundred",
        label: "💯 100点",
    },
];

/// evaluate の結果。Model Queue が処理する。
pub struct EvaluateResult {
    /// 即座に発火すべき指示
    pub fired: Vec<Instruction>,
    /// キューに入った数（ログ用）
    pub queued: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceClearSummary {
    pub active_effects: usize,
    pub superchat_queue: usize,
    pub manual_queue: usize,
}

impl Default for PerformanceEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PerformanceEngine {
    pub fn new() -> Self {
        Self {
            sm: StateMachine::new(EngineState::Initializing, "演出エンジン"),
            max_effects: 30,
            user_interval_sec: 5.0,
            cooldown_map: HashMap::new(),
            user_cooldown_map: HashMap::new(),
            superchat_queue: VecDeque::new(),
            manual_queue: VecDeque::new(),
            active_effect_count: 0,
            active_effects: VecDeque::new(),
            test_context_index: 0,
            test_reaction_index: 0,
        }
    }

    // ========== Static/Session セッター（イベント関数より先に呼ぶ） ==========

    // 2026-05-09 仕様変更: 旧 set_banned_users (= 演出フィルタ向け) を撤廃。

    pub fn set_global_cooldown(&mut self, max_effects: usize, user_interval_sec: f64) {
        self.max_effects = max_effects;
        self.user_interval_sec = user_interval_sec;
    }

    // ========== クエリ ==========

    /// 現在の状態を返す。
    pub fn state(&self) -> EngineState {
        self.sm.state()
    }

    pub fn is_paused(&self) -> bool {
        self.sm.state() == EngineState::Paused
    }

    pub fn clear_runtime(&mut self, scene_id: &str) -> PerformanceClearSummary {
        self.expire_active_effects();
        let all_scenes = scene_id.is_empty() || scene_id == "*";
        let before_active = self.active_effects.len();
        let before_superchat = self.superchat_queue.len();
        let before_manual = self.manual_queue.len();

        if all_scenes {
            self.active_effects.clear();
            self.superchat_queue.clear();
            self.manual_queue.clear();
        } else {
            self.active_effects.retain(|(_, active_scene_id)| active_scene_id != scene_id);
            self.superchat_queue.retain(|instruction| instruction.scene_id != scene_id);
            self.manual_queue.retain(|instruction| instruction.scene_id != scene_id);
        }
        self.active_effect_count = self.active_effects.len();

        PerformanceClearSummary {
            active_effects: before_active.saturating_sub(self.active_effects.len()),
            superchat_queue: before_superchat.saturating_sub(self.superchat_queue.len()),
            manual_queue: before_manual.saturating_sub(self.manual_queue.len()),
        }
    }

    // ========== イベント関数 ==========
    // ルール: Static/Session の更新が完了した後にイベント関数を呼ぶ。
    //         イベント関数内のガード条件が最新データを参照するため。

    /// イベント: エンジン初期化完了。
    /// Static（scenes, effects）の読み込み後に呼ぶ。
    pub fn initialized(&mut self) {
        match self.sm.state() {
            EngineState::Initializing => {
                self.sm.set_state(EngineState::Running);
            }
            _ => {
                tracing::warn!(
                    "想定されないタイミングで initialized: {:?}",
                    self.sm.state()
                );
            }
        }
    }

    /// イベント: 一時停止が要求された。
    pub fn pause_requested(&mut self) {
        match self.sm.state() {
            EngineState::Running => {
                self.sm
                    .push_state(EngineState::Paused, EngineState::Running);
            }
            EngineState::Paused => {
                // 既に一時停止中: 何もしない
            }
            _ => {
                tracing::warn!(
                    "想定されないタイミングで pause_requested: {:?}",
                    self.sm.state()
                );
            }
        }
    }

    /// イベント: 再開が要求された。
    pub fn resume_requested(&mut self) {
        match self.sm.state() {
            EngineState::Paused => {
                self.sm.pop_state();
            }
            EngineState::Running => {
                // 既に実行中: 何もしない
            }
            _ => {
                tracing::warn!(
                    "想定されないタイミングで resume_requested: {:?}",
                    self.sm.state()
                );
            }
        }
    }

    /// 期限切れのアクティブエフェクトを回収してカウントを減らす
    fn expire_active_effects(&mut self) {
        let now = Instant::now();
        while let Some((expires_at, _)) = self.active_effects.front() {
            if *expires_at <= now {
                self.active_effects.pop_front();
                if self.active_effect_count > 0 {
                    self.active_effect_count -= 1;
                }
            } else {
                break;
            }
        }
    }

    /// コメントに対して全シーンの全演出をスキャンし、マッチした演出を発火/キューする。
    pub fn evaluate(&mut self, comment: &RawComment, scenes: &SceneStore) -> EvaluateResult {
        self.expire_active_effects();

        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        // 一時停止中: スパチャはキューに入れる、それ以外は捨てる
        if self.is_paused() {
            if comment.has_gift || comment.amount > 0.0 || comment.is_membership {
                result.queued += self.queue_paused_superchat(comment, scenes);
            }
            return result;
        }

        if self.sm.state() != EngineState::Running {
            return result;
        }

        // 2026-05-09 仕様変更: 旧 BAN フィルタは撤廃 (= 演出には全員のコメが反映される)。
        // BAN は UI 表示抑制のみ (= app_config.hidden_listeners、UI 側 filter)。
        let user_id = if !comment.id.is_empty() {
            &comment.id
        } else {
            &comment.name
        };

        // user_interval (= per-user throttle) は 1 コメント単位で 1 回だけ判定する。
        // 演出ごとに pass / update すると、 同一コメントに複数演出が一致したとき先頭の
        // 演出が user_cooldown を更新し、 後続演出が user_interval で弾かれて
        // 「1 コメント = 1 演出」 しか発火しない不具合になる
        // (= 2026-05-24 芽吹き [comment-display] と固定表示 [first-time-welcome] の
        //  同時発火不可を実踏)。 ループ前に一度評価し、 非課金演出が 1 つでも発火したら
        // ループ後に 1 回だけ user_cooldown を消費する。
        let user_cooldown_ok = self.pass_user_cooldown(user_id);
        let mut user_interval_consumed = false;

        for scene in scenes.scenes.values() {
            if !scene.enabled || !scene.performances_enabled {
                continue;
            }

            for (perf_idx, perf) in scene.performances.iter().enumerate() {
                if !perf.enabled {
                    continue;
                }

                if self.match_trigger(&perf.trigger, comment) {
                    let trigger_type = &perf.trigger.trigger_type;
                    // 課金 trigger (= superchat) は user_interval を bypass する。
                    // 連投高額スパチャや課金行為そのものを抑制で殺さないため、
                    // user_cooldown の参照も更新も行わない (= 完全独立)。
                    let bypass_user_interval = trigger_type == "superchat";
                    if !bypass_user_interval && !user_cooldown_ok {
                        continue;
                    }

                    let cooldown_key = format!("{}:{}", scene.id, perf.id);
                    if !self.pass_cooldown(&cooldown_key, perf.cooldown) {
                        continue;
                    }

                    let instruction = self.build_instruction(
                        &scene.id,
                        perf,
                        perf_idx,
                        scene.performances.len(),
                        Some(comment),
                        scenes,
                    );

                    if should_queue(trigger_type) {
                        self.enqueue(instruction, trigger_type);
                        self.update_cooldown(&cooldown_key);
                        if !bypass_user_interval {
                            user_interval_consumed = true;
                        }
                        result.queued += 1;
                    } else if self.active_effect_count < self.max_effects {
                        self.fire(&mut result.fired, instruction);
                        self.update_cooldown(&cooldown_key);
                        if !bypass_user_interval {
                            user_interval_consumed = true;
                        }
                    }
                    // else: 上限到達、keyword は破棄
                }
            }
        }

        // 非課金演出が 1 つでも発火 / キューされたら、 このコメントの user_interval を 1 回だけ消費。
        if user_interval_consumed {
            self.update_user_cooldown(user_id);
        }

        // キュー処理
        self.process_queue(&mut result.fired);

        result
    }

    /// リアクションによる演出判定
    pub fn evaluate_reaction(
        &mut self,
        reaction_type: &str,
        scenes: &SceneStore,
    ) -> EvaluateResult {
        self.expire_active_effects();

        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        if self.sm.state() != EngineState::Running {
            return result;
        }

        for scene in scenes.scenes.values() {
            if !scene.enabled || !scene.performances_enabled {
                continue;
            }

            for (perf_idx, perf) in scene.performances.iter().enumerate() {
                if !perf.enabled {
                    continue;
                }
                if perf.trigger.trigger_type != "reaction" {
                    continue;
                }

                // リアクション種別のマッチ
                let reaction_types = get_reaction_types(&perf.trigger);
                if !reaction_types.contains(&reaction_type.to_string()) {
                    continue;
                }

                let cooldown_key = format!("{}:{}", scene.id, perf.id);
                if !self.pass_cooldown(&cooldown_key, perf.cooldown) {
                    continue;
                }

                let mut instruction = self.build_instruction(
                    &scene.id,
                    perf,
                    perf_idx,
                    scene.performances.len(),
                    None,
                    scenes,
                );
                instruction.extra.insert(
                    "reactionType".to_string(),
                    serde_json::Value::String(reaction_type.to_string()),
                );

                if should_queue("reaction") {
                    self.enqueue(instruction, "reaction");
                    self.update_cooldown(&cooldown_key);
                    result.queued += 1;
                } else if self.active_effect_count < self.max_effects {
                    self.fire(&mut result.fired, instruction);
                    self.update_cooldown(&cooldown_key);
                }
            }
        }

        self.process_queue(&mut result.fired);

        result
    }

    /// 手動発火
    pub fn trigger_manual(
        &mut self,
        scene_id: &str,
        performance_id: &str,
        scenes: &SceneStore,
    ) -> EvaluateResult {
        self.expire_active_effects();

        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        let scene = match scenes.scenes.get(scene_id) {
            Some(s) => s,
            None => return result,
        };

        let (perf_idx, perf) = match scene
            .performances
            .iter()
            .enumerate()
            .find(|(_, p)| p.id == performance_id)
        {
            Some(found) => found,
            None => return result,
        };

        let instruction = self.build_instruction(
            scene_id,
            perf,
            perf_idx,
            scene.performances.len(),
            None,
            scenes,
        );
        self.enqueue(instruction, "manual");
        result.queued += 1;

        self.process_queue(&mut result.fired);

        result
    }

    /// テスト発火（ダミーコンテキスト付き、クールダウン無視）
    pub fn trigger_test(
        &mut self,
        scene_id: &str,
        performance_id: &str,
        scenes: &SceneStore,
    ) -> (EvaluateResult, serde_json::Value) {
        self.expire_active_effects();
        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        let scene = match scenes.scenes.get(scene_id) {
            Some(s) => s,
            None => return (result, serde_json::json!(false)),
        };

        let (perf_idx, perf) = match scene
            .performances
            .iter()
            .enumerate()
            .find(|(_, p)| p.id == performance_id)
        {
            Some(found) => found,
            None => return (result, serde_json::json!(false)),
        };

        let mut instruction = self.build_instruction(
            scene_id,
            perf,
            perf_idx,
            scene.performances.len(),
            None,
            scenes,
        );

        if perf
            .extra
            .get("requiresContext")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            // プレースホルダーを使う演出: テストコンテキスト巡回
            let ctx = &TEST_CONTEXTS[self.test_context_index % TEST_CONTEXTS.len()];
            self.test_context_index += 1;
            instruction.context = Some(ctx.to_instruction_context());

            let next_ctx = &TEST_CONTEXTS[self.test_context_index % TEST_CONTEXTS.len()];
            self.enqueue(instruction, "manual");
            result.queued += 1;
            self.process_queue(&mut result.fired);

            let reply = serde_json::json!({
                "label": ctx.label,
                "nextLabel": next_ctx.label
            });
            (result, reply)
        } else {
            instruction.context = Some(InstructionContext {
                user_name: "テストユーザー".to_string(),
                comment: "テストコメント".to_string(),
                comment_html: String::new(),
                profile_image: String::new(),
                amount: 0.0,
                currency: "¥".to_string(),
                amount_display: String::new(),
                sticker_image: String::new(),
                tier_color: String::new(),
                superchat_tier: String::new(),
                is_member: false,
                member_months: 0,
                is_membership: false,
                membership_header: String::new(),
                is_membership_gift: false,
                is_membership_milestone: false,
                gift_count: 0,
                member_badge_url: String::new(),
                is_moderator: false,
                is_owner: false,
                is_verified: false,
                is_first_time: false,
                is_repeater: false,
                listener_status: String::new(),
                listener_tag: String::new(),
                has_prior_listener_comment: false,
                is_first_comment_in_stream: false,
                listener_previous_stream_last_seen_at: String::new(),
                listener_previous_stream_last_seen_at_ms: 0,
                listener_previous_comment_at: String::new(),
                listener_previous_comment_at_ms: 0,
                listener_current_stream_comment_count: 0,
                listener_current_stream_superchat_amount_jpy: 0,
                listener_current_stream_superchat_amount_display: String::new(),
                listener_previous_stream_id: String::new(),
                listener_previous_stream_title: String::new(),
                listener_previous_stream_started_at: String::new(),
                listener_previous_stream_started_at_ms: 0,
                listener_regular_stream_count: 0,
                listener_regular_window_streams: 0,
                listener_regular_min_streams: 0,
                is_first_time_listener: false,
                is_returning_listener: false,
                is_regular_listener: false,
                is_regular_arrival: false,
            });
            self.enqueue(instruction, "manual");
            result.queued += 1;
            self.process_queue(&mut result.fired);
            (result, serde_json::json!(true))
        }
    }

    /// カスタムコンテキストでテスト発火（トリガー判定あり）
    pub fn trigger_test_with_context(
        &mut self,
        scene_id: &str,
        performance_id: &str,
        custom_context: &serde_json::Value,
        scenes: &SceneStore,
    ) -> (EvaluateResult, serde_json::Value) {
        self.expire_active_effects();
        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        let scene = match scenes.scenes.get(scene_id) {
            Some(s) => s,
            None => return (result, serde_json::json!(false)),
        };

        let (perf_idx, perf) = match scene
            .performances
            .iter()
            .enumerate()
            .find(|(_, p)| p.id == performance_id)
        {
            Some(found) => found,
            None => return (result, serde_json::json!(false)),
        };

        // ダミーコメントを構築してトリガー判定
        let amount = custom_context
            .get("amount")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let is_membership_gift = custom_context
            .get("isMembershipGift")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let user_name = custom_context
            .get("userName")
            .and_then(|v| v.as_str())
            .unwrap_or("テストユーザー")
            .to_string();
        let gift_count = custom_context
            .get("giftCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let comment = custom_context
            .get("comment")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let resolved_comment = if is_membership_gift && comment.trim().is_empty() {
            format!(
                "{}さんがメンバーシップギフトを{}個送りました。",
                user_name, gift_count
            )
        } else {
            comment
        };
        let comment = RawComment {
            id: "__test__".to_string(),
            user_id: String::new(),
            live_id: String::new(),
            name: user_name,
            display_name: String::new(),
            screen_name: String::new(),
            nickname: String::new(),
            comment: resolved_comment,
            comment_html: custom_context
                .get("commentHtml")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            speech_text: String::new(),
            profile_image: custom_context
                .get("profileImage")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            original_profile_image: custom_context
                .get("originalProfileImage")
                .or_else(|| custom_context.get("_originalProfileImage"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            timestamp: String::new(),
            has_gift: amount > 0.0 || is_membership_gift,
            amount,
            currency: custom_context
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("¥")
                .to_string(),
            amount_display: custom_context
                .get("amountDisplay")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(|| {
                    format_amount_display(
                        amount,
                        custom_context
                            .get("currency")
                            .and_then(|v| v.as_str())
                            .unwrap_or("¥"),
                    )
                }),
            sticker_image: custom_context
                .get("stickerImage")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            tier_color: custom_context
                .get("tierColor")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            superchat_tier: custom_context
                .get("superchatTier")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(|| {
                    superchat_tier_key(
                        amount,
                        custom_context
                            .get("currency")
                            .and_then(|v| v.as_str())
                            .unwrap_or("¥"),
                        custom_context
                            .get("tierColor")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                    )
                }),
            is_member: custom_context
                .get("isMember")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            member_months: custom_context
                .get("memberMonths")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            is_membership: custom_context
                .get("isMembership")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            membership_header: custom_context
                .get("membershipHeader")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            is_membership_gift,
            is_membership_gift_redemption: false,
            is_membership_milestone: custom_context
                .get("isMembershipMilestone")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            gift_count,
            member_badge_url: custom_context
                .get("memberBadgeUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            is_moderator: custom_context
                .get("isModerator")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_owner: custom_context
                .get("isOwner")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_verified: custom_context
                .get("isVerified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_first_time: custom_context
                .get("isFirstTime")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_repeater: custom_context
                .get("isRepeater")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            listener_status: custom_context
                .get("listenerStatus")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_tag: custom_context
                .get("listenerTag")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            has_prior_listener_comment: custom_context
                .get("hasPriorListenerComment")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_first_comment_in_stream: custom_context
                .get("isFirstCommentInStream")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            listener_previous_stream_last_seen_at: custom_context
                .get("listenerPreviousStreamLastSeenAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_previous_stream_last_seen_at_ms: custom_context
                .get("listenerPreviousStreamLastSeenAtMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            listener_previous_comment_at: custom_context
                .get("listenerPreviousCommentAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_previous_comment_at_ms: custom_context
                .get("listenerPreviousCommentAtMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            listener_current_stream_comment_count: custom_context
                .get("listenerCurrentStreamCommentCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            listener_current_stream_superchat_amount_jpy: custom_context
                .get("listenerCurrentStreamSuperchatAmountJpy")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            listener_current_stream_superchat_amount_display: custom_context
                .get("listenerCurrentStreamSuperchatAmountDisplay")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_previous_stream_id: custom_context
                .get("listenerPreviousStreamId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_previous_stream_title: custom_context
                .get("listenerPreviousStreamTitle")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_previous_stream_started_at: custom_context
                .get("listenerPreviousStreamStartedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            listener_previous_stream_started_at_ms: custom_context
                .get("listenerPreviousStreamStartedAtMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            listener_regular_stream_count: custom_context
                .get("listenerRegularStreamCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            listener_regular_window_streams: custom_context
                .get("listenerRegularWindowStreams")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            listener_regular_min_streams: custom_context
                .get("listenerRegularMinStreams")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            is_first_time_listener: custom_context
                .get("isFirstTimeListener")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_returning_listener: custom_context
                .get("isReturningListener")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_regular_listener: custom_context
                .get("isRegularListener")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_regular_arrival: custom_context
                .get("isRegularArrival")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            comment_visible: custom_context
                .get("commentVisible")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            auto_moderated: custom_context
                .get("autoModerated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_template_test: true,
            is_backfill: false,
            komehub_trace: serde_json::Value::Null,
        };

        if !self.match_trigger(&perf.trigger, &comment) {
            return (result, serde_json::json!({ "matched": false }));
        }

        let instruction = self.build_instruction(
            scene_id,
            perf,
            perf_idx,
            scene.performances.len(),
            Some(&comment),
            scenes,
        );
        // build_instruction already sets context from comment
        self.enqueue(instruction, "manual");
        result.queued += 1;
        self.process_queue(&mut result.fired);
        (result, serde_json::json!({ "matched": true }))
    }

    /// リアクション用テスト発火（巡回）
    pub fn trigger_test_reaction(
        &mut self,
        scene_id: &str,
        performance_id: &str,
        scenes: &SceneStore,
    ) -> (EvaluateResult, serde_json::Value) {
        self.expire_active_effects();
        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        let scene = match scenes.scenes.get(scene_id) {
            Some(s) => s,
            None => return (result, serde_json::json!(false)),
        };

        let (perf_idx, perf) = match scene
            .performances
            .iter()
            .enumerate()
            .find(|(_, p)| p.id == performance_id)
        {
            Some(found) => found,
            None => return (result, serde_json::json!(false)),
        };

        let mut instruction = self.build_instruction(
            scene_id,
            perf,
            perf_idx,
            scene.performances.len(),
            None,
            scenes,
        );

        // 演出に設定されたリアクション種別のみ巡回
        let configured_types = get_reaction_types(&perf.trigger);
        let filtered: Vec<&TestReaction> = TEST_REACTIONS
            .iter()
            .filter(|r| configured_types.contains(&r.key.to_string()))
            .collect();

        let (key, label, next_label) = if !filtered.is_empty() {
            let idx = self.test_reaction_index % filtered.len();
            self.test_reaction_index += 1;
            let next_idx = self.test_reaction_index % filtered.len();
            (
                filtered[idx].key,
                filtered[idx].label,
                filtered[next_idx].label,
            )
        } else {
            let idx = self.test_reaction_index % TEST_REACTIONS.len();
            self.test_reaction_index += 1;
            let next_idx = self.test_reaction_index % TEST_REACTIONS.len();
            (
                TEST_REACTIONS[idx].key,
                TEST_REACTIONS[idx].label,
                TEST_REACTIONS[next_idx].label,
            )
        };

        instruction.extra.insert(
            "reactionType".to_string(),
            serde_json::Value::String(key.to_string()),
        );
        instruction.context = Some(InstructionContext {
            user_name: String::new(),
            comment: String::new(),
            comment_html: String::new(),
            profile_image: String::new(),
            amount: 0.0,
            currency: "¥".to_string(),
            amount_display: String::new(),
            sticker_image: String::new(),
            tier_color: String::new(),
            superchat_tier: String::new(),
            is_member: false,
            member_months: 0,
            is_membership: false,
            membership_header: String::new(),
            is_membership_gift: false,
            is_membership_milestone: false,
            gift_count: 0,
            member_badge_url: String::new(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
            listener_status: String::new(),
            listener_tag: String::new(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: false,
            listener_previous_stream_last_seen_at: String::new(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: String::new(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: String::new(),
            listener_previous_stream_id: String::new(),
            listener_previous_stream_title: String::new(),
            listener_previous_stream_started_at: String::new(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 0,
            listener_regular_min_streams: 0,
            is_first_time_listener: false,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
        });
        self.enqueue(instruction, "manual");
        result.queued += 1;
        self.process_queue(&mut result.fired);

        (
            result,
            serde_json::json!({ "label": label, "nextLabel": next_label }),
        )
    }

    /// リアクション用テスト発火（指定エモーション・トリガー判定あり）
    pub fn trigger_test_reaction_custom(
        &mut self,
        scene_id: &str,
        performance_id: &str,
        reaction_key: &str,
        scenes: &SceneStore,
    ) -> (EvaluateResult, serde_json::Value) {
        self.expire_active_effects();
        let mut result = EvaluateResult {
            fired: Vec::new(),
            queued: 0,
        };

        let scene = match scenes.scenes.get(scene_id) {
            Some(s) => s,
            None => return (result, serde_json::json!(false)),
        };

        let (perf_idx, perf) = match scene
            .performances
            .iter()
            .enumerate()
            .find(|(_, p)| p.id == performance_id)
        {
            Some(found) => found,
            None => return (result, serde_json::json!(false)),
        };

        // 実際の evaluate_reaction と同じトリガー判定
        if perf.trigger.trigger_type != "reaction" {
            return (result, serde_json::json!(false));
        }
        let configured_types = get_reaction_types(&perf.trigger);
        if !configured_types.contains(&reaction_key.to_string()) {
            return (result, serde_json::json!({ "matched": false }));
        }

        let mut instruction = self.build_instruction(
            scene_id,
            perf,
            perf_idx,
            scene.performances.len(),
            None,
            scenes,
        );
        instruction.extra.insert(
            "reactionType".to_string(),
            serde_json::Value::String(reaction_key.to_string()),
        );
        instruction.context = Some(InstructionContext {
            user_name: String::new(),
            comment: String::new(),
            comment_html: String::new(),
            profile_image: String::new(),
            amount: 0.0,
            currency: "¥".to_string(),
            amount_display: String::new(),
            sticker_image: String::new(),
            tier_color: String::new(),
            superchat_tier: String::new(),
            is_member: false,
            member_months: 0,
            is_membership: false,
            membership_header: String::new(),
            is_membership_gift: false,
            is_membership_milestone: false,
            gift_count: 0,
            member_badge_url: String::new(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
            listener_status: String::new(),
            listener_tag: String::new(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: false,
            listener_previous_stream_last_seen_at: String::new(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: String::new(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: String::new(),
            listener_previous_stream_id: String::new(),
            listener_previous_stream_title: String::new(),
            listener_previous_stream_started_at: String::new(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 0,
            listener_regular_min_streams: 0,
            is_first_time_listener: false,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
        });
        self.enqueue(instruction, "manual");
        result.queued += 1;
        self.process_queue(&mut result.fired);
        (result, serde_json::json!(true))
    }

    // --- 内部メソッド ---

    fn build_instruction(
        &self,
        scene_id: &str,
        perf: &crate::state::scene::Performance,
        perf_idx: usize,
        total_perfs: usize,
        comment: Option<&RawComment>,
        scenes: &SceneStore,
    ) -> Instruction {
        let z_order = total_perfs - perf_idx;

        let context = comment.map(|c| InstructionContext {
            user_name: c.name.clone(),
            comment: c.comment.clone(),
            comment_html: c.comment_html.clone(),
            profile_image: c.profile_image.clone(),
            amount: c.amount,
            currency: c.currency.clone(),
            amount_display: c.amount_display.clone(),
            sticker_image: c.sticker_image.clone(),
            tier_color: c.tier_color.clone(),
            superchat_tier: c.superchat_tier.clone(),
            is_member: c.is_member,
            member_months: c.member_months,
            is_membership: c.is_membership,
            membership_header: c.membership_header.clone(),
            is_membership_gift: c.is_membership_gift,
            is_membership_milestone: c.is_membership_milestone,
            gift_count: c.gift_count,
            member_badge_url: c.member_badge_url.clone(),
            is_moderator: c.is_moderator,
            is_owner: c.is_owner,
            is_verified: c.is_verified,
            is_first_time: c.is_first_time,
            is_repeater: c.is_repeater,
            listener_status: c.listener_status.clone(),
            listener_tag: c.listener_tag.clone(),
            has_prior_listener_comment: c.has_prior_listener_comment,
            is_first_comment_in_stream: c.is_first_comment_in_stream,
            listener_previous_stream_last_seen_at: c.listener_previous_stream_last_seen_at.clone(),
            listener_previous_stream_last_seen_at_ms: c.listener_previous_stream_last_seen_at_ms,
            listener_previous_comment_at: c.listener_previous_comment_at.clone(),
            listener_previous_comment_at_ms: c.listener_previous_comment_at_ms,
            listener_current_stream_comment_count: c.listener_current_stream_comment_count,
            listener_current_stream_superchat_amount_jpy: c.listener_current_stream_superchat_amount_jpy,
            listener_current_stream_superchat_amount_display: c.listener_current_stream_superchat_amount_display.clone(),
            listener_previous_stream_id: c.listener_previous_stream_id.clone(),
            listener_previous_stream_title: c.listener_previous_stream_title.clone(),
            listener_previous_stream_started_at: c.listener_previous_stream_started_at.clone(),
            listener_previous_stream_started_at_ms: c.listener_previous_stream_started_at_ms,
            listener_regular_stream_count: c.listener_regular_stream_count,
            listener_regular_window_streams: c.listener_regular_window_streams,
            listener_regular_min_streams: c.listener_regular_min_streams,
            is_first_time_listener: c.is_first_time_listener,
            is_returning_listener: c.is_returning_listener,
            is_regular_listener: c.is_regular_listener,
            is_regular_arrival: c.is_regular_arrival,
        });

        let mut extra = perf.extra.clone();
        extra.insert(
            "zOrder".to_string(),
            serde_json::Value::Number(serde_json::Number::from(z_order)),
        );

        Instruction {
            scene_id: scene_id.to_string(),
            performance_id: perf.id.clone(),
            effect: InstructionEffect {
                id: perf.effect.clone(),
                effect_type: perf.effect.clone(),
                params: scenes.effect_params.get(&perf.effect).cloned(),
            },
            assets: perf.assets.clone(),
            sounds: perf.sounds.clone(),
            context,
            extra,
        }
    }

    fn match_trigger(&self, trigger: &Trigger, comment: &RawComment) -> bool {
        if !self.match_listener_condition(trigger, comment) {
            return false;
        }
        match trigger.trigger_type.as_str() {
            "keyword" => self.match_keyword(trigger, comment),
            "superchat" => self.match_superchat(trigger, comment),
            "reaction" | "manual" | "firsttime" => false,
            _ => false,
        }
    }

    fn match_listener_condition(&self, trigger: &Trigger, comment: &RawComment) -> bool {
        if !match_optional_bool_condition(
            &trigger.listener_has_prior_comment,
            comment.has_prior_listener_comment,
        ) {
            return false;
        }
        if !match_optional_bool_condition(
            &trigger.listener_first_comment_in_stream,
            comment.is_first_comment_in_stream,
        ) {
            return false;
        }
        if !match_optional_bool_condition(&trigger.listener_regular, comment.is_regular_listener) {
            return false;
        }

        match trigger.listener_status.as_str() {
            "" | "none" => true,
            "first-time" => {
                comment.listener_status == "first-time" || comment.is_first_time_listener
            }
            "returning" => comment.listener_status == "returning" || comment.is_returning_listener,
            "regular-arrival" => {
                comment.listener_status == "regular-arrival" || comment.is_regular_arrival
            }
            "regular" => comment.is_regular_listener,
            // 「帰還」(= 離脱判定状態から返り咲き)。 直近 N 枠で発言ゼロかつ過去枠経験あり、
            // この枠で初発言の per-comment イベント。 2026-05-14 追加。
            "long-absence" => comment.listener_status == "long-absence",
            _ => false,
        }
    }

    fn match_keyword(&self, trigger: &Trigger, comment: &RawComment) -> bool {
        let keywords = &trigger.keywords;
        // 空配列 = 全コメントに反応
        if keywords.is_empty() {
            return true;
        }

        // 照合対象 = body (= 絵文字を `:musical_note:` 等の shortcode 化したプレーンテキスト)
        // + comment_html 内の絵文字本体 (= `data-emoji-id`)。
        // YouTube は絵文字を emoji run で送り、body には shortcode が入る (= 理由は
        // `innertube_parser::extract_text_from_runs` のコメント参照)。絵文字本体は
        // comment_html の `data-emoji-id` 属性に残るため、配信者が keyword に絵文字 (🎵) を
        // 設定しても、shortcode (`:musical_note:`) を設定しても、text run の記号 (♪) を
        // 設定してもマッチさせる。
        // (= 2026-05-26 「弾幕トリガーペンライト」が 🎵🎶 絵文字で発火しなかった根本修正。
        //  視聴者の音符入力はほぼ絵文字で、body には shortcode しか残らず照合できなかった)
        let mut haystack = comment.comment.to_lowercase();
        let emoji_chars = extract_emoji_ids(&comment.comment_html);
        if !emoji_chars.is_empty() {
            haystack.push(' ');
            haystack.push_str(&emoji_chars.to_lowercase());
        }

        for kw in keywords {
            if kw.text.is_empty() {
                continue;
            }
            if kw.regex {
                // 正規表現マッチ (= body + 絵文字本体を連結した haystack を対象)
                match regex::Regex::new(&format!("(?i){}", kw.text)) {
                    Ok(re) => {
                        if re.is_match(&haystack) {
                            return true;
                        }
                    }
                    Err(_) => continue, // 正規表現エラーは無視
                }
            } else if haystack.contains(&kw.text.to_lowercase()) {
                return true;
            }
        }
        false
    }

    fn match_superchat(&self, trigger: &Trigger, comment: &RawComment) -> bool {
        // メンバー加入（設定で有効な場合のみ）
        if comment.is_membership {
            return trigger.include_membership;
        }
        // スパチャ/ステッカー/メンバーシップギフト
        if !comment.has_gift {
            return false;
        }
        // minAmount チェック（0=全額マッチ）
        if trigger.min_amount <= 0.0 {
            return true;
        }
        comment.amount >= trigger.min_amount
    }

    fn pass_cooldown(&self, key: &str, cooldown_sec: u64) -> bool {
        if cooldown_sec == 0 {
            return true;
        }
        match self.cooldown_map.get(key) {
            None => true,
            Some(last) => last.elapsed().as_secs() >= cooldown_sec,
        }
    }

    fn update_cooldown(&mut self, key: &str) {
        self.cooldown_map.insert(key.to_string(), Instant::now());
    }

    fn pass_user_cooldown(&self, user_id: &str) -> bool {
        if user_id.is_empty() || self.user_interval_sec <= 0.0 {
            return true;
        }
        match self.user_cooldown_map.get(user_id) {
            None => true,
            Some(last) => last.elapsed().as_secs_f64() >= self.user_interval_sec,
        }
    }

    fn update_user_cooldown(&mut self, user_id: &str) {
        if !user_id.is_empty() {
            self.user_cooldown_map
                .insert(user_id.to_string(), Instant::now());
        }
    }

    fn enqueue(&mut self, instruction: Instruction, trigger_type: &str) {
        match trigger_type {
            "superchat" => {
                if self.superchat_queue.len() >= MAX_QUEUE_SUPERCHAT {
                    tracing::warn!("Superchat queue full, dropping oldest");
                    self.superchat_queue.pop_front();
                }
                self.superchat_queue.push_back(instruction);
            }
            _ => {
                if self.manual_queue.len() >= MAX_QUEUE_MANUAL {
                    tracing::warn!("Manual queue full, dropping oldest");
                    self.manual_queue.pop_front();
                }
                self.manual_queue.push_back(instruction);
            }
        }
    }

    fn process_queue(&mut self, fired: &mut Vec<Instruction>) {
        if self.is_paused() {
            return;
        }
        // スパチャ優先で処理
        while self.active_effect_count < self.max_effects {
            if let Some(inst) = self.superchat_queue.pop_front() {
                self.fire(fired, inst);
            } else if let Some(inst) = self.manual_queue.pop_front() {
                self.fire(fired, inst);
            } else {
                break;
            }
        }
    }

    fn fire(&mut self, fired: &mut Vec<Instruction>, instruction: Instruction) {
        tracing::debug!(
            "Fire: {} scene={} perf={}",
            instruction.effect.effect_type,
            instruction.scene_id,
            instruction.performance_id
        );

        self.active_effect_count += 1;

        // エフェクト終了予定時刻を記録（duration後にカウントを減らす）
        let duration_ms = instruction
            .extra
            .get("duration")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_EFFECT_DURATION_MS);
        let expires = Instant::now() + std::time::Duration::from_millis(duration_ms);
        self.active_effects.push_back((expires, instruction.scene_id.clone()));

        fired.push(instruction);
    }

    fn queue_paused_superchat(&mut self, comment: &RawComment, scenes: &SceneStore) -> usize {
        let mut queued = 0;
        for scene in scenes.scenes.values() {
            if !scene.enabled || !scene.performances_enabled {
                continue;
            }
            for (perf_idx, perf) in scene.performances.iter().enumerate() {
                if !perf.enabled {
                    continue;
                }
                if self.match_trigger(&perf.trigger, comment) {
                    let instruction = self.build_instruction(
                        &scene.id,
                        perf,
                        perf_idx,
                        scene.performances.len(),
                        Some(comment),
                        scenes,
                    );
                    self.enqueue(instruction, "superchat");
                    queued += 1;
                }
            }
        }
        queued
    }
}

fn match_optional_bool_condition(condition: &str, actual: bool) -> bool {
    match condition {
        "" | "any" | "none" => true,
        "yes" | "true" => actual,
        "no" | "false" => !actual,
        _ => false,
    }
}

fn should_queue(trigger_type: &str) -> bool {
    matches!(trigger_type, "manual" | "superchat")
}

/// comment_html の `data-emoji-id="..."` 属性値を全て抽出し空白区切りで連結する。
///
/// standard emoji は絵文字本体 (🎵 等)、custom emoji は `UCxxx/xxx` 形式の ID が入る
/// (= `innertube_parser::extract_html_from_runs` が付与)。body は絵文字を shortcode 化
/// しているため、絵文字そのものを keyword 照合に使えるよう本関数で補完する。
/// custom emoji の ID は keyword と一致しないので含めても無害。
fn extract_emoji_ids(comment_html: &str) -> String {
    // 大半のコメントは絵文字を含まない → 属性が無ければ regex を回さず即返す。
    if comment_html.is_empty() || !comment_html.contains("data-emoji-id=") {
        return String::new();
    }
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"data-emoji-id="([^"]*)""#).unwrap());
    let mut out = String::new();
    for cap in re.captures_iter(comment_html) {
        if let Some(m) = cap.get(1) {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(m.as_str());
        }
    }
    out
}

fn get_reaction_types(trigger: &Trigger) -> Vec<String> {
    // trigger.reaction_types が空なら全種類
    if trigger.reaction_types.is_empty() {
        vec![
            "heart".to_string(),
            "smile".to_string(),
            "celebration".to_string(),
            "surprise".to_string(),
            "hundred".to_string(),
        ]
    } else {
        trigger.reaction_types.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::scene::{Performance, Scene, Trigger};
    use std::collections::HashMap;

    fn scene_store_with_superchat_performance() -> SceneStore {
        let mut store = SceneStore::new();
        let scene_id = "scene-paused-superchat".to_string();
        let scene = Scene {
            id: scene_id.clone(),
            name: "Paused Superchat".to_string(),
            enabled: true,
            performances_enabled: true,
            performances: vec![Performance {
                id: "superchat-display".to_string(),
                name: "Superchat Display".to_string(),
                enabled: true,
                effect: "com.comment-hub.fixed".to_string(),
                trigger: Trigger {
                    trigger_type: "superchat".to_string(),
                    keywords: Vec::new(),
                    regex: false,
                    reaction_types: Vec::new(),
                    min_amount: 0.0,
                    include_membership: true,
                    listener_status: String::new(),
                    listener_has_prior_comment: String::new(),
                    listener_first_comment_in_stream: String::new(),
                    listener_regular: String::new(),
                },
                cooldown: 0,
                assets: Vec::new(),
                sounds: Vec::new(),
                asset_meta: serde_json::Value::Null,
                sound_meta: serde_json::Value::Null,
                extra: HashMap::new(),
            }],
            templates_enabled: true,
            templates: Vec::new(),
            selected_template_id: String::new(),
            mascot: serde_json::Value::Null,
        };
        store.scenes.insert(scene_id.clone(), scene);
        store.scene_order.push(scene_id.clone());
        store.active_scene_id = Some(scene_id);
        store
    }

    fn raw_comment(overrides: impl FnOnce(&mut RawComment)) -> RawComment {
        let mut comment = RawComment {
            id: "comment-id".to_string(),
            user_id: "user-id".to_string(),
            live_id: "live-id".to_string(),
            name: "@tester".to_string(),
            display_name: String::new(),
            screen_name: String::new(),
            nickname: String::new(),
            comment: "hello".to_string(),
            comment_html: String::new(),
            speech_text: String::new(),
            profile_image: String::new(),
            original_profile_image: String::new(),
            timestamp: String::new(),
            has_gift: false,
            amount: 0.0,
            currency: "JPY".to_string(),
            amount_display: String::new(),
            sticker_image: String::new(),
            tier_color: String::new(),
            superchat_tier: String::new(),
            is_member: false,
            member_months: 0,
            is_membership: false,
            membership_header: String::new(),
            is_membership_gift: false,
            is_membership_milestone: false,
            gift_count: 0,
            member_badge_url: String::new(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
            listener_status: String::new(),
            listener_tag: String::new(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: false,
            listener_previous_stream_last_seen_at: String::new(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: String::new(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: String::new(),
            listener_previous_stream_id: String::new(),
            listener_previous_stream_title: String::new(),
            listener_previous_stream_started_at: String::new(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 0,
            listener_regular_min_streams: 0,
            is_first_time_listener: false,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
            comment_visible: true,
            auto_moderated: false,
            is_template_test: false,
            is_membership_gift_redemption: false,
            is_backfill: false,
            komehub_trace: serde_json::Value::Null,
        };
        overrides(&mut comment);
        comment
    }

    #[test]
    fn paused_superchat_is_queued_and_fired_after_resume() {
        let scenes = scene_store_with_superchat_performance();
        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.pause_requested();

        let superchat = raw_comment(|comment| {
            comment.id = "superchat-comment".to_string();
            comment.has_gift = true;
            comment.amount = 1000.0;
            comment.amount_display = "¥1,000".to_string();
        });
        let paused_result = engine.evaluate(&superchat, &scenes);
        assert_eq!(paused_result.queued, 1);
        assert!(paused_result.fired.is_empty());

        engine.resume_requested();
        let normal = raw_comment(|comment| {
            comment.id = "normal-comment".to_string();
            comment.comment = "no trigger".to_string();
        });
        let resumed_result = engine.evaluate(&normal, &scenes);
        assert_eq!(resumed_result.fired.len(), 1);
        assert_eq!(resumed_result.fired[0].performance_id, "superchat-display");
        assert_eq!(
            resumed_result.fired[0]
                .context
                .as_ref()
                .map(|context| context.amount_display.as_str()),
            Some("¥1,000")
        );
    }

    #[test]
    fn paused_regular_comment_is_dropped() {
        let scenes = scene_store_with_superchat_performance();
        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.pause_requested();

        let normal = raw_comment(|comment| {
            comment.id = "normal-comment".to_string();
            comment.comment = "hello while paused".to_string();
        });
        let paused_result = engine.evaluate(&normal, &scenes);
        assert_eq!(paused_result.queued, 0);
        assert!(paused_result.fired.is_empty());

        engine.resume_requested();
        let resumed_result = engine.evaluate(&normal, &scenes);
        assert!(resumed_result.fired.is_empty());
    }

    #[test]
    fn listener_status_condition_filters_keyword_trigger() {
        let engine = PerformanceEngine::new();
        let trigger = Trigger {
            trigger_type: "keyword".to_string(),
            keywords: vec![crate::state::scene::Keyword {
                text: "hello".to_string(),
                regex: false,
            }],
            listener_status: "first-time".to_string(),
            ..Trigger::default()
        };

        let first_time = raw_comment(|comment| {
            comment.comment = "hello".to_string();
            comment.listener_status = "first-time".to_string();
            comment.is_first_time_listener = true;
        });
        assert!(engine.match_trigger(&trigger, &first_time));

        let returning = raw_comment(|comment| {
            comment.comment = "hello".to_string();
            comment.listener_status = "returning".to_string();
            comment.is_returning_listener = true;
        });
        assert!(!engine.match_trigger(&trigger, &returning));
    }

    #[test]
    fn regular_listener_condition_matches_regular_flag() {
        let engine = PerformanceEngine::new();
        let trigger = Trigger {
            trigger_type: "keyword".to_string(),
            listener_status: "regular".to_string(),
            ..Trigger::default()
        };

        let regular = raw_comment(|comment| {
            comment.comment = "anything".to_string();
            comment.is_regular_listener = true;
        });
        assert!(engine.match_trigger(&trigger, &regular));

        let not_regular = raw_comment(|comment| {
            comment.comment = "anything".to_string();
        });
        assert!(!engine.match_trigger(&trigger, &not_regular));
    }

    fn scene_store_with_keyword_and_superchat() -> SceneStore {
        let mut store = SceneStore::new();
        let scene_id = "scene-mix".to_string();
        let scene = Scene {
            id: scene_id.clone(),
            name: "Mix".to_string(),
            enabled: true,
            performances_enabled: true,
            performances: vec![
                Performance {
                    id: "kw-hello".to_string(),
                    name: "Hello Keyword".to_string(),
                    enabled: true,
                    effect: "com.comment-hub.cracker".to_string(),
                    trigger: Trigger {
                        trigger_type: "keyword".to_string(),
                        keywords: vec![crate::state::scene::Keyword {
                            text: "hello".to_string(),
                            regex: false,
                        }],
                        regex: false,
                        reaction_types: Vec::new(),
                        min_amount: 0.0,
                        include_membership: false,
                        listener_status: String::new(),
                        listener_has_prior_comment: String::new(),
                        listener_first_comment_in_stream: String::new(),
                        listener_regular: String::new(),
                    },
                    cooldown: 0,
                    assets: Vec::new(),
                    sounds: Vec::new(),
                    asset_meta: serde_json::Value::Null,
                    sound_meta: serde_json::Value::Null,
                    extra: HashMap::new(),
                },
                Performance {
                    id: "sc-display".to_string(),
                    name: "Superchat Display".to_string(),
                    enabled: true,
                    effect: "com.comment-hub.fixed".to_string(),
                    trigger: Trigger {
                        trigger_type: "superchat".to_string(),
                        keywords: Vec::new(),
                        regex: false,
                        reaction_types: Vec::new(),
                        min_amount: 0.0,
                        include_membership: true,
                        listener_status: String::new(),
                        listener_has_prior_comment: String::new(),
                        listener_first_comment_in_stream: String::new(),
                        listener_regular: String::new(),
                    },
                    cooldown: 0,
                    assets: Vec::new(),
                    sounds: Vec::new(),
                    asset_meta: serde_json::Value::Null,
                    sound_meta: serde_json::Value::Null,
                    extra: HashMap::new(),
                },
            ],
            templates_enabled: true,
            templates: Vec::new(),
            selected_template_id: String::new(),
            mascot: serde_json::Value::Null,
        };
        store.scenes.insert(scene_id.clone(), scene);
        store.scene_order.push(scene_id.clone());
        store.active_scene_id = Some(scene_id);
        store
    }

    #[test]
    fn superchat_bypasses_user_interval() {
        // 同一ユーザーが user_interval 内に連続でスパチャを投げても両方 queue/fire される (= 課金 trigger は抑制対象外)
        let scenes = scene_store_with_superchat_performance();
        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.set_global_cooldown(30, 5.0);

        let superchat1 = raw_comment(|comment| {
            comment.id = "user-paying".to_string();
            comment.has_gift = true;
            comment.amount = 1000.0;
            comment.amount_display = "¥1,000".to_string();
        });
        let r1 = engine.evaluate(&superchat1, &scenes);
        assert_eq!(r1.fired.len(), 1, "1 つ目のスパチャは発火");

        // 直後 (= user_interval 5 秒以内) に同一ユーザーから 2 つ目のスパチャ
        let superchat2 = raw_comment(|comment| {
            comment.id = "user-paying".to_string();
            comment.has_gift = true;
            comment.amount = 5000.0;
            comment.amount_display = "¥5,000".to_string();
        });
        let r2 = engine.evaluate(&superchat2, &scenes);
        assert_eq!(
            r2.fired.len(),
            1,
            "user_interval 内でも 2 つ目のスパチャは発火する (= 課金 trigger は user_interval 適用外)"
        );
    }

    #[test]
    fn superchat_does_not_update_user_cooldown() {
        // スパチャは user_cooldown を更新しないので、 直後の同一ユーザーの通常コメも抑制されない
        let scenes = scene_store_with_keyword_and_superchat();
        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.set_global_cooldown(30, 5.0);

        // 1. 同一ユーザーからスパチャ (= keyword "hello" に match しない本文)
        let sc = raw_comment(|comment| {
            comment.id = "user-mix".to_string();
            comment.comment = "thanks!".to_string();
            comment.has_gift = true;
            comment.amount = 1000.0;
            comment.amount_display = "¥1,000".to_string();
        });
        let r1 = engine.evaluate(&sc, &scenes);
        assert_eq!(r1.fired.len(), 1, "スパチャ自体は発火 (= sc-display のみ)");

        // 2. 直後に同一ユーザーから keyword コメ
        let kw = raw_comment(|comment| {
            comment.id = "user-mix".to_string();
            comment.comment = "hello".to_string();
        });
        let r2 = engine.evaluate(&kw, &scenes);
        assert_eq!(
            r2.fired.len(),
            1,
            "スパチャは user_cooldown を更新しないので、 直後の通常コメも発火する"
        );
    }

    #[test]
    fn keyword_respects_user_interval() {
        // 通常 trigger (= keyword) は同一ユーザー連投で 2 つ目が抑制される (= 既存挙動の確認)
        let scenes = scene_store_with_keyword_and_superchat();
        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.set_global_cooldown(30, 5.0);

        let kw1 = raw_comment(|comment| {
            comment.id = "user-spam".to_string();
            comment.comment = "hello".to_string();
        });
        let r1 = engine.evaluate(&kw1, &scenes);
        assert_eq!(r1.fired.len(), 1, "1 つ目の keyword コメは発火");

        let kw2 = raw_comment(|comment| {
            comment.id = "user-spam".to_string();
            comment.comment = "hello again".to_string();
        });
        let r2 = engine.evaluate(&kw2, &scenes);
        assert!(
            r2.fired.is_empty(),
            "user_interval 内の同一ユーザー連投 keyword は抑制される (= 既存挙動)"
        );
    }

    fn keyword_perf(id: &str, effect: &str) -> Performance {
        Performance {
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            effect: effect.to_string(),
            trigger: Trigger {
                trigger_type: "keyword".to_string(),
                keywords: Vec::new(),
                ..Trigger::default()
            },
            cooldown: 0,
            assets: Vec::new(),
            sounds: Vec::new(),
            asset_meta: serde_json::Value::Null,
            sound_meta: serde_json::Value::Null,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn single_comment_fires_all_matching_performances() {
        // 1 コメントに複数の keyword 演出 (= 空キーワード = 全コメ一致) が当たったら全部発火する。
        // user_interval を演出ごとに消費すると先頭だけ発火して後続が弾かれる回帰バグ
        // (= 2026-05-24 芽吹き [comment-display] と固定表示 [first-time-welcome] が
        //  1 コメントで同時発火しなかった) を防ぐ。
        let mut store = SceneStore::new();
        let scene = Scene {
            id: "scene-two-kw".to_string(),
            name: "TwoKw".to_string(),
            enabled: true,
            performances_enabled: true,
            performances: vec![
                keyword_perf("comment-display", "com.comment-hub.sprout"),
                keyword_perf("first-time-welcome", "com.comment-hub.fixed"),
            ],
            templates_enabled: true,
            templates: Vec::new(),
            selected_template_id: String::new(),
            mascot: serde_json::Value::Null,
        };
        store.scenes.insert("scene-two-kw".to_string(), scene);
        store.scene_order.push("scene-two-kw".to_string());
        store.active_scene_id = Some("scene-two-kw".to_string());

        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.set_global_cooldown(30, 5.0);

        let comment = raw_comment(|c| {
            c.id = "viewer-1".to_string();
            c.comment = "こんばんは".to_string();
        });
        let r = engine.evaluate(&comment, &store);
        assert_eq!(
            r.fired.len(),
            2,
            "1 コメントに一致する 2 演出は両方発火する (= user_interval は 1 コメント単位で消費)"
        );

        // 同一ユーザーの連投は user_interval で全演出まとめて抑制される (= 既存 throttle 維持)
        let spam = raw_comment(|c| {
            c.id = "viewer-1".to_string();
            c.comment = "連投".to_string();
        });
        let r2 = engine.evaluate(&spam, &store);
        assert!(
            r2.fired.is_empty(),
            "user_interval 内の連投は全演出まとめて抑制される"
        );
    }

    /// 「弾幕トリガーペンライト」相当の screen-overlay + 音符 keyword (= ♪♬♩🎵#♭🎶) シーンを作る。
    fn scene_store_penlight() -> SceneStore {
        let mut store = SceneStore::new();
        let keywords = ["♪", "♬", "♩", "🎵", "#", "♭", "🎶"];
        let penlight = Performance {
            id: "penlight".to_string(),
            name: "弾幕トリガーペンライト".to_string(),
            enabled: true,
            effect: "com.comment-hub.screen-overlay".to_string(),
            trigger: Trigger {
                trigger_type: "keyword".to_string(),
                keywords: keywords
                    .iter()
                    .map(|k| crate::state::scene::Keyword {
                        text: k.to_string(),
                        regex: false,
                    })
                    .collect(),
                include_membership: true,
                ..Trigger::default()
            },
            cooldown: 0,
            assets: Vec::new(),
            sounds: Vec::new(),
            asset_meta: serde_json::Value::Null,
            sound_meta: serde_json::Value::Null,
            extra: HashMap::new(),
        };
        let scene = Scene {
            id: "singing".to_string(),
            name: "歌枠".to_string(),
            enabled: true,
            performances_enabled: true,
            performances: vec![penlight],
            templates_enabled: false,
            templates: Vec::new(),
            selected_template_id: String::new(),
            mascot: serde_json::Value::Null,
        };
        store.scenes.insert("singing".to_string(), scene);
        store.scene_order.push("singing".to_string());
        store.active_scene_id = Some("singing".to_string());
        store
    }

    fn fresh_engine() -> PerformanceEngine {
        let mut engine = PerformanceEngine::new();
        engine.initialized();
        engine.set_global_cooldown(30, 5.0);
        engine
    }

    #[test]
    fn penlight_fires_on_text_symbol_keyword() {
        // ♪♬♩♭ は YouTube が text run で送り body にそのまま入る → 従来どおり発火する。
        let scenes = scene_store_penlight();
        let mut engine = fresh_engine();
        let comment = raw_comment(|c| {
            c.id = "viewer-note".to_string();
            c.comment = "いい歌だね♪".to_string();
        });
        let r = engine.evaluate(&comment, &scenes);
        assert_eq!(r.fired.len(), 1, "♪ (text run) を含むコメントで発火する");
        assert_eq!(
            r.fired[0].effect.effect_type,
            "com.comment-hub.screen-overlay"
        );
    }

    #[test]
    fn penlight_fires_on_emoji_via_data_emoji_id() {
        // 視聴者の 🎵 絵文字は body では :musical_note: に shortcode 化されるが、絵文字本体は
        // comment_html の data-emoji-id に残る。配信者が keyword に絵文字 🎵 を設定した penlight が
        // その絵文字コメントで発火することを保証する (= 2026-05-26 「弾幕トリガーペンライト」が
        // 絵文字で発火しなかった根本修正の回帰防止)。
        let scenes = scene_store_penlight();
        let mut engine = fresh_engine();
        let comment = raw_comment(|c| {
            c.id = "viewer-emoji".to_string();
            c.comment = ":musical_note:いい歌".to_string(); // body は shortcode 化済み
            c.comment_html =
                "<img class=\"emoji\" src=\"x\" alt=\":musical_note:\" data-emoji-id=\"🎵\">いい歌"
                    .to_string();
        });
        let r = engine.evaluate(&comment, &scenes);
        assert_eq!(
            r.fired.len(),
            1,
            "🎵 絵文字 (comment_html の data-emoji-id) で発火する"
        );
        assert_eq!(
            r.fired[0].effect.effect_type,
            "com.comment-hub.screen-overlay"
        );
    }

    #[test]
    fn penlight_does_not_fire_without_note() {
        // 音符を一切含まないコメントでは発火しない (= 過剰発火しないことの確認)。
        let scenes = scene_store_penlight();
        let mut engine = fresh_engine();
        let comment = raw_comment(|c| {
            c.id = "viewer-plain".to_string();
            c.comment = "こんばんは".to_string();
        });
        let r = engine.evaluate(&comment, &scenes);
        assert!(r.fired.is_empty(), "音符なしコメントでは発火しない");
    }

    #[test]
    fn atomic_listener_conditions_are_combined_with_trigger() {
        let engine = PerformanceEngine::new();
        let trigger = Trigger {
            trigger_type: "keyword".to_string(),
            listener_has_prior_comment: "yes".to_string(),
            listener_first_comment_in_stream: "yes".to_string(),
            listener_regular: "no".to_string(),
            ..Trigger::default()
        };

        let returning_arrival = raw_comment(|comment| {
            comment.has_prior_listener_comment = true;
            comment.is_first_comment_in_stream = true;
            comment.is_regular_listener = false;
        });
        assert!(engine.match_trigger(&trigger, &returning_arrival));

        let regular_arrival = raw_comment(|comment| {
            comment.has_prior_listener_comment = true;
            comment.is_first_comment_in_stream = true;
            comment.is_regular_listener = true;
        });
        assert!(!engine.match_trigger(&trigger, &regular_arrival));
    }

}
