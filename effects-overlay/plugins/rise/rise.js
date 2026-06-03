/**
 * 上昇エフェクト
 * 下から上にふわふわ浮かび上がる
 */
var Rise = (function () {
  var container;

  function safeRemove(el, maxLifetime) {
    var removed = false;
    function doRemove() {
      if (!removed) { removed = true; el.remove(); }
    }
    el.addEventListener('animationend', doRemove);
    setTimeout(doRemove, maxLifetime);
  }

  function init(c) { container = c; }

  function fire(params, assets, data) {
    if (!container) return;

    var zOrder = (data && data.zOrder) || 1;
    var count = (data && data.count) || params.count || 6;
    var speed = params.speed || 4;
    var sway = (params.sway || 3) * 15;
    var sizeMin = params.sizeMin || 24;
    var sizeMax = params.sizeMax || 48;
    var duration = params.duration || 2500;
    var scaleFactor = ((data && data.scale) || 100) / 100;

    // 基本設定パラメータ
    var originX = (data && data.originX != null) ? data.originX : 50; // 0-100%
    var originY = (data && data.originY != null) ? data.originY : 100; // 0-100%
    var spreadWidth = (data && data.spreadWidth != null) ? data.spreadWidth : 40; // 0-100%
    var riseDistance = (data && data.riseDistance != null) ? data.riseDistance : 50; // 0-100 (画面高さの%)

    sizeMin *= scaleFactor;
    sizeMax *= scaleFactor;

    var adjustedDuration = duration * (1.5 - speed / 10);

    for (var i = 0; i < count; i++) {
      (function (delay) {
        setTimeout(function () {
          var asset = assets[Math.floor(Math.random() * assets.length)];
          var size = sizeMin + Math.random() * (sizeMax - sizeMin);

          // 外側: 上昇軌道
          var outer = document.createElement('div');
          outer.style.position = 'absolute';
          outer.style.pointerEvents = 'none';
          outer.style.willChange = 'transform';
          outer.style.zIndex = zOrder;

          setAssetContent(outer, asset, size);

          var centerX = window.innerWidth * originX / 100;
          var halfSpread = window.innerWidth * spreadWidth / 200;
          var x = centerX - halfSpread + Math.random() * halfSpread * 2;
          var swayAmount = (Math.random() - 0.5) * sway * 2;
          var swaySpeed = 0.8 + Math.random() * 1.2;
          var particleDuration = adjustedDuration * (0.8 + Math.random() * 0.4);

          var startY = window.innerHeight * originY / 100;
          outer.style.left = x + 'px';
          outer.style.top = startY + 'px';
          outer.style.setProperty('--sway', swayAmount + 'px');
          outer.style.setProperty('--sway-speed', swaySpeed + 's');
          outer.style.setProperty('--duration', (particleDuration / 1000) + 's');
          outer.style.setProperty('--rise-distance', (window.innerHeight * riseDistance / 100) + 'px');

          outer.className = 'effect-particle effect-rise effect-rise-sway';

          container.appendChild(outer);
          safeRemove(outer, particleDuration + 200);
        }, delay);
      })(i * (80 + Math.random() * 60));
    }
  }

  return { init: init, fire: fire };
})();
