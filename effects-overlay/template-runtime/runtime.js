(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var runtimeConfig = window.__KOMEHUB_TEMPLATE_RUNTIME_CONFIG || {};
  var adapter = null;
  var latestConfig = null;
  var eventSource = null;
  var reconnectTimer = null;
  var everConnected = false;
  var hiddenOnce = false;
  var runtimeScriptNode = document.currentScript || null;
  var pageLoadedAtUnixMs = Date.now();
  var lastConfigAtUnixMs = 0;
  var resourceDebugPanel = null;

  if (typeof runtimeConfig.preview !== 'boolean') {
    runtimeConfig.preview = params.get('preview') === '1';
  }
  if (typeof runtimeConfig.devPreview !== 'boolean') {
    runtimeConfig.devPreview = runtimeConfig.preview && params.get('devPreview') === '1';
  }
  if (!runtimeConfig.previewDefaultBackground) {
    runtimeConfig.previewDefaultBackground = '#111827';
  }
  if (!runtimeConfig.streamPath) {
    runtimeConfig.streamPath = location.pathname.replace(/\/?$/, '') + '/stream';
  }
  if (!runtimeConfig.streamUrl) {
    runtimeConfig.streamUrl = runtimeConfig.streamPath + location.search;
  }
  if (!runtimeConfig.oneCommeWsUrl) {
    runtimeConfig.oneCommeWsUrl =
      (location.protocol === 'https:' ? 'wss://' : 'ws://') +
      location.host +
      '/onecomme/sub';
  }
  if (!Array.isArray(runtimeConfig.fonts)) {
    runtimeConfig.fonts = [];
  }
  if (!Array.isArray(runtimeConfig.fontSources)) {
    runtimeConfig.fontSources = [];
  }
  if (!runtimeConfig.resourceDebug || typeof runtimeConfig.resourceDebug !== 'object') {
    runtimeConfig.resourceDebug = {};
  }
  window.__KOMEHUB_PREVIEW = runtimeConfig.preview;
  window.__KOMEHUB_PREVIEW_DEFAULT_BG = runtimeConfig.previewDefaultBackground;
  window.__KOMEHUB_DEV_PREVIEW = !!runtimeConfig.devPreview;
  window.__KOMEHUB_RESET_ON_VISIBLE = !!runtimeConfig.resetOnVisible;

  function getContext() {
    return {
      root: document.documentElement,
      body: document.body,
      container: document.getElementById('comments'),
      runtimeConfig: runtimeConfig,
      latestConfig: latestConfig
    };
  }

  function safeCall(method, payload) {
    if (!adapter || typeof adapter[method] !== 'function') return;
    try {
      adapter[method](payload, getContext());
    } catch (err) {
      console.error('[KomehubTemplateRuntime] adapter.' + method + ' failed', err);
    }
  }

  function applyToBody(callback) {
    if (typeof callback !== 'function') return;
    if (document.body) {
      callback(document.body);
      return;
    }
    document.addEventListener('DOMContentLoaded', function handleBodyReady() {
      callback(document.body);
    }, { once: true });
  }

  function cloneJson(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}));
    } catch (_err) {
      return {};
    }
  }

  function formatUnixMs(unixMs) {
    if (typeof unixMs !== 'number' || !isFinite(unixMs) || unixMs <= 0) return '';
    try {
      return new Date(unixMs).toISOString();
    } catch (_err) {
      return '';
    }
  }

  function buildResourceDebugInfo() {
    var info = cloneJson(runtimeConfig.resourceDebug);
    if (!info.html || typeof info.html !== 'object') info.html = {};
    if (!info.assets || typeof info.assets !== 'object') info.assets = {};
    if (typeof info.html.servedAtUnixMs === 'number' && !info.html.servedAtIso) {
      info.html.servedAtIso = formatUnixMs(info.html.servedAtUnixMs);
    }
    Object.keys(info.assets).forEach(function (key) {
      var asset = info.assets[key];
      if (!asset || typeof asset !== 'object') return;
      if (typeof asset.modifiedUnixMs === 'number' && !asset.modifiedIso) {
        asset.modifiedIso = formatUnixMs(asset.modifiedUnixMs);
      }
    });
    info.client = {
      pageHref: location.href,
      pageLoadedAtUnixMs: pageLoadedAtUnixMs,
      pageLoadedAtIso: formatUnixMs(pageLoadedAtUnixMs),
      runtimeScriptUrl: runtimeScriptNode && runtimeScriptNode.src ? runtimeScriptNode.src : '',
      latestConfigAtUnixMs: lastConfigAtUnixMs || null,
      latestConfigAtIso: lastConfigAtUnixMs ? formatUnixMs(lastConfigAtUnixMs) : ''
    };
    return info;
  }

  function refreshResourceDebugInfo() {
    var info = buildResourceDebugInfo();
    window.__KOMEHUB_RESOURCE_DEBUG = info;
    return info;
  }

  function updateResourceDebugPanel() {
    if (!resourceDebugPanel) return;
    var pre = resourceDebugPanel.querySelector('pre');
    if (!pre) return;
    pre.textContent = JSON.stringify(refreshResourceDebugInfo(), null, 2);
  }

  function ensureResourceDebugPanel() {
    if (!runtimeConfig.preview) return;
    if (resourceDebugPanel) {
      updateResourceDebugPanel();
      return;
    }
    applyToBody(function (body) {
      if (!body || resourceDebugPanel) return;
      var panel = document.createElement('details');
      panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:min(560px,calc(100vw - 24px));background:rgba(3,7,18,0.92);border:1px solid #334155;border-radius:8px;color:#e2e8f0;font:12px/1.5 Consolas,monospace;padding:0;backdrop-filter:blur(8px);';
      var summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;list-style:none;padding:8px 10px;font:12px/1.4 sans-serif;color:#cbd5e1;';
      summary.textContent = 'リソース情報';
      panel.appendChild(summary);
      var inner = document.createElement('div');
      inner.style.cssText = 'padding:0 10px 10px;';
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'JSON をコピー';
      copyBtn.style.cssText = 'margin:0 0 8px;padding:4px 8px;background:#1d4ed8;border:1px solid #3b82f6;border-radius:4px;color:#eff6ff;font:11px sans-serif;cursor:pointer;';
      copyBtn.addEventListener('click', function () {
        var text = JSON.stringify(refreshResourceDebugInfo(), null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
        }
      });
      inner.appendChild(copyBtn);
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-word;';
      inner.appendChild(pre);
      panel.appendChild(inner);
      body.appendChild(panel);
      resourceDebugPanel = panel;
      updateResourceDebugPanel();
    });
  }

  function getFontCssHref(family) {
    if (!family || typeof family !== 'string') return '';
    return '/cache/fonts/' + family.replace(/\s+/g, '_') + '/font.css';
  }

  function ensureRuntimeFonts(fonts) {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;
    if (!Array.isArray(fonts) || fonts.length === 0) return;
    fonts.forEach(function (family) {
      var href = getFontCssHref(family);
      if (!href) return;
      appendStylesheetLink(head, href, { fontFamily: family, sourceType: 'builtinFont' });
    });
  }

  function hasStylesheetHref(head, href) {
    if (!head || !href) return false;
    var links = head.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i += 1) {
      var currentHref = links[i].getAttribute('href') || '';
      if (currentHref === href) return true;
      try {
        if (links[i].href === new URL(href, location.href).toString()) {
          return true;
        }
      } catch (_err) {}
    }
    return false;
  }

  function appendStylesheetLink(head, href, options) {
    if (!head || !href || hasStylesheetHref(head, href)) return null;
    options = options || {};
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    if (options.fontFamily) {
      link.setAttribute('data-komehub-font-family', options.fontFamily);
    }
    if (options.sourceType) {
      link.setAttribute('data-komehub-font-source-type', options.sourceType);
    }
    head.appendChild(link);
    return link;
  }

  function resolveFontSourceHref(source) {
    if (!source || typeof source !== 'object') return '';
    if (source.type === 'assetCss') {
      if (!source.css || typeof source.css !== 'string') return '';
      try {
        return new URL(source.css, location.href).toString();
      } catch (_err) {
        return '';
      }
    }
    if (source.type === 'remoteCss') {
      if (!source.url || typeof source.url !== 'string') return '';
      try {
        var remoteUrl = new URL(source.url);
        if (remoteUrl.protocol !== 'https:') return '';
        return remoteUrl.toString();
      } catch (_err) {
        return '';
      }
    }
    return '';
  }

  function ensureRuntimeFontSources(fontSources) {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;
    if (!Array.isArray(fontSources) || fontSources.length === 0) return;
    fontSources.forEach(function (source) {
      var href = resolveFontSourceHref(source);
      if (!href) return;
      appendStylesheetLink(head, href, {
        fontFamily: source.family || '',
        sourceType: source.type || 'fontSource'
      });
    });
  }

  function applyPreviewBackground(background) {
    if (!runtimeConfig.preview) return;
    var color = background || runtimeConfig.previewDefaultBackground || '#111827';
    document.documentElement.style.background = color;
    document.documentElement.style.setProperty('--komehub-preview-background', color);
    applyToBody(function (body) {
      if (!body || !body.style) return;
      body.style.background = color;
    });
  }

  // 共通レイアウト (表示位置 左/右 + 横幅): 共通 uiSchema (renderer 側
  // COMMON_LAYOUT_UI_SCHEMA) が全対応テンプレに自動付与する position / width を
  // body class + CSS 変数に流す built-in。テンプレ側は CSS で body.kh-pos-left /
  // body.kh-pos-right と --kh-stage-width を解釈するだけでよい (script.js の
  // config 配線は不要)。Group A (body > #comments 直下系) は common.css が、
  // Group B (panel 配置系) は各テンプレ CSS が解釈する。
  // position 未指定 (ticker / OneComme など対象外テンプレ) のときは class を
  // 付けないので、common.css の従来 viewport 全面配置にフォールバックする。
  function applyCommonLayout(config) {
    var position = config ? config.position : null;
    var rawWidth = config ? config.width : null;
    applyToBody(function (body) {
      if (!body || !body.classList) return;
      if (position === 'left' || position === 'right') {
        body.classList.toggle('kh-pos-right', position === 'right');
        body.classList.toggle('kh-pos-left', position !== 'right');
      }
      if (rawWidth != null && rawWidth !== '') {
        var n = typeof rawWidth === 'number' ? rawWidth : parseFloat(rawWidth);
        if (isFinite(n) && n > 0) {
          body.style.setProperty('--kh-stage-width', n + 'px');
        }
      }
    });
  }

  function applySceneVisibility(visible) {
    document.documentElement.style.opacity = visible ? '1' : '0';
    document.documentElement.style.pointerEvents = visible ? '' : 'none';
    applyToBody(function (body) {
      if (!body || !body.style) return;
      body.style.opacity = visible ? '1' : '0';
      body.style.pointerEvents = visible ? '' : 'none';
    });

    if (!visible) {
      hiddenOnce = true;
      safeCall('onClear', { reason: 'hidden' });
      return;
    }

    if (hiddenOnce && runtimeConfig.resetOnVisible) {
      hiddenOnce = false;
      location.reload();
    }
  }

  function dispatchConfig(config) {
    latestConfig = config || {};
    lastConfigAtUnixMs = Date.now();
    applySceneVisibility(latestConfig.sceneVisible !== false);
    applyPreviewBackground(latestConfig.testBackgroundColor);
    applyCommonLayout(latestConfig);
    updateResourceDebugPanel();
    safeCall('onConfig', latestConfig);
  }

  function dispatchMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'config':
        dispatchConfig(msg.data);
        break;
      case 'comments':
        safeCall('onComments', Array.isArray(msg.data) ? msg.data : []);
        break;
      case 'deleted':
        safeCall('onDeleted', msg.data || null);
        break;
      case 'clear':
        safeCall('onClear', { reason: 'server', data: msg.data || null });
        break;
    }
  }

  function closeEventSource() {
    if (!eventSource) return;
    try {
      eventSource.close();
    } catch (_err) {}
    eventSource = null;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectStream();
    }, 3000);
  }

  function connectStream() {
    closeEventSource();
    eventSource = new EventSource(runtimeConfig.streamUrl);
    eventSource.onopen = function () {
      if (everConnected) {
        location.reload();
        return;
      }
      everConnected = true;
    };
    eventSource.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_err) {
        return;
      }
      dispatchMessage(msg);
    };
    eventSource.onerror = function () {
      closeEventSource();
      scheduleReconnect();
    };
  }

  function normalizeListDirection(direction) {
    if (direction === 'prepend' || direction === 'down') return 'prepend';
    return 'append';
  }

  function setDataId(node, id) {
    if (!node || !id || !node.setAttribute) return;
    if (!node.getAttribute('data-id')) {
      node.setAttribute('data-id', id);
    }
  }

  /**
   * 要素に enter / leave transition を適用するヘルパー。
   * Vue の transition-group と同じ class 命名規則（`comment-enter-from`,
   * `comment-enter-active`, `comment-enter-to`, 同様の leave）を使い、
   * テンプレ側 CSS の transition 定義と連動させる。
   *
   * phase: 'enter' | 'leave'
   * onDone: transition 終了時に呼ばれる（leave で DOM 除去等）
   *
   * 既存 CSS に transition が定義されていなければ、class が付くだけで
   * 見た目の変化は起きない（既存テンプレへの後方互換）。
   */
  function runTransitionPhase(node, phase, onDone) {
    if (!node || !node.classList) {
      if (onDone) onDone();
      return;
    }
    var fromClass = 'comment-' + phase + '-from';
    var activeClass = 'comment-' + phase + '-active';
    var toClass = 'comment-' + phase + '-to';

    node.classList.add(fromClass);
    node.classList.add(activeClass);
    // 強制 reflow（from 状態を確定させる）
    void node.offsetWidth;

    requestAnimationFrame(function () {
      node.classList.remove(fromClass);
      node.classList.add(toClass);

      var finished = false;
      function cleanup() {
        if (finished) return;
        finished = true;
        node.classList.remove(activeClass);
        node.classList.remove(toClass);
        node.removeEventListener('transitionend', handleEnd);
        if (onDone) onDone();
      }
      function handleEnd(ev) {
        if (ev && ev.target !== node) return;
        cleanup();
      }
      node.addEventListener('transitionend', handleEnd);

      // transition-duration を読み取り、その値 + 余裕で fallback 終了
      var durationMs = readTransitionDurationMs(node);
      setTimeout(cleanup, durationMs + 120);
    });
  }

  function readTransitionDurationMs(node) {
    try {
      var cs = getComputedStyle(node);
      var values = (cs.transitionDuration || '').split(',');
      var max = 0;
      for (var i = 0; i < values.length; i += 1) {
        var token = values[i].trim();
        if (!token) continue;
        var ms = 0;
        if (token.endsWith('ms')) {
          ms = parseFloat(token);
        } else if (token.endsWith('s')) {
          ms = parseFloat(token) * 1000;
        }
        if (isFinite(ms) && ms > max) max = ms;
      }
      return max;
    } catch (_e) {
      return 0;
    }
  }

  /**
   * FLIP (First-Last-Invert-Play) で既存要素の位置変化を transition する。
   * captureRects は変更前の rect マップ。変更後の rect と比較して delta を
   * 計算し、各要素に一時的な transform を設定 → 次フレームで transform を
   * 空にして transition を起動する。
   *
   * テンプレ側 CSS で `.comment-move { transition: transform ... }` を
   * 定義しておけば、既存コメントが新コメント流入等で押し動かされる際の
   * 移動がスムーズにアニメーションする。
   */
  function captureChildRects(container) {
    var map = Object.create(null);
    if (!container || !container.children) return map;
    for (var i = 0; i < container.children.length; i += 1) {
      var child = container.children[i];
      if (child.getAttribute && (
        child.getAttribute('data-kh-overflow-leaving') === '1' ||
        child.getAttribute('data-kh-phase') === 'leaving'
      )) continue;
      var id = child.getAttribute && child.getAttribute('data-id');
      if (!id || typeof child.getBoundingClientRect !== 'function') continue;
      var r = child.getBoundingClientRect();
      map[id] = {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height
      };
    }
    return map;
  }

  function playFlipMove(container, priorRects) {
    if (!container || !container.children || !priorRects) return;
    var ids = Object.keys(priorRects);
    if (ids.length === 0) return;
    // Last: 新しい rect を取得し delta を計算
    var movers = [];
    for (var i = 0; i < container.children.length; i += 1) {
      var child = container.children[i];
      if (child.getAttribute && (
        child.getAttribute('data-kh-overflow-leaving') === '1' ||
        child.getAttribute('data-kh-phase') === 'leaving'
      )) continue;
      var id = child.getAttribute && child.getAttribute('data-id');
      if (!id) continue;
      var prev = priorRects[id];
      if (!prev) continue;
      var r = child.getBoundingClientRect();
      var dx = prev.x - r.left;
      var dy = prev.y - r.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      // Invert: transform で元の位置へ一時的に戻す
      child.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      child.style.transition = 'none';
      movers.push(child);
    }
    if (movers.length === 0) return;
    // Play: 次フレームで transform を解除して transition 起動
    requestAnimationFrame(function () {
      for (var j = 0; j < movers.length; j += 1) {
        var node = movers[j];
        node.classList.add('comment-move');
        node.style.transition = '';
        node.style.transform = '';
      }
      // transition 終了時に class / inline style を除去
      movers.forEach(function (node) {
        var done = false;
        function cleanup() {
          if (done) return;
          done = true;
          node.classList.remove('comment-move');
          node.removeEventListener('transitionend', handle);
        }
        function handle(ev) {
          if (ev && ev.target !== node) return;
          cleanup();
        }
        node.addEventListener('transitionend', handle);
        var durationMs = readTransitionDurationMs(node);
        setTimeout(cleanup, durationMs + 120);
      });
    });
  }

  function createListController(options) {
    options = options || {};
    var container = options.container;
    var maxComments = typeof options.maxComments === 'number' ? options.maxComments : Infinity;
    var direction = normalizeListDirection(options.direction);
    // animate: true （既定）でコメント流入 / 退場 / 押し動かされる移動に class を付与。
    // CSS 側で transition / animation が定義されていれば動作する（opt-in on CSS side）。
    // テンプレ側で無効化したい場合は options.animate: false を渡す。
    var animate = options.animate !== false;

    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('createListController requires a container element');
    }

    function trim() {
      // maxComments 超過の間引きは DOM 即除去。leave アニメーションは適用しない。
      // leave は対象要素を position: absolute で DOM 残留させる実装のため、
      // ここで使うと container.children.length が減らず無限ループに入る。
      // ユーザー操作由来の削除 (removeById) ではアニメーションありのため、
      // trim で間引かれるのは古いコメントが画面外に押し出される時のみであり、
      // アニメーション無しでも視覚的な違和感は小さい。
      while (container.children.length > maxComments) {
        var evictTarget = direction === 'prepend' ? container.lastChild : container.firstChild;
        if (!evictTarget) break;
        container.removeChild(evictTarget);
      }
    }

    function removeWithLeaveAnimation(node, priorRects) {
      // 2 度目呼び出し防止
      if (node.__khLeaving) return;
      node.__khLeaving = true;
      // container.children.length を即座に減らすため、対象を container から
      // detach して body 直下の position: fixed 要素としてアニメーション。
      // 残留方式 (position: absolute で container 内) だと children.length が
      // 減らず、maxComments 超過判定やテスト assertion で誤差になる。
      var rect = node.getBoundingClientRect();
      if (node.parentNode) node.parentNode.removeChild(node);
      node.style.position = 'fixed';
      node.style.top = rect.top + 'px';
      node.style.left = rect.left + 'px';
      node.style.width = rect.width + 'px';
      node.style.height = rect.height + 'px';
      node.style.margin = '0';
      node.style.zIndex = '0';
      node.style.pointerEvents = 'none';
      document.body.appendChild(node);

      runTransitionPhase(node, 'leave', function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      });
      // 他要素の位置変化を FLIP で transition
      if (priorRects) playFlipMove(container, priorRects);
    }

    return {
      setMaxComments: function (nextMaxComments) {
        if (typeof nextMaxComments === 'number' && isFinite(nextMaxComments) && nextMaxComments >= 0) {
          maxComments = nextMaxComments;
          trim();
        }
      },
      setDirection: function (nextDirection) {
        direction = normalizeListDirection(nextDirection);
        trim();
      },
      setAnimate: function (next) {
        animate = next !== false;
      },
      append: function (comment, renderFn) {
        if (typeof renderFn !== 'function') return null;

        // 同じ id のコメント要素が既に container 内にある場合は重複 append を
        // 防止する。YouTube 側が continuation 重複 / reconnect で同じ id を
        // 再送するケースで、DOM に同一コメントが 2 つ以上並びつつアニメが
        // 連続発火して上に上がり続ける事象の根本対処（先着優先）。
        // renderless 経路 (createRenderlessListController) は同等の仕組みを
        // 既に持つが、cellTemplate + list starter 経路はこの関数が唯一の
        // 要素追加経路なので、ここで duplicate 検出する。
        var dedupeId = comment && comment.id;
        if (dedupeId) {
          for (var i = 0; i < container.children.length; i += 1) {
            var child = container.children[i];
            if (child.getAttribute && child.getAttribute('data-id') === dedupeId) {
              return child;
            }
          }
        }

        var node = renderFn(comment);
        if (!node) return null;
        setDataId(node, comment && comment.id);

        // FLIP の First: 既存要素の rect を記録
        var priorRects = animate ? captureChildRects(container) : null;

        if (direction === 'prepend') {
          container.insertBefore(node, container.firstChild);
        } else {
          container.appendChild(node);
        }

        if (animate) {
          // 新要素の enter アニメーション
          runTransitionPhase(node, 'enter');
          // 既存要素の FLIP move（新要素を除く）
          if (priorRects) playFlipMove(container, priorRects);
        }

        trim();
        return node;
      },
      removeById: function (id) {
        if (!id) return null;
        var node = container.querySelector('[data-id="' + id + '"]');
        if (!node || node.parentNode !== container) {
          return node || null;
        }
        if (animate) {
          var priorRects = captureChildRects(container);
          removeWithLeaveAnimation(node, priorRects);
        } else {
          container.removeChild(node);
        }
        return node;
      },
      clear: function () {
        container.innerHTML = '';
      },
      trim: trim,
      getItems: function () {
        return Array.prototype.slice.call(container.children);
      }
    };
  }

  function normalizeAssetPath(value) {
    if (!value || typeof value !== 'string') return '';
    if (value.indexOf('/') === -1 && value.indexOf(':') === -1) {
      return 'assets/' + value;
    }
    return value;
  }

  function normalizeDelayMs(value, fallback) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      return fallback;
    }
    return value;
  }

  function resolveRenderlessLifecycleOptions(options) {
    var lifecycle = options && options.lifecycle && typeof options.lifecycle === 'object'
      ? options.lifecycle
      : {};
    return {
      enterActiveDelayMs: normalizeDelayMs(
        lifecycle.enterActiveDelayMs,
        normalizeDelayMs(options && options.enterActiveDelayMs, 0)
      ),
      leaveRemoveDelayMs: normalizeDelayMs(
        lifecycle.leaveRemoveDelayMs,
        normalizeDelayMs(options && options.leaveRemoveDelayMs, 180)
      )
    };
  }

  function resolveThemeAssetCssValue(value, options) {
    if (value == null || value === '') return '';
    options = options || {};
    var normalized = String(value).trim();
    if (!normalized) return '';
    if (/^none$/i.test(normalized) || /^url\(/i.test(normalized)) {
      return normalized;
    }
    if (options.normalizeAssetPath !== false) {
      normalized = normalizeAssetPath(normalized);
    }
    return 'url(' + JSON.stringify(normalized) + ')';
  }

  function applyRenderlessThemeAssets(node, model, options) {
    if (!node || !node.style) return;
    options = options || {};
    var prevVars = Array.isArray(node.__komehubThemeAssetVars)
      ? node.__komehubThemeAssetVars
      : [];
    prevVars.forEach(function (cssVarName) {
      if (cssVarName) node.style.removeProperty(cssVarName);
    });
    node.__komehubThemeAssetVars = [];
    var themeAssets = options.themeAssets;
    var themeKey = model && model.display && model.display.themeKey ? model.display.themeKey : '';
    if (!themeAssets || typeof themeAssets !== 'object') return;
    var commonMap = themeAssets._common && typeof themeAssets._common === 'object'
      ? themeAssets._common
      : null;
    var themeMap = themeKey && themeAssets[themeKey] && typeof themeAssets[themeKey] === 'object'
      ? themeAssets[themeKey]
      : null;
    if (!commonMap && !themeMap) return;
    var mergedMap = Object.assign({}, commonMap || {}, themeMap || {});
    var appliedVars = [];
    Object.keys(mergedMap).forEach(function (cssVarName) {
      if (!cssVarName || cssVarName.indexOf('--') !== 0) return;
      var cssValue = resolveThemeAssetCssValue(mergedMap[cssVarName], {
        normalizeAssetPath: options.normalizeAssetPath !== false
      });
      if (!cssValue) return;
      node.style.setProperty(cssVarName, cssValue);
      appliedVars.push(cssVarName);
    });
    node.__komehubThemeAssetVars = appliedVars;
  }

  function createImagePart(src, className, options) {
    if (!src) return null;
    options = options || {};
    var img = document.createElement('img');
    img.className = className;
    img.src = options.normalizeAssetPath ? normalizeAssetPath(src) : src;
    img.alt = options.alt != null ? options.alt : '';
    img.loading = options.loading || 'lazy';
    return img;
  }

  var parts = {
    createAvatar: function (comment, options) {
      options = options || {};
      return createImagePart(
        comment && comment.profileImage,
        options.className || 'avatar',
        { alt: options.alt, loading: options.loading || 'lazy' }
      );
    },
    createBadge: function (comment, options) {
      options = options || {};
      return createImagePart(
        comment && comment.memberBadgeUrl,
        options.className || 'badge',
        { alt: options.alt, loading: options.loading || 'lazy' }
      );
    },
    createName: function (comment, options) {
      options = options || {};
      var text = options.text != null ? options.text : (comment && comment.name) || '';
      if (!text) return null;
      var el = document.createElement(options.tagName || 'span');
      el.className = options.className || 'name';
      el.textContent = String(text);
      return el;
    },
    createAmount: function (comment, options) {
      options = options || {};
      var text = options.text != null
        ? options.text
        : (comment && (comment.amountDisplay || (comment.amount > 0 ? String(comment.amount) : '')));
      if (!text) return null;
      var el = document.createElement(options.tagName || 'span');
      el.className = options.className || 'amount';
      el.textContent = String(text);
      return el;
    },
    createText: function (comment, options) {
      options = options || {};
      var text = comment && comment.comment;
      var html = comment && comment.commentHtml;
      if (!text && !html) return null;
      var el = document.createElement(options.tagName || 'span');
      el.className = options.className || 'text';
      if (html && options.preferHtml !== false) {
        el.innerHTML = html;
      } else {
        el.textContent = text || '';
      }
      return el;
    },
    createSticker: function (comment, options) {
      options = options || {};
      return createImagePart(
        comment && comment.stickerImage,
        options.className || 'sticker',
        { alt: options.alt || 'sticker', loading: options.loading || 'lazy' }
      );
    }
  };

  var configHelpers = {
    setVar: function (target, name, value) {
      if (!target || !target.style || !name) return;
      if (value == null || value === '') {
        target.style.removeProperty(name);
        return;
      }
      target.style.setProperty(name, String(value));
    },
    setPxVar: function (target, name, value) {
      if (value == null || value === '') {
        configHelpers.setVar(target, name, null);
        return;
      }
      configHelpers.setVar(target, name, String(value) + 'px');
    },
    toggleClass: function (target, className, enabled) {
      if (!target || !target.classList || !className) return;
      target.classList.toggle(className, !!enabled);
    },
    setBackgroundImage: function (target, value, options) {
      if (!target || !target.style) return;
      options = options || {};
      if (!value) {
        target.style.backgroundImage = '';
        if (options.clearPresentation !== false) {
          target.style.backgroundSize = '';
          target.style.backgroundPosition = '';
          target.style.backgroundRepeat = '';
        }
        return;
      }
      var url = options.normalizeAssetPath === false ? value : normalizeAssetPath(value);
      target.style.backgroundImage = 'url(' + url + ')';
      if (options.size) target.style.backgroundSize = options.size;
      if (options.position) target.style.backgroundPosition = options.position;
      if (options.repeat) target.style.backgroundRepeat = options.repeat;
    }
  };

  function resolveStarterTarget(target, context) {
    if (!target) return null;
    if (target === 'root') return context.root;
    if (target === 'body') return context.body;
    if (target === 'container') return context.container;
    if (target === 'track') return context.track;
    if (typeof target === 'string') return document.querySelector(target);
    return target;
  }

  function ensureStyleTag(id) {
    var styleId = id || 'komehub-config';
    var existing = document.getElementById(styleId);
    if (existing) return existing;
    var style = document.createElement('style');
    style.id = styleId;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function applyCommonFontSettings(starter, config) {
    if (!starter) return;
    var root = starter.root || document.documentElement;
    var styleId = (starter.styleId || 'komehub-config') + '-font-compat';
    var styleTag = starter.fontCompatStyleTag || ensureStyleTag(styleId);
    starter.fontCompatStyleTag = styleTag;
    // config で明示された場合のみ CSS 変数と !important font-family を注入する。
    // 無指定時に `inherit !important` で常時上書きすると、テンプレ側の `.comment .name`
    // / `.comment .text` への font-family 指定が通らなくなる（chat-plastic 等で顕在化）。
    var hasNameFont = !!(config && config.nameFont);
    var hasTextFont = !!(config && config.textFont);
    configHelpers.setVar(root, '--name-font-family', hasNameFont ? config.nameFont : null);
    configHelpers.setVar(root, '--text-font-family', hasTextFont ? config.textFont : null);
    var css = '';
    if (hasNameFont) {
      css += '.comment .name{font-family:var(--name-font-family) !important;}\n';
    }
    if (hasTextFont) {
      css += '.comment .text{font-family:var(--text-font-family) !important;}';
    }
    styleTag.textContent = css;
  }

  function createDevPreviewController(options) {
    options = options || {};
    var scenarios = Array.isArray(options.scenarios) ? options.scenarios.slice() : [];
    var activeId = options.initialScenarioId || (scenarios[0] && scenarios[0].id) || '';
    var panel = null;

    function isEnabled() {
      return !!(runtimeConfig.preview && runtimeConfig.devPreview);
    }

    function findScenario(target) {
      if (!target) return null;
      if (typeof target === 'object') return target;
      for (var i = 0; i < scenarios.length; i += 1) {
        if (scenarios[i] && scenarios[i].id === target) return scenarios[i];
      }
      return null;
    }

    function renderPanel() {
      if (!panel) return;
      panel.innerHTML = '';
      var title = document.createElement('div');
      title.className = 'komehub-dev-preview-title';
      title.textContent = options.title || 'Dev Preview';
      panel.appendChild(title);

      var row = document.createElement('div');
      row.className = 'komehub-dev-preview-actions';
      scenarios.forEach(function (scenario) {
        if (!scenario || !scenario.id) return;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'komehub-dev-preview-button';
        if (scenario.id === activeId) button.classList.add('is-active');
        button.textContent = scenario.label || scenario.id;
        button.addEventListener('click', function () {
          applyScenario(scenario.id);
        });
        row.appendChild(button);
      });
      panel.appendChild(row);
    }

    function ensurePanel() {
      if (!isEnabled()) return null;
      if (panel) return panel;
      panel = document.createElement('div');
      panel.className = 'komehub-dev-preview-panel';
      panel.setAttribute('data-komehub-dev-preview', 'true');
      applyToBody(function (body) {
        if (!body || !panel || panel.parentNode) return;
        if (body.classList) body.classList.add('komehub-dev-preview-enabled');
        body.appendChild(panel);
        renderPanel();
      });
      return panel;
    }

    function applyScenario(target) {
      var scenario = findScenario(target);
      if (!scenario) return null;
      activeId = scenario.id;
      renderPanel();
      if (typeof options.onSelect === 'function') {
        options.onSelect(scenario, getContext());
      }
      return scenario;
    }

    ensurePanel();
    if (isEnabled() && activeId) {
      setTimeout(function () {
        applyScenario(activeId);
      }, 0);
    }

    return {
      enabled: isEnabled(),
      getScenarios: function () { return scenarios.slice(); },
      applyScenario: applyScenario,
      mount: ensurePanel
    };
  }

  function resolveCellTemplateSource(source) {
    if (!source) return null;
    if (typeof source === 'string') {
      return document.querySelector(source);
    }
    return source;
  }

  function compileCellTemplate(source) {
    var resolved = resolveCellTemplateSource(source);
    if (!resolved) {
      throw new Error('cellTemplate source not found');
    }
    if (resolved.tagName && resolved.tagName.toLowerCase() === 'template') {
      return { kind: 'template', node: resolved };
    }
    return { kind: 'element', node: resolved };
  }

  function cloneCellTemplateRoot(compiled) {
    if (!compiled || !compiled.node) return null;
    var fragment;
    if (compiled.kind === 'template') {
      fragment = compiled.node.content.cloneNode(true);
    } else {
      var wrapper = document.createElement('div');
      wrapper.appendChild(compiled.node.cloneNode(true));
      fragment = wrapper;
    }
    var elementCount = 0;
    var root = null;
    var childNodes = fragment.childNodes || [];
    for (var i = 0; i < childNodes.length; i += 1) {
      var child = childNodes[i];
      if (child && child.nodeType === 1) {
        elementCount += 1;
        root = child;
      }
    }
    if (elementCount !== 1 || !root) {
      throw new Error('cellTemplate requires exactly one root element');
    }
    return root;
  }

  function normalizeCellTemplateEmptyMode(mode) {
    if (mode === 'hide' || mode === 'keep' || mode === 'remove') return mode;
    return 'remove';
  }

  function revealCellTemplateNode(node) {
    if (!node) return;
    if (node.style) node.style.removeProperty('display');
    if (node.removeAttribute) node.removeAttribute('aria-hidden');
  }

  function applyCellTemplateEmptyState(node, mode) {
    if (!node) return false;
    var emptyMode = normalizeCellTemplateEmptyMode(mode);
    if (emptyMode === 'remove') {
      if (node.remove) node.remove();
      return false;
    }
    if (emptyMode === 'hide') {
      if (node.style) node.style.display = 'none';
      if (node.setAttribute) node.setAttribute('aria-hidden', 'true');
      return false;
    }
    revealCellTemplateNode(node);
    return false;
  }

  function setCellTemplateImage(node, value, alt, options) {
    if (!node) return false;
    options = options || {};
    if (!value) {
      if (node.tagName && node.tagName.toLowerCase() === 'img') {
        if (node.removeAttribute) node.removeAttribute('src');
        node.alt = '';
      } else if (node.style) {
        node.style.backgroundImage = '';
      }
      return applyCellTemplateEmptyState(node, options.emptyMode);
    }
    revealCellTemplateNode(node);
    if (node.tagName && node.tagName.toLowerCase() === 'img') {
      node.src = value;
      node.alt = alt || '';
    } else {
      node.style.backgroundImage = 'url(' + value + ')';
    }
    return true;
  }

  function setCellTemplateText(node, value, options) {
    if (!node) return false;
    options = options || {};
    if (value == null || value === '') {
      if (options.html) {
        if (node.innerHTML !== '') node.innerHTML = '';
      } else {
        if (node.textContent !== '') node.textContent = '';
      }
      node.__khLastHtmlValue = '';
      return applyCellTemplateEmptyState(node, options.emptyMode);
    }
    revealCellTemplateNode(node);
    var nextValue = String(value);
    if (options.html) {
      // 値が直前と同じなら innerHTML を再代入しない。
      // 同じ HTML でも innerHTML を代入すると DOM が再生成され、子の
      // <span class="typing-char"> 等の CSS animation が初回扱いで再生される。
      if (node.__khLastHtmlValue !== nextValue) {
        node.innerHTML = nextValue;
        node.__khLastHtmlValue = nextValue;
      }
    } else {
      if (node.__khLastHtmlValue !== nextValue) {
        node.textContent = nextValue;
        node.__khLastHtmlValue = nextValue;
      }
    }
    return true;
  }

  function setCellTemplateAttribute(node, attrName, value, options) {
    if (!node || !attrName) return false;
    options = options || {};
    var normalizedAttr = String(attrName);
    if (value == null || value === '') {
      if (normalizedAttr === 'html') node.innerHTML = '';
      else if (normalizedAttr === 'text') node.textContent = '';
      else if (normalizedAttr === 'background-image' || normalizedAttr === 'style.backgroundImage') {
        if (node.style) node.style.backgroundImage = '';
      } else if (node.removeAttribute) {
        node.removeAttribute(normalizedAttr);
      }
      return applyCellTemplateEmptyState(node, options.emptyMode);
    }
    revealCellTemplateNode(node);
    if (normalizedAttr === 'html') {
      return setCellTemplateText(node, value, { html: true, emptyMode: options.emptyMode });
    }
    if (normalizedAttr === 'text') {
      return setCellTemplateText(node, value, { html: false, emptyMode: options.emptyMode });
    }
    if (normalizedAttr === 'background-image' || normalizedAttr === 'style.backgroundImage') {
      if (node.style) node.style.backgroundImage = 'url(' + value + ')';
      return true;
    }
    if (node.setAttribute) node.setAttribute(normalizedAttr, String(value));
    return true;
  }

  function getObjectValueByPath(source, path) {
    if (!source || !path || typeof path !== 'string') return undefined;
    if (Object.prototype.hasOwnProperty.call(source, path)) return source[path];
    if (path.indexOf('.') === -1) return source[path];
    var parts = path.split('.');
    var current = source;
    for (var i = 0; i < parts.length; i += 1) {
      var key = parts[i];
      if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
        return undefined;
      }
      current = current[key];
    }
    return current;
  }

  function getCellTemplateFieldValue(comment, field) {
    if (!comment || !field) return null;
    switch (field) {
      case 'name':
        return comment.name || '';
      case 'text':
        return comment.commentHtml || comment.comment || '';
      case 'amount':
        return comment.amountDisplay || (comment.amount > 0 ? String(comment.amount) : '');
      case 'membershipHeader':
        return comment.membershipHeader || '';
      case 'timestamp':
        return comment.timestamp || '';
      case 'giftCount':
        return comment.giftCount > 0 ? String(comment.giftCount) : '';
      case 'avatar':
        return comment.profileImage || '';
      case 'badge':
        return comment.memberBadgeUrl || '';
      case 'sticker':
        return comment.stickerImage || '';
      default:
        var value = getObjectValueByPath(comment, field);
        return value == null ? null : value;
    }
  }

  function decorateCellTemplateRoot(node, comment) {
    if (!node || !node.classList) return;
    var isSuperchat = !!(comment && comment.amount > 0);
    var isMembership = !!(comment && comment.isMembership && !isSuperchat);
    var isMembershipGift = !!(comment && comment.isMembershipGift);
    var isMembershipGiftRedemption = !!(comment && comment.isMembershipGiftRedemption);
    var tier = (comment && comment.superchatTier) || 'blue';
    var hasAvatar = !!(comment && comment.profileImage);
    var hasBadge = !!(comment && comment.memberBadgeUrl);
    var hasAmount = !!(comment && (comment.amountDisplay || comment.amount > 0));
    var hasText = !!(comment && (comment.commentHtml || comment.comment));
    var hasSticker = !!(comment && comment.stickerImage);
    var hasMembershipHeader = !!(comment && comment.membershipHeader);

    node.classList.add('kh-comment');
    node.classList.toggle('is-superchat', isSuperchat);
    node.classList.toggle('is-membership', isMembership);
    node.classList.toggle('is-membership-gift', isMembershipGift);
    node.classList.toggle('is-gift-redemption', isMembershipGiftRedemption);
    node.classList.toggle('is-member', !!(comment && comment.isMember));
    node.classList.toggle('is-moderator', !!(comment && comment.isModerator));
    node.classList.toggle('is-owner', !!(comment && comment.isOwner));
    node.classList.toggle('is-verified', !!(comment && comment.isVerified));
    node.classList.toggle('has-avatar', hasAvatar);
    node.classList.toggle('has-badge', hasBadge);
    node.classList.toggle('has-amount', hasAmount);
    node.classList.toggle('has-text', hasText);
    node.classList.toggle('has-sticker', hasSticker);
    node.classList.toggle('has-membership-header', hasMembershipHeader);
    node.classList.toggle('tier-blue', tier === 'blue');
    node.classList.toggle('tier-teal', tier === 'teal');
    node.classList.toggle('tier-green', tier === 'green');
    node.classList.toggle('tier-yellow', tier === 'yellow');
    node.classList.toggle('tier-orange', tier === 'orange');
    node.classList.toggle('tier-magenta', tier === 'magenta');
    node.classList.toggle('tier-red', tier === 'red');
    node.setAttribute('data-kh-kind', isMembershipGiftRedemption ? 'giftRedemption' : (isMembershipGift ? 'membershipGift' : (isSuperchat ? 'superchat' : (isMembership ? 'membership' : 'comment'))));
    node.setAttribute('data-kh-superchat-tier', tier);
    node.setAttribute('data-kh-gift-count', String((comment && comment.giftCount) || 0));
    node.setAttribute('data-kh-listener-status', (comment && comment.listenerStatus) || '');
    node.setAttribute('data-kh-listener-tag', (comment && comment.listenerTag) || '');
    node.setAttribute('data-kh-has-prior-listener-comment', comment && comment.hasPriorListenerComment ? 'true' : 'false');
    node.setAttribute('data-kh-is-first-comment-in-stream', comment && comment.isFirstCommentInStream ? 'true' : 'false');
    node.setAttribute('data-kh-listener-previous-stream-last-seen-at', (comment && comment.listenerPreviousStreamLastSeenAt) || '');
  }

  function collectCellTemplateBindingNodes(root) {
    if (!root) return [];
    var nodes = [];
    if (root.getAttribute && root.getAttribute('data-kh')) nodes.push(root);
    var descendants = root.querySelectorAll ? root.querySelectorAll('[data-kh]') : [];
    for (var i = 0; i < descendants.length; i += 1) {
      nodes.push(descendants[i]);
    }
    return nodes;
  }

  function populateCellTemplateRoot(root, comment, options) {
    if (!root) return root;
    options = options || {};
    var commentData = comment || {};
    decorateCellTemplateRoot(root, commentData);
    var nodes = collectCellTemplateBindingNodes(root);
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var field = node.getAttribute('data-kh');
      var sourceField = node.getAttribute('data-kh-source') || field;
      var emptyMode = normalizeCellTemplateEmptyMode(node.getAttribute('data-kh-empty') || options.defaultEmptyMode);
      var attrName = node.getAttribute('data-kh-attr') || '';
      var mode = (node.getAttribute('data-kh-mode') || '').toLowerCase();
      var value = getCellTemplateFieldValue(commentData, sourceField);
      if (typeof options.transformValue === 'function') {
        value = options.transformValue({
          field: field,
          sourceField: sourceField,
          value: value,
          comment: commentData,
          node: node
        });
      }
      if (value != null && value !== '') {
        var prefix = node.getAttribute('data-kh-prefix');
        var suffix = node.getAttribute('data-kh-suffix');
        if (prefix) value = String(prefix) + value;
        if (suffix) value = value + String(suffix);
      }
      if (attrName) {
        setCellTemplateAttribute(node, attrName, value, {
          emptyMode: emptyMode
        });
        continue;
      }
      switch (sourceField) {
        case 'avatar':
          setCellTemplateImage(node, value, 'avatar', { emptyMode: emptyMode });
          break;
        case 'badge':
          setCellTemplateImage(node, value, 'badge', { emptyMode: emptyMode });
          break;
        case 'sticker':
          setCellTemplateImage(node, value, 'sticker', { emptyMode: emptyMode });
          break;
        case 'text':
          setCellTemplateText(node, value, {
            html: mode === 'html' || (mode !== 'plain' && !!commentData.commentHtml),
            emptyMode: emptyMode
          });
          break;
        default:
          setCellTemplateText(node, value, {
            html: mode === 'html',
            emptyMode: emptyMode
          });
          break;
      }
    }
    return root;
  }

  function createCellTemplateRenderer(source, options) {
    var compiled = compileCellTemplate(source);
    return function renderCellTemplate(comment) {
      var root = cloneCellTemplateRoot(compiled);
      return populateCellTemplateRoot(root, comment || {}, options || {});
    };
  }

  function applyConfigBindings(config, bindings, helpers) {
    if (!Array.isArray(bindings) || bindings.length === 0) return;
    bindings.forEach(function (binding) {
      if (!binding || !binding.kind) return;
      var value = binding.key != null ? config[binding.key] : undefined;
      var target = resolveStarterTarget(binding.target, helpers);
      switch (binding.kind) {
        case 'maxComments':
          if (helpers.list && value != null) {
            helpers.list.setMaxComments(value);
          }
          if (helpers.ticker && typeof helpers.ticker.setMaxComments === 'function' && value != null) {
            helpers.ticker.setMaxComments(value);
          }
          break;
        case 'direction':
          if (helpers.list && value != null) {
            helpers.list.setDirection(value);
          }
          break;
        case 'cssVar':
          if (value != null) {
            if (binding.unit) {
              configHelpers.setVar(target, binding.name, String(value) + binding.unit);
            } else {
              configHelpers.setVar(target, binding.name, value);
            }
          }
          break;
        case 'toggleCssVar':
          if (value != null) {
            configHelpers.setVar(target, binding.name, value ? binding.trueValue : binding.falseValue);
          }
          break;
        case 'toggleClass':
          if (value != null) {
            configHelpers.toggleClass(target, binding.className, binding.invert ? !value : value);
          }
          break;
        case 'valueClass':
          if (value != null) {
            configHelpers.toggleClass(target, binding.className, value === binding.activeValue);
          }
          break;
        case 'backgroundImage':
          if (value != null) {
            configHelpers.setBackgroundImage(target, value, {
              size: binding.size,
              position: binding.position,
              repeat: binding.repeat,
              clearPresentation: binding.clearPresentation !== false,
              normalizeAssetPath: binding.normalizeAssetPath !== false
            });
          }
          break;
        case 'customCss':
          helpers.styleTag = helpers.styleTag || ensureStyleTag(binding.styleId || helpers.styleId);
          helpers.styleTag.textContent = value ? String(value) : '';
          break;
        case 'callback':
          if (typeof binding.handler === 'function') {
            binding.handler(value, config, helpers);
          }
          break;
      }
    });
  }

  function createStarterBindingsApi() {
    return {
      maxComments: function (key) {
        return { kind: 'maxComments', key: key || 'maxComments' };
      },
      direction: function (key) {
        return { kind: 'direction', key: key || 'direction' };
      },
      cssVar: function (key, name, unit, target) {
        return {
          kind: 'cssVar',
          key: key,
          name: name,
          unit: unit || '',
          target: target || 'root'
        };
      },
      toggleCssVar: function (key, name, trueValue, falseValue, target) {
        return {
          kind: 'toggleCssVar',
          key: key,
          name: name,
          trueValue: trueValue,
          falseValue: falseValue,
          target: target || 'root'
        };
      },
      valueClass: function (key, className, activeValue, target) {
        return {
          kind: 'valueClass',
          key: key,
          className: className,
          activeValue: activeValue,
          target: target || 'container'
        };
      },
      toggleClass: function (key, className, target, invert) {
        return {
          kind: 'toggleClass',
          key: key,
          className: className,
          target: target || 'container',
          invert: !!invert
        };
      },
      backgroundImage: function (key, target, options) {
        options = options || {};
        return {
          kind: 'backgroundImage',
          key: key || 'backgroundImage',
          target: target || 'body',
          size: options.size || '',
          position: options.position || '',
          repeat: options.repeat || '',
          clearPresentation: options.clearPresentation !== false,
          normalizeAssetPath: options.normalizeAssetPath !== false
        };
      },
      customCss: function (key, styleId) {
        return {
          kind: 'customCss',
          key: key || 'customCss',
          styleId: styleId || ''
        };
      },
      callback: function (key, handler) {
        return {
          kind: 'callback',
          key: key,
          handler: handler
        };
      }
    };
  }

  function normalizeStarterConfigBindings(options) {
    options = options || {};
    var bindings = [];
    if (Array.isArray(options.configBindings)) {
      bindings = bindings.concat(options.configBindings);
    }

    var config = options.config;
    if (!config || typeof config !== 'object') {
      return bindings;
    }

    function appendCssVars(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var value = map[key];
        if (typeof value === 'string') {
          bindings.push(api.bindings.cssVar(key, value));
          return;
        }
        if (Array.isArray(value) && value.length > 0) {
          bindings.push(api.bindings.cssVar(key, value[0], value[1], value[2]));
        }
      });
    }

    function appendToggleCssVars(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var value = map[key];
        if (!Array.isArray(value) || value.length < 3) return;
        bindings.push(api.bindings.toggleCssVar(key, value[0], value[1], value[2], value[3]));
      });
    }

    function appendToggleClasses(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var value = map[key];
        if (typeof value === 'string') {
          bindings.push(api.bindings.toggleClass(key, value));
          return;
        }
        if (Array.isArray(value) && value.length > 0) {
          bindings.push(api.bindings.toggleClass(key, value[0], value[1], value[2]));
        }
      });
    }

    function appendDirectionClasses(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var value = map[key];
        if (typeof value === 'string') {
          bindings.push(api.bindings.valueClass(key, value, 'down'));
          return;
        }
        if (Array.isArray(value) && value.length > 0) {
          bindings.push(api.bindings.valueClass(
            key,
            value[0],
            value.length > 2 ? value[2] : 'down',
            value[1]
          ));
        }
      });
    }

    function appendBackgroundImages(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var value = map[key];
        if (typeof value === 'string') {
          bindings.push(api.bindings.backgroundImage(key, value));
          return;
        }
        if (Array.isArray(value) && value.length > 0) {
          bindings.push(api.bindings.backgroundImage(key, value[0], {
            size: value[1],
            position: value[2],
            repeat: value[3],
            clearPresentation: value.length > 4 ? value[4] : true,
            normalizeAssetPath: value.length > 5 ? value[5] : true
          }));
        }
      });
    }

    function appendCallbacks(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        if (typeof map[key] === 'function') {
          bindings.push(api.bindings.callback(key, map[key]));
        }
      });
    }

    if (config.maxComments) {
      bindings.push(api.bindings.maxComments(
        typeof config.maxComments === 'string' ? config.maxComments : undefined
      ));
    }
    if (config.direction) {
      bindings.push(api.bindings.direction(
        typeof config.direction === 'string' ? config.direction : undefined
      ));
    }
    appendCssVars(config.cssVars);
    appendToggleCssVars(config.toggleCssVars);
    appendToggleClasses(config.toggleClasses);
    appendDirectionClasses(config.directionClasses);
    appendBackgroundImages(config.backgroundImages);
    appendCallbacks(config.callbacks);
    if (config.customCss) {
      bindings.push(api.bindings.customCss(
        typeof config.customCss === 'string' ? config.customCss : undefined,
        config.styleId
      ));
    }

    return bindings;
  }

  function createStarterBase(options) {
    options = options || {};
    var context = getContext();
    var container = resolveStarterTarget(options.container || '#comments', context);
    var styleTag = options.styleId ? ensureStyleTag(options.styleId) : null;
    return {
      runtime: api,
      root: context.root,
      body: context.body,
      container: container,
      styleTag: styleTag,
      fontCompatStyleTag: ensureStyleTag((options.styleId || 'komehub-config') + '-font-compat'),
      styleId: options.styleId || '',
      configBindings: normalizeStarterConfigBindings(options)
    };
  }

  function shallowMergeRenderlessModelPatch(baseModel, patch) {
    if (!patch || typeof patch !== 'object') return baseModel;
    var nextModel = Object.assign({}, baseModel);
    ['display', 'flags', 'state', 'meta'].forEach(function (key) {
      nextModel[key] = Object.assign({}, baseModel[key] || {});
    });
    Object.keys(patch).forEach(function (key) {
      var value = patch[key];
      if (key === 'display' || key === 'flags' || key === 'state' || key === 'meta') {
        nextModel[key] = Object.assign({}, nextModel[key] || {}, value || {});
        return;
      }
      nextModel[key] = value;
    });
    return nextModel;
  }

  function sanitizeRenderlessComparableValue(value) {
    if (value == null) return value;
    if (Array.isArray(value)) {
      return value.map(sanitizeRenderlessComparableValue);
    }
    if (typeof value === 'object') {
      var next = {};
      Object.keys(value).forEach(function (key) {
        // 描画と無関係な internal メタは equality 比較から除外する。
        // - updatedAtMs / version: 更新ごとに変わる
        // - _komehubTrace: デバッグ用
        // - order: orderedIds.length に依存して変わる (新着コメント到着で全既存
        //   エントリの order が "ずれる" わけではないが、同じ id が再 upsert
        //   される replay 経路で context.nextOrder が変わり、model 等しくない
        //   判定 → 再 bind → typing animation 再生という不具合が起きる)
        if (key === 'updatedAtMs' || key === 'version' || key === '_komehubTrace' || key === 'order') return;
        next[key] = sanitizeRenderlessComparableValue(value[key]);
      });
      return next;
    }
    return value;
  }

  function isRenderlessModelRenderEqual(prevModel, nextModel) {
    if (!prevModel || !nextModel) return false;
    try {
      return JSON.stringify(sanitizeRenderlessComparableValue(prevModel)) ===
        JSON.stringify(sanitizeRenderlessComparableValue(nextModel));
    } catch (_err) {
      return false;
    }
  }

  function buildDefaultRenderlessFlags(rawComment) {
    rawComment = rawComment || {};
    return {
      isSuperchat: !!(rawComment.amount > 0),
      isMembership: !!rawComment.isMembership,
      isMembershipGift: !!rawComment.isMembershipGift,
      isMembershipGiftRedemption: !!rawComment.isMembershipGiftRedemption,
      isOwner: !!rawComment.isOwner,
      isModerator: !!rawComment.isModerator,
      isVerified: !!rawComment.isVerified,
      hasPriorListenerComment: !!rawComment.hasPriorListenerComment,
      isFirstCommentInStream: !!rawComment.isFirstCommentInStream,
      isFirstTimeListener: !!rawComment.isFirstTimeListener,
      isReturningListener: !!rawComment.isReturningListener,
      isRegularListener: !!rawComment.isRegularListener,
      isRegularArrival: !!rawComment.isRegularArrival,
      hasText: !!(rawComment.commentHtml || rawComment.comment),
      hasAmount: !!(rawComment.amountDisplay || rawComment.amount > 0),
      hasSticker: !!rawComment.stickerImage
    };
  }

  function buildDefaultRenderlessModel(rawComment, prevModel, context) {
    rawComment = rawComment || {};
    prevModel = prevModel || null;
    var nowMs = context && typeof context.nowMs === 'number' ? context.nowMs : Date.now();
    var createdAtMs = prevModel && prevModel.meta && typeof prevModel.meta.createdAtMs === 'number'
      ? prevModel.meta.createdAtMs
      : nowMs;
    var rawCopy = cloneJson(rawComment);
    return Object.assign({}, rawCopy, {
      id: rawComment.id || (prevModel && prevModel.id) || '',
      raw: rawCopy,
      display: {
        text: rawComment.comment || '',
        html: rawComment.commentHtml || rawComment.comment || '',
        prefix: '',
        themeKey: prevModel && prevModel.display ? prevModel.display.themeKey || '' : '',
        assetVariant: prevModel && prevModel.display ? prevModel.display.assetVariant || '' : ''
      },
      flags: Object.assign({}, buildDefaultRenderlessFlags(rawComment), prevModel && prevModel.flags ? prevModel.flags : {}),
      state: {
        phase: prevModel && prevModel.state ? prevModel.state.phase || 'active' : (context && context.isNew ? 'entering' : 'active')
      },
      meta: Object.assign({}, prevModel && prevModel.meta ? prevModel.meta : {}, {
        createdAtMs: createdAtMs,
        updatedAtMs: nowMs,
        order: context && typeof context.nextOrder === 'number' ? context.nextOrder : 0,
        version: prevModel && prevModel.meta && typeof prevModel.meta.version === 'number'
          ? prevModel.meta.version + 1
          : 1
      })
    });
  }

  function applyRenderlessModelMetadata(node, model) {
    if (!node || !model) return;
    var phase = model.state && model.state.phase ? model.state.phase : 'active';
    var themeKey = model.display && model.display.themeKey ? model.display.themeKey : '';
    if (node.setAttribute) {
      node.setAttribute('data-kh-id', model.id || '');
      node.setAttribute('data-kh-phase', phase);
      if (themeKey) node.setAttribute('data-kh-theme', themeKey);
      else node.removeAttribute('data-kh-theme');
    }
    if (!node.classList) return;
    node.classList.add('kh-comment');
    node.classList.toggle('is-entering', phase === 'entering');
    node.classList.toggle('is-active', phase === 'active');
    node.classList.toggle('is-leaving', phase === 'leaving');
  }

  function createRenderlessEffectScheduler(getEntry, sharedContextGetter) {
    var recordsByCommentId = {};

    function getSharedContext() {
      if (typeof sharedContextGetter !== 'function') return {};
      return sharedContextGetter() || {};
    }

    function getCommentRecords(commentId, createIfMissing) {
      if (!commentId) return null;
      if (!recordsByCommentId[commentId] && createIfMissing) {
        recordsByCommentId[commentId] = {};
      }
      return recordsByCommentId[commentId] || null;
    }

    function dropCommentRecordsIfEmpty(commentId) {
      var records = getCommentRecords(commentId, false);
      if (!records || Object.keys(records).length > 0) return;
      delete recordsByCommentId[commentId];
    }

    function buildEffectContext(commentId, effectKey, node, extra) {
      var entry = typeof getEntry === 'function' ? getEntry(commentId) : null;
      var context = Object.assign({}, getSharedContext(), extra || {});
      context.commentId = commentId || '';
      context.effectKey = effectKey || '';
      context.node = node || (entry && entry.node ? entry.node : null);
      context.model = context.model || (entry && entry.model ? entry.model : null);
      context.phase = context.phase || (context.model && context.model.state ? context.model.state.phase || '' : '');
      return context;
    }

    function cleanupRecord(commentId, effectKey, record, extra) {
      if (!record || typeof record.cleanup !== 'function') return;
      try {
        record.cleanup(buildEffectContext(commentId, effectKey, extra && extra.node, extra));
      } catch (err) {
        console.warn('[KomehubTemplateRuntime] effect cleanup failed', effectKey, err);
      }
    }

    function cleanupEffect(commentId, effectKey, extra) {
      var records = getCommentRecords(commentId, false);
      if (!records || !records[effectKey]) return false;
      var record = records[effectKey];
      delete records[effectKey];
      cleanupRecord(commentId, effectKey, record, extra);
      dropCommentRecordsIfEmpty(commentId);
      return true;
    }

    function cleanupComment(commentId, extra) {
      var records = getCommentRecords(commentId, false);
      if (!records) return;
      Object.keys(records).forEach(function (effectKey) {
        cleanupEffect(commentId, effectKey, extra);
      });
    }

    function cleanupAll(extra) {
      Object.keys(recordsByCommentId).forEach(function (commentId) {
        cleanupComment(commentId, extra);
      });
    }

    function normalizeEffectRecord(result) {
      if (typeof result === 'function') {
        return { cleanup: result };
      }
      if (result && typeof result === 'object') {
        return {
          cleanup: typeof result.cleanup === 'function' ? result.cleanup : null,
          onPhaseChange: typeof result.onPhaseChange === 'function' ? result.onPhaseChange : null
        };
      }
      return {};
    }

    function registerEffect(commentId, node, effectKey, setup) {
      if (!commentId || !effectKey || typeof setup !== 'function') return null;
      cleanupEffect(commentId, effectKey, {
        node: node,
        reason: 'replace'
      });
      var setupContext = buildEffectContext(commentId, effectKey, node, {
        reason: 'bind'
      });
      var record = normalizeEffectRecord(setup(setupContext));
      getCommentRecords(commentId, true)[effectKey] = record;
      return setupContext;
    }

    function notifyPhaseChange(commentId, prevPhase, nextPhase, extra) {
      var records = getCommentRecords(commentId, false);
      if (!records) return;
      Object.keys(records).forEach(function (effectKey) {
        var record = records[effectKey];
        if (!record || typeof record.onPhaseChange !== 'function') return;
        try {
          record.onPhaseChange(prevPhase, nextPhase, buildEffectContext(commentId, effectKey, extra && extra.node, Object.assign({}, extra, {
            prevPhase: prevPhase,
            nextPhase: nextPhase
          })));
        } catch (err) {
          console.warn('[KomehubTemplateRuntime] effect phase handler failed', effectKey, err);
        }
      });
    }

    function createEffectsApi(commentId, node) {
      function normalizePhaseList(value) {
        if (!Array.isArray(value)) return [];
        return value.filter(Boolean).map(function (item) { return String(item); });
      }

      return {
        register: function (effectKey, setup) {
          return registerEffect(commentId, node, effectKey, setup);
        },
        addClass: function (effectKey, className, options) {
          options = options || {};
          var removeOnPhases = normalizePhaseList(options.removeOnPhases);
          return registerEffect(commentId, node, effectKey, function (effectContext) {
            if (effectContext.node && effectContext.node.classList && className) {
              effectContext.node.classList.add(className);
            }
            return {
              cleanup: function (cleanupContext) {
                if (cleanupContext.node && cleanupContext.node.classList && className) {
                  cleanupContext.node.classList.remove(className);
                }
                if (typeof options.onCleanup === 'function') {
                  options.onCleanup(cleanupContext);
                }
              },
              onPhaseChange: function (prevPhase, nextPhase, phaseContext) {
                if (removeOnPhases.indexOf(String(nextPhase || '')) !== -1
                  && phaseContext.node && phaseContext.node.classList && className) {
                  phaseContext.node.classList.remove(className);
                }
                if (typeof options.onPhaseChange === 'function') {
                  options.onPhaseChange(prevPhase, nextPhase, phaseContext);
                }
              }
            };
          });
        },
        setTimeout: function (effectKey, delayMs, handler) {
          return registerEffect(commentId, node, effectKey, function (effectContext) {
            var timeoutMs = typeof delayMs === 'number' && isFinite(delayMs) ? Math.max(0, delayMs) : 0;
            var timer = setTimeout(function () {
              timer = null;
              try {
                if (typeof handler === 'function') {
                  handler(buildEffectContext(commentId, effectKey, node, {
                    reason: 'timeout'
                  }));
                }
              } finally {
                cleanupEffect(commentId, effectKey, {
                  node: node,
                  reason: 'timeout-complete'
                });
              }
            }, timeoutMs);
            return function () {
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
            };
          });
        },
        cleanup: function (effectKey, reason) {
          return cleanupEffect(commentId, effectKey, {
            node: node,
            reason: reason || 'manual'
          });
        },
        cleanupAll: function (reason) {
          cleanupComment(commentId, {
            node: node,
            reason: reason || 'manual'
          });
        },
        keys: function () {
          var records = getCommentRecords(commentId, false);
          return records ? Object.keys(records) : [];
        }
      };
    }

    return {
      createEffectsApi: createEffectsApi,
      notifyPhaseChange: notifyPhaseChange,
      cleanupComment: cleanupComment,
      cleanupAll: cleanupAll
    };
  }

  /**
   * Flex flow layout backend (= 旧 reconcile + FLIP + overflow leave-anim 系)。
   * container を flex 縦並びとして扱い、`.is-leaving` / `.comment-move` CSS で
   * 個別カードの退場・FLIP 移動をアニメする。renderless controller の既定 backend。
   */
  function createFlexFlowLayout(starter, options, callbacks) {
    var direction = normalizeListDirection(options.direction);

    function isLeavingChild(node) {
      if (!node || !node.getAttribute) return false;
      return node.getAttribute('data-kh-overflow-leaving') === '1'
        || node.getAttribute('data-kh-phase') === 'leaving';
    }

    function startOverflowLeaveAnimation(entry, priorRect) {
      if (!entry || !entry.node || entry.removeTimer) {
        if (entry) callbacks.removeEntry(entry.id, 'overflow');
        return;
      }
      var node = entry.node;
      var container = starter.container;
      // 退場ノードを container 内で position: absolute にする。
      // - flex フローから外れるので、残りのカードは FLIP で繰り上がれる
      // - container 内に居続けるので container 側 (mask-image 等) の効果が掛かる
      // - 退場アニメは CSS `.is-leaving` の transition で自由に表現可能
      var rect = node.getBoundingClientRect();
      var anchorRect = priorRect || rect;
      node.setAttribute('data-kh-overflow-leaving', '1');
      node.classList.remove('comment-move');
      // 幅/高さを固定 → position:absolute にする (flex フローから外す)。container が
      // content-sized なら縮むので、top/left 計算前に新 containerRect を取り直す。
      node.style.width = rect.width + 'px';
      node.style.height = rect.height + 'px';
      node.style.margin = '0';
      // 退場ノードを背面に置く (z-index:-1)。z-index:0 だと positioned 要素として
      // static な flex 兄弟より painting order が上になり、translate 中に
      // 「leaving が新 top を覆ってる」見え方になる。-1 で背面に隠す。
      node.style.zIndex = '-1';
      node.style.pointerEvents = 'none';
      node.style.position = 'absolute';
      // 再レイアウト後の containerRect (getBoundingClientRect が reflow を強制)
      var containerRect = container.getBoundingClientRect();
      node.style.top = (anchorRect.y - containerRect.top) + 'px';
      node.style.left = (anchorRect.x - containerRect.left) + 'px';
      var orderedIds = callbacks.getOrderedIds();
      var idx = orderedIds.indexOf(entry.id);
      if (idx !== -1) orderedIds.splice(idx, 1);
      // 強制 reflow + 次フレームで is-leaving を当てて transition を発火させる。
      void node.offsetWidth;
      requestAnimationFrame(function () {
        callbacks.setEntryPhase(entry, 'leaving');
      });
      var leaveDelay = callbacks.getLeaveRemoveDelayMs();
      entry.removeTimer = setTimeout(function () {
        callbacks.removeEntry(entry.id, 'overflow');
      }, leaveDelay);
    }

    return {
      captureBeforeUpdate: function () {
        return captureChildRects(starter.container);
      },
      onAttach: function (entry, node) {
        // reconcile が DOM に挿入する。ここでは何もしない
      },
      reconcile: function (orderedIds) {
        if (!starter.container) return;
        // 退場中ノードは cursor 候補から除外 (insertBefore で巻き戻る不具合回避)
        var cursor = starter.container.firstChild;
        while (isLeavingChild(cursor)) cursor = cursor.nextSibling;
        for (var i = 0; i < orderedIds.length; i += 1) {
          var entry = callbacks.getEntry(orderedIds[i]);
          if (!entry || !entry.node) continue;
          if (entry.node === cursor) {
            cursor = cursor.nextSibling;
            while (isLeavingChild(cursor)) cursor = cursor.nextSibling;
            continue;
          }
          starter.container.insertBefore(entry.node, cursor);
        }
      },
      trim: function (orderedIds, priorRects) {
        var maxComments = callbacks.getMaxComments();
        if (!isFinite(maxComments) || maxComments < 0) return;
        while (orderedIds.length > maxComments) {
          var overflowId = direction === 'prepend' ? orderedIds[orderedIds.length - 1] : orderedIds[0];
          var entry = callbacks.getEntry(overflowId);
          if (!entry) {
            var stuckIdx = orderedIds.indexOf(overflowId);
            if (stuckIdx !== -1) orderedIds.splice(stuckIdx, 1);
            continue;
          }
          startOverflowLeaveAnimation(entry, priorRects && priorRects[overflowId] ? priorRects[overflowId] : null);
        }
      },
      applyAfterRender: function (priorRects) {
        if (!priorRects) return;
        // 新着カードに synthetic priorRect を補完: 既存と同じ FLIP delta だけ
        // 「下にあった」ことにする → 新着も既存と一緒に上にスライドして来る形になり、
        // バッチ overflow 時に「新着が最終位置にいきなり置かれて重なる」現象を防ぐ。
        var commonDy = 0;
        var children = starter.container.children;
        for (var iSample = 0; iSample < children.length; iSample += 1) {
          var sample = children[iSample];
          var sampleId = sample.getAttribute && sample.getAttribute('data-id');
          if (!sampleId || !priorRects[sampleId]) continue;
          if (sample.style.position === 'absolute') continue;
          var sampleRect = sample.getBoundingClientRect();
          var deltaY = priorRects[sampleId].y - sampleRect.top;
          if (Math.abs(deltaY) > 0.5) { commonDy = deltaY; break; }
        }
        if (commonDy !== 0) {
          for (var iNew = 0; iNew < children.length; iNew += 1) {
            var nc = children[iNew];
            var ncId = nc.getAttribute && nc.getAttribute('data-id');
            if (!ncId || priorRects[ncId]) continue;
            if (nc.style.position === 'absolute') continue;
            var ncRect = nc.getBoundingClientRect();
            priorRects[ncId] = { x: ncRect.left, y: ncRect.top + commonDy };
          }
        }
        playFlipMove(starter.container, priorRects);
      },
      // refineAfterMeasure は flex backend では no-op (定義しない)
      beginRemoveById: function () {
        // controller 側で setPhase('leaving') + leaveRemoveDelayMs タイマーを起動する
        return true;
      },
      setMaxCommentsHint: function () {
        // flex は trim で再評価されるので特に処理なし
      },
      setDirectionHint: function (next) {
        direction = normalizeListDirection(next);
      },
      setGapHint: function () {
        // flex は CSS の gap (--card-gap 等) で制御されるため JS 側は何もしない
      },
      clear: function () {
        if (starter.container) starter.container.innerHTML = '';
      },
      dispose: function () {}
    };
  }

  /**
   * Rigid-board scroll layout backend (DashAndStop): 全カードを track 要素に乗せ、
   * track の transform に CSS transition を当てて「次セル位置まで一定時間で
   * dash → 停止」の動きを実現する。
   *
   * - container の中に <div> track を 1 つ作り、全カードはこの track の子で position:absolute
   * - track.style.transform = translateY(-scrollOffset) で板全体を移動
   * - CSS transition (default 0.15s) が transform 変化を滑らかに繋ぎ、次セル到達後は停止
   * - 連続流入時は新たな setScroll で transform 値が変わり、CSS transition が retarget して
   *   現在位置から新 target まで進む (= dash 連鎖)
   * - 退場は scrollOffset が進んで container outer-top を超えたカードを cleanup する
   *   (個別 leave anim 無し)
   * - 2 回 measure 補正: append 直後の offsetHeight が確定値とズレる (フォント遅延ロード等で
   *   「改行+1文字」だと 1 行ぶんの仮値が来てから 2 行に伸びる) ケースに対応。
   *   次 rAF で再測定し差分があれば自カード以降の slotY を delta だけずらす
   *
   * 詳細: docs/architecture/rigid-scroll-engine.md
   */
  function createRigidScrollLayout(starter, options, callbacks) {
    var maxComments = options.maxComments != null ? options.maxComments : 8;
    var gap = typeof options.gap === 'number' ? options.gap : 10;
    var paddingTop = typeof options.paddingTop === 'number' ? options.paddingTop : 8;
    var paddingBottom = typeof options.paddingBottom === 'number' ? options.paddingBottom : 8;
    var scrollDuration = options.scrollDuration || '0.15s';
    var scrollEasing = options.scrollEasing || 'cubic-bezier(0.12, 0, 0.32, 1)';
    var cardLeft = typeof options.cardLeft === 'string' ? options.cardLeft : '0';
    var cardRight = typeof options.cardRight === 'string' ? options.cardRight : '0';

    var scrollOffset = 0;
    var refCardHeight = 0;
    var stylesEnsured = false;

    var track = document.createElement('div');
    track.className = 'kh-rigid-track';
    track.style.position = 'absolute';
    track.style.top = '0';
    track.style.left = '0';
    track.style.right = '0';
    track.style.willChange = 'transform';
    track.style.transition = 'transform ' + scrollDuration + ' ' + scrollEasing;
    track.style.transform = 'translateY(0)';
    starter.container.appendChild(track);

    // ResizeObserver: フォントサイズや表示切替等の CSS 変化で既存カードの高さが
    // 変わったとき、全 entry を再計測 + 再配置する。append-only の slotY が
    // 旧高さで固定されているせいで起こる「あとから font-size を上げると重なる」
    // 系の不具合を解消する。rAF で 1 フレームに 1 回まで throttle。
    var remeasureScheduled = false;
    function scheduleRemeasure() {
      if (remeasureScheduled) return;
      remeasureScheduled = true;
      requestAnimationFrame(function () {
        remeasureScheduled = false;
        remeasureAndRestack();
      });
    }
    function remeasureAndRestack() {
      var orderedIds = callbacks.getOrderedIds();
      var dirty = false;
      // まず全カードの実高さを再測定 (差分があるか判定)
      for (var i = 0; i < orderedIds.length; i += 1) {
        var e = callbacks.getEntry(orderedIds[i]);
        if (!e || !e.node) continue;
        var measured = e.node.offsetHeight;
        if (measured && measured !== e._height) {
          e._height = measured;
          if (i === 0) refCardHeight = measured;
          dirty = true;
        }
      }
      if (!dirty) return;
      // 差分があれば setGapHint と同じ順序で slotY を詰め直す
      var prevSlot = paddingTop;
      var prevHeight = 0;
      for (var j = 0; j < orderedIds.length; j += 1) {
        var entry = callbacks.getEntry(orderedIds[j]);
        if (!entry || !entry.node) continue;
        var slotY = j === 0 ? paddingTop : (prevSlot + prevHeight + gap);
        entry._slotY = slotY;
        entry.node.style.top = slotY + 'px';
        prevSlot = slotY;
        prevHeight = entry._height || 0;
      }
      updateStageHeight();
      setScroll(recomputeScrollTarget());
    }
    var resizeObserver = (typeof ResizeObserver === 'function')
      ? new ResizeObserver(scheduleRemeasure)
      : null;

    function ensureContainerStyles() {
      if (stylesEnsured) return;
      var cs = window.getComputedStyle(starter.container);
      if (cs.position === 'static') starter.container.style.position = 'relative';
      if (cs.overflow !== 'hidden') starter.container.style.overflow = 'hidden';
      stylesEnsured = true;
    }

    function updateStageHeight() {
      var h = refCardHeight || 41;
      var height = (maxComments * (h + gap) - gap + paddingTop + paddingBottom);
      starter.container.style.height = height + 'px';
    }

    function setScroll(offset) {
      scrollOffset = offset;
      track.style.transform = 'translateY(' + (-offset).toFixed(2) + 'px)';
    }

    function recomputeScrollTarget() {
      var orderedIds = callbacks.getOrderedIds();
      if (orderedIds.length === 0) return 0;
      var lastEntry = callbacks.getEntry(orderedIds[orderedIds.length - 1]);
      if (!lastEntry || lastEntry._slotY == null) return scrollOffset;
      var stageH = starter.container.offsetHeight;
      var bottomTarget = lastEntry._slotY + (lastEntry._height || 0) - (stageH - paddingBottom);
      if (orderedIds.length > maxComments) {
        var maxPlusOneEntry = callbacks.getEntry(orderedIds[orderedIds.length - 1 - maxComments]);
        if (maxPlusOneEntry && maxPlusOneEntry._slotY != null) {
          var clipTarget = maxPlusOneEntry._slotY + (maxPlusOneEntry._height || 0) + 1;
          if (clipTarget > bottomTarget) bottomTarget = clipTarget;
        }
      }
      return bottomTarget;
    }

    function cleanupClippedCards() {
      var orderedIds = callbacks.getOrderedIds();
      // visualY = slotY - scrollOffset。bottom edge が container outer-top 以下なら除去。
      for (var i = orderedIds.length - 1; i >= 0; i -= 1) {
        var entry = callbacks.getEntry(orderedIds[i]);
        if (!entry || entry._slotY == null) continue;
        if ((entry._slotY - scrollOffset) + (entry._height || 0) < 0.5) {
          if (resizeObserver && entry.node) resizeObserver.unobserve(entry.node);
          callbacks.removeEntry(orderedIds[i], 'overflow');
        }
      }
    }

    // CSS transition 終了で settled。retarget 時は途中で別 transition に切り替わるため
    // 必ずしも fire しないが、流入が落ち着いたタイミングで cleanup される。
    track.addEventListener('transitionend', function (ev) {
      if (ev.propertyName !== 'transform') return;
      cleanupClippedCards();
    });

    return {
      captureBeforeUpdate: function () { return null; },
      onAttach: function (entry, node) {
        ensureContainerStyles();
        node.style.position = 'absolute';
        node.style.left = cardLeft;
        node.style.right = cardRight;
        track.appendChild(node);
        if (resizeObserver) resizeObserver.observe(node);
        var measured = node.offsetHeight || refCardHeight || 41;
        if (!refCardHeight) refCardHeight = measured;
        entry._height = measured;
        // slotY は append-only で確定: 直前 entry の slotY + height + gap (= 末尾追加前提)。
        // 既存 entry の slotY は以後変更しない。reconcile で詰めると recomputeScrollTarget が
        // 前回と同値になり transition が発火しなくなる + 板が後退して見えるバグになる。
        var orderedIds = callbacks.getOrderedIds();
        var idx = orderedIds.indexOf(entry.id);
        if (idx > 0) {
          // 直前 entry (= 既に slotY 確定済みのはず) の bottom + gap
          var prev = callbacks.getEntry(orderedIds[idx - 1]);
          if (prev && prev._slotY != null) {
            entry._slotY = prev._slotY + (prev._height || 0) + gap;
          } else {
            entry._slotY = paddingTop;
          }
        } else {
          entry._slotY = paddingTop;
        }
        node.style.top = entry._slotY + 'px';
      },
      reconcile: function () {
        // rigid backend では slotY は onAttach で append-only に確定済み。
        // 既存 entry の slotY は変えない (= 板を後ろに戻さないための重要仕様)。
        // 中間削除があっても残り entry はそのまま。新規追加だけ onAttach で slot 確定する。
      },
      trim: function () {
        // 流入が連続するときに DOM 数が膨らまないよう、append のたびに上端クリップ済みを
        // 即除去する (transitionend 任せだと retarget で fire しない)。
        cleanupClippedCards();
      },
      applyAfterRender: function () {
        updateStageHeight();
        setScroll(recomputeScrollTarget());
      },
      refineAfterMeasure: function (entry, node) {
        // 次 rAF で再測定し、差分があれば自カード以降の slotY を delta だけずらす。
        // 後続カードがまだ rAF callback 待ちで来ても、その rAF callback がさらに
        // 自分の delta を後ろに伝播させるため連鎖的に収束する。
        requestAnimationFrame(function () {
          var orderedIds = callbacks.getOrderedIds();
          var idx = orderedIds.indexOf(entry.id);
          if (idx === -1) return; // 既に cleanup された
          var measured = node.offsetHeight;
          if (!measured || measured === entry._height) return;
          var delta = measured - entry._height;
          entry._height = measured;
          if (idx === 0) refCardHeight = measured;
          for (var m = idx + 1; m < orderedIds.length; m += 1) {
            var other = callbacks.getEntry(orderedIds[m]);
            if (!other || other._slotY == null) continue;
            other._slotY += delta;
            if (other.node) other.node.style.top = other._slotY + 'px';
          }
          updateStageHeight();
          setScroll(recomputeScrollTarget());
        });
      },
      beginRemoveById: function (entry) {
        // rigid: 個別退場アニメなし、即削除
        if (resizeObserver && entry && entry.node) resizeObserver.unobserve(entry.node);
        return false;
      },
      setMaxCommentsHint: function (n) {
        if (typeof n === 'number' && isFinite(n) && n >= 0) {
          maxComments = n;
          updateStageHeight();
          setScroll(recomputeScrollTarget());
        }
      },
      setDirectionHint: function () {
        // rigid は slide-up 上方向のみサポート
      },
      setGapHint: function (n) {
        // gap 動的更新の特例: append-only 確定の slotY を再計算する。
        // 通常運用 (= append + cleanup) では slotY 不変が原則だが、gap 変更は
        // 全カード間隔に効くので例外的に全 entry を順次再配置する。
        if (typeof n !== 'number' || !isFinite(n) || n < 0) return;
        if (n === gap) return;
        gap = n;
        var orderedIds = callbacks.getOrderedIds();
        var prevSlot = paddingTop;
        var prevHeight = 0;
        for (var i = 0; i < orderedIds.length; i += 1) {
          var entry = callbacks.getEntry(orderedIds[i]);
          if (!entry || !entry.node) continue;
          var slotY = i === 0 ? paddingTop : (prevSlot + prevHeight + gap);
          entry._slotY = slotY;
          entry.node.style.top = slotY + 'px';
          prevSlot = slotY;
          prevHeight = entry._height || 0;
        }
        updateStageHeight();
        setScroll(recomputeScrollTarget());
      },
      clear: function () {
        if (resizeObserver) resizeObserver.disconnect();
        while (track.firstChild) track.removeChild(track.firstChild);
        scrollOffset = 0;
        refCardHeight = 0;
        track.style.transform = 'translateY(0)';
      },
      dispose: function () {
        if (resizeObserver) resizeObserver.disconnect();
        if (track.parentNode) track.parentNode.removeChild(track);
      }
    };
  }

  function createRenderlessListController(starter, options) {
    options = options || {};
    if (!starter || !starter.container) {
      throw new Error('createRenderlessListController requires starter.container');
    }
    var compiled = compileCellTemplate(options.cellTemplate);
    var maxComments = options.maxComments != null ? options.maxComments : Infinity;
    var direction = normalizeListDirection(options.direction);
    var beforeCommitComment = options.beforeCommitComment;
    var afterBindComment = options.afterBindComment;
    var onCommentStateChange = options.onCommentStateChange;
    var beforeRemoveComment = options.beforeRemoveComment;
    var lifecycle = resolveRenderlessLifecycleOptions(options);
    var enterActiveDelayMs = lifecycle.enterActiveDelayMs;
    var leaveRemoveDelayMs = lifecycle.leaveRemoveDelayMs;
    var themeAssets = options.themeAssets && typeof options.themeAssets === 'object'
      ? options.themeAssets
      : null;
    var entries = {};
    var orderedIds = [];
    var pendingIds = [];
    var pendingIdMap = {};
    var renderScheduled = false;
    var activationScheduled = false;
    var themeCursor = 0;

    function getEntry(id) {
      return id ? entries[id] || null : null;
    }

    var effectScheduler = createRenderlessEffectScheduler(getEntry, function () {
      return {
        starterType: 'list',
        sceneId: runtimeConfig.sceneId || '',
        templateId: runtimeConfig.templateId || '',
        latestConfig: latestConfig || {},
        container: starter.container
      };
    });

    function enqueueDirty(id) {
      if (!id || pendingIdMap[id]) return;
      pendingIdMap[id] = true;
      pendingIds.push(id);
    }

    function clearDirtyQueue() {
      pendingIds = [];
      pendingIdMap = {};
    }

    function clearActivationTimer(entry) {
      if (!entry || !entry.activateTimer) return;
      clearTimeout(entry.activateTimer);
      entry.activateTimer = null;
    }

    function buildRenderlessEffectContext(entry, node, extra) {
      extra = extra || {};
      return Object.assign({
        starterType: 'list',
        sceneId: runtimeConfig.sceneId || '',
        templateId: runtimeConfig.templateId || '',
        latestConfig: latestConfig || {},
        container: starter.container,
        commentId: entry && entry.id ? entry.id : '',
        node: node || (entry && entry.node ? entry.node : null),
        model: entry && entry.model ? entry.model : null,
        effects: effectScheduler.createEffectsApi(entry && entry.id ? entry.id : '', node || (entry && entry.node ? entry.node : null))
      }, extra);
    }

    function assignThemeKey(rawComment, prevModel, assignOptions) {
      if (prevModel && prevModel.display && prevModel.display.themeKey) {
        return prevModel.display.themeKey;
      }
      assignOptions = assignOptions || {};
      var themes = Array.isArray(assignOptions.themes) ? assignOptions.themes.filter(Boolean) : [];
      if (themes.length === 0) return '';
      var theme = themes[themeCursor % themes.length];
      themeCursor += 1;
      return theme;
    }

    function buildCallbackContext(rawComment, prevModel, isNew) {
      return {
        starterType: 'list',
        sceneId: runtimeConfig.sceneId || '',
        templateId: runtimeConfig.templateId || '',
        nowMs: Date.now(),
        isUpdate: !isNew,
        isNew: !!isNew,
        nextOrder: prevModel && prevModel.meta ? prevModel.meta.order : orderedIds.length,
        latestConfig: latestConfig || {},
        helpers: {
          assignThemeKey: assignThemeKey,
          buildDefaultModel: function (nextRawComment) {
            return buildDefaultRenderlessModel(nextRawComment, prevModel, buildCallbackContext(nextRawComment, prevModel, isNew));
          }
        }
      };
    }

    function notifyPhaseChange(model, prevPhase, nextPhase) {
      if (prevPhase === nextPhase) return;
      var entry = model && model.id ? getEntry(model.id) : null;
      var context = buildRenderlessEffectContext(entry, entry && entry.node ? entry.node : null, {
        prevPhase: prevPhase,
        nextPhase: nextPhase,
        phase: nextPhase
      });
      if (typeof onCommentStateChange === 'function') {
        onCommentStateChange(model, prevPhase, nextPhase, context);
      }
      if (entry) effectScheduler.notifyPhaseChange(entry.id, prevPhase, nextPhase, context);
    }

    function setPhase(entry, nextPhase) {
      if (!entry || !entry.model) return;
      if (nextPhase !== 'entering') clearActivationTimer(entry);
      var prevPhase = entry.model.state && entry.model.state.phase ? entry.model.state.phase : '';
      if (!entry.model.state) entry.model.state = {};
      entry.model.state.phase = nextPhase;
      if (entry.node) applyRenderlessModelMetadata(entry.node, entry.model);
      notifyPhaseChange(entry.model, prevPhase, nextPhase);
    }

    function scheduleActivation() {
      if (activationScheduled) return;
      activationScheduled = true;
      requestAnimationFrame(function () {
        activationScheduled = false;
        orderedIds.forEach(function (id) {
          var entry = getEntry(id);
          if (!entry || !entry.model || !entry.node) return;
          if (entry.model.state && entry.model.state.phase === 'entering') {
            if (enterActiveDelayMs > 0) {
              clearActivationTimer(entry);
              entry.activateTimer = setTimeout(function () {
                var liveEntry = getEntry(id);
                if (liveEntry) liveEntry.activateTimer = null;
                if (liveEntry && liveEntry.model && liveEntry.model.state && liveEntry.model.state.phase === 'entering') {
                  setPhase(liveEntry, 'active');
                }
              }, enterActiveDelayMs);
            } else {
              setPhase(entry, 'active');
            }
          }
        });
      });
    }

    function ensureEntryNode(entry) {
      if (!entry) return null;
      // Reuse the bound node even before it is attached.
      // Otherwise bindEntry() mutates one clone and reconcileDomOrder()
      // appends a fresh unbound clone on the same frame.
      if (entry.node) return entry.node;
      var node = cloneCellTemplateRoot(compiled);
      if (!node) return null;
      entry.node = node;
      setDataId(node, entry.id);
      return node;
    }

    function bindEntry(entry) {
      if (!entry) return null;
      var node = ensureEntryNode(entry);
      if (!node) return null;
      populateCellTemplateRoot(node, entry.model, {
        transformValue: options.transformValue,
        defaultEmptyMode: 'hide'
      });
      applyRenderlessThemeAssets(node, entry.model, {
        themeAssets: themeAssets
      });
      applyRenderlessModelMetadata(node, entry.model);
      if (typeof afterBindComment === 'function') {
        afterBindComment(node, entry.model, buildRenderlessEffectContext(entry, node, {
          phase: entry.model && entry.model.state ? entry.model.state.phase || '' : ''
        }));
      }
      return node;
    }

    function removeEntryNow(id, reason) {
      var entry = getEntry(id);
      if (!entry) return null;
      if (entry.removeTimer) {
        clearTimeout(entry.removeTimer);
        entry.removeTimer = null;
      }
      clearActivationTimer(entry);
      var context = buildRenderlessEffectContext(entry, entry.node, {
        reason: reason || 'remove',
        phase: entry.model && entry.model.state ? entry.model.state.phase || '' : ''
      });
      if (typeof beforeRemoveComment === 'function') {
        beforeRemoveComment(entry.node || null, entry.model, context);
      }
      effectScheduler.cleanupComment(id, context);
      if (entry.node && entry.node.remove) entry.node.remove();
      delete entries[id];
      var idx = orderedIds.indexOf(id);
      if (idx !== -1) orderedIds.splice(idx, 1);
      return entry;
    }

    // layout backend が controller の private state にアクセスするための窓口。
    // backend は entries / orderedIds を勝手に書き換えず、ここの callback を経由する。
    var layoutCallbacks = {
      getEntry: getEntry,
      getOrderedIds: function () { return orderedIds; },
      removeEntry: function (id, reason) {
        removeEntryNow(id, reason || 'overflow');
      },
      setEntryPhase: setPhase,
      getDirection: function () { return direction; },
      getMaxComments: function () { return maxComments; },
      getLeaveRemoveDelayMs: function () { return leaveRemoveDelayMs; }
    };

    var layout = options.useRigidScroll === true
      ? createRigidScrollLayout(starter, options, layoutCallbacks)
      : createFlexFlowLayout(starter, options, layoutCallbacks);

    function flushPending() {
      renderScheduled = false;
      var ids = pendingIds.slice();
      clearDirtyQueue();
      // FLIP の First (flex のみ): 既存要素の rect を記録。rigid は null
      var priorRects = typeof layout.captureBeforeUpdate === 'function'
        ? layout.captureBeforeUpdate()
        : null;
      var newlyAttached = [];
      ids.forEach(function (id) {
        var entry = getEntry(id);
        if (!entry) return;
        var wasAttached = !!entry.node;
        bindEntry(entry);
        if (!wasAttached && entry.node && typeof layout.onAttach === 'function') {
          layout.onAttach(entry, entry.node);
          newlyAttached.push(entry);
        }
      });
      if (typeof layout.reconcile === 'function') layout.reconcile(orderedIds);
      if (typeof layout.trim === 'function') layout.trim(orderedIds, priorRects);
      // Last/Invert/Play (flex: playFlipMove / rigid: setScroll)
      if (typeof layout.applyAfterRender === 'function') layout.applyAfterRender(priorRects);
      if (typeof layout.refineAfterMeasure === 'function') {
        newlyAttached.forEach(function (entry) {
          layout.refineAfterMeasure(entry, entry.node);
        });
      }
      scheduleActivation();
    }

    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(flushPending);
    }

    function upsertComment(rawComment) {
      if (!rawComment || !rawComment.id) return null;
      var prevEntry = getEntry(rawComment.id);
      var prevModel = prevEntry ? prevEntry.model : null;
      var isNew = !prevModel;
      var context = buildCallbackContext(rawComment, prevModel, isNew);
      var baseModel = buildDefaultRenderlessModel(rawComment, prevModel, context);
      var patch = typeof beforeCommitComment === 'function'
        ? beforeCommitComment(rawComment, prevModel, context)
        : null;
      var nextModel = shallowMergeRenderlessModelPatch(baseModel, patch);
      if (!nextModel.id) nextModel.id = rawComment.id;
      if (!nextModel.state) nextModel.state = {};
      if (!nextModel.state.phase) nextModel.state.phase = isNew ? 'entering' : 'active';
      var shouldRebind = isNew || !isRenderlessModelRenderEqual(prevModel, nextModel);
      if (!entries[nextModel.id]) {
        entries[nextModel.id] = {
          id: nextModel.id,
          model: nextModel,
          node: null,
          removeTimer: null,
          activateTimer: null
        };
        if (direction === 'prepend') orderedIds.unshift(nextModel.id);
        else orderedIds.push(nextModel.id);
      } else {
        entries[nextModel.id].model = nextModel;
        if (entries[nextModel.id].removeTimer) {
          clearTimeout(entries[nextModel.id].removeTimer);
          entries[nextModel.id].removeTimer = null;
        }
        if (nextModel.state.phase !== 'entering') {
          clearActivationTimer(entries[nextModel.id]);
        }
      }
      if (shouldRebind) {
        enqueueDirty(nextModel.id);
        scheduleRender();
      }
      return nextModel;
    }

    return {
      setMaxComments: function (nextMaxComments) {
        if (typeof nextMaxComments === 'number' && isFinite(nextMaxComments) && nextMaxComments >= 0) {
          maxComments = nextMaxComments;
          if (typeof layout.setMaxCommentsHint === 'function') layout.setMaxCommentsHint(maxComments);
          scheduleRender();
        }
      },
      setDirection: function (nextDirection) {
        direction = normalizeListDirection(nextDirection);
        if (typeof layout.setDirectionHint === 'function') layout.setDirectionHint(direction);
        scheduleRender();
      },
      setGap: function (nextGap) {
        if (typeof nextGap !== 'number' || !isFinite(nextGap) || nextGap < 0) return;
        if (typeof layout.setGapHint === 'function') layout.setGapHint(nextGap);
      },
      renderComments: function (comments, renderOptions) {
        renderOptions = renderOptions || {};
        if (renderOptions.replace) this.clear();
        if (!Array.isArray(comments)) return;
        comments.forEach(function (rawComment) {
          upsertComment(rawComment);
        });
      },
      removeById: function (id) {
        var entry = getEntry(id);
        if (!entry) return null;
        if (entry.removeTimer) return entry.node || null;
        var deferred = typeof layout.beginRemoveById === 'function'
          && layout.beginRemoveById(entry) === true;
        if (deferred) {
          setPhase(entry, 'leaving');
          entry.removeTimer = setTimeout(function () {
            removeEntryNow(id, 'remove');
          }, leaveRemoveDelayMs);
        } else {
          removeEntryNow(id, 'remove');
        }
        return entry.node || null;
      },
      clear: function () {
        Object.keys(entries).forEach(function (id) {
          var entry = entries[id];
          if (entry && entry.removeTimer) clearTimeout(entry.removeTimer);
          clearActivationTimer(entry);
          removeEntryNow(id, 'clear');
        });
        entries = {};
        orderedIds = [];
        clearDirtyQueue();
        if (typeof layout.clear === 'function') layout.clear();
      },
      getItems: function () {
        return Array.prototype.slice.call(starter.container.children);
      },
      dispose: function () {
        effectScheduler.cleanupAll({ reason: 'dispose' });
        this.clear();
        if (typeof layout.dispose === 'function') layout.dispose();
      }
    };
  }

  function runAfterRenderComment(starter, comment, node) {
    if (!node) return node;
    if (typeof starter.afterRenderComment === 'function') {
      var nextNode = starter.afterRenderComment(comment || {}, node, starter);
      if (nextNode) return nextNode;
    }
    return node;
  }

  function createListStarter(options) {
    options = options || {};
    var starter = createStarterBase(options);
    if (!starter.container) {
      throw new Error('starters.list requires a container');
    }
    // useRigidScroll を有効にすると自動的に renderless 経路に乗せる (= layout backend
    // として rigid を選択する)。renderlessModel を明示せず cellTemplate だけで rigid
    // を使うケースも renderless 経由に強制統一する。
    var useRenderlessList = !options.renderComment && !!options.cellTemplate
      && (!!options.renderlessModel
        || typeof options.beforeCommitComment === 'function'
        || options.useRigidScroll === true);
    var list;
    if (useRenderlessList) {
      list = createRenderlessListController(starter, options);
    } else {
      list = createListController({
        container: starter.container,
        maxComments: options.maxComments != null ? options.maxComments : Infinity,
        direction: options.direction || 'append'
      });
    }
    if (!options.renderComment && options.cellTemplate) {
      options.renderComment = createCellTemplateRenderer(options.cellTemplate, {
        transformValue: options.transformValue
      });
    }
    starter.list = list;
    starter.renderComment = useRenderlessList ? null : options.renderComment;
    starter.afterRenderComment = options.afterRenderComment;
    starter.onConfig = options.onConfig;
    starter.beforeCommitComment = options.beforeCommitComment;
    starter.afterBindComment = options.afterBindComment;
    starter.onCommentStateChange = options.onCommentStateChange;
    starter.beforeRemoveComment = options.beforeRemoveComment;
    starter.applyConfig = function (config) {
      applyCommonFontSettings(starter, config || {});
      applyConfigBindings(config || {}, starter.configBindings, starter);
      if (typeof starter.onConfig === 'function') {
        starter.onConfig(config || {}, starter);
      }
    };
    starter.renderComments = function (comments, renderOptions) {
      renderOptions = renderOptions || {};
      if (!Array.isArray(comments)) return;
      if (useRenderlessList) {
        list.renderComments(comments, renderOptions);
        return;
      }
      if (renderOptions.replace) list.clear();
      comments.forEach(function (comment) {
        if (comment && typeof starter.renderComment === 'function') {
          list.append(comment, function (nextComment) {
            return runAfterRenderComment(
              starter,
              nextComment,
              starter.renderComment(nextComment, starter)
            );
          });
        }
      });
    };
    starter.clear = function () {
      list.clear();
    };
    starter.removeById = function (id) {
      return list.removeById(id);
    };
    starter.setGap = function (nextGap) {
      // rigid scroll layout 採用テンプレで commentGap config の動的反映に使う。
      // flex flow layout では no-op (= CSS の gap: var(--card-gap) で制御するため)。
      if (list && typeof list.setGap === 'function') list.setGap(nextGap);
    };
    starter.dispose = function () {
      if (list && typeof list.dispose === 'function') list.dispose();
    };

    api.register({
      onConfig: function (config, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        starter.applyConfig(config || {});
      },
      onComments: function (comments) {
        starter.renderComments(comments);
      },
      onDeleted: function (payload) {
        if (payload && payload.id) starter.removeById(payload.id);
      },
      onClear: function () {
        starter.clear();
      },
      dispose: function () {
        if (typeof starter.dispose === 'function') starter.dispose();
      }
    });

    return starter;
  }

  function createTickerStarter(options) {
    options = options || {};
    var starter = createStarterBase(options);
    var track = resolveStarterTarget(options.track || '#track', starter);
    if (!starter.container || !track) {
      throw new Error('starters.ticker requires container and track');
    }
    var padding = options.padding != null ? options.padding : 24;
    var travelSeconds = options.travelSeconds != null ? options.travelSeconds : 8;
    var transitionTiming = options.transitionTiming || 'linear';
    var cleanupTimer = null;
    var maxComments = options.maxComments != null ? options.maxComments : Infinity;
    var useRenderlessTicker = !options.renderComment && !!options.cellTemplate
      && (!!options.renderlessModel || typeof options.beforeCommitComment === 'function');
    if (!options.renderComment && options.cellTemplate && !useRenderlessTicker) {
      options.renderComment = createCellTemplateRenderer(options.cellTemplate, {
        transformValue: options.transformValue
      });
    }

    starter.track = track;
    starter.ticker = starter;
    starter.renderComment = useRenderlessTicker ? null : options.renderComment;
    starter.afterRenderComment = options.afterRenderComment;
    starter.onConfig = options.onConfig;
    starter.beforeCommitComment = options.beforeCommitComment;
    starter.afterBindComment = options.afterBindComment;
    starter.onCommentStateChange = options.onCommentStateChange;
    starter.beforeRemoveComment = options.beforeRemoveComment;
    starter.recalcTrack = recalcTrack;
    starter.setMaxComments = function (nextMax) {
      if (typeof nextMax !== 'number' || !isFinite(nextMax) || nextMax <= 0) return;
      maxComments = nextMax;
      trimOverflow();
    };
    starter.setTravelSeconds = function (nextSeconds) {
      if (typeof nextSeconds !== 'number' || !isFinite(nextSeconds) || nextSeconds <= 0) return;
      travelSeconds = nextSeconds;
      configHelpers.setVar(starter.root, '--anim-duration', travelSeconds + 's');
      recalcTrack();
    };

    function getContainerWidth() {
      return window.innerWidth;
    }

    function getTrackShift() {
      return track.scrollWidth + padding;
    }

    function updateTrackPosition() {
      track.style.transform = 'translateX(' + (getContainerWidth() - getTrackShift()) + 'px)';
    }

    function getCurrentTrackTranslateX() {
      var transform = window.getComputedStyle(track).transform;
      if (!transform || transform === 'none') return 0;
      var match3d = transform.match(/^matrix3d\((.+)\)$/);
      if (match3d) {
        var values3d = match3d[1].split(',').map(function (value) { return parseFloat(value); });
        return values3d.length >= 13 && isFinite(values3d[12]) ? values3d[12] : 0;
      }
      var match2d = transform.match(/^matrix\((.+)\)$/);
      if (match2d) {
        var values2d = match2d[1].split(',').map(function (value) { return parseFloat(value); });
        return values2d.length >= 5 && isFinite(values2d[4]) ? values2d[4] : 0;
      }
      return 0;
    }

    function getFirstChildAdvance() {
      var first = track.children[0];
      if (!first) return 0;
      var second = track.children[1];
      if (second) {
        var advance = second.offsetLeft - first.offsetLeft;
        if (isFinite(advance) && advance > 0) return advance;
      }
      return first.offsetWidth || 0;
    }

    function preserveTrackVisualPosition(advance) {
      if (!advance || !isFinite(advance)) return;
      var currentX = getCurrentTrackTranslateX();
      track.style.transition = 'none';
      track.style.transform = 'translateX(' + (currentX + advance) + 'px)';
      track.offsetWidth;
      track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
    }

    function isFirstChildOffscreenLeft() {
      var first = track.children[0];
      if (!first) return false;
      var rightEdge = getCurrentTrackTranslateX() + first.offsetLeft + first.offsetWidth;
      return rightEdge < -20;
    }

    function recalcTrack() {
      track.style.transition = 'none';
      track.offsetWidth;
      updateTrackPosition();
      track.offsetWidth;
      track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
    }

    function initTrack() {
      track.style.transform = 'translateX(' + getContainerWidth() + 'px)';
      track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
    }

    var compiled = useRenderlessTicker ? compileCellTemplate(options.cellTemplate) : null;
    var beforeCommitComment = options.beforeCommitComment;
    var afterBindComment = options.afterBindComment;
    var onCommentStateChange = options.onCommentStateChange;
    var beforeRemoveComment = options.beforeRemoveComment;
    var lifecycle = resolveRenderlessLifecycleOptions(options);
    var enterActiveDelayMs = lifecycle.enterActiveDelayMs;
    var leaveRemoveDelayMs = lifecycle.leaveRemoveDelayMs;
    var themeAssets = options.themeAssets && typeof options.themeAssets === 'object'
      ? options.themeAssets
      : null;
    var entries = {};
    var orderedIds = [];
    var pendingIds = [];
    var pendingIdMap = {};
    var renderScheduled = false;
    var activationScheduled = false;
    var themeCursor = 0;

    function getEntry(id) {
      return id ? entries[id] || null : null;
    }

    var effectScheduler = createRenderlessEffectScheduler(getEntry, function () {
      return {
        starterType: 'ticker',
        sceneId: runtimeConfig.sceneId || '',
        templateId: runtimeConfig.templateId || '',
        latestConfig: latestConfig || {},
        container: starter.container,
        track: track
      };
    });

    function buildRenderlessEffectContext(entry, node, extra) {
      extra = extra || {};
      return Object.assign({
        starterType: 'ticker',
        sceneId: runtimeConfig.sceneId || '',
        templateId: runtimeConfig.templateId || '',
        latestConfig: latestConfig || {},
        container: starter.container,
        track: track,
        commentId: entry && entry.id ? entry.id : '',
        node: node || (entry && entry.node ? entry.node : null),
        model: entry && entry.model ? entry.model : null,
        effects: effectScheduler.createEffectsApi(entry && entry.id ? entry.id : '', node || (entry && entry.node ? entry.node : null))
      }, extra);
    }

    function enqueueDirty(id) {
      if (!id || pendingIdMap[id]) return;
      pendingIdMap[id] = true;
      pendingIds.push(id);
    }

    function clearDirtyQueue() {
      pendingIds = [];
      pendingIdMap = {};
    }

    function clearActivationTimer(entry) {
      if (!entry || !entry.activateTimer) return;
      clearTimeout(entry.activateTimer);
      entry.activateTimer = null;
    }

    function assignThemeKey(rawComment, prevModel, assignOptions) {
      if (prevModel && prevModel.display && prevModel.display.themeKey) {
        return prevModel.display.themeKey;
      }
      assignOptions = assignOptions || {};
      var themes = Array.isArray(assignOptions.themes) ? assignOptions.themes.filter(Boolean) : [];
      if (themes.length === 0) return '';
      var theme = themes[themeCursor % themes.length];
      themeCursor += 1;
      return theme;
    }

    function buildCallbackContext(rawComment, prevModel, isNew) {
      return {
        starterType: 'ticker',
        sceneId: runtimeConfig.sceneId || '',
        templateId: runtimeConfig.templateId || '',
        nowMs: Date.now(),
        isUpdate: !isNew,
        isNew: !!isNew,
        nextOrder: prevModel && prevModel.meta ? prevModel.meta.order : orderedIds.length,
        latestConfig: latestConfig || {},
        helpers: {
          assignThemeKey: assignThemeKey,
          buildDefaultModel: function (nextRawComment) {
            return buildDefaultRenderlessModel(nextRawComment, prevModel, buildCallbackContext(nextRawComment, prevModel, isNew));
          }
        }
      };
    }

    function notifyPhaseChange(model, prevPhase, nextPhase) {
      if (prevPhase === nextPhase) return;
      var entry = model && model.id ? getEntry(model.id) : null;
      var context = buildRenderlessEffectContext(entry, entry && entry.node ? entry.node : null, {
        prevPhase: prevPhase,
        nextPhase: nextPhase,
        phase: nextPhase
      });
      if (typeof onCommentStateChange === 'function') {
        onCommentStateChange(model, prevPhase, nextPhase, context);
      }
      if (entry) effectScheduler.notifyPhaseChange(entry.id, prevPhase, nextPhase, context);
    }

    function setPhase(entry, nextPhase) {
      if (!entry || !entry.model) return;
      if (nextPhase !== 'entering') clearActivationTimer(entry);
      var prevPhase = entry.model.state && entry.model.state.phase ? entry.model.state.phase : '';
      if (!entry.model.state) entry.model.state = {};
      entry.model.state.phase = nextPhase;
      if (entry.node) applyRenderlessModelMetadata(entry.node, entry.model);
      notifyPhaseChange(entry.model, prevPhase, nextPhase);
    }

    function scheduleActivation() {
      if (activationScheduled) return;
      activationScheduled = true;
      requestAnimationFrame(function () {
        activationScheduled = false;
        orderedIds.forEach(function (id) {
          var entry = getEntry(id);
          if (!entry || !entry.model || !entry.node) return;
          if (entry.model.state && entry.model.state.phase === 'entering') {
            if (enterActiveDelayMs > 0) {
              clearActivationTimer(entry);
              entry.activateTimer = setTimeout(function () {
                var liveEntry = getEntry(id);
                if (liveEntry) liveEntry.activateTimer = null;
                if (liveEntry && liveEntry.model && liveEntry.model.state && liveEntry.model.state.phase === 'entering') {
                  setPhase(liveEntry, 'active');
                }
              }, enterActiveDelayMs);
            } else {
              setPhase(entry, 'active');
            }
          }
        });
      });
    }

    function updateTrackAfterMutation() {
      track.style.transition = 'none';
      updateTrackPosition();
      track.offsetWidth;
      track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
    }

    function ensureEntryNode(entry) {
      if (!entry) return null;
      if (entry.node) return entry.node;
      var node = cloneCellTemplateRoot(compiled);
      if (!node) return null;
      entry.node = node;
      setDataId(node, entry.id);
      return node;
    }

    function bindEntry(entry) {
      if (!entry) return null;
      var node = ensureEntryNode(entry);
      if (!node) return null;
      populateCellTemplateRoot(node, entry.model, {
        transformValue: options.transformValue,
        defaultEmptyMode: 'hide'
      });
      applyRenderlessThemeAssets(node, entry.model, {
        themeAssets: themeAssets
      });
      applyRenderlessModelMetadata(node, entry.model);
      if (typeof afterBindComment === 'function') {
        afterBindComment(node, entry.model, buildRenderlessEffectContext(entry, node, {
          phase: entry.model && entry.model.state ? entry.model.state.phase || '' : ''
        }));
      }
      return node;
    }

    function appendPendingNodes() {
      var appended = false;
      orderedIds.forEach(function (id) {
        var entry = getEntry(id);
        if (!entry) return;
        var node = ensureEntryNode(entry);
        if (!node) return;
        if (!node.isConnected) {
          track.appendChild(node);
          appended = true;
        }
      });
      return appended;
    }

    function removeEntryNow(id, reason) {
      var entry = getEntry(id);
      if (!entry) return null;
      if (entry.removeTimer) {
        clearTimeout(entry.removeTimer);
        entry.removeTimer = null;
      }
      clearActivationTimer(entry);
      var context = buildRenderlessEffectContext(entry, entry.node, {
        reason: reason || 'remove',
        phase: entry.model && entry.model.state ? entry.model.state.phase || '' : ''
      });
      if (typeof beforeRemoveComment === 'function') {
        beforeRemoveComment(entry.node || null, entry.model, context);
      }
      effectScheduler.cleanupComment(id, context);
      if (entry.node && entry.node.remove) entry.node.remove();
      delete entries[id];
      var idx = orderedIds.indexOf(id);
      if (idx !== -1) orderedIds.splice(idx, 1);
      return entry;
    }

    function trimOverflow() {
      if (!isFinite(maxComments) || maxComments <= 0) return;
      if (!useRenderlessTicker) {
        while (track.children.length > maxComments && isFirstChildOffscreenLeft()) {
          var advance = getFirstChildAdvance();
          track.removeChild(track.firstChild);
          preserveTrackVisualPosition(advance);
        }
        updateTrackPosition();
        return;
      }
      while (orderedIds.length > maxComments && isFirstChildOffscreenLeft()) {
        var renderlessAdvance = getFirstChildAdvance();
        removeEntryNow(orderedIds[0], 'overflow');
        preserveTrackVisualPosition(renderlessAdvance);
      }
      updateTrackPosition();
    }

    function scheduleCleanup() {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(function () {
        cleanupTimer = null;
        var containerWidth = getContainerWidth();
        var shift = getTrackShift();
        var removed = false;

        while ((useRenderlessTicker ? orderedIds.length : track.children.length) > 1) {
          var first = useRenderlessTicker
            ? (function () {
              var firstEntry = getEntry(orderedIds[0]);
              return firstEntry ? firstEntry.node : null;
            })()
            : track.children[0];
          if (!first) break;
          var trackLeft = containerWidth - shift;
          var rightEdge = trackLeft + first.offsetLeft + first.offsetWidth;
          if (rightEdge < -20) {
            var advance = getFirstChildAdvance();
            if (useRenderlessTicker) {
              removeEntryNow(orderedIds[0], 'travel');
            } else {
              first.remove();
            }
            preserveTrackVisualPosition(advance);
            shift = getTrackShift();
            updateTrackPosition();
            removed = true;
          } else {
            break;
          }
        }

        if (removed) {
          track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
        }
      }, (travelSeconds + 0.2) * 1000);
    }

    function clearAll() {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      if (useRenderlessTicker) {
        Object.keys(entries).forEach(function (id) {
          var entry = entries[id];
          if (entry && entry.removeTimer) clearTimeout(entry.removeTimer);
          clearActivationTimer(entry);
          removeEntryNow(id, 'clear');
        });
        entries = {};
        orderedIds = [];
        clearDirtyQueue();
      }
      track.style.transition = 'none';
      track.innerHTML = '';
      updateTrackPosition();
      track.offsetWidth;
      track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
    }

    function removeComment(id) {
      if (useRenderlessTicker) {
        var entry = getEntry(id);
        if (!entry) return;
        if (entry.removeTimer) return;
        setPhase(entry, 'leaving');
        entry.removeTimer = setTimeout(function () {
          removeEntryNow(id, 'remove');
          updateTrackAfterMutation();
        }, leaveRemoveDelayMs);
        return;
      }
      var node = track.querySelector('[data-id="' + id + '"]');
      if (!node) return;
      track.style.transition = 'none';
      node.remove();
      updateTrackPosition();
      track.offsetWidth;
      track.style.transition = 'transform ' + travelSeconds + 's ' + transitionTiming;
    }

    function appendRenderedComment(comment) {
      if (useRenderlessTicker) {
        if (!comment || !comment.id) return;
        var prevEntry = getEntry(comment.id);
        var prevModel = prevEntry ? prevEntry.model : null;
        var isNew = !prevModel;
        var context = buildCallbackContext(comment, prevModel, isNew);
        var baseModel = buildDefaultRenderlessModel(comment, prevModel, context);
        var patch = typeof beforeCommitComment === 'function'
          ? beforeCommitComment(comment, prevModel, context)
          : null;
        var nextModel = shallowMergeRenderlessModelPatch(baseModel, patch);
        if (!nextModel.id) nextModel.id = comment.id;
        if (!nextModel.state) nextModel.state = {};
        if (!nextModel.state.phase) nextModel.state.phase = isNew ? 'entering' : 'active';
        var shouldRebind = isNew || !isRenderlessModelRenderEqual(prevModel, nextModel);
        if (!entries[nextModel.id]) {
          entries[nextModel.id] = {
            id: nextModel.id,
            model: nextModel,
            node: null,
            removeTimer: null,
            activateTimer: null
          };
          orderedIds.push(nextModel.id);
        } else {
          entries[nextModel.id].model = nextModel;
          if (entries[nextModel.id].removeTimer) {
            clearTimeout(entries[nextModel.id].removeTimer);
            entries[nextModel.id].removeTimer = null;
          }
          if (nextModel.state.phase !== 'entering') {
            clearActivationTimer(entries[nextModel.id]);
          }
        }
        if (shouldRebind) {
          enqueueDirty(nextModel.id);
          renderScheduled = renderScheduled || false;
          if (!renderScheduled) {
            renderScheduled = true;
            requestAnimationFrame(function () {
              renderScheduled = false;
              var ids = pendingIds.slice();
              clearDirtyQueue();
              ids.forEach(function (id) {
                var entry = getEntry(id);
                if (!entry) return;
                bindEntry(entry);
              });
              appendPendingNodes();
              trimOverflow();
              updateTrackPosition();
              scheduleCleanup();
              scheduleActivation();
            });
          }
        }
        return;
      }
      if (!comment || typeof starter.renderComment !== 'function') return;
      var node = runAfterRenderComment(
        starter,
        comment,
        starter.renderComment(comment, starter)
      );
      if (!node) return;
      setDataId(node, comment.id);
      track.appendChild(node);
      trimOverflow();
      updateTrackPosition();
      scheduleCleanup();
    }

    initTrack();
    window.addEventListener('resize', recalcTrack);
    starter.renderComments = function (comments, renderOptions) {
      renderOptions = renderOptions || {};
      if (renderOptions.replace) clearAll();
      if (!Array.isArray(comments)) return;
      comments.forEach(function (comment) {
        appendRenderedComment(comment);
      });
    };
    starter.clear = clearAll;

    api.register({
      onConfig: function (config, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        applyCommonFontSettings(starter, config || {});
        applyConfigBindings(config || {}, starter.configBindings, starter);
        if (typeof starter.onConfig === 'function') {
          starter.onConfig(config || {}, starter);
        }
      },
      onComments: function (comments) {
        starter.renderComments(comments);
      },
      onDeleted: function (payload) {
        if (payload && payload.id) removeComment(payload.id);
      },
      onClear: clearAll
      ,
      dispose: function () {
        window.removeEventListener('resize', recalcTrack);
        if (useRenderlessTicker) {
          effectScheduler.cleanupAll({ reason: 'dispose' });
        }
      }
    });

    return starter;
  }

  function mergeHtmlFirstOptions(base, override) {
    var result = {};
    var left = base && typeof base === 'object' ? base : {};
    var right = override && typeof override === 'object' ? override : {};
    Object.keys(left).forEach(function (key) {
      if (key === 'config' || key === 'preview') return;
      result[key] = left[key];
    });
    Object.keys(right).forEach(function (key) {
      if (key === 'config' || key === 'preview') return;
      result[key] = right[key];
    });
    result.config = Object.assign({}, left.config || {}, right.config || {});
    result.preview = Object.assign({}, left.preview || {}, right.preview || {});
    return result;
  }

  function readHtmlFirstJsonOptions(source) {
    if (!source) return {};
    var node = typeof source === 'string' ? document.querySelector(source) : source;
    if (!node) return {};
    var text = node.textContent || '';
    if (!text || !text.trim()) return {};
    var parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  function createStandardListPreviewScenarios() {
    var scenarios = [
      {
        id: 'normal',
        label: '通常',
        comments: [
          {
            id: 'preview-normal',
            name: 'こめはぶ太郎',
            comment: '通常コメントの見た目です。HTML と CSS の骨組みを確認します。',
            commentHtml: '通常コメントの見た目です。HTML と CSS の骨組みを確認します。',
            profileImage: 'https://placehold.co/96x96/png',
            memberBadgeUrl: '',
            stickerImage: '',
            amount: 0,
            amountDisplay: '',
            isMember: false,
            isMembership: false,
            isMembershipGift: false,
            membershipHeader: '',
            giftCount: 0,
            isModerator: false,
            isOwner: false,
            isVerified: false,
            superchatTier: ''
          }
        ]
      },
      {
        id: 'superchat',
        label: 'スパチャ',
        comments: [
          {
            id: 'preview-superchat',
            name: 'スパチャ勢',
            comment: '色と金額表示の見た目を確認します。',
            commentHtml: '色と金額表示の見た目を確認します。',
            profileImage: 'https://placehold.co/96x96/f59e0b/ffffff?text=SC',
            memberBadgeUrl: '',
            stickerImage: '',
            amount: 5000,
            amountDisplay: '¥5,000',
            isMember: false,
            isMembership: false,
            isMembershipGift: false,
            membershipHeader: '',
            giftCount: 0,
            isModerator: false,
            isOwner: false,
            isVerified: false,
            superchatTier: 'red'
          }
        ]
      },
      {
        id: 'membership',
        label: 'メンバー継続',
        comments: [
          {
            id: 'preview-membership',
            name: 'メンバー継続さん',
            comment: '継続メッセージ本文です。',
            commentHtml: '継続メッセージ本文です。',
            profileImage: 'https://placehold.co/96x96/16a34a/ffffff?text=M',
            memberBadgeUrl: 'https://placehold.co/48x48/16a34a/ffffff?text=B',
            stickerImage: '',
            amount: 0,
            amountDisplay: '',
            isMember: true,
            isMembership: true,
            isMembershipGift: false,
            membershipHeader: 'メンバー歴 12 か月',
            giftCount: 0,
            isModerator: false,
            isOwner: false,
            isVerified: false,
            superchatTier: ''
          }
        ]
      },
      {
        id: 'gift',
        label: 'メンギフ',
        comments: [
          {
            id: 'preview-gift',
            name: 'ギフト隊長',
            comment: 'メンバーシップギフトを送りました。',
            commentHtml: 'メンバーシップギフトを送りました。',
            profileImage: 'https://placehold.co/96x96/7c3aed/ffffff?text=G',
            memberBadgeUrl: '',
            stickerImage: '',
            amount: 0,
            amountDisplay: '',
            isMember: false,
            isMembership: false,
            isMembershipGift: true,
            membershipHeader: 'メンバーシップギフト x 5',
            giftCount: 5,
            isModerator: false,
            isOwner: false,
            isVerified: false,
            superchatTier: ''
          }
        ]
      },
      {
        id: 'roles',
        label: '役職色',
        comments: [
          {
            id: 'preview-moderator',
            name: 'モデレーター',
            comment: '名前色の差分を確認します。',
            commentHtml: '名前色の差分を確認します。',
            profileImage: '',
            memberBadgeUrl: '',
            stickerImage: '',
            amount: 0,
            amountDisplay: '',
            isMember: false,
            isMembership: false,
            isMembershipGift: false,
            membershipHeader: '',
            giftCount: 0,
            isModerator: true,
            isOwner: false,
            isVerified: false,
            superchatTier: ''
          },
          {
            id: 'preview-owner',
            name: '配信者',
            comment: 'owner 色の差分も確認します。',
            commentHtml: 'owner 色の差分も確認します。',
            profileImage: '',
            memberBadgeUrl: '',
            stickerImage: '',
            amount: 0,
            amountDisplay: '',
            isMember: false,
            isMembership: false,
            isMembershipGift: false,
            membershipHeader: '',
            giftCount: 0,
            isModerator: false,
            isOwner: true,
            isVerified: false,
            superchatTier: ''
          }
        ]
      }
    ];
    scenarios.push({
      id: 'all',
      label: '全部',
      comments: scenarios.reduce(function (items, scenario) {
        return items.concat(cloneJson(scenario.comments || []));
      }, [])
    });
    return scenarios;
  }

  function createStandardDevPreviewScenarios(preset) {
    var normalized = preset || 'list-basic';
    if (normalized === 'list-basic' || normalized === 'ticker-basic') {
      return createStandardListPreviewScenarios();
    }
    return [];
  }

  function buildHtmlFirstStarterOptions(options) {
    var input = options && typeof options === 'object' ? options : {};
    var container = input.container || document.querySelector('[data-kh-start]') || document.getElementById('comments');
    if (!container) {
      throw new Error('htmlFirst.start requires a container');
    }
    var optionsSelector = input.optionsSelector || container.getAttribute('data-kh-options') || '#komehub-template-options';
    var scriptOptions = {};
    try {
      scriptOptions = readHtmlFirstJsonOptions(optionsSelector);
    } catch (err) {
      throw new Error('htmlFirst options JSON is invalid: ' + err.message);
    }
    var merged = mergeHtmlFirstOptions(scriptOptions, input);
    merged.container = input.container || container;
    merged.mode = merged.mode || container.getAttribute('data-kh-start') || 'list';
    merged.cellTemplate = merged.cellTemplate
      || container.getAttribute('data-kh-template')
      || container.getAttribute('data-kh-cell-template')
      || '#comment-template';
    merged.styleId = merged.styleId || container.getAttribute('data-kh-style-id') || '';
    merged.track = merged.track || container.getAttribute('data-kh-track') || '';
    if (typeof merged.beforeCommitComment === 'function' && typeof merged.renderlessModel !== 'boolean') {
      merged.renderlessModel = true;
    }
    if (merged.mode === 'list' && typeof merged.renderlessModel !== 'boolean') {
      merged.renderlessModel = true;
    }
    if (!merged.preview.preset) {
      var attrPreviewPreset = container.getAttribute('data-kh-dev-preview');
      if (attrPreviewPreset) merged.preview.preset = attrPreviewPreset;
    }
    if (!merged.preview.title) {
      merged.preview.title = merged.mode === 'ticker' ? 'HTML-first ticker preview' : 'HTML-first list preview';
    }
    return merged;
  }

  function setupHtmlFirstPreview(mode, starter, previewOptions) {
    if (!previewOptions || !runtimeConfig.preview || !runtimeConfig.devPreview) return null;
    var scenarios = Array.isArray(previewOptions.scenarios)
      ? cloneJson(previewOptions.scenarios)
      : createStandardDevPreviewScenarios(previewOptions.preset || (mode === 'ticker' ? 'ticker-basic' : 'list-basic'));
    if (!Array.isArray(scenarios) || scenarios.length === 0) return null;
    return createDevPreviewController({
      title: previewOptions.title || 'HTML-first preview',
      scenarios: scenarios,
      initialScenarioId: previewOptions.initialScenarioId || (scenarios[0] && scenarios[0].id) || '',
      onSelect: function (scenario) {
        var config = Object.assign({}, previewOptions.applyConfig || {}, (scenario && scenario.config) || {});
        if (typeof starter.applyConfig === 'function') {
          starter.applyConfig(config);
        }
        if (typeof starter.renderComments === 'function') {
          starter.renderComments((scenario && scenario.comments) || [], { replace: true });
        }
      }
    });
  }

  function startHtmlFirstTemplate(options) {
    var starterOptions = buildHtmlFirstStarterOptions(options);
    var mode = starterOptions.mode;
    var previewOptions = starterOptions.preview;
    delete starterOptions.mode;
    delete starterOptions.preview;
    var starter;
    if (mode === 'list') {
      starter = api.starters.list(starterOptions);
    } else if (mode === 'ticker') {
      starter = api.starters.ticker(starterOptions);
    } else {
      throw new Error('htmlFirst.start supports list/ticker only');
    }
    setupHtmlFirstPreview(mode, starter, previewOptions);
    return starter;
  }

  function createCustomStarter(options) {
    options = options || {};
    var starter = createStarterBase(options);
    starter.onConfig = options.onConfig;
    starter.onComments = options.onComments;
    starter.onDeleted = options.onDeleted;
    starter.onClear = options.onClear;
    starter.mount = options.mount;
    starter.dispose = options.dispose;

    api.register({
      mount: function (_payload, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        if (typeof starter.mount === 'function') starter.mount(starter);
      },
      onConfig: function (config, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        applyCommonFontSettings(starter, config || {});
        applyConfigBindings(config || {}, starter.configBindings, starter);
        if (typeof starter.onConfig === 'function') {
          starter.onConfig(config || {}, starter);
        }
      },
      onComments: function (comments, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        if (typeof starter.onComments === 'function') {
          starter.onComments(Array.isArray(comments) ? comments : [], starter);
        }
      },
      onDeleted: function (payload, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        if (typeof starter.onDeleted === 'function') {
          starter.onDeleted(payload || null, starter);
        }
      },
      onClear: function (payload, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        if (typeof starter.onClear === 'function') {
          starter.onClear(payload || null, starter);
        }
      },
      dispose: function (_payload, runtimeContext) {
        starter.root = runtimeContext.root;
        starter.body = runtimeContext.body;
        if (typeof starter.dispose === 'function') starter.dispose(starter);
      }
    });

    return starter;
  }

  var api = window.KomehubTemplateRuntime || {};

  api.register = function (nextAdapter) {
    if (adapter && adapter !== nextAdapter) {
      safeCall('dispose');
    }
    adapter = nextAdapter || null;
    safeCall('mount');
    if (latestConfig) {
      safeCall('onConfig', latestConfig);
    }
    return api;
  };

  api.unregister = function (targetAdapter) {
    if (targetAdapter && adapter !== targetAdapter) return;
    safeCall('dispose');
    adapter = null;
  };

  api.getContext = getContext;
  api.getRuntimeConfig = function () { return runtimeConfig; };
  api.getLatestConfig = function () { return latestConfig; };
  api.getResourceDebugInfo = function () { return refreshResourceDebugInfo(); };
  api.createListController = createListController;
  api.createCellTemplateRenderer = createCellTemplateRenderer;
  api.createDevPreviewController = createDevPreviewController;
  api.parts = parts;
  api.config = configHelpers;
  api.bindings = createStarterBindingsApi();
  api.starters = {
    list: createListStarter,
    ticker: createTickerStarter,
    custom: createCustomStarter
  };
  api.htmlFirst = {
    start: startHtmlFirstTemplate,
    createPreviewScenarios: createStandardDevPreviewScenarios
  };
  api.createOneCommeWebSocket = function () {
    return new WebSocket(runtimeConfig.oneCommeWsUrl);
  };

  window.KomehubTemplateRuntime = api;
  refreshResourceDebugInfo();
  ensureResourceDebugPanel();
  console.info('[KomehubTemplateRuntime] resource debug', refreshResourceDebugInfo());

  ensureRuntimeFonts(runtimeConfig.fonts);
  ensureRuntimeFontSources(runtimeConfig.fontSources);
  applyPreviewBackground(runtimeConfig.previewDefaultBackground);
  connectStream();
})();
