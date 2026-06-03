//! ExportProgressReporter — わんコメ書き戻し export の進捗を Electron に push する仕組み。
//!
//! `export_to_onecomme` は ModelQueue spawn_blocking 経路で同期実行されるが、 そこから別
//! thread の Electron renderer へ進捗を通知するために `ThreadsafeFunction<String>`
//! (= JSON 文字列) を使う。 NonBlocking 呼び出しで fire-and-forget。
//!
//! 終了時 (= window close 抑制中) のモーダルダイアログに progress bar + N/M + 経過秒数
//! を出すため、 ユーザーが「フリーズ?」 と誤解せず、 完了/エラー判定可能にする。
//!
//! 設計は `import_progress_reporter` と同じ「callback 登録パターン」:
//! - Electron 起動時に `register_export_progress_reporter(callback)` で 1 度だけ登録
//! - 既存 API は無変更 (= export_to_onecomme シグネチャは触らない、 テスト影響なし)
//! - callback 未登録時 / 失敗時は no-op (= 進捗通知が出ないだけ、 動作影響なし)

use std::sync::{Arc, Mutex};

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

pub type ProgressCallback = ThreadsafeFunction<String>;

static REPORTER: Mutex<Option<Arc<ProgressCallback>>> = Mutex::new(None);

/// Electron から callback を登録する。 napi_bridge から呼ばれる。
pub fn set_reporter(callback: ProgressCallback) {
    let mut guard = REPORTER.lock().expect("REPORTER mutex poisoned");
    *guard = Some(Arc::new(callback));
    tracing::info!("export_progress_reporter: callback registered");
}

/// phase ごとの overall percent レンジ (= 段階重み付け)。
///
/// レンジは「実時間バランス」 で配分: pristine-backup (= わんコメ DB 591 MB クラスの
/// 退避) と write-comments (= 件数線形のバッチ insert) が支配的。 その他は数百 ms〜数秒で
/// 終わる。
///
/// pristine-backup は take_pristine_backup=false (= 2 回目以降の通常終了) では呼ばれない
/// ので、 そのケースでは schema-check 後にいきなり select-comments 40% へ飛ぶ。
fn phase_range(phase: &str) -> Option<(u8, u8)> {
    Some(match phase {
        "started" => (0, 1),
        "schema-check" => (1, 3),
        "preflight" => (3, 4),
        "pristine-backup" => (4, 40),
        "select-comments" => (40, 45),
        "transform" => (45, 50),
        "write-comments" => (50, 85),
        "aggregate-users" => (85, 87),
        "write-users" => (87, 95),
        "watermark" => (95, 98),
        "done" => (100, 100),
        "aborted" => (100, 100),
        _ => return None, // error / unknown
    })
}

/// phase + current/total から overall percent (0-100) を計算する。
///
/// listener_manager.rs 側の呼出セマンティクスに合わせて吸収:
/// - `started` (0/0): start
/// - `schema-check` / `preflight` / `select-comments` / `transform` / `aggregate-users` /
///   `watermark` / `pristine-backup` (0/0): 「完了報告」 とみなして end
/// - `write-comments` / `write-users` (current/total): start → end へ線形補完
/// - `done` / `aborted`: 100
fn overall_percent(phase: &str, current: u64, total: u64) -> Option<u8> {
    let (start, end) = phase_range(phase)?;
    match phase {
        "started" => Some(start),
        "schema-check"
        | "preflight"
        | "pristine-backup"
        | "select-comments"
        | "transform"
        | "aggregate-users"
        | "watermark" => Some(end),
        "done" | "aborted" => Some(100),
        "write-comments" | "write-users" => {
            if total == 0 {
                return Some(start);
            }
            let ratio = (current as f64 / total as f64).clamp(0.0, 1.0);
            let pct = start as f64 + (end as f64 - start as f64) * ratio;
            Some(pct.round() as u8)
        }
        _ => None,
    }
}

/// 進捗を Electron に通知する fire-and-forget API。
///
/// - `phase`: 段階名 ("started" / "schema-check" / "preflight" / "pristine-backup" /
///            "select-comments" / "transform" / "write-comments" / "aggregate-users" /
///            "write-users" / "watermark" / "done" / "aborted" / "error")
/// - `current` / `total`: 進捗カウンタ (= total=0 は「不定」、 percent 計算は phase に依存)
/// - `message`: 任意の補足メッセージ (= UI 表示用)
///
/// payload には `overallPercent` (= phase 重み付けで 0-100 へ正規化) も含める。
/// UI 側はバーをこの overall_percent で描画し、 current/total はカウンタ表示用にする。
/// callback 未登録時は no-op。 export_to_onecomme は callback 不在でも問題なく動く。
pub fn report(phase: &str, current: u64, total: u64, message: Option<&str>) {
    let payload = serde_json::json!({
        "phase": phase,
        "current": current,
        "total": total,
        "message": message,
        "overallPercent": overall_percent(phase, current, total),
    });
    let json = payload.to_string();
    let guard = REPORTER.lock().expect("REPORTER mutex poisoned");
    let Some(cb) = guard.as_ref() else {
        return;
    };
    let cb = cb.clone();
    drop(guard);
    let _ = cb.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn started_is_zero() {
        assert_eq!(overall_percent("started", 0, 0), Some(0));
    }

    #[test]
    fn schema_check_jumps_to_end() {
        assert_eq!(overall_percent("schema-check", 0, 0), Some(3));
    }

    #[test]
    fn pristine_backup_jumps_to_end() {
        assert_eq!(overall_percent("pristine-backup", 0, 0), Some(40));
    }

    #[test]
    fn write_comments_linear_interpolation() {
        // write-comments レンジ [50, 85]、 50% 進行で (50 + 17.5) = 68 (round)
        assert_eq!(overall_percent("write-comments", 5000, 10000), Some(68));
        assert_eq!(overall_percent("write-comments", 0, 10000), Some(50));
        assert_eq!(overall_percent("write-comments", 10000, 10000), Some(85));
    }

    #[test]
    fn write_users_linear_interpolation() {
        // write-users レンジ [87, 95]、 50% 進行で (87 + 4) = 91
        assert_eq!(overall_percent("write-users", 50, 100), Some(91));
    }

    #[test]
    fn done_is_hundred() {
        assert_eq!(overall_percent("done", 0, 0), Some(100));
    }

    #[test]
    fn aborted_is_hundred() {
        assert_eq!(overall_percent("aborted", 0, 0), Some(100));
    }

    #[test]
    fn unknown_phase_returns_none() {
        assert_eq!(overall_percent("error", 0, 0), None);
        assert_eq!(overall_percent("random", 0, 0), None);
    }
}
