/**
 * 全画面オーバーレイエフェクト
 * 画面全体にWebM/画像を重ねる
 * 素材未設定時はペンライト+レーザーの組み込み演出
 */
var ScreenOverlay = (function () {
  var container;
  var activeOverlay = null;
  var lastTriggerTime = 0;
  var fadeoutTimer = null;
  var FADEOUT_MS = 800; // フェードアウトのアニメーション時間

  // ペンライト色定義
  var PL_COLORS = [
    { light1: '#ff69b4', light2: '#ff1493', shadow: 'rgba(255,20,147,0.3)' },
    { light1: '#00bfff', light2: '#0080ff', shadow: 'rgba(0,128,255,0.3)' },
    { light1: '#00ff88', light2: '#00cc66', shadow: 'rgba(0,204,102,0.3)' },
    { light1: '#ffa500', light2: '#ff6600', shadow: 'rgba(255,102,0,0.3)' },
    { light1: '#bf5fff', light2: '#8b00ff', shadow: 'rgba(139,0,255,0.3)' },
    { light1: '#fff',    light2: '#ddd',    shadow: 'rgba(255,255,255,0.3)' },
    { light1: '#ff4444', light2: '#cc0000', shadow: 'rgba(204,0,0,0.3)' },
    { light1: '#ffee00', light2: '#ffcc00', shadow: 'rgba(255,204,0,0.3)' }
  ];

  var LASER_COLORS = [
    { bg: '#ff1493', glow: '#ff69b4' },
    { bg: '#0080ff', glow: '#00bfff' },
    { bg: '#00cc66', glow: '#00ff88' },
    { bg: '#8b00ff', glow: '#bf5fff' },
    { bg: '#cc0000', glow: '#ff4444' }
  ];

  function createPenlightShow(el, duration) {
    // スタイルが未設定の場合のみ設定（show側で設定済みの場合あり）
    if (!el.style.position) {
      el.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
    }

    // レーザー（左3本 + 右3本）
    var laserCount = 3;
    for (var side = 0; side < 2; side++) {
      var isLeft = side === 0;
      for (var li = 0; li < laserCount; li++) {
        var lc = LASER_COLORS[Math.floor(Math.random() * LASER_COLORS.length)];
        var laser = document.createElement('div');
        var speed = 3 + Math.random() * 1.5;
        laser.style.cssText =
          'position:absolute;width:6px;height:150vh;top:-30vh;pointer-events:none;opacity:1;' +
          'transform-origin:bottom center;' +
          (isLeft ? 'left:0;' : 'right:0;') +
          'background:linear-gradient(180deg,transparent 5%,' + lc.bg + ');' +
          'box-shadow:0 0 15px ' + lc.glow + ',0 0 40px ' + lc.glow + ',0 0 80px ' + lc.glow + ';';

        // グロー
        var laserGlow = document.createElement('div');
        laserGlow.style.cssText =
          'position:absolute;top:0;left:-20px;width:46px;height:100%;' +
          'filter:blur(16px);opacity:0.8;' +
          'background:linear-gradient(180deg,transparent 5%,' + lc.glow + ');';
        laser.appendChild(laserGlow);

        // アニメーション（上方向にスイープ: 左は5〜35度、右は-5〜-35度）
        var fromDeg = isLeft ? 5 : -5;
        var toDeg = isLeft ? 35 : -35;
        laser.animate([
          { transform: 'rotate(' + fromDeg + 'deg)' },
          { transform: 'rotate(' + toDeg + 'deg)' },
          { transform: 'rotate(' + fromDeg + 'deg)' }
        ], {
          duration: speed * 1000,
          iterations: Infinity,
          delay: Math.random() * -3000,
          easing: 'ease-in-out'
        });

        el.appendChild(laser);
      }
    }

    // ペンライト（25本）
    var plStage = document.createElement('div');
    plStage.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:60%;pointer-events:none;';

    var plCount = 25;
    for (var i = 0; i < plCount; i++) {
      var c = PL_COLORS[Math.floor(Math.random() * PL_COLORS.length)];
      var pen = document.createElement('div');
      pen.style.cssText = 'position:absolute;bottom:-20%;transform-origin:bottom center;';
      pen.style.left = (i / plCount * 100 + (Math.random() - 0.5) * 4) + '%';

      var scale = 0.6 + Math.random() * 0.5;
      pen.style.opacity = (0.5 + scale * 0.5).toString();

      // 光
      var light = document.createElement('div');
      light.style.cssText =
        'width:30px;height:200px;border-radius:15px;margin:0 auto;' +
        'background:linear-gradient(180deg,' + c.light1 + ',' + c.light2 + ');' +
        'box-shadow:0 0 20px ' + c.light1 + ',0 0 50px ' + c.light2 + ',0 0 80px ' + c.shadow + ';';
      pen.appendChild(light);

      // グロー
      var glow = document.createElement('div');
      glow.style.cssText =
        'position:absolute;top:-30px;left:50%;transform:translateX(-50%);' +
        'width:90px;height:260px;border-radius:45px;' +
        'filter:blur(25px);opacity:0.7;' +
        'background:' + c.light1 + ';pointer-events:none;';
      pen.insertBefore(glow, light);

      // 振りアニメーション
      var baseAngle = -15 + Math.random() * 10;
      var swingRange = 20 + Math.random() * 15;
      pen.animate([
        { transform: 'scale(' + scale + ') rotate(' + baseAngle + 'deg)' },
        { transform: 'scale(' + scale + ') rotate(' + (baseAngle + swingRange) + 'deg)' },
        { transform: 'scale(' + scale + ') rotate(' + baseAngle + 'deg)' }
      ], {
        duration: (0.8 + Math.random() * 0.6) * 1000,
        iterations: Infinity,
        delay: Math.random() * -2000,
        easing: 'ease-in-out'
      });

      plStage.appendChild(pen);
    }

    el.appendChild(plStage);

    // 有限durationの場合のみ自前でフェードイン/アウト（Infinityの場合はshow側で制御）
    if (isFinite(duration)) {
      el.animate([
        { opacity: 0, offset: 0 },
        { opacity: 1, offset: 0.05 },
        { opacity: 1, offset: 0.9 },
        { opacity: 0, offset: 1 }
      ], {
        duration: duration,
        easing: 'ease-in-out',
        fill: 'forwards'
      }).onfinish = function () { el.remove(); activeOverlay = null; };
    }
  }

  function init(c) { container = c; }

  function startFadeoutCheck(duration) {
    if (fadeoutTimer) return;
    fadeoutTimer = setInterval(function () {
      if (!activeOverlay) {
        clearInterval(fadeoutTimer);
        fadeoutTimer = null;
        return;
      }
      if (Date.now() - lastTriggerTime >= duration) {
        clearInterval(fadeoutTimer);
        fadeoutTimer = null;
        // フェードアウト
        activeOverlay.animate([
          { opacity: 1 },
          { opacity: 0 }
        ], { duration: FADEOUT_MS, fill: 'forwards' }).onfinish = function () {
          if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }
        };
      }
    }, 1000);
  }

  function show(params, assets, data) {
    if (overlayPaused) return;
    var duration = params.duration || 5000;
    var zOrder = (data && data.zOrder) || 1;
    lastTriggerTime = Date.now();

    // 既に表示中 → 時刻更新だけ（表示を延長）
    if (activeOverlay) return;

    // 素材なし → 組み込みペンライト
    if (!assets || assets.length === 0) {
      var el = document.createElement('div');
      activeOverlay = el;
      // フェードイン＋永続表示（フェードアウトはタイマーで制御）
      el.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;opacity:0;';
      el.style.zIndex = zOrder;
      createPenlightShow(el, Infinity);
      container.appendChild(el);
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: 'forwards' });
      startFadeoutCheck(duration);
      return;
    }

    var blendMode = params.blendMode || 'normal';
    var opacity = params.opacity || 0.8;
    var asset = assets[Math.floor(Math.random() * assets.length)];

    var el = document.createElement('div');
    activeOverlay = el;
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;';
    el.style.zIndex = zOrder;
    if (blendMode === 'additive') {
      el.style.mixBlendMode = 'screen';
    }

    if (isVideoAsset(asset)) {
      var video = document.createElement('video');
      video.src = asset;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      video.style.cssText = 'width:100%;height:100%;object-fit:fill;';
      el.appendChild(video);
    } else if (isImageUrl(asset)) {
      var img = document.createElement('img');
      img.src = asset;
      img.style.cssText = 'width:100%;height:100%;object-fit:fill;';
      el.appendChild(img);
    } else {
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.fontSize = '200px';
      el.textContent = asset;
    }

    container.appendChild(el);
    el.animate([{ opacity: 0 }, { opacity: opacity }], { duration: 500, fill: 'forwards' });
    startFadeoutCheck(duration);
  }

  var overlayPaused = false;
  function setPaused(val) { overlayPaused = val; }

  return { init: init, show: show, setPaused: setPaused };
})();
