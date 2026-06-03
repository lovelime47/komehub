/**
 * 固定表示エフェクト
 * 初見歓迎・スパチャお礼などを固定位置に表示する。
 * 見た目テンプレートは「ネオンスタンプ (stamp)」と「宝箱 (treasure)」の 2 種。
 *
 * 宝箱 (treasure) の演出本体は同ディレクトリの treasure-engine.js (window.TreasureEngine)。
 * plugin-loader は entry (= fixed.js) しか読み込まないため、ここから同プラグイン
 * ディレクトリの treasure-engine.js を script タグで動的ロードする。エクスポートは
 * plugins/fixed/ ディレクトリ全体を同梱するので treasure-engine.js も一緒に運ばれる。
 */
(function loadTreasureEngine() {
  if (typeof document === 'undefined') return;
  if (window.TreasureEngine) return; // 既にロード済みなら何もしない (二重ロード防止)
  var self = document.currentScript;
  if (!self || !self.src) return; // currentScript 不明時は別経路の読込に委ねる
  var base = self.src.replace(/[^/]*$/, ''); // 末尾 "fixed.js?_=..." を除去してディレクトリ URL に
  var s = document.createElement('script');
  s.src = base + 'treasure-engine.js?_=' + Date.now();
  s.onerror = function () { console.warn('[fixed] treasure-engine.js の読み込みに失敗しました'); };
  document.head.appendChild(s);
})();

var Fixed = (function () {
  var container;

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // === キュー管理 ===
  var MAX_QUEUE = 1000;
  var queue = [];
  var activeCount = 0;
  var queueTimer = null;

  function onFinish() {
    activeCount--;
    processQueue();
  }

  function processQueue() {
    if (queue.length === 0) return;
    if (overlayPaused) return;
    if (activeCount > 0) return; // 前の表示が消えるまで待つ
    var job = queue.shift();
    job();
    if (queue.length > 0 && !queueTimer) {
      queueTimer = setTimeout(function () {
        queueTimer = null;
        processQueue();
      }, 200);
    }
  }

  function init(c) { container = c; }

  // ---- ネオンスタンプ系で使用する Web フォントを必要時のみロード ----
  var neonFontsLoaded = false;
  function ensureNeonFonts() {
    if (neonFontsLoaded) return;
    neonFontsLoaded = true;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Yusei+Magic&family=Pacifico&display=swap';
    document.head.appendChild(link);
  }

  // templateStyle ディスパッチ。 既定 = stamp (ネオンスタンプ)。
  // treasure 以外 (= 未指定 / 旧 card・spotlight 等) は stamp にフォールバックする。
  function show(params, assets, data) {
    if (!container) return;
    var templateStyle = (data && data.templateStyle) || 'stamp';
    if (templateStyle === 'treasure') {
      return showTreasure(data);
    }
    return showStamp(data);
  }

  // ====================================================================
  // Stamp 系 (ネオン看板)
  // エンブレム (8 形状 or カスタム画像) + 歓迎文 + 仕切り + 名前 を backboard に載せ、
  // 管が数回チラついてから安定点灯する本物のネオン起動を再現する。
  // brandColor + displayMessage 共有、stampShape/stampImage/stampFlicker/stampBackboard/
  // stampReflection 専用。listenerTag があればタグ行に表示。
  // ====================================================================

  var stampStylesInjected = false;
  function ensureStampStyles() {
    if (stampStylesInjected) return;
    stampStylesInjected = true;
    var style = document.createElement('style');
    style.textContent = STAMP_CSS;
    document.head.appendChild(style);
  }

  var STAMP_CSS = `
.ks-stamp { position: absolute; pointer-events: none; }

/* 壁に滲むアンビエント光 */
.ks-stamp .ks-ambient {
  position: absolute; left: 50%; top: 48%; width: 150%; height: 150%;
  transform: translate(-50%, -50%);
  background: radial-gradient(ellipse 50% 42% at center,
    color-mix(in srgb, var(--neon-color, #ff6b9d) 80%, transparent) 0%,
    color-mix(in srgb, var(--neon-color, #ff6b9d) 35%, transparent) 28%,
    transparent 62%);
  opacity: 0; filter: blur(18px); transition: opacity 0.5s ease;
  pointer-events: none; z-index: 0;
}
.ks-stamp.ks-lit .ks-ambient { opacity: 0.16; }

/* アクリル backboard + 四隅スタンドオフ */
.ks-stamp .ks-board {
  position: absolute; inset: 10px; border-radius: 22px; z-index: 1;
  background: linear-gradient(160deg, rgba(14,16,24,0.66), rgba(8,9,14,0.74));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.05),
    inset 0 0 40px rgba(0,0,0,0.55),
    0 18px 50px rgba(0,0,0,0.55);
  border: 1px solid rgba(255,255,255,0.06);
  opacity: 0; transition: opacity 0.5s ease;
}
.ks-stamp.ks-lit .ks-board { opacity: 1; }
.ks-stamp .ks-board::after {
  content: ''; position: absolute; inset: 0; border-radius: 22px;
  box-shadow: inset 0 0 60px color-mix(in srgb, var(--neon-color, #ff6b9d) 45%, transparent);
  opacity: 0; transition: opacity 0.6s ease;
}
.ks-stamp.ks-lit .ks-board::after { opacity: 0.5; }
.ks-stamp .ks-screw {
  position: absolute; width: 9px; height: 9px; border-radius: 50%; z-index: 3;
  background: radial-gradient(circle at 35% 30%, #cdd2dc, #6b7180 60%, #2b2e36);
  box-shadow: 0 1px 2px rgba(0,0,0,0.6);
  opacity: 0; transition: opacity 0.5s ease;
}
.ks-stamp.ks-lit .ks-screw { opacity: 0.85; }
.ks-stamp .ks-screw.ks-tl { left: 20px; top: 20px; }
.ks-stamp .ks-screw.ks-tr { right: 20px; top: 20px; }
.ks-stamp .ks-screw.ks-bl { left: 20px; bottom: 20px; }
.ks-stamp .ks-screw.ks-br { right: 20px; bottom: 20px; }

/* 看板の中身 */
.ks-stamp .ks-sign {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  text-align: center;
}
.ks-stamp .ks-emblem { width: 84px; height: 84px; margin-bottom: 2px; }
.ks-stamp .ks-emblem svg { width: 100%; height: 100%; overflow: visible; display: block; }
/* カスタム画像エンブレム (透過 PNG / SVG の白線画を想定。 alpha に沿って drop-shadow が bloom する) */
.ks-stamp .ks-emblem img { width: 100%; height: 100%; object-fit: contain; display: block;
  opacity: 0.18; transition: opacity 0.08s; }
.ks-stamp.ks-lit .ks-emblem img {
  opacity: 1;
  filter:
    drop-shadow(0 0 1px #fff)
    drop-shadow(0 0 5px var(--neon-color, #ff6b9d))
    drop-shadow(0 0 12px var(--neon-color, #ff6b9d))
    drop-shadow(0 0 24px var(--neon-color, #ff6b9d))
    drop-shadow(0 0 46px color-mix(in srgb, var(--neon-color, #ff6b9d) 60%, transparent));
}

/* 形状 (消灯時の暗いガラス管) */
.ks-stamp .ks-outer { fill: rgba(0,0,0,0.30); stroke: rgba(190,194,205,0.16); stroke-width: 5;
  stroke-linecap: round; stroke-linejoin: round; }
.ks-stamp .ks-outer-noglow { fill: rgba(0,0,0,0.30); stroke: rgba(190,194,205,0.16); stroke-width: 5;
  stroke-linecap: round; stroke-linejoin: round; }
.ks-stamp .ks-outer-line-noglow { fill: none; stroke: rgba(190,194,205,0.16); stroke-width: 5;
  stroke-linecap: round; stroke-linejoin: round; }
.ks-stamp .ks-inner-ring { fill: none; stroke: rgba(255,255,255,0.12); stroke-width: 1.2;
  stroke-linecap: round; stroke-linejoin: round; opacity: 0.6; }
.ks-stamp .ks-crescent-inner { fill: none; stroke: rgba(190,194,205,0.16); stroke-width: 2.4; stroke-linecap: round; }
.ks-stamp .ks-snowflake-spoke { fill: none; stroke: rgba(190,194,205,0.16); stroke-width: 3.4; stroke-linecap: round; }

/* 形状 (点灯時の白コア + ブランドカラー bloom) */
.ks-stamp.ks-lit .ks-outer,
.ks-stamp.ks-lit .ks-outer-noglow,
.ks-stamp.ks-lit .ks-outer-line-noglow { stroke: #fff; }
.ks-stamp.ks-lit .ks-outer { fill: rgba(0,0,0,0.18); }
.ks-stamp.ks-lit .ks-glow,
.ks-stamp.ks-lit .ks-emblem svg > .ks-outer {
  filter:
    drop-shadow(0 0 1px #fff)
    drop-shadow(0 0 5px var(--neon-color, #ff6b9d))
    drop-shadow(0 0 12px var(--neon-color, #ff6b9d))
    drop-shadow(0 0 24px var(--neon-color, #ff6b9d))
    drop-shadow(0 0 46px color-mix(in srgb, var(--neon-color, #ff6b9d) 60%, transparent));
}
.ks-stamp.ks-lit .ks-crescent-inner { stroke: #fff;
  filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 4px var(--neon-color, #ff6b9d)) drop-shadow(0 0 10px var(--neon-color, #ff6b9d)); }
.ks-stamp.ks-lit .ks-snowflake-spoke { stroke: #fff;
  filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 6px var(--neon-color, #ff6b9d)) drop-shadow(0 0 16px var(--neon-color, #ff6b9d)); }
.ks-stamp.ks-lit .ks-inner-ring { stroke: rgba(255,255,255,0.5); filter: drop-shadow(0 0 3px var(--neon-color, #ff6b9d)); }

/* タグ (初見 等の listenerTag) */
.ks-stamp .ks-tag {
  font-family: 'Cormorant Garamond', serif;
  font-size: 15px; letter-spacing: 0.42em; text-indent: 0.42em;
  text-transform: uppercase; font-weight: 600;
  color: color-mix(in srgb, var(--neon-color, #ff6b9d) 22%, #07080c);
  transition: color 0.06s;
}
.ks-stamp.ks-lit .ks-tag { color: #fff;
  text-shadow: 0 0 2px #fff, 0 0 7px var(--neon-color, #ff6b9d), 0 0 15px var(--neon-color, #ff6b9d), 0 0 28px var(--neon-color, #ff6b9d); }

/* 主役: 歓迎メッセージ (ネオン管) */
.ks-stamp .ks-greeting {
  font-family: 'Yusei Magic', 'Yu Gothic UI', sans-serif;
  font-size: 52px; line-height: 1.12; letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--neon-color, #ff6b9d) 22%, #07080c);
  white-space: nowrap; transition: color 0.05s;
}
.ks-stamp.ks-lit .ks-greeting { color: #fff;
  text-shadow:
    0 0 2px #fff, 0 0 5px #fff,
    0 0 11px var(--neon-color, #ff6b9d), 0 0 22px var(--neon-color, #ff6b9d),
    0 0 38px var(--neon-color, #ff6b9d), 0 0 62px var(--neon-color, #ff6b9d),
    0 0 96px color-mix(in srgb, var(--neon-color, #ff6b9d) 55%, transparent); }

/* 仕切り */
.ks-stamp .ks-divider {
  width: 0; height: 3px; border-radius: 3px; margin: 4px 0 2px;
  background: color-mix(in srgb, var(--neon-color, #ff6b9d) 22%, #07080c);
  transition: width 0.5s cubic-bezier(0.16,1,0.3,1);
}
.ks-stamp.ks-lit .ks-divider { width: 64%; background: #fff;
  box-shadow: 0 0 4px #fff, 0 0 10px var(--neon-color, #ff6b9d), 0 0 22px var(--neon-color, #ff6b9d), 0 0 40px var(--neon-color, #ff6b9d); }

/* ユーザー名 (手書き script) */
.ks-stamp .ks-username {
  font-family: 'Pacifico', 'Yusei Magic', cursive;
  font-size: 30px; line-height: 1.1; letter-spacing: 0.01em;
  color: color-mix(in srgb, var(--neon-color, #ff6b9d) 22%, #07080c);
  white-space: nowrap; transition: color 0.05s;
}
.ks-stamp.ks-lit .ks-username { color: #fff;
  text-shadow:
    0 0 2px #fff, 0 0 5px var(--neon-color, #ff6b9d), 0 0 13px var(--neon-color, #ff6b9d),
    0 0 24px var(--neon-color, #ff6b9d), 0 0 42px color-mix(in srgb, var(--neon-color, #ff6b9d) 55%, transparent); }

/* 反射 */
.ks-stamp .ks-reflection {
  position: absolute; left: 50%; bottom: -6px; z-index: 1;
  transform: translateX(-50%) scaleY(-1);
  opacity: 0; transition: opacity 0.5s ease;
  -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0.45), transparent 70%);
  mask-image: linear-gradient(to bottom, rgba(0,0,0,0.45), transparent 70%);
  filter: blur(2px); pointer-events: none;
  font-family: 'Yusei Magic', 'Yu Gothic UI', sans-serif; font-size: 52px;
  color: #fff; text-shadow: 0 0 8px var(--neon-color, #ff6b9d), 0 0 20px var(--neon-color, #ff6b9d);
  white-space: nowrap;
}
.ks-stamp.ks-lit .ks-reflection { opacity: 0.22; }

/* 微細な持続フリッカー (stampFlicker ON 時) */
.ks-stamp.ks-steady .ks-sign,
.ks-stamp.ks-steady .ks-ambient { animation: ks-microflicker 5.5s infinite; }
@keyframes ks-microflicker {
  0%, 58%, 63%, 78%, 100% { opacity: 1; }
  60% { opacity: 0.86; } 61% { opacity: 1; }
  80% { opacity: 0.9; }  81% { opacity: 1; }
}

/* 登場バースト粒子 */
.ks-stamp .ks-burst-dot {
  position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #fff;
  opacity: 0; pointer-events: none; z-index: 4;
  box-shadow: 0 0 5px var(--neon-color, #ff6b9d), 0 0 12px var(--neon-color, #ff6b9d);
}
`;

  // 形状ごとの SVG 内部マークアップ (viewBox 0 0 200 200)。エンブレム用に最適化。
  var STAMP_SHAPES = {
    circle: '<circle class="ks-outer" cx="100" cy="100" r="78"/><circle class="ks-inner-ring" cx="100" cy="100" r="68"/>',
    heart: '<path class="ks-outer" d="M 100 168 C 100 168 30 122 30 78 C 30 52 50 32 75 32 C 90 32 100 42 100 56 C 100 42 110 32 125 32 C 150 32 170 52 170 78 C 170 122 100 168 100 168 Z"/>',
    star: '<polygon class="ks-outer" points="100,22 124,80 187,82 137,118 156,180 100,142 44,180 63,118 13,82 76,80"/>',
    sakura: '<g class="ks-glow">'
      + '<ellipse class="ks-outer-noglow" cx="100" cy="50" rx="20" ry="35"/>'
      + '<ellipse class="ks-outer-noglow" cx="100" cy="50" rx="20" ry="35" transform="rotate(72 100 100)"/>'
      + '<ellipse class="ks-outer-noglow" cx="100" cy="50" rx="20" ry="35" transform="rotate(144 100 100)"/>'
      + '<ellipse class="ks-outer-noglow" cx="100" cy="50" rx="20" ry="35" transform="rotate(216 100 100)"/>'
      + '<ellipse class="ks-outer-noglow" cx="100" cy="50" rx="20" ry="35" transform="rotate(288 100 100)"/>'
      + '</g><circle class="ks-inner-ring" cx="100" cy="100" r="10"/>',
    crescent: '<g class="ks-glow">'
      + '<path class="ks-outer-line-noglow" d="M 158 45 A 80 80 0 1 0 158 155"/>'
      + '<polygon class="ks-outer-noglow" points="155,80 159,93 173,93 162,101 166,114 155,107 144,114 148,101 137,93 151,93"/>'
      + '</g>'
      + '<path class="ks-crescent-inner" d="M 158 155 A 45 45 0 1 1 158 45" fill="none"/>',
    crown: '<g class="ks-glow">'
      + '<path class="ks-outer-noglow" d="M 35 165 L 35 80 L 65 110 L 80 50 L 105 95 L 130 50 L 145 110 L 175 80 L 175 165 Z"/>'
      + '<circle class="ks-outer-noglow" cx="80" cy="45" r="6"/>'
      + '<circle class="ks-outer-noglow" cx="105" cy="85" r="5"/>'
      + '<circle class="ks-outer-noglow" cx="130" cy="45" r="6"/>'
      + '</g>'
      + '<line class="ks-inner-ring" x1="38" y1="150" x2="172" y2="150"/>',
    paw: '<g class="ks-glow">'
      + '<ellipse class="ks-outer-noglow" cx="100" cy="145" rx="55" ry="46"/>'
      + '<ellipse class="ks-outer-noglow" cx="50" cy="80" rx="13" ry="18" transform="rotate(-20 50 80)"/>'
      + '<ellipse class="ks-outer-noglow" cx="78" cy="68" rx="13" ry="18" transform="rotate(-8 78 68)"/>'
      + '<ellipse class="ks-outer-noglow" cx="122" cy="68" rx="13" ry="18" transform="rotate(8 122 68)"/>'
      + '<ellipse class="ks-outer-noglow" cx="150" cy="80" rx="13" ry="18" transform="rotate(20 150 80)"/>'
      + '</g>',
    snowflake: function () {
      var spokeLines = '<line x1="100" y1="100" x2="100" y2="22"/>'
        + '<line x1="100" y1="30" x2="88" y2="22"/>'
        + '<line x1="100" y1="30" x2="112" y2="22"/>'
        + '<line x1="100" y1="48" x2="89" y2="40"/>'
        + '<line x1="100" y1="48" x2="111" y2="40"/>';
      var spokes = '';
      for (var i = 0; i < 6; i++) {
        spokes += '<g transform="rotate(' + (i * 60) + ' 100 100)">' + spokeLines + '</g>';
      }
      return '<g class="ks-snowflake-spoke">' + spokes + '</g>'
        + '<circle class="ks-inner-ring" cx="100" cy="100" r="48"/>';
    }
  };

  // 看板の基準スケール。 scale slider 100% = この倍率。
  // mock の素サイズは大きすぎたため 0.65 を等倍基準とした (= 2026-05-24 実機調整で確定)。
  var STAMP_DEFAULT_SCALE = 0.65;

  function showStamp(data) {
    ensureNeonFonts();
    ensureStampStyles();
    var noOverlap = (data && data.noOverlap != null) ? data.noOverlap : true;
    var spawnFn = function () { spawnStamp(data); };

    if (noOverlap) {
      if (activeCount === 0) {
        activeCount++;
        spawnFn();
      } else if (queue.length < MAX_QUEUE) {
        queue.push(function () { activeCount++; spawnFn(); });
      }
    } else {
      activeCount++;
      spawnFn();
    }
  }

  // ネオン看板: エンブレム + 歓迎文 + 仕切り + 名前 を backboard に載せ、
  // 管が数回チラついてから安定点灯する本物のネオン起動を再現する。
  function spawnStamp(data) {
    var ctx = (data && data.context) || {};
    var welcomeMessage = (data && data.displayMessage) || '初見さんいらっしゃい！';
    var brandColor = (data && data.brandColor) || '#5eead4';
    var stampShape = (data && data.stampShape) || 'circle';
    var stampFlicker = !!(data && data.stampFlicker);
    var showBoard = (data && data.stampBackboard != null) ? data.stampBackboard : true;
    var showScrews = (data && data.stampScrews != null) ? data.stampScrews : true;
    var showReflect = (data && data.stampReflection != null) ? data.stampReflection : true;
    var stayDuration = (data && data.stayDuration != null) ? data.stayDuration : 5500;
    var posX = (data && data.posX != null) ? data.posX : 50;
    var posY = (data && data.posY != null) ? data.posY : 30;
    var scaleFactor = (((data && data.scale) || 100) / 100) * STAMP_DEFAULT_SCALE;
    var zOrder = (data && data.zOrder) || 1;
    var shapeDef = STAMP_SHAPES[stampShape] || STAMP_SHAPES.circle;
    var shapeMarkup = (typeof shapeDef === 'function') ? shapeDef() : shapeDef;
    var tagText = ctx.listenerTag || '';
    var nameText = ctx.userName || '';

    // カスタム画像エンブレム: stampImage があれば SVG 形状の代わりに <img> を使う。
    // uiSchema image 値はファイル名のみなので _assetsBase で URL 化する (sprout wand と同経路)。
    var stampImage = (data && data.stampImage) || '';
    var assetsBase = (data && data._assetsBase) || '';
    var emblemInner;
    if (stampImage) {
      var imgUrl = /^(https?:|data:)/.test(stampImage) ? stampImage : (assetsBase + stampImage);
      emblemInner = '<img src="' + esc(imgUrl) + '" alt="">';
    } else {
      emblemInner = '<svg viewBox="0 0 200 200">' + shapeMarkup + '</svg>';
    }

    var root = document.createElement('div');
    root.className = 'ks-stamp';
    root.style.cssText = 'left:' + posX + '%;top:' + posY + '%;'
      + 'width:max-content;padding:36px 52px;'
      + 'transform:translate(-50%,-50%) scale(' + scaleFactor + ');'
      + 'z-index:' + zOrder + ';';
    root.style.setProperty('--neon-color', brandColor);

    var boardHtml = (showBoard ? '<div class="ks-board"></div>' : '')
      + (showScrews
        ? '<span class="ks-screw ks-tl"></span><span class="ks-screw ks-tr"></span>'
          + '<span class="ks-screw ks-bl"></span><span class="ks-screw ks-br"></span>'
        : '');
    var reflectHtml = showReflect
      ? '<div class="ks-reflection">' + esc(welcomeMessage) + '</div>'
      : '';

    root.innerHTML = '<div class="ks-ambient"></div>'
      + boardHtml
      + '<div class="ks-sign">'
        + '<div class="ks-emblem">' + emblemInner + '</div>'
        + (tagText ? '<div class="ks-tag">' + esc(tagText) + '</div>' : '')
        + '<div class="ks-greeting">' + esc(welcomeMessage) + '</div>'
        + '<div class="ks-divider"></div>'
        + (nameText ? '<div class="ks-username">' + esc(nameText) + '</div>' : '')
      + '</div>'
      + reflectHtml;

    container.appendChild(root);
    void root.offsetWidth; // reflow して transition/点灯の起点を確定

    // 点灯シーケンス: 管が "じじっ" とチラついてから安定
    var seq = [[120, 1], [180, 0], [240, 1], [300, 0], [360, 1], [430, 0], [470, 1], [560, 0], [620, 1]];
    seq.forEach(function (s) {
      setTimeout(function () {
        if (s[1]) root.classList.add('ks-lit'); else root.classList.remove('ks-lit');
      }, s[0]);
    });
    setTimeout(function () { root.classList.add('ks-lit'); spawnStampBurst(root); }, 700);
    if (stampFlicker) setTimeout(function () { root.classList.add('ks-steady'); }, 1300);

    // 消灯 (死にかけフリッカー → 暗転フェード) → 除去
    setTimeout(function () {
      root.classList.remove('ks-steady');
      setTimeout(function () { root.classList.remove('ks-lit'); }, 0);
      setTimeout(function () { root.classList.add('ks-lit'); }, 70);
      setTimeout(function () { root.classList.remove('ks-lit'); }, 130);
      setTimeout(function () { root.style.transition = 'opacity 0.5s ease'; root.style.opacity = '0'; }, 170);
    }, stayDuration);
    setTimeout(function () { root.remove(); onFinish(); }, stayDuration + 800);
  }

  // ===== 宝箱 (treasure) — 共有エンジン TreasureEngine を shadow DOM で固定表示 =====
  var TREASURE_BASE_SCALE = 0.6;

  function showTreasure(data) {
    if (!window.TreasureEngine) { console.warn('[fixed] TreasureEngine 未ロード'); return; }
    var noOverlap = (data && data.noOverlap != null) ? data.noOverlap : true;
    var spawnFn = function () { spawnTreasure(data); };
    if (noOverlap) {
      if (activeCount === 0) { activeCount++; spawnFn(); }
      else if (queue.length < MAX_QUEUE) { queue.push(function () { activeCount++; spawnFn(); }); }
    } else {
      activeCount++; spawnFn();
    }
  }

  function spawnTreasure(data) {
    var ctx = (data && data.context) || {};
    var posX = (data && data.posX != null) ? data.posX : 50;
    var posY = (data && data.posY != null) ? data.posY : 45;
    var scaleFactor = (((data && data.scale) || 100) / 100) * TREASURE_BASE_SCALE;
    var zOrder = (data && data.zOrder) || 1;

    var root = document.createElement('div');
    root.style.cssText = 'position:absolute;left:' + posX + '%;top:' + posY + '%;'
      + 'width:520px;height:550px;transform-origin:center center;'
      + 'transform:translate(-50%,-50%) scale(' + scaleFactor + ');'
      + 'z-index:' + zOrder + ';pointer-events:none;';
    container.appendChild(root);

    var opts = {
      amount: ctx.amount || 0,
      name: ctx.userName || '',
      amountDisplay: ctx.amountDisplay || ''
    };
    var done = false;
    function finish() { if (done) return; done = true; if (root.parentNode) root.remove(); onFinish(); }
    try {
      window.TreasureEngine.play(root, opts, finish);
    } catch (e) {
      console.error('[fixed] TreasureEngine.play error', e);
      finish();
      return;
    }
    // 保険: onDone が来なくても最大 14s で確実に除去
    setTimeout(finish, 14000);
  }

  function spawnStampBurst(root) {
    for (var i = 0; i < 14; i++) {
      var d = document.createElement('div');
      d.className = 'ks-burst-dot';
      d.style.left = '50%';
      d.style.top = '42%';
      root.appendChild(d);
      var ang = (i / 14) * 360 + (Math.random() * 24 - 12);
      var dist = 70 + Math.random() * 70;
      var dx = Math.cos(ang * Math.PI / 180) * dist;
      var dy = Math.sin(ang * Math.PI / 180) * dist;
      (function (el) {
        el.animate([
          { opacity: 1, transform: 'translate(-50%,-50%) translate(0,0) scale(1)' },
          { opacity: 0, transform: 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(0.2)' }
        ], { duration: 750 + Math.random() * 250, easing: 'ease-out', fill: 'forwards' });
        setTimeout(function () { el.remove(); }, 1100);
      })(d);
    }
  }

  var overlayPaused = false;
  function setPaused(val) {
    overlayPaused = val;
    if (!val) {
      // 表示中の演出が終わるのを待ってからキューを再開
      var resumeCheck = setInterval(function () {
        if (activeCount === 0) {
          clearInterval(resumeCheck);
          processQueue();
        }
      }, 500);
    }
  }

  return { init: init, show: show, setPaused: setPaused };
})();
