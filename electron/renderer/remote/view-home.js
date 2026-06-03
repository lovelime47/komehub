// === remote view: home ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.2 (B-2 強化版)
//
// 配信中の手元ダッシュボード:
// - 配信情報パネル (= LIVE 時、 タイトル / 経過時間 / 同接 / いいね / 累計 KPI)
// - アクション 3 カード (= コメ / ギフト / リスナー、 件数バッジ + 未対応 N)
// - フッター文言 (= スコープ説明、 削除 / import-export 不可)
//
// subscribeForever で SSE comment / listener-* / connection を永続購読し、
// タブ非表示中でも:
// - liveCount を increment (= 「コメ +N」表示)
// - stream-scoped-counts (= unGreeted listener / unResponded gift) を background 更新
// - 配信切替 (= connection videoId 変化) で全 state リセット + 再 fetch

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var homeLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('Home')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  if (!window.KomehubViews) window.KomehubViews = {};

  var state = {
    // 接続情報
    connected: false,
    streamVideoId: '',
    isOwnStream: false,
    // 配信詳細 (= /api/listeners/streams/{video_id})
    streamTitle: '',
    streamStartedAt: 0,
    channelName: '',
    channelIconUrl: '',
    currentViewers: 0,
    peakConcurrentViewers: 0,
    likes: 0,
    streamCommentCount: 0,
    streamScAmountJpy: 0,
    // 件数 (= /api/listeners/stream-scoped-counts)
    listenersAll: 0,
    listenersUnGreeted: 0,
    // 未対応ギフト件数 (= view-gifts.js の state を参照、 ただし home は独立。
    //                    /api/listeners/comments/search で取れる、 重いので
    //                    SSE comment-responded ベースで increment/decrement)
    giftsUnresponded: 0,
    // SSE 累計 (= 「+N コメ」表示用)
    liveCount: 0,
    // 初回 fetch 済か
    initialized: false
  };
  var dom = null;
  var isActive = false;
  var foreverSubscribed = false;
  var shellRef = null;
  var clockTimer = null;
  var countsRefreshTimer = null;

  function subscribeForever(shell) {
    if (foreverSubscribed) return;
    foreverSubscribed = true;
    shellRef = shell;

    shell.on('comment', function () {
      state.liveCount += 1;
      if (isActive && dom) updateActionCards();
    });

    shell.on('staticUpdate', function (path, data) {
      if (path === 'connection') {
        var prevVideo = state.streamVideoId;
        state.connected = !!(data && data.connected);
        if (data && data.videoId) {
          state.streamVideoId = data.videoId;
          state.isOwnStream = !!data.isOwnStream;
          state.currentViewers = data.viewerCount || state.currentViewers;
        } else {
          state.streamVideoId = '';
          state.isOwnStream = false;
        }
        if (prevVideo !== state.streamVideoId) {
          // 配信切替で state リセット
          state.streamTitle = '';
          state.streamStartedAt = 0;
          state.channelName = '';
          state.channelIconUrl = '';
          state.peakConcurrentViewers = 0;
          state.likes = 0;
          state.streamCommentCount = 0;
          state.streamScAmountJpy = 0;
          state.listenersAll = 0;
          state.listenersUnGreeted = 0;
          state.giftsUnresponded = 0;
          state.liveCount = 0;
          loadStreamDetail();
          loadCounts();
        }
        if (isActive && dom) renderAll();
      } else if (path === 'listener-updated' || path === 'listener-greeted' || path === 'listener-hidden') {
        scheduleCountsRefresh();
      } else if (path === 'comment-responded') {
        scheduleCountsRefresh();
      }
    });

    // 初回 status
    R.fetchJson('/api/status').then(function (s) {
      state.connected = !!(s && s.connected);
      if (s && s.connected && s.videoId) {
        state.streamVideoId = s.videoId;
        state.isOwnStream = !!s.isOwnStream;
        state.currentViewers = s.viewerCount || 0;
      }
      state.initialized = true;
      loadStreamDetail();
      loadCounts();
      if (isActive && dom) renderAll();
    }).catch(function (err) { homeLog.debug("promise rejected (catch swallow):", err); });
  }

  function loadStreamDetail() {
    if (!state.streamVideoId) return;
    R.fetchJson('/api/listeners/streams/' + encodeURIComponent(state.streamVideoId)).then(function (resp) {
      // /api/listeners/streams/{video_id} は { ok, stream, ... } 形式の可能性。
      // serde flatten で stream フィールドが直下展開されている場合もある (= memory feedback_serde_flatten 参照)。
      // どちらでも動くように両対応
      if (!resp || !resp.ok) return;
      var s = resp.detail || resp.stream || resp;
      // 直下展開の場合は resp 自体が StreamRow
      var src = s && s.videoId ? s : resp;
      state.streamTitle = src.title || '';
      state.streamStartedAt = src.startedAt || 0;
      state.channelName = src.channelName || '';
      state.channelIconUrl = src.channelIconUrl || '';
      state.currentViewers = src.currentViewers || state.currentViewers;
      state.peakConcurrentViewers = src.peakConcurrentViewers || 0;
      state.likes = src.likes || 0;
      state.streamCommentCount = src.commentCount || 0;
      state.streamScAmountJpy = src.superchatAmountJpy || 0;
      if (isActive && dom) renderAll();
    }).catch(function (err) { homeLog.debug("promise rejected (catch swallow):", err); });
  }

  function loadCounts() {
    if (!state.streamVideoId) {
      state.listenersAll = 0;
      state.listenersUnGreeted = 0;
      if (isActive && dom) updateActionCards();
      return;
    }
    R.fetchJson('/api/listeners/stream-scoped-counts?streamVideoId=' + encodeURIComponent(state.streamVideoId)).then(function (resp) {
      if (resp && resp.counts) {
        state.listenersAll = resp.counts.all || 0;
        state.listenersUnGreeted = resp.counts.unGreeted || 0;
      }
      if (isActive && dom) updateActionCards();
    }).catch(function (err) { homeLog.debug("promise rejected (catch swallow):", err); });
  }

  function scheduleCountsRefresh() {
    if (countsRefreshTimer) return;
    countsRefreshTimer = setTimeout(function () {
      countsRefreshTimer = null;
      loadCounts();
    }, 600);
  }

  // ───── 時刻表示 ヘルパ ─────
  function formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function formatNumber(n) {
    return Number(n || 0).toLocaleString('ja-JP');
  }

  // ───── DOM 描画 (= isActive 時のみ) ─────
  function renderAll() {
    if (!dom) return;
    renderStatusPanel();
    updateActionCards();
  }

  function renderStatusPanel() {
    if (!dom) return;
    var panel = dom.statusPanel;
    if (!state.connected || !state.streamVideoId) {
      // オフライン
      panel.innerHTML =
        '<div class="rh-home-offline">' +
          '<div class="rh-home-offline-icon" aria-hidden="true">⚫</div>' +
          '<div class="rh-home-offline-text">' +
            '<div class="rh-home-offline-title">LIVE 接続中ではありません</div>' +
            '<div class="rh-home-offline-sub">本体側で配信に接続するとここに情報が出ます</div>' +
          '</div>' +
        '</div>';
      stopClock();
      return;
    }
    // LIVE 中
    var iconHtml = state.channelIconUrl
      ? '<img class="rh-home-channel-icon" src="' + escapeHtml(R.normalizeAssetUrl(state.channelIconUrl)) + '" alt="">'
      : '<div class="rh-home-channel-icon placeholder">' + escapeHtml((state.channelName || '?').charAt(0)) + '</div>';
    var ownBadge = state.isOwnStream
      ? '<span class="rh-home-own-badge">自チャンネル</span>'
      : '<span class="rh-home-own-badge other">他枠</span>';
    panel.innerHTML =
      '<div class="rh-home-live-hero">' +
        iconHtml +
        '<div class="rh-home-live-meta">' +
          '<div class="rh-home-live-row1">' +
            '<span class="rh-home-live-pulse" aria-hidden="true"></span>' +
            '<span class="rh-home-live-label">LIVE</span>' +
            ownBadge +
            '<span class="rh-home-live-elapsed" id="rh-home-elapsed">—</span>' +
          '</div>' +
          '<div class="rh-home-live-title">' + escapeHtml(state.streamTitle || '(タイトル取得中)') + '</div>' +
          (state.channelName ? '<div class="rh-home-live-channel">' + escapeHtml(state.channelName) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="rh-home-kpi-grid">' +
        kpiCell('同接', formatNumber(state.currentViewers), state.peakConcurrentViewers > 0 ? 'ピーク ' + formatNumber(state.peakConcurrentViewers) : '') +
        kpiCell('いいね', formatNumber(state.likes), '') +
        kpiCell('累計コメ', formatNumber(state.streamCommentCount), '') +
        kpiCell('累計SC', state.streamScAmountJpy > 0 ? R.formatYen(state.streamScAmountJpy) : '¥0', '') +
      '</div>';
    startClock();
  }

  function kpiCell(label, value, sub) {
    return '<div class="rh-home-kpi">' +
      '<div class="rh-home-kpi-value">' + escapeHtml(value) + '</div>' +
      '<div class="rh-home-kpi-label">' + escapeHtml(label) + '</div>' +
      (sub ? '<div class="rh-home-kpi-sub">' + escapeHtml(sub) + '</div>' : '') +
    '</div>';
  }

  function startClock() {
    stopClock();
    updateElapsed();
    clockTimer = setInterval(updateElapsed, 1000);
  }
  function stopClock() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }
  function updateElapsed() {
    if (!dom) return;
    var el = dom.statusPanel.querySelector('#rh-home-elapsed');
    if (!el) return;
    if (!state.streamStartedAt) {
      el.textContent = '—';
      return;
    }
    el.textContent = formatDuration(Date.now() - state.streamStartedAt);
  }

  function updateActionCards() {
    if (!dom) return;
    // コメント card
    var liveSuffix = state.liveCount > 0 ? ' (+' + state.liveCount + ')' : '';
    dom.commentsMeta.textContent = state.streamVideoId
      ? formatNumber(state.streamCommentCount) + ' 件' + liveSuffix
      : '—';
    // ギフト card
    dom.giftsMeta.textContent = state.streamScAmountJpy > 0
      ? R.formatYen(state.streamScAmountJpy)
      : (state.streamVideoId ? '0 円' : '—');
    // リスナー card
    if (state.streamVideoId && state.listenersAll > 0) {
      var unGreetedSuffix = state.listenersUnGreeted > 0
        ? ' (未対応 ' + state.listenersUnGreeted + ')'
        : '';
      dom.listenersMeta.textContent = state.listenersAll + ' 名' + unGreetedSuffix;
    } else {
      dom.listenersMeta.textContent = state.streamVideoId ? '0 名' : '—';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ───── init / destroy ─────
  function init(container, params, shell) {
    shell.setTitle('こめはぶ Remote');
    shell.setBackVisible(false);
    shellRef = shell;

    var wrap = document.createElement('main');
    wrap.className = 'rh-main rh-view-home';
    wrap.innerHTML =
      '<section class="rh-home-status-panel" id="rh-home-status-panel"></section>' +
      '<section class="rh-home-actions">' +
        '<a class="rh-card rh-home-action-card" href="/remote/comments">' +
          '<div class="rh-card-icon">💬</div>' +
          '<div class="rh-card-body">' +
            '<div class="rh-card-label">コメント</div>' +
            '<div class="rh-card-meta" id="rh-home-comments-meta">—</div>' +
          '</div>' +
          '<div class="rh-card-arrow" aria-hidden="true">›</div>' +
        '</a>' +
        '<a class="rh-card rh-home-action-card" href="/remote/gifts">' +
          '<div class="rh-card-icon">🎁</div>' +
          '<div class="rh-card-body">' +
            '<div class="rh-card-label">ギフト</div>' +
            '<div class="rh-card-meta" id="rh-home-gifts-meta">—</div>' +
          '</div>' +
          '<div class="rh-card-arrow" aria-hidden="true">›</div>' +
        '</a>' +
        '<a class="rh-card rh-home-action-card" href="/remote/listeners">' +
          '<div class="rh-card-icon">👥</div>' +
          '<div class="rh-card-body">' +
            '<div class="rh-card-label">リスナー</div>' +
            '<div class="rh-card-meta" id="rh-home-listeners-meta">—</div>' +
          '</div>' +
          '<div class="rh-card-arrow" aria-hidden="true">›</div>' +
        '</a>' +
        '<a class="rh-card rh-home-action-card" href="/remote/archive">' +
          '<div class="rh-card-icon">📚</div>' +
          '<div class="rh-card-body">' +
            '<div class="rh-card-label">アーカイブ</div>' +
            '<div class="rh-card-meta">配信ログ / コメ検索 / リスナー検索</div>' +
          '</div>' +
          '<div class="rh-card-arrow" aria-hidden="true">›</div>' +
        '</a>' +
        '<a class="rh-card rh-home-action-card subtle" href="/remote/ponout/" data-external="ponout">' +
          '<div class="rh-card-icon">🎉</div>' +
          '<div class="rh-card-body">' +
            '<div class="rh-card-label">ポン出し</div>' +
            '<div class="rh-card-meta">別画面で開く</div>' +
          '</div>' +
          '<div class="rh-card-arrow" aria-hidden="true">›</div>' +
        '</a>' +
      '</section>';
    container.appendChild(wrap);

    dom = {
      wrap: wrap,
      statusPanel: wrap.querySelector('#rh-home-status-panel'),
      commentsMeta: wrap.querySelector('#rh-home-comments-meta'),
      giftsMeta: wrap.querySelector('#rh-home-gifts-meta'),
      listenersMeta: wrap.querySelector('#rh-home-listeners-meta')
    };
    isActive = true;

    renderAll();
    // 初回未完了なら今 trigger (= subscribeForever が走っていない unlikely ケースの保険)
    if (!state.initialized) {
      R.fetchJson('/api/status').then(function (s) {
        state.connected = !!(s && s.connected);
        if (s && s.connected && s.videoId) {
          state.streamVideoId = s.videoId;
          state.isOwnStream = !!s.isOwnStream;
        }
        loadStreamDetail();
        loadCounts();
        if (isActive && dom) renderAll();
      });
    } else if (state.streamVideoId) {
      // active 復帰時に最新の detail / counts を取り直す
      loadStreamDetail();
      loadCounts();
    }

    return {
      destroy: function () {
        isActive = false;
        dom = null;
        stopClock();
      }
    };
  }

  window.KomehubViews.home = { init: init, subscribeForever: subscribeForever };
})();
