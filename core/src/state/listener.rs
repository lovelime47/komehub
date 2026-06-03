//! Step 3 リスナー管理: state 構造体定義
//!
//! `listeners.db` (SQLite) に対応する Rust 側の row 構造体と、
//! ModelCommand / API レスポンスで使うクエリ・サマリ型をここに集約する。
//!
//! 設計詳細は docs/step3-design.md § 3.2 (DDL) と § 4.2 (ListenerManager) を参照。

use serde::{Deserialize, Serialize};

/// `Vec<String>` を 「単一値 / カンマ区切り / シーケンス」 のいずれからでも
/// デシリアライズできるようにする helper。
///
/// 用途: ListenersQuery / CommentsQuery 等の `system_tags` / `user_tags` 等の
/// 配列パラメータ。 axum の Query (serde_urlencoded) は `?foo=a` を Vec<String>
/// に変換できず 400 を返すので、 `#[serde(deserialize_with = "deserialize_str_or_vec")]`
/// を付けて受けられるようにする。 JSON (= napi 経由) の配列もそのまま受ける。
fn deserialize_str_or_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct StrOrVec;
    impl<'de> serde::de::Visitor<'de> for StrOrVec {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("string, list of strings, or comma-separated values")
        }
        fn visit_str<E>(self, s: &str) -> Result<Vec<String>, E>
        where
            E: serde::de::Error,
        {
            Ok(s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect())
        }
        fn visit_string<E>(self, s: String) -> Result<Vec<String>, E>
        where
            E: serde::de::Error,
        {
            self.visit_str(&s)
        }
        fn visit_unit<E>(self) -> Result<Vec<String>, E>
        where
            E: serde::de::Error,
        {
            Ok(Vec::new())
        }
        fn visit_none<E>(self) -> Result<Vec<String>, E>
        where
            E: serde::de::Error,
        {
            Ok(Vec::new())
        }
        fn visit_seq<A>(self, mut seq: A) -> Result<Vec<String>, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let mut v = Vec::new();
            while let Some(s) = seq.next_element::<String>()? {
                v.push(s);
            }
            Ok(v)
        }
    }
    deserializer.deserialize_any(StrOrVec)
}

/// listeners テーブル 1 行に対応。
/// channel_id は `yt-{UC...}` 形式 (わんコメ users.id と互換)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // フェーズ 3.2a で read API から使い始める
pub struct ListenerRow {
    pub channel_id: String,
    pub display_name: String,
    pub username: Option<String>,
    pub icon_url: Option<String>,
    pub name_history: serde_json::Value,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub comment_count: i64,
    pub superchat_count: i64,
    pub superchat_amount_jpy: i64,
    pub is_member: bool,
    pub is_moderator: bool,
    pub member_months_max: i64,
    pub notes: String,
    pub label: String,
    /// 配信者がリスナーに付ける表示用のあだ名 (わんコメ users.data.nickname と双方向同期)。
    /// display_name と異なり手動編集される。空文字なら未設定扱い。
    #[serde(default)]
    pub nickname: String,
    pub raw: Option<serde_json::Value>,
    /// 最後のコメント本文 (UI 表示用、comments テーブルからの correlated subquery で都度取得)。
    /// JSON Lines export / import では `#[serde(default)]` で互換性確保。
    /// 古い export ファイルを import する際にも欠落 = None として扱える。
    #[serde(default)]
    pub last_comment_body: Option<String>,
    /// 最後のコメントの HTML 表現 (カスタム絵文字を <img> に展開した版、innerHTML 用)。
    /// raw.commentHtml を json_extract した結果。innertube_parser 側で
    /// html_escape 済みなので innerHTML に流して安全。
    #[serde(default)]
    pub last_comment_html: Option<String>,
    /// リモート閲覧 redesign §5.4: ListenersQuery.stream_video_id 指定時に
    /// 当該枠での「挨拶済み」状態 (= stream_listener_state.greeted_at)。
    /// context が無い時 / 未挨拶の場合は 0。古い JSON Lines export からの import 時は
    /// `#[serde(default)]` で 0 になる。
    #[serde(default)]
    pub greeted_at: i64,
    /// ListenersQuery.stream_video_id 指定時に、当該枠での SC 累計 (JPY)。
    /// context が無い場合は 0。renderer の listener panel が
    /// 「現枠 SC = ¥X (amber primary)」表示を出すための正本値。
    /// 過去の `currentStreamScByChannelId` (= live cache) 廃止に伴い、
    /// DB 集計を一次情報として持つ。古い JSON Lines export 互換のため
    /// `#[serde(default)]`。
    #[serde(default)]
    pub per_stream_sc_amount_jpy: i64,
    /// ListenersQuery.stream_video_id 指定時に、当該枠でのコメント数。
    /// context が無い場合は 0。リスナータブの件数表示はこれを優先する。
    #[serde(default)]
    pub per_stream_comment_count: i64,
    /// ListenersQuery.stream_video_id 指定時に、当該枠での最終コメント時刻。
    /// 他チャンネル配信では listeners.last_seen_at を自チャンネル集計として 0 のまま
    /// 保つため、リスナー一覧の「最終」はこの値を優先して表示する。
    #[serde(default)]
    pub per_stream_last_at: i64,
    /// リスナーランク (= 新規 / 新参 / 常連 / 古参 / 復帰 / 離脱)。
    /// stream_video_id または baseline_stream_video_id 指定時に Rust 側で
    /// classify_listener_rank を経由して計算 (= SSoT)。
    /// 指定無しなら None (= JSON 上は欠落)。 2026-05-14 追加。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_tag: Option<String>,
}

/// owner_channels テーブル 1 行に対応 (自チャンネル設定の単位)。
/// `handle` は @入力時に保持する表示用識別子で、UC 直接入力時は None。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerChannel {
    pub channel_id: String,
    #[serde(default)]
    pub handle: Option<String>,
}

/// streams テーブル 1 行に対応。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // フェーズ 3.2b で read API から使い始める
pub struct StreamRow {
    pub video_id: String,
    pub owner_channel_id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub comment_count: i64,
    pub superchat_count: i64,
    pub superchat_amount_jpy: i64,
    /// 配信ページ URL (https://www.youtube.com/watch?v={video_id})
    #[serde(default)]
    pub stream_url: String,
    /// チャンネル名 (videoDetails.author)
    #[serde(default)]
    pub channel_name: String,
    /// チャンネルアイコン URL (videoOwnerRenderer.thumbnail)
    #[serde(default)]
    pub channel_icon_url: String,
    /// 概要欄テキスト (videoDetails.shortDescription)
    #[serde(default)]
    pub description: String,
    /// 登録者数 (subscriberCountText から数値抽出)
    #[serde(default)]
    pub subscriber_count: i64,
    /// 同時接続数 (videoViewCountRenderer.viewCount から数値抽出、リアルタイム更新)
    #[serde(default)]
    pub current_viewers: i64,
    /// 5 分以上維持できた最大同時接続数 (瞬間スパイクを除いた実質ピーク)。
    /// 配信の規模を後から追跡できるよう DB に蓄積する。
    #[serde(default)]
    pub peak_concurrent_viewers: i64,
    /// いいね数 (likeButtonViewModel.title から数値抽出、リアルタイム更新)
    #[serde(default)]
    pub likes: i64,
    /// 動的メタデータの最終更新時刻 (current_viewers / likes / subscriber_count)
    #[serde(default)]
    pub live_metadata_updated_at: i64,
    /// 現在の自チャンネル設定に含まれる配信かどうか。
    #[serde(default)]
    pub is_own_stream: bool,
}

/// comments テーブル 1 行に対応。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // フェーズ 3.2b で read API から使い始める
pub struct CommentRow {
    pub id: String,
    pub stream_id: String,
    pub listener_channel_id: String,
    pub posted_at: i64,
    pub body: String,
    pub comment_type: CommentType,
    pub superchat_amount_jpy: Option<i64>,
    pub superchat_currency: Option<String>,
    pub superchat_amount_raw: Option<f64>,
    pub raw: serde_json::Value,
    /// リモート閲覧 redesign §3.2: 「対応済み」マーク。0 = 未対応、>0 = 対応した時刻 (Unix ms)。
    /// 既存 client は serde default で 0 になるため互換性影響はない。
    #[serde(default)]
    pub responded_at: i64,
}

/// コメント種別。`comments.comment_type` に格納する文字列と対応する。
///
/// `Membership` は「この枠で新規メンバーシップ加入」(= "X へようこそ！" 通知) を意味する。
/// 「X カ月メンバー」のような継続記念は `MembershipMilestone` で別管理し、新規加入とは
/// 区別する (= 新メンバータブは Membership のみで filter)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentType {
    Chat,
    Superchat,
    Membership,
    #[serde(rename = "membership_milestone")]
    MembershipMilestone,
    Sticker,
    Gift,
    /// メンバーシップギフトを受け取った人 (= 課金していない / 新規メンバー集計に含めない)。
    #[serde(rename = "gift_redemption")]
    GiftRedemption,
}

impl CommentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            CommentType::Chat => "chat",
            CommentType::Superchat => "superchat",
            CommentType::Membership => "membership",
            CommentType::MembershipMilestone => "membership_milestone",
            CommentType::Sticker => "sticker",
            CommentType::Gift => "gift",
            CommentType::GiftRedemption => "gift_redemption",
        }
    }
}

/// record_comment 実行結果のサマリ。
/// runtime event での通知や WARN ログに使う。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // フェーズ 3.2 以降で runtime event ペイロードに使う
pub struct RecordCommentSummary {
    /// 新規コメントだったか (RETURNING 句が 1 行返したか)。
    pub inserted: bool,
    /// 紐づくリスナーが初めての登場 (今回 listeners INSERT 成功) か。
    pub is_first_time_listener: bool,
    /// 確定後の listener.channel_id (yt-{UC...} 形式)。
    pub channel_id: String,
}

/// コメント配信前に付与する listener DB 由来の分類。
/// `comments` insert 前の DB 状態を読むため、今回のコメントが
/// 「初めて」かどうかを UI / template payload に載せられる。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerCommentClassification {
    pub has_prior_comment: bool,
    pub has_comment_in_current_stream: bool,
    pub current_stream_comment_count: u32,
    pub current_stream_superchat_amount_jpy: i64,
    pub is_regular_listener: bool,
    pub regular_stream_count: u32,
    pub regular_window_streams: u32,
    pub regular_min_streams: u32,
    pub previous_stream_last_seen_at_ms: i64,
    pub previous_stream_last_seen_at: String,
    pub previous_comment_at_ms: i64,
    pub previous_comment_at: String,
    pub previous_stream_id: String,
    pub previous_stream_title: String,
    pub previous_stream_started_at_ms: i64,
    pub previous_stream_started_at: String,
    /// 帰還タグ判定用: listeners.first_seen_at (= 全期間で最古のコメ時刻、 ms)。
    /// 既存 listener 行が無ければ 0。 model_queue 側で `first_seen_at < baseline - X日`
    /// チェックに使う (= 2026-05-14)。
    pub first_seen_at_ms: i64,
}

/// `delete_listeners` の戻り値要素。1 リスナーの削除結果。
/// コメントは削除されず孤児として残る (= 同 channel_id のリスナー再登場時に
/// 自動で再紐付けされる仕様)。本フィールドは UI 表示用の参考値。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteListenerSummary {
    pub channel_id: String,
    /// 孤児化したコメント件数 (= 削除されず残るコメント数)。
    pub orphaned_comments: i64,
    /// うちスパチャ系 (superchat / sticker / gift) の件数。
    pub orphaned_superchats: i64,
    /// listeners 行が実際に削除されたか (false なら listeners に行が無かった)。
    pub listener_deleted: bool,
    /// アバター画像ファイルが削除されたか (cache URL が解決できなかった場合は false)。
    pub avatar_file_deleted: bool,
}

/// list_listeners のクエリパラメータ。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenersQuery {
    /// 並び替え。デフォルトは last_seen 降順。
    #[serde(default)]
    pub sort: ListenersSort,
    /// display_name 部分一致 (大小文字無視)。空または未指定で全件。
    pub q: Option<String>,
    /// 1 ページの最大行数 (1〜1000)。既定 100。
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// リモート閲覧 redesign §5.4: per-stream context。
    /// 指定すると「その配信枠で発言した listener のみ」に絞り込み (= EXISTS subquery)、
    /// かつ各 listener の greeted_at は当該枠での状態を返す。
    #[serde(default)]
    pub stream_video_id: Option<String>,
    /// リモート閲覧 redesign §5.4: 「未挨拶のみ」フィルタ。
    /// stream_video_id と組み合わせて使う。指定時は当該枠で挨拶していない listener のみ。
    #[serde(default)]
    pub un_greeted_only: bool,
    /// システム判定タグ ("first-time" / "returning" / "regular" / "veteran") を OR で AND する。
    /// 定義は CommentsQuery.system_tags と同じ。空配列で無効。
    /// - first-time = comment_count <= 1
    /// - returning  = comment_count > 1 AND first_seen_at >= NOW - 30d
    ///   リスナータブの現枠 context では「この枠以前に初回観測済み」も必要。
    /// - regular    = NOW - 365d <= first_seen_at < NOW - 30d
    /// - veteran    = first_seen_at < NOW - 365d
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub system_tags: Vec<String>,
    /// 「復帰」フィルタ: 常連以上 (first_seen_at < NOW-30d) で **直近 14 枠** (= streams.started_at
    /// DESC で上位 14、現枠を除外) にコメントが無い人のみ。stream_video_id 必須。
    #[serde(default)]
    pub comeback_only: bool,
    /// 「新メンバー」フィルタ: 現枠 (= stream_video_id) で `comment_type='membership'` の
    /// コメントを残した人のみ (= この枠でメンバーシップ加入した人)。過去実績は不問。
    /// stream_video_id 必須。
    #[serde(default)]
    pub new_member_only: bool,
    /// 「新規 (この枠で初めてコメント)」フィルタ: 全期間で最初のコメント
    /// (`listeners.first_seen_at`) が現枠 (= stream_video_id) の started_at 以降の人。
    /// `system_tags="first-time"` (= 累計コメ数 1 以下) とは別概念で、当該枠で連投した
    /// 新規も含める。stream_video_id 必須。
    #[serde(default)]
    pub first_in_stream_only: bool,
    /// リスナー検索タブ Phase 2b' (= 2026-05-14): 全期間 listener 一覧で
    /// 「最終枠」を baseline として使う場合の配信 video_id。
    ///
    /// `stream_video_id` (= 母集団を当該枠コメ済に絞る) と異なり、母集団は全 listener の
    /// まま **時刻基準** だけを「最終枠.started_at」に揃える。 接続中の場合は
    /// `currentStreamVideoId`、 切断中は `owner_channels` 配下の最新枠 (= `list_streams`
    /// で取得) を JS 側で解決する。
    ///
    /// 指定すると system_tags の判定が baseline 基準 + 6 ランク (= 復帰 / 離脱を含む)
    /// になる:
    /// - first-time = first_seen_at >= baseline_started
    /// - returning  = baseline_started - X日 <= first_seen_at < baseline_started
    /// - regular    = baseline_started - Y日 <= first_seen_at < baseline_started - X日 AND active
    /// - veteran    = first_seen_at < baseline_started - Y日 AND active
    /// - comeback   = first_seen_at < baseline_started - X日 AND NOT active AND 復帰窓 (= last_n_streams ∪ baseline、 N+1 枠) でコメ済
    /// - abandoned  = first_seen_at < baseline_started - X日 AND NOT active AND 復帰窓でコメ無し
    ///
    /// `stream_video_id` が指定されている場合は無視する (= 既存挙動優先)。
    #[serde(default)]
    pub baseline_stream_video_id: Option<String>,
    /// ユーザー付与タグ (= `listener_tags` テーブル経由 EXISTS、 タグ間は OR)。
    /// 空配列で無効。 StreamListenersQuery / CommentsQuery 同名フィールドと同義。
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub user_tags: Vec<String>,
}

/// list_listener_search_rank_counts の戻り値。
/// 設定画面「リスナー判定」セクションのライブプレビュー用 (= 現しきい値で
/// 全 audience が各ランクに何人入るか)。 baseline_stream_video_id を渡し、
/// 6 分類 + total を 1 SQL で集計する。 listener-search タブの chip 押下時に
/// 得られる件数と同じ意味 (= 母集団は `listeners.comment_count > 0`、
/// 時刻基準は最終枠の started_at)。
///
/// baseline 未解決 (= 自チャンネル枠なし) の場合は呼び出し側で fetch を抑止する。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerSearchRankCounts {
    pub total: i64,
    pub first_time: i64,
    pub returning: i64,
    pub regular: i64,
    pub veteran: i64,
    pub comeback: i64,
    pub abandoned: i64,
}

/// list_stream_scoped_listener_counts の戻り値。リスナータブのミニタブ件数バッジ用。
/// stream_video_id 必須 (= 接続中の枠のリスナー数を集計)。各値は同じ stream_video_id
/// 制約下での件数で、`all` がベース、他はそれぞれの追加 filter を適用した件数。
/// (= 既存 ListenerChipCounts は別用途 / 別 struct なので名前衝突を避ける)
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerStreamScopedCounts {
    pub all: i64,
    pub un_greeted: i64,
    pub first_time: i64,
    pub returning: i64,
    pub comeback: i64,
    pub new_member: i64,
}

/// list_stream_listener_pill_counts の戻り値。配信詳細モーダルのリスナータブ
/// system pill 件数用 (= 「すべて / 新規 / 新参 / 常連 / 古参 / 復帰 / 新メンバー」)。
///
/// **重要**: 各値は `list_stream_listeners` のページング (= limit 1000) と独立に、
/// 全 audience に対して計算される (= 1000 人超の配信でも正確な件数)。
///
/// filter ポリシー: name_q / body_q / user_tags は適用するが、system_tags /
/// member_join_only は無視する (= 「もし pill を切り替えたら何人」を見せるため、
/// 切り替え候補となる pill 自身は filter から外す)。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamListenerPillCounts {
    pub all: i64,
    pub first_time: i64,
    pub returning: i64,
    pub regular: i64,
    pub veteran: i64,
    pub comeback: i64,
    pub member_joined: i64,
}

/// list_stream_listener_pill_counts のフィルタ。name_q / body_q / user_tags のみ。
/// system_tags / member_join_only は含めない (= 上記 struct のコメント参照)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamListenerPillCountsQuery {
    pub name_q: Option<String>,
    pub body_q: Option<String>,
    /// 横断テキスト検索 (= name OR body)。 list_stream_listeners と同じ意味。
    /// 指定時は name_q / body_q を無視。 2026-05-14 追加。
    pub text_q: Option<String>,
    #[serde(default)]
    pub user_tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ListenersSort {
    /// 累計コメント数降順。
    CommentCount,
    /// 現枠で最初にコメントした時刻の降順。
    ///
    /// stream_video_id が無い場合は LastSeen と同じ挙動にフォールバックする。
    StreamFirstAt,
    /// 最終コメ時刻降順。
    #[default]
    LastSeen,
    /// 累計スパチャ JPY 降順。
    SuperchatAmount,
    /// 表示名昇順 (NOCASE)。
    DisplayName,
}

/// list_listeners の戻り値 (ページング込み)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenersPage {
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    pub rows: Vec<ListenerRow>,
}

/// get_listener_detail の戻り値。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerDetail {
    #[serde(flatten)]
    pub listener: ListenerRow,
    pub recent_comments: Vec<CommentRow>,
    /// 2026-05-09 BAN 仕様変更: コメリスト非表示フラグ。
    /// app_config.hidden_listeners[id].hide_from_comments と一致する。
    /// listener_manager は hidden_listeners を知らないため、ModelQueue::GetListenerDetail
    /// ハンドラで join して上書きする。listener_manager 単体では常に false。
    #[serde(default)]
    pub hide_from_comments: bool,
    /// 同上のリスナーリスト非表示フラグ。
    #[serde(default)]
    pub hide_from_listeners: bool,
    /// ユーザー設定タグ (= listener_tags テーブル経由)。 SPA リスナー詳細の
    /// バッジ表示用 (2026-05-14、 B-4)。 空配列なら表示なし。
    #[serde(default)]
    pub user_tags: Vec<String>,
}

/// list_listeners_activity のクエリ。
/// `channel_ids` は yt-{UC...} 形式の listener.channel_id を渡す。
/// `stream_count` は heatmap で表示する直近配信枠数 (default 14, clamp 1〜60)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenersActivityQuery {
    pub channel_ids: Vec<String>,
    pub stream_count: Option<u32>,
}

/// 1 配信枠 × 1 listener の活動量 (heatmap セル 1 個分)。
/// セルは「配信枠」単位で並ぶ。listener が来なかった枠は count=0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamActivityCell {
    pub count: i64,
    /// その枠でその listener が出した SC 額 (円)。SC 無しなら 0。
    pub sc_amount_jpy: i64,
}

/// listener 1 人分の直近 N 配信枠 activity。
/// `cells` は時系列昇順で `streams` 配列と index 一致 (index 0 = 最古, N-1 = 最新)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerStreamActivity {
    pub channel_id: String,
    pub cells: Vec<StreamActivityCell>,
}

/// heatmap で表示する 1 枠分の配信メタ (listener 不問)。
/// streams 配列のレスポンスは時系列昇順 (oldest → newest)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamCell {
    pub video_id: String,
    pub title: String,
    pub started_at: i64,
}

/// list_streams のクエリパラメータ。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamsQuery {
    /// 並び替え。デフォルトは started_at 降順。
    #[serde(default)]
    pub sort: StreamsSort,
    /// 1 ページの最大行数 (1〜500)。既定 100。
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// 配信ログの表示スコープ。既定は全配信。
    #[serde(default)]
    pub scope: StreamScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamScope {
    #[default]
    All,
    Own,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamsSort {
    /// 開始時刻降順 (新しい配信が上)。
    #[default]
    StartedAt,
    /// コメント数降順。
    CommentCount,
    /// スパチャ JPY 降順。
    SuperchatAmount,
    /// 5 分維持ピーク視聴者数降順。
    PeakConcurrentViewers,
    /// いいね数降順。
    Likes,
}

/// list_streams の戻り値。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamsPage {
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    pub rows: Vec<StreamRow>,
}

/// delete_streams の 1 配信ごとの結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteStreamSummary {
    pub video_id: String,
    pub stream_deleted: bool,
    pub deleted_comments: i64,
    pub deleted_stream_tags: i64,
    pub deleted_greeted_states: i64,
    /// この配信削除後、どの配信コメントにも紐付かなくなったため削除した listeners 行。
    pub deleted_orphan_listeners: i64,
    pub thumbnail_file_deleted: bool,
}

/// get_stream_detail の戻り値。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDetail {
    #[serde(flatten)]
    pub stream: StreamRow,
    pub recent_comments: Vec<CommentRow>,
    /// この配信でコメントしたユニークリスナー数 (= COUNT(DISTINCT listener_channel_id))。
    /// 配信詳細モーダルの「コメントリスナー」KPI で表示する。
    pub unique_commenters: i64,
}

/// listener_tags テーブル 1 行に対応 (= 1 リスナー × 1 タグ)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerTagRow {
    pub channel_id: String,
    pub tag: String,
    pub attached_at: i64,
}

/// 全タグの一覧 + 各タグの利用リスナー数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub tag: String,
    pub listener_count: i64,
}

/// stream_tags テーブル 1 行 (= 1 配信枠 × 1 タグ)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTagRow {
    pub video_id: String,
    pub tag: String,
    pub attached_at: i64,
}

/// 配信枠タグの一覧 + 各タグの利用配信枠数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTagSummary {
    pub tag: String,
    pub stream_count: i64,
}

/// stream_listener_state テーブル 1 行 (= 1 配信枠 × 1 リスナーの per-stream 状態)。
/// 設計正本: docs/architecture/remote-viewing-redesign.md §3.1
///
/// `greeted_at` は 0 = 未挨拶 / >0 = 挨拶した時刻 (Unix ms)。
/// 将来 `responded_count` などの派生集計を追加する余地を残す純粋な記録テーブル。
/// メモのような記述項目はここに増やさない。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // 設計先行の状態 DTO。stream listener runtime payload で使う。
pub struct StreamListenerState {
    pub stream_video_id: String,
    pub listener_channel_id: String,
    pub greeted_at: i64,
}

/// saved_searches テーブル 1 行に対応 (= 1 件の保存検索)。
/// `conditions` は scope ごとに別の JSON スキーマ:
///   - scope='comment-search': CommentsQuery 互換
///   - scope='listener-search': リスナー検索クエリ (nameQ / sort / systemTags / userTags 等)
/// UI 側で JSON.parse して scope に応じて使う。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch {
    pub id: i64,
    pub name: String,
    /// JSON 文字列 (= scope ごとに異なるスキーマ)。
    pub conditions: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// スコープ (= 'comment-search' / 'listener-search' / ...)。
    /// migration default で旧 row は 'comment-search'。
    pub scope: String,
}

/// search_comments のクエリパラメータ。すべて任意。
///
/// 複数値フィールド (stream_ids 等) は OR で結合され、フィールド間は AND。
/// body_q / stream_title_q / name_q は空白区切りで OR 検索 (大小文字無視)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsQuery {
    /// 配信 ID (yt 動画 ID) で絞り込み (複数指定で OR)
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub stream_ids: Vec<String>,
    /// リスナー channel id (yt- prefix 任意) で絞り込み (複数指定で OR)
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub listener_channel_ids: Vec<String>,
    /// コメント種別 (chat / superchat / membership / sticker / gift) を OR 指定
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub comment_types: Vec<String>,
    /// 本文部分一致 (空白区切りの語を OR、大小文字無視)
    pub body_q: Option<String>,
    /// 配信枠タイトル部分一致 (空白区切り OR)
    pub stream_title_q: Option<String>,
    /// リスナー表示名部分一致 (空白区切り OR、display_name / nickname 両方を対象)
    pub name_q: Option<String>,
    /// 期間下限 (epoch ms 含む)
    pub period_from: Option<i64>,
    /// 期間上限 (epoch ms 含まない)
    pub period_to: Option<i64>,
    /// システム判定タグ ("first-time" / "returning" / "regular" / "veteran") を OR
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub system_tags: Vec<String>,
    /// ユーザー付与タグを OR (listener_tags テーブル参照)
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub user_tags: Vec<String>,
    /// 配信枠タグを OR (stream_tags テーブル参照)
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub stream_tags: Vec<String>,
    /// 1 ページの最大行数 (1〜500)。既定 100。
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// true なら kpi / streams を集計して返す (件数だけ欲しい場合は false で軽量化)
    #[serde(default)]
    pub include_kpi: bool,
    /// true なら listeners.is_member = 1 の listener が書いたコメントのみ。
    /// 配信詳細モーダルの「メンバー」chip 用。listeners JOIN を要求する。
    #[serde(default)]
    pub member_only: bool,
    /// リモート閲覧 redesign §5.3: 「未対応のみ」フィルタ。
    /// true なら responded_at = 0 のコメントだけを返す。
    #[serde(default)]
    pub unresponded_only: bool,
    /// コメント検索対象。既定は自チャンネルのみ。
    #[serde(default)]
    pub scope: CommentSearchScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommentSearchScope {
    #[default]
    Own,
    All,
    Other,
}

/// 全体 KPI (検索結果サマリ)。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiSummary {
    /// ヒットしたコメント総件数 (= CommentsPage.total と同じ)
    pub total_count: i64,
    /// 合計金額 (JPY 換算)
    pub total_amount_jpy: i64,
    /// ユニークリスナー数 (DISTINCT listener_channel_id)
    pub unique_listeners: i64,
    /// 該当した配信枠の数
    pub stream_count: i64,
    /// 各枠ユニークリスナー数の単純平均 (枠単位の COUNT(DISTINCT) を平均)
    pub avg_unique_listeners_per_stream: f64,
    /// 該当配信枠の合計いいね数 (streams.likes の SUM)
    pub total_likes: i64,
    /// 各枠いいね数の平均
    pub avg_likes_per_stream: f64,
    /// 該当配信枠中のピーク同接の最大値 (= 「最も盛り上がった枠の同接」)。
    /// SUM ではなく MAX を採用するのは、同接は枠を跨いで足し合わせる意味が薄く
    /// 「リーチピーク」を見せるほうが UX として自然なため。
    pub max_peak_viewers: i64,
    /// 各枠ピーク同接の平均
    pub avg_peak_viewers_per_stream: f64,
    /// ヒット範囲の最古 posted_at (ms)。0 件なら None
    pub period_from: Option<i64>,
    /// ヒット範囲の最新 posted_at (ms)。0 件なら None
    pub period_to: Option<i64>,
}

/// 配信枠ごとの KPI (アコーディオンヘッダ用)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamKpi {
    pub stream_id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub comment_count: i64,
    pub amount_jpy: i64,
    pub unique_listeners: i64,
    /// 配信枠のいいね数 (streams.likes)
    pub likes: i64,
    /// 配信枠のピーク同接 (streams.peak_concurrent_viewers, 5分以上維持の最大)
    pub peak_viewers: i64,
    /// 配信枠の所有者チャンネル ID (streams.owner_channel_id, `yt-UC...` 形式)。
    /// renderer 側で「この枠は自チャンネルか」を判定して、コメント検索結果の
    /// 「対応済み」トグル表示可否などに使う。空文字 = 古い行で未記録。
    #[serde(default)]
    pub owner_channel_id: String,
}

/// search_comments の戻り値。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsPage {
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    pub rows: Vec<CommentRow>,
    /// include_kpi=true 時のみ集計。false の時は default (total_count=0) になるので
    /// UI 側は include_kpi を見て判定する。
    #[serde(default)]
    pub kpi: KpiSummary,
    /// 配信枠ごとの KPI (started_at DESC ソート)。include_kpi=false の時は空。
    #[serde(default)]
    pub streams: Vec<StreamKpi>,
}

/// JSON Lines export の結果サマリ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub out_path: String,
    pub listener_count: i64,
    pub stream_count: i64,
    pub comment_count: i64,
    pub bytes_written: u64,
    pub schema_version: i32,
}

/// わんコメ DB エクスポート (書き戻し / Plan A) の結果サマリ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnecommeExportSummary {
    pub onecomme_dir: String,
    /// users テーブルへの新規挿入数
    pub users_new: i64,
    /// users テーブルの既存上書き数
    pub users_updated: i64,
    /// comments テーブルへの新規挿入数
    pub comments_inserted: i64,
    /// comments テーブルの重複スキップ数 (PK 衝突)
    pub comments_skipped: i64,
    /// バックアップディレクトリ (F-22)
    pub backup_dir: Option<String>,
    /// このとき書き戻した最新 posted_at (watermark に保存される値)
    pub max_posted_at: Option<i64>,
    /// 警告 (スキーマ不一致警告など。書き戻し中断時はここに理由が入る)
    pub warnings: Vec<String>,
    /// 中断したか (true なら書き戻しは行われていない)
    pub aborted: bool,
}

/// わんコメ DB の観測スナップショット (= 巻き戻し / リセット検出用)。
/// こめはぶ起動時 + export 直前に観測 + 比較し、 前回値と大きく乖離していたら
/// 「わんコメ DB が外部要因でリセット / 巻き戻された」 と判定する。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnecommeSnapshot {
    pub users_count: i64,
    pub comments_count: i64,
    /// わんコメ comments テーブルの MAX(created_at) (= ISO 8601 文字列、 空 DB なら "")。
    /// 巻き戻し検出に使う (= わんコメの内部連番 `no` は comment JSON 内なので SQL 直引きできない代替)。
    pub max_created_at: String,
    /// わんコメ DB の絶対パス (= 別 PC からの DB 入替検出用)
    pub db_path: String,
    /// 観測 unix ms (= 古いスナップショットを検出する用、 現状は表示のみ)
    pub observed_at: i64,
}

/// わんコメ DB のリセット / 巻き戻し検出シグナル。 こめはぶ側 watermark をリセットすべき状況。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OnecommeResetSignal {
    /// users テーブルが空になった (= DB 削除 → 再起動)
    Deleted {
        prev: OnecommeSnapshot,
        curr: OnecommeSnapshot,
    },
    /// max(created_at) が前回より過去に戻った (= わんコメ自体の backup 復元等)
    RolledBack {
        prev: OnecommeSnapshot,
        curr: OnecommeSnapshot,
    },
    /// comments 件数が前回の半分未満に減った (= 破損 / 入替の可能性)
    LargeDecrease {
        prev: OnecommeSnapshot,
        curr: OnecommeSnapshot,
    },
    /// わんコメ DB の path が変わった (= 別 PC からの引越し / OneDrive 同期切替等)
    PathChanged {
        prev: OnecommeSnapshot,
        curr: OnecommeSnapshot,
    },
}

/// わんコメ DB インポートの結果サマリ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnecommeImportSummary {
    pub onecomme_dir: String,
    /// listeners テーブルへの新規挿入数。
    pub listeners_new: i64,
    /// listeners テーブルの既存上書き数。
    pub listeners_updated: i64,
    /// streams テーブルへの新規挿入数。
    pub streams_new: i64,
    pub streams_updated: i64,
    /// comments テーブルへの新規挿入数 (INSERT OR IGNORE 成功)。
    pub comments_inserted: i64,
    /// comments テーブルの重複スキップ数 (PK 衝突)。
    pub comments_skipped: i64,
    /// 自チャンネル外の配信としてフィルタされたコメント数。
    pub comments_filtered_other_channel: i64,
    /// パース不能・必須フィールド欠落でスキップしたコメント数。
    pub comments_invalid: i64,
    /// 警告メッセージ (スキーマ不一致、配信 owner 不明 等)。
    pub warnings: Vec<String>,
    /// 観測したわんコメ DB スキーマハッシュ (SHA256 hex)。
    pub schema_hash: String,
    /// バックアップディレクトリ (取った場合)。
    pub backup_dir: Option<String>,
    /// `video_owner_resolver` 経由で streams の title / channel_name が補完された video_id 群。
    /// 呼び出し側 (= model_queue) はこれを使って `stream-metadata-updated` SSE を push し、
    /// 配信ログ UI を即時更新する (= 起動時 import 後に UI が古い snapshot を持つ問題への対処)。
    #[serde(default)]
    pub repaired_video_ids: Vec<String>,
}

/// リスナー詳細モーダルのフィルタ chip 用カウント。
/// 1 リスナーの「全期間 / SC / 当該枠」の正確な総数を 1 SQL で返す。
/// recent_comments は表示用に上限が掛かっているため、それから derive すると
/// 200 件 cap で頭打ちになる。chip 数は accurate な値が要るので別 query。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerChipCounts {
    /// 全期間のコメント数 (= listeners.comment_count、record_comment が累積)
    pub all: i64,
    /// SC 系の総数 (= listeners.superchat_count)
    pub sc: i64,
    /// 当該枠 (context_video_id) でのコメント数。context が無ければ 0
    pub this_stream: i64,
    /// リモート閲覧 redesign §3.1: 当該枠での「挨拶済み」状態。
    /// 0 = 未挨拶、>0 = 挨拶した時刻。context が無ければ 0
    #[serde(default)]
    pub greeted_at: i64,
}

/// 配信詳細モーダルのコメント tab フィルタ chip 用カウント。
/// 1 配信内のコメントを 5 つの軸で集計した COUNT 結果を返す。
/// JS 側は chip 表示と現在 filter のサマリに使う。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentChipCounts {
    /// この配信のコメント全件 (= streams.comment_count に近いが SELECT で再集計)
    pub all: i64,
    /// SC 系 (superchat / sticker / gift)
    pub sc: i64,
    /// listeners.is_member = 1 の listener が書いたコメ
    pub member: i64,
    /// system_tag = first-time の listener (= comment_count <= 1)
    pub first_time: i64,
    /// system_tag = veteran の listener (= first_seen_at < now - 365d)
    pub veteran: i64,
    /// リモート閲覧 redesign §5.3: 「未対応」のコメント数 (= responded_at = 0)
    #[serde(default)]
    pub unresponded: i64,
}

/// list_stream_listeners のクエリ (= 配信詳細モーダルのリスナータブ用)。
/// fields 間 AND、複数値 OR は search_comments と同じ規約。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamListenersQuery {
    /// リスナー名 LIKE (空白区切り OR、display_name / nickname / username 横断)。
    /// `text_q` が指定されている場合は無視 (= text_q が name + body の OR 検索を兼ねる)。
    pub name_q: Option<String>,
    /// 「この配信内で本文に X を含むコメントをしたリスナー」絞り込み (空白区切り OR、EXISTS subquery)。
    /// `text_q` が指定されている場合は無視。
    pub body_q: Option<String>,
    /// 横断テキスト検索 (= リスナー名 OR コメント本文 を OR で繋ぐ)。
    /// UI の単一検索 input から渡される。 name_q / body_q を別個に AND 結合すると
    /// 「名前にも本文にもキーワード」しか引かないので、 横断は別パラメータで実装。
    /// 空白区切り OR (= 各語が name OR body のいずれかにマッチで足りる)。
    /// 2026-05-14 追加。
    pub text_q: Option<String>,
    /// システム判定タグ ("first-time" / "returning" / "regular" / "veteran")
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub system_tags: Vec<String>,
    /// ユーザー付与タグ (listener_tags 経由)
    #[serde(default, deserialize_with = "deserialize_str_or_vec")]
    pub user_tags: Vec<String>,
    /// この枠で `comment_type='membership'` を残した listener のみ
    /// (= "X へようこそ！" 通知が出た = 当該枠で新規メンバー加入)。継続記念は対象外。
    #[serde(default)]
    pub member_join_only: bool,
    /// 並び替え。既定は count_desc。
    #[serde(default)]
    pub sort: StreamListenersSort,
    /// 1 ページ最大行数 (1〜2000)、既定 1000。
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // API の sort 値として降順を明示するため Desc suffix を維持する。
pub enum StreamListenersSort {
    /// この配信内のコメント数降順 (既定)。
    #[default]
    CountDesc,
    /// この配信内のスパチャ JPY 降順。
    ScAmountDesc,
    /// 最終コメント時刻降順 (枠内で最後にしゃべったリスナー)。
    LastAtDesc,
}

/// 1 つの heatmap セル (= 配信時間を 14 等分した 1 bin)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapBin {
    pub count: u32,
    pub has_sc: bool,
}

/// list_stream_listeners の 1 行。1 リスナー × 1 配信枠。
/// `listener` は意図的にネストして残す (= JS 側で `row.listener.channelId` のように
/// アクセスする想定)。flatten すると ListenerRow の全フィールドが直に並んで
/// per_stream_* と区別が付かなくなり、UI 側で扱いづらくなる。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamListenerRow {
    pub listener: ListenerRow,
    /// この配信内のコメント数。
    pub per_stream_comment_count: i64,
    /// この配信内のスパチャ JPY 合計。
    pub per_stream_sc_amount_jpy: i64,
    /// この配信内で初めてコメントした時刻 (ms)。
    pub per_stream_first_at: i64,
    /// この配信内で最後にコメントした時刻 (ms)。
    pub per_stream_last_at: i64,
    /// 配信時間を 14 等分した bin ごとの活動 heatmap。
    pub heatmap_bins: Vec<HeatmapBin>,
    /// このリスナーに付いている user tag (listener_tags の tag 列)。
    pub user_tags: Vec<String>,
    /// この配信枠で `comment_type='membership'` を残したか
    /// (= "X へようこそ！" 通知が出た = この枠で新規メンバー加入)。
    /// stream-detail-modal リスナータブで「メンバー加入」システムタグを出すのに使う。
    /// `comment_type='membership_milestone'` (= 継続記念) は含まない。
    pub per_stream_member_joined: bool,
    /// 「直近 N 配信 (現在配信を除く) 中 M 配信以上でコメントしたか」
    /// (= ListenerClassificationConfig の regular_stream_window / regular_min_streams で判定)。
    /// JS 側 computeSystemTag が「常連 / 古参」と「復帰」を区別するために参照する。
    /// false かつ first_seen_at が古い = 「復帰」。
    #[serde(default)]
    pub is_active: bool,
    /// リスナーランク (= 5 分類 + 新規 + 空文字)。Rust core が `first_seen_at` /
    /// `is_active` / 対象配信の `started_at` から計算済の値を返す。JS 側はこの値を
    /// そのまま使い、判定ロジックは書かない (= 仕様の Single Source of Truth は Rust)。
    /// 値:
    /// - `'first-time'`: この枠で初コメ (= first_seen_at >= 対象配信 started_at)
    /// - `'returning'`: 新参 (= first_seen_at < started_at AND first_seen_at >= baseline - X日)
    /// - `'regular'`: 常連 (= baseline - Y日 <= first_seen_at < baseline - X日 AND active)
    /// - `'veteran'`: 古参 (= first_seen_at < baseline - Y日 AND active)
    /// - `'comeback'`: 復帰 (= first_seen_at < baseline - X日 AND NOT active)
    /// - `''`: 判定不能 (= first_seen_at = 0 等の異常データ)
    #[serde(default)]
    pub system_tag: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamListenersPage {
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    pub rows: Vec<StreamListenerRow>,
}

/// get_stream_stats の戻り値。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStats {
    /// コメント頻度時系列 (= bin_minutes 刻み)。
    pub comment_freq_bins: Vec<TimeBin>,
    /// 各 bin 末時点での累積ユニークコメント者数 (= 何人増えたか)。
    pub cumulative_unique_bins: Vec<u32>,
    /// 配信時間範囲内のリスナー構成 (= 配信中にコメントしたリスナーの system_tag 別カウント)。
    pub composition: StreamStatsComposition,
    /// 頻出語 top N (= 既定 10)。テキスト本文のみ、絵文字 / カスタムスタンプ / stopword 除去済み。
    pub top_words: Vec<WordCount>,
    /// その他数値統計。
    pub misc: StreamStatsMisc,
    /// 集計に使った bin 幅 (分)。UI の x 軸ラベル用。
    pub bin_minutes: i64,
    /// 配信開始時刻 (ms)。
    pub started_at: i64,
    /// 配信終了時刻 (ms)、配信中は 0。
    pub ended_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBin {
    /// この bin の開始時刻 (ms、started_at + index * bin_minutes * 60_000)。
    pub bin_start_ms: i64,
    /// この bin 内のコメント件数。
    pub count: u32,
    /// この bin が最大件数 bin のとき true (= UI の peak ハイライト用)。
    pub has_peak: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatsComposition {
    pub first_time: u32,
    pub returning: u32,
    pub regular: u32,
    pub veteran: u32,
    /// 復帰: 初コメから X 日以上経過しているが、直近 N 枠中 M 枠未満 (= 常連 / 古参 候補だが活動なし)
    #[serde(default)]
    pub comeback: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCount {
    pub word: String,
    pub count: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatsMisc {
    /// コメント間隔の平均 (秒)。
    pub avg_comment_interval_sec: f64,
    /// コメント本文の平均文字数。
    pub avg_comment_length_chars: f64,
    /// この配信中の membership 種別コメント数 (= わんコメで言うメンバー加入)。
    pub member_joins: i64,
    /// この配信が「初コメ」になったリスナー数 (= listeners.first_seen_at が配信時間内)。
    pub new_listeners: i64,
}

/// JSON Lines import の結果サマリ。
/// listener / stream は新規挿入と既存上書きを区別 (冪等性の表示と整合)。
/// comment は INSERT OR IGNORE なので新規のみで重複は skipped。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub src_path: String,
    pub listeners_new: i64,
    pub listeners_updated: i64,
    pub streams_new: i64,
    pub streams_updated: i64,
    pub comments_inserted: i64,
    pub comments_skipped: i64,
    pub warnings: Vec<String>,
    pub schema_version: Option<i32>,
}
