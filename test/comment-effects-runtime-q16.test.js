const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const nativeRuntime = require('./native-module-runtime');

const TEST_DATA_DIR = path.join(os.tmpdir(), 'komehub-q16-runtime-' + Date.now());
// .node ファイルは TEST_DATA_DIR と別ディレクトリに置く。Windows でロード中の .node が
// 削除不能なため、TEST_DATA_DIR と同居させると test.after の rmSync が失敗する。
const NATIVE_MODULE_DIR = path.join(os.tmpdir(), 'komehub-q16-native-' + Date.now());
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const RUNTIME_NODE_PATH = path.join(NATIVE_MODULE_DIR, 'komehub_core_runtime.node');
const PREVIOUS_PUBLIC_HTTP_PORT = process.env.KOMEHUB_PUBLIC_HTTP_PORT;

let m;
let port;

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(label + ' returned invalid JSON: ' + error.message);
  }
}

// Windows でファイルハンドル解放の遅延を吸収するため指数バックオフで rmSync をリトライ
async function rmrfWithRetry(target, options) {
  options = options || {};
  const maxRetries = options.retries || 5;
  const baseDelay = options.baseDelay || 100;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (attempt === maxRetries - 1) {
        console.warn('Cleanup failed (non-fatal): ' + target + ' - ' + e.message);
        return false;
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, baseDelay * Math.pow(2, attempt));
      });
    }
  }
  return false;
}

function registerSharedBuffer(name) {
  const layout = parseJson(m.getSharedBufferLayout(name), 'getSharedBufferLayout(' + name + ')');
  const result = parseJson(
    m.registerSharedBuffer(name, Buffer.alloc(layout.totalBytes)),
    'registerSharedBuffer(' + name + ')'
  );
  assert.ok(!result.error, 'registered shared buffer ' + name);
}

function performanceSnapshot() {
  return parseJson(m.readPerformanceLogSnapshot(0), 'readPerformanceLogSnapshot');
}

async function waitFor(label, readValue, predicate, timeoutMs) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await readValue();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label + ' timed out. Last value: ' + JSON.stringify(lastValue));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function rawComment(id, body, overrides) {
  return Object.assign({
    id,
    userId: 'user-' + id,
    liveId: '',
    name: '@q16',
    displayName: '@q16',
    screenName: '',
    nickname: '',
    comment: body,
    commentHtml: body,
    speechText: '',
    profileImage: '',
    originalProfileImage: '',
    timestamp: '2026-05-04T12:00:00.000Z',
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
  }, overrides || {});
}

function pushComment(comment) {
  m.pushComments(JSON.stringify([comment]));
}

function countPerformance(snapshot, performanceId) {
  if (!snapshot || snapshot.error || !Array.isArray(snapshot.entries)) return 0;
  return snapshot.entries.filter((entry) => entry.performanceId === performanceId).length;
}

async function waitForPerformanceCount(performanceId, expectedCount, timeoutMs) {
  return waitFor(
    'performance ' + performanceId + ' count ' + expectedCount,
    () => performanceSnapshot(),
    (snapshot) => countPerformance(snapshot, performanceId) >= expectedCount,
    timeoutMs || 3000
  );
}

async function assertNoNewPerformance(performanceId, previousCount, waitMs) {
  await sleep(waitMs);
  assert.equal(
    countPerformance(performanceSnapshot(), performanceId),
    previousCount,
    performanceId + ' should not fire yet'
  );
}

function scenePerformance(id, trigger, extra) {
  return Object.assign({
    id,
    name: id,
    enabled: true,
    trigger,
    effect: 'cracker',
    cooldown: 0,
    duration: 220
  }, extra || {});
}

function httpSseUntil(urlPath, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const events = [];
    const req = http.get('http://127.0.0.1:' + port + urlPath, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let match = buffer.match(/\r?\n\r?\n/);
        while (match) {
          const splitIndex = match.index;
          const rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + match[0].length);
          const data = rawEvent.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!data) continue;
          const event = JSON.parse(data);
          events.push(event);
          if (predicate(event, events)) {
            cleanup();
            resolve(events);
            return;
          }
          match = buffer.match(/\r?\n\r?\n/);
        }
      });
    });
    req.on('error', (error) => {
      cleanup();
      reject(error);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SSE timed out for ' + urlPath + '. Events: ' + JSON.stringify(events)));
    }, timeoutMs || 3000);
    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
    }
  });
}

test.before(async function () {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(NATIVE_MODULE_DIR, { recursive: true });
  process.env.KOMEHUB_PUBLIC_HTTP_PORT = '0';
  nativeRuntime.ensureNativeModuleBuilt();
  m = require(nativeRuntime.prepareNativeModulePath(RUNTIME_NODE_PATH));
  port = await m.init(TEST_DATA_DIR, PLUGINS_DIR);
  registerSharedBuffer('performanceLog');
  registerSharedBuffer('performanceEngineState');
});

test.after(async function () {
  if (m && typeof m.shutdownCore === 'function') {
    await m.shutdownCore();
  }
  // TEST_DATA_DIR は WAL チェックポイント + shutdown 内 sleep で確実に削除可能
  await rmrfWithRetry(TEST_DATA_DIR);
  // NATIVE_MODULE_DIR の .node はプロセス内で load 中なので削除不可。OS の tmp 清掃に委ねる
  // (試みるが失敗してもログのみ、テストは fail しない)
  await rmrfWithRetry(NATIVE_MODULE_DIR);
  if (PREVIOUS_PUBLIC_HTTP_PORT == null) {
    delete process.env.KOMEHUB_PUBLIC_HTTP_PORT;
  } else {
    process.env.KOMEHUB_PUBLIC_HTTP_PORT = PREVIOUS_PUBLIC_HTTP_PORT;
  }
});

test('Q16 held runtime checks pass through global settings, queues, and scene SSE', async function () {
  const sceneId = 'q16-runtime-scene';
  const blockPerf = 'q16-block';
  const keywordPerf = 'q16-keyword';
  const manualPerf = 'q16-manual';
  const superchatPerf = 'q16-superchat';
  const pausedSuperchatPerf = 'q16-paused-superchat';

  const existingScenes = parseJson(await m.getScenes(), 'getScenes');
  await Promise.all(Object.keys(existingScenes.scenes || {}).map((sceneId) => m.setSceneEnabled(sceneId, false)));

  await m.createScene(sceneId, 'Q16 Runtime Verification');
  await m.savePerformance(sceneId, JSON.stringify(scenePerformance(
    blockPerf,
    { type: 'keyword', keywords: [{ text: 'q16-block' }] }
  )));
  await m.savePerformance(sceneId, JSON.stringify(scenePerformance(
    keywordPerf,
    { type: 'keyword', keywords: [{ text: 'q16-keyword' }] }
  )));
  await m.savePerformance(sceneId, JSON.stringify(scenePerformance(
    manualPerf,
    { type: 'manual' },
    { duration: 80 }
  )));
  await m.savePerformance(sceneId, JSON.stringify(scenePerformance(
    superchatPerf,
    { type: 'superchat', minAmount: 0, includeMembership: true },
    { duration: 80 }
  )));
  await m.savePerformance(sceneId, JSON.stringify(scenePerformance(
    pausedSuperchatPerf,
    { type: 'superchat', minAmount: 5000, includeMembership: true },
    { duration: 80 }
  )));

  m.updateGlobalCooldown(1, 0);
  await waitFor(
    'global cooldown persistence',
    async () => parseJson(await m.getGlobalCooldown(), 'getGlobalCooldown'),
    (settings) => settings.maxEffects === 1 && settings.userInterval === 0,
    1000
  );

  pushComment(rawComment('q16-block-1', 'q16-block'));
  await waitForPerformanceCount(blockPerf, 1);
  const keywordBeforeDrop = countPerformance(performanceSnapshot(), keywordPerf);
  pushComment(rawComment('q16-keyword-dropped', 'q16-keyword'));
  await assertNoNewPerformance(keywordPerf, keywordBeforeDrop, 120);
  await sleep(180);
  pushComment(rawComment('q16-keyword-fired', 'q16-keyword'));
  await waitForPerformanceCount(keywordPerf, keywordBeforeDrop + 1);

  await sleep(260);
  pushComment(rawComment('q16-block-2', 'q16-block'));
  await waitForPerformanceCount(blockPerf, 2);
  const manualBeforeQueue = countPerformance(performanceSnapshot(), manualPerf);
  m.triggerPerformance(sceneId, manualPerf);
  await assertNoNewPerformance(manualPerf, manualBeforeQueue, 120);
  await sleep(180);
  pushComment(rawComment('q16-flush-manual', 'no trigger'));
  await waitForPerformanceCount(manualPerf, manualBeforeQueue + 1);

  await sleep(260);
  pushComment(rawComment('q16-block-3', 'q16-block'));
  await waitForPerformanceCount(blockPerf, 3);
  const superchatBeforeQueue = countPerformance(performanceSnapshot(), superchatPerf);
  pushComment(rawComment('q16-superchat-queued', 'superchat waits', {
    hasGift: true,
    amount: 1000,
    currency: 'JPY',
    amountDisplay: '¥1,000'
  }));
  await assertNoNewPerformance(superchatPerf, superchatBeforeQueue, 120);
  await sleep(180);
  pushComment(rawComment('q16-flush-superchat', 'no trigger'));
  await waitForPerformanceCount(superchatPerf, superchatBeforeQueue + 1);
  await m.setPerformanceEnabled(sceneId, superchatPerf, false);

  await sleep(260);
  await m.setPaused(true);
  const pausedSuperchatBeforeQueue = countPerformance(performanceSnapshot(), pausedSuperchatPerf);
  const overlayWait = httpSseUntil(
    '/effects/' + sceneId + '/stream',
    (event) => event.type === 'performance' &&
      event.data &&
      event.data.performanceId === pausedSuperchatPerf,
    3000
  );
  await sleep(100);
  pushComment(rawComment('q16-paused-superchat', 'paused superchat waits', {
    hasGift: true,
    amount: 5000,
    currency: 'JPY',
    amountDisplay: '¥5,000'
  }));
  await assertNoNewPerformance(pausedSuperchatPerf, pausedSuperchatBeforeQueue, 120);
  await m.setPaused(false);
  await waitForPerformanceCount(pausedSuperchatPerf, pausedSuperchatBeforeQueue + 1);
  await overlayWait;
});
