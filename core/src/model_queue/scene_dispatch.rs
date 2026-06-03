use super::*;

impl ModelQueue {
    pub(super) fn dispatch_scene_command(
        &mut self,
        cmd: ModelCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            ModelCommand::GetSceneList { reply } => {
                self.handle_scene_command(SceneCommand::GetSceneList { reply }, sse);
            }
            ModelCommand::GetScenes { reply } => {
                self.handle_scene_command(SceneCommand::GetScenes { reply }, sse);
            }
            ModelCommand::ReloadScenes => {
                self.handle_scene_command(SceneCommand::ReloadScenes, sse);
            }
            ModelCommand::CreateSceneWithGeneratedId { name, reply } => {
                self.handle_scene_command(
                    SceneCommand::CreateSceneWithGeneratedId { name, reply },
                    sse,
                );
            }
            ModelCommand::CreateScene {
                scene_id,
                name,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::CreateScene {
                        scene_id,
                        name,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::DeleteScene { scene_id, reply } => {
                self.handle_scene_command(SceneCommand::DeleteScene { scene_id, reply }, sse);
            }
            ModelCommand::DuplicateSceneWithGeneratedId {
                source_id,
                new_name,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::DuplicateSceneWithGeneratedId {
                        source_id,
                        new_name,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::DuplicateScene {
                source_id,
                new_id,
                new_name,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::DuplicateScene {
                        source_id,
                        new_id,
                        new_name,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::RenameScene {
                scene_id,
                new_name,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::RenameScene {
                        scene_id,
                        new_name,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::SaveScene {
                scene_id,
                scene,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SaveScene {
                        scene_id,
                        scene,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::ReorderScenes { order } => {
                self.handle_scene_command(SceneCommand::ReorderScenes { order }, sse);
            }
            ModelCommand::SetActiveScene { scene_id } => {
                self.handle_scene_command(SceneCommand::SetActiveScene { scene_id }, sse);
            }
            ModelCommand::SetSceneEnabled {
                scene_id,
                enabled,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SetSceneEnabled {
                        scene_id,
                        enabled,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::SetSceneTemplatesEnabled {
                scene_id,
                enabled,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SetSceneTemplatesEnabled {
                        scene_id,
                        enabled,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::SetSceneTemplateConfig {
                scene_id,
                template_name,
                settings,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SetSceneTemplateConfig {
                        scene_id,
                        template_name,
                        settings,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::GetSceneTemplateSettings {
                scene_id,
                template_name,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::GetSceneTemplateSettings {
                        scene_id,
                        template_name,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::GetTemplateManifests { reply } => {
                self.handle_scene_command(SceneCommand::GetTemplateManifests { reply }, sse);
            }
            ModelCommand::GetTemplateManifest { name, reply } => {
                self.handle_scene_command(SceneCommand::GetTemplateManifest { name, reply }, sse);
            }
            ModelCommand::SaveTemplateManifest {
                name,
                manifest,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SaveTemplateManifest {
                        name,
                        manifest,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::ImportTemplateBundledFont {
                name,
                src_path,
                family,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::ImportTemplateBundledFont {
                        name,
                        src_path,
                        family,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::EnsureTemplateFonts {
                fonts,
                progress_callback,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::EnsureTemplateFonts {
                        fonts,
                        progress_callback,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::GetPerformances { scene_id, reply } => {
                self.handle_scene_command(SceneCommand::GetPerformances { scene_id, reply }, sse);
            }
            ModelCommand::SavePerformance {
                scene_id,
                performance,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SavePerformance {
                        scene_id,
                        performance,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::DeletePerformance {
                scene_id,
                performance_id,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::DeletePerformance {
                        scene_id,
                        performance_id,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::SetPerformanceEnabled {
                scene_id,
                performance_id,
                enabled,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::SetPerformanceEnabled {
                        scene_id,
                        performance_id,
                        enabled,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::ReorderPerformances {
                scene_id,
                ordered_ids,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::ReorderPerformances {
                        scene_id,
                        ordered_ids,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::SetAppRootDir { dir } => {
                self.handle_scene_command(SceneCommand::SetAppRootDir { dir }, sse);
            }
            ModelCommand::SetActiveSceneAndSave { scene_id } => {
                self.handle_scene_command(SceneCommand::SetActiveSceneAndSave { scene_id }, sse);
            }
            ModelCommand::GetActiveScene { reply } => {
                self.handle_scene_command(SceneCommand::GetActiveScene { reply }, sse);
            }
            ModelCommand::RestoreDefaultScene { scene_id, reply } => {
                self.handle_scene_command(
                    SceneCommand::RestoreDefaultScene { scene_id, reply },
                    sse,
                );
            }
            ModelCommand::CheckDefaultTemplateContext { effect_id, reply } => {
                self.handle_scene_command(
                    SceneCommand::CheckDefaultTemplateContext { effect_id, reply },
                    sse,
                );
            }
            ModelCommand::CopyPerformanceAsset {
                scene_id,
                src_path,
                performance_id,
                reply,
            } => {
                self.handle_scene_command(
                    SceneCommand::CopyPerformanceAsset {
                        scene_id,
                        src_path,
                        performance_id,
                        reply,
                    },
                    sse,
                );
            }
            _ => unreachable!("non-scene ModelCommand routed to dispatch_scene_command"),
        }
        true
    }
}
