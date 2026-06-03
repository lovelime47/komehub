//! VideoOwnerResolver — わんコメ DB import 時に未知の video_id の owner_channel_id を
//! Electron 側 (HTTP fetch with cookie) に同期 RPC で解決する仕組み。
//!
//! ## 背景
//!
//! こめはぶ `import_from_onecomme` の owner フィルタは、 listeners.db の streams
//! テーブルから owner_channel_id を引いて自チャ判定する。 streams 行は通常
//! chat-scraper で直接接続した枠でのみ作られる → わんコメ経由でしか見ていない枠は
//! streams に無く、 owner 判定不能 → コメ全件 filter 除外、 という鶏卵問題があった。
//!
//! ## 解決方針
//!
//! ロジックは Rust に閉じ込めつつ、 「Electron が持つ Cookie で HTTP fetch できる」
//! 能力だけを callback として委譲する。 Electron は callback の中身 (= net.request
//! + 並列 Promise.all + 抽出) だけ持つ。
//!
//! ## 同期 RPC の仕組み
//!
//! 1. 起動時 Electron が `register_video_owner_resolver(callback)` で TsFn を登録
//! 2. `import_from_onecomme` (= spawn_blocking 内で動く sync 関数) が unknown video_id
//!    集合を検出
//! 3. `resolve_unknown_owners_blocking(ids)` を呼ぶ → tokio runtime Handle で
//!    `block_on(callback.call_async(ids))` → JS 側で並列 fetch → Promise resolve
//!    → Rust 側で結果取得
//! 4. 結果を import_from_onecomme の stream_owner_cache に事前埋め → 既存 Pass 2
//!    ループが自然に streams に upsert
//!
//! callback 未登録時 / 解決失敗時は空 Vec を返す (= 既存挙動 = filter で弾く と同じ)。

use std::future::IntoFuture;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;

/// JS 側から渡される 1 つの video_id に対する解決結果。
///
/// channel_name / title は記録できれば streams に保存される (= 表示用)。
/// 解決失敗 (= 削除動画 / fetch エラー) の場合は Vec から除外して返す前提。
#[napi(object)]
#[derive(Debug, Clone)]
pub struct VideoOwnerMeta {
    pub video_id: String,
    pub owner_channel_id: String,
    pub channel_name: Option<String>,
    pub title: Option<String>,
}

/// 起動後の任意のタイミングで Electron が登録する resolver callback。
///
/// 型: `(video_ids: string[]) => Promise<VideoOwnerMeta[]>`
///
/// Mutex<Option<...>> で持つ理由:
/// - 起動順序: core 初期化 → register 呼出 で順序保証なし (= None 期間あり)
/// - 再登録: Electron 再起動なしで callback 差し替え可能にする (= 開発時に便利)
///
/// napi-rs 3.x の TsFn デフォルト generic (= CalleeHandled=true) を採用、 call_async は
/// `Result<T, Status>` を取る (= JS callback の throw を Rust 側でハンドル可能)。
pub type ResolverCallback = ThreadsafeFunction<Vec<String>, Promise<Vec<VideoOwnerMeta>>>;

// napi-rs 3.x の `ThreadsafeFunction` は `Clone` を実装していないので、 共有のために
// `Arc` でラップして保持する。 `call_async` は `&self` で呼べるので Arc 経由で問題ない。
static RESOLVER: Mutex<Option<Arc<ResolverCallback>>> = Mutex::new(None);

/// Electron から callback を登録する。 napi_bridge から呼ばれる。
pub fn set_resolver(callback: ResolverCallback) {
    let mut guard = RESOLVER.lock().expect("RESOLVER mutex poisoned");
    *guard = Some(Arc::new(callback));
    tracing::info!("video_owner_resolver: callback registered");
}

/// callback の登録解除 (= Electron 終了時、 テストで使う想定、 通常は不要)。
#[allow(dead_code)]
pub fn clear_resolver() {
    let mut guard = RESOLVER.lock().expect("RESOLVER mutex poisoned");
    *guard = None;
}

/// 未知 video_id 群を Electron resolver で解決して owner meta を返す。
///
/// **spawn_blocking 内から呼ぶ前提** (= 内部で `Handle::current().block_on()` する)。
/// import_from_onecomme は listener_sync_queue 上の spawn_blocking で動くので OK。
///
/// callback 未登録時 / 解決失敗時は空 Vec を返す。 呼び出し側 (= import) は
/// 「解決できなかった video_id は streams に登録されない → 既存 filter で弾かれる」
/// 既存挙動を維持する。
pub fn resolve_unknown_owners_blocking(video_ids: Vec<String>) -> Vec<VideoOwnerMeta> {
    if video_ids.is_empty() {
        return Vec::new();
    }
    let callback: Arc<ResolverCallback> = {
        let guard = RESOLVER.lock().expect("RESOLVER mutex poisoned");
        match guard.as_ref() {
            Some(cb) => Arc::clone(cb),
            None => {
                tracing::debug!(
                    "video_owner_resolver: callback not registered, skipping {} ids",
                    video_ids.len()
                );
                return Vec::new();
            }
        }
    };

    let id_count = video_ids.len();
    tracing::info!(
        "video_owner_resolver: resolving {} unknown video ids via Electron callback: {:?}",
        id_count,
        video_ids
    );

    let handle = match tokio::runtime::Handle::try_current() {
        Ok(h) => h,
        Err(_) => {
            tracing::warn!(
                "video_owner_resolver: no tokio runtime available (sync context?), skipping"
            );
            return Vec::new();
        }
    };

    // block_on で JS callback を同期待ち。 spawn_blocking 内なので block_on OK。
    // CalleeHandled=true (デフォルト) なので call_async は Result<T, Status> を受ける。
    // 戻り値は Promise<Vec<...>> → into_future().await で実値を取得 (= 2 段 await)。
    let result: std::result::Result<Vec<VideoOwnerMeta>, String> = handle.block_on(async move {
        let promise: Promise<Vec<VideoOwnerMeta>> = callback
            .call_async(Ok(video_ids))
            .await
            .map_err(|e| format!("call_async failed: {}", e))?;
        let metas: Vec<VideoOwnerMeta> = promise
            .into_future()
            .await
            .map_err(|e| format!("promise await failed: {}", e))?;
        Ok(metas)
    });

    match result {
        Ok(metas) => {
            tracing::info!(
                "video_owner_resolver: resolved {} / {} video ids",
                metas.len(),
                id_count
            );
            metas
        }
        Err(err) => {
            tracing::warn!("video_owner_resolver: resolution failed: {}", err);
            Vec::new()
        }
    }
}
