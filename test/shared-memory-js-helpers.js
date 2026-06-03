var REACTION_COUNT_KEYS = ['heart', 'smile', 'celebration', 'surprise', 'hundred'];
var PERFORMANCE_LOG_CAPACITY = 64;
var COMMENT_TIMELINE_CAPACITY = 1000;
var CONNECTION_VIDEO_ID_BYTES = 256;
var PERFORMANCE_ENGINE_STATE_VALUES = ['initializing', 'running', 'paused', 'error', 'stopped'];

function createEmptyReactionCountMap() {
  return {
    heart: 0,
    smile: 0,
    celebration: 0,
    surprise: 0,
    hundred: 0
  };
}

function cloneReactionCountMap(source) {
  var clone = createEmptyReactionCountMap();
  var i;
  for (i = 0; i < REACTION_COUNT_KEYS.length; i++) {
    var key = REACTION_COUNT_KEYS[i];
    clone[key] = sanitizeReactionCount(source && source[key]);
  }
  return clone;
}

function sanitizeReactionCount(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function applyReactionToCountMap(target, reaction) {
  if (!target || !reaction || !reaction.emoji) return target;
  if (REACTION_COUNT_KEYS.indexOf(reaction.emoji) === -1) return target;
  var count = Object.prototype.hasOwnProperty.call(reaction, 'count') ? reaction.count : 1;
  target[reaction.emoji] += sanitizeReactionCount(count);
  return target;
}

function buildReactionCountSnapshot(counts, source, revision) {
  var normalized = cloneReactionCountMap(counts);
  var total = 0;
  var i;
  for (i = 0; i < REACTION_COUNT_KEYS.length; i++) {
    total += normalized[REACTION_COUNT_KEYS[i]];
  }
  return {
    counts: normalized,
    total: total,
    source: source || 'mirror',
    revision: sanitizeReactionCount(revision || 0)
  };
}

function buildPerformanceLogSnapshot(entries, nextCursor, droppedCount, source, revision) {
  return {
    entries: entries.slice(),
    nextCursor: sanitizeReactionCount(nextCursor || 0),
    droppedCount: sanitizeReactionCount(droppedCount || 0),
    source: source || 'mirror',
    revision: sanitizeReactionCount(revision || 0)
  };
}

function buildCommentTimelineSnapshot(entries, nextCursor, droppedCount, source, revision) {
  return {
    entries: entries.slice(),
    nextCursor: sanitizeReactionCount(nextCursor || 0),
    droppedCount: sanitizeReactionCount(droppedCount || 0),
    source: source || 'mirror',
    revision: sanitizeReactionCount(revision || 0)
  };
}

function createEmptyConnectionState() {
  return {
    connected: false,
    videoId: ''
  };
}

function cloneConnectionState(source) {
  return {
    connected: !!(source && source.connected),
    videoId: source && source.videoId ? String(source.videoId) : ''
  };
}

function buildConnectionStateSnapshot(state, source, revision) {
  return {
    data: cloneConnectionState(state),
    source: source || 'mirror',
    revision: sanitizeReactionCount(revision || 0)
  };
}

function createEmptyPerformanceEngineState() {
  return 'initializing';
}

function normalizePerformanceEngineState(value) {
  var normalized = value ? String(value).toLowerCase() : '';
  if (PERFORMANCE_ENGINE_STATE_VALUES.indexOf(normalized) >= 0) {
    return normalized;
  }
  return createEmptyPerformanceEngineState();
}

function buildPerformanceEngineStateSnapshot(state, source, revision) {
  return {
    data: normalizePerformanceEngineState(state),
    source: source || 'mirror',
    revision: sanitizeReactionCount(revision || 0)
  };
}

function isValidSharedLayout(layout) {
  return !!(
    layout &&
    layout.name === 'reactionCounts' &&
    layout.totalBytes > 0 &&
    layout.headerBytes > 0 &&
    layout.slotCount === REACTION_COUNT_KEYS.length &&
    layout.slotStrideBytes === 8 &&
    layout.bufferOffsets &&
    layout.bufferOffsets.length === 2 &&
    typeof layout.activeBufferIndexOffset === 'number' &&
    typeof layout.revisionOffset === 'number' &&
    typeof layout.writerStateOffset === 'number'
  );
}

function isValidPerformanceLogLayout(layout) {
  return !!(
    layout &&
    layout.name === 'performanceLog' &&
    layout.totalBytes > 0 &&
    layout.headerBytes > 0 &&
    typeof layout.bufferStrideBytes === 'number' &&
    typeof layout.activeBufferIndexOffset === 'number' &&
    layout.bufferOffsets &&
    layout.bufferOffsets.length === 2 &&
    layout.capacity === PERFORMANCE_LOG_CAPACITY &&
    typeof layout.recordStrideBytes === 'number' &&
    typeof layout.recordsOffset === 'number' &&
    typeof layout.headOffset === 'number' &&
    typeof layout.tailOffset === 'number' &&
    typeof layout.entryCountOffset === 'number' &&
    typeof layout.nextCursorOffset === 'number' &&
    typeof layout.droppedCountOffset === 'number' &&
    typeof layout.revisionOffset === 'number' &&
    typeof layout.writerStateOffset === 'number' &&
    typeof layout.arenaOffset === 'number' &&
    typeof layout.arenaBytes === 'number' &&
    typeof layout.arenaUsedBytesOffset === 'number' &&
    typeof layout.cursorOffset === 'number' &&
    typeof layout.flagsOffset === 'number' &&
    typeof layout.sceneIdOffset === 'number' &&
    typeof layout.sceneIdBytes === 'number' &&
    typeof layout.performanceIdOffset === 'number' &&
    typeof layout.performanceIdBytes === 'number' &&
    typeof layout.effectIdOffset === 'number' &&
    typeof layout.effectIdBytes === 'number' &&
    typeof layout.effectTypeOffset === 'number' &&
    typeof layout.effectTypeBytes === 'number' &&
    typeof layout.payloadOffset === 'number'
  );
}

function isValidCommentTimelineLayout(layout) {
  return !!(
    layout &&
    layout.name === 'commentTimeline' &&
    layout.totalBytes > 0 &&
    layout.headerBytes > 0 &&
    typeof layout.bufferStrideBytes === 'number' &&
    typeof layout.activeBufferIndexOffset === 'number' &&
    layout.bufferOffsets &&
    layout.bufferOffsets.length === 2 &&
    layout.capacity === COMMENT_TIMELINE_CAPACITY &&
    typeof layout.recordStrideBytes === 'number' &&
    typeof layout.recordsOffset === 'number' &&
    typeof layout.headOffset === 'number' &&
    typeof layout.tailOffset === 'number' &&
    typeof layout.entryCountOffset === 'number' &&
    typeof layout.nextCursorOffset === 'number' &&
    typeof layout.droppedCountOffset === 'number' &&
    typeof layout.revisionOffset === 'number' &&
    typeof layout.writerStateOffset === 'number' &&
    typeof layout.arenaOffset === 'number' &&
    typeof layout.arenaBytes === 'number' &&
    typeof layout.arenaUsedBytesOffset === 'number' &&
    typeof layout.cursorOffset === 'number' &&
    typeof layout.flagsOffset === 'number' &&
    typeof layout.memberMonthsOffset === 'number' &&
    typeof layout.giftCountOffset === 'number' &&
    typeof layout.amountOffset === 'number' &&
    typeof layout.idOffset === 'number' &&
    typeof layout.nameOffset === 'number' &&
    typeof layout.commentOffset === 'number' &&
    typeof layout.commentHtmlOffset === 'number' &&
    typeof layout.profileImageOffset === 'number' &&
    typeof layout.timestampOffset === 'number' &&
    typeof layout.currencyOffset === 'number' &&
    typeof layout.stickerImageOffset === 'number' &&
    typeof layout.membershipHeaderOffset === 'number'
  );
}

function isValidConnectionStateLayout(layout) {
  return !!(
    layout &&
    layout.name === 'connection' &&
    layout.totalBytes > 0 &&
    layout.headerBytes > 0 &&
    typeof layout.bufferStrideBytes === 'number' &&
    typeof layout.activeBufferIndexOffset === 'number' &&
    layout.bufferOffsets &&
    layout.bufferOffsets.length === 2 &&
    typeof layout.connectedOffset === 'number' &&
    typeof layout.videoIdOffset === 'number' &&
    typeof layout.videoIdBytes === 'number' &&
    typeof layout.revisionOffset === 'number' &&
    typeof layout.writerStateOffset === 'number'
  );
}

function isValidPerformanceEngineStateLayout(layout) {
  return !!(
    layout &&
    layout.name === 'performanceEngineState' &&
    layout.totalBytes > 0 &&
    layout.headerBytes > 0 &&
    typeof layout.bufferStrideBytes === 'number' &&
    typeof layout.activeBufferIndexOffset === 'number' &&
    layout.bufferOffsets &&
    layout.bufferOffsets.length === 2 &&
    typeof layout.stateOffset === 'number' &&
    typeof layout.revisionOffset === 'number' &&
    typeof layout.writerStateOffset === 'number'
  );
}

function readReactionCountsFromSharedBuffer(buffer, layout) {
  if (!Buffer.isBuffer(buffer) || !isValidSharedLayout(layout)) return null;
  if (buffer.length < layout.totalBytes) return null;

  var revisionBefore = buffer.readUInt32LE(layout.revisionOffset);
  var activeBufferIndex = buffer.readUInt32LE(layout.activeBufferIndexOffset);
  if (activeBufferIndex !== 0 && activeBufferIndex !== 1) return null;

  var bufferOffset = layout.bufferOffsets[activeBufferIndex];
  var counts = createEmptyReactionCountMap();
  var i;
  for (i = 0; i < REACTION_COUNT_KEYS.length; i++) {
    var slotOffset = bufferOffset + (i * layout.slotStrideBytes);
    counts[REACTION_COUNT_KEYS[i]] = sanitizeReactionCount(buffer.readBigUInt64LE(slotOffset));
  }
  var revisionAfter = buffer.readUInt32LE(layout.revisionOffset);
  if (revisionBefore !== revisionAfter) {
    return null;
  }

  return buildReactionCountSnapshot(counts, 'sharedMemory', revisionAfter);
}

function readNullTerminatedString(buffer, offset, byteLength) {
  var slice = buffer.subarray(offset, offset + byteLength);
  var zeroIndex = slice.indexOf(0);
  return slice.subarray(0, zeroIndex === -1 ? slice.length : zeroIndex).toString('utf8');
}

function readArenaString(buffer, arenaBaseOffset, offset, byteLength) {
  if (!byteLength) return '';
  return buffer
    .subarray(arenaBaseOffset + offset, arenaBaseOffset + offset + byteLength)
    .toString('utf8');
}

function readArenaRef(buffer, recordOffset, fieldOffset, arenaBaseOffset) {
  var textOffset = buffer.readUInt32LE(recordOffset + fieldOffset);
  var textLength = buffer.readUInt32LE(recordOffset + fieldOffset + 4);
  return readArenaString(buffer, arenaBaseOffset, textOffset, textLength);
}

function readPerformanceLogEntriesFromSharedBuffer(buffer, layout, cursor) {
  if (!Buffer.isBuffer(buffer) || !isValidPerformanceLogLayout(layout)) return null;
  if (buffer.length < layout.totalBytes) return null;

  var revisionBefore = buffer.readUInt32LE(layout.revisionOffset);
  var activeBufferIndex = buffer.readUInt32LE(layout.activeBufferIndexOffset);
  if (activeBufferIndex !== 0 && activeBufferIndex !== 1) return null;
  var baseOffset = layout.bufferOffsets[activeBufferIndex];
  var head = buffer.readUInt32LE(baseOffset + layout.headOffset);
  var entryCount = buffer.readUInt32LE(baseOffset + layout.entryCountOffset);
  var nextCursor = buffer.readUInt32LE(baseOffset + layout.nextCursorOffset);
  var droppedCount = buffer.readUInt32LE(baseOffset + layout.droppedCountOffset);
  var arenaUsedBytes = buffer.readUInt32LE(baseOffset + layout.arenaUsedBytesOffset);
  if (entryCount > layout.capacity || arenaUsedBytes > layout.arenaBytes) return null;

  var entries = [];
  var index;
  for (index = 0; index < entryCount; index++) {
    var physicalIndex = (head + index) % layout.capacity;
    var recordOffset = baseOffset + layout.recordsOffset + (physicalIndex * layout.recordStrideBytes);
    var entryCursor = buffer.readUInt32LE(recordOffset + layout.cursorOffset);
    if (entryCursor === 0 || entryCursor <= cursor) continue;

    var flags = buffer.readUInt32LE(recordOffset + layout.flagsOffset);
    var payloadJson = readArenaRef(buffer, recordOffset, layout.payloadOffset, baseOffset + layout.arenaOffset);
    var payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (_err) {
      return null;
    }

    entries.push(Object.assign({}, payload, {
      cursor: entryCursor,
      sceneId: payload && payload.sceneId ? String(payload.sceneId) : readNullTerminatedString(buffer, recordOffset + layout.sceneIdOffset, layout.sceneIdBytes),
      performanceId: payload && payload.performanceId ? String(payload.performanceId) : readNullTerminatedString(buffer, recordOffset + layout.performanceIdOffset, layout.performanceIdBytes),
      effectId: payload && payload.effect && payload.effect.id ? String(payload.effect.id) : readNullTerminatedString(buffer, recordOffset + layout.effectIdOffset, layout.effectIdBytes),
      effectType: payload && payload.effect && payload.effect.type ? String(payload.effect.type) : readNullTerminatedString(buffer, recordOffset + layout.effectTypeOffset, layout.effectTypeBytes),
      hasContext: (flags & 1) === 1
    }));
  }
  var revisionAfter = buffer.readUInt32LE(layout.revisionOffset);
  if (revisionBefore !== revisionAfter) {
    return null;
  }

  return buildPerformanceLogSnapshot(entries, nextCursor, droppedCount, 'sharedMemory', revisionAfter);
}

function readCommentTimelineEntriesFromSharedBuffer(buffer, layout, cursor) {
  if (!Buffer.isBuffer(buffer) || !isValidCommentTimelineLayout(layout)) return null;
  if (buffer.length < layout.totalBytes) return null;

  var revisionBefore = buffer.readUInt32LE(layout.revisionOffset);
  var activeBufferIndex = buffer.readUInt32LE(layout.activeBufferIndexOffset);
  if (activeBufferIndex !== 0 && activeBufferIndex !== 1) return null;
  var baseOffset = layout.bufferOffsets[activeBufferIndex];
  var head = buffer.readUInt32LE(baseOffset + layout.headOffset);
  var entryCount = buffer.readUInt32LE(baseOffset + layout.entryCountOffset);
  var nextCursor = buffer.readUInt32LE(baseOffset + layout.nextCursorOffset);
  var droppedCount = buffer.readUInt32LE(baseOffset + layout.droppedCountOffset);
  var arenaUsedBytes = buffer.readUInt32LE(baseOffset + layout.arenaUsedBytesOffset);
  if (entryCount > layout.capacity || arenaUsedBytes > layout.arenaBytes) return null;

  var entries = [];
  var index;
  for (index = 0; index < entryCount; index++) {
    var physicalIndex = (head + index) % layout.capacity;
    var recordOffset = baseOffset + layout.recordsOffset + (physicalIndex * layout.recordStrideBytes);
    var entryCursor = buffer.readUInt32LE(recordOffset + layout.cursorOffset);
    if (entryCursor === 0 || entryCursor <= cursor) continue;

    var flags = buffer.readUInt32LE(recordOffset + layout.flagsOffset);
    entries.push({
      cursor: entryCursor,
      id: readArenaRef(buffer, recordOffset, layout.idOffset, baseOffset + layout.arenaOffset),
      name: readArenaRef(buffer, recordOffset, layout.nameOffset, baseOffset + layout.arenaOffset),
      comment: readArenaRef(buffer, recordOffset, layout.commentOffset, baseOffset + layout.arenaOffset),
      commentHtml: readArenaRef(buffer, recordOffset, layout.commentHtmlOffset, baseOffset + layout.arenaOffset),
      profileImage: readArenaRef(buffer, recordOffset, layout.profileImageOffset, baseOffset + layout.arenaOffset),
      timestamp: readArenaRef(buffer, recordOffset, layout.timestampOffset, baseOffset + layout.arenaOffset),
      hasGift: (flags & 1) === 1,
      amount: buffer.readDoubleLE(recordOffset + layout.amountOffset),
      currency: readArenaRef(buffer, recordOffset, layout.currencyOffset, baseOffset + layout.arenaOffset),
      stickerImage: readArenaRef(buffer, recordOffset, layout.stickerImageOffset, baseOffset + layout.arenaOffset),
      isMember: (flags & 2) === 2,
      memberMonths: buffer.readUInt32LE(recordOffset + layout.memberMonthsOffset),
      isMembership: (flags & 4) === 4,
      membershipHeader: readArenaRef(buffer, recordOffset, layout.membershipHeaderOffset, baseOffset + layout.arenaOffset),
      isMembershipGift: (flags & 8) === 8,
      giftCount: buffer.readUInt32LE(recordOffset + layout.giftCountOffset)
    });
  }

  var revisionAfter = buffer.readUInt32LE(layout.revisionOffset);
  if (revisionBefore !== revisionAfter) {
    return null;
  }

  return buildCommentTimelineSnapshot(entries, nextCursor, droppedCount, 'sharedMemory', revisionAfter);
}

function readConnectionStateFromSharedBuffer(buffer, layout) {
  if (!Buffer.isBuffer(buffer) || !isValidConnectionStateLayout(layout)) return null;
  if (buffer.length < layout.totalBytes) return null;

  var revisionBefore = buffer.readUInt32LE(layout.revisionOffset);
  var activeBufferIndex = buffer.readUInt32LE(layout.activeBufferIndexOffset);
  if (activeBufferIndex !== 0 && activeBufferIndex !== 1) return null;
  var baseOffset = layout.bufferOffsets[activeBufferIndex];
  var connected = buffer.readUInt32LE(baseOffset + layout.connectedOffset) === 1;
  var videoId = readNullTerminatedString(buffer, baseOffset + layout.videoIdOffset, layout.videoIdBytes);
  var revisionAfter = buffer.readUInt32LE(layout.revisionOffset);
  if (revisionBefore !== revisionAfter) {
    return null;
  }

  return buildConnectionStateSnapshot({
    connected: connected,
    videoId: videoId
  }, 'sharedMemory', revisionAfter);
}

function readPerformanceEngineStateFromSharedBuffer(buffer, layout) {
  if (!Buffer.isBuffer(buffer) || !isValidPerformanceEngineStateLayout(layout)) return null;
  if (buffer.length < layout.totalBytes) return null;

  var revisionBefore = buffer.readUInt32LE(layout.revisionOffset);
  var activeBufferIndex = buffer.readUInt32LE(layout.activeBufferIndexOffset);
  if (activeBufferIndex !== 0 && activeBufferIndex !== 1) return null;
  var baseOffset = layout.bufferOffsets[activeBufferIndex];
  var stateCode = buffer.readUInt32LE(baseOffset + layout.stateOffset);
  if (stateCode >= PERFORMANCE_ENGINE_STATE_VALUES.length) return null;

  var revisionAfter = buffer.readUInt32LE(layout.revisionOffset);
  if (revisionBefore !== revisionAfter) {
    return null;
  }

  return buildPerformanceEngineStateSnapshot(PERFORMANCE_ENGINE_STATE_VALUES[stateCode], 'sharedMemory', revisionAfter);
}

function classifyPerformanceDispatchSnapshot(snapshot) {
  if (!snapshot) {
    return { status: 'readFailed', entries: [] };
  }
  if (!snapshot.entries || !snapshot.entries.length) {
    return { status: 'noEntries', entries: [] };
  }
  return { status: 'dispatched', entries: snapshot.entries };
}

module.exports = {
  REACTION_COUNT_KEYS: REACTION_COUNT_KEYS,
  PERFORMANCE_LOG_CAPACITY: PERFORMANCE_LOG_CAPACITY,
  COMMENT_TIMELINE_CAPACITY: COMMENT_TIMELINE_CAPACITY,
  CONNECTION_VIDEO_ID_BYTES: CONNECTION_VIDEO_ID_BYTES,
  PERFORMANCE_ENGINE_STATE_VALUES: PERFORMANCE_ENGINE_STATE_VALUES,
  createEmptyReactionCountMap: createEmptyReactionCountMap,
  cloneReactionCountMap: cloneReactionCountMap,
  applyReactionToCountMap: applyReactionToCountMap,
  buildReactionCountSnapshot: buildReactionCountSnapshot,
  buildPerformanceLogSnapshot: buildPerformanceLogSnapshot,
  buildCommentTimelineSnapshot: buildCommentTimelineSnapshot,
  createEmptyConnectionState: createEmptyConnectionState,
  cloneConnectionState: cloneConnectionState,
  buildConnectionStateSnapshot: buildConnectionStateSnapshot,
  createEmptyPerformanceEngineState: createEmptyPerformanceEngineState,
  normalizePerformanceEngineState: normalizePerformanceEngineState,
  buildPerformanceEngineStateSnapshot: buildPerformanceEngineStateSnapshot,
  isValidSharedLayout: isValidSharedLayout,
  isValidPerformanceLogLayout: isValidPerformanceLogLayout,
  isValidCommentTimelineLayout: isValidCommentTimelineLayout,
  isValidConnectionStateLayout: isValidConnectionStateLayout,
  isValidPerformanceEngineStateLayout: isValidPerformanceEngineStateLayout,
  readReactionCountsFromSharedBuffer: readReactionCountsFromSharedBuffer,
  readNullTerminatedString: readNullTerminatedString,
  readArenaString: readArenaString,
  readArenaRef: readArenaRef,
  readPerformanceLogEntriesFromSharedBuffer: readPerformanceLogEntriesFromSharedBuffer,
  readCommentTimelineEntriesFromSharedBuffer: readCommentTimelineEntriesFromSharedBuffer,
  readConnectionStateFromSharedBuffer: readConnectionStateFromSharedBuffer,
  readPerformanceEngineStateFromSharedBuffer: readPerformanceEngineStateFromSharedBuffer,
  classifyPerformanceDispatchSnapshot: classifyPerformanceDispatchSnapshot
};
