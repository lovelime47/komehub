use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use reqwest::{Client, Url};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const DEFAULT_FONT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_FONT_CSS_URL_TEMPLATE: &str =
    "https://fonts.googleapis.com/css2?family={family}:wght@400;500;600;700&display=swap";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureFontsResult {
    pub ok: bool,
    pub results: Vec<EnsureFontResult>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureFontResult {
    pub family: String,
    pub safe_family: String,
    pub cached: bool,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontDownloadProgress {
    pub current: usize,
    pub total: usize,
    pub family: String,
}

pub async fn ensure_fonts<F>(
    media_cache_dir: &Path,
    families: &[String],
    mut on_progress: F,
) -> EnsureFontsResult
where
    F: FnMut(FontDownloadProgress),
{
    let unique_families = dedupe_families(families);
    let client = match build_http_client() {
        Ok(client) => client,
        Err(error) => {
            return EnsureFontsResult {
                ok: false,
                results: unique_families
                    .into_iter()
                    .map(|family| EnsureFontResult {
                        family: family.clone(),
                        safe_family: sanitize_family(&family),
                        cached: false,
                        ok: false,
                        error: Some(error.clone()),
                    })
                    .collect(),
            };
        }
    };

    let uncached_total = unique_families
        .iter()
        .filter(|family| !font_css_path(media_cache_dir, family).exists())
        .count();
    let mut current = 0usize;
    let mut results = Vec::with_capacity(unique_families.len());
    let mut all_ok = true;

    for family in unique_families {
        if !font_css_path(media_cache_dir, &family).exists() {
            current += 1;
            on_progress(FontDownloadProgress {
                current,
                total: uncached_total,
                family: family.clone(),
            });
        }

        let result = ensure_font_family(media_cache_dir, &client, &family).await;
        all_ok &= result.ok;
        results.push(result);
    }

    EnsureFontsResult { ok: all_ok, results }
}

pub fn sanitize_family(family: &str) -> String {
    let invalid = invalid_family_chars_regex().replace_all(family, "_");
    whitespace_regex().replace_all(invalid.as_ref(), "_").into_owned()
}

async fn ensure_font_family(
    media_cache_dir: &Path,
    client: &Client,
    family: &str,
) -> EnsureFontResult {
    let safe_family = sanitize_family(family);
    let family_dir = media_cache_dir.join("fonts").join(&safe_family);
    let css_path = family_dir.join("font.css");

    if css_path.exists() {
        return EnsureFontResult {
            family: family.to_string(),
            safe_family,
            cached: true,
            ok: true,
            error: None,
        };
    }

    let result = ensure_font_family_inner(client, family, &safe_family, &family_dir, &css_path).await;
    match result {
        Ok(()) => EnsureFontResult {
            family: family.to_string(),
            safe_family,
            cached: false,
            ok: true,
            error: None,
        },
        Err(error) => EnsureFontResult {
            family: family.to_string(),
            safe_family,
            cached: false,
            ok: false,
            error: Some(error),
        },
    }
}

async fn ensure_font_family_inner(
    client: &Client,
    family: &str,
    safe_family: &str,
    family_dir: &Path,
    css_path: &Path,
) -> Result<(), String> {
    tokio::fs::create_dir_all(family_dir)
        .await
        .map_err(|error| format!("failed to create font cache dir: {}", error))?;

    let css_url = build_font_css_url(family)?;
    let original_css = client
        .get(css_url.clone())
        .send()
        .await
        .map_err(|error| format!("failed to fetch font CSS: {}", error))?
        .error_for_status()
        .map_err(|error| format!("failed to fetch font CSS: {}", error))?
        .text()
        .await
        .map_err(|error| format!("failed to read font CSS: {}", error))?;

    let remote_urls = extract_font_urls(&original_css);
    if remote_urls.is_empty() {
        return Err("no font URLs in CSS".to_string());
    }

    let mut local_css = original_css;
    for remote_url in remote_urls {
        let resolved_url = resolve_remote_url(&css_url, &remote_url)?;
        let file_name = resolved_url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("font URL has no file name: {}", resolved_url))?;
        let local_url = format!("/cache/fonts/{}/{}", safe_family, file_name);
        let file_path = family_dir.join(file_name);

        if !file_path.exists() {
            let bytes = client
                .get(resolved_url.clone())
                .send()
                .await
                .map_err(|error| format!("failed to download font file {}: {}", file_name, error))?
                .error_for_status()
                .map_err(|error| format!("failed to download font file {}: {}", file_name, error))?
                .bytes()
                .await
                .map_err(|error| format!("failed to read font file {}: {}", file_name, error))?;
            tokio::fs::write(&file_path, &bytes)
                .await
                .map_err(|error| format!("failed to save font file {}: {}", file_name, error))?;
        }

        local_css = local_css.replace(&remote_url, &local_url);
    }

    tokio::fs::write(css_path, local_css)
        .await
        .map_err(|error| format!("failed to save font CSS: {}", error))?;
    Ok(())
}

fn build_http_client() -> Result<Client, String> {
    let mut headers = HeaderMap::new();
    let user_agent = std::env::var("KOMEHUB_FONT_USER_AGENT")
        .unwrap_or_else(|_| DEFAULT_FONT_USER_AGENT.to_string());
    let header_value = HeaderValue::from_str(&user_agent)
        .map_err(|error| format!("invalid font user agent: {}", error))?;
    headers.insert(USER_AGENT, header_value);

    Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|error| format!("failed to build HTTP client: {}", error))
}

fn build_font_css_url(family: &str) -> Result<Url, String> {
    let template = std::env::var("KOMEHUB_FONT_CSS_BASE_URL_TEMPLATE")
        .unwrap_or_else(|_| DEFAULT_FONT_CSS_URL_TEMPLATE.to_string());
    let encoded_family = percent_encode(family);
    let url = template.replace("{family}", &encoded_family);
    Url::parse(&url).map_err(|error| format!("invalid font CSS URL: {}", error))
}

fn extract_font_urls(css: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    for captures in font_url_regex().captures_iter(css) {
        let Some(remote_url) = captures.get(1) else {
            continue;
        };
        let remote_url = remote_url.as_str().to_string();
        if seen.insert(remote_url.clone()) {
            urls.push(remote_url);
        }
    }
    urls
}

fn resolve_remote_url(css_url: &Url, remote_url: &str) -> Result<Url, String> {
    match Url::parse(remote_url) {
        Ok(url) => Ok(url),
        Err(_) => css_url
            .join(remote_url)
            .map_err(|error| format!("invalid font asset URL {}: {}", remote_url, error)),
    }
}

fn font_css_path(media_cache_dir: &Path, family: &str) -> PathBuf {
    media_cache_dir
        .join("fonts")
        .join(sanitize_family(family))
        .join("font.css")
}

fn dedupe_families(families: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for family in families {
        let family = family.trim();
        if family.is_empty() {
            continue;
        }
        if seen.insert(family.to_string()) {
            deduped.push(family.to_string());
        }
    }
    deduped
}

fn percent_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push_str(&format!("{:02X}", byte));
            }
        }
    }
    encoded
}

fn invalid_family_chars_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r#"[<>:"/\\|?*]"#).expect("valid invalid-char regex"))
}

fn whitespace_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\s+").expect("valid whitespace regex"))
}

fn font_url_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"url\((?:['"]?)(https?://[^)'"]+)(?:['"]?)\)"#).expect("valid font URL regex")
    })
}

#[cfg(test)]
mod tests {
    use super::{dedupe_families, extract_font_urls, percent_encode, sanitize_family};

    #[test]
    fn sanitize_family_matches_js_rules() {
        assert_eq!(sanitize_family("Noto Sans JP"), "Noto_Sans_JP");
        assert_eq!(sanitize_family("A/B:C"), "A_B_C");
    }

    #[test]
    fn extract_font_urls_keeps_unique_order() {
        let css = "@font-face{src:url(https://example.com/a.woff2)}\n@font-face{src:url(\"https://example.com/a.woff2\"),url('https://example.com/b.woff2')}";
        assert_eq!(
            extract_font_urls(css),
            vec![
                "https://example.com/a.woff2".to_string(),
                "https://example.com/b.woff2".to_string(),
            ]
        );
    }

    #[test]
    fn dedupe_families_skips_empty_values() {
        assert_eq!(
            dedupe_families(&[
                "Noto Sans JP".to_string(),
                "".to_string(),
                "Noto Sans JP".to_string(),
                "Zen Maru Gothic".to_string(),
            ]),
            vec!["Noto Sans JP".to_string(), "Zen Maru Gothic".to_string()]
        );
    }

    #[test]
    fn percent_encode_uses_utf8_bytes() {
        assert_eq!(percent_encode("M PLUS Rounded 1c"), "M%20PLUS%20Rounded%201c");
        assert_eq!(percent_encode("あ"), "%E3%81%82");
    }
}
