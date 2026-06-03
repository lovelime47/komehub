use super::*;

impl ModelQueue {
    fn send_listener_manager_response(
        &self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
        f: impl FnOnce(&crate::engine::listener_manager::ListenerManager) -> serde_json::Value,
    ) {
        let response = match self.engines.listener_manager.as_ref() {
            Some(mgr) => f(mgr),
            None => serde_json::json!({
                "ok": false,
                "error": "listener_manager is unavailable",
            }),
        };
        let _ = reply.send(response);
    }

    pub(super) fn handle_get_listener_tags(
        &self,
        channel_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.get_listener_tags(&channel_id) {
                Ok(tags) => serde_json::json!({ "ok": true, "tags": tags }),
                Err(err) => {
                    tracing::warn!("get_listener_tags failed: {}", err);
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                }
            }
        });
    }

    pub(super) fn handle_set_listener_tags(
        &self,
        channel_id: String,
        tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.set_listener_tags(&channel_id, &tags) {
                Ok(count) => serde_json::json!({ "ok": true, "count": count }),
                Err(err) => {
                    tracing::warn!("set_listener_tags failed: {}", err);
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                }
            }
        });
    }

    pub(super) fn handle_list_all_listener_tags(
        &self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.list_all_tags() {
            Ok(rows) => serde_json::json!({ "ok": true, "tags": rows }),
            Err(err) => {
                tracing::warn!("list_all_tags failed: {}", err);
                serde_json::json!({ "ok": false, "error": err.to_string() })
            }
        });
    }

    pub(super) fn handle_list_all_listener_tag_assignments(
        &self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.list_all_tag_assignments() {
            Ok(rows) => serde_json::json!({ "ok": true, "assignments": rows }),
            Err(err) => {
                tracing::warn!("list_all_tag_assignments failed: {}", err);
                serde_json::json!({ "ok": false, "error": err.to_string() })
            }
        });
    }

    pub(super) fn handle_get_stream_tags(
        &self,
        video_id: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.get_stream_tags(&video_id) {
            Ok(tags) => serde_json::json!({ "ok": true, "tags": tags }),
            Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }),
        });
    }

    pub(super) fn handle_set_stream_tags(
        &self,
        video_id: String,
        tags: Vec<String>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.set_stream_tags(&video_id, &tags) {
                Ok(count) => serde_json::json!({ "ok": true, "count": count }),
                Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }),
            }
        });
    }

    pub(super) fn handle_list_all_stream_tags(
        &self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.list_all_stream_tags() {
            Ok(tags) => serde_json::json!({ "ok": true, "tags": tags }),
            Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }),
        });
    }

    pub(super) fn handle_list_all_stream_tag_assignments(
        &self,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.list_all_stream_tag_assignments() {
                Ok(rows) => serde_json::json!({ "ok": true, "assignments": rows }),
                Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }),
            }
        });
    }

    pub(super) fn handle_rename_stream_tag(
        &self,
        old_name: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.rename_stream_tag(&old_name, &new_name) {
                Ok(n) => serde_json::json!({ "ok": true, "affected": n }),
                Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }),
            }
        });
    }

    pub(super) fn handle_delete_stream_tag(
        &self,
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.delete_stream_tag(&name) {
            Ok(n) => serde_json::json!({ "ok": true, "deleted": n }),
            Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }),
        });
    }

    pub(super) fn handle_rename_listener_tag(
        &self,
        old_name: String,
        new_name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.rename_tag(&old_name, &new_name) {
                Ok(n) => serde_json::json!({ "ok": true, "affected": n }),
                Err(err) => {
                    tracing::warn!("rename_tag failed: {}", err);
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                }
            }
        });
    }

    pub(super) fn handle_delete_listener_tag(
        &self,
        name: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.delete_tag(&name) {
            Ok(n) => serde_json::json!({ "ok": true, "deleted": n }),
            Err(err) => {
                tracing::warn!("delete_tag failed: {}", err);
                serde_json::json!({ "ok": false, "error": err.to_string() })
            }
        });
    }

    pub(super) fn handle_list_saved_searches(
        &self,
        scope: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.list_saved_searches(&scope) {
            Ok(rows) => serde_json::json!({ "ok": true, "searches": rows }),
            Err(err) => {
                tracing::warn!("list_saved_searches failed: {}", err);
                serde_json::json!({ "ok": false, "error": err.to_string() })
            }
        });
    }

    pub(super) fn handle_create_saved_search(
        &self,
        scope: String,
        name: String,
        conditions_json: String,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.create_saved_search(&scope, &name, &conditions_json) {
                Ok(id) => serde_json::json!({ "ok": true, "id": id }),
                Err(err) => {
                    tracing::warn!("create_saved_search failed: {}", err);
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                }
            }
        });
    }

    pub(super) fn handle_update_saved_search(
        &self,
        id: i64,
        name: Option<String>,
        conditions_json: Option<String>,
        sort_order: Option<i64>,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| {
            match mgr.update_saved_search(
                id,
                name.as_deref(),
                conditions_json.as_deref(),
                sort_order,
            ) {
                Ok(n) => serde_json::json!({ "ok": true, "updated": n }),
                Err(err) => {
                    tracing::warn!("update_saved_search failed: {}", err);
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                }
            }
        });
    }

    pub(super) fn handle_delete_saved_search(
        &self,
        id: i64,
        reply: tokio::sync::oneshot::Sender<serde_json::Value>,
    ) {
        self.send_listener_manager_response(reply, |mgr| match mgr.delete_saved_search(id) {
            Ok(n) => serde_json::json!({ "ok": true, "deleted": n }),
            Err(err) => {
                tracing::warn!("delete_saved_search failed: {}", err);
                serde_json::json!({ "ok": false, "error": err.to_string() })
            }
        });
    }
}
