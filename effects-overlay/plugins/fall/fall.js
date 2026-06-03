/**
 * 落下物エフェクト（共有物理エンジン使用）
 * 上から落下し、地面でごろごろ転がり、積み重なる
 */
var Fall = (function () {
  var container;

  function init(c) { container = c; }

  function fire(params, assets, data) {
    if (!container) return;

    var zOrder = (data && data.zOrder) || 1;
    var count = (data && data.count != null) ? data.count : (params.count || 3);
    var speed = params.speed || 5;
    var scaleFactor = ((data && data.scale) || 100) / 100;
    var sizeMin = (params.sizeMin || 30) * scaleFactor;
    var sizeMax = (params.sizeMax || 50) * scaleFactor;

    for (var i = 0; i < count; i++) {
      (function (delay) {
        setTimeout(function () {
          var asset = assets[Math.floor(Math.random() * assets.length)];
          var x = 50 + Math.random() * (window.innerWidth - 100);
          var y = -50 - Math.random() * 100;

          function spawnBody(el, w, h) {
            var rx = w / 2;
            var ry = h / 2;
            var sides = 12;
            var verts = [];
            for (var vi = 0; vi < sides; vi++) {
              var a = (Math.PI * 2 / sides) * vi;
              verts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
            }
            var body = Matter.Bodies.fromVertices(x, y, verts, {
              restitution: 0.5 + Math.random() * 0.3,
              friction: 0.1 + Math.random() * 0.2,
              frictionAir: 0.005 + Math.random() * 0.01,
              angle: Math.random() * Math.PI * 2,
              density: 0.001 + Math.random() * 0.002
            });
            Matter.Body.setVelocity(body, {
              x: (Math.random() - 0.5) * speed * 0.5,
              y: speed + Math.random() * speed
            });
            Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.3);
            Physics.addBody(el, body, w / 2, h / 2, 4000);
          }

          var el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.left = '0px';
          el.style.top = '0px';
          el.style.pointerEvents = 'none';
          el.style.willChange = 'transform';
          el.style.zIndex = zOrder;

          // 画像の場合は元サイズを使う
          if (isImageUrl(asset)) {
            var img = new Image();
            img.onload = function () {
              var w = img.naturalWidth * scaleFactor;
              var h = img.naturalHeight * scaleFactor;
              // 大きすぎる場合は上限
              var maxSize = 200 * scaleFactor;
              if (w > maxSize || h > maxSize) {
                var scale = maxSize / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
              }
              var imgEl = document.createElement('img');
              imgEl.src = asset;
              imgEl.style.width = w + 'px';
              imgEl.style.height = h + 'px';
              imgEl.style.objectFit = 'contain';
              el.appendChild(imgEl);
              el.style.width = w + 'px';
              el.style.height = h + 'px';
              container.appendChild(el);
              spawnBody(el, w, h);
            };
            img.src = asset;
          } else {
            var size = sizeMin + Math.random() * (sizeMax - sizeMin);
            setAssetContent(el, asset, size);
            container.appendChild(el);
            spawnBody(el, size, size * 0.8);
          }
        }, delay);
      })(i * 80 + Math.random() * 60);
    }
  }

  return { init: init, fire: fire };
})();
