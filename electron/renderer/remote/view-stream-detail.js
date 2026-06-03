// === remote view: stream-detail ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.8 (Phase B3)
//
// 配信枠 1 つの詳細 (= 本体 stream-detail-modal のスマホ版)。
// サブタブ 4 つ: 概要 (= summary + KPI) / リスナー / コメ / 統計。
//
// 各タブは lazy load (= 初回表示時に fetch)。 タブ切替は state を保持しつつ
// 表示だけ切替 (= 戻った時に再 fetch しない)。
//
// データソース:
//   GET /api/listeners/streams/{video_id}              → StreamDetail (= stream + recent_comments + unique_commenters)
//   GET /api/listeners/streams/{video_id}/listeners?q  → ListenersPage (= per-stream)
//   GET /api/listeners/streams/{video_id}/stats?bin    → StreamStats (= 頻度 / 累積 / 構成 / 頻出語 / misc)
//   GET /api/listeners/streams/{video_id}/comment-chip-counts → { all, chat, gift, membership }
//   POST /api/listeners/comments/search                → search 結果 (= 配信絞り込み)

(function () {
  'use strict';

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubViews) window.KomehubViews = {};

  var SUBTABS = [
    { key: 'overview',  label: '概要' },
    { key: 'listeners', label: 'リスナー' },
    { key: 'comments',  label: 'コメ' },
    { key: 'stats',     label: '統計' }
  ];

  function init(container, params, shell, query) {
    var videoId = (params && params.videoId) || '';
    shell.setTitle('配信詳細');
    shell.setBackVisible(true);

    var localState = {
      videoId: videoId,
      detail: null,                 // StreamDetail
      detailStatus: 'idle',         // idle | loading | ready | error
      listeners: null,              // ListenersPage
      listenersStatus: 'idle',
      listenersFilter: { q: '', systemTag: '', memberJoinOnly: false },
      stats: null,
      statsStatus: 'idle',
      commentChips: null,           // { all, chat, gift, membership }
      comments: null,               // search result rows
      commentsStatus: 'idle',
      commentsFilter: { kind: 'all', q: '' },
      currentSubtab: 'overview',
      destroyed: false
    };

    if (!videoId) {
      var empty = document.createElement('div');
      empty.className = 'rh-empty';
      empty.textContent = '配信 ID が指定されていません';
      container.appendChild(empty);
      return { destroy: function () { localState.destroyed = true; } };
    }

    // ───────── shell DOM ─────────
    var shellRoot = document.createElement('div');
    shellRoot.className = 'rh-sd-shell';
    shellRoot.innerHTML =
      '<div class="rh-sd-hero" id="rh-sd-hero">' +
        '<div class="rh-sd-thumb" id="rh-sd-thumb">▶</div>' +
        '<div class="rh-sd-hero-meta">' +
          '<div class="rh-sd-title" id="rh-sd-title">…</div>' +
          '<div class="rh-sd-subline" id="rh-sd-subline"></div>' +
          '<div class="rh-sd-channel" id="rh-sd-channel"></div>' +
        '</div>' +
      '</div>' +
      '<div class="rh-sd-kpi-grid" id="rh-sd-kpi-grid"></div>' +
      '<div class="rh-sd-subtabs" id="rh-sd-subtabs" role="tablist"></div>' +
      '<div class="rh-sd-panels">' +
        '<div class="rh-sd-panel" data-subtab="overview"></div>' +
        '<div class="rh-sd-panel" data-subtab="listeners"></div>' +
        '<div class="rh-sd-panel" data-subtab="comments"></div>' +
        '<div class="rh-sd-panel" data-subtab="stats"></div>' +
      '</div>';
    container.appendChild(shellRoot);

    var titleEl = shellRoot.querySelector('#rh-sd-title');
    var sublineEl = shellRoot.querySelector('#rh-sd-subline');
    var channelEl = shellRoot.querySelector('#rh-sd-channel');
    var thumbEl = shellRoot.querySelector('#rh-sd-thumb');
    var kpiGrid = shellRoot.querySelector('#rh-sd-kpi-grid');
    var subtabsEl = shellRoot.querySelector('#rh-sd-subtabs');
    var panels = {
      overview:  shellRoot.querySelector('[data-subtab="overview"]'),
      listeners: shellRoot.querySelector('[data-subtab="listeners"]'),
      comments:  shellRoot.querySelector('[data-subtab="comments"]'),
      stats:     shellRoot.querySelector('[data-subtab="stats"]')
    };

    // subtab buttons
    SUBTABS.forEach(function (def) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rh-sd-subtab';
      btn.dataset.subtabKey = def.key;
      btn.setAttribute('role', 'tab');
      btn.textContent = def.label;
      btn.addEventListener('click', function () { switchTo(def.key); });
      subtabsEl.appendChild(btn);
    });

    function switchTo(key) {
      localState.currentSubtab = key;
      var btns = subtabsEl.querySelectorAll('.rh-sd-subtab');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.subtabKey === key);
      }
      Object.keys(panels).forEach(function (k) {
        panels[k].classList.toggle('inactive', k !== key);
      });
      // lazy load
      if (key === 'listeners' && localState.listenersStatus === 'idle') loadListeners();
      else if (key === 'comments' && localState.commentsStatus === 'idle') loadCommentChips();
      else if (key === 'stats' && localState.statsStatus === 'idle') loadStats();
    }

    // ───────── 初期 fetch: stream detail ─────────
    localState.detailStatus = 'loading';
    R.fetchJson('/api/listeners/streams/' + encodeURIComponent(videoId)).then(function (resp) {
      if (localState.destroyed) return;
      // serde flatten: stream フィールドは resp.detail (= top-level) 直下に展開される
      var src = resp && (resp.detail || resp);
      if (!resp || !resp.ok || !src) {
        localState.detailStatus = 'error';
        titleEl.textContent = '配信が見つかりませんでした';
        return;
      }
      localState.detail = src;
      localState.detailStatus = 'ready';
      renderHero();
      renderOverviewTab();
      shell.setTitle(src.title || videoId);
    }).catch(function () {
      if (localState.destroyed) return;
      localState.detailStatus = 'error';
      titleEl.textContent = '配信情報の取得に失敗しました';
    });

    switchTo('overview');

    // ───────── hero / KPI ─────────
    function renderHero() {
      var d = localState.detail;
      if (!d) return;
      titleEl.textContent = d.title || d.videoId;
      // subline: 日付 + duration + 状態
      var subParts = [];
      subParts.push(formatYmd(d.startedAt));
      if (d.endedAt > 0 && d.startedAt > 0) {
        subParts.push(formatDuration(d.endedAt - d.startedAt));
      } else if (d.startedAt > 0) {
        subParts.push('終了未記録');
      }
      if (!d.isOwnStream) subParts.push('他枠');
      sublineEl.textContent = subParts.join(' · ');
      // channel
      var channelText = d.channelName || '';
      if (d.subscriberCount > 0) channelText += ' (登録 ' + formatCompact(d.subscriberCount) + ')';
      channelEl.textContent = channelText;
      // thumbnail
      if (d.channelIconUrl) {
        var imgUrl = R.normalizeAssetUrl ? R.normalizeAssetUrl(d.channelIconUrl) : d.channelIconUrl;
        thumbEl.style.backgroundImage = 'url(\'' + String(imgUrl).replace(/'/g, '%27') + '\')';
        thumbEl.textContent = '';
      }

      // KPI grid
      kpiGrid.replaceChildren();
      kpiGrid.appendChild(buildKpiCell('コメ', String(d.commentCount || 0), 'cyan'));
      kpiGrid.appendChild(buildKpiCell('SC', '¥' + Number(d.superchatAmountJpy || 0).toLocaleString('ja-JP'), 'amber'));
      kpiGrid.appendChild(buildKpiCell('SC 数', String(d.superchatCount || 0), ''));
      kpiGrid.appendChild(buildKpiCell('peak', String(d.peakConcurrentViewers || 0), ''));
      kpiGrid.appendChild(buildKpiCell('👍', String(d.likes || 0), ''));
      kpiGrid.appendChild(buildKpiCell('リスナー', String(d.uniqueCommenters || 0), ''));
    }

    function buildKpiCell(label, value, tone) {
      var c = document.createElement('div');
      c.className = 'rh-sd-kpi' + (tone ? ' tone-' + tone : '');
      var l = document.createElement('span');
      l.className = 'rh-sd-kpi-label';
      l.textContent = label;
      var v = document.createElement('span');
      v.className = 'rh-sd-kpi-value';
      v.textContent = value;
      c.appendChild(l);
      c.appendChild(v);
      return c;
    }

    // ───────── 概要タブ ─────────
    function renderOverviewTab() {
      var p = panels.overview;
      if (!p) return;
      var d = localState.detail;
      if (!d) {
        p.innerHTML = '<div class="rh-empty">読み込み中…</div>';
        return;
      }
      p.replaceChildren();
      // 説明
      if (d.description) {
        var sec = section('説明');
        var body = document.createElement('div');
        body.className = 'rh-sd-desc';
        body.textContent = d.description;
        sec.appendChild(body);
        p.appendChild(sec);
      }
      // 関連リンク
      var linkSec = section('リンク');
      if (d.streamUrl) {
        var a = document.createElement('a');
        a.className = 'rh-sd-link';
        a.href = d.streamUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '🎬 YouTube で開く';
        linkSec.appendChild(a);
      }
      var searchLink = document.createElement('a');
      searchLink.className = 'rh-sd-link';
      searchLink.href = '/remote/archive?tab=cs&streamId=' + encodeURIComponent(videoId);
      searchLink.textContent = '🔍 この枠のコメを検索';
      linkSec.appendChild(searchLink);
      p.appendChild(linkSec);
      // 直近コメ (= recent_comments プレビュー、 10 件まで)
      var recent = (d.recentComments || []).slice(0, 10);
      if (recent.length) {
        var rsec = section('直近のコメント (' + recent.length + '/' + (d.commentCount || recent.length) + ')');
        var list = document.createElement('div');
        list.className = 'rh-sd-comment-list-inline';
        recent.forEach(function (cm) {
          list.appendChild(buildCommentCell(cm));
        });
        rsec.appendChild(list);
        p.appendChild(rsec);
      }
    }

    function section(title) {
      var s = document.createElement('div');
      s.className = 'rh-sd-section';
      var h = document.createElement('h3');
      h.className = 'rh-sd-section-title';
      h.textContent = title;
      s.appendChild(h);
      return s;
    }

    function buildCommentCell(cm) {
      var raw = cm.raw || {};
      var data = {
        id: cm.id,
        name: raw.name || raw.displayName || '(no name)',
        profileImage: raw.profileImage || '',
        comment: cm.body || raw.comment || '',
        commentHtml: raw.commentHtml || '',
        timestamp: raw.timestamp || cm.postedAt,
        amount: cm.superchatAmountJpy || 0,
        currency: cm.superchatCurrency || '',
        amountDisplay: raw.amountDisplay || '',
        superchatTier: raw.superchatTier || '',
        respondedAt: cm.respondedAt || 0,
        isMember: !!raw.isMember,
        isMembership: !!raw.isMembership,
        isMembershipGift: !!raw.isMembershipGift,
        giftCount: raw.giftCount || 0,
        stickerImage: raw.stickerImage || ''
      };
      return KS.createCommentItem(data, {
        formatTime: R.formatRelativeTime,
        formatYen: R.formatYen,
        truncate: R.truncate,
        rewriteUrl: R.normalizeAssetUrl
      });
    }

    // ───────── リスナータブ ─────────
    function loadListeners() {
      localState.listenersStatus = 'loading';
      renderListenersTab();
      var f = localState.listenersFilter;
      var qs = new URLSearchParams();
      qs.set('sort', 'commentCount');
      qs.set('limit', '500');
      if (f.q) qs.set('textQ', f.q);
      if (f.systemTag) qs.set('systemTags', f.systemTag);
      if (f.memberJoinOnly) qs.set('memberJoinOnly', 'true');
      R.fetchJson('/api/listeners/streams/' + encodeURIComponent(videoId) + '/listeners?' + qs.toString())
        .then(function (resp) {
          if (localState.destroyed) return;
          if (!resp || !resp.ok || !resp.page) {
            localState.listenersStatus = 'error';
            renderListenersTab();
            return;
          }
          localState.listeners = resp.page;
          localState.listenersStatus = 'ready';
          renderListenersTab();
        }).catch(function () {
          if (localState.destroyed) return;
          localState.listenersStatus = 'error';
          renderListenersTab();
        });
    }

    function renderListenersTab() {
      var p = panels.listeners;
      if (!p) return;
      p.replaceChildren();
      // filter row
      var filterRow = document.createElement('div');
      filterRow.className = 'rh-sd-filter-row';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'rh-sd-filter-input';
      input.placeholder = 'リスナー名 / コメ本文';
      input.value = localState.listenersFilter.q || '';
      var debounceTimer = null;
      input.addEventListener('input', function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          localState.listenersFilter.q = input.value.trim();
          loadListeners();
        }, 300);
      });
      filterRow.appendChild(input);
      p.appendChild(filterRow);

      // system tag chip filter (= horizontal scroll)
      var chipRow = document.createElement('div');
      chipRow.className = 'rh-sd-chip-row';
      var rankChips = [
        { key: '', label: 'すべて' },
        { key: 'first-time', label: '新規' },
        { key: 'returning', label: '再訪' },
        { key: 'regular', label: '常連' },
        { key: 'veteran', label: '古参' },
        { key: 'comeback', label: '復帰' }
      ];
      rankChips.forEach(function (def) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'rh-sd-filter-chip' + (def.key === localState.listenersFilter.systemTag ? ' active' : '');
        c.textContent = def.label;
        c.addEventListener('click', function () {
          localState.listenersFilter.systemTag = def.key;
          loadListeners();
        });
        chipRow.appendChild(c);
      });
      p.appendChild(chipRow);

      // status
      if (localState.listenersStatus === 'loading') {
        p.appendChild(emptyMsg('リスナーを読み込み中…'));
        return;
      }
      if (localState.listenersStatus === 'error') {
        p.appendChild(emptyMsg('リスナー一覧の取得に失敗しました'));
        return;
      }
      var rows = (localState.listeners && localState.listeners.rows) || [];
      var total = (localState.listeners && localState.listeners.total) || 0;
      var summary = document.createElement('div');
      summary.className = 'rh-sd-list-summary';
      summary.textContent = '全 ' + total + ' 人 (表示 ' + rows.length + ')';
      p.appendChild(summary);

      if (!rows.length) {
        p.appendChild(emptyMsg('該当するリスナーがいません'));
        return;
      }
      var list = document.createElement('div');
      list.className = 'rh-sd-listener-list';
      rows.forEach(function (row) {
        list.appendChild(buildListenerCell(row));
      });
      p.appendChild(list);
    }

    function buildListenerCell(row) {
      var a = document.createElement('a');
      a.className = 'rh-sd-listener-cell';
      a.href = R.toListenerDetailUrl(row.channelId) + '?streamId=' + encodeURIComponent(videoId);
      var av = document.createElement('div');
      av.className = 'rh-sd-listener-avatar';
      if (row.iconUrl) {
        var u = R.normalizeAssetUrl ? R.normalizeAssetUrl(row.iconUrl) : row.iconUrl;
        av.style.backgroundImage = 'url(\'' + String(u).replace(/'/g, '%27') + '\')';
      } else {
        av.textContent = (row.displayName || '?').charAt(0);
      }
      a.appendChild(av);
      var meta = document.createElement('div');
      meta.className = 'rh-sd-listener-meta';
      var name = document.createElement('div');
      name.className = 'rh-sd-listener-name';
      name.textContent = row.nickname || row.displayName || row.channelId;
      meta.appendChild(name);
      var sub = document.createElement('div');
      sub.className = 'rh-sd-listener-sub';
      var subParts = [];
      if (row.perStreamCommentCount > 0) subParts.push('コメ ' + row.perStreamCommentCount);
      if (row.perStreamScAmountJpy > 0) subParts.push('SC ¥' + Number(row.perStreamScAmountJpy).toLocaleString('ja-JP'));
      if (row.isMember) subParts.push('メンバー');
      sub.textContent = subParts.join(' · ');
      meta.appendChild(sub);
      a.appendChild(meta);
      // rank badge
      if (row.systemTag) {
        var b = document.createElement('span');
        b.className = 'rh-sd-listener-rank rank-' + row.systemTag;
        b.textContent = rankLabel(row.systemTag);
        a.appendChild(b);
      }
      return a;
    }

    function rankLabel(tag) {
      switch (tag) {
        case 'first-time': return '新規';
        case 'returning':  return '再訪';
        case 'regular':    return '常連';
        case 'veteran':    return '古参';
        case 'comeback':   return '復帰';
        case 'abandoned':  return '離脱';
        default: return tag;
      }
    }

    // ───────── コメタブ ─────────
    function loadCommentChips() {
      localState.commentsStatus = 'loading';
      renderCommentsTab();
      R.fetchJson('/api/listeners/streams/' + encodeURIComponent(videoId) + '/comment-chip-counts')
        .then(function (resp) {
          if (localState.destroyed) return;
          if (resp && resp.ok && resp.counts) {
            localState.commentChips = resp.counts;
          }
          loadComments();
        }).catch(function () {
          if (localState.destroyed) return;
          loadComments();
        });
    }

    function loadComments() {
      var f = localState.commentsFilter;
      var body = {
        streamIds: [videoId],
        limit: 500,
        offset: 0
      };
      if (f.kind === 'chat') body.commentTypes = ['chat'];
      else if (f.kind === 'gift') body.commentTypes = ['superchat', 'sticker', 'gift'];
      else if (f.kind === 'membership') body.commentTypes = ['membership'];
      if (f.q) body.bodyQ = f.q;
      R.postJson('/api/listeners/comments/search', body).then(function (resp) {
        if (localState.destroyed) return;
        if (!resp || !resp.ok || !resp.page) {
          localState.commentsStatus = 'error';
          renderCommentsTab();
          return;
        }
        localState.comments = resp.page.rows || [];
        localState.commentsStatus = 'ready';
        renderCommentsTab();
      }).catch(function () {
        if (localState.destroyed) return;
        localState.commentsStatus = 'error';
        renderCommentsTab();
      });
    }

    function renderCommentsTab() {
      var p = panels.comments;
      if (!p) return;
      p.replaceChildren();
      // chip filter
      var chips = localState.commentChips || { all: 0, chat: 0, gift: 0, membership: 0 };
      var chipRow = document.createElement('div');
      chipRow.className = 'rh-sd-chip-row';
      var defs = [
        { key: 'all', label: 'すべて', count: chips.all || 0 },
        { key: 'chat', label: 'チャット', count: chips.chat || 0 },
        { key: 'gift', label: 'ギフト', count: chips.gift || 0 },
        { key: 'membership', label: 'メンバー', count: chips.membership || 0 }
      ];
      defs.forEach(function (def) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'rh-sd-filter-chip' + (def.key === localState.commentsFilter.kind ? ' active' : '');
        c.innerHTML = def.label + '<span class="ct">' + def.count + '</span>';
        c.addEventListener('click', function () {
          localState.commentsFilter.kind = def.key;
          loadComments();
        });
        chipRow.appendChild(c);
      });
      p.appendChild(chipRow);

      // search input
      var filterRow = document.createElement('div');
      filterRow.className = 'rh-sd-filter-row';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'rh-sd-filter-input';
      input.placeholder = '本文で絞り込み';
      input.value = localState.commentsFilter.q || '';
      var debounceTimer = null;
      input.addEventListener('input', function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          localState.commentsFilter.q = input.value.trim();
          loadComments();
        }, 300);
      });
      filterRow.appendChild(input);
      p.appendChild(filterRow);

      if (localState.commentsStatus === 'loading') {
        p.appendChild(emptyMsg('コメントを読み込み中…'));
        return;
      }
      if (localState.commentsStatus === 'error') {
        p.appendChild(emptyMsg('コメント取得に失敗しました'));
        return;
      }
      var rows = localState.comments || [];
      if (!rows.length) {
        p.appendChild(emptyMsg('該当するコメントがありません'));
        return;
      }
      var summary = document.createElement('div');
      summary.className = 'rh-sd-list-summary';
      summary.textContent = '表示 ' + rows.length + ' 件';
      p.appendChild(summary);
      var list = document.createElement('div');
      list.className = 'rh-sd-comment-list-inline';
      rows.forEach(function (cm) {
        list.appendChild(buildCommentCell(cm));
      });
      p.appendChild(list);
    }

    // ───────── 統計タブ ─────────
    function loadStats() {
      localState.statsStatus = 'loading';
      renderStatsTab();
      // duration から bin_minutes を決める (= 本体 sdComputeBinMinutes 相当)
      var binMinutes = 15;
      var d = localState.detail;
      if (d && d.startedAt && d.endedAt > d.startedAt) {
        var durMin = (d.endedAt - d.startedAt) / 60000;
        if (durMin < 30) binMinutes = 1;
        else if (durMin < 60) binMinutes = 2;
        else if (durMin < 180) binMinutes = 5;
        else if (durMin < 360) binMinutes = 10;
        else binMinutes = 15;
      }
      R.fetchJson('/api/listeners/streams/' + encodeURIComponent(videoId) + '/stats?binMinutes=' + binMinutes)
        .then(function (resp) {
          if (localState.destroyed) return;
          if (!resp || !resp.ok || !resp.stats) {
            localState.statsStatus = 'error';
            renderStatsTab();
            return;
          }
          localState.stats = resp.stats;
          localState.statsStatus = 'ready';
          renderStatsTab();
        }).catch(function () {
          if (localState.destroyed) return;
          localState.statsStatus = 'error';
          renderStatsTab();
        });
    }

    function renderStatsTab() {
      var p = panels.stats;
      if (!p) return;
      p.replaceChildren();
      if (localState.statsStatus === 'loading') {
        p.appendChild(emptyMsg('統計を集計中…'));
        return;
      }
      if (localState.statsStatus === 'error') {
        p.appendChild(emptyMsg('統計データの取得に失敗しました'));
        return;
      }
      var stats = localState.stats;
      if (!stats) return;

      // 頻度 bin
      var freqSec = section('コメント頻度 (' + stats.binMinutes + ' 分刻み)');
      freqSec.appendChild(buildTimelineBars(stats.commentFreqBins, function (b) { return b.count; }, function (b) { return b.hasPeak; }));
      var peakBin = (stats.commentFreqBins || []).find(function (b) { return b.hasPeak; });
      if (peakBin) {
        var peakMsg = document.createElement('div');
        peakMsg.className = 'rh-sd-stats-summary';
        peakMsg.innerHTML = 'ピーク: <b>' + formatTimeOfDay(peakBin.binStartMs) +
          '</b> · ' + peakBin.count + ' 件 / ' + stats.binMinutes + ' 分';
        freqSec.appendChild(peakMsg);
      }
      p.appendChild(freqSec);

      // 累積ユニーク
      var cum = stats.cumulativeUniqueBins || [];
      if (cum.length > 0) {
        var maxVal = cum[cum.length - 1] || 1;
        var cumSec = section('ユニークリスナー累積 (' + maxVal + ' 人 = 100%)');
        var cumBins = cum.map(function (v) { return { count: v }; });
        cumSec.appendChild(buildTimelineBars(cumBins, function (b) { return b.count; }));
        p.appendChild(cumSec);
      }

      // リスナー構成
      var comp = stats.composition || {};
      var compSec = section('リスナー構成');
      var compTotal = (comp.firstTime || 0) + (comp.returning || 0) + (comp.regular || 0) + (comp.veteran || 0);
      var compGrid = document.createElement('div');
      compGrid.className = 'rh-sd-composition';
      [
        { key: 'firstTime', label: '新規', value: comp.firstTime || 0, tone: 'cyan' },
        { key: 'returning', label: '再訪', value: comp.returning || 0, tone: '' },
        { key: 'regular', label: '常連', value: comp.regular || 0, tone: 'amber' },
        { key: 'veteran', label: '古参', value: comp.veteran || 0, tone: 'amber' }
      ].forEach(function (def) {
        var pct = compTotal > 0 ? Math.round(def.value / compTotal * 100) : 0;
        var cell = document.createElement('div');
        cell.className = 'rh-sd-comp-cell' + (def.tone ? ' tone-' + def.tone : '');
        cell.innerHTML = '<div class="label">' + def.label + '</div>' +
          '<div class="value">' + def.value + '</div>' +
          '<div class="pct">' + pct + '%</div>';
        compGrid.appendChild(cell);
      });
      compSec.appendChild(compGrid);
      p.appendChild(compSec);

      // 頻出語
      var topWords = stats.topWords || [];
      if (topWords.length) {
        var twSec = section('頻出語 (top ' + Math.min(topWords.length, 10) + ')');
        var twGrid = document.createElement('div');
        twGrid.className = 'rh-sd-top-words';
        topWords.slice(0, 10).forEach(function (w) {
          var item = document.createElement('div');
          item.className = 'rh-sd-tw-item';
          item.innerHTML = '<span class="rh-sd-tw-word">' + escapeHtml(w.word) + '</span>' +
            '<span class="rh-sd-tw-count">' + w.count + '</span>';
          twGrid.appendChild(item);
        });
        twSec.appendChild(twGrid);
        var note = document.createElement('div');
        note.className = 'rh-sd-stats-summary';
        note.innerHTML = '<b>絵文字 / カスタムスタンプ / 助詞 / 短語</b> は除外';
        twSec.appendChild(note);
        p.appendChild(twSec);
      }

      // misc
      var misc = stats.misc || {};
      if (Object.keys(misc).length) {
        var miscSec = section('その他');
        var miscGrid = document.createElement('div');
        miscGrid.className = 'rh-sd-misc-grid';
        Object.keys(misc).forEach(function (k) {
          var item = document.createElement('div');
          item.className = 'rh-sd-misc-cell';
          item.innerHTML = '<div class="label">' + escapeHtml(k) + '</div>' +
            '<div class="value">' + escapeHtml(String(misc[k])) + '</div>';
          miscGrid.appendChild(item);
        });
        miscSec.appendChild(miscGrid);
        p.appendChild(miscSec);
      }
    }

    function buildTimelineBars(bins, getValue, getPeak) {
      var wrap = document.createElement('div');
      wrap.className = 'rh-sd-timeline';
      if (!bins || !bins.length) return wrap;
      var maxV = 0;
      for (var i = 0; i < bins.length; i++) {
        var v = getValue(bins[i]) || 0;
        if (v > maxV) maxV = v;
      }
      bins.forEach(function (b) {
        var bar = document.createElement('div');
        bar.className = 'rh-sd-bar' + (getPeak && getPeak(b) ? ' peak' : '');
        var v = getValue(b) || 0;
        var h = maxV > 0 ? (v / maxV * 100) : 0;
        bar.style.height = Math.max(2, h) + '%';
        bar.title = v + (b.binStartMs ? ' (' + formatTimeOfDay(b.binStartMs) + ')' : '');
        wrap.appendChild(bar);
      });
      return wrap;
    }

    function emptyMsg(text) {
      var d = document.createElement('div');
      d.className = 'rh-empty';
      d.textContent = text;
      return d;
    }

    // ───────── format helpers ─────────
    function formatYmd(unixMs) {
      if (!unixMs) return '';
      var d = new Date(Number(unixMs));
      if (isNaN(d.getTime())) return '';
      var wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
      return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' (' + wd + ')';
    }
    function formatDuration(ms) {
      if (!ms || ms < 0) return '';
      var sec = Math.floor(ms / 1000);
      var h = Math.floor(sec / 3600);
      var m = Math.floor((sec % 3600) / 60);
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    }
    function formatCompact(n) {
      n = Number(n) || 0;
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
      return String(n);
    }
    function formatTimeOfDay(ms) {
      var d = new Date(ms);
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    return {
      destroy: function () {
        localState.destroyed = true;
      }
    };
  }

  window.KomehubViews['stream-detail'] = { init: init };
})();
