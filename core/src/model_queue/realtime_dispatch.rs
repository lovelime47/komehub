use super::*;

impl ModelQueue {
    pub(super) async fn dispatch_realtime_command(
        &mut self,
        cmd: ModelCommand,
        sse: &Arc<SseBroadcaster>,
    ) -> bool {
        match cmd {
            ModelCommand::ApplyAsyncWriteback { writeback } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::ApplyAsyncWriteback { writeback },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::ApplyAsyncWritebackSync { writeback, ack } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::ApplyAsyncWritebackSync { writeback, ack },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::IncomingCommentsJson { comments_json } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::IncomingCommentsJson { comments_json },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::IncomingInnertubeActions { actions_json } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::IncomingInnertubeActions { actions_json },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::IncomingComments { comments } => {
                if !self
                    .handle_realtime_command(RealtimeCommand::IncomingComments { comments }, sse)
                    .await
                {
                    return false;
                }
            }
            ModelCommand::CacheCommentImages {
                comments_json,
                reply,
            } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::CacheCommentImages {
                            comments_json,
                            reply,
                        },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::GetRecentComments { limit, reply } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::GetRecentComments { limit, reply },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::GetLiveStreamStats { reply } => {
                if !self
                    .handle_realtime_command(RealtimeCommand::GetLiveStreamStats { reply }, sse)
                    .await
                {
                    return false;
                }
            }
            ModelCommand::IncomingReaction { reaction } => {
                if !self
                    .handle_realtime_command(RealtimeCommand::IncomingReaction { reaction }, sse)
                    .await
                {
                    return false;
                }
            }
            ModelCommand::CommentDeleted { comment_ids } => {
                if !self
                    .handle_realtime_command(RealtimeCommand::CommentDeleted { comment_ids }, sse)
                    .await
                {
                    return false;
                }
            }
            ModelCommand::ConnectionStateChanged {
                connected,
                video_id,
            } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::ConnectionStateChanged {
                            connected,
                            video_id,
                        },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            ModelCommand::AnnounceStreamOwner {
                video_id,
                owner_channel_id,
            } => {
                if !self
                    .handle_realtime_command(
                        RealtimeCommand::AnnounceStreamOwner {
                            video_id,
                            owner_channel_id,
                        },
                        sse,
                    )
                    .await
                {
                    return false;
                }
            }
            _ => unreachable!("non-realtime ModelCommand routed to dispatch_realtime_command"),
        }
        true
    }
}
