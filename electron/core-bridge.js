/**
 * Rust コアエンジン (napi-rs ネイティブアドオン) の管理。
 *
 * 起動・停止・runtime event コールバック転送を担当する。
 * コアエンジンとの通信は napi-rs 経由の直接関数呼び出しで行う。
 * OBS オーバーレイ配信用の axum サーバーは DLL 内部で起動する。
 *
 * ランタイム通知:
 *   Rust 側が State の正本を保持し、`subscribeRuntimeEvents` の
 *   napi コールバックで main へ変更を配信する。
 *   Electron が Rust axum の `/api/stream` を購読するわけではない。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var log = require('./log');
var L = log.create('CoreBridge');

var native = null;
var running = false;
var corePort = null;

// コールバック（main.js から設定）
var callbacks = {
  onStaticUpdate: null,   // Static 状態変更を受信
  onSessionComment: null, // Session コメント追記を受信
  onSessionReaction: null, // Session リアクション追記を受信
  onCommentDeleted: null,  // コメント削除を受信
  onTtsState: null         // TTS runtime state を受信
};

// --- ネイティブアドオンの読み込み ---

function prepareNativeModulePath(modulePath) {
  var dllPath;
  var runtimeDir;
  var runtimePath;

  if (path.extname(modulePath).toLowerCase() === '.node') {
    dllPath = modulePath.replace(/\.node$/i, '.dll');
    if (fs.existsSync(dllPath)) {
      runtimeDir = path.join(os.tmpdir(), 'komehub-runtime-node');
      fs.mkdirSync(runtimeDir, { recursive: true });
      runtimePath = path.join(runtimeDir, 'komehub_core_runtime_' + process.pid + '.node');
      fs.copyFileSync(dllPath, runtimePath);
      return runtimePath;
    }
  }

  return modulePath;
}

function loadNativeModule() {
  if (native) return native;
  var isDev = !require('electron').app.isPackaged;
  var modulePath;
  if (isDev) {
    modulePath = path.join(__dirname, '..', 'core', 'target', 'debug', 'komehub_core.node');
  } else {
    modulePath = path.join(process.resourcesPath, 'komehub_core.node');
  }
  modulePath = prepareNativeModulePath(modulePath);
  L.info('Loading native module:', modulePath);
  native = require(modulePath);
  return native;
}

// --- 起動 ---

function start(options) {
  if (running) {
    L.warn('Core engine already running');
    return;
  }

  var onReady = options.onReady || function () {};
  var onError = options.onError || function () {};

  // コールバック設定
  if (options.onStaticUpdate) callbacks.onStaticUpdate = options.onStaticUpdate;
  if (options.onSessionComment) callbacks.onSessionComment = options.onSessionComment;
  if (options.onSessionReaction) callbacks.onSessionReaction = options.onSessionReaction;
  if (options.onCommentDeleted) callbacks.onCommentDeleted = options.onCommentDeleted;
  if (options.onTtsState) callbacks.onTtsState = options.onTtsState;

  var dataDir = options.dataDir;

  L.info('Starting core engine');
  L.info('Data directory:', dataDir);

  try {
    var m = loadNativeModule();

    // プラグインディレクトリ
    var isDev = !require('electron').app.isPackaged;
    var pluginsDir;
    if (isDev) {
      pluginsDir = path.join(__dirname, '..', 'effects-overlay', 'plugins');
    } else {
      pluginsDir = path.join(process.resourcesPath, 'effects-overlay', 'plugins');
    }

    // 非同期初期化
    m.init(dataDir, pluginsDir).then(function (port) {
      corePort = port;
      running = true;
      L.info('Core engine ready on port', port);

      // Runtime コールバック登録
      m.subscribeRuntimeEvents(function (err, eventJson) {
        if (err || !eventJson) return;
        try {
          handleRuntimeEvent(JSON.parse(eventJson));
        } catch (e) {
          // パースエラーは無視
        }
      });

      onReady(port);
    }).catch(function (e) {
      var raw = (e && e.message) ? e.message : String(e);
      var info = parseStructuredCoreError(raw);
      L.error('Failed to initialize core engine:', info.message || raw);
      onError(Object.assign(new Error(info.message || raw), info));
    });
  } catch (e) {
    L.error('Failed to load native module:', e.message);
    onError(e);
  }
}

/**
 * Rust 側 `Error::from_reason(JSON文字列)` を構造化情報に展開する。
 * JSON でない場合は code:"EUNKNOWN" にフォールバック。
 * code: 'EADDRINUSE' / 'EBIND' / 'EUNKNOWN'
 */
function parseStructuredCoreError(message) {
  if (typeof message !== 'string') {
    return { code: 'EUNKNOWN', message: String(message) };
  }
  // napi-rs は Error::from_reason の文字列を `${reason}` でそのまま返すケースと
  // `Failed to ...: <reason>` のように prefix を付けるケースがあるので、両対応する。
  var jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    var jsonEnd = message.lastIndexOf('}');
    if (jsonEnd > jsonStart) {
      try {
        var parsed = JSON.parse(message.slice(jsonStart, jsonEnd + 1));
        if (parsed && typeof parsed === 'object' && parsed.code) {
          return parsed;
        }
      } catch (_) {
        // intentional: 構造化 JSON parse 失敗 → 関数末尾の EUNKNOWN fallback に
        // 落ちる設計。 message 全文は呼出側で扱われるので、 ここでは握る。
      }
    }
  }
  return { code: 'EUNKNOWN', message: message };
}

// --- 停止 ---

async function stop() {
  if (native) {
    try {
      await native.shutdownCore();
    } catch (err) {
      L.error('Failed to shutdown core engine:', err && err.message ? err.message : err);
    }
  }
  running = false;
  corePort = null;
  L.info('Core engine stopped');
}

// --- Runtime イベント処理 ---

function handleRuntimeEvent(message) {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'static':
      if (callbacks.onStaticUpdate) {
        callbacks.onStaticUpdate(message.path, message.data);
      }
      break;

    case 'session-comment':
      if (callbacks.onSessionComment) {
        callbacks.onSessionComment(message.data);
      }
      break;

    case 'session-reaction':
      if (callbacks.onSessionReaction) {
        callbacks.onSessionReaction(message.data);
      }
      break;

    case 'comment-deleted':
      if (callbacks.onCommentDeleted) {
        callbacks.onCommentDeleted(message.data);
      }
      break;

    case 'tts-state':
      if (callbacks.onTtsState) {
        callbacks.onTtsState(message.data);
      }
      break;
  }
}

// --- 公開API ---

function getPort() {
  return corePort;
}

function getPublicClientCount() {
  if (!running || !native) return 0;
  return Number(native.getPublicClientCount()) || 0;
}

function getBaseUrl() {
  if (!running || !corePort) return '';
  return 'http://127.0.0.1:' + corePort;
}

function isRunning() {
  return running;
}

function getLanIpv4Address() {
  var interfaces = os.networkInterfaces();
  var names = Object.keys(interfaces || {});
  for (var i = 0; i < names.length; i++) {
    var entries = interfaces[names[i]] || [];
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (!entry || entry.internal || entry.family !== 'IPv4') continue;
      if (/^(169\.254|127\.)\./.test(entry.address)) continue;
      return entry.address;
    }
  }
  return '127.0.0.1';
}

function startPonoutRemote() {
  if (!running || !native) {
    return Promise.resolve({ ok: false, error: 'Rust core not running' });
  }
  return callAsyncMethod('startPonoutRemote', { ok: false }, [getLanIpv4Address()]);
}

function startListenerRemote() {
  if (!running || !native) {
    return Promise.resolve({ ok: false, error: 'Rust core not running' });
  }
  return callAsyncMethod('startListenerRemote', { ok: false }, [getLanIpv4Address()]);
}

/** コメントをコアエンジンに転送 */
function pushComments(comments) {
  callSyncMethod('pushComments', stringifyArgs([comments], [0]));
}

/** InnerTube API の生 actions JSON をコアエンジンに転送 */
function pushInnertubeActions(payload) {
  callSyncMethod('pushInnertubeActions', stringifyArgs([payload], [0]));
}

/** リアクションをコアエンジンに転送 */
function pushReaction(reaction) {
  callSyncMethod('pushReaction', stringifyArgs([reaction], [0]));
}

/** 接続状態をコアエンジンに通知 */
function pushConnectionState(connected, videoId) {
  callSyncMethod('pushConnectionState', [connected, videoId || null]);
}

/** PT-1b: 配信の owner channel id をコアエンジンに通知 (Step 3 リスナー管理の自チャンネル判定用) */
function announceStreamOwner(videoId, ownerChannelId) {
  if (!videoId || !ownerChannelId) return;
  callSyncMethod('announceStreamOwner', [videoId, ownerChannelId]);
}

/**
 * わんコメ書き戻し import 中に Rust core から呼ばれる「未知 video_id の owner 解決」
 * callback を登録する。 Rust 側は import_from_onecomme 内で streams に owner 未登録の
 * video_id を集めて、 ここに渡されたコールバックを `spawn_blocking + block_on` で同期呼出
 * する。 詳細は `core/src/engine/video_owner_resolver.rs` 参照。
 *
 * resolverFn: `(videoIds: string[]) => Promise<{videoId, ownerChannelId, channelName?, title?}[]>`
 * (= 並列度 / fetch 実装は呼び出し側が持つ、 core-bridge は単に NAPI に渡すだけ)
 */
function registerVideoOwnerResolver(resolverFn) {
  if (typeof resolverFn !== 'function') {
    throw new TypeError('registerVideoOwnerResolver requires a function');
  }
  if (!running || !native) {
    throw new Error('core engine not loaded');
  }
  if (typeof native.registerVideoOwnerResolver !== 'function') {
    throw new Error('native.registerVideoOwnerResolver not found (rebuild required?)');
  }
  native.registerVideoOwnerResolver(resolverFn);
  L.info('VideoOwnerResolver registered');
}

/**
 * import_from_onecomme の中間進捗 callback を Rust core に登録する。
 * callback (err, jsonStr) で受け、 jsonStr は {phase, current, total, message} JSON。
 * subscribeRuntimeEvents と同じ error-first パターン。
 */
function registerImportProgressReporter(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('registerImportProgressReporter requires a function');
  }
  if (!running || !native) {
    throw new Error('core engine not loaded');
  }
  if (typeof native.registerImportProgressReporter !== 'function') {
    throw new Error('native.registerImportProgressReporter not found (rebuild required?)');
  }
  native.registerImportProgressReporter(callback);
  L.info('ImportProgressReporter registered');
}

/**
 * export_to_onecomme の中間進捗 callback を Rust core に登録する。
 * callback (err, jsonStr) で受け、 jsonStr は {phase, current, total, message, overallPercent} JSON。
 * subscribeRuntimeEvents と同じ error-first パターン。
 */
function registerExportProgressReporter(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('registerExportProgressReporter requires a function');
  }
  if (!running || !native) {
    throw new Error('core engine not loaded');
  }
  if (typeof native.registerExportProgressReporter !== 'function') {
    throw new Error('native.registerExportProgressReporter not found (rebuild required?)');
  }
  native.registerExportProgressReporter(callback);
  L.info('ExportProgressReporter registered');
}

// --- Step 3 リスナー管理 (フェーズ 3.2a) ---

/** 自チャンネル設定一覧 (channelId + handle?) を取得。UI 起動時の初期表示用。 */
function getOwnerChannels() {
  return callAsyncMethod('getOwnerChannels', { ownerChannels: [] }, []);
}

/**
 * 自チャンネル設定一覧を一括上書き。各要素は `{ channelId, handle? }`。
 * 空配列で全クリア。
 */
function setOwnerChannels(channels) {
  return callAsyncMethod('setOwnerChannels', { ok: false }, [Array.isArray(channels) ? channels : []]);
}

/** リスナー一覧取得 (sort / q / limit / offset) */
function listListeners(query) {
  var qJson = JSON.stringify(query || {});
  return callAsyncMethod('listListeners', { ok: false, page: { total: 0, rows: [] } }, [qJson]);
}

/**
 * リスナー一覧 UI heatmap 用 daily activity 一括取得。
 * query = { channelIds: ['yt-UC...'], days?: 14 }
 * 戻り: { ok: true, activities: [{ channelId, days: [{count, hasSc}, ...] }] }
 */
function listListenersActivity(query) {
  var qJson = JSON.stringify(query || {});
  return callAsyncMethod('listListenersActivity', { ok: false, activities: [] }, [qJson]);
}

/** リスナー詳細取得 (リスナー単体 + 直近コメント) */
function getListenerDetail(channelId, recentCommentLimit) {
  var limit = typeof recentCommentLimit === 'number' && recentCommentLimit > 0
    ? Math.min(200, Math.floor(recentCommentLimit))
    : 50;
  return callAsyncMethod('getListenerDetail', { ok: false, detail: null }, [channelId || '', limit]);
}

/**
 * 配信メタデータ (タイトル / チャンネル名 / 同時接続数 等) の部分更新。
 * 各キーが undefined / null なら Rust 側で「触らない」扱い。
 * peakConcurrentViewers は Rust 側 SQL の MAX() で蓄積されるので、
 * 小さい値が来てもピークは縮退しない。
 */
function updateStreamMetadata(videoId, fields) {
  var f = fields || {};
  var num = function (v) { return typeof v === 'number' ? v : null; };
  var str = function (v) { return v === undefined || v === null ? null : String(v); };
  return callAsyncMethod(
    'updateStreamMetadata',
    { ok: false, updated: 0 },
    [
      videoId || '',
      str(f.streamUrl),
      str(f.title),
      str(f.ownerChannelId),
      str(f.channelName),
      str(f.channelIconUrl),
      str(f.description),
      num(f.subscriberCount),
      num(f.currentViewers),
      num(f.peakConcurrentViewers),
      num(f.likes),
      num(f.startedAt),
      num(f.endedAt),
      num(f.liveMetadataUpdatedAt),
    ]
  );
}

/**
 * nickname / notes / label の部分更新。
 * 値が undefined のフィールドは null として渡し Rust 側で「触らない」扱い。
 * 空文字 "" は明示クリア。
 */
function updateListenerMetadata(channelId, fields) {
  var f = fields || {};
  var nickname = f.nickname === undefined ? null : String(f.nickname);
  var notes = f.notes === undefined ? null : String(f.notes);
  var label = f.label === undefined ? null : String(f.label);
  return callAsyncMethod(
    'updateListenerMetadata',
    { ok: false, updated: 0 },
    [channelId || '', nickname, notes, label]
  );
}

/**
 * リモート閲覧 redesign §3.1 / §4.1: 配信枠 × リスナーの「挨拶済み」トグル。
 * value=true で挨拶済み、false で解除。per-stream リセット (= 各配信ごとに新規)。
 */
function setListenerGreeted(streamVideoId, listenerChannelId, value) {
  return callAsyncMethod(
    'setListenerGreeted',
    { ok: false, greetedAt: 0 },
    [String(streamVideoId || ''), String(listenerChannelId || ''), !!value]
  );
}

/**
 * リモート閲覧 redesign §3.2 / §4.1: コメント単位の「対応済み」トグル。
 * value=true で対応済み、false で解除。
 */
function setCommentResponded(commentId, value) {
  return callAsyncMethod(
    'setCommentResponded',
    { ok: false, respondedAt: 0 },
    [String(commentId || ''), !!value]
  );
}

/**
 * 指定リスナー (複数可) を listeners 行 + アバター画像ファイルだけ削除する。
 * コメントは残す (= 配信履歴として永続化)、streams 集計値も触らない。
 * 同 channel_id のリスナーが再登場したら過去コメントが自動で再紐付け。
 * わんコメ DB は触らない。
 */
function deleteListeners(channelIds) {
  var ids = Array.isArray(channelIds) ? channelIds.map(String) : [];
  return callAsyncMethod('deleteListeners', { ok: false, summaries: [] }, [ids]);
}

/** 配信一覧取得 (sort / limit / offset) */
function listStreams(query) {
  var qJson = JSON.stringify(query || {});
  return callAsyncMethod('listStreams', { ok: false, page: { total: 0, rows: [] } }, [qJson]);
}

/**
 * 指定配信 (複数可) を削除する。
 * comments / stream_tags / stream_listener_state と、その配信だけに紐付いた orphan listeners も削除する。
 * わんコメ DB は触らない。
 */
function deleteStreams(videoIds) {
  var ids = Array.isArray(videoIds) ? videoIds.map(String) : [];
  return callAsyncMethod('deleteStreams', { ok: false, summaries: [] }, [ids]);
}

/** 配信詳細取得 (配信単体 + 直近コメント) */
function getStreamDetail(videoId, recentCommentLimit) {
  var limit = typeof recentCommentLimit === 'number' && recentCommentLimit > 0
    ? Math.min(500, Math.floor(recentCommentLimit))
    : 100;
  return callAsyncMethod('getStreamDetail', { ok: false, detail: null }, [videoId || '', limit]);
}

/** コメント検索 (新仕様: bodyQ / streamTitleQ / nameQ / periodFrom-To / systemTags[] /
 *  userTags[] / streamIds[] / listenerChannelIds[] / commentTypes[] / includeKpi + ページング) */
function searchComments(query) {
  var qJson = JSON.stringify(query || {});
  return callAsyncMethod('searchComments', { ok: false, page: { total: 0, rows: [] } }, [qJson]);
}

/** 配信詳細モーダルのリスナータブ用: per-stream 集計 + heatmap + user_tags 付き */
function listStreamListeners(videoId, query) {
  var qJson = JSON.stringify(query || {});
  return callAsyncMethod(
    'listStreamListeners',
    { ok: false, page: { total: 0, rows: [] } },
    [videoId || '', qJson],
  );
}

/** 配信詳細モーダルの統計タブ用: 時系列 / 累積 / 構成 / 頻出語 / misc を一括 */
function getStreamStats(videoId, binMinutes) {
  var bin = typeof binMinutes === 'number' && binMinutes > 0
    ? Math.min(240, Math.floor(binMinutes))
    : 15;
  return callAsyncMethod('getStreamStats', { ok: false, stats: null }, [videoId || '', bin]);
}

/** 配信詳細モーダルの chip 表示用: 5 種 COUNT を 1 SQL で取得 */
function getCommentChipCounts(videoId) {
  return callAsyncMethod(
    'getCommentChipCounts',
    { ok: false, counts: { all: 0, sc: 0, member: 0, firstTime: 0, veteran: 0 } },
    [videoId || ''],
  );
}

/** リスナー詳細モーダルの chip 表示用: 全期間 / SC / 当該枠の 3 種 COUNT */
function getListenerChipCounts(channelId, contextVideoId) {
  return callAsyncMethod(
    'getListenerChipCounts',
    { ok: false, counts: { all: 0, sc: 0, thisStream: 0 } },
    [channelId || '', contextVideoId || ''],
  );
}

/** リスナー詳細モーダル「SC のみ」chip 用: 全期間 SC コメ取得 */
function listListenerSuperchats(channelId, limit) {
  var n = typeof limit === 'number' && limit > 0 ? Math.min(1000, Math.floor(limit)) : 200;
  return callAsyncMethod(
    'listListenerSuperchats',
    { ok: false, comments: [] },
    [String(channelId || ''), n],
  );
}

/** リスナー詳細モーダル「この枠」chip 用: 指定 stream_video_id でのコメを全件取得 */
function listListenerCommentsInStream(channelId, streamVideoId, limit) {
  var n = typeof limit === 'number' && limit > 0
    ? Math.min(10000, Math.floor(limit))
    : 1000;
  return callAsyncMethod(
    'listListenerCommentsInStream',
    { ok: false, comments: [] },
    [String(channelId || ''), String(streamVideoId || ''), n],
  );
}

/** 設定画面「リスナー判定」ライブプレビュー用: 6 ランクの件数を取得 */
function getListenerSearchRankCounts(baselineVideoId) {
  return callAsyncMethod(
    'getListenerSearchRankCounts',
    { ok: false, counts: null },
    [String(baselineVideoId || '')],
  );
}

/** リスナータブのミニタブ件数バッジ用: 接続中の枠の 6 種 COUNT */
function getStreamScopedListenerCounts(streamVideoId, q) {
  return callAsyncMethod(
    'getStreamScopedListenerCounts',
    {
      ok: false,
      counts: { all: 0, unGreeted: 0, firstTime: 0, returning: 0, comeback: 0, newMember: 0 },
    },
    [String(streamVideoId || ''), q == null ? null : String(q)],
  );
}

/** 配信詳細モーダル: system pill 件数 (= 全 audience に対する集計、ページング非依存) */
function getStreamListenerPillCounts(videoId, query) {
  var q = query || {};
  var payload = {
    nameQ: q.nameQ || q.name_q || undefined,
    bodyQ: q.bodyQ || q.body_q || undefined,
    userTags: Array.isArray(q.userTags) ? q.userTags : (Array.isArray(q.user_tags) ? q.user_tags : []),
  };
  return callAsyncMethod(
    'getStreamListenerPillCounts',
    {
      ok: false,
      counts: { all: 0, firstTime: 0, returning: 0, regular: 0, veteran: 0, comeback: 0, memberJoined: 0 },
    },
    [String(videoId || ''), JSON.stringify(payload)],
  );
}

/** 1 リスナーに付けられた user-attached タグ一覧 */
function getListenerTags(channelId) {
  return callAsyncMethod('getListenerTags', { ok: false, tags: [] }, [String(channelId || '')]);
}

/** 1 リスナーのタグ集合を完全置換 (空配列で全削除) */
function setListenerTags(channelId, tags) {
  var jsonTags = JSON.stringify(Array.isArray(tags) ? tags : []);
  return callAsyncMethod('setListenerTags', { ok: false }, [String(channelId || ''), jsonTags]);
}

/** 全 user-attached タグの一覧 + 利用リスナー数 */
function listAllListenerTags() {
  return callAsyncMethod('listAllListenerTags', { ok: false, tags: [] }, []);
}

/** listener_tags 全行をフラット取得 (popover 用) */
function listAllListenerTagAssignments() {
  return callAsyncMethod('listAllListenerTagAssignments', { ok: false, assignments: [] }, []);
}

/** 1 配信のタグ取得 */
function getStreamTags(videoId) {
  return callAsyncMethod('getStreamTags', { ok: false, tags: [] }, [String(videoId || '')]);
}

/** 1 配信のタグ完全置換 */
function setStreamTags(videoId, tags) {
  return callAsyncMethod('setStreamTags', { ok: false }, [String(videoId || ''), JSON.stringify(Array.isArray(tags) ? tags : [])]);
}

/** 配信枠タグ一覧 */
function listAllStreamTags() {
  return callAsyncMethod('listAllStreamTags', { ok: false, tags: [] }, []);
}

/** 配信枠タグ assignment 全行 */
function listAllStreamTagAssignments() {
  return callAsyncMethod('listAllStreamTagAssignments', { ok: false, assignments: [] }, []);
}

/** 配信枠タグ rename */
function renameStreamTag(oldName, newName) {
  return callAsyncMethod('renameStreamTag', { ok: false }, [String(oldName || ''), String(newName || '')]);
}

/** 配信枠タグ delete */
function deleteStreamTag(name) {
  return callAsyncMethod('deleteStreamTag', { ok: false }, [String(name || '')]);
}

/** タグ名一括変更 (新名と既存衝突は統合) */
function renameListenerTag(oldName, newName) {
  return callAsyncMethod('renameListenerTag', { ok: false }, [String(oldName || ''), String(newName || '')]);
}

/** タグ名を全リスナーから削除 */
function deleteListenerTag(name) {
  return callAsyncMethod('deleteListenerTag', { ok: false }, [String(name || '')]);
}

/** 指定 scope の保存検索一覧 (sort_order ASC、 'comment-search' / 'listener-search' 等) */
function listSavedSearches(scope) {
  return callAsyncMethod(
    'listSavedSearches',
    { ok: false, searches: [] },
    [String(scope || 'comment-search')],
  );
}

/** 保存検索を新規作成 (scope + name + JSON 文字列の conditions) */
function createSavedSearch(scope, name, conditionsJson) {
  return callAsyncMethod(
    'createSavedSearch',
    { ok: false },
    [
      String(scope || 'comment-search'),
      String(name || ''),
      String(conditionsJson || '{}'),
    ],
  );
}

/** 保存検索の部分更新 (null は touch しない) */
function updateSavedSearch(id, name, conditionsJson, sortOrder) {
  return callAsyncMethod(
    'updateSavedSearch',
    { ok: false },
    [
      Number(id) | 0,
      typeof name === 'string' ? name : null,
      typeof conditionsJson === 'string' ? conditionsJson : null,
      typeof sortOrder === 'number' ? (sortOrder | 0) : null,
    ]
  );
}

/** 保存検索を id 指定で削除 */
function deleteSavedSearch(id) {
  return callAsyncMethod('deleteSavedSearch', { ok: false }, [Number(id) | 0]);
}

/** こめはぶ形式 JSON Lines エクスポート (絶対パス指定) */
function exportKomehubJsonl(outPath) {
  return callAsyncMethod('exportKomehubJsonl', { ok: false }, [String(outPath || '')]);
}

/** こめはぶ形式 JSON Lines インポート (絶対パス指定) */
function importKomehubJsonl(srcPath) {
  return callAsyncMethod('importKomehubJsonl', { ok: false }, [String(srcPath || '')]);
}

/** わんコメ DB インポート (Plan A、onecomme dir 指定) */
function importFromOnecomme(onecommeDir) {
  return callAsyncMethod('importFromOnecomme', { ok: false }, [String(onecommeDir || '')]);
}

/** 空 title/channel_name の自チャ過去枠を resolver で後追い補完 (= 起動時 backfill、fire-and-forget)。
 *  registerVideoOwnerResolver 後に呼ぶこと (= resolver 未登録なら Rust 側で no-op)。 */
function backfillStreamMeta() {
  callSyncMethod('backfillStreamMeta', []);
}

/** わんコメ DB へ書き戻し (Plan A、onecomme dir 指定、フェーズ 3.5) */
function exportToOnecomme(onecommeDir) {
  return callAsyncMethod('exportToOnecomme', { ok: false }, [String(onecommeDir || '')]);
}

/** listeners.db にわんコメ書き戻し対象の変更があるかを問い合わせる。
 *  close ハンドラで shutdown export を実行 / skip 判定する */
function isListenerDbDirty() {
  return callAsyncMethod('isListenerDbDirty', { ok: false, dirty: false }, []);
}

/** わんコメ起動検知 (HTTP 11180、200ms タイムアウト) */
function detectOnecommeRunning() {
  return callAsyncMethod('detectOnecommeRunning', { ok: false, running: false }, []);
}

/** 双方向同期 (起動時自動 + 「今すぐ同期」ボタン) */
function runBidirectionalSync(onecommeDir) {
  return callAsyncMethod('runBidirectionalSync', { ok: false }, [String(onecommeDir || '')]);
}

function resetOnecommeWatermarks(onecommeDir) {
  return callAsyncMethod('resetOnecommeWatermarks', { ok: false }, [String(onecommeDir || '')]);
}

/** コメント削除をコアエンジンに通知 */
function pushCommentDeleted(ids) {
  callSyncMethod('pushCommentDeleted', stringifyArgs([ids], [0]));
}

/** 一時停止をコアエンジンに通知 */
function pushPaused(paused) {
  callSyncMethod('setPaused', [paused]);
}

// 2026-05-09 仕様変更: 旧 pushBannedUsers / getBannedUsers / setBannedUsers (= 演出フィルタ向け) は撤廃。
// 演出フィルタを廃止し、UI 表示抑制 (= hidden_listeners) に集約。

// 2026-05-09 仕様変更: 旧 setListenerBanned (= 単一 BAN) を 2 軸独立 (= コメ非表示 / リスナー非表示) に置換。
// 演出フィルタは撤廃済 (= UI 表示抑制のみ)。
function setListenerHidden(channelId, hideFromComments, hideFromListeners) {
  return callAsyncMethod('setListenerHidden', { ok: false }, [
    String(channelId || ''),
    !!hideFromComments,
    !!hideFromListeners,
  ]);
}

function getHiddenListeners() {
  return callAsyncMethod('getHiddenListeners', '[]', []);
}

function setHiddenListeners(users) {
  return callAsyncMethod('setHiddenListeners', '[]', stringifyArgs([users], [0]));
}

/** グローバルクールダウン設定をコアエンジンに同期 */
function pushGlobalCooldown(settings) {
  callSyncMethod('updateGlobalCooldown', [settings.maxEffects, settings.userInterval]);
}

function getGlobalCooldown() {
  return callAsyncMethod('getGlobalCooldown', { maxEffects: 30, userInterval: 5 }, []);
}

/** メンバーシップギフトの推定単価設定を取得 (= { defaultPriceJpy, perChannel: {UC: 単価} }) */
function getMembershipGiftPricing() {
  return callAsyncMethod('getMembershipGiftPricing', { defaultPriceJpy: 490, perChannel: {} }, []);
}

/** メンバーシップギフトの推定単価設定を保存し、正規化後の値を返す */
function setMembershipGiftPricing(settings) {
  return callAsyncMethod('setMembershipGiftPricing', null, stringifyArgs([settings || {}], [0]));
}

function getListenerClassificationConfig() {
  return callAsyncMethod(
    'getListenerClassificationConfig',
    {
      regularStreamWindow: 10,
      regularMinStreams: 3,
      newcomerFirstSeenDays: 30,
      veteranFirstSeenDays: 365
    },
    []
  );
}

function setListenerClassificationConfig(settings) {
  return callAsyncMethod(
    'setListenerClassificationConfig',
    {
      regularStreamWindow: 10,
      regularMinStreams: 3,
      newcomerFirstSeenDays: 30,
      veteranFirstSeenDays: 365
    },
    [
      settings.regularStreamWindow,
      settings.regularMinStreams,
      settings.newcomerFirstSeenDays || 30,
      settings.veteranFirstSeenDays || 365
    ]
  );
}

function getTtsSettings() {
  return callAsyncMethod('getTtsSettings', null, []);
}

function setTtsSettings(settings) {
  return callAsyncMethod('setTtsSettings', null, stringifyArgs([settings || {}], [0]));
}

function getTtsState() {
  return callAsyncMethod('getTtsState', { enabled: false, paused: false, speaking: false, queueCount: 0, provider: 'builtin' }, []);
}

function setTtsEnabled(enabled) {
  return setTtsSettings({ enabled: !!enabled }).then(function (saved) {
    if (!saved) return null;
    return getTtsState();
  });
}

function setTtsPaused(paused) {
  return callAsyncMethod('setTtsPaused', null, [!!paused]);
}

function clearTts() {
  return callAsyncMethod('clearTts', null, []);
}

// --- Notification (Phase C) ---

function getNotificationSettings() {
  return callAsyncMethod('getNotificationSettings', null, []);
}

function setNotificationSettings(settings) {
  return callAsyncMethod('setNotificationSettings', null, stringifyArgs([settings || {}], [0]));
}

function setNotificationEnabled(enabled) {
  return callAsyncMethod('setNotificationEnabled', null, [!!enabled]);
}

function setNotificationPaused(paused) {
  return callAsyncMethod('setNotificationPaused', null, [!!paused]);
}

function testNotificationSound(file, volume, outputDevice) {
  return callAsyncMethod(
    'testNotificationSound',
    { ok: false, error: 'Rust core not running' },
    [file || '', Number(volume) || 0.7, outputDevice || '']
  );
}

function previewNotificationTts(text, provider, outputDevice) {
  return callAsyncMethod(
    'previewNotificationTts',
    { ok: false, error: 'Rust core not running' },
    [text || '', provider || 'builtin', outputDevice || '']
  );
}

function listNotificationSoundDevices() {
  // napi 側は sync だが callAsyncMethod 経由で統一 (JSON parse + fallback)
  return callAsyncMethod('listNotificationSoundDevices', [], []);
}

function listNotificationSoundPresets(presetsDir) {
  return callAsyncMethod('listNotificationSoundPresets', [], [presetsDir || '']);
}

function getNotificationEventDefaults() {
  return callAsyncMethod('getNotificationEventDefaults', [], []);
}

function refreshNotificationSoundDeviceMap() {
  return callAsyncMethod('refreshNotificationSoundDeviceMap', { ok: false, size: 0 }, []);
}

function testTtsSpeech(text) {
  return callAsyncMethod('testTtsSpeech', { ok: false, error: 'Rust core not running' }, [text || '']);
}

function getTtsVoices(provider) {
  return callAsyncMethod('getTtsVoices', { ok: false, error: 'Rust core not running' }, [provider || '']);
}

function checkTtsProvider(provider) {
  return callAsyncMethod('checkTtsProvider', { ok: false, error: 'Rust core not running' }, [provider || '']);
}

function launchTtsProvider(provider) {
  return callAsyncMethod('launchTtsProvider', { ok: false, error: 'Rust core not running' }, [provider || '']);
}

function detectTtsProviderExecutable(provider) {
  return callAsyncMethod('detectTtsProviderExecutable', { ok: false, error: 'Rust core not running' }, [provider || '']);
}

function getTtsAudioOutputs() {
  return callAsyncMethod('getTtsAudioOutputs', { ok: false, outputs: [], error: 'Rust core not running' }, []);
}

function broadcastReload() {
  return callAsyncMethod('broadcastReload', false, []);
}

function ensureTemplateFonts(fonts, onProgress) {
  if (!Array.isArray(fonts) || fonts.length === 0) {
    return Promise.resolve({ ok: true, results: [] });
  }
  if (!running || !native) {
    return Promise.resolve({ ok: false, results: [] });
  }
  var progressHandler = typeof onProgress === 'function' ? onProgress : function () {};
  return callAsync(function () {
    return native.ensureTemplateFonts(JSON.stringify(fonts), function (err, progressJson) {
      if (err || !progressJson) return;
      try {
        progressHandler(JSON.parse(progressJson));
      } catch (e) {
        // 進捗パースエラーは UI 更新だけをスキップする
      }
    });
  }, { ok: false, results: [] });
}

function cacheCommentImages(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return Promise.resolve([]);
  }
  return callAsyncMethod('cacheCommentImages', comments, stringifyArgs([comments], [0]));
}

/**
 * 配信サムネを media-cache に DL → ローカル URL を返す。
 * 既存ヒット (= 既に DL 済み) なら即時 return。
 * 戻り: { ok, localUrl, hit, fileName }
 */
function cacheStreamThumbnail(videoId) {
  if (!videoId) return Promise.resolve({ ok: false, error: 'empty videoId' });
  return callAsyncMethod('cacheStreamThumbnail', { ok: false }, [String(videoId)]);
}

// --- napi 直接呼び出し API ---
// main.js の IPC ハンドラから使用する。
// 全て Promise を返す（async napi 関数）か、同期で結果を返す。
// JSON 文字列 → JS オブジェクトへの変換はこの層で行う。

/** napi async 呼び出し → JSON パース。エラー時は fallback を返す */
function callAsync(fn, fallback, methodName) {
  if (!running || !native) return Promise.resolve(fallback);
  try {
    return Promise.resolve(fn()).then(function (json) {
      try { return JSON.parse(json); } catch (e) { return json; }
    }).catch(function (err) {
      L.error('Core async method failed:', methodName || '(unknown)', err && (err.stack || err.message) || err);
      return fallback;
    });
  } catch (err) {
    L.error('Core async method threw:', methodName || '(unknown)', err && (err.stack || err.message) || err);
    return Promise.resolve(fallback);
  }
}

/** napi sync 呼び出し → JSON パース */
function callSync(fn) {
  if (!running || !native) return null;
  var result = fn();
  try { return JSON.parse(result); } catch (e) { return result; }
}

function callAsyncMethod(methodName, fallback, args) {
  if (!running || !native) {
    return Promise.resolve(fallback);
  }
  if (typeof native[methodName] !== 'function') {
    L.error('Core async method not found:', methodName);
    return Promise.resolve(fallback);
  }
  return callAsync(function () {
    return native[methodName].apply(native, args || []);
  }, fallback, methodName);
}

function callSyncMethod(methodName, args) {
  if (!running || !native) return;
  return native[methodName].apply(native, args || []);
}

function stringifyArgs(args, indexes) {
  var serialized = (args || []).slice();
  var i;
  for (i = 0; i < indexes.length; i++) {
    serialized[indexes[i]] = JSON.stringify(serialized[indexes[i]]);
  }
  return serialized;
}

// --- シーン ---

function getScenes() {
  return callAsyncMethod('getScenes', {}, []);
}

function getSceneList() {
  return callAsyncMethod('getSceneList', [], []);
}

function createScene(sceneIdOrName, name) {
  if (typeof name === 'undefined') {
    return callAsyncMethod('createSceneWithGeneratedId', null, [sceneIdOrName]);
  }
  return callAsyncMethod('createScene', null, [sceneIdOrName, name]);
}

function deleteScene(sceneId) {
  return callAsyncMethod('deleteScene', null, [sceneId]);
}

function saveScene(sceneId, sceneData) {
  return callAsyncMethod('saveScene', false, stringifyArgs([sceneId, sceneData], [1]));
}

function renameScene(sceneId, newName) {
  return callAsyncMethod('renameScene', false, [sceneId, newName]);
}

function duplicateScene(sourceId, newIdOrName, newName) {
  if (typeof newName === 'undefined') {
    return callAsyncMethod('duplicateSceneWithGeneratedId', null, [sourceId, newIdOrName]);
  }
  return callAsyncMethod('duplicateScene', null, [sourceId, newIdOrName, newName]);
}

function reorderScenes(order) {
  callSyncMethod('reorderScenes', [order]);
}

function setActiveScene(sceneId) {
  callSyncMethod('setActiveScene', [sceneId]);
}

function setActiveSceneAndSave(sceneId) {
  callSyncMethod('setActiveSceneAndSave', [sceneId]);
}

function setSceneEnabled(sceneId, enabled) {
  return callAsyncMethod('setSceneEnabled', false, [sceneId, enabled]);
}

function getActiveScene() {
  return callAsyncMethod('getActiveScene', '', []);
}

function restoreDefaultScene(sceneId) {
  return callAsyncMethod('restoreDefaultScene', false, [sceneId]);
}

// --- 演出 ---

function getPerformances(sceneId) {
  return callAsyncMethod('getPerformances', [], [sceneId]);
}

function savePerformance(sceneId, performance) {
  return callAsyncMethod('savePerformance', false, stringifyArgs([sceneId, performance], [1]));
}

function deletePerformance(sceneId, performanceId) {
  return callAsyncMethod('deletePerformance', false, [sceneId, performanceId]);
}

function setPerformanceEnabled(sceneId, performanceId, enabled) {
  return callAsyncMethod('setPerformanceEnabled', false, [sceneId, performanceId, enabled]);
}

function reorderPerformances(sceneId, orderedIds) {
  return callAsyncMethod('reorderPerformances', false, [sceneId, orderedIds]);
}

// --- テンプレート ---

function getTemplates() {
  return callAsyncMethod('getTemplates', [], []);
}

function installTemplate(zipPath) {
  return callAsyncMethod('installTemplate', null, [zipPath]);
}

function createTemplateFromStarter(starterType, templateId, displayName) {
  return callAsyncMethod('createTemplateFromStarter', null, [starterType, templateId, displayName]);
}

function removeTemplate(name) {
  return callAsyncMethod('removeTemplate', false, [name]);
}

function getTemplateDirectory(name) {
  return callAsyncMethod('getTemplateDirectory', { path: null }, [name]);
}

function importTemplateBundledFont(name, srcPath, family) {
  return callAsyncMethod('importTemplateBundledFont', false, [name, srcPath, family]);
}

function getSceneTemplates(sceneId) {
  return callAsyncMethod('getSceneTemplates', { sceneTemplates: [], availableTemplates: [], selectedTemplateId: '' }, [sceneId]);
}

function addSceneTemplate(sceneId, templateName) {
  return callAsyncMethod('addSceneTemplate', false, [sceneId, templateName]);
}

function removeSceneTemplate(sceneId, templateName) {
  return callAsyncMethod('removeSceneTemplate', false, [sceneId, templateName]);
}

function setSelectedSceneTemplate(sceneId, templateName) {
  return callAsyncMethod('setSelectedSceneTemplate', false, [sceneId, templateName]);
}

function setSceneTemplateEnabled(sceneId, templateName, enabled) {
  return callAsyncMethod('setSceneTemplateEnabled', false, [sceneId, templateName, enabled]);
}

function setSceneTemplatesEnabled(sceneId, enabled) {
  return callAsyncMethod('setSceneTemplatesEnabled', false, [sceneId, enabled]);
}

function setSceneTemplateConfig(sceneId, templateName, settings) {
  return callAsyncMethod('setSceneTemplateConfig', false, stringifyArgs([sceneId, templateName, settings], [2]));
}

function getTemplateManifests() {
  return callAsyncMethod('getTemplateManifests', {}, []);
}

function createTemplateFromBuiltin(sourceTemplateId, templateId, displayName) {
  return callAsyncMethod('createTemplateFromBuiltin', false, [sourceTemplateId, templateId, displayName]);
}

function getTemplateManifest(name) {
  return callAsyncMethod('getTemplateManifest', { manifest: null }, [name]);
}

function saveTemplateManifest(name, manifest) {
  return callAsyncMethod('saveTemplateManifest', false, stringifyArgs([name, manifest], [1]));
}

// --- エフェクト ---

function getEffects() {
  return callAsyncMethod('getEffects', [], []);
}

function getEffect(effectId) {
  return callAsyncMethod('getEffect', null, [effectId]);
}

function addEffect(effect) {
  return callAsyncMethod('addEffect', null, stringifyArgs([effect], [0]));
}

function updateEffect(effect) {
  return callAsyncMethod('updateEffect', false, stringifyArgs([effect], [0]));
}

function removeEffect(effectId) {
  return callAsyncMethod('removeEffect', false, [effectId]);
}

function duplicateEffect(effectId, newName) {
  return callAsyncMethod('duplicateEffect', null, [effectId, newName]);
}

function getPluginManifests() {
  return callAsyncMethod('getPluginManifests', {}, []);
}

// --- トリガー ---

function triggerManual(sceneId, performanceId) {
  callSyncMethod('triggerPerformance', [sceneId, performanceId]);
}

function clearPerformances(sceneId) {
  return callAsyncMethod('clearPerformances', { ok: false }, [sceneId || '']);
}

function triggerTest(sceneId, performanceId) {
  return callAsyncMethod('triggerTest', false, [sceneId, performanceId]);
}

function triggerTestWithContext(sceneId, performanceId, context) {
  return callAsyncMethod('triggerTestWithContext', false, stringifyArgs([sceneId, performanceId, context], [2]));
}

function triggerTestReaction(sceneId, performanceId) {
  return callAsyncMethod('triggerTestReaction', false, [sceneId, performanceId]);
}

function triggerTestReactionCustom(sceneId, performanceId, reactionKey) {
  return callAsyncMethod('triggerTestReactionCustom', false, [sceneId, performanceId, reactionKey]);
}

function sendTemplateTestComment(sceneId, context) {
  return callAsyncMethod('sendTemplateTestComment', false, stringifyArgs([sceneId, context], [1]));
}

function hasReactionTrigger() {
  return callAsyncMethod('hasReactionTrigger', false, []);
}

function getPaused() {
  return callAsyncMethod('getPaused', false, []);
}

// --- プリセット ---

function getPresetList() {
  return callAsyncMethod('getPresetList', [], []);
}

function getCurrentPreset() {
  return callAsyncMethod('getCurrentPreset', '', []);
}

function setCurrentPreset(name) {
  callSyncMethod('setCurrentPreset', [name]);
}

function switchPreset(name) {
  return callAsyncMethod('switchPreset', false, [name]);
}

function duplicatePreset(newName) {
  return callAsyncMethod('duplicatePreset', false, [newName]);
}

function deletePreset(name) {
  return callAsyncMethod('deletePreset', false, [name]);
}

function exportPreset(destPath, exportName) {
  return callAsyncMethod('exportPreset', false, [destPath, exportName]);
}

function importPreset(zipPath) {
  return callAsyncMethod('importPreset', false, [zipPath]);
}

// --- バックアップ ---

function getBackupList() {
  return callAsyncMethod('getBackupList', [], []);
}

function createBackup(options) {
  return callAsyncMethod('createBackup', null, stringifyArgs([options], [0]));
}

function createFullBackup(name) {
  return callAsyncMethod('createFullBackup', null, [name || null]);
}

function deleteBackup(backupId) {
  return callAsyncMethod('deleteBackup', false, [backupId]);
}

function restoreBackup(backupId) {
  return callAsyncMethod('restoreBackup', false, [backupId]);
}

function getBackupsDir() {
  return callAsyncMethod('getBackupsDir', '', []);
}

function getDataOverview() {
  return callAsyncMethod('getDataOverview', { commentsCount: 0, listenersCount: 0 }, []);
}

function setBackupsDir(dir) {
  callSyncMethod('setBackupsDir', [dir]);
}

function confirmUpgradeEffect(zipPath, effectId) {
  return callAsyncMethod('confirmUpgradeEffect', false, [zipPath, effectId]);
}

// --- エクスポート/インポート ---

function exportScene(sceneId, destPath) {
  return callAsyncMethod('exportScene', false, [sceneId, destPath]);
}

function exportPerformance(sceneId, performanceId, destPath) {
  return callAsyncMethod('exportPerformance', false, [sceneId, performanceId, destPath]);
}

function exportEffect(effectId, destPath) {
  return callAsyncMethod('exportEffect', false, [effectId, destPath]);
}

function exportTemplate(templateName, exportName, sceneId, templateSettings, destPath) {
  return callAsync(function () {
    return native.exportTemplate(
      templateName,
      exportName || null,
      sceneId || null,
      JSON.stringify(templateSettings || {}),
      destPath
    );
  }, false);
}

function importEffect(zipPath) {
  return callAsyncMethod('importEffect', null, [zipPath]);
}

function importScene(zipPath) {
  return callAsyncMethod('importScene', null, [zipPath]);
}

function importPerformance(sceneId, zipPath) {
  return callAsyncMethod('importPerformance', false, [sceneId, zipPath]);
}

// --- アプリ設定 ---

function setAppRootDir(dir) {
  callSyncMethod('setAppRootDir', [dir]);
}

function checkDefaultTemplateContext(effectId) {
  return callAsyncMethod('checkDefaultTemplateContext', false, [effectId]);
}

function copyPerformanceAsset(sceneId, srcPath, performanceId) {
  return callAsyncMethod('copyPerformanceAsset', null, [sceneId, srcPath, performanceId]);
}

// --- デバッグ・サポート (= debug logging ON/OFF) ---

/** デバッグログ ON/OFF の現在値を取得 → { enabled: bool } */
function getDebugLoggingEnabled() {
  return callAsyncMethod('getDebugLoggingEnabled', { enabled: false }, []);
}

/** デバッグログ ON/OFF を保存 (= 再起動で反映)。 戻り値 { ok, enabled } */
function setDebugLoggingEnabled(enabled) {
  return callAsyncMethod('setDebugLoggingEnabled', { ok: false }, [!!enabled]);
}

// --- Renderer logging (= renderer.log への書き込み経路、 詳細: docs/logging.md) ---

/**
 * renderer プロセスからの log event を Rust 側 renderer_logging に転送する
 * (= fire-and-forget、 同期 napi 呼出で即返却)。
 * Rust 内部で専用 mpsc + writer task が renderer.log に書き込む。
 */
function logRenderer(level, tag, message) {
  if (!running || !native) return;
  if (typeof native.logRenderer !== 'function') return;
  try {
    native.logRenderer(String(level || 'info'), String(tag || 'Renderer'), String(message || ''));
  } catch (err) {
    L.warn('logRenderer failed:', err && err.message ? err.message : err);
  }
}

/** renderer logging 初期化済か (= main 側 IPC handler が fallback 判定で使う)。 */
function isRendererLoggingInitialized() {
  if (!running || !native) return false;
  if (typeof native.isRendererLoggingInitialized !== 'function') return false;
  try {
    return !!native.isRendererLoggingInitialized();
  } catch (err) {
    return false;
  }
}

// デモモード専用: core init より前に listeners.db (デモ用データ dir) へ
// デモデータを seed する。native module を読み込むだけで init は不要。
function seedDemoData(dataDir, seedJson) {
  var m = loadNativeModule();
  return m.seedDemoData(dataDir, seedJson);
}

module.exports = {
  start: start,
  seedDemoData: seedDemoData,
  stop: stop,
  getPort: getPort,
  getPublicClientCount: getPublicClientCount,
  getBaseUrl: getBaseUrl,
  isRunning: isRunning,
  startPonoutRemote: startPonoutRemote,
  startListenerRemote: startListenerRemote,
  pushComments: pushComments,
  pushInnertubeActions: pushInnertubeActions,
  pushReaction: pushReaction,
  pushConnectionState: pushConnectionState,
  announceStreamOwner: announceStreamOwner,
  registerVideoOwnerResolver: registerVideoOwnerResolver,
  registerImportProgressReporter: registerImportProgressReporter,
  registerExportProgressReporter: registerExportProgressReporter,
  getOwnerChannels: getOwnerChannels,
  setOwnerChannels: setOwnerChannels,
  listListeners: listListeners,
  listListenersActivity: listListenersActivity,
  getListenerDetail: getListenerDetail,
  updateListenerMetadata: updateListenerMetadata,
  setListenerGreeted: setListenerGreeted,
  setCommentResponded: setCommentResponded,
  deleteListeners: deleteListeners,
  updateStreamMetadata: updateStreamMetadata,
  listStreams: listStreams,
  deleteStreams: deleteStreams,
  getStreamDetail: getStreamDetail,
  searchComments: searchComments,
  listStreamListeners: listStreamListeners,
  getStreamStats: getStreamStats,
  getCommentChipCounts: getCommentChipCounts,
  getListenerChipCounts: getListenerChipCounts,
  listListenerSuperchats: listListenerSuperchats,
  listListenerCommentsInStream: listListenerCommentsInStream,
  getListenerSearchRankCounts: getListenerSearchRankCounts,
  getStreamScopedListenerCounts: getStreamScopedListenerCounts,
  getStreamListenerPillCounts: getStreamListenerPillCounts,
  getListenerTags: getListenerTags,
  setListenerTags: setListenerTags,
  listAllListenerTags: listAllListenerTags,
  listAllListenerTagAssignments: listAllListenerTagAssignments,
  getStreamTags: getStreamTags,
  setStreamTags: setStreamTags,
  listAllStreamTags: listAllStreamTags,
  listAllStreamTagAssignments: listAllStreamTagAssignments,
  renameStreamTag: renameStreamTag,
  deleteStreamTag: deleteStreamTag,
  renameListenerTag: renameListenerTag,
  deleteListenerTag: deleteListenerTag,
  listSavedSearches: listSavedSearches,
  createSavedSearch: createSavedSearch,
  updateSavedSearch: updateSavedSearch,
  deleteSavedSearch: deleteSavedSearch,
  exportKomehubJsonl: exportKomehubJsonl,
  importKomehubJsonl: importKomehubJsonl,
  importFromOnecomme: importFromOnecomme,
  backfillStreamMeta: backfillStreamMeta,
  exportToOnecomme: exportToOnecomme,
  isListenerDbDirty: isListenerDbDirty,
  detectOnecommeRunning: detectOnecommeRunning,
  runBidirectionalSync: runBidirectionalSync,
  resetOnecommeWatermarks: resetOnecommeWatermarks,
  pushCommentDeleted: pushCommentDeleted,
  pushPaused: pushPaused,
  // pushBannedUsers は 2026-05-09 仕様変更 (BAN → hidden_listeners) で撤廃済
  pushGlobalCooldown: pushGlobalCooldown,
  getHiddenListeners: getHiddenListeners,
  setHiddenListeners: setHiddenListeners,
  setListenerHidden: setListenerHidden,
  getGlobalCooldown: getGlobalCooldown,
  getMembershipGiftPricing: getMembershipGiftPricing,
  setMembershipGiftPricing: setMembershipGiftPricing,
  getListenerClassificationConfig: getListenerClassificationConfig,
  setListenerClassificationConfig: setListenerClassificationConfig,
  getTtsSettings: getTtsSettings,
  setTtsSettings: setTtsSettings,
  getTtsState: getTtsState,
  setTtsEnabled: setTtsEnabled,
  setTtsPaused: setTtsPaused,
  clearTts: clearTts,
  testTtsSpeech: testTtsSpeech,
  getTtsVoices: getTtsVoices,
  checkTtsProvider: checkTtsProvider,
  launchTtsProvider: launchTtsProvider,
  detectTtsProviderExecutable: detectTtsProviderExecutable,
  getTtsAudioOutputs: getTtsAudioOutputs,
  getNotificationSettings: getNotificationSettings,
  setNotificationSettings: setNotificationSettings,
  setNotificationEnabled: setNotificationEnabled,
  setNotificationPaused: setNotificationPaused,
  testNotificationSound: testNotificationSound,
  previewNotificationTts: previewNotificationTts,
  listNotificationSoundDevices: listNotificationSoundDevices,
  listNotificationSoundPresets: listNotificationSoundPresets,
  getNotificationEventDefaults: getNotificationEventDefaults,
  refreshNotificationSoundDeviceMap: refreshNotificationSoundDeviceMap,
  broadcastReload: broadcastReload,
  ensureTemplateFonts: ensureTemplateFonts,
  cacheCommentImages: cacheCommentImages,
  cacheStreamThumbnail: cacheStreamThumbnail,

  // napi 直接呼び出し API
  getSceneList: getSceneList,
  getScenes: getScenes,
  createScene: createScene,
  deleteScene: deleteScene,
  saveScene: saveScene,
  renameScene: renameScene,
  duplicateScene: duplicateScene,
  reorderScenes: reorderScenes,
  setActiveScene: setActiveScene,
  setActiveSceneAndSave: setActiveSceneAndSave,
  setSceneEnabled: setSceneEnabled,
  getActiveScene: getActiveScene,
  restoreDefaultScene: restoreDefaultScene,

  getPerformances: getPerformances,
  savePerformance: savePerformance,
  deletePerformance: deletePerformance,
  setPerformanceEnabled: setPerformanceEnabled,
  reorderPerformances: reorderPerformances,

  getTemplates: getTemplates,
  installTemplate: installTemplate,
  createTemplateFromStarter: createTemplateFromStarter,
  removeTemplate: removeTemplate,
  getTemplateDirectory: getTemplateDirectory,
  importTemplateBundledFont: importTemplateBundledFont,
  getSceneTemplates: getSceneTemplates,
  addSceneTemplate: addSceneTemplate,
  removeSceneTemplate: removeSceneTemplate,
  setSelectedSceneTemplate: setSelectedSceneTemplate,
  setSceneTemplateEnabled: setSceneTemplateEnabled,
  setSceneTemplatesEnabled: setSceneTemplatesEnabled,
  setSceneTemplateConfig: setSceneTemplateConfig,
  getTemplateManifests: getTemplateManifests,
  createTemplateFromBuiltin: createTemplateFromBuiltin,
  getTemplateManifest: getTemplateManifest,
  saveTemplateManifest: saveTemplateManifest,

  getEffects: getEffects,
  getEffect: getEffect,
  addEffect: addEffect,
  updateEffect: updateEffect,
  removeEffect: removeEffect,
  duplicateEffect: duplicateEffect,
  getPluginManifests: getPluginManifests,

  triggerManual: triggerManual,
  clearPerformances: clearPerformances,
  triggerTest: triggerTest,
  triggerTestWithContext: triggerTestWithContext,
  triggerTestReaction: triggerTestReaction,
  triggerTestReactionCustom: triggerTestReactionCustom,
  sendTemplateTestComment: sendTemplateTestComment,
  hasReactionTrigger: hasReactionTrigger,
  getPaused: getPaused,

  getPresetList: getPresetList,
  getCurrentPreset: getCurrentPreset,
  setCurrentPreset: setCurrentPreset,
  switchPreset: switchPreset,
  duplicatePreset: duplicatePreset,
  deletePreset: deletePreset,
  exportPreset: exportPreset,
  importPreset: importPreset,

  getBackupList: getBackupList,
  createBackup: createBackup,
  createFullBackup: createFullBackup,
  deleteBackup: deleteBackup,
  restoreBackup: restoreBackup,
  getBackupsDir: getBackupsDir,
  setBackupsDir: setBackupsDir,
  getDataOverview: getDataOverview,
  confirmUpgradeEffect: confirmUpgradeEffect,

  exportScene: exportScene,
  exportPerformance: exportPerformance,
  exportEffect: exportEffect,
  exportTemplate: exportTemplate,
  importEffect: importEffect,
  importScene: importScene,
  importPerformance: importPerformance,

  setAppRootDir: setAppRootDir,
  checkDefaultTemplateContext: checkDefaultTemplateContext,
  copyPerformanceAsset: copyPerformanceAsset,

  getDebugLoggingEnabled: getDebugLoggingEnabled,
  setDebugLoggingEnabled: setDebugLoggingEnabled,

  logRenderer: logRenderer,
  isRendererLoggingInitialized: isRendererLoggingInitialized
};
