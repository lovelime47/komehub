const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const pathUtils = require('../../electron/path-utils');

function sanitizePresetName(name) {
  if (!name) return '';
  name = name.replace(/[\/\\]/g, '');
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  name = name.replace(/^\.+/, '');
  name = name.replace(/[<>:"|?*]/g, '');
  return name.trim();
}

function readPresetNameFromZip(zip, zipFilePath) {
  var presetEntry = zip.getEntry('preset.json');
  var fallbackName = path.basename(zipFilePath || '', '.zip');
  if (!presetEntry) return fallbackName;

  try {
    var meta = JSON.parse(presetEntry.getData().toString('utf-8'));
    return meta.name || fallbackName;
  } catch (_e) {
    return fallbackName;
  }
}

function validatePresetZip(zip) {
  var entries = zip.getEntries();
  if (entries.length === 0) return 'ZIPファイルが空です。';
  if (entries.length > 500) return 'ファイル数が多すぎます（上限500）。';

  var hasConfig = false;
  var hasFrames = false;
  var allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.json'];
  var totalSize = 0;
  var MAX_TOTAL_SIZE = 100 * 1024 * 1024;

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var name = entry.entryName;

    if (name === 'config.json' || name === 'preset.json') hasConfig = true;
    if (name.startsWith('frames/')) hasFrames = true;
    if (entry.isDirectory) continue;

    var ext = path.extname(name).toLowerCase();
    if (allowedExtensions.indexOf(ext) === -1) {
      return '許可されていないファイル形式が含まれています: ' + name;
    }
    if (name.indexOf('..') !== -1) {
      return '不正なパスが含まれています: ' + name;
    }

    totalSize += entry.header.size;
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    return 'ファイルサイズが大きすぎます（上限100MB）。';
  }
  if (!hasConfig && !hasFrames) {
    return 'Live Comment Hub のプリセットファイルではありません。\nconfig.json または frames/ が必要です。';
  }

  return null;
}

function resolvePresetDir(baseDir, presetName) {
  var normalizedName = typeof presetName === 'string' ? presetName.trim() : '';
  if (!normalizedName) return null;
  if (sanitizePresetName(normalizedName) !== normalizedName) return null;

  var presetDir = path.join(baseDir, normalizedName);
  if (path.resolve(baseDir) === path.resolve(presetDir)) return null;
  return pathUtils.isPathInside(baseDir, presetDir) ? presetDir : null;
}

function findAvailablePresetDir(baseDir, presetName, existsFn) {
  var presetDir = resolvePresetDir(baseDir, presetName);
  if (!presetDir) return null;

  var counter = 1;
  while (existsFn(presetDir)) {
    presetDir = resolvePresetDir(baseDir, presetName + ' (' + counter + ')');
    if (!presetDir) return null;
    counter++;
  }
  return presetDir;
}

function zipEntriesStayInside(targetDir, entries) {
  for (var i = 0; i < entries.length; i++) {
    var entryPath = path.resolve(targetDir, entries[i].entryName);
    if (!pathUtils.isPathInside(targetDir, entryPath)) return false;
  }
  return true;
}

function resolveImportedPresetDir(baseDir, zip, zipFilePath, existsFn) {
  var presetName = sanitizePresetName(readPresetNameFromZip(zip, zipFilePath));
  if (!presetName) return null;

  var presetDir = findAvailablePresetDir(baseDir, presetName, existsFn);
  if (!presetDir) return null;

  return {
    presetName: presetName,
    presetDir: presetDir
  };
}

function addDirToZip(zip, dirPath, zipPath) {
  var entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.forEach(function (entry) {
    var fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      addDirToZip(zip, fullPath, zipPath ? zipPath + '/' + entry.name : entry.name);
    } else {
      zip.addLocalFile(fullPath, zipPath || '');
    }
  });
}

function exportPresetZip(zipFilePath, exportName, assetsDir) {
  var zip = new AdmZip();
  zip.addFile('preset.json', Buffer.from(JSON.stringify({ name: exportName }), 'utf-8'));
  addDirToZip(zip, assetsDir, '');
  zip.writeZip(zipFilePath);
}

module.exports = {
  exportPresetZip: exportPresetZip,
  readPresetNameFromZip: readPresetNameFromZip,
  sanitizePresetName: sanitizePresetName,
  validatePresetZip: validatePresetZip,
  resolvePresetDir: resolvePresetDir,
  findAvailablePresetDir: findAvailablePresetDir,
  zipEntriesStayInside: zipEntriesStayInside,
  resolveImportedPresetDir: resolveImportedPresetDir
};
