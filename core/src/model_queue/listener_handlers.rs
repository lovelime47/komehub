use super::*;

impl ModelQueue {
    pub(super) fn handle_listener_command(
        &mut self,
        cmd: ListenerCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            ListenerCommand::GetOwnerChannels { reply } => {
                self.handle_get_owner_channels(reply);
            }
            ListenerCommand::IsListenerDbDirty { reply } => {
                let dirty = self
                    .engines
                    .listener_manager
                    .as_ref()
                    .map(|mgr| mgr.is_data_dirty())
                    .unwrap_or(false);
                let _ = reply.send(serde_json::json!({ "ok": true, "dirty": dirty }));
            }
            ListenerCommand::SetOwnerChannels { channels, reply } => {
                self.handle_set_owner_channels(channels, reply, sse);
            }
            ListenerCommand::GetListeners { query, reply } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_listeners(&query) {
                        Ok(mut page) => {
                            // 2026-05-09 仕様変更: hide_from_listeners=true の listener は
                            // リスナーリストに表示しない。internal の DB / 集計には残す。
                            let hidden: std::collections::HashSet<String> = self
                                .app_config
                                .hidden_listeners
                                .iter()
                                .filter(|u| u.hide_from_listeners)
                                .map(|u| u.id.trim_start_matches("yt-").to_string())
                                .collect();
                            if !hidden.is_empty() {
                                page.rows.retain(|row| {
                                    let id = row.channel_id.trim_start_matches("yt-");
                                    !hidden.contains(id)
                                });
                            }
                            serde_json::json!({ "ok": true, "page": page })
                        }
                        Err(err) => {
                            tracing::warn!("list_listeners failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetListenersActivity { query, reply } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_listeners_activity(&query) {
                        Ok((activities, streams)) => {
                            serde_json::json!({
                                "ok": true,
                                "activities": activities,
                                "streams": streams,
                            })
                        }
                        Err(err) => {
                            tracing::warn!("list_listeners_activity failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetListenerDetail {
                channel_id,
                recent_comment_limit,
                stream_video_id,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.get_listener_detail(
                        &channel_id,
                        recent_comment_limit,
                        stream_video_id.as_deref(),
                    ) {
                        Ok(Some(mut detail)) => {
                            // 2026-05-09 仕様変更: hidden_listeners は app_config 側にあるので
                            // listener_manager の戻り値に join して埋める。
                            // id は yt- prefix 付き / なし両方ありうるので両方比較。
                            let listener_id = detail.listener.channel_id.as_str();
                            let listener_id_stripped = listener_id.trim_start_matches("yt-");
                            if let Some(rec) =
                                self.app_config.hidden_listeners.iter().find(|u| {
                                    u.id.trim_start_matches("yt-") == listener_id_stripped
                                })
                            {
                                detail.hide_from_comments = rec.hide_from_comments;
                                detail.hide_from_listeners = rec.hide_from_listeners;
                            }
                            serde_json::json!({ "ok": true, "detail": detail })
                        }
                        Ok(None) => serde_json::json!({ "ok": true, "detail": null }),
                        Err(err) => {
                            tracing::warn!("get_listener_detail failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::UpdateStreamMetadata {
                video_id,
                stream_url,
                title,
                owner_channel_id,
                channel_name,
                channel_icon_url,
                description,
                subscriber_count,
                current_viewers,
                peak_concurrent_viewers,
                likes,
                started_at,
                ended_at,
                live_metadata_updated_at,
                reply,
            } => {
                // 通知テンプレ {streamTitle} で参照する用、 現接続枠 + 非空 title なら
                // live_stream_stats.stream_title を更新する。 DB 書き込み許可判定とは独立 (=
                // owner 不明枠でも title だけは renderer / 通知で使うため)。
                if let Some(t) = title.as_deref() {
                    if !t.is_empty()
                        && self
                            .main_store
                            .connection
                            .video_id
                            .as_deref()
                            .map(|v| v == video_id)
                            .unwrap_or(false)
                    {
                        self.main_session.live_stream_stats.stream_title = t.to_string();
                    }
                }
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => {
                        // B 方針: 他チャンネル配信も配信ログの管理対象なので、owner が
                        // 確定しているメタデータは DB に永続化する。
                        //
                        // 判定:
                        //   1. configured が空 → フィルタ無効 (テスト / dev モード扱いで素通し)
                        //   2. passed-in owner_channel_id が非空 → OK (自枠 / 他枠とも保存)
                        //   3. passed-in owner が unknown / 空文字 → 既存行があれば OK
                        //      (= コメント記録で作成済みの他枠 stream に後続 metadata を反映)
                        //      既存行も無ければ skip (= owner 不明 stub の新規作成を防ぐ)
                        let configured = &self.main_store.configured_owner_channel_ids;
                        let passed_owner_yt = owner_channel_id.as_deref().map(|s| {
                            if s.is_empty() || s.starts_with("yt-") {
                                s.to_string()
                            } else {
                                format!("yt-{}", s)
                            }
                        });
                        let allow = if configured.is_empty() {
                            true
                        } else if passed_owner_yt.as_ref().is_some_and(|s| !s.is_empty()) {
                            true
                        } else {
                            // owner 未指定 (endedAt 更新など) → 既存行がある場合だけ更新
                            match mgr.lookup_stream_owner(&video_id) {
                                Ok(Some(_existing)) => true,
                                Ok(None) => false, // 既存行なし or owner 空 → 新規 stub を作らない
                                Err(_) => false,
                            }
                        };
                        if !allow {
                            tracing::debug!(
                                "Skipping update_stream_metadata persistence (unknown stream owner: video={}, owner={:?})",
                                video_id,
                                owner_channel_id
                            );
                            // owner 不明かつ既存 stream 行も無い場合は listeners.db への
                            // 書き込みは行わないが、UI 用の SSE 通知だけ発行する。
                            //
                            // partial update セマンティクス:
                            // 動的更新 (= isInitial=false の poll) では title / icon 等の
                            // 静的フィールドが None で渡る。「指定されたフィールドだけ
                            // payload に含める」形にして、未指定は renderer で既存表示を
                            // 維持できるようにする (= listener_manager の COALESCE 経路と同等)。
                            // ephemeral: true で「DB 永続化されていない」を明示。
                            let mut ephemeral = serde_json::Map::new();
                            ephemeral.insert(
                                "videoId".into(),
                                serde_json::Value::String(video_id.clone()),
                            );
                            ephemeral.insert("ephemeral".into(), serde_json::Value::Bool(true));
                            fn put_str(
                                m: &mut serde_json::Map<String, serde_json::Value>,
                                k: &str,
                                v: &Option<String>,
                            ) {
                                if let Some(s) = v.as_deref() {
                                    if !s.is_empty() {
                                        m.insert(
                                            k.into(),
                                            serde_json::Value::String(s.to_string()),
                                        );
                                    }
                                }
                            }
                            fn put_i64(
                                m: &mut serde_json::Map<String, serde_json::Value>,
                                k: &str,
                                v: Option<i64>,
                            ) {
                                if let Some(n) = v {
                                    m.insert(k.into(), serde_json::Value::Number(n.into()));
                                }
                            }
                            put_str(&mut ephemeral, "ownerChannelId", &owner_channel_id);
                            put_str(&mut ephemeral, "title", &title);
                            put_str(&mut ephemeral, "streamUrl", &stream_url);
                            put_str(&mut ephemeral, "channelName", &channel_name);
                            put_str(&mut ephemeral, "channelIconUrl", &channel_icon_url);
                            put_str(&mut ephemeral, "description", &description);
                            put_i64(&mut ephemeral, "subscriberCount", subscriber_count);
                            put_i64(&mut ephemeral, "currentViewers", current_viewers);
                            put_i64(
                                &mut ephemeral,
                                "peakConcurrentViewers",
                                peak_concurrent_viewers,
                            );
                            put_i64(&mut ephemeral, "likes", likes);
                            put_i64(&mut ephemeral, "startedAt", started_at);
                            put_i64(&mut ephemeral, "endedAt", ended_at);
                            put_i64(
                                &mut ephemeral,
                                "liveMetadataUpdatedAt",
                                live_metadata_updated_at,
                            );
                            // 他枠で DB に行かない代わりの in-memory live 集計 (= MainSession.live_stream_stats)。
                            // 自枠は path 2 (= detail.stream) で DB 値を載せるのでここには来ない。
                            let stats = &self.main_session.live_stream_stats;
                            if stats.video_id == video_id {
                                ephemeral.insert(
                                    "commentCount".into(),
                                    serde_json::Value::Number(stats.comment_count.into()),
                                );
                                ephemeral.insert(
                                    "superchatAmountJpy".into(),
                                    serde_json::Value::Number(stats.superchat_amount_jpy.into()),
                                );
                            }
                            sse.push_static_update(
                                "stream-metadata-updated",
                                &serde_json::Value::Object(ephemeral),
                            );
                            let _ = reply.send(serde_json::json!({
                                    "ok": true, "updated": 0, "skipped": "unknown-stream-owner", "ephemeral": true
                                }));
                            return true;
                        }
                        match mgr.update_stream_metadata(
                            &video_id,
                            stream_url.as_deref(),
                            title.as_deref(),
                            owner_channel_id.as_deref(),
                            channel_name.as_deref(),
                            channel_icon_url.as_deref(),
                            description.as_deref(),
                            subscriber_count,
                            current_viewers,
                            peak_concurrent_viewers,
                            likes,
                            started_at,
                            ended_at,
                            live_metadata_updated_at,
                        ) {
                            Ok(n) => {
                                // 更新後の最新値を一度引いて SSE で push する。
                                // 動的更新 (current_viewers / likes) を renderer に
                                // リアルタイム反映させるための push。
                                if let Ok(Some(detail)) = mgr.get_stream_detail(&video_id, 0) {
                                    sse.push_static_update(
                                        "stream-metadata-updated",
                                        &detail.stream,
                                    );
                                }
                                serde_json::json!({ "ok": true, "updated": n })
                            }
                            Err(err) => {
                                tracing::warn!("update_stream_metadata failed: {}", err);
                                serde_json::json!({ "ok": false, "error": err.to_string() })
                            }
                        }
                    }
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::UpdateListenerMetadata {
                channel_id,
                nickname,
                notes,
                label,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.update_listener_metadata(
                        &channel_id,
                        nickname.as_deref(),
                        notes.as_deref(),
                        label.as_deref(),
                    ) {
                        Ok(n) => serde_json::json!({ "ok": true, "updated": n }),
                        Err(err) => {
                            tracing::warn!("update_listener_metadata failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::SetListenerGreeted {
                stream_video_id,
                listener_channel_id,
                value,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.set_listener_greeted(
                        &stream_video_id,
                        &listener_channel_id,
                        value,
                    ) {
                        Ok(greeted_at) => {
                            // SSE で本体・remote 双方の UI が同期できるように通知
                            sse.push_static_update(
                                "listener-greeted",
                                &serde_json::json!({
                                    "streamVideoId": stream_video_id,
                                    "listenerChannelId": listener_channel_id,
                                    "greetedAt": greeted_at,
                                }),
                            );
                            serde_json::json!({ "ok": true, "greetedAt": greeted_at })
                        }
                        Err(err) => {
                            tracing::warn!("set_listener_greeted failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::SetListenerHidden {
                listener_channel_id,
                hide_from_comments,
                hide_from_listeners,
                reply,
            } => {
                // 2026-05-09 仕様変更: 旧 SetListenerBanned (= 単一 BAN 概念) を
                // 「コメ非表示」「リスナー非表示」の 2 軸独立に変更。両方 false なら
                // record 自体を削除する (= ノイズ回避)。
                let raw_id = listener_channel_id.trim_start_matches("yt-");
                let mut display_name = raw_id.to_string();
                let mut profile_image = String::new();
                if let Some(mgr) = self.engines.listener_manager.as_ref() {
                    if let Ok(Some(detail)) = mgr.get_listener_detail(raw_id, 1, None) {
                        display_name = if !detail.listener.nickname.is_empty() {
                            detail.listener.nickname.clone()
                        } else if !detail.listener.display_name.is_empty() {
                            detail.listener.display_name.clone()
                        } else {
                            raw_id.to_string()
                        };
                        profile_image = detail.listener.icon_url.clone().unwrap_or_default();
                    }
                }
                // 現在の hidden_listeners をベースに 2 軸独立で書き換え
                let mut next: Vec<HiddenListenerRecord> = self.app_config.hidden_listeners.clone();
                next.retain(|u| u.id != raw_id);
                if hide_from_comments || hide_from_listeners {
                    next.push(HiddenListenerRecord {
                        id: raw_id.to_string(),
                        name: display_name,
                        profile_image,
                        hide_from_comments,
                        hide_from_listeners,
                    });
                }
                self.app_config.hidden_listeners = next.clone();
                self.save_app_config();
                // /api/comments filter 用の snapshot を最新化
                sse.set_hidden_for_comments(
                    next.iter()
                        .filter(|u| u.hide_from_comments)
                        .map(|u| u.id.trim_start_matches("yt-").to_string())
                        .collect(),
                );
                sse.push_static_update(
                    "listener-hidden",
                    &serde_json::json!({
                        "listenerChannelId": raw_id,
                        "hideFromComments": hide_from_comments,
                        "hideFromListeners": hide_from_listeners,
                    }),
                );
                let _ = reply.send(serde_json::json!({
                    "ok": true,
                    "hideFromComments": hide_from_comments,
                    "hideFromListeners": hide_from_listeners,
                }));
            }
            ListenerCommand::SetCommentResponded {
                comment_id,
                value,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.set_comment_responded(&comment_id, value) {
                        Ok(responded_at) => {
                            // /api/comments (= recent_events cache) もリロード時に
                            // 最新の対応済み状態を返せるよう in-place 更新する
                            sse.update_comment_responded(&comment_id, responded_at);
                            sse.push_static_update(
                                "comment-responded",
                                &serde_json::json!({
                                    "commentId": comment_id,
                                    "respondedAt": responded_at,
                                }),
                            );
                            if value && responded_at > 0 {
                                if let Ok(Some((stream_video_id, listener_channel_id))) =
                                    mgr.get_comment_stream_listener(&comment_id)
                                {
                                    sse.push_static_update(
                                        "listener-greeted",
                                        &serde_json::json!({
                                            "streamVideoId": stream_video_id,
                                            "listenerChannelId": listener_channel_id,
                                            "greetedAt": responded_at,
                                        }),
                                    );
                                }
                            }
                            serde_json::json!({ "ok": true, "respondedAt": responded_at })
                        }
                        Err(err) => {
                            tracing::warn!("set_comment_responded failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::DeleteListeners { channel_ids, reply } => {
                // media_cache_dir はアバター画像ファイル削除に使う
                // (= listeners.icon_url の cache URL に対応するファイルを消す)。
                let media_cache_dir = self.engines.media_cache_dir.clone();
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => {
                        match mgr.delete_listeners(&channel_ids, media_cache_dir.as_deref()) {
                            Ok(summaries) => {
                                // SSE で UI に通知して一覧を再描画させる
                                sse.push_static_update(
                                    "listener-updated",
                                    &serde_json::json!({
                                        "deleted": true,
                                        "channelIds": channel_ids,
                                    }),
                                );
                                serde_json::json!({ "ok": true, "summaries": summaries })
                            }
                            Err(err) => {
                                tracing::warn!("delete_listeners failed: {}", err);
                                serde_json::json!({ "ok": false, "error": err.to_string() })
                            }
                        }
                    }
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::DeleteStreams { video_ids, reply } => {
                let media_cache_dir = self.engines.media_cache_dir.clone();
                let current_video_id = self
                    .main_store
                    .connection
                    .video_id
                    .as_deref()
                    .filter(|_| self.main_store.connection.connected);
                if let Some(current) = current_video_id {
                    if video_ids.iter().any(|id| id == current) {
                        let _ = reply.send(serde_json::json!({
                            "ok": false,
                            "error": "connected stream cannot be deleted",
                            "code": "connected-stream",
                            "videoId": current,
                        }));
                        return true;
                    }
                }
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.delete_streams(&video_ids, media_cache_dir.as_deref()) {
                        Ok(summaries) => {
                            sse.push_static_update(
                                "listener-updated",
                                &serde_json::json!({
                                    "streamsDeleted": true,
                                    "videoIds": video_ids,
                                }),
                            );
                            serde_json::json!({ "ok": true, "summaries": summaries })
                        }
                        Err(err) => {
                            tracing::warn!("delete_streams failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetStreams { query, reply } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_streams(&query) {
                        Ok(page) => serde_json::json!({ "ok": true, "page": page }),
                        Err(err) => {
                            tracing::warn!("list_streams failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetStreamDetail {
                video_id,
                recent_comment_limit,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.get_stream_detail(&video_id, recent_comment_limit) {
                        Ok(Some(detail)) => serde_json::json!({ "ok": true, "detail": detail }),
                        Ok(None) => serde_json::json!({ "ok": true, "detail": null }),
                        Err(err) => {
                            tracing::warn!("get_stream_detail failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::SearchComments { query, reply } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.search_comments(&query) {
                        Ok(page) => serde_json::json!({ "ok": true, "page": page }),
                        Err(err) => {
                            tracing::warn!("search_comments failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::ListStreamListeners {
                video_id,
                query,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_stream_listeners(&video_id, &query) {
                        Ok(page) => serde_json::json!({ "ok": true, "page": page }),
                        Err(err) => {
                            tracing::warn!("list_stream_listeners failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetStreamStats {
                video_id,
                bin_minutes,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.get_stream_stats(&video_id, bin_minutes) {
                        Ok(Some(stats)) => serde_json::json!({ "ok": true, "stats": stats }),
                        Ok(None) => serde_json::json!({ "ok": true, "stats": null }),
                        Err(err) => {
                            tracing::warn!("get_stream_stats failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetCommentChipCounts { video_id, reply } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.get_comment_chip_counts(&video_id) {
                        Ok(counts) => serde_json::json!({ "ok": true, "counts": counts }),
                        Err(err) => {
                            tracing::warn!("get_comment_chip_counts failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetListenerChipCounts {
                channel_id,
                context_video_id,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.get_listener_chip_counts(&channel_id, &context_video_id)
                    {
                        Ok(counts) => serde_json::json!({ "ok": true, "counts": counts }),
                        Err(err) => {
                            tracing::warn!("get_listener_chip_counts failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::ListListenerSuperchats {
                channel_id,
                limit,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_listener_superchats(&channel_id, limit) {
                        Ok(comments) => serde_json::json!({ "ok": true, "comments": comments }),
                        Err(err) => {
                            tracing::warn!("list_listener_superchats failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::ListListenerCommentsInStream {
                channel_id,
                stream_video_id,
                limit,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_listener_comments_in_stream(
                        &channel_id,
                        &stream_video_id,
                        limit,
                    ) {
                        Ok(comments) => serde_json::json!({ "ok": true, "comments": comments }),
                        Err(err) => {
                            tracing::warn!("list_listener_comments_in_stream failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetListenerSearchRankCounts {
                baseline_video_id,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.list_listener_search_rank_counts(&baseline_video_id) {
                        Ok(counts) => serde_json::json!({ "ok": true, "counts": counts }),
                        Err(err) => {
                            tracing::warn!("list_listener_search_rank_counts failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetStreamScopedListenerCounts {
                stream_video_id,
                q,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr
                        .list_stream_scoped_listener_counts(&stream_video_id, q.as_deref())
                    {
                        Ok(counts) => serde_json::json!({ "ok": true, "counts": counts }),
                        Err(err) => {
                            tracing::warn!("list_stream_scoped_listener_counts failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetStreamListenerPillCounts {
                video_id,
                name_q,
                body_q,
                text_q,
                user_tags,
                reply,
            } => {
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => {
                        let query = crate::state::listener::StreamListenerPillCountsQuery {
                            name_q,
                            body_q,
                            text_q,
                            user_tags,
                        };
                        match mgr.list_stream_listener_pill_counts(&video_id, &query) {
                            Ok(counts) => serde_json::json!({ "ok": true, "counts": counts }),
                            Err(err) => {
                                tracing::warn!(
                                    "list_stream_listener_pill_counts failed: {}",
                                    err
                                );
                                serde_json::json!({ "ok": false, "error": err.to_string() })
                            }
                        }
                    }
                    None => serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                };
                let _ = reply.send(response);
            }
            ListenerCommand::GetListenerTags { channel_id, reply } => {
                self.handle_get_listener_tags(channel_id, reply);
            }
            ListenerCommand::SetListenerTags {
                channel_id,
                tags,
                reply,
            } => {
                self.handle_set_listener_tags(channel_id, tags, reply);
            }
            ListenerCommand::ListAllListenerTags { reply } => {
                self.handle_list_all_listener_tags(reply);
            }
            ListenerCommand::ListAllListenerTagAssignments { reply } => {
                self.handle_list_all_listener_tag_assignments(reply);
            }
            ListenerCommand::GetStreamTags { video_id, reply } => {
                self.handle_get_stream_tags(video_id, reply);
            }
            ListenerCommand::SetStreamTags {
                video_id,
                tags,
                reply,
            } => {
                self.handle_set_stream_tags(video_id, tags, reply);
            }
            ListenerCommand::ListAllStreamTags { reply } => {
                self.handle_list_all_stream_tags(reply);
            }
            ListenerCommand::ListAllStreamTagAssignments { reply } => {
                self.handle_list_all_stream_tag_assignments(reply);
            }
            ListenerCommand::RenameStreamTag {
                old_name,
                new_name,
                reply,
            } => {
                self.handle_rename_stream_tag(old_name, new_name, reply);
            }
            ListenerCommand::DeleteStreamTag { name, reply } => {
                self.handle_delete_stream_tag(name, reply);
            }
            ListenerCommand::RenameListenerTag {
                old_name,
                new_name,
                reply,
            } => {
                self.handle_rename_listener_tag(old_name, new_name, reply);
            }
            ListenerCommand::DeleteListenerTag { name, reply } => {
                self.handle_delete_listener_tag(name, reply);
            }
            ListenerCommand::ListSavedSearches { scope, reply } => {
                self.handle_list_saved_searches(scope, reply);
            }
            ListenerCommand::CreateSavedSearch {
                scope,
                name,
                conditions_json,
                reply,
            } => {
                self.handle_create_saved_search(scope, name, conditions_json, reply);
            }
            ListenerCommand::UpdateSavedSearch {
                id,
                name,
                conditions_json,
                sort_order,
                reply,
            } => {
                self.handle_update_saved_search(id, name, conditions_json, sort_order, reply);
            }
            ListenerCommand::DeleteSavedSearch { id, reply } => {
                self.handle_delete_saved_search(id, reply);
            }
            ListenerCommand::ExportKomehubJsonl { out_path, reply } => {
                self.handle_export_komehub_jsonl(out_path, reply);
            }
            ListenerCommand::ImportKomehubJsonl { src_path, reply } => {
                self.handle_import_komehub_jsonl(src_path, reply);
            }
            ListenerCommand::ImportFromOnecomme {
                onecomme_dir,
                reply,
            } => {
                self.handle_import_from_onecomme(onecomme_dir, reply, sse);
            }
            ListenerCommand::ExportToOnecomme {
                onecomme_dir,
                reply,
            } => {
                if !self.handle_export_to_onecomme(onecomme_dir, reply, sse) {
                    return true;
                }
            }
            ListenerCommand::DetectOnecommeRunning { reply } => {
                self.handle_detect_onecomme_running(reply);
            }
            ListenerCommand::RunBidirectionalSync {
                onecomme_dir,
                reply,
            } => {
                if !self.handle_run_bidirectional_sync(onecomme_dir, reply, sse) {
                    return true;
                }
            }
            ListenerCommand::ResetOnecommeWatermarks {
                onecomme_dir,
                reply,
            } => {
                // 検出済の watermark ズレを user 確認後にクリアする経路。
                // listener_manager で 2 つの watermark (= 取り込み + 書き戻し) を DELETE し、
                // 新しい観測値をスナップショットとして保存。 data_dirty=true に立てるので
                // 次回 close で全件書き戻しが走る。
                let response = match self.engines.listener_manager.as_ref() {
                    Some(mgr) => match mgr.reset_onecomme_watermarks(Path::new(&onecomme_dir)) {
                        Ok(()) => serde_json::json!({ "ok": true }),
                        Err(err) => {
                            tracing::warn!("reset_onecomme_watermarks failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                    },
                    None => {
                        serde_json::json!({ "ok": false, "error": "listener_manager unavailable" })
                    }
                };
                let _ = reply.send(response);
            }
            ListenerCommand::SendTemplateTestComment {
                scene_id,
                context,
                reply,
            } => {
                let ok =
                    self.main_store.scenes.active_scene_id.as_deref() == Some(scene_id.as_str());
                if ok {
                    let comment = build_test_comment_from_context(&context);
                    self.handle_incoming_comments(vec![comment], sse);
                }
                let _ = reply.send(serde_json::json!({ "ok": ok }));
            }
        }
        true
    }
}
