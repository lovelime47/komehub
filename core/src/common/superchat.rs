use std::collections::HashMap;

fn tier_thresholds() -> HashMap<&'static str, [f64; 7]> {
    HashMap::from([
        ("¥", [100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0]),
        ("￥", [100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0]),
        ("JPY", [100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0]),
        ("HK$", [8.0, 15.0, 40.0, 75.0, 150.0, 400.0, 800.0]),
        ("HKD", [8.0, 15.0, 40.0, 75.0, 150.0, 400.0, 800.0]),
        ("NT$", [15.0, 30.0, 75.0, 150.0, 300.0, 750.0, 1500.0]),
        ("TWD", [15.0, 30.0, 75.0, 150.0, 300.0, 750.0, 1500.0]),
        ("TW$", [15.0, 30.0, 75.0, 150.0, 300.0, 750.0, 1500.0]),
        ("₩", [1000.0, 2000.0, 5000.0, 10000.0, 20000.0, 50000.0, 100000.0]),
        ("KRW", [1000.0, 2000.0, 5000.0, 10000.0, 20000.0, 50000.0, 100000.0]),
        ("$", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("US$", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("USD", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("CA$", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("CAD", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("A$", [2.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("AUD", [2.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("NZD", [2.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("SGD", [2.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("S$", [2.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("€", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("EUR", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("£", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("GBP", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("CHF", [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        ("SEK", [5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0]),
        ("NOK", [5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0]),
        ("DKK", [5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0]),
        ("PLN", [2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0]),
        ("CZK", [10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0]),
        ("₹", [20.0, 40.0, 100.0, 200.0, 400.0, 1000.0, 2000.0]),
        ("INR", [20.0, 40.0, 100.0, 200.0, 400.0, 1000.0, 2000.0]),
        ("R$", [2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0]),
        ("BRL", [2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0]),
        ("₱", [25.0, 50.0, 125.0, 250.0, 500.0, 1250.0, 2500.0]),
        ("PHP", [25.0, 50.0, 125.0, 250.0, 500.0, 1250.0, 2500.0]),
        ("MX$", [10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0]),
        ("MXN", [10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0]),
        ("THB", [20.0, 40.0, 100.0, 200.0, 400.0, 1000.0, 2000.0]),
        ("MYR", [2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0]),
        ("IDR", [7000.0, 15000.0, 35000.0, 70000.0, 150000.0, 350000.0, 700000.0]),
        ("VND", [10000.0, 25000.0, 50000.0, 100000.0, 250000.0, 500000.0, 1000000.0]),
    ])
}

pub fn superchat_tier_key(amount: f64, currency: &str, tier_color: &str) -> String {
    if amount <= 0.0 {
        return String::new();
    }

    if let Some(idx) = tier_index_from_color(tier_color) {
        return tier_key_from_index(idx).to_string();
    }

    let thresholds_map = tier_thresholds();
    let currency_trimmed = currency.trim();
    let thresholds = thresholds_map
        .get(currency_trimmed)
        .copied()
        .or_else(|| {
            thresholds_map
                .iter()
                .find(|(key, _)| currency_trimmed.contains(**key))
                .map(|(_, value)| *value)
        })
        .unwrap_or([100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0]);

    for index in (0..thresholds.len()).rev() {
        if amount >= thresholds[index] {
            return tier_key_from_index(index).to_string();
        }
    }

    "blue".to_string()
}

pub fn format_amount_display(amount: f64, currency: &str) -> String {
    if amount <= 0.0 {
        return String::new();
    }

    let currency_trimmed = currency.trim();
    match currency_trimmed {
        "" | "JPY" | "¥" | "円" => format!("¥{}", format_number(amount, 0)),
        "USD" | "$" => format!("${}", format_number(amount, 2)),
        "EUR" | "€" => format!("€{}", format_number(amount, 2)),
        _ => format!("{} {}", currency_trimmed, format_number(amount, if has_fraction(amount) { 2 } else { 0 })),
    }
}

fn tier_index_from_color(color: &str) -> Option<usize> {
    let normalized = normalize_color(color)?;
    let idx = match normalized.as_str() {
        "#1565c0" => 0,
        "#00bfa5" => 1,
        "#1de9b6" => 2,
        "#ffb300" | "#ffca28" => 3,
        "#e65100" | "#f57c00" => 4,
        "#c2185b" | "#e91e63" => 5,
        "#e62117" | "#ff0000" => 6,
        _ => return None,
    };
    Some(idx)
}

fn normalize_color(color: &str) -> Option<String> {
    let trimmed = color.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed.strip_prefix('#') {
        return Some(format!("#{}", hex.to_ascii_lowercase()));
    }
    if let Some(rgb) = trimmed.strip_prefix("rgb(").and_then(|value| value.strip_suffix(')')) {
        let parts: Vec<u8> = rgb
            .split(',')
            .map(|part| part.trim().parse::<u8>())
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        if parts.len() == 3 {
            return Some(format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2]));
        }
    }
    None
}

fn tier_key_from_index(index: usize) -> &'static str {
    match index {
        0 => "blue",
        1 => "teal",
        2 => "green",
        3 => "yellow",
        4 => "orange",
        5 => "magenta",
        _ => "red",
    }
}

fn has_fraction(amount: f64) -> bool {
    (amount.fract()).abs() > f64::EPSILON
}

fn format_number(amount: f64, decimals: usize) -> String {
    let mut value = if decimals == 0 {
        format!("{:.0}", amount)
    } else {
        format!("{:.*}", decimals, amount)
    };

    let sign = if value.starts_with('-') {
        value.remove(0);
        "-"
    } else {
        ""
    };

    let mut parts = value.split('.').collect::<Vec<_>>();
    let integer = parts.remove(0);
    let grouped = group_integer(integer);
    if parts.is_empty() {
        format!("{}{}", sign, grouped)
    } else {
        format!("{}{}.{}", sign, grouped, parts[0])
    }
}

fn group_integer(integer: &str) -> String {
    let chars: Vec<char> = integer.chars().collect();
    let mut out = String::new();
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && (chars.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{format_amount_display, superchat_tier_key};

    #[test]
    fn uses_tier_color_when_available() {
        assert_eq!(superchat_tier_key(10.0, "USD", "rgb(230, 33, 23)"), "red");
    }

    #[test]
    fn falls_back_to_currency_thresholds() {
        assert_eq!(superchat_tier_key(5000.0, "¥", ""), "magenta");
        assert_eq!(superchat_tier_key(10.0, "USD", ""), "yellow");
    }

    #[test]
    fn formats_amount_display_by_currency() {
        assert_eq!(format_amount_display(5000.0, "JPY"), "¥5,000");
        assert_eq!(format_amount_display(10.0, "USD"), "$10.00");
        assert_eq!(format_amount_display(12.5, "HK$"), "HK$ 12.50");
    }
}
