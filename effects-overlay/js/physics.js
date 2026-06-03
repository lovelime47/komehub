/**
 * 共有物理エンジン（Matter.js）
 * 落下物・クラッカー等が同じワールドを共有する
 */
var Physics = (function () {
  var engine, world, runner;
  var items = []; // { body, el, halfW, halfH, createdAt, lifetime }
  var initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    engine = Matter.Engine.create({
      gravity: { x: 0, y: 1.5 }
    });
    world = engine.world;

    // 地面（画面下端）
    var ground = Matter.Bodies.rectangle(
      window.innerWidth / 2, window.innerHeight + 25,
      window.innerWidth * 2, 50,
      { isStatic: true, friction: 0.2, restitution: 0.4 }
    );

    // 左右の壁
    var wallLeft = Matter.Bodies.rectangle(
      -25, window.innerHeight / 2,
      50, window.innerHeight * 2,
      { isStatic: true }
    );
    var wallRight = Matter.Bodies.rectangle(
      window.innerWidth + 25, window.innerHeight / 2,
      50, window.innerHeight * 2,
      { isStatic: true }
    );

    Matter.Composite.add(world, [ground, wallLeft, wallRight]);

    runner = Matter.Runner.create();
    Matter.Runner.run(runner, engine);

    requestAnimationFrame(renderLoop);
  }

  function renderLoop() {
    var now = Date.now();

    for (var i = items.length - 1; i >= 0; i--) {
      var item = items[i];
      var pos = item.body.position;
      var angle = item.body.angle;

      item.el.style.transform = 'translate(' + (pos.x - item.halfW) + 'px, ' + (pos.y - item.halfH) + 'px) rotate(' + angle + 'rad)';

      // 地面到達で即フェードアウト
      if (item.removeOnGround && !item.fading && pos.y > window.innerHeight - 60) {
        item.fading = true;
        item.fadeStart = now;
        item.lifetime = Math.min(item.lifetime, (now - item.createdAt) + 500);
      }

      var age = now - item.createdAt;
      if (item.fading) {
        var fadeAge = now - item.fadeStart;
        item.el.style.opacity = Math.max(0, 1 - fadeAge / 500);
      } else {
        var fadeStart = item.lifetime - 1000;
        if (age > fadeStart) {
          item.el.style.opacity = Math.max(0, 1 - (age - fadeStart) / 1000);
        }
      }
      if (age > item.lifetime) {
        item.el.remove();
        Matter.Composite.remove(world, item.body);
        items.splice(i, 1);
      }
    }

    requestAnimationFrame(renderLoop);
  }

  function addBody(el, body, halfW, halfH, lifetime, options) {
    init();
    Matter.Composite.add(world, body);
    items.push({
      body: body,
      el: el,
      halfW: halfW,
      halfH: halfH,
      createdAt: Date.now(),
      lifetime: lifetime || 8000,
      removeOnGround: options && options.removeOnGround,
      fading: false
    });
  }

  function getWorld() {
    init();
    return world;
  }

  function clear() {
    init();
    for (var i = items.length - 1; i >= 0; i--) {
      items[i].el.remove();
      Matter.Composite.remove(world, items[i].body);
    }
    items = [];
  }

  return {
    init: init,
    addBody: addBody,
    getWorld: getWorld,
    clear: clear
  };
})();
