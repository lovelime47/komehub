const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const nativeRuntime = require('./native-module-runtime');

const TEMPLATE_ID = 'com.comment-hub.template.framed-list-renderless';
const TEMPLATE_NAME = 'framed-list-renderless';
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const TEMPLATE_DIR = path.join(__dirname, '..', 'effects-overlay', 'templates', TEMPLATE_NAME);
const TEST_DATA_DIR = path.join(os.tmpdir(), 'framed-list-renderless-smoke-' + Date.now());
const RUNTIME_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;

const EXPECTED_UI_SCHEMA_KEYS = [
  'maxComments',
  'width',
  'frameHeight',
  'fontSize',
  'position',
  'commentGap',
  'colorPreset',
  'accentColor',
  'textColor',
  'bgColor',
  'highlightColor',
  'borderColor',
  'frameOpacity',
  'showAvatar',
  'showBadge',
  'memberColor',
  'memberColorValue',
  'showHeader',
  'kickerText',
  'headerText',
  'showStatus',
  'statusText',
  'showFooter',
  'footerText',
  'dense',
  'typingEnabled',
  'typingSpeed',
  'animationStyle'
];

var m;
var port;

function buildRawComment(overrides) {
  return Object.assign({
    id: 'framed-' + Math.random().toString(36).slice(2, 10),
    service: 'youtube',
    name: '@framed',
    comment: '表示確認です',
    commentHtml: '表示確認です',
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

describe('framed-list-renderless smoke', { timeout: 60000 }, function () {
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
    var sceneId = 'framed-config';
    await m.createScene(sceneId, 'framed config');
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

  it('defines renderless lifecycle CSS for every animation preset', function () {
    var manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'manifest.json'), 'utf8'));
    var styleCss = fs.readFileSync(path.join(TEMPLATE_DIR, 'style.css'), 'utf8');
    var animationSetting = manifest.uiSchema.find(function (item) {
      return item && item.key === 'animationStyle';
    });
    assert.ok(animationSetting, 'animationStyle setting exists');

    animationSetting.options.forEach(function (option) {
      var className = 'kh-anim-' + option.value;
      assert.match(styleCss, new RegExp('#comments\\.' + className + '\\s+\\.comment\\.is-entering'), className + ' has entering CSS');
      assert.match(styleCss, new RegExp('#comments\\.' + className + '\\s+\\.comment\\.is-active'), className + ' has active CSS');
      assert.match(styleCss, new RegExp('#comments\\.' + className + '\\s+\\.comment\\.is-leaving'), className + ' has leaving CSS');
    });
  });

  it('keeps dependent header settings grouped together', function () {
    var manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'manifest.json'), 'utf8'));
    var statusTextSetting = manifest.uiSchema.find(function (item) {
      return item && item.key === 'statusText';
    });
    assert.ok(statusTextSetting, 'statusText setting exists');
    assert.deepEqual(statusTextSetting.showIf, [
      { key: 'showHeader', value: true },
      { key: 'showStatus', value: true }
    ]);
  });

  it('keeps beginner guides aligned with the current renderless sample', function () {
    var docFiles = [
      'README.md',
      'structure.html',
      path.join('guides', 'first-edit.html'),
      path.join('guides', 'fields.html'),
      path.join('guides', 'model.html'),
      path.join('guides', 'themes.html')
    ];
    var combined = docFiles.map(function (file) {
      return fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
    }).join('\n');

    assert.doesNotMatch(combined, /themeKey|themeAssets|data-kh-theme|context\.helpers/);
    assert.match(combined, /guides\/first-edit\.html/);
    assert.match(combined, /data-kh="display\.html"/);
    assert.match(combined, /beforeCommitComment\(\)/);
  });

  it('renders with renderless display structure and typing HTML', async function () {
    var sceneId = 'framed-render';
    await m.createScene(sceneId, 'framed render');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/?preview=1';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });
      var heightBefore = await page.evaluate(function () {
        var frame = document.querySelector('.frame-shell');
        return frame ? frame.getBoundingClientRect().height : 0;
      });

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'framed-normal', name: '@FrameTest' }),
        buildRawComment({
          id: 'framed-superchat',
          name: '@SuperChat',
          comment: 'スパチャ確認',
          commentHtml: 'スパチャ確認',
          amount: 1000,
          amountDisplay: '\u00a51,000',
          currency: 'JPY',
          superchatTier: 'yellow'
        })
      ]));

      await page.waitForFunction(function () {
        return document.querySelectorAll('#comments .comment').length >= 2;
      }, null, { timeout: 10000 });
      await page.waitForTimeout(300);

      var result = await page.evaluate(function () {
        var paid = document.querySelector('#comments [data-id="framed-superchat"]');
        return {
          count: document.querySelectorAll('#comments .comment').length,
          frameHeight: document.querySelector('.frame-shell') ? document.querySelector('.frame-shell').getBoundingClientRect().height : 0,
          typing: document.querySelectorAll('#comments .typing-char').length,
          paidClass: paid ? paid.className : '',
          header: document.querySelector('.frame-title') ? document.querySelector('.frame-title').textContent : ''
        };
      });

      assert.equal(result.count, 2);
      assert.equal(heightBefore, 652);
      assert.equal(result.frameHeight, heightBefore);
      assert.ok(result.typing > 0, 'typing-char spans are rendered');
      assert.match(result.paidClass, /is-superchat/);
      assert.equal(result.header, 'Comment Board');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('applies completion settings for placement, status, gap and typing', async function () {
    var sceneId = 'framed-settings';
    await m.createScene(sceneId, 'framed settings');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);
    var configResult = JSON.parse(await m.setSceneTemplateConfig(sceneId, TEMPLATE_ID, JSON.stringify({
      position: 'right',
      commentGap: 22,
      showStatus: false,
      showFooter: false,
      typingEnabled: false,
      typingSpeed: 8,
      animationStyle: 'slide-left',
      headerText: '雑談コメント'
    })));
    assert.equal(configResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });

      m.pushComments(JSON.stringify([
        buildRawComment({ id: 'framed-settings-1', name: '@Settings', comment: '設定確認', commentHtml: '設定確認' })
      ]));

      await page.waitForFunction(function () {
        return document.querySelectorAll('#comments .comment').length >= 1;
      }, null, { timeout: 10000 });
      await page.waitForTimeout(150);

      var result = await page.evaluate(function () {
        var comments = document.querySelector('#comments');
        var status = document.querySelector('.frame-status');
        var footer = document.querySelector('.frame-footer');
        var typing = document.querySelector('.typing-char');
        return {
          bodyClass: document.body.className,
          commentsClass: comments ? comments.className : '',
          justifyContent: getComputedStyle(document.body).justifyContent,
          gap: getComputedStyle(comments).gap,
          statusDisplay: status ? getComputedStyle(status).display : '',
          footerDisplay: footer ? getComputedStyle(footer).display : '',
          header: document.querySelector('.frame-title') ? document.querySelector('.frame-title').textContent : '',
          typingAnimation: typing ? getComputedStyle(typing).animationName : '',
          typingOpacity: typing ? getComputedStyle(typing).opacity : ''
        };
      });

      assert.match(result.bodyClass, /kh-pos-right/);
      assert.match(result.bodyClass, /hide-status/);
      assert.match(result.bodyClass, /hide-footer/);
      assert.match(result.bodyClass, /no-typing/);
      assert.match(result.commentsClass, /kh-anim-slide-left/);
      assert.equal(result.justifyContent, 'flex-end');
      assert.equal(result.gap, '22px');
      assert.equal(result.statusDisplay, 'none');
      assert.equal(result.footerDisplay, 'none');
      assert.equal(result.header, '雑談コメント');
      assert.equal(result.typingAnimation, 'none');
      assert.equal(result.typingOpacity, '1');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
