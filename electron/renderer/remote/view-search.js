// === remote view: search ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.6 (= SPA 化 X-2)
//
// query (= app.js が URL search を parse して渡す):
//   listenerChannelId 必須
//   streamVideoId 任意
//   period 任意 (= 期間絞り込み、 後続セッションで実装)

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var searchLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('Search')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubViews) window.KomehubViews = {};

  function init(container, params, shell, query) {
    shell.setTitle('コメ検索結果');
    shell.setBackVisible(true);

    var wrap = document.createElement('div');
    wrap.className = 'rh-view-search';
    wrap.innerHTML =
      '<div class="rh-list-wrap" id="rh-s-list-wrap">' +
        '<div id="rh-s-list"></div>' +
        '<div id="rh-s-empty" class="rh-empty" style="display:none">該当するコメントがありません</div>' +
      '</div>' +
      '<footer class="rh-footer"><span id="rh-s-count">0 件</span></footer>';
    container.appendChild(wrap);

    var listEl = wrap.querySelector('#rh-s-list');
    var emptyEl = wrap.querySelector('#rh-s-empty');
    var countEl = wrap.querySelector('#rh-s-count');

    var destroyed = false;
    var listenerChannelId = (query && query.listenerChannelId) || '';
    var streamVideoId = (query && query.streamVideoId) || '';

    if (!listenerChannelId) {
      emptyEl.textContent = 'listenerChannelId が指定されていません';
      emptyEl.style.display = '';
      return { destroy: function () { destroyed = true; } };
    }

    // listener 名でタイトル更新 (= best-effort)
    R.fetchJson('/api/listeners/by-channel/' + encodeURIComponent(listenerChannelId)).then(function (resp) {
      if (destroyed) return;
      if (resp && resp.ok && resp.detail) {
        var name = resp.detail.nickname || resp.detail.displayName || listenerChannelId;
        shell.setTitle(name + ' の全コメ');
      }
    }).catch(function (err) { searchLog.debug("promise rejected (catch swallow):", err); });

    // limit は backend 上限 (= search_comments の clamp 上限)。 旧 200 だと
    // 長期間アクティブな listener では古いコメが切れて「200 件で止まる」と見える。
    var searchQuery = {
      listenerChannelIds: [listenerChannelId],
      limit: 1000,
      offset: 0
    };
    if (streamVideoId) searchQuery.streamIds = [streamVideoId];

    // stream_id → { title, startedAt } のキャッシュ (= 同じ枠で複数コメある時 1 fetch で済む)
    var streamInfoCache = {};

    R.postJson('/api/listeners/comments/search', searchQuery).then(function (resp) {
      if (destroyed) return;
      if (!resp || !resp.ok || !resp.page) {
        emptyEl.textContent = 'コメント検索に失敗しました';
        emptyEl.style.display = '';
        return;
      }
      var rows = resp.page.rows || [];
      var total = resp.page.total || 0;
      // 初期描画 (= stream タイトル無しで先に表示)
      renderRows(rows, total);
      // 並行で stream meta を取得し、 取れた都度 chip を hydrate
      hydrateStreamInfo(rows);
    }).catch(function (err) {
      if (destroyed) return;
      emptyEl.textContent = '検索エラー: ' + (err && err.message ? err.message : err);
      emptyEl.style.display = '';
    });

    function hydrateStreamInfo(rows) {
      var ids = {};
      rows.forEach(function (row) {
        if (row.streamId && !streamInfoCache[row.streamId]) ids[row.streamId] = true;
      });
      Object.keys(ids).forEach(function (sid) {
        R.fetchJson('/api/listeners/streams/' + encodeURIComponent(sid)).then(function (resp) {
          if (destroyed) return;
          // 注: ListenerDetail / StreamDetail は serde flatten を使うことがあり、
          // resp.detail / resp.stream / resp 自体のいずれかに stream フィールドが乗る
          var src = resp && (resp.detail || resp.stream || resp);
          if (!src) return;
          streamInfoCache[sid] = {
            title: src.title || sid,
            startedAt: src.startedAt || 0
          };
          applyStreamHeaderForId(sid);
        }).catch(function (err) { searchLog.debug('stream meta fetch rejected (catch swallow):', err); });
      });
    }

    function applyStreamHeaderForId(streamId) {
      if (!listEl) return;
      var info = streamInfoCache[streamId];
      if (!info) return;
      var headers = listEl.querySelectorAll('.rh-s-stream-header[data-stream-id="' + streamId + '"]');
      for (var i = 0; i < headers.length; i++) {
        var titleEl = headers[i].querySelector('[data-tag="title"]');
        var dateEl = headers[i].querySelector('[data-tag="date"]');
        if (titleEl) titleEl.textContent = info.title || streamId;
        if (dateEl && info.startedAt) {
          var d = new Date(info.startedAt);
          var wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
          dateEl.textContent = (d.getMonth() + 1) + '/' + d.getDate() + ' (' + wd + ')';
        }
      }
    }

    function renderRows(rows, total) {
      if (!rows.length) {
        emptyEl.style.display = '';
        countEl.textContent = '0 件';
        return;
      }
      emptyEl.style.display = 'none';
      countEl.textContent = '表示 ' + rows.length + ' / 全 ' + total + ' 件';
      // 配信枠で grouping。 rows は posted_at DESC 順なので、 同じ stream は
      // 連続している前提だが安全のため Map ベースで配列順を保つ。
      var groups = [];
      var groupMap = {};
      rows.forEach(function (row) {
        var sid = row.streamId || '__no-stream__';
        if (!groupMap[sid]) {
          groupMap[sid] = { streamId: sid, rows: [] };
          groups.push(groupMap[sid]);
        }
        groupMap[sid].rows.push(row);
      });

      var frag = document.createDocumentFragment();
      groups.forEach(function (g) {
        // section ヘッダ (= 配信枠タイトル + 日付 + 件数、 sticky で常時可視)
        var header = document.createElement('div');
        header.className = 'rh-s-stream-header';
        header.dataset.streamId = g.streamId;
        var titleSpan = document.createElement('span');
        titleSpan.className = 'rh-s-stream-title';
        titleSpan.dataset.tag = 'title';
        titleSpan.textContent = g.streamId; // info 取得後に書き換え
        var dateSpan = document.createElement('span');
        dateSpan.className = 'rh-s-stream-date';
        dateSpan.dataset.tag = 'date';
        var countSpan = document.createElement('span');
        countSpan.className = 'rh-s-stream-count';
        countSpan.textContent = g.rows.length + ' 件';
        var iconSpan = document.createElement('span');
        iconSpan.className = 'rh-s-stream-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = '📺';
        header.appendChild(iconSpan);
        header.appendChild(titleSpan);
        header.appendChild(dateSpan);
        header.appendChild(countSpan);
        frag.appendChild(header);

        g.rows.forEach(function (row) {
          var raw = row.raw || {};
          var data = {
            id: row.id,
            name: raw.name || raw.displayName || '(no name)',
            profileImage: raw.profileImage || '',
            comment: row.body || raw.comment || '',
            commentHtml: raw.commentHtml || '',
            timestamp: raw.timestamp || row.postedAt,
            amount: row.superchatAmountJpy || 0,
            currency: row.superchatCurrency || '',
            amountDisplay: raw.amountDisplay || '',
            superchatTier: raw.superchatTier || '',
            respondedAt: row.respondedAt || 0,
            isMember: !!raw.isMember,
            isMembership: !!raw.isMembership,
            isMembershipGift: !!raw.isMembershipGift,
            giftCount: raw.giftCount || 0,
            stickerImage: raw.stickerImage || ''
          };
          var cell = KS.createCommentItem(data, {
            formatTime: R.formatRelativeTime,
            formatYen: R.formatYen,
            truncate: R.truncate,
            rewriteUrl: R.normalizeAssetUrl
          });
          frag.appendChild(cell);
        });
      });
      listEl.replaceChildren(frag);
      // 既に streamInfoCache にあるものは即時 hydrate
      Object.keys(streamInfoCache).forEach(applyStreamHeaderForId);
    }

    return {
      destroy: function () {
        destroyed = true;
      }
    };
  }

  window.KomehubViews.search = { init: init };
})();
