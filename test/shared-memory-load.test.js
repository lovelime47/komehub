const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./shared-memory-js-helpers');
const REACTION_KEYS = ['heart', 'smile', 'celebration', 'surprise', 'hundred'];

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

function buildReactionCounts(iteration) {
  return {
    heart: iteration,
    smile: iteration * 2,
    celebration: iteration * 3,
    surprise: iteration * 4,
    hundred: iteration * 5
  };
}

function writeReactionSnapshot(buffer, layout, revision, counts) {
  var activeIndex = revision % 2;
  var baseOffset = layout.bufferOffsets[activeIndex];
  var i;

  buffer.writeUInt32LE(1, layout.writerStateOffset);
  for (i = 0; i < REACTION_KEYS.length; i++) {
    buffer.writeBigUInt64LE(BigInt(counts[REACTION_KEYS[i]]), baseOffset + (i * layout.slotStrideBytes));
  }
  buffer.writeUInt32LE(activeIndex, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(revision, layout.revisionOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
}

function writePerformanceEntry(buffer, layout, state, entry) {
  var inactiveIndex = state.activeBufferIndex === 0 ? 1 : 0;
  var baseOffset = layout.bufferOffsets[inactiveIndex];
  var arenaCursor = 0;
  var i;

  state.activeEntries.push(entry);
  if (state.activeEntries.length > layout.capacity) {
    state.activeEntries.shift();
    state.droppedCount += 1;
  }

  buffer.writeUInt32LE(1, layout.writerStateOffset);
  buffer.fill(0, baseOffset, baseOffset + layout.bufferStrideBytes);

  for (i = 0; i < state.activeEntries.length; i++) {
    var current = state.activeEntries[i];
    var recordOffset = baseOffset + layout.recordsOffset + (i * layout.recordStrideBytes);
    var payload = JSON.stringify({
      sceneId: current.sceneId,
      performanceId: current.performanceId,
      effect: { id: current.effectId, type: current.effectType },
      assets: current.assets || [],
      sounds: current.sounds || [],
      context: current.hasContext ? (current.context || { userName: 'load-test' }) : undefined
    });
    var payloadLength = Buffer.byteLength(payload, 'utf8');

    buffer.writeUInt32LE(current.cursor, recordOffset + layout.cursorOffset);
    buffer.writeUInt32LE(current.hasContext ? 1 : 0, recordOffset + layout.flagsOffset);
    buffer.write(current.sceneId, recordOffset + layout.sceneIdOffset, 'utf8');
    buffer.write(current.performanceId, recordOffset + layout.performanceIdOffset, 'utf8');
    buffer.write(current.effectId, recordOffset + layout.effectIdOffset, 'utf8');
    buffer.write(current.effectType, recordOffset + layout.effectTypeOffset, 'utf8');
    buffer.write(payload, baseOffset + layout.arenaOffset + arenaCursor, 'utf8');
    buffer.writeUInt32LE(arenaCursor, recordOffset + layout.payloadOffset);
    buffer.writeUInt32LE(payloadLength, recordOffset + layout.payloadOffset + 4);
    arenaCursor += payloadLength;
  }

  state.nextCursor = entry.cursor + 1;
  state.revision += 1;
  state.activeBufferIndex = inactiveIndex;

  buffer.writeUInt32LE(0, baseOffset + layout.headOffset);
  buffer.writeUInt32LE(state.activeEntries.length % layout.capacity, baseOffset + layout.tailOffset);
  buffer.writeUInt32LE(state.activeEntries.length, baseOffset + layout.entryCountOffset);
  buffer.writeUInt32LE(state.nextCursor, baseOffset + layout.nextCursorOffset);
  buffer.writeUInt32LE(state.droppedCount, baseOffset + layout.droppedCountOffset);
  buffer.writeUInt32LE(arenaCursor, baseOffset + layout.arenaUsedBytesOffset);
  buffer.writeUInt32LE(inactiveIndex, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(state.revision, layout.revisionOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
}

function writeArenaRef(buffer, recordOffset, fieldOffset, text, arenaState, layout, baseOffset) {
  var byteLength = Buffer.byteLength(text, 'utf8');
  var textOffset = baseOffset + layout.arenaOffset + arenaState.cursor;

  buffer.write(text, textOffset, 'utf8');
  buffer.writeUInt32LE(arenaState.cursor, recordOffset + fieldOffset);
  buffer.writeUInt32LE(byteLength, recordOffset + fieldOffset + 4);
  arenaState.cursor += byteLength;
}

function writeCommentRecord(buffer, layout, baseOffset, physicalIndex, entry, arenaState) {
  var recordOffset = baseOffset + layout.recordsOffset + (physicalIndex * layout.recordStrideBytes);
  var flags = 0;

  buffer.fill(0, recordOffset, recordOffset + layout.recordStrideBytes);
  if (entry.hasGift) flags |= 1;
  if (entry.isMember) flags |= 2;
  if (entry.isMembership) flags |= 4;
  if (entry.isMembershipGift) flags |= 8;

  buffer.writeUInt32LE(entry.cursor, recordOffset + layout.cursorOffset);
  buffer.writeUInt32LE(flags, recordOffset + layout.flagsOffset);
  buffer.writeUInt32LE(entry.memberMonths, recordOffset + layout.memberMonthsOffset);
  buffer.writeUInt32LE(entry.giftCount, recordOffset + layout.giftCountOffset);
  buffer.writeDoubleLE(entry.amount, recordOffset + layout.amountOffset);

  writeArenaRef(buffer, recordOffset, layout.idOffset, entry.id, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.nameOffset, entry.name, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.commentOffset, entry.comment, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.commentHtmlOffset, entry.commentHtml, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.profileImageOffset, entry.profileImage, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.timestampOffset, entry.timestamp, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.currencyOffset, entry.currency, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.stickerImageOffset, entry.stickerImage, arenaState, layout, baseOffset);
  writeArenaRef(buffer, recordOffset, layout.membershipHeaderOffset, entry.membershipHeader, arenaState, layout, baseOffset);
}

function estimateCommentArenaBytes(entry) {
  return Buffer.byteLength(entry.id, 'utf8') +
    Buffer.byteLength(entry.name, 'utf8') +
    Buffer.byteLength(entry.comment, 'utf8') +
    Buffer.byteLength(entry.commentHtml, 'utf8') +
    Buffer.byteLength(entry.profileImage, 'utf8') +
    Buffer.byteLength(entry.timestamp, 'utf8') +
    Buffer.byteLength(entry.currency, 'utf8') +
    Buffer.byteLength(entry.stickerImage, 'utf8') +
    Buffer.byteLength(entry.membershipHeader, 'utf8');
}

function rebuildCommentBuffer(buffer, layout, state, activeEntries) {
  var inactiveIndex = state.activeBufferIndex === 0 ? 1 : 0;
  var baseOffset = layout.bufferOffsets[inactiveIndex];
  var arenaState = { cursor: 0 };
  var i;

  buffer.writeUInt32LE(1, layout.writerStateOffset);
  buffer.fill(0, baseOffset, baseOffset + layout.bufferStrideBytes);

  for (i = 0; i < activeEntries.length; i++) {
    writeCommentRecord(buffer, layout, baseOffset, i, activeEntries[i], arenaState);
  }

  state.revision += 1;
  state.activeBufferIndex = inactiveIndex;

  buffer.writeUInt32LE(0, baseOffset + layout.headOffset);
  buffer.writeUInt32LE(activeEntries.length % layout.capacity, baseOffset + layout.tailOffset);
  buffer.writeUInt32LE(activeEntries.length, baseOffset + layout.entryCountOffset);
  buffer.writeUInt32LE(state.nextCursor, baseOffset + layout.nextCursorOffset);
  buffer.writeUInt32LE(state.droppedCount, baseOffset + layout.droppedCountOffset);
  buffer.writeUInt32LE(arenaState.cursor, baseOffset + layout.arenaUsedBytesOffset);
  buffer.writeUInt32LE(inactiveIndex, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(state.revision, layout.revisionOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
}

function writeCommentEntry(buffer, layout, state, activeEntries, entry) {
  if (activeEntries.length === layout.capacity) {
    activeEntries.shift();
    state.droppedCount += 1;
  }
  activeEntries.push(entry);
  state.nextCursor = entry.cursor + 1;
  rebuildCommentBuffer(buffer, layout, state, activeEntries);
}

function writePerformanceEngineStateSnapshot(buffer, layout, revision, stateCode) {
  var activeIndex = revision % 2;
  var baseOffset = layout.bufferOffsets[activeIndex];
  buffer.writeUInt32LE(1, layout.writerStateOffset);
  buffer.writeUInt32LE(activeIndex, layout.activeBufferIndexOffset);
  buffer.writeUInt32LE(stateCode, baseOffset + layout.stateOffset);
  buffer.writeUInt32LE(revision, layout.revisionOffset);
  buffer.writeUInt32LE(0, layout.writerStateOffset);
}

test('shared memory reaction reader survives repeated buffer flips', function () {
  var layout = createReactionCountsLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var iteration;

  for (iteration = 1; iteration <= 20000; iteration++) {
    var counts = buildReactionCounts(iteration);
    writeReactionSnapshot(buffer, layout, iteration, counts);

    var snapshot = helpers.readReactionCountsFromSharedBuffer(buffer, layout);
    assert.ok(snapshot);
    assert.equal(snapshot.source, 'sharedMemory');
    assert.equal(snapshot.revision, iteration);
    assert.deepEqual(snapshot.counts, counts);
    assert.equal(snapshot.total, iteration * 15);
  }
});

test('shared memory performance reader survives repeated ring writes', function () {
  var layout = createPerformanceLogLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var state = {
    activeBufferIndex: 0,
    activeEntries: [],
    nextCursor: 1,
    droppedCount: 0,
    revision: 0
  };
  var lastCursor = 0;
  var iteration;

  for (iteration = 1; iteration <= 2000; iteration++) {
    var entry = {
      cursor: state.nextCursor,
      sceneId: 'scene-' + (iteration % 7),
      performanceId: 'perf-' + iteration,
      effectId: 'fx-' + (iteration % 13),
      effectType: iteration % 2 === 0 ? 'rise' : 'fall',
      hasContext: iteration % 3 === 0,
      assets: ['asset-' + iteration],
      sounds: ['sound-' + iteration + '.wav'],
      context: iteration % 3 === 0 ? { userName: 'user-' + iteration } : undefined
    };

    writePerformanceEntry(buffer, layout, state, entry);

    var snapshot = helpers.readPerformanceLogEntriesFromSharedBuffer(buffer, layout, lastCursor);
    assert.ok(snapshot);
    assert.equal(snapshot.source, 'sharedMemory');
    assert.equal(snapshot.entries.length, 1);
    var expectedEntry = {
      cursor: entry.cursor,
      sceneId: entry.sceneId,
      performanceId: entry.performanceId,
      effect: { id: entry.effectId, type: entry.effectType },
      assets: entry.assets,
      sounds: entry.sounds,
      effectId: entry.effectId,
      effectType: entry.effectType,
      hasContext: entry.hasContext
    };
    if (entry.context) {
      expectedEntry.context = entry.context;
    }
    assert.deepEqual(snapshot.entries[0], expectedEntry);
    assert.equal(snapshot.nextCursor, entry.cursor + 1);
    lastCursor = entry.cursor;
  }
});

test('shared memory comment reader survives repeated arena-backed writes', function () {
  var layout = createCommentTimelineLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var state = {
    activeBufferIndex: 0,
    nextCursor: 1,
    droppedCount: 0,
    revision: 0
  };
  var activeEntries = [];
  var lastCursor = 0;
  var iteration;

  for (iteration = 1; iteration <= 6000; iteration++) {
    var entry = {
      cursor: state.nextCursor,
      id: 'comment-' + iteration,
      name: 'user-' + (iteration % 17),
      comment: 'comment text ' + iteration,
      commentHtml: '<b>comment text ' + iteration + '</b>',
      profileImage: 'https://example.com/u/' + (iteration % 23) + '.png',
      timestamp: '2026-03-19T12:' + String(iteration % 60).padStart(2, '0') + ':00Z',
      hasGift: iteration % 11 === 0,
      amount: iteration % 11 === 0 ? iteration * 1.5 : 0,
      currency: iteration % 11 === 0 ? 'JPY' : '',
      stickerImage: iteration % 5 === 0 ? 'sticker-' + iteration : '',
      isMember: iteration % 4 === 0,
      memberMonths: iteration % 36,
      isMembership: iteration % 9 === 0,
      membershipHeader: iteration % 9 === 0 ? 'Member milestone ' + iteration : '',
      isMembershipGift: iteration % 10 === 0,
      giftCount: iteration % 10 === 0 ? (iteration % 3) + 1 : 0
    };

    writeCommentEntry(buffer, layout, state, activeEntries, entry);

    var snapshot = helpers.readCommentTimelineEntriesFromSharedBuffer(buffer, layout, lastCursor);
    assert.ok(snapshot);
    assert.equal(snapshot.source, 'sharedMemory');
    assert.equal(snapshot.entries.length, 1);
    assert.deepEqual(snapshot.entries[0], entry);
    assert.equal(snapshot.nextCursor, entry.cursor + 1);
    lastCursor = entry.cursor;
  }
});

test('shared memory performance engine state reader survives repeated fixed-state writes', function () {
  var layout = createPerformanceEngineStateLayout();
  var buffer = Buffer.alloc(layout.totalBytes);
  var iteration;

  for (iteration = 1; iteration <= 20000; iteration++) {
    var stateCode = iteration % helpers.PERFORMANCE_ENGINE_STATE_VALUES.length;
    writePerformanceEngineStateSnapshot(buffer, layout, iteration, stateCode);

    var snapshot = helpers.readPerformanceEngineStateFromSharedBuffer(buffer, layout);
    assert.ok(snapshot);
    assert.equal(snapshot.source, 'sharedMemory');
    assert.equal(snapshot.revision, iteration);
    assert.equal(snapshot.data, helpers.PERFORMANCE_ENGINE_STATE_VALUES[stateCode]);
  }
});
