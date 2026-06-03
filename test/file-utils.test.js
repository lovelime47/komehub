const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeFilenameSegment, safeFilename } = require('./helpers/file-utils');

describe('file-utils', function () {
  it('sanitizes filename prefixes used for generated assets', function () {
    assert.equal(sanitizeFilenameSegment('../bad:name\\test'), '-badname-test');
    assert.equal(sanitizeFilenameSegment(''), 'asset');
  });

  it('builds safe filenames with sanitized prefix and lowercase extension', function () {
    var filename = safeFilename('Clip.HTML', '../bad:name');

    assert.match(filename, /^-badname_[a-z0-9]+\.html$/);
  });
});
