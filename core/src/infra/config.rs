pub const DEFAULT_PUBLIC_HTTP_PORT: u16 = 11280;
pub const DEFAULT_PUBLIC_HTTP_BIND_ADDR: &str = "127.0.0.1";

pub fn configured_public_http_port() -> u16 {
    std::env::var("KOMEHUB_PUBLIC_HTTP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PUBLIC_HTTP_PORT)
}

pub fn configured_public_http_bind_addr() -> String {
    std::env::var("KOMEHUB_PUBLIC_HTTP_BIND_ADDR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PUBLIC_HTTP_BIND_ADDR.to_string())
}
