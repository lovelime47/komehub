use super::*;

impl ModelQueue {
    pub(super) fn handle_performance_command(
        &mut self,
        cmd: PerformanceCommand,
        sse: &Arc<SseBroadcaster>,
    ) {
        match cmd {
            PerformanceCommand::TriggerPerformance {
                scene_id,
                performance_id,
            } => {
                self.handle_trigger(&scene_id, &performance_id, sse);
            }
            PerformanceCommand::TriggerTest {
                scene_id,
                performance_id,
                reply,
            } => {
                let (result, resp) = self.engines.performance.trigger_test(
                    &scene_id,
                    &performance_id,
                    &self.main_store.scenes,
                );
                self.emit_performances(result.fired, sse);
                let _ = reply.send(resp);
            }
            PerformanceCommand::TriggerTestWithContext {
                scene_id,
                performance_id,
                context,
                reply,
            } => {
                let (result, resp) = self.engines.performance.trigger_test_with_context(
                    &scene_id,
                    &performance_id,
                    &context,
                    &self.main_store.scenes,
                );
                self.emit_performances(result.fired, sse);
                let _ = reply.send(resp);
            }
            PerformanceCommand::TriggerTestReaction {
                scene_id,
                performance_id,
                reply,
            } => {
                let (result, resp) = self.engines.performance.trigger_test_reaction(
                    &scene_id,
                    &performance_id,
                    &self.main_store.scenes,
                );
                self.emit_performances(result.fired, sse);
                let _ = reply.send(resp);
            }
            PerformanceCommand::TriggerTestReactionCustom {
                scene_id,
                performance_id,
                reaction_key,
                reply,
            } => {
                let (result, resp) = self.engines.performance.trigger_test_reaction_custom(
                    &scene_id,
                    &performance_id,
                    &reaction_key,
                    &self.main_store.scenes,
                );
                self.emit_performances(result.fired, sse);
                let _ = reply.send(resp);
            }
            PerformanceCommand::ClearPerformances { scene_id, reply } => {
                let summary = self.engines.performance.clear_runtime(&scene_id);
                sse.push_performance_clear(&scene_id);
                let _ = reply.send(serde_json::json!({
                    "ok": true,
                    "cleared": summary,
                }));
            }
            PerformanceCommand::SetPaused { paused, reply } => {
                if paused {
                    self.engines.performance.pause_requested();
                } else {
                    self.engines.performance.resume_requested();
                    // 再開時にキューを処理
                    self.flush_performance_queue(sse);
                }
                self.main_store.performance_engine_state = self.engines.performance.state();
                shared_memory::publish_performance_engine_state(
                    self.main_store.performance_engine_state,
                );
                sse.push_static_update(
                    "performanceEngineState",
                    &self.main_store.performance_engine_state,
                );
                if let Some(reply) = reply {
                    let _ = reply.send(serde_json::json!(true));
                }
            }
            PerformanceCommand::GetPaused { reply } => {
                let _ = reply.send(serde_json::json!(self.engines.performance.is_paused()));
            }
            PerformanceCommand::GetHiddenListeners { reply } => {
                let data =
                    serde_json::to_value(&self.app_config.hidden_listeners).unwrap_or_default();
                let _ = reply.send(data);
            }
            PerformanceCommand::SetHiddenListeners { users, reply } => {
                // 2026-05-09 仕様変更: 演出フィルタは撤廃 (= UI 表示抑制のみ)。
                // 一括 set は BAN リストモーダルからの「全クリア」「複数解除」用。
                self.app_config.hidden_listeners = users.clone();
                self.save_app_config();
                sse.set_hidden_for_comments(
                    users
                        .iter()
                        .filter(|u| u.hide_from_comments)
                        .map(|u| u.id.trim_start_matches("yt-").to_string())
                        .collect(),
                );
                let _ = reply.send(serde_json::to_value(users).unwrap_or_default());
            }
            PerformanceCommand::GetGlobalCooldown { reply } => {
                let data = serde_json::to_value(
                    self.app_config.global_cooldown.clone().unwrap_or_default(),
                )
                .unwrap_or_default();
                let _ = reply.send(data);
            }
            PerformanceCommand::UpdateGlobalCooldown {
                max_effects,
                user_interval,
            } => {
                self.engines
                    .performance
                    .set_global_cooldown(max_effects, user_interval);
                self.app_config.global_cooldown = Some(GlobalCooldownConfig {
                    max_effects,
                    user_interval,
                });
                self.save_app_config();
            }
            PerformanceCommand::GetMembershipGiftPricing { reply } => {
                let data = serde_json::to_value(
                    self.app_config
                        .membership_gift_pricing
                        .clone()
                        .unwrap_or_default(),
                )
                .unwrap_or_default();
                let _ = reply.send(data);
            }
            PerformanceCommand::SetMembershipGiftPricing { settings, reply } => {
                let config = normalize_membership_gift_pricing(settings);
                self.app_config.membership_gift_pricing = Some(config.clone());
                self.save_app_config();
                let _ = reply.send(serde_json::to_value(config).unwrap_or_default());
            }
            PerformanceCommand::GetListenerClassificationConfig { reply } => {
                let data = serde_json::to_value(
                    self.app_config
                        .listener_classification
                        .clone()
                        .unwrap_or_default(),
                )
                .unwrap_or_default();
                let _ = reply.send(data);
            }
            PerformanceCommand::UpdateListenerClassificationConfig {
                regular_stream_window,
                regular_min_streams,
                newcomer_first_seen_days,
                veteran_first_seen_days,
                reply,
            } => {
                // 新参境界 ≤ 古参境界 が成立しないと「常連 / 古参 区間」が消えるので強制 swap
                let newcomer = newcomer_first_seen_days.clamp(1, 3650);
                let veteran = veteran_first_seen_days.clamp(7, 3650);
                let (newcomer, veteran) = if newcomer >= veteran {
                    (veteran.saturating_sub(1).max(1), veteran)
                } else {
                    (newcomer, veteran)
                };
                let config = ListenerClassificationConfig {
                    regular_stream_window: regular_stream_window.clamp(1, 100),
                    regular_min_streams: regular_min_streams.clamp(1, 100),
                    newcomer_first_seen_days: newcomer,
                    veteran_first_seen_days: veteran,
                };
                // listener_manager の AtomicU32 にも反映 → 即座に SQL 計算へ反映される
                if let Some(mgr) = self.engines.listener_manager.as_ref() {
                    mgr.set_classification_thresholds(
                        config.newcomer_first_seen_days,
                        config.veteran_first_seen_days,
                        config.regular_stream_window as u32,
                        config.regular_min_streams as u32,
                    );
                }
                self.app_config.listener_classification = Some(config.clone());
                self.save_app_config();
                if let Some(reply) = reply {
                    let _ = reply.send(serde_json::to_value(config).unwrap_or_default());
                }
            }
            PerformanceCommand::GetTtsSettings { reply } => {
                let data = crate::tts::normalize_settings(self.app_config.tts.clone());
                let _ = reply.send(data);
            }
            PerformanceCommand::SetTtsSettings { settings, reply } => {
                let patch_enabled = settings.get("enabled").cloned();
                let pre_enabled = self
                    .app_config
                    .tts
                    .as_ref()
                    .and_then(|v| v.get("enabled"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let pre_provider = self
                    .app_config
                    .tts
                    .as_ref()
                    .and_then(|v| v.get("provider"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("builtin")
                    .to_string();
                tracing::info!(
                    "SetTtsSettings: pre_enabled={} pre_provider={} patch_enabled={:?} patch_keys={:?}",
                    pre_enabled,
                    pre_provider,
                    patch_enabled,
                    settings
                        .as_object()
                        .map(|o| o.keys().cloned().collect::<Vec<_>>())
                );

                let mut data = crate::tts::normalize_settings(self.app_config.tts.clone());
                crate::tts::merge_settings(&mut data, settings);
                crate::tts::set_paused(
                    data.get("paused")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                );
                let next_enabled = data
                    .get("enabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let next_provider = data
                    .get("provider")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("builtin")
                    .to_string();
                // OFF 化のときだけキューを破棄+再生中をkill。
                // provider/voice 等の変更時は何もしない。run_tts_queue が次に pop した時に
                // 最新の CURRENT_TTS_SETTINGS を読むので、自動的に新しい設定で再生される。
                if !next_enabled {
                    crate::tts::clear_pending();
                }
                self.app_config.tts = Some(data.clone());
                crate::tts::update_current_settings(data.clone());
                self.save_app_config();
                sse.push_tts_state(&crate::tts::state(&data));
                tracing::info!(
                    "SetTtsSettings: saved enabled={} provider={} (was enabled={} provider={})",
                    next_enabled,
                    next_provider,
                    pre_enabled,
                    pre_provider
                );
                // provider が切り替わった or 設定保存 (host/port 等が変わった可能性) の
                // どちらでも health-check を再発火する。enabled=false でも次回 ON 時に
                // すでに状態が更新されているほうが UX が良い。
                if next_provider != "builtin" {
                    tokio::spawn(crate::tts::refresh_health(
                        data.clone(),
                        next_provider.clone(),
                        sse.clone(),
                    ));
                }
                let _ = reply.send(data);
            }
            PerformanceCommand::GetTtsState { reply } => {
                let settings = crate::tts::normalize_settings(self.app_config.tts.clone());
                let _ = reply.send(crate::tts::state(&settings));
            }
            PerformanceCommand::SetTtsEnabled { enabled, reply } => {
                tracing::info!("SetTtsEnabled: requested={}", enabled);
                let mut settings = crate::tts::normalize_settings(self.app_config.tts.clone());
                crate::tts::merge_settings(
                    &mut settings,
                    serde_json::json!({ "enabled": enabled }),
                );
                if !enabled {
                    crate::tts::clear_pending();
                    // paused (= TtsRuntime.paused、 memory のみ) も OFF と同時にリセット
                    // (= 「OFF 中の一時停止」 は UX 上意味不明、 ON 再開時に paused=false 状態を保証)
                    crate::tts::set_paused(false);
                }
                self.app_config.tts = Some(settings.clone());
                crate::tts::update_current_settings(settings.clone());
                self.save_app_config();
                let state = crate::tts::state(&settings);
                sse.push_tts_state(&state);
                // OFF→ON のタイミングで provider の生死を最新化する
                // (前回 unreachable だった環境を起こし直したケースを拾う)
                if enabled {
                    let provider = settings
                        .get("provider")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("builtin")
                        .to_string();
                    if provider != "builtin" {
                        tokio::spawn(crate::tts::refresh_health(
                            settings.clone(),
                            provider,
                            sse.clone(),
                        ));
                    }
                }
                let _ = reply.send(state);
            }
            PerformanceCommand::SetTtsPaused { paused, reply } => {
                // paused は memory のみ (= TtsRuntime.paused、 AppConfig.tts には保存しない)。
                // ハブ再起動で必ず解除される「セッション内一時停止」 の概念。
                crate::tts::set_paused(paused);
                let settings = crate::tts::normalize_settings(self.app_config.tts.clone());
                let state = crate::tts::state(&settings);
                sse.push_tts_state(&state);
                let _ = reply.send(state);
            }
            PerformanceCommand::ClearTts { reply } => {
                crate::tts::clear_pending();
                let settings = crate::tts::normalize_settings(self.app_config.tts.clone());
                let state = crate::tts::state(&settings);
                sse.push_tts_state(&state);
                let _ = reply.send(state);
            }
            PerformanceCommand::GetNotificationSettings { reply } => {
                let data = crate::notification_settings::normalize(self.app_config.notification.clone());
                let _ = reply.send(data);
            }
            PerformanceCommand::SetNotificationSettings { settings, reply } => {
                let mut data = crate::notification_settings::normalize(self.app_config.notification.clone());
                crate::notification_settings::merge(&mut data, settings);
                self.app_config.notification = Some(data.clone());
                crate::notification_settings::update_current_settings(data.clone());
                self.save_app_config();
                let _ = reply.send(data);
            }
            PerformanceCommand::SetNotificationEnabled { enabled, reply } => {
                let mut data = crate::notification_settings::normalize(self.app_config.notification.clone());
                crate::notification_settings::merge(&mut data, serde_json::json!({ "enabled": enabled }));
                if !enabled {
                    // OFF にした瞬間、 共通 TTS_RUNTIME queue に溜まっている Notification
                    // ジョブを破棄して即時停止
                    crate::tts::clear_pending_notifications();
                    // paused (= 一時停止) は memory 保持で「セッション内一時停止」 の概念。
                    // OFF と paused が両立すると UX 上意味不明 (= 「停止中の停止」) なので
                    // OFF した瞬間に paused は解除する。
                    crate::notification_settings::set_paused(false);
                }
                self.app_config.notification = Some(data.clone());
                crate::notification_settings::update_current_settings(data.clone());
                self.save_app_config();
                let _ = reply.send(crate::notification_settings::state(&data));
            }
            PerformanceCommand::SetNotificationPaused { paused, reply } => {
                // paused は memory のみ (= AppConfig 永続化しない)。 ハブ再起動で必ず解除。
                crate::notification_settings::set_paused(paused);
                if paused {
                    // 一時停止にした瞬間、 queue に残った Notification ジョブを破棄
                    crate::tts::clear_pending_notifications();
                }
                // 設定本体 (= app_config.notification) は触らない (= paused field 含まず)
                let data = crate::notification_settings::normalize(self.app_config.notification.clone());
                let _ = reply.send(crate::notification_settings::state(&data));
            }
            PerformanceCommand::EvaluateReaction { reaction_type } => {
                let result = self
                    .engines
                    .performance
                    .evaluate_reaction(&reaction_type, &self.main_store.scenes);
                self.emit_performances(result.fired, sse);
            }
            PerformanceCommand::HasReactionTrigger { reply } => {
                let _ = reply.send(serde_json::json!(self
                    .main_store
                    .scenes
                    .has_enabled_reaction_trigger()));
            }
        }
    }
}
