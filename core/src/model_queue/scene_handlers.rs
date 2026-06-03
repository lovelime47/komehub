use super::*;

impl ModelQueue {
    pub(super) fn handle_scene_command(&mut self, cmd: SceneCommand, sse: &Arc<SseBroadcaster>) {
        match cmd {
            SceneCommand::GetSceneList { reply } => {
                let data = serde_json::to_value(self.main_store.scenes.scene_list_items())
                    .unwrap_or_default();
                let _ = reply.send(data);
            }
            SceneCommand::GetScenes { reply } => {
                let data = serde_json::to_value(&self.main_store.scenes).unwrap_or_default();
                let _ = reply.send(data);
            }
            SceneCommand::ReloadScenes => {
                let model_tx = self.model_tx.clone();
                let scene_manager = self.engines.scene_manager.clone();
                self.engines.scene_io_queue.send(async move {
                    let result =
                        tokio::task::spawn_blocking(move || scene_manager.load_all()).await;
                    let writeback = match result {
                        Ok(scenes) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::ReplaceScenes {
                                scenes,
                                sync_effects: true,
                            },
                            reply: None,
                            response: serde_json::json!({ "ok": true }),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::None,
                            reply: None,
                            response: background_error_json("reloadScenes", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            SceneCommand::CreateSceneWithGeneratedId { name, reply } => {
                let scene_id = self.engines.scene_manager.generate_scene_id(&name);
                let resp = match self.engines.scene_manager.create_scene(&scene_id, &name) {
                    Ok(scene) => {
                        self.main_store
                            .scenes
                            .scenes
                            .insert(scene_id.clone(), scene);
                        // 重複ガード: 復元後の sceneOrder.json に残骸が残っていた等の理由で
                        // 同 id が既に scene_order にある場合は再追加しない (= UI 重複防止)
                        if !self.main_store.scenes.scene_order.contains(&scene_id) {
                            self.main_store.scenes.scene_order.push(scene_id.clone());
                        }
                        let _ = self
                            .engines
                            .scene_manager
                            .save_scene_order(&self.main_store.scenes.scene_order);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!(scene_id)
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::CreateScene {
                scene_id,
                name,
                reply,
            } => {
                let resp = match self.engines.scene_manager.create_scene(&scene_id, &name) {
                    Ok(scene) => {
                        self.main_store
                            .scenes
                            .scenes
                            .insert(scene_id.clone(), scene);
                        // 重複ガード (= 同上、 UI 重複防止)
                        if !self.main_store.scenes.scene_order.contains(&scene_id) {
                            self.main_store.scenes.scene_order.push(scene_id);
                        }
                        let _ = self
                            .engines
                            .scene_manager
                            .save_scene_order(&self.main_store.scenes.scene_order);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!({ "ok": true })
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::DeleteScene { scene_id, reply } => {
                let resp = match self.engines.scene_manager.delete_scene(&scene_id) {
                    Ok(()) => {
                        self.main_store.scenes.scenes.remove(&scene_id);
                        self.main_store
                            .scenes
                            .scene_order
                            .retain(|id| id != &scene_id);
                        let _ = self
                            .engines
                            .scene_manager
                            .save_scene_order(&self.main_store.scenes.scene_order);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!({ "ok": true })
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::DuplicateSceneWithGeneratedId {
                source_id,
                new_name,
                reply,
            } => {
                let new_id = self
                    .engines
                    .scene_manager
                    .generate_duplicate_scene_id(&new_name);
                let resp = match self
                    .engines
                    .scene_manager
                    .duplicate_scene(&source_id, &new_id, &new_name)
                {
                    Ok(scene) => {
                        self.main_store.scenes.scenes.insert(new_id.clone(), scene);
                        let insert_idx = self
                            .main_store
                            .scenes
                            .scene_order
                            .iter()
                            .position(|id| id == &source_id)
                            .map(|i| i + 1)
                            .unwrap_or(self.main_store.scenes.scene_order.len());
                        self.main_store
                            .scenes
                            .scene_order
                            .insert(insert_idx, new_id.clone());
                        let _ = self
                            .engines
                            .scene_manager
                            .save_scene_order(&self.main_store.scenes.scene_order);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!(new_id)
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::DuplicateScene {
                source_id,
                new_id,
                new_name,
                reply,
            } => {
                let resp = match self
                    .engines
                    .scene_manager
                    .duplicate_scene(&source_id, &new_id, &new_name)
                {
                    Ok(scene) => {
                        self.main_store.scenes.scenes.insert(new_id.clone(), scene);
                        // 元シーンの直後に挿入
                        let insert_idx = self
                            .main_store
                            .scenes
                            .scene_order
                            .iter()
                            .position(|id| id == &source_id)
                            .map(|i| i + 1)
                            .unwrap_or(self.main_store.scenes.scene_order.len());
                        self.main_store
                            .scenes
                            .scene_order
                            .insert(insert_idx, new_id);
                        let _ = self
                            .engines
                            .scene_manager
                            .save_scene_order(&self.main_store.scenes.scene_order);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!({ "ok": true })
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::RenameScene {
                scene_id,
                new_name,
                reply,
            } => {
                let resp = match self.engines.scene_manager.rename_scene(
                    &scene_id,
                    &new_name,
                    &mut self.main_store.scenes,
                ) {
                    Ok(()) => {
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!({ "ok": true })
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::SaveScene {
                scene_id,
                scene,
                reply,
            } => {
                let resp = match self.engines.scene_manager.save_scene(&scene_id, &scene) {
                    Ok(()) => {
                        self.main_store.scenes.scenes.insert(scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!({ "ok": true })
                    }
                    Err(e) => serde_json::json!({ "error": e }),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::ReorderScenes { order } => {
                self.main_store.scenes.scene_order = order.clone();
                let _ = self.engines.scene_manager.save_scene_order(&order);
                sse.push_static_update("scenes", &self.main_store.scenes);
            }
            SceneCommand::SetActiveScene { scene_id } => {
                tracing::debug!("scene: set_active to {}", scene_id);
                self.main_store.scenes.active_scene_id = Some(scene_id);
                sse.push_static_update("scenes", &self.main_store.scenes);
            }
            SceneCommand::SetSceneEnabled {
                scene_id,
                enabled,
                reply,
            } => {
                tracing::debug!(
                    "scene: set_enabled scene_id={} enabled={}",
                    scene_id,
                    enabled
                );
                let resp = match self.main_store.scenes.scenes.get_mut(&scene_id) {
                    Some(scene) => {
                        scene.enabled = enabled;
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        serde_json::json!(true)
                    }
                    None => serde_json::json!(false),
                };
                if resp == serde_json::json!(true) {
                    sse.push_static_update("scenes", &self.main_store.scenes);
                    if let Some(scene) = self.main_store.scenes.scenes.get(&scene_id) {
                        Self::push_scene_template_configs(
                            &scene_id,
                            scene,
                            sse,
                            &self.engines.template_manager,
                        );
                    }
                }
                let _ = reply.send(resp);
            }
            SceneCommand::SetSceneTemplatesEnabled {
                scene_id,
                enabled,
                reply,
            } => {
                let resp = match self.main_store.scenes.scenes.get_mut(&scene_id) {
                    Some(scene) => {
                        scene.templates_enabled = enabled;
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        serde_json::json!(true)
                    }
                    None => serde_json::json!(false),
                };
                if resp == serde_json::json!(true) {
                    sse.push_static_update("scenes", &self.main_store.scenes);
                    if let Some(scene) = self.main_store.scenes.scenes.get(&scene_id) {
                        Self::push_scene_template_configs(
                            &scene_id,
                            scene,
                            sse,
                            &self.engines.template_manager,
                        );
                    }
                }
                let _ = reply.send(resp);
            }
            SceneCommand::SetSceneTemplateConfig {
                scene_id,
                template_name,
                settings,
                reply,
            } => {
                let template_id = self
                    .engines
                    .template_manager
                    .resolve_template_id(&template_name)
                    .unwrap_or(template_name);
                let ui_schema_keys = self
                    .engines
                    .template_manager
                    .get_template_ui_schema_keys(&template_id);
                let ui_schema_defaults = self
                    .engines
                    .template_manager
                    .get_template_default_settings(&template_id);
                let result = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    if let Some(tmpl) = scene
                        .templates
                        .iter_mut()
                        .find(|t| Self::template_identifier_matches(t, &template_id))
                    {
                        let scene_enabled = scene.enabled;
                        let templates_enabled = scene.templates_enabled;
                        if let Some(obj) = settings.as_object() {
                            for (k, v) in obj {
                                tmpl.settings.insert(k.clone(), v.clone());
                            }
                        }
                        crate::state::scene::normalize_template_settings_map_in_place(
                            &mut tmpl.settings,
                        );
                        tmpl.id = template_id.clone();
                        tmpl.name = template_id.clone();
                        let template_id_snapshot = tmpl.id.clone();
                        let reconciled =
                            crate::state::scene::reconcile_template_settings_with_ui_schema(
                                &tmpl.settings,
                                &ui_schema_keys,
                                &ui_schema_defaults,
                            );
                        let config_snapshot = Self::build_template_config_from_parts(
                            &reconciled,
                            scene_enabled,
                            templates_enabled,
                            tmpl.enabled,
                        );
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        Some((config_snapshot, template_id_snapshot))
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some((config, template_id)) = &result {
                    sse.push_static_update("scenes", &self.main_store.scenes);
                    sse.push_template_config(&scene_id, template_id, config);
                }
                let _ = reply.send(serde_json::json!({ "ok": result.is_some() }));
            }
            SceneCommand::GetSceneTemplateSettings {
                scene_id,
                template_name,
                reply,
            } => {
                // Scene owns template settings because the values are embedded in each scene file.
                // Template package metadata stays in TemplateManager; this command reconciles both.
                let template_id = self
                    .engines
                    .template_manager
                    .resolve_template_id(&template_name)
                    .unwrap_or(template_name);
                let ui_schema_keys = self
                    .engines
                    .template_manager
                    .get_template_ui_schema_keys(&template_id);
                let ui_schema_defaults = self
                    .engines
                    .template_manager
                    .get_template_default_settings(&template_id);
                let mut changed = false;
                let settings = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id)
                {
                    let scene_enabled = scene.enabled;
                    let templates_enabled = scene.templates_enabled;
                    let settings = scene
                        .templates
                        .iter_mut()
                        .find(|t| Self::template_identifier_matches(t, &template_id))
                        .map(|t| {
                            if t.id != template_id || t.name != template_id {
                                t.id = template_id.clone();
                                t.name = template_id.clone();
                                changed = true;
                            }
                            changed |=
                                crate::state::scene::normalize_template_settings_map_in_place(
                                    &mut t.settings,
                                );
                            let reconciled =
                                crate::state::scene::reconcile_template_settings_with_ui_schema(
                                    &t.settings,
                                    &ui_schema_keys,
                                    &ui_schema_defaults,
                                );
                            Self::build_template_config_from_parts(
                                &reconciled,
                                scene_enabled,
                                templates_enabled,
                                t.enabled,
                            )
                        })
                        .unwrap_or(serde_json::json!({}));
                    if changed {
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                    }
                    settings
                } else {
                    serde_json::json!({})
                };
                let _ = reply.send(settings);
            }
            SceneCommand::GetTemplateManifests { reply } => {
                // Manifest reads live here with manifest writes because saves can rewrite scene
                // template references when a template id changes.
                let manifests = self.engines.template_manager.get_template_manifests();
                let _ = reply.send(serde_json::to_value(&manifests).unwrap_or_default());
            }
            SceneCommand::GetTemplateManifest { name, reply } => {
                let manifest = self.engines.template_manager.get_template_manifest(&name);
                let _ = reply.send(serde_json::json!({ "manifest": manifest }));
            }
            SceneCommand::SaveTemplateManifest {
                name,
                manifest,
                reply,
            } => {
                // Saving a template manifest can rename the canonical template id. Scene references
                // must be normalized in the same queue turn as the manifest write.
                let result = self
                    .engines
                    .template_manager
                    .save_template_manifest(&name, &manifest);
                match result {
                    Ok(saved) => {
                        let scene_ids: Vec<String> =
                            self.main_store.scenes.scenes.keys().cloned().collect();
                        let mut changed_scene_ids = Vec::new();
                        for scene_id in scene_ids {
                            let mut changed = false;
                            if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                                changed |= Self::rename_scene_template_references(
                                    scene,
                                    &saved.previous_template_id,
                                    &saved.template_id,
                                );
                                changed |= Self::normalize_scene_templates(
                                    scene,
                                    &self.engines.template_manager,
                                );
                                if changed {
                                    let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                                    changed_scene_ids.push(scene_id.clone());
                                }
                            }
                        }
                        if !changed_scene_ids.is_empty() {
                            sse.push_static_update("scenes", &self.main_store.scenes);
                            for scene_id in changed_scene_ids {
                                if let Some(scene) = self.main_store.scenes.scenes.get(&scene_id) {
                                    Self::push_scene_template_configs(
                                        &scene_id,
                                        scene,
                                        sse,
                                        &self.engines.template_manager,
                                    );
                                }
                            }
                        }
                        let _ = reply.send(serde_json::json!({
                            "ok": true,
                            "templateId": saved.template_id,
                            "previousTemplateId": saved.previous_template_id,
                            "displayName": saved.display_name,
                            "manifest": saved.manifest
                        }));
                    }
                    Err(error) => {
                        let _ = reply.send(serde_json::json!({ "ok": false, "error": error }));
                    }
                }
            }
            SceneCommand::ImportTemplateBundledFont {
                name,
                src_path,
                family,
                reply,
            } => {
                let result = self.engines.template_manager.import_bundled_font_source(
                    &name,
                    std::path::Path::new(&src_path),
                    &family,
                );
                match result {
                    Ok(imported) => {
                        let _ = reply.send(serde_json::json!({
                            "ok": true,
                            "imports": imported.imports,
                        }));
                    }
                    Err(error) => {
                        let _ = reply.send(serde_json::json!({ "ok": false, "error": error }));
                    }
                }
            }
            SceneCommand::EnsureTemplateFonts {
                fonts,
                progress_callback,
                reply,
            } => {
                let media_cache_dir = self.media_cache_dir.clone();
                self.engines.template_queue.send(async move {
                    let response = crate::engine::template_aux_io::ensure_template_fonts(
                        &media_cache_dir,
                        &fonts,
                        progress_callback,
                    )
                    .await;
                    let _ = reply.send(response);
                });
            }

            // --- PerformanceCrudSurface ---
            SceneCommand::GetPerformances { scene_id, reply } => {
                let resp = match self.main_store.scenes.scenes.get(&scene_id) {
                    Some(scene) => serde_json::to_value(&scene.performances).unwrap_or_default(),
                    None => serde_json::json!([]),
                };
                let _ = reply.send(resp);
            }
            SceneCommand::SavePerformance {
                scene_id,
                performance,
                reply,
            } => {
                let resp =
                    match serde_json::from_value::<crate::state::scene::Performance>(performance) {
                        Ok(perf) => {
                            if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                                // 既存なら更新、なければ追加
                                if let Some(existing) =
                                    scene.performances.iter_mut().find(|p| p.id == perf.id)
                                {
                                    *existing = perf;
                                } else {
                                    scene.performances.push(perf);
                                }
                                let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                                sse.push_static_update("scenes", &self.main_store.scenes);
                                serde_json::json!(true)
                            } else {
                                serde_json::json!(false)
                            }
                        }
                        Err(e) => serde_json::json!({ "error": e.to_string() }),
                    };
                let _ = reply.send(resp);
            }
            SceneCommand::DeletePerformance {
                scene_id,
                performance_id,
                reply,
            } => {
                let resp = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    let before = scene.performances.len();
                    scene.performances.retain(|p| p.id != performance_id);
                    if scene.performances.len() < before {
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!(true)
                    } else {
                        serde_json::json!(false)
                    }
                } else {
                    serde_json::json!(false)
                };
                let _ = reply.send(resp);
            }
            SceneCommand::SetPerformanceEnabled {
                scene_id,
                performance_id,
                enabled,
                reply,
            } => {
                let resp = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    if let Some(perf) = scene
                        .performances
                        .iter_mut()
                        .find(|p| p.id == performance_id)
                    {
                        perf.enabled = enabled;
                        let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                        sse.push_static_update("scenes", &self.main_store.scenes);
                        serde_json::json!(true)
                    } else {
                        serde_json::json!(false)
                    }
                } else {
                    serde_json::json!(false)
                };
                let _ = reply.send(resp);
            }
            SceneCommand::ReorderPerformances {
                scene_id,
                ordered_ids,
                reply,
            } => {
                let resp = if let Some(scene) = self.main_store.scenes.scenes.get_mut(&scene_id) {
                    let mut reordered = Vec::new();
                    for id in &ordered_ids {
                        if let Some(perf) = scene.performances.iter().find(|p| &p.id == id) {
                            reordered.push(perf.clone());
                        }
                    }
                    // ordered_ids に含まれないものは末尾に追加
                    for perf in &scene.performances {
                        if !ordered_ids.contains(&perf.id) {
                            reordered.push(perf.clone());
                        }
                    }
                    scene.performances = reordered;
                    let _ = self.engines.scene_manager.save_scene(&scene_id, scene);
                    sse.push_static_update("scenes", &self.main_store.scenes);
                    serde_json::json!(true)
                } else {
                    serde_json::json!(false)
                };
                let _ = reply.send(resp);
            }
            // --- AppConfigSurface ---
            SceneCommand::SetAppRootDir { dir } => {
                self.main_store.app_root_dir = PathBuf::from(dir);
                tracing::info!("App root dir: {:?}", self.main_store.app_root_dir);
            }
            SceneCommand::SetActiveSceneAndSave { scene_id } => {
                tracing::debug!("scene: set_active_and_save to {}", scene_id);
                self.main_store.scenes.active_scene_id = Some(scene_id.clone());
                sse.push_static_update("scenes", &self.main_store.scenes);
                self.app_config.active_scene_id = normalize_optional_string(Some(&scene_id));
                self.save_app_config();
            }
            SceneCommand::GetActiveScene { reply } => {
                let active = self
                    .main_store
                    .scenes
                    .active_scene_id
                    .clone()
                    .unwrap_or_default();
                let _ = reply.send(serde_json::json!(active));
            }
            SceneCommand::RestoreDefaultScene { scene_id, reply } => {
                let model_tx = self.model_tx.clone();
                let scene_id_for_worker = scene_id.clone();
                let defaults_dir = self
                    .main_store
                    .app_root_dir
                    .join("electron")
                    .join("defaults");
                let scenes_dir = self.engines.scene_manager.scenes_dir().to_path_buf();
                self.engines.scene_io_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        let mut scratch = crate::state::scene::SceneStore::new();
                        restore_default_scene(
                            &scene_id_for_worker,
                            &defaults_dir,
                            &scenes_dir,
                            &mut scratch,
                        )
                    })
                    .await;
                    let writeback = match result {
                        Ok(Ok(())) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::ReloadScenesAndSyncEffects,
                            reply: Some(reply),
                            response: serde_json::json!(true),
                        },
                        Ok(Err(_)) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::json!(false),
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("restoreDefaultScene", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
            SceneCommand::CheckDefaultTemplateContext { effect_id, reply } => {
                let defaults_dir = self
                    .main_store
                    .app_root_dir
                    .join("electron")
                    .join("defaults");
                let has_context = check_default_template_context(&effect_id, &defaults_dir);
                let _ = reply.send(serde_json::json!(has_context));
            }
            SceneCommand::CopyPerformanceAsset {
                scene_id,
                src_path,
                performance_id,
                reply,
            } => {
                let model_tx = self.model_tx.clone();
                let perf_dir = self
                    .engines
                    .scene_manager
                    .scenes_dir()
                    .join(&scene_id)
                    .join("performances");
                self.engines.scene_io_queue.send(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        copy_performance_asset(&src_path, &perf_dir, &performance_id)
                    })
                    .await;
                    let writeback = match result {
                        Ok(Some(value)) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: value,
                        },
                        Ok(None) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: serde_json::Value::Null,
                        },
                        Err(error) => AsyncWriteback {
                            queue: EngineQueueKind::SceneIo,
                            apply: AsyncApply::None,
                            reply: Some(reply),
                            response: background_error_json("copyPerformanceAsset", error),
                        },
                    };
                    model_tx.send(ModelCommand::ApplyAsyncWriteback { writeback });
                });
            }
        }
    }
}
