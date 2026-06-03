// === remote view: archive > streams ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.7 (Phase B)
//
// 配信ログ (= 全期間の配信枠一覧)。 本体 streams-toolbar / streams-list と同等機能を
// スマホ向けに作る。 状態は module-level に持って、 タブ切替で消えないようにする。

(function () {
  'use strict';

  var R = window.KomehubRemote;
  if (!window.KomehubArchiveSubviews) window.KomehubArchiveSubviews = {};

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var archiveLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('ArchiveStreams')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  // module-level state (= タブ切替で消えない)
  var state = {
    rows: [],
    total: 0,
    sort: 'startedAt',
    scope: 'all',
    density: 'l',
    limit: 50,
    offset: 0,
    fetching: false,
    initialized: false,
    scrollTop: 0
  };
  var dom = null;
  var destroyed = false;

  function init(container, shell, query) {
    destroyed = false;
    var wrap = document.createElement('div');
    wrap.className = 'rh-arch-streams';
    wrap.innerHTML =
      '<div class="rh-arch-toolbar">' +
        '<select id="rh-as-sort" class="rh-arch-select">' +
          '<option value="startedAt">開始時刻順</option>' +
          '<option value="commentCount">コメ数順</option>' +
          '<option value="superchatAmount">SC 額順</option>' +
          '<option value="peakConcurrentViewers">peak 視聴者順</option>' +
          '<option value="likes">いいね順</option>' +
        '</select>' +
        '<select id="rh-as-scope" class="rh-arch-select">' +
          '<option value="all">すべて</option>' +
          '<option value="own">自チャンネル</option>' +
          '<option value="other">他チャンネル</option>' +
        '</select>' +
        '<div class="rh-arch-density-seg" role="group" aria-label="表示密度">' +
          '<button type="button" class="rh-arch-seg-btn" data-density="l" title="大">大</button>' +
          '<button type="button" class="rh-arch-seg-btn" data-density="m" title="中">中</button>' +
          '<button type="button" class="rh-arch-seg-btn" data-density="s" title="小">小</button>' +
        '</div>' +
      '</div>' +
      '<div class="rh-arch-count" id="rh-as-count"></div>' +
      '<div class="rh-list-wrap" id="rh-as-list-wrap">' +
        '<div id="rh-as-list" class="rh-arch-streams-list"></div>' +
        '<div id="rh-as-empty" class="rh-empty" style="display:none">該当する配信がありません</div>' +
      '</div>' +
      '<div class="rh-arch-pagination" id="rh-as-pag" style="display:none">' +
        '<button type="button" id="rh-as-prev">‹ 前</button>' +
        '<span id="rh-as-page-label"></span>' +
        '<button type="button" id="rh-as-next">次 ›</button>' +
      '</div>';
    container.appendChild(wrap);

    dom = {
      sort: wrap.querySelector('#rh-as-sort'),
      scope: wrap.querySelector('#rh-as-scope'),
      densityBtns: wrap.querySelectorAll('.rh-arch-seg-btn'),
      count: wrap.querySelector('#rh-as-count'),
      list: wrap.querySelector('#rh-as-list'),
      listWrap: wrap.querySelector('#rh-as-list-wrap'),
      empty: wrap.querySelector('#rh-as-empty'),
      pag: wrap.querySelector('#rh-as-pag'),
      prev: wrap.querySelector('#rh-as-prev'),
      next: wrap.querySelector('#rh-as-next'),
      pageLabel: wrap.querySelector('#rh-as-page-label')
    };

    // 復元 state を DOM に反映
    dom.sort.value = state.sort;
    dom.scope.value = state.scope;
    applyDensityActive();

    dom.sort.addEventListener('change', function () {
      state.sort = dom.sort.value;
      state.offset = 0;
      load();
    });
    dom.scope.addEventListener('change', function () {
      state.scope = dom.scope.value;
      state.offset = 0;
      load();
    });
    for (var i = 0; i < dom.densityBtns.length; i++) {
      dom.densityBtns[i].addEventListener('click', function () {
        state.density = this.dataset.density || 'l';
        applyDensityActive();
        render();
      });
    }
    dom.prev.addEventListener('click', function () {
      if (state.offset <= 0) return;
      state.offset = Math.max(0, state.offset - state.limit);
      load();
    });
    dom.next.addEventListener('click', function () {
      if (state.offset + state.limit >= state.total) return;
      state.offset += state.limit;
      load();
    });

    // 初回はキャッシュ済 state があればそのまま描画、 なければ fetch
    if (state.initialized) {
      render();
      // scroll 位置復元 (= rAF で確実に layout 後に)
      requestAnimationFrame(function () {
        if (!destroyed && dom && dom.listWrap) {
          dom.listWrap.scrollTop = state.scrollTop || 0;
        }
      });
    } else {
      load();
    }

    return {
      destroy: function () {
        destroyed = true;
        if (dom && dom.listWrap) {
          state.scrollTop = dom.listWrap.scrollTop || 0;
        }
        dom = null;
      }
    };
  }

  function applyDensityActive() {
    if (!dom || !dom.densityBtns) return;
    for (var i = 0; i < dom.densityBtns.length; i++) {
      var btn = dom.densityBtns[i];
      btn.classList.toggle('active', (btn.dataset.density || 'l') === state.density);
    }
  }

  function load() {
    if (state.fetching) return;
    state.fetching = true;
    var qs = new URLSearchParams();
    qs.set('sort', state.sort);
    qs.set('scope', state.scope);
    qs.set('limit', String(state.limit));
    qs.set('offset', String(state.offset));
    R.fetchJson('/api/listeners/streams?' + qs.toString()).then(function (resp) {
      state.fetching = false;
      if (destroyed) return;
      if (!resp || !resp.ok || !resp.page) {
        state.rows = [];
        state.total = 0;
      } else {
        state.rows = resp.page.rows || [];
        state.total = resp.page.total || 0;
      }
      state.initialized = true;
      render();
    }).catch(function (err) {
      state.fetching = false;
      if (destroyed) return;
      archiveLog.error('archive-streams load failed', err);
      state.rows = [];
      state.total = 0;
      state.initialized = true;
      render();
    });
  }

  function render() {
    if (!dom) return;
    dom.count.textContent = '全 ' + state.total + ' 件';
    var rows = state.rows || [];
    if (!rows.length) {
      dom.list.replaceChildren();
      dom.empty.style.display = '';
      dom.pag.style.display = 'none';
      return;
    }
    dom.empty.style.display = 'none';

    var frag = document.createDocumentFragment();
    rows.forEach(function (row) {
      frag.appendChild(buildStreamCell(row, state.density));
    });
    dom.list.replaceChildren(frag);
    dom.list.dataset.density = state.density;

    // pagination
    if (state.total > state.limit) {
      dom.pag.style.display = '';
      var page = Math.floor(state.offset / state.limit) + 1;
      var totalPage = Math.ceil(state.total / state.limit);
      dom.pageLabel.textContent = page + ' / ' + totalPage;
      dom.prev.disabled = state.offset <= 0;
      dom.next.disabled = state.offset + state.limit >= state.total;
    } else {
      dom.pag.style.display = 'none';
    }
  }

  function buildStreamCell(row, density) {
    var cell = document.createElement('a');
    cell.className = 'rh-arch-stream-cell density-' + (density || 'l');
    cell.href = '/remote/streams/' + encodeURIComponent(row.videoId);
    cell.dataset.videoId = row.videoId;

    // 全 density 共通: 16:9 ストリーム サムネ
    var thumb = document.createElement('div');
    thumb.className = 'rh-as-thumb';
    var thumbUrl = '/cache/stream-thumbs/' + encodeURIComponent(row.videoId) + '.jpg';
    thumb.style.backgroundImage = "url('" + thumbUrl.replace(/'/g, '%27') + "')";
    cell.appendChild(thumb);

    if (density === 's') {
      // 小: サムネ + タイトル 1 行のみ (= KPI は spaces 取れないため省略)。
      // タイトルが全幅を埋めて読みやすさ優先。
      var title = document.createElement('span');
      title.className = 'rh-as-title';
      title.textContent = row.title || row.videoId;
      cell.appendChild(title);
      return cell;
    }

    // 中・大共通: thumb + meta + kpi
    var meta = document.createElement('div');
    meta.className = 'rh-as-meta';
    var titleEl = document.createElement('div');
    titleEl.className = 'rh-as-title';
    titleEl.textContent = row.title || row.videoId;
    meta.appendChild(titleEl);

    var subline = document.createElement('div');
    subline.className = 'rh-as-subline';
    var subParts = [];
    subParts.push(formatYmdShort(row.startedAt));
    if (row.endedAt > 0 && row.startedAt > 0) {
      subParts.push(formatDuration(row.endedAt - row.startedAt));
    } else if (row.startedAt > 0) {
      subParts.push('終了未記録');
    }
    if (row.channelName) subParts.push(row.channelName);
    if (!row.isOwnStream) subParts.push('他枠');
    subline.textContent = subParts.join(' · ');
    meta.appendChild(subline);

    // 大のみ description (1 行 truncate)
    if (density === 'l' && row.description) {
      var desc = document.createElement('div');
      desc.className = 'rh-as-desc';
      desc.textContent = row.description;
      meta.appendChild(desc);
    }

    cell.appendChild(meta);

    // KPI 群
    var kpiBox = document.createElement('div');
    kpiBox.className = 'rh-as-kpi-box';
    kpiBox.appendChild(buildKpi('コメ', String(row.commentCount || 0), 'cyan'));
    if (row.superchatAmountJpy > 0) {
      kpiBox.appendChild(buildKpi('SC', '¥' + Number(row.superchatAmountJpy).toLocaleString('ja-JP'), 'amber'));
    }
    if (density === 'l') {
      if (row.peakConcurrentViewers > 0) {
        kpiBox.appendChild(buildKpi('peak', String(row.peakConcurrentViewers), ''));
      }
      if (row.likes > 0) {
        kpiBox.appendChild(buildKpi('👍', String(row.likes), ''));
      }
    }
    cell.appendChild(kpiBox);

    return cell;
  }

  function buildKpi(label, value, tone) {
    var box = document.createElement('div');
    box.className = 'rh-as-kpi' + (tone ? ' tone-' + tone : '');
    var l = document.createElement('span');
    l.className = 'rh-as-kpi-label';
    l.textContent = label;
    var v = document.createElement('span');
    v.className = 'rh-as-kpi-value';
    v.textContent = value;
    box.appendChild(l);
    box.appendChild(v);
    return box;
  }

  function formatYmdShort(unixMs) {
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

  function escapeUrl(url) {
    return String(url).replace(/'/g, '%27');
  }

  window.KomehubArchiveSubviews['archive-streams'] = { init: init };
})();
