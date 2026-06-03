//! ZIP ユーティリティ — エクスポート/インポートの ZIP 操作基盤。
//!
//! 旧 JS ZIP ヘルパー群を置き換える Rust 実装。
//! バリデーション、ディレクトリ追加/展開、トランザクション管理を提供する。

#![allow(dead_code)]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// ZIP に含めてよい拡張子
const ALLOWED_EXTENSIONS: &[&str] = &[
    ".json", ".js", ".png", ".jpg", ".jpeg", ".gif", ".apng",
    ".webm", ".mp3", ".wav", ".svg", ".webp", ".html", ".css",
];

/// 1ファイルあたりの最大サイズ (100MB)
const MAX_ZIP_SIZE: u64 = 100 * 1024 * 1024;

/// ZIP 内の最大ファイル数
const MAX_ZIP_FILES: usize = 500;

// ========== ZIP バリデーション ==========

/// ZIP ファイルを開いてバリデーションする。
/// 成功時は ZipArchive を返す。
pub fn open_validated_zip(zip_path: &Path) -> Result<zip::ZipArchive<fs::File>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("ZIPファイルを開けません: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("無効なZIPファイルです: {}", e))?;

    if archive.len() > MAX_ZIP_FILES {
        return Err(format!("ZIPファイルのエントリ数が上限({})を超えています", MAX_ZIP_FILES));
    }

    for i in 0..archive.len() {
        let entry = archive.by_index(i)
            .map_err(|e| format!("ZIPエントリの読み取りに失敗: {}", e))?;
        validate_zip_entry_info(entry.name(), entry.is_dir(), entry.size())?;
    }

    Ok(archive)
}

/// ZIP エントリの安全性を検証する。
fn validate_zip_entry_info(name: &str, is_dir: bool, size: u64) -> Result<(), String> {
    let normalized = name.replace('\\', "/");
    // パストラバーサル防止
    if normalized.contains("..") {
        return Err(format!("不正なパスを含むZIPエントリ: {}", name));
    }
    // サイズチェック
    if size > MAX_ZIP_SIZE {
        return Err(format!("ZIPエントリが大きすぎます: {} ({}bytes)", name, size));
    }
    // ディレクトリはOK
    if is_dir {
        return Ok(());
    }
    // 拡張子チェック
    let ext = Path::new(&normalized)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("許可されない拡張子: {} ({})", name, ext));
    }
    Ok(())
}

// ========== ZIP プレフィックス検出 ==========

/// ZIP 内のルートフォルダプレフィックスを検出する。
/// フォルダごと圧縮された場合に全エントリが共通プレフィックスを持つ。
pub fn detect_zip_prefix(archive: &mut zip::ZipArchive<fs::File>) -> String {
    if archive.is_empty() {
        return String::new();
    }

    let first_name = match archive.by_index(0) {
        Ok(entry) => entry.name().replace('\\', "/"),
        Err(_) => return String::new(),
    };

    let slash_idx = match first_name.find('/') {
        Some(idx) => idx,
        None => return String::new(),
    };

    let prefix = &first_name[..=slash_idx];

    for i in 1..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().replace('\\', "/");
            if !name.starts_with(prefix) {
                return String::new();
            }
        }
    }

    prefix.to_string()
}

// ========== ZIP 読み取り ==========

/// ZIP からテキストファイルを読む（プレフィックス付き・なし両方試行）。
pub fn read_zip_text(archive: &mut zip::ZipArchive<fs::File>, prefix: &str, file_path: &str) -> Option<String> {
    // プレフィックス付きで試す
    let prefixed = format!("{}{}", prefix, file_path);
    if let Ok(mut entry) = archive.by_name(&prefixed) {
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_ok() {
            return Some(content);
        }
    }
    // プレフィックスなしで試す
    if !prefix.is_empty() {
        if let Ok(mut entry) = archive.by_name(file_path) {
            let mut content = String::new();
            if entry.read_to_string(&mut content).is_ok() {
                return Some(content);
            }
        }
    }
    None
}

/// ZIP からJSONを読んでパースする。
pub fn read_zip_json(archive: &mut zip::ZipArchive<fs::File>, prefix: &str, file_path: &str) -> Option<serde_json::Value> {
    let text = read_zip_text(archive, prefix, file_path)?;
    serde_json::from_str(&text).ok()
}

// ========== ZIP 書き込み ==========

/// ディレクトリを再帰的に ZIP に追加する。
pub fn add_dir_to_zip<W: Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    dir_path: &Path,
    zip_prefix: &str,
) -> Result<(), String> {
    if !dir_path.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(dir_path)
        .map_err(|e| format!("ディレクトリ読み取り失敗: {:?} {}", dir_path, e))?;

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let zip_path = if zip_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}{}", zip_prefix, name)
        };

        if path.is_dir() {
            let sub_prefix = format!("{}/", zip_path);
            add_dir_to_zip(writer, &path, &sub_prefix)?;
        } else {
            let data = fs::read(&path)
                .map_err(|e| format!("ファイル読み取り失敗: {:?} {}", path, e))?;
            writer.start_file(&zip_path, options)
                .map_err(|e| format!("ZIPエントリ作成失敗: {} {}", zip_path, e))?;
            writer.write_all(&data)
                .map_err(|e| format!("ZIP書き込み失敗: {} {}", zip_path, e))?;
        }
    }

    Ok(())
}

/// 単一ファイルを ZIP に追加する。
pub fn add_file_to_zip<W: Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    file_path: &Path,
    zip_path: &str,
) -> Result<(), String> {
    let data = fs::read(file_path)
        .map_err(|e| format!("ファイル読み取り失敗: {:?} {}", file_path, e))?;
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file(zip_path, options)
        .map_err(|e| format!("ZIPエントリ作成失敗: {} {}", zip_path, e))?;
    writer.write_all(&data)
        .map_err(|e| format!("ZIP書き込み失敗: {} {}", zip_path, e))?;
    Ok(())
}

/// JSON データを ZIP に追加する。
pub fn add_json_to_zip<W: Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    zip_path: &str,
    data: &serde_json::Value,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| format!("JSONシリアライズ失敗: {}", e))?;
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file(zip_path, options)
        .map_err(|e| format!("ZIPエントリ作成失敗: {} {}", zip_path, e))?;
    writer.write_all(json.as_bytes())
        .map_err(|e| format!("ZIP書き込み失敗: {} {}", zip_path, e))?;
    Ok(())
}

// ========== ZIP 展開 ==========

/// ZIP の指定プレフィックス配下をターゲットディレクトリに展開する。
pub fn extract_entries_to_dir(
    archive: &mut zip::ZipArchive<fs::File>,
    source_prefix: &str,
    target_dir: &Path,
) -> Result<(), String> {
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("ディレクトリ作成失敗: {:?} {}", target_dir, e))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("ZIPエントリ読み取り失敗: {}", e))?;

        let entry_path = entry.name().replace('\\', "/");
        if entry.is_dir() || !entry_path.starts_with(source_prefix) {
            continue;
        }

        let rel_name = &entry_path[source_prefix.len()..];
        if rel_name.is_empty() {
            continue;
        }

        let target_path = target_dir.join(rel_name);
        // パストラバーサル防止
        if !is_path_inside(target_dir, &target_path) {
            continue;
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).ok();
        }

        let mut data = Vec::new();
        entry.read_to_end(&mut data)
            .map_err(|e| format!("ZIP展開失敗: {} {}", rel_name, e))?;
        fs::write(&target_path, &data)
            .map_err(|e| format!("ファイル書き込み失敗: {:?} {}", target_path, e))?;
    }

    Ok(())
}

// ========== トランザクション管理 ==========

/// ディレクトリ置換トランザクション。
pub struct DirReplaceTransaction {
    pub staging_dir: PathBuf,
    pub target_dir: PathBuf,
    pub had_target: bool,
    pub backup_dir: Option<PathBuf>,
}

/// ステージングディレクトリをターゲットに置換する（アトミック）。
/// 失敗時は自動ロールバック。
pub fn begin_dir_replace(staging_dir: &Path, target_dir: &Path) -> Result<DirReplaceTransaction, String> {
    let had_target = target_dir.exists();
    let backup_dir = if had_target {
        let backup = create_temp_dir(
            target_dir.parent().unwrap_or(Path::new(".")),
            &format!("{}-rollback", target_dir.file_name().unwrap_or_default().to_string_lossy()),
        )?;
        copy_dir_recursive(target_dir, &backup)
            .map_err(|e| format!("バックアップ作成失敗: {}", e))?;
        Some(backup)
    } else {
        None
    };

    // staging → target に置換
    if had_target {
        fs::remove_dir_all(target_dir)
            .map_err(|e| format!("ターゲット削除失敗: {}", e))?;
    }
    fs::rename(staging_dir, target_dir)
        .or_else(|_| {
            // rename が失敗する場合（異なるドライブ間等）はコピー+削除
            copy_dir_recursive(staging_dir, target_dir)
                .and_then(|_| fs::remove_dir_all(staging_dir))
        })
        .map_err(|e| {
            // 失敗時にバックアップからロールバック
            if let Some(ref backup) = backup_dir {
                let _ = copy_dir_recursive(backup, target_dir);
                let _ = fs::remove_dir_all(backup);
            }
            format!("ディレクトリ置換失敗: {}", e)
        })?;

    Ok(DirReplaceTransaction {
        staging_dir: staging_dir.to_path_buf(),
        target_dir: target_dir.to_path_buf(),
        had_target,
        backup_dir,
    })
}

/// トランザクションをロールバックする。
pub fn rollback_dir_replace(txn: &DirReplaceTransaction) {
    if txn.target_dir.exists() {
        let _ = fs::remove_dir_all(&txn.target_dir);
    }
    if txn.had_target {
        if let Some(ref backup) = txn.backup_dir {
            if backup.exists() {
                let _ = copy_dir_recursive(backup, &txn.target_dir);
            }
        }
    }
    cleanup_dir_replace(txn);
}

/// トランザクションのバックアップを削除する（成功後のクリーンアップ）。
pub fn cleanup_dir_replace(txn: &DirReplaceTransaction) {
    if let Some(ref backup) = txn.backup_dir {
        if backup.exists() {
            let _ = fs::remove_dir_all(backup);
        }
    }
}

// ========== ファイル単位のステージングコミット ==========

/// ファイル単位のコミットトランザクション。
pub struct FileCommitTransaction {
    pub dest_path: PathBuf,
    pub had_target: bool,
    pub backup_path: Option<PathBuf>,
}

/// ステージングディレクトリからターゲットディレクトリに個別ファイルをコミットする。
pub fn commit_staged_files(
    staging_dir: &Path,
    target_dir: &Path,
    relative_paths: &[String],
) -> Result<Vec<FileCommitTransaction>, String> {
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("ターゲットディレクトリ作成失敗: {}", e))?;

    let mut transactions = Vec::new();

    for rel_path in relative_paths {
        let src = staging_dir.join(rel_path);
        let dest = target_dir.join(rel_path);

        if !is_path_inside(target_dir, &dest) {
            continue;
        }

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).ok();
        }

        let had_target = dest.exists();
        let backup_path = if had_target {
            let backup = make_temp_file_path(&dest, "rollback");
            fs::copy(&dest, &backup)
                .map_err(|e| {
                    rollback_staged_files(&transactions);
                    format!("バックアップ作成失敗: {:?} {}", dest, e)
                })?;
            Some(backup)
        } else {
            None
        };

        fs::copy(&src, &dest).map_err(|e| {
            rollback_staged_files(&transactions);
            format!("ファイルコミット失敗: {:?} {}", dest, e)
        })?;

        transactions.push(FileCommitTransaction {
            dest_path: dest,
            had_target,
            backup_path,
        });
    }

    Ok(transactions)
}

/// ファイルコミットをロールバックする。
pub fn rollback_staged_files(transactions: &[FileCommitTransaction]) {
    for txn in transactions.iter().rev() {
        if txn.had_target {
            if let Some(ref backup) = txn.backup_path {
                if backup.exists() {
                    let _ = fs::copy(backup, &txn.dest_path);
                }
            }
        } else if txn.dest_path.exists() {
            let _ = fs::remove_file(&txn.dest_path);
        }

        if let Some(ref backup) = txn.backup_path {
            if backup.exists() {
                let _ = fs::remove_file(backup);
            }
        }
    }
}

/// ファイルコミットのバックアップを削除する（成功後のクリーンアップ）。
pub fn cleanup_staged_files(transactions: &[FileCommitTransaction], staging_dir: Option<&Path>) {
    for txn in transactions {
        if let Some(ref backup) = txn.backup_path {
            if backup.exists() {
                let _ = fs::remove_file(backup);
            }
        }
    }
    if let Some(dir) = staging_dir {
        if dir.exists() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

// ========== パス・ファイルシステムヘルパー ==========

/// target が base ディレクトリの内部にあるかチェックする。
pub fn is_path_inside(base: &Path, target: &Path) -> bool {
    match (base.canonicalize(), canonicalize_with_missing_leaf(target)) {
        (Ok(base_canon), Ok(target_canon)) => target_canon.starts_with(&base_canon),
        _ => false,
    }
}

fn canonicalize_with_missing_leaf(target: &Path) -> std::io::Result<PathBuf> {
    if let Ok(canon) = target.canonicalize() {
        return Ok(canon);
    }

    let mut existing = target;
    let mut suffix = PathBuf::new();

    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "missing ancestor"));
        };
        suffix = PathBuf::from(name).join(suffix);
        existing = existing
            .parent()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "missing parent"))?;
    }

    existing.canonicalize().map(|base| base.join(suffix))
}

/// ディレクトリを再帰的にコピーする。
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// 一時ディレクトリを作成する。
pub fn create_temp_dir(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(parent)
        .map_err(|e| format!("親ディレクトリ作成失敗: {}", e))?;

    let dir = parent.join(format!(
        ".{}-{}",
        prefix,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("一時ディレクトリ作成失敗: {:?} {}", dir, e))?;
    Ok(dir)
}

/// 一時ファイルパスを生成する。
fn make_temp_file_path(target: &Path, suffix: &str) -> PathBuf {
    let parent = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    parent.join(format!(".{}.{}.{}", name, suffix, ts))
}

#[cfg(test)]
mod tests {
    use super::is_path_inside;

    #[test]
    fn path_inside_accepts_missing_nested_targets() {
        let root = std::env::temp_dir().join(format!("zip-utils-{}", std::process::id()));
        let base = root.join("base");
        std::fs::create_dir_all(&base).expect("create base");

        let nested = base.join("nested").join("asset.svg");
        assert!(is_path_inside(&base, &nested));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_inside_rejects_parent_escape() {
        let root = std::env::temp_dir().join(format!("zip-utils-escape-{}", std::process::id()));
        let base = root.join("base");
        std::fs::create_dir_all(&base).expect("create base");

        let escaped = base.join("..").join("outside.txt");
        assert!(!is_path_inside(&base, &escaped));

        let _ = std::fs::remove_dir_all(&root);
    }
}
