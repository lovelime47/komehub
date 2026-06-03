const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyDirSync, replaceDirSync } = require('../electron/fs-utils');

var tempDirs = [];

function makeTempDir(prefix) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(function () {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('fs-utils copyDirSync', function () {
  it('copies nested directories and files', function () {
    var srcDir = makeTempDir('komehub-fs-src-');
    var destDir = makeTempDir('komehub-fs-dest-');

    fs.mkdirSync(path.join(srcDir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'root.txt'), 'root');
    fs.writeFileSync(path.join(srcDir, 'nested', 'deeper', 'child.txt'), 'child');

    copyDirSync(srcDir, destDir);

    assert.equal(fs.readFileSync(path.join(destDir, 'root.txt'), 'utf8'), 'root');
    assert.equal(fs.readFileSync(path.join(destDir, 'nested', 'deeper', 'child.txt'), 'utf8'), 'child');
  });

  it('does nothing when source directory is missing', function () {
    var destDir = makeTempDir('komehub-fs-dest-');

    copyDirSync(path.join(destDir, 'missing'), path.join(destDir, 'out'));

    assert.equal(fs.existsSync(path.join(destDir, 'out')), false);
  });
});

describe('fs-utils replaceDirSync', function () {
  it('replaces the destination directory after staging the copy', function () {
    var srcDir = makeTempDir('komehub-fs-src-');
    var destDir = makeTempDir('komehub-fs-dest-');

    fs.writeFileSync(path.join(srcDir, 'new.txt'), 'new');
    fs.writeFileSync(path.join(destDir, 'old.txt'), 'old');

    replaceDirSync(srcDir, destDir);

    assert.equal(fs.existsSync(path.join(destDir, 'old.txt')), false);
    assert.equal(fs.readFileSync(path.join(destDir, 'new.txt'), 'utf8'), 'new');
  });

  it('restores the original destination when staging fails', function () {
    var srcDir = makeTempDir('komehub-fs-src-');
    var destDir = makeTempDir('komehub-fs-dest-');
    var originalCopyFileSync = fs.copyFileSync;

    fs.writeFileSync(path.join(srcDir, 'new.txt'), 'new');
    fs.writeFileSync(path.join(destDir, 'old.txt'), 'old');

    fs.copyFileSync = function (srcPath) {
      if (path.basename(srcPath) === 'new.txt') {
        throw new Error('copy failed');
      }
      return originalCopyFileSync.apply(this, arguments);
    };

    try {
      assert.throws(function () {
        replaceDirSync(srcDir, destDir);
      }, /copy failed/);
    } finally {
      fs.copyFileSync = originalCopyFileSync;
    }

    assert.equal(fs.readFileSync(path.join(destDir, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(destDir, 'new.txt')), false);
  });
});
