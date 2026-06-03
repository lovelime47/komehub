use super::*;
use futures::stream::{self, StreamExt};

/// comment_aux の prepare 並列度上限 (= 0003)。
/// 通常 batch=25 (= fetch-intercept) / 63 (= dom-initial-scrape backfill)。
/// 10 並列なら CDN への同時 fetch を抑えつつ、25 件で ~3 round (= 150ms)、
/// 63 件 backfill で ~7 round (= 350ms) に短縮される (= 元 1.4 / 3.3 秒)。
/// 5ca6b61 の「コメント単位で順次 writeback」精神は維持 (= 1 件 prepare 完了で 1 件 writeback)、
/// `buffered(N)` で入力順保証 (= timestamp 順を保つ)。
const COMMENT_AUX_PREPARE_CONCURRENCY: usize = 10;

impl ModelQueue {
    pub(super) async fn handle_realtime_command(
        &mut self,
        cmd: RealtimeCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            RealtimeCommand::ApplyAsyncWriteback { writeback } => {
                self.handle_async_writeback(writeback, sse).await;
            }
            RealtimeCommand::ApplyAsyncWritebackSync { writeback, ack } => {
                self.handle_async_writeback(writeback, sse).await;
                let _ = ack.send(());
            }
            RealtimeCommand::IncomingCommentsJson { comments_json } => {
                let model_tx = self.model_tx.clone();
                let media_cache_dir = self.media_cache_dir.clone();
                let public_http_port = self.public_http_port;
                self.engines.comment_aux_queue.send(async move {
                        let client = match crate::image_cache::build_image_http_client() {
                            Ok(client) => client,
                            Err(error) => {
                                model_tx.send(ModelCommand::ApplyAsyncWriteback {
                                    writeback: AsyncWriteback {
                                        queue: EngineQueueKind::CommentAux,
                                        apply: AsyncApply::None,
                                        reply: None,
                                        response: serde_json::json!({ "error": error }),
                                    },
                                });
                                return;
                            }
                        };
                        let mut comments: Vec<serde_json::Value> = match serde_json::from_str(&comments_json) {
                            Ok(comments) => comments,
                            Err(error) => {
                                model_tx.send(ModelCommand::ApplyAsyncWriteback {
                                    writeback: AsyncWriteback {
                                        queue: EngineQueueKind::CommentAux,
                                        apply: AsyncApply::None,
                                        reply: None,
                                        response: serde_json::json!({ "error": format!("invalid comments JSON: {}", error) }),
                                    },
                                });
                                return;
                            }
                        };
                        // timestamp でソート（fetch インターセプト経路では API レスポンス内の順序が保証されない場合がある）
                        comments.sort_by(|a, b| {
                            let ta = a.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
                            let tb = b.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
                            ta.cmp(tb)
                        });

                        let batch_started_at = current_millis();
                        let batch_size = comments.len() as u64;

                        // [0003] 並列 prepare + 入力順 fire-and-forget writeback
                        let prepare_stream = stream::iter(comments.into_iter().enumerate())
                            .map(|(index, mut comment)| {
                                let media_cache_dir = media_cache_dir.clone();
                                let client = client.clone();
                                async move {
                                    stamp_value_trace(&mut comment, "commentAuxBatchStartedAtMs", serde_json::Value::from(batch_started_at));
                                    stamp_value_trace(&mut comment, "commentAuxBatchSize", serde_json::Value::from(batch_size));
                                    stamp_value_trace(&mut comment, "commentAuxBatchIndex", serde_json::Value::from(index as u64));
                                    stamp_value_trace(&mut comment, "commentAuxItemStartedAtMs", serde_json::Value::from(current_millis()));
                                    let prepared = crate::engine::comment_aux_io::prepare_incoming_comment_value(
                                        &media_cache_dir,
                                        public_http_port,
                                        &mut comment,
                                        &client,
                                    )
                                    .await;
                                    prepared
                                }
                            })
                            .buffered(COMMENT_AUX_PREPARE_CONCURRENCY);
                        tokio::pin!(prepare_stream);

                        while let Some(prepared) = prepare_stream.next().await {
                            match prepared {
                                Ok(mut prepared_comment) => {
                                    let item_done_at = current_millis();
                                    prepared_comment.set_trace_ms("commentAuxItemDoneAtMs", item_done_at);
                                    prepared_comment.set_trace_ms("commentAuxReadyAtMs", item_done_at);
                                    prepared_comment.set_trace_ms("commentAuxBatchFinishedAtMs", item_done_at);
                                    prepared_comment.set_trace_ms("commentAuxWritebackQueuedAtMs", current_millis());
                                    // 非 Sync (= fire-and-forget): ModelQueue 側 writeback_gate=Semaphore(1)
                                    // で逐次化が担保されるので caller の ack 待ちは冗長 (= 0003 Phase 2)
                                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                                        writeback: AsyncWriteback {
                                            queue: EngineQueueKind::CommentAux,
                                            apply: AsyncApply::IncomingComments { comments: vec![prepared_comment] },
                                            reply: None,
                                            response: serde_json::json!({ "ok": true }),
                                        },
                                    });
                                }
                                Err(error) => {
                                    // 1 件失敗時は警告のみ。残りの並列 prepare は継続させる
                                    // (= 旧実装は return で全 batch を中断していたが、並列化後は他コメに影響させない)
                                    tracing::warn!("comment prepare error (IncomingCommentsJson): {}", error);
                                }
                            }
                        }
                    });
            }
            RealtimeCommand::IncomingInnertubeActions { actions_json } => {
                let model_tx = self.model_tx.clone();
                let media_cache_dir = self.media_cache_dir.clone();
                let public_http_port = self.public_http_port;
                self.engines.comment_aux_queue.send(async move {
                    let payload: serde_json::Value = match serde_json::from_str(&actions_json) {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::warn!("InnerTube actions JSON parse error: {}", e);
                            return;
                        }
                    };
                    let actions = match payload.get("actions").and_then(|v| v.as_array()) {
                        Some(a) => a.as_slice(),
                        None => return,
                    };
                    let initial = payload
                        .get("initial")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    // seenIds は Rust 側でスレッドローカルに管理
                    // (comment_aux_queue は single-thread 保証)
                    const MAX_SEEN_IDS: usize = 5000;
                    thread_local! {
                        static SEEN_IDS: std::cell::RefCell<std::collections::HashSet<String>> =
                            std::cell::RefCell::new(std::collections::HashSet::new());
                    }
                    let (comments, deleted_ids) = SEEN_IDS.with(|seen| {
                        let mut seen = seen.borrow_mut();
                        if seen.len() > MAX_SEEN_IDS {
                            seen.clear();
                            seen.shrink_to(MAX_SEEN_IDS);
                        }
                        crate::innertube_parser::parse_innertube_actions(
                            actions, initial, &mut seen,
                        )
                    });

                    // 削除を先に処理
                    if !deleted_ids.is_empty() {
                        tracing::debug!(
                            "InnerTube deleted {} ids: {:?}",
                            deleted_ids.len(),
                            &deleted_ids[..deleted_ids.len().min(3)]
                        );
                        model_tx.send(ModelCommand::CommentDeleted {
                            comment_ids: deleted_ids,
                        });
                    }

                    if comments.is_empty() {
                        return;
                    }

                    // IncomingCommentsJson と同じパイプライン（画像キャッシュ → writeback）
                    let client = match crate::image_cache::build_image_http_client() {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!("Image client build error in InnerTube path: {}", e);
                            // 画像キャッシュなしでも直接送る
                            model_tx.send(ModelCommand::IncomingComments { comments });
                            return;
                        }
                    };

                    let comment_values: Vec<serde_json::Value> = comments
                        .iter()
                        .filter_map(|c| serde_json::to_value(c).ok())
                        .collect();

                    let batch_started_at = current_millis();
                    let batch_size = comment_values.len() as u64;

                    // [0003] 並列 prepare + 入力順 fire-and-forget writeback
                    let prepare_stream = stream::iter(comment_values.into_iter().enumerate())
                        .map(|(index, mut comment)| {
                            let media_cache_dir = media_cache_dir.clone();
                            let client = client.clone();
                            async move {
                                stamp_value_trace(
                                    &mut comment,
                                    "commentAuxBatchStartedAtMs",
                                    serde_json::Value::from(batch_started_at),
                                );
                                stamp_value_trace(
                                    &mut comment,
                                    "commentAuxBatchSize",
                                    serde_json::Value::from(batch_size),
                                );
                                stamp_value_trace(
                                    &mut comment,
                                    "commentAuxBatchIndex",
                                    serde_json::Value::from(index as u64),
                                );
                                stamp_value_trace(
                                    &mut comment,
                                    "commentAuxItemStartedAtMs",
                                    serde_json::Value::from(current_millis()),
                                );
                                let prepared =
                                    crate::engine::comment_aux_io::prepare_incoming_comment_value(
                                        &media_cache_dir,
                                        public_http_port,
                                        &mut comment,
                                        &client,
                                    )
                                    .await;
                                prepared
                            }
                        })
                        .buffered(COMMENT_AUX_PREPARE_CONCURRENCY);
                    tokio::pin!(prepare_stream);

                    while let Some(prepared) = prepare_stream.next().await {
                        match prepared {
                            Ok(mut prepared_comment) => {
                                let item_done_at = current_millis();
                                prepared_comment
                                    .set_trace_ms("commentAuxItemDoneAtMs", item_done_at);
                                prepared_comment.set_trace_ms("commentAuxReadyAtMs", item_done_at);
                                prepared_comment.set_trace_ms(
                                    "commentAuxBatchFinishedAtMs",
                                    item_done_at,
                                );
                                prepared_comment.set_trace_ms(
                                    "commentAuxWritebackQueuedAtMs",
                                    current_millis(),
                                );
                                // 非 Sync (= fire-and-forget): ModelQueue 側 writeback_gate=Semaphore(1)
                                // で逐次化が担保されるので caller の ack 待ちは冗長 (= 0003 Phase 2)
                                model_tx.send(ModelCommand::ApplyAsyncWriteback {
                                    writeback: AsyncWriteback {
                                        queue: EngineQueueKind::CommentAux,
                                        apply: AsyncApply::IncomingComments {
                                            comments: vec![prepared_comment],
                                        },
                                        reply: None,
                                        response: serde_json::json!({ "ok": true }),
                                    },
                                });
                            }
                            Err(error) => {
                                tracing::warn!("InnerTube comment prepare error: {}", error);
                            }
                        }
                    }
                });
            }
            RealtimeCommand::IncomingComments { comments } => {
                self.handle_incoming_comments(comments, sse);
            }
            RealtimeCommand::CacheCommentImages {
                comments_json,
                reply,
            } => {
                let media_cache_dir = self.media_cache_dir.clone();
                let public_http_port = self.public_http_port;
                self.engines.comment_aux_queue.send(async move {
                    let response = crate::engine::comment_aux_io::cache_comment_images(
                        &media_cache_dir,
                        public_http_port,
                        &comments_json,
                    )
                    .await;
                    let _ = reply.send(response);
                });
            }
            RealtimeCommand::GetRecentComments { limit, reply } => {
                let recent = self
                    .main_session
                    .canonical_comment_store
                    .recent_cloned(limit);
                let _ = reply.send(serde_json::json!(recent));
            }
            RealtimeCommand::GetLiveStreamStats { reply } => {
                let stats = &self.main_session.live_stream_stats;
                let _ = reply.send(serde_json::json!({
                    "videoId": stats.video_id,
                    "commentCount": stats.comment_count,
                    "superchatAmountJpy": stats.superchat_amount_jpy,
                }));
            }
            RealtimeCommand::IncomingReaction { reaction } => {
                self.handle_incoming_reaction(reaction, sse);
            }
            RealtimeCommand::CommentDeleted { comment_ids } => {
                self.main_session
                    .canonical_comment_store
                    .delete_ids(&comment_ids);
                for id in &comment_ids {
                    sse.push_comment_deleted(id);
                }
            }
            RealtimeCommand::ConnectionStateChanged {
                connected,
                video_id,
            } => {
                self.handle_connection_state_changed(connected, video_id, sse);
            }
            RealtimeCommand::AnnounceStreamOwner {
                video_id,
                owner_channel_id,
            } => {
                if Self::apply_stream_owner_announcement(
                    &mut self.main_store.connection,
                    &mut self.pending_stream_owner,
                    video_id,
                    owner_channel_id,
                ) {
                    Self::push_connection_status(&mut self.main_store, sse);
                }
            }
        }
        true
    }
}
