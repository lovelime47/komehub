use super::*;

impl ModelQueue {
    pub(super) fn dispatch_performance_command(
        &mut self,
        cmd: ModelCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            ModelCommand::TriggerPerformance {
                scene_id,
                performance_id,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::TriggerPerformance {
                        scene_id,
                        performance_id,
                    },
                    sse,
                );
            }
            ModelCommand::TriggerTest {
                scene_id,
                performance_id,
                reply,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::TriggerTest {
                        scene_id,
                        performance_id,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::TriggerTestWithContext {
                scene_id,
                performance_id,
                context,
                reply,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::TriggerTestWithContext {
                        scene_id,
                        performance_id,
                        context,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::TriggerTestReaction {
                scene_id,
                performance_id,
                reply,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::TriggerTestReaction {
                        scene_id,
                        performance_id,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::TriggerTestReactionCustom {
                scene_id,
                performance_id,
                reaction_key,
                reply,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::TriggerTestReactionCustom {
                        scene_id,
                        performance_id,
                        reaction_key,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::ClearPerformances { scene_id, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::ClearPerformances { scene_id, reply },
                    sse,
                );
            }
            ModelCommand::SetPaused { paused, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetPaused { paused, reply },
                    sse,
                );
            }
            ModelCommand::GetPaused { reply } => {
                self.handle_performance_command(PerformanceCommand::GetPaused { reply }, sse);
            }
            ModelCommand::GetHiddenListeners { reply } => {
                self.handle_performance_command(
                    PerformanceCommand::GetHiddenListeners { reply },
                    sse,
                );
            }
            ModelCommand::SetHiddenListeners { users, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetHiddenListeners { users, reply },
                    sse,
                );
            }
            ModelCommand::GetGlobalCooldown { reply } => {
                self.handle_performance_command(
                    PerformanceCommand::GetGlobalCooldown { reply },
                    sse,
                );
            }
            ModelCommand::UpdateGlobalCooldown {
                max_effects,
                user_interval,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::UpdateGlobalCooldown {
                        max_effects,
                        user_interval,
                    },
                    sse,
                );
            }
            ModelCommand::GetMembershipGiftPricing { reply } => {
                self.handle_performance_command(
                    PerformanceCommand::GetMembershipGiftPricing { reply },
                    sse,
                );
            }
            ModelCommand::SetMembershipGiftPricing { settings, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetMembershipGiftPricing { settings, reply },
                    sse,
                );
            }
            ModelCommand::GetListenerClassificationConfig { reply } => {
                self.handle_performance_command(
                    PerformanceCommand::GetListenerClassificationConfig { reply },
                    sse,
                );
            }
            ModelCommand::UpdateListenerClassificationConfig {
                regular_stream_window,
                regular_min_streams,
                newcomer_first_seen_days,
                veteran_first_seen_days,
                reply,
            } => {
                self.handle_performance_command(
                    PerformanceCommand::UpdateListenerClassificationConfig {
                        regular_stream_window,
                        regular_min_streams,
                        newcomer_first_seen_days,
                        veteran_first_seen_days,
                        reply,
                    },
                    sse,
                );
            }
            ModelCommand::GetTtsSettings { reply } => {
                self.handle_performance_command(PerformanceCommand::GetTtsSettings { reply }, sse);
            }
            ModelCommand::SetTtsSettings { settings, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetTtsSettings { settings, reply },
                    sse,
                );
            }
            ModelCommand::GetTtsState { reply } => {
                self.handle_performance_command(PerformanceCommand::GetTtsState { reply }, sse);
            }
            ModelCommand::SetTtsEnabled { enabled, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetTtsEnabled { enabled, reply },
                    sse,
                );
            }
            ModelCommand::SetTtsPaused { paused, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetTtsPaused { paused, reply },
                    sse,
                );
            }
            ModelCommand::ClearTts { reply } => {
                self.handle_performance_command(PerformanceCommand::ClearTts { reply }, sse);
            }
            ModelCommand::GetNotificationSettings { reply } => {
                self.handle_performance_command(
                    PerformanceCommand::GetNotificationSettings { reply },
                    sse,
                );
            }
            ModelCommand::SetNotificationSettings { settings, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetNotificationSettings { settings, reply },
                    sse,
                );
            }
            ModelCommand::SetNotificationEnabled { enabled, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetNotificationEnabled { enabled, reply },
                    sse,
                );
            }
            ModelCommand::SetNotificationPaused { paused, reply } => {
                self.handle_performance_command(
                    PerformanceCommand::SetNotificationPaused { paused, reply },
                    sse,
                );
            }
            ModelCommand::EvaluateReaction { reaction_type } => {
                self.handle_performance_command(
                    PerformanceCommand::EvaluateReaction { reaction_type },
                    sse,
                );
            }
            ModelCommand::HasReactionTrigger { reply } => {
                self.handle_performance_command(
                    PerformanceCommand::HasReactionTrigger { reply },
                    sse,
                );
            }
            _ => {
                unreachable!("non-performance ModelCommand routed to dispatch_performance_command")
            }
        }
        true
    }
}
