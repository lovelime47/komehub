// === remote view: listener-detail ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.5 (= SPA 化 X-2)
//
// 旧 listener-detail.js を view モジュール化。 params.channelId で識別、
// 同じ channel に戻ってきた場合は state から即時 rehydrate + 裏で latest fetch。

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var listenerDetailLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('ListenerDetail')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubViews) window.KomehubViews = {};

  // 直前に表示した詳細 (= 戻ってきた時の rehydrate)
  var cache = {
    channelId: '',
    detail: null,
    streamVideoId: '',
    isOwnStream: false,
    greetedAt: 0
  };

  // streamId → { title, startedAt } の cache (= view 全体で共有、 別 channel に遷移しても再利用)。
  // hydrateStreamTitles で fetch 結果を保持し、 同 streamId は API 再叩きしない。
  var streamTitleCache = {};

  function init(container, params, shell) {
    var channelId = (params && params.channelId) ? params.channelId : '';
    shell.setBackVisible(true);
    shell.setTitle('リスナー詳細');

    if (!channelId) {
      var err = document.createElement('div');
      err.className = 'rh-empty';
      err.textContent = 'URL に channelId がありません';
      container.appendChild(err);
      return { destroy: function () {} };
    }

    var main = document.createElement('main');
    main.className = 'rh-detail-main';
    // 構造ポリシー (= 本体 listener-detail-modal 準拠):
    //   hero  (= 「今この瞬間の識別 + 主要 KPI + 対応済み」): avatar / 名前 / バッジ / stat 1 行 / 対応済み
    //   tabs  (= 直近のコメント / ユーザー詳細 / 全コメ、 default は直近)
    //   panel: 直近のコメント (= recent コメ list)
    //   panel: ユーザー詳細 (= 識別情報 + 関係性 + heatmap + 表示設定[BAN])
    //   panel: 全コメ (= search リンク)
    //
    // 危険操作 (= コメ/リスナー非表示) は本体に倣い 「ユーザー詳細」タブ最下段に置く。
    // hero / 常時表示エリアに置かない (= 誤タップ防止)。
    main.innerHTML =
      '<section class="rh-detail-hero" id="rh-d-hero"></section>' +
      '<div class="rh-detail-tabs" id="rh-d-tabs" role="tablist">' +
        '<button type="button" class="rh-detail-tab active" data-tab="recent" role="tab">' +
          '直近のコメント<span class="rh-detail-tab-count" id="rh-d-tab-recent-count">0</span>' +
        '</button>' +
        '<button type="button" class="rh-detail-tab" data-tab="profile" role="tab">ユーザー詳細</button>' +
        '<button type="button" class="rh-detail-tab" data-tab="full" role="tab">全コメ</button>' +
      '</div>' +
      '<section class="rh-detail-tab-panel" data-tab-panel="recent" id="rh-d-panel-recent">' +
        '<div id="rh-d-recent" class="rh-detail-recent"></div>' +
      '</section>' +
      '<section class="rh-detail-tab-panel inactive" data-tab-panel="profile" id="rh-d-panel-profile">' +
        '<div id="rh-d-profile"></div>' +
        '<div class="rh-detail-section" id="rh-d-heatmap-section" style="display:none">' +
          '<div class="rh-detail-h">活動 (直近 14 配信枠) <span class="rh-detail-h-count">古い ← → 最新</span></div>' +
          '<div id="rh-d-heatmap" class="rh-detail-heatmap"></div>' +
          '<div id="rh-d-heatmap-tip" class="rh-detail-heatmap-tip" hidden></div>' +
        '</div>' +
        '<div class="rh-detail-section" id="rh-d-edit-section" style="display:none">' +
          '<div class="rh-detail-h">編集 (わんコメ memo と同期)</div>' +
          '<label class="rh-d-edit-label">ニックネーム</label>' +
          '<input id="rh-d-edit-nickname" type="text" class="rh-d-edit-input" autocomplete="off">' +
          '<label class="rh-d-edit-label">ラベル</label>' +
          '<input id="rh-d-edit-label" type="text" class="rh-d-edit-input" placeholder="例: VIP / 常連" autocomplete="off">' +
          '<label class="rh-d-edit-label">タグ</label>' +
          '<div id="rh-d-edit-tags" class="rh-d-edit-tags"></div>' +
          '<input id="rh-d-edit-tag-input" type="text" class="rh-d-edit-input" placeholder="+ タグ追加 (Enter)" autocomplete="off">' +
          '<label class="rh-d-edit-label">メモ</label>' +
          '<textarea id="rh-d-edit-notes" class="rh-d-edit-input rh-d-edit-textarea" rows="3" placeholder="任意メモ (わんコメ memo と同期)"></textarea>' +
          '<div class="rh-d-edit-save-row">' +
            '<span id="rh-d-edit-status" class="rh-d-edit-status"></span>' +
            '<button id="rh-d-edit-save" type="button" class="rh-d-edit-save-btn">保存</button>' +
          '</div>' +
        '</div>' +
        '<div class="rh-detail-section" id="rh-d-hide-section">' +
          '<div class="rh-detail-h">表示設定</div>' +
          '<div id="rh-d-hide-actions" class="rh-detail-hide-actions"></div>' +
        '</div>' +
      '</section>' +
      '<section class="rh-detail-tab-panel inactive" data-tab-panel="full" id="rh-d-panel-full">' +
        '<div id="rh-d-full-status" class="rh-detail-full-status"></div>' +
        '<div id="rh-d-full-list" class="rh-detail-recent"></div>' +
      '</section>';
    container.appendChild(main);

    var heroEl = main.querySelector('#rh-d-hero');
    var tabsEl = main.querySelector('#rh-d-tabs');
    var profileEl = main.querySelector('#rh-d-profile');
    var hideActionsEl = main.querySelector('#rh-d-hide-actions');
    var hideSectionEl = main.querySelector('#rh-d-hide-section');
    var heatmapSectionEl = main.querySelector('#rh-d-heatmap-section');
    var heatmapEl = main.querySelector('#rh-d-heatmap');
    var heatmapTipEl = main.querySelector('#rh-d-heatmap-tip');
    var recentEl = main.querySelector('#rh-d-recent');
    var recentCountEl = main.querySelector('#rh-d-tab-recent-count');
    var fullListEl = main.querySelector('#rh-d-full-list');
    var fullStatusEl = main.querySelector('#rh-d-full-status');
    var editSectionEl = main.querySelector('#rh-d-edit-section');
    var editNicknameEl = main.querySelector('#rh-d-edit-nickname');
    var editLabelEl = main.querySelector('#rh-d-edit-label');
    var editTagsEl = main.querySelector('#rh-d-edit-tags');
    var editTagInputEl = main.querySelector('#rh-d-edit-tag-input');
    var editNotesEl = main.querySelector('#rh-d-edit-notes');
    var editSaveEl = main.querySelector('#rh-d-edit-save');
    var editStatusEl = main.querySelector('#rh-d-edit-status');

    // タグ chip の現状 (= UI 内で編集中の値)。 保存ボタンで POST する。
    var editTags = [];

    // 「全コメ」タブの lazy load state (= init スコープ、 channelId 切替なら自動リセット)。
    // scroll container は .rh-detail-main 自体 (= 既存 overflow-y:auto)、 panel は独自に
    // overflow を持たない。 scroll handler は main 要素に bind する。
    var FULL_PAGE_LIMIT = 100;
    var FULL_END_THRESHOLD_PX = 600;
    var fullState = {
      loaded: false,
      fetching: false,
      exhausted: false,
      offset: 0,
      total: 0,
      scrollHandlerBound: false
    };

    // タブ切替: panel.inactive で display:none、 tab.active で見た目強調
    var panels = main.querySelectorAll('.rh-detail-tab-panel');
    tabsEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest && ev.target.closest('.rh-detail-tab');
      if (!btn || btn.classList.contains('active')) return;
      var name = btn.dataset.tab;
      // 観点 I: リスナー詳細モーダル内 sub-tab (= 当該枠 / 全コメ 等) の切替を user 操作として記録
      listenerDetailLog.info('user: listener-detail-tab-switch, tab=' + name);
      tabsEl.querySelectorAll('.rh-detail-tab').forEach(function (t) { t.classList.toggle('active', t === btn); });
      panels.forEach(function (p) { p.classList.toggle('inactive', p.dataset.tabPanel !== name); });
      // 「全コメ」 タブ初回表示で lazy load 開始 (= 本体 listenerDetailFullEnsureLoaded 相当)
      if (name === 'full') ensureFullLoaded();
    });

    function ensureFullLoaded() {
      if (destroyed) return;
      if (fullState.loaded) return;
      fullState.loaded = true;
      // .rh-detail-main が既存の scroll container (= overflow-y:auto)。 panel に
      // 独自 scroll を作らず main 要素の scroll を共用する (= 二重 scroll 回避)。
      if (!fullState.scrollHandlerBound) {
        main.addEventListener('scroll', onFullScroll, { passive: true });
        fullState.scrollHandlerBound = true;
      }
      fetchFullChunk();
    }

    function onFullScroll() {
      if (destroyed) return;
      if (fullState.fetching || fullState.exhausted) return;
      // 全コメタブが active な時のみ追加 fetch する
      var panel = main.querySelector('#rh-d-panel-full');
      if (!panel || panel.classList.contains('inactive')) return;
      var remaining = main.scrollHeight - main.scrollTop - main.clientHeight;
      if (remaining < FULL_END_THRESHOLD_PX) fetchFullChunk();
    }

    function fetchFullChunk() {
      if (destroyed || fullState.fetching || fullState.exhausted) return;
      fullState.fetching = true;
      updateFullStatus();
      R.postJson('/api/listeners/comments/search', {
        listenerChannelIds: [channelId],
        scope: 'all',
        includeKpi: false,
        limit: FULL_PAGE_LIMIT,
        offset: fullState.offset
      }).then(function (resp) {
        if (destroyed) return;
        fullState.fetching = false;
        if (!resp || !resp.ok || !resp.page) { updateFullStatus(); return; }
        fullState.total = resp.page.total || 0;
        var rows = resp.page.rows || [];
        // 初回 fetch 前なら recentEl の channelId / iconUrl を fallback として使うため
        // cache.detail を参照 (= renderRecent で sourceDetail 渡してたのと同じパス)
        var sourceDetail = cache.detail || null;
        appendFullRows(rows, sourceDetail);
        fullState.offset += rows.length;
        if (fullState.offset >= fullState.total || rows.length === 0) fullState.exhausted = true;
        // 同 streamId は cache 再利用、 新規 streamId だけ title fetch
        hydrateStreamTitlesForFull(rows);
        updateFullStatus();
      }).catch(function () {
        if (destroyed) return;
        fullState.fetching = false;
        updateFullStatus();
      });
    }

    function appendFullRows(rows, sourceDetail) {
      if (!fullListEl || !rows.length) return;
      var fallbackIcon = sourceDetail && sourceDetail.iconUrl ? sourceDetail.iconUrl : '';
      // 連続 streamId で grouping。 group の最後 streamId と new row が一致なら同 group に積む
      var lastGroupEl = fullListEl.lastElementChild;
      var lastGroupSid = lastGroupEl && lastGroupEl.classList.contains('rh-detail-recent-group')
        ? lastGroupEl.dataset.streamId : null;
      var currentGroupEl = lastGroupSid ? lastGroupEl : null;
      rows.forEach(function (c) {
        var sid = c.streamId || '';
        if (!currentGroupEl || currentGroupEl.dataset.streamId !== sid) {
          currentGroupEl = document.createElement('div');
          currentGroupEl.className = 'rh-detail-recent-group';
          currentGroupEl.dataset.streamId = sid;
          var headerEl = document.createElement('div');
          headerEl.className = 'rh-detail-recent-stream-h';
          if (sid) headerEl.dataset.streamId = sid;
          var stamp = c.postedAt ? R.formatRelativeTime(c.postedAt) : '';
          var cached = sid && streamTitleCache[sid];
          var titleText = (cached && cached.title) ? cached.title : '配信枠';
          headerEl.innerHTML =
            '<span class="rh-detail-recent-stream-icon">📺</span>' +
            '<span class="rh-detail-recent-stream-title">' + escapeHtml(titleText) + '</span>' +
            (stamp ? '<span class="rh-detail-recent-stream-stamp">' + escapeHtml(stamp) + '</span>' : '');
          currentGroupEl.appendChild(headerEl);
          fullListEl.appendChild(currentGroupEl);
        }
        var raw = c.raw || {};
        var data = {
          id: c.id,
          name: raw.name || raw.displayName || '(no name)',
          profileImage: raw.profileImage || '',
          _fallbackIconUrl: fallbackIcon,
          comment: c.body || raw.comment || '',
          commentHtml: raw.commentHtml || '',
          timestamp: raw.timestamp || c.postedAt,
          amount: c.superchatAmountJpy || 0,
          currency: c.superchatCurrency || '',
          amountDisplay: raw.amountDisplay || '',
          superchatTier: raw.superchatTier || '',
          respondedAt: c.respondedAt || 0,
          isMember: !!raw.isMember,
          isMembership: !!raw.isMembership,
          isMembershipGift: !!raw.isMembershipGift,
          giftCount: raw.giftCount || 0,
          stickerImage: raw.stickerImage || ''
        };
        currentGroupEl.appendChild(KS.createCommentItem(data, {
          formatTime: R.formatRelativeTime,
          formatYen: R.formatYen,
          truncate: R.truncate,
          rewriteUrl: R.normalizeAssetUrl
        }));
      });
    }

    function hydrateStreamTitlesForFull(rows) {
      if (destroyed || !fullListEl) return;
      var unique = {};
      for (var i = 0; i < rows.length; i++) {
        var sid = rows[i].streamId;
        if (!sid) continue;
        if (streamTitleCache[sid]) continue;
        unique[sid] = true;
      }
      Object.keys(unique).forEach(function (sid) {
        R.fetchJson('/api/listeners/streams/' + encodeURIComponent(sid))
          .then(function (resp) {
            if (destroyed || !resp || !resp.ok || !resp.detail) return;
            streamTitleCache[sid] = {
              title: resp.detail.title || '',
              startedAt: resp.detail.startedAt || 0
            };
            var title = streamTitleCache[sid].title;
            if (!title) return;
            var safeSid = sid.replace(/"/g, '\\"');
            var headers = fullListEl.querySelectorAll('.rh-detail-recent-stream-h[data-stream-id="' + safeSid + '"]');
            for (var hi = 0; hi < headers.length; hi++) {
              var titleEl = headers[hi].querySelector('.rh-detail-recent-stream-title');
              if (titleEl) titleEl.textContent = title;
            }
          })
          .catch(function () { /* silent fallback */ });
      });
    }

    function updateFullStatus() {
      if (!fullStatusEl) return;
      var loaded = fullState.offset;
      if (fullState.fetching && loaded === 0) {
        fullStatusEl.textContent = '読み込み中…';
      } else if (fullState.exhausted) {
        fullStatusEl.textContent = '全 ' + fullState.total + ' 件';
      } else if (loaded > 0) {
        fullStatusEl.textContent = loaded + ' / ' + fullState.total + ' 件 (スクロールで追加読込)';
      } else {
        fullStatusEl.textContent = '';
      }
    }

    var destroyed = false;
    var streamVideoId = '';
    var isOwnStream = false;
    var greetedAt = 0;

    // ────── 同 channelId なら cache から即時 rehydrate ──────
    if (cache.channelId === channelId && cache.detail) {
      streamVideoId = cache.streamVideoId;
      isOwnStream = cache.isOwnStream;
      greetedAt = cache.greetedAt;
      renderHero(cache.detail);
      renderProfile(cache.detail);
      renderHideActions(cache.detail);
      renderEditSection(cache.detail);
      renderRecent(cache.detail.recentComments || [], cache.detail);
      shell.setTitle(cache.detail.nickname || cache.detail.displayName || 'リスナー詳細');
    }

    var fallbackComment = R.popCommentForFallback(channelId);

    // detail fetch は status の videoId を query に乗せる必要があるので status 先行 →
    // detail で 2 段階。 status を取った後に detail を fetch する。
    R.fetchJson('/api/status').catch(function () { return null; }).then(function (status) {
      if (destroyed) return null;
      if (status && status.connected && status.videoId) {
        streamVideoId = status.videoId;
        isOwnStream = !!status.isOwnStream;
      }
      // streamVideoId を渡すと systemTag / perStreamCommentCount /
      // perStreamScAmountJpy / perStreamLastAt が detail に乗ってくる
      var url = '/api/listeners/by-channel/' + encodeURIComponent(channelId) + '?recentCommentLimit=50';
      if (streamVideoId) url += '&streamVideoId=' + encodeURIComponent(streamVideoId);
      return R.fetchJson(url).catch(function () { return null; });
    }).then(function (detailResp) {
      if (destroyed) return;
      var detail = null;
      if (detailResp && detailResp.ok && detailResp.detail) detail = detailResp.detail;
      else if (fallbackComment) detail = R.commentToFallbackDetail(fallbackComment);

      if (!detail) {
        heroEl.innerHTML = '<div class="rh-empty">リスナー情報を取得できませんでした</div>';
        return;
      }

      shell.setTitle(detail.nickname || detail.displayName || 'リスナー詳細');
      renderHero(detail);
      renderProfile(detail);
      renderRecent(detail.recentComments || [], detail);

      // detail は既に streamVideoId 付きで取得済 (= get_listener_detail が
      // per_stream_comment_count / per_stream_sc_amount_jpy / per_stream_last_at /
      // greeted_at を 1 SQL で集計済み、 B-4 backend 改修)。 追加 fetch 不要。
      if (streamVideoId && isOwnStream && !detail._commentOnly) {
        greetedAt = detail.greetedAt || 0;
      }
      // greetedAt が確定してから renderHero を再描画 (= 対応済みボタンの状態反映のため)。
      // cache rehydrate 経路では greetedAt が cache から来るので renderHero 1 回で済む。
      renderHero(detail);
      renderHideActions(detail);
      renderEditSection(detail);

      // cache 更新 (= 戻ってきた時の即時表示)
      cache.channelId = channelId;
      cache.detail = detail;
      cache.streamVideoId = streamVideoId;
      cache.isOwnStream = isOwnStream;
      cache.greetedAt = greetedAt;

      // heatmap (= 直近 14 枠の活動量) は別 API、 fallback (= 自枠外コメ表示) では skip
      if (!detail._commentOnly) loadHeatmap();
    });

    function loadHeatmap() {
      if (destroyed || !channelId) return;
      R.fetchJson('/api/listeners/activity?channelIds=' + encodeURIComponent(channelId) + '&streamCount=14')
        .then(function (resp) {
          if (destroyed || !resp || !resp.ok) return;
          var cells = (resp.activities && resp.activities[0] && resp.activities[0].cells) || [];
          var streams = resp.streams || [];
          renderHeatmap(cells, streams);
        }).catch(function () { /* heatmap は best-effort */ });
    }

    function renderHeatmap(cells, streams) {
      if (destroyed || !heatmapEl || !heatmapSectionEl) return;
      if (!cells.length || !streams.length) {
        heatmapSectionEl.style.display = 'none';
        return;
      }
      heatmapSectionEl.style.display = '';
      var maxCount = 0;
      for (var k = 0; k < cells.length; k++) {
        if ((cells[k].count || 0) > maxCount) maxCount = cells[k].count;
      }
      var frag = document.createDocumentFragment();
      var N = Math.min(cells.length, streams.length);
      for (var i = 0; i < N; i++) {
        var c = cells[i] || { count: 0 };
        var s = streams[i] || {};
        var cell = document.createElement('span');
        cell.className = 'rh-d-heatmap-cell';
        if (c.count > 0) {
          if (c.scAmountJpy > 0) cell.classList.add('sc');
          else if (maxCount > 0) {
            var ratio = c.count / maxCount;
            cell.classList.add(ratio > 0.66 ? 'l3' : ratio > 0.33 ? 'l2' : 'l1');
          }
        }
        var titleParts = [];
        if (s.title) titleParts.push(s.title);
        else if (s.videoId) titleParts.push(s.videoId);
        if (s.startedAt) {
          titleParts.push(new Date(s.startedAt).toLocaleString('ja-JP'));
        }
        titleParts.push('コメ ' + (c.count || 0));
        if (c.scAmountJpy > 0) titleParts.push('SC ' + R.formatYen(c.scAmountJpy));
        // PC ホバー用 (= title) と スマホタップ用 (= dataset.tip) の両対応
        var tipText = titleParts.join('\n');
        cell.title = tipText;
        cell.dataset.tip = tipText;
        frag.appendChild(cell);
      }
      heatmapEl.replaceChildren(frag);
      // セルタップで heatmap 下の tip 領域に内容を表示 (= スマホ向け)。
      // 同セル再タップで閉じる、 別セルタップで内容差替。
      heatmapEl.addEventListener('click', onHeatmapCellTap);
    }

    function onHeatmapCellTap(ev) {
      var cell = ev.target.closest && ev.target.closest('.rh-d-heatmap-cell');
      if (!cell || !heatmapTipEl) return;
      var wasActive = cell.classList.contains('active');
      // 既存 active 解除
      var prev = heatmapEl.querySelector('.rh-d-heatmap-cell.active');
      if (prev) prev.classList.remove('active');
      if (wasActive) {
        heatmapTipEl.hidden = true;
        heatmapTipEl.textContent = '';
        return;
      }
      cell.classList.add('active');
      heatmapTipEl.hidden = false;
      heatmapTipEl.textContent = cell.dataset.tip || '';
    }

    function renderHero(detail) {
      // hero 構成: avatar / primary 名 + (任意) secondary ハンドル inline / バッジ / stat 1 行
      // 対応ボタンは hero に置かない (= リスナー一覧セル右端の ✓ で操作する)。
      // primary / secondary は view-listeners.js と同じ重複排除ロジック:
      //   primary = nickname || displayName
      //   secondary は nickname 非空 + username あり時のみ表示 (改行なし inline)。
      // YouTube ハンドル未カスタマイズの視聴者は primary が `@xxx` 1 文字列で、
      // secondary 不要。
      var displayName = detail.displayName || '(no name)';
      var nick = detail.nickname || '';
      var primary = nick || displayName;
      var secondary = (nick && detail.username) ? detail.username : '';
      var iconUrl = R.normalizeAssetUrl(detail.iconUrl || '');
      var avatar = iconUrl
        ? '<img class="rh-detail-avatar" src="' + escapeHtml(iconUrl) + '" alt="">'
        : '<div class="rh-detail-avatar placeholder">' + escapeHtml((primary || '?').charAt(0)) + '</div>';

      // バッジ (= 本体と同じ並び): メンバー / MOD / label / SC
      var badges = '';
      if (detail.systemTag && streamVideoId && isOwnStream) {
        var rankLabel = KS.rankTagLabel ? KS.rankTagLabel(detail.systemTag) : '';
        var rankClass = KS.rankTagClass ? KS.rankTagClass(detail.systemTag) : '';
        if (rankLabel) {
          badges += '<span class="kh-rank-badge' + (rankClass ? ' ' + rankClass : '') + '">' +
            escapeHtml(rankLabel) + '</span>';
        }
      }
      if (detail.isMember) {
        badges += '<span class="kh-listener-badge member">👑 メンバー ' + (detail.memberMonthsMax || 0) + 'ヶ月</span>';
      }
      if (detail.isModerator) badges += '<span class="kh-listener-badge moderator">MOD</span>';
      if (detail.label) badges += '<span class="kh-listener-badge label">' + escapeHtml(detail.label) + '</span>';
      var scAmount = detail.superchatAmountJpy || 0;
      if (scAmount > 0) {
        badges += '<span class="kh-listener-badge sc">SC ' + escapeHtml(R.formatYen(scAmount) || '¥0') + '</span>';
      }

      // stat 1 行: コメ N · SC ¥X (N件) · 歴 X · 最終 X
      var statParts = [];
      statParts.push('総コメ <span class="v">' + (detail.commentCount || 0) + '</span>');
      if (scAmount > 0) {
        statParts.push('SC <span class="v amber">' + escapeHtml(R.formatYen(scAmount)) + '</span> (' + (detail.superchatCount || 0) + ')');
      }
      if (detail.firstSeenAt) statParts.push('歴 <span class="v">' + escapeHtml(R.formatRelativeTime(detail.firstSeenAt)) + '</span>');
      if (detail.lastSeenAt && detail.lastSeenAt !== detail.firstSeenAt) {
        statParts.push('最終 <span class="v">' + escapeHtml(R.formatRelativeTime(detail.lastSeenAt)) + '</span>');
      }

      // 自枠外 / 他枠視聴中の補足 note のみ hero に残す (= 何の操作もできない理由を示す)。
      var noteHtml = '';
      if (detail._commentOnly) {
        noteHtml = '<div class="rh-detail-note">自枠外のため最低限の情報のみ表示</div>';
      } else if (streamVideoId && !isOwnStream) {
        noteHtml = '<div class="rh-detail-note">他枠視聴中</div>';
      }

      // primary 名 + secondary ハンドルは同じ行に inline (= 改行しない)。
      // 長い場合は secondary が改行ではなく overflow:hidden + ellipsis でカット。
      heroEl.innerHTML =
        avatar +
        '<div class="rh-detail-hero-meta">' +
          '<div class="rh-detail-name">' +
            '<span class="primary">' + escapeHtml(primary) + '</span>' +
            (secondary ? '<span class="secondary">' + escapeHtml(secondary) + '</span>' : '') +
          '</div>' +
          (badges ? '<div class="rh-detail-badges">' + badges + '</div>' : '') +
          (statParts.length > 0 ? '<div class="rh-detail-stat-line">' + statParts.join(' · ') + '</div>' : '') +
          noteHtml +
        '</div>';
    }

    function renderProfile(detail) {
      if (!profileEl) return;
      // 本体 renderListenerDetailProfile 準拠の section 構成:
      //   識別情報 / 関係性 / (活動 heatmap は HTML 構造側で別 section) / メモ / ユーザータグ
      // 非表示 (= BAN 系) は profile 最下段の別 section で renderHideActions が描画。
      var html = '';

      // 識別情報
      html += '<div class="rh-detail-h">識別情報</div>';
      html += row('channel id', detail.channelId || '');
      if (detail.username) html += row('handle', detail.username);
      html += row('表示名', detail.displayName || '');
      if (detail.nickname && detail.nickname !== detail.displayName) {
        html += row('ニックネーム', detail.nickname);
      }

      // 関係性
      html += '<div class="rh-detail-h">関係性</div>';
      if (detail.firstSeenAt) {
        html += row('初コメ', R.formatRelativeTime(detail.firstSeenAt));
      }
      if (detail.lastSeenAt) {
        html += row('最終コメ', R.formatRelativeTime(detail.lastSeenAt));
      }
      html += row('累計コメ', String(detail.commentCount || 0), 'v cyan');
      var scAmount = detail.superchatAmountJpy || 0;
      html += row('累計スパチャ', (R.formatYen(scAmount) || '¥0') + ' (' + (detail.superchatCount || 0) + ' 件)', 'v amber');
      if (streamVideoId && (detail.perStreamCommentCount || detail.perStreamScAmountJpy)) {
        html += row('この枠コメ', String(detail.perStreamCommentCount || 0), 'v cyan');
        if ((detail.perStreamScAmountJpy || 0) > 0) {
          html += row('この枠SC', R.formatYen(detail.perStreamScAmountJpy), 'v amber');
        }
      }
      if (detail.isMember) html += row('メンバー継続', (detail.memberMonthsMax || 0) + ' ヶ月');
      if (detail.isModerator) html += row('モデレーター', 'はい');
      if (detail.label) html += row('ラベル', detail.label);

      // メモ (= 本体 nickname/notes 編集 form の代わり、 remote は read-only)
      if (detail.notes) {
        html += '<div class="rh-detail-h">メモ</div>';
        html += '<div class="rh-detail-notes">' + escapeHtml(detail.notes) + '</div>';
      }

      // ユーザータグ (= listener_tags、 本体には Profile タブで chip 編集 UI、 remote は read-only chip)
      if (Array.isArray(detail.userTags) && detail.userTags.length > 0) {
        html += '<div class="rh-detail-h">タグ</div>';
        html += '<div class="rh-detail-tag-row">';
        detail.userTags.forEach(function (t) {
          if (t) html += '<span class="kh-listener-badge user-tag">' + escapeHtml(t) + '</span>';
        });
        html += '</div>';
      }

      profileEl.innerHTML = html;
    }

    function row(key, value, vClass) {
      return '<div class="rh-detail-row">' +
        '<span class="key">' + escapeHtml(key) + '</span>' +
        '<span class="' + (vClass || 'v') + '">' + escapeHtml(value) + '</span>' +
      '</div>';
    }

    function renderEditSection(detail) {
      if (!editSectionEl) return;
      // _commentOnly (= 自枠外コメから開いた fallback) では DB に row が無いので編集 UI 非表示。
      if (detail._commentOnly) {
        editSectionEl.style.display = 'none';
        return;
      }
      editSectionEl.style.display = '';
      if (editNicknameEl) {
        editNicknameEl.value = detail.nickname || '';
        editNicknameEl.placeholder = detail.displayName || '';
      }
      if (editLabelEl) editLabelEl.value = detail.label || '';
      if (editNotesEl) editNotesEl.value = detail.notes || '';
      editTags = Array.isArray(detail.userTags) ? detail.userTags.slice() : [];
      renderEditTagChips();
      if (editStatusEl) editStatusEl.textContent = '';
    }

    function renderEditTagChips() {
      if (!editTagsEl) return;
      editTagsEl.replaceChildren();
      editTags.forEach(function (t, idx) {
        var chip = document.createElement('span');
        chip.className = 'rh-d-edit-tag-chip';
        chip.textContent = t;
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'rh-d-edit-tag-chip-x';
        x.textContent = '×';
        x.title = 'タグを削除';
        x.addEventListener('click', function () {
          editTags.splice(idx, 1);
          renderEditTagChips();
        });
        chip.appendChild(x);
        editTagsEl.appendChild(chip);
      });
    }

    if (editTagInputEl) {
      editTagInputEl.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var v = String(editTagInputEl.value || '').trim();
        if (!v) return;
        if (editTags.indexOf(v) >= 0) {
          editTagInputEl.value = '';
          return;
        }
        editTags.push(v);
        editTagInputEl.value = '';
        renderEditTagChips();
      });
    }

    if (editSaveEl) {
      editSaveEl.addEventListener('click', function () {
        if (destroyed) return;
        editSaveEl.disabled = true;
        if (editStatusEl) editStatusEl.textContent = '保存中…';
        // profile (= nickname/label/notes) と tags は別 endpoint。 順次叩いて両方
        // 成功で「保存しました」、 どちらか失敗で「保存に失敗しました」。
        // catch は個別に着け (= 1 つ失敗しても他方は完走させる)、 結果配列で失敗詳細を返す。
        var nicknameVal = editNicknameEl ? editNicknameEl.value : '';
        var labelVal = editLabelEl ? editLabelEl.value : '';
        var notesVal = editNotesEl ? editNotesEl.value : '';
        var profilePromise = R.postJson(
          '/api/listeners/by-channel/' + encodeURIComponent(channelId) + '/profile',
          { nickname: nicknameVal, label: labelVal, notes: notesVal }
        ).then(function (r) { return { kind: 'profile', ok: !!(r && r.ok), resp: r }; })
         .catch(function (err) { return { kind: 'profile', ok: false, err: String(err && err.message || err) }; });
        var tagsPromise = R.postJson(
          '/api/listeners/by-channel/' + encodeURIComponent(channelId) + '/tags',
          { tags: editTags.slice() }
        ).then(function (r) { return { kind: 'tags', ok: !!(r && r.ok), resp: r }; })
         .catch(function (err) { return { kind: 'tags', ok: false, err: String(err && err.message || err) }; });
        Promise.all([profilePromise, tagsPromise]).then(function (results) {
          if (destroyed) return;
          editSaveEl.disabled = false;
          var allOk = results.every(function (r) { return r.ok; });
          if (allOk) {
            if (editStatusEl) editStatusEl.textContent = '保存しました';
            // cache を最新値で更新 (= 戻ってきた時の即時 rehydrate で正しい値が出る)
            if (cache.detail && cache.channelId === channelId) {
              cache.detail.nickname = nicknameVal;
              cache.detail.label = labelVal;
              cache.detail.notes = notesVal;
              cache.detail.userTags = editTags.slice();
            }
            // shell タイトルも更新 (= nickname 変更が反映)
            var newName = nicknameVal || (cache.detail && cache.detail.displayName) || 'リスナー詳細';
            shell.setTitle(newName);
            setTimeout(function () {
              if (destroyed) return;
              if (editStatusEl) editStatusEl.textContent = '';
            }, 2000);
          } else {
            // 失敗詳細を status に詰める (= どの endpoint が落ちたか + 原因 message)
            var failParts = results.filter(function (r) { return !r.ok; }).map(function (r) {
              return r.kind + (r.err ? ': ' + r.err : '');
            });
            if (editStatusEl) editStatusEl.textContent = '保存失敗 (' + failParts.join(', ') + ')';
          }
        });
      });
    }

    function renderHideActions(detail) {
      if (destroyed || !hideActionsEl) return;
      // 表示設定 (= コメ/リスナー非表示) は本体に倣い詳細タブ最下段に置く。
      // 危険操作なので hero に常時露出させない (= 誤タップ防止)。
      // _commentOnly (= 自枠外コメから開いた fallback) でも非表示は操作可能
      // (= 本体仕様と同じ、 listener row 未確定でも /hidden API は受け付ける)。
      var initHC = !!detail.hideFromComments;
      var initHL = !!detail.hideFromListeners;
      hideActionsEl.innerHTML =
        '<button type="button" id="rh-d-hide-c" class="rh-detail-hide' + (initHC ? ' active' : '') + '" data-active="' + (initHC ? '1' : '0') + '">コメ非表示</button>' +
        '<button type="button" id="rh-d-hide-l" class="rh-detail-hide' + (initHL ? ' active' : '') + '" data-active="' + (initHL ? '1' : '0') + '">リスナー非表示</button>';

      var hcBtn = hideActionsEl.querySelector('#rh-d-hide-c');
      var hlBtn = hideActionsEl.querySelector('#rh-d-hide-l');
      function postHidden(nextHC, nextHL) {
        return R.postJson('/api/listeners/by-channel/' + encodeURIComponent(channelId) + '/hidden', {
          hideFromComments: nextHC,
          hideFromListeners: nextHL
        });
      }
      function applyHide(target) {
        var label = detail.nickname || detail.displayName || channelId;
        var prevHC = hcBtn.dataset.active === '1';
        var prevHL = hlBtn.dataset.active === '1';
        var nextHC = (target === 'comments') ? !prevHC : prevHC;
        var nextHL = (target === 'listeners') ? !prevHL : prevHL;
        hcBtn.disabled = true;
        hlBtn.disabled = true;
        postHidden(nextHC, nextHL).then(function (resp) {
          hcBtn.disabled = false;
          hlBtn.disabled = false;
          if (!resp || !resp.ok) {
            KS.showUndoSnackbar({ message: '更新に失敗しました' });
            return;
          }
          setHideDom(hcBtn, nextHC);
          setHideDom(hlBtn, nextHL);
          var msg = (target === 'comments')
            ? (nextHC ? '"' + label + '" のコメントを非表示にしました' : '"' + label + '" のコメント非表示を解除しました')
            : (nextHL ? '"' + label + '" をリスナーリストから非表示にしました' : '"' + label + '" のリスナー非表示を解除しました');
          KS.showUndoSnackbar({
            message: msg,
            onAction: function () {
              postHidden(prevHC, prevHL).then(function () {
                setHideDom(hcBtn, prevHC);
                setHideDom(hlBtn, prevHL);
              });
            }
          });
        }).catch(function (err) {
          hcBtn.disabled = false;
          hlBtn.disabled = false;
          KS.showUndoSnackbar({ message: '非表示更新エラー: ' + (err && err.message ? err.message : err) });
        });
      }
      if (hcBtn) hcBtn.addEventListener('click', function () { applyHide('comments'); });
      if (hlBtn) hlBtn.addEventListener('click', function () { applyHide('listeners'); });
      // 初期ラベルの「中」サフィックスを確定 (= 初回 active 状態でも正しいラベルに)
      if (hcBtn) setHideDom(hcBtn, initHC);
      if (hlBtn) setHideDom(hlBtn, initHL);
    }

    function setHideDom(btn, isActive) {
      if (!btn) return;
      btn.dataset.active = isActive ? '1' : '0';
      btn.classList.toggle('active', isActive);
      // ラベルにも状態を反映 (= 「コメ非表示」 ↔ 「✓ コメ非表示中」)
      if (!btn.dataset.baseLabel) {
        btn.dataset.baseLabel = btn.textContent.replace(/^✓\s*/, '').replace(/中$/, '');
      }
      btn.textContent = isActive ? '✓ ' + btn.dataset.baseLabel + '中' : btn.dataset.baseLabel;
    }

    function setGreetedDom(btn, isGreeted) {
      btn.dataset.greeted = isGreeted ? '1' : '0';
      var icon = btn.querySelector('.ld-greeted-icon');
      var label = btn.querySelector('.ld-greeted-label');
      if (isGreeted) {
        if (!icon) {
          icon = document.createElement('span');
          icon.className = 'ld-greeted-icon';
          icon.textContent = '✓';
          btn.insertBefore(icon, label || null);
        } else icon.textContent = '✓';
      } else if (icon) icon.remove();
      if (label) label.textContent = isGreeted ? '対応済み' : '対応';
    }

    function renderRecent(recent, sourceDetail) {
      if (!recent.length) {
        recentEl.innerHTML = '<div class="rh-empty">直近のコメントはありません</div>';
        recentCountEl.textContent = '0';
        return;
      }
      recentCountEl.textContent = String(recent.length);
      // raw.profileImage はハッシュ付き cache URL で、 古いコメだと cache file 削除済で
      // 404 になることがある (= avatar 更新後の現象)。 listener の現在 iconUrl を
      // fallback として渡し、 shared/comment-item.js の onerror 経路で切り替える。
      var fallbackIcon = sourceDetail && sourceDetail.iconUrl ? sourceDetail.iconUrl : '';

      // 本体 listener-detail-modal と同じく streamId で順序保持の grouping。
      // 各 group の先頭に枠ヘッダー (= 📺 + 配信枠の relative time) を入れる。
      // 配信タイトルは別 API fetch (= hydrateStreamTitles 相当) で後追い更新するが、
      // remote では未実装のため簡素表示。
      var groups = [];
      var groupMap = {};
      recent.forEach(function (c) {
        var sid = c.streamId || '';
        if (!groupMap[sid]) {
          groupMap[sid] = { streamId: sid, comments: [] };
          groups.push(groupMap[sid]);
        }
        groupMap[sid].comments.push(c);
      });

      var frag = document.createDocumentFragment();
      groups.forEach(function (g) {
        var groupEl = document.createElement('div');
        groupEl.className = 'rh-detail-recent-group';

        var headerEl = document.createElement('div');
        headerEl.className = 'rh-detail-recent-stream-h';
        if (g.streamId) headerEl.dataset.streamId = g.streamId;
        // 先頭コメの postedAt から枠の時期を推測 (= recent は postedAt DESC 順)
        var firstAt = g.comments[0] && g.comments[0].postedAt;
        var stamp = firstAt ? R.formatRelativeTime(firstAt) : '';
        var cnt = g.comments.length;
        // 初期表示は cache のタイトル (あれば) or 「配信枠」 fallback。
        // hydrateStreamTitles で後追い fetch + in-place 更新する。
        var cached = g.streamId && streamTitleCache[g.streamId];
        var titleText = (cached && cached.title) ? cached.title : '配信枠';
        headerEl.innerHTML =
          '<span class="rh-detail-recent-stream-icon">📺</span>' +
          '<span class="rh-detail-recent-stream-title">' + escapeHtml(titleText) + '</span>' +
          (stamp ? '<span class="rh-detail-recent-stream-stamp">' + escapeHtml(stamp) + '</span>' : '') +
          '<span class="rh-detail-recent-stream-count">' + cnt + ' 件</span>';
        groupEl.appendChild(headerEl);

        g.comments.forEach(function (c) {
          var raw = c.raw || {};
          var data = {
            id: c.id,
            name: raw.name || raw.displayName || '(no name)',
            profileImage: raw.profileImage || '',
            _fallbackIconUrl: fallbackIcon,
            comment: c.body || raw.comment || '',
            commentHtml: raw.commentHtml || '',
            timestamp: raw.timestamp || c.postedAt,
            amount: c.superchatAmountJpy || 0,
            currency: c.superchatCurrency || '',
            amountDisplay: raw.amountDisplay || '',
            superchatTier: raw.superchatTier || '',
            respondedAt: c.respondedAt || 0,
            isMember: !!raw.isMember,
            isMembership: !!raw.isMembership,
            isMembershipGift: !!raw.isMembershipGift,
            giftCount: raw.giftCount || 0,
            stickerImage: raw.stickerImage || ''
          };
          groupEl.appendChild(KS.createCommentItem(data, {
            formatTime: R.formatRelativeTime,
            formatYen: R.formatYen,
            truncate: R.truncate,
            rewriteUrl: R.normalizeAssetUrl
          }));
        });

        frag.appendChild(groupEl);
      });
      recentEl.replaceChildren(frag);

      // 配信タイトルを別 API 経由で後追い取得 → 該当 header の title span を in-place 更新。
      // 本体 renderer.js:hydrateStreamTitlesInList と同等の動き。 cache を共有して
      // 同 streamId の再 fetch は避ける。
      hydrateStreamTitlesInList(groups);
    }

    function hydrateStreamTitlesInList(groups) {
      if (destroyed) return;
      var unique = {};
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (!g.streamId) continue;
        if (streamTitleCache[g.streamId]) continue;
        unique[g.streamId] = true;
      }
      Object.keys(unique).forEach(function (sid) {
        R.fetchJson('/api/listeners/streams/' + encodeURIComponent(sid))
          .then(function (resp) {
            if (destroyed) return;
            if (!resp || !resp.ok || !resp.detail) return;
            streamTitleCache[sid] = {
              title: resp.detail.title || '',
              startedAt: resp.detail.startedAt || 0
            };
            var title = streamTitleCache[sid].title;
            if (!title) return;
            // 該当 header の title span のみ in-place 書き換え (= innerHTML 全 rebuild 禁止
            // / SC や count 表示は保持される、 click 中の他要素も壊さない)
            var safeSid = sid.replace(/"/g, '\\"');
            var headers = recentEl.querySelectorAll('.rh-detail-recent-stream-h[data-stream-id="' + safeSid + '"]');
            for (var hi = 0; hi < headers.length; hi++) {
              var titleEl = headers[hi].querySelector('.rh-detail-recent-stream-title');
              if (titleEl) titleEl.textContent = title;
            }
          })
          .catch(function () { /* 失敗は黙って fallback (= 「配信枠」 のまま) */ });
      });
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // SSE subscribe
    var unsubs = [];
    unsubs.push(shell.on('staticUpdate', function (path, data) {
      if (destroyed) return;
      if (path === 'listener-greeted' && data && data.listenerChannelId) {
        var dataCh = String(data.listenerChannelId).replace(/^yt-/, '');
        var thisCh = channelId.replace(/^yt-/, '');
        if (dataCh === thisCh) {
          // 対応済みボタンは hero 内に統合 (2026-05-14 構造再編)
          var btn = heroEl.querySelector('#rh-d-greeted');
          if (btn) {
            greetedAt = data.greetedAt || 0;
            setGreetedDom(btn, greetedAt > 0);
          }
        }
      } else if (path === 'listener-hidden' && data && data.listenerChannelId) {
        var dataCh2 = String(data.listenerChannelId).replace(/^yt-/, '');
        var thisCh2 = channelId.replace(/^yt-/, '');
        if (dataCh2 === thisCh2) {
          // 非表示ボタンは Profile タブ最下段に移動
          var hcBtn2 = hideActionsEl.querySelector('#rh-d-hide-c');
          var hlBtn2 = hideActionsEl.querySelector('#rh-d-hide-l');
          if (hcBtn2) setHideDom(hcBtn2, !!data.hideFromComments);
          if (hlBtn2) setHideDom(hlBtn2, !!data.hideFromListeners);
        }
      }
    }));

    return {
      destroy: function () {
        destroyed = true;
        unsubs.forEach(function (u) { u(); });
        unsubs = [];
      }
    };
  }

  window.KomehubViews['listener-detail'] = { init: init };
})();
