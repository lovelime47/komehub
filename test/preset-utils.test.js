const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const {
  exportPresetZip,
  readPresetNameFromZip,
  sanitizePresetName,
  validatePresetZip,
  resolvePresetDir,
  findAvailablePresetDir,
  zipEntriesStayInside,
  resolveImportedPresetDir
} = require('./helpers/preset-utils');

function makeEntry(name, size, isDirectory) {
  return {
    entryName: name,
    isDirectory: !!isDirectory,
    header: { size: size || 0 }
  };
}

function listZipEntries(zipPath) {
  return new AdmZip(zipPath).getEntries().map(function (entry) {
    return entry.entryName.replace(/\\/g, '/');
  }).sort();
}

describe('preset-utils', function () {
  it('sanitizes preset names for safe directory usage', function () {
    assert.equal(sanitizePresetName('../My:Preset*'), 'MyPreset');
    assert.equal(sanitizePresetName('   '), '');
  });

  it('validates expected preset zip contents', function () {
    var zip = {
      getEntries: function () {
        return [
          makeEntry('preset.json', 20, false),
          makeEntry('frames/a.png', 100, false)
        ];
      }
    };

    assert.equal(validatePresetZip(zip), null);
  });

  it('reads preset name from preset.json with file-name fallback', function () {
    var zip = {
      getEntry: function (name) {
        if (name !== 'preset.json') return null;
        return {
          getData: function () {
            return Buffer.from(JSON.stringify({ name: 'Imported Preset' }), 'utf8');
          }
        };
      }
    };

    assert.equal(readPresetNameFromZip(zip, 'C:/tmp/fallback.zip'), 'Imported Preset');
    assert.equal(readPresetNameFromZip({ getEntry: function () { return null; } }, 'C:/tmp/fallback.zip'), 'fallback');
  });

  it('rejects preset zip entries with invalid extensions', function () {
    var zip = {
      getEntries: function () {
        return [makeEntry('frames/run.exe', 20, false)];
      }
    };

    assert.match(validatePresetZip(zip), /許可されていないファイル形式/);
  });

  it('resolves only preset paths inside the presets directory', function () {
    var presetsDir = path.join('C:', 'app', 'presets');

    assert.equal(resolvePresetDir(presetsDir, 'My Preset'), path.join(presetsDir, 'My Preset'));
    assert.equal(resolvePresetDir(presetsDir, ''), null);
    assert.equal(resolvePresetDir(presetsDir, '.'), null);
    assert.equal(resolvePresetDir(presetsDir, 'Preset/../evil'), null);
    assert.equal(resolvePresetDir(presetsDir, '../presets-evil'), null);
  });

  it('allocates an available preset dir with numeric suffixes', function () {
    var presetsDir = path.join('C:', 'app', 'presets');
    var seen = {};
    seen[path.join(presetsDir, 'Preset')] = true;
    seen[path.join(presetsDir, 'Preset (1)')] = true;

    var resolved = findAvailablePresetDir(presetsDir, 'Preset', function (candidate) {
      return !!seen[candidate];
    });

    assert.equal(resolved, path.join(presetsDir, 'Preset (2)'));
  });

  it('rejects zip entries that would escape the target preset directory', function () {
    var presetDir = path.join('C:', 'app', 'presets', 'Preset');
    var entries = [makeEntry('../presets-evil/config.json', 20, false)];

    assert.equal(zipEntriesStayInside(presetDir, entries), false);
  });

  it('resolves imported preset dir from zip metadata and collision rules', function () {
    var presetsDir = path.join('C:', 'app', 'presets');
    var zip = {
      getEntry: function () {
        return {
          getData: function () {
            return Buffer.from(JSON.stringify({ name: 'Preset' }), 'utf8');
          }
        };
      }
    };
    var seen = {};
    seen[path.join(presetsDir, 'Preset')] = true;

    var resolved = resolveImportedPresetDir(presetsDir, zip, 'C:/tmp/fallback.zip', function (candidate) {
      return !!seen[candidate];
    });

    assert.deepEqual(resolved, {
      presetName: 'Preset',
      presetDir: path.join(presetsDir, 'Preset (1)')
    });
  });

  it('exports preset zip with metadata and nested asset files', function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'komehub-preset-export-'));
    try {
      var assetsDir = path.join(tempDir, 'assets');
      fs.mkdirSync(path.join(assetsDir, 'frames', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(assetsDir, 'config.json'), '{"ok":true}');
      fs.writeFileSync(path.join(assetsDir, 'frames', 'nested', 'idle.png'), 'png');

      var zipPath = path.join(tempDir, 'preset.zip');
      exportPresetZip(zipPath, 'Export Preset', assetsDir);

      var entries = listZipEntries(zipPath);
      assert.ok(entries.includes('preset.json'));
      assert.ok(entries.includes('config.json'));
      assert.ok(entries.includes('frames/nested/idle.png'));
      assert.equal(readPresetNameFromZip(new AdmZip(zipPath), zipPath), 'Export Preset');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
