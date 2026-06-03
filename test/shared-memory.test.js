const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./shared-memory-js-helpers');

function createReactionCountsLayout() {
  return {
    name: 'reactionCounts',
    totalBytes: 144,
    headerBytes: 64,
    slotCount: 5,
    slotStrideBytes: 8,
    bufferOffsets: [64, 104],
    activeBufferIndexOffset: 32,
    revisionOffset: 36,
    writerStateOffset: 40
  };
}

function createPerformanceLogLayout() {
  return {
    name: 'performanceLog',
    totalBytes: 2127984,
    headerBytes: 64,
    bufferStrideBytes: 1063960,
    activeBufferIndexOffset: 20,
    bufferOffsets: [64, 1064024],
    capacity: 64,
    recordStrideBytes: 240,
    recordsOffset: 24,
    headOffset: 0,
    tailOffset: 4,
    entryCountOffset: 8,
    nextCursorOffset: 12,
    droppedCountOffset: 16,
    revisionOffset: 24,
    writerStateOffset: 28,
    arenaOffset: 15384,
    arenaBytes: 1048576,
    arenaUsedBytesOffset: 20,
    cursorOffset: 0,
    flagsOffset: 4,
    sceneIdOffset: 8,
    sceneIdBytes: 64,
    performanceIdOffset: 72,
    performanceIdBytes: 64,
    effectIdOffset: 136,
    effectIdBytes: 64,
    effectTypeOffset: 200,
    effectTypeBytes: 32,
    payloadOffset: 232
  };
}

function createCommentTimelineLayout() {
  return {
    name: 'commentTimeline',
    totalBytes: 2289264,
    headerBytes: 64,
    bufferStrideBytes: 1144600,
    activeBufferIndexOffset: 20,
    bufferOffsets: [64, 1144664],
    capacity: 1000,
    recordStrideBytes: 96,
    recordsOffset: 24,
    headOffset: 0,
    tailOffset: 4,
    entryCountOffset: 8,
    nextCursorOffset: 12,
    droppedCountOffset: 16,
    revisionOffset: 24,
    writerStateOffset: 28,
    arenaOffset: 96024,
    arenaBytes: 1048576,
    arenaUsedBytesOffset: 20,
    cursorOffset: 0,
    flagsOffset: 4,
    memberMonthsOffset: 8,
    giftCountOffset: 12,
    amountOffset: 16,
    idOffset: 24,
    nameOffset: 32,
    commentOffset: 40,
    commentHtmlOffset: 48,
    profileImageOffset: 56,
    timestampOffset: 64,
    currencyOffset: 72,
    stickerImageOffset: 80,
    membershipHeaderOffset: 88
  };
}

function createConnectionLayout() {
  return {
    name: 'connection',
    totalBytes: 584,
    headerBytes: 64,
    bufferStrideBytes: 260,
    activeBufferIndexOffset: 20,
    bufferOffsets: [64, 324],
    connectedOffset: 0,
    videoIdBytes: 256,
    revisionOffset: 24,
    writerStateOffset: 28,
    videoIdOffset: 4
  };
}

function createPerformanceEngineStateLayout() {
  return {
    name: 'performanceEngineState',
    totalBytes: 72,
    headerBytes: 64,
    bufferStrideBytes: 4,
    activeBufferIndexOffset: 20,
    bufferOffsets: [64, 68],
    stateOffset: 0,
    revisionOffset: 24,
    writerStateOffset: 28
  };
}

test('shared memory reaction snapshot reads active buffer', function () {
  var layout = createReactionCountsLayout();
  var buffer = Buffer.alloc(layout.totalBytes);

  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(7, layout.revisionOffset);
  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);

  buffer.writeBigUInt64LE(11n, layout.bufferOffsets[1] + (0 * layout.slotStrideBytes));
  buffer.writeBigUInt64LE(12n, layout.bufferOffsets[1] + (1 * layout.slotStrideBytes));
  buffer.writeBigUInt64LE(13n, layout.bufferOffsets[1] + (2 * layout.slotStrideBytes));
  buffer.writeBigUInt64LE(14n, layout.bufferOffsets[1] + (3 * layout.slotStrideBytes));
  buffer.writeBigUInt64LE(15n, layout.bufferOffsets[1] + (4 * layout.slotStrideBytes));

  var snapshot = helpers.readReactionCountsFromSharedBuffer(buffer, layout);
  assert.deepEqual(snapshot, {
    counts: {
      heart: 11,
      smile: 12,
      celebration: 13,
      surprise: 14,
      hundred: 15
    },
    total: 65,
    source: 'sharedMemory',
    revision: 7
  });
});

test('shared memory reaction snapshot keeps reading active buffer during inactive write', function () {
  var layout = createReactionCountsLayout();
  var buffer = Buffer.alloc(layout.totalBytes);

  buffer.writeUInt32LE(1, layout.writerStateOffset);
  buffer.writeUInt32LE(3, layout.revisionOffset);
  buffer.writeUInt32LE(0, layout.activeBufferIndexOffset);
  buffer.writeBigUInt64LE(9n, layout.bufferOffsets[0] + (0 * layout.slotStrideBytes));

  assert.equal(helpers.readReactionCountsFromSharedBuffer(buffer, layout).counts.heart, 9);
});

test('reaction count mirror applies aggregated reaction counts', function () {
  var counts = helpers.createEmptyReactionCountMap();
  helpers.applyReactionToCountMap(counts, { emoji: 'heart', count: 4 });
  helpers.applyReactionToCountMap(counts, { emoji: 'surprise', count: 2 });

  assert.deepEqual(helpers.buildReactionCountSnapshot(counts, 'mirror', 0), {
    counts: {
      heart: 4,
      smile: 0,
      celebration: 0,
      surprise: 2,
      hundred: 0
    },
    total: 6,
    source: 'mirror',
    revision: 0
  });
});

test('shared memory connection snapshot reads fixed state', function () {
  var layout = createConnectionLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var baseOffset = layout.bufferOffsets[1];

  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.connectedOffset);
  buffer.writeUInt32LE(9, layout.revisionOffset);
  buffer.write('video-123', baseOffset + layout.videoIdOffset, 'utf8');

  var snapshot = helpers.readConnectionStateFromSharedBuffer(buffer, layout);
  assert.deepEqual(snapshot, {
    data: {
      connected: true,
      videoId: 'video-123'
    },
    source: 'sharedMemory',
    revision: 9
  });
});

test('shared memory connection snapshot keeps reading active buffer during inactive write', function () {
  var layout = createConnectionLayout();
  var buffer = Buffer.alloc(layout.totalBytes);

  buffer.writeUInt32LE(0, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(1, layout.writerStateOffset);
  buffer.writeUInt32LE(1, layout.revisionOffset);
  buffer.writeUInt32LE(1, layout.bufferOffsets[0] + layout.connectedOffset);
  buffer.write('video-123', layout.bufferOffsets[0] + layout.videoIdOffset, 'utf8');
  assert.equal(helpers.readConnectionStateFromSharedBuffer(buffer, layout).data.videoId, 'video-123');
});

test('shared memory performance engine state snapshot reads fixed state', function () {
  var layout = createPerformanceEngineStateLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var baseOffset = layout.bufferOffsets[1];

  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(2, baseOffset + layout.stateOffset);
  buffer.writeUInt32LE(4, layout.revisionOffset);

  var snapshot = helpers.readPerformanceEngineStateFromSharedBuffer(buffer, layout);
  assert.deepEqual(snapshot, {
    data: 'paused',
    source: 'sharedMemory',
    revision: 4
  });
});

test('shared memory performance engine state snapshot keeps reading active buffer during inactive write', function () {
  var layout = createPerformanceEngineStateLayout();
  var buffer = Buffer.alloc(layout.totalBytes);

  buffer.writeUInt32LE(0, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(1, layout.writerStateOffset);
  buffer.writeUInt32LE(1, layout.revisionOffset);
  buffer.writeUInt32LE(2, layout.bufferOffsets[0] + layout.stateOffset);
  assert.equal(helpers.readPerformanceEngineStateFromSharedBuffer(buffer, layout).data, 'paused');
});

test('shared memory performance log snapshot reads new entries after cursor', function () {
  var layout = createPerformanceLogLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var baseOffset = layout.bufferOffsets[1];
  var arenaCursor = 0;

  function writePerformancePayload(recordOffset, payload) {
    var json = JSON.stringify(payload);
    var byteLength = Buffer.byteLength(json, 'utf8');
    buffer.write(json, baseOffset + layout.arenaOffset + arenaCursor, 'utf8');
    buffer.writeUInt32LE(arenaCursor, recordOffset + layout.payloadOffset);
    buffer.writeUInt32LE(byteLength, recordOffset + layout.payloadOffset + 4);
    arenaCursor += byteLength;
  }

  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(5, layout.revisionOffset);
  buffer.writeUInt32LE(2, baseOffset + layout.entryCountOffset);
  buffer.writeUInt32LE(3, baseOffset + layout.nextCursorOffset);
  buffer.writeUInt32LE(0, baseOffset + layout.droppedCountOffset);

  buffer.writeUInt32LE(1, baseOffset + layout.recordsOffset + layout.cursorOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.recordsOffset + layout.flagsOffset);
  buffer.write('scene-a', baseOffset + layout.recordsOffset + layout.sceneIdOffset, 'utf8');
  buffer.write('perf-1', baseOffset + layout.recordsOffset + layout.performanceIdOffset, 'utf8');
  buffer.write('fx-1', baseOffset + layout.recordsOffset + layout.effectIdOffset, 'utf8');
  buffer.write('firework', baseOffset + layout.recordsOffset + layout.effectTypeOffset, 'utf8');
  writePerformancePayload(baseOffset + layout.recordsOffset, {
    sceneId: 'scene-a',
    performanceId: 'perf-1',
    effect: { id: 'fx-1', type: 'firework' },
    assets: [],
    sounds: [],
    context: { userName: 'alice' }
  });

  var secondOffset = baseOffset + layout.recordsOffset + layout.recordStrideBytes;
  buffer.writeUInt32LE(2, secondOffset + layout.cursorOffset);
  buffer.writeUInt32LE(0, secondOffset + layout.flagsOffset);
  buffer.write('scene-b', secondOffset + layout.sceneIdOffset, 'utf8');
  buffer.write('perf-2', secondOffset + layout.performanceIdOffset, 'utf8');
  buffer.write('fx-2', secondOffset + layout.effectIdOffset, 'utf8');
  buffer.write('rise', secondOffset + layout.effectTypeOffset, 'utf8');
  writePerformancePayload(secondOffset, {
    sceneId: 'scene-b',
    performanceId: 'perf-2',
    effect: { id: 'fx-2', type: 'rise' },
    assets: ['spark'],
    sounds: ['rise.wav']
  });
  buffer.writeUInt32LE(arenaCursor, baseOffset + layout.arenaUsedBytesOffset);

  var snapshot = helpers.readPerformanceLogEntriesFromSharedBuffer(buffer, layout, 1);
  assert.deepEqual(snapshot, {
    entries: [{
      cursor: 2,
      sceneId: 'scene-b',
      performanceId: 'perf-2',
      effect: { id: 'fx-2', type: 'rise' },
      assets: ['spark'],
      sounds: ['rise.wav'],
      effectId: 'fx-2',
      effectType: 'rise',
      hasContext: false
    }],
    nextCursor: 3,
    droppedCount: 0,
    source: 'sharedMemory',
    revision: 5
  });
});

test('shared memory performance log snapshot respects head when ring wrapped', function () {
  var layout = createPerformanceLogLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var baseOffset = layout.bufferOffsets[1];
  var arenaCursor = 0;

  function writePerformancePayload(recordOffset, payload) {
    var json = JSON.stringify(payload);
    var byteLength = Buffer.byteLength(json, 'utf8');
    buffer.write(json, baseOffset + layout.arenaOffset + arenaCursor, 'utf8');
    buffer.writeUInt32LE(arenaCursor, recordOffset + layout.payloadOffset);
    buffer.writeUInt32LE(byteLength, recordOffset + layout.payloadOffset + 4);
    arenaCursor += byteLength;
  }

  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(8, layout.revisionOffset);
  buffer.writeUInt32LE(63, baseOffset + layout.headOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.tailOffset);
  buffer.writeUInt32LE(2, baseOffset + layout.entryCountOffset);
  buffer.writeUInt32LE(4, baseOffset + layout.nextCursorOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.droppedCountOffset);

  var wrappedOffset = baseOffset + layout.recordsOffset + (63 * layout.recordStrideBytes);
  buffer.writeUInt32LE(2, wrappedOffset + layout.cursorOffset);
  buffer.write('scene-b', wrappedOffset + layout.sceneIdOffset, 'utf8');
  buffer.write('perf-2', wrappedOffset + layout.performanceIdOffset, 'utf8');
  buffer.write('fx-2', wrappedOffset + layout.effectIdOffset, 'utf8');
  buffer.write('rise', wrappedOffset + layout.effectTypeOffset, 'utf8');
  writePerformancePayload(wrappedOffset, {
    sceneId: 'scene-b',
    performanceId: 'perf-2',
    effect: { id: 'fx-2', type: 'rise' },
    assets: [],
    sounds: []
  });

  var zeroOffset = baseOffset + layout.recordsOffset;
  buffer.writeUInt32LE(3, zeroOffset + layout.cursorOffset);
  buffer.write('scene-c', zeroOffset + layout.sceneIdOffset, 'utf8');
  buffer.write('perf-3', zeroOffset + layout.performanceIdOffset, 'utf8');
  buffer.write('fx-3', zeroOffset + layout.effectIdOffset, 'utf8');
  buffer.write('fall', zeroOffset + layout.effectTypeOffset, 'utf8');
  writePerformancePayload(zeroOffset, {
    sceneId: 'scene-c',
    performanceId: 'perf-3',
    effect: { id: 'fx-3', type: 'fall' },
    assets: [],
    sounds: []
  });
  buffer.writeUInt32LE(arenaCursor, baseOffset + layout.arenaUsedBytesOffset);

  var snapshot = helpers.readPerformanceLogEntriesFromSharedBuffer(buffer, layout, 0);
  assert.deepEqual(snapshot.entries.map(function (entry) { return entry.cursor; }), [2, 3]);
});

test('performance dispatch classification treats empty snapshot as non-error', function () {
  assert.deepEqual(helpers.classifyPerformanceDispatchSnapshot({
    entries: [],
    nextCursor: 4,
    droppedCount: 0,
    source: 'sharedMemory',
    revision: 2
  }), {
    status: 'noEntries',
    entries: []
  });
});

test('performance dispatch classification treats null snapshot as error', function () {
  assert.deepEqual(helpers.classifyPerformanceDispatchSnapshot(null), {
    status: 'readFailed',
    entries: []
  });
});

test('shared memory comment timeline snapshot decodes arena-backed strings', function () {
  var layout = createCommentTimelineLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var baseOffset = layout.bufferOffsets[1];
  var arenaBase = baseOffset + layout.arenaOffset;
  var arenaCursor = 0;

  function writeArenaString(text) {
    var start = arenaCursor;
    buffer.write(text, arenaBase + start, 'utf8');
    arenaCursor += Buffer.byteLength(text, 'utf8');
    return { offset: start, length: Buffer.byteLength(text, 'utf8') };
  }

  function writeArenaRef(recordOffset, fieldOffset, text) {
    var ref = writeArenaString(text);
    buffer.writeUInt32LE(ref.offset, recordOffset + fieldOffset);
    buffer.writeUInt32LE(ref.length, recordOffset + fieldOffset + 4);
  }

  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(arenaCursor, baseOffset + layout.arenaUsedBytesOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(9, layout.revisionOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.entryCountOffset);
  buffer.writeUInt32LE(2, baseOffset + layout.nextCursorOffset);
  buffer.writeUInt32LE(0, baseOffset + layout.droppedCountOffset);

  var recordOffset = baseOffset + layout.recordsOffset;
  buffer.writeUInt32LE(1, recordOffset + layout.cursorOffset);
  buffer.writeUInt32LE(15, recordOffset + layout.flagsOffset);
  buffer.writeUInt32LE(6, recordOffset + layout.memberMonthsOffset);
  buffer.writeUInt32LE(3, recordOffset + layout.giftCountOffset);
  buffer.writeDoubleLE(1200.5, recordOffset + layout.amountOffset);
  writeArenaRef(recordOffset, layout.idOffset, 'comment-1');
  writeArenaRef(recordOffset, layout.nameOffset, 'alice');
  writeArenaRef(recordOffset, layout.commentOffset, 'hello');
  writeArenaRef(recordOffset, layout.commentHtmlOffset, '<b>hello</b>');
  writeArenaRef(recordOffset, layout.profileImageOffset, 'https://example.com/a.png');
  writeArenaRef(recordOffset, layout.timestampOffset, '12:34');
  writeArenaRef(recordOffset, layout.currencyOffset, 'JPY');
  writeArenaRef(recordOffset, layout.stickerImageOffset, 'https://example.com/sticker.png');
  writeArenaRef(recordOffset, layout.membershipHeaderOffset, 'Welcome');
  buffer.writeUInt32LE(arenaCursor, baseOffset + layout.arenaUsedBytesOffset);

  var snapshot = helpers.readCommentTimelineEntriesFromSharedBuffer(buffer, layout, 0);
  assert.deepEqual(snapshot, {
    entries: [{
      cursor: 1,
      id: 'comment-1',
      name: 'alice',
      comment: 'hello',
      commentHtml: '<b>hello</b>',
      profileImage: 'https://example.com/a.png',
      timestamp: '12:34',
      hasGift: true,
      amount: 1200.5,
      currency: 'JPY',
      stickerImage: 'https://example.com/sticker.png',
      isMember: true,
      memberMonths: 6,
      isMembership: true,
      membershipHeader: 'Welcome',
      isMembershipGift: true,
      giftCount: 3
    }],
    nextCursor: 2,
    droppedCount: 0,
    source: 'sharedMemory',
    revision: 9
  });
});

test('shared memory comment timeline snapshot respects head when ring wrapped', function () {
  var layout = createCommentTimelineLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var baseOffset = layout.bufferOffsets[1];
  var arenaBase = baseOffset + layout.arenaOffset;
  var arenaCursor = 0;

  function writeArenaString(text) {
    var start = arenaCursor;
    buffer.write(text, arenaBase + start, 'utf8');
    arenaCursor += Buffer.byteLength(text, 'utf8');
    return { offset: start, length: Buffer.byteLength(text, 'utf8') };
  }

  function writeArenaRef(recordOffset, fieldOffset, text) {
    var ref = writeArenaString(text);
    buffer.writeUInt32LE(ref.offset, recordOffset + fieldOffset);
    buffer.writeUInt32LE(ref.length, recordOffset + fieldOffset + 4);
  }

  buffer.writeUInt32LE(1, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
  buffer.writeUInt32LE(10, layout.revisionOffset);
  buffer.writeUInt32LE(999, baseOffset + layout.headOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.tailOffset);
  buffer.writeUInt32LE(2, baseOffset + layout.entryCountOffset);
  buffer.writeUInt32LE(4, baseOffset + layout.nextCursorOffset);
  buffer.writeUInt32LE(1, baseOffset + layout.droppedCountOffset);

  var wrappedOffset = baseOffset + layout.recordsOffset + (999 * layout.recordStrideBytes);
  buffer.writeUInt32LE(2, wrappedOffset + layout.cursorOffset);
  writeArenaRef(wrappedOffset, layout.idOffset, 'comment-2');
  writeArenaRef(wrappedOffset, layout.nameOffset, 'bob');
  writeArenaRef(wrappedOffset, layout.commentOffset, 'second');
  writeArenaRef(wrappedOffset, layout.commentHtmlOffset, 'second');
  writeArenaRef(wrappedOffset, layout.profileImageOffset, '');
  writeArenaRef(wrappedOffset, layout.timestampOffset, '');
  writeArenaRef(wrappedOffset, layout.currencyOffset, '');
  writeArenaRef(wrappedOffset, layout.stickerImageOffset, '');
  writeArenaRef(wrappedOffset, layout.membershipHeaderOffset, '');

  var zeroOffset = baseOffset + layout.recordsOffset;
  buffer.writeUInt32LE(3, zeroOffset + layout.cursorOffset);
  writeArenaRef(zeroOffset, layout.idOffset, 'comment-3');
  writeArenaRef(zeroOffset, layout.nameOffset, 'carol');
  writeArenaRef(zeroOffset, layout.commentOffset, 'third');
  writeArenaRef(zeroOffset, layout.commentHtmlOffset, 'third');
  writeArenaRef(zeroOffset, layout.profileImageOffset, '');
  writeArenaRef(zeroOffset, layout.timestampOffset, '');
  writeArenaRef(zeroOffset, layout.currencyOffset, '');
  writeArenaRef(zeroOffset, layout.stickerImageOffset, '');
  writeArenaRef(zeroOffset, layout.membershipHeaderOffset, '');
  buffer.writeUInt32LE(arenaCursor, baseOffset + layout.arenaUsedBytesOffset);

  var snapshot = helpers.readCommentTimelineEntriesFromSharedBuffer(buffer, layout, 0);
  assert.deepEqual(snapshot.entries.map(function (entry) { return entry.cursor; }), [2, 3]);
});
