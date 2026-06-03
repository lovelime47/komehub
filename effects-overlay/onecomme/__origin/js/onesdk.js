/**
 * onesdk.js — わんコメ互換 SDK（クリーンルーム実装）
 *
 * わんコメ用テンプレートが期待する OneSDK API を完全互換で提供する。
 * 内部では こめはぶ の /onecomme/sub WebSocket に接続する。
 */
(function () {
  'use strict';

  var DEFAULT_CONFIG = {
    protocol: 'local',
    port: 11180,
    host: 'localhost',
    pathname: '',
    mode: 'all',
    disabledDelay: false,
    intervalTime: 5000,
    maxQueueInterval: 30,
    reconnectInterval: 5000,
    commentLimit: 100,
    requestInterval: 1500,
    lifeTime: Infinity,
    includes: null,
    excludes: null,
    includeIds: null,
    excludeIds: null,
    includeNames: null,
    excludeNames: null,
    permissions: ['comments', 'deleted', 'clear', 'pinned', 'bookmarked', 'meta', 'meta.clear']
  };

  var PERM = {
    DEFAULT: 'DEFAULT',
    COMMENT: 'COMMENT',
    META: 'META',
    ORDER: 'ORDER',
    REACTION: 'REACTION',
    SETLIST: 'SETLIST',
    WORDPAETY: 'WORDPAETY',
    YT_SURVEY: 'YT_SURVEY',
    CONFIG: 'CONFIG',
    SERVICE: 'SERVICE',
    USER: 'USER',
    NOTIFICATION: 'NOTIFICATION'
  };

  // --- 内部状態 ---
  var _config = null;
  var _connected = false;
  var _ws = null;
  var _reconnectTimer = null;
  var _subscribers = {};
  var _nextSubscriberId = 1;
  var _commentMap = {};       // id → comment
  var _commentOrder = [];     // id[] (挿入順)
  var _timerMap = {};         // id → setTimeout handle
  var _queue = [];            // 未配信キュー
  var _queueTimer = null;
  var _lastDequeueAtMs = 0;   // 最後にキューから配信した時刻
  var _commentIndexCounter = 0; // commentIndex 通し番号
  var _tickTimer = null;
  var _readyPromise = null;
  var _readyResolve = null;
  var _connectResolve = null;

  // --- ready ---
  _readyPromise = new Promise(function (resolve) {
    _readyResolve = resolve;
  });

  function _initReady() {
    // DOMContentLoaded で十分。window.load はフォント・画像の読み込みを
    // 待つため、外部フォントが遅いと WS 接続が10秒以上ブロックされる。
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        _readyResolve();
      });
    } else {
      _readyResolve();
    }
  }
  _initReady();

  // --- 設定読み込み ---
  function _readConfigFromCSS(config) {
    var style = getComputedStyle(document.documentElement);
    var mapping = {
      '--one-sdk-protocol': 'protocol',
      '--one-sdk-host': 'host',
      '--one-sdk-port': 'port',
      '--one-sdk-pathname': 'pathname',
      '--one-sdk-permissions': 'permissions',
      '--one-sdk-includes': 'includes',
      '--one-sdk-excludes': 'excludes',
      '--one-sdk-include-ids': 'includeIds',
      '--one-sdk-exclude-ids': 'excludeIds',
      '--one-sdk-include-names': 'includeNames',
      '--one-sdk-exclude-names': 'excludeNames',
      '--one-sdk-life-time': 'lifeTime'
    };
    for (var cssVar in mapping) {
      var val = style.getPropertyValue(cssVar).trim().replace(/^["']|["']$/g, '');
      if (val) {
        var key = mapping[cssVar];
        if (key === 'port' || key === 'lifeTime') {
          var num = parseInt(val, 10);
          if (!isNaN(num)) config[key] = num;
        } else if (key === 'permissions' || key === 'includes' || key === 'excludes' ||
                   key === 'includeIds' || key === 'excludeIds' ||
                   key === 'includeNames' || key === 'excludeNames') {
          config[key] = val.split(/\s+/).filter(function (s) { return s; });
        } else {
          config[key] = val;
        }
      }
    }
  }

  function _readConfigFromURL(config) {
    var params = new URLSearchParams(location.search);
    var stringKeys = ['protocol', 'host', 'pathname', 'mode'];
    var numKeys = ['port', 'lifeTime', 'commentLimit', 'intervalTime', 'maxQueueInterval', 'reconnectInterval', 'requestInterval'];
    var arrayKeys = ['permissions', 'includes', 'excludes', 'includeIds', 'excludeIds', 'includeNames', 'excludeNames'];

    stringKeys.forEach(function (key) {
      if (params.has(key)) config[key] = params.get(key);
    });
    numKeys.forEach(function (key) {
      if (params.has(key)) {
        var v = parseInt(params.get(key), 10);
        if (!isNaN(v)) config[key] = v;
      }
    });
    arrayKeys.forEach(function (key) {
      var all = params.getAll(key);
      if (all.length > 0) config[key] = all;
    });
    if (params.has('disabledDelay')) config.disabledDelay = params.get('disabledDelay') !== 'false';
  }

  // --- フィルタ ---
  function _filterComment(comment) {
    if (!_config) return true;
    var service = comment.service || '';
    var id = (comment.data && comment.data.userId) || '';
    var name = (comment.data && (comment.data.name || comment.data.displayName)) || '';

    if (_config.includes && _config.includes.indexOf(service) === -1) return false;
    if (_config.excludes && _config.excludes.indexOf(service) !== -1) return false;
    if (_config.includeIds && _config.includeIds.indexOf(id) === -1) return false;
    if (_config.excludeIds && _config.excludeIds.indexOf(id) !== -1) return false;
    if (_config.includeNames && _config.includeNames.indexOf(name) === -1) return false;
    if (_config.excludeNames && _config.excludeNames.indexOf(name) !== -1) return false;
    return true;
  }

  // --- コメント蓄積 ---
  function _saveComment(comment) {
    var cid = comment.data && comment.data.id;
    if (!cid) return;

    // 既存を更新 or 新規追加
    if (!_commentMap[cid]) {
      _commentOrder.push(cid);
      // commentIndex: 新規コメントにのみ通し番号を付与（既存は維持）
      if (comment.commentIndex == null) {
        comment.commentIndex = _commentIndexCounter;
        _commentIndexCounter += 1;
      }
      if (comment.data && comment.data.commentIndex == null) {
        comment.data.commentIndex = comment.commentIndex;
      }
    } else if (comment.data && comment.data.commentIndex == null && comment.commentIndex != null) {
      comment.data.commentIndex = comment.commentIndex;
    }
    _commentMap[cid] = comment;

    // lifeTime タイマー
    if (_config && _config.lifeTime !== Infinity && _config.lifeTime > 0) {
      if (_timerMap[cid]) clearTimeout(_timerMap[cid]);
      _timerMap[cid] = setTimeout(function () {
        _removeComment(cid);
        _sendComments();
      }, _config.lifeTime);
    }

    // commentLimit 超過時は古いのを除去
    var limit = (_config && _config.commentLimit) || 100;
    while (_commentOrder.length > limit) {
      var oldest = _commentOrder.shift();
      delete _commentMap[oldest];
      if (_timerMap[oldest]) {
        clearTimeout(_timerMap[oldest]);
        delete _timerMap[oldest];
      }
    }
  }

  function _removeComment(cid) {
    delete _commentMap[cid];
    var idx = _commentOrder.indexOf(cid);
    if (idx !== -1) _commentOrder.splice(idx, 1);
    if (_timerMap[cid]) {
      clearTimeout(_timerMap[cid]);
      delete _timerMap[cid];
    }
  }

  function _getCommentList() {
    var list = [];
    for (var i = 0; i < _commentOrder.length; i++) {
      var c = _commentMap[_commentOrder[i]];
      if (c) list.push(c);
    }
    return list;
  }

  function _stampTrace(comment, key, value) {
    if (!comment || typeof comment !== 'object') return;
    if (!comment._komehubTrace || typeof comment._komehubTrace !== 'object') {
      comment._komehubTrace = {};
    }
    comment._komehubTrace[key] = value;
    if (comment.data && typeof comment.data === 'object') {
      comment.data._komehubTrace = comment._komehubTrace;
    }
  }

  // --- 配信 ---
  function _sendComments(newComments) {
    if (!_config) return;
    if (_config.mode === 'diff') {
      _publish('comments', newComments || []);
    } else {
      _publish('comments', _getCommentList());
    }
  }

  function _publish(action, data) {
    for (var id in _subscribers) {
      var sub = _subscribers[id];
      if (sub && sub.action === action && typeof sub.callback === 'function') {
        try { sub.callback(data); } catch (e) {}
      }
    }
  }

  // --- キューイング ---
  function _enqueue(comments) {
    var enqueuedAtMs = Date.now();
    if (!_config || _config.disabledDelay) {
      // 遅延なし: 即座に保存＆配信
      var newOnes = [];
      comments.forEach(function (c) {
        if (_filterComment(c)) {
          _stampTrace(c, 'oneSdkEnqueuedAtMs', enqueuedAtMs);
          _stampTrace(c, 'oneSdkDequeuedAtMs', enqueuedAtMs);
          _saveComment(c);
          newOnes.push(c);
        }
      });
      if (newOnes.length > 0) _sendComments(newOnes);
      return;
    }

    // キューに追加
    comments.forEach(function (c) {
      if (_filterComment(c)) {
        _stampTrace(c, 'oneSdkEnqueuedAtMs', enqueuedAtMs);
        _queue.push(c);
      }
    });
    _processQueue();
  }

  function _calcQueueInterval() {
    return Math.min(
      (_config && _config.maxQueueInterval) || 150,
      ((_config && _config.intervalTime) || 5000) / Math.max(_queue.length, 1)
    );
  }

  function _flushOne() {
    if (_queue.length === 0) return;
    var comment = _queue.shift();
    var now = Date.now();
    _lastDequeueAtMs = now;
    _stampTrace(comment, 'oneSdkDequeuedAtMs', now);
    _saveComment(comment);
    _sendComments([comment]);
  }

  function _scheduleNextFlush(delayMs) {
    _queueTimer = setTimeout(function () {
      _queueTimer = null;
      _flushOne();
      if (_queue.length > 0) {
        _scheduleNextFlush(_calcQueueInterval());
      }
    }, delayMs);
  }

  function _processQueue() {
    if (_queueTimer || _queue.length === 0) return;

    var now = Date.now();
    var elapsed = now - _lastDequeueAtMs;
    var interval = _calcQueueInterval();

    if (elapsed >= interval) {
      // 前回配信から十分な時間が経過 → 即時配信
      _flushOne();
      if (_queue.length > 0) {
        _scheduleNextFlush(_calcQueueInterval());
      }
    } else {
      // 前回配信から間隔が足りない → 残り時間だけ待つ
      _scheduleNextFlush(interval - elapsed);
    }
  }

  // --- WS 接続 ---
  function _connectWS() {
    return new Promise(function (resolve) {
      if (_ws) {
        try { _ws.close(); } catch (e) {}
      }
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
      }

      var runtime = window.KomehubTemplateRuntime;
      if (runtime && typeof runtime.createOneCommeWebSocket === 'function') {
        _ws = runtime.createOneCommeWebSocket();
      } else {
        var host = location.hostname || 'localhost';
        var port = location.port;
        var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var url = protocol + host + (port ? ':' + port : '') + '/onecomme/sub';
        _ws = new WebSocket(url);
      }

      _ws.onopen = function () {
        _connected = true;
        _publish('connected', { comments: _getCommentList() });
        resolve();
      };

      _ws.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          _handleMessage(msg);
        } catch (err) {}
      };

      _ws.onclose = function () {
        _connected = false;
        var interval = (_config && _config.reconnectInterval) || 5000;
        _reconnectTimer = setTimeout(function () {
          _connectWS();
        }, interval);
      };

      _ws.onerror = function () {};

      // タイムアウト: 10秒で接続できなかったら resolve（ブロックしない）
      setTimeout(function () { resolve(); }, 10000);
    });
  }

  function _handleMessage(msg) {
    var type = msg.type;
    if (!type) return;

    switch (type) {
      case 'comments':
        var comments = (msg.data && msg.data.comments) || [];
        var receivedAtMs = Date.now();
        comments.forEach(function (comment) {
          _stampTrace(comment, 'oneSdkReceivedAtMs', receivedAtMs);
        });
        _enqueue(comments);
        break;

      case 'deleted':
        var deletedList = Array.isArray(msg.data) ? msg.data : [msg.data];
        deletedList.forEach(function (d) {
          if (d && d.id) _removeComment(d.id);
        });
        _sendComments();
        _publish('deleted', deletedList);
        break;

      case 'clear':
        _commentMap = {};
        _commentOrder = [];
        _queue = [];
        for (var tid in _timerMap) {
          clearTimeout(_timerMap[tid]);
        }
        _timerMap = {};
        _publish('clear', null);
        _sendComments();
        break;

      default:
        // pinned, meta, reactions 等はそのまま転送
        _publish(type, msg.data);
        break;
    }
  }

  // --- getCommentStyle ---
  function _getCommentStyle(comment) {
    var style = {};
    if (!comment || !comment.data) return style;
    var colors = comment.data.colors;
    if (colors) {
      if (colors.headerBackgroundColor) {
        style['--lcv-header-background-color'] = colors.headerBackgroundColor;
      }
      if (colors.headerTextColor) {
        style['--lcv-header-text-color'] = colors.headerTextColor;
      }
      if (colors.bodyBackgroundColor) {
        style['--lcv-background-color'] = colors.bodyBackgroundColor;
      }
      if (colors.bodyTextColor) {
        style['--lcv-text-color'] = colors.bodyTextColor;
        style['--lcv-comment-shadow'] = 'none';
      }
      if (colors.authorNameTextColor) {
        style['--lcv-name-color'] = colors.authorNameTextColor;
        style['--lcv-name-shadow'] = 'none';
      }
      if (colors.timestampColor) {
        style['--lcv-timestamp-color'] = colors.timestampColor;
      }
    }
    if (comment.data.isMember) {
      style['--lcv-membership-color'] = '#2ba640';
    }
    return style;
  }

  // --- getStyleVariable ---
  function _getStyleVariable(name, defaultValue, parser) {
    var val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!val) return defaultValue;
    if (typeof parser === 'function') {
      try { return parser(val); } catch (e) { return defaultValue; }
    }
    return val;
  }

  // --- 数値フォーマット ---
  var SUFFIXES = ['', 'K', 'M', 'B', 'T', 'P', 'E'];

  function _toShortNumberFormat(num) {
    if (typeof num !== 'number' || isNaN(num)) return '0';
    if (num < 1000) return String(num);
    var tier = Math.floor(Math.log10(Math.abs(num)) / 3);
    if (tier >= SUFFIXES.length) tier = SUFFIXES.length - 1;
    var scaled = num / Math.pow(10, tier * 3);
    var formatted = scaled % 1 === 0 ? String(scaled) : scaled.toFixed(1);
    return formatted + SUFFIXES[tier];
  }

  function _toNumberFromShortNumberFormat(str) {
    if (!str || typeof str !== 'string') return 0;
    var match = str.match(/^([\d.]+)\s*([KMBTPE]?)$/i);
    if (!match) return parseFloat(str) || 0;
    var num = parseFloat(match[1]);
    var suffix = (match[2] || '').toUpperCase();
    var idx = SUFFIXES.indexOf(suffix);
    if (idx > 0) num *= Math.pow(10, idx * 3);
    return num;
  }

  // --- stub HTTP メソッド ---
  function _stubGet(url) { return Promise.resolve({ data: null }); }
  function _stubPost(url, data) { return Promise.resolve({ data: null }); }
  function _stubPut(url, data) { return Promise.resolve({ data: null }); }
  function _stubDelete(url) { return Promise.resolve({ data: null }); }

  // --- OneSDK シングルトン ---
  var sdk = {
    ready: function () {
      return _readyPromise;
    },

    setup: function (config) {
      _config = {};
      var key;
      for (key in DEFAULT_CONFIG) {
        _config[key] = DEFAULT_CONFIG[key];
      }
      if (config) {
        for (key in config) {
          _config[key] = config[key];
        }
      }
      // CSS 変数 → URL パラメータの順で上書き
      try { _readConfigFromCSS(_config); } catch (e) {}
      try { _readConfigFromURL(_config); } catch (e) {}

      // CSS/style の query パラメータ対応
      var params = new URLSearchParams(location.search);
      var cssUrl = params.get('css');
      if (cssUrl) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = cssUrl;
        document.head.appendChild(link);
      }
      var styleStr = params.get('style');
      if (styleStr) {
        var styleEl = document.createElement('style');
        styleEl.textContent = styleStr;
        document.head.appendChild(styleEl);
      }

      return Promise.resolve();
    },

    connect: function () {
      return _readyPromise.then(function () {
        return _connectWS();
      });
    },

    subscribe: function (subscriberObj) {
      var id = _nextSubscriberId++;
      _subscribers[id] = subscriberObj;
      return id;
    },

    unsubscribe: function (subscriberId) {
      delete _subscribers[subscriberId];
    },

    reset: function () {
      _commentMap = {};
      _commentOrder = [];
      _queue = [];
      _commentIndexCounter = 0;
      _lastDequeueAtMs = 0;
      if (_queueTimer) { clearTimeout(_queueTimer); _queueTimer = null; }
      for (var tid in _timerMap) {
        clearTimeout(_timerMap[tid]);
      }
      _timerMap = {};
      _sendComments();
    },

    getCommentStyle: _getCommentStyle,
    getStyleVariable: _getStyleVariable,
    toShortNumberFormat: _toShortNumberFormat,
    toNumberFromShortNumberFormat: _toNumberFromShortNumberFormat,

    // HTTP API stubs（こめはぶでは未使用だが API 互換のため）
    getInfo: function () {
      var isMac = /mac/i.test(navigator.platform || '');
      return Promise.resolve({
        platform: isMac ? 'mac' : 'win',
        version: '0.3.0',
        port: Number(location.port || 0),
        licensed: true,
        templatePath: location.pathname,
        templateUrl: location.href
      });
    },
    checkLicensed: function () { return Promise.resolve(true); },
    getComments: function () { return Promise.resolve(_getCommentList()); },
    searchComments: function () { return Promise.resolve([]); },
    getPinnedComment: function () { return Promise.resolve(null); },
    getTemplates: function () { return Promise.resolve([]); },
    getServices: function () { return Promise.resolve([]); },
    getConfig: function () { return Promise.resolve(JSON.parse(JSON.stringify(_config || DEFAULT_CONFIG))); },
    getOrders: function () { return Promise.resolve([]); },
    cancelOrder: function () { return Promise.resolve([]); },
    completeOrder: function () { return Promise.resolve([]); },
    getSetList: function () { return Promise.resolve({ id: 0, name: '', items: [], completed: [] }); },

    get: _stubGet,
    post: _stubPost,
    put: _stubPut,
    'delete': _stubDelete
  };

  // getter プロパティ
  Object.defineProperty(sdk, 'connected', {
    get: function () { return _connected; },
    enumerable: true
  });

  Object.defineProperty(sdk, 'config', {
    get: function () { return Object.freeze(JSON.parse(JSON.stringify(_config || DEFAULT_CONFIG))); },
    enumerable: true
  });

  Object.defineProperty(sdk, 'PERM', {
    get: function () { return PERM; },
    enumerable: true
  });

  Object.defineProperty(sdk, 'DEFAULT_CONFIG', {
    get: function () { return DEFAULT_CONFIG; },
    enumerable: true
  });

  window.OneSDK = sdk;
})();
