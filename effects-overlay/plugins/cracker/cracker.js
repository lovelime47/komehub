/**
 * クラッカーエフェクト（共有物理エンジン使用）
 * 紙吹雪が爆発的に飛び出し、物理演算でひらひら舞い落ちる
 */
var Cracker = (function () {
  var container;

  var CONFETTI_COLORS = [
    '#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3',
    '#54a0ff', '#5f27cd', '#01a3a4', '#ff9f43',
    '#00d2d3', '#f368e0', '#2ed573', '#ffffff'
  ];

  var SHAPES = ['rect', 'rect', 'rect', 'strip', 'strip', 'circle'];

  function init(c) { container = c; }

  function fire(params, assets, data) {
    if (!container) return;

    var zOrder = (data && data.zOrder) || 1;
    var launchPosition = (data && data.launchPosition) || 'random';

    if (launchPosition === 'both') {
      // 左右同時発射: 半分ずつの設定で2回呼ぶ
      var halfData = {};
      for (var k in data) halfData[k] = data[k];
      halfData.launchPosition = '_left';
      if (halfData.confettiCount != null) halfData.confettiCount = Math.ceil(halfData.confettiCount / 2);
      if (halfData.count != null) halfData.count = Math.ceil(halfData.count / 2);
      fire(params, assets, halfData);
      halfData.launchPosition = '_right';
      fire(params, assets, halfData);
      return;
    }

    var count = (data && data.confettiCount != null) ? data.confettiCount : (params.count || 30);
    var bigCount = (data && data.count != null) ? data.count : 3;
    var bigSize = (data && data.bigSize) || 100;
    var distance = (params.distance || 5) * 50;
    var spread = params.spread || 5;
    var duration = params.duration || 3000;

    // 発射位置
    var startX, startY;
    if (launchPosition === '_left') {
      startX = window.innerWidth * (0.05 + Math.random() * 0.15);
      startY = window.innerHeight * (0.8 + Math.random() * 0.2);
    } else if (launchPosition === '_right') {
      startX = window.innerWidth * (0.8 + Math.random() * 0.15);
      startY = window.innerHeight * (0.8 + Math.random() * 0.2);
    } else {
      startX = Math.random() * window.innerWidth;
      startY = window.innerHeight * (0.8 + Math.random() * 0.2);
    }

    // 射角: 発射位置に応じて画面内側を狙う
    var xRatio = startX / window.innerWidth;
    var minAngle = -(30 + xRatio * 70);
    var maxAngle = -(80 + xRatio * 70);
    var baseAngle = minAngle + Math.random() * (maxAngle - minAngle);

    for (var i = 0; i < count; i++) {
      (function (delay) {
        setTimeout(function () {
          var color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
          var shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];

          // 角度と速度
          var angle = baseAngle + (Math.random() - 0.5) * spread;
          var rad = angle * Math.PI / 180;
          var speed = distance * (0.3 + Math.random() * 0.7) / 3.6;

          // DOM要素
          var el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.left = '0px';
          el.style.top = '0px';
          el.style.pointerEvents = 'none';
          el.style.willChange = 'transform';
          el.style.zIndex = zOrder;

          // 内側: 形状 + 3D回転
          var inner = document.createElement('div');
          inner.className = 'confetti-piece confetti-' + shape;
          inner.style.background = color;
          inner.style.setProperty('--tumble-speed', (0.5 + Math.random() * 1.0) + 's');

          var w, h;
          if (shape === 'rect') {
            w = 14 + Math.random() * 10;
            h = 9 + Math.random() * 7;
          } else if (shape === 'strip') {
            w = 4 + Math.random() * 3;
            h = 18 + Math.random() * 14;
          } else {
            var sz = 10 + Math.random() * 8;
            w = sz;
            h = sz;
          }
          inner.style.width = w + 'px';
          inner.style.height = h + 'px';

          el.appendChild(inner);
          container.appendChild(el);

          // 物理ボディ（小さめの楕円）
          var bw = w * 0.6;
          var bh = h * 0.6;
          var brx = bw / 2;
          var bry = bh / 2;
          var bsides = 6;
          var bverts = [];
          for (var bvi = 0; bvi < bsides; bvi++) {
            var ba = (Math.PI * 2 / bsides) * bvi;
            bverts.push({ x: Math.cos(ba) * brx, y: Math.sin(ba) * bry });
          }
          // 初期位置を射角方向にずらして重なり回避
          var spawnOffset = i * (bw * 0.5);
          var spawnX = startX + Math.cos(rad) * spawnOffset;
          var spawnY = startY + Math.sin(rad) * spawnOffset;

          var body = Matter.Bodies.fromVertices(spawnX, spawnY, bverts, {
            restitution: 0.3 + Math.random() * 0.3,
            friction: 0.05 + Math.random() * 0.1,
            frictionAir: 0.02 + Math.random() * 0.04,
            angle: Math.random() * Math.PI * 2,
            density: 0.0005 + Math.random() * 0.001
          });

          // 爆発的な初速
          Matter.Body.setVelocity(body, {
            x: Math.cos(rad) * speed,
            y: Math.sin(rad) * speed
          });
          Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.4);

          Physics.addBody(el, body, w / 2, h / 2, duration + Math.random() * 2000, { removeOnGround: true });
        }, delay);
      })(0);
    }

    // 大きなオブジェクト（落下物サイズ）を3個飛ばす
    for (var bi = 0; bi < bigCount; bi++) {
      (function () {
        var asset = assets[Math.floor(Math.random() * assets.length)];
        var scaleFactor = ((data && data.scale) || 100) / 100;
        var bigSize = (30 + Math.random() * 20) * scaleFactor;

        var el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.pointerEvents = 'none';
        el.style.willChange = 'transform';
        el.style.zIndex = zOrder;
        setAssetContent(el, asset, bigSize);
        container.appendChild(el);

        var bAngle = baseAngle + (Math.random() - 0.5) * spread;
        var bRad = bAngle * Math.PI / 180;
        var bSpeed = distance * (0.4 + Math.random() * 0.4) / 3.6;

        var bw = bigSize;
        var bh = bigSize * 0.8;
        var brx = bw / 2;
        var bry = bh / 2;
        var bsides = 10;
        var bverts = [];
        for (var bvi = 0; bvi < bsides; bvi++) {
          var ba = (Math.PI * 2 / bsides) * bvi;
          bverts.push({ x: Math.cos(ba) * brx, y: Math.sin(ba) * bry });
        }

        var body = Matter.Bodies.fromVertices(startX, startY, bverts, {
          restitution: 0.5 + Math.random() * 0.3,
          friction: 0.1 + Math.random() * 0.2,
          frictionAir: 0.005 + Math.random() * 0.01,
          angle: Math.random() * Math.PI * 2,
          density: 0.001 + Math.random() * 0.002
        });

        Matter.Body.setVelocity(body, {
          x: Math.cos(bRad) * bSpeed,
          y: Math.sin(bRad) * bSpeed
        });
        Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.3);

        Physics.addBody(el, body, bw / 2, bh / 2, 4000);
      })();
    }
  }

  return { init: init, fire: fire };
})();
