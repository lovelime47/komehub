use std::collections::HashMap;
use std::collections::VecDeque;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// chat-scraper から受信するコメントデータ
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawComment {
    pub id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub live_id: String,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub screen_name: String,
    #[serde(default)]
    pub nickname: String,
    pub comment: String,
    #[serde(default)]
    pub comment_html: String,
    #[serde(default)]
    pub speech_text: String,
    #[serde(default)]
    pub profile_image: String,
    #[serde(default, alias = "_originalProfileImage")]
    pub original_profile_image: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub has_gift: bool,
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
    /// `liveChatSponsorshipsGiftRedemptionAnnouncementRenderer` = ギフトを受け取った人。
    /// 贈り主が支払うので受領者は課金扱いにしない (= 新規メンバー集計・金額に含めない)。
    /// 表示は通常コメント + 控えめなギフト印。`is_membership` 等とは排他。
    #[serde(default)]
    pub is_membership_gift_redemption: bool,
    /// `liveChatMembershipItemRenderer` のうち継続記念 (= "X カ月メンバー" 自動投稿) か。
    /// `headerPrimaryText` が非空の場合に true。新規加入 ("X へようこそ！") は false。
    /// `is_membership` と同時に true になる (= mutually exclusive ではない)。
    /// 新メンバータブの filter は false 側 (= comment_type='membership') のみ拾う。
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
    /// Phase C listener DB 連動タグ。
    ///
    /// 値は `""`, `first-time`, `returning`, `regular-arrival`。
    /// コメハブ本体 UI はこの値から 初見 / 再訪 / 今北 のタグを表示し、
    /// コメントテンプレートは `rawComment.listenerStatus` または
    /// `data-kh="listenerStatus"` として参照できる。
    #[serde(default)]
    pub listener_status: String,
    #[serde(default)]
    pub listener_tag: String,
    /// listener DB の原子条件: 自チャンネル群で過去コメントがあるか。
    #[serde(default)]
    pub has_prior_listener_comment: bool,
    /// listener DB の原子条件: この配信で初めてのコメントか。
    #[serde(default)]
    pub is_first_comment_in_stream: bool,
    /// 現在配信を除く、自チャンネル群での前回コメント日時 (RFC3339)。
    #[serde(default)]
    pub listener_previous_stream_last_seen_at: String,
    #[serde(default)]
    pub listener_previous_stream_last_seen_at_ms: i64,
    /// listener DB / 現セッションで観測した、このユーザーの 1 つ前のコメント日時。
    #[serde(default)]
    pub listener_previous_comment_at: String,
    #[serde(default)]
    pub listener_previous_comment_at_ms: i64,
    /// この配信内での、このユーザーのコメント数 / スパチャ累計。
    #[serde(default)]
    pub listener_current_stream_comment_count: u32,
    #[serde(default)]
    pub listener_current_stream_superchat_amount_jpy: i64,
    #[serde(default)]
    pub listener_current_stream_superchat_amount_display: String,
    /// この配信での初コメ時に表示する、前回コメントした配信の情報。
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
    #[serde(default)]
    pub comment_visible: bool,
    #[serde(default)]
    pub auto_moderated: bool,
    /// テンプレ / 演出のテスト送信由来のコメントか。
    /// true の場合、コメント配信側 (= performance / TTS / SSE / 表示) は通常通り処理するが、
    /// コメント管理側 (= listener_record_queue 投入、配信ログへの集計、わんコメ書き戻し等) は
    /// 全部 skip する。「テスト送信したコメントが配信実績として記録される」のを防ぐ。
    /// 将来テストコメに対する別の特別処理が必要になった場合もこのフィールドで分岐する。
    #[serde(default)]
    pub is_template_test: bool,
    /// chat-scraper の `ytInitialData` 経由で取り込まれた「接続直前の過去コメ」か。
    /// true の場合、`performance.evaluate` (= 演出) と TTS は skip する (= 過去コメで
    /// 演出 / 読み上げが走るのを防ぐ)。それ以外 (= listener_record / SSE / 表示 /
    /// テンプレ / わんコメ書き戻し) は通常通り処理する。
    /// 接続が遅れた / 一時切断した時の直近コメをハブに取り込むための仕組み。
    #[serde(default)]
    pub is_backfill: bool,
    #[serde(default, rename = "_komehubTrace")]
    pub komehub_trace: Value,
}

impl RawComment {
    pub fn set_trace_ms(&mut self, key: &str, value: u64) {
        if !self.komehub_trace.is_object() {
            self.komehub_trace = Value::Object(Map::new());
        }
        if let Some(obj) = self.komehub_trace.as_object_mut() {
            obj.insert(key.to_string(), serde_json::json!(value));
        }
    }
}

/// chat-scraper から受信するリアクションデータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawReaction {
    pub emoji: String,
    #[serde(default = "default_count")]
    pub count: u32,
}

fn default_count() -> u32 { 1 }

/// コメントタイムライン（最新N件のリングバッファ）
#[derive(Debug, Clone)]
pub struct CommentTimelineEntry {
    pub cursor: u32,
    pub comment: RawComment,
}

pub struct CommentTimeline {
    comments: VecDeque<CommentTimelineEntry>,
    capacity: usize,
    next_cursor: u32,
    dropped_count: u32,
}

impl CommentTimeline {
    pub fn new(capacity: usize) -> Self {
        Self {
            comments: VecDeque::with_capacity(capacity),
            capacity,
            next_cursor: 1,
            dropped_count: 0,
        }
    }

    pub fn push(&mut self, comment: RawComment) -> CommentTimelineEntry {
        if self.comments.len() >= self.capacity {
            self.comments.pop_front();
            self.dropped_count = self.dropped_count.wrapping_add(1);
        }
        let entry = CommentTimelineEntry {
            cursor: self.next_cursor,
            comment,
        };
        self.next_cursor = self.next_cursor.wrapping_add(1);
        self.comments.push_back(entry.clone());
        entry
    }

    /// 同じ comment id の timeline entry が残っていれば内容だけ更新する。
    /// cursor は維持し、新規 entry は作らない。
    pub fn update_by_id(&mut self, comment: RawComment) -> Option<CommentTimelineEntry> {
        if comment.id.is_empty() {
            return None;
        }
        let entry = self
            .comments
            .iter_mut()
            .find(|entry| entry.comment.id == comment.id)?;
        entry.comment = comment;
        Some(entry.clone())
    }

    #[allow(dead_code)]
    pub fn recent(&self, limit: usize) -> Vec<&RawComment> {
        self.comments
            .iter()
            .rev()
            .take(limit)
            .map(|entry| &entry.comment)
            .collect()
    }

    #[allow(dead_code)]
    pub fn recent_cloned(&self, limit: usize) -> Vec<RawComment> {
        let mut items: Vec<RawComment> = self
            .comments
            .iter()
            .rev()
            .take(limit)
            .map(|entry| entry.comment.clone())
            .collect();
        items.reverse();
        items
    }

    pub fn entries(&self) -> &VecDeque<CommentTimelineEntry> {
        &self.comments
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.comments.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.comments.is_empty()
    }

    #[allow(dead_code)]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn next_cursor(&self) -> u32 {
        self.next_cursor
    }

    pub fn dropped_count(&self) -> u32 {
        self.dropped_count
    }

    /// 配信切替時に in-memory rolling window をリセットする。
    /// `next_cursor` は維持する (= shared_memory 側の cursor 連続性を壊さない)。
    pub fn clear(&mut self) {
        self.comments.clear();
    }
}

/// replay 用の正本コメントストア。
/// 同一 id は更新扱い、削除通知を受けた id は replay 対象から除外する。
pub struct CanonicalCommentStore {
    comments: VecDeque<RawComment>,
    capacity: usize,
}

impl CanonicalCommentStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            comments: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    /// 同じ id が既に存在すれば内容を更新して `false` を返す (= 重複コメ)。
    /// 新規 ID なら追加して `true` を返す (= 新規コメ)。
    /// 呼び出し元はこの戻り値で「すでに処理済みか」を判定し、
    /// 重複コメに対する side effect (= 演出 / TTS / SSE / record_comment 等) を skip できる。
    pub fn upsert(&mut self, comment: RawComment) -> bool {
        if !comment.id.is_empty() {
            if let Some(existing) = self.comments.iter_mut().find(|item| item.id == comment.id) {
                *existing = comment;
                return false;
            }
        }
        if self.comments.len() >= self.capacity {
            self.comments.pop_front();
        }
        self.comments.push_back(comment);
        true
    }

    pub fn delete_ids(&mut self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let id_set: std::collections::HashSet<&str> = ids.iter().map(|id| id.as_str()).collect();
        self.comments
            .retain(|comment| comment.id.is_empty() || !id_set.contains(comment.id.as_str()));
    }

    /// 配信切替時に in-memory cache をリセットする。
    /// dedup スコープは per-comment-id だが、テンプレ / わんコメ WS の初回 backfill
    /// (= recent_cloned) で旧枠コメが新枠クライアントに混入しないよう clear する。
    pub fn clear(&mut self) {
        self.comments.clear();
    }

    pub fn recent_cloned(&self, limit: usize) -> Vec<RawComment> {
        let mut items: Vec<RawComment> = self
            .comments
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect();
        items.reverse();
        items
    }
}

/// リアクション種別ごとの累計カウント
pub struct ReactionCounts {
    counts: HashMap<String, u64>,
}

impl Default for ReactionCounts {
    fn default() -> Self {
        Self::new()
    }
}

impl ReactionCounts {
    pub fn new() -> Self {
        Self {
            counts: HashMap::new(),
        }
    }

    #[allow(dead_code)]
    pub fn increment(&mut self, emoji: &str) {
        self.increment_by(emoji, 1);
    }

    pub fn increment_by(&mut self, emoji: &str, amount: u64) {
        *self.counts.entry(emoji.to_string()).or_insert(0) += amount;
    }

    pub fn get(&self, emoji: &str) -> u64 {
        *self.counts.get(emoji).unwrap_or(&0)
    }

    #[allow(dead_code)]
    pub fn all(&self) -> &HashMap<String, u64> {
        &self.counts
    }

    /// 配信切替時に累計をリセットする。renderer 側の totalReactions は
    /// shared_memory snapshot から data.total を直接読むため、ここで 0 に
    /// しないと「配信 A の累計 + 配信 B の 1 件」と混在表示される。
    pub fn clear(&mut self) {
        self.counts.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-05-10 検出: stream 切替時に累計が引き継がれる cross-stream バグ修正検証。
    /// shared_memory snapshot 経由で renderer に流れる total に旧枠分を残さない。
    #[test]
    fn reaction_counts_clear_resets_all_emojis() {
        let mut rc = ReactionCounts::new();
        rc.increment_by("heart", 5);
        rc.increment_by("smile", 3);
        assert_eq!(rc.get("heart"), 5);
        assert_eq!(rc.get("smile"), 3);
        rc.clear();
        assert_eq!(rc.get("heart"), 0, "clear で全 emoji が 0 リセットされる");
        assert_eq!(rc.get("smile"), 0);
    }

    #[test]
    fn canonical_comment_store_clear_empties_buffer() {
        let mut store = CanonicalCommentStore::new(100);
        let c: RawComment = serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "n", "comment": "hi", "timestamp": "10:00 AM",
            "hasGift": false, "amount": 0, "currency": "", "amountDisplay": "",
            "stickerImage": "", "tierColor": "", "superchatTier": "",
            "profileImage": "", "isMember": false, "memberMonths": 0,
            "memberBadgeUrl": "", "isModerator": false, "isOwner": false, "isVerified": false
        })).unwrap();
        assert!(store.upsert(c.clone()));
        assert_eq!(store.recent_cloned(10).len(), 1);
        store.clear();
        assert_eq!(store.recent_cloned(10).len(), 0,
            "clear 後は recent_cloned が空 (= 新枠クライアントに旧枠コメが漏れない)");
    }

    #[test]
    fn comment_timeline_clear_empties_window_keeps_cursor() {
        let mut tl = CommentTimeline::new(100);
        let c: RawComment = serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "n", "comment": "hi", "timestamp": "10:00 AM",
            "hasGift": false, "amount": 0, "currency": "", "amountDisplay": "",
            "stickerImage": "", "tierColor": "", "superchatTier": "",
            "profileImage": "", "isMember": false, "memberMonths": 0,
            "memberBadgeUrl": "", "isModerator": false, "isOwner": false, "isVerified": false
        })).unwrap();
        let entry1 = tl.push(c.clone());
        assert_eq!(entry1.cursor, 1);
        tl.clear();
        // 新エントリは cursor 連番を継続 (= shared_memory 側の cursor 連続性を維持)
        let entry2 = tl.push(c);
        assert_eq!(entry2.cursor, 2, "clear で next_cursor は維持される");
    }

    #[test]
    fn comment_timeline_update_by_id_replaces_entry_without_advancing_cursor() {
        let mut tl = CommentTimeline::new(100);
        let c1: RawComment = serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "n", "comment": "first", "timestamp": "10:00 AM",
            "hasGift": false, "amount": 0, "currency": "", "amountDisplay": "",
            "stickerImage": "", "tierColor": "", "superchatTier": "",
            "profileImage": "", "isMember": false, "memberMonths": 0,
            "memberBadgeUrl": "", "isModerator": false, "isOwner": false, "isVerified": false
        })).unwrap();
        let mut c2 = c1.clone();
        c2.comment = "updated".to_string();

        let pushed = tl.push(c1);
        let updated = tl.update_by_id(c2).expect("existing entry should update");

        assert_eq!(updated.cursor, pushed.cursor);
        assert_eq!(tl.next_cursor(), 2, "更新では新規 cursor を発行しない");
        assert_eq!(tl.entries().len(), 1);
        assert_eq!(tl.entries().front().unwrap().comment.comment, "updated");
    }
}
