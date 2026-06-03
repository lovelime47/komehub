/**
 * 花火ショー 共有エンジン (firework-engine.js)
 *
 * canvas パーティクルで「花火大会」を描画する。 玉種 3 (菊/しだれ/型物) + 型物 16 種を、
 * 構成 (序破急結) + 構造化ランダムで組み立てる。 加算合成 + destination-out 減衰で尾を
 * 空間に残しつつ OBS 透過を維持。 物理は時間ベース。 fps 監視で内部解像度を自動降下。
 *
 * 公開 API:
 *   window.FireworkEngine.attach(hostEl)      — hostEl に canvas を 1 枚用意 (冪等、 消えてたら再生成)
 *   window.FireworkEngine.playShow(name)       — 'small' | 'medium' | 'large' | 'grand' のショーを再生
 *   window.FireworkEngine.applyConfig(opts)    — { opacity, noZone, noZoneW } を反映 (透過 / 中心禁止帯)
 *
 * 仕様の正本は docs/architecture/firework-show-design.md。 OBS 互換のため ES module は使わず IIFE + グローバル公開。
 */
var FireworkEngine = (function () {
  var container = null, canvas = null, ctx = null, W = 0, H = 0, RS = 0.85;
  var FADE = 0.10;           // 尾の長さ (小さいほど長く残る)
  var SIZE = 1.6;            // 粒の描画サイズ倍率 (小さいほど画面被覆が減る)
  var BRIGHT = 0.55;         // 1 粒の発光強度 (低いほど加算飽和=中心の白転びが減る)
  var FLASH = 0.15;          // 炸裂時の白い閃光の大きさ倍率 (0 で閃光なし)
  // 設定で上書き可能な項目 (firework.js が effect params から applyConfig で渡す)。
  //   opacity  = canvas 全体の不透明度 (配信画面を透かす)
  //   noZone   = 中心の発射禁止帯 ON/OFF、 noZoneW = その帯の幅 (画面幅比)
  var cfg = { opacity: 0.80, noZone: true, noZoneW: 0.36 };
  var parts = [], rockets = [], MAX = 1700, running = false;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.random() * (i + 1) | 0, t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function mn() { return Math.min(W, H); }

  // 純色パレット (同系の濃淡 3 段。白に近い淡色は使わない = 加算合成で白飛びしないため)。
  // 特に黄系は B(青)成分が混じると加算で白へ転ぶので gold/willow は B≈0 のアンバーに統一。
  // white は意図的な白花火 (spade/ghost/フィナーレ) 用、 willow は金しだれ用。
  var P = {
    gold: ['#ffb300', '#ffc400', '#ff8f00'], pink: ['#ff2d6f', '#ff5d8f', '#e6206a'], blue: ['#1f9bff', '#3fb6ff', '#0c7fe6'],
    green: ['#10d97a', '#34f0a0', '#0bbf68'], willow: ['#ff9c14', '#ff8400', '#ffac2e'], white: ['#ffffff', '#dfe9ff', '#fff3c2'], violet: ['#9a4dff', '#b576ff', '#7e2ff0']
  };
  var glowCache = {};
  // 白コアを持たず中心まで色を詰めた小さな点 (にじみ最小)。CFILL(0.78)まで色を保持し端だけフェード。
  function glow(c) { if (glowCache[c]) return glowCache[c]; var cv = document.createElement('canvas'); cv.width = cv.height = 48;
    var g = cv.getContext('2d'), grd = g.createRadialGradient(24, 24, 0, 24, 24, 24); grd.addColorStop(0, c); grd.addColorStop(0.78, c); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 48, 48); glowCache[c] = cv; return cv; }

  // ===== canvas 準備 (冪等) =====
  function attach(host) {
    container = host || container;
    if (!container) return;
    if (canvas && canvas.parentNode === container) { resize(); return; }
    canvas = document.createElement('canvas');
    canvas.className = 'fw-engine-canvas';
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    canvas.style.opacity = cfg.opacity; // 配信画面を透かす全体透過
    container.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
  }
  // 設定適用 (firework.js が effect params から渡す)。canvas が既にあれば即反映。
  function applyConfig(o) {
    if (!o) return;
    if (o.opacity != null && isFinite(o.opacity)) { cfg.opacity = Math.max(0.05, Math.min(1, o.opacity)); if (canvas) canvas.style.opacity = cfg.opacity; }
    if (o.noZone != null) cfg.noZone = !!o.noZone;
    if (o.noZoneW != null && isFinite(o.noZoneW)) cfg.noZoneW = Math.max(0, Math.min(0.9, o.noZoneW));
  }
  function resize() { if (!canvas || !container) return;
    var cw = container.clientWidth || window.innerWidth, ch = container.clientHeight || window.innerHeight;
    var nw = Math.max(1, Math.round(cw * RS)), nh = Math.max(1, Math.round(ch * RS));
    if (nw === W && nh === H) return;
    // canvas.width を変えると中身が消えるので、 既存の軌跡バッファを退避して新サイズに描き戻す
    // (= 自動解像度降下のたびに全消去 → フリッカー、 を防ぐ)
    var prev = null;
    if (W > 0 && H > 0 && canvas.width > 0 && canvas.height > 0) {
      prev = document.createElement('canvas'); prev.width = canvas.width; prev.height = canvas.height;
      try { prev.getContext('2d').drawImage(canvas, 0, 0); } catch (e) { prev = null; }
    }
    W = canvas.width = nw; H = canvas.height = nh;
    if (prev) { try { ctx.drawImage(prev, 0, 0, W, H); } catch (e) { } } }

  // ===== パーティクル =====
  function PT(o) { if (parts.length >= MAX) return; o.max = o.life; o.r = o.r || 2;
    o.drag = o.drag == null ? 0.985 : o.drag; o.grav = o.grav == null ? 0.05 : o.grav; o.bpow = o.bpow == null ? 0.6 : o.bpow; parts.push(o); ensureLoop(); }

  // ===== 型物の輪郭 16 種 =====
  function norm(pts) { var ax = 1e9, bx = -1e9, ay = 1e9, by = -1e9;
    for (var i = 0; i < pts.length; i++) { var p = pts[i]; if (p.x < ax) ax = p.x; if (p.x > bx) bx = p.x; if (p.y < ay) ay = p.y; if (p.y > by) by = p.y; }
    var cx = (ax + bx) / 2, cy = (ay + by) / 2, half = Math.max(bx - ax, by - ay) / 2 || 1, out = [];
    for (var j = 0; j < pts.length; j++) out.push({ x: (pts[j].x - cx) / half, y: (pts[j].y - cy) / half }); return out; }
  function arcp(cx, cy, r, a0, a1, n) { return ellip(cx, cy, r, r, a0, a1, n); }
  function ellip(cx, cy, rx, ry, a0, a1, n) { var p = []; for (var i = 0; i < n; i++) { var a = a0 + (a1 - a0) * (n <= 1 ? 0 : i / (n - 1)); p.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }); } return p; }
  function seg(a, b, n) { var p = []; for (var i = 0; i < n; i++) { var f = n <= 1 ? 0 : i / (n - 1); p.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }); } return p; }
  function poly(v, n) { var p = [], per = Math.max(1, Math.ceil(n / v.length)); for (var e = 0; e < v.length; e++) { var a = v[e], b = v[(e + 1) % v.length]; for (var j = 0; j < per; j++) { var f = j / per; p.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }); } } return p; }
  function dg(d) { return d * Math.PI / 180; }
  function starGen(pn, inner) { return function (n) { var v = []; for (var k = 0; k < pn * 2; k++) { var ang = -Math.PI / 2 + k * Math.PI / pn, r = (k % 2 === 0) ? 1 : inner; v.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r }); } return norm(poly(v, n)); }; }
  function rose(k) { return function (n) { var p = []; for (var i = 0; i < n; i++) { var th = i / n * Math.PI * 2, r = Math.cos(k * th); p.push({ x: r * Math.cos(th), y: r * Math.sin(th) }); } return norm(p); }; }
  var SHAPES = {
    heart: function (n) { var p = []; for (var i = 0; i < n; i++) { var t = i / n * Math.PI * 2, x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t); p.push({ x: x, y: -y }); } return norm(p); },
    star5: starGen(5, 0.46), star6: starGen(6, 0.55), flower: rose(5), clover: rose(2),
    butterfly: function (n) { var p = []; for (var i = 0; i < n; i++) { var t = i / n * 12 * Math.PI, f = Math.exp(Math.cos(t)) - 2 * Math.cos(4 * t) - Math.pow(Math.sin(t / 12), 5); p.push({ x: Math.sin(t) * f, y: -Math.cos(t) * f }); } return norm(p); },
    saturn: function (n) { var pl = arcp(0, 0, 0.52, 0, Math.PI * 2, Math.floor(n * 0.5)), rn = n - pl.length, rg = [], ca = Math.cos(-0.35), sa = Math.sin(-0.35);
      for (var i = 0; i < rn; i++) { var t = i / rn * Math.PI * 2, ex = Math.cos(t) * 1.05, ey = Math.sin(t) * 0.34; rg.push({ x: ex * ca - ey * sa, y: ex * sa + ey * ca }); } return norm(pl.concat(rg)); },
    snowflake: function (n) { var p = [], ps = Math.floor(n / 6); for (var s = 0; s < 6; s++) { var a = s * Math.PI / 3; for (var i = 0; i < ps; i++) { var r = i / ps; p.push({ x: Math.cos(a) * r, y: Math.sin(a) * r }); }
      var bx = Math.cos(a) * 0.6, by = Math.sin(a) * 0.6;[a + 0.6, a - 0.6].forEach(function (ba) { for (var j = 1; j <= 3; j++) { var d = j * 0.13; p.push({ x: bx + Math.cos(ba) * d, y: by + Math.sin(ba) * d }); } }); } return norm(p); },
    ribbon: function (n) { return norm(poly([{ x: -0.12, y: 0 }, { x: -1, y: -0.6 }, { x: -1, y: 0.6 }], Math.floor(n * 0.4)).concat(poly([{ x: 0.12, y: 0 }, { x: 1, y: -0.6 }, { x: 1, y: 0.6 }], Math.floor(n * 0.4))).concat(arcp(0, 0, 0.2, 0, Math.PI * 2, Math.floor(n * 0.2)))); },
    spade: function (n) { var m = Math.floor(n * 0.78), hp = []; for (var i = 0; i < m; i++) { var t = i / m * Math.PI * 2, x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t); hp.push({ x: x / 17, y: y / 17 }); }
      return norm(hp.concat(poly([{ x: 0, y: 0.55 }, { x: -0.4, y: 1.15 }, { x: 0.4, y: 1.15 }], Math.floor(n * 0.22)))); },
    fish: function (n) { var body = ellip(0.1, 0, 0.9, 0.52, dg(-145), dg(145), Math.floor(n * 0.5));
      var tail = seg({ x: -0.64, y: -0.30 }, { x: -1.15, y: -0.55 }, Math.floor(n * 0.1)).concat(seg({ x: -1.15, y: -0.55 }, { x: -0.8, y: 0 }, Math.floor(n * 0.1))).concat(seg({ x: -0.8, y: 0 }, { x: -1.15, y: 0.55 }, Math.floor(n * 0.1))).concat(seg({ x: -1.15, y: 0.55 }, { x: -0.64, y: 0.30 }, Math.floor(n * 0.1)));
      return norm(body.concat(tail).concat(arcp(0.5, -0.12, 0.07, 0, Math.PI * 2, Math.max(4, Math.floor(n * 0.06))))); },
    note: function (n) { var head = ellip(-0.25, 0.55, 0.36, 0.26, 0, Math.PI * 2, Math.floor(n * 0.4));
      var stem = seg({ x: 0.08, y: 0.5 }, { x: 0.08, y: -0.9 }, Math.floor(n * 0.35));
      var flag = seg({ x: 0.08, y: -0.9 }, { x: 0.5, y: -0.45 }, Math.floor(n * 0.13)).concat(seg({ x: 0.5, y: -0.45 }, { x: 0.14, y: -0.32 }, Math.floor(n * 0.12)));
      return norm(head.concat(stem).concat(flag)); },
    cat: function (n) { var head = arcp(0, 0.1, 0.8, 0, Math.PI * 2, Math.floor(n * 0.5));
      var earL = poly([{ x: -0.62, y: -0.45 }, { x: -0.85, y: -1.05 }, { x: -0.2, y: -0.62 }], Math.floor(n * 0.11)), earR = poly([{ x: 0.62, y: -0.45 }, { x: 0.85, y: -1.05 }, { x: 0.2, y: -0.62 }], Math.floor(n * 0.11));
      var eyeL = arcp(-0.3, 0, 0.06, 0, Math.PI * 2, Math.max(3, Math.floor(n * 0.03))), eyeR = arcp(0.3, 0, 0.06, 0, Math.PI * 2, Math.max(3, Math.floor(n * 0.03)));
      var wh = seg({ x: -0.1, y: 0.25 }, { x: -0.78, y: 0.12 }, Math.floor(n * 0.05)).concat(seg({ x: -0.1, y: 0.34 }, { x: -0.78, y: 0.42 }, Math.floor(n * 0.05))).concat(seg({ x: 0.1, y: 0.25 }, { x: 0.78, y: 0.12 }, Math.floor(n * 0.05))).concat(seg({ x: 0.1, y: 0.34 }, { x: 0.78, y: 0.42 }, Math.floor(n * 0.05)));
      return norm(head.concat(earL).concat(earR).concat(eyeL).concat(eyeR).concat(wh)); },
    ghost: function (n) { var top = arcp(0, 0, 0.7, Math.PI, Math.PI * 2, Math.floor(n * 0.38));
      var sideL = seg({ x: -0.7, y: 0 }, { x: -0.7, y: 0.7 }, Math.floor(n * 0.12)), sideR = seg({ x: 0.7, y: 0 }, { x: 0.7, y: 0.7 }, Math.floor(n * 0.12));
      var hem = [], hn = Math.floor(n * 0.2); for (var i = 0; i < hn; i++) { var f = i / (hn - 1), x = -0.7 + 1.4 * f, y = 0.7 + 0.13 * Math.cos(f * Math.PI * 6); hem.push({ x: x, y: y }); }
      return norm(top.concat(sideL).concat(sideR).concat(hem).concat(arcp(-0.28, -0.05, 0.1, 0, Math.PI * 2, Math.max(4, Math.floor(n * 0.08)))).concat(arcp(0.28, -0.05, 0.1, 0, Math.PI * 2, Math.max(4, Math.floor(n * 0.08))))); },
    crown: function (n) { return norm(poly([{ x: 35, y: 165 }, { x: 35, y: 80 }, { x: 65, y: 110 }, { x: 80, y: 50 }, { x: 105, y: 95 }, { x: 130, y: 50 }, { x: 145, y: 110 }, { x: 175, y: 80 }, { x: 175, y: 165 }], n)); },
    bell: function (n) { var loop = arcp(0, -0.9, 0.13, 0, Math.PI * 2, Math.floor(n * 0.1)), shoulder = arcp(0, -0.35, 0.5, dg(200), dg(340), Math.floor(n * 0.26));
      var sideL = seg({ x: -0.47, y: -0.52 }, { x: -0.72, y: 0.5 }, Math.floor(n * 0.16)), sideR = seg({ x: 0.47, y: -0.52 }, { x: 0.72, y: 0.5 }, Math.floor(n * 0.16));
      return norm(loop.concat(shoulder).concat(sideL).concat(sideR).concat(seg({ x: -0.72, y: 0.5 }, { x: 0.72, y: 0.5 }, Math.floor(n * 0.18))).concat(arcp(0, 0.72, 0.12, 0, Math.PI * 2, Math.floor(n * 0.12)))); }
  };
  var SHAPE_LIST = Object.keys(SHAPES);

  // ===== バースト =====
  function flashAt(x, y) { if (FLASH <= 0.01) return; var n = FLASH < 0.5 ? 1 : 2; for (var i = 0; i < n; i++) PT({ x: x, y: y, vx: 0, vy: 0, r: rand(7, 11) * FLASH, color: '#fff', life: 130, drag: 0.7, grav: 0, bpow: 1 }); }
  // しだれ: 横を圧縮 (vx*0.5) して人物にかからない幅にし、 重力を強め (0.09) て枝垂れ落とす。
  // 上向きに軽く打ち上げ → 重力で弧を描いて下垂、 長寿命 + 低 bpow で金の尾を長く引く。
  function burstWillow(x, y, pal, size) { flashAt(x, y); var n = 54, base = size / 150;
    for (var i = 0; i < n; i++) { var a = (i / n) * Math.PI * 2 + rand(-0.12, 0.12), sp = rand(2.0, 4.5) * base; PT({ x: x, y: y, vx: Math.cos(a) * sp * 0.5, vy: Math.sin(a) * sp - rand(0.5, 1.5), grav: 0.09, drag: 0.988, life: rand(3400, 5200), r: rand(1.3, 2.0), color: pick(pal), bpow: 0.28 }); } }
  function burstRound(x, y, pal, size) { flashAt(x, y); var n = 66, base = size / 150;
    for (var i = 0; i < n; i++) { var a = (i / n) * Math.PI * 2 + rand(-0.05, 0.05), sp = rand(5, 11) * base; PT({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, grav: 0.05, drag: 0.90, life: rand(1150, 1900), r: rand(1.5, 2.4), color: pick(pal), bpow: 0.7 }); }
    for (var j = 0; j < 18; j++) { var a2 = rand(0, Math.PI * 2), s2 = rand(2, 5) * base; PT({ x: x, y: y, vx: Math.cos(a2) * s2, vy: Math.sin(a2) * s2, grav: 0.05, drag: 0.9, life: rand(750, 1250), r: rand(1.3, 1.9), color: pick(pal), bpow: 0.8 }); } }
  function burstShaped(x, y, shape, pal, size) { flashAt(x, y); var fn = SHAPES[shape] || SHAPES.heart, pts = fn(92), d = 0.86, k = (1 - d);
    for (var i = 0; i < pts.length; i++) PT({ x: x, y: y, vx: pts[i].x * size * k, vy: pts[i].y * size * k, grav: 0.018, drag: d, life: rand(1900, 2800), r: rand(1.8, 2.6), color: pick(pal), bpow: 0.55 });
    var pc = (shape === 'heart' || shape === 'flower') ? P.gold : pal;
    for (var j = 0; j < 16; j++) { var a = rand(0, Math.PI * 2), rr = size * 0.26 * Math.sqrt(Math.random()); PT({ x: x, y: y, vx: Math.cos(a) * rr * k, vy: Math.sin(a) * rr * k, grav: 0.02, drag: d, life: rand(1400, 2100), r: rand(1.4, 2), color: pick(pc), bpow: 0.6 }); } }
  function launch(opt) { attach(container); if (!canvas) return; var x = W * opt.xFrac, ay = H * opt.yFrac, vy = -Math.sqrt(2 * 0.16 * (H - ay));
    rockets.push({ x: x, y: H, vx: rand(-0.4, 0.4), vy: vy, grav: 0.16, burst: function (bx, by) {
      if (opt.shape === 'ring') burstRound(bx, by, opt.palette, opt.size); else if (opt.shape === 'willow') burstWillow(bx, by, opt.palette, opt.size); else burstShaped(bx, by, opt.shape, opt.palette, opt.size); } }); ensureLoop(); }

  // ===== ループ (時間ベース・空なら停止) =====
  var last = 0, fAcc = 0, fCnt = 0, fpsAvg = 60, lastRs = 0;
  function ensureLoop() { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } }
  function frame(now) {
    var dtms = now - last; last = now; if (dtms > 80) dtms = 80; var dt = dtms / 16.667;
    var fadeDt = 1 - Math.pow(1 - FADE, dt);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,' + fadeDt + ')'; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (var r = rockets.length - 1; r >= 0; r--) { var k = rockets[r]; k.vy += k.grav * dt; k.x += k.vx * dt; k.y += k.vy * dt;
      PT({ x: k.x + rand(-1, 1), y: k.y, vx: rand(-0.3, 0.3), vy: rand(0.4, 1.2), grav: 0.02, drag: 0.95, life: rand(180, 320), r: rand(1, 1.6), color: '#ff9e2e', bpow: 0.8 });
      var gr = 4; ctx.globalAlpha = 0.85; ctx.drawImage(glow('#ffaa3c'), k.x - gr, k.y - gr, gr * 2, gr * 2); if (k.vy >= 0) { k.burst(k.x, k.y); rockets.splice(r, 1); } }
    for (var i = parts.length - 1; i >= 0; i--) { var p = parts[i], df = Math.pow(p.drag, dt); p.vy += p.grav * dt; p.vx *= df; p.vy *= df; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dtms;
      if (p.life <= 0) { parts.splice(i, 1); continue; } var b = Math.pow(p.life / p.max, p.bpow); if (b < 0.03) continue; var gr2 = p.r * SIZE; ctx.globalAlpha = b * BRIGHT; ctx.drawImage(glow(p.color), p.x - gr2, p.y - gr2, gr2 * 2, gr2 * 2); }
    ctx.globalAlpha = 1;
    // fps 監視 → 内部解像度 自動降下/復帰
    fAcc += dtms; fCnt++;
    if (fAcc >= 400) { var fps = 1000 * fCnt / fAcc; fpsAvg = fpsAvg * 0.5 + fps * 0.5; fAcc = 0; fCnt = 0;
      // 解像度変更はクールダウン (1.2s) + 広めの閾値で thrash を抑制 (resize はバッファ温存なので無消去)
      if (now - lastRs > 1200) {
        if (fpsAvg < 38 && RS > 0.4) { RS = Math.max(0.4, RS - 0.1); resize(); lastRs = now; }
        else if (fpsAvg > 58 && RS < 0.85) { RS = Math.min(0.85, RS + 0.05); resize(); lastRs = now; }
      } }
    // アイドルは停止 (CPU 節約)。 destination-out の減衰は完全には 0 にならないので、
    // 停止する瞬間に canvas を完全クリアして薄い残像が固定されないようにする。
    if (parts.length === 0 && rockets.length === 0) { ctx.clearRect(0, 0, W, H); running = false; return; }
    requestAnimationFrame(frame);
  }

  // ===== 構成プリミティブ =====
  // 中心の発射禁止帯 (配信者/メイン映像を覆わない保護帯。縦は全高、幅 cfg.noZoneW)。
  // 帯内に当たるバーストは左右どちらか近い側の外へ押し出す (バースト半径ぶん余分に逃がす)。
  function avoidZone(xf, sizeFrac) {
    if (!cfg.noZone || cfg.noZoneW <= 0) return xf;
    var hw = cfg.noZoneW / 2, x0 = 0.5 - hw, x1 = 0.5 + hw;
    if (xf < x0 || xf > x1) return xf;
    var rx = (sizeFrac || 0.12) * mn() / W * 0.7;
    xf = (xf < 0.5) ? x0 - rx : x1 + rx;
    return Math.max(0.04, Math.min(0.96, xf));
  }
  function shell(xf, yf, type, pal, sizeFrac) { launch({ xFrac: avoidZone(xf, sizeFrac), yFrac: yf, shape: type, palette: pal, size: mn() * sizeFrac }); }
  // 型物の配置予約 (2D rejection sampling): ランダムだが重ならない。 明るい期間のみ予約。
  var shapeSlots = [];
  function reserveXY(pxf, pyf, rpx, lifeMs) { var t = performance.now();
    for (var i = shapeSlots.length - 1; i >= 0; i--) if (shapeSlots[i].until <= t) shapeSlots.splice(i, 1);
    var mx = rpx / W + 0.02, gapPx = 0.03 * mn();
    function cx(x) { return Math.min(1 - mx, Math.max(mx, x)); }
    function cy(y) { return Math.min(0.48, Math.max(0.16, y)); }
    function ok(xf, yf) { var ax = xf * W, ay = yf * H; for (var i = 0; i < shapeSlots.length; i++) { var s = shapeSlots[i], dx = ax - s.cx, dy = ay - s.cy, rr = rpx + s.r + gapPx; if (dx * dx + dy * dy < rr * rr) return false; } return true; }
    var fx = cx(pxf), fy = cy(pyf), found = ok(fx, fy);
    for (var k = 0; k < 32 && !found; k++) { var x = cx(rand(0.1, 0.9)), y = cy(rand(0.22, 0.46)); if (ok(x, y)) { fx = x; fy = y; found = true; } }
    shapeSlots.push({ cx: fx * W, cy: fy * H, r: rpx, until: t + lifeMs }); return { x: fx, y: fy }; }
  // 型物の色は固定せず、 カラフルパレット (BODY) から random に選ぶ (pickBody = 直前と同色を回避)。
  // サイズも ±25% 程度ランダム化して単調さを避ける (reserveXY / avoidZone には実サイズを渡す)。
  function mShape(name, sizeFrac, xf, yf) { var sf = sizeFrac * rand(0.78, 1.28); var p = reserveXY(xf, yf, sf * mn(), 1700); shell(p.x, p.y, name, pickBody(), sf); }
  function mAccent(sizeFrac) { mShape(pick(SHAPE_LIST), sizeFrac, rand(0.18, 0.82), rand(0.26, 0.42)); }
  function mShapeShowcase(sizeFrac, count) { count = count || 5; var names = shuffle(SHAPE_LIST).slice(0, count);
    names.forEach(function (nm, i) { setTimeout(function () { mShape(nm, sizeFrac * rand(0.92, 1.12), rand(0.12, 0.88), rand(0.24, 0.44)); }, i * 360 + rand(0, 120)); }); }
  function mWave(pal, n, dir, sizeFrac, yMid, stagger) { for (var i = 0; i < n; i++) (function (i) { var ord = dir < 0 ? (n - 1 - i) : i; setTimeout(function () { shell(0.16 + 0.68 * (i / (n - 1)) + rand(-0.03, 0.03), yMid + rand(-0.05, 0.05), 'ring', pal, sizeFrac * rand(0.85, 1.1)); }, ord * stagger); })(i); }
  function mCenterOut(pal, pairs, sizeFrac) { shell(0.5, rand(0.30, 0.36), 'ring', pal, sizeFrac); for (var kk = 1; kk <= pairs; kk++) (function (k) { setTimeout(function () { var off = 0.13 * k; shell(0.5 - off, rand(0.30, 0.40), 'ring', pal, sizeFrac * 0.9); shell(0.5 + off, rand(0.30, 0.40), 'ring', pal, sizeFrac * 0.9); }, k * 190); })(kk); }
  function mMirror(pal, sizeFrac) { var xo = rand(0.18, 0.26); shell(0.5 - xo, rand(0.32, 0.38), 'ring', pal, sizeFrac); shell(0.5 + xo, rand(0.32, 0.38), 'ring', pal, sizeFrac); if (Math.random() < 0.6) setTimeout(function () { var x2 = rand(0.30, 0.40); shell(0.5 - x2, 0.30, 'ring', pal, sizeFrac * 0.8); shell(0.5 + x2, 0.30, 'ring', pal, sizeFrac * 0.8); }, 420); }
  function mScatter(pal, n, sizeFrac) { for (var i = 0; i < n; i++) (function (i) { setTimeout(function () { var x = (i + 0.5) / n + rand(-0.06, 0.06); shell(Math.min(0.9, Math.max(0.1, x)), rand(0.22, 0.44), 'ring', pal, sizeFrac * rand(0.8, 1.2)); }, i * rand(120, 240)); })(i); }
  function mFiller(n, pal) { for (var i = 0; i < n; i++) (function (i) { setTimeout(function () { shell(rand(0.15, 0.85), rand(0.16, 0.30), 'ring', pal, rand(0.10, 0.14)); }, i * 130); })(i); }
  function mCurtain(n) { for (var i = 0; i < n; i++) (function (i) { setTimeout(function () { shell(0.18 + 0.64 * (i / Math.max(1, n - 1)), 0.22, 'willow', P.willow, rand(0.24, 0.30)); }, i * 230); })(i); }
  function finaleKamuro() { for (var i = 0; i < 16; i++) (function (i) { setTimeout(function () { shell(rand(0.12, 0.88), rand(0.20, 0.46), 'ring', i % 3 ? P.gold : P.white, rand(0.12, 0.20)); }, i * 170); })(i);
    [0.3, 0.5, 0.7].forEach(function (xf, idx) { setTimeout(function () { shell(xf, 0.26, 'willow', P.willow, 0.30); }, 400 + idx * 320); });
    setTimeout(function () { mShape(pick(SHAPE_LIST), 0.24, rand(0.3, 0.7), rand(0.28, 0.36)); }, 1300); setTimeout(function () { shell(0.5, 0.37, 'ring', P.gold, 0.27); }, 2600); }
  function finaleColor() { var cols = [P.pink, P.blue, P.green, P.gold, P.violet]; for (var i = 0; i < 16; i++) (function (i) { setTimeout(function () { shell(rand(0.12, 0.88), rand(0.20, 0.46), 'ring', pick(cols), rand(0.12, 0.20)); }, i * 160); })(i);
    var ns = shuffle(SHAPE_LIST); setTimeout(function () { mShape(ns[0], 0.19, rand(0.15, 0.45), rand(0.28, 0.4)); }, 1300); setTimeout(function () { mShape(ns[1], 0.19, rand(0.55, 0.85), rand(0.28, 0.4)); }, 1300); setTimeout(function () { mShape(ns[2], 0.2, rand(0.35, 0.65), rand(0.3, 0.42)); }, 1900); setTimeout(function () { mCurtain(3); }, 1500); }
  function finaleSenrin() { for (var i = 0; i < 26; i++) (function (i) { setTimeout(function () { shell(rand(0.1, 0.9), rand(0.18, 0.46), 'ring', pick([P.gold, P.white, P.pink, P.blue]), rand(0.08, 0.14)); }, i * 95); })(i); setTimeout(function () { mCurtain(4); }, 800); setTimeout(function () { mShapeShowcase(0.2, 3); }, 1400); setTimeout(function () { shell(0.5, 0.34, 'ring', P.gold, 0.26); }, 3000); }
  var FINALES = [finaleKamuro, finaleColor, finaleSenrin], lastFinale = null;
  function finaleVariant() { var f; do { f = pick(FINALES); } while (f === lastFinale && FINALES.length > 1); lastFinale = f; f(); }
  // 特大専用フィナーレ = 和風大スターマイン。 左右多点から超高速 (~48ms 間隔) で連射し、
  // 隙間なく咲き続ける壁を作る (粒上限 MAX が密度を一定に保つ) → 締めに全幅の大玉一斉 +
  // 大しだれ 2 + 特大の金。 中心は禁止帯 (avoidZone) が自動で空ける。~3.7s に凝縮。
  function finaleGrand() {
    var xs = [0.10, 0.90, 0.18, 0.82, 0.26, 0.74, 0.14, 0.86, 0.22, 0.78], shots = 48, iv = 48;
    for (var i = 0; i < shots; i++) (function (i) { setTimeout(function () {
      shell(xs[i % xs.length] + rand(-0.03, 0.03), rand(0.20, 0.46), 'ring', i % 3 === 0 ? P.gold : pickBody(), rand(0.11, 0.18));
    }, i * iv); })(i);
    setTimeout(function () {
      [0.16, 0.34, 0.66, 0.84].forEach(function (xf) { shell(xf, rand(0.28, 0.36), 'ring', pickBody(), rand(0.26, 0.32)); });
      shell(0.30, 0.40, 'willow', P.willow, 0.34); shell(0.70, 0.40, 'willow', P.willow, 0.34);
    }, shots * iv + 200);
    setTimeout(function () { shell(0.5, 0.30, 'ring', P.gold, 0.44); }, shots * iv + 700);
  }
  var BODY = [P.gold, P.pink, P.blue, P.green, P.violet], lastBody = null;
  function pickBody() { var b; do { b = pick(BODY); } while (b === lastBody && BODY.length > 1); lastBody = b; return b; }
  function other(not) { var b; do { b = pick(BODY); } while (b === not); return b; }
  function breakMoves() { return shuffle([function (p, s) { mWave(p, 4 + (Math.random() * 2 | 0), Math.random() < 0.5 ? 1 : -1, s, rand(0.38, 0.44), rand(130, 180)); }, function (p, s) { mCenterOut(p, 3, s); }, function (p, s) { mMirror(p, s); }, function (p, s) { mScatter(p, 5, s); }]); }

  // ===== ショー =====
  var SHOWS = {
    small: function () { var p = pickBody(); shell(0.5, rand(0.32, 0.36), 'ring', p, 0.16); setTimeout(function () { shell(rand(0.4, 0.6), rand(0.28, 0.34), 'ring', Math.random() < 0.5 ? p : other(p), 0.15); }, rand(800, 1100)); },
    medium: function () { var p = pickBody(), mv = breakMoves(); shell(0.5, 0.33, 'ring', p, 0.16); setTimeout(function () { mv[0](other(p), 0.15); }, rand(1000, 1300)); setTimeout(function () { mAccent(0.21); }, rand(2600, 3000)); },
    large: function () { var p1 = pickBody(), p2 = other(p1), mv = breakMoves();
      shell(0.32, 0.38, 'ring', p1, 0.15); setTimeout(function () { shell(0.68, 0.32, 'ring', p1, 0.16); }, rand(600, 800));
      setTimeout(function () { mv[0](p2, 0.16); }, rand(1500, 1800)); setTimeout(function () { mAccent(0.22); }, rand(3000, 3400));
      setTimeout(function () { mShapeShowcase(0.20, 3); }, rand(4200, 4600)); setTimeout(function () { mCurtain(3); }, rand(6400, 6900)); setTimeout(function () { finaleVariant(); }, rand(8000, 8600)); },
    grand: function () { var p1 = pickBody(), p2 = other(p1), mv = breakMoves(), t = 0; function cue(d, f) { t += d; setTimeout(f, t); }
      cue(0, function () { shell(0.5, 0.33, 'ring', p1, 0.17); });
      cue(rand(1500, 1900), function () { shell(rand(0.24, 0.32), 0.40, 'ring', p1, 0.15); });
      cue(rand(800, 1100), function () { shell(rand(0.68, 0.76), 0.30, 'ring', p1, 0.16); });
      cue(rand(1800, 2100), function () { mv[0](p2, 0.16); });
      cue(rand(1500, 1800), function () { mAccent(0.27); });
      cue(rand(1800, 2100), function () { mv[1](pickBody(), 0.16); if (Math.random() < 0.5) mFiller(5, p2); });
      cue(rand(1400, 1700), function () { mShapeShowcase(0.22, 5); });
      cue(rand(1400, 1700), function () { mCurtain(3 + (Math.random() * 2 | 0)); });
      cue(rand(1700, 2000), function () { finaleGrand(); });
    }
  };

  function playShow(name) { attach(container); if (!canvas) return; (SHOWS[name] || SHOWS.small)(); }

  return { attach: attach, playShow: playShow, applyConfig: applyConfig };
})();
