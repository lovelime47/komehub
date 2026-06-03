use super::*;

impl ModelQueue {
    pub(super) fn handle_get_owner_channels(
        &mut self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        let response = match self.engines.listener_manager.as_ref() {
            Some(mgr) => match mgr.get_owner_channels() {
                Ok(channels) => serde_json::json!({ "ownerChannels": channels }),
                Err(err) => {
                    tracing::warn!("get_owner_channels failed: {}", err);
                    serde_json::json!({ "ownerChannels": [], "error": err.to_string() })
                }
            },
            None => serde_json::json!({ "ownerChannels": [] }),
        };
        let _ = reply.send(response);
    }

    pub(super) fn handle_set_owner_channels(
        &mut self,
        channels: Vec<crate::state::listener::OwnerChannel>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
        sse: &Arc<SseBroadcaster>,
    ) {
        use crate::state::listener::OwnerChannel;

        // 各要素を trim、空除去、フォーマット検証 (UC で始まる ASCII)。
        // 重複は channel_id ベースで除去、不正値があれば全体を拒否。
        let mut cleaned: Vec<OwnerChannel> = Vec::with_capacity(channels.len());
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut invalid: Option<String> = None;
        for ch in &channels {
            let id = ch.channel_id.trim();
            if id.is_empty() {
                continue;
            }
            if !is_valid_owner_channel_id(id) {
                invalid = Some(id.to_string());
                break;
            }
            if seen.insert(id.to_string()) {
                let handle = ch
                    .handle
                    .as_deref()
                    .map(|s| s.trim().trim_start_matches('@').to_string())
                    .filter(|s| !s.is_empty());
                cleaned.push(OwnerChannel {
                    channel_id: id.to_string(),
                    handle,
                });
            }
        }
        if let Some(bad) = invalid {
            let _ = reply.send(serde_json::json!({
                    "ok": false,
                    "error": format!("Invalid YouTube channel id (must match ^UC[A-Za-z0-9_-]+$): {}", bad),
                }));
            return;
        }
        let response = match self.engines.listener_manager.as_ref() {
            Some(mgr) => match mgr.set_owner_channels(&cleaned) {
                Ok(()) => {
                    self.main_store.configured_owner_channel_ids =
                        cleaned.iter().map(|c| c.channel_id.clone()).collect();
                    sse.push_static_update(
                        "configuredOwnerChannels",
                        &serde_json::json!({ "ownerChannels": cleaned }),
                    );
                    // configured が変わると isOwnStream の判定結果も変わる可能性があるので
                    // connection state を再 push する (= 本体・remote の挨拶 / 対応トグル
                    // 表示が即座に切替わる)。
                    Self::push_connection_status(&mut self.main_store, sse);
                    serde_json::json!({ "ok": true, "ownerChannels": cleaned })
                }
                Err(err) => {
                    tracing::warn!("set_owner_channels failed: {}", err);
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                }
            },
            None => serde_json::json!({
                "ok": false,
                "error": "listener_manager is unavailable (open failed at startup)",
            }),
        };
        let _ = reply.send(response);
    }
}
