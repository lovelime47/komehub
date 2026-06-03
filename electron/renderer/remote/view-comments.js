// === remote view: comments ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.3 (= SPA 化 X-2)
//
// 「タブ移動で SSE が切れる / コメが飛ぶ」根本対策:
// - state は module-level に保持 (= タブ移動で destroy しても消えない)
// - SSE subscribe は subscribeForever() で **一度だけ** 行い、 destroy しても
//   解除しない (= 他 view を表示中も comment / commentDeleted / staticUpdate
//   を受信し state を更新し続ける)
// - DOM 反映 (= rerender / DOM in-place 更新) は isActive=true (= comments view
//   が表示中) の時のみ行う
//
// この設計により view が destroy されていても state.comments は最新を保ち、
// 再 init 時に即時 rerender → 「タブ移動で来たコメが飛ぶ」を解消。

(function () {
  'use strict';

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubViews) window.KomehubViews = {};

  var MAX_COMMENTS = 1000;

  // chip フィルタ: コメリスト表示の絞り込み軸 (= 排他、 1 つだけ active)
  // - all: 全コメ (= バッジなし)
  // - gifts: スパチャ / ステッカー / メンバーシップギフト (= 本体 cl-tab gifts と
  //   同じ判定、 メンバー加入アナウンス isMembership は除外)
  // - members: メンバー加入アナウンス (= isMembership && !isMembershipGift)
  // - moderators: モデレーター発言 (= isModerator)
  // 各 chip (全て以外) の数字バッジは「未読 (= respondedAt が 0)」の件数。
  var FILTER_LABEL = {
    all: '全て',
    gifts: 'ギフト',
    members: 'メンバ加入',
    moderators: 'モデレータ'
  };

  function matchesFilterKey(c, key) {
    if (key === 'gifts') {
      return !!(c.hasGift || c.isMembershipGift || (typeof c.stickerImage === 'string' && c.stickerImage));
    }
    if (key === 'members') return !!(c.isMembership && !c.isMembershipGift);
    if (key === 'moderators') return !!c.isModerator;
    return true; // all
  }

  // ───── module-level 永続 state ─────
  var state = {
    comments: [],
    follow: true,
    keyword: '',
    filter: 'all',
    isOwnStream: false,
    hiddenForComments: new Set(),
    initialFetchDone: false,
    scrollTop: 0  // destroy 時の listWrap.scrollTop を保持、 再 init で復元
  };
  var dom = null;       // DOM 参照 (= init で設定、 destroy で null)
  var isActive = false; // comments view が表示中か
  var foreverSubscribed = false;
  var shellRef = null;

  // ───── 永続 (= タブ非表示時も走る) handlers ─────
  function onLiveCommentForever(comment) {
    if (!comment || !comment.id) return;
    var listenerId = comment.userId || comment.channelId || comment.listenerChannelId;
    if (state.hiddenForComments.has(String(listenerId || '').replace(/^yt-/, ''))) return;
    var idx = state.comments.findIndex(function (c) { return c.id === comment.id; });
    if (idx >= 0) state.comments.splice(idx, 1);
    state.comments.push(comment);
    while (state.comments.length > MAX_COMMENTS) state.comments.shift();
    if (isActive && dom) {
      rerender();
      if (state.follow) dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
    }
  }

  function onCommentDeletedForever(data) {
    var id = data && data.id ? data.id : (data && Array.isArray(data) ? data[0] : null);
    if (!id) return;
    state.comments = state.comments.filter(function (c) { return c.id !== id; });
    if (isActive && dom) rerender();
  }

  function onStaticUpdateForever(path, data) {
    if (path === 'connection') {
      state.isOwnStream = !!(data && data.connected && data.isOwnStream);
      if (isActive && dom) rerender();
    } else if (path === 'comment-responded' && data && data.commentId) {
      var c = state.comments.find(function (x) { return x.id === data.commentId; });
      if (c) c.respondedAt = data.respondedAt || 0;
      if (isActive && dom) applyRespondedToDom(data.commentId, data.respondedAt || 0);
    } else if (path === 'listener-hidden' && data && data.listenerChannelId) {
      var id = String(data.listenerChannelId).replace(/^yt-/, '');
      if (data.hideFromComments) state.hiddenForComments.add(id);
      else state.hiddenForComments.delete(id);
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
    initialFetch();
  }

  function initialFetch() {
    R.fetchJson('/api/status').then(function (s) {
      state.isOwnStream = !!(s && s.connected && s.isOwnStream);
      var videoId = s && s.videoId ? s.videoId : '';
      // backend (= model_queue::handle_incoming_comments) が live_id を connection.video_id で
      // 補完するようになったため、 streamVideoId filter が正しく機能する (= 2026-05-14)。
      var url = videoId
        ? '/api/comments?limit=200&streamVideoId=' + encodeURIComponent(videoId)
        : '/api/comments?limit=200';
      return R.fetchJson(url);
    }).then(function (arr) {
      if (!Array.isArray(arr)) return;
      // 既存 state.comments と merge して取りこぼし補完
      var existing = {};
      state.comments.forEach(function (c) { existing[c.id] = c; });
      arr.forEach(function (c) { existing[c.id] = c; });
      var merged = Object.values(existing);
      merged.sort(function (a, b) {
        var ta = a.timestamp || a.postedAt || 0;
        var tb = b.timestamp || b.postedAt || 0;
        return ta - tb;
      });
      state.comments = merged.slice(-MAX_COMMENTS);
      state.initialFetchDone = true;
      if (isActive && dom) {
        rerender();
        if (state.follow) dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
      }
    }).catch(function () { /* silent */ });
  }

  // ───── DOM 操作 (= isActive 時のみ呼ぶ) ─────
  function passesFilter(c) {
    return matchesFilterKey(c, state.filter);
  }

  // chip 数字バッジ: 「未対応 (= respondedAt = 0) かつ該当フィルタにマッチ」 のみ集計。
  function countByFilter() {
    var counts = { all: 0, gifts: 0, members: 0, moderators: 0 };
    state.comments.forEach(function (c) {
      var listenerId = c.userId || c.channelId || c.listenerChannelId;
      if (state.hiddenForComments.has(String(listenerId || '').replace(/^yt-/, ''))) return;
      if (c.respondedAt > 0) return; // 未読のみ
      counts.all += 1;
      if (matchesFilterKey(c, 'gifts')) counts.gifts += 1;
      if (matchesFilterKey(c, 'members')) counts.members += 1;
      if (matchesFilterKey(c, 'moderators')) counts.moderators += 1;
    });
    return counts;
  }

  function updateFilterChipsDom() {
    if (!dom) return;
    var counts = countByFilter();
    var chips = dom.filterChips.querySelectorAll('.rh-c-chip');
    for (var i = 0; i < chips.length; i++) {
      var key = chips[i].dataset.filter;
      chips[i].classList.toggle('active', key === state.filter);
      var countEl = chips[i].querySelector('.rh-c-chip-count');
      if (countEl) {
        countEl.hidden = false;
        countEl.textContent = String(counts[key] || 0);
      }
    }
  }

  function rerender() {
    if (!dom) return;
    updateFilterChipsDom();
    var visible = state.comments.filter(function (c) {
      if (!passesFilter(c)) return false;
      var listenerId = c.userId || c.channelId || c.listenerChannelId;
      if (state.hiddenForComments.has(String(listenerId || '').replace(/^yt-/, ''))) return false;
      if (state.keyword) {
        var k = state.keyword.toLowerCase();
        var hay = ((c.name || '') + ' ' + (c.comment || '') + ' ' + (c.commentHtml || '')).toLowerCase();
        if (hay.indexOf(k) < 0) return false;
      }
      return true;
    });
    if (visible.length === 0) {
      dom.listEl.replaceChildren();
      dom.emptyEl.style.display = '';
      dom.countEl.textContent = '0 件';
      return;
    }
    dom.emptyEl.style.display = 'none';
    var frag = document.createDocumentFragment();
    visible.forEach(function (c) {
      frag.appendChild(KS.createCommentItem(c, {
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
    var suffix = state.filter !== 'all' ? ' (' + FILTER_LABEL[state.filter] + ')' : '';
    dom.countEl.textContent = '表示 ' + visible.length + ' / 全 ' + state.comments.length + ' 件' + suffix;
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
    var c = state.comments.find(function (x) { return x.id === commentId; });
    if (c) c.respondedAt = nextValue ? Date.now() : 0;
    applyRespondedToDom(commentId, nextValue ? Date.now() : 0);

    R.postJson('/api/comments/' + encodeURIComponent(commentId) + '/responded', {
      value: nextValue ? 1 : 0
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        if (c) c.respondedAt = nextValue ? 0 : Date.now();
        applyRespondedToDom(commentId, c ? c.respondedAt : 0);
        KS.showUndoSnackbar({
          message: '更新に失敗しました',
          actionLabel: '再試行',
          onAction: function () { toggleResponded(commentId, nextValue); }
        });
      }
    }).catch(function () {
      if (c) c.respondedAt = nextValue ? 0 : Date.now();
      applyRespondedToDom(commentId, c ? c.respondedAt : 0);
    });
  }

  // ───── init / destroy ─────
  function init(container, params, shell) {
    shell.setTitle('コメント');
    shell.setBackVisible(false);
    shellRef = shell;

    var wrap = document.createElement('div');
    wrap.className = 'rh-view-comments';
    wrap.innerHTML =
      '<div class="rh-c-filter-chips" id="rh-c-filter-chips" role="tablist">' +
        Object.keys(FILTER_LABEL).map(function (k) {
          return '<button type="button" class="rh-c-chip" data-filter="' + k + '" role="tab">' +
            '<span class="rh-c-chip-label">' + FILTER_LABEL[k] + '</span>' +
            '<span class="rh-c-chip-count">0</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="rh-toolbar">' +
        '<input id="rh-c-search" type="search" placeholder="本文 / 名前で検索">' +
      '</div>' +
      '<div class="rh-list-wrap" id="rh-c-list-wrap">' +
        '<div id="rh-c-list"></div>' +
        '<div id="rh-c-empty" class="rh-empty" style="display:none">表示できるコメントがありません</div>' +
      '</div>' +
      '<button id="rh-c-jump" type="button" class="rh-jump-latest" style="display:none">↓ 最新へ戻る</button>' +
      '<footer class="rh-footer"><span id="rh-c-count">0 件</span></footer>';
    container.appendChild(wrap);

    dom = {
      wrap: wrap,
      filterChips: wrap.querySelector('#rh-c-filter-chips'),
      searchEl: wrap.querySelector('#rh-c-search'),
      listWrap: wrap.querySelector('#rh-c-list-wrap'),
      listEl: wrap.querySelector('#rh-c-list'),
      emptyEl: wrap.querySelector('#rh-c-empty'),
      jumpEl: wrap.querySelector('#rh-c-jump'),
      countEl: wrap.querySelector('#rh-c-count')
    };
    isActive = true;

    // state から rehydrate
    dom.searchEl.value = state.keyword;
    updateFilterChipsDom();
    if (state.comments.length > 0) {
      rerender();
      // scroll 位置の復元: follow モード (= 末尾追従) なら末尾、 そうでなければ
      // destroy 時に保存した scrollTop に戻す。 rAF で layout 完了後に適用
      // (= rerender 直後は scrollHeight 計算が確定していないことがある)
      requestAnimationFrame(function () {
        if (!dom || !dom.listWrap) return;
        if (state.follow) {
          dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
        } else {
          dom.listWrap.scrollTop = state.scrollTop;
        }
      });
    }
    // 初回 fetch 未完了なら trigger (= 通常は subscribeForever で済んでいる)
    if (!state.initialFetchDone) initialFetch();

    // UI イベント (= isActive=true 中のみ生きる)
    dom.searchEl.addEventListener('input', function () {
      state.keyword = dom.searchEl.value.trim();
      rerender();
    });
    dom.filterChips.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.rh-c-chip');
      if (!btn || btn.hasAttribute('disabled')) return;
      var f = btn.dataset.filter;
      if (!f || f === state.filter) return;
      state.filter = f;
      rerender();
    });
    dom.listWrap.addEventListener('scroll', function () {
      if (!dom) return;
      var bottomGap = dom.listWrap.scrollHeight - dom.listWrap.clientHeight - dom.listWrap.scrollTop;
      var atBottom = bottomGap < 6;
      state.follow = atBottom;
      dom.jumpEl.style.display = atBottom ? 'none' : '';
    }, { passive: true });
    dom.jumpEl.addEventListener('click', function () {
      if (!dom) return;
      dom.listWrap.scrollTop = dom.listWrap.scrollHeight;
      state.follow = true;
      dom.jumpEl.style.display = 'none';
    });

    return {
      destroy: function () {
        // 現在のスクロール位置を保存 (= 再 init 時に復元)
        if (dom && dom.listWrap) state.scrollTop = dom.listWrap.scrollTop;
        isActive = false;
        dom = null;
        // shellRef / unsubs は destroy しない (= 永続 subscribe を維持)
      }
    };
  }

  window.KomehubViews.comments = {
    init: init,
    subscribeForever: subscribeForever
  };
})();
