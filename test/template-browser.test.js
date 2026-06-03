const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { chromium } = require('playwright');

const nativeRuntime = require('./native-module-runtime');

const TEST_DATA_DIR = path.join(os.tmpdir(), 'komehub-browser-test-' + Date.now());
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const RUNTIME_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core_runtime.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;
const CHAT_LIST_ID = 'com.comment-hub.template.standard-renderless';

var m;
var port;

function pngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WZ0pQAAAABJRU5ErkJggg==',
    'base64'
  );
}

function createRenderlessTemplateZip(zipPath) {
  var zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    id: 'com.comment-hub.template.test.renderless-preview',
    name: 'renderless-preview',
    displayName: 'Renderless Preview Test',
    version: '1.0.0'
  }, null, 2)));
  zip.addFile('index.html', Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div
    id="comments"
    data-kh-start="list"
    data-kh-template="#comment-template"
    data-kh-style-id="renderless-preview-style"
    data-kh-options="#komehub-template-options"></div>

  <template id="comment-template">
    <article class="comment">
      <div class="prefix" data-kh="display.prefix" data-kh-empty="hide"></div>
      <div class="text" data-kh="display.html" data-kh-mode="html"></div>
    </article>
  </template>

  <script id="komehub-template-options" type="application/json">
  {
    "preview": {
      "preset": "list-basic",
      "title": "Renderless Preview Test"
    }
  }
  </script>
  <script src="script.js"></script>
</body>
</html>`));
  zip.addFile('style.css', Buffer.from(`html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  color: #fff;
  font-family: sans-serif;
}

#comments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.comment {
  background-image: var(--theme-frame-image, none), var(--theme-shared-image, none);
  padding: 12px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.9);
}

.text {
  white-space: pre-wrap;
}`));
  zip.addFile('script.js', Buffer.from(`(function () {
  'use strict';

  window.KomehubTemplateRuntime.htmlFirst.start({
    themeAssets: {
      _common: {
        '--theme-shared-image': 'shared-frame.png'
      },
      'theme-pink': {
        '--theme-frame-image': 'pink-frame.png'
      }
    },
    beforeCommitComment: function (rawComment) {
      return {
        display: {
          prefix: rawComment.amountDisplay ? 'SUPER CHAT ' + rawComment.amountDisplay : '',
          html: rawComment.commentHtml || rawComment.comment || '',
          themeKey: 'theme-pink'
        }
      };
    }
  });
})();`));
  zip.writeZip(zipPath);
}

function createRenderlessTypingTemplateZip(zipPath) {
  var zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    id: 'com.comment-hub.template.test.renderless-typing-persistence',
    name: 'renderless-typing-persistence',
    displayName: 'Renderless Typing Persistence Test',
    version: '1.0.0'
  }, null, 2)));
  zip.addFile('index.html', Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div
    id="comments"
    data-kh-start="list"
    data-kh-template="#comment-template"
    data-kh-style-id="renderless-typing-style"></div>

  <template id="comment-template">
    <article class="comment">
      <div class="text" data-kh="display.html" data-kh-mode="html"></div>
    </article>
  </template>

  <script src="script.js"></script>
</body>
</html>`));
  zip.addFile('style.css', Buffer.from(`html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  color: #fff;
  font-family: sans-serif;
}

#comments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.comment {
  padding: 12px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.9);
}

.text {
  white-space: pre-wrap;
}

.typing-char {
  opacity: 0;
  animation: type-in 0ms step-start forwards;
  animation-delay: var(--type-delay, 0ms);
}

@keyframes type-in {
  from { opacity: 0; }
  to { opacity: 1; }
}`));
  zip.addFile('script.js', Buffer.from(`(function () {
  'use strict';

  function wrapWithTypingAnim(html, speed) {
    var tokens = [];
    var charCount = 0;
    var re = /(<[^>]+>)|(&[a-zA-Z]+;|&#\\d+;)|(.)/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) {
        tokens.push(m[1]);
      } else if (m[2]) {
        tokens.push('<span class="typing-char" style="--type-delay:' + (charCount * speed) + 'ms">' + m[2] + '</span>');
        charCount++;
      } else {
        var ch = m[3];
        if (ch === ' ') {
          tokens.push(' ');
        } else {
          tokens.push('<span class="typing-char" style="--type-delay:' + (charCount * speed) + 'ms">' + ch + '</span>');
        }
        charCount++;
      }
    }
    return tokens.join('');
  }

  window.KomehubTemplateRuntime.htmlFirst.start({
    beforeCommitComment: function (rawComment) {
      return {
        display: {
          html: wrapWithTypingAnim(rawComment.commentHtml || rawComment.comment || '', 80),
          themeKey: 'theme-pink'
        }
      };
    }
  });
})();`));
  zip.writeZip(zipPath);
}

function createRenderlessEffectTemplateZip(zipPath) {
  var zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    id: 'com.comment-hub.template.test.renderless-effect-scheduler',
    name: 'renderless-effect-scheduler',
    displayName: 'Renderless Effect Scheduler Test',
    version: '1.0.0'
  }, null, 2)));
  zip.addFile('index.html', Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div
    id="comments"
    data-kh-start="list"
    data-kh-template="#comment-template"
    data-kh-style-id="renderless-effect-style"></div>

  <template id="comment-template">
    <article class="comment">
      <div class="text" data-kh="display.html" data-kh-mode="html"></div>
    </article>
  </template>

  <script src="script.js"></script>
</body>
</html>`));
  zip.addFile('style.css', Buffer.from(`html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  color: #fff;
  font-family: sans-serif;
}

#comments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.comment {
  padding: 12px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.9);
}

.comment.is-pulsing {
  outline: 2px solid rgb(34, 197, 94);
}`));
  zip.addFile('script.js', Buffer.from(`(function () {
  'use strict';

  window.__effectEvents = [];

  window.KomehubTemplateRuntime.htmlFirst.start({
    lifecycle: {
      leaveRemoveDelayMs: 40
    },
    beforeCommitComment: function (rawComment) {
      return {
        display: {
          html: rawComment.commentHtml || rawComment.comment || ''
        }
      };
    },
    afterBindComment: function (node, model, context) {
      window.__effectEvents.push({
        type: 'bind',
        id: context.commentId,
        phase: context.phase
      });
      context.effects.addClass('pulse', 'is-pulsing', {
        removeOnPhases: ['leaving'],
        onCleanup: function (cleanupContext) {
          window.__effectEvents.push({
            type: 'cleanup',
            id: cleanupContext.commentId,
            reason: cleanupContext.reason || ''
          });
          if (cleanupContext.node) {
            cleanupContext.node.dataset.effectActive = '0';
          }
        },
        onPhaseChange: function (prevPhase, nextPhase, phaseContext) {
          window.__effectEvents.push({
            type: 'phase',
            id: phaseContext.commentId,
            prevPhase: prevPhase,
            nextPhase: nextPhase
          });
          if (phaseContext.node) {
            phaseContext.node.dataset.lastPhase = nextPhase;
          }
        }
      });
      context.effects.setTimeout('ready-flag', 120, function (timeoutContext) {
        window.__effectEvents.push({
          type: 'timeout',
          id: timeoutContext.commentId,
          reason: timeoutContext.reason || ''
        });
        if (timeoutContext.node) {
          timeoutContext.node.dataset.effectReady = '1';
        }
      });
      node.dataset.effectActive = '1';
      node.dataset.effectKeys = context.effects.keys().slice().sort().join(',');
      node.dataset.effectCount = String(context.effects.keys().length);
      node.dataset.effectCommentId = context.commentId;
      node.dataset.effectPhase = context.phase || '';
    },
    beforeRemoveComment: function (node, model, context) {
      window.__effectEvents.push({
        type: 'beforeRemove',
        id: context.commentId,
        reason: context.reason || '',
        keys: context.effects.keys().join(',')
      });
      if (node) {
        node.dataset.beforeRemove = '1';
      }
    }
  });
})();`));
  zip.writeZip(zipPath);
}

function createRenderlessTickerTemplateZip(zipPath) {
  var zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    id: 'com.comment-hub.template.test.renderless-ticker-effect',
    name: 'renderless-ticker-effect',
    displayName: 'Renderless Ticker Effect Test',
    version: '1.0.0'
  }, null, 2)));
  zip.addFile('index.html', Buffer.from(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div
    id="comments"
    data-kh-start="ticker"
    data-kh-track="#track"
    data-kh-template="#comment-template"
    data-kh-style-id="renderless-ticker-effect-style">
    <div id="track"></div>
  </div>

  <template id="comment-template">
    <article class="comment">
      <span class="prefix" data-kh="display.prefix" data-kh-empty="hide"></span>
      <span class="text" data-kh="display.html" data-kh-mode="html"></span>
    </article>
  </template>

  <script src="script.js"></script>
</body>
</html>`));
  zip.addFile('style.css', Buffer.from(`html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: #fff;
  font-family: sans-serif;
}

#comments {
  position: relative;
  width: 100%;
  height: 120px;
  overflow: hidden;
}

#track {
  position: absolute;
  left: 0;
  top: 24px;
  display: inline-flex;
  gap: 12px;
  white-space: nowrap;
  will-change: transform;
}

.comment {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.92);
}

.comment.is-entering {
  opacity: 0.4;
}

.comment.is-pulsing {
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.9);
}

.prefix {
  color: rgb(250, 204, 21);
}`));
  zip.addFile('script.js', Buffer.from(`(function () {
  'use strict';

  window.__tickerEffectEvents = [];

  window.KomehubTemplateRuntime.htmlFirst.start({
    mode: 'ticker',
    travelSeconds: 12,
    lifecycle: {
      enterActiveDelayMs: 12,
      leaveRemoveDelayMs: 40
    },
    beforeCommitComment: function (rawComment) {
      return {
        display: {
          prefix: rawComment.amountDisplay ? 'SC' : '',
          html: rawComment.commentHtml || rawComment.comment || ''
        }
      };
    },
    afterBindComment: function (node, model, context) {
      window.__tickerEffectEvents.push({
        type: 'bind',
        id: context.commentId,
        phase: context.phase
      });
      context.effects.addClass('ticker-pulse', 'is-pulsing', {
        removeOnPhases: ['leaving'],
        onCleanup: function (cleanupContext) {
          window.__tickerEffectEvents.push({
            type: 'cleanup',
            id: cleanupContext.commentId,
            reason: cleanupContext.reason || ''
          });
        },
        onPhaseChange: function (prevPhase, nextPhase, phaseContext) {
          window.__tickerEffectEvents.push({
            type: 'phase',
            id: phaseContext.commentId,
            prevPhase: prevPhase,
            nextPhase: nextPhase
          });
        }
      });
      node.dataset.effectKeys = context.effects.keys().join(',');
      node.dataset.effectCount = String(context.effects.keys().length);
    },
    beforeRemoveComment: function (_node, _model, context) {
      window.__tickerEffectEvents.push({
        type: 'beforeRemove',
        id: context.commentId,
        reason: context.reason || '',
        keys: context.effects.keys().join(',')
      });
    }
  });
})();`));
  zip.writeZip(zipPath);
}

// テンプレート runtime の SSE 接続完了を待つ。
// `#comments` の attach 直後に pushComments すると EventSource の subscribe 前で
// ブロードキャストを取り落とすことがあるため、初回 config 受信を ready 信号として待つ。
async function waitForTemplateRuntimeReady(page, timeoutMs) {
  await page.waitForFunction(function () {
    var rt = window.KomehubTemplateRuntime;
    return !!(rt
      && typeof rt.getLatestConfig === 'function'
      && rt.getLatestConfig() !== null);
  }, null, { timeout: timeoutMs || 30000 });
}

function buildRawComment(id, text) {
  return {
    id: id,
    service: 'youtube',
    name: '@browser-test',
    comment: text,
    commentHtml: text,
    profileImage: '',
    timestamp: '12:34',
    hasGift: false,
    amount: 0,
    amountDisplay: '',
    currency: '',
    stickerImage: '',
    isMember: false,
    memberMonths: 0,
    isMembership: false,
    membershipHeader: '',
    isMembershipGift: false,
    giftCount: 0,
    memberBadgeUrl: '',
    isModerator: false,
    isOwner: false,
    isVerified: false,
    superchatTier: ''
  };
}

async function exportAndInstallTemplate(options) {
  var exportResult;
  var installResult;

  fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes', options.sourceSceneId, 'performances'), { recursive: true });
  if (options.sourceAssetName) {
    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'scenes', options.sourceSceneId, 'performances', options.sourceAssetName),
      pngBuffer()
    );
  }
  if (options.targetAssetName) {
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes', options.targetSceneId, 'performances'), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'scenes', options.targetSceneId, 'performances', options.targetAssetName),
      pngBuffer()
    );
  }

  exportResult = JSON.parse(await m.exportTemplate(
    CHAT_LIST_ID,
    options.displayName,
    options.sourceSceneId,
    JSON.stringify({
      backgroundImage: options.exportBackgroundImage,
      maxComments: 24
    }),
    options.exportPath
  ));
  assert.equal(exportResult.ok, true);

  installResult = JSON.parse(await m.installTemplate(options.exportPath));
  assert.equal(installResult.ok, true);
  assert.ok(installResult.template && installResult.template.id, 'installed template info returned');

  await m.addSceneTemplate(options.targetSceneId, installResult.template.id);
  if (options.runtimeBackgroundImage != null) {
    var configResult = JSON.parse(await m.setSceneTemplateConfig(
      options.targetSceneId,
      installResult.template.id,
      JSON.stringify({
        backgroundImage: options.runtimeBackgroundImage,
        maxComments: 24
      })
    ));
    assert.equal(configResult.ok, true);
  }

  return installResult.template.id;
}

async function openTemplatePage(templatePath, trackedAssetPath) {
  var browser = await chromium.launch({ headless: true });
  var page = await browser.newPage();
  var requests = [];
  var responses = [];
  var pageErrors = [];
  var assetPathFragment = templatePath + trackedAssetPath;

  page.on('request', function (request) {
    var url = request.url();
    if (url.indexOf(trackedAssetPath) !== -1) {
      requests.push(url);
    }
  });
  page.on('response', function (response) {
    var url = response.url();
    if (url.indexOf(trackedAssetPath) !== -1) {
      responses.push({ url: url, status: response.status() });
    }
  });
  page.on('pageerror', function (error) {
    pageErrors.push(String(error));
  });

  var assetResponsePromise = page.waitForResponse(function (response) {
    return response.url().indexOf(assetPathFragment) !== -1 && response.status() < 400;
  }, { timeout: 30000 });

  await page.goto('http://127.0.0.1:' + port + templatePath, {
    waitUntil: 'domcontentloaded'
  });

  await page.waitForFunction(function (assetPath) {
    return window.getComputedStyle(document.body).backgroundImage.indexOf(assetPath) !== -1;
  }, trackedAssetPath, { timeout: 30000 });

  await assetResponsePromise;

  return {
    browser: browser,
    page: page,
    requests: requests,
    responses: responses,
    pageErrors: pageErrors
  };
}

describe('template-browser', { timeout: 120000 }, function () {
  before(async function () {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes'), { recursive: true });
    process.env.KOMEHUB_PUBLIC_HTTP_PORT = '0';

    nativeRuntime.ensureNativeModuleBuilt();
    m = require(nativeRuntime.prepareNativeModulePath(RUNTIME_NODE_PATH));
    assert.ok(m, 'Native module loaded');

    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    assert.ok(port > 0, 'Port assigned: ' + port);
  });

  after(async function () {
    if (m && typeof m.shutdownCore === 'function') {
      try {
        await m.shutdownCore();
      } catch (_e) {
      }
    }

    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (_e) {
    }

    if (PREVIOUS_PUBLIC_HTTP_PORT == null) {
      delete process.env.KOMEHUB_PUBLIC_HTTP_PORT;
    } else {
      process.env.KOMEHUB_PUBLIC_HTTP_PORT = PREVIOUS_PUBLIC_HTTP_PORT;
    }
  });

  it('renders imported template background from template assets path', async function () {
    var sourceSceneId = 'browser-template-source';
    var targetSceneId = 'browser-template-target';
    var assetName = 'bg-import.png';
    var exportPath = path.join(TEST_DATA_DIR, 'browser-template-export.zip');
    var browser;
    var page;
    var installedTemplateId;
    var result;

    try {
      await m.createScene(sourceSceneId, 'Browser Template Source');
      await m.createScene(targetSceneId, 'Browser Template Target');

      installedTemplateId = await exportAndInstallTemplate({
        sourceSceneId: sourceSceneId,
        targetSceneId: targetSceneId,
        sourceAssetName: assetName,
        targetAssetName: null,
        displayName: 'Browser Imported Template',
        exportBackgroundImage: assetName,
        runtimeBackgroundImage: null,
        exportPath: exportPath
      });

      result = await openTemplatePage(
        '/templates/' + targetSceneId + '/comehub/' + installedTemplateId + '/',
        'assets/' + assetName
      );
      browser = result.browser;
      page = result.page;

      var backgroundImage = await result.page.evaluate(function () {
        return window.getComputedStyle(document.body).backgroundImage;
      });

      assert.deepEqual(result.pageErrors, []);
      assert.match(
        backgroundImage,
        new RegExp('/templates/' + targetSceneId + '/comehub/' + installedTemplateId.replace(/\./g, '\\.') + '/assets/' + assetName.replace('.', '\\.'))
      );
      assert.ok(
        result.requests.some(function (url) {
          return url.indexOf('/templates/' + targetSceneId + '/comehub/' + installedTemplateId + '/assets/' + assetName) !== -1;
        }),
        'template asset requested by browser'
      );
      assert.ok(
        result.requests.every(function (url) {
          return url.indexOf('/effects/' + targetSceneId + '/assets/' + assetName) === -1;
        }),
        'effects asset fallback was not used'
      );
      assert.ok(
        result.responses.some(function (entry) {
          return entry.url.indexOf('/templates/' + targetSceneId + '/comehub/' + installedTemplateId + '/assets/' + assetName) !== -1
            && entry.status === 200;
        }),
        'template asset response succeeded'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
      if (installedTemplateId) {
        await m.removeTemplate(installedTemplateId);
      }
    }
  });

  it('serves scene-owned template background through template assets path', async function () {
    var sceneId = 'browser-template-scene-assets';
    var assetName = 'bg-scene.png';
    var browser;
    var page;
    var result;

    try {
      await m.createScene(sceneId, 'Browser Template Scene Assets');
      fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes', sceneId, 'performances'), { recursive: true });
      fs.writeFileSync(
        path.join(TEST_DATA_DIR, 'scenes', sceneId, 'performances', assetName),
        pngBuffer()
      );

      var addResult = JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID));
      assert.equal(addResult.ok, true);

      var configResult = JSON.parse(await m.setSceneTemplateConfig(
        sceneId,
        CHAT_LIST_ID,
        JSON.stringify({
          backgroundImage: assetName,
          maxComments: 24
        })
      ));
      assert.equal(configResult.ok, true);

      result = await openTemplatePage(
        '/templates/' + sceneId + '/built-in/standard-renderless/',
        'assets/' + assetName
      );
      browser = result.browser;
      page = result.page;

      var backgroundImage = await result.page.evaluate(function () {
        return window.getComputedStyle(document.body).backgroundImage;
      });

      assert.deepEqual(result.pageErrors, []);
      assert.match(
        backgroundImage,
        new RegExp('/templates/' + sceneId + '/built-in/standard-renderless/assets/' + assetName.replace('.', '\\.'))
      );
      assert.ok(
        result.requests.some(function (url) {
          return url.indexOf('/templates/' + sceneId + '/built-in/standard-renderless/assets/' + assetName) !== -1;
        }),
        'template assets path requested by browser'
      );
      assert.ok(
        result.requests.every(function (url) {
          return url.indexOf('/effects/' + sceneId + '/assets/' + assetName) === -1;
        }),
        'effects assets path was not requested'
      );
      assert.ok(
        result.responses.some(function (entry) {
          return entry.url.indexOf('/templates/' + sceneId + '/built-in/standard-renderless/assets/' + assetName) !== -1
            && entry.status === 200;
        }),
        'template assets path response succeeded'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
    }
  });

  it('renderless htmlFirst preview keeps bound text in attached DOM nodes', async function () {
    var sceneId = 'browser-renderless-preview';
    var exportPath = path.join(TEST_DATA_DIR, 'renderless-preview-template.zip');
    var browser;
    var page;
    var installedTemplateId;

    try {
      await m.createScene(sceneId, 'Browser Renderless Preview');
      createRenderlessTemplateZip(exportPath);

      var installResult = JSON.parse(await m.installTemplate(exportPath));
      assert.equal(installResult.ok, true);
      installedTemplateId = installResult.template.id;

      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, installedTemplateId)).ok, true);

      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();

      await page.goto(
        'http://127.0.0.1:' + port + '/templates/' + sceneId + '/comehub/' + installedTemplateId + '/?preview=1&devPreview=1',
        { waitUntil: 'domcontentloaded' }
      );

      await page.waitForFunction(function () {
        var container = document.getElementById('comments');
        if (!container || container.children.length === 0) return false;
        return Array.prototype.some.call(container.children, function (node) {
          var textNode = node.querySelector('.text');
          return textNode && (textNode.textContent || '').trim().length > 0;
        });
      }, null, { timeout: 30000 });

      var rendered = await page.evaluate(function () {
        var container = document.getElementById('comments');
        return Array.prototype.map.call(container.children, function (node) {
          var textNode = node.querySelector('.text');
          return {
            text: textNode ? (textNode.textContent || '').trim() : '',
            sharedImage: node.style.getPropertyValue('--theme-shared-image') || '',
            frameImage: node.style.getPropertyValue('--theme-frame-image') || ''
          };
        });
      });

      assert.ok(rendered.length > 0, 'preview created at least one comment node');
      assert.ok(
        rendered.some(function (entry) { return entry.text.length > 0; }),
        'at least one attached renderless comment keeps its bound text'
      );
      assert.ok(
        rendered.some(function (entry) {
          return entry.text === '通常コメントの見た目です。HTML と CSS の骨組みを確認します。';
        }),
        'standard dev preview text is present in attached DOM'
      );
      assert.ok(
        rendered.every(function (entry) {
          return entry.sharedImage.indexOf('assets/shared-frame.png') !== -1;
        }),
        'common theme asset variables are injected into every attached comment root'
      );
      assert.ok(
        rendered.every(function (entry) {
          return entry.frameImage.indexOf('assets/pink-frame.png') !== -1;
        }),
        'theme-specific asset variables are merged with _common declarations'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
      if (installedTemplateId) {
        await m.removeTemplate(installedTemplateId);
      }
    }
  });

  it('renderless htmlFirst keeps typing progress when identical comment is re-sent', async function () {
    var sceneId = 'browser-renderless-typing';
    var exportPath = path.join(TEST_DATA_DIR, 'renderless-typing-template.zip');
    var browser;
    var page;
    var installedTemplateId;
    var pushComments = null;
    var commentId = 'typing-persist-id';
    var commentText = 'これはタイピング継続確認のための長めのコメントです';

    try {
      await m.createScene(sceneId, 'Browser Renderless Typing');
      createRenderlessTypingTemplateZip(exportPath);

      var installResult = JSON.parse(await m.installTemplate(exportPath));
      assert.equal(installResult.ok, true);
      installedTemplateId = installResult.template.id;

      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, installedTemplateId)).ok, true);

      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });

      await page.goto(
        'http://127.0.0.1:' + port + '/templates/' + sceneId + '/comehub/' + installedTemplateId + '/',
        { waitUntil: 'domcontentloaded' }
      );

      await page.waitForSelector('#comments', { state: 'attached', timeout: 30000 });
      await waitForTemplateRuntimeReady(page);
      var initialCount = await page.evaluate(function () {
        var container = document.getElementById('comments');
        return container ? container.children.length : 0;
      });

      pushComments = typeof m.pushComments === 'function'
        ? m.pushComments.bind(m)
        : (typeof m.push_comments === 'function' ? m.push_comments.bind(m) : null);
      assert.ok(pushComments, 'native bridge exposes pushComments');

      pushComments(JSON.stringify([buildRawComment(commentId, commentText)]));

      await page.waitForFunction(function (targetId) {
        return !!document.querySelector('[data-kh-id="' + targetId + '"]');
      }, commentId, { timeout: 30000 });

      await page.waitForTimeout(650);

      var beforeReplay = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var spans = root ? Array.prototype.slice.call(root.querySelectorAll('.text .typing-char')) : [];
        return {
          childCount: document.getElementById('comments').children.length,
          visible: spans.filter(function (span) {
            return Number(window.getComputedStyle(span).opacity) > 0.5;
          }).length,
          total: spans.length
        };
      }, commentId);

      pushComments(JSON.stringify([buildRawComment(commentId, commentText)]));
      await page.waitForTimeout(120);

      var afterReplay = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var spans = root ? Array.prototype.slice.call(root.querySelectorAll('.text .typing-char')) : [];
        return {
          childCount: document.getElementById('comments').children.length,
          visible: spans.filter(function (span) {
            return Number(window.getComputedStyle(span).opacity) > 0.5;
          }).length,
          total: spans.length
        };
      }, commentId);

      await page.waitForTimeout(600);

      var later = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var spans = root ? Array.prototype.slice.call(root.querySelectorAll('.text .typing-char')) : [];
        return {
          childCount: document.getElementById('comments').children.length,
          visible: spans.filter(function (span) {
            return Number(window.getComputedStyle(span).opacity) > 0.5;
          }).length,
          total: spans.length
        };
      }, commentId);

      assert.ok(beforeReplay.total > 10, 'typing test comment created multiple animated spans');
      assert.ok(
        beforeReplay.visible > 0 && beforeReplay.visible < beforeReplay.total,
        'typing is in progress before replay'
      );
      assert.equal(afterReplay.childCount, 1, 'same id replay does not duplicate comment nodes');
      assert.ok(
        afterReplay.visible >= beforeReplay.visible,
        'visible typing progress does not rewind after identical replay'
      );
      assert.ok(
        later.visible > afterReplay.visible,
        'typing continues to advance after replay instead of restarting'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
      if (installedTemplateId) {
        await m.removeTemplate(installedTemplateId);
      }
    }
  });

  it('renderless htmlFirst keeps typing progress when a new comment is appended', async function () {
    var sceneId = 'browser-renderless-typing-append';
    var exportPath = path.join(TEST_DATA_DIR, 'renderless-typing-append-template.zip');
    var browser;
    var page;
    var installedTemplateId;
    var pushComments = null;
    var firstId = 'typing-append-first';
    var secondId = 'typing-append-second';
    var commentText = 'これはタイピング継続確認のための長めのコメントです';

    try {
      await m.createScene(sceneId, 'Browser Renderless Typing Append');
      createRenderlessTypingTemplateZip(exportPath);

      var installResult = JSON.parse(await m.installTemplate(exportPath));
      assert.equal(installResult.ok, true);
      installedTemplateId = installResult.template.id;

      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, installedTemplateId)).ok, true);

      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });

      await page.goto(
        'http://127.0.0.1:' + port + '/templates/' + sceneId + '/comehub/' + installedTemplateId + '/',
        { waitUntil: 'domcontentloaded' }
      );

      await page.waitForSelector('#comments', { state: 'attached', timeout: 30000 });
      await waitForTemplateRuntimeReady(page);

      pushComments = typeof m.pushComments === 'function'
        ? m.pushComments.bind(m)
        : (typeof m.push_comments === 'function' ? m.push_comments.bind(m) : null);
      assert.ok(pushComments, 'native bridge exposes pushComments');

      pushComments(JSON.stringify([buildRawComment(firstId, commentText)]));

      await page.waitForFunction(function (targetId) {
        return !!document.querySelector('[data-kh-id="' + targetId + '"]');
      }, firstId, { timeout: 30000 });

      await page.waitForTimeout(650);

      var beforeAppend = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var spans = root ? Array.prototype.slice.call(root.querySelectorAll('.text .typing-char')) : [];
        return {
          childCount: document.getElementById('comments').children.length,
          visible: spans.filter(function (span) {
            return Number(window.getComputedStyle(span).opacity) > 0.5;
          }).length,
          total: spans.length
        };
      }, firstId);

      pushComments(JSON.stringify([buildRawComment(secondId, '次のコメント')]));
      await page.waitForFunction(function (targetId) {
        return !!document.querySelector('[data-kh-id="' + targetId + '"]');
      }, secondId, { timeout: 30000 });
      await page.waitForTimeout(120);

      var afterAppend = await page.evaluate(function (ids) {
        var targetId = ids.targetId;
        var appendedId = ids.appendedId;
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var spans = root ? Array.prototype.slice.call(root.querySelectorAll('.text .typing-char')) : [];
        return {
          // 全体 childCount への依存は前段テストの DOM 残留に脆弱なので、
          // 対象 data-kh-id ごとのノード数を見る形に変更
          targetNodes: document.querySelectorAll('[data-kh-id="' + targetId + '"]').length,
          appendedNodes: document.querySelectorAll('[data-kh-id="' + appendedId + '"]').length,
          visible: spans.filter(function (span) {
            return Number(window.getComputedStyle(span).opacity) > 0.5;
          }).length,
          total: spans.length
        };
      }, { targetId: firstId, appendedId: secondId });

      await page.waitForTimeout(600);

      var later = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var spans = root ? Array.prototype.slice.call(root.querySelectorAll('.text .typing-char')) : [];
        return {
          visible: spans.filter(function (span) {
            return Number(window.getComputedStyle(span).opacity) > 0.5;
          }).length,
          total: spans.length
        };
      }, firstId);

      assert.ok(beforeAppend.total > 10, 'first comment created multiple animated spans');
      assert.ok(
        beforeAppend.visible > 0 && beforeAppend.visible < beforeAppend.total,
        'first typing is in progress before append'
      );
      assert.equal(
        afterAppend.targetNodes,
        1,
        'first comment is present exactly once after append (no duplicate, no rebuild)'
      );
      assert.equal(
        afterAppend.appendedNodes,
        1,
        'second comment is appended exactly once'
      );
      assert.ok(
        afterAppend.visible >= beforeAppend.visible,
        'existing typing progress does not rewind when a new comment is appended'
      );
      assert.ok(
        later.visible > afterAppend.visible,
        'existing typing continues advancing after append'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
      if (installedTemplateId) {
        await m.removeTemplate(installedTemplateId);
      }
    }
  });

  it('renderless htmlFirst effect scheduler cleans up on delete', async function () {
    var sceneId = 'browser-renderless-effect-scheduler';
    var exportPath = path.join(TEST_DATA_DIR, 'renderless-effect-scheduler-template.zip');
    var browser;
    var page;
    var installedTemplateId;
    var pushComments = null;
    var pushCommentDeleted = null;
    var commentId = 'effect-scheduler-id';

    try {
      await m.createScene(sceneId, 'Browser Renderless Effect Scheduler');
      createRenderlessEffectTemplateZip(exportPath);

      var installResult = JSON.parse(await m.installTemplate(exportPath));
      assert.equal(installResult.ok, true);
      installedTemplateId = installResult.template.id;

      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, installedTemplateId)).ok, true);

      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });

      await page.goto(
        'http://127.0.0.1:' + port + '/templates/' + sceneId + '/comehub/' + installedTemplateId + '/',
        { waitUntil: 'domcontentloaded' }
      );

      await page.waitForSelector('#comments', { state: 'attached', timeout: 30000 });
      await waitForTemplateRuntimeReady(page);

      pushComments = typeof m.pushComments === 'function'
        ? m.pushComments.bind(m)
        : (typeof m.push_comments === 'function' ? m.push_comments.bind(m) : null);
      pushCommentDeleted = typeof m.pushCommentDeleted === 'function'
        ? m.pushCommentDeleted.bind(m)
        : (typeof m.push_comment_deleted === 'function' ? m.push_comment_deleted.bind(m) : null);
      assert.ok(pushComments, 'native bridge exposes pushComments');
      assert.ok(pushCommentDeleted, 'native bridge exposes pushCommentDeleted');

      pushComments(JSON.stringify([buildRawComment(commentId, 'effect scheduler test')]));

      await page.waitForFunction(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        return !!(root
          && root.dataset.effectActive === '1'
          && root.dataset.effectKeys === 'pulse,ready-flag');
      }, commentId, { timeout: 30000 });

      await page.waitForFunction(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        return !!(root && root.dataset.effectReady === '1');
      }, commentId, { timeout: 30000 });

      var beforeDelete = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        return {
          active: root ? root.dataset.effectActive : '',
          keys: root ? root.dataset.effectKeys : '',
          effectCount: root ? root.dataset.effectCount : '',
          ready: root ? root.dataset.effectReady : '',
          className: root ? root.className : ''
        };
      }, commentId);

      pushCommentDeleted(JSON.stringify([commentId]));

      await page.waitForFunction(function (targetId) {
        return !document.querySelector('[data-kh-id="' + targetId + '"]');
      }, commentId, { timeout: 30000 });

      var effectEvents = await page.evaluate(function () {
        return Array.isArray(window.__effectEvents) ? window.__effectEvents.slice() : [];
      });

      assert.equal(beforeDelete.active, '1', 'effect is active after bind');
      assert.equal(beforeDelete.keys, 'pulse,ready-flag', 'scheduler tracks helper-registered effect keys');
      assert.equal(beforeDelete.effectCount, '2', 'scheduler exposes helper-registered effect count');
      assert.equal(beforeDelete.ready, '1', 'timeout helper ran before delete');
      assert.match(beforeDelete.className, /is-pulsing/, 'effect setup mutates the node without rebuilding it');
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'bind' && entry.id === commentId;
        }),
        'effect bind hook ran'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'phase' && entry.id === commentId && entry.nextPhase === 'leaving';
        }),
        'effect phase handler is notified on leaving'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'beforeRemove' && entry.id === commentId && entry.keys === 'pulse';
        }),
        'beforeRemoveComment sees timeout helper already cleaned up'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'timeout' && entry.id === commentId && entry.reason === 'timeout';
        }),
        'timeout helper fires with effect context'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'cleanup' && entry.id === commentId && entry.reason === 'remove';
        }),
        'scheduler cleanup runs before node removal'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
      if (installedTemplateId) {
        await m.removeTemplate(installedTemplateId);
      }
    }
  });

  it('renderless ticker works without renderComment and shares effect cleanup contract', async function () {
    var sceneId = 'browser-renderless-ticker-effect';
    var exportPath = path.join(TEST_DATA_DIR, 'renderless-ticker-effect-template.zip');
    var browser;
    var page;
    var installedTemplateId;
    var pushComments = null;
    var pushCommentDeleted = null;
    var commentId = 'ticker-effect-id';

    try {
      await m.createScene(sceneId, 'Browser Renderless Ticker Effect');
      createRenderlessTickerTemplateZip(exportPath);

      var installResult = JSON.parse(await m.installTemplate(exportPath));
      assert.equal(installResult.ok, true);
      installedTemplateId = installResult.template.id;

      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, installedTemplateId)).ok, true);

      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 900, height: 240 } });

      await page.goto(
        'http://127.0.0.1:' + port + '/templates/' + sceneId + '/comehub/' + installedTemplateId + '/',
        { waitUntil: 'domcontentloaded' }
      );

      await page.waitForSelector('#track', { state: 'attached', timeout: 30000 });
      await waitForTemplateRuntimeReady(page);

      pushComments = typeof m.pushComments === 'function'
        ? m.pushComments.bind(m)
        : (typeof m.push_comments === 'function' ? m.push_comments.bind(m) : null);
      pushCommentDeleted = typeof m.pushCommentDeleted === 'function'
        ? m.pushCommentDeleted.bind(m)
        : (typeof m.push_comment_deleted === 'function' ? m.push_comment_deleted.bind(m) : null);
      assert.ok(pushComments, 'native bridge exposes pushComments');
      assert.ok(pushCommentDeleted, 'native bridge exposes pushCommentDeleted');

      pushComments(JSON.stringify([buildRawComment(commentId, 'renderless ticker text')]));

      await page.waitForFunction(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var textNode = root ? root.querySelector('.text') : null;
        return !!(root
          && textNode
          && (textNode.textContent || '').indexOf('renderless ticker text') !== -1
          && root.dataset.effectKeys === 'ticker-pulse');
      }, commentId, { timeout: 30000 });

      var beforeDelete = await page.evaluate(function (targetId) {
        var root = document.querySelector('[data-kh-id="' + targetId + '"]');
        var textNode = root ? root.querySelector('.text') : null;
        return {
          text: textNode ? textNode.textContent : '',
          phase: root ? root.getAttribute('data-kh-phase') : '',
          effectKeys: root ? root.dataset.effectKeys : '',
          effectCount: root ? root.dataset.effectCount : '',
          className: root ? root.className : ''
        };
      }, commentId);

      pushCommentDeleted(JSON.stringify([commentId]));

      await page.waitForFunction(function (targetId) {
        return !document.querySelector('[data-kh-id="' + targetId + '"]');
      }, commentId, { timeout: 30000 });

      var effectEvents = await page.evaluate(function () {
        return Array.isArray(window.__tickerEffectEvents) ? window.__tickerEffectEvents.slice() : [];
      });

      assert.match(beforeDelete.text, /renderless ticker text/, 'ticker renderless binds text without renderComment');
      assert.ok(
        beforeDelete.phase === 'entering' || beforeDelete.phase === 'active',
        'ticker renderless applies lifecycle metadata'
      );
      assert.equal(beforeDelete.effectKeys, 'ticker-pulse', 'ticker renderless exposes scheduler effect key');
      assert.equal(beforeDelete.effectCount, '1', 'ticker renderless exposes single registered effect');
      assert.match(beforeDelete.className, /is-pulsing/, 'ticker effect mutates bound node');
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'bind' && entry.id === commentId;
        }),
        'ticker effect bind hook ran'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'phase' && entry.id === commentId && entry.nextPhase === 'leaving';
        }),
        'ticker effect phase handler is notified on leaving'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'beforeRemove' && entry.id === commentId && entry.keys === 'ticker-pulse';
        }),
        'ticker beforeRemoveComment sees registered effects'
      );
      assert.ok(
        effectEvents.some(function (entry) {
          return entry.type === 'cleanup' && entry.id === commentId && entry.reason === 'remove';
        }),
        'ticker effect cleanup runs on delete'
      );
    } finally {
      if (page) {
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
      if (installedTemplateId) {
        await m.removeTemplate(installedTemplateId);
      }
    }
  });
});
