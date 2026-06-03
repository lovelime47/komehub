use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn parse_comment_timestamp_ms(timestamp: &str) -> Option<i64> {
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;
    if timestamp.is_empty() {
        return None;
    }
    OffsetDateTime::parse(timestamp, &Rfc3339)
        .ok()
        .map(|dt| (dt.unix_timestamp_nanos() / 1_000_000) as i64)
}

pub(crate) fn format_unix_ms_iso(ms: i64) -> String {
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;
    if ms <= 0 {
        return String::new();
    }
    OffsetDateTime::from_unix_timestamp_nanos((ms as i128) * 1_000_000)
        .ok()
        .and_then(|dt| dt.format(&Rfc3339).ok())
        .unwrap_or_default()
}

pub(crate) fn comment_superchat_jpy(comment: &crate::state::comment::RawComment) -> i64 {
    if !comment.has_gift && !comment.is_membership_gift {
        return 0;
    }
    if comment.amount <= 0.0 {
        return 0;
    }
    crate::common::fx_rates::fallback_amount_to_jpy(comment.amount, &comment.currency).unwrap_or(0)
}

pub(crate) fn stamp_comments_trace(comments: &mut [crate::state::comment::RawComment], key: &str) {
    let now = current_millis();
    for comment in comments {
        comment.set_trace_ms(key, now);
    }
}

pub(crate) fn stamp_value_trace(
    value: &mut serde_json::Value,
    key: &str,
    trace_value: serde_json::Value,
) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let trace = obj
        .entry("_komehubTrace".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !trace.is_object() {
        *trace = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(trace_obj) = trace.as_object_mut() {
        trace_obj.insert(key.to_string(), trace_value);
    }
}
