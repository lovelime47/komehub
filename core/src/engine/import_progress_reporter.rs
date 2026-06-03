//! ImportProgressReporter — わんコメ書き戻し import の進捗を Electron に push する仕組み。
//!
//! `import_from_onecomme` は spawn_blocking 内で同期実行されるが、 そこから別 thread の
//! Electron renderer へ進捗を通知するために `ThreadsafeFunction<String>` (= JSON 文字列) を
//! 使う。 NonBlocking 呼び出しで fire-and-forget。
//!
//! UI 側 (= フッタの進捗バー) は phase / current / total / message を受けて表示する。
//! 起動時自動 sync 中、 ユーザーが「ハブが固まった?」 と誤解せず、 完了 / エラー判定可能にする。
//!
//! 設計は `video_owner_resolver` と同じ「callback 登録パターン」:
//! - Electron 起動時に `register_import_progress_reporter(callback)` で 1 度だけ登録
//! - 既存 API は無変更 (= import_from_onecomme シグネチャは触らない、 テスト影響なし)
//! - callback 未登録時 / 失敗時は no-op (= 進捗通知が出ないだけ、 動作影響なし)

use std::sync::{Arc, Mutex};

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

pub type ProgressCallback = ThreadsafeFunction<String>;

static REPORTER: Mutex<Option<Arc<ProgressCallback>>> = Mutex::new(None);

/// Electron から callback を登録する。 napi_bridge から呼ばれる。
pub fn set_reporter(callback: ProgressCallback) {
    let mut guard = REPORTER.lock().expect("REPORTER mutex poisoned");
    *guard = Some(Arc::new(callback));
    tracing::info!("import_progress_reporter: callback registered");
}

/// phase ごとの overall percent レンジ (= 段階重み付け)。
///
/// レンジは「実時間バランス」 で配分: pass2 (= コメ解析メインループ) と
/// flush-comments (= バッチ書き込み) が支配的なので大きく取る。 read / repair /
/// flush-listeners / flush-streams は 1〜数秒で終わるため短い。
///
/// Phase 14 のバックアップ進捗 phase 配分と同じ思想 (= ユーザー指示で再調整可能)。
fn phase_range(phase: &str) -> Option<(u8, u8)> {
    Some(match phase {
        "started" => (0, 1),
        "read" => (1, 5),
        "repair" => (5, 8),
        "pass2" => (8, 70),
        "flush-listeners" => (70, 75),
        "flush-streams" => (75, 80),
        "flush-comments" => (80, 98),
        "watermark" => (98, 99),
        "done" => (100, 100),
        _ => return None, // error / unknown
    })
}

/// phase + current/total から overall percent (0-100) を計算する。
///
/// listener_manager.rs 側の呼出セマンティクスに合わせて吸収:
/// - `started` (0/0): start (= 0%)
/// - `read` / `repair` (0/total): 「完了報告」 とみなして end
/// - `pass2` / `flush-comments` (current/total): start → end へ線形補完
/// - `flush-listeners` / `flush-streams` (0/N): 「開始」 とみなして start
/// - `watermark` / `done`: end
fn overall_percent(phase: &str, current: u64, total: u64) -> Option<u8> {
    let (start, end) = phase_range(phase)?;
    match phase {
        "started" => Some(start),
        "read" | "repair" | "watermark" => Some(end),
        "done" => Some(100),
        "flush-listeners" | "flush-streams" => Some(start),
        "pass2" | "flush-comments" => {
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
/// - `phase`: 段階名 ("started" / "read" / "repair" / "pass2" / "flush-listeners" /
///            "flush-streams" / "flush-comments" / "watermark" / "done" / "error")
/// - `current` / `total`: 進捗カウンタ (= total=0 は「不定」 = spinner、 percent 計算不能)
/// - `message`: 任意の補足メッセージ (= UI 表示用)
///
/// payload には `overallPercent` (= phase 重み付けで 0-100 へ正規化) も含める。
/// UI 側はバーをこの overall_percent で描画し、 current/total はカウンタ表示用にする。
/// callback 未登録時は no-op。 import_from_onecomme は callback 不在でも問題なく動く。
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
    fn read_complete_jumps_to_end() {
        // read は (0, total) で呼ばれるが「DB 読み取り完了」 セマンティクス
        assert_eq!(overall_percent("read", 0, 1000), Some(5));
    }

    #[test]
    fn repair_complete_jumps_to_end() {
        assert_eq!(overall_percent("repair", 0, 1000), Some(8));
    }

    #[test]
    fn pass2_linear_interpolation() {
        // pass2 レンジ [8, 70]、 50% 進行で (8 + 31) = 39
        assert_eq!(overall_percent("pass2", 500, 1000), Some(39));
        assert_eq!(overall_percent("pass2", 0, 1000), Some(8));
        assert_eq!(overall_percent("pass2", 1000, 1000), Some(70));
    }

    #[test]
    fn flush_listeners_at_start() {
        assert_eq!(overall_percent("flush-listeners", 0, 100), Some(70));
    }

    #[test]
    fn flush_comments_linear() {
        // flush-comments レンジ [80, 98]、 50% 進行で (80 + 9) = 89
        assert_eq!(overall_percent("flush-comments", 5000, 10000), Some(89));
        assert_eq!(overall_percent("flush-comments", 0, 10000), Some(80));
        assert_eq!(overall_percent("flush-comments", 10000, 10000), Some(98));
    }

    #[test]
    fn done_is_hundred() {
        assert_eq!(overall_percent("done", 1000, 1000), Some(100));
    }

    #[test]
    fn unknown_phase_returns_none() {
        assert_eq!(overall_percent("error", 0, 0), None);
        assert_eq!(overall_percent("random", 0, 0), None);
    }
}
