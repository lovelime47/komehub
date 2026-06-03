//! BackupManager — バックアップの作成・一覧・削除・リストア。
//!
//! %APPDATA%/live-comment-hub/backups/ 配下に、バックアップ 1 件 = 1 ファイル
//! (`Komehub-<type>-<YYYY-MM-DD-HHMM>-<short_id>.tar`) として保存する。
//!
//! tar コンテナ (無圧縮 PAX) を採用する理由:
//! - 数百 GB 規模を想定 → ZIP の 4 GB 制限 / 互換性問題で扱いづらい
//! - 中身は listeners.db (= zstd 事前圧縮) と画像 / フォント (= 既圧縮) が大半なので、
//!   外側圧縮は CPU 食うだけでサイズ削減効果が薄い
//! - 部分復元 (= tar entry 単位で読める) と ストリーミング作成 / 復元が容易
//!
//! 各バックアップは meta.json (tar 内、 末尾付近) と backup-index.json (= 一覧用、
//! backups/ 直下に 1 ファイル) で管理。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rayon::prelude::*;

use crate::engine::effect_manager::{self, is_valid_effect_id, EffectManager};
use crate::engine::listener_manager::ListenerManager;
use crate::infra::zip_utils;
use crate::state::scene::{EffectDefinition, EffectsFile, SceneStore};

/// フルバックアップで DB を zstd 圧縮するときの level (1〜22)。
/// 3 は zstd default。バックアップ用途では 3 でも 1.6 GB → ~90 MB (17:1) に縮む。
/// 上げる (10〜) と CPU 時間がかなり伸びる割に追加削減は少ない。
const ZSTD_LEVEL: i32 = 3;

/// unpack_raw_zst_to_text の chunk サイズ (= 1 transaction で書き戻す行数)。
/// 1 chunk 内で zstd decode を rayon par_iter で並列化するため、 大 chunk のほうが
/// CPU multi-core 活用率が上がる (= 10000 件 × 4 KB 平均 ≒ 40 MB のメモリピーク、 余裕)。
/// migration 側 (= migrate_comments_raw_to_zstd) は 1000 件のままで起動時負荷を抑える。
const UNPACK_CHUNK_ROWS: usize = 10000;

/// DB-heavy 並列処理 (= backup unpack / migration 等) で使う rayon スレッド数。
/// 「物理コア × 3/4」 で全論理コアを使い切らないようにし、 PC 全体が重くなる UX を避ける。
/// 例: 物理 16 → 12 スレッド (= 32 論理コアのうち 12 だけ使用、 残り 20 は他作業に確保)。
/// listener_manager::migrate_comments_raw_to_zstd からも参照される。
pub fn unpack_thread_count() -> usize {
    let physical = num_cpus::get_physical();
    ((physical * 3) / 4).max(1)
}

/// db-compress phase の予想所要秒数を計算する (= UI 表示用)。
///
/// zstd L3 圧縮の処理速度仮定: 約 100 MB/s (= 保守的、 環境とデータ依存)。
/// 1.6 GB の listeners.db (= unpack 後) で 約 16 秒。 実測ズレが目立つなら係数調整。
fn estimate_compress_seconds(input_bytes: u64) -> u64 {
    let mb = input_bytes as f64 / 1_048_576.0;
    let sec = mb / 100.0;
    sec.round().max(1.0) as u64
}

/// db-unpack phase の予想所要秒数を計算する (= UI 表示用、 JS 側はこの値をそのまま見せる)。
///
/// 計算根拠 (= 2026-05-17 実機実測 from `core.log`):
/// - シリアル時 1 件あたり処理時間: 286 秒 / 433796 件 ≒ **0.66 ms/件**
/// - 並列化効率 (= 並列度に対する実効倍率): 12 スレッドで 6.15 倍速 → **約 51%**
///   (= SQLite UPDATE がシリアル必須のため、 zstd decode が並列化されても律速で半減)
///
/// 別環境 (= 物理コア違うマシン) でも、 SQLite UPDATE シリアル化は同じなので、 効率係数
/// 0.51 はそれなりの汎用性で通じるはず。 実測でズレが目立つようなら調整する。
fn estimate_unpack_seconds(rows: u64, threads: usize) -> u64 {
    let serial_ms = rows as f64 * 0.66;
    let parallel_ms = serial_ms / threads.max(1) as f64 / 0.51;
    (parallel_ms / 1000.0).round().max(1.0) as u64
}

/// migrate phase (= 復元後の起動時 raw TEXT → raw_zst BLOB 再変換) の予想所要秒数。
///
/// 計算根拠 (= 2026-05-17 復元実機実測):
/// - シリアル換算 1 件あたり: 433796 件 / 68 秒 / 12 スレッド / 0.51 効率 = 約 0.96 ms/件
/// - つまり migrate (= zstd encode) は unpack (= zstd decode) より 約 1.46 倍時間がかかる
///   (= 圧縮側のほうが計算重い、 zstd の一般性質)
/// - 並列効率は unpack と同じ 0.51 を採用 (= SQLite UPDATE 律速)
pub fn estimate_migrate_seconds(rows: u64, threads: usize) -> u64 {
    let serial_ms = rows as f64 * 0.96;
    let parallel_ms = serial_ms / threads.max(1) as f64 / 0.51;
    (parallel_ms / 1000.0).round().max(1.0) as u64
}

/// 1 ファイル backup の拡張子。
/// 命名規約: `Komehub-<type>-<YYYY-MM-DD-HHMM>-<short_id>.tar`
/// prefix `Komehub-` がブランド識別を担うので、 拡張子は標準 `.tar` で 7-Zip 等の互換最大化。
const BACKUP_EXT: &str = "tar";

/// short_id は backup_id 先頭何文字を使うか。 同分内衝突回避用 (= 完全 ID は meta.json 内)。
const SHORT_ID_LEN: usize = 6;

/// 進捗コールバック (phase 名, 0-100 の overall percent, 補助数値)。
/// spawn_blocking 経由で渡るため Send + Sync + 'static 制約を満たす Arc<dyn Fn>。
///
/// 3 引数目 `meta` は phase ごとに意味を持つ「総量」 (= 進捗 0% 時に 1 回だけ渡す):
/// - `db-unpack`: 展開対象のコメ件数 (= JS 側で予想時間を計算する用)
/// - その他 phase: 現状 None
pub type BackupProgressFn = std::sync::Arc<dyn Fn(&str, u8, Option<u64>) + Send + Sync>;

/// バックアップメタデータ
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    pub id: String,
    #[serde(rename = "type")]
    pub backup_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub items: BackupItems,
    /// 実際の tar ファイル名 (= `Komehub-<type>-<YYYY-MM-DD-HHMM>-<short_id>.komehub-backup.tar`)。
    /// backups/ 直下からこのファイル名で探す。 既存形式 (= filename 欠落) の entry は
    /// `prune_legacy_index_entries` で排除されるので、 新形式 backup は必ずこの値を持つ。
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct BackupItems {
    #[serde(default)]
    pub scenes: Vec<String>,
    #[serde(default)]
    pub effects: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    /// フルバックアップで listeners.db を含めた場合 true。
    /// 復元時、true なら tar 内の `data/listeners.db.zst` を展開して
    /// `<data_dir>/data/listeners.db` に置く。
    #[serde(default, rename = "database")]
    pub database: bool,
    /// `<data_dir>/media-cache/` を含めた場合 true。
    #[serde(default, rename = "mediaCache")]
    pub media_cache: bool,
    /// バックアップに含めた設定ファイル名 (= "app-config.json" / "config.json")。
    #[serde(default)]
    pub configs: Vec<String>,
}

/// backup-index.json
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BackupIndex {
    #[serde(default)]
    pub backups: Vec<BackupMeta>,
}

#[derive(Clone)]
pub struct BackupManager {
    backups_dir: PathBuf,
}

impl BackupManager {
    pub fn new(backups_dir: &Path) -> Self {
        fs::create_dir_all(backups_dir).ok();
        tracing::info!("Backups dir: {:?}", backups_dir);
        let mgr = Self {
            backups_dir: backups_dir.to_path_buf(),
        };
        // 旧形式 (= ディレクトリ形式) backup の index entry を排除する。
        // ディスク上のディレクトリは温存 (= OneDrive 同期の破壊回避、 ユーザー手動削除に委ねる)。
        mgr.prune_legacy_index_entries();
        mgr
    }

    pub fn set_backups_dir(&mut self, new_dir: &Path) {
        self.backups_dir = new_dir.to_path_buf();
        fs::create_dir_all(&self.backups_dir).ok();
        tracing::info!("Backups dir changed: {:?}", self.backups_dir);
        self.prune_legacy_index_entries();
    }

    /// 起動時 / backups_dir 切替時に backup-index.json をスキャンし、
    /// `meta.filename` が None もしくは対応する tar ファイルが存在しない entry を index から
    /// 除外する。 (= 旧ディレクトリ形式 / 旧 `<id>.komehub-backup.tar` 形式の残骸 entry が
    /// UI に並ぶのを防ぐ。 Phase 14 → Phase 14.1 で命名規約変更、 互換は切り捨て)
    /// ディスク上の旧ディレクトリ / 旧 tar は触らない (= ユーザー手動削除に委ねる)。
    fn prune_legacy_index_entries(&self) {
        let mut index = self.read_index();
        let before = index.backups.len();
        index.backups.retain(|b| match b.filename.as_deref() {
            Some(fname) => self.backups_dir.join(fname).exists(),
            None => false,
        });
        let after = index.backups.len();
        if before != after {
            tracing::info!(
                "Pruned {} legacy backup entries from index (= no filename or file missing)",
                before - after
            );
            self.write_index(&index);
        }
    }

    /// meta から tar ファイルの絶対 path を引く。 filename が None なら None を返す
    /// (= legacy entry。 prune 済なので通常呼ばれないが、 過渡期の安全装置)。
    fn tar_path_for_meta(&self, meta: &BackupMeta) -> Option<PathBuf> {
        meta.filename
            .as_deref()
            .map(|fname| self.backups_dir.join(fname))
    }

    fn staging_dir_for(&self, backup_id: &str) -> PathBuf {
        self.backups_dir.join(".tmp").join(backup_id)
    }

    // ========== CRUD ==========

    /// バックアップ一覧を返す。
    pub fn get_backup_list(&self) -> Vec<BackupMeta> {
        self.read_index().backups
    }

    /// バックアップを作成する (= 既存呼出からの薄いラッパ)。
    /// scenes / effects / plugins のみ。DB / media-cache / config は含めない。
    pub fn create_backup(
        &self,
        options: &BackupOptions,
        scenes_dir: &Path,
        effect_manager: &EffectManager,
    ) -> Result<String, String> {
        self.create_backup_inner(
            options,
            scenes_dir,
            effect_manager,
            FullBackupExtras::none(),
        )
    }

    /// 内部実装。1 backup = 1 tar ファイルとして書き出す。
    /// フルバックアップ時の追加対象 (`extras`) があれば DB / media-cache / config も含める。
    fn create_backup_inner(
        &self,
        options: &BackupOptions,
        scenes_dir: &Path,
        effect_manager: &EffectManager,
        extras: FullBackupExtras,
    ) -> Result<String, String> {
        let id = effect_manager::generate_id_pub();
        tracing::info!(
            "create_backup_inner: starting (id={}, type={}, scenes={}, effects={}, plugins={}, db={}, media_cache={}, configs={})",
            id,
            options.backup_type.as_deref().unwrap_or("full"),
            options.scene_ids.as_ref().map(|v| v.len()).unwrap_or(0),
            options.effect_ids.as_ref().map(|v| v.len()).unwrap_or(0),
            options.plugin_ids.as_ref().map(|v| v.len()).unwrap_or(0),
            extras.include_database,
            extras.include_media_cache,
            extras.include_configs,
        );
        let staging_dir = self.staging_dir_for(&id);
        fs::create_dir_all(&staging_dir)
            .map_err(|e| format!("staging dir 作成失敗: {}", e))?;

        // 進捗通知 helper (= None なら no-op)。 補助 meta は phase 開始時のみ意味を持つので
        // 通常の report は None 固定、 専用パスでは progress.as_ref().map(|p| p(...)) を直接呼ぶ。
        let progress = extras.progress.clone();
        let report = |phase: &str, percent: u8| {
            if let Some(p) = progress.as_ref() {
                p(phase, percent, None);
            }
        };

        let backup_type = options
            .backup_type
            .clone()
            .unwrap_or_else(|| "full".to_string());
        let created_at = chrono_now();
        // 視認性の高いファイル名 (= `Komehub-<type>-<YYYY-MM-DD-HHMM>-<short_id>.komehub-backup.tar`)
        let filename = make_backup_filename(&backup_type, &created_at, &id);
        let tar_path = self.backups_dir.join(&filename);

        let mut meta = BackupMeta {
            id: id.clone(),
            backup_type,
            name: options.name.clone().unwrap_or_default(),
            reason: options
                .reason
                .clone()
                .unwrap_or_else(|| "manual".to_string()),
            created_at,
            items: BackupItems::default(),
            filename: Some(filename),
        };

        // tar Builder を open。 失敗時は staging dir / 半端な tar ファイルを掃除して返す。
        let tar_file = match fs::File::create(&tar_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(format!("backup tar 作成失敗: {}", e));
            }
        };
        let writer = std::io::BufWriter::with_capacity(1 << 20, tar_file);
        let mut builder = tar::Builder::new(writer);
        // PAX 拡張: 100 char 超 path / 8 GB 超 file を素直に扱う (= 数百 GB 想定)
        builder.mode(tar::HeaderMode::Complete);
        builder.follow_symlinks(false);

        report("start", 0);

        // build を 1 まとまりとして実行し、 失敗時は tar / staging を掃除する closure。
        let build_result = (|| -> Result<(), String> {
            // ----- scenes -----
            if let Some(ref scene_ids) = options.scene_ids {
                tracing::info!("backup phase: scenes starting (target_count={})", scene_ids.len());
                for sid in scene_ids {
                    let src = scenes_dir.join(sid);
                    if src.exists() {
                        let tar_name = format!("scenes/{}", sid);
                        builder
                            .append_dir_all(&tar_name, &src)
                            .map_err(|e| format!("tar append scenes/{}: {}", sid, e))?;
                    }
                }
                // sceneOrder.json も tar に含める。 これが無いと復元後の sceneOrder が
                // 復元前 (= クリーン bootstrap の 3 件等) のままになり、 backup 当時の
                // シーン順序 + テスト1 等が UI に反映されない。 scenes_dir 直下にあるので
                // tar 内 path は scenes/sceneOrder.json (= restore_tar_streaming は
                // path prefix "scenes/" で scenes_dir 配下に展開する経路でカバー済)
                let order_path = scenes_dir.join("sceneOrder.json");
                if order_path.exists() {
                    let bytes = std::fs::read(&order_path)
                        .map_err(|e| format!("read sceneOrder.json: {}", e))?;
                    append_bytes_to_tar(&mut builder, "scenes/sceneOrder.json", &bytes)
                        .map_err(|e| format!("tar append sceneOrder.json: {}", e))?;
                }
                meta.items.scenes = scene_ids.clone();
            }
            report("scenes", 2);

            // ----- effects -----
            if let Some(ref effect_ids) = options.effect_ids {
                tracing::info!("backup phase: effects starting (target_count={})", effect_ids.len());
                let to_backup: Vec<EffectDefinition> = effect_manager
                    .effects()
                    .iter()
                    .filter(|e| effect_ids.contains(&e.id))
                    .cloned()
                    .collect();
                if !to_backup.is_empty() {
                    let data = EffectsFile { effects: to_backup };
                    let json = serde_json::to_string_pretty(&data).unwrap_or_default();
                    append_bytes_to_tar(&mut builder, "effects/effects.json", json.as_bytes())
                        .map_err(|e| format!("tar append effects.json: {}", e))?;
                }
                meta.items.effects = effect_ids.clone();
            }

            // ----- plugins -----
            if let Some(ref plugin_ids) = options.plugin_ids {
                tracing::info!("backup phase: plugins starting (target_count={})", plugin_ids.len());
                let mut backed = Vec::new();
                for pid in plugin_ids {
                    if let Some(dir_name) = effect_manager.find_plugin_dir(pid) {
                        let src = effect_manager.plugins_dir().join(&dir_name);
                        let tar_name = format!("plugins/{}", pid);
                        if builder.append_dir_all(&tar_name, &src).is_ok() {
                            backed.push(pid.clone());
                        }
                    }
                }
                meta.items.plugins = backed;
            }
            report("plugins", 4);

            // ----- DB (フルバックアップ拡張) -----
            //
            // フロー: VACUUM INTO で staging に raw スナップ → zstd で staging に圧縮
            //        → tar に append → staging の raw / zst を即削除。
            //
            // ピーク容量は raw DB サイズ × 1.05 程度 (= raw + zst が一瞬共存)。
            // backups/ と同ボリュームの .tmp/ を使うため、 backups/ の置かれるディスクに
            // raw DB サイズ以上の空きが必要。 数百 GB 規模ではここがネック。
            if extras.include_database {
                if let (Some(mgr), Some(data_dir)) = (extras.listener_manager, extras.data_dir) {
                    let staging_raw = staging_dir.join("listeners.db");
                    let staging_unpacked = staging_dir.join("listeners.db.unpacked");
                    let staging_zst = staging_dir.join("listeners.db.zst");

                    report("db-vacuum", 5);
                    tracing::info!("backup phase: db-vacuum starting");
                    mgr.vacuum_into(&staging_raw)
                        .map_err(|e| format!("VACUUM INTO 失敗: {}", e))?;

                    // raw_zst BLOB → raw TEXT に逆向き展開 (= 後段 zstd の long-range match を効かせる)
                    // staging_raw を弄って staging_unpacked に rename。 復元時は migration が再 BLOB 化する。
                    // 進捗配分 5% → 85% (= 80% 配分): backup 全体の中で最も時間がかかる phase
                    // (= 432K 件で約 5 分弱)、 実時間比に合わせて大きく取る。
                    unpack_raw_zst_to_text(
                        &staging_raw,
                        &staging_unpacked,
                        progress.as_ref(),
                        5,
                        85,
                    )?;

                    // zstd 圧縮 (バイト単位 progress = 85% → 92%)
                    tracing::info!("backup phase: db-compress starting");
                    compress_file_zstd(&staging_unpacked, &staging_zst, progress.as_ref(), 85, 92)?;
                    // unpacked は即削除 (= ピーク容量を抑える)
                    let _ = fs::remove_file(&staging_unpacked);

                    // tar に append (= ファイル単位なので size 事前確定 OK)
                    append_file_to_tar(&mut builder, "data/listeners.db.zst", &staging_zst)
                        .map_err(|e| format!("tar append db.zst: {}", e))?;
                    let _ = fs::remove_file(&staging_zst);

                    meta.items.database = true;
                    let _ = data_dir; // 使わないが将来用に保持
                }
            }
            report("db-done", 92);

            // ----- media-cache (フルバックアップ拡張) -----
            // 55000+ ファイル想定。 ファイル単位で tar に append + 進捗 (55% → 95%)。
            // 画像 / フォントは既圧縮なので無圧縮 tar で OK。
            if extras.include_media_cache {
                if let Some(data_dir) = extras.data_dir {
                    let src = data_dir.join("media-cache");
                    if src.exists() {
                        tracing::info!("backup phase: media-cache starting (path={:?})", src);
                        if let Err(e) = append_dir_to_tar_with_progress(
                            &mut builder,
                            &src,
                            "media-cache",
                            progress.as_ref(),
                            92,
                            98,
                            "media-cache",
                        ) {
                            // media-cache の失敗は致命ではなく、 警告で済ませる
                            // (= 個別ファイルが open できない等は再取得可能)
                            tracing::warn!("media-cache backup partial failure: {}", e);
                        } else {
                            meta.items.media_cache = true;
                        }
                    }
                }
            }
            report("media-cache-done", 98);

            // ----- configs (フルバックアップ拡張) -----
            if extras.include_configs {
                if let Some(data_dir) = extras.data_dir {
                    tracing::info!("backup phase: configs starting");
                    for name in &["app-config.json", "config.json"] {
                        let src = data_dir.join(name);
                        if src.exists() {
                            if let Err(e) = append_file_to_tar(
                                &mut builder,
                                &format!("config/{}", name),
                                &src,
                            ) {
                                tracing::warn!("config backup ({}) failed: {}", name, e);
                            } else {
                                meta.items.configs.push((*name).to_string());
                            }
                        }
                    }
                }
            }
            report("configs", 99);

            // ----- meta.json (末尾に置く) -----
            // 復元時は meta.json を最初に取り出して items を確認する必要があるが、
            // tar は random access ではないため、 復元側で全 stream を 2 度回す
            // (= 1 度目 meta 取得、 2 度目 配置) か、 meta を頭に置く必要がある。
            // 作成時に meta を頭に書くと items が未確定なので、 ここでは末尾に書いて
            // 復元側で 2 pass にする (= tar 走査コストは O(N) で許容範囲)。
            let meta_json = serde_json::to_string_pretty(&meta).unwrap_or_default();
            append_bytes_to_tar(&mut builder, "meta.json", meta_json.as_bytes())
                .map_err(|e| format!("tar append meta.json: {}", e))?;

            // tar finalize (= end-of-archive marker + flush)
            let writer = builder
                .into_inner()
                .map_err(|e| format!("tar finalize 失敗: {}", e))?;
            writer
                .into_inner()
                .map_err(|e| format!("tar flush 失敗: {}", e))?
                .sync_all()
                .map_err(|e| format!("tar fsync 失敗: {}", e))?;

            Ok(())
        })();

        // staging dir は成否によらず削除
        let _ = fs::remove_dir_all(&staging_dir);
        // .tmp/ 自体が空なら削除 (= 他の作成が走ってなければ)
        let _ = fs::remove_dir(self.backups_dir.join(".tmp"));

        if let Err(e) = build_result {
            // 半端な tar を消す
            let _ = fs::remove_file(&tar_path);
            return Err(e);
        }

        // index 更新
        let mut index = self.read_index();
        index.backups.insert(0, meta);
        self.write_index(&index);

        tracing::info!("Created backup: {} → {:?}", id, tar_path);
        report("done", 100);
        Ok(id)
    }

    /// フルバックアップを作成する。
    ///
    /// scenes / effects / plugins に加えて、listeners.db (zstd 圧縮)、media-cache/、
    /// app-config.json / config.json を含める。listener_manager / data_dir が None の場合は
    /// 演出系のみのバックアップになる (= テスト経路や DB 初期化失敗時のフォールバック)。
    /// `progress` を Some にすると phase 切替時 / DB 圧縮中のバイト進捗を 0-100% で通知する。
    pub fn create_full_backup(
        &self,
        name: Option<&str>,
        scenes: &SceneStore,
        scenes_dir: &Path,
        effect_manager: &EffectManager,
        listener_manager: Option<&ListenerManager>,
        data_dir: Option<&Path>,
        progress: Option<BackupProgressFn>,
    ) -> Result<String, String> {
        let scene_ids: Vec<String> = scenes.scenes.keys().cloned().collect();
        let effect_ids: Vec<String> = effect_manager
            .effects()
            .iter()
            .map(|e| e.id.clone())
            .collect();
        let manifests = effect_manager.get_plugin_manifests();
        let plugin_ids: Vec<String> = manifests.keys().cloned().collect();

        self.create_backup_inner(
            &BackupOptions {
                backup_type: Some("full".to_string()),
                name: Some(name.unwrap_or("フルバックアップ").to_string()),
                reason: Some("manual".to_string()),
                scene_ids: Some(scene_ids),
                effect_ids: Some(effect_ids),
                plugin_ids: Some(plugin_ids),
            },
            scenes_dir,
            effect_manager,
            FullBackupExtras {
                listener_manager,
                data_dir,
                include_database: true,
                include_media_cache: true,
                include_configs: true,
                progress,
            },
        )
    }

    /// バックアップを削除する。
    pub fn delete_backup(&self, backup_id: &str) -> bool {
        let mut index = self.read_index();
        let found = index.backups.iter().find(|b| b.id == backup_id).cloned();
        let Some(meta) = found else {
            return false;
        };
        if let Some(tar_path) = self.tar_path_for_meta(&meta) {
            if !zip_utils::is_path_inside(&self.backups_dir, &tar_path) {
                return false;
            }
            if tar_path.exists() {
                let _ = fs::remove_file(&tar_path);
            }
        }
        index.backups.retain(|b| b.id != backup_id);
        self.write_index(&index);

        tracing::debug!("Deleted backup: {}", backup_id);
        true
    }

    /// バックアップをリストアする (= ストリーミング展開 + 即配置)。
    ///
    /// `data_dir` を渡すと、フルバックアップに含まれる listeners.db / media-cache / config も
    /// 復元する。listeners.db を hot replace するため、**呼び出し側 (= model queue) で
    /// ListenerManager を drop 済 (= DB ファイルハンドル開放済)** であることが前提。
    /// 復元後に ListenerManager を再 open するのは呼び出し側の責務。
    /// `progress` を Some にすると phase / DB 展開のバイト進捗を 0-100% で通知する。
    ///
    /// 復元失敗時は rescue から元データを戻す。 完了直前で crash した場合は
    /// `<data_dir>/.restore-rescue/` が残るので、 次回起動時に検出 → UI 経由で
    /// 手動復旧 or 削除する想定 (= 別途実装)。
    pub fn restore_backup(
        &self,
        backup_id: &str,
        scenes_dir: &Path,
        _scenes: &mut SceneStore,
        effect_manager: &mut EffectManager,
        data_dir: Option<&Path>,
        progress: Option<BackupProgressFn>,
    ) -> Result<(), String> {
        let report = |phase: &str, percent: u8| {
            if let Some(p) = progress.as_ref() {
                p(phase, percent, None);
            }
        };
        report("start", 0);

        // backup-index.json から filename を引いて tar path を確定
        let index = self.read_index();
        let index_meta = index
            .backups
            .iter()
            .find(|b| b.id == backup_id)
            .ok_or_else(|| "バックアップが見つかりません (index)".to_string())?;
        let tar_path = self
            .tar_path_for_meta(index_meta)
            .ok_or_else(|| "バックアップにファイル名が記録されていません".to_string())?;
        if !zip_utils::is_path_inside(&self.backups_dir, &tar_path) {
            return Err("不正なバックアップID".to_string());
        }
        if !tar_path.exists() {
            return Err("バックアップが見つかりません".to_string());
        }

        // Pass 1: tar 内の meta.json を取得 (= 復元対象を確認、 index と同じ id のはず)
        let meta = read_meta_from_tar(&tar_path)?;
        report("scan", 3);

        // rescue: 既存データを退避 (= rename で atomic、 容量ノーコピー)
        let rescue_dir = if let Some(dd) = data_dir {
            let rd = dd
                .join(".restore-rescue")
                .join(format!("{}-{}", backup_id, std::process::id()));
            fs::create_dir_all(&rd).map_err(|e| format!("rescue dir 作成失敗: {}", e))?;
            Some(rd)
        } else {
            None
        };

        tracing::info!("restore_backup: rescuing existing data for backup_id={}", backup_id);
        let rescued = rescue_existing(
            rescue_dir.as_deref(),
            data_dir,
            scenes_dir,
            effect_manager,
            &meta,
        );
        tracing::info!(
            "restore_backup: rescue completed (db={}, media_cache={}, scenes={}, plugins={}, configs={})",
            rescued.db,
            rescued.media_cache,
            rescued.scenes.len(),
            rescued.plugins.len(),
            rescued.configs.len()
        );
        report("rescue", 5);

        // Pass 2: tar を順次 iterate して entry を配置先に直接書き込む
        tracing::info!("restore_backup: starting tar streaming (backup_id={})", backup_id);
        let restore_result = restore_tar_streaming(
            &tar_path,
            scenes_dir,
            effect_manager,
            data_dir,
            progress.as_ref(),
            &meta,
        );

        match restore_result {
            Ok(()) => {
                // 成功 → rescue を削除
                if let Some(rd) = &rescue_dir {
                    let _ = fs::remove_dir_all(rd);
                    if let Some(parent) = rd.parent() {
                        let _ = fs::remove_dir(parent); // 空なら成功、 他 rescue があれば失敗
                    }
                }
                tracing::info!("Restored backup: {}", backup_id);
                report("done", 100);
                Ok(())
            }
            Err(err) => {
                tracing::error!("Restore failed: {} — rolling back from rescue", err);
                // 復元途中の中途半端なファイルを掃除してから rescue 戻し
                rollback_from_rescue(
                    rescue_dir.as_deref(),
                    &rescued,
                    data_dir,
                    scenes_dir,
                    effect_manager,
                );
                Err(err)
            }
        }
    }

    // ========== 内部ヘルパー ==========

    fn read_index(&self) -> BackupIndex {
        let path = self.backups_dir.join("backup-index.json");
        read_json(&path).unwrap_or(BackupIndex {
            backups: Vec::new(),
        })
    }

    fn write_index(&self, index: &BackupIndex) {
        let path = self.backups_dir.join("backup-index.json");
        let json = serde_json::to_string_pretty(index).unwrap_or_default();
        fs::write(path, json).ok();
    }
}

/// バックアップ作成オプション
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    #[serde(rename = "type")]
    pub backup_type: Option<String>,
    pub name: Option<String>,
    pub reason: Option<String>,
    pub scene_ids: Option<Vec<String>>,
    pub effect_ids: Option<Vec<String>>,
    pub plugin_ids: Option<Vec<String>>,
}

/// フルバックアップ専用の追加情報。`create_backup` (= 演出のみ) は `FullBackupExtras::none()` を渡す。
struct FullBackupExtras<'a> {
    listener_manager: Option<&'a ListenerManager>,
    data_dir: Option<&'a Path>,
    include_database: bool,
    include_media_cache: bool,
    include_configs: bool,
    /// 進捗コールバック (= None なら何も通知しない)。
    progress: Option<BackupProgressFn>,
}

impl<'a> FullBackupExtras<'a> {
    fn none() -> Self {
        Self {
            listener_manager: None,
            data_dir: None,
            include_database: false,
            include_media_cache: false,
            include_configs: false,
            progress: None,
        }
    }
}

// ========== tar 操作ヘルパー ==========

/// 任意のバイト列を tar entry として append (= meta.json のようなインメモリデータ用)。
fn append_bytes_to_tar<W: Write>(
    builder: &mut tar::Builder<W>,
    name: &str,
    data: &[u8],
) -> std::io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(now_unix_secs());
    header.set_cksum();
    builder.append_data(&mut header, name, data)
}

/// ファイルを tar entry として append。 size は metadata から取得して header に乗せる。
fn append_file_to_tar<W: Write>(
    builder: &mut tar::Builder<W>,
    name: &str,
    src: &Path,
) -> std::io::Result<()> {
    let mut file = fs::File::open(src)?;
    let metadata = file.metadata()?;
    let mut header = tar::Header::new_gnu();
    header.set_metadata(&metadata);
    header.set_size(metadata.len());
    header.set_cksum();
    builder.append_data(&mut header, name, &mut file)
}

/// ディレクトリを再帰的に tar に append し、 1 ファイル完了ごとに progress を更新する。
/// 事前に総ファイル数を数えて、 完了数 / 総数 を map_start..=map_end の範囲にマップ。
/// media-cache のように小ファイルが大量にある場合に「バーが止まって見える」を解消。
fn append_dir_to_tar_with_progress<W: Write>(
    builder: &mut tar::Builder<W>,
    src: &Path,
    tar_prefix: &str,
    progress: Option<&BackupProgressFn>,
    map_start: u8,
    map_end: u8,
    phase: &'static str,
) -> std::io::Result<()> {
    let total = count_files_recursive(src);
    let mut state = AppendProgress {
        appended: 0,
        total,
        last_report: map_start,
        map_start,
        map_end,
        phase,
        progress: progress.cloned(),
    };
    append_dir_inner(builder, src, tar_prefix, &mut state)
}

struct AppendProgress {
    appended: u64,
    total: u64,
    last_report: u8,
    map_start: u8,
    map_end: u8,
    phase: &'static str,
    progress: Option<BackupProgressFn>,
}

fn append_dir_inner<W: Write>(
    builder: &mut tar::Builder<W>,
    src: &Path,
    tar_prefix: &str,
    state: &mut AppendProgress,
) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let name_in_tar = format!(
            "{}/{}",
            tar_prefix,
            entry.file_name().to_string_lossy()
        );
        if src_path.is_dir() {
            append_dir_inner(builder, &src_path, &name_in_tar, state)?;
        } else {
            // append_file_to_tar の代わりに直接 (= header を毎回 new するコストは許容)
            let mut file = match fs::File::open(&src_path) {
                Ok(f) => f,
                Err(e) => {
                    // 個別ファイルの open 失敗は無視 (= ログだけ)、 他のファイルを継続
                    tracing::warn!("skip {}: open failed: {}", src_path.display(), e);
                    continue;
                }
            };
            let metadata = match file.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mut header = tar::Header::new_gnu();
            header.set_metadata(&metadata);
            header.set_size(metadata.len());
            header.set_cksum();
            if let Err(e) = builder.append_data(&mut header, &name_in_tar, &mut file) {
                tracing::warn!("skip {}: tar append failed: {}", src_path.display(), e);
                continue;
            }
            state.appended += 1;
            if let (Some(p), true) = (
                state.progress.as_ref(),
                state.total > 0 && state.map_end > state.map_start,
            ) {
                let ratio = (state.appended as f64 / state.total as f64).min(1.0);
                let percent = state.map_start as f64
                    + ratio * (state.map_end as f64 - state.map_start as f64);
                let percent = percent.round() as u8;
                if percent >= state.last_report.saturating_add(1) {
                    state.last_report = percent;
                    p(state.phase, percent, None);
                }
            }
        }
    }
    Ok(())
}

fn count_files_recursive(dir: &Path) -> u64 {
    let mut count = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                count += count_files_recursive(&p);
            } else {
                count += 1;
            }
        }
    }
    count
}

// ========== tar 復元ヘルパー ==========

/// tar の先頭から meta.json entry を探して BackupMeta を返す。
/// 作成側は meta.json を末尾に書くため、 ここでは全 entry を走査する (= header だけ読んで本体は skip 可能)。
fn read_meta_from_tar(tar_path: &Path) -> Result<BackupMeta, String> {
    let file = fs::File::open(tar_path).map_err(|e| format!("tar open 失敗: {}", e))?;
    let reader = std::io::BufReader::with_capacity(1 << 20, file);
    let mut archive = tar::Archive::new(reader);
    for entry in archive
        .entries()
        .map_err(|e| format!("tar entries 失敗: {}", e))?
    {
        let mut entry = entry.map_err(|e| format!("tar entry 失敗: {}", e))?;
        let path = entry.path().map_err(|e| format!("tar entry path 失敗: {}", e))?;
        if path.to_string_lossy() == "meta.json" {
            let mut buf = String::new();
            entry
                .read_to_string(&mut buf)
                .map_err(|e| format!("meta.json 読み込み失敗: {}", e))?;
            let meta: BackupMeta = serde_json::from_str(&buf)
                .map_err(|e| format!("meta.json パース失敗: {}", e))?;
            return Ok(meta);
        }
    }
    Err("meta.json が tar 内に見つかりません".to_string())
}

/// 復元前に既存データを rescue dir に退避 (= rename で atomic + 容量ノーコピー)。
/// 退避できたパス一覧を返す (= 失敗時の rollback で使う)。
struct RescuedItems {
    db: bool,
    media_cache: bool,
    configs: Vec<String>,
    scenes: Vec<String>,
    plugins: Vec<String>,
}

fn rescue_existing(
    rescue_dir: Option<&Path>,
    data_dir: Option<&Path>,
    scenes_dir: &Path,
    effect_manager: &EffectManager,
    meta: &BackupMeta,
) -> RescuedItems {
    let mut rescued = RescuedItems {
        db: false,
        media_cache: false,
        configs: Vec::new(),
        scenes: Vec::new(),
        plugins: Vec::new(),
    };
    let Some(rd) = rescue_dir else {
        return rescued;
    };

    // listeners.db / wal / shm (= フルバックアップで DB 含む場合のみ退避)
    if meta.items.database {
        if let Some(dd) = data_dir {
            let db_rescue = rd.join("data");
            fs::create_dir_all(&db_rescue).ok();
            for fname in &["listeners.db", "listeners.db-wal", "listeners.db-shm"] {
                let src = dd.join("data").join(fname);
                if src.exists() {
                    match fs::rename(&src, db_rescue.join(fname)) {
                        Ok(_) => rescued.db = true,
                        Err(e) => tracing::warn!(
                            "rescue rename failed for {}: {}",
                            src.display(),
                            e
                        ),
                    }
                }
            }
        }
    }

    // media-cache (フルバックアップで含む場合のみ退避)
    if meta.items.media_cache {
        if let Some(dd) = data_dir {
            let src = dd.join("media-cache");
            if src.exists() {
                match fs::rename(&src, rd.join("media-cache")) {
                    Ok(_) => rescued.media_cache = true,
                    Err(e) => tracing::warn!(
                        "rescue rename failed for media-cache: {}",
                        e
                    ),
                }
            }
        }
    }

    // configs (バックアップに含まれているもののみ退避)
    for name in &meta.items.configs {
        if name != "app-config.json" && name != "config.json" {
            continue;
        }
        if let Some(dd) = data_dir {
            let src = dd.join(name);
            if src.exists() {
                match fs::rename(&src, rd.join(name)) {
                    Ok(_) => rescued.configs.push(name.clone()),
                    Err(e) => tracing::warn!(
                        "rescue rename failed for config {}: {}",
                        name,
                        e
                    ),
                }
            }
        }
    }

    // scenes:
    // - full backup → ディスク上の **全 scenes** を rescue (= backup 集合に無い後付け
    //   シーンも退避することで、 復元後にディスクが backup 当時の状態 + α でなく
    //   backup 当時の状態 **完全一致** になる)。 復元失敗時の rollback では rescue dir から
    //   全部戻すので、 後付けシーンも復活する
    // - partial backup (= scene / effect / plugin / auto-upgrade) → backup に含まれる
    //   シーンのみ rescue (= 既存挙動、 他のシーンを保護)
    let is_full = meta.backup_type == "full";
    let scenes_to_rescue: Vec<String> = if is_full {
        fs::read_dir(scenes_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().to_str().map(String::from))
            .collect()
    } else {
        meta.items.scenes.clone()
    };
    for sid in &scenes_to_rescue {
        let src = scenes_dir.join(sid);
        if src.exists() {
            let dst_parent = rd.join("scenes");
            fs::create_dir_all(&dst_parent).ok();
            match fs::rename(&src, dst_parent.join(sid)) {
                Ok(_) => rescued.scenes.push(sid.clone()),
                Err(e) => tracing::warn!(
                    "rescue rename failed for scene {}: {}",
                    sid,
                    e
                ),
            }
        }
    }
    // sceneOrder.json も full backup なら退避 (= 復元失敗時の rollback 用)。
    // 復元成功時は rescue dir 丸ごと削除されるので、 backup の sceneOrder.json が
    // ディスクに残る形になる。
    if is_full {
        let order_src = scenes_dir.join("sceneOrder.json");
        if order_src.exists() {
            let dst_parent = rd.join("scenes");
            fs::create_dir_all(&dst_parent).ok();
            let _ = fs::rename(&order_src, dst_parent.join("sceneOrder.json"));
        }
    }

    // plugins: scenes と同じく full backup ならディスク上の全 plugins を rescue
    let plugins_to_rescue: Vec<String> = if is_full {
        fs::read_dir(effect_manager.plugins_dir())
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().to_str().map(String::from))
            .collect()
    } else {
        // partial backup: backup に含まれる plugin id を effect_manager で
        // ディレクトリ名に解決する
        meta.items
            .plugins
            .iter()
            .filter_map(|pid| effect_manager.find_plugin_dir(pid))
            .collect()
    };
    for dir_name in &plugins_to_rescue {
        let src = effect_manager.plugins_dir().join(dir_name);
        if src.exists() {
            let dst_parent = rd.join("plugins");
            fs::create_dir_all(&dst_parent).ok();
            match fs::rename(&src, dst_parent.join(dir_name)) {
                Ok(_) => rescued.plugins.push(dir_name.clone()),
                Err(e) => tracing::warn!(
                    "rescue rename failed for plugin {}: {}",
                    dir_name,
                    e
                ),
            }
        }
    }

    rescued
}

/// rescue から元データを戻す (= 復元失敗時のロールバック)。
/// 復元途中の中途半端なファイル / ディレクトリを削除してから rename で戻す。
fn rollback_from_rescue(
    rescue_dir: Option<&Path>,
    rescued: &RescuedItems,
    data_dir: Option<&Path>,
    scenes_dir: &Path,
    effect_manager: &EffectManager,
) {
    let Some(rd) = rescue_dir else {
        return;
    };

    if rescued.db {
        if let Some(dd) = data_dir {
            let db_dir = dd.join("data");
            let db_rescue = rd.join("data");
            for fname in &["listeners.db", "listeners.db-wal", "listeners.db-shm"] {
                let target = db_dir.join(fname);
                let _ = fs::remove_file(&target);
                let saved = db_rescue.join(fname);
                if saved.exists() {
                    let _ = fs::rename(&saved, &target);
                }
            }
        }
    }

    if rescued.media_cache {
        if let Some(dd) = data_dir {
            let target = dd.join("media-cache");
            let _ = fs::remove_dir_all(&target);
            let saved = rd.join("media-cache");
            if saved.exists() {
                let _ = fs::rename(&saved, &target);
            }
        }
    }

    for name in &rescued.configs {
        if let Some(dd) = data_dir {
            let target = dd.join(name);
            let _ = fs::remove_file(&target);
            let saved = rd.join(name);
            if saved.exists() {
                let _ = fs::rename(&saved, &target);
            }
        }
    }

    for sid in &rescued.scenes {
        let target = scenes_dir.join(sid);
        let _ = fs::remove_dir_all(&target);
        let saved = rd.join("scenes").join(sid);
        if saved.exists() {
            let _ = fs::rename(&saved, &target);
        }
    }
    // sceneOrder.json の rollback (= rescue_existing で full backup 時のみ退避)。
    // rd 内に saved があれば、 復元途中で生成された order を消してから rename で戻す。
    {
        let target = scenes_dir.join("sceneOrder.json");
        let saved = rd.join("scenes").join("sceneOrder.json");
        if saved.exists() {
            let _ = fs::remove_file(&target);
            let _ = fs::rename(&saved, &target);
        }
    }

    for dir_name in &rescued.plugins {
        let target = effect_manager.plugins_dir().join(dir_name);
        let _ = fs::remove_dir_all(&target);
        let saved = rd.join("plugins").join(dir_name);
        if saved.exists() {
            let _ = fs::rename(&saved, &target);
        }
    }
    let _ = effect_manager; // 借用警告抑制 (= 将来 plugin 再 scan を呼ぶ用)
}

/// tar を 1 pass で読み、 entry ごとに配置先へ直接書き込む。
/// `data/listeners.db.zst` のみ zstd 展開して `data/listeners.db` に置く。
/// 他は entry path をそのまま `<base_dir>/<rest>` にマップ。
fn restore_tar_streaming(
    tar_path: &Path,
    scenes_dir: &Path,
    effect_manager: &mut EffectManager,
    data_dir: Option<&Path>,
    progress: Option<&BackupProgressFn>,
    meta: &BackupMeta,
) -> Result<(), String> {
    // tar 総サイズで圧縮入力 byte 進捗をマップする
    let total_size = fs::metadata(tar_path).map(|m| m.len()).unwrap_or(0);

    let file = fs::File::open(tar_path).map_err(|e| format!("tar open 失敗: {}", e))?;
    // tar streaming は復元全体の前半 (= 4-50%)、 後半 (= 50-95%) は復元後の
    // listener_manager 再 open 時に走る migration が埋める (= backup_handlers が
    // migration_progress reporter 経由で SSE に migrate phase を流す)。
    let counting = CountingReader::new(
        std::io::BufReader::with_capacity(1 << 20, file),
        total_size,
        progress.cloned(),
        4,
        50,
        "restore",
    );
    let mut archive = tar::Archive::new(counting);

    // effects.json は entry 内で deserialize → effect_manager に反映
    let mut effects_buf: Option<String> = None;

    for entry in archive
        .entries()
        .map_err(|e| format!("tar entries 失敗: {}", e))?
    {
        let mut entry = entry.map_err(|e| format!("tar entry 失敗: {}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar entry path 失敗: {}", e))?
            .into_owned();
        let path_str = path.to_string_lossy().to_string();

        // entry path traversal 防止 (= `..` / 絶対パス は弾く)
        if path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(format!("不正な entry path: {}", path_str));
        }

        if path_str == "meta.json" {
            // すでに read_meta_from_tar で取得済、 ここでは skip (= 本体読み飛ばし)
            std::io::copy(&mut entry, &mut std::io::sink())
                .map_err(|e| format!("meta.json skip 失敗: {}", e))?;
            continue;
        }

        // scenes/<sid>/...
        if let Some(rest) = path_str.strip_prefix("scenes/") {
            let dest = scenes_dir.join(rest);
            ensure_parent_dir(&dest)?;
            entry
                .unpack(&dest)
                .map_err(|e| format!("scenes/{} unpack 失敗: {}", rest, e))?;
            continue;
        }

        // effects/effects.json
        if path_str == "effects/effects.json" {
            let mut s = String::new();
            entry
                .read_to_string(&mut s)
                .map_err(|e| format!("effects.json read 失敗: {}", e))?;
            effects_buf = Some(s);
            continue;
        }

        // plugins/<pid>/...
        if let Some(rest) = path_str.strip_prefix("plugins/") {
            // 先頭 component が plugin id (= effect id format)。 既存 plugin dir があれば
            // そこに上書き、 なければ新規 dir 名で配置。
            let mut parts = rest.splitn(2, '/');
            let pid = parts.next().unwrap_or("");
            if !is_valid_effect_id(pid) {
                tracing::warn!("skip invalid plugin id in tar: {}", pid);
                std::io::copy(&mut entry, &mut std::io::sink()).ok();
                continue;
            }
            let dir_name = effect_manager
                .find_plugin_dir(pid)
                .unwrap_or_else(|| pid.to_string());
            let plugin_root = effect_manager.plugins_dir().join(&dir_name);
            let dest = if let Some(rel) = parts.next() {
                plugin_root.join(rel)
            } else {
                // dir entry そのもの (= "plugins/<pid>/") — ディレクトリ作成だけ
                fs::create_dir_all(&plugin_root)
                    .map_err(|e| format!("plugins/{} dir 作成失敗: {}", pid, e))?;
                continue;
            };
            ensure_parent_dir(&dest)?;
            entry
                .unpack(&dest)
                .map_err(|e| format!("plugins/{} unpack 失敗: {}", rest, e))?;
            continue;
        }

        // data/listeners.db.zst → zstd 展開して data/listeners.db に置く
        if path_str == "data/listeners.db.zst" {
            let Some(dd) = data_dir else { continue };
            let db_dir = dd.join("data");
            fs::create_dir_all(&db_dir)
                .map_err(|e| format!("data dir 作成失敗: {}", e))?;
            let dest = db_dir.join("listeners.db");
            // entry を直接 zstd decoder に流す (= 中間ファイル不要、 ストリーム展開)
            let mut decoder = zstd::stream::Decoder::new(&mut entry)
                .map_err(|e| format!("zstd decoder init 失敗: {}", e))?;
            let output = fs::File::create(&dest)
                .map_err(|e| format!("listeners.db 作成失敗: {}", e))?;
            let mut writer = std::io::BufWriter::with_capacity(1 << 20, output);
            std::io::copy(&mut decoder, &mut writer)
                .map_err(|e| format!("listeners.db 展開失敗: {}", e))?;
            writer
                .flush()
                .map_err(|e| format!("listeners.db flush 失敗: {}", e))?;
            continue;
        }

        // media-cache/<rest>
        if let Some(rest) = path_str.strip_prefix("media-cache/") {
            let Some(dd) = data_dir else { continue };
            let dest = dd.join("media-cache").join(rest);
            ensure_parent_dir(&dest)?;
            entry
                .unpack(&dest)
                .map_err(|e| format!("media-cache/{} unpack 失敗: {}", rest, e))?;
            continue;
        }

        // config/<name>
        if let Some(rest) = path_str.strip_prefix("config/") {
            let Some(dd) = data_dir else { continue };
            // path traversal 防止: 既知の 2 つだけ受ける
            if rest != "app-config.json" && rest != "config.json" {
                tracing::warn!("skip unknown config entry: {}", rest);
                std::io::copy(&mut entry, &mut std::io::sink()).ok();
                continue;
            }
            let dest = dd.join(rest);
            ensure_parent_dir(&dest)?;
            entry
                .unpack(&dest)
                .map_err(|e| format!("config/{} unpack 失敗: {}", rest, e))?;
            continue;
        }

        tracing::warn!("skip unknown tar entry: {}", path_str);
        std::io::copy(&mut entry, &mut std::io::sink()).ok();
    }

    // effects: 全 stream 完了後に反映 (= バックアップ内 effect で上書き / 追加)
    if let Some(buf) = effects_buf {
        if let Ok(backup_data) = serde_json::from_str::<EffectsFile>(&buf) {
            for b_eff in backup_data.effects {
                if let Some(idx) = effect_manager
                    .effects()
                    .iter()
                    .position(|e| e.id == b_eff.id)
                {
                    let mut effects = effect_manager.effects().to_vec();
                    effects[idx] = b_eff;
                    effect_manager.save_all_effects(effects);
                } else {
                    effect_manager.add_effect(b_eff);
                }
            }
        }
    }

    let _ = meta; // 将来 items 別の処理に使う用、 現状は read_meta_from_tar で取得済
    Ok(())
}

fn ensure_parent_dir(dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("dir 作成失敗 {:?}: {}", parent, e))?;
    }
    Ok(())
}

// ========== zstd 圧縮ヘルパー (作成側のみ使用、 復元側はストリーム経路) ==========

/// VACUUM INTO で書き出した listeners.db スナップショット (= raw_zst BLOB + comment_html TEXT
/// schema) を開いて、 raw_zst BLOB を zstd decode した raw TEXT 列に戻し、 raw_zst /
/// comment_html 列を DROP + VACUUM することで、 後段の tar zstd 圧縮の効率を最大化する。
///
/// 個別 raw_zst BLOB は zstd 済 ≒ ランダムバイト列で外側 zstd の long-range match が効かない
/// (= 2026-05-16 raw_zst BLOB 化後、 backup tar が 90 MB → 660 MB に肥大化)。 backup 専用の
/// 中間 schema として旧 raw TEXT 形式に戻すことで、 JSON 共通パターン (= 共通テンプレート /
/// 配信者名 / Unicode 等) を long-range match できるようにする。
///
/// 復元時は ListenerManager の起動時 migration (= `migrate_comments_raw_to_zstd`) が
/// 自動で raw TEXT → raw_zst BLOB に再変換するため、 復元側のコードは何も変更しなくてよい。
fn unpack_raw_zst_to_text(
    src: &Path,
    dest: &Path,
    progress: Option<&BackupProgressFn>,
    map_start: u8,
    map_end: u8,
) -> Result<(), String> {
    use rusqlite::{params, Connection};

    let conn = Connection::open(src).map_err(|e| format!("staging db open 失敗: {}", e))?;

    // raw 列を追加 (= 復元側 migration が「raw 列あり」 で逆向き変換を発火する条件)。
    // 既に存在する場合 (= 旧 schema 残骸) は skip。
    let columns: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(comments)")
            .map_err(|e| format!("PRAGMA table_info: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("query columns: {}", e))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if !columns.iter().any(|c| c == "raw") {
        conn.execute(
            "ALTER TABLE comments ADD COLUMN raw TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| format!("ALTER TABLE ADD COLUMN raw: {}", e))?;
    }

    // 対象件数 (= raw が空かつ raw_zst NOT NULL の行)
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM comments WHERE raw_zst IS NOT NULL AND (raw IS NULL OR raw = '')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    tracing::info!("unpack_raw_zst_to_text: starting {} rows", total);

    // 専用 rayon ThreadPool (= 物理コアの 3/4 で global pool に影響なし)。
    // global pool に上書きすると他処理 (= 将来 import や export の並列化等) に影響するため、
    // unpack scope 内だけ install する。
    let thread_count = unpack_thread_count();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .thread_name(|i| format!("komehub-unpack-{}", i))
        .build()
        .map_err(|e| format!("rayon pool 構築失敗: {}", e))?;
    tracing::info!(
        "unpack_raw_zst_to_text: rayon pool threads={} (physical={}/logical={})",
        thread_count,
        num_cpus::get_physical(),
        num_cpus::get(),
    );

    // 開始時 1 回だけ予想所要秒数を送る (= JS 側はこの値を「(約 X 分 Y 秒)」 で表示するだけ)。
    // 計算は estimate_unpack_seconds() に集約 (= 並列度を考慮、 UI 側は単純に表示)。
    if let Some(p) = progress {
        let est_sec = estimate_unpack_seconds(total.max(0) as u64, thread_count);
        p("db-unpack", map_start, Some(est_sec));
    }

    let mut processed: i64 = 0;
    let mut last_report = map_start;

    loop {
        // chunk pick: raw_zst から逆向きに書き戻す対象。 ADD COLUMN raw が DEFAULT '' で
        // 入っているため、 NULL ではなく空文字列で未処理判定する。
        let rows: Vec<(String, Vec<u8>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, raw_zst FROM comments
                     WHERE raw_zst IS NOT NULL AND (raw IS NULL OR raw = '')
                     LIMIT ?1",
                )
                .map_err(|e| format!("prepare select: {}", e))?;
            let collected: Vec<(String, Vec<u8>)> = stmt
                .query_map(params![UNPACK_CHUNK_ROWS as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| format!("query rows: {}", e))?
                .filter_map(|r| r.ok())
                .collect();
            collected
        };
        if rows.is_empty() {
            break;
        }
        let n = rows.len();

        // chunk 内 zstd decode を rayon で並列化 (= CPU multi-core 活用、 シリアル時 5 分 → N 倍速)。
        // decode 失敗 / UTF-8 不正の行は warn ログ + 空文字列でスキップ (= migration が
        // 再度走ったときに「無効な raw」 として再 BLOB 化される、 致命ではない)。
        // pool.install で「物理コア × 3/4」 の専用 thread pool を使い、 global pool には影響しない。
        let decoded: Vec<(String, String)> = pool.install(|| {
            rows.par_iter()
                .map(|(id, blob)| {
                    let raw_bytes = match zstd::decode_all(blob.as_slice()) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::warn!("unpack zstd decode skip ({}): {}", id, e);
                            return (id.clone(), String::new());
                        }
                    };
                    let raw_str = match String::from_utf8(raw_bytes) {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("unpack utf8 skip ({}): {}", id, e);
                            String::new()
                        }
                    };
                    (id.clone(), raw_str)
                })
                .collect()
        });

        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("BEGIN: {}", e))?;
        {
            let mut upd = conn
                .prepare("UPDATE comments SET raw = ?1 WHERE id = ?2")
                .map_err(|e| format!("prepare update: {}", e))?;
            for (id, raw_str) in &decoded {
                upd.execute(params![raw_str, id])
                    .map_err(|e| format!("update {}: {}", id, e))?;
            }
        }
        conn.execute_batch("COMMIT")
            .map_err(|e| format!("COMMIT: {}", e))?;

        processed += n as i64;

        if let (Some(p), true) = (progress, total > 0 && map_end > map_start) {
            let ratio = (processed as f64 / total as f64).min(1.0);
            let percent =
                map_start as f64 + ratio * (map_end as f64 - map_start as f64);
            let percent = percent.round() as u8;
            if percent >= last_report.saturating_add(1) {
                last_report = percent;
                p("db-unpack", percent, None);
            }
        }
    }
    tracing::info!("unpack_raw_zst_to_text: completed {} rows", processed);

    // 不要列を DROP してから VACUUM (= tar zstd の入力サイズを最小化)。
    // raw_zst / comment_html に依存する index は無いため DROP は安全。
    conn.execute("ALTER TABLE comments DROP COLUMN raw_zst", [])
        .map_err(|e| format!("DROP COLUMN raw_zst: {}", e))?;
    conn.execute("ALTER TABLE comments DROP COLUMN comment_html", [])
        .map_err(|e| format!("DROP COLUMN comment_html: {}", e))?;
    conn.execute("VACUUM", [])
        .map_err(|e| format!("VACUUM: {}", e))?;

    drop(conn);

    // .db-wal / .db-shm が残ったら掃除 (= rename の対象は .db のみ)
    for ext in &["-wal", "-shm"] {
        let aux = src.with_file_name(format!(
            "{}{}",
            src.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            ext
        ));
        let _ = fs::remove_file(&aux);
    }

    fs::rename(src, dest).map_err(|e| format!("rename to unpacked: {}", e))?;
    Ok(())
}

fn compress_file_zstd(
    src: &Path,
    dest: &Path,
    progress: Option<&BackupProgressFn>,
    map_start: u8,
    map_end: u8,
) -> Result<(), String> {
    let input = fs::File::open(src).map_err(|e| format!("input open 失敗: {}", e))?;
    let total = input.metadata().map(|m| m.len()).unwrap_or(0);
    let output = fs::File::create(dest).map_err(|e| format!("output create 失敗: {}", e))?;
    let mut encoder = zstd::stream::Encoder::new(output, ZSTD_LEVEL)
        .map_err(|e| format!("zstd encoder init 失敗: {}", e))?;
    let mut reader = std::io::BufReader::with_capacity(1 << 20, input);
    let mut buf = vec![0u8; 1 << 20];
    let mut processed: u64 = 0;
    let mut last_report_percent: u8 = map_start;

    // 開始時 1 回だけ予想所要秒数を送る (= UI 側で「(約 X 秒)」 表示する用)
    if let (Some(p), true) = (progress, total > 0) {
        let est_sec = estimate_compress_seconds(total);
        p("db-compress", map_start, Some(est_sec));
    }

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("input read 失敗: {}", e))?;
        if n == 0 {
            break;
        }
        encoder
            .write_all(&buf[..n])
            .map_err(|e| format!("zstd write 失敗: {}", e))?;
        processed += n as u64;
        if let (Some(p), true) = (progress, total > 0 && map_end > map_start) {
            let ratio = (processed as f64 / total as f64).min(1.0);
            let percent = map_start as f64 + ratio * (map_end as f64 - map_start as f64);
            let percent = percent.round() as u8;
            if percent >= last_report_percent.saturating_add(1) {
                last_report_percent = percent;
                p("db-compress", percent, None);
            }
        }
    }
    encoder
        .finish()
        .map_err(|e| format!("zstd finalize 失敗: {}", e))?;
    Ok(())
}

// ========== 読み取り byte カウンタ (= 復元の overall 進捗用) ==========

/// 読み取りバイトをカウントし、 progress callback を 1% 刻みで呼ぶ Reader。
/// 復元時に tar 全体の読み取り進捗を取るのに使う (= 圧縮サイズベース)。
struct CountingReader<R: std::io::Read> {
    inner: R,
    bytes_read: u64,
    total: u64,
    progress: Option<BackupProgressFn>,
    map_start: u8,
    map_end: u8,
    last_report: u8,
    phase: &'static str,
}

impl<R: std::io::Read> CountingReader<R> {
    fn new(
        inner: R,
        total: u64,
        progress: Option<BackupProgressFn>,
        map_start: u8,
        map_end: u8,
        phase: &'static str,
    ) -> Self {
        Self {
            inner,
            bytes_read: 0,
            total,
            progress,
            map_start,
            map_end,
            last_report: map_start,
            phase,
        }
    }
}

impl<R: std::io::Read> std::io::Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.bytes_read += n as u64;
            if let (Some(p), true) = (
                self.progress.as_ref(),
                self.total > 0 && self.map_end > self.map_start,
            ) {
                let ratio = (self.bytes_read as f64 / self.total as f64).min(1.0);
                let percent = self.map_start as f64
                    + ratio * (self.map_end as f64 - self.map_start as f64);
                let percent = percent.round() as u8;
                if percent >= self.last_report.saturating_add(1) {
                    self.last_report = percent;
                    p(self.phase, percent, None);
                }
            }
        }
        Ok(n)
    }
}

// ========== その他ヘルパー ==========

/// 視認性の高い backup ファイル名を組み立てる。
/// 形式: `Komehub-<type>-<YYYY-MM-DD-HHMM>-<short_id>.tar`
///
/// 例: `Komehub-full-2026-05-16-1932-mp75ra.tar`
///
/// - `type` は normalize_type_label で短縮 (= full / upgrade / manual)
/// - 日時は `created_at` (ISO 8601 風) を YYYY-MM-DD-HHMM に圧縮
/// - short_id は backup_id 先頭 6 文字 (= 同分内衝突回避、 完全 ID は meta.json 内)
fn make_backup_filename(backup_type: &str, created_at: &str, backup_id: &str) -> String {
    let type_label = normalize_type_label(backup_type);
    let date_part = compress_iso_datetime(created_at);
    let short = backup_id
        .chars()
        .take(SHORT_ID_LEN)
        .collect::<String>();
    format!("Komehub-{}-{}-{}.{}", type_label, date_part, short, BACKUP_EXT)
}

/// backup_type を視認性の高い短ラベルに変換。
/// 未知の値はそのまま (= sanitize 込みで返す、 非 ASCII / 禁則文字を除去)。
fn normalize_type_label(backup_type: &str) -> String {
    match backup_type {
        "full" => "full".to_string(),
        "auto-upgrade" => "upgrade".to_string(),
        "manual" => "manual".to_string(),
        other => sanitize_filename_segment(other),
    }
}

/// ISO 8601 風 `2026-05-16T19:32:45Z` を `2026-05-16-1932` に圧縮 (= 秒は捨てる)。
/// パース失敗時はフォールバックで現在時刻を使う (= 既に created_at が壊れているケース)。
fn compress_iso_datetime(s: &str) -> String {
    // 期待形式: "YYYY-MM-DDTHH:MM:SSZ"
    let mut parts = s.splitn(2, 'T');
    let date = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    let hhmm = time
        .split(':')
        .take(2)
        .collect::<Vec<_>>()
        .join("");
    // hhmm は "HHMM"。 おかしければフォールバック
    if date.len() == 10 && hhmm.len() == 4 && hhmm.chars().all(|c| c.is_ascii_digit()) {
        format!("{}-{}", date, hhmm)
    } else {
        // 壊れた created_at の場合、 最低限ファイル名衝突を避けるため process time を埋める
        format!("invalid-{}", now_unix_secs())
    }
}

/// Windows 禁則文字 / 制御文字 / 連続空白を `_` に置換、 長さを 40 文字に制限。
fn sanitize_filename_segment(s: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for c in s.chars() {
        let safe = match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c if c.is_whitespace() => '_',
            c => c,
        };
        if safe == '_' {
            if !prev_underscore {
                out.push('_');
                prev_underscore = true;
            }
        } else {
            out.push(safe);
            prev_underscore = false;
        }
    }
    // 先頭末尾の `_` / `.` をトリム + 長さ制限
    let trimmed: String = out
        .trim_matches(|c: char| c == '_' || c == '.')
        .chars()
        .take(40)
        .collect();
    if trimmed.is_empty() {
        "manual".to_string()
    } else {
        trimmed
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn now_unix_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn chrono_now() -> String {
    // ISO 8601 形式のタイムスタンプ（chrono crate なしで簡易実装）
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0;
    for md in &month_days {
        if remaining_days < *md {
            break;
        }
        remaining_days -= md;
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes,
        seconds
    )
}
