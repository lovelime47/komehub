//! コメント通知イベント判定 + tts queue 投入 (Phase C 〜)。
//!
//! Phase B 時点では SSE push して JS 側で filter していたが、 Phase C で Rust 側
//! に正本設定 (= notification_settings) を移管したので、 判定 + filter + enqueue を
//! ここで完結させる。 通知音 (Phase D 予定) と通知 TTS をシーケンシャルに再生するため、
//! `crate::tts::enqueue_notification` 経由で共通 TTS_RUNTIME に投入する。

use std::sync::Arc;

use serde_json::Value;

use crate::state::comment::RawComment;
use crate::surface::sse::SseBroadcaster;

use super::trace::current_millis;

/// 通知イベント種別。 JS 側 (NOTIFICATION_EVENT_DEFS) と id を 1:1 に揃える。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotificationEventType {
    FirstSeen,
    Revisit,
    Comeback,
    Latecomer,
    Superchat,
    NewMember,
    MemberGift,
    Moderator,
}

impl NotificationEventType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::FirstSeen => "first_seen",
            Self::Revisit => "revisit",
            Self::Comeback => "comeback",
            Self::Latecomer => "latecomer",
            Self::Superchat => "superchat",
            Self::NewMember => "new_member",
            Self::MemberGift => "member_gift",
            Self::Moderator => "moderator",
        }
    }
}

/// 1 コメントに対して該当する通知イベントを列挙する純関数。
///
/// per-comment tag 系 4 種は mutually exclusive (= listener_status が排他)。
/// ギフト系 3 種も mutually exclusive (= is_membership_gift > is_membership > has_gift の優先順)。
/// moderator は他軸と独立 (= 初見 + モデレータ で 2 件返ることがある)。
///
/// owner (= 配信者本人) のコメは moderator 通知を抑止 (= 自分宛通知ノイズ防止)。
pub(crate) fn collect_events(comment: &RawComment) -> Vec<NotificationEventType> {
    let mut events = Vec::new();

    match comment.listener_status.as_str() {
        "first-time" => events.push(NotificationEventType::FirstSeen),
        "returning" => events.push(NotificationEventType::Revisit),
        "long-absence" => events.push(NotificationEventType::Comeback),
        "regular-arrival" => events.push(NotificationEventType::Latecomer),
        _ => {}
    }

    if comment.is_membership_gift {
        events.push(NotificationEventType::MemberGift);
    } else if comment.is_membership && !comment.is_membership_milestone {
        // 新規加入 (= "X へようこそ！")。 継続記念 (= milestone) は除外
        events.push(NotificationEventType::NewMember);
    } else if comment.has_gift && comment.amount > 0.0 {
        events.push(NotificationEventType::Superchat);
    }

    if comment.is_moderator && !comment.is_owner {
        events.push(NotificationEventType::Moderator);
    }

    events
}

/// 通知イベントを判定 → 設定 filter → tts queue に enqueue する。
///
/// is_backfill / is_template_test の skip は呼出側 (= handle_incoming_comments) で実施。
/// ここに到達した時点で「現コメに対して通知発火する候補」 が確定している。
///
/// `stream_title` はテンプレ `{streamTitle}` 置換用 (= 配信非接続時 / 未取得時は空文字、
/// `apply_template` 側で空のままシレッと消える)。
///
/// 該当 0 件 / master OFF / paused は早期 return。
pub(crate) fn dispatch(comment: &RawComment, sse: &Arc<SseBroadcaster>, stream_title: &str) {
    let events = collect_events(comment);
    if events.is_empty() {
        return;
    }

    let settings = crate::notification_settings::current_settings();
    let master_on = settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let paused = settings
        .get("paused")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !master_on || paused {
        tracing::debug!(
            "notification dispatch skipped: master_on={} paused={} (events={})",
            master_on,
            paused,
            events.len()
        );
        return;
    }

    let provider = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("builtin")
        .to_string();
    let output_device = settings
        .get("outputDevice")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // VOICEVOX 設定の組み立て: 通知側の speaker/style/speed + TTS 側 host/port を merge。
    // host/port は通知 UI に出さず、 TTS の CURRENT_TTS_SETTINGS.voicevox から引いてくる
    // (= ユーザーは「コメント読み上げ側で host/port を設定」 という仕様)。
    let voicevox_settings = if provider == "voicevox" {
        let mut vv = settings
            .get("voicevox")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let tts_settings = crate::tts::current_settings();
        if let Some(tts_vv) = tts_settings.get("voicevox") {
            if let Some(obj) = vv.as_object_mut() {
                if !obj.contains_key("host") {
                    obj.insert(
                        "host".to_string(),
                        tts_vv.get("host").cloned().unwrap_or(Value::String("127.0.0.1".to_string())),
                    );
                }
                if !obj.contains_key("port") {
                    obj.insert(
                        "port".to_string(),
                        tts_vv.get("port").cloned().unwrap_or(Value::Number(50021.into())),
                    );
                }
            }
        }
        Some(vv)
    } else {
        None
    };

    // 内蔵 (SAPI) 設定: 通知側だけ持つ voice / rate / volume。 host/port なし。
    let builtin_settings = if provider == "builtin" {
        Some(
            settings
                .get("builtin")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
    } else {
        None
    };

    // 棒読みちゃん設定の組み立て: 通知側の speed/tone/volume/voice + TTS 側
    // executablePath / host / port を merge。 後者 3 つは通知 UI に出さず TTS 側を共有する。
    let bouyomi_settings = if provider == "bouyomi" {
        let mut by = settings
            .get("bouyomi")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let tts_settings = crate::tts::current_settings();
        if let Some(tts_by) = tts_settings.get("bouyomi") {
            if let Some(obj) = by.as_object_mut() {
                if !obj.contains_key("host") {
                    obj.insert(
                        "host".to_string(),
                        tts_by.get("host").cloned().unwrap_or(Value::String("127.0.0.1".to_string())),
                    );
                }
                if !obj.contains_key("port") {
                    obj.insert(
                        "port".to_string(),
                        tts_by.get("port").cloned().unwrap_or(Value::Number(50001.into())),
                    );
                }
                if !obj.contains_key("executablePath") {
                    if let Some(p) = tts_by.get("executablePath") {
                        obj.insert("executablePath".to_string(), p.clone());
                    }
                }
            }
        }
        Some(by)
    } else {
        None
    };

    let days_away = compute_days_away(comment);
    let display_name = if !comment.display_name.is_empty() {
        comment.display_name.clone()
    } else {
        comment.name.clone()
    };

    for event_type in events {
        let event_id = event_type.as_str();
        // Phase C は tts のみ判定 (= 通知音は Phase D)。
        let fire_tts = crate::notification_settings::should_fire_tts(&settings, event_id);
        let fire_sound = crate::notification_settings::should_fire_sound(&settings, event_id);
        if !fire_tts && !fire_sound {
            continue;
        }
        let text = if fire_tts {
            build_notification_text(&settings, event_id, comment, days_away, &display_name, stream_title)
        } else {
            String::new()
        };
        // sound only / tts only / 両方 のどの組み合わせも 1 NotificationJob で表現する
        // (= 「鳴って → 読む」 のシーケンスが確定する、 別 job で投入すると逆順 / 割込みが起きうる)。
        let (sound_file, sound_volume) = if fire_sound {
            crate::notification_settings::event_sound(&settings, event_id)
                .map(|(f, v)| (Some(f), v))
                .unwrap_or((None, 0.7))
        } else {
            (None, 0.7)
        };
        let job = crate::tts::NotificationJob {
            event_type: event_id.to_string(),
            listener_name: display_name.clone(),
            text,
            sound_file,
            sound_volume,
            provider: provider.clone(),
            output_device: output_device.clone(),
            voicevox_settings: voicevox_settings.clone(),
            bouyomi_settings: bouyomi_settings.clone(),
            builtin_settings: builtin_settings.clone(),
            generation: crate::tts::current_generation(),
            sse: sse.clone(),
        };
        crate::tts::enqueue_notification(job);
    }
}

/// テンプレが空のときの fallback 文 (Phase C デフォルト)。 Phase D-3 で
/// {streamTitle} 置換に対応するため stream_title を引き渡す。
fn build_notification_text(
    settings: &Value,
    event_id: &str,
    comment: &RawComment,
    days_away: u32,
    name: &str,
    stream_title: &str,
) -> String {
    // ユーザー設定済テンプレ > default テンプレ。 default は
    // notification_settings::default_template_for で 1 個所管理 (= JS UI placeholder と共有)。
    // 旧 hardcoded fallback 8 件は撤去済 (= 二重正本解消、 JS UI と挙動が一致するように)。
    let user_template = crate::notification_settings::event_settings(settings, event_id)
        .and_then(|ev: &Value| ev.get("tts"))
        .and_then(|tts: &Value| tts.get("template"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let template = if user_template.is_empty() {
        crate::notification_settings::default_template_for(event_id)
    } else {
        user_template
    };
    if template.is_empty() {
        // default 自体が空 (= comeback / new_member は文言未指定) のとき。 fire_tts を
        // 抑制する責務は呼出元 (= should_fire_tts) に委ねるが、 ここに来た場合のため
        // 最低限の文字列を返す (= 「{name} さんから通知です」)。
        return format!("{} さんから通知です", name);
    }
    apply_template(template, comment, days_away, name, stream_title)
}

/// テンプレ簡易評価 ({name}, {message}, {amount}, {currency}, {tier}, {daysAway}, {streamTitle})。
/// `stream_title` は live_stream_stats から渡される現配信タイトル (= 配信非接続時は空)。
fn apply_template(
    template: &str,
    comment: &RawComment,
    days_away: u32,
    name: &str,
    stream_title: &str,
) -> String {
    template
        .replace("{name}", name)
        .replace("{message}", &comment.comment)
        .replace("{amount}", &comment.amount_display)
        .replace("{currency}", &comment.currency)
        .replace("{tier}", &comment.membership_header)
        .replace("{daysAway}", &days_away.to_string())
        .replace("{streamTitle}", stream_title)
}

/// 「帰還」 イベントの空白日数を計算する。 該当しない場合は 0。
fn compute_days_away(comment: &RawComment) -> u32 {
    if comment.listener_status != "long-absence" {
        return 0;
    }
    let prev_ms = comment.listener_previous_stream_started_at_ms;
    if prev_ms <= 0 {
        return 0;
    }
    let now_ms = current_millis() as i64;
    if now_ms <= prev_ms {
        return 0;
    }
    ((now_ms - prev_ms) / (1000 * 86400)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::comment::RawComment;
    use serde_json::json;

    fn empty_comment() -> RawComment {
        serde_json::from_value(serde_json::json!({
            "id": "c1",
            "name": "alice",
            "comment": "hi"
        }))
        .unwrap()
    }

    #[test]
    fn no_event_for_plain_comment() {
        let c = empty_comment();
        assert_eq!(collect_events(&c), vec![]);
    }

    #[test]
    fn first_seen_from_listener_status() {
        let mut c = empty_comment();
        c.listener_status = "first-time".to_string();
        assert_eq!(collect_events(&c), vec![NotificationEventType::FirstSeen]);
    }

    #[test]
    fn revisit_from_listener_status() {
        let mut c = empty_comment();
        c.listener_status = "returning".to_string();
        assert_eq!(collect_events(&c), vec![NotificationEventType::Revisit]);
    }

    #[test]
    fn comeback_from_listener_status() {
        let mut c = empty_comment();
        c.listener_status = "long-absence".to_string();
        assert_eq!(collect_events(&c), vec![NotificationEventType::Comeback]);
    }

    #[test]
    fn latecomer_from_listener_status() {
        let mut c = empty_comment();
        c.listener_status = "regular-arrival".to_string();
        assert_eq!(collect_events(&c), vec![NotificationEventType::Latecomer]);
    }

    #[test]
    fn superchat_when_has_gift_and_amount() {
        let mut c = empty_comment();
        c.has_gift = true;
        c.amount = 500.0;
        assert_eq!(collect_events(&c), vec![NotificationEventType::Superchat]);
    }

    #[test]
    fn no_superchat_when_amount_zero() {
        let mut c = empty_comment();
        c.has_gift = true;
        c.amount = 0.0;
        assert_eq!(collect_events(&c), vec![]);
    }

    #[test]
    fn new_member_when_is_membership_not_milestone() {
        let mut c = empty_comment();
        c.is_membership = true;
        c.is_membership_milestone = false;
        assert_eq!(collect_events(&c), vec![NotificationEventType::NewMember]);
    }

    #[test]
    fn no_new_member_for_milestone() {
        let mut c = empty_comment();
        c.is_membership = true;
        c.is_membership_milestone = true;
        assert_eq!(collect_events(&c), vec![]);
    }

    #[test]
    fn member_gift_takes_priority() {
        let mut c = empty_comment();
        c.is_membership = true;
        c.is_membership_gift = true;
        assert_eq!(collect_events(&c), vec![NotificationEventType::MemberGift]);
    }

    #[test]
    fn moderator_independent_of_tag() {
        let mut c = empty_comment();
        c.listener_status = "first-time".to_string();
        c.is_moderator = true;
        assert_eq!(
            collect_events(&c),
            vec![NotificationEventType::FirstSeen, NotificationEventType::Moderator]
        );
    }

    #[test]
    fn moderator_skipped_when_owner() {
        let mut c = empty_comment();
        c.is_moderator = true;
        c.is_owner = true;
        assert_eq!(collect_events(&c), vec![]);
    }

    #[test]
    fn superchat_plus_moderator() {
        let mut c = empty_comment();
        c.has_gift = true;
        c.amount = 1000.0;
        c.is_moderator = true;
        assert_eq!(
            collect_events(&c),
            vec![NotificationEventType::Superchat, NotificationEventType::Moderator]
        );
    }

    #[test]
    fn days_away_zero_when_not_comeback() {
        let mut c = empty_comment();
        c.listener_status = "first-time".to_string();
        c.listener_previous_stream_started_at_ms = 1_000;
        assert_eq!(compute_days_away(&c), 0);
    }

    #[test]
    fn days_away_zero_when_no_previous() {
        let mut c = empty_comment();
        c.listener_status = "long-absence".to_string();
        c.listener_previous_stream_started_at_ms = 0;
        assert_eq!(compute_days_away(&c), 0);
    }

    #[test]
    fn days_away_positive_when_long_absence_with_previous() {
        let mut c = empty_comment();
        c.listener_status = "long-absence".to_string();
        let thirty_days_ago = current_millis() as i64 - 30 * 86400 * 1000;
        c.listener_previous_stream_started_at_ms = thirty_days_ago;
        let days = compute_days_away(&c);
        assert!((29..=30).contains(&days), "expected ~30 days, got {}", days);
    }

    #[test]
    fn build_text_uses_template_when_present() {
        let mut c = empty_comment();
        c.display_name = "Alice".to_string();
        let mut settings = json!({
            "enabled": true,
            "events": {
                "first_seen": {
                    "enabled": true,
                    "tts": { "enabled": true, "template": "Hi {name}!" }
                }
            }
        });
        // normalize 噛ませて欠落 field を補う
        settings = crate::notification_settings::normalize(Some(settings));
        let text = build_notification_text(&settings, "first_seen", &c, 0, "Alice", "");
        assert_eq!(text, "Hi Alice!");
    }

    #[test]
    fn build_text_fallback_when_template_empty() {
        // normalize(None) は first_seen の default テンプレ (= notification_settings の
        // EVENT_TEMPLATE_DEFAULTS) を sound.file / tts.template に焼き込んでくる。
        // build_notification_text は user_template が空 → default_template_for を読む経路を踏む。
        let c = empty_comment();
        let settings = crate::notification_settings::normalize(None);
        let text = build_notification_text(&settings, "first_seen", &c, 0, "Bob", "");
        assert_eq!(text, "しょけんのBob さんがコメントしました");
    }

    #[test]
    fn apply_template_substitutes_all_vars() {
        let mut c = empty_comment();
        c.comment = "yo".to_string();
        c.amount_display = "¥500".to_string();
        let r = apply_template(
            "{name}: {message} ({amount}, {daysAway}日)",
            &c,
            7,
            "X",
            "",
        );
        assert_eq!(r, "X: yo (¥500, 7日)");
    }

    #[test]
    fn apply_template_substitutes_stream_title() {
        let c = empty_comment();
        let r = apply_template(
            "「{streamTitle}」 に {name} さん来訪",
            &c,
            0,
            "Alice",
            "歌枠 #38",
        );
        assert_eq!(r, "「歌枠 #38」 に Alice さん来訪");
    }

    #[test]
    fn apply_template_empty_stream_title_drops_var() {
        let c = empty_comment();
        let r = apply_template("[{streamTitle}] {name}", &c, 0, "Alice", "");
        assert_eq!(r, "[] Alice");
    }

    #[test]
    fn build_text_template_uses_stream_title() {
        let c = empty_comment();
        let mut settings = serde_json::json!({
            "enabled": true,
            "events": {
                "first_seen": {
                    "enabled": true,
                    "tts": { "enabled": true, "template": "{streamTitle}: {name}" }
                }
            }
        });
        settings = crate::notification_settings::normalize(Some(settings));
        let text = build_notification_text(&settings, "first_seen", &c, 0, "Bob", "雑談 #5");
        assert_eq!(text, "雑談 #5: Bob");
    }
}
