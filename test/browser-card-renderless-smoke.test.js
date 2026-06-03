const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const nativeRuntime = require('./native-module-runtime');

const TEMPLATE_ID = 'com.comment-hub.template.browser-card-renderless';
const TEMPLATE_NAME = 'browser-card-renderless';
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const TEST_DATA_DIR = path.join(os.tmpdir(), 'browser-card-renderless-smoke-' + Date.now());
const RUNTIME_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;

const EXPECTED_UI_SCHEMA_KEYS = [
  'maxComments',
  'width',
  'fontSize',
  'nameSize',
  'cardGap',
  'cornerRadius',
  'accentColor',
  'showAvatar',
  'showMetaRail',
  'compactMode',
  'typingEnabled',
  'themeMode'
];

var m;
var port;

function buildRawComment(overrides) {
  return Object.assign({
    id: 'browser-card-' + Math.random().toString(36).slice(2, 10),
    service: 'youtube',
    name: '@card',
    comment: 'カード表示確認です',
    commentHtml: 'カード表示確認です',
    profileImage: '',
    timestamp: '00:00',
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
  }, overrides || {});
}

async function fetchFirstSseEvent(streamUrl, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 5000);
  try {
    var res = await fetch(streamUrl, { signal: controller.signal });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (buf.indexOf('\n\n') === -1) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value);
    }
    await reader.cancel();
    var match = buf.match(/data:\s*({[\s\S]*?})\s*\n\n/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } finally {
    clearTimeout(timer);
  }
}

describe('browser-card-renderless smoke', { timeout: 60000 }, function () {
  before(async function () {
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes'), { recursive: true });
    process.env.KOMEHUB_PUBLIC_HTTP_PORT = '0';
    nativeRuntime.ensureNativeModuleBuilt();
    m = require(nativeRuntime.prepareNativeModulePath(RUNTIME_NODE_PATH));
    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    assert.ok(port > 0, 'port assigned: ' + port);
  });

  after(async function () {
    if (m && typeof m.shutdownCore === 'function') {
      try { await m.shutdownCore(); } catch (_e) { /* ignore */ }
    }
    try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    if (PREVIOUS_PUBLIC_HTTP_PORT == null) {
      delete process.env.KOMEHUB_PUBLIC_HTTP_PORT;
    } else {
      process.env.KOMEHUB_PUBLIC_HTTP_PORT = PREVIOUS_PUBLIC_HTTP_PORT;
    }
  });

  it('delivers SSE config containing all uiSchema keys', async function () {
    var sceneId = 'browser-card-config';
    await m.createScene(sceneId, 'browser card config');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);

    var streamUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/stream';
    var event = await fetchFirstSseEvent(streamUrl, 5000);
    assert.ok(event, 'SSE initial event received');
    assert.equal(event.type, 'config', 'event type is config');
    var configKeys = Object.keys(event.data || {});
    EXPECTED_UI_SCHEMA_KEYS.forEach(function (key) {
      assert.ok(configKeys.indexOf(key) !== -1, 'config contains ' + key);
    });
  });

  it('renders multi-layer cards with theme assets and preserved typing HTML', async function () {
    var sceneId = 'browser-card-render';
    await m.createScene(sceneId, 'browser card render');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/?preview=1';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'card-normal', name: '@CardTest' }),
        buildRawComment({
          id: 'card-superchat',
          name: '@PaidCard',
          comment: '多層カード確認',
          commentHtml: '多層カード確認',
          amount: 1500,
          amountDisplay: '\u00a51,500',
          currency: 'JPY',
          superchatTier: 'orange'
        })
      ]));

      await page.waitForFunction(function () {
        return document.querySelectorAll('#comments .browser-card').length >= 2;
      }, null, { timeout: 10000 });
      await page.waitForTimeout(300);

      var firstSnapshot = await page.evaluate(function () {
        var first = document.querySelector('#comments .browser-card');
        var paid = document.querySelector('#comments [data-id="card-superchat"]');
        var firstRect = first ? first.getBoundingClientRect() : null;
        return {
          count: document.querySelectorAll('#comments .browser-card').length,
          theme: first ? first.getAttribute('data-kh-theme') : '',
          icon: first ? getComputedStyle(first).getPropertyValue('--theme-icon-image') : '',
          typing: document.querySelectorAll('#comments .typing-char').length,
          paidClass: paid ? paid.className : '',
          notice: paid ? paid.querySelector('.notice').textContent : '',
          hasBackdrop: !!document.querySelector('.card-backdrop'),
          hasRail: !!document.querySelector('.meta-rail'),
          firstTop: firstRect ? firstRect.top : 0,
          viewportHeight: window.innerHeight
        };
      });

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'card-normal', name: '@CardTest' })
      ]));
      await page.waitForTimeout(250);

      var secondSnapshot = await page.evaluate(function () {
        var first = document.querySelector('#comments [data-id="card-normal"]');
        return {
          theme: first ? first.getAttribute('data-kh-theme') : '',
          html: first ? first.querySelector('.comment-text').innerHTML : ''
        };
      });

      assert.equal(firstSnapshot.count, 2);
      assert.ok(firstSnapshot.theme, 'theme key is attached');
      assert.match(firstSnapshot.icon, /icon-/);
      assert.ok(firstSnapshot.typing > 0, 'typing-char spans are rendered');
      assert.match(firstSnapshot.paidClass, /is-superchat/);
      assert.match(firstSnapshot.notice, /SUPER CHAT/);
      assert.equal(firstSnapshot.hasBackdrop, true);
      assert.equal(firstSnapshot.hasRail, true);
      assert.ok(firstSnapshot.firstTop > firstSnapshot.viewportHeight * 0.45, 'few cards are anchored near the lower area');
      assert.equal(secondSnapshot.theme, firstSnapshot.theme);
      assert.match(secondSnapshot.html, /typing-char/);
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('removes overflow cards as the rigid scroll advances', async function () {
    // rigid-board layout backend: 個別カードの leaving アニメは無く、scrollOffset の
    // 進行で container 上端を超えたカードを cleanupClippedCards が DOM から除去する。
    var sceneId = 'browser-card-overflow-leave';
    await m.createScene(sceneId, 'browser card overflow leave');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);
    var configResult = JSON.parse(await m.setSceneTemplateConfig(sceneId, TEMPLATE_ID, JSON.stringify({
      maxComments: 2,
      cardGap: 12,
      width: 520
    })));
    assert.equal(configResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'overflow-1', name: '@Overflow1', comment: '1枚目', commentHtml: '1枚目' }),
        buildRawComment({ id: 'overflow-2', name: '@Overflow2', comment: '2枚目', commentHtml: '2枚目' })
      ]));

      await page.waitForFunction(function () {
        return document.querySelectorAll('#comments .browser-card').length === 2;
      }, null, { timeout: 10000 });
      await page.waitForTimeout(120);

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'overflow-3', name: '@Overflow3', comment: '3枚目', commentHtml: '3枚目' })
      ]));

      // 板進行 → 1 枚目が clip → DOM から除去されるまで wait。
      // 同時に最新 (overflow-3) は板の中なので DOM に残る。
      // (テスト共有 buffer の都合で他の card-* が混ざり得るので push した最古/最新だけ確認)
      await page.waitForFunction(function () {
        var oneGone = !document.querySelector('[data-id="overflow-1"]');
        var threeStays = !!document.querySelector('[data-id="overflow-3"]');
        return oneGone && threeStays;
      }, null, { timeout: 10000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
