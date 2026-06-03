// === remote view: gifts ===
// 設計正本: 本体 cl-tab gifts (renderer.js:3779 周辺) の移植
//
// 当該枠 (= LIVE 現枠) のギフト (= スパチャ + ステッカー + メンバーシップギフト)
// のみを古→新で並べる。 配信者の「お礼漏れ防止」用。
//
// isGiftComment 判定は本体と同じ:
//   hasGift || isMembershipGift || stickerImage (truthy string)
//   (= メンバー加入 isMembership はお金を投げる行為ではないので除外)
//
// subscribeForever で永続購読し、 タブ非表示中も:
// - state.gifts に新着 push
// - 未対応件数を shell.setTabBadge('gifts', n) で bottom tab bar に反映
// - 配信切替 (= connection videoId 変化) で全 state クリア + 新枠の初回 fetch

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var giftsLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('Gifts')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubViews) window.KomehubViews = {};

  var state = {
    gifts: [],
    loadedIds: new Set(),
    streamVideoId: '',
    isOwnStream: false,
    hiddenForComments: new Set(),
    unrespondedCount: 0,
    initialFetchDone: false,
    follow: true,    // 末尾追従モード
    scrollTop: 0     // destroy 時の listWrap.scrollTop を保持、 再 init で復元
  };
  var dom = null;
  var isActive = false;
  var foreverSubscribed = false;
  var shellRef = null;

  function isGiftComment(data) {
    if (!data) return false;
    return !!(
      data.hasGift ||
      data.isMembershipGift ||
      (typeof data.stickerImage === 'string' && data.stickerImage)
    );
  }

  function listenerIdOf(data) {
    var raw = data.userId || data.channelId || data.listenerChannelId || '';
    return String(raw).replace(/^yt-/, '');
  }

  function recomputeUnrespondedBadge() {
    var n = 0;
    for (var i = 0; i < state.gifts.length; i++) {
      if (!(state.gifts[i].respondedAt > 0)) n += 1;
    }
    state.unrespondedCount = n;
    if (shellRef) shellRef.setTabBadge('gifts', n);
  }

  // ───── 永続 handlers ─────
  function onLiveCommentForever(comment) {
    if (!comment || !comment.id) return;
    if (!isGiftComment(comment)) return;
    if (state.hiddenForComments.has(listenerIdOf(comment))) return;
    if (state.loadedIds.has(comment.id)) {
      // 同 ID 既存なら上書き
      var idx = state.gifts.findIndex(function (g) { return g.id === comment.id; });
      if (idx >= 0) state.gifts[idx] = comment;
    } else {
      state.gifts.push(comment);
      state.loadedIds.add(comment.id);
    }
    recomputeUnrespondedBadge();
    if (isActive && dom) {
      rerender();
      // follow モード時のみ末尾追従 (= ユーザーが上を見ている時は強制スクロールしない)
      if (state.follow && dom.listWrap) {
        dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
      }
    }
  }

  function onCommentDeletedForever(data) {
    var id = data && data.id ? data.id : (data && Array.isArray(data) ? data[0] : null);
    if (!id) return;
    if (!state.loadedIds.has(id)) return;
    var idx = state.gifts.findIndex(function (g) { return g.id === id; });
    if (idx >= 0) {
      state.gifts.splice(idx, 1);
      state.loadedIds.delete(id);
      recomputeUnrespondedBadge();
      if (isActive && dom) rerender();
    }
  }

  function onStaticUpdateForever(path, data) {
    if (path === 'connection') {
      var prevVideo = state.streamVideoId;
      if (data && data.videoId) {
        state.streamVideoId = data.videoId;
        state.isOwnStream = !!data.isOwnStream;
      } else {
        state.streamVideoId = '';
        state.isOwnStream = false;
      }
      if (prevVideo !== state.streamVideoId) {
        state.gifts = [];
        state.loadedIds = new Set();
        state.initialFetchDone = false;
        recomputeUnrespondedBadge();
        if (isActive && dom) rerender();
        if (state.streamVideoId) initialFetch();
      }
    } else if (path === 'comment-responded' && data && data.commentId) {
      var g = state.gifts.find(function (x) { return x.id === data.commentId; });
      if (g) {
        g.respondedAt = data.respondedAt || 0;
        recomputeUnrespondedBadge();
        if (isActive && dom) applyRespondedToDom(data.commentId, data.respondedAt || 0);
      }
    } else if (path === 'listener-hidden' && data && data.listenerChannelId) {
      var lid = String(data.listenerChannelId).replace(/^yt-/, '');
      if (data.hideFromComments) {
        state.hiddenForComments.add(lid);
        // 既存 gifts から該当 listener を除外 (= 配信者の管理 UI からは見えない)
        state.gifts = state.gifts.filter(function (g) {
          if (listenerIdOf(g) === lid) {
            state.loadedIds.delete(g.id);
            return false;
          }
          return true;
        });
      } else {
        state.hiddenForComments.delete(lid);
        // 復帰は次回 initialFetch でしか反映できない (= 過去 gift は state に無い)
      }
      recomputeUnrespondedBadge();
      if (isActive && dom) rerender();
    }
  }

  function subscribeForever(shell) {
    if (foreverSubscribed) return;
    foreverSubscribed = true;
    shellRef = shell;
    shell.on('comment', onLiveCommentForever);
    shell.on('commentDeleted', onCommentDeletedForever);
    shell.on('staticUpdate', onStaticUpdateForever);
    R.fetchJson('/api/status').then(function (s) {
      if (s && s.connected && s.videoId) {
        state.streamVideoId = s.videoId;
        state.isOwnStream = !!s.isOwnStream;
        initialFetch();
      }
    }).catch(function (err) { giftsLog.debug("promise rejected (catch swallow):", err); });
  }

  function initialFetch() {
    if (!state.streamVideoId) return;
    if (state.initialFetchDone) return;
    R.postJson('/api/listeners/comments/search', {
      streamIds: [state.streamVideoId],
      commentTypes: ['superchat', 'sticker', 'gift'],
      limit: 500,
      offset: 0
    }).then(function (resp) {
      if (!resp || !resp.ok || !resp.page) return;
      var rows = resp.page.rows || [];
      rows.sort(function (a, b) {
        return (a.postedAt || 0) - (b.postedAt || 0);
      });
      rows.forEach(function (row) {
        if (state.loadedIds.has(row.id)) return;
        var data = commentRowToCommentData(row);
        if (state.hiddenForComments.has(listenerIdOf(data))) return;
        state.gifts.push(data);
        state.loadedIds.add(row.id);
      });
      state.initialFetchDone = true;
      recomputeUnrespondedBadge();
      if (isActive && dom) {
        rerender();
        if (dom.listWrap) dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
      }
    }).catch(function (err) { giftsLog.debug('gifts initial fetch rejected (catch swallow):', err); });
  }

  // /api/listeners/comments/search の CommentRow を createCommentItem 用 data に変換。
  // view-listener-detail.js / view-search.js と同じ整形パターン。
  function commentRowToCommentData(row) {
    var raw = row.raw || {};
    return {
      id: row.id,
      name: raw.name || raw.displayName || '(no name)',
      profileImage: raw.profileImage || '',
      comment: row.body || raw.comment || '',
      commentHtml: raw.commentHtml || '',
      timestamp: raw.timestamp || row.postedAt,
      amount: row.superchatAmountJpy || raw.amount || 0,
      currency: row.superchatCurrency || raw.currency || '',
      amountDisplay: raw.amountDisplay || '',
      superchatTier: raw.superchatTier || '',
      respondedAt: row.respondedAt || 0,
      isMember: !!raw.isMember,
      isMembership: !!raw.isMembership,
      isMembershipGift: !!raw.isMembershipGift,
      giftCount: raw.giftCount || 0,
      hasGift: !!raw.hasGift || !!row.superchatAmountJpy,
      stickerImage: raw.stickerImage || '',
      userId: raw.userId || row.listenerChannelId,
      channelId: raw.channelId || row.listenerChannelId,
      listenerChannelId: row.listenerChannelId
    };
  }

  // ───── DOM ─────
  function rerender() {
    if (!dom) return;
    if (state.gifts.length === 0) {
      dom.listEl.replaceChildren();
      dom.emptyEl.textContent = state.streamVideoId
        ? 'この枠のギフトはまだありません'
        : 'LIVE 接続中の配信枠がありません';
      dom.emptyEl.style.display = '';
      dom.countEl.textContent = '0 件';
      return;
    }
    dom.emptyEl.style.display = 'none';
    var frag = document.createDocumentFragment();
    state.gifts.forEach(function (g) {
      frag.appendChild(KS.createCommentItem(g, {
        onClick: function (data) {
          var ch = data.userId || data.channelId || data.listenerChannelId;
          if (ch && shellRef) {
            R.stashCommentForFallback(ch, data);
            shellRef.navigate(R.toListenerDetailUrl(ch));
          }
        },
        onToggleResponded: state.isOwnStream ? toggleResponded : null,
        formatTime: R.formatRelativeTime,
        formatYen: R.formatYen,
        truncate: R.truncate,
        rewriteUrl: R.normalizeAssetUrl
      }));
    });
    dom.listEl.replaceChildren(frag);
    dom.countEl.textContent = state.gifts.length + ' 件 (未対応 ' + state.unrespondedCount + ')';
  }

  function applyRespondedToDom(commentId, respondedAt) {
    if (!dom) return;
    var safe = String(commentId).replace(/"/g, '\\"');
    var nodes = dom.listEl.querySelectorAll('[data-id="' + safe + '"]');
    var isResponded = (respondedAt || 0) > 0;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].dataset.responded = isResponded ? '1' : '0';
      var btn = nodes[i].querySelector('.kh-toggle-responded');
      if (btn) btn.dataset.responded = isResponded ? '1' : '0';
    }
  }

  function toggleResponded(commentId, nextValue) {
    if (!commentId) return;
    var g = state.gifts.find(function (x) { return x.id === commentId; });
    if (g) g.respondedAt = nextValue ? Date.now() : 0;
    recomputeUnrespondedBadge();
    applyRespondedToDom(commentId, nextValue ? Date.now() : 0);
    if (isActive && dom) {
      // count 表示更新
      dom.countEl.textContent = state.gifts.length + ' 件 (未対応 ' + state.unrespondedCount + ')';
    }

    R.postJson('/api/comments/' + encodeURIComponent(commentId) + '/responded', {
      value: nextValue ? 1 : 0
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        if (g) g.respondedAt = nextValue ? 0 : Date.now();
        recomputeUnrespondedBadge();
        applyRespondedToDom(commentId, g ? g.respondedAt : 0);
        if (isActive && dom) {
          dom.countEl.textContent = state.gifts.length + ' 件 (未対応 ' + state.unrespondedCount + ')';
        }
        KS.showUndoSnackbar({
          message: '更新に失敗しました',
          actionLabel: '再試行',
          onAction: function () { toggleResponded(commentId, nextValue); }
        });
      }
    }).catch(function () {
      if (g) g.respondedAt = nextValue ? 0 : Date.now();
      recomputeUnrespondedBadge();
      applyRespondedToDom(commentId, g ? g.respondedAt : 0);
    });
  }

  // ───── init / destroy ─────
  function init(container, params, shell) {
    shell.setTitle('ギフト');
    shell.setBackVisible(false);
    shellRef = shell;

    var wrap = document.createElement('div');
    wrap.className = 'rh-view-gifts';
    wrap.innerHTML =
      '<div class="rh-list-wrap" id="rh-g-list-wrap">' +
        '<div id="rh-g-list"></div>' +
        '<div id="rh-g-empty" class="rh-empty" style="display:none">この枠のギフトはまだありません</div>' +
      '</div>' +
      '<footer class="rh-footer"><span id="rh-g-count">0 件</span></footer>';
    container.appendChild(wrap);

    dom = {
      wrap: wrap,
      listWrap: wrap.querySelector('#rh-g-list-wrap'),
      listEl: wrap.querySelector('#rh-g-list'),
      emptyEl: wrap.querySelector('#rh-g-empty'),
      countEl: wrap.querySelector('#rh-g-count')
    };
    isActive = true;

    // state から rehydrate
    if (state.gifts.length > 0) {
      rerender();
      requestAnimationFrame(function () {
        if (!dom || !dom.listWrap) return;
        if (state.follow) dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
        else dom.listWrap.scrollTop = state.scrollTop;
      });
    } else if (!state.initialFetchDone && state.streamVideoId) {
      // subscribeForever 経由で初回 fetch が走っていない場合の保険
      initialFetch();
    } else {
      rerender();
    }

    // 末尾追従モードの追跡 (= 最下端付近にいる時のみ新着で auto scroll)
    dom.listWrap.addEventListener('scroll', function () {
      if (!dom || !dom.listWrap) return;
      var bottomGap = dom.listWrap.scrollHeight - dom.listWrap.clientHeight - dom.listWrap.scrollTop;
      state.follow = bottomGap < 6;
    }, { passive: true });

    return {
      destroy: function () {
        if (dom && dom.listWrap) state.scrollTop = dom.listWrap.scrollTop;
        isActive = false;
        dom = null;
      }
    };
  }

  window.KomehubViews.gifts = {
    init: init,
    subscribeForever: subscribeForever
  };
})();
