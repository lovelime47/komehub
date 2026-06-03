use super::*;

impl ModelQueue {
    pub(super) fn handle_effect_command(&mut self, cmd: EffectCommand) {
        match cmd {
            EffectCommand::GetEffects { reply } => {
                let effects = self.engines.effect_manager.get_effects_with_status();
                let _ = reply.send(serde_json::json!(effects));
            }
            EffectCommand::GetEffect { effect_id, reply } => {
                let resp = match self.engines.effect_manager.get_effect(&effect_id) {
                    Some(eff) => serde_json::to_value(eff).unwrap_or_default(),
                    None => serde_json::Value::Null,
                };
                let _ = reply.send(resp);
            }
            EffectCommand::AddEffect { effect, reply } => {
                match serde_json::from_value::<crate::state::scene::EffectDefinition>(effect) {
                    Ok(eff) => {
                        let model_tx = self.model_tx.clone();
                        let mut effect_manager = self.engines.effect_manager.clone();
                        self.engines.effect_io_queue.send(async move {
                            let result =
                                tokio::task::spawn_blocking(move || effect_manager.add_effect(eff))
                                    .await;
                            let writeback = match result {
                                Ok(id) => AsyncWriteback {
                                    queue: EngineQueueKind::EffectIo,
                                    apply: AsyncApply::SyncEffectsToStore,
                                    reply: Some(reply),
                                    response: serde_json::json!(id),
                                },
                                Err(error) => AsyncWriteback {
                                    queue: EngineQueueKind::EffectIo,
                                    apply: AsyncApply::None,
                                    reply: Some(reply),
                                    response: background_error_json("addEffect", error),
                                },
                            };
                            model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                        });
                    }
                    Err(error) => {
                        let _ = reply.send(serde_json::json!({ "error": error.to_string() }));
                    }
                };
            }
            EffectCommand::UpdateEffect { effect, reply } => {
                match serde_json::from_value::<crate::state::scene::EffectDefinition>(effect) {
                    Ok(eff) => {
                        let model_tx = self.model_tx.clone();
                        let mut effect_manager = self.engines.effect_manager.clone();
                        self.engines.effect_io_queue.send(async move {
                            let result = tokio::task::spawn_blocking(move || {
                                effect_manager.update_effect(eff)
                            })
                            .await;
                            let writeback = match result {
                                Ok(ok) => AsyncWriteback {
                                    queue: EngineQueueKind::EffectIo,
                                    apply: if ok {
                                        AsyncApply::SyncEffectsToStore
                                    } else {
                                        AsyncApply::None
                                    },
                                    reply: Some(reply),
                                    response: serde_json::json!(ok),
                                },
                                Err(error) => AsyncWriteback {
                                    queue: EngineQueueKind::EffectIo,
                                    apply: AsyncApply::None,
                                    reply: Some(reply),
                                    response: background_error_json("updateEffect", error),
                                },
                            };
                            model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                        });
                    }
                    Err(error) => {
                        let _ = reply.send(serde_json::json!({ "error": error.to_string() }));
                    }
                };
            }
            EffectCommand::RemoveEffect { effect_id, reply } => {
                let model_tx = self.model_tx.clone();
                let mut effect_manager = self.engines.effect_manager.clone();
                self.engines.effect_io_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        effect_manager.remove_effect(&effect_id)
                    })
                    .await;
                    let writeback = match result {
                        Ok(ok) => AsyncWriteback {
                            queue: EngineQueueKind::EffectIo,
                            apply: if ok {
                                AsyncApply::SyncEffectsToStore
                            } else {
                                AsyncApply::None
                            },
                            reply: Some(reply),
                            response: serde_json::json!(ok),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::EffectIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("removeEffect", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            EffectCommand::DuplicateEffect {
                effect_id,
                new_name,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let mut effect_manager = self.engines.effect_manager.clone();
                self.engines.effect_io_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        effect_manager.duplicate_effect(&effect_id, &new_name)
                    })
                    .await;
                    let writeback = match result {
                        Ok(Some(new_id)) => AsyncWriteback {
                            queue: EngineQueueKind::EffectIo,
                            apply: AsyncApply::SyncEffectsToStore,
                            reply: Some(reply),
                            response: serde_json::json!(new_id),
                        },
                        Ok(None) => AsyncWriteback {
                            queue: EngineQueueKind::EffectIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::Value::Null,
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::EffectIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("duplicateEffect", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            EffectCommand::GetPluginManifests { reply } => {
                let manifests = self.engines.effect_manager.get_plugin_manifests();
                let _ = reply.send(serde_json::json!(manifests));
            }
        }
    }
}
