use std::path::Path;

use super::*;

impl ModelQueue {
    pub(super) fn handle_preset_command(&mut self, cmd: PresetCommand) {
        match cmd {
            PresetCommand::GetPresetList { reply } => {
                let list = self.engines.preset_manager.list_presets();
                let _ = reply.send(serde_json::json!(list));
            }
            PresetCommand::GetCurrentPreset { reply } => {
                let _ = reply.send(serde_json::json!(self
                    .engines
                    .preset_manager
                    .current_preset()));
            }
            PresetCommand::SwitchPreset { name, reply } => {
                let model_tx = self.model_tx.clone();
                let mut preset_manager = self.engines.preset_manager.clone();
                self.engines.preset_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        preset_manager.switch_preset(&name, false)
                    })
                    .await;
                    let writeback = match result {
                        Ok(Ok(current_preset)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::SetCurrentPreset {
                                current_preset: normalize_optional_string(Some(&current_preset)),
                            },
                            reply: Some(reply),
                            response: serde_json::json!(current_preset),
                        },
                        Ok(Err(error)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!({ "error": error }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("switchPreset", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            PresetCommand::DuplicatePreset { new_name, reply } => {
                let model_tx = self.model_tx.clone();
                let preset_manager = self.engines.preset_manager.clone();
                self.engines.preset_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        preset_manager.duplicate_preset(&new_name)
                    })
                    .await;
                    let writeback = match result {
                        Ok(Ok(name)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!(name),
                        },
                        Ok(Err(error)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!({ "error": error }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("duplicatePreset", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            PresetCommand::DeletePreset { name, reply } => {
                let model_tx = self.model_tx.clone();
                let mut preset_manager = self.engines.preset_manager.clone();
                self.engines.preset_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        let result = preset_manager.delete_preset(&name);
                        let current = preset_manager.current_preset().to_string();
                        (result, current)
                    })
                    .await;
                    let writeback = match result {
                        Ok((Ok(ok), current_preset)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::SetCurrentPreset {
                                current_preset: normalize_optional_string(Some(&current_preset)),
                            },
                            reply: Some(reply),
                            response: serde_json::json!(ok),
                        },
                        Ok((Err(error), _)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!({ "error": error }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("deletePreset", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            PresetCommand::ExportPreset {
                dest_path,
                export_name,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let preset_manager = self.engines.preset_manager.clone();
                self.engines.preset_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        preset_manager.export_preset(Path::new(&dest_path), &export_name)
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(())) => serde_json::json!({ "ok": true }),
                        Ok(Err(error)) => serde_json::json!({ "error": error }),
                        Err(error) => background_error_json("exportPreset", error),
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback {
                        writeback: AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response,
                        },
                    });
                });
            }
            PresetCommand::ImportPreset { zip_path, reply } => {
                let model_tx = self.model_tx.clone();
                let mut preset_manager = self.engines.preset_manager.clone();
                self.engines.preset_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        preset_manager.import_preset(Path::new(&zip_path))
                    })
                    .await;
                    let writeback = match result {
                        Ok(Ok(current_preset)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::SetCurrentPreset {
                                current_preset: normalize_optional_string(Some(&current_preset)),
                            },
                            reply: Some(reply),
                            response: serde_json::json!(current_preset),
                        },
                        Ok(Err(error)) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!({ "error": error }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::Preset,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("importPreset", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            PresetCommand::SetCurrentPreset { name } => {
                tracing::debug!("preset: set_current_preset to {}", name);
                self.engines.preset_manager.set_current_preset(&name);
                self.app_config.current_preset =
                    normalize_optional_string(Some(self.engines.preset_manager.current_preset()));
                self.save_app_config();
            }
        }
    }
}
