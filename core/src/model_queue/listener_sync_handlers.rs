use std::path::Path;

use crate::engine::listener_aux_io;

use super::*;

impl ModelQueue {
    pub(super) fn handle_export_komehub_jsonl(
        &self,
        out_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        let manager = self.engines.listener_manager.as_ref().cloned();
        self.engines.listener_sync_queue.send(async move {
            let response = match manager {
                Some(mgr) => {
                    let path = std::path::PathBuf::from(&out_path);
                    let result =
                        tokio::task::spawn_blocking(move || mgr.export_komehub_jsonl(&path)).await;
                    match result {
                        Ok(Ok(summary)) => serde_json::json!({ "ok": true, "summary": summary }),
                        Ok(Err(err)) => {
                            tracing::warn!("export_komehub_jsonl failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                        Err(join_err) => serde_json::json!({
                            "ok": false,
                            "error": format!("export task join error: {}", join_err),
                        }),
                    }
                }
                None => serde_json::json!({
                    "ok": false,
                    "error": "listener_manager is unavailable",
                }),
            };
            let _ = reply.send(response);
        });
    }

    pub(super) fn handle_import_komehub_jsonl(
        &self,
        src_path: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        let manager = self.engines.listener_manager.as_ref().cloned();
        self.engines.listener_sync_queue.send(async move {
            let response = match manager {
                Some(mgr) => {
                    let path = std::path::PathBuf::from(&src_path);
                    let result =
                        tokio::task::spawn_blocking(move || mgr.import_komehub_jsonl(&path)).await;
                    match result {
                        Ok(Ok(summary)) => serde_json::json!({ "ok": true, "summary": summary }),
                        Ok(Err(err)) => {
                            tracing::warn!("import_komehub_jsonl failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                        Err(join_err) => serde_json::json!({
                            "ok": false,
                            "error": format!("import task join error: {}", join_err),
                        }),
                    }
                }
                None => serde_json::json!({
                    "ok": false,
                    "error": "listener_manager is unavailable",
                }),
            };
            let _ = reply.send(response);
        });
    }

    pub(super) fn handle_import_from_onecomme(
        &self,
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
        sse: &Arc<SseBroadcaster>,
    ) {
        let manager = self.engines.listener_manager.as_ref().cloned();
        let configured = self.main_store.configured_owner_channel_ids.clone();
        let sse_for_push = sse.clone();
        self.engines.listener_sync_queue.send(async move {
            let response = match manager {
                Some(mgr) => {
                    let dir = std::path::PathBuf::from(&onecomme_dir);

                    // import 前に わんコメ DB のリセット / 巻き戻し検出 ([[feedback_watermark_vs_external_db_reset]])。
                    // 検出時は SSE push で renderer に警告 → user が「リセット」 を選択するまで
                    // watermark は据え置き。 import 自体は続行 (= 取り込み watermark で
                    // 大半は重複 skip されるので無害)。
                    let detect_mgr = mgr.clone();
                    let detect_dir = dir.clone();
                    let signal = tokio::task::spawn_blocking(move || {
                        detect_mgr.detect_onecomme_reset(&detect_dir)
                    })
                    .await
                    .ok()
                    .flatten();
                    if let Some(sig) = signal {
                        tracing::warn!("onecomme reset detected: {:?}", sig);
                        sse_for_push.push_static_update(
                            "onecomme-reset-detected",
                            &serde_json::json!({
                                "signal": sig,
                                "onecommeDir": onecomme_dir,
                            }),
                        );
                    }

                    let mgr_for_push = mgr.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let refs: Vec<&str> = configured.iter().map(String::as_str).collect();
                        mgr.import_from_onecomme(&dir, &refs)
                    })
                    .await;
                    match result {
                        Ok(Ok(summary)) => {
                            push_repaired_stream_meta(
                                &mgr_for_push,
                                &sse_for_push,
                                &summary.repaired_video_ids,
                            )
                            .await;
                            serde_json::json!({ "ok": true, "summary": summary })
                        }
                        Ok(Err(err)) => {
                            tracing::warn!("import_from_onecomme failed: {}", err);
                            serde_json::json!({ "ok": false, "error": err.to_string() })
                        }
                        Err(join_err) => serde_json::json!({
                            "ok": false,
                            "error": format!("import task join error: {}", join_err),
                        }),
                    }
                }
                None => serde_json::json!({
                    "ok": false,
                    "error": "listener_manager is unavailable",
                }),
            };
            let _ = reply.send(response);
        });
    }

    /// 空 title/channel_name の自チャ過去 stream を Electron resolver で後追い補完する
    /// (= 起動時 backfill。fire-and-forget)。import の Pass 0 と同じ repair_missing_stream_meta を
    /// listener_sync_queue 上の spawn_blocking で呼び、補完できた枠は SSE で 配信ログ UI に反映する。
    pub(super) fn handle_backfill_stream_meta(&self, sse: &Arc<SseBroadcaster>) {
        let manager = self.engines.listener_manager.as_ref().cloned();
        // configured を yt- 形式へ正規化 (= streams.owner_channel_id と一致比較する)。
        let configured_yt: Vec<String> = self
            .main_store
            .configured_owner_channel_ids
            .iter()
            .filter(|c| !c.is_empty())
            .map(|c| {
                if c.starts_with("yt-") {
                    c.to_string()
                } else {
                    format!("yt-{}", c)
                }
            })
            .collect();
        let sse_for_push = sse.clone();
        self.engines.listener_sync_queue.send(async move {
            let Some(mgr) = manager else {
                return;
            };
            if configured_yt.is_empty() {
                return; // 自チャンネル未設定 → 対象なし
            }
            let mgr_for_push = mgr.clone();
            let result =
                tokio::task::spawn_blocking(move || mgr.repair_missing_stream_meta(&configured_yt))
                    .await;
            match result {
                Ok(Ok(repaired)) => {
                    if repaired.is_empty() {
                        tracing::debug!("backfill_stream_meta: no streams needed repair");
                    } else {
                        tracing::info!(
                            "backfill_stream_meta: repaired {} stream(s)",
                            repaired.len()
                        );
                        push_repaired_stream_meta(&mgr_for_push, &sse_for_push, &repaired).await;
                    }
                }
                Ok(Err(err)) => {
                    tracing::warn!("backfill_stream_meta failed: {}", err);
                }
                Err(join_err) => {
                    tracing::warn!("backfill_stream_meta task join error: {}", join_err);
                }
            }
        });
    }

    pub(super) fn handle_export_to_onecomme(
        &self,
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        if self.main_store.connection.connected {
            let _ = reply.send(serde_json::json!({
                "ok": false,
                "skipped": true,
                "reason": "broadcasting",
                "message": "配信中はわんコメへの書き戻しを実行できません。",
            }));
            return false;
        }
        let manager = self.engines.listener_manager.as_ref().cloned();
        let data_dir = self
            .engines
            .scene_manager
            .scenes_dir()
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| Path::new(".").to_path_buf());
        let backup_root = data_dir.join("data").join("onecomme-backups");
        // pristine 判定: app_config に記録された onecommeDir と一致しなければ backup を取る
        let take_pristine_backup =
            self.app_config.onecomme_pristine_for.as_deref() != Some(onecomme_dir.as_str());
        let model_tx = self.model_tx.clone();
        let onecomme_dir_for_apply = onecomme_dir.clone();
        let sse_for_detect = sse.clone();
        self.engines.listener_sync_queue.send(async move {
            if listener_aux_io::detect_onecomme_running().await {
                let _ = reply.send(serde_json::json!({
                    "ok": false,
                    "skipped": true,
                    "reason": "onecomme_running",
                    "message": "わんコメが起動中のため書き戻しを中断しました。わんコメを終了してから再実行してください。",
                }));
                return;
            }

            // 二重防御: 起動時 import 前と同じ detect_onecomme_reset を export 直前にも実行
            // ([[project_onecomme_reset_detection]])。 起動後にユーザーが わんコメ DB を
            // 独立でリセットしたケース (= 起動時検出を逃したケース) のフォローアップ。
            // 検出時は SSE で警告 push、 export 自体は **続行する** (= 中断すると shutdown
            // 経路で書き戻しが永遠に走らないリスクの方が大きい、 ユーザーは警告を見て
            // 次回起動時に reset を判断できる)。
            if let Some(mgr) = manager.as_ref() {
                let detect_mgr = mgr.clone();
                let detect_dir = std::path::PathBuf::from(&onecomme_dir);
                let signal = tokio::task::spawn_blocking(move || {
                    detect_mgr.detect_onecomme_reset(&detect_dir)
                })
                .await
                .ok()
                .flatten();
                if let Some(sig) = signal {
                    tracing::warn!("onecomme reset detected at export time: {:?}", sig);
                    sse_for_detect.push_static_update(
                        "onecomme-reset-detected",
                        &serde_json::json!({
                            "signal": sig,
                            "onecommeDir": onecomme_dir,
                        }),
                    );
                }
            }

            let (response, did_backup) = match manager {
                Some(mgr) => {
                    let dir = std::path::PathBuf::from(&onecomme_dir);
                    let result = tokio::task::spawn_blocking(move || {
                        mgr.export_to_onecomme(&dir, &backup_root, take_pristine_backup)
                    })
                    .await;
                    match result {
                        Ok(Ok(summary)) => {
                            let did = summary.backup_dir.is_some();
                            (serde_json::json!({ "ok": true, "summary": summary }), did)
                        }
                        Ok(Err(err)) => {
                            tracing::warn!("export_to_onecomme failed: {}", err);
                            (serde_json::json!({ "ok": false, "error": err.to_string() }), false)
                        }
                        Err(join_err) => (
                            serde_json::json!({
                                "ok": false,
                                "error": format!("export task join error: {}", join_err),
                            }),
                            false,
                        ),
                    }
                }
                None => (
                    serde_json::json!({
                        "ok": false,
                        "error": "listener_manager is unavailable",
                    }),
                    false,
                ),
            };
            let _ = reply.send(response);
            if did_backup {
                // pristine backup を取った onecommeDir を app_config に記録
                // (= 次回 export で backup を skip するため)
                let writeback = AsyncWriteback {
                    queue: EngineQueueKind::ListenerSync,
                    apply: AsyncApply::MarkOnecommePristineBackupTaken {
                        onecomme_dir: onecomme_dir_for_apply,
                    },
                    reply: None,
                    response: serde_json::Value::Null,
                };
                model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
            }
        });
        true
    }

    pub(super) fn handle_detect_onecomme_running(
        &self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.engines.listener_sync_queue.send(async move {
            let running = listener_aux_io::detect_onecomme_running().await;
            let _ = reply.send(serde_json::json!({ "ok": true, "running": running }));
        });
    }

    pub(super) fn handle_run_bidirectional_sync(
        &self,
        onecomme_dir: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        if self.main_store.connection.connected {
            let _ = reply.send(serde_json::json!({
                "ok": false, "skipped": true, "reason": "broadcasting",
                "message": "配信中は同期できません",
            }));
            return false;
        }
        let configured = self.main_store.configured_owner_channel_ids.clone();
        if configured.is_empty() {
            let _ = reply.send(serde_json::json!({
                "ok": false, "skipped": true, "reason": "owner_unset",
                "message": "自チャンネル未設定のため同期をスキップしました",
            }));
            return false;
        }
        let manager = self.engines.listener_manager.as_ref().cloned();
        let data_dir = self
            .engines
            .scene_manager
            .scenes_dir()
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| Path::new(".").to_path_buf());
        let backup_root = data_dir.join("data").join("onecomme-backups");
        let take_pristine_backup =
            self.app_config.onecomme_pristine_for.as_deref() != Some(onecomme_dir.as_str());
        let model_tx = self.model_tx.clone();
        let onecomme_dir_for_apply = onecomme_dir.clone();
        let sse_for_push = sse.clone();
        self.engines.listener_sync_queue.send(async move {
            if listener_aux_io::detect_onecomme_running().await {
                let _ = reply.send(serde_json::json!({
                    "ok": false, "skipped": true, "reason": "onecomme_running",
                    "message": "わんコメ起動中のため同期をスキップしました",
                }));
                return;
            }
            let dir = std::path::PathBuf::from(&onecomme_dir);
            let (response, did_backup) = match manager {
                Some(mgr) => {
                    let configured_clone = configured.clone();
                    let dir_for_blocking = dir.clone();
                    let mgr_clone = mgr.clone();
                    let mgr_for_push = mgr.clone();
                    let import_result = tokio::task::spawn_blocking(move || {
                        let refs: Vec<&str> = configured_clone.iter().map(String::as_str).collect();
                        mgr_clone.import_from_onecomme(&dir_for_blocking, &refs)
                    })
                    .await;
                    let import_summary = match import_result {
                        Ok(Ok(s)) => {
                            push_repaired_stream_meta(
                                &mgr_for_push,
                                &sse_for_push,
                                &s.repaired_video_ids,
                            )
                            .await;
                            Some(s)
                        }
                        Ok(Err(e)) => {
                            tracing::warn!("bidirectional sync import phase failed: {}", e);
                            None
                        }
                        Err(je) => {
                            tracing::warn!("bidirectional sync import join error: {}", je);
                            None
                        }
                    };
                    let export_result = tokio::task::spawn_blocking(move || {
                        mgr.export_to_onecomme(&dir, &backup_root, take_pristine_backup)
                    })
                    .await;
                    let (export_summary, did) = match export_result {
                        Ok(Ok(s)) => {
                            let did = s.backup_dir.is_some();
                            (Some(s), did)
                        }
                        Ok(Err(e)) => {
                            tracing::warn!("bidirectional sync export phase failed: {}", e);
                            (None, false)
                        }
                        Err(je) => {
                            tracing::warn!("bidirectional sync export join error: {}", je);
                            (None, false)
                        }
                    };
                    let export_aborted = export_summary.as_ref().is_some_and(|s| s.aborted);
                    let ok =
                        (import_summary.is_some() || export_summary.is_some()) && !export_aborted;
                    (
                        serde_json::json!({
                            "ok": ok,
                            "import": import_summary,
                            "export": export_summary,
                        }),
                        did,
                    )
                }
                None => (
                    serde_json::json!({
                        "ok": false, "error": "listener_manager is unavailable",
                    }),
                    false,
                ),
            };
            let _ = reply.send(response);
            if did_backup {
                let writeback = AsyncWriteback {
                    queue: EngineQueueKind::ListenerSync,
                    apply: AsyncApply::MarkOnecommePristineBackupTaken {
                        onecomme_dir: onecomme_dir_for_apply,
                    },
                    reply: None,
                    response: serde_json::Value::Null,
                };
                model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
            }
        });
        true
    }
}

/// import_from_onecomme で title/channel_name が補完された video_id 群について、
/// 最新 stream detail を `stream-metadata-updated` SSE で push し、 配信ログ UI を即時更新する。
/// (= 起動時 import が main window 表示後に走るタイミング race で UI snapshot が古いまま残る
///   問題への対処。 UI 側は既存 `stream-metadata-updated` listener が反応する)
async fn push_repaired_stream_meta(
    mgr: &std::sync::Arc<crate::engine::listener_manager::ListenerManager>,
    sse: &Arc<SseBroadcaster>,
    video_ids: &[String],
) {
    if video_ids.is_empty() {
        return;
    }
    let mgr_clone = mgr.clone();
    let video_ids_owned: Vec<String> = video_ids.to_vec();
    let sse_clone = sse.clone();
    // get_stream_detail は同期 SQL なので spawn_blocking 内で実行
    let _ = tokio::task::spawn_blocking(move || {
        for vid in &video_ids_owned {
            match mgr_clone.get_stream_detail(vid, 0) {
                Ok(Some(detail)) => {
                    sse_clone.push_static_update("stream-metadata-updated", &detail.stream);
                    tracing::info!(
                        "pushed stream-metadata-updated for repaired video_id={}",
                        vid
                    );
                }
                Ok(None) => {
                    tracing::warn!("get_stream_detail returned None for {}", vid);
                }
                Err(e) => {
                    tracing::warn!("get_stream_detail failed for {}: {}", vid, e);
                }
            }
        }
    })
    .await;
}
