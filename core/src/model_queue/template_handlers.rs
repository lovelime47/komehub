use super::*;

impl ModelQueue {
    pub(super) fn handle_template_command(
        &mut self,
        cmd: TemplateCommand,
        sse: &SseBroadcaster,
    ) -> bool {
        match cmd {
            TemplateCommand::GetTemplates { reply } => {
                let templates = self.engines.template_manager.get_templates();
                let _ = reply.send(serde_json::json!(templates));
            }
            TemplateCommand::InstallTemplate { zip_path, reply } => {
                let model_tx = self.model_tx.clone();
                let template_manager = self.engines.template_manager.clone();
                self.engines.template_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        template_manager.install_template(std::path::Path::new(&zip_path))
                    })
                    .await;
                    let response = match result {
                        Ok(Ok((info, unsupported_plugins))) => serde_json::json!({
                            "ok": true,
                            "template": info,
                            "unsupportedPlugins": unsupported_plugins,
                        }),
                        Ok(Err(error)) => serde_json::json!({ "ok": false, "error": error }),
                        Err(error) => background_error_json("installTemplate", error),
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
            TemplateCommand::CreateTemplateFromStarter {
                starter_type,
                template_id,
                display_name,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let template_manager = self.engines.template_manager.clone();
                self.engines.template_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        template_manager.create_starter_template(
                            &starter_type,
                            &template_id,
                            &display_name,
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(info)) => serde_json::json!({ "ok": true, "template": info }),
                        Ok(Err(error)) => serde_json::json!({ "ok": false, "error": error }),
                        Err(error) => background_error_json("createTemplateFromStarter", error),
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
            TemplateCommand::CreateTemplateFromBuiltin {
                source_template_id,
                template_id,
                display_name,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let template_manager = self.engines.template_manager.clone();
                self.engines.template_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        template_manager.create_template_from_builtin(
                            &source_template_id,
                            &template_id,
                            &display_name,
                        )
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(info)) => serde_json::json!({ "ok": true, "template": info }),
                        Ok(Err(error)) => serde_json::json!({ "ok": false, "error": error }),
                        Err(error) => background_error_json("createTemplateFromBuiltin", error),
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
            TemplateCommand::RemoveTemplate { name, reply } => {
                let model_tx = self.model_tx.clone();
                let template_manager = self.engines.template_manager.clone();
                self.engines.template_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        template_manager.remove_template(&name)
                    })
                    .await;
                    let response = match result {
                        Ok(ok) => serde_json::json!({ "ok": ok }),
                        Err(error) => background_error_json("removeTemplate", error),
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
            TemplateCommand::GetTemplateDirectory { name, reply } => {
                let path = self
                    .engines
                    .template_manager
                    .get_template_directory(&name)
                    .map(|value| value.to_string_lossy().to_string());
                let _ = reply.send(serde_json::json!({ "path": path }));
            }
            TemplateCommand::GetSceneTemplates { scene_id, reply } => {
                // Template owns the scene-template list UI because it must combine the scene's
                // selected templates with installable template packages.
                let mut changed = false;
                let template_manager = self.engines.template_manager.clone();
                let scene_templates: Vec<crate::state::scene::SceneTemplate> =
                    if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                        changed |= Self::normalize_scene_templates(scene, &template_manager);
                        let snapshot = scene.templates.clone();
                        let selected_template_id = scene.selected_template_id.clone();
                        if changed {
                            let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        }
                        let all_templates = self.engines.template_manager.get_templates();
                        let _ = reply.send(serde_json::json!({
                            "sceneTemplates": snapshot,
                            "availableTemplates": all_templates,
                            "selectedTemplateId": selected_template_id
                        }));
                        return true;
                    } else {
                        Vec::new()
                    };
                let all_templates = self.engines.template_manager.get_templates();
                let _ = reply.send(serde_json::json!({
                    "sceneTemplates": scene_templates,
                    "availableTemplates": all_templates,
                    "selectedTemplateId": ""
                }));
            }
            TemplateCommand::AddSceneTemplate {
                scene_id,
                template_name,
                reply,
            } => {
                let template_id = self
                    .engines
                    .template_manager
                    .resolve_template_id(&template_name)
                    .unwrap_or(template_name);
                let template_defaults = self
                    .engines
                    .template_manager
                    .get_template_default_settings(&template_id);
                let ok = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    if !scene
                        .templates
                        .iter()
                        .any(|t| Self::template_identifier_matches(t, &template_id))
                    {
                        scene.templates.push(crate::state::scene::SceneTemplate {
                            id: template_id.clone(),
                            name: template_id,
                            enabled: true,
                            settings: template_defaults,
                        });
                        crate::state::scene::normalize_scene_selected_template_id(scene);
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                let _ = reply.send(serde_json::json!({ "ok": ok }));
            }
            TemplateCommand::RemoveSceneTemplate {
                scene_id,
                template_name,
                reply,
            } => {
                let template_id = self
                    .engines
                    .template_manager
                    .resolve_template_id(&template_name)
                    .unwrap_or(template_name);
                let ok = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    let before = scene.templates.len();
                    scene
                        .templates
                        .retain(|t| !Self::template_identifier_matches(t, &template_id));
                    if scene.templates.len() != before {
                        crate::state::scene::normalize_scene_selected_template_id(scene);
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                let _ = reply.send(serde_json::json!({ "ok": ok }));
            }
            TemplateCommand::SetSelectedSceneTemplate {
                scene_id,
                template_name,
                reply,
            } => {
                let template_id = self
                    .engines
                    .template_manager
                    .resolve_template_id(&template_name)
                    .unwrap_or(template_name);
                let ok = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    let selected = scene
                        .templates
                        .iter()
                        .find(|t| Self::template_identifier_matches(t, &template_id))
                        .map(|template| {
                            if !template.id.is_empty() {
                                template.id.clone()
                            } else {
                                template.name.clone()
                            }
                        });
                    if let Some(selected_id) = selected {
                        scene.selected_template_id = selected_id;
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                let _ = reply.send(serde_json::json!({ "ok": ok }));
            }
            TemplateCommand::SetSceneTemplateEnabled {
                scene_id,
                template_name,
                enabled,
                reply,
            } => {
                let template_id = self
                    .engines
                    .template_manager
                    .resolve_template_id(&template_name)
                    .unwrap_or(template_name);
                let ok = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    if let Some(index) = scene
                        .templates
                        .iter()
                        .position(|t| Self::template_identifier_matches(t, &template_id))
                    {
                        let was_selected = {
                            let template = &scene.templates[index];
                            scene.selected_template_id == template.id
                                || scene.selected_template_id == template.name
                        };
                        let tmpl = &mut scene.templates[index];
                        tmpl.id = template_id.clone();
                        tmpl.name = template_id;
                        tmpl.enabled = enabled;
                        if was_selected && !enabled {
                            crate::state::scene::normalize_scene_selected_template_id(scene);
                        }
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                let _ = reply.send(serde_json::json!({ "ok": ok }));
            }
        }
        true
    }
}
