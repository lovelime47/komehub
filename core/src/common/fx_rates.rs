//! Step 3 リスナー管理: 為替レートのソース既定値（最終フォールバック専用）。
//!
//! 通常は公式配信サーバーから取得した為替レート → ローカルキャッシュ →
//! ここの既定値、の 3 段フォールバック。
//!
//! このテーブルはリリース時に作者がメンテする。**精度低めでも全 API 不通時の
//! 動作保証になることが目的**。フェーズ 3.1 時点では公式サーバー取得未実装の
//! ため、record_comment はここから直接引く。

/// USD ベースで集計した「1 通貨 = X 円」の既定値。
/// 通貨コードは ISO 4217 大文字 (例: "JPY", "USD")。
pub const FX_RATES_JPY_FALLBACK: &[(&str, f64)] = &[
    ("JPY",   1.0),
    ("USD", 150.0),
    ("EUR", 160.0),
    ("GBP", 190.0),
    ("AUD", 100.0),
    ("CAD", 110.0),
    ("HKD",  19.0),
    ("KRW",   0.11),
    ("TWD",   4.7),
    ("MXN",   8.5),
    ("PHP",   2.6),
    ("INR",   1.8),
    ("BRL",  30.0),
    ("CHF", 175.0),
    ("CNY",  21.0),
    ("NZD",  90.0),
    ("SEK",  14.0),
    ("NOK",  14.0),
    ("DKK",  21.5),
    ("PLN",  37.0),
    ("SGD", 110.0),
    ("THB",   4.4),
    ("ZAR",   8.0),
    ("ARS",   0.11),
    ("CLP",   0.16),
    ("COP",   0.034),
    ("PEN",  39.0),
    ("RUB",   1.7),
    ("TRY",   3.6),
];

/// 通貨記号 (¥, $, € 等) や混在表記から ISO 通貨コードを推定する。
/// chat-scraper 経路の `RawComment.currency` は `"¥"` `"$"` `"JPY"` `"USD"` 等
/// が混在するため、ここで正規化する。
pub fn normalize_currency(input: &str) -> &str {
    match input.trim() {
        "¥" | "JP¥" | "￥" => "JPY",
        "$" | "USD$" => "USD",
        "€" => "EUR",
        "£" => "GBP",
        "A$" => "AUD",
        "C$" => "CAD",
        "HK$" => "HKD",
        "NT$" => "TWD",
        "₩" => "KRW",
        "₹" => "INR",
        "₱" => "PHP",
        "R$" => "BRL",
        "S$" => "SGD",
        "MX$" => "MXN",
        "NZ$" => "NZD",
        "kr" => "SEK", // SEK / NOK / DKK 区別は不能、デフォルト SEK
        "zł" => "PLN",
        "฿" => "THB",
        "R" => "ZAR",
        "₽" => "RUB",
        "₺" => "TRY",
        c => c,
    }
}

/// `amount_raw` を JPY に換算した整数を返す。未対応通貨は None。
pub fn fallback_amount_to_jpy(amount_raw: f64, currency: &str) -> Option<i64> {
    if !amount_raw.is_finite() {
        return None;
    }
    let code = normalize_currency(currency);
    FX_RATES_JPY_FALLBACK
        .iter()
        .find(|(c, _)| c.eq_ignore_ascii_case(code))
        .map(|(_, rate)| (amount_raw * rate).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpy_passes_through() {
        assert_eq!(fallback_amount_to_jpy(500.0, "JPY"), Some(500));
        assert_eq!(fallback_amount_to_jpy(500.0, "¥"), Some(500));
    }

    #[test]
    fn usd_uses_default_rate() {
        assert_eq!(fallback_amount_to_jpy(10.0, "USD"), Some(1500));
        assert_eq!(fallback_amount_to_jpy(10.0, "$"), Some(1500));
    }

    #[test]
    fn unsupported_currency_returns_none() {
        assert_eq!(fallback_amount_to_jpy(100.0, "XXX"), None);
    }

    #[test]
    fn nan_or_infinity_returns_none() {
        assert_eq!(fallback_amount_to_jpy(f64::NAN, "JPY"), None);
        assert_eq!(fallback_amount_to_jpy(f64::INFINITY, "JPY"), None);
    }

    #[test]
    fn taiwan_dollar_via_symbol() {
        assert_eq!(fallback_amount_to_jpy(100.0, "NT$"), Some(470));
    }
}
