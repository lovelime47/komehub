use std::path::Path;

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

pub async fn ensure_template_fonts(
    media_cache_dir: &Path,
    fonts: &[String],
    progress_callback: ThreadsafeFunction<String>,
) -> serde_json::Value {
    let result = crate::font_cache::ensure_fonts(media_cache_dir, fonts, |progress| {
        if let Ok(json) = serde_json::to_string(&progress) {
            let _ = progress_callback.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
        }
    })
    .await;

    serde_json::to_value(&result).unwrap_or_else(|error| {
        serde_json::json!({
            "ok": false,
            "results": [],
            "error": format!("Failed to serialize font cache result: {}", error),
        })
    })
}
