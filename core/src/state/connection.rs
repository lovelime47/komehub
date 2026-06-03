use serde::Serialize;

/// 現在の YouTube Live 接続状態を表す。
///
/// # 設計原則: shared_memory layout との完全同期
///
/// 本 struct の **全フィールド** は `shared_memory.rs` の Connection layout
/// (`CONNECTION_*_OFFSET` 定数群と `ConnectionSharedBuffer::publish` /
/// `decode_connection_state_snapshot`) と **1:1 で同期** する設計。
///
/// ## なぜ全フィールド同期が必要か
///
/// `ModelQueue` は static update を SSE channel と shared_memory の **両経路** に publish する
/// (= `model_queue.rs::push_connection_status`)。しかし `napi_bridge::runtime_events_from_sse`
/// は SSE 通知を受けた後に **shared_memory snapshot を再読込** して RuntimeEvent を構築する
/// (docs/architecture/shared-memory.md L92)。そのため struct と layout が乖離していると、
/// SSE message data に乗っている値でも napi 経路 (= main.js → renderer) では **読み捨てられる**。
///
/// ## アンチパターン (= 2026-05-09 isOwnStream 事例)
///
/// 派生値 (= `configured ∋ owner` で計算する `is_own_stream` 等) を struct field 化せず、
/// `push_static_update` の data 引数の JSON Map に直接 `obj.insert("isOwnStream", ...)` で
/// 注入するパッチワーク的実装。HTTP SSE 経路 (= /api/stream → remote) では届いたが、
/// napi 経路では shared_memory snapshot で上書きされて消失し、本体 renderer に届かなかった。
/// 「`push_static_update` の data に何でも乗せられる」と誤認した結果、設計原則
/// 「shared_memory が正本」を実装が破っていた。
///
/// ## フィールド追加時の手順
///
/// 1. 本 struct に `pub` field 追加 (`#[serde(rename_all = "camelCase")]` で自動 camelCase 化)
/// 2. `shared_memory.rs` の Connection layout 定数 (`CONNECTION_OFFSET_*`,
///    `CONNECTION_BUFFER_STRIDE_BYTES`) を更新し、`CONNECTION_STATE_LAYOUT_ID` を bump
/// 3. `ConnectionSharedBuffer::publish` で write、`decode_connection_state_snapshot` で read
/// 4. `publishes_connection_state_as_fixed_snapshot` テストに新フィールドの assertion 追加
///
/// 上記 4 点を **同時に** 行うこと。1 つでも欠けると napi 経路で派生値が剥がれるバグが再発する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionState {
    pub connected: bool,
    pub video_id: Option<String>,
    /// PT-1b: 現在視聴中の配信の owner channel id (UC...)。
    /// Step 3 リスナー管理の自チャンネル判定に使う。video_id と一致する場合のみ有効。
    pub current_stream_owner_channel_id: Option<String>,
    /// remote-viewing redesign §5.3: 現在接続中の配信が自チャンネル枠かどうか。
    /// `configured_owner_channel_ids` ∋ `current_stream_owner_channel_id` で計算される派生値。
    /// 派生値だが struct field として持つ理由は本 struct doc 参照
    /// (= shared_memory layout 同期で SSE/napi 両経路に届ける必要があるため)。
    /// 計算は `ModelQueue::is_current_stream_own` が担当し、`push_connection_status` 呼出時に再計算する。
    pub is_own_stream: bool,
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionState {
    pub fn new() -> Self {
        Self {
            connected: false,
            video_id: None,
            current_stream_owner_channel_id: None,
            is_own_stream: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_has_no_owner_channel() {
        let s = ConnectionState::new();
        assert!(!s.connected);
        assert!(s.video_id.is_none());
        assert!(s.current_stream_owner_channel_id.is_none());
        assert!(!s.is_own_stream);
    }

    #[test]
    fn serializes_owner_channel_id_as_camel_case() {
        let mut s = ConnectionState::new();
        s.connected = true;
        s.video_id = Some("abc123".into());
        s.current_stream_owner_channel_id = Some("UCxxxx".into());
        s.is_own_stream = true;
        let json = serde_json::to_value(&s).unwrap();
        // PT-1b: API 公開フィールド名が camelCase になることを保証
        assert_eq!(json["currentStreamOwnerChannelId"], "UCxxxx");
        assert_eq!(json["videoId"], "abc123");
        assert_eq!(json["connected"], true);
        // remote-viewing redesign §5.3: 派生値 is_own_stream も camelCase で公開
        assert_eq!(json["isOwnStream"], true);
    }
}
