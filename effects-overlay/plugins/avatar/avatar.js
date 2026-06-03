/**
 * リアクション連動アバター エフェクトプラグイン
 * フレームアニメーション + パーティクルエフェクトを統合
 *
 * init() でアバター要素を常駐配置（idle状態）
 * show() でリアクション発火（フレームアニメ開始 + パーティクル生成）
 * setPaused() でオーバーレイ一時停止対応
 */
var AvatarEffect = (function () {
  var container;
  var avatarContainer;  // アバター位置決め用ラッパー
  var avatarEl;         // アバター本体（is-idle / is-reacting クラス切替）
  var imgEl;            // フレーム画像
  var particleContainer;

  // フレームアニメーション状態
  var frames = [];         // 素材パスリスト（show()で受け取る）
  var frameInterval = 150;
  var reactDuration = 2000;
  var animTimer = null;
  var currentFrame = 0;
  var isAnimating = false;
  var reactEndTimer = null;
  var pendingReaction = false;

  // パーティクル設定
  var MAX_PARTICLES = 30;
  var activeParticleCount = 0;
  var riseDistance = 180;
  var spreadWidth = 120;

  var VALID_PATTERNS = ['float-up', 'scatter', 'sparkle', 'fountain'];

  var DEFAULT_PARTICLES = {
    heart: ['\uD83D\uDC96', '\uD83D\uDC95', '\uD83D\uDC97', '\uD83D\uDC93', '\uD83D\uDC97'],
    smile: ['\uD83D\uDE04', '\u2728', '\uD83C\uDF1F', '\u2B50'],
    celebration: ['\uD83C\uDF89', '\uD83C\uDF8A', '\u2B50', '\uD83C\uDF1F'],
    surprise: ['\uD83D\uDE2E', '\u2757', '\u2049\uFE0F', '\uD83D\uDCA5'],
    hundred: ['\uD83D\uDCAF', '\uD83C\uDF86', '\uD83C\uDF87', '\uD83D\uDD25']
  };

  var DEFAULT_PATTERNS = {
    heart: 'float-up',
    smile: 'sparkle',
    celebration: 'scatter',
    surprise: 'fountain',
    hundred: 'fountain'
  };

  // 位置キャッシュ（getOrigin用。素材未設定でもパーティクル位置を正しく計算するため）
  var cachedPosX = 90;
  var cachedPosY = 90;

  // 一時停止状態
  var paused = false;

  // CSS注入済みフラグ
  var cssInjected = false;

  function injectCSS() {
    if (cssInjected) return;
    cssInjected = true;

    var style = document.createElement('style');
    style.textContent =
      /* アバター本体 */
      '.avatar-plugin-container {' +
        'position: fixed;' +
        'z-index: 10;' +
        'pointer-events: none;' +
      '}' +
      '.avatar-plugin-body {' +
        'width: 120px;' +
      '}' +
      '.avatar-plugin-body img {' +
        'width: 100%;' +
        'height: auto;' +
        'display: block;' +
      '}' +
      /* アイドル: 軽く浮遊 */
      '.avatar-plugin-body.is-idle {' +
        'animation: avatarPluginIdle 3s ease-in-out infinite;' +
      '}' +
      /* リアクション: 揺れ */
      '.avatar-plugin-body.is-reacting {' +
        'animation: avatarPluginReact 0.3s ease-in-out infinite alternate;' +
      '}' +
      '@keyframes avatarPluginIdle {' +
        '0%, 100% { transform: translateY(0); }' +
        '50% { transform: translateY(-4px); }' +
      '}' +
      '@keyframes avatarPluginReact {' +
        '0% { transform: translateX(-2px) rotate(-1deg); }' +
        '100% { transform: translateX(2px) rotate(1deg); }' +
      '}' +
      /* パーティクル共通 */
      '.avatar-particle {' +
        'position: fixed;' +
        'pointer-events: none;' +
        'z-index: 20;' +
        'animation: avatarFloatUp var(--duration, 2s) ease-out forwards;' +
      '}' +
      '.avatar-particle-float-up { animation-name: avatarFloatUp; }' +
      '.avatar-particle-scatter { animation-name: avatarScatter; }' +
      '.avatar-particle-sparkle { animation-name: avatarSparkle; }' +
      '.avatar-particle-fountain { animation-name: avatarFountain; }' +
      /* float-up */
      '@keyframes avatarFloatUp {' +
        '0% { transform: translateY(0) translateX(0) scale(1); opacity: 1; }' +
        '80% { opacity: 0.8; }' +
        '100% { transform: translateY(var(--rise-distance, -180px)) translateX(var(--drift, 0px)) scale(0.6); opacity: 0; }' +
      '}' +
      /* scatter */
      '@keyframes avatarScatter {' +
        '0% { transform: translateY(0) translateX(0) scale(0.5); opacity: 1; }' +
        '30% { transform: translateY(var(--scatter-y, -60px)) translateX(var(--drift, 0px)) scale(1.2); opacity: 1; }' +
        '100% { transform: translateY(calc(var(--scatter-y, -60px) * 2.5)) translateX(calc(var(--drift, 0px) * 2.5)) scale(0.3); opacity: 0; }' +
      '}' +
      /* sparkle */
      '@keyframes avatarSparkle {' +
        '0% { transform: translateY(var(--sparkle-y, -30px)) translateX(var(--sparkle-x, 0px)) scale(0) rotate(0deg); opacity: 0; }' +
        '20% { transform: translateY(var(--sparkle-y, -30px)) translateX(var(--sparkle-x, 0px)) scale(1.3) rotate(90deg); opacity: 1; }' +
        '50% { transform: translateY(calc(var(--sparkle-y, -30px) * 1.3)) translateX(var(--sparkle-x, 0px)) scale(0.8) rotate(180deg); opacity: 0.8; }' +
        '100% { transform: translateY(calc(var(--sparkle-y, -30px) * 1.8)) translateX(var(--sparkle-x, 0px)) scale(0) rotate(360deg); opacity: 0; }' +
      '}' +
      /* fountain */
      '@keyframes avatarFountain {' +
        '0% { transform: translateY(0) translateX(0) scale(0.8); opacity: 1; }' +
        '15% { transform: translateY(calc(var(--rise-distance, -180px) * 0.7)) translateX(calc(var(--fountain-x, 20px) * 0.3)) scale(1.1); opacity: 1; }' +
        '35% { transform: translateY(var(--rise-distance, -180px)) translateX(calc(var(--fountain-x, 20px) * 0.6)) scale(1); opacity: 0.9; }' +
        '60% { transform: translateY(calc(var(--rise-distance, -180px) * 0.6)) translateX(calc(var(--fountain-x, 20px) * 0.85)) scale(0.9); opacity: 0.7; }' +
        '100% { transform: translateY(20px) translateX(var(--fountain-x, 20px)) scale(0.4); opacity: 0; }' +
      '}';
    document.head.appendChild(style);
  }

  // --- 初期化 ---

  function init(c) {
    container = c;
    injectCSS();

    // アバター常駐要素を作成
    avatarContainer = document.createElement('div');
    avatarContainer.className = 'avatar-plugin-container';

    avatarEl = document.createElement('div');
    avatarEl.className = 'avatar-plugin-body is-idle';

    imgEl = document.createElement('img');
    imgEl.alt = 'avatar';
    avatarEl.appendChild(imgEl);

    // パーティクルコンテナ
    particleContainer = document.createElement('div');
    particleContainer.style.position = 'fixed';
    particleContainer.style.left = '0';
    particleContainer.style.top = '0';
    particleContainer.style.width = '100%';
    particleContainer.style.height = '100%';
    particleContainer.style.pointerEvents = 'none';
    particleContainer.style.zIndex = '20';

    avatarContainer.appendChild(avatarEl);
    container.appendChild(avatarContainer);
    container.appendChild(particleContainer);

    // 初期状態: アバターは非表示（素材が来るまで）
    avatarContainer.style.display = 'none';
  }

  // --- フレームアニメーション ---

  function applyPosition(params) {
    if (!avatarContainer) return;
    var posX = params.posX != null ? params.posX : 90;
    var posY = params.posY != null ? params.posY : 90;
    var scale = params.avatarScale != null ? params.avatarScale : 100;

    cachedPosX = posX;
    cachedPosY = posY;

    avatarContainer.style.left = posX + '%';
    avatarContainer.style.top = posY + '%';
    avatarContainer.style.transform = 'translate(-50%, -50%) scale(' + (scale / 100) + ')';

    // アバター非表示設定
    if (params.showAvatar === false) {
      avatarContainer.style.visibility = 'hidden';
    } else {
      avatarContainer.style.visibility = '';
    }

    // パーティクル非表示設定
    if (params.showParticles === false) {
      particleContainer.style.display = 'none';
    } else {
      particleContainer.style.display = '';
    }
  }

  function setupFrames(assets) {
    if (!assets || assets.length === 0) return;

    // 素材が変わった場合のみ更新
    var newKey = assets.join(',');
    if (frames.join(',') === newKey) return;

    frames = assets.slice();
    // 初回フレームを表示してアバターを見せる
    imgEl.src = frames[0];
    avatarContainer.style.display = '';
  }

  function frameSrc(n) {
    return frames[n % frames.length];
  }

  function startAnimation() {
    if (isAnimating || frames.length < 2) return;
    isAnimating = true;

    avatarEl.classList.remove('is-idle');
    avatarEl.classList.add('is-reacting');

    currentFrame = 0;
    animTimer = setInterval(function () {
      currentFrame = (currentFrame + 1) % frames.length;
      imgEl.src = frameSrc(currentFrame);
    }, frameInterval);
  }

  function stopAnimation() {
    if (!isAnimating) return;
    isAnimating = false;

    clearInterval(animTimer);
    animTimer = null;

    avatarEl.classList.remove('is-reacting');
    avatarEl.classList.add('is-idle');
    if (frames.length > 0) {
      imgEl.src = frames[0];
    }
  }

  function scheduleEnd() {
    if (reactEndTimer) {
      clearTimeout(reactEndTimer);
    }
    reactEndTimer = setTimeout(function () {
      reactEndTimer = null;
      if (pendingReaction) {
        pendingReaction = false;
        scheduleEnd();
      } else {
        stopAnimation();
      }
    }, reactDuration);
  }

  // --- パーティクル ---

  function getPattern(reactionType) {
    return DEFAULT_PATTERNS[reactionType] || 'float-up';
  }

  function getOrigin() {
    if (!avatarContainer) {
      return { x: window.innerWidth / 2, y: window.innerHeight - 100 };
    }
    var rect = avatarContainer.getBoundingClientRect();
    // display:none や未配置の場合、rect が全て0になるのでキャッシュ位置から算出
    if (rect.width === 0 && rect.height === 0) {
      return {
        x: window.innerWidth * cachedPosX / 100,
        y: window.innerHeight * cachedPosY / 100
      };
    }
    return {
      x: rect.left + rect.width / 2,
      y: rect.top
    };
  }

  function createParticle(reactionType, sizeMin, sizeMax) {
    if (activeParticleCount >= MAX_PARTICLES) return;

    var pattern = getPattern(reactionType);
    var origin = getOrigin();
    var el = document.createElement('div');
    el.className = 'avatar-particle avatar-particle-' + pattern;

    var size = sizeMin + Math.random() * (sizeMax - sizeMin);

    var items = DEFAULT_PARTICLES[reactionType] || DEFAULT_PARTICLES.heart;
    var chosen = items[Math.floor(Math.random() * items.length)];
    el.textContent = chosen;
    el.style.fontSize = size + 'px';

    // 共通CSS変数
    el.style.setProperty('--drift', ((Math.random() - 0.5) * 100) + 'px');
    el.style.setProperty('--duration', (1.5 + Math.random() * 1.5) + 's');
    el.style.setProperty('--rise-distance', (-riseDistance) + 'px');

    // パターンごとの初期位置
    if (pattern === 'sparkle') {
      el.style.left = (origin.x + (Math.random() - 0.5) * 150) + 'px';
      el.style.top = (origin.y - Math.random() * riseDistance * 0.6) + 'px';
      el.style.setProperty('--sparkle-x', ((Math.random() - 0.5) * 40) + 'px');
      el.style.setProperty('--sparkle-y', (-20 - Math.random() * 40) + 'px');
    } else if (pattern === 'fountain') {
      el.style.left = (origin.x + (Math.random() - 0.5) * 40) + 'px';
      el.style.top = origin.y + 'px';
      el.style.setProperty('--fountain-x', ((Math.random() - 0.5) * 200) + 'px');
    } else if (pattern === 'scatter') {
      el.style.left = (origin.x + (Math.random() - 0.5) * 120) + 'px';
      el.style.top = origin.y + 'px';
      var angle = Math.random() * Math.PI * 2;
      var dist = 60 + Math.random() * 60;
      el.style.setProperty('--scatter-y', (Math.sin(angle) * dist) + 'px');
      el.style.setProperty('--drift', (Math.cos(angle) * dist) + 'px');
    } else {
      // float-up
      el.style.left = (origin.x + (Math.random() - 0.5) * spreadWidth) + 'px';
      el.style.top = origin.y + 'px';
    }

    particleContainer.appendChild(el);
    activeParticleCount++;

    el.addEventListener('animationend', function () {
      el.remove();
      activeParticleCount--;
    });
    // animationendが発火しないケースの安全策
    setTimeout(function () {
      if (el.parentNode) {
        el.remove();
        activeParticleCount--;
      }
    }, 5000);
  }

  function emitParticles(reactionType) {
    var config = {
      heart:       { count: 3, min: 16, max: 28, delay: 120 },
      smile:       { count: 3, min: 14, max: 24, delay: 100 },
      celebration: { count: 6, min: 16, max: 26, delay: 100 },
      surprise:    { count: 2, min: 20, max: 32, delay: 150 },
      hundred:     { count: 4, min: 18, max: 30, delay: 80 }
    };
    var c = config[reactionType] || config.heart;

    for (var i = 0; i < c.count; i++) {
      (function (delay, type, min, max) {
        setTimeout(function () { createParticle(type, min, max); }, delay);
      })(i * c.delay, reactionType, c.min, c.max);
    }
  }

  // --- プラグインインターフェース ---

  function show(params, assets, data) {
    if (!container || paused) return;

    // パラメータ: data（演出オーバーライド）優先、params（エフェクト定義）フォールバック
    var p = params || {};
    var d = data || {};
    frameInterval = d.frameInterval != null ? d.frameInterval : (p.frameInterval != null ? p.frameInterval : 150);
    reactDuration = d.reactDuration != null ? d.reactDuration : (p.reactDuration != null ? p.reactDuration : 2000);
    riseDistance = d.riseDistance != null ? d.riseDistance : (p.riseDistance != null ? p.riseDistance : 180);
    spreadWidth = d.spreadWidth != null ? d.spreadWidth : (p.spreadWidth != null ? p.spreadWidth : 120);

    // 位置・表示設定を適用（data優先）
    applyPosition({
      posX: d.posX != null ? d.posX : p.posX,
      posY: d.posY != null ? d.posY : p.posY,
      avatarScale: d.avatarScale != null ? d.avatarScale : p.avatarScale,
      showAvatar: d.showAvatar != null ? d.showAvatar : p.showAvatar,
      showParticles: d.showParticles != null ? d.showParticles : p.showParticles
    });

    // フレーム素材をセットアップ
    setupFrames(assets);

    // リアクション種別（SSEのdata.reactionTypeから取得）
    var reactionType = (d.reactionType) || 'heart';

    // パーティクル発生
    var showParticlesVal = d.showParticles != null ? d.showParticles : (p.showParticles != null ? p.showParticles : true);
    if (showParticlesVal !== false) {
      emitParticles(reactionType);
    }

    // フレームアニメーション
    if (!isAnimating) {
      startAnimation();
      pendingReaction = false;
      scheduleEnd();
    } else {
      pendingReaction = true;
    }
  }

  function setPaused(val) {
    paused = val;
    if (paused) {
      // 一時停止: アニメーション停止
      if (isAnimating) {
        clearInterval(animTimer);
        animTimer = null;
      }
      if (reactEndTimer) {
        clearTimeout(reactEndTimer);
        reactEndTimer = null;
      }
    } else {
      // 再開: pendingがあればアニメーション再開
      if (isAnimating && !animTimer) {
        animTimer = setInterval(function () {
          currentFrame = (currentFrame + 1) % frames.length;
          imgEl.src = frameSrc(currentFrame);
        }, frameInterval);
        scheduleEnd();
      }
    }
  }

  return { init: init, show: show, setPaused: setPaused };
})();
