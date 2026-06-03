use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, USER_AGENT};
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_IMAGE_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheImageResult {
    pub local_url: String,
    pub hit: bool,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum CacheType {
    Avatars,
    Badges,
    Emojis,
    Stickers,
}

impl CacheType {
    fn dir_name(self) -> &'static str {
        match self {
            CacheType::Avatars => "avatars",
            CacheType::Badges => "badges",
            CacheType::Emojis => "emojis",
            CacheType::Stickers => "stickers",
        }
    }
}

pub async fn cache_comment_images(
    media_cache_dir: &Path,
    port: u16,
    comments_json: &str,
) -> Result<String, String> {
    let client = build_image_http_client()?;
    let mut comments: Vec<Value> = serde_json::from_str(comments_json)
        .map_err(|error| format!("invalid comments JSON: {}", error))?;
    let batch_started_at = current_millis();
    let batch_size = comments.len() as u64;

    for (index, comment) in comments.iter_mut().enumerate() {
        add_trace_u64(comment, "commentAuxBatchStartedAtMs", batch_started_at);
        add_trace_u64(comment, "commentAuxBatchSize", batch_size);
        add_trace_u64(comment, "commentAuxBatchIndex", index as u64);
        add_trace_u64(comment, "commentAuxItemStartedAtMs", current_millis());
        process_comment_images(comment, media_cache_dir, port, &client).await;
        add_trace_u64(comment, "commentAuxItemDoneAtMs", current_millis());
    }

    let batch_finished_at = current_millis();
    for comment in comments.iter_mut() {
        add_trace_u64(comment, "commentAuxBatchFinishedAtMs", batch_finished_at);
    }

    serde_json::to_string(&comments)
        .map_err(|error| format!("failed to serialize cached comments: {}", error))
}

pub fn build_image_http_client() -> Result<Client, String> {
    build_http_client()
}

pub async fn normalize_comment_images_with_client(
    media_cache_dir: &Path,
    port: u16,
    comment: &mut Value,
    client: &Client,
) {
    process_comment_images(comment, media_cache_dir, port, client).await;
}

async fn process_comment_images(comment: &mut Value, media_cache_dir: &Path, port: u16, client: &Client) {
    let Some(comment_obj) = comment.as_object_mut() else {
        return;
    };

    let comment_name = comment_obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let comment_id = comment_obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if let Some(image_source) = resolve_image_field(comment_obj, "profileImage", "_originalProfileImage") {
        // わんコメ書き戻し用に YouTube CDN 生 URL を originalProfileImage に退避する。
        // profileImage 自体は下で cache URL に書き換わるが、わんコメ側ではこめはぶ
        // 未起動時に cache URL に到達できないため、こめはぶ DB の listener レコードに
        // 生 URL を残しておく必要がある。data: URL や既に local cache URL のものは
        // 退避してもアバター URL として無意味なので除外する。
        if !image_source.original_url.starts_with("data:")
            && !is_local_cache_url(&image_source.original_url)
        {
            comment_obj.insert(
                "originalProfileImage".to_string(),
                Value::String(image_source.original_url.clone()),
            );
        }
        if let Some(local_url) = cache_local_url(
            media_cache_dir,
            port,
            CacheType::Avatars,
            &comment_name,
            &image_source.original_url,
            image_source.data_url.as_deref(),
            client,
        )
        .await
        {
            comment_obj.insert("profileImage".to_string(), Value::String(local_url));
        }
    }

    if let Some(image_source) = resolve_image_field(comment_obj, "memberBadgeUrl", "_originalBadgeUrl") {
        if let Some(local_url) = cache_local_url(
            media_cache_dir,
            port,
            CacheType::Badges,
            &comment_name,
            &image_source.original_url,
            image_source.data_url.as_deref(),
            client,
        )
        .await
        {
            comment_obj.insert("memberBadgeUrl".to_string(), Value::String(local_url));
        }
    }

    if let Some(image_source) = resolve_image_field(comment_obj, "stickerImage", "_originalStickerImage") {
        let sticker_handle = format!("{}_{}", comment_name, comment_id);
        if let Some(local_url) = cache_local_url(
            media_cache_dir,
            port,
            CacheType::Stickers,
            &sticker_handle,
            &image_source.original_url,
            image_source.data_url.as_deref(),
            client,
        )
        .await
        {
            comment_obj.insert("stickerImage".to_string(), Value::String(local_url));
        }
    }

    let mut comment_html = comment_obj
        .get("commentHtml")
        .and_then(Value::as_str)
        .map(|value| value.to_string());

    if let Some(emojis) = comment_obj.get_mut("emojis").and_then(Value::as_array_mut) {
        for emoji in emojis.iter_mut() {
            let Some(emoji_obj) = emoji.as_object_mut() else {
                continue;
            };
            let Some(image_source) = resolve_image_field(emoji_obj, "src", "_originalSrc") else {
                continue;
            };
            let emoji_key = emoji_obj
                .get("emojiId")
                .and_then(Value::as_str)
                .or_else(|| emoji_obj.get("alt").and_then(Value::as_str))
                .unwrap_or("emoji");

            if let Some(local_url) = cache_local_url(
                media_cache_dir,
                port,
                CacheType::Emojis,
                emoji_key,
                &image_source.original_url,
                image_source.data_url.as_deref(),
                client,
            )
            .await
            {
                if let Some(ref mut html) = comment_html {
                    *html = html.replace(&image_source.replace_target, &local_url);
                }
                emoji_obj.insert("src".to_string(), Value::String(local_url));
            }
        }
    }

    if let Some(html) = comment_html {
        comment_obj.insert("commentHtml".to_string(), Value::String(html));
    }
}

async fn cache_local_url(
    media_cache_dir: &Path,
    port: u16,
    cache_type: CacheType,
    handle: &str,
    original_url: &str,
    data_url: Option<&str>,
    client: &Client,
) -> Option<String> {
    match cache_image(media_cache_dir, port, cache_type, handle, original_url, data_url, client).await {
        Ok(result) if !result.local_url.is_empty() => Some(result.local_url),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(
                "image cache failed for {} {}: {}",
                cache_type.dir_name(),
                handle,
                error
            );
            None
        }
    }
}

async fn cache_image(
    media_cache_dir: &Path,
    port: u16,
    cache_type: CacheType,
    handle: &str,
    original_url: &str,
    data_url: Option<&str>,
    client: &Client,
) -> Result<CacheImageResult, String> {
    if handle.is_empty() || original_url.is_empty() {
        return Ok(CacheImageResult {
            local_url: String::new(),
            hit: false,
            file_name: None,
        });
    }

    // YouTube は sticker URL を `//host/path` (= プロトコル相対) で返すケースがある。
    // reqwest::Client::get は scheme なしの URL を parse できず fetch エラーになるため、
    // ここで https: を補って正規化する。url_hash / fetch 双方が同じ URL を見るよう保つ。
    let normalized_url_storage;
    let original_url: &str = if original_url.starts_with("//") {
        normalized_url_storage = format!("https:{}", original_url);
        normalized_url_storage.as_str()
    } else {
        original_url
    };

    let safe_handle = sanitize_handle(handle);
    if safe_handle.is_empty() {
        return Ok(CacheImageResult {
            local_url: String::new(),
            hit: false,
            file_name: None,
        });
    }

    let cache_dir = media_cache_dir.join(cache_type.dir_name());
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("failed to create image cache dir: {}", error))?;

    let hash = url_hash(original_url);
    if let Some(existing_file) = find_cached(&cache_dir, &safe_handle).await? {
        if extract_cached_hash(&existing_file, &safe_handle).as_deref() == Some(hash.as_str()) {
            return Ok(CacheImageResult {
                local_url: build_local_url(port, cache_type, &existing_file),
                hit: true,
                file_name: Some(existing_file),
            });
        }

        let old_path = cache_dir.join(&existing_file);
        match tokio::fs::remove_file(&old_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to remove stale cache file {}: {}",
                    old_path.display(),
                    error
                ));
            }
        }
    }

    let parsed = if let Some(data_url) = data_url.filter(|value| value.starts_with("data:")) {
        parse_data_url(data_url)?
    } else {
        fetch_image_from_url(client, original_url).await?
    };
    let file_name = format!("{}_{}{}", safe_handle, hash, parsed.extension);
    let file_path = cache_dir.join(&file_name);
    tokio::fs::write(&file_path, parsed.bytes)
        .await
        .map_err(|error| format!("failed to write image cache file {}: {}", file_path.display(), error))?;

    Ok(CacheImageResult {
        local_url: build_local_url(port, cache_type, &file_name),
        hit: false,
        file_name: Some(file_name),
    })
}

/// 配信サムネを `media-cache/stream-thumbs/{video_id}.jpg` に保存する。
/// URL は YouTube CDN の `mqdefault.jpg` (320x180) 固定。
/// videoId は `[A-Za-z0-9_-]` のみ許可、それ以外を含む入力は弾く。
/// 既にファイルがあればヒット (= ダウンロードしない、即時 return)。
#[allow(dead_code)] // N-API から呼ばれる cdylib 用 helper。HTTP bin target では直接使わない。
pub async fn cache_stream_thumbnail(
    media_cache_dir: &Path,
    port: u16,
    video_id: &str,
) -> Result<CacheImageResult, String> {
    if video_id.is_empty()
        || !video_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid video_id: {}", video_id));
    }

    let cache_dir = media_cache_dir.join("stream-thumbs");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("failed to create stream-thumbs cache dir: {}", error))?;

    let file_name = format!("{}.jpg", video_id);
    let file_path = cache_dir.join(&file_name);

    // 既存ヒット (= 過去に DL 済み) はそのまま return
    if tokio::fs::metadata(&file_path).await.is_ok() {
        return Ok(CacheImageResult {
            local_url: format!(
                "http://127.0.0.1:{}/cache/stream-thumbs/{}",
                port, file_name
            ),
            hit: true,
            file_name: Some(file_name),
        });
    }

    // CDN から fetch して保存
    let url = format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", video_id);
    let client = build_image_http_client()?;
    let parsed = fetch_image_from_url(&client, &url).await?;
    tokio::fs::write(&file_path, parsed.bytes)
        .await
        .map_err(|error| {
            format!(
                "failed to write stream thumb file {}: {}",
                file_path.display(),
                error
            )
        })?;

    Ok(CacheImageResult {
        local_url: format!(
            "http://127.0.0.1:{}/cache/stream-thumbs/{}",
            port, file_name
        ),
        hit: false,
        file_name: Some(file_name),
    })
}

async fn fetch_image_from_url(client: &Client, original_url: &str) -> Result<ParsedDataUrl, String> {
    let response = client
        .get(original_url)
        .send()
        .await
        .map_err(|error| format!("failed to fetch image URL {}: {}", original_url, error))?;
    if !response.status().is_success() {
        return Err(format!(
            "image URL returned {} for {}",
            response.status(),
            original_url
        ));
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("failed to read image body {}: {}", original_url, error))?;
    if bytes.is_empty() {
        return Err(format!("image URL returned empty body: {}", original_url));
    }

    Ok(ParsedDataUrl {
        extension: content_type
            .as_deref()
            .and_then(image_extension_from_content_type)
            .or_else(|| extension_from_url(original_url))
            .unwrap_or_else(|| ".jpg".to_string()),
        bytes: bytes.to_vec(),
    })
}

fn build_http_client() -> Result<Client, String> {
    let mut headers = HeaderMap::new();
    let header_value = HeaderValue::from_str(DEFAULT_IMAGE_USER_AGENT)
        .map_err(|error| format!("invalid image user agent: {}", error))?;
    headers.insert(USER_AGENT, header_value);

    Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|error| format!("failed to build image HTTP client: {}", error))
}

#[derive(Debug, Clone)]
struct ImageSource {
    original_url: String,
    data_url: Option<String>,
    replace_target: String,
}

fn resolve_image_field(object: &mut Map<String, Value>, current_key: &str, original_key: &str) -> Option<ImageSource> {
    let current_value = object
        .get(current_key)
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let original_value = take_string_field(object, original_key);

    let data_url = current_value
        .as_ref()
        .filter(|value| value.starts_with("data:"))
        .cloned();
    let replace_target = current_value
        .clone()
        .or_else(|| original_value.clone())
        .unwrap_or_default();
    let original_url = original_value
        .or_else(|| current_value.clone().filter(|value| !is_local_cache_url(value)))?;

    Some(ImageSource {
        original_url,
        data_url,
        replace_target,
    })
}

fn add_trace_u64(comment: &mut Value, key: &str, value: u64) {
    let Some(comment_obj) = comment.as_object_mut() else {
        return;
    };
    let trace = comment_obj
        .entry("_komehubTrace".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !trace.is_object() {
        *trace = Value::Object(Map::new());
    }
    if let Some(trace_obj) = trace.as_object_mut() {
        trace_obj.insert(key.to_string(), Value::from(value));
    }
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn build_local_url(port: u16, cache_type: CacheType, file_name: &str) -> String {
    format!(
        "http://127.0.0.1:{}/cache/{}/{}",
        port,
        cache_type.dir_name(),
        file_name
    )
}

fn take_string_field(comment_obj: &mut Map<String, Value>, key: &str) -> Option<String> {
    comment_obj
        .remove(key)
        .and_then(|value| value.as_str().map(|text| text.to_string()))
}

fn is_local_cache_url(value: &str) -> bool {
    value.contains("/cache/avatars/")
        || value.contains("/cache/badges/")
        || value.contains("/cache/emojis/")
        || value.contains("/cache/stickers/")
}

async fn find_cached(cache_dir: &Path, safe_handle: &str) -> Result<Option<String>, String> {
    let mut entries = match tokio::fs::read_dir(cache_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read image cache dir {}: {}",
                cache_dir.display(),
                error
            ))
        }
    };

    let prefix = format!("{}_", safe_handle);
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("failed to iterate image cache dir {}: {}", cache_dir.display(), error))?
    {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with(&prefix) {
            return Ok(Some(file_name));
        }
    }

    Ok(None)
}

fn extract_cached_hash(file_name: &str, safe_handle: &str) -> Option<String> {
    let prefix = format!("{}_", safe_handle);
    file_name
        .strip_prefix(&prefix)
        .and_then(|rest| rest.rsplit_once('.').map(|(hash, _)| hash.to_string()))
}

fn sanitize_handle(handle: &str) -> String {
    let trimmed = handle.strip_prefix('@').unwrap_or(handle);
    trimmed
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .collect()
}

fn url_hash(url: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(url.as_bytes());
    let digest = hasher.finalize();
    digest[..3]
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

struct ParsedDataUrl {
    extension: String,
    bytes: Vec<u8>,
}

fn parse_data_url(data_url: &str) -> Result<ParsedDataUrl, String> {
    let Some((metadata, encoded)) = data_url.strip_prefix("data:").and_then(|value| value.split_once(',')) else {
        return Err("invalid data URL".to_string());
    };
    if !metadata.ends_with(";base64") {
        return Err("data URL is not base64 encoded".to_string());
    }

    let mime_type = metadata
        .split(';')
        .next()
        .ok_or_else(|| "data URL has no MIME type".to_string())?;
    if !mime_type.starts_with("image/") {
        return Err(format!("unsupported data URL MIME type: {}", mime_type));
    }

    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| format!("invalid base64 image data: {}", error))?;

    Ok(ParsedDataUrl {
        extension: extension_from_mime(mime_type),
        bytes,
    })
}

fn extension_from_mime(mime_type: &str) -> String {
    let subtype = mime_type.strip_prefix("image/").unwrap_or("jpeg");
    match subtype {
        "jpeg" => ".jpg".to_string(),
        "svg+xml" => ".svg".to_string(),
        "x-icon" => ".ico".to_string(),
        "" => ".jpg".to_string(),
        value => format!(".{}", value),
    }
}

fn image_extension_from_content_type(content_type: &str) -> Option<String> {
    let mime = content_type.split(';').next()?.trim();
    if !mime.starts_with("image/") {
        return None;
    }
    Some(extension_from_mime(mime))
}

fn extension_from_url(original_url: &str) -> Option<String> {
    let url = Url::parse(original_url).ok()?;
    let path = url.path();
    let ext = path.rsplit_once('.')?.1;
    if ext.is_empty() {
        return None;
    }
    let ext = ext
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '+' || *ch == '-')
        .collect::<String>()
        .to_ascii_lowercase();
    if ext.is_empty() {
        return None;
    }
    Some(extension_from_mime(&format!("image/{}", ext)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_media_cache_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("komehub-image-cache-{}-{}", name, unique));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn png_data_url(seed: &str) -> String {
        format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(format!("png-{}", seed))
        )
    }

    #[test]
    fn sanitize_handle_matches_js_rules() {
        assert_eq!(sanitize_handle("@name"), "name");
        assert_eq!(sanitize_handle(r#"a<b>:"/\|?*c"#), "a_b________c");
    }

    #[test]
    fn url_hash_matches_legacy_length() {
        assert_eq!(url_hash("https://example.com/test.png").len(), 6);
    }

    #[tokio::test]
    async fn cache_image_normalizes_protocol_relative_url() {
        // 2026-05-15 実機 DB から発見: YouTube は sticker URL を `//host/path` で返すケースがあり、
        // 正規化しないと reqwest::Client::get が URL parse 失敗で fetch エラー → cache されない。
        // 正規化後の hash は `https:` 補完版で計算されることを保証する。
        let media_cache_dir = temp_media_cache_dir("proto-rel");
        let client = build_http_client().expect("http client");

        let result = cache_image(
            &media_cache_dir,
            11280,
            CacheType::Stickers,
            "@sticker-tester",
            "//cdn.example.com/sticker.png",
            Some(&png_data_url("sticker-proto-rel")),
            &client,
        )
        .await
        .expect("cache image");
        assert!(!result.hit);
        let expected_hash = url_hash("https://cdn.example.com/sticker.png");
        let file_name = result.file_name.expect("file name");
        assert!(
            file_name.contains(&expected_hash),
            "file_name {} should contain hash {} from normalized URL",
            file_name,
            expected_hash
        );

        std::fs::remove_dir_all(&media_cache_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn cache_image_replaces_stale_file() {
        let media_cache_dir = temp_media_cache_dir("stale");
        let client = build_http_client().expect("http client");

        let first = cache_image(
            &media_cache_dir,
            11280,
            CacheType::Avatars,
            "@tester",
            "https://example.com/a.png",
            Some(&png_data_url("first")),
            &client,
        )
        .await
        .expect("first cache");
        assert!(!first.hit);

        let second = cache_image(
            &media_cache_dir,
            11280,
            CacheType::Avatars,
            "@tester",
            "https://example.com/b.png",
            Some(&png_data_url("second")),
            &client,
        )
        .await
        .expect("second cache");
        assert!(!second.hit);
        assert_ne!(first.file_name, second.file_name);

        let avatar_dir = media_cache_dir.join("avatars");
        let files: Vec<String> = std::fs::read_dir(&avatar_dir)
            .expect("avatar dir")
            .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(Some(files[0].clone()), second.file_name);

        std::fs::remove_dir_all(&media_cache_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn cache_comment_images_rewrites_comment_fields() {
        let temp_dir = temp_media_cache_dir("comments");
        let comments_json = serde_json::json!([
            {
                "id": "comment-1",
                "name": "@tester",
                "profileImage": png_data_url("avatar"),
                "_originalProfileImage": "https://example.com/avatar.png",
                "commentHtml": "<img src=\"data:image/png;base64,ZW1vamk=\">",
                "emojis": [
                    {
                        "emojiId": "emoji-1",
                        "src": "data:image/png;base64,ZW1vamk="
                    }
                ]
            }
        ])
        .to_string();

        let cached_json = cache_comment_images(&temp_dir, 11280, &comments_json)
            .await
            .expect("cache_comment_images");
        let cached: Vec<Value> = serde_json::from_str(&cached_json).expect("cached comments");
        let comment = cached[0].as_object().expect("comment object");

        assert!(
            comment
                .get("profileImage")
                .and_then(Value::as_str)
                .expect("profileImage")
                .starts_with("http://127.0.0.1:11280/cache/avatars/")
        );
        assert!(comment.get("_originalProfileImage").is_none());
        // YouTube CDN 生 URL は originalProfileImage に退避され、わんコメ書き戻しで使われる
        assert_eq!(
            comment.get("originalProfileImage").and_then(Value::as_str),
            Some("https://example.com/avatar.png")
        );
        assert!(
            comment
                .get("commentHtml")
                .and_then(Value::as_str)
                .expect("commentHtml")
                .contains("/cache/emojis/")
        );

        std::fs::remove_dir_all(&temp_dir).expect("cleanup temp dir");
    }
}
