use super::*;

impl ModelQueue {
    /// Route a public `ModelCommand` to the domain handler that owns its state mutation.
    ///
    /// Keep this match exhaustive. Do not add a wildcard arm: new command variants should fail
    /// to compile until their ownership is decided here. Handlers may use narrower command enums
    /// when a domain is ready for compile-time coverage inside the handler as well.
    pub(super) async fn dispatch_command(
        &mut self,
        cmd: ModelCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            cmd @ (ModelCommand::ApplyAsyncWriteback { .. }
            | ModelCommand::ApplyAsyncWritebackSync { .. }
            | ModelCommand::IncomingCommentsJson { .. }
            | ModelCommand::IncomingInnertubeActions { .. }
            | ModelCommand::IncomingComments { .. }
            | ModelCommand::CacheCommentImages { .. }
            | ModelCommand::GetRecentComments { .. }
            | ModelCommand::GetLiveStreamStats { .. }
            | ModelCommand::IncomingReaction { .. }
            | ModelCommand::CommentDeleted { .. }
            | ModelCommand::ConnectionStateChanged { .. }
            | ModelCommand::AnnounceStreamOwner { .. }) => {
                if !self.dispatch_realtime_command(cmd, sse).await {
                    return false;
                }
            }
            cmd @ (ModelCommand::GetOwnerChannels { .. }
            | ModelCommand::IsListenerDbDirty { .. }
            | ModelCommand::SetOwnerChannels { .. }
            | ModelCommand::GetListeners { .. }
            | ModelCommand::GetListenersActivity { .. }
            | ModelCommand::GetListenerDetail { .. }
            | ModelCommand::UpdateStreamMetadata { .. }
            | ModelCommand::UpdateListenerMetadata { .. }
            | ModelCommand::SetListenerGreeted { .. }
            | ModelCommand::SetListenerHidden { .. }
            | ModelCommand::SetCommentResponded { .. }
            | ModelCommand::DeleteListeners { .. }
            | ModelCommand::DeleteStreams { .. }
            | ModelCommand::GetStreams { .. }
            | ModelCommand::GetStreamDetail { .. }
            | ModelCommand::SearchComments { .. }
            | ModelCommand::ListStreamListeners { .. }
            | ModelCommand::GetStreamStats { .. }
            | ModelCommand::GetCommentChipCounts { .. }
            | ModelCommand::GetListenerChipCounts { .. }
            | ModelCommand::ListListenerSuperchats { .. }
            | ModelCommand::ListListenerCommentsInStream { .. }
            | ModelCommand::GetListenerSearchRankCounts { .. }
            | ModelCommand::GetStreamScopedListenerCounts { .. }
            | ModelCommand::GetStreamListenerPillCounts { .. }
            | ModelCommand::GetListenerTags { .. }
            | ModelCommand::SetListenerTags { .. }
            | ModelCommand::ListAllListenerTags { .. }
            | ModelCommand::ListAllListenerTagAssignments { .. }
            | ModelCommand::GetStreamTags { .. }
            | ModelCommand::SetStreamTags { .. }
            | ModelCommand::ListAllStreamTags { .. }
            | ModelCommand::ListAllStreamTagAssignments { .. }
            | ModelCommand::RenameStreamTag { .. }
            | ModelCommand::DeleteStreamTag { .. }
            | ModelCommand::RenameListenerTag { .. }
            | ModelCommand::DeleteListenerTag { .. }
            | ModelCommand::ListSavedSearches { .. }
            | ModelCommand::CreateSavedSearch { .. }
            | ModelCommand::UpdateSavedSearch { .. }
            | ModelCommand::DeleteSavedSearch { .. }
            | ModelCommand::ExportKomehubJsonl { .. }
            | ModelCommand::ImportKomehubJsonl { .. }
            | ModelCommand::ImportFromOnecomme { .. }
            | ModelCommand::BackfillStreamMeta
            | ModelCommand::ExportToOnecomme { .. }
            | ModelCommand::DetectOnecommeRunning { .. }
            | ModelCommand::RunBidirectionalSync { .. }
            | ModelCommand::ResetOnecommeWatermarks { .. }
            | ModelCommand::SendTemplateTestComment { .. }) => {
                if !self.dispatch_listener_command(cmd, sse) {
                    return false;
                }
            }
            cmd @ (ModelCommand::TriggerPerformance { .. }
            | ModelCommand::TriggerTest { .. }
            | ModelCommand::TriggerTestWithContext { .. }
            | ModelCommand::TriggerTestReaction { .. }
            | ModelCommand::TriggerTestReactionCustom { .. }
            | ModelCommand::ClearPerformances { .. }
            | ModelCommand::SetPaused { .. }
            | ModelCommand::GetPaused { .. }
            | ModelCommand::GetHiddenListeners { .. }
            | ModelCommand::SetHiddenListeners { .. }
            | ModelCommand::GetGlobalCooldown { .. }
            | ModelCommand::UpdateGlobalCooldown { .. }
            | ModelCommand::GetMembershipGiftPricing { .. }
            | ModelCommand::SetMembershipGiftPricing { .. }
            | ModelCommand::GetListenerClassificationConfig { .. }
            | ModelCommand::UpdateListenerClassificationConfig { .. }
            | ModelCommand::GetTtsSettings { .. }
            | ModelCommand::SetTtsSettings { .. }
            | ModelCommand::GetTtsState { .. }
            | ModelCommand::SetTtsEnabled { .. }
            | ModelCommand::SetTtsPaused { .. }
            | ModelCommand::ClearTts { .. }
            | ModelCommand::GetNotificationSettings { .. }
            | ModelCommand::SetNotificationSettings { .. }
            | ModelCommand::SetNotificationEnabled { .. }
            | ModelCommand::SetNotificationPaused { .. }
            | ModelCommand::EvaluateReaction { .. }
            | ModelCommand::HasReactionTrigger { .. }) => {
                if !self.dispatch_performance_command(cmd, sse) {
                    return false;
                }
            }
            cmd @ (ModelCommand::GetSceneList { .. }
            | ModelCommand::GetScenes { .. }
            | ModelCommand::ReloadScenes
            | ModelCommand::CreateSceneWithGeneratedId { .. }
            | ModelCommand::CreateScene { .. }
            | ModelCommand::DeleteScene { .. }
            | ModelCommand::DuplicateSceneWithGeneratedId { .. }
            | ModelCommand::DuplicateScene { .. }
            | ModelCommand::RenameScene { .. }
            | ModelCommand::SaveScene { .. }
            | ModelCommand::ReorderScenes { .. }
            | ModelCommand::SetActiveScene { .. }
            | ModelCommand::SetSceneEnabled { .. }
            | ModelCommand::SetSceneTemplatesEnabled { .. }
            | ModelCommand::SetSceneTemplateConfig { .. }
            | ModelCommand::GetSceneTemplateSettings { .. }
            | ModelCommand::GetTemplateManifests { .. }
            | ModelCommand::GetTemplateManifest { .. }
            | ModelCommand::SaveTemplateManifest { .. }
            | ModelCommand::ImportTemplateBundledFont { .. }
            | ModelCommand::EnsureTemplateFonts { .. }
            | ModelCommand::GetPerformances { .. }
            | ModelCommand::SavePerformance { .. }
            | ModelCommand::DeletePerformance { .. }
            | ModelCommand::SetPerformanceEnabled { .. }
            | ModelCommand::ReorderPerformances { .. }
            | ModelCommand::SetAppRootDir { .. }
            | ModelCommand::SetActiveSceneAndSave { .. }
            | ModelCommand::GetActiveScene { .. }
            | ModelCommand::RestoreDefaultScene { .. }
            | ModelCommand::CheckDefaultTemplateContext { .. }
            | ModelCommand::CopyPerformanceAsset { .. }) => {
                // Scene owns template settings that are embedded in scenes, template manifest saves
                // that must rewrite scene references, and performance CRUD stored under scenes.
                if !self.dispatch_scene_command(cmd, sse) {
                    return false;
                }
            }
            ModelCommand::GetPresetList { reply } => {
                self.handle_preset_command(PresetCommand::GetPresetList { reply });
            }
            ModelCommand::GetCurrentPreset { reply } => {
                self.handle_preset_command(PresetCommand::GetCurrentPreset { reply });
            }
            ModelCommand::SwitchPreset { name, reply } => {
                self.handle_preset_command(PresetCommand::SwitchPreset { name, reply });
            }
            ModelCommand::DuplicatePreset { new_name, reply } => {
                self.handle_preset_command(PresetCommand::DuplicatePreset { new_name, reply });
            }
            ModelCommand::DeletePreset { name, reply } => {
                self.handle_preset_command(PresetCommand::DeletePreset { name, reply });
            }
            ModelCommand::ExportPreset {
                dest_path,
                export_name,
                reply,
            } => {
                self.handle_preset_command(PresetCommand::ExportPreset {
                    dest_path,
                    export_name,
                    reply,
                });
            }
            ModelCommand::ImportPreset { zip_path, reply } => {
                self.handle_preset_command(PresetCommand::ImportPreset { zip_path, reply });
            }
            ModelCommand::SetCurrentPreset { name } => {
                self.handle_preset_command(PresetCommand::SetCurrentPreset { name });
            }

            ModelCommand::GetBackupList { reply } => {
                self.handle_backup_command(BackupCommand::GetBackupList { reply }, sse);
            }
            ModelCommand::CreateBackup { options, reply } => {
                self.handle_backup_command(BackupCommand::CreateBackup { options, reply }, sse);
            }
            ModelCommand::CreateFullBackup { name, reply } => {
                self.handle_backup_command(BackupCommand::CreateFullBackup { name, reply }, sse);
            }
            ModelCommand::DeleteBackup { backup_id, reply } => {
                self.handle_backup_command(BackupCommand::DeleteBackup { backup_id, reply }, sse);
            }
            ModelCommand::RestoreBackup { backup_id, reply } => {
                self.handle_backup_command(BackupCommand::RestoreBackup { backup_id, reply }, sse);
            }
            ModelCommand::GetBackupsDir { reply } => {
                self.handle_backup_command(BackupCommand::GetBackupsDir { reply }, sse);
            }
            ModelCommand::SetBackupsDir { dir } => {
                self.handle_backup_command(BackupCommand::SetBackupsDir { dir }, sse);
            }
            ModelCommand::GetDataOverview { reply } => {
                self.handle_backup_command(BackupCommand::GetDataOverview { reply }, sse);
            }
            ModelCommand::ConfirmUpgradeEffect {
                zip_path,
                effect_id,
                reply,
            } => {
                self.handle_backup_command(
                    BackupCommand::ConfirmUpgradeEffect {
                        zip_path,
                        effect_id,
                        reply,
                    },
                    sse,
                );
            }

            cmd @ (ModelCommand::ImportEffect { .. }
            | ModelCommand::ImportScene { .. }
            | ModelCommand::ImportPerformance { .. }
            | ModelCommand::ExportScene { .. }
            | ModelCommand::ExportPerformance { .. }
            | ModelCommand::ExportEffect { .. }
            | ModelCommand::ExportTemplate { .. }) => {
                if !self.dispatch_import_export_command(cmd) {
                    return false;
                }
            }

            ModelCommand::GetTemplates { reply } => {
                if !self.handle_template_command(TemplateCommand::GetTemplates { reply }, sse) {
                    return false;
                }
            }
            ModelCommand::InstallTemplate { zip_path, reply } => {
                if !self.handle_template_command(
                    TemplateCommand::InstallTemplate { zip_path, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::CreateTemplateFromStarter {
                starter_type,
                template_id,
                display_name,
                reply,
            } => {
                if !self.handle_template_command(
                    TemplateCommand::CreateTemplateFromStarter {
                        starter_type,
                        template_id,
                        display_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::CreateTemplateFromBuiltin {
                source_template_id,
                template_id,
                display_name,
                reply,
            } => {
                if !self.handle_template_command(
                    TemplateCommand::CreateTemplateFromBuiltin {
                        source_template_id,
                        template_id,
                        display_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::RemoveTemplate { name, reply } => {
                if !self
                    .handle_template_command(TemplateCommand::RemoveTemplate { name, reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::GetTemplateDirectory { name, reply } => {
                if !self.handle_template_command(
                    TemplateCommand::GetTemplateDirectory { name, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetSceneTemplates { scene_id, reply } => {
                if !self.handle_template_command(
                    TemplateCommand::GetSceneTemplates { scene_id, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::AddSceneTemplate {
                scene_id,
                template_name,
                reply,
            } => {
                if !self.handle_template_command(
                    TemplateCommand::AddSceneTemplate {
                        scene_id,
                        template_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::RemoveSceneTemplate {
                scene_id,
                template_name,
                reply,
            } => {
                if !self.handle_template_command(
                    TemplateCommand::RemoveSceneTemplate {
                        scene_id,
                        template_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetSelectedSceneTemplate {
                scene_id,
                template_name,
                reply,
            } => {
                if !self.handle_template_command(
                    TemplateCommand::SetSelectedSceneTemplate {
                        scene_id,
                        template_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetSceneTemplateEnabled {
                scene_id,
                template_name,
                enabled,
                reply,
            } => {
                if !self.handle_template_command(
                    TemplateCommand::SetSceneTemplateEnabled {
                        scene_id,
                        template_name,
                        enabled,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }

            ModelCommand::GetEffects { reply } => {
                self.handle_effect_command(EffectCommand::GetEffects { reply });
            }
            ModelCommand::GetEffect { effect_id, reply } => {
                self.handle_effect_command(EffectCommand::GetEffect { effect_id, reply });
            }
            ModelCommand::AddEffect { effect, reply } => {
                self.handle_effect_command(EffectCommand::AddEffect { effect, reply });
            }
            ModelCommand::UpdateEffect { effect, reply } => {
                self.handle_effect_command(EffectCommand::UpdateEffect { effect, reply });
            }
            ModelCommand::RemoveEffect { effect_id, reply } => {
                self.handle_effect_command(EffectCommand::RemoveEffect { effect_id, reply });
            }
            ModelCommand::DuplicateEffect {
                effect_id,
                new_name,
                reply,
            } => {
                self.handle_effect_command(EffectCommand::DuplicateEffect {
                    effect_id,
                    new_name,
                    reply,
                });
            }
            ModelCommand::GetPluginManifests { reply } => {
                self.handle_effect_command(EffectCommand::GetPluginManifests { reply });
            }

            // --- DebugSupportSurface ---
            ModelCommand::GetDebugLoggingEnabled { reply } => {
                let _ = reply.send(serde_json::json!({
                    "enabled": self.app_config.debug_logging_enabled,
                }));
            }
            ModelCommand::SetDebugLoggingEnabled { enabled, reply } => {
                self.app_config.debug_logging_enabled = enabled;
                self.save_app_config();
                let _ = reply.send(serde_json::json!({
                    "ok": true,
                    "enabled": enabled,
                }));
            }

            ModelCommand::Shutdown => {
                self.handle_shutdown();
                return false;
            }
        }
        true
    }
}
