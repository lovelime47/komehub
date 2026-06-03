const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nativeRuntime = require('./native-module-runtime');
const helpers = require('./shared-memory-js-helpers');

const REACTION_KEYS = helpers.REACTION_COUNT_KEYS;
const PLUGINS_DIR = path.join(__dirname, '..', 'effects-overlay', 'plugins');
const TEST_DATA_DIR = path.join(os.tmpdir(), 'komehub-shared-memory-native-soak-' + Date.now());
const TEMP_NODE_PATH = path.join(TEST_DATA_DIR, 'komehub_core_runtime.node');
const PROFILE = readProfile();
const CONFIG = getProfileConfig(PROFILE);
const PERFORMANCE_SCENE_ID = PROFILE + '-scene';
const PERFORMANCE_ID = PROFILE + '-performance';

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function serializeError(err) {
  if (!err) return 'unknown error';
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function readProfile() {
  var profileIndex = process.argv.indexOf('--profile');
  if (profileIndex >= 0 && process.argv[profileIndex + 1]) {
    return process.argv[profileIndex + 1];
  }
  return process.env.SHARED_MEMORY_PROFILE || 'smoke';
}

function getProfileConfig(profile) {
  if (profile === 'soak') {
    return {
      name: 'soak',
      reactionIterations: 20000,
      performanceIterations: 1024,
      commentIterations: 6000,
      commentBatchSize: 24,
      commentTextRepeat: 220,
      reactionTimeoutMs: 20000,
      performanceTimeoutMs: 20000,
      commentTimeoutMs: 30000
    };
  }
  if (profile === 'smoke') {
    return {
      name: 'smoke',
      reactionIterations: 500,
      performanceIterations: 96,
      commentIterations: 2400,
      commentBatchSize: 24,
      commentTextRepeat: 220,
      reactionTimeoutMs: 10000,
      performanceTimeoutMs: 10000,
      commentTimeoutMs: 20000
    };
  }
  throw new Error('Unknown profile: ' + profile);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(label + ' returned invalid JSON: ' + serializeError(err));
  }
}

function registerSharedBuffer(nativeModule, name, validator) {
  var layout = parseJson(nativeModule.getSharedBufferLayout(name), 'getSharedBufferLayout(' + name + ')');
  assert.ok(validator(layout), 'unexpected shared buffer layout for ' + name);

  var buffer = Buffer.alloc(layout.totalBytes);
  var registration = parseJson(nativeModule.registerSharedBuffer(name, buffer), 'registerSharedBuffer(' + name + ')');
  assert.ok(!registration.error, 'shared buffer registration failed for ' + name + ': ' + (registration.error || 'unknown'));

  return {
    buffer: buffer,
    layout: layout
  };
}

async function waitForSnapshot(label, readSnapshot, predicate, timeoutMs) {
  var startedAt = Date.now();
  var lastSnapshot = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = readSnapshot();
    if (lastSnapshot && predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await sleep(20);
  }

  throw new Error(label + ' timed out. Last snapshot: ' + JSON.stringify(lastSnapshot));
}

function buildExpectedReactionCounts(iterations) {
  var counts = helpers.createEmptyReactionCountMap();
  var i;
  for (i = 0; i < iterations; i++) {
    var emoji = REACTION_KEYS[i % REACTION_KEYS.length];
    counts[emoji] += (i % 4) + 1;
  }
  return counts;
}

function buildLongCommentText(index) {
  return 'comment-' + index + '-' + 'x'.repeat(CONFIG.commentTextRepeat);
}

function buildLongCommentHtml(index) {
  return '<b>' + 'comment-html-' + index + '-' + 'y'.repeat(CONFIG.commentTextRepeat) + '</b>';
}

async function run() {
  var nativeModule;
  var reactionShared;
  var performanceShared;
  var commentShared;
  var connectionShared;
  var performanceEngineStateShared;
  var expectedReactionCounts;
  var reactionSnapshot;
  var performanceSnapshot;
  var commentSnapshot;
  var connectionSnapshot;
  var performanceEngineStateSnapshot;
  var i;

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'scenes'), { recursive: true });

  nativeRuntime.ensureNativeModuleBuilt();
  nativeModule = require(nativeRuntime.prepareNativeModulePath(TEMP_NODE_PATH));
  await nativeModule.init(TEST_DATA_DIR, PLUGINS_DIR);

  reactionShared = registerSharedBuffer(nativeModule, 'reactionCounts', helpers.isValidSharedLayout);
  performanceShared = registerSharedBuffer(nativeModule, 'performanceLog', helpers.isValidPerformanceLogLayout);
  commentShared = registerSharedBuffer(nativeModule, 'commentTimeline', helpers.isValidCommentTimelineLayout);
  connectionShared = registerSharedBuffer(nativeModule, 'connection', helpers.isValidConnectionStateLayout);
  performanceEngineStateShared = registerSharedBuffer(nativeModule, 'performanceEngineState', helpers.isValidPerformanceEngineStateLayout);

  console.log('Running native shared-memory ' + CONFIG.name + ' check...');

  for (i = 0; i < CONFIG.reactionIterations; i++) {
    nativeModule.pushReaction(JSON.stringify({
      emoji: REACTION_KEYS[i % REACTION_KEYS.length],
      count: (i % 4) + 1
    }));
  }

  expectedReactionCounts = buildExpectedReactionCounts(CONFIG.reactionIterations);
  reactionSnapshot = await waitForSnapshot(
    'reaction snapshot',
    function () {
      return helpers.readReactionCountsFromSharedBuffer(reactionShared.buffer, reactionShared.layout);
    },
    function (snapshot) {
      return snapshot &&
        snapshot.revision >= CONFIG.reactionIterations &&
        JSON.stringify(snapshot.counts) === JSON.stringify(expectedReactionCounts);
    },
    CONFIG.reactionTimeoutMs
  );

  assert.deepEqual(reactionSnapshot.counts, expectedReactionCounts);
  console.log('Reaction soak passed:', reactionSnapshot.revision, 'updates');

  nativeModule.pushConnectionState(true, 'video-' + CONFIG.name);
  connectionSnapshot = await waitForSnapshot(
    'connection snapshot',
    function () {
      return helpers.readConnectionStateFromSharedBuffer(connectionShared.buffer, connectionShared.layout);
    },
    function (snapshot) {
      return snapshot &&
        snapshot.data.connected === true &&
        snapshot.data.videoId === ('video-' + CONFIG.name);
    },
    CONFIG.reactionTimeoutMs
  );

  assert.equal(connectionSnapshot.data.connected, true);
  assert.equal(connectionSnapshot.data.videoId, 'video-' + CONFIG.name);
  console.log('Connection soak passed:', connectionSnapshot.revision, 'updates');

  nativeModule.setPaused(true);
  performanceEngineStateSnapshot = await waitForSnapshot(
    'performance engine state snapshot',
    function () {
      return helpers.readPerformanceEngineStateFromSharedBuffer(
        performanceEngineStateShared.buffer,
        performanceEngineStateShared.layout
      );
    },
    function (snapshot) {
      return snapshot && snapshot.data === 'paused';
    },
    CONFIG.performanceTimeoutMs
  );
  assert.equal(performanceEngineStateSnapshot.data, 'paused');

  nativeModule.setPaused(false);
  performanceEngineStateSnapshot = await waitForSnapshot(
    'performance engine state resume snapshot',
    function () {
      return helpers.readPerformanceEngineStateFromSharedBuffer(
        performanceEngineStateShared.buffer,
        performanceEngineStateShared.layout
      );
    },
    function (snapshot) {
      return snapshot && snapshot.data === 'running' && snapshot.revision >= 2;
    },
    CONFIG.performanceTimeoutMs
  );
  assert.equal(performanceEngineStateSnapshot.data, 'running');
  console.log('Performance engine state soak passed:', performanceEngineStateSnapshot.revision, 'updates');

  await nativeModule.createScene(PERFORMANCE_SCENE_ID, 'Shared Memory Soak Scene');
  await nativeModule.savePerformance(PERFORMANCE_SCENE_ID, JSON.stringify({
    id: PERFORMANCE_ID,
    name: 'Shared Memory Soak Performance',
    enabled: true,
    trigger: { type: 'keyword', value: 'soak' },
    effect: 'cracker'
  }));
  nativeModule.updateGlobalCooldown(10000, 0);

  for (i = 0; i < CONFIG.performanceIterations; i++) {
    await nativeModule.triggerTestWithContext(PERFORMANCE_SCENE_ID, PERFORMANCE_ID, JSON.stringify({
      comment: 'trigger-' + i,
      userName: 'user-' + (i % 11)
    }));
  }

  performanceSnapshot = await waitForSnapshot(
    'performance snapshot',
    function () {
      return helpers.readPerformanceLogEntriesFromSharedBuffer(performanceShared.buffer, performanceShared.layout, 0);
    },
    function (snapshot) {
      return snapshot &&
        snapshot.nextCursor === (CONFIG.performanceIterations + 1) &&
        snapshot.entries.length === Math.min(CONFIG.performanceIterations, helpers.PERFORMANCE_LOG_CAPACITY) &&
        snapshot.entries[0].cursor === Math.max(1, (CONFIG.performanceIterations + 1) - helpers.PERFORMANCE_LOG_CAPACITY) &&
        snapshot.entries[snapshot.entries.length - 1].cursor === CONFIG.performanceIterations;
    },
    CONFIG.performanceTimeoutMs
  );

  assert.equal(performanceSnapshot.droppedCount, Math.max(0, CONFIG.performanceIterations - helpers.PERFORMANCE_LOG_CAPACITY));
  assert.equal(performanceSnapshot.entries[0].sceneId, PERFORMANCE_SCENE_ID);
  assert.equal(performanceSnapshot.entries[0].performanceId, PERFORMANCE_ID);
  assert.equal(performanceSnapshot.entries[0].hasContext, true);
  assert.equal(performanceSnapshot.entries[performanceSnapshot.entries.length - 1].cursor, CONFIG.performanceIterations);
  console.log('Performance soak passed:', performanceSnapshot.nextCursor - 1, 'entries');

  for (i = 0; i < CONFIG.commentIterations; i += CONFIG.commentBatchSize) {
    var batch = [];
    var j;

    for (j = 0; j < CONFIG.commentBatchSize && i + j < CONFIG.commentIterations; j++) {
      var index = i + j + 1;
      batch.push({
        id: 'comment-' + index,
        name: 'user-' + (index % 31),
        comment: buildLongCommentText(index),
        commentHtml: buildLongCommentHtml(index),
        profileImage: 'https://example.com/u/' + (index % 17) + '.png',
        timestamp: '2026-03-19T12:' + String(index % 60).padStart(2, '0') + ':00Z',
        hasGift: index % 13 === 0,
        amount: index % 13 === 0 ? index * 10 : 0,
        currency: index % 13 === 0 ? 'JPY' : '',
        stickerImage: index % 5 === 0 ? 'https://example.com/sticker/' + index + '.png' : '',
        isMember: index % 3 === 0,
        memberMonths: index % 48,
        isMembership: index % 9 === 0,
        membershipHeader: index % 9 === 0 ? 'Membership milestone ' + index : '',
        isMembershipGift: index % 10 === 0,
        giftCount: index % 10 === 0 ? (index % 4) + 1 : 0
      });
    }

    nativeModule.pushComments(JSON.stringify(batch));
  }

  commentSnapshot = await waitForSnapshot(
    'comment snapshot',
    function () {
      return helpers.readCommentTimelineEntriesFromSharedBuffer(commentShared.buffer, commentShared.layout, 0);
    },
    function (snapshot) {
      var expectedFirstCursor;
      var lastEntry;
      if (!snapshot || snapshot.entries.length !== helpers.COMMENT_TIMELINE_CAPACITY) return false;
      expectedFirstCursor = (CONFIG.commentIterations - helpers.COMMENT_TIMELINE_CAPACITY) + 1;
      lastEntry = snapshot.entries[snapshot.entries.length - 1];
      return snapshot.nextCursor === (CONFIG.commentIterations + 1) &&
        snapshot.entries[0].cursor === expectedFirstCursor &&
        lastEntry.cursor === CONFIG.commentIterations &&
        lastEntry.id === 'comment-' + CONFIG.commentIterations;
    },
    CONFIG.commentTimeoutMs
  );

  assert.equal(commentSnapshot.droppedCount, CONFIG.commentIterations - helpers.COMMENT_TIMELINE_CAPACITY);
  assert.equal(commentSnapshot.entries[0].id, 'comment-' + ((CONFIG.commentIterations - helpers.COMMENT_TIMELINE_CAPACITY) + 1));
  assert.equal(commentSnapshot.entries[commentSnapshot.entries.length - 1].comment, buildLongCommentText(CONFIG.commentIterations));
  console.log('Comment soak passed:', commentSnapshot.nextCursor - 1, 'entries');

  console.log('Native shared-memory ' + CONFIG.name + ' completed successfully.');
}

(async function main() {
  var exitCode = 0;

  try {
    await run();
  } catch (err) {
    exitCode = 1;
    console.error(serializeError(err));
  } finally {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (cleanupError) {
      if (cleanupError && cleanupError.code !== 'EPERM') {
        console.error('cleanup failed:', serializeError(cleanupError));
        exitCode = 1;
      }
    }

    process.exit(exitCode);
  }
})();
