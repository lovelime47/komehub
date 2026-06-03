use std::path::Path;

use super::*;

impl ModelQueue {
    pub(super) fn handle_import_export_command(&mut self, cmd: ImportExportCommand) {
        match cmd {
            ImportExportCommand::ImportEffect { zip_path, reply } => {
                let model_tx = self.model_tx.clone();
                let mut effect_manager = self.engines.effect_manager.clone();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::import_effect(
                            Path::new(&zip_path),
                            &mut effect_manager,
                        )
                    })
                    .await;
                    let writeback = match result {
                        Ok(import_result) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::SyncEffectsToStore,
                            reply: Some(reply),
                            response: import_result_to_json(import_result),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("importEffect", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            ImportExportCommand::ImportScene { zip_path, reply } => {
                let model_tx = self.model_tx.clone();
                let mut effect_manager = self.engines.effect_manager.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let mut scenes = self.main_store.scenes.clone();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::import_scene(
                            Path::new(&zip_path),
                            &mut effect_manager,
                            &scenes_dir,
                            &mut scenes,
                        )
                    })
                    .await;
                    let writeback = match result {
                        Ok(import_result) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::ReloadScenesAndSyncEffects,
                            reply: Some(reply),
                            response: import_result_to_json(import_result),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("importScene", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            ImportExportCommand::ImportPerformance {
                scene_id,
                zip_path,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let mut effect_manager = self.engines.effect_manager.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let mut scenes = self.main_store.scenes.clone();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::import_performance(
                            &scene_id,
                            Path::new(&zip_path),
                            &mut effect_manager,
                            &scenes_dir,
                            &mut scenes,
                        )
                    })
                    .await;
                    let writeback = match result {
                        Ok(import_result) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::ReloadScenesAndSyncEffects,
                            reply: Some(reply),
                            response: import_result_to_json(import_result),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("importPerformance", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }

            // --- ExportSurface ---
            ImportExportCommand::ExportScene {
                scene_id,
                dest_path,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let scenes = self.main_store.scenes.clone();
                let plugins_dir = self.engines.effect_manager.plugins_dir().to_path_buf();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::export_scene(
                            &scene_id,
                            Path::new(&dest_path),
                            &scenes_dir,
                            &scenes,
                            &plugins_dir,
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(())) => serde_json::json!({ "ok": true }),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("exportScene", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            ImportExportCommand::ExportPerformance {
                scene_id,
                performance_id,
                dest_path,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                let scenes = self.main_store.scenes.clone();
                let plugins_dir = self.engines.effect_manager.plugins_dir().to_path_buf();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::export_performance(
                            &scene_id,
                            &performance_id,
                            Path::new(&dest_path),
                            &scenes_dir,
                            &scenes,
                            &plugins_dir,
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(())) => serde_json::json!({ "ok": true }),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("exportPerformance", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            ImportExportCommand::ExportEffect {
                effect_id,
                dest_path,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let effects_dir = self.engines.effect_manager.effects_dir().to_path_buf();
                let scenes = self.main_store.scenes.clone();
                let plugins_dir = self.engines.effect_manager.plugins_dir().to_path_buf();
                self.engines.import_export_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::engine::export_import::export_effect(
                            &effect_id,
                            Path::new(&dest_path),
                            &effects_dir,
                            &scenes,
                            &plugins_dir,
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(())) => serde_json::json!({ "ok": true }),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("exportEffect", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::ImportExport,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            ImportExportCommand::ExportTemplate {
                template_name,
                export_name,
                scene_id,
                template_settings,
                dest_path,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let template_manager = self.engines.template_manager.clone();
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                self.engines.template_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        template_manager.export_template(
                            &template_name,
                            export_name.as_deref(),
                            scene_id.as_deref(),
                            Some(&template_settings),
                            &scenes_dir,
                            Path::new(&dest_path),
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(())) => serde_json::json!({ "ok": true }),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("exportTemplate", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::Template,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
        }
    }
}
