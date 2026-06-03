const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const nativeRuntime = require('./native-module-runtime');

const TEMPLATE_ID = 'com.comment-hub.template.ticker-renderless';
const TEMPLATE_NAME = 'ticker-renderless';
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const TEST_DATA_DIR = path.join(os.tmpdir(), 'ticker-renderless-smoke-' + Date.now());
const RUNTIME_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;

const EXPECTED_UI_SCHEMA_KEYS = [
  'maxComments',
  'positionY',
  'fontSize',
  'showName',
  'showBadge',
  'namePosition',
  'nameColor',
  'textColor',
  'memberColor',
  'memberColorValue',
  'glowIntensity',
  'glowColor',
  'glowCustomColor',
  'animSpeed'
];

var m;
var port;

function buildRawComment(overrides) {
  return Object.assign({
    id: 'ticker-' + Math.random().toString(36).slice(2, 10),
    service: 'youtube',
    name: '@ticker',
    comment: '横流れ確認です',
    commentHtml: '横流れ確認です',
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

describe('ticker-renderless smoke', { timeout: 60000 }, function () {
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
    var sceneId = 'ticker-renderless-config';
    await m.createScene(sceneId, 'ticker renderless config');
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

  it('renders ticker items from cellTemplate without renderComment', async function () {
    var sceneId = 'ticker-renderless-render';
    await m.createScene(sceneId, 'ticker renderless render');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 1280, height: 240 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/?preview=1';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'ticker-normal', name: '@TickerTest', comment: 'renderless ticker text', commentHtml: 'renderless ticker text' }),
        buildRawComment({
          id: 'ticker-paid',
          name: '@TickerPaid',
          comment: 'ticker paid text',
          commentHtml: 'ticker paid text',
          amount: 800,
          amountDisplay: '\u00a5800',
          currency: 'JPY',
          superchatTier: 'yellow'
        })
      ]));

      await page.waitForFunction(function () {
        return document.querySelectorAll('#track .comment').length >= 2;
      }, null, { timeout: 10000 });
      await page.waitForTimeout(120);
      var transformDuringA = await page.evaluate(function () {
        var track = document.getElementById('track');
        return track ? getComputedStyle(track).transform : '';
      });
      await page.waitForTimeout(220);
      var transformDuringB = await page.evaluate(function () {
        var track = document.getElementById('track');
        return track ? getComputedStyle(track).transform : '';
      });

      var result = await page.evaluate(function () {
        var container = document.getElementById('comments');
        var track = document.getElementById('track');
        var first = document.querySelector('#track .comment');
        var paid = document.querySelector('#track [data-id="ticker-paid"]');
        var firstText = first ? first.querySelector('.text') : null;
        return {
          count: document.querySelectorAll('#track .comment').length,
          containerClass: container ? container.className : '',
          transform: track ? getComputedStyle(track).transform : '',
          transitionTiming: track ? getComputedStyle(track).transitionTimingFunction : '',
          firstText: firstText ? firstText.textContent : '',
          paidClass: paid ? paid.className : '',
          paidText: paid ? paid.textContent : '',
          paidFontSize: paid ? getComputedStyle(paid).fontSize : '',
          phase: first ? first.getAttribute('data-kh-phase') : ''
        };
      });

      assert.equal(result.count, 2);
      assert.match(result.containerClass, /show-name/);
      assert.match(result.containerClass, /name-bottom/);
      assert.notEqual(result.transform, 'none');
      assert.notEqual(transformDuringA, transformDuringB, 'ticker track is still animating after new comments arrive');
      assert.match(result.transitionTiming, /cubic-bezier/);
      assert.match(result.firstText, /renderless ticker text/);
      assert.match(result.paidClass, /is-superchat/);
      assert.match(result.paidText, /\u00a5800/);
      assert.ok(parseFloat(result.paidFontSize) > 20, 'superchat is slightly larger');
      assert.equal(result.phase, 'active');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('keeps visible ticker items moving left when overflow trims old comments', async function () {
    var sceneId = 'ticker-renderless-overflow';
    await m.createScene(sceneId, 'ticker renderless overflow');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 1280, height: 240 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    async function pushOne(index) {
      m.pushComments(JSON.stringify([
        buildRawComment({
          id: 'ticker-burst-' + index,
          name: '@Ticker' + index,
          comment: 'burst ticker ' + index,
          commentHtml: 'burst ticker ' + index
        })
      ]));
    }

    async function anchorLeft() {
      return page.evaluate(function () {
        var anchor = document.querySelector('#track [data-id="ticker-burst-7"]');
        return anchor ? anchor.getBoundingClientRect().left : null;
      });
    }

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/?preview=1';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });

      // push を連続で行い、アニメ未完了の状態で次の push (overflow 9番目) に進む。
      // settle 後に 9番目を push すると ticker-burst-0 が off-screen left に到達して
      // trim されてしまうため、トランジション進行中で oldest がまだ可視範囲にいる
      // タイミングで 9番目を push する必要がある。
      for (var i = 0; i < 8; i += 1) {
        await pushOne(i);
        await page.waitForTimeout(50);
      }
      // 8 件全て DOM に届くまで待機 (count ベース、ID ベースだと並列下で flaky)
      await page.waitForFunction(function () {
        return document.querySelectorAll('#track .comment').length >= 8;
      }, null, { timeout: 20000 });
      // settle wait は意図的に**しない** — アニメ進行中で oldest が visible のうちに
      // 9番目を push して "trim されない" を検証するのが本テストの目的

      // 9番目 push 直前に oldest (ticker-burst-0) が画面内にあるか確認。
      // 並列テスト下でアニメが速く進むと既に off-screen left になることがあり、
      // その場合 trim は妥当な動作なので "removed immediately" 検証はスキップ。
      var oldestVisibleBeforeOverflow = await page.evaluate(function () {
        var first = document.querySelector('#track [data-id="ticker-burst-0"]');
        if (!first) return false;
        var rect = first.getBoundingClientRect();
        return rect.right > 0 && rect.left < window.innerWidth;
      });
      await pushOne(8);
      await page.waitForTimeout(120);
      var visibleOldestAfterOverflow = await page.evaluate(function () {
        return !!document.querySelector('#track [data-id="ticker-burst-0"]');
      });
      if (oldestVisibleBeforeOverflow) {
        assert.equal(visibleOldestAfterOverflow, true, 'visible oldest comment is not removed immediately on overflow');
      }
      // oldest が既に off-screen の場合は trim 妥当なので、本検証はスキップ

      for (var next = 9; next < 14; next += 1) {
        await pushOne(next);
        await page.waitForTimeout(40);
        var earlyLeft = await anchorLeft();
        await page.waitForTimeout(180);
        var laterLeft = await anchorLeft();
        assert.ok(earlyLeft != null, 'anchor is still visible after push ' + next);
        assert.ok(laterLeft != null, 'anchor remains visible after push ' + next);
        assert.ok(
          laterLeft <= earlyLeft + 2,
          'anchor should not drift right after overflow trim: early=' + earlyLeft + ' later=' + laterLeft
        );
      }

      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
