use std::path::Path;

use reqwest::Client;

use crate::state::comment::RawComment;

pub async fn cache_comment_images(
    media_cache_dir: &Path,
    port: u16,
    comments_json: &str,
) -> serde_json::Value {
    match crate::image_cache::cache_comment_images(media_cache_dir, port, comments_json).await {
        Ok(cached_json) => serde_json::from_str(&cached_json).unwrap_or_else(|error| {
            serde_json::json!({
                "error": format!("failed to parse cached comments JSON: {}", error),
            })
        }),
        Err(error) => serde_json::json!({ "error": error }),
    }
}

#[allow(dead_code)] // cdylib の N-API entrypoint では同等処理が model_queue 経由で非同期実行される。
pub async fn prepare_incoming_comments(
    media_cache_dir: &Path,
    port: u16,
    comments_json: &str,
) -> Result<Vec<RawComment>, String> {
    let normalized_json =
        match crate::image_cache::cache_comment_images(media_cache_dir, port, comments_json).await {
            Ok(cached_json) => cached_json,
            Err(error) => {
                tracing::warn!("comment image cache failed, falling back to original payload: {}", error);
                comments_json.to_string()
            }
        };

    serde_json::from_str(&normalized_json)
        .map_err(|error| format!("failed to parse prepared comments JSON: {}", error))
}

pub async fn prepare_incoming_comment_value(
    media_cache_dir: &Path,
    port: u16,
    comment: &mut serde_json::Value,
    client: &Client,
) -> Result<RawComment, String> {
    crate::image_cache::normalize_comment_images_with_client(media_cache_dir, port, comment, client).await;
    serde_json::from_value(comment.clone())
        .map_err(|error| format!("failed to parse prepared comment JSON: {}", error))
}
