use super::*;

impl ModelQueue {
    pub(super) fn dispatch_listener_command(
        &mut self,
        cmd: ModelCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            ModelCommand::GetOwnerChannels { reply } => {
                if !self.handle_listener_command(ListenerCommand::GetOwnerChannels { reply }, sse) {
                    return false;
                }
            }
            ModelCommand::IsListenerDbDirty { reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::IsListenerDbDirty { reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetOwnerChannels { channels, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::SetOwnerChannels { channels, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetListeners { query, reply } => {
                if !self
                    .handle_listener_command(ListenerCommand::GetListeners { query, reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::GetListenersActivity { query, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetListenersActivity { query, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetListenerDetail {
                channel_id,
                recent_comment_limit,
                stream_video_id,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetListenerDetail {
                        channel_id,
                        recent_comment_limit,
                        stream_video_id,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::UpdateStreamMetadata {
                video_id,
                stream_url,
                title,
                owner_channel_id,
                channel_name,
                channel_icon_url,
                description,
                subscriber_count,
                current_viewers,
                peak_concurrent_viewers,
                likes,
                started_at,
                ended_at,
                live_metadata_updated_at,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::UpdateStreamMetadata {
                        video_id,
                        stream_url,
                        title,
                        owner_channel_id,
                        channel_name,
                        channel_icon_url,
                        description,
                        subscriber_count,
                        current_viewers,
                        peak_concurrent_viewers,
                        likes,
                        started_at,
                        ended_at,
                        live_metadata_updated_at,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::UpdateListenerMetadata {
                channel_id,
                nickname,
                notes,
                label,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::UpdateListenerMetadata {
                        channel_id,
                        nickname,
                        notes,
                        label,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetListenerGreeted {
                stream_video_id,
                listener_channel_id,
                value,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::SetListenerGreeted {
                        stream_video_id,
                        listener_channel_id,
                        value,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetListenerHidden {
                listener_channel_id,
                hide_from_comments,
                hide_from_listeners,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::SetListenerHidden {
                        listener_channel_id,
                        hide_from_comments,
                        hide_from_listeners,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetCommentResponded {
                comment_id,
                value,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::SetCommentResponded {
                        comment_id,
                        value,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::DeleteListeners { channel_ids, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::DeleteListeners { channel_ids, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::DeleteStreams { video_ids, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::DeleteStreams { video_ids, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetStreams { query, reply } => {
                if !self.handle_listener_command(ListenerCommand::GetStreams { query, reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::GetStreamDetail {
                video_id,
                recent_comment_limit,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetStreamDetail {
                        video_id,
                        recent_comment_limit,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SearchComments { query, reply } => {
                if !self
                    .handle_listener_command(ListenerCommand::SearchComments { query, reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::ListStreamListeners {
                video_id,
                query,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::ListStreamListeners {
                        video_id,
                        query,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetStreamStats {
                video_id,
                bin_minutes,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetStreamStats {
                        video_id,
                        bin_minutes,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetCommentChipCounts { video_id, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetCommentChipCounts { video_id, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetListenerChipCounts {
                channel_id,
                context_video_id,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetListenerChipCounts {
                        channel_id,
                        context_video_id,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ListListenerSuperchats {
                channel_id,
                limit,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::ListListenerSuperchats {
                        channel_id,
                        limit,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ListListenerCommentsInStream {
                channel_id,
                stream_video_id,
                limit,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::ListListenerCommentsInStream {
                        channel_id,
                        stream_video_id,
                        limit,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetListenerSearchRankCounts {
                baseline_video_id,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetListenerSearchRankCounts {
                        baseline_video_id,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetStreamScopedListenerCounts {
                stream_video_id,
                q,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetStreamScopedListenerCounts {
                        stream_video_id,
                        q,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetStreamListenerPillCounts {
                video_id,
                name_q,
                body_q,
                text_q,
                user_tags,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetStreamListenerPillCounts {
                        video_id,
                        name_q,
                        body_q,
                        text_q,
                        user_tags,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetListenerTags { channel_id, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetListenerTags { channel_id, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetListenerTags {
                channel_id,
                tags,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::SetListenerTags {
                        channel_id,
                        tags,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ListAllListenerTags { reply } => {
                if !self
                    .handle_listener_command(ListenerCommand::ListAllListenerTags { reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::ListAllListenerTagAssignments { reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::ListAllListenerTagAssignments { reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::GetStreamTags { video_id, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::GetStreamTags { video_id, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SetStreamTags {
                video_id,
                tags,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::SetStreamTags {
                        video_id,
                        tags,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ListAllStreamTags { reply } => {
                if !self.handle_listener_command(ListenerCommand::ListAllStreamTags { reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::ListAllStreamTagAssignments { reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::ListAllStreamTagAssignments { reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::RenameStreamTag {
                old_name,
                new_name,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::RenameStreamTag {
                        old_name,
                        new_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::DeleteStreamTag { name, reply } => {
                if !self
                    .handle_listener_command(ListenerCommand::DeleteStreamTag { name, reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::RenameListenerTag {
                old_name,
                new_name,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::RenameListenerTag {
                        old_name,
                        new_name,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::DeleteListenerTag { name, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::DeleteListenerTag { name, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ListSavedSearches { scope, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::ListSavedSearches { scope, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::CreateSavedSearch {
                scope,
                name,
                conditions_json,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::CreateSavedSearch {
                        scope,
                        name,
                        conditions_json,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::UpdateSavedSearch {
                id,
                name,
                conditions_json,
                sort_order,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::UpdateSavedSearch {
                        id,
                        name,
                        conditions_json,
                        sort_order,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::DeleteSavedSearch { id, reply } => {
                if !self
                    .handle_listener_command(ListenerCommand::DeleteSavedSearch { id, reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::ExportKomehubJsonl { out_path, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::ExportKomehubJsonl { out_path, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ImportKomehubJsonl { src_path, reply } => {
                if !self.handle_listener_command(
                    ListenerCommand::ImportKomehubJsonl { src_path, reply },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ImportFromOnecomme {
                onecomme_dir,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::ImportFromOnecomme {
                        onecomme_dir,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::BackfillStreamMeta => {
                // fire-and-forget。listener_sync_queue 上で resolver 補完 → 完了時 SSE push。
                self.handle_backfill_stream_meta(sse);
            }
            ModelCommand::ExportToOnecomme {
                onecomme_dir,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::ExportToOnecomme {
                        onecomme_dir,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::DetectOnecommeRunning { reply } => {
                if !self
                    .handle_listener_command(ListenerCommand::DetectOnecommeRunning { reply }, sse)
                {
                    return false;
                }
            }
            ModelCommand::RunBidirectionalSync {
                onecomme_dir,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::RunBidirectionalSync {
                        onecomme_dir,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::ResetOnecommeWatermarks {
                onecomme_dir,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::ResetOnecommeWatermarks {
                        onecomme_dir,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            ModelCommand::SendTemplateTestComment {
                scene_id,
                context,
                reply,
            } => {
                if !self.handle_listener_command(
                    ListenerCommand::SendTemplateTestComment {
                        scene_id,
                        context,
                        reply,
                    },
                    sse,
                ) {
                    return false;
                }
            }
            _ => unreachable!("non-listener ModelCommand routed to dispatch_listener_command"),
        }
        true
    }
}
