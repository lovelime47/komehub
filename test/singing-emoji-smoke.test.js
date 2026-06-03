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
const TEST_DATA_DIR = path.join(os.tmpdir(), 'singing-emoji-smoke-' + Date.now());
const RUNTIME_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;

var m;
var port;

describe('singing emoji smoke', { timeout: 60000 }, function () {
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

  it('keeps clap emoji intact through the template test path', async function () {
    var sceneId = 'singing-emoji';
    await m.createScene(sceneId, 'singing emoji');
    var addResult = JSON.parse(await m.addSceneTemplate(sceneId, TEMPLATE_ID));
    assert.equal(addResult.ok, true);

    var browser = await chromium.launch({ headless: true });
    var page = await browser.newPage({ viewport: { width: 900, height: 260 } });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String(e)); });

    try {
      var templateUrl = 'http://127.0.0.1:' + port + '/templates/' + sceneId + '/built-in/' + TEMPLATE_NAME + '/?preview=1';
      await page.goto(templateUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () { return !!window.KomehubTemplateRuntime; }, null, { timeout: 10000 });

      m.pushComments(JSON.stringify([{
        id: 'emoji-clap',
        service: 'youtube',
        name: '@fuwari-voice',
        comment: '👏👏👏👏👏',
        commentHtml: '👏👏👏👏👏',
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
      }]));

      await page.waitForFunction(function () {
        return !!document.querySelector('#comments .comment .text');
      }, null, { timeout: 10000 });

      var result = await page.evaluate(function () {
        var text = document.querySelector('#comments .comment .text');
        var value = text ? text.textContent : '';
        return {
          value: value,
          codepoints: Array.from(value).map(function (char) {
            return char.codePointAt(0).toString(16);
          }),
          fontFamily: text ? getComputedStyle(text).fontFamily : ''
        };
      });

      assert.equal(result.value, '👏👏👏👏👏');
      assert.deepEqual(result.codepoints, ['1f44f', '1f44f', '1f44f', '1f44f', '1f44f']);
      assert.match(result.fontFamily, /Emoji/);
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
