// === remote view: archive > listener-search ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.7 (Phase D)
//
// リスナー検索フル機能スマホ版:
//   - 名前検索 input (= display_name / nickname / username 横断)
//   - sort select
//   - システムランク chip (= 排他選択、 first-time / returning / regular / veteran / comeback / abandoned)
//   - ユーザータグ chip (= 排他選択、 listener_tags 経由)
//   - 保存検索ストリップ (= scope='listener-search'、 読み取り + 作成 + 削除)
//   - 結果リスト (= ランクバッジ + 累計 KPI + 最終コメ)
//   - ページング (= prev/next)
//
// state は module-level (= タブ切替で消えない)。

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var archListLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('ArchiveListenerSearch')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var R = window.KomehubRemote;
  if (!window.KomehubArchiveSubviews) window.KomehubArchiveSubviews = {};

  var SAVED_SCOPE = 'listener-search';

  // module-level state
  var state = {
    form: {
      nameQ: '',
      sort: 'lastSeen',
      systemTag: '',
      userTag: ''
    },
    result: { rows: [], total: 0, status: 'idle', limit: 50, offset: 0 },
    saved: { items: [], status: 'idle' },
    baselineVideoId: '',
    initialized: false,
    scrollTop: 0
  };

  var dom = null;
  var destroyed = false;

  function init(container, shell, query) {
    destroyed = false;
    var wrap = document.createElement('div');
    wrap.className = 'rh-arch-ls';
    container.appendChild(wrap);

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

    return {
      destroy: function () {
        destroyed = true;
        if (dom && dom.resultWrap) state.scrollTop = dom.resultWrap.scrollTop || 0;
        dom = null;
      }
    };
  }

  // 接続中 → currentStreamVideoId、 切断中 → 自チャンネル最新枠
  function resolveBaseline() {
    R.fetchJson('/api/status').then(function (s) {
      if (s && s.connected && s.videoId) {
        state.baselineVideoId = s.videoId;
      } else {
        // owner_channel 配下の最新枠を取得
        return R.fetchJson('/api/listeners/streams?sort=startedAt&scope=own&limit=1').then(function (resp) {
          if (resp && resp.ok && resp.page && resp.page.rows && resp.page.rows.length) {
            state.baselineVideoId = resp.page.rows[0].videoId;
          }
        });
      }
    }).catch(function (err) { archListLog.debug("promise rejected (catch swallow):", err); });
  }

  // ───── 保存検索ストリップ ─────
  function buildSavedStrip(parent) {
    var strip = document.createElement('div');
    strip.className = 'rh-cs-saved-strip';
    strip.innerHTML =
      '<div class="rh-cs-saved-pins" id="rh-ls-saved-pins"></div>' +
      '<button type="button" class="rh-cs-saved-add" id="rh-ls-save-current">＋ 保存</button>';
    parent.appendChild(strip);
    if (!dom) dom = {};
    dom.savedPins = strip.querySelector('#rh-ls-saved-pins');
    dom.saveBtn = strip.querySelector('#rh-ls-save-current');
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
          try { cond = JSON.parse(it.conditions || '{}'); } catch (err) { archListLog.debug('conditions JSON parse failed:', err); }
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
      if (!res.ok) { alert('削除に失敗しました'); return; }
      loadSavedSearches();
    }).catch(function (err) {
      alert('削除に失敗しました: ' + (err && err.message ? err.message : err));
    });
  }

  // ───── form ─────
  function buildForm(parent) {
    var form = document.createElement('div');
    form.className = 'rh-cs-form rh-ls-form';
    form.innerHTML =
      '<label class="rh-cs-field">' +
        '<span class="rh-cs-label">リスナー名</span>' +
        '<input type="text" id="rh-ls-name-q" placeholder="display_name / nickname / username">' +
      '</label>' +
      '<label class="rh-cs-field">' +
        '<span class="rh-cs-label">並び替え</span>' +
        '<select id="rh-ls-sort">' +
          '<option value="lastSeen">最終コメ降順</option>' +
          '<option value="commentCount">コメ数降順</option>' +
          '<option value="superchatAmount">SC 累計降順</option>' +
          '<option value="displayName">表示名昇順</option>' +
        '</select>' +
      '</label>' +
      '<div class="rh-cs-field">' +
        '<span class="rh-cs-label">ランク</span>' +
        '<div class="rh-cs-picker-tag-strip" id="rh-ls-rank-strip"></div>' +
      '</div>' +
      '<div class="rh-cs-field">' +
        '<span class="rh-cs-label">ユーザータグ</span>' +
        '<div class="rh-cs-picker-tag-strip" id="rh-ls-user-strip"></div>' +
      '</div>' +
      '<div class="rh-cs-form-actions">' +
        '<button type="button" class="rh-cs-clear-btn" id="rh-ls-clear">クリア</button>' +
        '<button type="button" class="rh-cs-run-btn" id="rh-ls-run">検索</button>' +
      '</div>';
    parent.appendChild(form);

    dom.form = form;
    dom.nameQ = form.querySelector('#rh-ls-name-q');
    dom.sort = form.querySelector('#rh-ls-sort');
    dom.rankStrip = form.querySelector('#rh-ls-rank-strip');
    dom.userStrip = form.querySelector('#rh-ls-user-strip');

    syncFormFromState();

    dom.nameQ.addEventListener('input', function () { state.form.nameQ = dom.nameQ.value; });
    dom.sort.addEventListener('change', function () { state.form.sort = dom.sort.value; });

    form.querySelector('#rh-ls-run').addEventListener('click', function () {
      state.result.offset = 0;
      runSearch();
    });
    form.querySelector('#rh-ls-clear').addEventListener('click', function () {
      state.form = { nameQ: '', sort: 'lastSeen', systemTag: '', userTag: '' };
      syncFormFromState();
    });

    // ランク chip
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
      c.className = 'rh-cs-picker-chip' + (state.form.systemTag === def.key ? ' active' : '');
      c.textContent = def.label;
      c.dataset.tagKey = def.key;
      c.addEventListener('click', function () {
        state.form.systemTag = def.key;
        updateChipActive(dom.rankStrip, def.key);
      });
      dom.rankStrip.appendChild(c);
    });

    // ユーザータグ chip (= 動的 fetch)
    R.fetchJson('/api/listener-tags').then(function (resp) {
      if (destroyed) return;
      var tags = (resp && resp.ok && resp.tags) || [];
      var allChip = document.createElement('button');
      allChip.type = 'button';
      allChip.className = 'rh-cs-picker-chip' + (state.form.userTag === '' ? ' active' : '');
      allChip.textContent = 'すべて';
      allChip.dataset.tagKey = '';
      allChip.addEventListener('click', function () {
        state.form.userTag = '';
        updateChipActive(dom.userStrip, '');
      });
      dom.userStrip.appendChild(allChip);
      if (!tags.length) {
        var hint = document.createElement('span');
        hint.className = 'rh-cs-picker-empty-hint';
        hint.textContent = 'タグなし';
        dom.userStrip.appendChild(hint);
        return;
      }
      tags.forEach(function (t) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'rh-cs-picker-chip' + (state.form.userTag === t.tag ? ' active' : '');
        c.textContent = '#' + t.tag + ' (' + t.listenerCount + ')';
        c.dataset.tagKey = t.tag;
        c.addEventListener('click', function () {
          state.form.userTag = t.tag;
          updateChipActive(dom.userStrip, t.tag);
        });
        dom.userStrip.appendChild(c);
      });
    }).catch(function (err) { archListLog.debug("promise rejected (catch swallow):", err); });
  }

  function updateChipActive(strip, key) {
    var btns = strip.querySelectorAll('button.rh-cs-picker-chip');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', (btns[i].dataset.tagKey || '') === key);
    }
  }

  function syncFormFromState() {
    if (!dom) return;
    dom.nameQ.value = state.form.nameQ || '';
    dom.sort.value = state.form.sort || 'lastSeen';
    if (dom.rankStrip) updateChipActive(dom.rankStrip, state.form.systemTag || '');
    if (dom.userStrip) updateChipActive(dom.userStrip, state.form.userTag || '');
  }

  function formStateToConditions() {
    return {
      nameQ: state.form.nameQ || '',
      sort: state.form.sort || 'lastSeen',
      systemTag: state.form.systemTag || '',
      userTag: state.form.userTag || ''
    };
  }

  function loadConditionsIntoForm(cond) {
    if (!cond) return;
    state.form.nameQ = cond.nameQ || '';
    state.form.sort = cond.sort || 'lastSeen';
    state.form.systemTag = cond.systemTag || '';
    state.form.userTag = cond.userTag || '';
    syncFormFromState();
  }

  // ───── 結果 ─────
  function buildResultArea(parent) {
    var area = document.createElement('div');
    area.className = 'rh-cs-result-area';
    area.innerHTML =
      '<div class="rh-cs-result-summary" id="rh-ls-summary"></div>' +
      '<div id="rh-ls-result-wrap">' +
        '<div id="rh-ls-result-list"></div>' +
        '<div id="rh-ls-result-empty" class="rh-empty" style="display:none">条件を入力して 「検索」 を押してください</div>' +
      '</div>' +
      '<div class="rh-arch-pagination" id="rh-ls-pag" style="display:none">' +
        '<button type="button" id="rh-ls-prev">‹ 前</button>' +
        '<span id="rh-ls-page-label"></span>' +
        '<button type="button" id="rh-ls-next">次 ›</button>' +
      '</div>';
    parent.appendChild(area);
    dom.summary = area.querySelector('#rh-ls-summary');
    dom.resultWrap = area.querySelector('#rh-ls-result-wrap');
    dom.resultList = area.querySelector('#rh-ls-result-list');
    dom.resultEmpty = area.querySelector('#rh-ls-result-empty');
    dom.pag = area.querySelector('#rh-ls-pag');
    dom.prev = area.querySelector('#rh-ls-prev');
    dom.next = area.querySelector('#rh-ls-next');
    dom.pageLabel = area.querySelector('#rh-ls-page-label');
    dom.prev.addEventListener('click', function () {
      if (state.result.offset <= 0) return;
      state.result.offset = Math.max(0, state.result.offset - state.result.limit);
      runSearch();
    });
    dom.next.addEventListener('click', function () {
      if (state.result.offset + state.result.limit >= state.result.total) return;
      state.result.offset += state.result.limit;
      runSearch();
    });
  }

  function runSearch() {
    state.result.status = 'loading';
    renderResult();
    var qs = new URLSearchParams();
    if (state.form.nameQ) qs.set('q', state.form.nameQ);
    qs.set('sort', state.form.sort);
    qs.set('limit', String(state.result.limit));
    qs.set('offset', String(state.result.offset));
    if (state.form.systemTag) qs.set('systemTags', state.form.systemTag);
    if (state.form.userTag) qs.append('userTags', state.form.userTag);
    if (state.baselineVideoId) qs.set('baselineStreamVideoId', state.baselineVideoId);
    R.fetchJson('/api/listeners?' + qs.toString()).then(function (resp) {
      if (destroyed) return;
      if (!resp || !resp.ok || !resp.page) {
        state.result.status = 'error';
        state.result.rows = [];
        state.result.total = 0;
      } else {
        state.result.rows = resp.page.rows || [];
        state.result.total = resp.page.total || 0;
        state.result.status = 'ready';
      }
      renderResult();
    }).catch(function () {
      if (destroyed) return;
      state.result.status = 'error';
      renderResult();
    });
  }

  function renderResult() {
    if (!dom || !dom.resultList) return;
    if (state.result.status === 'idle') {
      dom.summary.textContent = '';
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = '';
      dom.resultEmpty.textContent = '条件を入力して 「検索」 を押してください';
      dom.pag.style.display = 'none';
      return;
    }
    if (state.result.status === 'loading') {
      dom.summary.textContent = '検索中…';
      return;
    }
    if (state.result.status === 'error') {
      dom.summary.textContent = '';
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = '';
      dom.resultEmpty.textContent = '検索に失敗しました';
      dom.pag.style.display = 'none';
      return;
    }
    var rows = state.result.rows || [];
    dom.summary.textContent = '全 ' + state.result.total + ' 人 (表示 ' + rows.length + ')';
    if (!rows.length) {
      dom.resultList.replaceChildren();
      dom.resultEmpty.style.display = '';
      dom.resultEmpty.textContent = '該当するリスナーがいません';
      dom.pag.style.display = 'none';
      return;
    }
    dom.resultEmpty.style.display = 'none';

    var frag = document.createDocumentFragment();
    rows.forEach(function (l) {
      frag.appendChild(buildListenerCell(l));
    });
    dom.resultList.replaceChildren(frag);

    // pagination
    if (state.result.total > state.result.limit) {
      dom.pag.style.display = '';
      var page = Math.floor(state.result.offset / state.result.limit) + 1;
      var totalPage = Math.ceil(state.result.total / state.result.limit);
      dom.pageLabel.textContent = page + ' / ' + totalPage;
      dom.prev.disabled = state.result.offset <= 0;
      dom.next.disabled = state.result.offset + state.result.limit >= state.result.total;
    } else {
      dom.pag.style.display = 'none';
    }
  }

  function buildListenerCell(l) {
    var a = document.createElement('a');
    a.className = 'rh-ls-result-cell';
    a.href = R.toListenerDetailUrl(l.channelId);
    // avatar
    var av = document.createElement('div');
    av.className = 'rh-ls-avatar';
    if (l.iconUrl) {
      var u = R.normalizeAssetUrl ? R.normalizeAssetUrl(l.iconUrl) : l.iconUrl;
      av.style.backgroundImage = 'url(\'' + String(u).replace(/'/g, '%27') + '\')';
    } else {
      av.textContent = (l.displayName || '?').charAt(0);
    }
    a.appendChild(av);
    // meta
    var meta = document.createElement('div');
    meta.className = 'rh-ls-meta';
    var name = document.createElement('div');
    name.className = 'rh-ls-name';
    name.textContent = l.nickname || l.displayName || l.channelId;
    meta.appendChild(name);
    if (l.username) {
      var sub = document.createElement('div');
      sub.className = 'rh-ls-sub';
      sub.textContent = l.username;
      meta.appendChild(sub);
    }
    var stats = document.createElement('div');
    stats.className = 'rh-ls-stats';
    var parts = [];
    parts.push('コメ ' + (l.commentCount || 0));
    if (l.superchatAmountJpy > 0) parts.push('SC ¥' + Number(l.superchatAmountJpy).toLocaleString('ja-JP'));
    if (l.lastSeenAt) parts.push('最終 ' + R.formatRelativeTime(l.lastSeenAt));
    stats.textContent = parts.join(' · ');
    meta.appendChild(stats);
    a.appendChild(meta);
    // rank badge
    if (l.systemTag) {
      var b = document.createElement('span');
      b.className = 'rh-sd-listener-rank rank-' + l.systemTag;
      b.textContent = rankLabel(l.systemTag);
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

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.KomehubArchiveSubviews['archive-listener-search'] = { init: init };
})();
