// === remote view: archive > comment-search ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.7 (Phase C)
//
// コメ検索フル機能スマホ版:
//   - 配信枠名 / 本文 / リスナー名 のテキスト 3 種
//   - 種別 pill (chat / gift / membership)
//   - scope (all / own / other)
//   - 期間 ボトムシート (preset + range + カレンダー)
//   - リスナー picker ボトムシート (システムランク + ユーザータグ + 個別選択)
//   - 配信枠 picker ボトムシート (タグ + 個別選択)
//   - 保存検索ストリップ (= 読み取り + 作成 + 削除)
//
// state は module-level (= タブ切替で消えない)。

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var archCommLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('ArchiveCommentSearch')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  var KS = window.KomehubShared;
  if (!window.KomehubArchiveSubviews) window.KomehubArchiveSubviews = {};

  var SAVED_SCOPE = 'comment-search';
  // 仮想化パラメータ (= 本体 setupLazyCommentRender 相当の mobile 簡略版)
  // 固定高さ推定で DOM 数を一定に保つ。 BUFFER 上下 + 可視範囲分だけ実 DOM 化。
  var VIRT_ROW_HEIGHT = 72;  // コメ 1 行の推定高 (px、 平均値で十分。 厳密測定は本体だけ)
  var VIRT_BUFFER = 15;      // viewport 上下に余分に描画する行数 (スクロール先回り)
  var CHUNK_SIZE = 2000;     // 枠展開時に取得するコメチャンク数 (本体 5000 だが mobile は半分以下に)

  // ───── module-level state (= タブ切替で消えない) ─────
  var state = {
    form: {
      streamTitleQ: '',
      bodyQ: '',
      nameQ: '',
      types: [],          // ['chat', 'gift', 'membership']
      scope: 'own',
      period: null,       // { from: ms, to: ms, label: string } or null
      listeners: [],      // [{ channelId, displayName }]
      streams: []         // [{ videoId, title, startedAt }]
    },
    result: { rows: [], total: 0, kpi: null, streams: [], status: 'idle', lastQuery: null },
    saved: { items: [], status: 'idle' },
    streamInfoCache: {},  // sid → { title, startedAt }
    formOpen: true,       // フォームを折り畳むか
    scrollTop: 0,
    initialized: false,
    baselineVideoId: ''   // ランク判定の baseline (= 接続中の自枠 or 最新の自枠)
  };

  var dom = null;
  var destroyed = false;

  // 仮想化された全 stream card 用の共有 scroll listener。
  // cs view (= scroll container) に 1 つだけ listener を貼り、 各 virtualizer の
  // update() を rAF で一括呼び出しする。
  var activeVirtualizers = new Set();
  var sharedScrollContainer = null;
  var sharedScrollHandler = null;

  function ensureSharedScrollListener(container) {
    if (sharedScrollContainer === container && sharedScrollHandler) return;
    // 既存 listener があれば古い container から外す (= bottom タブ切替で wrap が
    // 別要素に置き換わるケースに対応)
    if (sharedScrollContainer && sharedScrollHandler) {
      try { sharedScrollContainer.removeEventListener('scroll', sharedScrollHandler); }
      catch (err) { archCommLog.debug('scroll listener detach failed:', err); }
      window.removeEventListener('resize', sharedScrollHandler);
    }
    sharedScrollContainer = container;
    var rafPending = false;
    sharedScrollHandler = function () {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        activeVirtualizers.forEach(function (v) { try { v.update(); } catch (err) { archCommLog.debug("virtualizer update threw:", err); } });
      });
    };
    container.addEventListener('scroll', sharedScrollHandler, { passive: true });
    window.addEventListener('resize', sharedScrollHandler, { passive: true });
  }

  function destroyAllVirtualizers() {
    activeVirtualizers.forEach(function (v) { try { v.destroy(); } catch (err) { archCommLog.debug("virtualizer destroy threw:", err); } });
    activeVirtualizers.clear();
  }

  // 簡易 windowed virtualizer
  // - dataRows: 行データ配列 (= 増加するので参照で保持)
  // - bodyEl: 仮想化対象コンテナ (= topSpacer + 描画窓 + bottomSpacer 構造)
  // - buildCellFn: row → DOM cell
  // - scrollContainerEl: スクロール基準 (= .rh-arch-cs)
  function createVirtualizer(bodyEl, dataRows, buildCellFn, scrollContainerEl) {
    var topSpacer = document.createElement('div');
    topSpacer.className = 'rh-cs-virt-spacer';
    topSpacer.style.height = '0px';
    var bottomSpacer = document.createElement('div');
    bottomSpacer.className = 'rh-cs-virt-spacer';
    bottomSpacer.style.height = '0px';
    bodyEl.appendChild(topSpacer);
    bodyEl.appendChild(bottomSpacer);

    var renderedStart = 0;
    var renderedEnd = 0;
    var renderedCells = [];

    function update() {
      var n = dataRows.length;
      if (n === 0) {
        clearRendered();
        topSpacer.style.height = '0px';
        bottomSpacer.style.height = '0px';
        return;
      }
      // 折り畳まれている (= 親が display:none) ときは offsetWidth = 0。
      // 描画せず、 spacer も小さく保つ (= 開いた時に再 update される)。
      if (bodyEl.offsetWidth === 0) {
        clearRendered();
        topSpacer.style.height = '0px';
        bottomSpacer.style.height = '0px';
        return;
      }
      var bodyRect = bodyEl.getBoundingClientRect();
      var cRect = scrollContainerEl.getBoundingClientRect();
      var viewTop = cRect.top;
      var viewBottom = cRect.bottom;
      // body 内 local 座標
      var localTop = viewTop - bodyRect.top;
      var localBottom = viewBottom - bodyRect.top;
      var totalH = n * VIRT_ROW_HEIGHT;
      // body 全体が viewport より上 or 下のときは描画なしで spacer のみ
      if (localBottom <= 0) {
        // 完全に viewport の上
        clearRendered();
        topSpacer.style.height = '0px';
        bottomSpacer.style.height = totalH + 'px';
        return;
      }
      if (localTop >= totalH) {
        // 完全に viewport の下
        clearRendered();
        topSpacer.style.height = totalH + 'px';
        bottomSpacer.style.height = '0px';
        return;
      }
      var firstIdx = Math.max(0, Math.floor(Math.max(0, localTop) / VIRT_ROW_HEIGHT) - VIRT_BUFFER);
      var lastIdx = Math.min(n, Math.ceil(Math.max(0, localBottom) / VIRT_ROW_HEIGHT) + VIRT_BUFFER);
      setWindow(firstIdx, lastIdx);
    }

    function setWindow(start, end) {
      if (start === renderedStart && end === renderedEnd && renderedCells.length === (end - start)) return;
      clearRendered();
      for (var i = start; i < end; i++) {
        var cell = buildCellFn(dataRows[i]);
        // 高さ揃え (= 推定値で描画。 実高は flex / wrap で多少ぶれても可)
        bodyEl.insertBefore(cell, bottomSpacer);
        renderedCells.push(cell);
      }
      renderedStart = start;
      renderedEnd = end;
      topSpacer.style.height = (start * VIRT_ROW_HEIGHT) + 'px';
      var nrest = Math.max(0, dataRows.length - end);
      bottomSpacer.style.height = (nrest * VIRT_ROW_HEIGHT) + 'px';
    }

    function clearRendered() {
      renderedCells.forEach(function (c) { if (c.parentNode === bodyEl) bodyEl.removeChild(c); });
      renderedCells = [];
      renderedStart = 0;
      renderedEnd = 0;
    }

    function notifyDataExtended() {
      // データが増えたので bottomSpacer のみ更新 (= 描画窓は次の scroll/update で追従)
      update();
    }

    function destroy() {
      activeVirtualizers.delete(controller);
      clearRendered();
      if (topSpacer.parentNode) topSpacer.remove();
      if (bottomSpacer.parentNode) bottomSpacer.remove();
    }

    var controller = { update: update, notifyDataExtended: notifyDataExtended, destroy: destroy };
    activeVirtualizers.add(controller);
    return controller;
  }

  // 枠展開時に不足分のコメを CHUNK_SIZE 単位で取得して dataRows に push。
  // onProgress(dataRows.length, expectedTotal) を逐次呼ぶ。
  // onDone() を完了時に呼ぶ。
  function fetchStreamChunks(streamId, dataRows, expectedTotal, onProgress, onDone) {
    var lastQ = state.result.lastQuery || {};
    function loop(offset) {
      var body = {};
      Object.keys(lastQ).forEach(function (k) {
        // streamIds は強制上書き (= この枠だけに絞る)
        if (k !== 'streamIds') body[k] = lastQ[k];
      });
      body.streamIds = [streamId];
      body.limit = CHUNK_SIZE;
      body.offset = offset;
      body.includeKpi = false;
      return R.postJson('/api/listeners/comments/search', body).then(function (resp) {
        if (destroyed) return;
        if (!resp || !resp.ok || !resp.page) {
          onDone(new Error('fetch failed'));
          return;
        }
        var rows = resp.page.rows || [];
        for (var i = 0; i < rows.length; i++) dataRows.push(rows[i]);
        onProgress(dataRows.length, expectedTotal);
        if (rows.length >= CHUNK_SIZE && dataRows.length < expectedTotal) {
          return loop(offset + CHUNK_SIZE);
        }
        onDone(null);
      });
    }
    return loop(dataRows.length).catch(function (err) {
      if (destroyed) return;
      onDone(err);
    });
  }

  // ───── baseline 解決 (= ランク判定の基準枠) ─────
  // 接続中なら currentStreamVideoId、 切断中なら自チャンネル最新枠を採用。
  // listener.system_tag は baselineStreamVideoId 渡しでのみ populated される
  // (engine/listener_manager.rs::list_listeners の post-process)。
  function resolveBaseline() {
    R.fetchJson('/api/status').then(function (s) {
      if (s && s.connected && s.videoId) {
        state.baselineVideoId = s.videoId;
        return;
      }
      return R.fetchJson('/api/listeners/streams?sort=startedAt&scope=own&limit=1').then(function (resp) {
        if (resp && resp.ok && resp.page && resp.page.rows && resp.page.rows.length) {
          state.baselineVideoId = resp.page.rows[0].videoId;
        }
      });
    }).catch(function (err) { archCommLog.debug("promise rejected (catch swallow):", err); });
  }

  // ───── public init ─────
  function init(container, shell, query) {
    destroyed = false;
    var wrap = document.createElement('div');
    wrap.className = 'rh-arch-cs';
    container.appendChild(wrap);
    // cs view が overflow:auto を持つので、 ここを scroll container として登録。
    // 1 度だけ scroll listener を貼る (= 全 virtualizer 共有)。
    ensureSharedScrollListener(wrap);

    buildSavedStrip(wrap);
    buildForm(wrap);
    buildResultArea(wrap);

    if (!state.initialized) {
      loadSavedSearches();
      resolveBaseline();
      state.initialized = true;
    } else {
      renderSavedStrip();
      renderResult();
    }

    // pre-fetch tag lists for popovers (= 初回だけ)
    if (!state.allListenerTags) loadListenerTagsList();
    if (!state.allStreamTags) loadStreamTagsList();

    return {
      destroy: function () {
        destroyed = true;
        if (dom && dom.resultWrap) state.scrollTop = dom.resultWrap.scrollTop || 0;
        destroyAllVirtualizers();
        dom = null;
      },
      // archive shell が呼ぶ: サブタブが再表示された時に virtualizer を再同期。
      // display:none → block 切替で scrollTop / 描画窓 がズレる対策。
      onShow: function () {
        if (destroyed || !sharedScrollContainer) return;
        // 全 virtualizer の update() を呼ぶ (= 現在の scroll 位置に合わせて窓を再構築)
        activeVirtualizers.forEach(function (v) {
          try { v.update(); } catch (err) { archCommLog.debug("virtualizer update threw:", err); }
        });
      }
    };
  }

  // ───── 保存検索ストリップ ─────
  function buildSavedStrip(parent) {
    var strip = document.createElement('div');
    strip.className = 'rh-cs-saved-strip';
    strip.innerHTML =
      '<div class="rh-cs-saved-pins" id="rh-cs-saved-pins"></div>' +
      '<button type="button" class="rh-cs-saved-add" id="rh-cs-save-current">＋ 保存</button>';
    parent.appendChild(strip);
    if (!dom) dom = {};
    dom.savedPins = strip.querySelector('#rh-cs-saved-pins');
    dom.saveBtn = strip.querySelector('#rh-cs-save-current');
    dom.saveBtn.addEventListener('click', onClickSaveCurrent);
  }

  function renderSavedStrip() {
    if (!dom || !dom.savedPins) return;
    dom.savedPins.replaceChildren();
    var items = (state.saved && state.saved.items) || [];
    if (!items.length) {
      var hint = document.createElement('span');
      hint.className = 'rh-cs-saved-hint';
      hint.textContent = '保存検索なし';
      dom.savedPins.appendChild(hint);
      return;
    }
    items.forEach(function (it) {
      var pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'rh-cs-saved-pin';
      pin.innerHTML =
        '<span class="rh-cs-saved-name">' + escapeHtml(it.name) + '</span>' +
        '<span class="rh-cs-saved-x" data-action="delete" title="削除">✕</span>';
      pin.addEventListener('click', function (ev) {
        if (ev.target && ev.target.dataset && ev.target.dataset.action === 'delete') {
          ev.stopPropagation();
          if (confirm('「' + it.name + '」 を削除しますか?')) deleteSavedSearch(it.id);
          return;
        }
        loadConditionsIntoForm(it.conditions);
        runSearch();
      });
      dom.savedPins.appendChild(pin);
    });
  }

  function loadSavedSearches() {
    state.saved.status = 'loading';
    R.fetchJson('/api/saved-searches?scope=' + SAVED_SCOPE).then(function (resp) {
      if (destroyed) return;
      if (resp && resp.ok && resp.searches) {
        state.saved.items = resp.searches.map(function (it) {
          var cond = {};
          try { cond = JSON.parse(it.conditions || "{}"); } catch (err) { archCommLog.debug("conditions JSON parse failed:", err); }
          return { id: it.id, name: it.name, conditions: cond };
        });
      } else {
        state.saved.items = [];
      }
      state.saved.status = 'ready';
      renderSavedStrip();
    }).catch(function () {
      if (destroyed) return;
      state.saved.status = 'error';
      state.saved.items = [];
      renderSavedStrip();
    });
  }

  function onClickSaveCurrent() {
    var name = (prompt('保存する検索条件の名前') || '').trim();
    if (!name) return;
    var conditions = formStateToConditions();
    R.postJson('/api/saved-searches', {
      scope: SAVED_SCOPE,
      name: name,
      conditions: JSON.stringify(conditions)
    }).then(function (resp) {
      if (destroyed) return;
      if (!resp || !resp.ok) {
        alert('保存に失敗しました: ' + ((resp && resp.error) || ''));
        return;
      }
      loadSavedSearches();
    }).catch(function (err) {
      alert('保存に失敗しました: ' + (err && err.message ? err.message : err));
    });
  }

  function deleteSavedSearch(id) {
    fetch('/api/saved-searches/' + encodeURIComponent(id), {
      method: 'DELETE',
      cache: 'no-store'
    }).then(function (res) {
      if (destroyed) return;
      if (!res.ok) {
        alert('削除に失敗しました');
        return;
      }
      loadSavedSearches();
    }).catch(function (err) {
      alert('削除に失敗しました: ' + (err && err.message ? err.message : err));
    });
  }

  // ───── form ─────
  function buildForm(parent) {
    var form = document.createElement('div');
    form.className = 'rh-cs-form';
    form.innerHTML =
      '<label class="rh-cs-field">' +
        '<span class="rh-cs-label">配信枠名</span>' +
        '<input type="text" id="rh-cs-stream-title-q" placeholder="例: 歌枠 / Apex (空白区切り OR)">' +
      '</label>' +
      '<label class="rh-cs-field">' +
        '<span class="rh-cs-label">本文</span>' +
        '<input type="text" id="rh-cs-body-q" placeholder="キーワード (空白区切り OR)">' +
      '</label>' +
      '<label class="rh-cs-field">' +
        '<span class="rh-cs-label">リスナー名</span>' +
        '<input type="text" id="rh-cs-name-q" placeholder="部分一致">' +
      '</label>' +
      '<div class="rh-cs-field">' +
        '<span class="rh-cs-label">種別</span>' +
        '<div class="rh-cs-type-row" id="rh-cs-type-row">' +
          '<label class="rh-cs-type-pill"><input type="checkbox" value="chat"> チャット</label>' +
          '<label class="rh-cs-type-pill"><input type="checkbox" value="gift"> ギフト</label>' +
          '<label class="rh-cs-type-pill"><input type="checkbox" value="membership"> メンバー加入</label>' +
        '</div>' +
      '</div>' +
      '<div class="rh-cs-field">' +
        '<span class="rh-cs-label">期間</span>' +
        '<button type="button" class="rh-cs-picker-btn" id="rh-cs-period-btn">' +
          '<span id="rh-cs-period-label">全期間</span> <span class="rh-cs-picker-arrow">›</span>' +
        '</button>' +
      '</div>' +
      '<div class="rh-cs-field">' +
        '<span class="rh-cs-label">リスナー</span>' +
        '<button type="button" class="rh-cs-picker-btn" id="rh-cs-listener-btn">' +
          '<span id="rh-cs-listener-label">指定なし</span> <span class="rh-cs-picker-arrow">›</span>' +
        '</button>' +
      '</div>' +
      '<div class="rh-cs-field">' +
        '<span class="rh-cs-label">配信枠</span>' +
        '<button type="button" class="rh-cs-picker-btn" id="rh-cs-stream-btn">' +
          '<span id="rh-cs-stream-label">指定なし</span> <span class="rh-cs-picker-arrow">›</span>' +
        '</button>' +
      '</div>' +
      '<label class="rh-cs-field">' +
        '<span class="rh-cs-label">スコープ</span>' +
        '<select id="rh-cs-scope">' +
          '<option value="own">自チャンネル</option>' +
          '<option value="all">すべて</option>' +
          '<option value="other">他チャンネル</option>' +
        '</select>' +
      '</label>' +
      '<div class="rh-cs-form-actions">' +
        '<button type="button" class="rh-cs-clear-btn" id="rh-cs-clear">条件クリア</button>' +
        '<button type="button" class="rh-cs-run-btn" id="rh-cs-run">検索</button>' +
      '</div>';
    parent.appendChild(form);

    dom.form = form;
    dom.streamTitleQ = form.querySelector('#rh-cs-stream-title-q');
    dom.bodyQ = form.querySelector('#rh-cs-body-q');
    dom.nameQ = form.querySelector('#rh-cs-name-q');
    dom.typeRow = form.querySelector('#rh-cs-type-row');
    dom.periodLabel = form.querySelector('#rh-cs-period-label');
    dom.listenerLabel = form.querySelector('#rh-cs-listener-label');
    dom.streamLabel = form.querySelector('#rh-cs-stream-label');
    dom.scope = form.querySelector('#rh-cs-scope');
    dom.runBtn = form.querySelector('#rh-cs-run');
    dom.clearBtn = form.querySelector('#rh-cs-clear');

    // bind form ↔ state
    syncFormFromState();

    dom.streamTitleQ.addEventListener('input', function () { state.form.streamTitleQ = dom.streamTitleQ.value; });
    dom.bodyQ.addEventListener('input', function () { state.form.bodyQ = dom.bodyQ.value; });
    dom.nameQ.addEventListener('input', function () { state.form.nameQ = dom.nameQ.value; });
    dom.scope.addEventListener('change', function () { state.form.scope = dom.scope.value; });
    var typeCbs = dom.typeRow.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < typeCbs.length; i++) {
      typeCbs[i].addEventListener('change', function () {
        state.form.types = Array.prototype.filter
          .call(typeCbs, function (cb) { return cb.checked; })
          .map(function (cb) { return cb.value; });
      });
    }
    form.querySelector('#rh-cs-period-btn').addEventListener('click', openPeriodSheet);
    form.querySelector('#rh-cs-listener-btn').addEventListener('click', openListenerSheet);
    form.querySelector('#rh-cs-stream-btn').addEventListener('click', openStreamSheet);
    dom.runBtn.addEventListener('click', runSearch);
    dom.clearBtn.addEventListener('click', function () {
      state.form = {
        streamTitleQ: '', bodyQ: '', nameQ: '', types: [], scope: 'own',
        period: null, listeners: [], streams: []
      };
      syncFormFromState();
    });
  }

  function syncFormFromState() {
    if (!dom) return;
    dom.streamTitleQ.value = state.form.streamTitleQ || '';
    dom.bodyQ.value = state.form.bodyQ || '';
    dom.nameQ.value = state.form.nameQ || '';
    dom.scope.value = state.form.scope || 'own';
    var typeCbs = dom.typeRow.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < typeCbs.length; i++) {
      typeCbs[i].checked = state.form.types.indexOf(typeCbs[i].value) >= 0;
    }
    dom.periodLabel.textContent = (state.form.period && state.form.period.label) || '全期間';
    dom.listenerLabel.textContent = state.form.listeners.length > 0
      ? state.form.listeners.length + ' 人'
      : '指定なし';
    dom.streamLabel.textContent = state.form.streams.length > 0
      ? state.form.streams.length + ' 枠'
      : '指定なし';
  }

  function formStateToConditions() {
    return {
      streamTitleQ: state.form.streamTitleQ || '',
      bodyQ: state.form.bodyQ || '',
      nameQ: state.form.nameQ || '',
      types: state.form.types.slice(),
      scope: state.form.scope || 'own',
      periodFrom: state.form.period ? state.form.period.from : null,
      periodTo: state.form.period ? state.form.period.to : null,
      periodLabel: state.form.period ? state.form.period.label : null,
      listenerChannelIds: state.form.listeners.map(function (l) { return l.channelId; }),
      streamIds: state.form.streams.map(function (s) { return s.videoId; })
    };
  }

  function loadConditionsIntoForm(cond) {
    if (!cond) return;
    state.form.streamTitleQ = cond.streamTitleQ || '';
    state.form.bodyQ = cond.bodyQ || '';
    state.form.nameQ = cond.nameQ || '';
    state.form.types = Array.isArray(cond.types) ? cond.types.slice() : [];
    state.form.scope = cond.scope || 'own';
    if (cond.periodFrom || cond.periodTo) {
      state.form.period = {
        from: cond.periodFrom || 0,
        to: cond.periodTo || 0,
        label: cond.periodLabel || formatPeriodLabel(cond.periodFrom, cond.periodTo)
      };
    } else {
      state.form.period = null;
    }
    state.form.listeners = (cond.listenerChannelIds || []).map(function (id) {
      return { channelId: id, displayName: id };
    });
    state.form.streams = (cond.streamIds || []).map(function (id) {
      return { videoId: id, title: id };
    });
    syncFormFromState();
  }

  // ───── search 実行 ─────
  function buildResultArea(parent) {
    var area = document.createElement('div');
    area.className = 'rh-cs-result-area';
    // .rh-list-wrap は使わない: cs view は外側 .rh-arch-cs が overflow-y:auto で
    // 全体スクロール責務を持つので、 内側で更にスクロール領域を作ると flex:1 1 0
    // が 0 に潰れて中身が見えなくなる (= 2026-05-14 修正)。
    area.innerHTML =
      '<div class="rh-cs-result-summary" id="rh-cs-summary"></div>' +
      '<div id="rh-cs-result-wrap">' +
        '<div id="rh-cs-result-list"></div>' +
        '<div id="rh-cs-result-empty" class="rh-empty" style="display:none">該当するコメントがありません</div>' +
      '</div>';
    parent.appendChild(area);
    dom.summary = area.querySelector('#rh-cs-summary');
    dom.resultWrap = area.querySelector('#rh-cs-result-wrap');
    dom.resultList = area.querySelector('#rh-cs-result-list');
    dom.resultEmpty = area.querySelector('#rh-cs-result-empty');
  }

  // form state → CommentsQuery body (= 検索 + チャンク再 fetch 共用)。
  // limit / offset / streamIds / includeKpi はチャンクで上書きする想定。
  function buildSearchBody() {
    var body = {};
    if (state.form.streamTitleQ) body.streamTitleQ = state.form.streamTitleQ;
    if (state.form.bodyQ) body.bodyQ = state.form.bodyQ;
    if (state.form.nameQ) body.nameQ = state.form.nameQ;
    if (state.form.types.length) {
      var ct = [];
      state.form.types.forEach(function (t) {
        if (t === 'gift') ct.push('superchat', 'sticker', 'gift');
        else ct.push(t);
      });
      body.commentTypes = ct;
    }
    if (state.form.period) {
      if (state.form.period.from) body.periodFrom = state.form.period.from;
      if (state.form.period.to) body.periodTo = state.form.period.to;
    }
    if (state.form.listeners.length) {
      body.listenerChannelIds = state.form.listeners.map(function (l) { return l.channelId; });
    }
    if (state.form.streams.length) {
      body.streamIds = state.form.streams.map(function (s) { return s.videoId; });
    }
    return body;
  }

  function runSearch() {
    state.result.status = 'loading';
    renderResult();
    var body = buildSearchBody();
    body.limit = 500;
    body.offset = 0;
    body.includeKpi = true;
    // チャンク fetch がフィルタを再現できるよう保存
    state.result.lastQuery = buildSearchBody();
    // scope は backend に直接渡らない (= CommentsQuery には scope なし)。 表示時に
    // フロントで filter する設計 → 旧実装と合わせるなら listener_channel_ids を引っ張る
    // 必要があるが、 mobile では複雑度を抑えて scope='own' は owner_channels 経由で
    // hydrate (= 未実装、 'own' でも 'all' と同じ結果を返す)。
    // TODO: backend scope サポート追加か、 'own' filter を front で適用するか検討
    R.postJson('/api/listeners/comments/search', body).then(function (resp) {
      if (destroyed) return;
      if (!resp || !resp.ok || !resp.page) {
        state.result.status = 'error';
        state.result.rows = [];
        state.result.total = 0;
        state.result.kpi = null;
        state.result.streams = [];
      } else {
        state.result.rows = resp.page.rows || [];
        state.result.total = resp.page.total || 0;
        state.result.kpi = resp.page.kpi || null;
        state.result.streams = resp.page.streams || [];
        state.result.status = 'ready';
      }
      renderResult();
      // 検索完了直後は結果サマリが画面上端に来るまで自動スクロール
      // (= 結果が長い時に検索ボタンを押した位置を保たず、 すぐ結果を見せる)
      if (state.result.status === 'ready') {
        requestAnimationFrame(scrollToResultStart);
      }
    }).catch(function () {
      if (destroyed) return;
      state.result.status = 'error';
      renderResult();
    });
  }

  function scrollToResultStart() {
    if (!sharedScrollContainer) return;
    var target = sharedScrollContainer.querySelector('.rh-cs-result-summary');
    if (!target) return;
    var cRect = sharedScrollContainer.getBoundingClientRect();
    var tRect = target.getBoundingClientRect();
    var delta = tRect.top - cRect.top;
    if (Math.abs(delta) < 2) return;  // 既に画面上端付近なら何もしない
    try {
      sharedScrollContainer.scrollBy({ top: delta, behavior: 'smooth' });
    } catch (_) {
      // 古いブラウザ fallback
      sharedScrollContainer.scrollTop += delta;
    }
  }

  function renderResult() {
    if (!dom || !dom.resultList) return;
    // 古い virtualizer は新規 render の前に破棄 (= 古い DOM 参照を捨てる)
    destroyAllVirtualizers();
    if (state.result.status === 'idle') {
      dom.summary.textContent = '';
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = '';
      dom.resultEmpty.textContent = '条件を入力して 「検索」 を押してください';
      return;
    }
    if (state.result.status === 'loading') {
      dom.summary.textContent = '検索中…';
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = 'none';
      return;
    }
    if (state.result.status === 'error') {
      dom.summary.textContent = '';
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = '';
      dom.resultEmpty.textContent = '検索に失敗しました';
      return;
    }
    var rows = state.result.rows || [];
    var kpi = state.result.kpi;
    var streams = state.result.streams || [];

    // 結果 summary text: 全件 + マッチ枠数 (= 表示数は chunk fetch で枠ごとに変動するので summary には出さない)
    var summaryParts = ['全 ' + state.result.total + ' 件'];
    if (streams.length) summaryParts.push(streams.length + ' 枠');
    dom.summary.textContent = summaryParts.join(' · ');

    if (!rows.length && !streams.length) {
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = '';
      dom.resultEmpty.textContent = '該当するコメントがありません';
      return;
    }
    dom.resultEmpty.style.display = 'none';

    // rows を stream_id で grouping (= 同枠は連続前提だが Map ベース)
    var rowsByStream = {};
    rows.forEach(function (row) {
      var sid = row.streamId || '__no-stream__';
      if (!rowsByStream[sid]) rowsByStream[sid] = [];
      rowsByStream[sid].push(row);
    });

    var frag = document.createDocumentFragment();
    // 結果 KPI summary card
    if (kpi) frag.appendChild(buildKpiSummaryCard(kpi));
    // streams を kpi.streamCount 順 (= streams[] は backend が posted_at DESC で来る)
    // 各枠カードに header + 該当 rows を入れる。 rows が無い枠も枠カード自体は出す。
    // 初期展開: rows がある最初の枠だけ (本体 cs と同等)。
    var firstWithRowsIdx = -1;
    for (var i = 0; i < streams.length; i++) {
      if ((rowsByStream[streams[i].streamId] || []).length > 0) { firstWithRowsIdx = i; break; }
    }
    streams.forEach(function (sKpi, idx) {
      var streamRows = rowsByStream[sKpi.streamId] || [];
      frag.appendChild(buildStreamCard(sKpi, streamRows, idx === firstWithRowsIdx));
    });
    // streams に無い stream_id の rows (= 通常起こらないが念のため fallback)
    Object.keys(rowsByStream).forEach(function (sid) {
      if (streams.some(function (s) { return s.streamId === sid; })) return;
      var fakeKpi = {
        streamId: sid,
        title: sid,
        startedAt: 0,
        endedAt: 0,
        commentCount: rowsByStream[sid].length,
        amountJpy: 0,
        likes: 0,
        peakViewers: 0,
        uniqueListeners: 0
      };
      frag.appendChild(buildStreamCard(fakeKpi, rowsByStream[sid], false));
    });
    dom.resultList.replaceChildren(frag);
  }

  // 結果全体の KPI summary カード (= 本体 cs-summary-card 相当をスマホ向け 2×3 grid に)
  function buildKpiSummaryCard(kpi) {
    var card = document.createElement('div');
    card.className = 'rh-cs-kpi-card';
    var grid = document.createElement('div');
    grid.className = 'rh-cs-kpi-grid';

    function cell(label, value, avg, tone) {
      var c = document.createElement('div');
      c.className = 'rh-cs-kpi-cell' + (tone ? ' tone-' + tone : '');
      c.innerHTML =
        '<div class="rh-cs-kpi-label">' + escapeHtml(label) + '</div>' +
        '<div class="rh-cs-kpi-value">' + value + '</div>' +
        (avg ? '<div class="rh-cs-kpi-avg">' + avg + '</div>' : '');
      return c;
    }
    function fmtNum(n) { return Number(n || 0).toLocaleString('ja-JP'); }
    function fmtYen(n) { return '¥' + fmtNum(n); }

    var sc = kpi.streamCount || 0;
    var avgCount = sc > 0 ? (kpi.totalCount / sc).toFixed(1) : '0';
    var avgAmount = sc > 0 ? Math.round((kpi.totalAmountJpy || 0) / sc) : 0;
    var avgUnique = (kpi.avgUniqueListenersPerStream || 0).toFixed(1);
    var avgLikes = kpi.avgLikesPerStream || 0;
    var avgLikesStr = avgLikes >= 1000 ? Math.round(avgLikes).toLocaleString('ja-JP') : avgLikes.toFixed(1);
    var avgPeak = kpi.avgPeakViewersPerStream || 0;
    var avgPeakStr = avgPeak >= 1000 ? Math.round(avgPeak).toLocaleString('ja-JP') : avgPeak.toFixed(1);

    grid.appendChild(cell('コメント', fmtNum(kpi.totalCount) + '<span class="unit">件</span>', 'avg ' + avgCount + ' /枠'));
    grid.appendChild(cell('金額', fmtYen(kpi.totalAmountJpy || 0), 'avg ' + fmtYen(avgAmount) + ' /枠', 'amber'));
    grid.appendChild(cell('リスナー', fmtNum(kpi.uniqueListeners) + '<span class="unit">人</span>', 'avg ' + avgUnique + ' /枠'));
    grid.appendChild(cell('いいね', fmtNum(kpi.totalLikes), 'avg ' + avgLikesStr + ' /枠', 'pink'));
    // peak は枠ごとの数値で、 合計は無意味 (= 同時刻ではない)。 主値 = 平均、 副 = 最大。
    grid.appendChild(cell('peak (平均)', avgPeakStr + '<span class="unit">人</span>', '最大 ' + fmtNum(kpi.maxPeakViewers), 'green'));
    grid.appendChild(cell('配信枠', fmtNum(kpi.streamCount) + '<span class="unit">枠</span>', null));
    card.appendChild(grid);

    if (kpi.periodFrom && kpi.periodTo) {
      var range = document.createElement('div');
      range.className = 'rh-cs-kpi-range';
      range.innerHTML = '<span class="rh-cs-kpi-range-label">範囲</span> ' +
        escapeHtml(formatYmdShort(kpi.periodFrom)) + ' – ' + escapeHtml(formatYmdShort(kpi.periodTo));
      card.appendChild(range);
    }
    return card;
  }

  // 配信枠カード (= ヘッダに KPI 一行 + 直下にコメント rows、 ヘッダタップで開閉)
  function buildStreamCard(sKpi, streamRows, openInitially) {
    var card = document.createElement('div');
    card.className = 'rh-cs-stream-card' + (openInitially ? '' : ' collapsed');

    var head = document.createElement('div');
    head.className = 'rh-cs-stream-card-head';

    // タイトル行: ▼ chevron + title + 詳細ボタン (= 別ナビ)
    var titleRow = document.createElement('div');
    titleRow.className = 'rh-cs-stream-card-title-row';

    var arrow = document.createElement('span');
    arrow.className = 'rh-cs-stream-arrow';
    arrow.textContent = '▼';
    arrow.setAttribute('aria-hidden', 'true');
    titleRow.appendChild(arrow);

    var title = document.createElement('span');
    title.className = 'rh-cs-stream-card-title';
    title.textContent = sKpi.title || sKpi.streamId;
    titleRow.appendChild(title);

    // 配信詳細ページへ (= 別 view への navigation。 head click と区別するため stopPropagation)
    var detailBtn = document.createElement('a');
    detailBtn.className = 'rh-cs-stream-card-detail-btn';
    detailBtn.href = '/remote/streams/' + encodeURIComponent(sKpi.streamId);
    detailBtn.title = '配信詳細を開く';
    detailBtn.textContent = '詳細 ›';
    detailBtn.addEventListener('click', function (ev) { ev.stopPropagation(); });
    titleRow.appendChild(detailBtn);

    head.appendChild(titleRow);

    var sub = document.createElement('div');
    sub.className = 'rh-cs-stream-card-sub';
    var subParts = [];
    if (sKpi.startedAt) subParts.push(formatYmdHm(sKpi.startedAt));
    if (sKpi.startedAt && sKpi.endedAt > sKpi.startedAt) {
      subParts.push(formatDuration(sKpi.endedAt - sKpi.startedAt));
    }
    sub.textContent = subParts.join(' · ');
    head.appendChild(sub);

    // KPI 行 (枠ごと、 横スクロール対応)
    var kpiLine = document.createElement('div');
    kpiLine.className = 'rh-cs-stream-card-kpi';
    function kpiPart(label, value, tone) {
      return '<span class="rh-cs-stream-kpi' + (tone ? ' tone-' + tone : '') + '">' +
        '<span class="k">' + escapeHtml(label) + '</span>' +
        '<span class="v">' + value + '</span>' +
        '</span>';
    }
    var parts = [];
    parts.push(kpiPart('💬', String(sKpi.commentCount || 0)));
    if (sKpi.amountJpy > 0) parts.push(kpiPart('¥', Number(sKpi.amountJpy).toLocaleString('ja-JP'), 'amber'));
    parts.push(kpiPart('🧍', String(sKpi.uniqueListeners || 0)));
    if (sKpi.likes > 0) parts.push(kpiPart('👍', String(sKpi.likes), 'pink'));
    if (sKpi.peakViewers > 0) parts.push(kpiPart('peak', String(sKpi.peakViewers), 'green'));
    kpiLine.innerHTML = parts.join('');
    head.appendChild(kpiLine);

    card.appendChild(head);

    // body (= 仮想化されたコメリスト + 進捗 placeholder)
    var body = document.createElement('div');
    body.className = 'rh-cs-stream-card-body';
    card.appendChild(body);
    // 進捗 placeholder (= 取得未完了時のみ表示)
    var placeholder = document.createElement('div');
    placeholder.className = 'rh-cs-stream-card-placeholder';
    placeholder.style.display = 'none';
    card.appendChild(placeholder);

    // データ準備: streamRows をベースに、 不足分は枠展開時にチャンク fetch
    // 検索条件にマッチした件数 (= sKpi.commentCount は backend が「この検索条件で
    // この枠にあるコメ件数」 を返す)。 全件 fetch するための上限値。
    var dataRows = streamRows.slice();
    var expectedTotal = sKpi.commentCount || dataRows.length;
    var hasFetched = dataRows.length >= expectedTotal;
    var fetching = false;

    function updatePlaceholder(text) {
      if (text == null) {
        placeholder.style.display = 'none';
        return;
      }
      placeholder.textContent = text;
      placeholder.style.display = '';
    }

    // 仮想化開始
    var virt = createVirtualizer(body, dataRows, buildCommentCell, sharedScrollContainer);

    if (!hasFetched) {
      updatePlaceholder('残り ' + (expectedTotal - dataRows.length) + ' 件 — 展開で読み込みます');
    }

    function fetchRemaining() {
      if (hasFetched || fetching) return;
      fetching = true;
      updatePlaceholder('取得中… (' + dataRows.length + ' / ' + expectedTotal + ')');
      fetchStreamChunks(
        sKpi.streamId,
        dataRows,
        expectedTotal,
        function progress(loaded, total) {
          if (destroyed) return;
          updatePlaceholder('取得中… (' + loaded + ' / ' + total + ')');
          virt.notifyDataExtended();
        },
        function done(err) {
          if (destroyed) return;
          if (err) {
            updatePlaceholder('読み込みに失敗しました');
          } else {
            hasFetched = true;
            updatePlaceholder(null);
            virt.notifyDataExtended();
          }
          fetching = false;
        }
      );
    }

    // ヘッダタップで開閉 + 初回展開で fetch (= 詳細ボタンは stopPropagation 済)
    head.addEventListener('click', function () {
      card.classList.toggle('collapsed');
      var isOpen = !card.classList.contains('collapsed');
      if (isOpen) {
        if (!hasFetched) fetchRemaining();
        // 表示直後に virtualizer を起動 (= bodyRect.height が確定する次フレーム)
        requestAnimationFrame(function () { virt.update(); });
      }
    });
    head.style.cursor = 'pointer';

    // 初期展開で fetch (= 検索直後トップに見える枠)
    if (openInitially && !hasFetched) {
      // 次フレームに遅延 (= card が DOM 接続済になってから fetch & update)
      requestAnimationFrame(function () { fetchRemaining(); });
    }
    if (openInitially) {
      requestAnimationFrame(function () { virt.update(); });
    }

    // streamRows 0 件の枠 (= 検索 limit 500 を超えて先頭 500 に入らなかった枠) の hint
    if (streamRows.length === 0 && expectedTotal > 0) {
      updatePlaceholder('全 ' + expectedTotal + ' 件 — 展開で読み込みます');
    }

    return card;
  }

  function formatYmdHm(unixMs) {
    if (!unixMs) return '';
    var d = new Date(Number(unixMs));
    if (isNaN(d.getTime())) return '';
    var wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() +
      ' (' + wd + ') ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function formatDuration(ms) {
    if (!ms || ms < 0) return '';
    var sec = Math.floor(ms / 1000);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function buildCommentCell(row) {
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
    return KS.createCommentItem(data, {
      formatTime: R.formatRelativeTime,
      formatYen: R.formatYen,
      truncate: R.truncate,
      rewriteUrl: R.normalizeAssetUrl
    });
  }

  // ═══════════════ 期間ボトムシート ═══════════════
  // 本体 cs-period popover (= renderer.js:17400 周辺) の機能を踏襲:
  //   - preset (= 7 種) + active 表示
  //   - カレンダー (= タップで from→to 順次選択、 範囲ハイライト)
  //   - 月送り ◀▶ + 月名タップで年月 picker
  //   - 「N 日間」 サマリ表示
  // スマホは画面幅の都合で 1 ヶ月ずつ表示。
  function openPeriodSheet() {
    var content = document.createElement('div');
    content.className = 'rh-cs-period';

    // ───── working state ─────
    // from/to は startOfDay/endOfDay の epoch ms (= 本体と同じ表現)。
    // 適用時に periodTo = to + 1ms で exclusive に変換して form state に保存。
    var working = {
      from: null,
      to: null,
      activePreset: null,  // 現在 active な preset key
      calYear: 0,
      calMonth: 0,
      ymPickerYear: null   // 年月 picker が出ているか (= null で隠れ)
    };
    // 既存 form state から復元
    if (state.form.period && (state.form.period.from || state.form.period.to)) {
      working.from = state.form.period.from || null;
      // form state の to は exclusive (= 当日 0:00 翌日)、 popover state では当日末 (endOfDay)
      working.to = state.form.period.to ? state.form.period.to - 1 : null;
    }
    var anchor = working.to ? new Date(working.to) : new Date();
    working.calYear = anchor.getFullYear();
    working.calMonth = anchor.getMonth();

    // ───── helpers ─────
    function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
    function endOfDay(d)   { var x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
    function fmtYmd(unixMs) {
      if (!unixMs) return '?';
      var d = new Date(unixMs);
      return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
    }

    // ───── DOM 骨格 ─────
    content.innerHTML =
      '<div class="rh-cs-period-presets" id="rh-cs-pp-presets">' +
        '<button type="button" data-preset="today">今日</button>' +
        '<button type="button" data-preset="yesterday">昨日</button>' +
        '<button type="button" data-preset="thisWeek">今週</button>' +
        '<button type="button" data-preset="thisMonth">今月</button>' +
        '<button type="button" data-preset="lastMonth">先月</button>' +
        '<button type="button" data-preset="last30">過去30日</button>' +
        '<button type="button" data-preset="all">全期間</button>' +
      '</div>' +
      '<div class="rh-cs-pp-hint" id="rh-cs-pp-hint"></div>' +
      '<div class="rh-cs-pp-summary" id="rh-cs-pp-summary"></div>' +
      '<div class="rh-cs-pp-cal" id="rh-cs-pp-cal"></div>' +
      '<div class="rh-cs-pp-legend">' +
        '<span class="lg-today"></span> 今日 ' +
        '<span class="lg-from"></span> 開始日 ' +
        '<span class="lg-to"></span> 終了日 ' +
        '<span class="lg-range"></span> 範囲内' +
      '</div>' +
      '<div class="rh-cs-pp-ym" id="rh-cs-pp-ym" style="display:none"></div>';

    var presetsEl = content.querySelector('#rh-cs-pp-presets');
    var hintEl = content.querySelector('#rh-cs-pp-hint');
    var summaryEl = content.querySelector('#rh-cs-pp-summary');
    var calEl = content.querySelector('#rh-cs-pp-cal');
    var ymEl = content.querySelector('#rh-cs-pp-ym');

    // ───── preset ─────
    function applyPreset(key) {
      var now = new Date();
      var todayStart = startOfDay(now);
      var f = null, t = null;
      switch (key) {
        case 'today':
          f = todayStart.getTime();
          t = endOfDay(now).getTime();
          break;
        case 'yesterday': {
          var y = new Date(todayStart); y.setDate(y.getDate() - 1);
          f = y.getTime();
          t = endOfDay(y).getTime();
          break;
        }
        case 'thisWeek': {
          var monday = new Date(todayStart);
          var dow = (monday.getDay() + 6) % 7;  // 月=0
          monday.setDate(monday.getDate() - dow);
          f = monday.getTime();
          t = endOfDay(now).getTime();
          break;
        }
        case 'thisMonth':
          f = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
          t = endOfDay(now).getTime();
          break;
        case 'lastMonth':
          f = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
          t = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime();
          break;
        case 'last30': {
          var d30 = new Date(todayStart); d30.setDate(d30.getDate() - 29);
          f = d30.getTime();
          t = endOfDay(now).getTime();
          break;
        }
        case 'all':
          f = null; t = null;
          break;
      }
      working.from = f;
      working.to = t;
      working.activePreset = key;
      // カレンダー表示位置を to に追従
      if (t) {
        var a = new Date(t);
        working.calYear = a.getFullYear();
        working.calMonth = a.getMonth();
      }
      render();
    }
    var presetBtns = presetsEl.querySelectorAll('button');
    for (var i = 0; i < presetBtns.length; i++) {
      presetBtns[i].addEventListener('click', function () {
        applyPreset(this.dataset.preset);
      });
    }

    // ───── カレンダー描画 ─────
    function renderCalendar() {
      calEl.replaceChildren();
      var year = working.calYear;
      var month = working.calMonth;
      // ヘッダ (◀ Y/M ▶)
      var head = document.createElement('div');
      head.className = 'rh-cs-pp-cal-h';
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'rh-cs-pp-nav';
      prev.textContent = '◀';
      prev.addEventListener('click', function () {
        working.calMonth -= 1;
        if (working.calMonth < 0) { working.calMonth += 12; working.calYear -= 1; }
        renderCalendar();
      });
      head.appendChild(prev);
      var name = document.createElement('button');
      name.type = 'button';
      name.className = 'rh-cs-pp-cal-name';
      name.textContent = year + ' 年 ' + (month + 1) + ' 月';
      name.addEventListener('click', function () { showYmPicker(year); });
      head.appendChild(name);
      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'rh-cs-pp-nav';
      next.textContent = '▶';
      next.addEventListener('click', function () {
        working.calMonth += 1;
        if (working.calMonth > 11) { working.calMonth -= 12; working.calYear += 1; }
        renderCalendar();
      });
      head.appendChild(next);
      calEl.appendChild(head);

      // 日付グリッド
      var grid = document.createElement('div');
      grid.className = 'rh-cs-pp-cal-grid';
      var dows = ['日', '月', '火', '水', '木', '金', '土'];
      for (var di = 0; di < 7; di++) {
        var dh = document.createElement('span');
        dh.className = 'rh-cs-pp-dow' + (di === 0 ? ' sun' : '') + (di === 6 ? ' sat' : '');
        dh.textContent = dows[di];
        grid.appendChild(dh);
      }
      // 前月詰め
      var firstDow = new Date(year, month, 1).getDay();
      var daysInPrev = new Date(year, month, 0).getDate();
      for (var p = 0; p < firstDow; p++) {
        var pc = document.createElement('span');
        pc.className = 'rh-cs-pp-day other-month';
        pc.textContent = String(daysInPrev - firstDow + 1 + p);
        grid.appendChild(pc);
      }
      // 当月
      var daysInMonth = new Date(year, month + 1, 0).getDate();
      var todayStartMs = startOfDay(new Date()).getTime();
      var fStartMs = working.from ? startOfDay(new Date(working.from)).getTime() : null;
      var tStartMs = working.to ? startOfDay(new Date(working.to)).getTime() : null;
      for (var dd = 1; dd <= daysInMonth; dd++) {
        var cellMs = new Date(year, month, dd).getTime();
        var cell = document.createElement('span');
        cell.className = 'rh-cs-pp-day';
        cell.textContent = String(dd);
        if (cellMs === todayStartMs) cell.classList.add('today');
        if (fStartMs !== null && tStartMs !== null
            && cellMs >= fStartMs && cellMs <= tStartMs) {
          cell.classList.add('in-range');
        }
        if (fStartMs !== null && cellMs === fStartMs) cell.classList.add('range-start');
        if (tStartMs !== null && cellMs === tStartMs) cell.classList.add('range-end');
        (function (msVal) {
          cell.addEventListener('click', function () { onDayClick(msVal); });
        }(cellMs));
        grid.appendChild(cell);
      }
      // 後埋め (6 行揃え)
      var totalCells = 7 + firstDow + daysInMonth;
      var trailing = (totalCells % 7 === 0) ? 0 : (7 - (totalCells % 7));
      for (var tr = 1; tr <= trailing; tr++) {
        var tc = document.createElement('span');
        tc.className = 'rh-cs-pp-day other-month';
        tc.textContent = String(tr);
        grid.appendChild(tc);
      }
      calEl.appendChild(grid);
    }

    // ───── 日付タップ: from → to の順次選択 ─────
    function onDayClick(ms) {
      var dayStart = startOfDay(new Date(ms)).getTime();
      var dayEnd = endOfDay(new Date(ms)).getTime();
      if (working.from === null || (working.from !== null && working.to !== null)) {
        // 新規開始
        working.from = dayStart;
        working.to = null;
      } else {
        // 終了選択
        if (dayStart < working.from) {
          working.to = endOfDay(new Date(working.from)).getTime();
          working.from = dayStart;
        } else {
          working.to = dayEnd;
        }
      }
      working.activePreset = null;
      render();
    }

    // ───── 年月 picker (= 月名タップで開く) ─────
    function showYmPicker(year) {
      working.ymPickerYear = year;
      ymEl.style.display = '';
      ymEl.replaceChildren();
      // ヘッダ
      var h = document.createElement('div');
      h.className = 'rh-cs-pp-ym-h';
      var pv = document.createElement('button');
      pv.type = 'button';
      pv.textContent = '◀';
      pv.addEventListener('click', function () { showYmPicker(working.ymPickerYear - 1); });
      h.appendChild(pv);
      var lbl = document.createElement('span');
      lbl.textContent = year + ' 年';
      h.appendChild(lbl);
      var nx = document.createElement('button');
      nx.type = 'button';
      nx.textContent = '▶';
      nx.addEventListener('click', function () { showYmPicker(working.ymPickerYear + 1); });
      h.appendChild(nx);
      ymEl.appendChild(h);
      // 4×3 月グリッド
      var grid = document.createElement('div');
      grid.className = 'rh-cs-pp-ym-grid';
      for (var m = 0; m < 12; m++) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'rh-cs-pp-ym-cell';
        if (year === working.calYear && m === working.calMonth) c.classList.add('active');
        c.textContent = (m + 1) + ' 月';
        (function (mm, yy) {
          c.addEventListener('click', function () {
            working.calYear = yy;
            working.calMonth = mm;
            hideYmPicker();
            renderCalendar();
          });
        }(m, year));
        grid.appendChild(c);
      }
      ymEl.appendChild(grid);
      // カレンダー本体は隠さない (= スマホは縦長で両方見える方が分かりやすい)
    }
    function hideYmPicker() {
      working.ymPickerYear = null;
      ymEl.style.display = 'none';
    }

    // ───── 全体描画 ─────
    function render() {
      // preset active
      var btns = presetsEl.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.preset === working.activePreset);
      }
      // hint (= 「次に何をすべきか」 を明示)
      var hasFrom = working.from !== null;
      var hasTo = working.to !== null;
      var hintCls = 'rh-cs-pp-hint';
      var hintText = '';
      if (!hasFrom && !hasTo) {
        hintCls += ' info';
        hintText = '開始日と終了日 をカレンダーでタップしてください (= 全期間で良ければ「全期間」)';
      } else if (hasFrom && !hasTo) {
        hintCls += ' warn';
        hintText = '次は 終了日 をタップしてください';
      } else {
        hintCls += ' ok';
        hintText = '範囲指定 完了。 別の日を押すと最初からやり直し';
      }
      hintEl.className = hintCls;
      hintEl.textContent = hintText;
      // summary
      if (!hasFrom && !hasTo) {
        summaryEl.textContent = '期間未指定 (= 全期間)';
      } else {
        var fStr = hasFrom ? fmtYmd(working.from) : '(未選択)';
        var tStr = hasTo ? fmtYmd(working.to) : '(未選択)';
        var days = (hasFrom && hasTo)
          ? Math.round((startOfDay(new Date(working.to)).getTime() - startOfDay(new Date(working.from)).getTime()) / 86400000) + 1
          : 0;
        summaryEl.textContent = fStr + ' – ' + tStr + (days > 0 ? ' (' + days + ' 日間)' : '');
      }
      renderCalendar();
    }
    render();

    // ───── footer ─────
    var footer = buildFooter('適用', function () {
      if (working.from || working.to) {
        // form state の to は exclusive (= +1ms で当日末を超えさせる)。 本体と同じ仕様。
        state.form.period = {
          from: working.from || null,
          to: working.to ? working.to + 1 : null,
          label: formatPeriodLabel(working.from, working.to ? working.to + 1 : null)
        };
      } else {
        state.form.period = null;
      }
      syncFormFromState();
      sheet.close();
    }, function () {
      state.form.period = null;
      syncFormFromState();
      sheet.close();
    });

    var sheet = window.KomehubBottomSheet.open({
      title: '期間を選択',
      content: content,
      footer: footer
    });
  }

  // ═══════════════ ユーザー picker ボトムシート ═══════════════
  function openListenerSheet() {
    var content = document.createElement('div');
    content.className = 'rh-cs-picker';

    // 作業中の選択 (= 確定時に form state に反映)
    var working = {};
    state.form.listeners.forEach(function (l) { working[l.channelId] = l; });

    var tagFilter = '';
    var systemFilter = '';
    var queryStr = '';
    // server から返ってきた最後の page (= 1000 件まで)
    var fetchedRows = [];
    var fetchedTotal = 0;
    var fetching = false;
    var fetchSeq = 0;  // race 防止: 古い fetch が遅れて到着しても破棄

    content.innerHTML =
      '<div class="rh-cs-picker-search-wrap">' +
        '<input type="text" class="rh-cs-picker-search" placeholder="リスナー名で検索">' +
      '</div>' +
      '<div class="rh-cs-picker-tag-group">' +
        '<div class="rh-cs-picker-tag-label">ランク</div>' +
        '<div class="rh-cs-picker-tag-strip rank-strip"></div>' +
      '</div>' +
      '<div class="rh-cs-picker-tag-group">' +
        '<div class="rh-cs-picker-tag-label">ユーザータグ</div>' +
        '<div class="rh-cs-picker-tag-strip user-strip"></div>' +
      '</div>' +
      '<div class="rh-cs-picker-summary"></div>' +
      '<div class="rh-empty rh-cs-picker-loading">リスナーを読み込み中…</div>' +
      '<div class="rh-cs-picker-list"></div>';

    var searchInput = content.querySelector('.rh-cs-picker-search');
    var rankStrip = content.querySelector('.rank-strip');
    var userStrip = content.querySelector('.user-strip');
    var listEl = content.querySelector('.rh-cs-picker-list');
    var summaryEl = content.querySelector('.rh-cs-picker-summary');
    var loadingMsg = content.querySelector('.rh-cs-picker-loading');

    // rank chips
    [
      { key: '', label: 'すべて' },
      { key: 'first-time', label: '新規' },
      { key: 'returning', label: '再訪' },
      { key: 'regular', label: '常連' },
      { key: 'veteran', label: '古参' },
      { key: 'comeback', label: '復帰' },
      { key: 'abandoned', label: '離脱' }
    ].forEach(function (def) {
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'rh-cs-picker-chip' + (def.key === systemFilter ? ' active' : '');
      c.textContent = def.label;
      c.addEventListener('click', function () {
        systemFilter = def.key;
        renderRankActive();
        fetchListeners();
      });
      rankStrip.appendChild(c);
    });

    function renderRankActive() {
      var btns = rankStrip.querySelectorAll('button');
      var defs = ['', 'first-time', 'returning', 'regular', 'veteran', 'comeback', 'abandoned'];
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', defs[i] === systemFilter);
      }
    }

    // user tag chips (= state.allListenerTags が ready の時のみ)
    function renderUserTagStrip() {
      userStrip.replaceChildren();
      var tags = (state.allListenerTags && state.allListenerTags.items) || [];
      if (!tags.length) {
        var hint = document.createElement('span');
        hint.className = 'rh-cs-picker-empty-hint';
        hint.textContent = 'ユーザータグなし';
        userStrip.appendChild(hint);
        return;
      }
      var allChip = document.createElement('button');
      allChip.type = 'button';
      allChip.className = 'rh-cs-picker-chip' + (tagFilter === '' ? ' active' : '');
      allChip.textContent = 'すべて';
      allChip.addEventListener('click', function () {
        tagFilter = '';
        renderUserTagStrip();
        renderList();  // user_tag は client filter のみ (= ListenersQuery が未対応)
      });
      userStrip.appendChild(allChip);
      tags.forEach(function (t) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'rh-cs-picker-chip' + (tagFilter === t.tag ? ' active' : '');
        c.textContent = '#' + t.tag + ' (' + t.listenerCount + ')';
        c.addEventListener('click', function () {
          tagFilter = t.tag;
          renderUserTagStrip();
          renderList();
        });
        userStrip.appendChild(c);
      });
    }
    renderUserTagStrip();

    // search (= server-side 部分一致)
    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        queryStr = searchInput.value.trim();
        fetchListeners();
      }, 300);
    });

    // ───── server fetch (= q + systemTags + baseline で絞り込み済の結果) ─────
    // user_tag は ListenersQuery 未対応のため、 fetch 後に client filter する。
    function fetchListeners() {
      fetching = true;
      fetchSeq += 1;
      var seq = fetchSeq;
      loadingMsg.style.display = '';
      var qs = new URLSearchParams();
      qs.set('limit', '1000');
      qs.set('sort', 'lastSeen');
      if (queryStr) qs.set('q', queryStr);
      if (systemFilter) qs.append('systemTags', systemFilter);
      if (state.baselineVideoId) qs.set('baselineStreamVideoId', state.baselineVideoId);
      R.fetchJson('/api/listeners?' + qs.toString()).then(function (resp) {
        if (seq !== fetchSeq) return;  // 古い fetch を捨てる
        fetching = false;
        if (resp && resp.ok && resp.page) {
          fetchedRows = resp.page.rows || [];
          fetchedTotal = resp.page.total || 0;
        } else {
          fetchedRows = [];
          fetchedTotal = 0;
        }
        loadingMsg.style.display = 'none';
        renderList();
      }).catch(function () {
        if (seq !== fetchSeq) return;
        fetching = false;
        loadingMsg.textContent = 'リスナー取得に失敗しました';
      });
    }
    fetchListeners();  // 初回

    function renderList() {
      listEl.replaceChildren();
      // user_tag は client filter (= server 未対応)
      var byChannelId = (state.allListenerTags && state.allListenerTags.byChannelId) || {};
      var filtered = fetchedRows.filter(function (l) {
        if (tagFilter) {
          var ut = byChannelId[l.channelId] || [];
          if (ut.indexOf(tagFilter) < 0) return false;
        }
        return true;
      });
      // bulk-row (= タグ filter / 未選択全選択)
      if (filtered.length > 0) {
        var bulk = document.createElement('div');
        bulk.className = 'rh-cs-picker-bulk';
        var info = document.createElement('span');
        // server total が limit (1000) を超えていれば 「+N 件」 を併記して切られている事を明示
        var label = '一致 ' + filtered.length + ' 人';
        if (!tagFilter && fetchedTotal > fetchedRows.length) {
          label += ' (全 ' + fetchedTotal + ' 人中、 検索で絞り込んでください)';
        }
        info.textContent = label;
        var selBtn = document.createElement('button');
        selBtn.type = 'button';
        selBtn.textContent = '一致を全選択';
        selBtn.addEventListener('click', function () {
          filtered.forEach(function (l) {
            working[l.channelId] = { channelId: l.channelId, displayName: l.nickname || l.displayName || l.channelId };
          });
          renderList();
          updateSummary();
        });
        var deselBtn = document.createElement('button');
        deselBtn.type = 'button';
        deselBtn.textContent = '一致を全解除';
        deselBtn.addEventListener('click', function () {
          filtered.forEach(function (l) { delete working[l.channelId]; });
          renderList();
          updateSummary();
        });
        bulk.appendChild(info);
        bulk.appendChild(selBtn);
        bulk.appendChild(deselBtn);
        listEl.appendChild(bulk);
      } else if (fetchedRows.length > 0) {
        // user_tag filter で 0 件になった場合の通知 (= server には rows あるが client filter で消える)
        var hint = document.createElement('div');
        hint.className = 'rh-empty';
        hint.textContent = 'タグ条件で 0 件 (' + fetchedRows.length + ' 人中)';
        listEl.appendChild(hint);
      } else {
        var hint2 = document.createElement('div');
        hint2.className = 'rh-empty';
        hint2.textContent = '該当するリスナーがいません';
        listEl.appendChild(hint2);
      }

      // server 側で limit 1000 を強制済 (fetchListeners)。 client 側ではこれ以上の
      // truncate は不要 (= 1000 件全て描画)。
      filtered.forEach(function (l) {
        var row = document.createElement('label');
        row.className = 'rh-cs-picker-row';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!working[l.channelId];
        cb.addEventListener('change', function () {
          if (cb.checked) {
            working[l.channelId] = { channelId: l.channelId, displayName: l.nickname || l.displayName || l.channelId };
          } else {
            delete working[l.channelId];
          }
          updateSummary();
        });
        var av = document.createElement('div');
        av.className = 'rh-cs-picker-row-avatar';
        if (l.iconUrl) {
          var u = R.normalizeAssetUrl ? R.normalizeAssetUrl(l.iconUrl) : l.iconUrl;
          av.style.backgroundImage = 'url(\'' + String(u).replace(/'/g, '%27') + '\')';
        } else {
          av.textContent = (l.displayName || '?').charAt(0);
        }
        var name = document.createElement('span');
        name.className = 'rh-cs-picker-row-name';
        name.textContent = l.nickname || l.displayName || l.channelId;
        row.appendChild(cb);
        row.appendChild(av);
        row.appendChild(name);
        listEl.appendChild(row);
      });
      updateSummary();
    }

    function updateSummary() {
      summaryEl.textContent = '選択 ' + Object.keys(working).length + ' 人';
    }

    var footer = buildFooter('適用', function () {
      state.form.listeners = Object.keys(working).map(function (k) { return working[k]; });
      syncFormFromState();
      sheet.close();
    }, function () {
      working = {};
      state.form.listeners = [];
      syncFormFromState();
      sheet.close();
    });

    var sheet = window.KomehubBottomSheet.open({
      title: 'リスナーを選択',
      content: content,
      footer: footer
    });
  }

  // ═══════════════ 配信枠 picker ボトムシート ═══════════════
  function openStreamSheet() {
    var content = document.createElement('div');
    content.className = 'rh-cs-picker';

    var working = {};
    state.form.streams.forEach(function (s) { working[s.videoId] = s; });
    var tagFilter = '';
    var queryStr = '';

    content.innerHTML =
      '<div class="rh-cs-picker-search-wrap">' +
        '<input type="text" class="rh-cs-picker-search" placeholder="タイトル / 日付で検索">' +
      '</div>' +
      '<div class="rh-cs-picker-tag-group">' +
        '<div class="rh-cs-picker-tag-label">タグ</div>' +
        '<div class="rh-cs-picker-tag-strip stream-tag-strip"></div>' +
      '</div>' +
      '<div class="rh-cs-picker-summary"></div>' +
      '<div class="rh-empty rh-cs-picker-loading">配信枠を読み込み中…</div>' +
      '<div class="rh-cs-picker-list"></div>';

    var searchInput = content.querySelector('.rh-cs-picker-search');
    var tagStrip = content.querySelector('.stream-tag-strip');
    var listEl = content.querySelector('.rh-cs-picker-list');
    var summaryEl = content.querySelector('.rh-cs-picker-summary');
    var loadingMsg = content.querySelector('.rh-cs-picker-loading');

    var allStreams = [];

    function renderTagStrip() {
      tagStrip.replaceChildren();
      var tags = (state.allStreamTags && state.allStreamTags.items) || [];
      var allChip = document.createElement('button');
      allChip.type = 'button';
      allChip.className = 'rh-cs-picker-chip' + (tagFilter === '' ? ' active' : '');
      allChip.textContent = 'すべて';
      allChip.addEventListener('click', function () { tagFilter = ''; renderTagStrip(); renderList(); });
      tagStrip.appendChild(allChip);
      if (!tags.length) {
        var hint = document.createElement('span');
        hint.className = 'rh-cs-picker-empty-hint';
        hint.textContent = 'タグなし';
        tagStrip.appendChild(hint);
        return;
      }
      tags.forEach(function (t) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'rh-cs-picker-chip' + (tagFilter === t.tag ? ' active' : '');
        c.textContent = '#' + t.tag + ' (' + t.streamCount + ')';
        c.addEventListener('click', function () { tagFilter = t.tag; renderTagStrip(); renderList(); });
        tagStrip.appendChild(c);
      });
    }
    renderTagStrip();

    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        queryStr = searchInput.value.trim();
        renderList();
      }, 200);
    });

    // fetch all streams (= sort by date desc, limit 500)
    var qs = new URLSearchParams();
    qs.set('sort', 'startedAt');
    qs.set('limit', '500');
    R.fetchJson('/api/listeners/streams?' + qs.toString()).then(function (resp) {
      if (resp && resp.ok && resp.page && resp.page.rows) {
        allStreams = resp.page.rows;
      }
      loadingMsg.style.display = 'none';
      renderList();
    }).catch(function () {
      loadingMsg.textContent = '配信枠取得に失敗しました';
    });

    function renderList() {
      listEl.replaceChildren();
      var q = queryStr.toLowerCase();
      // タグ assignment cache (= state.allStreamTags.assignments) があれば使う、 なければ無視
      var assignByVid = (state.allStreamTags && state.allStreamTags.byVideoId) || {};
      var filtered = allStreams.filter(function (s) {
        if (tagFilter) {
          var t = assignByVid[s.videoId] || [];
          if (t.indexOf(tagFilter) < 0) return false;
        }
        if (q) {
          var title = (s.title || '').toLowerCase();
          if (title.indexOf(q) < 0) return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        var bulk = document.createElement('div');
        bulk.className = 'rh-cs-picker-bulk';
        bulk.innerHTML = '<span>一致 ' + filtered.length + ' 枠</span>';
        var selBtn = document.createElement('button');
        selBtn.type = 'button';
        selBtn.textContent = '一致を全選択';
        selBtn.addEventListener('click', function () {
          filtered.forEach(function (s) {
            working[s.videoId] = { videoId: s.videoId, title: s.title, startedAt: s.startedAt };
          });
          renderList();
        });
        var deselBtn = document.createElement('button');
        deselBtn.type = 'button';
        deselBtn.textContent = '一致を全解除';
        deselBtn.addEventListener('click', function () {
          filtered.forEach(function (s) { delete working[s.videoId]; });
          renderList();
        });
        bulk.appendChild(selBtn);
        bulk.appendChild(deselBtn);
        listEl.appendChild(bulk);
      }

      filtered.slice(0, 500).forEach(function (s) {
        var row = document.createElement('label');
        // -stream 修飾: avatar の代わりに 16:9 サムネ列を使う 3 カラム grid
        row.className = 'rh-cs-picker-row rh-cs-picker-row-stream';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!working[s.videoId];
        cb.addEventListener('change', function () {
          if (cb.checked) {
            working[s.videoId] = { videoId: s.videoId, title: s.title, startedAt: s.startedAt };
          } else {
            delete working[s.videoId];
          }
          updateSummary();
        });
        // サムネ (= /cache/stream-thumbs/{video_id}.jpg、 取得失敗時は素 background)
        var thumb = document.createElement('div');
        thumb.className = 'rh-cs-picker-row-thumb';
        var thumbUrl = '/cache/stream-thumbs/' + encodeURIComponent(s.videoId) + '.jpg';
        thumb.style.backgroundImage = "url('" + thumbUrl.replace(/'/g, '%27') + "')";
        var meta = document.createElement('span');
        meta.className = 'rh-cs-picker-row-name';
        meta.innerHTML = '<span class="rh-cs-picker-row-title">' + escapeHtml(s.title || s.videoId) + '</span>' +
          '<span class="rh-cs-picker-row-sub">' + formatYmdShort(s.startedAt) + '</span>';
        row.appendChild(cb);
        row.appendChild(thumb);
        row.appendChild(meta);
        listEl.appendChild(row);
      });
      updateSummary();
    }

    function updateSummary() {
      summaryEl.textContent = '選択 ' + Object.keys(working).length + ' 枠';
    }

    var footer = buildFooter('適用', function () {
      state.form.streams = Object.keys(working).map(function (k) { return working[k]; });
      syncFormFromState();
      sheet.close();
    }, function () {
      working = {};
      state.form.streams = [];
      syncFormFromState();
      sheet.close();
    });

    var sheet = window.KomehubBottomSheet.open({
      title: '配信枠を選択',
      content: content,
      footer: footer
    });
  }

  // ───── タグリスト一括 fetch ─────
  function loadListenerTagsList() {
    R.fetchJson('/api/listener-tags').then(function (resp) {
      if (resp && resp.ok) {
        state.allListenerTags = { items: resp.tags || [] };
      }
    }).catch(function (err) { archCommLog.debug("promise rejected (catch swallow):", err); });
    // 並行で assignment も取得 (= リスナーが持つタグ判定用)
    R.fetchJson('/api/listener-tag-assignments').then(function (resp) {
      if (resp && resp.ok) {
        var byCh = {};
        (resp.assignments || []).forEach(function (a) {
          if (!byCh[a.channelId]) byCh[a.channelId] = [];
          byCh[a.channelId].push(a.tag);
        });
        if (!state.allListenerTags) state.allListenerTags = { items: [] };
        state.allListenerTags.byChannelId = byCh;
      }
    }).catch(function (err) { archCommLog.debug("promise rejected (catch swallow):", err); });
  }
  function loadStreamTagsList() {
    R.fetchJson('/api/stream-tags').then(function (resp) {
      if (resp && resp.ok) {
        if (!state.allStreamTags) state.allStreamTags = {};
        state.allStreamTags.items = resp.tags || [];
      }
    }).catch(function (err) { archCommLog.debug("promise rejected (catch swallow):", err); });
    R.fetchJson('/api/stream-tag-assignments').then(function (resp) {
      if (resp && resp.ok) {
        var byVid = {};
        (resp.assignments || []).forEach(function (a) {
          if (!byVid[a.videoId]) byVid[a.videoId] = [];
          byVid[a.videoId].push(a.tag);
        });
        if (!state.allStreamTags) state.allStreamTags = { items: [] };
        state.allStreamTags.byVideoId = byVid;
      }
    }).catch(function (err) { archCommLog.debug("promise rejected (catch swallow):", err); });
  }

  // ───── footer 共通 ─────
  function buildFooter(applyLabel, onApply, onClear) {
    var footer = document.createElement('div');
    footer.className = 'rh-cs-sheet-footer';
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'rh-cs-sheet-clear';
    clearBtn.textContent = 'クリア';
    clearBtn.addEventListener('click', onClear);
    var applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'rh-cs-sheet-apply';
    applyBtn.textContent = applyLabel;
    applyBtn.addEventListener('click', onApply);
    footer.appendChild(clearBtn);
    footer.appendChild(applyBtn);
    return footer;
  }

  // ───── format ─────
  function formatYmdShort(unixMs) {
    if (!unixMs) return '';
    var d = new Date(Number(unixMs));
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function formatPeriodLabel(from, to) {
    if (!from && !to) return '全期間';
    var s = from ? formatYmdShort(from) : '';
    var e = to ? formatYmdShort(to - 1) : '';
    return s + ' 〜 ' + e;
  }
  function toIsoDate(ms) {
    var d = new Date(Number(ms));
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.KomehubArchiveSubviews['archive-comment-search'] = { init: init };
})();
