// === remote shell 共通 helpers ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5
//
// すべての remote ページから読まれる common モジュール。
// HTTP fetch / SSE 接続 / フォーマッタなどを集約する。

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var remoteCommonLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('RemoteCommon')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var ns = window.KomehubRemote = window.KomehubRemote || {};

  // 注: 戻るボタン (#rh-back-btn) の click 結線は SPA 化 (X-1) で app.js に
  // 移管した。 旧 5 HTML 時代に common.js が DOMContentLoaded で bind していたが、
  // app.js と二重発火して history.back() が 2 回呼ばれる不具合があったため削除。

  // ───── HTTP wrappers ─────

  ns.fetchJson = function (url, init) {
    return fetch(url, Object.assign({ cache: 'no-store' }, init || {})).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  };

  ns.postJson = function (url, body) {
    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  };

  // ───── SSE 接続 ─────

  // /api/stream に EventSource で接続し、event を dispatcher に渡す。
  // dispatcher は { onComment, onCommentDeleted, onStaticUpdate, onStatus, onOpen, onError }。
  // 自動再接続 (= EventSource の標準動作) + 接続状態 callback で UI 表示。
  //
  // public_api SSE は translate_public_stream_message で形式変換されており、以下を扱う:
  //   {type:"version",data:"x.y.z"}
  //   {type:"status",data:{connected, videoId, viewerCount}}
  //   {type:"event",event:"comment",data:RawComment,timestamp}
  //   {type:"event",event:"comment-deleted",data:{id}}
  //   {type:"event",event:"reaction",data:RawReaction,timestamp}
  //   {type:"performance",sceneId,data,timestamp}
  //   {type:"performance-clear",sceneId,timestamp}
  //   {type:"static",path:"comment-responded"|"listener-greeted"|...,data:...}
  //   {type:"tts-state",data}
  //   {type:"pause",data:{paused}}
  //   {type:"reload"}
  ns.connectStream = function (handlers) {
    handlers = handlers || {};
    var es = new EventSource('/api/stream');
    es.onopen = function () {
      if (typeof handlers.onOpen === 'function') handlers.onOpen();
    };
    es.onerror = function () {
      if (typeof handlers.onError === 'function') handlers.onError();
    };
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'event':
          if (msg.event === 'comment') {
            if (typeof handlers.onComment === 'function') handlers.onComment(msg.data);
          } else if (msg.event === 'comment-deleted') {
            if (typeof handlers.onCommentDeleted === 'function') handlers.onCommentDeleted(msg.data);
          }
          break;
        case 'static':
          if (typeof handlers.onStaticUpdate === 'function') handlers.onStaticUpdate(msg.path, msg.data);
          break;
        case 'status':
          // 接続状態の更新。connection static-update と等価扱いで dispatch
          if (typeof handlers.onStaticUpdate === 'function') handlers.onStaticUpdate('connection', msg.data);
          break;
        default: break;
      }
    };
    return es;
  };

  // ───── ステータス表示 helper ─────

  ns.refreshStatusBadge = function (el) {
    if (!el) return Promise.resolve(null);
    return ns.fetchJson('/api/status').then(function (s) {
      el.classList.remove('live', 'disconnected');
      if (s && s.connected) {
        el.classList.add('live');
        var label = 'LIVE 中';
        if (s.videoId) label += ' · ' + s.videoId;
        if (s.isOwnStream === false) label += ' (他枠)';
        el.textContent = label;
      } else {
        el.classList.add('disconnected');
        el.textContent = 'オフライン';
      }
      return s;
    }).catch(function () {
      el.textContent = '接続できません';
      return null;
    });
  };

  // ───── フォーマッタ (= 本体 listenerMgrFormatTime / Yen 相当の最小実装) ─────

  ns.formatRelativeTime = function (unixMs) {
    if (!unixMs) return '';
    var d = new Date(Number(unixMs));
    if (isNaN(d.getTime())) return '';
    var diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return diffMin + ' 分前';
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + ' 時間前';
    var diffD = Math.floor(diffH / 24);
    if (diffD < 30) return diffD + ' 日前';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  };

  ns.formatYen = function (value) {
    if (!value || value === 0) return '';
    return '¥' + Number(value).toLocaleString('ja-JP');
  };

  ns.truncate = function (text, max) {
    var v = String(text == null ? '' : text);
    if (!max || v.length <= max) return v;
    return v.substring(0, max) + '...';
  };

  // 本体 PC 側で書き込まれた絶対 URL (= http://127.0.0.1:11280/cache/...) を
  // remote 端末から到達できる相対 URL に書き換える。
  // record_comment 時に image_cache が profileImage を 11280 直 URL に書き換えるため、
  // remote 端末からは host が違う (= 自端末の 127.0.0.1 を見てしまう) → 取得できない。
  // remote port (= cache::remote_routes) で /cache/* を公開しているので、相対化すれば
  // ブラウザは現在開いているホスト (= 192.168.x.x:11281) に GET する。
  ns.normalizeAssetUrl = function (url) {
    if (!url) return url;
    return String(url).replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?\//, '/');
  };

  // ───── ナビゲーション helper ─────

  ns.toListenerDetailUrl = function (channelId) {
    return '/remote/listeners/' + encodeURIComponent(channelId);
  };
  ns.toSearchUrl = function (params) {
    var qs = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== '') qs.append(k, params[k]);
    });
    return '/remote/search' + (qs.toString() ? '?' + qs.toString() : '');
  };

  // ───── コメ data → リスナー詳細 fallback ─────
  // 自枠外 (= listeners.db に行が無い) リスナーをコメから開いた時、
  // sessionStorage 経由でコメ data を渡して最低限の情報表示を可能にする。
  // 本体 renderer.js の commentDataToListenerDetail と同等の振る舞い。
  function fallbackKey(channelId) {
    return 'rh-fallback-comment::' + String(channelId);
  }
  ns.stashCommentForFallback = function (channelId, comment) {
    if (!channelId || !comment) return;
    try {
      sessionStorage.setItem(fallbackKey(channelId), JSON.stringify(comment));
    } catch (err) {
      // intentional: sessionStorage 容量超過 / プライベートモード時の救済。
      // fallback comment が保存できなくても remote view 本体は機能する。
      remoteCommonLog.debug('sessionStorage save failed:', err);
    }
  };
  // peek: sessionStorage から読むが remove しない (= 戻る操作で再取得できるよう残す)。
  // タブを閉じれば自動で消えるのでゴミは溜まらない。
  ns.popCommentForFallback = function (channelId) {
    if (!channelId) return null;
    try {
      var raw = sessionStorage.getItem(fallbackKey(channelId));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  };
  ns.commentToFallbackDetail = function (data) {
    if (!data) return null;
    var ch = data.userId || data.channelId || data.listenerChannelId || '';
    return {
      channelId: ch,
      displayName: data.name || '(no name)',
      username: '',
      iconUrl: data.profileImage || '',
      firstSeenAt: data.timestamp || 0,
      lastSeenAt: data.timestamp || 0,
      commentCount: 1,
      superchatCount: 0,
      superchatAmountJpy: 0,
      isMember: !!data.isMember,
      isModerator: !!data.isModerator,
      memberMonthsMax: data.memberMonths || 0,
      notes: '',
      label: '',
      nickname: '',
      recentComments: [{
        id: data.id || '',
        streamId: data.streamId || data.liveId || '',
        postedAt: data.timestamp || Date.now(),
        body: data.comment || '',
        commentType: (data.amountDisplay || data.amount > 0 || data.hasGift) ? 'superchat' : 'chat',
        superchatAmountJpy: data.amount || null,
        respondedAt: data.respondedAt || 0,
        raw: {
          name: data.name || '',
          displayName: data.name || '',
          profileImage: data.profileImage || '',
          commentHtml: data.commentHtml || '',
          timestamp: data.timestamp || '',
          amount: data.amount || 0,
          amountDisplay: data.amountDisplay || '',
          superchatTier: data.superchatTier || '',
          isMember: !!data.isMember,
          isMembership: !!data.isMembership,
          isMembershipGift: !!data.isMembershipGift,
          giftCount: data.giftCount || 0,
        }
      }],
      _commentOnly: true
    };
  };
})();
