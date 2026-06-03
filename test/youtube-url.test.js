const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractVideoId, buildChatUrl, buildWatchUrl } = require('../electron/youtube-url');

describe('extractVideoId', function () {
  it('standard watch URL', function () {
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('watch URL with extra params', function () {
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  });

  it('short URL (youtu.be)', function () {
    assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('live URL', function () {
    assert.equal(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('bare video ID', function () {
    assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('invalid URL returns null', function () {
    assert.equal(extractVideoId('https://example.com'), null);
  });

  it('empty string returns null', function () {
    assert.equal(extractVideoId(''), null);
  });

  it('null returns null', function () {
    assert.equal(extractVideoId(null), null);
  });
});

describe('buildChatUrl', function () {
  it('builds correct chat URL', function () {
    assert.equal(buildChatUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/live_chat?is_popout=1&v=dQw4w9WgXcQ');
  });
});

describe('buildWatchUrl', function () {
  it('builds correct watch URL', function () {
    assert.equal(buildWatchUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
