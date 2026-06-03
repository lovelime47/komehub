const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isPathInside } = require('../electron/path-utils');

describe('path-utils isPathInside', function () {
  it('accepts paths inside the base directory', function () {
    var baseDir = path.join('C:', 'app', 'backups');
    var childPath = path.join(baseDir, 'daily', 'meta.json');

    assert.equal(isPathInside(baseDir, childPath), true);
  });

  it('accepts the base directory itself', function () {
    var baseDir = path.join('C:', 'app', 'backups');

    assert.equal(isPathInside(baseDir, baseDir), true);
  });

  it('rejects prefix-matching sibling directories', function () {
    var baseDir = path.join('C:', 'app', 'backups');
    var siblingPath = path.join('C:', 'app', 'backups-evil', 'meta.json');

    assert.equal(isPathInside(baseDir, siblingPath), false);
  });

  it('rejects parent traversal targets', function () {
    var baseDir = path.join('C:', 'app', 'backups');
    var escapedPath = path.join(baseDir, '..', 'other', 'meta.json');

    assert.equal(isPathInside(baseDir, escapedPath), false);
  });
});
