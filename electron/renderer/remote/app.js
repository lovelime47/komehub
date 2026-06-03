// === remote SPA shell ===
// 設計正本: docs/architecture/remote-viewing-redesign.md (= §5.1 「SPA 不要」は
// 2026-05 のユーザー要望により撤回、 タブ間ステート保持のため SPA 化)
//
// 役割:
// - history.pushState ベースのクライアントサイドルーター
// - shell-level SSE 接続 1 本を維持 + 各 view への pub/sub dispatch
// - 各 view モジュール (window.KomehubViews.*) の mount / unmount
// - bottom tab bar の active 切替 + 通知バッジ
// - <a href> の hijack (= 同一 SPA 内なら preventDefault + pushState)
//
// View モジュールの contract:
//   window.KomehubViews.{name} = {
//     init: function(container, params, shell) { return instance; },
//     // instance は { destroy: function() } を持つ
//   };
// shell は instance.destroy() を呼んで old view を破棄してから new view を mount。
// state は module-level に持って、 再 init 時に rehydrate (= 「コメが消える」を防止)。

(function () {
  'use strict';

  var R = window.KomehubRemote;
  if (!window.KomehubViews) window.KomehubViews = {};
  var views = window.KomehubViews;

  // DOM 参照
  var statusEl = document.getElementById('rh-status');
  var titleEl = document.getElementById('rh-title');
  var backBtn = document.getElementById('rh-back-btn');
  var viewRoot = document.getElementById('rh-view-root');

  // ───────── SSE pub/sub (= shell-level 1 接続) ─────────
  // 各 view が shell.on('comment', fn) で subscribe、 destroy 時に unsub を呼ぶ。
  // shell は EventSource を 1 つだけ持ち、 接続を切らない (= 「タブ移動で SSE
  // 再接続 + コメ取りこぼし」の根本解消)。
  var subscribers = {
    open: [],
    comment: [],
    commentDeleted: [],
    staticUpdate: [],
    error: []
  };
  function emit(type) {
    var arr = subscribers[type];
    if (!arr) return;
    // arguments[1..] を view callback に転送
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < arr.length; i++) {
      try { arr[i].apply(null, args); }
      catch (e) { /* view 側の例外は他 view に波及させない */ }
    }
  }
  var shellApi = {
    on: function (type, fn) {
      if (!subscribers[type]) subscribers[type] = [];
      subscribers[type].push(fn);
      return function unsub() {
        var arr = subscribers[type];
        if (!arr) return;
        var idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      };
    },
    setTitle: function (t) { titleEl.textContent = t || 'こめはぶ Remote'; },
    setBackVisible: function (show) {
      backBtn.style.display = show ? '' : 'none';
    },
    navigate: function (path) { pushAndNavigate(path); },
    setTabBadge: function (tabName, count) { setTabBadge(tabName, count); }
  };

  // 初回ステータス取得 + SSE 接続 (= shell が永続化する単一接続)
  R.refreshStatusBadge(statusEl);
  R.connectStream({
    onOpen: function () { emit('open'); },
    onComment: function (c) { emit('comment', c); },
    onCommentDeleted: function (d) { emit('commentDeleted', d); },
    onStaticUpdate: function (path, data) {
      // status バッジは shell が常に更新 (= 全 view 共通要素)
      if (path === 'connection') R.refreshStatusBadge(statusEl);
      emit('staticUpdate', path, data);
    },
    onError: function (e) {
      statusEl.classList.remove('live');
      statusEl.classList.add('disconnected');
      statusEl.textContent = '再接続中…';
      emit('error', e);
    }
  });

  // ───────── ルーター ─────────
  // /remote/                       → home
  // /remote/comments               → comments
  // /remote/listeners              → listeners
  // /remote/listeners/{channel_id} → listener-detail
  // /remote/search                 → search (+ querystring listener / stream / period)
  // /remote/archive                → archive (= 上部サブタブで 配信ログ/コメ検索/リスナー検索)
  // /remote/streams/{video_id}     → stream-detail (= 1 配信の summary + 4 セクション)
  function parsePath(pathname) {
    var parts = pathname.split('/').filter(Boolean);
    // ['remote'] / ['remote', X] / ['remote', 'listeners', ch]
    if (parts.length === 1 && parts[0] === 'remote') return { name: 'home', params: {} };
    if (parts.length === 2 && parts[1] === 'comments') return { name: 'comments', params: {} };
    if (parts.length === 2 && parts[1] === 'gifts') return { name: 'gifts', params: {} };
    if (parts.length === 2 && parts[1] === 'listeners') return { name: 'listeners', params: {} };
    if (parts.length === 3 && parts[1] === 'listeners') {
      return { name: 'listener-detail', params: { channelId: decodeURIComponent(parts[2]) } };
    }
    if (parts.length === 2 && parts[1] === 'search') return { name: 'search', params: {} };
    if (parts.length === 2 && parts[1] === 'archive') return { name: 'archive', params: {} };
    if (parts.length === 3 && parts[1] === 'streams') {
      return { name: 'stream-detail', params: { videoId: decodeURIComponent(parts[2]) } };
    }
    // 未知 path は home へ fallback
    return { name: 'home', params: {} };
  }

  function parseQuery(search) {
    var out = {};
    if (!search) return out;
    var qs = search.charAt(0) === '?' ? search.slice(1) : search;
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      var pair = kv.split('=');
      var k = decodeURIComponent(pair[0] || '');
      var v = decodeURIComponent(pair[1] || '');
      if (k) out[k] = v;
    });
    return out;
  }

  var current = null; // { name, instance }

  function navigate(name, params, query) {
    // 古い view を destroy (= state は module-level に残る、 DOM だけ破棄)
    if (current && current.instance && typeof current.instance.destroy === 'function') {
      try { current.instance.destroy(); }
      catch (e) { /* swallow */ }
    }
    viewRoot.replaceChildren();

    // タイトル / 戻るボタンは view 側で setTitle / setBackVisible する。
    // ここでは default に戻しておく。
    titleEl.textContent = 'こめはぶ Remote';
    backBtn.style.display = 'none';

    var def = views[name];
    if (!def || typeof def.init !== 'function') {
      // X-2 で各 view を実装するまでの placeholder
      var ph = document.createElement('div');
      ph.className = 'rh-empty';
      ph.textContent = '画面 "' + name + '" は準備中です';
      viewRoot.appendChild(ph);
      current = null;
    } else {
      var instance = null;
      try {
        instance = def.init(viewRoot, params || {}, shellApi, query || {});
      } catch (e) {
        var err = document.createElement('div');
        err.className = 'rh-empty';
        err.textContent = '画面の初期化に失敗しました: ' + (e && e.message ? e.message : String(e));
        viewRoot.appendChild(err);
        current = null;
        return;
      }
      current = { name: name, instance: instance || {} };
    }

    updateTabActive(name);
  }

  function updateTabActive(name) {
    // 派生 view を親タブの active 表示に紐付ける (= listener-detail はリスナータブ、
    // stream-detail / archive 配下の view はアーカイブタブを active)
    var tabFor = name;
    if (name === 'listener-detail') tabFor = 'listeners';
    else if (name === 'stream-detail') tabFor = 'archive';
    var tabs = document.querySelectorAll('.rh-tab');
    for (var i = 0; i < tabs.length; i++) {
      var v = tabs[i].dataset.view || '';
      tabs[i].classList.toggle('active', v === tabFor);
    }
  }

  function setTabBadge(tabName, count) {
    var el = document.getElementById('rh-tab-badge-' + tabName);
    if (!el) return;
    var n = Number(count) || 0;
    if (n <= 0) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.textContent = n > 99 ? '99+' : String(n);
    }
  }

  function pushAndNavigate(href) {
    if (!href) return;
    // 絶対 / 相対 path を URL に正規化
    var url = new URL(href, location.origin);
    history.pushState({}, '', url.pathname + url.search);
    var route = parsePath(url.pathname);
    navigate(route.name, route.params, parseQuery(url.search));
  }

  // ───────── <a href> hijack ─────────
  // 同一 SPA 内 (/remote/*) なら preventDefault + pushState。
  // /remote/ponout/* は別 SPA なので素通り。
  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented) return;
    if (ev.button !== 0) return; // 中クリック等は素通り
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // Cmd+click 等は素通り
    var link = ev.target.closest && ev.target.closest('a');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href) return;
    if (link.target && link.target !== '' && link.target !== '_self') return;
    // ponout は別 SPA、 通常遷移
    if (link.dataset.external === 'ponout') return;
    if (href.indexOf('/remote/ponout') === 0) return;
    // /remote/* のみ hijack
    if (href.indexOf('/remote') !== 0) return;
    ev.preventDefault();
    pushAndNavigate(href);
  });

  // ───────── 戻るボタン ─────────
  // header の戻るボタン (= view 内で showBack(true) して使う)
  backBtn.addEventListener('click', function () {
    if (history.length > 1) history.back();
    else pushAndNavigate('/remote/');
  });

  // ───────── ブラウザの戻る/進む ─────────
  window.addEventListener('popstate', function () {
    var route = parsePath(location.pathname);
    navigate(route.name, route.params, parseQuery(location.search));
  });

  // ───────── 各 view の永続購読 ─────────
  // 一部の view (= comments) は表示中でなくても SSE を聞いて state を更新する
  // 必要がある (= 「タブ移動でコメが飛ぶ」を防ぐ)。 そのような view は
  // subscribeForever(shell) を export する。 destroy しても解除されない。
  Object.keys(views).forEach(function (name) {
    var v = views[name];
    if (v && typeof v.subscribeForever === 'function') {
      try { v.subscribeForever(shellApi); }
      catch (e) { /* swallow */ }
    }
  });

  // ───────── 初期ナビゲーション ─────────
  var initialRoute = parsePath(location.pathname);
  navigate(initialRoute.name, initialRoute.params, parseQuery(location.search));
})();
