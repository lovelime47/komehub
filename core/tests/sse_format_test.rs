//! SSE JSON フォーマット互換テスト
//!
//! Rust サイドカーが生成する JSON が JS オーバーレイ (effects-overlay/js/renderer.js)
//! の期待するフィールド名・構造と一致することを検証する。

use serde_json::{json, Value};
use std::collections::HashMap;

mod state {
    pub mod comment {
        #![allow(dead_code)]
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/state/comment.rs"));
    }
    pub mod scene {
        #![allow(dead_code)]
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/state/scene.rs"));
    }
}

mod surface {
    pub mod sse_shared {
        #![allow(dead_code)]
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/surface/sse_shared.rs"
        ));
    }
}

use state::scene::{Instruction, InstructionContext, InstructionEffect};
use surface::sse_shared::SseMessage;

/// テスト用に全フィールドが埋まった Instruction を生成する
fn make_full_instruction() -> Instruction {
    let mut extra = HashMap::new();
    extra.insert("count".to_string(), json!(30));
    extra.insert("scale".to_string(), json!(1.5));
    extra.insert("duration".to_string(), json!(3000));
    extra.insert("zOrder".to_string(), json!(10));

    Instruction {
        scene_id: "game".to_string(),
        performance_id: "perf-001".to_string(),
        effect: InstructionEffect {
            id: "cracker-fx".to_string(),
            effect_type: "com.comment-hub.cracker".to_string(),
            params: Some(json!({
                "count": 20,
                "duration": 2000,
                "gravity": 0.8
            })),
        },
        assets: vec![json!({"url": "confetti.png", "weight": 1})],
        sounds: vec!["pop.mp3".to_string()],
        context: Some(InstructionContext {
            user_name: "TestUser".to_string(),
            comment: "Hello!".to_string(),
            comment_html: "<span>Hello!</span>".to_string(),
            profile_image: "https://example.com/avatar.png".to_string(),
            amount: 500.0,
            currency: "JPY".to_string(),
            amount_display: "¥500".to_string(),
            sticker_image: "https://example.com/sticker.png".to_string(),
            tier_color: "#FF0000".to_string(),
            superchat_tier: "green".to_string(),
            is_member: true,
            member_months: 12,
            is_membership: false,
            membership_header: "Welcome!".to_string(),
            is_membership_gift: true,
            is_membership_milestone: false,
            gift_count: 5,
            member_badge_url: "https://example.com/badge.png".to_string(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: true,
            is_repeater: false,
            listener_status: "first_time".to_string(),
            listener_tag: "初見".to_string(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: true,
            listener_previous_stream_last_seen_at: "".to_string(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: "".to_string(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: "".to_string(),
            listener_previous_stream_id: "".to_string(),
            listener_previous_stream_title: "".to_string(),
            listener_previous_stream_started_at: "".to_string(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 10,
            listener_regular_min_streams: 3,
            is_first_time_listener: true,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
        }),
        extra,
    }
}

#[test]
fn instruction_fields_are_camel_case() {
    let inst = make_full_instruction();
    let v: Value = serde_json::to_value(&inst).unwrap();
    let obj = v.as_object().unwrap();

    // sceneId / performanceId (camelCase)
    assert!(obj.contains_key("sceneId"), "missing sceneId");
    assert!(obj.contains_key("performanceId"), "missing performanceId");

    // snake_case は存在しないこと
    assert!(!obj.contains_key("scene_id"), "scene_id must not appear");
    assert!(
        !obj.contains_key("performance_id"),
        "performance_id must not appear"
    );
}

#[test]
fn instruction_has_effect_object_with_type_and_params() {
    let inst = make_full_instruction();
    let v: Value = serde_json::to_value(&inst).unwrap();

    let effect = v.get("effect").expect("missing 'effect' field");
    assert!(effect.is_object(), "effect must be an object");

    // effect.type (rename = "type")
    assert!(
        effect.get("type").is_some(),
        "effect must contain 'type' field"
    );
    assert_eq!(effect["type"], "com.comment-hub.cracker");

    // effect.id
    assert_eq!(effect["id"], "cracker-fx");

    // effect.params — オブジェクト
    let params = effect.get("params").expect("effect must contain 'params'");
    assert!(params.is_object(), "effect.params must be an object");
    assert_eq!(params["count"], 20);
    assert_eq!(params["duration"], 2000);
}

#[test]
fn instruction_extra_fields_flattened_to_top_level() {
    let inst = make_full_instruction();
    let v: Value = serde_json::to_value(&inst).unwrap();
    let obj = v.as_object().unwrap();

    // extra の中身がトップレベルに展開される
    assert_eq!(obj["count"], 30, "extra.count must be at top level");
    assert_eq!(obj["scale"], 1.5, "extra.scale must be at top level");
    assert_eq!(obj["zOrder"], 10, "zOrder must be at top level");

    // "extra" というキー自体は存在しない
    assert!(
        !obj.contains_key("extra"),
        "'extra' key must not exist — fields should be flattened"
    );
}

#[test]
fn instruction_context_fields_are_camel_case() {
    let inst = make_full_instruction();
    let v: Value = serde_json::to_value(&inst).unwrap();

    let ctx = v.get("context").expect("missing context");
    let ctx_obj = ctx.as_object().unwrap();

    // 全フィールドが camelCase であること
    let expected_keys = [
        "userName",
        "comment",
        "commentHtml",
        "profileImage",
        "amount",
        "currency",
        "stickerImage",
        "tierColor",
        "isMember",
        "memberMonths",
        "isMembership",
        "membershipHeader",
        "isMembershipGift",
        "giftCount",
    ];
    for key in &expected_keys {
        assert!(ctx_obj.contains_key(*key), "context missing key: {}", key);
    }

    // snake_case が混入していないこと
    let snake_case_keys = [
        "user_name",
        "comment_html",
        "profile_image",
        "sticker_image",
        "tier_color",
        "is_member",
        "member_months",
        "is_membership",
        "membership_header",
        "is_membership_gift",
        "gift_count",
    ];
    for key in &snake_case_keys {
        assert!(
            !ctx_obj.contains_key(*key),
            "context must not have snake_case key: {}",
            key
        );
    }

    // 値の確認
    assert_eq!(ctx["userName"], "TestUser");
    assert_eq!(ctx["amount"], 500.0);
    assert_eq!(ctx["isMember"], true);
    assert_eq!(ctx["memberMonths"], 12);
    assert_eq!(ctx["giftCount"], 5);
}

#[test]
fn instruction_context_none_is_omitted() {
    let inst = Instruction {
        scene_id: "s1".to_string(),
        performance_id: "p1".to_string(),
        effect: InstructionEffect {
            id: "fx".to_string(),
            effect_type: "com.comment-hub.test".to_string(),
            params: None,
        },
        assets: vec![],
        sounds: vec![],
        context: None,
        extra: HashMap::new(),
    };
    let v: Value = serde_json::to_value(&inst).unwrap();

    // context が None の場合はフィールド自体が省略される
    assert!(
        !v.as_object().unwrap().contains_key("context"),
        "context: None should be omitted (skip_serializing_if)"
    );

    // params が None の場合も省略される
    assert!(
        !v["effect"].as_object().unwrap().contains_key("params"),
        "params: None should be omitted"
    );
}

#[test]
fn sse_message_performance_wrapping_format() {
    let inst = make_full_instruction();
    let msg = SseMessage::Performance {
        scene_id: inst.scene_id.clone(),
        data: serde_json::to_value(&inst).unwrap(),
        timestamp: 0,
    };

    let json_str = serde_json::to_string(&msg).unwrap();
    let v: Value = serde_json::from_str(&json_str).unwrap();
    let obj = v.as_object().unwrap();

    // type = "performance"
    assert_eq!(
        obj["type"], "performance",
        "SSE message type must be 'performance'"
    );

    // sceneId at wrapper level
    assert_eq!(obj["sceneId"], "game", "sceneId must be at wrapper level");

    // data contains the instruction
    let data = obj.get("data").expect("missing 'data' in SSE wrapper");
    assert!(data.is_object(), "data must be an object");

    // data 内に effect オブジェクトがある
    assert!(data.get("effect").is_some(), "data must contain 'effect'");
    assert_eq!(data["effect"]["type"], "com.comment-hub.cracker");

    // data 内に flattened extra がある
    assert_eq!(data["zOrder"], 10);
    assert_eq!(data["count"], 30);

    // data 内に context がある
    assert!(data.get("context").is_some(), "data must contain 'context'");
    assert_eq!(data["context"]["userName"], "TestUser");
}

#[test]
fn sse_message_performance_has_no_extra_fields() {
    let inst = make_full_instruction();
    let msg = SseMessage::Performance {
        scene_id: inst.scene_id.clone(),
        data: serde_json::to_value(&inst).unwrap(),
        timestamp: 0,
    };

    let v: Value = serde_json::to_value(&msg).unwrap();
    let obj = v.as_object().unwrap();

    // Performance ラッパー: type, sceneId, data, timestamp（余分なキーが付かないこと）
    let keys: Vec<&String> = obj.keys().collect();
    assert_eq!(
        keys.len(),
        4,
        "Performance wrapper must have exactly 4 keys: type, sceneId, data, timestamp — got: {:?}",
        keys
    );
    assert!(obj.contains_key("type"));
    assert!(obj.contains_key("sceneId"));
    assert!(obj.contains_key("data"));
    assert!(obj.contains_key("timestamp"));
}
