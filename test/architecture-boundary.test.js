const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('architecture boundary guardrails', function () {
  it('main process no longer owns comment image preprocessing', function () {
    const mainJs = read('electron/main.js');

    assert.doesNotMatch(mainJs, /commentImageCacheChain/);
    assert.doesNotMatch(mainJs, /coreBridge\.cacheCommentImages\(/);
    assert.match(mainJs, /coreBridge\.pushComments\(comments\)/);
  });

  it('napi bridge delegates template and comment aux work to ModelCommand', function () {
    const napiBridge = read('core/src/napi_bridge.rs');

    assert.match(napiBridge, /ModelCommand::EnsureTemplateFonts/);
    assert.match(napiBridge, /ModelCommand::CacheCommentImages/);
    assert.match(napiBridge, /ModelCommand::IncomingCommentsJson/);
    assert.doesNotMatch(napiBridge, /crate::font_cache::ensure_fonts/);
    assert.doesNotMatch(napiBridge, /crate::image_cache::cache_comment_images/);
  });

  it('HTTP and napi comment inputs share IncomingCommentsJson entrypoint', function () {
    const napiBridge = read('core/src/napi_bridge.rs');
    const commentSurface = read('core/src/surface/comment.rs');

    assert.match(napiBridge, /fire_and_forget\(ModelCommand::IncomingCommentsJson \{ comments_json \}\)/);
    assert.match(commentSurface, /\.send\(ModelCommand::IncomingCommentsJson \{ comments_json \}\)/);
  });
});
