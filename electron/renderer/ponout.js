(function () {
  'use strict';

  var api = window.api;
  // renderer.log に出力するロガー (= 詳細: docs/logging.md)
  var ponoutLog = (api && api.log && api.log.create)
    ? api.log.create('Ponout')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var device = document.getElementById('device');
  var sceneTabsEl = document.getElementById('sceneTabs');
  var sceneTabsWrap = document.getElementById('sceneTabsWrap');
  var pad = document.getElementById('pad');
  var pageBar = document.getElementById('pageBar');
  var editToggle = document.getElementById('editToggle');
  var pool = document.getElementById('pool');
  var poolList = document.getElementById('poolList');
  var recentEl = document.getElementById('recent');
  var connEl = document.getElementById('conn');
  var connDot = document.getElementById('connDot');
  var connText = document.getElementById('connText');
  var pauseButton = document.getElementById('pauseButton');
  var clearButton = document.getElementById('clearButton');
  var perfDot = document.getElementById('perfDot');
  var perfStatusText = document.getElementById('perfStatusText');
  var ttsDot = document.getElementById('ttsDot');
  var ttsStatusText = document.getElementById('ttsStatusText');
  var ttsToggle = document.getElementById('ttsToggle');
  var ttsPause = document.getElementById('ttsPause');
  var ttsClear = document.getElementById('ttsClear');
  var remoteButton = document.getElementById('remoteButton');
  var fullscreenButton = document.getElementById('fullscreenButton');

  // === 状態 ===
  var corePort = 11280;
  var sceneList = [];        // [{id, name, ...}] 順序付き (sidebar と同じ)
  var scenesMap = {};        // {id: scene}
  var currentSceneId = '';
  var currentPage = 0;
  var editing = false;
  var recentLog = [];        // [{name, at}]
  var coreHost = 'localhost';
  var coreOrigin = '';

  function buildLocalHttpUrl(p) {
    if (coreOrigin) return coreOrigin + p;
    return 'http://' + coreHost + ':' + corePort + p;
  }

  function isImageAsset(name) {
    return /\.(png|jpg|jpeg|gif|apng|svg|webp)$/i.test(name);
  }
  function isVideoAsset(name) {
    return /\.(webm|mp4)$/i.test(name);
  }

  function eligible(perf) {
    return !!perf
      && perf.ponout === true
      && perf.requiresContext !== true
      && perf.enabled !== false;
  }

  function eligiblePerfs(scene) {
    return ((scene && scene.performances) || []).filter(eligible);
  }

  function activeScene() {
    return scenesMap[currentSceneId] || null;
  }

  // === slot view 構築 ===
  // ponoutSlot が number なら explicit 配置、null/undefined は auto-fill。
  // 衝突は先勝ち、はみ出しは auto-fill にフォールバック。
  function buildSlots(scene) {
    var pons = eligiblePerfs(scene);
    var maxSlot = -1;
    pons.forEach(function (p) {
      if (typeof p.ponoutSlot === 'number' && p.ponoutSlot >= 0) {
        if (p.ponoutSlot > maxSlot) maxSlot = p.ponoutSlot;
      }
    });
    var len = Math.max(8, Math.ceil((maxSlot + 1) / 8) * 8);
    var slots = new Array(len);
    for (var i = 0; i < len; i++) slots[i] = null;

    // explicit 配置 (衝突は先勝ち)
    pons.forEach(function (p) {
      if (typeof p.ponoutSlot === 'number' && p.ponoutSlot >= 0 && p.ponoutSlot < slots.length) {
        if (slots[p.ponoutSlot] === null) slots[p.ponoutSlot] = p.id;
      }
    });
    // auto-fill (未配置を空きへ詰める。空きが無ければ +8 ページ)
    // ponoutSlot === null は「明示的に未割当」(pool) なので auto-fill しない。
    // ponoutSlot 未定義 (= 一度も配置を確定していない) のみ auto-fill 対象。
    pons.forEach(function (p) {
      if (slots.indexOf(p.id) !== -1) return;
      if (p.ponoutSlot === null) return;
      var idx = slots.indexOf(null);
      if (idx === -1) {
        for (var k = 0; k < 8; k++) slots.push(null);
        idx = slots.indexOf(null);
      }
      slots[idx] = p.id;
    });
    // 末尾空ページを trim (最低 1 ページ = 8 スロット)
    while (slots.length > 8) {
      var last8 = slots.slice(-8);
      var allNull = true;
      for (var j = 0; j < last8.length; j++) {
        if (last8[j] !== null) { allNull = false; break; }
      }
      if (allNull) slots = slots.slice(0, -8);
      else break;
    }
    return slots;
  }

  function pageCount(slots) {
    return Math.max(1, Math.ceil(slots.length / 8));
  }

  function getPerf(scene, perfId) {
    return ((scene && scene.performances) || []).find(function (p) { return p.id === perfId; });
  }

  // === UI 描画 ===

  function renderSceneTabs() {
    sceneTabsEl.innerHTML = '';
    sceneList.forEach(function (entry) {
      var s = scenesMap[entry.id] || entry;
      var assigned = eligiblePerfs(s).length;
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'scene-tab' + (entry.id === currentSceneId ? ' active' : '');
      tab.title = entry.name + ' に切り替え (' + assigned + ' 件)';
      tab.innerHTML =
        '<span class="live"></span>' +
        '<span></span>' +
        '<span class="count"></span>';
      tab.children[1].textContent = entry.name;
      tab.children[2].textContent = String(assigned);
      tab.addEventListener('click', function () {
        if (entry.id === currentSceneId) return;
        ponoutLog.info('user: ponout-scene-switch, sceneId=' + entry.id);
        api.setSelectedScene(entry.id);
        // broadcast 駆動。scenes-changed で再描画される。
        // active タブ視認のため即時に view 側もズラしておく。
        currentSceneId = entry.id;
        currentPage = 0;
        renderAll();
        try { tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch (err) { ponoutLog.debug('scrollIntoView failed (tab detached?):', err); }
      });
      sceneTabsEl.appendChild(tab);
    });
  }

  function updateTabsOverflow() {
    var overflow = sceneTabsEl.scrollWidth > sceneTabsEl.clientWidth + 1;
    sceneTabsWrap.classList.toggle('overflow', overflow);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function formatRecentTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function renderRecent() {
    // V2 で直近バーは廃止 (HTML から #recent を削除)。recentLog 自体は残しているので、
    // 将来 1 行 ticker を再導入したくなったら #recent を復活するだけで良い。
    if (!recentEl) return;
    recentEl.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = '直近:';
    recentEl.appendChild(label);
    if (recentLog.length === 0) {
      var none = document.createElement('span');
      none.className = 'none';
      none.textContent = 'まだ発火していません';
      recentEl.appendChild(none);
      return;
    }
    recentLog.slice(0, 3).forEach(function (rec) {
      var el = document.createElement('span');
      el.className = 'item';
      var timeText = formatRecentTime(rec.at);
      if (timeText) {
        var time = document.createElement('span');
        time.className = 'time';
        time.textContent = timeText;
        el.appendChild(time);
        el.appendChild(document.createTextNode(' ' + rec.name));
      } else {
        el.textContent = rec.name;
      }
      recentEl.appendChild(el);
    });
  }

  function buildKeyContent(scene, perf) {
    var firstAsset = perf.assets && perf.assets[0];
    var assetStr = '';
    if (firstAsset) {
      // assets 要素は文字列の場合と {file: '...'} の場合がある (extra)
      if (typeof firstAsset === 'string') assetStr = firstAsset;
      else if (firstAsset && typeof firstAsset.file === 'string') assetStr = firstAsset.file;
    }
    var iconHtml;
    if (assetStr && isImageAsset(assetStr)) {
      var src = buildLocalHttpUrl('/effects/' + scene.id + '/assets/' + assetStr);
      iconHtml = '<img src="' + src.replace(/"/g, '&quot;') + '" alt="">';
    } else if (assetStr && isVideoAsset(assetStr)) {
      iconHtml = '🎬';
    } else if (assetStr) {
      iconHtml = escapeHtml(assetStr);
    } else {
      iconHtml = '🎉';
    }
    return '<div class="led"></div>'
      + '<div class="icon">' + iconHtml + '</div>'
      + '<div class="name">' + escapeHtml(perf.name || '(無名)') + '</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  // 全画面非対応時など、リモート起動とは無関係な汎用 notice モーダル。
  // (リモート起動関連は shared/remote-opener.js に集約済み)
  function showRemoteNotice(title, message) {
    if (window.KomehubShared && window.KomehubShared.closeRemoteModal) {
      window.KomehubShared.closeRemoteModal();
    }
    var modal = document.createElement('div');
    modal.className = 'remote-modal';
    modal.id = 'remoteModal';
    modal.innerHTML = '<div class="remote-panel">'
      + '<h2>' + escapeHtml(title) + '</h2>'
      + '<p>' + escapeHtml(message) + '</p>'
      + '<div class="remote-actions">'
      + '<button class="remote-confirm" type="button" id="remoteClose">閉じる</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(modal);
    document.getElementById('remoteClose').addEventListener('click', function () {
      var existing = document.getElementById('remoteModal');
      if (existing) existing.remove();
    });
  }

  function openRemoteWithOptionalWarning() {
    if (!window.KomehubShared || !window.KomehubShared.openRemote) {
      // eslint-disable-next-line no-console
      ponoutLog.error('[ponout] KomehubShared.openRemote not loaded');
      return;
    }
    remoteButton.disabled = true;
    window.KomehubShared.openRemote({
      confirmTitle: 'スマホ操作を有効にしますか？',
      confirmParagraphs: [
        'スマホからポン出しを操作するため、このPCのローカルネットワーク向けにリモート専用ポートを開きます。',
        'Windows セキュリティの警告が表示された場合は、同じ Wi-Fi / LAN のスマホから接続できるように「プライベート ネットワーク」を許可してください。パブリック ネットワークでは許可しないでください。',
        'リモート専用ポートでは、ポン出し操作に必要な機能だけを公開します。通常の管理機能は公開しません。'
      ],
      resultTitle: 'スマホで開く',
      fetchInfo: function () { return api.ponout.openRemote(); },
      getDismissed: api.ponout && api.ponout.getRemoteWarningDismissed
        ? function () { return api.ponout.getRemoteWarningDismissed(); }
        : null,
      setDismissed: api.ponout && api.ponout.setRemoteWarningDismissed
        ? function (v) { return api.ponout.setRemoteWarningDismissed(v); }
        : null
    });
    // openRemote は await 不要 (= モーダル管理を内部で持つ)。ボタンは即時 enable
    setTimeout(function () { remoteButton.disabled = false; }, 0);
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function updateFullscreenButton() {
    if (!fullscreenButton) return;
    fullscreenButton.textContent = fullscreenElement() ? '解除' : '全画面';
  }

  function enterFullscreen() {
    var target = document.documentElement;
    var request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!request) {
      showRemoteNotice(
        '全画面表示に対応していません',
        'このブラウザではページ側から全画面表示へ切り替えられません。ブラウザのメニュー、またはホーム画面に追加してから開く方法を試してください。'
      );
      return Promise.resolve();
    }
    return Promise.resolve(request.call(target));
  }

  function exitFullscreen() {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return Promise.resolve();
    return Promise.resolve(exit.call(document));
  }

  function toggleFullscreen() {
    var action = fullscreenElement() ? exitFullscreen() : enterFullscreen();
    return action.then(updateFullscreenButton).catch(function () {
      showRemoteNotice(
        '全画面表示にできませんでした',
        'ブラウザの制限により全画面表示へ切り替えられませんでした。もう一度ボタンを押すか、ブラウザのメニューから全画面表示を試してください。'
      );
      updateFullscreenButton();
    });
  }

  function renderPad(scene, slots) {
    pad.innerHTML = '';
    var start = currentPage * 8;
    for (var i = 0; i < 8; i++) {
      var slotIdx = start + i;
      var perfId = slots[slotIdx];
      var perf = perfId ? getPerf(scene, perfId) : null;
      var key = document.createElement('button');
      key.type = 'button';
      key.className = 'key' + (perf ? ' ready' : ' empty');
      key.dataset.slotIdx = String(slotIdx);

      if (perf) {
        key.innerHTML = buildKeyContent(scene, perf);
        attachFireHandler(key, scene.id, perf);
      } else {
        key.innerHTML = '<div class="icon">+</div>';
      }

      if (editing) attachDragHandlers(key, slotIdx, slots);

      pad.appendChild(key);
    }
  }

  function attachFireHandler(key, sceneId, perf) {
    key.addEventListener('click', function () {
      if (editing) return;
      ponoutLog.info('user: ponout-fire, sceneId=' + sceneId + ', perfId=' + perf.id + ', name=' + (perf.name || ''));
      key.classList.add('firing');
      setTimeout(function () { key.classList.remove('firing'); }, 140);
      Promise.resolve(api.triggerManual(sceneId, perf.id)).then(function (ok) {
        // 接続ドットは YouTube ライブチャット状態を反映するため触らない。
        // ok === false (= core 未起動) はサイレント無視。
        if (ok !== false) {
          recentLog.unshift({ name: perf.name || '(無名)', at: Date.now() });
          if (recentLog.length > 3) recentLog.length = 3;
          renderRecent();
        }
      }).catch(function () { /* noop */ });
    });
  }

  function attachDragHandlers(key, slotIdx, slots) {
    var perfId = slots[slotIdx];
    if (perfId) {
      key.draggable = true;
      key.addEventListener('dragstart', function (e) {
        key.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-source', JSON.stringify({ kind: 'slot', slotIdx: slotIdx }));
      });
      key.addEventListener('dragend', function () { key.classList.remove('dragging'); });
    }
    key.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      key.classList.add('drop-target');
    });
    key.addEventListener('dragleave', function () { key.classList.remove('drop-target'); });
    key.addEventListener('drop', function (e) {
      e.preventDefault();
      key.classList.remove('drop-target');
      var data = e.dataTransfer.getData('text/x-source');
      if (!data) return;
      var src;
      try { src = JSON.parse(data); } catch (_) { return; }
      commitDrop(slots, src, slotIdx);
    });
  }

  // view (slot 配列) の状態を全 perf の ponoutSlot に反映する共通処理。
  // current の状態を 3 値で扱う:
  //   - number: 既に explicit 配置
  //   - null:   明示的に未割当 (pool に居る)
  //   - 'auto': まだ確定していない (= ponoutSlot field 不在 / undefined)
  // ユーザー操作 (drag) 直後は view の位置を「確定」として永続化する。
  // 'auto' は番兵で、explicit 化のためなら値が変わらなくても save する
  // (= drag-to-pool で undefined→null も確定対象になる)。
  function persistViewState(scene, view) {
    var pons = eligiblePerfs(scene);
    var jobs = [];
    pons.forEach(function (p) {
      var newSlot = view.indexOf(p.id);
      var newSlotValue = newSlot === -1 ? null : newSlot;
      var hasExplicit = (typeof p.ponoutSlot === 'number') || p.ponoutSlot === null;
      var current = hasExplicit ? p.ponoutSlot : 'auto';
      var willSave = (current === 'auto') || (current !== newSlotValue);
      if (willSave) {
        var next = Object.assign({}, p, { ponoutSlot: newSlotValue });
        jobs.push(api.savePerformance(scene.id, next));
      }
    });
    Promise.all(jobs).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });
  }

  // === ドロップ操作: view 上で位置を入れ替えた後、影響 perf を永続化 ===
  function commitDrop(currentSlots, source, targetSlotIdx) {
    var scene = activeScene();
    if (!scene) return;
    var view = currentSlots.slice();
    if (source.kind === 'slot') {
      var a = source.slotIdx, b = targetSlotIdx;
      if (a === b) return;
      var tmp = view[a]; view[a] = view[b]; view[b] = tmp;
    } else if (source.kind === 'pool') {
      var i = view.indexOf(source.perfId);
      if (i !== -1) view[i] = null;
      view[targetSlotIdx] = source.perfId;
    } else {
      return;
    }
    persistViewState(scene, view);
  }

  function commitDropToPool(source) {
    if (source.kind !== 'slot') return;
    var scene = activeScene();
    if (!scene) return;
    var view = buildSlots(scene);
    view[source.slotIdx] = null;
    persistViewState(scene, view);
  }

  function renderPageBar(scene, slots) {
    pageBar.innerHTML = '';
    var n = pageCount(slots);
    pageBar.classList.toggle('single', n <= 1);
    pageBar.classList.toggle('editing-add', editing);
    for (var i = 0; i < n; i++) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'page-chip' + (i === currentPage ? ' active' : '');
      chip.innerHTML = '<span></span><span class="num"></span>';
      chip.children[0].textContent = 'ページ';
      chip.children[1].textContent = String(i + 1);
      (function (idx) {
        chip.addEventListener('click', function () { currentPage = idx; renderAll(); });
      })(i);
      pageBar.appendChild(chip);
    }
    if (editing) {
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'page-chip add';
      add.textContent = '+ ページ追加';
      add.title = '空のスロットを 8 個追加';
      add.addEventListener('click', function () {
        // 何もしない (永続化対象が無いため). ページを増やすには空スロットへ何かを置く必要がある。
        // ここでは UX 上「次のページ」へ進むことで擬似的に対応。
        currentPage = n; // n は元のページ数。新ページに移動。
        // pageCount は実体に依存するため、ローカル currentPage を上回ると render で clamp される。
        // 利用者が pool からドラッグするまで、新ページは空のまま見える。
        // → 擬似ページ表示は render 側で +1 する形に対応する余地がある。今回は簡略化。
        renderAll();
      });
      pageBar.appendChild(add);
    }
  }

  function renderPool(scene) {
    poolList.innerHTML = '';
    if (!scene) return;
    var slots = buildSlots(scene);
    var pons = eligiblePerfs(scene);
    var unassigned = pons.filter(function (p) { return slots.indexOf(p.id) === -1; });
    unassigned.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'pool-item';
      item.draggable = true;
      var firstAsset = p.assets && p.assets[0];
      var assetStr = '';
      if (typeof firstAsset === 'string') assetStr = firstAsset;
      else if (firstAsset && typeof firstAsset.file === 'string') assetStr = firstAsset.file;
      var iconHtml;
      if (assetStr && isImageAsset(assetStr)) {
        iconHtml = '<img src="' + buildLocalHttpUrl('/effects/' + scene.id + '/assets/' + assetStr).replace(/"/g, '&quot;') + '" alt="">';
      } else if (assetStr && isVideoAsset(assetStr)) {
        iconHtml = '🎬';
      } else {
        iconHtml = '🎉';
      }
      item.innerHTML = '<span class="icon">' + iconHtml + '</span><span></span>';
      item.children[1].textContent = p.name || '(無名)';
      item.addEventListener('dragstart', function (e) {
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-source', JSON.stringify({ kind: 'pool', perfId: p.id }));
      });
      item.addEventListener('dragend', function () { item.classList.remove('dragging'); });
      poolList.appendChild(item);
    });
  }

  // YouTube ライブチャットの接続状態を main UI と同じ tri-state で表示する。
  // - connected=true                    → green '接続中'
  // - msg に '再接続' or '接続中'         → yellow (msg 表示)
  // - その他 (default '未接続')          → gray (msg 表示)
  function applyChatStatus(data) {
    if (!data || typeof data !== 'object') return;
    var state, text;
    if (data.connected) {
      state = 'connected';
      text = '接続中';
    } else {
      var msg = data.message || '未接続';
      state = (msg.indexOf('再接続') !== -1 || msg.indexOf('接続中') !== -1) ? 'connecting' : 'disconnected';
      text = msg;
    }
    if (connDot) connDot.className = 'dot ' + state;
    if (connText) connText.textContent = text;
  }

  // === 全描画 ===
  function renderAll() {
    var scene = activeScene();
    var slots = scene ? buildSlots(scene) : [null,null,null,null,null,null,null,null];
    var n = pageCount(slots);
    if (currentPage >= n) currentPage = n - 1;
    if (currentPage < 0) currentPage = 0;
    renderSceneTabs();
    renderRecent();
    renderPad(scene || { id: '', performances: [] }, slots);
    renderPageBar(scene || { id: '' }, slots);
    renderPool(scene);
    updateTabsOverflow();
  }

  // === データ load ===
  function loadAndRender() {
    return Promise.all([
      api.getSceneList(),
      api.getScenes(),
      api.getSelectedScene()
    ]).then(function (results) {
      sceneList = Array.isArray(results[0]) ? results[0] : [];
      scenesMap = (results[1] && typeof results[1] === 'object') ? results[1] : {};
      var selected = results[2] || '';
      if (selected && scenesMap[selected]) {
        currentSceneId = selected;
      } else if (sceneList.length > 0) {
        currentSceneId = sceneList[0].id;
      } else {
        currentSceneId = '';
      }
      renderAll();
    }).catch(function () {
      renderAll();
    });
  }

  // === 編集トグル ===
  editToggle.addEventListener('click', function () {
    editing = !editing;
    device.classList.toggle('editing', editing);
    editToggle.classList.toggle('active', editing);
    editToggle.textContent = editing ? '完了' : '編集';
    pool.classList.toggle('visible', editing);
    renderAll();
  });

  function applyPausedState(paused) {
    // ボタン文字は「停止」固定。active (paused=true) でうっすら赤発光して「今止まっている」状態を示す。
    // ラベルが「再開」に化けると「何もしてないのに再開？」と読みづらかったため、TTS 一時停止と同じ
    // "label fixed + active glow" パターンに揃えた。
    pauseButton.classList.toggle('active', !!paused);
    if (perfStatusText) {
      perfStatusText.textContent = paused ? '停止中' : '通常';
      perfStatusText.classList.toggle('paused', !!paused);
    }
    if (perfDot) {
      perfDot.className = 'dot' + (paused ? ' paused' : '');
    }
  }

  pauseButton.addEventListener('click', function () {
    if (!api.getPaused || !api.setPaused) return;
    ponoutLog.info('user: ponout-performance-paused-toggle');
    pauseButton.disabled = true;
    api.getPaused().then(function (paused) {
      var next = !paused;
      return api.setPaused(next).then(function () {
        applyPausedState(next);
      });
    }).catch(function (err) {
      ponoutLog.debug('ponout pause toggle rejected:', err);
    }).then(function () {
      pauseButton.disabled = false;
    });
  });

  clearButton.addEventListener('click', function () {
    if (!currentSceneId || !api.clearPerformances) return;
    ponoutLog.info('user: ponout-performance-clear, sceneId=' + currentSceneId);
    clearButton.disabled = true;
    Promise.resolve(api.clearPerformances(currentSceneId)).then(function (result) {
      if (result && result.ok !== false) {
        recentLog = [];
        renderRecent();
      }
    }).catch(function () {
      /* noop */
    }).then(function () {
      clearButton.disabled = false;
    });
  });

  // === Pool への drop (= 未割当に戻す) ===
  poolList.addEventListener('dragover', function (e) {
    if (!editing) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    poolList.classList.add('drop-active');
  });
  poolList.addEventListener('dragleave', function () { poolList.classList.remove('drop-active'); });
  poolList.addEventListener('drop', function (e) {
    e.preventDefault();
    poolList.classList.remove('drop-active');
    var data = e.dataTransfer.getData('text/x-source');
    if (!data) return;
    var src;
    try { src = JSON.parse(data); } catch (_) { return; }
    commitDropToPool(src);
  });

  // === キーボード: ← / → でページ送り ===
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.matches && e.target.matches('input, textarea')) return;
    var scene = activeScene();
    if (!scene) return;
    var slots = buildSlots(scene);
    var n = pageCount(slots);
    if (e.key === 'ArrowLeft' && currentPage > 0) { currentPage--; renderAll(); }
    else if (e.key === 'ArrowRight' && currentPage < n - 1) { currentPage++; renderAll(); }
  });

  // === port (asset URL 用) は Rust core 状態から取る ===
  // push: 起動 / port 変化時に core-status broadcast が来る
  // pull: 後から開いた window が初期取得
  function applyCorePort(status) {
    if (!status) return;
    if (typeof status.origin === 'string' && status.origin) {
      coreOrigin = status.origin.replace(/\/$/, '');
    } else {
      coreOrigin = '';
      if (typeof status.host === 'string' && status.host) coreHost = status.host;
    }
    if (typeof status.port === 'number' && status.port > 0 && status.port !== corePort) {
      corePort = status.port;
      renderAll();
    } else if (coreOrigin || coreHost !== 'localhost') {
      renderAll();
    }
  }
  if (api.onCoreStatus) api.onCoreStatus(applyCorePort);
  if (api.getCoreStatus) api.getCoreStatus().then(applyCorePort).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });

  // === 接続ドット表示は YouTube ライブチャット状態 (main UI と同じ) ===
  // push: status イベントが来るたびに反映
  // pull: 後から開いた window が初期表示用に main の最新値を取得
  if (api.onStatus) api.onStatus(applyChatStatus);
  if (api.getChatStatus) api.getChatStatus().then(applyChatStatus).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });

  if (api.getPaused) api.getPaused().then(applyPausedState).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });

  // === TTS 操作 ===
  // ON/OFF / pause / clear だけを扱う。provider 選択や音量・速度は main UI 側に残す。
  // 表示は ttsBadgeText 相当 (provider 名 + 状態) + 状態ドット。
  var ttsState = {
    enabled: false,
    paused: false,
    speaking: false,
    queueCount: 0,
    provider: 'builtin',
    providerStatus: 'idle',
    providerError: ''
  };
  // ttsSetEnabled は Rust 側で再生プロセス停止やキュークリアを伴うため数百 ms 待つことがある。
  // 多重クリック防止と「処理中…」表示用フラグ (main UI の ttsBusy と同じ)。
  var ttsBusy = false;

  function ttsProviderLabel(p) {
    if (p === 'voicevox') return 'VOICEVOX';
    if (p === 'bouyomi') return '棒読みちゃん';
    return '内蔵';
  }

  function ttsStatusKind() {
    if (ttsState.providerStatus === 'unreachable') return 'error';
    if (ttsState.providerStatus === 'checking') return 'checking';
    if (!ttsState.enabled) return 'off';
    if (ttsState.paused) return 'paused';
    return 'on';
  }

  function ttsStatusLabel() {
    if (ttsState.providerStatus === 'unreachable') {
      return ttsProviderLabel(ttsState.provider) + ' 未起動';
    }
    if (ttsState.providerStatus === 'checking') return '接続確認中…';
    var label = ttsProviderLabel(ttsState.provider);
    if (!ttsState.enabled) return label + ' / OFF';
    if (ttsState.paused) {
      return ttsState.queueCount > 0
        ? label + ' / 一時停止 (待機 ' + ttsState.queueCount + '件)'
        : label + ' / 一時停止';
    }
    if (ttsState.speaking) return label + ' / 読み上げ中';
    if (ttsState.queueCount > 0) return label + ' / 待機 ' + ttsState.queueCount + '件';
    return label;
  }

  function applyTtsAppearance() {
    var kind = ttsStatusKind();

    if (ttsDot) {
      ttsDot.className = 'dot' + (kind === 'on' || kind === 'paused' || kind === 'error' || kind === 'checking' ? ' ' + kind : '');
    }
    if (ttsStatusText) {
      ttsStatusText.textContent = ttsStatusLabel();
      ttsStatusText.className = 'status' + (kind === 'error' || kind === 'checking' || kind === 'on' || kind === 'paused' ? ' ' + (kind === 'paused' ? 'on' : kind) : '');
      ttsStatusText.title = ttsState.providerError || '';
    }

    if (ttsToggle) {
      if (ttsBusy) {
        ttsToggle.textContent = '処理中…';
        ttsToggle.disabled = true;
        ttsToggle.classList.remove('active');
      } else {
        ttsToggle.textContent = ttsState.enabled ? 'ON' : 'OFF';
        ttsToggle.disabled = false;
        ttsToggle.classList.toggle('active', !!ttsState.enabled);
      }
    }
    if (ttsPause) {
      // ラベルは「一時停止」固定。押下で active (オレンジ発光) になり再押下で解除する
      // トグルボタンとして扱う。状態テキストは strip 左側で別途出している。
      ttsPause.classList.toggle('active', !!ttsState.paused);
      ttsPause.disabled = !ttsState.enabled;
    }
    if (ttsClear) {
      ttsClear.disabled = !ttsState.enabled;
    }
  }

  if (ttsToggle) {
    ttsToggle.addEventListener('click', function () {
      if (!api.ttsSetEnabled || ttsBusy) return;
      ttsBusy = true;
      applyTtsAppearance();
      var nextEnabled = !ttsState.enabled;
      ponoutLog.info('user: ponout-tts-enabled-toggle, enabled=' + nextEnabled);
      Promise.resolve(api.ttsSetEnabled(nextEnabled)).then(function (state) {
        if (state) ttsState = state;
      }).catch(function () {
        if (api.ttsGetState) {
          return api.ttsGetState().then(function (state) {
            if (state) ttsState = state;
          }).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });
        }
      }).then(function () {
        ttsBusy = false;
        applyTtsAppearance();
      });
    });
  }

  if (ttsPause) {
    ttsPause.addEventListener('click', function () {
      if (!api.ttsSetPaused) return;
      var nextPaused = !ttsState.paused;
      ponoutLog.info('user: ponout-tts-paused-toggle, paused=' + nextPaused);
      Promise.resolve(api.ttsSetPaused(nextPaused)).then(function (state) {
        if (state) ttsState = state;
        applyTtsAppearance();
      }).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });
    });
  }

  if (ttsClear) {
    ttsClear.addEventListener('click', function () {
      if (!api.ttsClear) return;
      ponoutLog.info('user: ponout-tts-clear');
      Promise.resolve(api.ttsClear()).then(function (state) {
        if (state) ttsState = state;
        applyTtsAppearance();
      }).catch(function (err) { ponoutLog.debug("promise rejected (catch swallow):", err); });
    });
  }

  // 初期 pull (後から開いた window が main UI と同じ状態を初期表示するため)。
  if (api.ttsGetState) {
    api.ttsGetState().then(function (state) {
      if (state) ttsState = state;
      applyTtsAppearance();
    }).catch(function () { applyTtsAppearance(); });
  } else {
    applyTtsAppearance();
  }

  // push: Rust 側はコメント毎 / provider 切替時に tts-state を送ってくる。
  // ttsBusy 中は ON/OFF が確定する前に SSE 由来の中間状態で上書きされないよう skip する
  // (main UI の onTtsState と同じ方針)。
  if (api.onTtsState) {
    api.onTtsState(function (state) {
      if (state) ttsState = state;
      if (ttsBusy) return;
      applyTtsAppearance();
    });
  }

  if (remoteButton && api.ponout && api.ponout.openRemote) {
    remoteButton.addEventListener('click', function () {
      openRemoteWithOptionalWarning();
    });
  }

  if (fullscreenButton) {
    fullscreenButton.addEventListener('click', function () {
      fullscreenButton.disabled = true;
      toggleFullscreen().finally(function () {
        fullscreenButton.disabled = false;
      });
    });
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
    updateFullscreenButton();
  }

  // === broadcast 駆動 ===
  if (api.onScenesChanged) {
    api.onScenesChanged(function () { loadAndRender(); });
  }

  // === resize でタブ overflow 再判定 ===
  window.addEventListener('resize', updateTabsOverflow);

  // 初期化
  loadAndRender();
})();
