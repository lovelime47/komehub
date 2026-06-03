/**
 * napi-rs ブリッジのテスト。
 *
 * komehub_core.node (DLL) を直接ロードし、全 API の動作を確認する。
 * Electron 非依存 — Node.js 単体で実行可能。
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const AdmZip = require('adm-zip');
const nativeRuntime = require('./native-module-runtime');
const PACKAGE_VERSION = require('../package.json').version;

// テスト用データディレクトリ（本番と分離）
const TEST_DATA_DIR = path.join(os.tmpdir(), 'komehub-test-' + Date.now());
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const RUNTIME_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core_runtime.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;
const CHAT_LIST_ID = 'com.comment-hub.template.standard-renderless';
const STANDARD_RENDERLESS_ID = 'com.comment-hub.template.standard-renderless';
const CHAT_CUTE_ID = 'com.comment-hub.template.chat-cute';
const CHAT_WAFUU_ID = 'com.comment-hub.template.chat-wafuu';
const GAME_COMPACT_ID = 'com.comment-hub.template.game-compact';
const GAME_FPS_ID = 'com.comment-hub.template.game-fps';
const SINGING_TEXT_ID = 'com.comment-hub.template.singing-text';
const GAME_RAINBOW_ID = 'com.comment-hub.template.game-rainbow';
const TICKER_RENDERLESS_ID = 'com.comment-hub.template.ticker-renderless';
const LEGACY_CUSTOM_STORAGE = 'tmpl-legacy-custom';
const LEGACY_ONECOMME_STORAGE = 'tmpl-legacy-onecomme';

var m;
var port;

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(label + ' returned invalid JSON: ' + (err && err.message ? err.message : err));
  }
}

function registerSharedBuffer(name) {
  var layout = parseJson(m.getSharedBufferLayout(name), 'getSharedBufferLayout(' + name + ')');
  assert.ok(layout && layout.totalBytes > 0, 'layout available for ' + name);

  var registration = parseJson(
    m.registerSharedBuffer(name, Buffer.alloc(layout.totalBytes)),
    'registerSharedBuffer(' + name + ')'
  );
  assert.ok(!registration.error, 'shared buffer registration succeeded for ' + name);
}

async function waitForSnapshot(label, readSnapshot, predicate, timeoutMs) {
  var startedAt = Date.now();
  var lastSnapshot = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = readSnapshot();
    if (lastSnapshot && predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  }

  throw new Error(label + ' timed out. Last snapshot: ' + JSON.stringify(lastSnapshot));
}

async function waitForValue(label, readValue, predicate, timeoutMs) {
  var startedAt = Date.now();
  var lastValue = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await readValue();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  }

  throw new Error(label + ' timed out. Last value: ' + JSON.stringify(lastValue));
}

function rawComment(overrides) {
  return Object.assign({
    id: uniqueId('comment'),
    name: '@user',
    comment: 'comment',
    commentHtml: 'comment',
    profileImage: '',
    timestamp: '12:34',
    hasGift: false,
    amount: 0,
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
    isVerified: false
  }, overrides || {});
}

function httpJson(urlPath) {
  var http = require('node:http');
  return new Promise(function (resolve, reject) {
    http.get('http://127.0.0.1:' + port + urlPath, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(body)
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function httpJsonRequest(method, urlPath, body) {
  var http = require('node:http');
  var payload = body == null ? '' : JSON.stringify(body);
  return new Promise(function (resolve, reject) {
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, function (res) {
      var responseBody = '';
      res.on('data', function (chunk) { responseBody += chunk; });
      res.on('end', function () {
        try {
          resolve({
            statusCode: res.statusCode,
            body: responseBody ? JSON.parse(responseBody) : null
          });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpBuffer(urlPath) {
  var http = require('node:http');
  return new Promise(function (resolve, reject) {
    http.get('http://127.0.0.1:' + port + urlPath, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks)
        });
      });
    }).on('error', reject);
  });
}

function listenerRawComment(id, userId, displayName, body, timestamp) {
  return {
    id: id,
    userId: userId,
    liveId: '',
    name: displayName,
    displayName: displayName,
    screenName: '',
    nickname: '',
    comment: body,
    commentHtml: '',
    speechText: '',
    profileImage: '',
    originalProfileImage: '',
    timestamp: timestamp || '2026-05-03T12:00:00.000Z',
    hasGift: false,
    amount: 0,
    currency: '',
    amountDisplay: '',
    stickerImage: '',
    tierColor: '',
    superchatTier: '',
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
    isFirstTime: false,
    isRepeater: false,
    commentVisible: true,
    autoModerated: false
  };
}

function httpSseEvents(urlPath, eventCount, timeoutMs) {
  var http = require('node:http');
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = null;
    var req = http.get('http://127.0.0.1:' + port + urlPath, function (res) {
      var buffer = '';
      var events = [];
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        buffer += chunk;
        while (buffer.indexOf('\n\n') !== -1) {
          var splitIndex = buffer.indexOf('\n\n');
          var rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          var dataLines = rawEvent.split(/\r?\n/).filter(function (line) {
            return line.indexOf('data:') === 0;
          });
          if (dataLines.length === 0) continue;
          try {
            events.push(JSON.parse(dataLines.map(function (line) {
              return line.slice(5).trim();
            }).join('\n')));
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }
          if (events.length >= eventCount) {
            cleanup();
            resolve(events);
            return;
          }
        }
      });
      res.on('error', function (error) {
        cleanup();
        reject(error);
      });
    });

    req.on('error', function (error) {
      cleanup();
      reject(error);
    });

    timer = setTimeout(function () {
      cleanup();
      reject(new Error('SSE timed out for ' + urlPath));
    }, timeoutMs || 3000);

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
    }
  });
}

// options.onFirstEvent: 最初のイベント (通常 'config') 受信時に呼ばれる。
//   SSE 購読が確実に成立してから副作用を起こしたいテストで race を防ぐ。
function httpSseUntil(urlPath, predicate, timeoutMs, options) {
  var http = require('node:http');
  options = options || {};
  return new Promise(function (resolve, reject) {
    var settled = false;
    var firstEventFired = false;
    var timer = null;
    var req = http.get('http://127.0.0.1:' + port + urlPath, function (res) {
      var buffer = '';
      var events = [];
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        buffer += chunk;
        while (buffer.indexOf('\n\n') !== -1) {
          var splitIndex = buffer.indexOf('\n\n');
          var rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          var dataLines = rawEvent.split(/\r?\n/).filter(function (line) {
            return line.indexOf('data:') === 0;
          });
          if (dataLines.length === 0) continue;
          try {
            var event = JSON.parse(dataLines.map(function (line) {
              return line.slice(5).trim();
            }).join('\n'));
            events.push(event);
            if (!firstEventFired) {
              firstEventFired = true;
              if (typeof options.onFirstEvent === 'function') {
                try {
                  options.onFirstEvent(event);
                } catch (hookErr) {
                  cleanup();
                  reject(hookErr);
                  return;
                }
              }
            }
            if (predicate(event, events)) {
              cleanup();
              resolve(events);
              return;
            }
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }
        }
      });
      res.on('error', function (error) {
        cleanup();
        reject(error);
      });
    });

    req.on('error', function (error) {
      cleanup();
      reject(error);
    });

    timer = setTimeout(function () {
      cleanup();
      reject(new Error('SSE timed out for ' + urlPath));
    }, timeoutMs || 3000);

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
    }
  });
}

function pngDataUrl(label) {
  return 'data:image/png;base64,' + Buffer.from(label, 'utf8').toString('base64');
}

function uniqueId(prefix) {
  return prefix + '.' + Date.now() + '.' + Math.floor(Math.random() * 100000);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function listZipEntries(zipPath) {
  return new AdmZip(zipPath).getEntries().map(function (entry) {
    return entry.entryName.replace(/\\/g, '/');
  }).sort();
}

function createPluginFixture(effectId) {
  var pluginDir = path.join(PLUGINS_DIR, effectId);
  fs.mkdirSync(path.join(pluginDir, 'templates'), { recursive: true });
  writeJson(path.join(pluginDir, 'manifest.json'), {
    id: effectId,
    version: '1.0.0',
    name: 'Export Test Effect',
    entry: 'main.js',
    interface: { methods: ['fire'] }
  });
  fs.writeFileSync(path.join(pluginDir, 'main.js'), 'window.ExportTestEffect = { fire: function () {} };');
  fs.writeFileSync(path.join(pluginDir, 'templates', 'card.html'), '<div>card</div>');
  return pluginDir;
}

function createTemplateFontFixture(options) {
  options = options || {};
  var templateId = uniqueId('com.test.template.fonts');
  var storageName = 'tmpl-fonts-' + Math.floor(Math.random() * 1000000);
  var templateDir = path.join(TEST_DATA_DIR, 'templates', storageName);
  fs.mkdirSync(path.join(templateDir, 'fonts'), { recursive: true });
  fs.writeFileSync(
    path.join(templateDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="comments"></div><script src="script.js"></script></body></html>'
  );
  fs.writeFileSync(
    path.join(templateDir, 'style.css'),
    'html,body{margin:0;background:transparent;font-family:"Bundled Example Font","Noto Sans JP",sans-serif;}'
  );
  fs.writeFileSync(path.join(templateDir, 'script.js'), '(function(){window.__fontFixtureLoaded=true;})();');
  fs.writeFileSync(
    path.join(templateDir, 'fonts', 'bundled-font.css'),
    [
      '@font-face {',
      '  font-family: "Bundled Example Font";',
      '  src: url("./BundledExampleFont.woff2") format("woff2");',
      '  font-display: swap;',
      '}'
    ].join('\n')
  );
  fs.writeFileSync(path.join(templateDir, 'fonts', 'BundledExampleFont.woff2'), 'bundled-font-data');
  var manifest = {
    id: templateId,
    name: 'font-fixture',
    displayName: 'Font Fixture',
    version: '1.0.0',
    fonts: ['Noto Sans JP'],
    fontSources: [
      {
        family: 'Bundled Example Font',
        type: 'assetCss',
        css: 'fonts/bundled-font.css'
      },
      {
        family: 'Remote Example Font',
        type: 'remoteCss',
        url: 'https://cdn.example.com/fonts/remote-font.css'
      }
    ],
    uiSchema: []
  };
  if (options.exportPolicy) {
    manifest.exportPolicy = options.exportPolicy;
  }
  writeJson(path.join(templateDir, 'manifest.json'), manifest);
  return {
    dir: templateDir,
    templateId: templateId
  };
}

async function addCustomEffect(effectId) {
  var result = JSON.parse(await m.addEffect(JSON.stringify({
    id: effectId,
    name: 'Export Test Effect',
    builtin: false,
    version: '1.0.0',
    icon: 'T',
    badgeColor: '#123456',
    params: {}
  })));
  assert.equal(result, effectId, 'addEffect returned created effect ID');
}

async function removeCustomEffect(effectId) {
  if (!m || typeof m.removeEffect !== 'function') return;
  try {
    await m.removeEffect(effectId);
  } catch (e) {
    // cleanup best-effort
  }
}

function startMockFontServer() {
  var http = require('node:http');
  var counts = {
    css: 0,
    font: 0
  };
  var server = http.createServer(function (req, res) {
    if (req.url.indexOf('/css') === 0) {
      counts.css++;
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end([
        '@font-face {',
        '  font-family: "Mock Font";',
        '  src: url("http://127.0.0.1:' + server.address().port + '/fonts/mock-font.woff2") format("woff2");',
        '}'
      ].join('\n'));
      return;
    }
    if (req.url === '/fonts/mock-font.woff2') {
      counts.font++;
      res.writeHead(200, { 'Content-Type': 'font/woff2' });
      res.end(Buffer.from('mock-font-data', 'utf8'));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise(function (resolve, reject) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, counts: counts, port: server.address().port });
    });
    server.on('error', reject);
  });
}

function startMockImageServer() {
  var http = require('node:http');
  var counts = {
    avatarOne: 0,
    avatarTwo: 0,
    avatarSlow: 0,
    emojiOne: 0,
    missing: 0
  };
  var server = http.createServer(function (req, res) {
    if (req.url === '/images/avatar-one.png') {
      counts.avatarOne++;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('avatar-one', 'utf8'));
      return;
    }
    if (req.url === '/images/avatar-two.png') {
      counts.avatarTwo++;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('avatar-two', 'utf8'));
      return;
    }
    if (req.url === '/images/avatar-slow.png') {
      counts.avatarSlow++;
      setTimeout(function () {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from('avatar-slow', 'utf8'));
      }, 80);
      return;
    }
    if (req.url === '/images/emoji-one.png') {
      counts.emojiOne++;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('emoji-one', 'utf8'));
      return;
    }
    if (req.url === '/images/missing.png') {
      counts.missing++;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('missing');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise(function (resolve, reject) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, counts: counts, port: server.address().port });
    });
    server.on('error', reject);
  });
}

describe('napi-bridge', function () {
  before(async function () {
    // テスト用データディレクトリ作成
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'templates', LEGACY_CUSTOM_STORAGE), { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'templates', LEGACY_ONECOMME_STORAGE), { recursive: true });
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'templates', LEGACY_CUSTOM_STORAGE, 'index.html'), '<!doctype html><html><body>legacy custom</body></html>');
    writeJson(path.join(TEST_DATA_DIR, 'templates', LEGACY_CUSTOM_STORAGE, 'manifest.json'), {
      name: 'Legacy Custom Template',
      displayName: 'Legacy Custom Template',
      version: '1.0.0',
      uiSchema: []
    });
    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'templates', LEGACY_ONECOMME_STORAGE, 'index.html'),
      '<!doctype html><html><head><script src="onesdk.js"></script></head><body>legacy onecomme</body></html>'
    );
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes', 'legacy-template-scene'), { recursive: true });
    writeJson(path.join(TEST_DATA_DIR, 'scenes', 'legacy-template-scene', 'scene.json'), {
      name: 'Legacy Template Scene',
      enabled: true,
      performancesEnabled: true,
      performances: [],
      templatesEnabled: true,
      templates: [
        { name: LEGACY_CUSTOM_STORAGE, enabled: true, settings: { maxComments: 5 } },
        { name: LEGACY_ONECOMME_STORAGE, enabled: true, settings: {} }
      ],
      mascot: {}
    });
    process.env.KOMEHUB_PUBLIC_HTTP_PORT = '0';

    nativeRuntime.ensureNativeModuleBuilt();

    // DLL ロード
    m = require(nativeRuntime.prepareNativeModulePath(RUNTIME_NODE_PATH));
    assert.ok(m, 'Native module loaded');

    // 初期化
    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    assert.ok(port > 0, 'Port assigned: ' + port);

    registerSharedBuffer('reactionCounts');
    registerSharedBuffer('performanceLog');
    registerSharedBuffer('commentTimeline');
    registerSharedBuffer('connection');
    registerSharedBuffer('performanceEngineState');
  });

  after(async function () {
    if (m && typeof m.shutdownCore === 'function') {
      try {
        await m.shutdownCore();
      } catch (e) {
        // shutdown failure is not critical for cleanup
      }
    }
    // テストデータ削除
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // cleanup failure is not critical
    }
    if (PREVIOUS_PUBLIC_HTTP_PORT == null) {
      delete process.env.KOMEHUB_PUBLIC_HTTP_PORT;
    } else {
      process.env.KOMEHUB_PUBLIC_HTTP_PORT = PREVIOUS_PUBLIC_HTTP_PORT;
    }
  });

  // --- health ---

  it('health() returns version', function () {
    var result = JSON.parse(m.health());
    assert.equal(result.status, 'ok');
    assert.equal(result.version, PACKAGE_VERSION);
  });

  it('getPort() returns assigned port', function () {
    assert.equal(m.getPort(), port);
  });

  it('subscribeRuntimeEvents() receives normalized runtime events', async function () {
    var received = [];
    var sceneId = uniqueId('runtime-events-scene');

    m.subscribeRuntimeEvents(function (_err, data) {
      if (!data) return;
      received.push(JSON.parse(data));
    });

    try {
      await m.createScene(sceneId, 'Runtime Events Scene');

      m.pushConnectionState(true, 'runtime-video-id');
      m.pushComments(JSON.stringify([
        {
          id: 'runtime-comment-1',
          name: '@runtime',
          comment: 'runtime-keyword',
          commentHtml: '<b>runtime-keyword</b>',
          profileImage: '',
          timestamp: '12:34',
          hasGift: false,
          amount: 0,
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
          isVerified: false
        }
      ]));
      m.pushReaction(JSON.stringify({ emoji: 'heart', count: 1 }));
      m.pushCommentDeleted(JSON.stringify(['runtime-comment-1']));
      await new Promise(function (resolve) { setTimeout(resolve, 100); });

      assert.ok(received.some(function (event) {
        return event.type === 'static' &&
          event.path === 'connection' &&
          event.data &&
          event.data.connected === true &&
          event.data.videoId === 'runtime-video-id';
      }), 'normalized connection event received');

      assert.ok(received.some(function (event) {
        return event.type === 'session-comment' && event.data && event.data.id === 'runtime-comment-1';
      }), 'normalized session comment received');

      assert.ok(received.some(function (event) {
        return event.type === 'session-reaction' &&
          event.data &&
          event.data.counts &&
          event.data.counts.heart >= 1;
      }), 'normalized session reaction received');

      assert.ok(received.some(function (event) {
        return event.type === 'comment-deleted' &&
          event.data &&
          event.data.id === 'runtime-comment-1';
      }), 'normalized comment deleted received');
    } finally {
      try { await m.deleteScene(sceneId); } catch (e) {}
    }
  });

  // --- Scene CRUD ---

  it('createScene + getScenes', async function () {
    var result = await m.createScene('test-scene-1', 'Test Scene 1');
    var parsed = JSON.parse(result);
    assert.ok(parsed, 'createScene returned result');

    var scenes = JSON.parse(await m.getScenes());
    assert.ok(scenes.scenes, 'getScenes returned scenes object');
    assert.ok(scenes.scenes['test-scene-1'], 'Created scene exists');
    assert.equal(scenes.scenes['test-scene-1'].name, 'Test Scene 1');
  });

  it('getSceneList returns DTO rows from Rust', async function () {
    var list = JSON.parse(await m.getSceneList());
    var row = list.find(function (item) { return item.id === 'test-scene-1'; });
    assert.ok(Array.isArray(list), 'getSceneList returned array');
    assert.ok(row, 'scene row exists');
    assert.equal(row.name, 'Test Scene 1');
    assert.equal(row.enabled, true);
    assert.equal(row.performanceCount, 0);
  });

  it('renameScene', async function () {
    var result = JSON.parse(await m.renameScene('test-scene-1', 'Renamed Scene'));
    assert.ok(result && result.ok, 'renameScene succeeded');

    var scenes = JSON.parse(await m.getScenes());
    assert.equal(scenes.scenes['test-scene-1'].name, 'Renamed Scene');
  });

  it('setSceneEnabled', async function () {
    var result = JSON.parse(await m.setSceneEnabled('test-scene-1', false));
    // エンジンは enabled フィールドを返すか、ok を返す
    assert.ok(result !== null, 'setSceneEnabled returned result');
  });

  it('duplicateScene', async function () {
    var result = await m.duplicateScene('test-scene-1', 'test-scene-copy', 'Copy Scene');
    var parsed = JSON.parse(result);
    assert.ok(parsed, 'duplicateScene returned result');

    var scenes = JSON.parse(await m.getScenes());
    assert.ok(scenes.scenes['test-scene-copy'], 'Duplicated scene exists');
  });

  it('createSceneWithGeneratedId returns generated scene id', async function () {
    var sceneName = 'Auto Scene ' + uniqueId('generated');
    var sceneId = JSON.parse(await m.createSceneWithGeneratedId(sceneName));
    assert.equal(typeof sceneId, 'string');
    assert.ok(sceneId.indexOf('auto-scene-') === 0, 'generated scene id is slugged');

    try {
      var scenes = JSON.parse(await m.getScenes());
      assert.ok(scenes.scenes[sceneId], 'Generated scene exists');
      assert.equal(scenes.scenes[sceneId].name, sceneName);
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('duplicateSceneWithGeneratedId returns generated scene id', async function () {
    var sourceId = uniqueId('duplicate-source');
    await m.createScene(sourceId, 'Duplicate Source');

    var duplicatedId = JSON.parse(await m.duplicateSceneWithGeneratedId(sourceId, 'Generated Copy'));
    assert.equal(typeof duplicatedId, 'string');
    assert.notEqual(duplicatedId, sourceId);

    try {
      var scenes = JSON.parse(await m.getScenes());
      assert.ok(scenes.scenes[duplicatedId], 'Generated duplicate exists');
      assert.equal(scenes.scenes[duplicatedId].name, 'Generated Copy');
    } finally {
      await m.deleteScene(duplicatedId);
      await m.deleteScene(sourceId);
    }
  });

  it('deleteScene', async function () {
    var result = await m.deleteScene('test-scene-copy');
    var parsed = JSON.parse(result);
    assert.ok(parsed, 'deleteScene returned result');

    var scenes = JSON.parse(await m.getScenes());
    assert.ok(!scenes.scenes['test-scene-copy'], 'Deleted scene is gone');
  });

  it('reorderScenes (fire-and-forget)', function () {
    // fire-and-forget — エラーなく完了すれば OK
    m.reorderScenes(['test-scene-1']);
    assert.ok(true);
  });

  it('hasReactionTrigger reflects enabled reaction performances', async function () {
    var sceneId = uniqueId('reaction-trigger-scene');
    assert.equal(JSON.parse(await m.hasReactionTrigger()), false);

    try {
      await m.createScene(sceneId, 'Reaction Trigger Scene');
      await m.savePerformance(sceneId, JSON.stringify({
        id: 'reaction-perf',
        name: 'Reaction Performance',
        enabled: true,
        trigger: { type: 'reaction', reactionTypes: ['heart'] },
        effect: 'cracker',
        cooldown: 0
      }));

      assert.equal(JSON.parse(await m.hasReactionTrigger()), true);

      await m.setSceneEnabled(sceneId, false);
      assert.equal(JSON.parse(await m.hasReactionTrigger()), false);
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('setSceneTemplateConfig normalizes backgroundImage to template assets path', async function () {
    var sceneId = uniqueId('template-config-scene');

    try {
      await m.createScene(sceneId, 'Template Config Scene');

      var addResult = JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID));
      assert.equal(addResult.ok, true);

      var saveResult = JSON.parse(await m.setSceneTemplateConfig(
        sceneId,
        CHAT_LIST_ID,
        JSON.stringify({
          backgroundImage: 'bg-normalize.png',
          maxComments: 12
        })
      ));
      assert.equal(saveResult.ok, true);

      var templates = JSON.parse(await m.getSceneTemplates(sceneId));
      var template = (templates.sceneTemplates || []).find(function (item) {
        return item && item.id === CHAT_LIST_ID;
      });

      assert.ok(template, 'scene template exists');
      assert.equal(template.settings.backgroundImage, 'assets/bg-normalize.png');
      assert.equal(template.settings.maxComments, 12);
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('supplements generated ids for legacy custom and OneComme templates', async function () {
    var templates = JSON.parse(await m.getTemplates());
    var legacyCustom = templates.find(function (item) { return item && item.storageName === LEGACY_CUSTOM_STORAGE; });
    var legacyOneComme = templates.find(function (item) { return item && item.storageName === LEGACY_ONECOMME_STORAGE; });

    assert.ok(legacyCustom, 'legacy custom template listed');
    assert.ok(legacyOneComme, 'legacy OneComme template listed');
    assert.match(legacyCustom.id, /^com\.comment-hub\.template\.custom\./);
    assert.match(legacyOneComme.id, /^com\.comment-hub\.template\.onecomme\./);

    var customMeta = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'templates', LEGACY_CUSTOM_STORAGE, '.template-meta.json'), 'utf8'));
    var oneCommeMeta = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'templates', LEGACY_ONECOMME_STORAGE, '.template-meta.json'), 'utf8'));
    var customManifest = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'templates', LEGACY_CUSTOM_STORAGE, 'manifest.json'), 'utf8'));

    assert.equal(customMeta.id, legacyCustom.id);
    assert.equal(oneCommeMeta.id, legacyOneComme.id);
    assert.equal(customManifest.id, legacyCustom.id);
  });

  it('migrates legacy scene template references to canonical template ids', async function () {
    var templates = JSON.parse(await m.getTemplates());
    var legacyCustom = templates.find(function (item) { return item && item.storageName === LEGACY_CUSTOM_STORAGE; });
    var legacyOneComme = templates.find(function (item) { return item && item.storageName === LEGACY_ONECOMME_STORAGE; });
    var sceneTemplates = JSON.parse(await m.getSceneTemplates('legacy-template-scene'));
    var customSceneTemplate = (sceneTemplates.sceneTemplates || []).find(function (item) {
      return item && item.id === legacyCustom.id;
    });
    var oneCommeSceneTemplate = (sceneTemplates.sceneTemplates || []).find(function (item) {
      return item && item.id === legacyOneComme.id;
    });

    assert.ok(customSceneTemplate, 'legacy custom scene template migrated');
    assert.ok(oneCommeSceneTemplate, 'legacy OneComme scene template migrated');
    assert.equal(sceneTemplates.selectedTemplateId, legacyCustom.id);
    assert.equal(customSceneTemplate.name, legacyCustom.id);
    assert.equal(oneCommeSceneTemplate.name, legacyOneComme.id);

    var storedScene = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'scenes', 'legacy-template-scene', 'scene.json'), 'utf8'));
    assert.equal(storedScene.selectedTemplateId, legacyCustom.id);
    assert.equal(storedScene.templates[0].id, legacyCustom.id);
    assert.equal(storedScene.templates[0].name, legacyCustom.id);
    assert.equal(storedScene.templates[1].id, legacyOneComme.id);
    assert.equal(storedScene.templates[1].name, legacyOneComme.id);
  });

  it('selectedTemplateId updates and falls back when selected template is removed', async function () {
    var sceneId = uniqueId('selected-template-scene');

    try {
      await m.createScene(sceneId, 'Selected Template Scene');
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_CUTE_ID)).ok, true);

      var sceneTemplates = JSON.parse(await m.getSceneTemplates(sceneId));
      assert.equal(sceneTemplates.selectedTemplateId, CHAT_LIST_ID, 'first added template becomes selected');

      var setSelectedResult = JSON.parse(await m.setSelectedSceneTemplate(sceneId, CHAT_CUTE_ID));
      assert.equal(setSelectedResult.ok, true, 'selection update succeeds');

      sceneTemplates = JSON.parse(await m.getSceneTemplates(sceneId));
      assert.equal(sceneTemplates.selectedTemplateId, CHAT_CUTE_ID, 'selectedTemplateId reflects explicit selection');

      assert.equal(JSON.parse(await m.removeSceneTemplate(sceneId, CHAT_CUTE_ID)).ok, true);
      sceneTemplates = JSON.parse(await m.getSceneTemplates(sceneId));
      assert.equal(sceneTemplates.selectedTemplateId, CHAT_LIST_ID, 'selection falls back to remaining template');

      assert.equal(JSON.parse(await m.removeSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);
      sceneTemplates = JSON.parse(await m.getSceneTemplates(sceneId));
      assert.equal(sceneTemplates.selectedTemplateId, '', 'selection clears when scene has no templates');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('template bucket routes resolve built-in and OneComme templates', async function () {
    var builtinIndex = await httpBuffer('/templates/legacy-template-scene/built-in/standard-renderless/');
    var oneCommeIndex = await httpBuffer('/templates/legacy-template-scene/one/1/');
    var runtimeAsset = await httpBuffer('/templates/__runtime/runtime.js');

    assert.equal(builtinIndex.statusCode, 200);
    assert.equal(oneCommeIndex.statusCode, 200);
    assert.equal(runtimeAsset.statusCode, 200);
    assert.match(runtimeAsset.body.toString('utf8'), /KomehubTemplateRuntime/);
    assert.match(runtimeAsset.body.toString('utf8'), /createListController/);
    assert.match(runtimeAsset.body.toString('utf8'), /parts\s*=\s*\{/);
    assert.match(runtimeAsset.body.toString('utf8'), /ensureRuntimeFonts/);
    assert.match(runtimeAsset.body.toString('utf8'), /ensureRuntimeFontSources/);
    assert.match(runtimeAsset.body.toString('utf8'), /normalizeStarterConfigBindings/);
    assert.match(runtimeAsset.body.toString('utf8'), /createCellTemplateRenderer/);
    assert.match(runtimeAsset.body.toString('utf8'), /createDevPreviewController/);
    assert.match(runtimeAsset.body.toString('utf8'), /backgroundImage/);
    assert.match(runtimeAsset.body.toString('utf8'), /valueClass/);
    assert.match(runtimeAsset.body.toString('utf8'), /data-kh-kind/);
    assert.match(builtinIndex.body.toString('utf8'), /__KOMEHUB_TEMPLATE_RUNTIME_CONFIG/);
    assert.match(builtinIndex.body.toString('utf8'), /"templateKind":"builtin"/);
    assert.match(builtinIndex.body.toString('utf8'), /"resetOnVisible":true/);
    assert.match(builtinIndex.body.toString('utf8'), /"fonts":\["Noto Sans JP"\]/);
    assert.match(builtinIndex.body.toString('utf8'), /"fontSources":\[\]/);
    assert.match(builtinIndex.body.toString('utf8'), /\/templates\/__runtime\/runtime\.js\?v=/);
    assert.match(oneCommeIndex.body.toString('utf8'), /"templateKind":"onecomme"/);
    assert.match(oneCommeIndex.body.toString('utf8'), /"resetOnVisible":true/);
    assert.match(oneCommeIndex.body.toString('utf8'), /legacy onecomme/);
  });

  it('remote ponout routes expose the shared window shell and HTTP adapter', async function () {
    var html = await httpBuffer('/remote/ponout/');
    var css = await httpBuffer('/remote/ponout.css');
    var adapter = await httpBuffer('/remote/ponout-remote-api.js');
    var script = await httpBuffer('/remote/ponout.js');

    assert.equal(html.statusCode, 200);
    assert.equal(css.statusCode, 200);
    assert.equal(adapter.statusCode, 200);
    assert.equal(script.statusCode, 200);
    assert.match(html.body.toString('utf8'), /ポン出し/);
    assert.match(html.body.toString('utf8'), /ponout-remote-api\.js/);
    assert.match(adapter.body.toString('utf8'), /window\.api/);
    assert.match(adapter.body.toString('utf8'), /\/api\/tts\/state/);
    assert.match(script.body.toString('utf8'), /triggerManual/);
  });

  it('remote viewing routes serve home shell + shared modules', async function () {
    // Phase 5 で codex 旧実装 (/remote/view*) を破棄し、新 shell に書き換えた。
    // ホームは /remote/, スタイル/共通 JS は /remote/style.css /remote/common.js,
    // shared モジュールは /remote/shared/{file} で配信される。
    var home = await httpBuffer('/remote/');
    var style = await httpBuffer('/remote/style.css');
    var common = await httpBuffer('/remote/common.js');
    var sharedSanitize = await httpBuffer('/remote/shared/comment-sanitize.js');
    var sharedSnack = await httpBuffer('/remote/shared/undo-snackbar.js');
    var sharedCss = await httpBuffer('/remote/shared/shared.css');

    assert.equal(home.statusCode, 200, 'home /remote/');
    assert.equal(style.statusCode, 200, 'remote style.css');
    assert.equal(common.statusCode, 200, 'remote common.js');
    assert.equal(sharedSanitize.statusCode, 200, 'shared comment-sanitize.js');
    assert.equal(sharedSnack.statusCode, 200, 'shared undo-snackbar.js');
    assert.equal(sharedCss.statusCode, 200, 'shared shared.css');

    var html = home.body.toString('utf8');
    assert.match(html, /こめはぶ Remote/);
    // SPA bottom tab bar の 4 リンク (= 2026-05-14、 X-4 でポン出しタブは撤去)
    assert.match(html, /\/remote\/comments/);
    assert.match(html, /\/remote\/gifts/);
    assert.match(html, /\/remote\/listeners/);
    assert.match(common.body.toString('utf8'), /KomehubRemote/);

    // 旧 codex 実装の /remote/view* は完全に消えている (= 404)
    var oldView = await httpBuffer('/remote/view');
    assert.equal(oldView.statusCode, 404, '/remote/view should be removed');

    // shared/ の許可リスト外は 404
    var unknownShared = await httpBuffer('/remote/shared/non-existent.js');
    assert.equal(unknownShared.statusCode, 404);
  });

  it('remote ponout HTTP APIs cover pause, clear, and TTS operations', async function () {
    var sceneId = uniqueId('remote-ponout-api-scene');

    try {
      await m.createScene(sceneId, 'Remote Ponout API Scene');

      var pauseResult = await httpJsonRequest('POST', '/api/paused', { paused: true });
      assert.equal(pauseResult.statusCode, 200);
      assert.equal(pauseResult.body, true);

      var paused = await httpJson('/api/paused');
      assert.equal(paused.statusCode, 200);
      assert.equal(paused.body, true);

      var clearResult = await httpJsonRequest('POST', '/api/scenes/' + sceneId + '/performances/clear', {});
      assert.equal(clearResult.statusCode, 200);
      assert.equal(clearResult.body.ok, true);

      var ttsState = await httpJson('/api/tts/state');
      assert.equal(ttsState.statusCode, 200);
      assert.ok(ttsState.body && typeof ttsState.body === 'object');
      assert.equal(ttsState.body.paused, false);

      // paused=true: TTS_RUNTIME 未初期化 (= まだコメが来ていない) でも paused が立つことを確認。
      // (旧実装は runtime.paused.load 経由で AtomicBool が lazy init 後でないと反映されないバグ
      // があった。 static TTS_PAUSED 化でこの assertion が成立する。)
      var ttsPausedOn = await httpJsonRequest('POST', '/api/tts/paused', { paused: true });
      assert.equal(ttsPausedOn.statusCode, 200);
      assert.equal(ttsPausedOn.body.paused, true);

      // paused=false に戻せる
      var ttsPausedOff = await httpJsonRequest('POST', '/api/tts/paused', { paused: false });
      assert.equal(ttsPausedOff.statusCode, 200);
      assert.equal(ttsPausedOff.body.paused, false);

      // 再度 paused=true にしてから enabled=false → paused が自動 reset される
      // (= 2026-05-17 7214e49: 「OFF 状態の一時停止」 を排除する新仕様)。
      await httpJsonRequest('POST', '/api/tts/paused', { paused: true });
      var ttsEnabled = await httpJsonRequest('POST', '/api/tts/enabled', { enabled: false });
      assert.equal(ttsEnabled.statusCode, 200);
      assert.equal(ttsEnabled.body.enabled, false);
      assert.equal(ttsEnabled.body.paused, false);

      var ttsClear = await httpJsonRequest('POST', '/api/tts/clear', {});
      assert.equal(ttsClear.statusCode, 200);
      assert.ok(ttsClear.body && typeof ttsClear.body === 'object');
    } finally {
      await httpJsonRequest('POST', '/api/paused', { paused: false });
      await m.deleteScene(sceneId);
    }
  });

  it('detects OneComme templates even when OneSDK usage lives in script files', async function () {
    var storageName = 'tmpl-script-detected-onecomme';
    var templateDir = path.join(TEST_DATA_DIR, 'templates', storageName);
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, 'index.html'),
      '<!doctype html><html><head><script src="./app.js"></script></head><body>script detected onecomme</body></html>'
    );
    fs.writeFileSync(path.join(templateDir, 'app.js'), 'window.addEventListener("load", function () { OneSDK.connect(); });');

    var templates = JSON.parse(await m.getTemplates());
    var detected = templates.find(function (item) { return item && item.storageName === storageName; });

    assert.ok(detected, 'script-only fixture is listed');
    assert.equal(detected.templateType, 'oneComme');
    assert.match(detected.id, /^com\.comment-hub\.template\.onecomme\./);
  });

  it('rewrites vue.min.js to vue2.min.js for legacy OneComme templates', async function () {
    var storageName = 'tmpl-onecomme-vue2-rewrite';
    var sceneId = uniqueId('onecomme-vue2-scene');
    var templateDir = path.join(TEST_DATA_DIR, 'templates', storageName);

    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, 'index.html'),
      [
        '<!doctype html>',
        '<html>',
        '<head>',
        '  <script src="../__origin/js/onesdk.js"></script>',
        '  <script src="../__origin/js/vue.min.js"></script>',
        '</head>',
        '<body>',
        '  <div id="app"></div>',
        '  <script src="./script.js"></script>',
        '</body>',
        '</html>'
      ].join('\n')
    );
    fs.writeFileSync(path.join(templateDir, 'script.js'), 'new Vue({ el: "#app" }); OneSDK.connect();');

    try {
      await m.createScene(sceneId, 'OneComme Vue2 Rewrite Scene');
      var templates = JSON.parse(await m.getTemplates());
      var detected = templates.find(function (item) { return item && item.storageName === storageName; });
      assert.ok(detected, 'vue2 fixture is listed');
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, detected.id)).ok, true);

      var response = await httpBuffer('/templates/' + sceneId + '/one/1/');
      var html = response.body.toString('utf8');

      assert.equal(response.statusCode, 200);
      assert.match(html, /vue2\.min\.js/);
      assert.doesNotMatch(html, /vue\.min\.js(?![^]*vue2\.min\.js)/);
    } finally {
      try { await m.deleteScene(sceneId); } catch (e) {}
    }
  });

  it('serves newly supported OneComme __origin assets', async function () {
    var paths = [
      '/templates/legacy-template-scene/one/__origin/css/animation/blur.css',
      '/templates/legacy-template-scene/one/__origin/css/animation/flip-x.css',
      '/templates/legacy-template-scene/one/__origin/css/animation/flip-y.css',
      '/templates/legacy-template-scene/one/__origin/css/animation/nomove.css',
      '/templates/legacy-template-scene/one/__origin/css/animation/purun.css',
      '/templates/legacy-template-scene/one/__origin/css/animation/scale-in.css',
      '/templates/legacy-template-scene/one/__origin/css/ext/fadeOut.css',
      '/templates/legacy-template-scene/one/__origin/css/ext/hide.css',
      '/templates/legacy-template-scene/one/__origin/css/ext/marquee.css',
      '/templates/legacy-template-scene/one/__origin/js/html-escaper.min.js',
      '/templates/legacy-template-scene/one/__origin/js/one-marquee.js',
      '/templates/legacy-template-scene/one/__origin/js/onesdk.legacy.js'
    ];

    for (var i = 0; i < paths.length; i += 1) {
      var response = await httpBuffer(paths[i]);
      assert.equal(response.statusCode, 200, paths[i] + ' is served');
    }
  });

  it('starter samples and built-in templates use starter APIs', function () {
    var listSample = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-list-basic', 'script.js'), 'utf8');
    var htmlFirstListSample = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-list-html-first', 'script.js'), 'utf8');
    var tickerSample = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-ticker-basic', 'script.js'), 'utf8');
    var customSample = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-custom-basic', 'script.js'), 'utf8');
    var listIndex = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-list-basic', 'index.html'), 'utf8');
    var tickerIndex = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-ticker-basic', 'index.html'), 'utf8');
    var htmlFirstListIndex = fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'template-list-html-first', 'index.html'), 'utf8');
    var chatListScript = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', 'chat-cute', 'script.js'), 'utf8');
    var standardRenderlessScript = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', 'standard-renderless', 'script.js'), 'utf8');
    var builtins = [
      ['chat-cute', 'list'],
      ['chat-wafuu', 'list'],
      ['game-compact', 'list'],
      ['game-fps', 'list'],
      ['game-rainbow', 'list'],
      ['singing-text', 'list']
    ];

    assert.match(listSample, /config:\s*\{/);
    assert.match(tickerSample, /config:\s*\{/);
    assert.match(customSample, /config:\s*\{/);
    assert.match(listSample, /cellTemplate:\s*'#comment-template'/);
    assert.match(tickerSample, /renderlessModel:\s*true/);
    assert.match(tickerIndex, /data-kh-template="#comment-template"/);
    assert.doesNotMatch(tickerSample, /renderComment\s*:/);
    assert.match(listSample, /createDevPreviewController/);
    assert.match(listSample, /preview=1&devPreview=1|devPreviewScenarios/);
    assert.ok(!/renderComment\s*:/.test(listSample), 'list sample no longer needs renderComment');
    assert.match(htmlFirstListSample, /htmlFirst\.start/);
    assert.match(htmlFirstListSample, /lifecycle:\s*\{/);
    assert.match(htmlFirstListSample, /enterActiveDelayMs/);
    assert.match(htmlFirstListSample, /leaveRemoveDelayMs/);
    assert.match(htmlFirstListSample, /beforeCommitComment/);
    assert.match(htmlFirstListSample, /assignThemeKey/);
    assert.match(listIndex, /<template id="comment-template">/);
    assert.match(listIndex, /data-kh="avatar"/);
    assert.match(listIndex, /data-kh="text"/);
    assert.match(htmlFirstListIndex, /data-kh-start="list"/);
    assert.match(htmlFirstListIndex, /type="application\/json"/);
    assert.match(htmlFirstListIndex, /data-kh-empty="hide"/);
    assert.match(htmlFirstListIndex, /data-kh="display\.prefix"/);
    assert.match(htmlFirstListIndex, /data-kh="display\.html"/);
    assert.ok(!/configBindings\s*:/.test(listSample), 'list sample avoids verbose configBindings');
    assert.ok(!/configBindings\s*:/.test(tickerSample), 'ticker sample avoids verbose configBindings');
    assert.ok(!/configBindings\s*:/.test(customSample), 'custom sample avoids verbose configBindings');
    assert.match(chatListScript, /runtime\.starters\.list\(/);
    assert.match(chatListScript, /cellTemplate:\s*ensureCommentTemplate\('comment-template'\)/);
    assert.match(chatListScript, /nameSize:\s*\['--name-size', 'em'\]/);
    assert.match(chatListScript, /nameFont:\s*'--name-font-family'/);
    assert.match(chatListScript, /textFont:\s*'--text-font-family'/);
    assert.match(chatListScript, /backgroundImages:\s*\{/);
    assert.match(chatListScript, /data-kh="name"/);
    assert.match(chatListScript, /data-kh="text"/);
    assert.ok(!/loadFont\(/.test(chatListScript), 'chat list built-in should rely on runtime font loading');
    // onConfig (= per-template 上位フック) は不要なので、これが無いことを確認する。
    assert.ok(!/onConfig\s*:/.test(chatListScript), 'chat list built-in should not need onConfig');
    assert.match(standardRenderlessScript, /htmlFirst\.start\(/, 'standard-renderless should use htmlFirst starter');
    assert.match(standardRenderlessScript, /beforeCommitComment/, 'standard-renderless should bind through beforeCommitComment');

    builtins.forEach(function (entry) {
      var script = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', entry[0], 'script.js'), 'utf8');
      var style = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', entry[0], 'style.css'), 'utf8');
      assert.match(script, new RegExp('runtime\\.starters\\.' + entry[1] + '\\('), entry[0] + ' should use starters.' + entry[1]);
      assert.match(script, /nameFont:\s*'--name-font-family'/, entry[0] + ' should expose name font config');
      assert.match(script, /textFont:\s*'--text-font-family'/, entry[0] + ' should expose text font config');
      assert.match(style, /font-family:\s*var\(--name-font-family,\s*inherit\)/, entry[0] + ' should apply name font variable');
      assert.match(style, /font-family:\s*var\(--text-font-family,\s*inherit\)/, entry[0] + ' should apply text font variable');
      assert.ok(!/loadFont\(/.test(script), entry[0] + ' should rely on runtime font loading');
      assert.ok(!/createListController\(/.test(script), entry[0] + ' should not wire list controllers directly');
      assert.ok(!/runtime\.register\(/.test(script), entry[0] + ' should not register manually');
    });

    var rainbowScript = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', 'game-rainbow', 'script.js'), 'utf8');
    var tickerRenderlessScript = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', 'ticker-renderless', 'script.js'), 'utf8');
    assert.match(rainbowScript, /afterRenderComment\s*:/);
    assert.match(tickerRenderlessScript, /mode:\s*'ticker'/);
    assert.match(tickerRenderlessScript, /renderlessModel:\s*true/);
    assert.match(tickerRenderlessScript, /transitionTiming:\s*'cubic-bezier\(0\.12, 0, 0, 1\)'/);
    assert.match(tickerRenderlessScript, /runtime\.config\.setPxVar\(helpers\.container, 'bottom', value\)/);
  });

  it('createTemplateFromStarter creates a custom scaffold and returns its directory', async function () {
    var templateId = 'com.comment-hub.template.dev.list-check';
    var createResult = JSON.parse(await m.createTemplateFromStarter('list', templateId, 'List Dev Check'));
    assert.equal(createResult.ok, true);
    assert.equal(createResult.template.id, templateId);
    assert.equal(createResult.template.displayName, 'List Dev Check');
    assert.equal(createResult.template.builtin, false);

    var dirResult = JSON.parse(await m.getTemplateDirectory(templateId));
    assert.equal(typeof dirResult.path, 'string');
    assert.equal(fs.existsSync(path.join(dirResult.path, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(dirResult.path, 'index.html')), true);
    assert.equal(fs.existsSync(path.join(dirResult.path, 'style.css')), true);
    assert.equal(fs.existsSync(path.join(dirResult.path, 'script.js')), true);

    var manifest = JSON.parse(fs.readFileSync(path.join(dirResult.path, 'manifest.json'), 'utf8'));
    var indexHtml = fs.readFileSync(path.join(dirResult.path, 'index.html'), 'utf8');
    var scriptJs = fs.readFileSync(path.join(dirResult.path, 'script.js'), 'utf8');
    assert.equal(manifest.id, templateId);
    assert.equal(manifest.displayName, 'List Dev Check');
    assert.equal(manifest.name, 'list-check');
    assert.match(indexHtml, /<template id="comment-template">/);
    assert.match(scriptJs, /createDevPreviewController/);

    var templates = JSON.parse(await m.getTemplates());
    assert.ok(templates.some(function (item) {
      return item && item.id === templateId && item.builtin === false;
    }));

    var removeResult = JSON.parse(await m.removeTemplate(templateId));
    assert.equal(removeResult.ok, true);
  });

  it('createTemplateFromBuiltin clones a built-in template into custom storage', async function () {
    var templateId = uniqueId('com.comment-hub.template.standard-renderless.dev-copy');

    try {
      var createResult = JSON.parse(await m.createTemplateFromBuiltin(CHAT_LIST_ID, templateId, 'Standard Dev Copy'));
      assert.equal(createResult.ok, true);
      assert.equal(createResult.template.id, templateId);
      assert.equal(createResult.template.displayName, 'Standard Dev Copy');
      assert.equal(createResult.template.builtin, false);
      assert.equal(createResult.template.templateType, 'custom');

      var dirResult = JSON.parse(await m.getTemplateDirectory(templateId));
      assert.equal(typeof dirResult.path, 'string');
      assert.equal(fs.existsSync(path.join(dirResult.path, 'manifest.json')), true);
      assert.equal(fs.existsSync(path.join(dirResult.path, 'index.html')), true);
      assert.equal(fs.existsSync(path.join(dirResult.path, 'style.css')), true);
      assert.equal(fs.existsSync(path.join(dirResult.path, 'script.js')), true);

      var manifest = JSON.parse(fs.readFileSync(path.join(dirResult.path, 'manifest.json'), 'utf8'));
      var copiedIndexHtml = fs.readFileSync(path.join(dirResult.path, 'index.html'), 'utf8');
      var builtinIndexHtml = fs.readFileSync(path.join(__dirname, '..', 'effects-overlay', 'templates', 'standard-renderless', 'index.html'), 'utf8');
      assert.equal(manifest.id, templateId);
      assert.equal(manifest.displayName, 'Standard Dev Copy');
      assert.equal(manifest.name, templateId.split('.').pop());
      assert.equal(copiedIndexHtml, builtinIndexHtml);

      var templates = JSON.parse(await m.getTemplates());
      assert.ok(templates.some(function (item) {
        return item && item.id === templateId && item.builtin === false;
      }));
    } finally {
      try { await m.removeTemplate(templateId); } catch (_err) {}
    }
  });

  it('importTemplateBundledFont imports font files from zip into a custom template', async function () {
    var templateId = uniqueId('com.comment-hub.template.font-import');
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'komehub-font-import-'));
    var zipPath = path.join(tempDir, 'riimnkt.zip');
    var zip = new AdmZip();
    zip.addFile('riimnkt/Riimin-Regular.otf', Buffer.from('regular-font'));
    zip.addFile('riimnkt/Riimin-BoldItalic.otf', Buffer.from('bold-italic-font'));
    zip.addFile('riimnkt/readme.txt', Buffer.from('ignore me'));
    zip.writeZip(zipPath);

    try {
      var createResult = JSON.parse(await m.createTemplateFromStarter('list', templateId, 'Font Import Test'));
      assert.equal(createResult.ok, true);

      var importResult = JSON.parse(await m.importTemplateBundledFont(templateId, zipPath, ''));
      assert.equal(importResult.ok, true);
      assert.equal(importResult.imports.length, 1);
      assert.equal(importResult.imports[0].family, 'riimnkt');
      assert.equal(importResult.imports[0].cssPath, importResult.imports[0].fontSource.css);
      assert.equal(importResult.imports[0].fontSource.family, 'riimnkt');
      assert.equal(importResult.imports[0].fontSource.type, 'assetCss');
      assert.equal(importResult.imports[0].importedFiles.length, 2);

      var dirResult = JSON.parse(await m.getTemplateDirectory(templateId));
      assert.ok(dirResult.path, 'template directory exists');

      var cssPath = path.join(dirResult.path, importResult.imports[0].cssPath);
      assert.ok(fs.existsSync(cssPath), 'generated css file exists');
      var css = fs.readFileSync(cssPath, 'utf8');
      assert.match(css, /font-family: 'riimnkt'/);
      assert.match(css, /font-weight: 400/);
      assert.match(css, /font-weight: 700/);
      assert.match(css, /font-style: italic/);
      importResult.imports[0].importedFiles.forEach(function (relativePath) {
        assert.ok(fs.existsSync(path.join(dirResult.path, relativePath)), 'imported font file exists: ' + relativePath);
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      try {
        await m.removeTemplate(templateId);
      } catch (_error) {}
    }
  });

  it('saveTemplateManifest persists custom manifest edits and renames scene references', async function () {
    var templateId = uniqueId('com.comment-hub.template.manifest-editor');
    var renamedTemplateId = templateId + '.renamed';
    var sceneId = uniqueId('manifest-editor-scene');

    try {
      var createResult = JSON.parse(await m.createTemplateFromStarter('list', templateId, 'Manifest Editor Base'));
      assert.equal(createResult.ok, true);

      var originalDirResult = JSON.parse(await m.getTemplateDirectory(templateId));
      assert.equal(typeof originalDirResult.path, 'string');

      assert.ok(JSON.parse(await m.createScene(sceneId, 'Manifest Editor Scene')));
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, templateId)).ok, true);
      assert.equal(JSON.parse(await m.setSelectedSceneTemplate(sceneId, templateId)).ok, true);

      var manifestResult = JSON.parse(await m.getTemplateManifest(templateId));
      assert.ok(manifestResult && manifestResult.manifest, 'getTemplateManifest returned manifest');

      var manifest = manifestResult.manifest;
      manifest.id = renamedTemplateId;
      manifest.name = 'manifest-editor-renamed';
      manifest.displayName = 'Manifest Editor Renamed';
      manifest.version = '1.2.3';
      manifest.obsHint = 'OBS幅 800px 推奨 / 高さ 320px 前後';
      manifest.fonts = ['Noto Sans JP', 'M PLUS Rounded 1c'];
      manifest.fontSources = [{
        family: 'Remote Example Font',
        type: 'remoteCss',
        url: 'https://cdn.example.com/fonts/remote-font.css'
      }];
      manifest.exportPolicy = {
        allowTemplateExport: false,
        note: 'Bundled resources require manual license review.'
      };
      manifest.customUnknown = { keep: true };
      manifest.uiSchema[0].customHint = 'preserve-me';
      manifest.uiSchema.push({
        key: 'accentColor',
        type: 'color',
        label: 'アクセント色',
        default: '#ff00aa',
        customKey: 'custom-value'
      });

      var saveResult = JSON.parse(await m.saveTemplateManifest(templateId, JSON.stringify(manifest)));
      assert.equal(saveResult.ok, true);
      assert.equal(saveResult.previousTemplateId, templateId);
      assert.equal(saveResult.templateId, renamedTemplateId);
      assert.equal(saveResult.displayName, 'Manifest Editor Renamed');
      assert.equal(saveResult.manifest.customUnknown.keep, true);
      assert.equal(saveResult.manifest.uiSchema[0].customHint, 'preserve-me');

      var renamedDirResult = JSON.parse(await m.getTemplateDirectory(renamedTemplateId));
      assert.equal(renamedDirResult.path, originalDirResult.path, 'template directory remains stable after rename');

      var savedManifest = JSON.parse(fs.readFileSync(path.join(originalDirResult.path, 'manifest.json'), 'utf8'));
      assert.equal(savedManifest.id, renamedTemplateId);
      assert.equal(savedManifest.displayName, 'Manifest Editor Renamed');
      assert.equal(savedManifest.customUnknown.keep, true);
      assert.equal(savedManifest.uiSchema[0].customHint, 'preserve-me');
      assert.ok(savedManifest.uiSchema.some(function (item) {
        return item && item.key === 'accentColor' && item.customKey === 'custom-value';
      }));

      var templates = JSON.parse(await m.getTemplates());
      assert.ok(templates.some(function (item) { return item && item.id === renamedTemplateId; }));
      assert.ok(!templates.some(function (item) { return item && item.id === templateId; }));

      var sceneTemplates = JSON.parse(await m.getSceneTemplates(sceneId));
      assert.equal(sceneTemplates.selectedTemplateId, renamedTemplateId);
      assert.ok((sceneTemplates.sceneTemplates || []).some(function (item) {
        return item && item.id === renamedTemplateId && item.name === renamedTemplateId;
      }));
    } finally {
      try { await m.removeSceneTemplate(sceneId, renamedTemplateId); } catch (_err) {}
      try { await m.deleteScene(sceneId); } catch (_err) {}
      try { await m.removeTemplate(renamedTemplateId); } catch (_err) {}
      try { await m.removeTemplate(templateId); } catch (_err) {}
    }
  });

  it('template development flow wiring is present in electron bridge files', function () {
    var renderer = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'renderer.js'), 'utf8');
    var preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    var main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

    assert.match(renderer, /新規テンプレートを作成/);
    assert.match(renderer, /createTemplateFromStarter/);
    assert.match(renderer, /createTemplateFromBuiltin/);
    assert.match(renderer, /openTemplateCreateWizardFromBuiltin/);
    assert.match(renderer, /この built-in を元に custom テンプレートを新規作成します/);
    assert.match(renderer, /openTemplateFolder/);
    assert.match(renderer, /openTemplateFontEditor/);
    assert.match(renderer, /openTemplateBasicInfoEditor/);
    assert.match(renderer, /openTemplateSchemaEditor/);
    assert.match(renderer, /編集メニュー/);
    assert.match(renderer, /まずは HTML\/CSS から/);
    assert.match(renderer, /テンプレ構造とメタ情報/);
    assert.match(renderer, /基本情報/);
    assert.match(renderer, /設定項目/);
    assert.match(renderer, /現在の設定/);
    assert.match(renderer, /フォント設定を保存/);
    assert.match(renderer, /名前のフォント/);
    assert.match(renderer, /コメントのフォント/);
    assert.match(renderer, /type === 'font'/);
    assert.match(renderer, /manifest\.fonts と fontSources\.family から自動/);
    assert.match(renderer, /Google Fonts 系のプリセットだけ選べます/);
    assert.match(renderer, /任意フォントは下の fontSources を使います/);
    assert.match(renderer, /同梱フォントを取り込む/);
    assert.match(renderer, /family ごとに CSS を生成します/);
    assert.match(renderer, /chooseTemplateFontImport/);
    assert.match(renderer, /importTemplateBundledFont/);
    assert.match(renderer, /openTemplateManifestEditor/);
    assert.match(renderer, /manifest を編集/);
    assert.match(renderer, /開発を開く/);
    assert.match(renderer, /複製して開発/);
    assert.match(renderer, /生成後の最短コース/);
    assert.match(renderer, /触る順番の目安/);
    assert.match(renderer, /1\. index\.html/);
    assert.match(renderer, /4\. manifest\.json/);
    assert.match(renderer, /\?preview=1&devPreview=1/);
    assert.match(renderer, /既存のテストコメント機能/);
    assert.match(preload, /create-template-from-starter/);
    assert.match(preload, /create-template-from-builtin/);
    assert.match(preload, /open-template-folder/);
    assert.match(preload, /choose-template-font-import/);
    assert.match(preload, /import-template-bundled-font/);
    assert.match(preload, /get-template-manifest/);
    assert.match(preload, /save-template-manifest/);
    assert.match(main, /create-template-from-starter/);
    assert.match(main, /create-template-from-builtin/);
    assert.match(main, /open-template-folder/);
    assert.match(main, /choose-template-font-import/);
    assert.match(main, /import-template-bundled-font/);
    assert.match(main, /get-template-manifest/);
    assert.match(main, /save-template-manifest/);
  });

  it('template runtime config injects fontSources and serves bundled font assets', async function () {
    var fixture = createTemplateFontFixture();

    try {
      var runtimeAsset = await httpBuffer('/templates/__runtime/runtime.js');
      var index = await httpBuffer('/templates/test-scene-1/comehub/' + fixture.templateId + '/');
      var bundledCss = await httpBuffer('/templates/test-scene-1/comehub/' + fixture.templateId + '/fonts/bundled-font.css');
      var bundledFont = await httpBuffer('/templates/test-scene-1/comehub/' + fixture.templateId + '/fonts/BundledExampleFont.woff2');

      assert.equal(runtimeAsset.statusCode, 200);
      assert.equal(index.statusCode, 200);
      assert.equal(bundledCss.statusCode, 200);
      assert.equal(bundledFont.statusCode, 200);
      assert.match(runtimeAsset.body.toString('utf8'), /resolveFontSourceHref/);
      assert.match(runtimeAsset.body.toString('utf8'), /remoteCss/);
      assert.match(runtimeAsset.body.toString('utf8'), /assetCss/);
      assert.match(runtimeAsset.body.toString('utf8'), /--name-font-family/);
      assert.match(runtimeAsset.body.toString('utf8'), /font-compat/);
      assert.match(runtimeAsset.body.toString('utf8'), /getResourceDebugInfo/);
      assert.match(runtimeAsset.body.toString('utf8'), /リソース情報/);
      assert.match(runtimeAsset.body.toString('utf8'), /afterRenderComment/);
      assert.match(runtimeAsset.body.toString('utf8'), /data-kh-empty/);
      assert.match(runtimeAsset.body.toString('utf8'), /beforeCommitComment/);
      assert.match(runtimeAsset.body.toString('utf8'), /data-kh-phase/);
      assert.match(runtimeAsset.body.toString('utf8'), /assignThemeKey/);
      assert.match(runtimeAsset.body.toString('utf8'), /themeAssets/);
      assert.match(runtimeAsset.body.toString('utf8'), /enterActiveDelayMs/);
      assert.match(runtimeAsset.body.toString('utf8'), /leaveRemoveDelayMs/);
      assert.match(runtimeAsset.body.toString('utf8'), /htmlFirst/);
      assert.match(runtimeAsset.body.toString('utf8'), /transitionTiming/);
      var indexBody = index.body.toString('utf8');
      assert.match(indexBody, /"fontSources":\[/);
      assert.match(indexBody, /"resourceDebug":\{/);
      assert.match(indexBody, /"servedAtUnixMs":/);
      assert.match(indexBody, /"style\.css"/);
      assert.match(indexBody, /"script\.js"/);
      assert.match(indexBody, /"family":"Bundled Example Font"/);
      assert.match(indexBody, /"type":"assetCss"/);
      assert.match(indexBody, /"css":"fonts\/bundled-font\.css"/);
      assert.match(indexBody, /"family":"Remote Example Font"/);
      assert.match(indexBody, /"type":"remoteCss"/);
      assert.match(indexBody, /"url":"https:\/\/cdn\.example\.com\/fonts\/remote-font\.css"/);
      assert.equal(bundledCss.body.toString('utf8').includes('Bundled Example Font'), true);
      assert.equal(bundledFont.body.toString('utf8'), 'bundled-font-data');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('exportTemplate rejects assetCss templates when exportPolicy disables redistribution', async function () {
    var fixture = createTemplateFontFixture({
      exportPolicy: {
        allowTemplateExport: false,
        note: 'Bundled commercial font is not redistributable.'
      }
    });
    var exportPath = path.join(TEST_DATA_DIR, 'exported-template-fonts-denied.zip');

    try {
      var exportResult = JSON.parse(await m.exportTemplate(
        fixture.templateId,
        'Denied Font Template',
        'test-scene-1',
        JSON.stringify({}),
        exportPath
      ));

      assert.equal(typeof exportResult.error, 'string');
      assert.match(exportResult.error, /テンプレート作者の設定によりエクスポートできません/);
      assert.match(exportResult.error, /Bundled commercial font is not redistributable\./);
      assert.ok(!fs.existsSync(exportPath), 'zip is not created when export is denied');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
      fs.rmSync(exportPath, { force: true });
    }
  });

  it('exportTemplate rejects assetCss templates when exportPolicy is missing', async function () {
    var fixture = createTemplateFontFixture();
    var exportPath = path.join(TEST_DATA_DIR, 'exported-template-fonts-missing-policy.zip');

    try {
      var exportResult = JSON.parse(await m.exportTemplate(
        fixture.templateId,
        'Missing Policy Font Template',
        'test-scene-1',
        JSON.stringify({}),
        exportPath
      ));

      assert.equal(typeof exportResult.error, 'string');
      assert.match(exportResult.error, /assetCss を使っています/);
      assert.match(exportResult.error, /allowTemplateExport/);
      assert.ok(!fs.existsSync(exportPath), 'zip is not created when export policy is missing');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
      fs.rmSync(exportPath, { force: true });
    }
  });

  it('legacy templateId routes are removed', async function () {
    var legacyBuiltin = await httpBuffer('/templates/legacy-template-scene/' + CHAT_LIST_ID + '/');
    var templates = JSON.parse(await m.getTemplates());
    var legacyOneComme = templates.find(function (item) { return item && item.storageName === LEGACY_ONECOMME_STORAGE; });
    var legacyCustom = templates.find(function (item) { return item && item.storageName === LEGACY_CUSTOM_STORAGE; });
    var legacyOneCommeResponse = await httpBuffer('/templates/legacy-template-scene/' + legacyOneComme.id + '/');
    var legacyCustomResponse = await httpBuffer('/templates/legacy-template-scene/' + legacyCustom.id + '/');

    assert.equal(legacyBuiltin.statusCode, 404);
    assert.equal(legacyOneCommeResponse.statusCode, 404);
    assert.equal(legacyCustomResponse.statusCode, 404);
  });

  it('selected template fixed route follows the current selection', async function () {
    var sceneId = uniqueId('selected-template-route-scene');

    try {
      await m.createScene(sceneId, 'Selected Template Route Scene');
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_CUTE_ID)).ok, true);

      var wrapper = await httpBuffer('/templates/' + sceneId + '/selected/');
      assert.equal(wrapper.statusCode, 200);
      assert.match(wrapper.body.toString('utf8'), /template-frame/);

      var selectedMeta = await httpJson('/templates/' + sceneId + '/selected/meta');
      assert.equal(selectedMeta.statusCode, 200);
      assert.equal(selectedMeta.body.templateId, CHAT_LIST_ID);
      assert.equal(selectedMeta.body.route, '/templates/' + sceneId + '/built-in/standard-renderless/');

      assert.equal(JSON.parse(await m.setSelectedSceneTemplate(sceneId, CHAT_CUTE_ID)).ok, true);

      selectedMeta = await httpJson('/templates/' + sceneId + '/selected/meta');
      assert.equal(selectedMeta.statusCode, 200);
      assert.equal(selectedMeta.body.templateId, CHAT_CUTE_ID);
      assert.equal(selectedMeta.body.route, '/templates/' + sceneId + '/built-in/chat-cute/');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('template stream replays recent comments on first connect', async function () {
    var sceneId = uniqueId('template-replay-scene');
    var commentId = uniqueId('template-replay-comment');

    try {
      await m.createScene(sceneId, 'Template Replay Scene');
      m.setActiveScene(sceneId);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);

      m.pushComments(JSON.stringify([{
        id: commentId,
        name: '@replay-user',
        comment: 'template replay comment',
        commentHtml: 'template replay comment',
        profileImage: '',
        timestamp: '12:34',
        hasGift: false,
        amount: 0,
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
        isVerified: false
      }]));

      await new Promise(function (resolve) { setTimeout(resolve, 50); });

      var events = await httpSseEvents('/templates/' + sceneId + '/built-in/standard-renderless/stream', 2, 4000);
      assert.equal(events[0].type, 'config');
      assert.equal(events[1].type, 'comments');
      assert.ok(Array.isArray(events[1].data), 'comments payload is an array');
      assert.ok(events[1].data.some(function (item) {
        return item && item.id === commentId;
      }), 'recent comments replay contains the latest comment');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('template stream replay count follows maxComments instead of fixed 20', async function () {
    var sceneId = uniqueId('template-replay-limit-scene');
    var totalComments = 25;

    try {
      await m.createScene(sceneId, 'Template Replay Limit Scene');
      m.setActiveScene(sceneId);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);
      assert.equal(JSON.parse(await m.setSceneTemplateConfig(sceneId, CHAT_LIST_ID, JSON.stringify({
        maxComments: totalComments
      }))).ok, true);

      var payload = [];
      for (var i = 0; i < totalComments; i++) {
        payload.push({
          id: uniqueId('template-replay-limit-comment'),
          name: '@limit-user-' + i,
          comment: 'template replay limit comment ' + i,
          commentHtml: 'template replay limit comment ' + i,
          profileImage: '',
          timestamp: '12:34',
          hasGift: false,
          amount: 0,
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
          isVerified: false
        });
      }
      m.pushComments(JSON.stringify(payload));

      await new Promise(function (resolve) { setTimeout(resolve, 50); });

      var events = await httpSseEvents('/templates/' + sceneId + '/built-in/standard-renderless/stream', 2, 4000);
      assert.equal(events[0].type, 'config');
      assert.equal(events[1].type, 'comments');
      assert.ok(Array.isArray(events[1].data), 'comments payload is an array');
      assert.equal(events[1].data.length, totalComments, 'replay count follows maxComments');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('template replay excludes comments deleted after arrival', async function () {
    var sceneId = uniqueId('template-replay-delete-scene');
    var deletedId = uniqueId('template-deleted-comment');
    var keptId = uniqueId('template-kept-comment');

    try {
      await m.createScene(sceneId, 'Template Replay Delete Scene');
      m.setActiveScene(sceneId);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);

      m.pushComments(JSON.stringify([
        {
          id: deletedId,
          name: '@delete-user',
          comment: 'deleted comment',
          commentHtml: 'deleted comment',
          profileImage: '',
          timestamp: '12:34',
          hasGift: false,
          amount: 0,
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
          isVerified: false
        },
        {
          id: keptId,
          name: '@keep-user',
          comment: 'kept comment',
          commentHtml: 'kept comment',
          profileImage: '',
          timestamp: '12:35',
          hasGift: false,
          amount: 0,
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
          isVerified: false
        }
      ]));
      await new Promise(function (resolve) { setTimeout(resolve, 30); });
      m.pushCommentDeleted(JSON.stringify([deletedId]));
      await new Promise(function (resolve) { setTimeout(resolve, 30); });

      var events = await httpSseEvents('/templates/' + sceneId + '/built-in/standard-renderless/stream', 2, 4000);
      assert.equal(events[1].type, 'comments');
      assert.ok(events[1].data.some(function (item) { return item && item.id === keptId; }));
      assert.ok(!events[1].data.some(function (item) { return item && item.id === deletedId; }), 'deleted comment is excluded from replay');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('template replay uses latest content when the same comment id is updated', async function () {
    var sceneId = uniqueId('template-replay-update-scene');
    var commentId = uniqueId('template-update-comment');
    var updatedText = 'updated replay comment';

    try {
      await m.createScene(sceneId, 'Template Replay Update Scene');
      m.setActiveScene(sceneId);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);

      m.pushComments(JSON.stringify([{
        id: commentId,
        name: '@update-user',
        comment: 'original replay comment',
        commentHtml: 'original replay comment',
        profileImage: '',
        timestamp: '12:34',
        hasGift: false,
        amount: 0,
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
        isVerified: false
      }]));
      await new Promise(function (resolve) { setTimeout(resolve, 30); });
      m.pushComments(JSON.stringify([{
        id: commentId,
        name: '@update-user',
        comment: updatedText,
        commentHtml: updatedText,
        profileImage: '',
        timestamp: '12:35',
        hasGift: false,
        amount: 0,
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
        isVerified: false
      }]));
      await new Promise(function (resolve) { setTimeout(resolve, 30); });

      var events = await httpSseEvents('/templates/' + sceneId + '/built-in/standard-renderless/stream', 2, 4000);
      assert.equal(events[1].type, 'comments');
      assert.ok(events[1].data.some(function (item) {
        return item && item.id === commentId && item.comment === updatedText;
      }), 'replay returns the latest version of the comment');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('template stream for a non-active scene still receives incoming comments', async function () {
    var inactiveSceneId = uniqueId('template-inactive-scene');
    var activeSceneId = uniqueId('template-active-scene');
    var commentId = uniqueId('template-inactive-comment');

    try {
      await m.createScene(inactiveSceneId, 'Template Inactive Scene');
      await m.createScene(activeSceneId, 'Template Active Scene');
      assert.equal(JSON.parse(await m.addSceneTemplate(inactiveSceneId, CHAT_LIST_ID)).ok, true);
      assert.equal(JSON.parse(await m.addSceneTemplate(activeSceneId, CHAT_LIST_ID)).ok, true);
      m.setActiveScene(activeSceneId);

      var commentPayload = [{
        id: commentId,
        name: '@inactive-user',
        comment: 'inactive scene template comment',
        commentHtml: 'inactive scene template comment',
        profileImage: '',
        timestamp: '12:34',
        hasGift: false,
        amount: 0,
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
        isVerified: false
      }];
      var events = await httpSseUntil(
        '/templates/' + inactiveSceneId + '/built-in/standard-renderless/stream',
        function (event) {
          return event &&
            event.type === 'comments' &&
            Array.isArray(event.data) &&
            event.data.some(function (item) { return item && item.id === commentId; });
        },
        8000,
        {
          onFirstEvent: function () {
            m.pushComments(JSON.stringify(commentPayload));
          }
        }
      );
      assert.equal(events[0].type, 'config');
      assert.ok(events.some(function (event) {
        return event &&
          event.type === 'comments' &&
          Array.isArray(event.data) &&
          event.data.some(function (item) {
            return item && item.id === commentId;
          });
      }), 'non-active scene template stream receives incoming comments');
    } finally {
      await m.deleteScene(inactiveSceneId);
      await m.deleteScene(activeSceneId);
    }
  });

  it('template stream receives sceneVisible false when the scene is disabled', async function () {
    var sceneId = uniqueId('template-hidden-scene');

    try {
      await m.createScene(sceneId, 'Template Hidden Scene');
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);

      var setEnabledPromise = null;
      var events = await httpSseUntil(
        '/templates/' + sceneId + '/built-in/standard-renderless/stream',
        function (event) {
          return event &&
            event.type === 'config' &&
            event.data &&
            event.data.sceneVisible === false;
        },
        8000,
        {
          onFirstEvent: function () {
            setEnabledPromise = m.setSceneEnabled(sceneId, false);
          }
        }
      );
      if (setEnabledPromise) {
        assert.equal(JSON.parse(await setEnabledPromise), true);
      }
      assert.ok(events.some(function (event) {
        return event &&
          event.type === 'config' &&
          event.data &&
          event.data.sceneVisible === false;
      }), 'disabled scene pushes invisible config to template stream');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('sendTemplateTestComment pushes a test comment into template stream', async function () {
    var sceneId = uniqueId('template-test-comment-scene');
    var testText = 'template test comment ' + uniqueId('msg');

    try {
      await m.createScene(sceneId, 'Template Test Comment Scene');
      m.setActiveScene(sceneId);
      assert.equal(JSON.parse(await m.addSceneTemplate(sceneId, CHAT_LIST_ID)).ok, true);

      // SSE 購読が確立 (最初の config イベント受信) してから sendTemplateTestComment を呼ぶ。
      // 固定 sleep だと並列テスト下で connection 確立前に発火して race る。
      var sendPromise = null;
      var sendError = null;
      var events = await httpSseUntil(
        '/templates/' + sceneId + '/built-in/standard-renderless/stream',
        function (event) {
          return event &&
            event.type === 'comments' &&
            Array.isArray(event.data) &&
            event.data.some(function (item) { return item && item.comment === testText; });
        },
        8000,
        {
          onFirstEvent: function () {
            sendPromise = m.sendTemplateTestComment(sceneId, JSON.stringify({
              userName: 'Template Tester',
              comment: testText
            })).catch(function (err) { sendError = err; });
          }
        }
      );

      assert.ok(sendPromise, 'sendTemplateTestComment was triggered after SSE open');
      var sendResultRaw = await sendPromise;
      assert.equal(sendError, null, 'sendTemplateTestComment did not error');
      var sendResult = JSON.parse(sendResultRaw);
      assert.equal(sendResult.ok, true, 'test comment API succeeds');

      assert.equal(events[0].type, 'config');
      assert.ok(events.some(function (event) {
        return event && event.type === 'comments';
      }), 'template stream emits comments events');
      assert.ok(events.some(function (event) {
        return event &&
          event.type === 'comments' &&
          Array.isArray(event.data) &&
          event.data.some(function (item) {
            return item && item.comment === testText;
          });
      }), 'template stream receives the injected test comment');
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  // --- Performance CRUD ---

  it('savePerformance + getPerformances', async function () {
    var perf = {
      id: 'test-perf-1',
      name: 'Test Performance',
      enabled: true,
      trigger: { type: 'keyword', value: 'hello' },
      effect: 'cracker'
    };
    var result = JSON.parse(await m.savePerformance('test-scene-1', JSON.stringify(perf)));
    assert.ok(result, 'savePerformance returned result');

    var perfs = JSON.parse(await m.getPerformances('test-scene-1'));
    assert.ok(Array.isArray(perfs), 'getPerformances returned array');
    assert.ok(perfs.length > 0, 'Performance was saved');
  });

  it('setPerformanceEnabled', async function () {
    var result = JSON.parse(await m.setPerformanceEnabled('test-scene-1', 'test-perf-1', false));
    assert.ok(result !== null, 'setPerformanceEnabled returned');
  });

  it('deletePerformance', async function () {
    var result = JSON.parse(await m.deletePerformance('test-scene-1', 'test-perf-1'));
    assert.ok(result !== null, 'deletePerformance returned');
  });

  // --- Effect CRUD ---

  it('getEffects returns array', async function () {
    var effects = JSON.parse(await m.getEffects());
    assert.ok(Array.isArray(effects), 'getEffects returned array');
  });

  it('getPluginManifests returns object', async function () {
    var manifests = JSON.parse(await m.getPluginManifests());
    assert.ok(typeof manifests === 'object', 'getPluginManifests returned object');
  });

  // --- Trigger ---

  it('triggerTest returns result', async function () {
    var result = JSON.parse(await m.triggerTest('test-scene-1', 'nonexistent'));
    // 存在しない演出なのでエラーか false 系の値
    assert.ok(result !== undefined, 'triggerTest returned something');
  });

  // --- Pause ---

  it('setPaused + getPaused', async function () {
    await m.setPaused(true);
    var paused = JSON.parse(await m.getPaused());
    assert.equal(paused, true, 'Paused is true');

    await m.setPaused(false);
    paused = JSON.parse(await m.getPaused());
    assert.equal(paused, false, 'Paused is false');
  });

  // --- Fire-and-forget commands ---

  it('pushComments (fire-and-forget)', function () {
    var result = m.pushComments(JSON.stringify([
      { id: 'c1', author: 'test', message: 'hello', timestamp: Date.now() }
    ]));
    assert.ok(result, 'pushComments returned');
  });

  it('pushReaction (fire-and-forget)', function () {
    var result = m.pushReaction(JSON.stringify({ type: 'like' }));
    assert.ok(result, 'pushReaction returned');
  });

  it('pushConnectionState (fire-and-forget)', function () {
    var result = m.pushConnectionState(true, 'test-video-id');
    assert.ok(result, 'pushConnectionState returned');
  });

  it('shared memory snapshot readers return reaction, connection, and engine state', async function () {
    m.pushConnectionState(true, 'snapshot-video-id');
    m.pushReaction(JSON.stringify({ emoji: 'heart', count: 3 }));
    await m.setPaused(true);

    var reactionSnapshot = await waitForSnapshot(
      'reaction snapshot',
      function () { return parseJson(m.readReactionCountsSnapshot(), 'readReactionCountsSnapshot'); },
      function (snapshot) {
        return snapshot && !snapshot.error && snapshot.counts && snapshot.counts.heart >= 3;
      },
      5000
    );
    assert.equal(reactionSnapshot.source, 'sharedMemory');
    assert.ok(reactionSnapshot.total >= reactionSnapshot.counts.heart);

    var connectionSnapshot = await waitForSnapshot(
      'connection snapshot',
      function () { return parseJson(m.readConnectionStateSnapshot(), 'readConnectionStateSnapshot'); },
      function (snapshot) {
        return snapshot && !snapshot.error &&
          snapshot.data &&
          snapshot.data.connected === true &&
          snapshot.data.videoId === 'snapshot-video-id';
      },
      5000
    );
    assert.equal(connectionSnapshot.source, 'sharedMemory');

    var engineSnapshot = await waitForSnapshot(
      'performance engine state snapshot',
      function () { return parseJson(m.readPerformanceEngineStateSnapshot(), 'readPerformanceEngineStateSnapshot'); },
      function (snapshot) {
        return snapshot && !snapshot.error && snapshot.data === 'paused';
      },
      5000
    );
    assert.equal(engineSnapshot.source, 'sharedMemory');

    await m.setPaused(false);
  });

  it('shared memory snapshot readers return comment and performance log entries', async function () {
    var sceneId = uniqueId('shared-memory-scene');
    var performanceId = 'shared-memory-perf';

    try {
      await m.createScene(sceneId, 'Shared Memory Snapshot Scene');
      await m.savePerformance(sceneId, JSON.stringify({
        id: performanceId,
        name: 'Shared Memory Snapshot Performance',
        enabled: true,
        trigger: { type: 'keyword', keywords: [{ text: 'snapshot-keyword' }] },
        effect: 'cracker',
        cooldown: 0
      }));

      m.pushComments(JSON.stringify([
        {
          id: uniqueId('comment'),
          name: '@snapshot',
          comment: 'snapshot-keyword',
          commentHtml: '<b>snapshot-keyword</b>',
          profileImage: 'https://example.com/avatar.png',
          timestamp: '12:34',
          hasGift: false,
          amount: 0,
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
          isVerified: false
        }
      ]));

      var commentSnapshot = await waitForSnapshot(
        'comment timeline snapshot',
        function () { return parseJson(m.readCommentTimelineSnapshot(0), 'readCommentTimelineSnapshot'); },
        function (snapshot) {
          return snapshot && !snapshot.error &&
            Array.isArray(snapshot.entries) &&
            snapshot.entries.some(function (entry) { return entry.comment === 'snapshot-keyword'; });
        },
        5000
      );
      assert.equal(commentSnapshot.source, 'sharedMemory');

      var performanceSnapshot = await waitForSnapshot(
        'performance log snapshot',
        function () { return parseJson(m.readPerformanceLogSnapshot(0), 'readPerformanceLogSnapshot'); },
        function (snapshot) {
          return snapshot && !snapshot.error &&
            Array.isArray(snapshot.entries) &&
            snapshot.entries.some(function (entry) {
              return entry.sceneId === sceneId && entry.performanceId === performanceId;
            });
        },
        5000
      );
      assert.equal(performanceSnapshot.source, 'sharedMemory');
    } finally {
      try { await m.deletePerformance(sceneId, performanceId); } catch (e) {}
      try { await m.deleteScene(sceneId); } catch (e) {}
    }
  });

  it('public /api/status returns current connection snapshot', async function () {
    m.pushConnectionState(true, 'test-video-id');
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    var result = await httpJson('/api/status');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.connected, true);
    assert.equal(result.body.videoId, 'test-video-id');
    assert.equal(result.body.viewerCount, 0);
  });

  it('shared memory comment timeline updates existing entry for the same comment id', async function () {
    var commentId = uniqueId('shared-memory-update-comment');
    var originalText = 'shared memory original comment';
    var updatedText = 'shared memory updated comment';

    m.pushComments(JSON.stringify([
      rawComment({
        id: commentId,
        name: '@shared-update',
        comment: originalText,
        commentHtml: originalText,
        timestamp: '12:34'
      })
    ]));

    var originalSnapshot = await waitForSnapshot(
      'comment timeline original entry',
      function () { return parseJson(m.readCommentTimelineSnapshot(0), 'readCommentTimelineSnapshot'); },
      function (snapshot) {
        return snapshot && !snapshot.error &&
          Array.isArray(snapshot.entries) &&
          snapshot.entries.some(function (entry) {
            return entry.id === commentId && entry.comment === originalText;
          });
      },
      5000
    );
    var originalEntry = originalSnapshot.entries.find(function (entry) {
      return entry.id === commentId;
    });
    assert.ok(originalEntry && originalEntry.cursor > 0, 'original timeline entry has cursor');

    m.pushComments(JSON.stringify([
      rawComment({
        id: commentId,
        name: '@shared-update',
        comment: updatedText,
        commentHtml: updatedText,
        timestamp: '12:35'
      })
    ]));

    var updatedSnapshot = await waitForSnapshot(
      'comment timeline updated entry',
      function () { return parseJson(m.readCommentTimelineSnapshot(0), 'readCommentTimelineSnapshot'); },
      function (snapshot) {
        return snapshot && !snapshot.error &&
          Array.isArray(snapshot.entries) &&
          snapshot.entries.some(function (entry) {
            return entry.id === commentId &&
              entry.comment === updatedText &&
              entry.timestamp === '12:35';
          });
      },
      5000
    );
    var updatedEntries = updatedSnapshot.entries.filter(function (entry) {
      return entry.id === commentId;
    });
    assert.equal(updatedEntries.length, 1, 'same id stays as one timeline entry');
    assert.equal(updatedEntries[0].cursor, originalEntry.cursor, 'timeline update keeps cursor');
    assert.equal(updatedEntries[0].comment, updatedText);
  });

  it('public /api/events and /api/comments return recent entries', async function () {
    m.pushComments(JSON.stringify([
      {
        id: 'http-comment-1',
        name: '@tester',
        comment: 'hello from http test',
        commentHtml: '',
        profileImage: '',
        timestamp: '12:34',
        hasGift: false,
        amount: 0,
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
        isVerified: false
      }
    ]));
    m.pushReaction(JSON.stringify({ emoji: 'heart', count: 1 }));
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    var events = await httpJson('/api/events?limit=10');
    var comments = await httpJson('/api/comments?limit=10');
    assert.equal(events.statusCode, 200);
    assert.equal(comments.statusCode, 200);
    assert.ok(Array.isArray(events.body), 'events returned array');
    assert.ok(Array.isArray(comments.body), 'comments returned array');
    assert.ok(events.body.some(function (entry) { return entry.event === 'comment'; }));
    assert.ok(events.body.some(function (entry) { return entry.event === 'reaction'; }));
    assert.ok(comments.body.length >= 1, 'comments endpoint returned recent comment');
  });

  it('listener owner APIs round-trip through napi and public HTTP', async function () {
    // 自チャンネル設定が複数 ID 対応 (サブチャンネル等) になったため、
    // setOwnerChannels(Vec<{channelId, handle?}>) / getOwnerChannels で配列を扱う。
    var napiOwner = 'UCownerNapiIntegration';
    var httpOwner = 'UCownerHttpIntegration';

    try {
      var napiSet = JSON.parse(await m.setOwnerChannels([{ channelId: napiOwner }]));
      assert.equal(napiSet.ok, true);
      assert.deepEqual(
        napiSet.ownerChannels.map(function (c) { return c.channelId; }),
        [napiOwner]
      );

      var napiGet = JSON.parse(await m.getOwnerChannels());
      assert.deepEqual(
        napiGet.ownerChannels.map(function (c) { return c.channelId; }),
        [napiOwner]
      );

      var httpGetBefore = await httpJson('/api/listeners/owner-channel');
      assert.equal(httpGetBefore.statusCode, 200);
      assert.deepEqual(
        httpGetBefore.body.ownerChannels.map(function (c) { return c.channelId; }),
        [napiOwner]
      );

      var httpSet = await httpJsonRequest('PUT', '/api/listeners/owner-channel', {
        ownerChannels: [{ channelId: httpOwner }]
      });
      assert.equal(httpSet.statusCode, 200);
      assert.equal(httpSet.body.ok, true);
      assert.deepEqual(
        httpSet.body.ownerChannels.map(function (c) { return c.channelId; }),
        [httpOwner]
      );

      var napiGetAfter = JSON.parse(await m.getOwnerChannels());
      assert.deepEqual(
        napiGetAfter.ownerChannels.map(function (c) { return c.channelId; }),
        [httpOwner]
      );

      // 複数 ID のラウンドトリップ (サブチャンネル想定)
      var multi = JSON.parse(await m.setOwnerChannels([
        { channelId: 'UCmainNapi' },
        { channelId: 'UCsubNapi', handle: 'subchannel' }
      ]));
      assert.equal(multi.ok, true);
      assert.equal(multi.ownerChannels.length, 2);
      assert.equal(multi.ownerChannels[1].handle, 'subchannel');
    } finally {
      try { await m.setOwnerChannels([]); } catch (e) {}
    }
  });

  it('listener list and detail APIs expose recorded own-channel comments', async function () {
    var owner = 'UClistenerIntegrationOwner';
    var videoId = uniqueId('listener-video');
    var aliceChannel = 'UClistenerAliceIntegration';
    var bobChannel = 'UClistenerBobIntegration';
    var aliceName = 'Alice Listener Integration';
    var bobName = 'Bob Listener Integration';

    try {
      assert.equal(JSON.parse(await m.setOwnerChannels([{ channelId: owner }])).ok, true);
      m.pushConnectionState(true, videoId);
      m.announceStreamOwner(videoId, owner);
      m.pushComments(JSON.stringify([
        listenerRawComment(uniqueId('listener-alice-1'), aliceChannel, aliceName, 'hello alpha', '2026-05-03T12:00:01.000Z'),
        listenerRawComment(uniqueId('listener-alice-2'), aliceChannel, aliceName, 'hello beta', '2026-05-03T12:00:02.000Z'),
        listenerRawComment(uniqueId('listener-bob-1'), bobChannel, bobName, 'hello gamma', '2026-05-03T12:00:03.000Z')
      ]));

      var listResult = await waitForValue(
        'listener list',
        async function () {
          return JSON.parse(await m.listListeners(JSON.stringify({
            sort: 'commentCount',
            q: 'Listener Integration',
            limit: 10,
            offset: 0
          })));
        },
        function (result) {
          return result && result.ok &&
            result.page &&
            Array.isArray(result.page.rows) &&
            result.page.rows.some(function (row) {
              return row.channelId === 'yt-' + aliceChannel && row.commentCount >= 2;
            }) &&
            result.page.rows.some(function (row) {
              return row.channelId === 'yt-' + bobChannel && row.commentCount >= 1;
            });
        },
        5000
      );

      assert.ok(listResult.page.total >= 2, 'listener list includes recorded rows');
      assert.equal(listResult.page.rows[0].channelId, 'yt-' + aliceChannel);
      assert.equal(listResult.page.rows[0].commentCount, 2);

      var httpList = await httpJson('/api/listeners?q=Alice%20Listener%20Integration&sort=commentCount&limit=5&offset=0');
      assert.equal(httpList.statusCode, 200);
      assert.equal(httpList.body.ok, true);
      assert.ok(httpList.body.page.rows.some(function (row) {
        return row.channelId === 'yt-' + aliceChannel && row.commentCount === 2;
      }), 'HTTP listener list includes Alice row');

      var napiDetail = JSON.parse(await m.getListenerDetail(aliceChannel, 10));
      assert.equal(napiDetail.ok, true);
      assert.equal(napiDetail.detail.channelId, 'yt-' + aliceChannel);
      assert.equal(napiDetail.detail.commentCount, 2);
      assert.ok(napiDetail.detail.recentComments.length >= 2);
      assert.equal(napiDetail.detail.recentComments[0].body, 'hello beta');

      var httpDetail = await httpJson('/api/listeners/by-channel/' + aliceChannel + '?recentCommentLimit=1');
      assert.equal(httpDetail.statusCode, 200);
      assert.equal(httpDetail.body.ok, true);
      assert.equal(httpDetail.body.detail.channelId, 'yt-' + aliceChannel);
      assert.equal(httpDetail.body.detail.recentComments.length, 1);
      assert.equal(httpDetail.body.detail.recentComments[0].body, 'hello beta');
    } finally {
      try { await m.setOwnerChannels([]); } catch (e) {}
      try { m.pushConnectionState(false, null); } catch (e) {}
    }
  });

  it('ensureTemplateFonts creates cache files and reuses existing cache', async function () {
    var mock = await startMockFontServer();
    var previousTemplate = process.env.KOMEHUB_FONT_CSS_BASE_URL_TEMPLATE;
    process.env.KOMEHUB_FONT_CSS_BASE_URL_TEMPLATE =
      'http://127.0.0.1:' + mock.port + '/css?family={family}';

    try {
      var progress = [];
      var result = JSON.parse(await m.ensureTemplateFonts(
        JSON.stringify(['Mock Font']),
        function (_err, progressJson) {
          if (!progressJson) return;
          progress.push(JSON.parse(progressJson));
        }
      ));

      assert.equal(result.ok, true);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].family, 'Mock Font');
      assert.equal(result.results[0].cached, false);
      assert.equal(progress.length, 1);
      assert.deepEqual(progress[0], {
        current: 1,
        total: 1,
        family: 'Mock Font'
      });

      var safeFamily = 'Mock_Font';
      var fontDir = path.join(TEST_DATA_DIR, 'media-cache', 'fonts', safeFamily);
      var cssPath = path.join(fontDir, 'font.css');
      var fontPath = path.join(fontDir, 'mock-font.woff2');
      assert.ok(fs.existsSync(cssPath), 'font.css created');
      assert.ok(fs.existsSync(fontPath), 'font binary created');
      var css = fs.readFileSync(cssPath, 'utf8');
      assert.match(css, /\/cache\/fonts\/Mock_Font\/mock-font\.woff2/);
      assert.equal(mock.counts.css, 1);
      assert.equal(mock.counts.font, 1);

      var cachedResult = JSON.parse(await m.ensureTemplateFonts(
        JSON.stringify(['Mock Font']),
        function () {}
      ));
      assert.equal(cachedResult.ok, true);
      assert.equal(cachedResult.results[0].cached, true);
      assert.equal(mock.counts.css, 1, 'cached font does not re-fetch CSS');
      assert.equal(mock.counts.font, 1, 'cached font does not re-fetch binary');
    } finally {
      if (previousTemplate == null) {
        delete process.env.KOMEHUB_FONT_CSS_BASE_URL_TEMPLATE;
      } else {
        process.env.KOMEHUB_FONT_CSS_BASE_URL_TEMPLATE = previousTemplate;
      }
      await new Promise(function (resolve) { mock.server.close(resolve); });
    }
  });

  it('cacheCommentImages caches local assets and replaces stale files', async function () {
    var firstComments = JSON.parse(await m.cacheCommentImages(JSON.stringify([
      {
        id: 'img-comment-1',
        name: '@tester',
        profileImage: pngDataUrl('avatar-one'),
        _originalProfileImage: 'https://cdn.example.com/avatar-one.png',
        commentHtml: '<img src="' + pngDataUrl('emoji-one') + '">',
        emojis: [
          {
            emojiId: 'emoji-1',
            src: pngDataUrl('emoji-one')
          }
        ]
      }
    ])));

    assert.equal(Object.prototype.hasOwnProperty.call(firstComments[0], '_originalProfileImage'), false);
    assert.match(
      firstComments[0].profileImage,
      new RegExp('^http://127\\.0\\.0\\.1:' + port + '/cache/avatars/tester_[0-9a-f]{6}\\.png$')
    );
    assert.match(firstComments[0].commentHtml, /\/cache\/emojis\/emoji-1_[0-9a-f]{6}\.png/);
    assert.match(firstComments[0].emojis[0].src, /\/cache\/emojis\/emoji-1_[0-9a-f]{6}\.png$/);

    var avatarResponse = await httpBuffer(new URL(firstComments[0].profileImage).pathname);
    assert.equal(avatarResponse.statusCode, 200);
    assert.equal(avatarResponse.body.toString('utf8'), 'avatar-one');

    var secondComments = JSON.parse(await m.cacheCommentImages(JSON.stringify([
      {
        id: 'img-comment-1',
        name: '@tester',
        profileImage: pngDataUrl('avatar-ignored'),
        _originalProfileImage: 'https://cdn.example.com/avatar-one.png'
      }
    ])));
    assert.equal(secondComments[0].profileImage, firstComments[0].profileImage, 'same original URL reuses cache');

    var updatedComments = JSON.parse(await m.cacheCommentImages(JSON.stringify([
      {
        id: 'img-comment-1',
        name: '@tester',
        profileImage: pngDataUrl('avatar-two'),
        _originalProfileImage: 'https://cdn.example.com/avatar-two.png'
      }
    ])));
    assert.notEqual(updatedComments[0].profileImage, firstComments[0].profileImage, 'new original URL creates new cache file');

    var avatarDir = path.join(TEST_DATA_DIR, 'media-cache', 'avatars');
    var avatarFiles = fs.readdirSync(avatarDir).filter(function (name) { return name.indexOf('tester_') === 0; });
    assert.equal(avatarFiles.length, 1, 'stale avatar cache file removed');
  });

  it('pushComments normalizes comment assets through Rust comment aux queue', async function () {
    var avatarData = pngDataUrl('queued-avatar');
    var emojiData = pngDataUrl('queued-emoji');

    m.pushComments(JSON.stringify([
      {
        id: 'queued-comment-1',
        name: '@queued',
        comment: 'queued-comment',
        commentHtml: '<img src="' + emojiData + '">',
        profileImage: avatarData,
        _originalProfileImage: 'https://cdn.example.com/queued-avatar.png',
        emojis: [
          {
            emojiId: 'emoji-queued',
            src: emojiData
          }
        ]
      }
    ]));

    var snapshot = await waitForSnapshot(
      'comment aux snapshot',
      function () { return parseJson(m.readCommentTimelineSnapshot(0), 'readCommentTimelineSnapshot'); },
      function (value) {
        return value && !value.error &&
          Array.isArray(value.entries) &&
          value.entries.some(function (entry) {
            return entry.id === 'queued-comment-1' &&
              /^http:\/\/127\.0\.0\.1:\d+\/cache\/avatars\/queued_[0-9a-f]{6}\.png$/.test(entry.profileImage) &&
              /\/cache\/emojis\/emoji-queued_[0-9a-f]{6}\.png/.test(entry.commentHtml);
          });
      },
      5000
    );

    var entry = snapshot.entries.find(function (value) { return value.id === 'queued-comment-1'; });
    assert.ok(entry, 'queued comment found in snapshot');
    assert.match(
      entry.profileImage,
      new RegExp('^http://127\\.0\\.0\\.1:' + port + '/cache/avatars/queued_[0-9a-f]{6}\\.png$')
    );
    assert.match(entry.commentHtml, /\/cache\/emojis\/emoji-queued_[0-9a-f]{6}\.png/);

    var avatarResponse = await httpBuffer(new URL(entry.profileImage).pathname);
    assert.equal(avatarResponse.statusCode, 200);
    assert.equal(avatarResponse.body.toString('utf8'), 'queued-avatar');
  });

  it('cacheCommentImages caches URL-only assets and reuses existing files', async function () {
    var mock = await startMockImageServer();
    var baseUrl = 'http://127.0.0.1:' + mock.port;
    try {
      var firstComments = JSON.parse(await m.cacheCommentImages(JSON.stringify([
        {
          id: 'url-comment-1',
          name: '@tester',
          profileImage: baseUrl + '/images/avatar-one.png',
          commentHtml: '<img src="' + baseUrl + '/images/emoji-one.png">',
          emojis: [
            {
              emojiId: 'emoji-url',
              src: baseUrl + '/images/emoji-one.png'
            }
          ]
        }
      ])));

      assert.match(
        firstComments[0].profileImage,
        new RegExp('^http://127\\.0\\.0\\.1:' + port + '/cache/avatars/tester_[0-9a-f]{6}\\.png$')
      );
      assert.match(firstComments[0].commentHtml, /\/cache\/emojis\/emoji-url_[0-9a-f]{6}\.png/);
      assert.match(firstComments[0].emojis[0].src, /\/cache\/emojis\/emoji-url_[0-9a-f]{6}\.png$/);
      assert.equal(mock.counts.avatarOne, 1, 'first avatar URL fetched once');
      assert.equal(mock.counts.emojiOne, 1, 'first emoji URL fetched once');

      var secondComments = JSON.parse(await m.cacheCommentImages(JSON.stringify([
        {
          id: 'url-comment-1',
          name: '@tester',
          profileImage: baseUrl + '/images/avatar-one.png',
          commentHtml: '<img src="' + baseUrl + '/images/emoji-one.png">',
          emojis: [
            {
              emojiId: 'emoji-url',
              src: baseUrl + '/images/emoji-one.png'
            }
          ]
        }
      ])));

      assert.equal(secondComments[0].profileImage, firstComments[0].profileImage, 'same original URL reuses local cache');
      assert.equal(mock.counts.avatarOne, 1, 'cached avatar URL is not re-fetched');
      assert.equal(mock.counts.emojiOne, 1, 'cached emoji URL is not re-fetched');

      var updatedComments = JSON.parse(await m.cacheCommentImages(JSON.stringify([
        {
          id: 'url-comment-1',
          name: '@tester',
          profileImage: baseUrl + '/images/avatar-two.png'
        }
      ])));

      assert.notEqual(updatedComments[0].profileImage, firstComments[0].profileImage, 'new original URL creates a new cache file');
      assert.equal(mock.counts.avatarTwo, 1, 'updated avatar URL fetched once');

      var avatarDir = path.join(TEST_DATA_DIR, 'media-cache', 'avatars');
      var avatarFiles = fs.readdirSync(avatarDir).filter(function (name) { return name.indexOf('tester_') === 0; });
      assert.equal(avatarFiles.length, 1, 'stale avatar cache file removed');
    } finally {
      await new Promise(function (resolve) { mock.server.close(resolve); });
    }
  });

  it('pushComments normalizes URL-only assets through Rust comment aux queue', async function () {
    var mock = await startMockImageServer();
    var baseUrl = 'http://127.0.0.1:' + mock.port;
    try {
      m.pushComments(JSON.stringify([
        {
          id: 'queued-url-comment-1',
          name: '@queued',
          comment: 'queued-comment',
          commentHtml: '<img src="' + baseUrl + '/images/emoji-one.png">',
          profileImage: baseUrl + '/images/avatar-one.png',
          emojis: [
            {
              emojiId: 'emoji-queued-url',
              src: baseUrl + '/images/emoji-one.png'
            }
          ]
        }
      ]));

      var snapshot = await waitForSnapshot(
        'comment aux URL-only snapshot',
        function () { return parseJson(m.readCommentTimelineSnapshot(0), 'readCommentTimelineSnapshot'); },
        function (value) {
          return value && !value.error &&
            Array.isArray(value.entries) &&
            value.entries.some(function (entry) {
              return entry.id === 'queued-url-comment-1' &&
                /^http:\/\/127\.0\.0\.1:\d+\/cache\/avatars\/queued_[0-9a-f]{6}\.png$/.test(entry.profileImage) &&
                /\/cache\/emojis\/emoji-queued-url_[0-9a-f]{6}\.png/.test(entry.commentHtml);
            });
        },
        5000
      );

      var entry = snapshot.entries.find(function (value) { return value.id === 'queued-url-comment-1'; });
      assert.ok(entry, 'queued URL-only comment found in snapshot');
      assert.match(
        entry.profileImage,
        new RegExp('^http://127\\.0\\.0\\.1:' + port + '/cache/avatars/queued_[0-9a-f]{6}\\.png$')
      );
      assert.match(entry.commentHtml, /\/cache\/emojis\/emoji-queued-url_[0-9a-f]{6}\.png/);

      var avatarResponse = await httpBuffer(new URL(entry.profileImage).pathname);
      assert.equal(avatarResponse.statusCode, 200);
      assert.equal(avatarResponse.body.toString('utf8'), 'avatar-one');
    } finally {
      await new Promise(function (resolve) { mock.server.close(resolve); });
    }
  });

  it('pushComments keeps comment payload when URL-only image fetch fails', async function () {
    var mock = await startMockImageServer();
    var baseUrl = 'http://127.0.0.1:' + mock.port;
    try {
      m.pushComments(JSON.stringify([
        {
          id: 'queued-url-missing-1',
          name: '@queued',
          comment: 'queued-missing',
          commentHtml: '<img src="' + baseUrl + '/images/missing.png">',
          profileImage: baseUrl + '/images/missing.png',
          emojis: [
            {
              emojiId: 'emoji-missing',
              src: baseUrl + '/images/missing.png'
            }
          ]
        }
      ]));

      var snapshot = await waitForSnapshot(
        'comment aux URL-only missing snapshot',
        function () { return parseJson(m.readCommentTimelineSnapshot(0), 'readCommentTimelineSnapshot'); },
        function (value) {
          return value && !value.error &&
            Array.isArray(value.entries) &&
            value.entries.some(function (entry) {
              return entry.id === 'queued-url-missing-1' &&
                entry.profileImage === baseUrl + '/images/missing.png' &&
                entry.commentHtml.indexOf(baseUrl + '/images/missing.png') !== -1;
            });
        },
        5000
      );

      var entry = snapshot.entries.find(function (value) { return value.id === 'queued-url-missing-1'; });
      assert.ok(entry, 'queued URL-only fallback comment found in snapshot');
      assert.equal(entry.profileImage, baseUrl + '/images/missing.png');
      assert.match(entry.commentHtml, /images\/missing\.png/);
      assert.equal(mock.counts.missing >= 1, true, 'missing image URL was attempted');
    } finally {
      await new Promise(function (resolve) { mock.server.close(resolve); });
    }
  });

  it('pushComments progressively applies comments within the same aux batch', async function () {
    var mock = await startMockImageServer();
    var baseUrl = 'http://127.0.0.1:' + mock.port;
    try {
      m.pushComments(JSON.stringify([
        {
          id: 'queued-progressive-1',
          name: '@queued',
          comment: 'fast-comment',
          profileImage: baseUrl + '/images/avatar-one.png'
        },
        {
          id: 'queued-progressive-2',
          name: '@queued',
          comment: 'slow-comment',
          profileImage: baseUrl + '/images/avatar-slow.png'
        }
      ]));

      var commentsResponse = null;
      var startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        var response = await httpJson('/api/comments?limit=100');
        commentsResponse = response.body;
        if (
          Array.isArray(commentsResponse) &&
          commentsResponse.some(function (entry) {
            return entry.id === 'queued-progressive-1' &&
              entry._komehubTrace &&
              entry._komehubTrace.commentAuxBatchSize === 2 &&
              entry._komehubTrace.commentAuxBatchIndex === 0;
          }) &&
          commentsResponse.some(function (entry) {
            return entry.id === 'queued-progressive-2' &&
              entry._komehubTrace &&
              entry._komehubTrace.commentAuxBatchSize === 2 &&
              entry._komehubTrace.commentAuxBatchIndex === 1;
          })
        ) {
          break;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 20); });
      }
      assert.ok(Array.isArray(commentsResponse), 'comments api returned array');

      var first = commentsResponse.find(function (value) { return value.id === 'queued-progressive-1'; });
      var second = commentsResponse.find(function (value) { return value.id === 'queued-progressive-2'; });
      assert.ok(first, 'first progressive comment found');
      assert.ok(second, 'second progressive comment found');
      assert.equal(first._komehubTrace.commentAuxBatchSize, 2);
      assert.equal(second._komehubTrace.commentAuxBatchSize, 2);
      assert.equal(first._komehubTrace.commentAuxBatchIndex, 0);
      assert.equal(second._komehubTrace.commentAuxBatchIndex, 1);
      assert.ok(
        first._komehubTrace.modelQueueHandleAtMs <= second._komehubTrace.commentAuxItemDoneAtMs,
        'first comment is applied before second comment finishes aux processing'
      );
      assert.ok(
        (first._komehubTrace.modelQueueHandleAtMs - first._komehubTrace.commentAuxItemDoneAtMs) <= 5,
        'first comment does not wait for whole batch tail'
      );
      assert.ok(
        (second._komehubTrace.commentAuxItemDoneAtMs - second._komehubTrace.commentAuxItemStartedAtMs) >= 60,
        'second comment keeps the induced slow aux processing'
      );
    } finally {
      await new Promise(function (resolve) { mock.server.close(resolve); });
    }
  });

  it('exportTemplate writes manifest defaults and scene assets into zip', async function () {
    var perfDir = path.join(TEST_DATA_DIR, 'scenes', 'test-scene-1', 'performances');
    var exportPath = path.join(TEST_DATA_DIR, 'exported-template.zip');
    fs.mkdirSync(perfDir, { recursive: true });
    fs.writeFileSync(path.join(perfDir, 'bg.png'), Buffer.from('template-bg', 'utf8'));

    var result = JSON.parse(await m.exportTemplate(
      CHAT_LIST_ID,
      'Exported Template',
      'test-scene-1',
      JSON.stringify({
        backgroundImage: 'bg.png',
        maxComments: 42
      }),
      exportPath
    ));
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(exportPath), 'template zip created');

    var AdmZip = require('adm-zip');
    var zip = new AdmZip(exportPath);
    var manifestEntry = zip.getEntry('Exported Template/manifest.json');
    var assetEntry = zip.getEntry('Exported Template/assets/bg.png');
    assert.ok(manifestEntry, 'manifest.json included');
    assert.ok(assetEntry, 'scene asset included');

    var manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    assert.equal(manifest.id, CHAT_LIST_ID);
    assert.equal(manifest.name, 'Exported Template');
    assert.equal(manifest.displayName, 'Exported Template');
    var maxCommentsSchema = (manifest.uiSchema || []).find(function (item) {
      return item && item.key === 'maxComments';
    });
    var backgroundSchema = (manifest.uiSchema || []).find(function (item) {
      return item && item.key === 'backgroundImage';
    });
    assert.equal(maxCommentsSchema.default, 42);
    assert.equal(backgroundSchema.default, 'assets/bg.png');
    assert.equal(assetEntry.getData().toString('utf8'), 'template-bg');
  });

  it('installTemplate serves exported template assets from template path', async function () {
    var perfDir = path.join(TEST_DATA_DIR, 'scenes', 'test-scene-1', 'performances');
    var exportPath = path.join(TEST_DATA_DIR, 'exported-template-import.zip');
    fs.mkdirSync(perfDir, { recursive: true });
    fs.writeFileSync(path.join(perfDir, 'bg-import.png'), Buffer.from('template-import-bg', 'utf8'));

    var exportResult = JSON.parse(await m.exportTemplate(
      CHAT_LIST_ID,
      'Imported Template Source',
      'test-scene-1',
      JSON.stringify({
        backgroundImage: 'bg-import.png',
        maxComments: 24
      }),
      exportPath
    ));
    assert.equal(exportResult.ok, true);

    var installResult = JSON.parse(await m.installTemplate(exportPath));
    assert.equal(installResult.ok, true);
    assert.ok(installResult.template, 'installed template info returned');

    var installedTemplateId = installResult.template.id;
    var installedAsset = await httpBuffer('/templates/test-scene-1/comehub/' + installedTemplateId + '/assets/bg-import.png');
    assert.equal(installedAsset.statusCode, 200);
    assert.equal(installedAsset.body.toString('utf8'), 'template-import-bg');

    var templates = JSON.parse(await m.getTemplates());
    assert.ok(templates.some(function (item) {
      return item && item.id === installedTemplateId && item.builtin === false;
    }), 'installed template appears in template list');

    await m.removeTemplate(installedTemplateId);
  });

  it('installTemplate uses zip top-level directory name as display name when no manifest/template.json exists', async function () {
    // わんコメ系の多くのテンプレ (例: 「シンプル可愛い星とラインのわんコメテンプレート」) は
    // manifest.json も template.json も持たず、zip 内は `表示名/index.html` という
    // 1 階層構造になっている。以前は 2 階層 (`A/B/index.html`) しか表示名を拾えず、
    // 1 階層 zip は storage 名 "tmpl-N" に落ちていた。これを回帰検知する。
    var displayNameFromZip = 'シンプル可愛い星とラインのわんコメテンプレート';
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'komehub-zip-name-'));
    var zipPath = path.join(tempDir, 'single-level.zip');
    var indexHtml = '<html><head><meta charset="UTF-8"></head><body>' +
      '<script src="../__origin/js/vue.min.js"></script>' +
      '<script src="../__origin/js/onesdk.js"></script>' +
      '</body></html>';
    var zip = new AdmZip();
    zip.addFile(displayNameFromZip + '/index.html', Buffer.from(indexHtml, 'utf8'));
    zip.addFile(displayNameFromZip + '/style.css', Buffer.from('/* empty */', 'utf8'));
    zip.writeZip(zipPath);

    var installResult = JSON.parse(await m.installTemplate(zipPath));
    assert.equal(installResult.ok, true);
    assert.equal(
      installResult.template.displayName,
      displayNameFromZip,
      'displayName should be extracted from single-level zip top dir, got: ' + installResult.template.displayName
    );

    await m.removeTemplate(installResult.template.id);
  });

  it('installTemplate reports unsupported OneComme community plugins and the HTTP catch-all returns 404', async function () {
    // わんコメ community プラグイン依存（`/plugins/onecomme.plugin.XXX/`）を
    // 含む テンプレを作って、インポート時に unsupportedPlugins が報告されることと、
    // /plugins/* が 404 を返すことを確認する smoke
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'komehub-unsupported-plugin-'));
    var zipPath = path.join(tempDir, 'with-template-utils.zip');
    var indexHtml = [
      '<!DOCTYPE html>',
      '<html><head>',
      '<meta charset="UTF-8">',
      '<link rel="stylesheet" href="/plugins/onecomme.plugin.template-utils/css/fonts.css">',
      '</head><body>',
      '<div id="comments"></div>',
      '<script src="../__origin/js/vue.min.js"></script>',
      '<script src="/plugins/onecomme.plugin.template-utils/template.js"></script>',
      '</body></html>'
    ].join('\n');
    var manifest = {
      id: 'com.test.template.with-template-utils',
      name: 'with-template-utils',
      displayName: 'With template-utils',
      version: '1.0.0'
    };
    var zip = new AdmZip();
    zip.addFile('with-template-utils/index.html', Buffer.from(indexHtml, 'utf8'));
    zip.addFile('with-template-utils/style.css', Buffer.from('/* empty */', 'utf8'));
    zip.addFile('with-template-utils/manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
    zip.writeZip(zipPath);

    var installResult = JSON.parse(await m.installTemplate(zipPath));
    assert.equal(installResult.ok, true, 'install ok even when plugin dependency missing');
    assert.ok(Array.isArray(installResult.unsupportedPlugins), 'unsupportedPlugins returned');
    assert.ok(
      installResult.unsupportedPlugins.indexOf('onecomme.plugin.template-utils') !== -1,
      'detected template-utils plugin: ' + JSON.stringify(installResult.unsupportedPlugins)
    );

    // /plugins/* catch-all: 404 + 説明本文を返すこと
    var pluginResponse = await httpBuffer('/plugins/onecomme.plugin.template-utils/template.js');
    assert.equal(pluginResponse.statusCode, 404, 'plugin catch-all returns 404');
    var body = pluginResponse.body.toString('utf8');
    assert.ok(body.indexOf('onecomme.plugin.template-utils') !== -1, 'body mentions plugin id');

    await m.removeTemplate(installResult.template.id);
  });

  it('addSceneTemplate applies imported manifest defaults to scene settings', async function () {
    var perfDir = path.join(TEST_DATA_DIR, 'scenes', 'test-scene-1', 'performances');
    var exportPath = path.join(TEST_DATA_DIR, 'exported-template-defaults.zip');
    fs.mkdirSync(perfDir, { recursive: true });
    fs.writeFileSync(path.join(perfDir, 'bg-default.png'), Buffer.from('template-default-bg', 'utf8'));

    var exportResult = JSON.parse(await m.exportTemplate(
      CHAT_LIST_ID,
      'Imported Template Defaults',
      'test-scene-1',
      JSON.stringify({
        backgroundImage: 'bg-default.png',
        maxComments: 18
      }),
      exportPath
    ));
    assert.equal(exportResult.ok, true);

    var installResult = JSON.parse(await m.installTemplate(exportPath));
    assert.equal(installResult.ok, true);
    assert.ok(installResult.template, 'installed template info returned');

    var installedTemplateId = installResult.template.id;

    try {
      var addResult = JSON.parse(await m.addSceneTemplate('test-scene-1', installedTemplateId));
      assert.equal(addResult.ok, true);

      var sceneTemplates = JSON.parse(await m.getSceneTemplates('test-scene-1'));
      var template = (sceneTemplates.sceneTemplates || []).find(function (item) {
        return item && item.id === installedTemplateId;
      });

      assert.ok(template, 'added template exists in scene settings');
      assert.equal(template.settings.backgroundImage, 'assets/bg-default.png');
      assert.equal(template.settings.maxComments, 18);
    } finally {
      await m.removeSceneTemplate('test-scene-1', installedTemplateId);
      await m.removeTemplate(installedTemplateId);
    }
  });

  it('exportTemplate and installTemplate preserve bundled font subtrees when exportPolicy allows redistribution', async function () {
    var fixture = createTemplateFontFixture({
      exportPolicy: {
        allowTemplateExport: true,
        note: 'Bundled font redistribution is allowed.'
      }
    });
    var exportPath = path.join(TEST_DATA_DIR, 'exported-template-fonts.zip');
    var installedTemplateId = '';

    try {
      var exportResult = JSON.parse(await m.exportTemplate(
        fixture.templateId,
        'Exported Font Template',
        'test-scene-1',
        JSON.stringify({}),
        exportPath
      ));
      assert.equal(exportResult.ok, true);

      var entries = listZipEntries(exportPath);
      assert.ok(entries.includes('Exported Font Template/fonts/bundled-font.css'));
      assert.ok(entries.includes('Exported Font Template/fonts/BundledExampleFont.woff2'));

      var zip = new AdmZip(exportPath);
      var manifest = JSON.parse(zip.getEntry('Exported Font Template/manifest.json').getData().toString('utf8'));
      assert.deepEqual(manifest.fontSources, [
        {
          family: 'Bundled Example Font',
          type: 'assetCss',
          css: 'fonts/bundled-font.css'
        },
        {
          family: 'Remote Example Font',
          type: 'remoteCss',
          url: 'https://cdn.example.com/fonts/remote-font.css'
        }
      ]);
      assert.deepEqual(manifest.exportPolicy, {
        allowTemplateExport: true,
        note: 'Bundled font redistribution is allowed.'
      });

      var installResult = JSON.parse(await m.installTemplate(exportPath));
      assert.equal(installResult.ok, true);
      installedTemplateId = installResult.template.id;

      var installedCss = await httpBuffer('/templates/test-scene-1/comehub/' + installedTemplateId + '/fonts/bundled-font.css');
      var installedFont = await httpBuffer('/templates/test-scene-1/comehub/' + installedTemplateId + '/fonts/BundledExampleFont.woff2');
      var installedIndex = await httpBuffer('/templates/test-scene-1/comehub/' + installedTemplateId + '/');

      assert.equal(installedCss.statusCode, 200);
      assert.equal(installedFont.statusCode, 200);
      assert.equal(installedFont.body.toString('utf8'), 'bundled-font-data');
      var installedIndexBody = installedIndex.body.toString('utf8');
      assert.match(installedIndexBody, /"fontSources":\[/);
      assert.match(installedIndexBody, /"family":"Bundled Example Font"/);
      assert.match(installedIndexBody, /"css":"fonts\/bundled-font\.css"/);
      assert.match(installedIndexBody, /"family":"Remote Example Font"/);
      assert.match(installedIndexBody, /"url":"https:\/\/cdn\.example\.com\/fonts\/remote-font\.css"/);
    } finally {
      if (installedTemplateId) {
        try { await m.removeTemplate(installedTemplateId); } catch (e) {}
      }
      fs.rmSync(fixture.dir, { recursive: true, force: true });
      fs.rmSync(exportPath, { force: true });
    }
  });

  it('addSceneTemplate seeds built-in template defaults into scene settings', async function () {
    var sceneId = uniqueId('template-color-defaults');
    var expectedDefaults = [
      {
        id: STANDARD_RENDERLESS_ID,
        settings: {
          nameColor: '#8f8f8f',
          textColor: '#e0e0e0',
          memberColor: false,
          memberColorValue: '#2ba640',
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 12,
          paddingRight: 12
        }
      },
      {
        id: CHAT_CUTE_ID,
        settings: {
          nameColor: '#a07aa0',
          textColor: '#3a3a4a',
          memberColor: false,
          memberColorValue: '#2ba640',
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 12,
          paddingRight: 12
        }
      },
      {
        id: CHAT_WAFUU_ID,
        settings: {
          nameColor: '#8a7a6a',
          textColor: '#4a4035',
          memberColor: false,
          memberColorValue: '#2ba640',
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 12,
          paddingRight: 12
        }
      },
      {
        id: GAME_COMPACT_ID,
        settings: {
          nameColor: '#7ec8e3',
          textColor: '#ffffff',
          memberColor: false,
          memberColorValue: '#2ba640'
        }
      },
      {
        id: GAME_FPS_ID,
        settings: {
          nameColor: '#6ea8d4',
          textColor: 'rgba(255,255,255,0.82)',
          memberColor: false,
          memberColorValue: '#2ba640'
        }
      },
      {
        id: SINGING_TEXT_ID,
        settings: {
          nameColor: '#ffffff',
          textColor: 'rgba(255,255,255,0.92)',
          memberColor: false,
          memberColorValue: '#2ba640'
        }
      },
      {
        id: GAME_RAINBOW_ID,
        settings: {
          textColor: 'rgba(255,255,255,0.88)',
          memberColor: false,
          memberColorValue: '#2ba640'
        }
      },
      {
        id: TICKER_RENDERLESS_ID,
        settings: {
          nameColor: '#ffffff',
          textColor: '#ffffff',
          memberColor: false,
          memberColorValue: '#2ba640',
          glowCustomColor: '#00dcff'
        }
      }
    ];

    try {
      await m.createScene(sceneId, 'Template Color Defaults Scene');
      for (var i = 0; i < expectedDefaults.length; i++) {
        var addResult = JSON.parse(await m.addSceneTemplate(sceneId, expectedDefaults[i].id));
        assert.equal(addResult.ok, true, 'addSceneTemplate succeeded for ' + expectedDefaults[i].id);
      }

      var sceneTemplates = JSON.parse(await m.getSceneTemplates(sceneId));
      expectedDefaults.forEach(function (expected) {
        var template = (sceneTemplates.sceneTemplates || []).find(function (item) {
          return item && item.id === expected.id;
        });
        assert.ok(template, 'added template exists for ' + expected.id);
        Object.keys(expected.settings).forEach(function (key) {
          assert.equal(
            template.settings[key],
            expected.settings[key],
            expected.id + ' keeps manifest default for ' + key
          );
        });
      });
    } finally {
      await m.deleteScene(sceneId);
    }
  });

  it('exportEffect keeps nested plugin and asset paths', async function () {
    var effectId = uniqueId('com.test.export.effect');
    var pluginDir = createPluginFixture(effectId);
    var assetsDir = path.join(TEST_DATA_DIR, 'effects', 'assets', effectId, 'nested');
    var zipPath = path.join(TEST_DATA_DIR, effectId + '-effect.zip');

    try {
      fs.mkdirSync(assetsDir, { recursive: true });
      writeJson(path.join(assetsDir, 'config.json'), { ok: true });
      await addCustomEffect(effectId);

      var result = JSON.parse(await m.exportEffect(effectId, zipPath));
      assert.equal(result.ok, true);

      var entries = listZipEntries(zipPath);
      assert.ok(entries.includes('effect.json'));
      assert.ok(entries.includes('plugin/main.js'));
      assert.ok(entries.includes('plugin/templates/card.html'));
      assert.ok(entries.includes('assets/nested/config.json'));
    } finally {
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('exportScene keeps nested mascot, performance, and plugin paths', async function () {
    var effectId = uniqueId('com.test.export.scene');
    var pluginDir = createPluginFixture(effectId);
    var sceneId = uniqueId('scene-export');
    var zipPath = path.join(TEST_DATA_DIR, sceneId + '.zip');

    try {
      await addCustomEffect(effectId);
      await m.createScene(sceneId, 'Export Regression Scene');

      var sceneDir = path.join(TEST_DATA_DIR, 'scenes', sceneId);
      fs.writeFileSync(path.join(sceneDir, 'mascot', 'icon.png'), 'icon');
      fs.mkdirSync(path.join(sceneDir, 'mascot', 'particles', 'special'), { recursive: true });
      writeJson(path.join(sceneDir, 'mascot', 'particles', 'special', 'meta.json'), { particle: true });
      fs.mkdirSync(path.join(sceneDir, 'performances', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(sceneDir, 'performances', 'nested', 'asset.svg'), '<svg></svg>');

      await m.savePerformance(sceneId, JSON.stringify({
        id: 'perf-export-test',
        name: 'Export Test Performance',
        enabled: true,
        trigger: { type: 'keyword', keywords: [{ text: 'test' }] },
        effect: effectId,
        assets: ['nested/asset.svg'],
        sounds: [],
        cooldown: 0
      }));

      var result = JSON.parse(await m.exportScene(sceneId, zipPath));
      assert.equal(result.ok, true);

      var entries = listZipEntries(zipPath);
      assert.ok(entries.includes('scene.json'));
      assert.ok(entries.includes('mascot/icon.png'));
      assert.ok(entries.includes('mascot/particles/special/meta.json'));
      assert.ok(entries.includes('performances/nested/asset.svg'));
      assert.ok(entries.includes('effects/effects.json'));
      assert.ok(entries.includes('plugins/' + effectId + '/main.js'));
      assert.ok(entries.includes('plugins/' + effectId + '/templates/card.html'));
    } finally {
      try { await m.deleteScene(sceneId); } catch (e) {}
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('exportPerformance keeps nested asset, sound, and plugin paths', async function () {
    var effectId = uniqueId('com.test.export.performance');
    var pluginDir = createPluginFixture(effectId);
    var sceneId = uniqueId('perf-export-scene');
    var zipPath = path.join(TEST_DATA_DIR, sceneId + '-performance.zip');

    try {
      await addCustomEffect(effectId);
      await m.createScene(sceneId, 'Performance Export Regression Scene');

      var perfDir = path.join(TEST_DATA_DIR, 'scenes', sceneId, 'performances', 'nested');
      fs.mkdirSync(perfDir, { recursive: true });
      fs.writeFileSync(path.join(perfDir, 'asset.svg'), '<svg></svg>');
      fs.writeFileSync(path.join(perfDir, 'sound.wav'), 'fake-wave');

      await m.savePerformance(sceneId, JSON.stringify({
        id: 'perf-export-nested-test',
        name: 'Nested Performance Export',
        enabled: true,
        trigger: { type: 'keyword', keywords: [{ text: 'nested' }] },
        effect: effectId,
        assets: ['nested/asset.svg'],
        sounds: ['nested/sound.wav'],
        cooldown: 0
      }));

      var result = JSON.parse(await m.exportPerformance(sceneId, 'perf-export-nested-test', zipPath));
      assert.equal(result.ok, true);

      var entries = listZipEntries(zipPath);
      assert.ok(entries.includes('performance.json'));
      assert.ok(entries.includes('effect.json'));
      assert.ok(entries.includes('plugin/main.js'));
      assert.ok(entries.includes('plugin/templates/card.html'));
      assert.ok(entries.includes('assets/nested/asset.svg'));
      assert.ok(entries.includes('assets/nested/sound.wav'));
    } finally {
      try { await m.deleteScene(sceneId); } catch (e) {}
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('importPerformance restores nested asset, sound, and plugin paths from exported zip', async function () {
    var effectId = uniqueId('com.test.import.performance');
    var pluginDir = createPluginFixture(effectId);
    var sourceSceneId = uniqueId('perf-import-source');
    var targetSceneId = uniqueId('perf-import-target');
    var zipPath = path.join(TEST_DATA_DIR, sourceSceneId + '-roundtrip.zip');

    try {
      await addCustomEffect(effectId);
      await m.createScene(sourceSceneId, 'Performance Import Source');

      var sourcePerfDir = path.join(TEST_DATA_DIR, 'scenes', sourceSceneId, 'performances', 'nested');
      fs.mkdirSync(sourcePerfDir, { recursive: true });
      fs.writeFileSync(path.join(sourcePerfDir, 'asset.svg'), '<svg></svg>');
      fs.writeFileSync(path.join(sourcePerfDir, 'sound.wav'), 'fake-wave');

      await m.savePerformance(sourceSceneId, JSON.stringify({
        id: 'perf-import-roundtrip',
        name: 'Import Roundtrip Performance',
        enabled: true,
        trigger: { type: 'keyword', keywords: [{ text: 'roundtrip' }] },
        effect: effectId,
        assets: ['nested/asset.svg'],
        sounds: ['nested/sound.wav'],
        cooldown: 0
      }));

      assert.equal(JSON.parse(await m.exportPerformance(sourceSceneId, 'perf-import-roundtrip', zipPath)).ok, true);

      await m.deleteScene(sourceSceneId);
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });

      await m.createScene(targetSceneId, 'Performance Import Target');
      assert.equal(JSON.parse(await m.importPerformance(targetSceneId, zipPath)), true);

      var importedPerformances = JSON.parse(await m.getPerformances(targetSceneId));
      assert.equal(importedPerformances.length, 1);
      assert.equal(importedPerformances[0].effect, effectId);
      assert.deepEqual(importedPerformances[0].assets, ['nested/asset.svg']);
      assert.deepEqual(importedPerformances[0].sounds, ['nested/sound.wav']);
      assert.ok(JSON.parse(await m.getEffect(effectId)));
      assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'scenes', targetSceneId, 'performances', 'nested', 'asset.svg')));
      assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'scenes', targetSceneId, 'performances', 'nested', 'sound.wav')));
      assert.ok(fs.existsSync(path.join(pluginDir, 'main.js')));
      assert.ok(fs.existsSync(path.join(pluginDir, 'templates', 'card.html')));
    } finally {
      try { await m.deleteScene(sourceSceneId); } catch (e) {}
      try { await m.deleteScene(targetSceneId); } catch (e) {}
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('importScene restores nested mascot, performance, and plugin paths from exported zip', async function () {
    var effectId = uniqueId('com.test.import.scene');
    var pluginDir = createPluginFixture(effectId);
    var sourceSceneId = uniqueId('scene-import-source');
    var zipPath = path.join(TEST_DATA_DIR, sourceSceneId + '-scene-roundtrip.zip');
    var importedSceneId = null;

    try {
      await addCustomEffect(effectId);
      await m.createScene(sourceSceneId, 'Scene Import Source');

      var sourceSceneDir = path.join(TEST_DATA_DIR, 'scenes', sourceSceneId);
      fs.writeFileSync(path.join(sourceSceneDir, 'mascot', 'icon.png'), 'icon');
      fs.mkdirSync(path.join(sourceSceneDir, 'mascot', 'particles', 'special'), { recursive: true });
      writeJson(path.join(sourceSceneDir, 'mascot', 'particles', 'special', 'meta.json'), { particle: true });
      fs.mkdirSync(path.join(sourceSceneDir, 'performances', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(sourceSceneDir, 'performances', 'nested', 'asset.svg'), '<svg></svg>');

      await m.savePerformance(sourceSceneId, JSON.stringify({
        id: 'scene-import-roundtrip',
        name: 'Scene Import Roundtrip',
        enabled: true,
        trigger: { type: 'keyword', keywords: [{ text: 'scene' }] },
        effect: effectId,
        assets: ['nested/asset.svg'],
        sounds: [],
        cooldown: 0
      }));

      assert.equal(JSON.parse(await m.exportScene(sourceSceneId, zipPath)).ok, true);

      await m.deleteScene(sourceSceneId);
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });

      var importResult = JSON.parse(await m.importScene(zipPath));
      importedSceneId = typeof importResult === 'string' ? importResult : importResult.sceneId;
      assert.ok(importedSceneId);

      var scenes = JSON.parse(await m.getScenes());
      var importedScene = scenes.scenes[importedSceneId];
      assert.ok(importedScene);
      assert.equal(importedScene.performances.length, 1);
      assert.equal(importedScene.performances[0].effect, effectId);
      assert.ok(JSON.parse(await m.getEffect(effectId)));
      assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'scenes', importedSceneId, 'mascot', 'icon.png')));
      assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'scenes', importedSceneId, 'mascot', 'particles', 'special', 'meta.json')));
      assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'scenes', importedSceneId, 'performances', 'nested', 'asset.svg')));
      assert.ok(fs.existsSync(path.join(pluginDir, 'main.js')));
      assert.ok(fs.existsSync(path.join(pluginDir, 'templates', 'card.html')));
    } finally {
      try { await m.deleteScene(sourceSceneId); } catch (e) {}
      if (importedSceneId) {
        try { await m.deleteScene(importedSceneId); } catch (e) {}
      }
      await removeCustomEffect(effectId);
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('setListenerHidden toggles two-axis hidden state', async function () {
    var result = JSON.parse(await m.setListenerHidden('UChiddenUser', true, false));
    assert.equal(result.ok, true);

    var users = JSON.parse(await m.getHiddenListeners());
    assert.ok(users.some(function (u) {
      return u.id === 'UChiddenUser' && u.hideFromComments === true && u.hideFromListeners === false;
    }));

    var cleared = JSON.parse(await m.setListenerHidden('UChiddenUser', false, false));
    assert.equal(cleared.ok, true);
  });

  it('setHiddenListeners persists into app-config and reloads on init', async function () {
    var configPath = path.join(TEST_DATA_DIR, 'app-config.json');
    var users = [
      { id: 'user1', name: 'User One', profileImage: 'avatar-1.png', hideFromComments: true, hideFromListeners: false },
      { id: 'user2', name: 'User Two', profileImage: '', hideFromComments: false, hideFromListeners: true }
    ];

    assert.deepEqual(JSON.parse(await m.setHiddenListeners(JSON.stringify(users))), users);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });

    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.hiddenListeners, users);

    await m.shutdownCore();
    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    registerSharedBuffer('reactionCounts');
    registerSharedBuffer('performanceLog');
    registerSharedBuffer('commentTimeline');
    registerSharedBuffer('connection');
    registerSharedBuffer('performanceEngineState');

    assert.deepEqual(JSON.parse(await m.getHiddenListeners()), users);
  });

  it('setListenerGreeted toggles per-stream greeted state and notifies via SSE', async function () {
    // listener が存在しなくても stream_listener_state には行が作れる (= per-stream の交差表)
    var setResp = JSON.parse(await m.setListenerGreeted('vid-test-1', 'UCalice', true));
    assert.equal(setResp.ok, true);
    assert.ok(setResp.greetedAt > 0, 'greetedAt should be > 0 when set');

    var clearResp = JSON.parse(await m.setListenerGreeted('vid-test-1', 'UCalice', false));
    assert.equal(clearResp.ok, true);
    assert.equal(clearResp.greetedAt, 0, 'greetedAt should be 0 when cleared');
  });

  it('setCommentResponded returns ok with respondedAt = 0 when comment id does not exist', async function () {
    var resp = JSON.parse(await m.setCommentResponded('non-existent-id', true));
    assert.equal(resp.ok, true);
    assert.equal(resp.respondedAt, 0, 'unknown id returns 0 (no row updated)');
  });

  it('updateGlobalCooldown (fire-and-forget)', function () {
    var result = m.updateGlobalCooldown(30, 5.0);
    assert.ok(result, 'updateGlobalCooldown returned');
  });

  it('updateGlobalCooldown persists into app-config and reloads on init', async function () {
    var configPath = path.join(TEST_DATA_DIR, 'app-config.json');
    m.updateGlobalCooldown(7, 1.5);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });

    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.globalCooldown, { maxEffects: 7, userInterval: 1.5 });

    await m.shutdownCore();
    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    registerSharedBuffer('reactionCounts');
    registerSharedBuffer('performanceLog');
    registerSharedBuffer('commentTimeline');
    registerSharedBuffer('connection');
    registerSharedBuffer('performanceEngineState');

    assert.deepEqual(JSON.parse(await m.getGlobalCooldown()), { maxEffects: 7, userInterval: 1.5 });
  });

  // --- AppConfig ---

  it('setAppRootDir (fire-and-forget)', function () {
    var result = m.setAppRootDir(__dirname);
    assert.ok(result, 'setAppRootDir returned');
  });

  it('getActiveScene', async function () {
    var result = JSON.parse(await m.getActiveScene());
    // 初期状態では null か空文字
    assert.ok(result !== undefined, 'getActiveScene returned');
  });

  // --- Backup ---

  it('getBackupList returns array', async function () {
    var list = JSON.parse(await m.getBackupList());
    assert.ok(Array.isArray(list), 'getBackupList returned array');
  });

  it('setBackupsDir persists custom dir and reset clears it', async function () {
    var configPath = path.join(TEST_DATA_DIR, 'app-config.json');
    var customDir = path.join(TEST_DATA_DIR, 'custom-backups');

    m.setBackupsDir(customDir);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    assert.equal(JSON.parse(await m.getBackupsDir()), customDir);

    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.backupsDir, customDir);

    await m.shutdownCore();
    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    registerSharedBuffer('reactionCounts');
    registerSharedBuffer('performanceLog');
    registerSharedBuffer('commentTimeline');
    registerSharedBuffer('connection');
    registerSharedBuffer('performanceEngineState');

    assert.equal(JSON.parse(await m.getBackupsDir()), customDir);

    m.setBackupsDir('');
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    assert.equal(JSON.parse(await m.getBackupsDir()), '');

    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.backupsDir, null);
  });

  it('deleteBackup rejects paths that escape into prefix-matching sibling directories', async function () {
    var siblingDir = path.join(TEST_DATA_DIR, 'backups-evil');
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'keep.txt'), 'safe');

    assert.equal(JSON.parse(await m.deleteBackup('../backups-evil')), false);
    assert.ok(fs.existsSync(path.join(siblingDir, 'keep.txt')));
  });

  // Phase 14 (66be526) で backup は 1 tar ファイル化された (= backups/<id>/ ディレクトリ形式廃止)。
  // 以下、 旧ディレクトリ形式向けの validation 検査 4 件は同一コードパス
  // (= backup-index.json に entry が無い → "(index)" error) に集約されたため redundant 化。
  // 削除し、 still-current な `is_path_inside` 検査を 1 件で代表する。
  // tar 形式特有の検査 (= entry path traversal / meta.json parse) は backup_manager.rs 内に
  // 存続するが、 test では tar fixture 構築が大袈裟なので別タスクで covered する。
  it('restoreBackup rejects path-escape via malicious backup-index.json filename', async function () {
    // 兄弟 dir に「盗まれる対象」 を置く
    var siblingDir = path.join(TEST_DATA_DIR, 'backups-evil');
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'evil.tar'), 'pwned');

    // 悪意ある index entry を backups dir に仕込む (filename が backups dir を escape する)
    var backupsDir = path.join(TEST_DATA_DIR, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    writeJson(path.join(backupsDir, 'backup-index.json'), {
      backups: [
        {
          id: 'evil-id',
          type: 'full',
          name: 'evil',
          reason: 'test',
          createdAt: new Date().toISOString(),
          items: { scenes: [], effects: [], plugins: [] },
          filename: '../backups-evil/evil.tar'
        }
      ]
    });

    // BackupManager は init 時に prune_legacy_index_entries で「filename が指す tar が
    // 存在する entry」 を残す。 上記 evil.tar は実在するので index に残り、 restoreBackup
    // 内の is_path_inside チェックで `不正なバックアップID` が返る経路を踏む。
    // 起動済みの core に新規 backup-index を読み直させるため setBackupsDir を経由。
    var prevDir = JSON.parse(await m.getBackupsDir());
    m.setBackupsDir(backupsDir);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });

    var result = JSON.parse(await m.restoreBackup('evil-id'));
    assert.deepEqual(result, { restored: false, error: '不正なバックアップID' });

    // restore 後も兄弟ファイルが無傷
    assert.ok(fs.existsSync(path.join(siblingDir, 'evil.tar')));

    // 後片付け
    m.setBackupsDir(prevDir);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  });

  // --- Preset ---

  it('getPresetList returns array', async function () {
    var list = JSON.parse(await m.getPresetList());
    assert.ok(Array.isArray(list), 'getPresetList returned array');
  });

  it('setCurrentPreset persists into app-config and reloads on init', async function () {
    var configPath = path.join(TEST_DATA_DIR, 'app-config.json');
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'presets', 'TestPreset'), { recursive: true });
    m.setCurrentPreset('TestPreset');
    await new Promise(function (resolve) { setTimeout(resolve, 20); });

    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.currentPreset, 'TestPreset');

    await m.shutdownCore();
    port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
    registerSharedBuffer('reactionCounts');
    registerSharedBuffer('performanceLog');
    registerSharedBuffer('commentTimeline');
    registerSharedBuffer('connection');
    registerSharedBuffer('performanceEngineState');

    assert.equal(JSON.parse(await m.getCurrentPreset()), 'TestPreset');
  });

  // --- HTTP Server (axum for OBS) ---

  it('axum health check via HTTP', async function () {
    var http = require('node:http');
    var result = await new Promise(function (resolve, reject) {
      http.get('http://127.0.0.1:' + port + '/api/health', function (res) {
        var body = '';
        res.on('data', function (chunk) { body += chunk; });
        res.on('end', function () {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
        });
      }).on('error', reject);
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.version, PACKAGE_VERSION);
  });

  // --- Cleanup ---

  it('deleteScene cleanup', async function () {
    await m.deleteScene('test-scene-1');
    var scenes = JSON.parse(await m.getScenes());
    assert.ok(!scenes.scenes['test-scene-1'], 'test-scene-1 cleaned up');
  });
});
