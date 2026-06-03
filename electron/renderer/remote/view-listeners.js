// === remote view: listeners ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.4 (= SPA 化 X-2、 ミニタブ Y-1/Y-2)
//
// 本体 listener-mgr cl-tab 構造に準拠した 6 ミニタブ:
//   all / unGreeted / firstTime / returning / comeback / newMember
// 各ミニタブで listenersQuery のフラグを切り替え、 件数バッジは
// /api/listeners/stream-scoped-counts で一括取得。
// 「未対応」件数は shell.setTabBadge('listeners', n) で bottom tab bar にも反映。
//
// 「タブ移動で状態が消える / 通知バッジが更新されない」対策:
// - state は module-level (= タブ移動で destroy しても消えない)
// - SSE subscribe は subscribeForever() で永続購読 → タブ非表示中も
//   miniTabCounts + bottom tab bar の +N バッジを更新し続ける
// - DOM 反映 (= row list rerender / ミニタブ active 表示) は isActive=true 時のみ
//
// 他チャンネル枠 (= !isOwnStream) では all / newMember 以外を disabled に。

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var listenersLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('Listeners')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubViews) window.KomehubViews = {};

  var MTAB_LABEL = {
    all: '全て',
    unGreeted: '未対応',
    firstTime: '新規',
    returning: '再訪',
    comeback: '復帰',
    newMember: '新メンバー'
  };
  function buildQueryForMiniTab(mtab) {
    var q = {};
    if (mtab === 'unGreeted') q.unGreetedOnly = 'true';
    else if (mtab === 'firstTime') q.firstInStreamOnly = 'true';
    else if (mtab === 'returning') q.systemTags = 'returning';
    else if (mtab === 'comeback') q.comebackOnly = 'true';
    else if (mtab === 'newMember') q.newMemberOnly = 'true';
    return q;
  }
  var OWN_STREAM_ONLY_MTABS = ['unGreeted', 'firstTime', 'returning', 'comeback'];

  // ───── module-level 永続 state ─────
  var state = {
    rows: [],
    keyword: '',
    // 本体 #listener-mgr-sort と同じデフォルト (= この枠の参加が新しい順)。
    sort: 'streamFirstAt',
    currentStreamVideoId: '',
    isOwnStream: false,
    miniTab: 'all',
    miniTabCounts: { all: 0, unGreeted: 0, firstTime: 0, returning: 0, comeback: 0, newMember: 0 },
    initialized: false,
    scrollTop: 0  // destroy 時の list-wrap.scrollTop を保持、 再 init で復元
  };
  var dom = null;
  var isActive = false;
  var foreverSubscribed = false;
  var shellRef = null;
  var fetching = false;
  var refreshTimer = null;
  var countRefreshTimer = null;
  var searchTimer = null;

  // ───── 永続: SSE 購読 + count fetch (= タブ非表示中も走る) ─────
  function subscribeForever(shell) {
    if (foreverSubscribed) return;
    foreverSubscribed = true;
    shellRef = shell;

    shell.on('staticUpdate', function (path, data) {
      if (path === 'connection') {
        if (data && data.videoId) {
          state.currentStreamVideoId = data.videoId;
          state.isOwnStream = !!data.isOwnStream;
        } else {
          state.currentStreamVideoId = '';
          state.isOwnStream = false;
        }
        if (isActive && dom) updateMiniTabsDom();
        scheduleRefresh();
        scheduleCountRefresh();
      } else if (path === 'listener-updated' || path === 'listener-greeted' || path === 'listener-hidden') {
        scheduleRefresh();
        scheduleCountRefresh();
      }
    });

    // 初回 status fetch + 初回 count fetch
    R.fetchJson('/api/status').then(function (s) {
      if (s && s.connected && s.videoId) {
        state.currentStreamVideoId = s.videoId;
        state.isOwnStream = !!s.isOwnStream;
      }
      state.initialized = true;
      loadCounts();
      if (isActive && dom) {
        updateMiniTabsDom();
        loadListeners();
      }
    }).catch(function () { /* silent */ });
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      // 表示中のみ rows 取得 (= 非表示中は無駄な fetch を避ける、 表示時に再取得)
      if (isActive && dom) loadListeners();
    }, 800);
  }

  function scheduleCountRefresh() {
    if (countRefreshTimer) return;
    countRefreshTimer = setTimeout(function () {
      countRefreshTimer = null;
      loadCounts();
    }, 400);
  }

  function loadCounts() {
    if (!state.currentStreamVideoId) {
      state.miniTabCounts = { all: 0, unGreeted: 0, firstTime: 0, returning: 0, comeback: 0, newMember: 0 };
      if (isActive && dom) updateMiniTabsDom();
      if (shellRef) shellRef.setTabBadge('listeners', 0);
      return;
    }
    var qs = new URLSearchParams({ streamVideoId: state.currentStreamVideoId });
    if (state.keyword) qs.set('q', state.keyword);
    R.fetchJson('/api/listeners/stream-scoped-counts?' + qs.toString()).then(function (resp) {
      var counts = (resp && resp.counts) ? resp.counts : null;
      if (!counts) return;
      Object.keys(state.miniTabCounts).forEach(function (k) {
        state.miniTabCounts[k] = counts[k] || 0;
      });
      if (isActive && dom) updateMiniTabsDom();
      if (shellRef) shellRef.setTabBadge('listeners', counts.unGreeted || 0);
    }).catch(function () { /* silent */ });
  }

  function loadListeners() {
    if (fetching || !dom) return;
    if (!state.currentStreamVideoId) {
      state.rows = [];
      rerender();
      dom.emptyEl.textContent = 'LIVE 接続中の配信枠がありません';
      return;
    }
    fetching = true;
    var qs = new URLSearchParams({ sort: state.sort, limit: '200', offset: '0' });
    qs.set('streamVideoId', state.currentStreamVideoId);
    if (state.keyword) qs.set('q', state.keyword);
    var flags = buildQueryForMiniTab(state.miniTab);
    Object.keys(flags).forEach(function (k) { qs.set(k, flags[k]); });
    R.fetchJson('/api/listeners?' + qs.toString()).then(function (data) {
      if (!dom) return;
      state.rows = (data && data.page && Array.isArray(data.page.rows)) ? data.page.rows : [];
      rerender();
    }).catch(function () {
      if (!dom) return;
      dom.emptyEl.textContent = 'リスナーを取得できませんでした';
      dom.emptyEl.style.display = '';
      dom.listEl.replaceChildren();
    }).finally(function () { fetching = false; });
  }

  // ───── DOM 操作 (= isActive 時のみ呼ぶ) ─────
  function updateMiniTabsDom() {
    if (!dom) return;
    var tabs = dom.mtabsEl.querySelectorAll('.rh-mini-tab');
    for (var i = 0; i < tabs.length; i++) {
      var key = tabs[i].dataset.mtab;
      tabs[i].classList.toggle('active', key === state.miniTab);
      var isOwnerOnly = OWN_STREAM_ONLY_MTABS.indexOf(key) >= 0;
      var disabled = isOwnerOnly && !state.isOwnStream;
      tabs[i].toggleAttribute('disabled', disabled);
      tabs[i].classList.toggle('disabled', disabled);
      var c = dom.mtabsEl.querySelector('[data-count-for="' + key + '"]');
      if (c) c.textContent = String(state.miniTabCounts[key] || 0);
    }
  }

  function rerender() {
    if (!dom) return;
    if (!state.rows.length) {
      dom.listEl.replaceChildren();
      dom.emptyEl.textContent = '表示できるリスナーがいません';
      dom.emptyEl.style.display = '';
      dom.countEl.textContent = '0 人';
      return;
    }
    dom.emptyEl.style.display = 'none';
    var frag = document.createDocumentFragment();
    state.rows.forEach(function (r) { frag.appendChild(buildListenerRow(r)); });
    dom.listEl.replaceChildren(frag);
    dom.countEl.textContent = state.rows.length + ' 人';
  }

  function buildListenerRow(r) {
    var row = document.createElement('a');
    row.className = 'rh-listener-row';
    row.href = R.toListenerDetailUrl(r.channelId || '');

    var canToggle = !!(state.currentStreamVideoId && state.isOwnStream);
    var isResponded = !!(r.greetedAt && r.greetedAt > 0);
    if (canToggle) {
      row.classList.add('has-response-check');
      if (isResponded) row.classList.add('listener-responded');
    }
    if (state.currentStreamVideoId) {
      row.dataset.greeted = isResponded ? '1' : '0';
    }
    if (r.isMember) row.classList.add('is-member');

    var respondedBtn = null;
    if (canToggle) {
      respondedBtn = document.createElement('button');
      respondedBtn.type = 'button';
      respondedBtn.className = 'kh-toggle-responded';
      respondedBtn.title = '対応済みにする / 戻す';
      respondedBtn.textContent = '✓';
      respondedBtn.dataset.responded = isResponded ? '1' : '0';
      respondedBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var prev = respondedBtn.dataset.responded === '1';
        var next = !prev;
        respondedBtn.dataset.responded = next ? '1' : '0';
        row.dataset.greeted = next ? '1' : '0';
        row.classList.toggle('listener-responded', next);
        toggleListenerResponded(r.channelId || '', next, respondedBtn, row);
      });
    }

    var avatarWrap = document.createElement('div');
    avatarWrap.className = 'rh-listener-avatar-wrap';
    var avatar;
    if (r.iconUrl) {
      avatar = document.createElement('img');
      avatar.className = 'rh-listener-avatar';
      avatar.alt = '';
      avatar.src = R.normalizeAssetUrl(r.iconUrl);
      avatar.onerror = function () {
        var fallback = buildAvatarPlaceholder(r);
        if (this.parentNode) this.parentNode.replaceChild(fallback, this);
      };
    } else {
      avatar = buildAvatarPlaceholder(r);
    }
    avatarWrap.appendChild(avatar);
    if (state.currentStreamVideoId && (!r.greetedAt || r.greetedAt === 0)) {
      var dot = document.createElement('span');
      dot.className = 'rh-listener-ungreeted-dot';
      dot.title = '未対応';
      avatarWrap.appendChild(dot);
    }

    var main = document.createElement('div');
    main.className = 'rh-listener-main';

    var name = document.createElement('div');
    name.className = 'rh-listener-name';
    var primary = document.createElement('span');
    primary.className = 'rh-listener-name-primary';
    primary.textContent = r.nickname || r.displayName || '(no name)';
    name.appendChild(primary);
    // secondary (= @ハンドル) は手動別名 (nickname) 設定済みのときのみ表示。
    // YouTube は表示名カスタム未設定の視聴者を `@xxx` 1 文字列で返してくるため、
    // 通常は primary == username で重複になる。 username は既に `@` 込みでそのまま使う。
    if (r.nickname && r.username) {
      var secondary2 = document.createElement('span');
      secondary2.className = 'rh-listener-name-secondary';
      secondary2.textContent = r.username;
      name.appendChild(secondary2);
    }
    if (r.systemTag) {
      var rankBadge = KS.createRankBadge(r.systemTag);
      if (rankBadge) name.appendChild(rankBadge);
    }
    // メンバー / 対応済みバッジはリスト一覧では非表示 (= 詳細画面で確認)。
    // メンバーは row に is-member class が付与され primary 文字色で識別。
    // 対応済みは行右端の トグルボタン (= kh-toggle-responded) で識別。
    if (r.isModerator) name.appendChild(KS.createModeratorBadge());
    if (r.label) {
      var labelBadge = KS.createLabelBadge(r.label);
      if (labelBadge) name.appendChild(labelBadge);
    }
    main.appendChild(name);

    var lastCmt = document.createElement('div');
    lastCmt.className = 'rh-listener-last';
    // lastCommentHtml は Rust 側で html_escape 済 + <img class="emoji"> など安全 HTML のみ。
    // textContent では YouTube カスタム絵文字が `:thinking_face:` のように shortcode で
    // 表示されてしまうため、 innerHTML で本体と同じ表示にする (= 本体 line 11611-)。
    // truncate は CSS max-height + overflow:hidden で行う (= img 途中切れを避ける)。
    if (r.lastCommentHtml) {
      lastCmt.innerHTML = r.lastCommentHtml;
      if (r.lastCommentBody) lastCmt.title = r.lastCommentBody;
    } else if (r.lastCommentBody) {
      lastCmt.textContent = r.lastCommentBody;
      lastCmt.title = r.lastCommentBody;
    } else {
      lastCmt.textContent = '(コメントなし)';
      lastCmt.style.opacity = '0.6';
    }
    main.appendChild(lastCmt);

    var meta = document.createElement('div');
    meta.className = 'rh-listener-meta';
    var parts = [];
    var lastAt = (state.currentStreamVideoId && r.perStreamLastAt) ? r.perStreamLastAt : r.lastSeenAt;
    if (lastAt) parts.push('最終 ' + R.formatRelativeTime(lastAt));
    if (state.currentStreamVideoId && r.perStreamCommentCount) {
      parts.push('この枠 ' + r.perStreamCommentCount);
    }
    parts.push('累計 ' + (r.commentCount || 0));
    if (state.currentStreamVideoId && r.perStreamScAmountJpy) {
      parts.push('枠 SC ' + R.formatYen(r.perStreamScAmountJpy));
    } else if (r.superchatAmountJpy) {
      parts.push('SC ' + R.formatYen(r.superchatAmountJpy));
    }
    meta.textContent = parts.join(' · ');
    main.appendChild(meta);

    row.appendChild(avatarWrap);
    row.appendChild(main);
    if (respondedBtn) row.appendChild(respondedBtn);
    return row;
  }

  function buildAvatarPlaceholder(r) {
    var div = document.createElement('div');
    div.className = 'rh-listener-avatar placeholder';
    var src = r.nickname || r.displayName || '?';
    div.textContent = src.charAt(0).toUpperCase();
    return div;
  }

  function toggleListenerResponded(channelId, next, btnEl, rowEl) {
    if (!channelId || !state.currentStreamVideoId) return;
    var prev = !next;
    R.postJson('/api/listeners/by-channel/' + encodeURIComponent(channelId) + '/greeted', {
      streamVideoId: state.currentStreamVideoId,
      value: next ? 1 : 0
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        if (btnEl) btnEl.dataset.responded = prev ? '1' : '0';
        if (rowEl) {
          rowEl.dataset.greeted = prev ? '1' : '0';
          rowEl.classList.toggle('listener-responded', prev);
        }
        return;
      }
      scheduleRefresh();
      scheduleCountRefresh();
    }).catch(function () {
      if (btnEl) btnEl.dataset.responded = prev ? '1' : '0';
      if (rowEl) {
        rowEl.dataset.greeted = prev ? '1' : '0';
        rowEl.classList.toggle('listener-responded', prev);
      }
    });
  }

  // ───── init / destroy ─────
  function init(container, params, shell) {
    shell.setTitle('リスナー');
    shell.setBackVisible(false);
    shellRef = shell;

    var wrap = document.createElement('div');
    wrap.className = 'rh-view-listeners';
    wrap.innerHTML =
      '<div class="rh-mini-tabs" id="rh-l-mtabs" role="tablist">' +
        Object.keys(MTAB_LABEL).map(function (key) {
          return '<button type="button" class="rh-mini-tab" data-mtab="' + key + '" role="tab">' +
            '<span class="rh-mini-tab-label">' + MTAB_LABEL[key] + '</span>' +
            '<span class="rh-mini-tab-count" data-count-for="' + key + '">0</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="rh-toolbar" style="grid-template-columns: 1fr 110px">' +
        '<input id="rh-l-search" type="search" placeholder="リスナー検索">' +
        // スマホ縦持ち向けに短い label に詰める (= 本体 #listener-mgr-sort は
        // PC 想定で「この枠の参加が新しい順」等の長文だが、 select 横幅 110px に収まらない)。
        '<select id="rh-l-sort">' +
          '<option value="streamFirstAt">枠参加順</option>' +
          '<option value="lastSeen">最終コメ順</option>' +
          '<option value="commentCount">枠コメ数順</option>' +
          '<option value="superchatAmount">SC 順</option>' +
          '<option value="displayName">名前順</option>' +
        '</select>' +
      '</div>' +
      '<div class="rh-list-wrap" id="rh-l-list-wrap">' +
        '<div id="rh-l-list" class="rh-listener-list"></div>' +
        '<div id="rh-l-empty" class="rh-empty" style="display:none">表示できるリスナーがいません</div>' +
      '</div>' +
      '<footer class="rh-footer"><span id="rh-l-count">0 人</span></footer>';
    container.appendChild(wrap);

    dom = {
      wrap: wrap,
      mtabsEl: wrap.querySelector('#rh-l-mtabs'),
      searchEl: wrap.querySelector('#rh-l-search'),
      sortEl: wrap.querySelector('#rh-l-sort'),
      listWrap: wrap.querySelector('#rh-l-list-wrap'),
      listEl: wrap.querySelector('#rh-l-list'),
      emptyEl: wrap.querySelector('#rh-l-empty'),
      countEl: wrap.querySelector('#rh-l-count')
    };
    isActive = true;

    // state から rehydrate
    dom.searchEl.value = state.keyword;
    dom.sortEl.value = state.sort;
    updateMiniTabsDom();
    if (state.rows.length > 0) {
      rerender();
      // scrollTop 復元: rAF で layout 完了後に適用
      requestAnimationFrame(function () {
        if (dom && dom.listWrap) dom.listWrap.scrollTop = state.scrollTop;
      });
    }

    // 初期化前 (= subscribeForever の status fetch が未完了) なら待たずに loadListeners 走らせる。
    // status 取得後は subscribeForever 側で loadCounts + loadListeners が走る
    if (state.initialized) {
      loadListeners();
      loadCounts();
    } else {
      // status 取得を試みる (= subscribeForever が先に走っているはずだが念のため)
      loadListeners();
    }

    // ───── UI イベント ─────
    dom.mtabsEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.rh-mini-tab');
      if (!btn) return;
      if (btn.hasAttribute('disabled')) return;
      var mtab = btn.dataset.mtab;
      if (!mtab || mtab === state.miniTab) return;
      // 観点 I: リスナー mini-tab 切替 (= all / unGreeted / firstTime /
      // returning / comeback / newMember) を user 操作として記録
      listenersLog.info('user: listeners-minitab-switch, from=' + state.miniTab + ', to=' + mtab);
      state.miniTab = mtab;
      updateMiniTabsDom();
      loadListeners();
    });
    dom.searchEl.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.keyword = dom.searchEl.value.trim();
        loadListeners();
        loadCounts();
      }, 250);
    });
    dom.sortEl.addEventListener('change', function () {
      state.sort = dom.sortEl.value;
      loadListeners();
    });

    return {
      destroy: function () {
        if (dom && dom.listWrap) state.scrollTop = dom.listWrap.scrollTop;
        isActive = false;
        dom = null;
        clearTimeout(searchTimer);
        searchTimer = null;
        // refreshTimer / countRefreshTimer はクリアしない (= subscribeForever が
        // 引き続き scheduleCountRefresh を呼ぶので、 background 更新を維持)
      }
    };
  }

  window.KomehubViews.listeners = {
    init: init,
    subscribeForever: subscribeForever
  };
})();
