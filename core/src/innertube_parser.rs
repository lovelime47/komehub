//! YouTube InnerTube API のライブチャットレスポンスから RawComment を抽出するパーサー。
//!
//! chat-scraper.js の fetch インターセプト経路が横取りした生 JSON をパースし、
//! RawComment に変換する。JS 側のパース処理を Rust に集約することで、
//! ブラウザ側の負荷削減とパイプラインの一貫性を実現する。

use crate::state::comment::RawComment;

/// InnerTube actions 配列をパースし、(comments, deleted_ids) を返す。
/// `initial` が true の場合は既存メッセージなので seenIds 登録のみ（コメント返却なし）。
pub fn parse_innertube_actions(
    actions: &[serde_json::Value],
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> (Vec<RawComment>, Vec<String>) {
    let mut comments = Vec::new();
    let mut deleted_ids = Vec::new();

    for action in actions {
        // replayChatItemAction のラップ解除
        if let Some(replay) = action.get("replayChatItemAction").and_then(|v| v.get("actions")).and_then(|v| v.as_array()) {
            for inner in replay {
                if let Some(comment) = parse_add_action(inner, initial, seen_ids) {
                    comments.push(comment);
                }
                if let Some(id) = parse_delete_action(inner, seen_ids) {
                    deleted_ids.push(id);
                }
            }
            continue;
        }

        if let Some(comment) = parse_add_action(action, initial, seen_ids) {
            comments.push(comment);
        }
        if let Some(id) = parse_delete_action(action, seen_ids) {
            deleted_ids.push(id);
        }
    }

    // timestamp でソート
    comments.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    (comments, deleted_ids)
}

fn parse_add_action(
    action: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let item = action.get("addChatItemAction")?.get("item")?;

    // 通常コメント
    if let Some(r) = item.get("liveChatTextMessageRenderer") {
        return parse_text_message(r, initial, seen_ids);
    }
    // スパチャ
    if let Some(r) = item.get("liveChatPaidMessageRenderer") {
        return parse_paid_message(r, initial, seen_ids);
    }
    // ステッカー
    if let Some(r) = item.get("liveChatPaidStickerRenderer") {
        return parse_paid_sticker(r, initial, seen_ids);
    }
    // メンバーシップ
    if let Some(r) = item.get("liveChatMembershipItemRenderer") {
        return parse_membership(r, initial, seen_ids);
    }
    // メンバーシップギフト (= 贈った人)
    if let Some(r) = item.get("liveChatSponsorshipsGiftPurchaseAnnouncementRenderer") {
        return parse_membership_gift(r, initial, seen_ids);
    }
    // メンバーシップギフト受領 (= 受け取った人)
    if let Some(r) = item.get("liveChatSponsorshipsGiftRedemptionAnnouncementRenderer") {
        return parse_gift_redemption(r, initial, seen_ids);
    }

    None
}

fn parse_delete_action(
    action: &serde_json::Value,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<String> {
    if let Some(del) = action.get("markChatItemAsDeletedAction") {
        let target_id = str_field(del, "targetItemId");
        if !target_id.is_empty() && seen_ids.remove(&target_id) {
            return Some(target_id);
        }
    }
    if let Some(del) = action.get("markChatItemsByAuthorAsDeletedAction") {
        let channel_id = str_field(del, "externalChannelId");
        if !channel_id.is_empty() {
            return Some(format!("__author_deleted__:{}", channel_id));
        }
    }
    None
}

/// 共通フィールドを埋めた RawComment を生成するヘルパー。
/// renderer 固有のフィールドは呼び出し元で上書きする。
fn new_raw_comment(id: String, name: String, badges: &BadgeInfo) -> RawComment {
    let display_name = name.clone();
    let speech_text = String::new();
    RawComment {
        id,
        user_id: String::new(),
        live_id: String::new(),
        name,
        display_name,
        screen_name: String::new(),
        nickname: String::new(),
        comment: String::new(),
        comment_html: String::new(),
        speech_text,
        profile_image: String::new(),
        original_profile_image: String::new(),
        timestamp: String::new(),
        has_gift: false,
        amount: 0.0,
        currency: String::new(),
        amount_display: String::new(),
        sticker_image: String::new(),
        tier_color: String::new(),
        superchat_tier: String::new(),
        is_member: badges.is_member,
        member_months: badges.member_months,
        is_membership: false,
        membership_header: String::new(),
        is_membership_gift: false,
        is_membership_gift_redemption: false,
        is_membership_milestone: false,
        gift_count: 0,
        member_badge_url: badges.member_badge_url.clone(),
        is_moderator: badges.is_moderator,
        is_owner: badges.is_owner,
        is_verified: badges.is_verified,
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
        is_backfill: false,
        komehub_trace: serde_json::Value::Null,
    }
}

// ─── Renderer パーサー ──────────────────────────────────────────────

fn parse_text_message(
    r: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let id = str_field(r, "id");
    if id.is_empty() || !seen_ids.insert(id.clone()) {
        return None;
    }

    let badges = extract_badges(r.get("authorBadges"));
    let runs = r.get("message").and_then(|v| v.get("runs")).and_then(|v| v.as_array()).map(|v| v.as_slice());
    let comment_text = extract_text_from_runs(runs);
    let comment_html = extract_html_from_runs(runs);

    if comment_text.is_empty() && comment_html.is_empty() {
        return None;
    }

    let name = simple_text(r, "authorName");
    let mut c = new_raw_comment(id, name, &badges);
    c.user_id = str_field(r, "authorExternalChannelId");
    c.comment = comment_text;
    c.comment_html = comment_html;
    c.profile_image = first_thumbnail_url(r.get("authorPhoto"));
    c.timestamp = timestamp_usec_to_iso(r);
    c.is_backfill = initial;
    Some(c)
}

fn parse_paid_message(
    r: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let id = str_field(r, "id");
    if id.is_empty() || !seen_ids.insert(id.clone()) {
        return None;
    }

    let badges = extract_badges(r.get("authorBadges"));
    let runs = r.get("message").and_then(|v| v.get("runs")).and_then(|v| v.as_array()).map(|v| v.as_slice());
    let amount_text = r.get("purchaseAmountText")
        .and_then(|v| v.get("simpleText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let (amount, currency) = parse_amount_text(&amount_text);
    let tier_color = int_color_to_hex(r.get("bodyBackgroundColor"));
    let superchat_tier = crate::common::superchat::superchat_tier_key(amount, &currency, &tier_color);

    let name = simple_text(r, "authorName");
    let mut c = new_raw_comment(id, name, &badges);
    c.user_id = str_field(r, "authorExternalChannelId");
    c.comment = extract_text_from_runs(runs);
    c.comment_html = extract_html_from_runs(runs);
    c.profile_image = first_thumbnail_url(r.get("authorPhoto"));
    c.timestamp = timestamp_usec_to_iso(r);
    c.has_gift = true;
    c.amount = amount;
    c.currency = currency;
    c.amount_display = amount_text;
    c.tier_color = tier_color;
    c.superchat_tier = superchat_tier;
    c.is_backfill = initial;
    Some(c)
}

fn parse_paid_sticker(
    r: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let id = str_field(r, "id");
    if id.is_empty() || !seen_ids.insert(id.clone()) {
        return None;
    }

    let badges = extract_badges(r.get("authorBadges"));
    let amount_text = r.get("purchaseAmountText")
        .and_then(|v| v.get("simpleText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let (amount, currency) = parse_amount_text(&amount_text);
    let tier_color = int_color_to_hex(r.get("backgroundColor"));
    let superchat_tier = crate::common::superchat::superchat_tier_key(amount, &currency, &tier_color);
    let sticker_image = last_thumbnail_url(r.get("sticker"));

    let name = simple_text(r, "authorName");
    let mut c = new_raw_comment(id, name, &badges);
    c.user_id = str_field(r, "authorExternalChannelId");
    c.profile_image = first_thumbnail_url(r.get("authorPhoto"));
    c.timestamp = timestamp_usec_to_iso(r);
    c.has_gift = true;
    c.amount = amount;
    c.currency = currency;
    c.amount_display = amount_text;
    c.sticker_image = sticker_image;
    c.tier_color = tier_color;
    c.superchat_tier = superchat_tier;
    c.is_backfill = initial;
    Some(c)
}

fn parse_membership(
    r: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let id = str_field(r, "id");
    if id.is_empty() || !seen_ids.insert(id.clone()) {
        return None;
    }

    let badges = extract_badges(r.get("authorBadges"));
    // YouTube は headerPrimaryText / headerSubtext を `{runs:[...]}` か `{simpleText:"..."}`
    // のどちらかで返す (= 通常複合文 = runs、 単一テキスト = simpleText)。 旧コードは
    // runs 専用で simpleText を空扱いしており、 マイルストーン (= 「メンバー歴 N か月」が
    // simpleText 形式で来る場合) を新規加入として誤分類していた (2026-05-14 確認、
    // 実機 DB で 226/227 件の membership 中 ほぼ全てが is_membership_milestone=false で
    // 保存されていた)。
    let subtext_text = r.get("headerSubtext")
        .map(extract_text_runs_or_simple)
        .unwrap_or_default();
    let primary_text = r.get("headerPrimaryText")
        .map(extract_text_runs_or_simple)
        .unwrap_or_default();
    let msg_runs = r.get("message").and_then(|v| v.get("runs")).and_then(|v| v.as_array()).map(|v| v.as_slice());
    let comment_text = extract_text_from_runs(msg_runs);
    let comment_html = extract_html_from_runs(msg_runs);

    // milestone 判定は 2 軸 OR:
    //   1. headerPrimaryText 非空 (= 旧 YouTube 形式の主見出し「メンバー登録 N カ月」)。
    //      4d07ed3 で simpleText 形式にも対応。
    //   2. message 本文非空 (= メンバーが書いたマイルストーンチャット本文)。
    // 旧基準 (1 のみ) だと最新の YouTube が headerPrimaryText を送らないケース
    // (= headerSubtext に tier 名 + message に本文) で「新規加入」と誤判定していた
    // (= 2026-05-15 実機 DB 256 件で milestone=true が 0 件)。
    //
    // member_months >= N 軸は採用しない: 復帰メンバー (= 以前加入 → 脱退 → 再加入)
    // も memberMonths を持つが、これは「新規加入」として通知すべき (= 課金イベント)。
    // 本文なしのシステム通知系 (新規加入 / 復帰加入 / 「N カ月メンバー」継続通知) は
    // 全て milestone=false で「加入」として扱う方針。 本文ありの記念チャットだけ
    // milestone=true で区別する。
    let is_milestone = !primary_text.is_empty() || !comment_text.is_empty();
    let header_text = if !primary_text.is_empty() { primary_text } else { subtext_text };

    let name = simple_text(r, "authorName");
    let mut c = new_raw_comment(id, name, &badges);
    c.user_id = str_field(r, "authorExternalChannelId");
    c.comment = if comment_text.is_empty() { header_text.clone() } else { comment_text };
    c.comment_html = comment_html;
    c.profile_image = first_thumbnail_url(r.get("authorPhoto"));
    c.timestamp = timestamp_usec_to_iso(r);
    c.is_member = true;
    c.is_membership = true;
    c.is_membership_milestone = is_milestone;
    c.membership_header = header_text;
    c.is_backfill = initial;
    Some(c)
}

fn parse_membership_gift(
    r: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let id = str_field(r, "id");
    let id = if id.is_empty() {
        format!("gift-api-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0))
    } else {
        id
    };
    if !seen_ids.insert(id.clone()) {
        return None;
    }

    let header = r.get("header")
        .and_then(|v| v.get("liveChatSponsorshipsHeaderRenderer"));

    let name = header
        .and_then(|h| h.get("authorName"))
        .and_then(|v| v.get("simpleText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let profile_image = header
        .and_then(|h| first_thumbnail_url_opt(h.get("authorPhoto")))
        .unwrap_or_default();

    let primary_runs = header
        .and_then(|h| h.get("primaryText"))
        .and_then(|v| v.get("runs"))
        .and_then(|v| v.as_array()).map(|v| v.as_slice());
    let gift_text = extract_text_from_runs(primary_runs);

    let gift_count = gift_text
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<u32>()
        .unwrap_or(0);

    let empty_badges = BadgeInfo {
        is_member: false, member_months: 0, member_badge_url: String::new(),
        is_moderator: false, is_owner: false, is_verified: false,
    };
    let mut c = new_raw_comment(id, name, &empty_badges);
    // 贈り主の channel id は renderer top-level の authorExternalChannelId を優先する
    // (= redemption と同じ。YouTube 現行構造では header.liveChatSponsorshipsHeaderRenderer
    // 配下に無い枠が多く、header だけ見ると user_id 空 → listeners.db の yt-unknown バケツに
    // 集約され、別人の名前で listener 詳細が開く不具合になる。実測 gift 86 件中 67 件が
    // header 空 / top-level 有り)。top-level が無い旧構造のみ header にフォールバックする。
    c.user_id = {
        let top = str_field(r, "authorExternalChannelId");
        if !top.is_empty() {
            top
        } else {
            header
                .map(|h| str_field(h, "authorExternalChannelId"))
                .unwrap_or_default()
        }
    };
    c.comment = gift_text;
    c.profile_image = profile_image;
    c.timestamp = {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        format_unix_millis_to_iso(millis / 1000, millis % 1000)
    };
    c.has_gift = true;
    c.is_membership_gift = true;
    c.gift_count = gift_count;
    c.is_backfill = initial;
    Some(c)
}

/// メンバーシップギフトを受け取った人 (= liveChatSponsorshipsGiftRedemptionAnnouncementRenderer)。
/// 受領者は課金していない (= 贈り主が支払う) ので has_gift/amount は付けず、is_membership 系にも
/// しない。表示用に本文へ「○○ さんが △△ さんからメンバーシップ ギフトを受け取りました」全文を入れる
/// (= authorName + message.runs)。is_membership_gift_redemption を立てて分類・表示を分ける。
fn parse_gift_redemption(
    r: &serde_json::Value,
    initial: bool,
    seen_ids: &mut std::collections::HashSet<String>,
) -> Option<RawComment> {
    let id = str_field(r, "id");
    if id.is_empty() || !seen_ids.insert(id.clone()) {
        return None;
    }

    let name = simple_text(r, "authorName");
    let msg_runs = r
        .get("message")
        .and_then(|v| v.get("runs"))
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice());
    let runs_text = extract_text_from_runs(msg_runs);

    let empty_badges = BadgeInfo {
        is_member: false, member_months: 0, member_badge_url: String::new(),
        is_moderator: false, is_owner: false, is_verified: false,
    };
    let mut c = new_raw_comment(id, name.clone(), &empty_badges);
    c.user_id = str_field(r, "authorExternalChannelId");
    // 受領者名 + message runs を連結 (= runs は「さんが @贈り主 さんから…受け取りました」で始まる)。
    // 「@受領者 さんが …」と読めるよう名前と runs の間に半角スペースを入れる。
    c.comment = if name.is_empty() {
        runs_text
    } else {
        format!("{} {}", name, runs_text)
    };
    c.profile_image = first_thumbnail_url(r.get("authorPhoto"));
    c.timestamp = timestamp_usec_to_iso(r);
    c.is_membership_gift_redemption = true;
    c.is_backfill = initial;
    Some(c)
}

// ─── ヘルパー ──────────────────────────────────────────────────────

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn simple_text(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|v| v.get("simpleText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn first_thumbnail_url(photo: Option<&serde_json::Value>) -> String {
    first_thumbnail_url_opt(photo).unwrap_or_default()
}

fn first_thumbnail_url_opt(photo: Option<&serde_json::Value>) -> Option<String> {
    photo?
        .get("thumbnails")?
        .as_array()?
        .first()?
        .get("url")?
        .as_str()
        .map(|s| s.to_string())
}

fn last_thumbnail_url(container: Option<&serde_json::Value>) -> String {
    container
        .and_then(|v| v.get("thumbnails"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last())
        .and_then(|v| v.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn timestamp_usec_to_iso(r: &serde_json::Value) -> String {
    r.get("timestampUsec")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .map(|usec| {
            let millis = usec / 1000;
            // JavaScript 互換の ISO 文字列を生成
            let secs = millis / 1000;
            let ms = millis % 1000;
            let dt = std::time::UNIX_EPOCH + std::time::Duration::from_millis(millis as u64);
            // 簡易 ISO 8601 フォーマット
            let _ = dt; // UNIX_EPOCH からの秒数で直接計算
            format_unix_millis_to_iso(secs, ms)
        })
        .unwrap_or_default()
}

fn format_unix_millis_to_iso(secs: i64, ms: i64) -> String {
    // 簡易 UTC ISO 8601 フォーマッタ（外部クレート不要）
    const SECS_PER_DAY: i64 = 86400;
    const DAYS_PER_400Y: i64 = 146097;

    let total_days = secs.div_euclid(SECS_PER_DAY);
    let day_secs = secs.rem_euclid(SECS_PER_DAY);
    let h = day_secs / 3600;
    let m = (day_secs % 3600) / 60;
    let s = day_secs % 60;

    // 1970-01-01 を基準にグレゴリオ暦の年月日を計算
    let days = total_days + 719468; // 0000-03-01 epoch
    let era = days.div_euclid(DAYS_PER_400Y);
    let doe = days.rem_euclid(DAYS_PER_400Y);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, month, d, h, m, s, ms)
}

fn int_color_to_hex(v: Option<&serde_json::Value>) -> String {
    let n = match v.and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i as u64))) {
        Some(n) => n as u32,
        None => return String::new(),
    };
    let r = (n >> 16) & 0xff;
    let g = (n >> 8) & 0xff;
    let b = n & 0xff;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

fn parse_amount_text(text: &str) -> (f64, String) {
    if text.is_empty() {
        return (0.0, "¥".to_string());
    }
    let cleaned = text.replace(',', "").trim().to_string();

    // 先頭に通貨記号: "¥500", "$10.00"
    if let Some(pos) = cleaned.find(|c: char| c.is_ascii_digit() || c == '.') {
        if pos > 0 {
            let currency = cleaned[..pos].trim().to_string();
            let amount = cleaned[pos..].trim().parse::<f64>().unwrap_or(0.0);
            return (amount, currency);
        }
    }
    // 末尾に通貨記号: "500円"
    if let Some(pos) = cleaned.rfind(|c: char| c.is_ascii_digit() || c == '.') {
        if pos + 1 < cleaned.len() {
            let amount = cleaned[..=pos].trim().parse::<f64>().unwrap_or(0.0);
            let currency = cleaned[pos + 1..].trim().to_string();
            return (amount, currency);
        }
    }

    let amount = cleaned.chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .parse::<f64>()
        .unwrap_or(0.0);
    (amount, "¥".to_string())
}

// ─── runs からテキスト/HTML 抽出 ────────────────────────────────────

/// `headerPrimaryText` のような `{runs:[...]} | {simpleText:"..."}` 両形式に対応するヘルパー。
/// YouTube は同じフィールドでも文脈によって runs / simpleText を切り替えてくる。
fn extract_text_runs_or_simple(node: &serde_json::Value) -> String {
    if let Some(runs) = node.get("runs").and_then(|v| v.as_array()) {
        if !runs.is_empty() {
            return extract_text_from_runs(Some(runs.as_slice()));
        }
    }
    node.get("simpleText")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default()
}

/// runs (= コメント本文の断片配列) からプレーンテキスト (= body) を組み立てる。
///
/// **emoji run は絵文字そのものではなく shortcode (`:musical_note:` 等) に変換する。**
/// 理由: body は検索 / TTS / 絵文字非対応フォント環境での簡易表示に使うプレーンテキスト
/// であり、絵文字を生のまま入れると豆腐 (□) 表示や読み上げ不能になる環境があるため
/// (= shortcode なら可読を保てる)。絵文字本体 (= Unicode 文字) は
/// `extract_html_from_runs` が comment_html の `data-emoji-id` 属性に保持しており、
/// 絵文字を keyword 照合に使う処理 (= `crate::engine::performance::match_keyword`) は
/// そちらから絵文字を拾うことで「配信者が keyword に絵文字を設定 → 視聴者の絵文字コメントで
/// 発火」を成立させている。
/// ※ commit 履歴に shortcode 化の明示的理由は残っておらず、上記フォント対策は経緯の記憶ベース。
fn extract_text_from_runs(runs: Option<&[serde_json::Value]>) -> String {
    let runs = match runs {
        Some(r) => r,
        None => return String::new(),
    };
    let mut result = String::new();
    for run in runs {
        if let Some(text) = run.get("text").and_then(|v| v.as_str()) {
            result.push_str(text);
        } else if let Some(emoji) = run.get("emoji") {
            // 優先順位: shortcuts (`:smile:`) → accessibility label → emojiId は流さない。
            // emojiId はカスタム絵文字で `UCxxx/xxx` 形式となり、本文表示に不適切なため除外。
            if let Some(shortcut) = emoji
                .get("shortcuts")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
            {
                result.push_str(shortcut);
            } else if let Some(label) = emoji
                .get("image")
                .and_then(|v| v.get("accessibility"))
                .and_then(|v| v.get("accessibilityData"))
                .and_then(|v| v.get("label"))
                .and_then(|v| v.as_str())
            {
                result.push_str(label);
            }
        }
    }
    result
}

fn extract_html_from_runs(runs: Option<&[serde_json::Value]>) -> String {
    let runs = match runs {
        Some(r) => r,
        None => return String::new(),
    };
    let mut result = String::new();
    for run in runs {
        if let Some(text) = run.get("text").and_then(|v| v.as_str()) {
            let escaped = html_escape(text);
            if let Some(url) = run.get("navigationEndpoint")
                .and_then(|v| v.get("urlEndpoint"))
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
            {
                result.push_str(&format!("<a href=\"{}\">{}</a>", html_escape(url), escaped));
            } else {
                result.push_str(&escaped);
            }
        } else if let Some(emoji) = run.get("emoji") {
            let thumbnails = emoji.get("image")
                .and_then(|v| v.get("thumbnails"))
                .and_then(|v| v.as_array());
            if let Some(thumbs) = thumbnails {
                if let Some(last) = thumbs.last() {
                    let src = last.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let alt = emoji.get("shortcuts")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|v| v.as_str())
                        .or_else(|| emoji.get("emojiId").and_then(|v| v.as_str()))
                        .unwrap_or("");
                    // emojiId (= standard emoji は絵文字本体 🎵、custom emoji は `UCxxx/xxx`) を
                    // data-emoji-id に保持する。body は絵文字を shortcode 化する
                    // (= extract_text_from_runs 参照) ため、絵文字を keyword 照合する処理
                    // (= engine::performance::match_keyword) はこの属性から絵文字を拾う。
                    let emoji_id = emoji.get("emojiId").and_then(|v| v.as_str()).unwrap_or("");
                    let is_custom = src.contains("yt3.ggpht.com");
                    let class = if is_custom { "emoji yt-formatted-string" } else { "emoji" };
                    result.push_str(&format!(
                        "<img class=\"{}\" src=\"{}\" alt=\"{}\"{}>"  ,
                        class,
                        html_escape(src),
                        html_escape(alt),
                        if emoji_id.is_empty() { String::new() } else { format!(" data-emoji-id=\"{}\"", html_escape(emoji_id)) }
                    ));
                }
            } else if let Some(id) = emoji.get("emojiId").and_then(|v| v.as_str()) {
                result.push_str(id);
            }
        }
    }
    result
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ─── バッジ抽出 ────────────────────────────────────────────────────

struct BadgeInfo {
    is_member: bool,
    member_months: u32,
    member_badge_url: String,
    is_moderator: bool,
    is_owner: bool,
    is_verified: bool,
}

fn extract_badges(badges_value: Option<&serde_json::Value>) -> BadgeInfo {
    let mut info = BadgeInfo {
        is_member: false,
        member_months: 0,
        member_badge_url: String::new(),
        is_moderator: false,
        is_owner: false,
        is_verified: false,
    };

    let badges = match badges_value.and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return info,
    };

    for badge in badges {
        let renderer = match badge.get("liveChatAuthorBadgeRenderer") {
            Some(r) => r,
            None => continue,
        };
        let icon_type = renderer.get("icon")
            .and_then(|v| v.get("iconType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match icon_type {
            "MODERATOR" => info.is_moderator = true,
            "OWNER" => info.is_owner = true,
            "VERIFIED" => info.is_verified = true,
            _ => {
                if let Some(custom) = renderer.get("customThumbnail") {
                    info.is_member = true;
                    if let Some(url) = custom.get("thumbnails")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.last())
                        .and_then(|v| v.get("url"))
                        .and_then(|v| v.as_str())
                    {
                        info.member_badge_url = url.to_string();
                    }
                    // tooltip から月数
                    let tooltip = renderer.get("tooltip")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    info.member_months = parse_member_months(tooltip);
                }
            }
        }
    }

    info
}

fn parse_member_months(tooltip: &str) -> u32 {
    let mut months = 0u32;
    let lower = tooltip.to_lowercase();

    // 年
    let year_patterns = ["年", "year"];
    for pat in &year_patterns {
        if let Some(pos) = lower.find(pat) {
            let before = &lower[..pos];
            if let Ok(num) = before.chars().rev()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .chars().rev().collect::<String>()
                .parse::<u32>()
            {
                months += num * 12;
            }
        }
    }

    // 月
    let month_patterns = ["か月", "ヶ月", "ケ月", "カ月", "month"];
    for pat in &month_patterns {
        if let Some(pos) = lower.find(pat) {
            let before = &lower[..pos];
            if let Ok(num) = before.chars().rev()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .chars().rev().collect::<String>()
                .parse::<u32>()
            {
                months += num;
                break;
            }
        }
    }

    months
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_amount_yen() {
        let (amount, currency) = parse_amount_text("¥5,000");
        assert_eq!(amount, 5000.0);
        assert_eq!(currency, "¥");
    }

    #[test]
    fn parse_amount_usd() {
        let (amount, currency) = parse_amount_text("$10.00");
        assert_eq!(amount, 10.0);
        assert_eq!(currency, "$");
    }

    #[test]
    fn int_color_blue() {
        let v = serde_json::json!(4280191205u64);
        assert_eq!(int_color_to_hex(Some(&v)), "#1e88e5");
    }

    #[test]
    fn html_escape_basic() {
        assert_eq!(html_escape("<script>"), "&lt;script&gt;");
    }

    #[test]
    fn member_months_japanese() {
        assert_eq!(parse_member_months("メンバー（6 か月）"), 6);
    }

    #[test]
    fn member_months_year_and_month() {
        assert_eq!(parse_member_months("メンバー（1 年 3 か月）"), 15);
    }

    #[test]
    fn member_months_english() {
        assert_eq!(parse_member_months("Member (2 months)"), 2);
    }

    #[test]
    fn text_from_runs() {
        let runs = vec![
            serde_json::json!({"text": "hello "}),
            serde_json::json!({"text": "world"}),
        ];
        assert_eq!(extract_text_from_runs(Some(&runs)), "hello world");
    }

    #[test]
    fn text_from_runs_emoji_uses_shortcut_not_id() {
        // カスタム絵文字 (UCxxx/xxx) を本文に流すと UI が壊れるので shortcut を採用する。
        let runs = vec![
            serde_json::json!({"text": "ねぎ"}),
            serde_json::json!({
                "emoji": {
                    "emojiId": "UCvaTdHTWBGv3MKj3KVqJVCw/WOjuX6vAF8_J-AOM9KKgAg",
                    "shortcuts": [":custom_negi:"],
                    "image": {
                        "accessibility": {
                            "accessibilityData": { "label": "negi emoji" }
                        }
                    }
                }
            }),
        ];
        assert_eq!(extract_text_from_runs(Some(&runs)), "ねぎ:custom_negi:");
    }

    #[test]
    fn text_from_runs_emoji_falls_back_to_accessibility_label() {
        // shortcuts が無いカスタム絵文字は accessibility ラベルを使う。
        let runs = vec![serde_json::json!({
            "emoji": {
                "emojiId": "UCxxx/yyy",
                "image": {
                    "accessibility": {
                        "accessibilityData": { "label": "negi" }
                    }
                }
            }
        })];
        assert_eq!(extract_text_from_runs(Some(&runs)), "negi");
    }

    #[test]
    fn text_from_runs_emoji_skips_when_only_id_available() {
        // shortcut も label も無いケースでは emojiId を本文に流さず空にする。
        let runs = vec![serde_json::json!({
            "emoji": { "emojiId": "UCxxx/yyy" }
        })];
        assert_eq!(extract_text_from_runs(Some(&runs)), "");
    }

    #[test]
    fn html_from_runs_with_emoji() {
        let runs = vec![
            serde_json::json!({"text": "hi "}),
            serde_json::json!({"emoji": {"emojiId": "UC123", "image": {"thumbnails": [{"url": "https://example.com/e.png"}]}}}),
        ];
        let html = extract_html_from_runs(Some(&runs));
        assert!(html.contains("hi "));
        assert!(html.contains("<img"));
        assert!(html.contains("data-emoji-id=\"UC123\""));
    }

    // ─── PT-1a: 投稿者 channel id 抽出のテスト ────────────────────────

    fn fake_seen() -> std::collections::HashSet<String> { std::collections::HashSet::new() }

    #[test]
    fn parse_text_message_extracts_user_id() {
        let r = serde_json::json!({
            "id": "yt-text-1",
            "authorName": { "simpleText": "alice" },
            "authorExternalChannelId": "UCalice0000000000000000",
            "message": { "runs": [{ "text": "hello" }] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_text_message(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(c.user_id, "UCalice0000000000000000");
        assert_eq!(c.id, "yt-text-1");
    }

    #[test]
    fn parse_paid_message_extracts_user_id() {
        let r = serde_json::json!({
            "id": "yt-paid-1",
            "authorName": { "simpleText": "bob" },
            "authorExternalChannelId": "UCbob000000000000000000",
            "message": { "runs": [{ "text": "thanks" }] },
            "purchaseAmountText": { "simpleText": "¥500" },
            "bodyBackgroundColor": 4280191205u64,
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_paid_message(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(c.user_id, "UCbob000000000000000000");
        assert!(c.has_gift);
    }

    #[test]
    fn parse_paid_sticker_extracts_user_id() {
        let r = serde_json::json!({
            "id": "yt-sticker-1",
            "authorName": { "simpleText": "carol" },
            "authorExternalChannelId": "UCcarol00000000000000000",
            "purchaseAmountText": { "simpleText": "¥1,000" },
            "backgroundColor": 4280191205u64,
            "sticker": { "thumbnails": [{ "url": "https://example.com/s.png" }] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_paid_sticker(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(c.user_id, "UCcarol00000000000000000");
    }

    #[test]
    fn parse_membership_extracts_user_id() {
        // headerPrimaryText 不在 + headerSubtext "X へようこそ！" = 新規加入
        let r = serde_json::json!({
            "id": "yt-member-1",
            "authorName": { "simpleText": "dave" },
            "authorExternalChannelId": "UCdave00000000000000000",
            "headerSubtext": { "runs": [
                { "text": "テストチャンネル" },
                { "text": " へようこそ！" }
            ] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_membership(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(c.user_id, "UCdave00000000000000000");
        assert!(c.is_membership);
        assert!(!c.is_membership_milestone, "新規加入は milestone=false");
        assert_eq!(c.membership_header, "テストチャンネル へようこそ！");
    }

    #[test]
    fn parse_membership_milestone_accepts_simpletext_form() {
        // 2026-05-14 実機で発見: YouTube は headerPrimaryText を simpleText 形式でも返してくる。
        // 旧コードは runs 専用で、 simpleText で来ると primary_text が空 → 新規加入扱いに
        // 誤分類していた。
        let r = serde_json::json!({
            "id": "yt-member-3",
            "authorName": { "simpleText": "@milestonetester" },
            "authorExternalChannelId": "UCmilestone0000000000000",
            "headerPrimaryText": { "simpleText": "メンバー歴 1 か月" },
            "headerSubtext": { "simpleText": "テストチャンネル" },
            "message": { "runs": [{ "text": "マイルストーンできる様になってたー" }] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_membership(&r, false, &mut seen).expect("comment parsed");
        assert!(c.is_membership);
        assert!(
            c.is_membership_milestone,
            "simpleText 形式 headerPrimaryText でも継続記念は milestone=true"
        );
        assert_eq!(c.membership_header, "メンバー歴 1 か月");
    }

    #[test]
    fn parse_membership_milestone_marks_milestone_flag() {
        // headerPrimaryText 非空 = 継続記念 (X カ月メンバー)
        let r = serde_json::json!({
            "id": "yt-member-2",
            "authorName": { "simpleText": "frank" },
            "authorExternalChannelId": "UCfrank0000000000000000",
            "headerPrimaryText": { "runs": [
                { "text": "メンバー登録 " },
                { "text": "3" },
                { "text": " カ月" }
            ] },
            "headerSubtext": { "runs": [{ "text": "テストチャンネル" }] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_membership(&r, false, &mut seen).expect("comment parsed");
        assert!(c.is_membership);
        assert!(c.is_membership_milestone, "継続記念は milestone=true");
        // header_text は primary を採用 (= "メンバー登録 3 カ月")
        assert_eq!(c.membership_header, "メンバー登録 3 カ月");
    }

    #[test]
    fn parse_membership_milestone_marks_milestone_from_message_body() {
        // 2026-05-15 実機 DB から確認: 最新の YouTube は headerPrimaryText を送らず、
        // tier 名を headerSubtext に、メンバー記念チャット本文を message に入れて来る形式が主流。
        // body 非空 = ユーザー記入の記念チャット = milestone と判定する。
        let r = serde_json::json!({
            "id": "yt-member-body",
            "authorName": { "simpleText": "るか-chan" },
            "authorExternalChannelId": "UChabvSQVc1B7ZAE2lbZwq2g",
            "headerSubtext": { "simpleText": "ひよこっこ🐔" },
            "message": { "runs": [{ "text": "わーーーー" }] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_membership(&r, false, &mut seen).expect("comment parsed");
        assert!(c.is_membership);
        assert!(
            c.is_membership_milestone,
            "本文を持つメンバー記念チャットは milestone=true"
        );
        // headerPrimaryText が無いので header_text は subtext (= tier 名) を採用
        assert_eq!(c.membership_header, "ひよこっこ🐔");
    }

    #[test]
    fn parse_membership_returning_member_treated_as_join_not_milestone() {
        // 復帰メンバー (= 以前加入 → 脱退 → 再加入) は memberMonths を持つが、 課金が
        // 再開された「加入」イベントとして配信者に通知すべき。本文 無し + headerPrimaryText 無し
        // の場合は member_months が大きくても milestone=false (= 新規加入扱い) で保つ。
        let r = serde_json::json!({
            "id": "yt-member-returning",
            "authorName": { "simpleText": "comeback" },
            "authorExternalChannelId": "UCback000000000000000000",
            "authorBadges": [{
                "liveChatAuthorBadgeRenderer": {
                    "customThumbnail": { "thumbnails": [{ "url": "https://example.com/badge.png" }] },
                    "tooltip": "メンバー（12 か月）"
                }
            }],
            "headerSubtext": { "simpleText": "テストチャンネル" },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_membership(&r, false, &mut seen).expect("comment parsed");
        assert!(c.is_membership);
        assert_eq!(c.member_months, 12, "badge から月数取得");
        assert!(
            !c.is_membership_milestone,
            "本文無しのシステム通知は復帰加入として扱う (milestone=false)"
        );
    }

    #[test]
    fn parse_membership_gift_extracts_user_id_from_header() {
        let r = serde_json::json!({
            "id": "yt-gift-1",
            "header": {
                "liveChatSponsorshipsHeaderRenderer": {
                    "authorName": { "simpleText": "erin" },
                    "authorExternalChannelId": "UCerin00000000000000000",
                    "primaryText": { "runs": [{ "text": "ギフトを 5 個" }] }
                }
            }
        });
        let mut seen = fake_seen();
        let c = parse_membership_gift(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(c.user_id, "UCerin00000000000000000");
        assert!(c.is_membership_gift);
        assert_eq!(c.gift_count, 5);
    }

    #[test]
    fn parse_membership_gift_prefers_top_level_channel_id() {
        // YouTube 現行構造: 贈り主 channel id は renderer top-level にあり header には無い。
        // top-level を読まないと user_id 空 → listeners.db の yt-unknown バケツに集約され、
        // 別人の listener 詳細が開く不具合になる (= 実機で 86 件中 67 件が header 空だった)。
        let r = serde_json::json!({
            "id": "yt-gift-toplevel",
            "authorExternalChannelId": "UCgifter0000000000000000",
            "header": {
                "liveChatSponsorshipsHeaderRenderer": {
                    "authorName": { "simpleText": "gifter" },
                    // header には authorExternalChannelId が無い (= 現行構造)
                    "primaryText": { "runs": [{ "text": "ギフトを 10 個" }] }
                }
            }
        });
        let mut seen = fake_seen();
        let c = parse_membership_gift(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(
            c.user_id, "UCgifter0000000000000000",
            "top-level authorExternalChannelId を贈り主として採用する"
        );
        assert_eq!(c.gift_count, 10);
    }

    #[test]
    fn parse_text_message_user_id_empty_when_missing() {
        // authorExternalChannelId が無い古い fixture に対しても破綻しないことを確認
        let r = serde_json::json!({
            "id": "yt-text-noid",
            "authorName": { "simpleText": "frank" },
            "message": { "runs": [{ "text": "hi" }] },
            "timestampUsec": "1700000000000000"
        });
        let mut seen = fake_seen();
        let c = parse_text_message(&r, false, &mut seen).expect("comment parsed");
        assert_eq!(c.user_id, "");
    }
}
