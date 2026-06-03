use std::path::Path;
use std::sync::Arc;

use super::*;
use crate::surface::sse_shared::SseBroadcaster;

impl ModelQueue {
    pub(super) fn handle_backup_command(&mut self, cmd: BackupCommand, sse: &Arc<SseBroadcaster>) {
        match cmd {
            BackupCommand::GetBackupList { reply } => {
                let list = self.engines.backup_manager.get_backup_list();
                let _ = reply.send(serde_json::json!(list));
            }
            BackupCommand::CreateBackup { options, reply } => {
                let opts: crate::engine::backup_manager::BackupOptions = serde_json::from_value(
                    options,
                )
                .unwrap_or(crate::engine::backup_manager::BackupOptions {
                    backup_type: Some("full".into()),
                    name: None,
                    reason: None,
                    scene_ids: None,
                    effect_ids: None,
                    plugin_ids: None,
                });
                let model_tx = self.model_tx.clone();
                let backup_manager = self.engines.backup_manager.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let effect_manager = self.engines.effect_manager.clone();
                self.engines.backup_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        backup_manager.create_backup(&opts, &scenes_dir, &effect_manager)
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(id)) => serde_json::json!(id),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("createBackup", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::Backup,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            BackupCommand::CreateFullBackup { name, reply } => {
                // 配信に接続中はバックアップを拒否 (= record_comment が走り続けるため、
                // VACUUM INTO の整合性スナップは取れるが、バックアップ後の DB と
                // 実 DB が即座にズレるので意味が薄い + ユーザーの誤操作リスクを下げる)。
                if self.main_store.connection.connected {
                    let _ = reply.send(serde_json::json!({
                        "error": "配信に接続中はバックアップを作成できません。接続を切断してから再試行してください。"
                    }));
                    return;
                }
                let model_tx = self.model_tx.clone();
                let backup_manager = self.engines.backup_manager.clone();
                let scenes = self.main_store.scenes.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let effect_manager = self.engines.effect_manager.clone();
                let listener_manager = self.engines.listener_manager.as_ref().cloned();
                let data_dir = scenes_dir
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| Path::new(".").to_path_buf());

                // 進捗を SSE static-update("backup-progress") として配信。
                // main.js の onStaticUpdate が path="backup-progress" を拾って IPC で
                // renderer に流す → ダイアログのバー / パーセントを更新する。
                let sse_for_progress = sse.clone();
                let progress: crate::engine::backup_manager::BackupProgressFn =
                    Arc::new(move |phase: &str, percent: u8, meta: Option<u64>| {
                        // meta は phase 別の総量 (= db-unpack なら総コメ件数)。
                        // JS 側で予想時間を計算する用 (= rows × 単位時間)。
                        let mut payload = serde_json::json!({
                            "phase": phase,
                            "percent": percent,
                        });
                        if let (Some(obj), Some(m)) = (payload.as_object_mut(), meta) {
                            obj.insert("meta".to_string(), serde_json::json!(m));
                        }
                        sse_for_progress.push_static_update("backup-progress", &payload);
                    });

                self.engines.backup_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        backup_manager.create_full_backup(
                            name.as_deref(),
                            &scenes,
                            &scenes_dir,
                            &effect_manager,
                            listener_manager.as_deref(),
                            Some(&data_dir),
                            Some(progress),
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(id)) => serde_json::json!(id),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("createFullBackup", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::Backup,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            BackupCommand::DeleteBackup { backup_id, reply } => {
                let model_tx = self.model_tx.clone();
                let backup_manager = self.engines.backup_manager.clone();
                self.engines.backup_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        backup_manager.delete_backup(&backup_id)
                    })
                    .await;
                    let response = match result {
                        Ok(ok) => serde_json::json!(ok),
                        Err(error) => background_error_json("deleteBackup", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::Backup,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            BackupCommand::RestoreBackup { backup_id, reply } => {
                // 配信に接続中は復元を拒否 (= 進行中の record_comment / SSE 通知と
                // ファイル差し替えが競合するため)
                if self.main_store.connection.connected {
                    let _ = reply.send(serde_json::json!({
                        "restored": false,
                        "error": "配信に接続中はバックアップを復元できません。接続を切断してから再試行してください。"
                    }));
                    return;
                }

                // DB 接続を閉じる: engines.listener_manager から Arc を取り出して try_unwrap。
                // 他の async タスクが Arc clone を保持していると失敗する。失敗時は元に戻して
                // 「他の処理が DB を使用中」エラーを返す。
                let taken = self.engines.listener_manager.take();
                let mgr_dropped = match taken {
                    Some(arc) => match std::sync::Arc::try_unwrap(arc) {
                        Ok(inner) => {
                            // drop(inner) で rusqlite::Connection が閉じてファイルロック解放
                            drop(inner);
                            true
                        }
                        Err(arc_back) => {
                            self.engines.listener_manager = Some(arc_back);
                            let _ = reply.send(serde_json::json!({
                                "restored": false,
                                "error": "他の処理が DB を使用中です。少し待ってから再試行してください。"
                            }));
                            return;
                        }
                    },
                    None => false, // listener_manager は未 open (= DB バックアップを含めても無害)
                };

                let model_tx = self.model_tx.clone();
                let backup_manager = self.engines.backup_manager.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let mut effect_manager = self.engines.effect_manager.clone();
                let data_dir = scenes_dir
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| Path::new(".").to_path_buf());
                let data_dir_for_reopen = data_dir.clone();

                // 進捗を SSE static-update("backup-progress") として配信。
                // 復元は前半 (= tar streaming = restore phase、 4-50%) + 後半 (= migrate
                // phase、 50-95%) + 再 open 完了 (= done、 100%) の 3 段で流す。
                // restore_backup 内部の最後の `done` phase は「tar streaming 完了」 を
                // 意味するので、 ここで `restore-tar-done` 50% に rename して migrate
                // phase へ続ける流れを作る。 本物の `done` 100% は ApplyAsyncWriteback
                // で listener_manager の再 open + migration が完全完了した後に発火する。
                let sse_for_progress = sse.clone();
                let progress: crate::engine::backup_manager::BackupProgressFn =
                    Arc::new(move |phase: &str, percent: u8, meta: Option<u64>| {
                        let (out_phase, out_percent) = if phase == "done" {
                            ("restore-tar-done", 50)
                        } else {
                            (phase, percent)
                        };
                        let mut payload = serde_json::json!({
                            "phase": out_phase,
                            "percent": out_percent,
                        });
                        if let (Some(obj), Some(m)) = (payload.as_object_mut(), meta) {
                            obj.insert("meta".to_string(), serde_json::json!(m));
                        }
                        sse_for_progress.push_static_update("backup-progress", &payload);
                    });

                // migrate phase 用 reporter (= listener_manager::open() 内の
                // migrate_comments_raw_to_zstd から chunk 完了ごとに呼ばれる)。
                // processed=0 は「開始通知」 として扱い、 予想秒数を meta に乗せる。
                let sse_for_migrate = sse.clone();
                crate::engine::listener_manager::migration_progress::set(Arc::new(
                    move |processed: u64, total: u64| {
                        let percent = if total > 0 {
                            50 + ((processed as f64 / total as f64) * 45.0).round() as u8
                        } else {
                            50
                        };
                        let mut payload = serde_json::json!({
                            "phase": "migrate",
                            "percent": percent,
                        });
                        if processed == 0 && total > 0 {
                            let est_sec = crate::engine::backup_manager::estimate_migrate_seconds(
                                total,
                                crate::engine::backup_manager::unpack_thread_count(),
                            );
                            if let Some(obj) = payload.as_object_mut() {
                                obj.insert("meta".to_string(), serde_json::json!(est_sec));
                            }
                        }
                        sse_for_migrate.push_static_update("backup-progress", &payload);
                    },
                ));

                self.engines.backup_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        let mut scratch = crate::state::scene::SceneStore::new();
                        backup_manager.restore_backup(
                            &backup_id,
                            &scenes_dir,
                            &mut scratch,
                            &mut effect_manager,
                            Some(&data_dir),
                            Some(progress),
                        )
                    })
                    .await;
                    // 復元失敗 + listener_manager drop していない経路では ReopenListenerManager
                    // ApplyAsyncWriteback が走らず migration_progress::clear() が呼ばれない。
                    // reporter が global static に残ると次回 migration で誤発火するため、
                    // 結果に関わらず必ず clear する safety net (= 成功経路でも 2 回 clear は no-op)。
                    crate::engine::listener_manager::migration_progress::clear();
                    let writeback = match result {
                        Ok(Ok(())) => AsyncWriteback {
                            queue: EngineQueueKind::Backup,
                            apply: AsyncApply::ReopenListenerManagerAndReloadScenes {
                                data_dir: data_dir_for_reopen,
                            },
                            reply: Some(reply),
                            response: serde_json::json!({ "restored": true }),
                        },
                        Ok(Err(error)) => AsyncWriteback {
                            queue: EngineQueueKind::Backup,
                            // 失敗時も DB 接続を閉じたので再 open は試みる
                            apply: if mgr_dropped {
                                AsyncApply::ReopenListenerManagerAndReloadScenes {
                                    data_dir: data_dir_for_reopen,
                                }
                            } else {
                                AsyncApply::None
                            },
                            reply: Some(reply),
                            response: serde_json::json!({ "restored": false, "error": error }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::Backup,
                            apply: if mgr_dropped {
                                AsyncApply::ReopenListenerManagerAndReloadScenes {
                                    data_dir: data_dir_for_reopen,
                                }
                            } else {
                                AsyncApply::None
                            },
                            reply: Some(reply),
                            response: background_error_json("restoreBackup", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            BackupCommand::GetDataOverview { reply } => {
                // listeners.db のコメ件数 + リスナー件数。 復元前の「強めの警告を出すか」 判定用。
                // listener_manager が未 open (= 起動直後の極初期) なら 0 を返す。
                let (comments, listeners) = self
                    .engines
                    .listener_manager
                    .as_ref()
                    .map(|mgr| mgr.data_overview())
                    .unwrap_or((0, 0));
                let _ = reply.send(serde_json::json!({
                    "commentsCount": comments,
                    "listenersCount": listeners,
                }));
            }
            BackupCommand::GetBackupsDir { reply } => {
                let _ = reply.send(serde_json::json!(self
                    .app_config
                    .backups_dir
                    .clone()
                    .unwrap_or_default()));
            }
            BackupCommand::SetBackupsDir { dir } => {
                if dir.trim().is_empty() {
                    let default_dir = self
                        .engines
                        .scene_manager
                        .scenes_dir()
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join("backups");
                    self.engines.backup_manager.set_backups_dir(&default_dir);
                    self.app_config.backups_dir = None;
                } else {
                    self.engines.backup_manager.set_backups_dir(Path::new(&dir));
                    self.app_config.backups_dir = Some(dir);
                }
                self.save_app_config();
            }
            BackupCommand::ConfirmUpgradeEffect {
                zip_path,
                effect_id,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let mut effect_manager = self.engines.effect_manager.clone();
                let backup_manager = self.engines.backup_manager.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let mut scenes = self.main_store.scenes.clone();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::confirm_and_upgrade_effect(
                            Path::new(&zip_path),
                            &effect_id,
                            &mut effect_manager,
                            &backup_manager,
                            &scenes_dir,
                            &mut scenes,
                        )
                    })
                    .await;
                    let writeback = match result {
                        Ok(Ok(value)) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::ReloadScenesAndSyncEffects,
                            reply: Some(reply),
                            response: value,
                        },
                        Ok(Err(error)) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!({ "upgraded": false, "error": error }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("confirmUpgradeEffect", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
        }
    }
}
