// === remote view: archive ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.7 (アーカイブタブ、 Phase 9)
//
// 本体 cl-tabs の「アーカイブ」グループ (= 配信ログ / コメ検索 / リスナー検索) を
// スマホ用に SPA 化したタブ。 5 つ目のボトムタブとして配置し、 内部で上部サブタブで
// 3 機能を切り替える。
//
// 各サブビュー (= view-archive-streams / view-archive-comment-search /
// view-archive-listener-search) は window.KomehubArchiveSubviews.{key} に
// 登録された contract { init(container, shell, query), destroy() } を実装する。
// shell が mount / unmount を制御し、 非アクティブ panel は display:none で残す
// (= state 保持、 戻る時に再 fetch しない)。
//
// URL design:
//   /remote/archive               → default = streams sub-tab
//   /remote/archive?tab=cs        → コメ検索
//   /remote/archive?tab=ls        → リスナー検索
//
// 配信詳細サブ画面 (= タップ遷移) は別 view:
//   /remote/streams/{video_id}    → view-stream-detail

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var archiveViewLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('Archive')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  if (!window.KomehubViews) window.KomehubViews = {};
  if (!window.KomehubArchiveSubviews) window.KomehubArchiveSubviews = {};

  // サブタブ定義 (= UI 表示順)
  var SUBTABS = [
    { key: 'streams', label: '配信ログ', view: 'archive-streams' },
    { key: 'cs',      label: 'コメ検索',  view: 'archive-comment-search' },
    { key: 'ls',      label: 'リスナー検索', view: 'archive-listener-search' }
  ];

  function init(container, params, shell, query) {
    shell.setTitle('アーカイブ');
    shell.setBackVisible(false);

    var initialKey = (query && query.tab) || 'streams';
    if (!findSubtabByKey(initialKey)) initialKey = 'streams';

    var shellRoot = document.createElement('div');
    shellRoot.className = 'rh-archive-shell';

    // サブタブ bar
    var subtabsEl = document.createElement('div');
    subtabsEl.className = 'rh-archive-subtabs';
    subtabsEl.setAttribute('role', 'tablist');
    SUBTABS.forEach(function (def) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rh-archive-subtab';
      btn.dataset.subtabKey = def.key;
      btn.setAttribute('role', 'tab');
      btn.textContent = def.label;
      btn.addEventListener('click', function () { switchTo(def.key, true); });
      subtabsEl.appendChild(btn);
    });
    shellRoot.appendChild(subtabsEl);

    // panel container
    var panelsEl = document.createElement('div');
    panelsEl.className = 'rh-archive-panels';
    shellRoot.appendChild(panelsEl);

    container.appendChild(shellRoot);

    // 各サブビューの instance ({ panelEl, instance, mounted })
    var subInstances = {};

    var currentKey = '';
    function switchTo(key, pushHistory) {
      var def = findSubtabByKey(key);
      if (!def) return;
      // 観点 I: アーカイブ sub-tab 切替 (= 配信ログ / コメ検索 / リスナー検索)
      // を user 操作として記録。 詳細: docs/logging.md
      if (currentKey !== key) {
        archiveViewLog.info('user: archive-subtab-switch, from=' + (currentKey || '(initial)') + ', to=' + key);
      }
      currentKey = key;
      // ボタン active 表示
      var btns = subtabsEl.querySelectorAll('.rh-archive-subtab');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.subtabKey === key);
      }
      // panel mount (= lazy: 初回 active 時に init)
      ensureMounted(def);
      // 全 panel の active 切替
      SUBTABS.forEach(function (d) {
        var rec = subInstances[d.key];
        if (!rec || !rec.panelEl) return;
        rec.panelEl.classList.toggle('inactive', d.key !== key);
      });
      // URL 更新 (= ブラウザ back で前サブタブに戻れる)
      if (pushHistory) {
        var qs = key === 'streams' ? '' : '?tab=' + encodeURIComponent(key);
        try { history.replaceState({}, '', '/remote/archive' + qs); }
        catch (err) { archiveViewLog.debug('history.replaceState failed:', err); }
      }
      // 切替先のサブビュー instance に onShow() があれば呼ぶ。
      // 仮想化リスト等が再表示時に DOM を再同期するために使う。
      var activeRec = subInstances[key];
      if (activeRec && activeRec.instance && typeof activeRec.instance.onShow === 'function') {
        // 次フレームで呼ぶ (= display:none → block の layout 反映後)
        requestAnimationFrame(function () {
          try { activeRec.instance.onShow(); } catch (err) { archiveViewLog.warn('subview onShow threw:', err); }
        });
      }
    }

    function ensureMounted(def) {
      if (subInstances[def.key]) return;
      var panel = document.createElement('div');
      panel.className = 'rh-archive-panel inactive';
      panel.dataset.subtabKey = def.key;
      panelsEl.appendChild(panel);
      var subdef = window.KomehubArchiveSubviews[def.view];
      var inst = null;
      if (subdef && typeof subdef.init === 'function') {
        try { inst = subdef.init(panel, shell, query || {}); }
        catch (e) {
          var err = document.createElement('div');
          err.className = 'rh-empty';
          err.textContent = 'サブビューの初期化に失敗: ' + (e && e.message ? e.message : String(e));
          panel.appendChild(err);
        }
      } else {
        var ph = document.createElement('div');
        ph.className = 'rh-empty';
        ph.textContent = '「' + def.label + '」 は準備中です';
        panel.appendChild(ph);
      }
      subInstances[def.key] = { panelEl: panel, instance: inst || {} };
    }

    switchTo(initialKey, false);

    return {
      destroy: function () {
        Object.keys(subInstances).forEach(function (k) {
          var rec = subInstances[k];
          if (rec && rec.instance && typeof rec.instance.destroy === 'function') {
            try { rec.instance.destroy(); } catch (err) { archiveViewLog.warn('subview destroy threw (continuing cleanup):', err); }
          }
        });
        subInstances = {};
      }
    };
  }

  function findSubtabByKey(key) {
    for (var i = 0; i < SUBTABS.length; i++) {
      if (SUBTABS[i].key === key) return SUBTABS[i];
    }
    return null;
  }

  window.KomehubViews.archive = { init: init };
})();
