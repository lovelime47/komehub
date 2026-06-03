//! OneCommeSurface — わんコメ互換 WebSocket エンドポイント。
//!
//! わんコメ用テンプレートが onesdk.js 経由で接続する:
//! - GET /onecomme/sub  → WebSocket (わんコメ互換購読)

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::SinkExt;
use tokio::sync::broadcast;

use super::AppState;
use crate::model_queue::ModelCommand;

pub fn routes() -> Router<AppState> {
    Router::new().route("/onecomme/sub", get(ws_handler))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: AppState) {
    let (recent_tx, recent_rx) = tokio::sync::oneshot::channel();
    state.model_tx.send(ModelCommand::GetRecentComments {
        limit: 20,
        reply: recent_tx,
    });
    if let Ok(recent_comments) = recent_rx.await {
        if let Some(comments) = recent_comments.as_array() {
            if !comments.is_empty() {
                let wrapped = serde_json::json!({
                    "type": "comments",
                    "data": {
                        "comments": comments.iter().map(raw_to_onecomme).collect::<Vec<_>>()
                    }
                });
                if socket.send(Message::Text(wrapped.to_string().into())).await.is_err() {
                    return;
                }
            }
        }
    }

    let mut rx = state.sse_broadcaster.subscribe();
    let mut shutdown_rx = state.shutdown_signal.clone();

    // コメントを短い時間窓でバッチ化して送信する。
    // onesdk.js は 1件ずつ受け取ると毎回「先頭即時配信」してキューイングが効かないため、
    // 複数件をまとめた comments メッセージとして送る。
    const BATCH_WINDOW_MS: u64 = 5;

    loop {
        // 既に shutdown 済みなら早期 close
        // (`*borrow()` の Ref は同一 statement 内で drop される — await を跨がない)
        let already = *shutdown_rx.borrow();
        if already {
            let _ = socket.close().await;
            return;
        }
        // shutdown signal も同時に観測。change で起きるたびに次ループで再チェック。
        // changed() は () を返すので Send 制約に引っかからない (wait_for は Ref を返すため NG)
        let recv = tokio::select! {
            biased;
            _ = shutdown_rx.changed() => continue,
            recv = rx.recv() => recv,
        };
        match recv {
            Ok(data) => {
                // 最初の1件を処理
                let mut comment_batch: Vec<serde_json::Value> = Vec::new();
                let mut other_messages: Vec<String> = Vec::new();
                classify_onecomme_message(&data, &mut comment_batch, &mut other_messages);

                // 短い時間窓で追加のメッセージを集める
                let deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_millis(BATCH_WINDOW_MS);
                loop {
                    let timeout = tokio::time::timeout_at(deadline, rx.recv());
                    match timeout.await {
                        Ok(Ok(more_data)) => {
                            classify_onecomme_message(&more_data, &mut comment_batch, &mut other_messages);
                        }
                        Ok(Err(broadcast::error::RecvError::Lagged(n))) => {
                            tracing::warn!("OneComme WS lagged by {} messages", n);
                        }
                        Ok(Err(_)) => {
                            // チャンネル閉鎖 — 残りを送ってから終了
                            let _ = flush_onecomme_batch(&mut socket, &comment_batch, &other_messages).await;
                            return;
                        }
                        Err(_) => break, // タイムアウト — バッチ送信へ
                    }
                }

                if flush_onecomme_batch(&mut socket, &comment_batch, &other_messages).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("OneComme WS lagged by {} messages", n);
                continue;
            }
            Err(_) => break, // チャンネル閉鎖
        }
    }
}

/// SSE メッセージを分類: コメントはバッチ用配列へ、それ以外は個別メッセージ配列へ。
fn classify_onecomme_message(
    data: &str,
    comment_batch: &mut Vec<serde_json::Value>,
    other_messages: &mut Vec<String>,
) {
    let msg: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return,
    };
    let msg_type = match msg.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    match msg_type {
        "template-comment" => {
            if let Some(raw) = msg.get("data") {
                comment_batch.push(raw_to_onecomme(raw));
            }
        }
        "comment-deleted" => {
            let id = msg.get("data").and_then(|d| d.get("id")).cloned()
                .unwrap_or(serde_json::Value::Null);
            let wrapped = serde_json::json!({
                "type": "deleted",
                "data": [{ "id": id, "message": "deleted" }]
            });
            other_messages.push(wrapped.to_string());
        }
        _ => {}
    }
}

/// バッチ化したコメントとその他のメッセージを WebSocket で送信する。
async fn flush_onecomme_batch(
    socket: &mut WebSocket,
    comment_batch: &[serde_json::Value],
    other_messages: &[String],
) -> Result<(), ()> {
    // コメントはまとめて1つの comments メッセージとして送信
    if !comment_batch.is_empty() {
        let wrapped = serde_json::json!({
            "type": "comments",
            "data": {
                "comments": comment_batch
            }
        });
        if socket.send(Message::Text(wrapped.to_string().into())).await.is_err() {
            return Err(());
        }
    }
    // 削除等は個別に送信
    for msg in other_messages {
        if socket.send(Message::Text(msg.clone().into())).await.is_err() {
            return Err(());
        }
    }
    Ok(())
}

/// SSE ブロードキャストメッセージをわんコメ互換形式に変換する。
/// template-comment → comments、comment-deleted → deleted。
#[cfg(test)]
fn transform_to_onecomme(data: &str) -> Option<String> {
    let msg: serde_json::Value = serde_json::from_str(data).ok()?;
    let msg_type = msg.get("type")?.as_str()?;

    match msg_type {
        "template-comment" => {
            let raw = msg.get("data")?;
            let onecomme_comment = raw_to_onecomme(raw);
            let wrapped = serde_json::json!({
                "type": "comments",
                "data": {
                    "comments": [onecomme_comment]
                }
            });
            Some(wrapped.to_string())
        }
        "comment-deleted" => {
            // onesdk.js は deleted.data を配列 [{id, message}] として期待する
            let id = msg.get("data").and_then(|d| d.get("id")).cloned()
                .unwrap_or(serde_json::Value::Null);
            let wrapped = serde_json::json!({
                "type": "deleted",
                "data": [{ "id": id, "message": "deleted" }]
            });
            Some(wrapped.to_string())
        }
        _ => None,
    }
}

/// スパチャ tier → わんコメ互換 Colors (header + body + authorName + timestamp)
/// YouTube の実際のスパチャ色に基づく。
fn tier_colors(tier: &str) -> Option<serde_json::Value> {
    let (header_bg, header_text, body_bg, body_text) = match tier {
        "blue"    => ("#1565c0", "#ffffff", "#1e88e5", "#ffffff"),
        "teal"    => ("#00bfa5", "#000000", "#00e5ff", "#000000"),
        "green"   => ("#1de9b6", "#000000", "#1de9b6", "#000000"),
        "yellow"  => ("#ffb300", "#000000", "#ffca28", "#000000"),
        "orange"  => ("#e65100", "#ffffff", "#f57c00", "#ffffff"),
        "magenta" => ("#c2185b", "#ffffff", "#e91e63", "#ffffff"),
        "red"     => ("#e62117", "#ffffff", "#ff0000", "#ffffff"),
        _ => return None,
    };
    Some(serde_json::json!({
        "headerBackgroundColor": header_bg,
        "headerTextColor": header_text,
        "bodyBackgroundColor": body_bg,
        "bodyTextColor": body_text,
        "authorNameTextColor": header_text,
        "timestampColor": header_text,
    }))
}

/// RawComment JSON → わんコメ Comment 形式に変換する。
fn raw_to_onecomme(raw: &serde_json::Value) -> serde_json::Value {
    let name = raw.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let display_name = raw
        .get("displayName")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(name);
    let screen_name = raw.get("screenName").and_then(|v| v.as_str()).unwrap_or("");
    let nickname = raw.get("nickname").and_then(|v| v.as_str()).unwrap_or("");
    let comment = raw.get("comment").and_then(|v| v.as_str()).unwrap_or("");
    let speech_text = raw
        .get("speechText")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(comment);
    let profile_image = raw.get("profileImage").and_then(|v| v.as_str()).unwrap_or("");
    let original_profile_image = raw
        .get("originalProfileImage")
        .or_else(|| raw.get("_originalProfileImage"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(profile_image);
    let timestamp = raw.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let id = raw.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let user_id = raw
        .get("userId")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(if !name.is_empty() { name } else { id });
    let live_id = raw.get("liveId").and_then(|v| v.as_str()).unwrap_or("");
    let has_gift = raw.get("hasGift").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_member = raw.get("isMember").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_owner = raw.get("isOwner").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_moderator = raw.get("isModerator").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_verified = raw.get("isVerified").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_first_time = raw.get("isFirstTime").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_repeater = raw.get("isRepeater").and_then(|v| v.as_bool()).unwrap_or(false);
    let comment_visible = raw.get("commentVisible").and_then(|v| v.as_bool()).unwrap_or(true);
    let auto_moderated = raw.get("autoModerated").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_supporter = raw.get("isSupporter").and_then(|v| v.as_bool()).unwrap_or(false);
    let amount = raw.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let currency = raw.get("currency").and_then(|v| v.as_str()).unwrap_or("");
    let amount_display = raw.get("amountDisplay").and_then(|v| v.as_str()).unwrap_or("");
    let sticker_image = raw.get("stickerImage").and_then(|v| v.as_str()).unwrap_or("");
    let superchat_tier = raw.get("superchatTier").and_then(|v| v.as_str()).unwrap_or("");
    let is_membership = raw.get("isMembership").and_then(|v| v.as_bool()).unwrap_or(false);
    let membership_header = raw.get("membershipHeader").and_then(|v| v.as_str()).unwrap_or("");
    let member_months = raw.get("memberMonths").and_then(|v| v.as_u64()).unwrap_or(0);
    let is_membership_gift = raw.get("isMembershipGift").and_then(|v| v.as_bool()).unwrap_or(false);
    let gift_count = raw.get("giftCount").and_then(|v| v.as_u64()).unwrap_or(0);
    let member_badge_url = raw.get("memberBadgeUrl").and_then(|v| v.as_str()).unwrap_or("");

    let mut badges: Vec<serde_json::Value> = Vec::new();
    if !member_badge_url.is_empty() {
        badges.push(serde_json::json!({ "type": "member", "url": member_badge_url, "label": "Member" }));
    } else if is_member {
        badges.push(serde_json::json!({ "type": "member" }));
    }

    let comment_html = raw.get("commentHtml").and_then(|v| v.as_str()).unwrap_or(comment);

    // paidText: スパチャの金額表示
    let paid_text = if !amount_display.is_empty() {
        serde_json::Value::String(amount_display.to_string())
    } else if amount > 0.0 {
        serde_json::Value::String(crate::common::superchat::format_amount_display(amount, currency))
    } else {
        serde_json::Value::Null
    };

    // membership: メンバーシップ情報
    let membership_sub = raw
        .get("membershipSub")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| {
            if member_months > 0 {
                format!("メンバー歴 {} か月", member_months)
            } else {
                String::new()
            }
        });
    let membership = if is_membership && !membership_header.is_empty() {
        serde_json::json!({ "primary": membership_header, "sub": membership_sub })
    } else if is_membership_gift && gift_count > 0 {
        serde_json::json!({ "primary": format!("メンバーシップギフト x{}", gift_count), "sub": "" })
    } else {
        serde_json::Value::Null
    };

    // colors: スパチャ背景色（header + body + authorName + timestamp）
    // メンバーシップギフトは superchatTier を持たないため teal をフォールバック
    let colors = raw
        .get("colors")
        .cloned()
        .filter(|value| !value.is_null())
        .or_else(|| tier_colors(superchat_tier))
        .or_else(|| if is_membership_gift { tier_colors("teal") } else { None })
        .unwrap_or(serde_json::Value::Null);

    let comment_meta = raw.get("meta").cloned().unwrap_or(serde_json::Value::Null);
    let komehub_trace = raw
        .get("_komehubTrace")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let color = raw.get("color").cloned().unwrap_or_else(|| {
        serde_json::json!({
            "r": 255,
            "g": 255,
            "b": 255
        })
    });
    let url = raw.get("url").and_then(|v| v.as_str()).unwrap_or("");

    let data = serde_json::json!({
        "id": id,
        "userId": user_id,
        "liveId": live_id,
        "name": name,
        "screenName": screen_name,
        "displayName": display_name,
        "nickname": nickname,
        "isSupporter": is_supporter,
        "comment": comment_html,
        "speechText": speech_text,
        "profileImage": profile_image,
        "originalProfileImage": original_profile_image,
        "isOwner": is_owner,
        "isModerator": is_moderator,
        "isMember": is_member,
        "isVerified": is_verified,
        "isFirstTime": is_first_time,
        "isRepeater": is_repeater,
        "commentVisible": comment_visible,
        "autoModerated": auto_moderated,
        "timestamp": timestamp,
        "hasGift": has_gift || amount > 0.0,
        "amount": amount,
        "currency": currency,
        "paidText": paid_text,
        "membership": membership,
        "colors": colors,
        "stickerImage": sticker_image,
        "badges": badges,
        "meta": comment_meta,
        "_komehubTrace": komehub_trace.clone()
    });

    serde_json::json!({
        "id": id,
        "service": "youtube",
        "name": name,
        "url": url,
        "color": color,
        "meta": comment_meta,
        "_komehubTrace": komehub_trace,
        "profileImage": profile_image,
        "badges": badges,
        "hasGift": has_gift || amount > 0.0,
        "data": data
    })
}

#[cfg(test)]
mod tests {
    use super::{raw_to_onecomme, transform_to_onecomme};

    #[test]
    fn raw_to_onecomme_maps_official_comment_fields() {
        let raw = serde_json::json!({
            "id": "comment-1",
            "userId": "user-1",
            "liveId": "live-1",
            "name": "視聴者A",
            "displayName": "表示名A",
            "screenName": "@viewer_a",
            "nickname": "ニックネームA",
            "comment": "こんばんは",
            "commentHtml": "<b>こんばんは</b>",
            "speechText": "こんばんは",
            "profileImage": "https://cdn.example.com/avatar.png",
            "originalProfileImage": "https://cdn.example.com/original-avatar.png",
            "timestamp": "12:34",
            "isOwner": false,
            "isModerator": true,
            "isMember": true,
            "isVerified": true,
            "isFirstTime": true,
            "isRepeater": true,
            "commentVisible": false,
            "autoModerated": true,
            "isSupporter": true,
            "amount": 1000.0,
            "currency": "JPY",
            "amountDisplay": "￥1,000",
            "superchatTier": "yellow",
            "memberMonths": 6,
            "isMembership": true,
            "membershipHeader": "メンバーになりました",
            "memberBadgeUrl": "https://cdn.example.com/badge.png"
        });

        let converted = raw_to_onecomme(&raw);
        let data = &converted["data"];

        assert_eq!(converted["id"], "comment-1");
        assert_eq!(converted["service"], "youtube");
        assert_eq!(converted["url"], "");
        assert_eq!(data["userId"], "user-1");
        assert_eq!(data["liveId"], "live-1");
        assert_eq!(data["displayName"], "表示名A");
        assert_eq!(data["screenName"], "@viewer_a");
        assert_eq!(data["nickname"], "ニックネームA");
        assert_eq!(data["comment"], "<b>こんばんは</b>");
        assert_eq!(data["speechText"], "こんばんは");
        assert_eq!(data["originalProfileImage"], "https://cdn.example.com/original-avatar.png");
        assert_eq!(data["isModerator"], true);
        assert_eq!(data["isVerified"], true);
        assert_eq!(data["isFirstTime"], true);
        assert_eq!(data["isRepeater"], true);
        assert_eq!(data["commentVisible"], false);
        assert_eq!(data["autoModerated"], true);
        assert_eq!(data["isSupporter"], true);
        assert_eq!(data["paidText"], "￥1,000");
        assert_eq!(data["membership"]["primary"], "メンバーになりました");
        assert_eq!(data["membership"]["sub"], "メンバー歴 6 か月");
        assert_eq!(data["badges"][0]["url"], "https://cdn.example.com/badge.png");
        assert_eq!(data["colors"]["headerBackgroundColor"], "#ffb300");
    }

    #[test]
    fn raw_to_onecomme_falls_back_to_safe_defaults() {
        let raw = serde_json::json!({
            "id": "comment-2",
            "name": "視聴者B",
            "comment": "hello"
        });

        let converted = raw_to_onecomme(&raw);
        let data = &converted["data"];

        assert_eq!(data["userId"], "視聴者B");
        assert_eq!(data["liveId"], "");
        assert_eq!(data["displayName"], "視聴者B");
        assert_eq!(data["speechText"], "hello");
        assert_eq!(data["commentVisible"], true);
        assert_eq!(data["originalProfileImage"], "");
    }

    #[test]
    fn raw_to_onecomme_membership_gift_gets_teal_colors() {
        let raw = serde_json::json!({
            "id": "gift-1",
            "name": "ギフター",
            "comment": "5 件のメンバーシップギフト",
            "hasGift": true,
            "isMembershipGift": true,
            "giftCount": 5
        });

        let converted = raw_to_onecomme(&raw);
        let data = &converted["data"];

        assert_eq!(data["hasGift"], true);
        assert_eq!(converted["hasGift"], true);
        assert!(!data["colors"].is_null(), "membership gift should have colors");
        assert_eq!(data["colors"]["headerBackgroundColor"], "#00bfa5");
        assert_eq!(data["colors"]["bodyBackgroundColor"], "#00e5ff");
    }

    #[test]
    fn transform_to_onecomme_wraps_template_comment() {
        let message = serde_json::json!({
            "type": "template-comment",
            "data": {
                "id": "comment-3",
                "name": "視聴者C",
                "comment": "test"
            }
        });

        let wrapped = transform_to_onecomme(&message.to_string()).expect("comment message");
        let parsed: serde_json::Value = serde_json::from_str(&wrapped).expect("json");
        assert_eq!(parsed["type"], "comments");
        assert_eq!(parsed["data"]["comments"][0]["data"]["id"], "comment-3");
    }

    #[test]
    fn transform_to_onecomme_wraps_deleted_message() {
        let message = serde_json::json!({
            "type": "comment-deleted",
            "data": {
                "id": "comment-4"
            }
        });

        let wrapped = transform_to_onecomme(&message.to_string()).expect("deleted message");
        let parsed: serde_json::Value = serde_json::from_str(&wrapped).expect("json");
        assert_eq!(parsed["type"], "deleted");
        assert_eq!(parsed["data"][0]["id"], "comment-4");
        assert_eq!(parsed["data"][0]["message"], "deleted");
    }
}
