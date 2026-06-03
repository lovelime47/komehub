/**
 * 宝箱演出 共有エンジン (treasure-engine.js)
 *
 * スーパーチャットで宝箱が落下 → 開封 → お宝が溢れ出るレトロゲーム風演出。
 * OBS ブラウザソースで動くオーバーレイ用。 mock (test/probe/local/treasure-chest-v1.html)
 * からの移植版。
 *
 * 公開 API:
 *   window.TreasureEngine.play(hostEl, opts, onDone)
 *     opts = { amount: Number(円), name: String, amountDisplay: String }
 *     hostEl に Shadow DOM を attach し、 シーンを 1 回だけ再生する。
 *     再生完了 (フェードアウト後 ~800ms) に onDone() を呼ぶ。
 *
 * OBS 互換のため ES module 構文 (import/export) は使わない。 IIFE + グローバル公開。
 */
var TreasureEngine = (function () {

  // ===== Google Fonts を document.head に 1 回だけ inject =====
  var fontsInjected = false;
  function ensureFonts() {
    if (fontsInjected) return;
    fontsInjected = true;
    if (typeof document === 'undefined' || !document.head) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DotGothic16&family=Press+Start+2P&display=swap';
    document.head.appendChild(link);
  }

  // ===== CSS 全文 (mock から移植。 .stage 背景を透明化 / CRT 周辺暗化を削除) =====
  var STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .stage {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    /* OBS 上では背景透明 (mock の暗背景 / 周辺暗化は削除) */
    background: transparent;
  }

  .scene { position: relative; width: 520px; height: 550px; }

  /* ===== 宝箱 ===== */
  .chest-wrap {                          /* 落下 (opacity + translateY) 専用 */
    position: absolute; left: 50%; top: 240px;
    transform: translate(-50%, -50%);
    width: 256px; height: 224px;
    opacity: 0;
  }
  .chest-inner {                         /* 揺れ (margin) + 蓋の 3D perspective 専用 */
    position: absolute; left: 0; top: 0; width: 256px; height: 224px;
    perspective: 600px;
  }
  .chest-wrap svg { image-rendering: pixelated; display: block; position: absolute; }
  .chest-base { left: 0; top: 0; width: 256px; }
  .chest-lid {
    left: 0; top: 0; width: 256px;
    transform-origin: 50% 50%;        /* ヒンジ = 蓋の下端中央 (svg 内で蓋下端 ≈ 縦50%) */
    transform: rotateX(0deg);
    z-index: 3;
  }
  .chest-wrap.lit .chest-lid { animation: lid-open 0.5s cubic-bezier(0.34,1.6,0.5,1) forwards; }
  @keyframes lid-open {
    0%   { transform: rotateX(0deg); }
    70%  { transform: rotateX(-128deg); }
    100% { transform: rotateX(-118deg); }
  }
  /* 出現 (上から落下 → バウンド着地) */
  .chest-wrap.show { animation: chest-drop 0.95s linear forwards; }
  @keyframes chest-drop {
    0%   { opacity: 0; transform: translate(-50%,-50%) translateY(-300px); }
    8%   { opacity: 1; }
    50%  { transform: translate(-50%,-50%) translateY(0); }     /* 着地 */
    64%  { transform: translate(-50%,-50%) translateY(-38px); } /* バウンド */
    78%  { transform: translate(-50%,-50%) translateY(0); }
    88%  { transform: translate(-50%,-50%) translateY(-12px); }
    100% { opacity: 1; transform: translate(-50%,-50%) translateY(0); }
  }
  /* 着地の土煙 */
  .dust { position: absolute; width: 14px; height: 14px; border-radius: 50%;
    background: rgba(196,176,134,0.55); z-index: 1; pointer-events: none; }

  /* 開く直前の溜め (中から押されてガタガタ) — 内側だけ揺らす */
  .chest-wrap.shake .chest-inner { animation: chest-shake 0.18s ease-in-out 3; }
  @keyframes chest-shake {
    0%,100% { margin-left: 0; } 20% { margin-left: -6px; } 55% { margin-left: 6px; } 80% { margin-left: -3px; }
  }
  .chest-wrap.shake .chest-lid { animation: lid-bump 0.2s ease-in-out 3; }
  @keyframes lid-bump {
    0%,100% { transform: rotateX(0deg) translateY(0); }
    45% { transform: rotateX(-12deg) translateY(-6px); }
    75% { transform: rotateX(0deg) translateY(0); }
  }

  /* 開封フラッシュ */
  /* 開封バースト = 口元から溢れる金色の光 (宝箱を白飛びさせない: 小さめ + 金色 + chest の後ろ z) */
  .flash {
    position: absolute; left: 50%; top: 238px; transform: translate(-50%,-50%);
    width: 8px; height: 8px; border-radius: 50%;
    background: radial-gradient(circle, #fff 0%, #ffe08a 38%, rgba(255,210,90,0.2) 60%, transparent 72%);
    opacity: 0; pointer-events: none; z-index: 2;
  }
  .flash.go { animation: flash-burst 0.5s ease-out forwards; }
  @keyframes flash-burst {
    0% { width: 8px; height: 8px; opacity: 0; }
    28% { width: 170px; height: 170px; opacity: 0.85; }
    100% { width: 240px; height: 240px; opacity: 0; }
  }

  /* 光の柱 */
  .beam {
    position: absolute; left: 50%; top: 150px; transform: translateX(-50%);
    width: 150px; height: 130px; z-index: 2; pointer-events: none;
    background: linear-gradient(to top, rgba(255,224,120,0.55), rgba(255,236,160,0.12) 60%, transparent);
    clip-path: polygon(36% 100%, 64% 100%, 100% 0, 0 0);
    opacity: 0;
  }
  .chest-wrap.lit ~ .beam { animation: beam-in 0.4s ease-out 0.25s forwards; }
  @keyframes beam-in { 0% { opacity: 0; } 100% { opacity: 1; } }
  .beam.fade { animation: beam-out 0.6s ease forwards !important; }
  @keyframes beam-out { to { opacity: 0; } }

  /* ルート (金貨/宝石/特別) */
  .loot { position: absolute; left: 0; top: 0; z-index: 5; pointer-events: none; }
  .loot-item { position: absolute; image-rendering: pixelated; will-change: transform, opacity; }
  .loot-item svg { display: block; image-rendering: pixelated; }
  .spark {
    position: absolute; width: 6px; height: 6px; z-index: 5; pointer-events: none;
    background: #fff; opacity: 0;
    clip-path: polygon(50% 0,60% 40%,100% 50%,60% 60%,50% 100%,40% 60%,0 50%,40% 40%);
  }
  .spark.go { animation: spark-tw 1.2s ease-in-out infinite; }
  @keyframes spark-tw { 0%,100% { opacity: 0; transform: scale(0.3) rotate(0); } 50% { opacity: 1; transform: scale(1.2) rotate(120deg); } }

  /* レアリティ表示 (全 Tier) */
  .rarity {
    position: absolute; left: 50%; top: 12px; transform: translateX(-50%) scale(0);
    z-index: 10; text-align: center; opacity: 0; pointer-events: none; white-space: nowrap;
  }
  .rarity.show { animation: rarity-pop 0.5s cubic-bezier(0.34,1.7,0.5,1) forwards; }
  @keyframes rarity-pop {
    0% { opacity: 0; transform: translateX(-50%) scale(0); }
    60% { opacity: 1; transform: translateX(-50%) scale(1.18); }
    100% { opacity: 1; transform: translateX(-50%) scale(1); }
  }
  .rarity .stars { font-family: 'Press Start 2P', monospace; font-size: 30px; letter-spacing: 3px; text-shadow: 2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
  .rarity .stars .off { opacity: 0.25; }
  .rarity .rank { font-family: 'DotGothic16', sans-serif; font-size: 34px; margin-top: 6px; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 0 0 10px currentColor; }
  /* 最高レア時は中央の剣を避けて右上へ */
  .rarity.tr { left: auto; right: 18px; top: 16px; transform: scale(0); }
  .rarity.tr.show { animation: rarity-pop-tr 0.5s cubic-bezier(0.34,1.7,0.5,1) forwards; }
  @keyframes rarity-pop-tr {
    0% { opacity: 0; transform: scale(0); }
    60% { opacity: 1; transform: scale(1.18); }
    100% { opacity: 1; transform: scale(1); }
  }

  /* ===== 最高レア (MYTHIC): ホールドアロフト ===== */
  .dim {
    position: absolute; inset: -25%; z-index: 7; pointer-events: none; opacity: 0;
    background: radial-gradient(circle at 50% 34%, transparent 12%, rgba(0,0,0,0.64) 42%, transparent 70%);
    /* 箱の四角い端をぼかして背景に溶かす (= 長方形の黒パッチに見えないよう端をグラデで透明化) */
    -webkit-mask-image: radial-gradient(circle at 50% 36%, #000 34%, transparent 72%);
            mask-image: radial-gradient(circle at 50% 36%, #000 34%, transparent 72%);
    transition: opacity 0.6s ease;
  }
  .dim.show { opacity: 1; }
  /* コンパクトな後背の光 (剣に寄り添う縦長グロー、 左右に広がらない) */
  .aura {
    position: absolute; transform: translate(-50%, -50%);
    width: 168px; height: 250px; z-index: 8; pointer-events: none;
    background: radial-gradient(ellipse 46% 50% at center,
      rgba(255,255,248,0.9) 0%, rgba(255,238,156,0.6) 20%, rgba(255,205,92,0.34) 46%, transparent 72%);
    animation: aura-pulse 1.7s ease-in-out infinite;
  }
  @keyframes aura-pulse {
    0%, 100% { opacity: 0.72; transform: translate(-50%, -50%) scale(0.9); }
    50%      { opacity: 1;    transform: translate(-50%, -50%) scale(1.14); }
  }
  /* きらめき (4 点星) — 剣の各所でポンポン明滅 */
  .glint {
    position: absolute; transform: translate(-50%, -50%) scale(0); opacity: 0; z-index: 10;
    background: radial-gradient(circle, #fff 0%, #fff6c0 38%, transparent 72%);
    clip-path: polygon(50% 0%, 58% 42%, 100% 50%, 58% 58%, 50% 100%, 42% 58%, 0% 50%, 42% 42%);
    pointer-events: none;
  }
  .glint.go { animation: glint-pop 1.2s ease-in-out infinite; }
  @keyframes glint-pop {
    0%, 100% { transform: translate(-50%, -50%) scale(0) rotate(0deg); opacity: 0; }
    50%      { transform: translate(-50%, -50%) scale(1) rotate(45deg); opacity: 1; }
  }
  .legend { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 9; pointer-events: none; }
  .legend-hero { position: absolute; z-index: 9; image-rendering: pixelated; }
  .legend-hero svg { display: block; image-rendering: pixelated;
    filter: drop-shadow(0 0 8px rgba(255,228,150,0.9)) drop-shadow(0 0 18px rgba(255,200,90,0.55)); }
  .legend-name {
    position: absolute; left: 50%; top: 230px; transform: translateX(-50%) scale(0);
    z-index: 11; white-space: nowrap; opacity: 0;
    font-family: 'DotGothic16', sans-serif; font-size: 26px; color: #ffe24a;
    padding: 7px 18px; border-radius: 3px;
    background: rgba(8,10,24,0.9);
    border: 3px solid #ffd24a;
    box-shadow: 0 0 0 2px #0b1024, 3px 3px 0 rgba(0,0,0,0.5), 0 0 14px rgba(255,180,40,0.5);
    /* 黒フチ取りで背景に負けない */
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
  }
  .legend-name.show { animation: rarity-pop 0.5s cubic-bezier(0.34,1.7,0.5,1) forwards; }

  /* ===== 中レアの見せ場 (showcase) — 最高レアより控えめ ===== */
  .showcase { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 8; pointer-events: none; }
  .sc-glow {
    position: absolute; transform: translate(-50%, -50%);
    width: 150px; height: 150px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,250,215,0.7) 0%, rgba(255,224,130,0.3) 40%, transparent 70%);
    opacity: 0; transition: opacity 0.4s ease;
  }
  .sc-glow.show { opacity: 1; animation: sc-glow-pulse 1.1s ease-in-out infinite; }
  @keyframes sc-glow-pulse {
    0%, 100% { transform: translate(-50%, -50%) scale(0.92); }
    50%      { transform: translate(-50%, -50%) scale(1.1); }
  }

  /* ===== アイテム名 (常時表示・レアリティで見せ方が変化) ===== */
  .itemname {
    position: absolute; left: 50%; top: 160px; transform: translateX(-50%) scale(0);
    z-index: 11; opacity: 0; white-space: nowrap; pointer-events: none;
    font-family: 'DotGothic16', sans-serif; text-align: center; line-height: 1.1;
  }
  .itemname.show { animation: rarity-pop 0.5s cubic-bezier(0.34,1.7,0.5,1) forwards; }
  /* r1 COMMON: 素朴な白文字 */
  .itemname.r1 { font-size: 26px; color: #eef2fb;
    padding: 3px 14px; border-radius: 11px; background: rgba(10,14,24,0.66);
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
  /* r2 UNCOMMON: 緑の細ピル */
  .itemname.r2 { font-size: 27px; color: #d8ffe4;
    padding: 4px 15px; border-radius: 13px;
    background: rgba(18,38,26,0.78); border: 2px solid #4fd17a;
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
  /* r3 RARE: 青のプレート + 枠 */
  .itemname.r3 { font-size: 28px; color: #e4f3ff; font-weight: bold;
    padding: 4px 15px; border-radius: 3px;
    background: rgba(10,22,40,0.82); border: 2px solid #4fb6ff;
    box-shadow: 0 0 0 2px #07101e, 0 0 12px rgba(80,180,255,0.45);
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
  /* r4 EPIC: 紫金のプレート + グロー */
  .itemname.r4 { font-size: 29px; color: #ffeaf6; font-weight: bold;
    padding: 5px 17px; border-radius: 3px;
    background: rgba(28,12,34,0.86); border: 2px solid #d77dff;
    box-shadow: 0 0 0 2px #120820, 3px 3px 0 rgba(0,0,0,0.5), 0 0 16px rgba(200,110,255,0.55);
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
  /* r5 LEGENDARY: 大きな金バナー */
  .itemname.r5 { font-size: 32px; color: #ffe24a; top: 96px;
    padding: 7px 19px; border-radius: 3px;
    background: rgba(8,10,24,0.92); border: 3px solid #ffd24a;
    box-shadow: 0 0 0 2px #0b1024, 3px 3px 0 rgba(0,0,0,0.5), 0 0 16px rgba(255,180,40,0.55);
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }

  /* ===== RPG メッセージウィンドウ ===== */
  .msgwin {
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%) translateY(20px);
    width: 460px; padding: 16px 20px; z-index: 12;
    background: #0b1442;
    border: 4px solid #fff;
    border-radius: 2px;
    box-shadow: 0 0 0 4px #0b1442, 0 0 0 7px #3a5bd0, 6px 6px 0 rgba(0,0,0,0.5);
    opacity: 0; image-rendering: pixelated;
  }
  .msgwin.show { animation: msg-in 0.35s steps(4) forwards; }
  @keyframes msg-in {
    0% { opacity: 0; transform: translateX(-50%) translateY(20px); }
    100% { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  .msgwin .line1 {
    font-family: 'DotGothic16', sans-serif; font-size: 22px; color: #fff;
    line-height: 1.4; text-shadow: 2px 2px 0 #000; min-height: 30px;
  }
  .msgwin .line1 .nm { color: #ffe24a; }
  .msgwin .amt {
    margin-top: 10px; font-family: 'Press Start 2P', monospace; font-size: 20px;
    color: #ffe24a; text-shadow: 2px 2px 0 #7a3d00, 3px 3px 0 #000; letter-spacing: 1px;
  }
  .msgwin .amt .tierlabel { font-size: 9px; color: #9fb0e8; margin-left: 10px; vertical-align: middle; }
  .msgwin .arrow {
    position: absolute; right: 14px; bottom: 8px; color: #fff; font-size: 14px;
    animation: blink 0.8s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  `;

  // ===== シーン DOM (mock の body 内 .stage > .scene 構造。 panel は除外) =====
  var SCENE_HTML =
    '<div class="stage">' +
      '<div class="scene" id="scene">' +
        '<div class="chest-wrap" id="chest"></div>' +
        '<div class="flash" id="flash"></div>' +
        '<div class="beam" id="beam"></div>' +
        '<div class="loot" id="loot"></div>' +
        '<div class="dim" id="dim"></div>' +
        '<div class="showcase" id="showcase"></div>' +
        '<div class="legend" id="legend"></div>' +
        '<div class="rarity" id="rarity"></div>' +
        '<div class="itemname" id="itemname"></div>' +
        '<div class="msgwin" id="msg">' +
          '<div class="line1" id="msgLine"></div>' +
          '<div class="amt" id="msgAmt"></div>' +
          '<span class="arrow">▼</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  // ---- ピクセル sprite レンダラ (文字グリッド → SVG rects) ----
  function pix(rows, pal, scale) {
    var w = rows[0].length, h = rows.length, r = '';
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < rows[y].length; x++) {
        var c = rows[y][x];
        if (!pal[c]) continue;
        r += '<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + pal[c] + '"/>';
      }
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + (w * scale) + '" height="' + (h * scale)
      + '" shape-rendering="crispEdges">' + r + '</svg>';
  }

  // ---- 宝箱 base / lid (チャンキーな rect で構成、 crispEdges) ----
  var C = {
    OL: '#241204', WD: '#8a5a2c', WL: '#b67e3e', WS: '#5b3819',
    GD: '#c8901a', GO: '#ffd24a', GH: '#fff2b8', IN: '#0e0803'
  };
  function rect(x, y, w, h, f) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '"/>'; }
  // viewBox 0 0 64 56
  function chestBaseSvg() {
    var s = '';
    // 中の金 (蓋を開けると覗く) — body 上端に盛り上がり
    s += rect(16, 22, 8, 4, C.GO) + rect(26, 21, 12, 5, C.GH) + rect(40, 22, 8, 4, C.GO);
    s += rect(20, 24, 6, 2, C.GD) + rect(38, 24, 6, 2, C.GD);
    // body 本体
    s += rect(8, 26, 48, 24, C.OL);          // 外枠
    s += rect(10, 28, 44, 20, C.WD);         // 木
    s += rect(10, 28, 44, 3, C.WL);          // 上ハイライト
    s += rect(10, 45, 44, 3, C.WS);          // 下影
    s += rect(10, 26, 44, 3, C.IN);          // 内側の縁 (暗)
    // 縦の金具 2 本
    [16, 40].forEach(function (sx) {
      s += rect(sx, 26, 8, 24, C.OL) + rect(sx + 2, 28, 4, 20, C.GO) + rect(sx + 2, 28, 1, 20, C.GH) + rect(sx + 5, 28, 1, 20, C.GD);
    });
    // 錠前
    s += rect(28, 33, 8, 11, C.OL) + rect(30, 35, 4, 7, C.GO) + rect(30, 35, 4, 1, C.GH);
    s += rect(31, 37, 2, 2, C.OL) + rect(31, 39, 2, 2, C.OL);
    return '<svg class="chest-base" viewBox="0 0 64 56" width="256" shape-rendering="crispEdges">' + s + '</svg>';
  }
  function chestLidSvg() {
    var s = '';
    s += rect(6, 10, 52, 18, C.OL);          // 蓋外枠 (やや幅広 = overhang)
    s += rect(8, 12, 48, 14, C.WD);          // 木
    s += rect(8, 12, 48, 3, C.WL);           // ハイライト
    s += rect(8, 23, 48, 3, C.WS);           // 下影
    // 蓋下端の金帯
    s += rect(6, 22, 52, 6, C.OL) + rect(8, 24, 48, 2, C.GO) + rect(8, 24, 48, 1, C.GH);
    // 縦金具 (body と整列)
    [16, 40].forEach(function (sx) {
      s += rect(sx, 10, 8, 14, C.OL) + rect(sx + 2, 12, 4, 12, C.GO) + rect(sx + 2, 12, 1, 12, C.GH) + rect(sx + 5, 12, 1, 12, C.GD);
    });
    // 角のピクセル面取り (透明で削る)
    s += rect(6, 10, 2, 2, 'transparent') + rect(56, 10, 2, 2, 'transparent');
    return '<svg class="chest-lid" viewBox="0 0 64 56" width="256" shape-rendering="crispEdges">' + s + '</svg>';
  }

  // ---- ルート sprite ----
  var coinPal = { k: '#5a3a00', G: '#ffd24a', H: '#fff6c8', d: '#c8901a' };
  var COIN = ['..kkkk..', '.kGGGGk.', 'kGHGGGdk', 'kGHGGGdk', 'kGGGGGdk', 'kGdGGddk', '.kdddk.', '..kkkk..'];
  function gemRows() { return ['..kkk..', '.kCHck.', 'kCCCCck', 'kCCCcck', '.kCCck.', '..kck..', '...k...']; }
  // 王者の冠 — 3 つの宝石付きの峰 + 宝石入りの帯 (大きめ 15x12)
  var CROWN = [
    '.......R.......',
    '......kGk......',
    '..B...kGk...B..',
    '.kGk.kGGGk.kGk.',
    '.kGGGGGGGGGGGk.',
    '.kGHHGGGGGHHGk.',
    'kGGGGGGGGGGGGGk',
    'kGGBGGGRGGGBGGk',
    'kGGHGGGGGGGHGGk',
    'kGGGGGGGGGGGGGk',
    'kdddddddddddddk',
    '.kkkkkkkkkkkkk.'
  ];
  var crownPal = { k: '#4a3000', G: '#ffd24a', H: '#fff2b8', d: '#c8901a', R: '#ff4d6d', B: '#4fd0ff' };

  // 赤ポーション (HP) — 第 1 号アイテム。 round-bottom フラスコ + ガラス首 + 赤液 + 光沢 + 気泡
  var POTION = [
    '....ccc....',
    '....cCc....',
    '...ccccc...',
    '....kgk....',
    '....kgk....',
    '...kgggk...',
    '..kgRRRgk..',
    '.kHRrrrrRk.',
    '.kHrrrrrrk.',
    '.kHrrbrrrk.',
    '.kdrrrrrdk.',
    '..kdrrrdk..',
    '...kdddk...',
    '....kkk....'
  ];
  var potionPal = {
    k: '#1c0f0a', c: '#6e4a26', C: '#a9763f', g: '#cfe0e6',
    r: '#e23b3b', R: '#ff7e6e', d: '#9e1c1c', H: '#ffffff', b: '#ffe2dc'
  };
  // マナポーション — 球形のボトル + 青い液 (= フラスコとは別形状) (11x13)
  var MANA = [
    '....kkk....',
    '....kCk....',
    '....kgk....',
    '...kgggk...',
    '..kgMMMgk..',
    '.kgMMMMMgk.',
    'kgMMMMMMMgk',
    'kgMHMMMMMgk',
    'kgMMMMMMMgk',
    '.kgMMMMMgk.',
    '..kgMMMgk..',
    '...kdddk...',
    '....kkk....'
  ];
  var manaPal = { k: '#0c0f1c', C: '#6e4a26', g: '#cfe0e6', M: '#4f86e8', H: '#bcd4ff', d: '#1c3a9e' };

  // 解毒薬 — 細い試験管 + 緑の液 (= さらに別形状) (7x14)
  var ANTIDOTE = [
    '..kkk..',
    '..kCk..',
    '.kgggk.',
    '.kgVgk.',
    '.kgVgk.',
    '.kgAgk.',
    '.kgAgk.',
    '.kgAgk.',
    '.kgAgk.',
    '.kgAgk.',
    '.kgAgk.',
    '.kgAgk.',
    '.kdddk.',
    '..kkk..'
  ];
  var antidotePal = { k: '#0c1c0e', C: '#6e4a26', g: '#cfe0e6', V: '#eaf4f0', A: '#3fcf52', d: '#1c7e2a' };

  // エリクサー — 最上位の霊薬。 宝石の栓 + 金のキャップ/襟 + 多面カット瓶 + 金のフィリグリー帯 + 金の台座 (11x17)
  var ELIXIR = [
    '....kBk....',
    '...kBWBk...',
    '....kGk....',
    '...kGGGk...',
    '....kgk....',
    '...kgggk...',
    '..kgEEEgk..',
    '.kgEEEEEgk.',
    'kgEEEHEEEgk',
    'kGGGGGGGGGk',
    'kgEEEEEEEgk',
    'kgEEEEEEEgk',
    '.kgEEEEEgk.',
    '..kgEEEgk..',
    '..kGGGGGk..',
    '...kGGGk...',
    '....kkk....'
  ];
  var elixirPal = { k: '#2a1c0a', B: '#5ad0ff', W: '#ffffff', G: '#ffe24a', g: '#bcd0dc', E: '#ffb52e', H: '#fff2b8' };

  // ---- 薬草シリーズ (= すべて別形状) ----
  // 薬草 — 双葉の若芽 (9x9)
  var HERB = [
    '..L...L..',
    '.LLL.LLL.',
    'LLLLkLLLL',
    '.LLLkLLL.',
    '..LLkLL..',
    '...LkL...',
    '....k....',
    '....k....',
    '...kkk...'
  ];
  var herbPal = { k: '#143a14', L: '#4fbf3f' };

  // 薬用キノコ — 赤い傘 + 白い斑点 + 白い柄 (9x11)
  var MUSHROOM = [
    '..kkkkk..',
    '.kRRRRRk.',
    'kRRWRRWRk',
    'kRRRRRRRk',
    'kRWRRRWRk',
    'kRRRRRRRk',
    '.kkkkkkk.',
    '..kWWWk..',
    '..kWWWk..',
    '..kWWWk..',
    '..kkkkk..'
  ];
  var mushroomPal = { k: '#3a1414', R: '#e23b3b', W: '#fff0e0' };

  // 回復の花 — 花弁 + 黄色の芯 + 茎と葉 (9x13)
  var FLOWER = [
    '...kkk...',
    '.kkPPPkk.',
    'kPPPPPPPk',
    'kPPOWOPPk',
    'kPPOOOPPk',
    'kPPPPPPPk',
    '.kkPPPkk.',
    '....k....',
    '...kLk...',
    '..kLLk...',
    '....k....',
    '....k....',
    '...kkk...'
  ];
  var flowerPal = { k: '#5a2a3a', P: '#ff8ac0', O: '#ffd24a', W: '#fff2b8', L: '#4fbf3f' };

  // 四つ葉のクローバー — 4 枚の葉 + 茎 (9x10)
  var CLOVER = [
    '.kLk.kLk.',
    'kLLLkLLLk',
    'kLLLkLLLk',
    '.kLkLkLk.',
    'kLLLkLLLk',
    'kLLLkLLLk',
    '.kLk.kLk.',
    '....k....',
    '....k....',
    '...kkk...'
  ];
  var cloverPal = { k: '#143a14', L: '#5fd04a' };

  // 霊草 — 光る大きな葉 + 輝く葉脈 (9x14)
  var SACRED = [
    '....k....',
    '...kSk...',
    '..kSHSk..',
    '.kSSHSSk.',
    'kSSSHSSSk',
    'kSSSHSSSk',
    'kSSSHSSSk',
    '.kSSHSSk.',
    '.kSSHSSk.',
    '..kSHSk..',
    '..kSHSk..',
    '...kHk...',
    '...kbk...',
    '...kkk...'
  ];
  var sacredPal = { k: '#0e3a30', S: '#3fd9b0', H: '#eaffe0', b: '#6e4a26' };

  // ---- 財宝・装飾品シリーズ (= すべて別形状) ----
  // ネックレス — 金の鎖 + 宝石ペンダント (11x11)
  var NECKLACE = [
    'GG.......GG',
    '.G.......G.',
    '.G.......G.',
    '..G.....G..',
    '..G.....G..',
    '...G...G...',
    '....GGG....',
    '....kBk....',
    '...kBWBk...',
    '...kBBBk...',
    '....kkk....'
  ];
  var necklacePal = { k: '#2a3038', G: '#ffd24a', B: '#5ad0ff', W: '#ffffff' };

  // ティアラ — 細い宝石の額冠 (= 王冠より小ぶり) (13x7)
  var TIARA = [
    '...G..B..G...',
    '..GkGkBkGkG..',
    '.kGGGGGGGGGk.',
    'kGGGBGGGBGGGk',
    'kGGGGGGGGGGGk',
    '.kGGGGGGGGGk.',
    '..kkkkkkkkk..'
  ];
  var tiaraPal = { k: '#5a3a00', G: '#ffe24a', B: '#ff6db0' };

  // 聖杯 — 金のゴブレット + 宝石 (11x14)
  var CHALICE = [
    'kGGGGGGGGGk',
    'kGGGGGGGGGk',
    '.kGGBGBGGk.',
    '.kGGGGGGGk.',
    '..kGGGGGk..',
    '...kGGGk...',
    '....kGk....',
    '....kGk....',
    '....kGk....',
    '...kGGGk...',
    '..kGGGGGk..',
    '.kGGGGGGGk.',
    'kGGGGGGGGGk',
    'kkkkkkkkkkk'
  ];
  var chalicePal = { k: '#5a3a00', G: '#ffd24a', B: '#ff3b3b' };

  // 黄金像 — 偶像の彫像 + 宝石の目 (9x14)
  var IDOL = [
    '..kGGGk..',
    '.kGGGGGk.',
    '.kGRGRGk.',
    '.kGGGGGk.',
    '.kGkkkGk.',
    '..kGGGk..',
    '.kGGGGGk.',
    'kGGGGGGGk',
    'kGGkkkGGk',
    'kGGGGGGGk',
    '.kGGGGGk.',
    '.kGGGGGk.',
    'kkGGGGGkk',
    'kkkkkkkkk'
  ];
  var idolPal = { k: '#4a3000', G: '#ffd24a', R: '#ff3b3b' };

  // 砂時計 — 金の枠 + 砂 (9x9)
  var HOURGLASS = [
    'kkGGGGGkk',
    '.kSSSSSk.',
    '..kSSSk..',
    '...kSk...',
    '...kxk...',
    '...ksk...',
    '..ksssk..',
    '.ksssssk.',
    'kkGGGGGkk'
  ];
  var hourglassPal = { k: '#3a2a10', G: '#ffd24a', S: '#f0d890', x: '#ffe08a', s: '#d8b860' };

  // 黄金の壺 — 丸胴の壺 + 模様 (11x14)
  var VASE = [
    '...kkkkk...',
    '...kGGGk...',
    '..kGGGGGk..',
    '.kGGGGGGGk.',
    'kGGGGGGGGGk',
    'kGGkGGGkGGk',
    'kGGGGGGGGGk',
    'kGGGkGkGGGk',
    'kGGGGGGGGGk',
    '.kGGGGGGGk.',
    '..kGGGGGk..',
    '...kGGGk...',
    '..kGGGGGk..',
    '..kkkkkkk..'
  ];
  var vasePal = { k: '#5a3a00', G: '#ffd24a' };

  // ブローチ — 楕円の金枠 + 宝石 (11x8)
  var BROOCH = [
    '...kkkkk...',
    '.kkGGGGGkk.',
    'kGGGBBBGGGk',
    'kGGBBWBBGGk',
    'kGGBBBBBGGk',
    'kGGGBBBGGGk',
    '.kkGGGGGkk.',
    '...kkkkk...'
  ];
  var broochPal = { k: '#3a2a10', G: '#ffd24a', B: '#c77dff', W: '#ffffff' };

  // 真実の鏡 — 丸い鏡 + 柄 (9x14)
  var MIRROR = [
    '..kGGGk..',
    '.kGMMMGk.',
    'kGMMMMMGk',
    'kGMMHMMGk',
    'kGMMMMMGk',
    'kGMMMMMGk',
    '.kGMMMGk.',
    '..kGGGk..',
    '...kGk...',
    '...kGk...',
    '...kGk...',
    '...kGk...',
    '..kGGGk..',
    '...kkk...'
  ];
  var mirrorPal = { k: '#3a2a10', G: '#ffd24a', M: '#bfe0ea', H: '#ffffff' };

  // ---- 追加バッチ (冒険・特殊・武器) ----
  // 世界樹の葉 — 金の葉脈が走る大きな葉 (11x13)
  var WORLDLEAF = [
    '....kkk....',
    '..kkGGGkk..',
    '.kLLLGLLLk.',
    'kLLLLGLLLLk',
    'kLLLGGGLLLk',
    'kLLLLGLLLLk',
    'kLLLLGLLLLk',
    '.kLLLGLLLk.',
    '.kLLLGLLLk.',
    '..kLLGLLk..',
    '...kLGLk...',
    '....kbk....',
    '....kkk....'
  ];
  var worldleafPal = { k: '#1a4a1a', L: '#5fc24a', G: '#ffe24a', b: '#6e4a26' };

  // 密造酒 — クランプ式ガラス瓶 + 琥珀色の液 + 泡 (11x14)
  var JUG = [
    '...kMMk....',
    '..kgggggk..',
    '..kgggggk..',
    '.MkgggggkM.',
    '.kvvvvvvvk.',
    'kgWWWWWWWgk',
    'kgAHAAAAAgk',
    'kgAHAAAAAgk',
    'kgAHAAAAAgk',
    'kgAAAAAAAgk',
    'kgAAAAAAAgk',
    'kgAAAAAAAgk',
    '.kAAAAAAAk.',
    '.kkkkkkkkk.'
  ];
  var jugPal = { k: '#3a2a1a', M: '#9aa4b0', g: '#d8e8ee', v: '#eaf6fa', W: '#f0d8b0', A: '#a8401a', H: '#e07a3a' };

  // 気付け薬 — 寸胴の小瓶 + 銀の栓 (9x11)
  var SMELLING = [
    '...kkk...',
    '...kSk...',
    '...kgk...',
    '..kgggk..',
    '.kgYYYgk.',
    'kgYYYYYgk',
    'kgYYYYYgk',
    'kgYYYYYgk',
    '.kgYYYgk.',
    '..kgggk..',
    '...kkk...'
  ];
  var smellingPal = { k: '#3a2a10', S: '#c0c0c8', g: '#cfe0e6', Y: '#ffe04a' };

  // ロープ — 巻いた縄 + 垂れた端 (11x11)
  var ROPE = [
    '...kkkkk...',
    '..kRRRRRk..',
    '.kRRRRRRRk.',
    'kRRRkkkRRRk',
    'kRRk...kRRk',
    'kRRRkkkRRRk',
    '.kRRRRRRRk.',
    '..kRRRRRk..',
    '...kkRkk...',
    '....kRk....',
    '....kkk....'
  ];
  var ropePal = { k: '#3a2a14', R: '#b8895a' };

  // 手裏剣 — 4 方向の刃 + 中央の穴 (11x11)
  var SHURIKEN = [
    '.....k.....',
    '....kSk....',
    '...kSSSk...',
    '..kSSSSSk..',
    'kkSSSSSSSkk',
    'kSSSk.kSSSk',
    'kkSSSSSSSkk',
    '..kSSSSSk..',
    '...kSSSk...',
    '....kSk....',
    '.....k.....'
  ];
  var shurikenPal = { k: '#181c22', S: '#9aa4b0' };

  // 投げナイフ — 細身の刃 + 環付き柄頭 (5x14)
  var THROWKNIFE = [
    '..k..',
    '.kSk.',
    '.kSk.',
    '.kSk.',
    '.kSk.',
    '.kSk.',
    '.kSk.',
    '.kSk.',
    'kkSkk',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kok.',
    '.kkk.'
  ];
  var throwknifePal = { k: '#20242c', S: '#c4ccd6', b: '#5b3819', o: '#9aa4b0' };

  // ヒールリング — 緑宝石(白十字) + 金の輪 (9x12)
  var HEALRING = [
    '...kkk...',
    '..kEEEk..',
    '.kEEWEEk.',
    '.kEWWWEk.',
    '.kEEWEEk.',
    '..kEEEk..',
    '.kGGGGGk.',
    'kGG...GGk',
    'kG.....Gk',
    '.kG...Gk.',
    '..kGGGk..',
    '...kkk...'
  ];
  var healringPal = { k: '#1a3a2a', E: '#3fd96a', W: '#ffffff', G: '#ffd24a' };

  // パワーリング — 赤い角宝石(印章) + 太い金の輪 (9x12)
  var PARING = [
    '..kkkkk..',
    '.kRRRRRk.',
    '.kRRoRRk.',
    '.kRoRoRk.',
    '.kRRoRRk.',
    '.kRRRRRk.',
    '.kGGGGGk.',
    'kGGG.GGGk',
    'kGG...GGk',
    '.kG...Gk.',
    '..kGGGk..',
    '...kkk...'
  ];
  var paringPal = { k: '#3a1010', R: '#ff5a3c', o: '#a01818', G: '#ffd24a' };

  // クレイモア — 両手大剣。 長い刃 + 角ばった鍔 (9x20)
  var CLAYMORE = [
    '....k....',
    '...kHk...',
    '..kHSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    '..kSSSk..',
    'kkkGGGkkk',
    '.kkGGGkk.',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '..kGGGk..',
    '...kkk...'
  ];

  // ロングソード — 細身の長い刃 + 金鍔 + 宝玉の柄頭 (9x19)
  var LONGSWORD = [
    '....k....',
    '...kHk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '...kSk...',
    '.kGGGGGk.',
    'kGGGGGGGk',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '..kGoGk..',
    '...kkk...'
  ];

  // ブロードソード — 幅広の刃 (9x15)
  var BROADSWORD = [
    '....k....',
    '...kSk...',
    '..kSSSk..',
    '.kHSSSSk.',
    '.kHSSSSk.',
    '.kHSSSSk.',
    '.kHSSSSk.',
    '.kHSSSSk.',
    '.kHSSSSk.',
    '.kGGGGGk.',
    'kGGGGGGGk',
    '...kbk...',
    '...kbk...',
    '..kGGGk..',
    '...kkk...'
  ];

  // レイピア — 極細の刃 + 籠状の護拳 (7x18)
  var RAPIER = [
    '...k...',
    '...S...',
    '...S...',
    '...S...',
    '...S...',
    '...S...',
    '...S...',
    '...S...',
    '...S...',
    '...S...',
    '..kSk..',
    'k.kGk.k',
    '.kGGGk.',
    'k.kGk.k',
    '...b...',
    '...b...',
    '..kok..',
    '...k...'
  ];
  var rapierPal = { k: '#20242c', S: '#dfe8f4', G: '#e0c060', b: '#3a2a1a', o: '#ffd24a' };

  // スピア — 猪槍 (横木付き) (7x18)
  var SPEAR2 = [
    '...k...',
    '..kSk..',
    '..kSk..',
    '.kSSSk.',
    '..kSk..',
    'k.kbk.k',
    '.kkbkk.',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kkk..'
  ];
  var spear2Pal = { k: '#2a1c10', S: '#aeb8c4', b: '#6e4a26' };

  // メイス — 棘付きの鉄球 + 柄 (9x17)
  var MACE = [
    '...kSk...',
    '.k.kSk.k.',
    '.kSSSSSk.',
    'kSSSSSSSk',
    'kSSSHSSSk',
    'kSSSSSSSk',
    '.kSSSSSk.',
    '.k.kSk.k.',
    '...kSk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '..kGGGk..',
    '...kkk...'
  ];
  var macePal = { k: '#1c2028', S: '#8a929e', H: '#c4ccd6', b: '#6e4a26', G: '#8a929e' };

  // ドラゴンの卵 — 鱗状の斑点 (11x14)
  var EGG = [
    '...kkkkk...',
    '..kDDDDDk..',
    '.kDDsDDDDk.',
    'kDDDDDsDDDk',
    'kDsDDDDDsDk',
    'kDDDDsDDDDk',
    'kDDsDDDsDDk',
    'kDDDDsDDDDk',
    'kDsDDDDDsDk',
    '.kDDDsDDDk.',
    '.kDDDDDDDk.',
    '..kDDDDDk..',
    '...kDDDk...',
    '....kkk....'
  ];
  var eggPal = { k: '#3a1a2a', D: '#c0506a', s: '#ffd24a' };

  // ウィザードスタッフ — 鉤爪に抱かれた水晶 + 杖 (9x18)
  var WIZSTAFF = [
    '...kCk...',
    '..kCCCk..',
    '.kCCWCCk.',
    '.kCCCCCk.',
    '..kCCCk..',
    '.kGkGkGk.',
    '..kGGGk..',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '...kwk...',
    '..kGGGk..',
    '...kkk...'
  ];
  var wizstaffPal = { k: '#1a1430', C: '#7fd8ff', W: '#ffffff', G: '#ffd24a', w: '#6e4a26' };

  // ルビーの指輪 — 丸いルビー + 穴あきの金の輪 (9x11)
  var RUBYRING = [
    '..kRRRk..',
    '.kRRWRRk.',
    '.kRRRRRk.',
    '..kRRRk..',
    '.kGGGGGk.',
    'kGGkkkGGk',
    'kGk...kGk',
    'kGGkkkGGk',
    '.kGGGGGk.',
    '..kGGGk..',
    '...kkk...'
  ];
  var rubyringPal = { k: '#3a1010', R: '#ff2a3a', W: '#ffffff', G: '#ffd24a' };

  // ---- 高レア目玉バッチ (r5x3 + r4x4) ----
  // スレイプニール — RO の神器。 紺×白の縞模様 + 翼付きのブーツ (13x13)
  var SLEIPNIR = [
    '....kkkk.....',
    '...kNNNNk....',
    'f..kWWWWk....',
    'ff.kNNNNk....',
    'fffkWWWWk....',
    'fffkNNNNk....',
    'ff.kWWWWk....',
    '...kNNNNk....',
    '...kNNNNkk...',
    '...kWWWWWWk..',
    '...kNNNNNNNk.',
    '..kkWWWWWWWWk',
    '..ks.....ksk.'
  ];
  var sleipnirPal = { k: '#16203f', N: '#34489a', W: '#e8ecf8', f: '#ffffff', s: '#20242c' };

  // 神官の手袋 — 白い篭手 + 金のカフ + 聖印 (9x12)
  var GLOVE = [
    '.kkkk....',
    'kWWWWk...',
    'kWWWWk...',
    'kWWWWkk..',
    'kWWWWWWk.',
    'kWWWWWWk.',
    'kWWOWWWk.',
    'kWWWWWWk.',
    'kGGGGGGk.',
    'kGGGGGGk.',
    'kGGGGGGk.',
    'kkkkkkkk.'
  ];
  var glovePal = { k: '#5a4a2a', W: '#f4f0e0', G: '#ffd24a', O: '#fff2b8' };

  // ドラゴンメイル — 肩当て + 胸当て + 金の紋章(赤宝石) (11x13)
  var DRAGONMAIL = [
    'kGk.....kGk',
    'kGGk...kGGk',
    'kGGGkkkGGGk',
    '.kSSSSSSSk.',
    'kSSSSSSSSSk',
    'kSSSGGGSSSk',
    'kSSSGRGSSSk',
    'kSSSGGGSSSk',
    'kSSSSSSSSSk',
    '.kSSSSSSSk.',
    '.kSSSSSSSk.',
    '..kSSSSSk..',
    '..kkkkkkk..'
  ];
  var dragonmailPal = { k: '#2a2a3a', S: '#8a92a8', G: '#ffd24a', R: '#ff3b3b' };

  // マジカルビキニ — ネタ枠。 白いホルターネックの二点 (11x12)
  var BIKINI = [
    '.....k.....',
    '....kWk....',
    '...kW.Wk...',
    'k.kWWWWWk.k',
    'kWWWk.kWWWk',
    'kWWWk.kWWWk',
    '.kWsk.ksWk.',
    '...........',
    '..kWWWWWk..',
    '.kWWsssWWk.',
    '..kWWWWWk..',
    '...kkkkk...'
  ];
  var bikiniPal = { k: '#8a93a8', W: '#ffffff', s: '#dde2ee' };

  // きぐるみ — ネタ枠。 白い猫フード + ちびっこ顔 (猫耳/赤リボン/ほっぺ) (11x13)
  var KIGURUMI = [
    '..k.....k..',
    '.kWk...kWk.',
    '.kPk...kPk.',
    '.kWWWWWWWk.',
    'kWWFFFFFWWk',
    'kWFFFFFFFWk',
    'kWFeFFFeFWk',
    'kWFbFmFbFWk',
    'kWWFFFFFWWk',
    'kWWRRRRRWWk',
    'kWWWWWWWWWk',
    '.kWWWWWWWk.',
    '..kkkkkkk..'
  ];
  var kigurumiPal = { k: '#8a93a8', W: '#ffffff', P: '#ffb0c0', F: '#ffe2cc', e: '#4a3a3a', b: '#ff9ab0', R: '#e23b3b', m: '#e87a8a' };

  // 魔導書 — 金枠の表紙 + 宝玉の紋章 + 留め金 (11x13)
  var GRIMOIRE = [
    '.kkkkkkkkk.',
    'kBBBBBBBBBk',
    'kBGGGGGGGBk',
    'kBGBBBBBGBk',
    'kBGBEEEBGBk',
    'kBGBEWEBGBk',
    'kBGBEEEBGBk',
    'kBGBBBBBGBk',
    'kBGGGGGGGBk',
    'kBBBBBBBBBk',
    'kBBkGGGkBBk',
    'kBBBBBBBBBk',
    '.kkkkkkkkk.'
  ];
  var grimoirePal = { k: '#1a1024', B: '#3a2a5a', G: '#ffd24a', E: '#5fd0ff', W: '#ffffff' };

  // 水晶玉 — 光る球 + 金の鉤爪台座 (11x13)
  var CRYSTALBALL = [
    '...kkkkk...',
    '..kCCCCCk..',
    '.kCCWCCCCk.',
    'kCCCCCCCCCk',
    'kCCCCCCCCCk',
    'kCCCCCCCCCk',
    '.kCCCCCCCk.',
    '..kCCCCCk..',
    '..Gk.k.kG..',
    '.kGGGGGGGk.',
    '..kGGGGGk..',
    '...kGGGk...',
    '...kkkkk...'
  ];
  var crystalballPal = { k: '#1a2a3a', C: '#8ad8f0', W: '#ffffff', G: '#ffd24a' };

  // ---- 中レア: 魔法・エレメント (r3) ----
  // ルーン石 — 石板 + 光る刻印 (9x11)
  var RUNE = [
    '..kkkkk..',
    '.kSSSSSk.',
    'kSSSGSSSk',
    'kSSGGGSSk',
    'kSGSGSGSk',
    'kSSSGSSSk',
    'kSSSGSSSk',
    'kSSSGSSSk',
    '.kSSSSSk.',
    '.kSSSSSk.',
    '..kkkkk..'
  ];
  var runePal = { k: '#2a2a30', S: '#7a7a86', G: '#5fffd0' };

  // 炎の結晶 — 赤い芯の結晶 (9x13)
  var FIRECRYSTAL = [
    '....k....',
    '...kFk...',
    '..kFFFk..',
    '.kFFRFFk.',
    'kFFFRFFFk',
    'kFFRRRFFk',
    'kFFFRFFFk',
    '.kFFRFFk.',
    '.kFFFFFk.',
    '..kFFFk..',
    '..kFFFk..',
    '...kFk...',
    '....k....'
  ];
  var firecrystalPal = { k: '#5a1500', F: '#ff7a3c', R: '#ffe04a' };

  // 氷の結晶 — 縦長の氷柱 (7x13)
  var ICECRYSTAL = [
    '..kkk..',
    '.kIWIk.',
    '.kIIIk.',
    'kIIIIIk',
    'kIIIIIk',
    'kIIWIIk',
    'kIIIIIk',
    'kIIIIIk',
    'kIIIIIk',
    '.kIIIk.',
    '.kIIIk.',
    '..kIk..',
    '..kkk..'
  ];
  var icecrystalPal = { k: '#1a3a5a', I: '#9ce0ff', W: '#ffffff' };

  // 雷の結晶 — 稲妻形 (9x13)
  var THUNDERCRYSTAL = [
    '...kkk...',
    '..kYYk...',
    '..kYk....',
    '.kYYk....',
    '.kYk.....',
    'kYYkkkk..',
    'kYYYYYYk.',
    '.kkkkYYk.',
    '....kYk..',
    '...kYYk..',
    '...kYk...',
    '..kYk....',
    '..kk.....'
  ];
  var thundercrystalPal = { k: '#5a4a00', Y: '#ffe23a' };

  // 魔法の巻物 — 両端を巻いた羊皮紙 + 文字 (13x9)
  var SCROLL = [
    '..PPPPPPPPP..',
    '.cPPPPPPPPPc.',
    'cCPPPPPPPPPCc',
    'cCPdPdPdPdPCc',
    'cCPPPPPPPPPCc',
    'cCPdPdPdPdPCc',
    'cCPPPPPPPPPCc',
    '.cPPPPPPPPPc.',
    '..PPPPPPPPP..'
  ];
  var scrollPal = { c: '#6e4a26', C: '#a9763f', P: '#e8d8a8', d: '#9a6a3a' };

  // 星のかけら — 4 方向に尖った輝き (11x11)
  var STAR = [
    '.....k.....',
    '....kYk....',
    '...kYYYk...',
    '..kYYYYYk..',
    'kkYYYWYYYkk',
    '.kYYYWYYYk.',
    'kkYYYYYYYkk',
    '..kYYYYYk..',
    '...kYYYk...',
    '....kYk....',
    '.....k.....'
  ];
  var starPal = { k: '#7a5a00', Y: '#ffe23a', W: '#ffffff' };

  // 妖精のビン — 瓶の中で光る妖精 + キラ (9x13)
  var FAIRYBOTTLE = [
    '..kkkkk..',
    '..kCCCk..',
    '...kgk...',
    '..kgggk..',
    '.kgggggk.',
    'kggisiggk',
    'kgswFwsgk',
    'kggiFiggk',
    'kggisiggk',
    '.kgggggk.',
    '.kgggggk.',
    '.kdddddk.',
    '..kkkkk..'
  ];
  var fairybottlePal = { k: '#2a2a3a', C: '#8a929e', g: '#bcd0dc', i: '#16243a', F: '#fff2a0', w: '#cfe8ff', s: '#ffffff', d: '#6a7a86' };

  // ---- 宝石・鉱石・小物 (r2 中心) ----
  // サファイア — ラウンドブリリアントカット (9x9)
  var SAPPHIRE = [
    '.kkkkkkk.',
    'kBWBBBBBk',
    'kBBBBBBBk',
    '.kBcccBk.',
    '.kBBBBBk.',
    '..kBBBk..',
    '..kBcBk..',
    '...kBk...',
    '....k....'
  ];
  var sapphirePal = { k: '#0a2a5a', B: '#3a7ae8', W: '#bcd8ff', c: '#1a4a9a' };

  // エメラルド — 角型ステップカット (9x11)
  var EMERALD = [
    '.kkkkkkk.',
    'kdEEEEEdk',
    'kEEEEEEEk',
    'kEWEEEEEk',
    'kEEEEEEEk',
    'kEdddddEk',
    'kEEEEEEEk',
    'kEdddddEk',
    'kEEEEEEEk',
    'kdEEEEEdk',
    '.kkkkkkk.'
  ];
  var emeraldPal = { k: '#0a3a1a', E: '#2fc25a', W: '#aaffc0', d: '#177a3a' };

  // トパーズ — ペアシェイプ (7x11)
  var TOPAZ = [
    '...k...',
    '..kTk..',
    '.kTTTk.',
    'kTTWTTk',
    'kTTTTTk',
    'kTTTTTk',
    'kTcTcTk',
    'kTTTTTk',
    '.kTTTk.',
    '.kTTTk.',
    '..kkk..'
  ];
  var topazPal = { k: '#5a3a00', T: '#ffb52e', W: '#fff0c0', c: '#c8801a' };

  // 真珠 — 滑らかな球 (9x9)
  var PEARL = [
    '...kkk...',
    '.kkPPPkk.',
    'kPWWPPPPk',
    'kPWPPPPPk',
    'kPPPPPPPk',
    'kPPPPPdPk',
    'kPPPdddPk',
    '.kkPPPkk.',
    '...kkk...'
  ];
  var pearlPal = { k: '#9a90a0', P: '#f4eef0', W: '#ffffff', d: '#d8c8d4' };

  // お札 — 赤い印の紙片 (7x14)
  var OFUDA = [
    '.kkkkk.',
    'kWWWWWk',
    'kWWRWWk',
    'kWRRRWk',
    'kWWRWWk',
    'kWWRWWk',
    'kWRRRWk',
    'kWWRWWk',
    'kWWWWWk',
    'kWWRWWk',
    'kWRRRWk',
    'kWWRWWk',
    'kWWWWWk',
    '.kkkkk.'
  ];
  var ofudaPal = { k: '#8a6a4a', W: '#f4ecd8', R: '#d82a2a' };

  // 木のルーン — 木札 + 刻印 (9x9)
  var WOODRUNE = [
    '.kkkkkkk.',
    'kBGBBBGBk',
    'kBBGBGBBk',
    'kBBBGBBBk',
    'kBBBGBBBk',
    'kBBBGBBBk',
    'kBBBGBBBk',
    'kBBBBBBBk',
    '.kkkkkkk.'
  ];
  var woodrunePal = { k: '#3a2410', B: '#8a5a2c', G: '#d8a85a' };

  // 羽根ペン — 青い羽 + インクの穂先 (9x14)
  var QUILL = [
    '....k....',
    '...kFk...',
    '..kFFFk..',
    '.kFvFvFk.',
    '.kFvFvFk.',
    '.kFvFvFk.',
    '..kFvFk..',
    '..kFvFk..',
    '...kvk...',
    '...kvk...',
    '...kvk...',
    '...kvk...',
    '...ksk...',
    '....k....'
  ];
  var quillPal = { k: '#3a2a3a', F: '#7ab8e8', v: '#cfe0f0', s: '#1a1a24' };

  // 松明 — 炎 + 巻いた頭 + 木の柄 (9x14)
  var TORCH = [
    '...kFk...',
    '..kFfFk..',
    '..kFfFk..',
    '.kFffFFk.',
    '.kFfffFk.',
    '.kFFfFFk.',
    '..kFFFk..',
    '..kWWWk..',
    '..kbbbk..',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '...kkk...'
  ];
  var torchPal = { k: '#3a1a00', F: '#ff6a2a', f: '#ffe04a', W: '#9a6a3a', b: '#6e4a26' };

  // 水筒 — 丸い金属の水筒 + コルク栓 (9x12)
  var CANTEEN = [
    '...kCk...',
    '..kgCgk..',
    '.kMMMMMk.',
    'kMMMMMMMk',
    'kMHMMMMMk',
    'kMMMMMMMk',
    'kMMMMMMMk',
    'kMMMMMMMk',
    'kMMMMMMMk',
    '.kMMMMMk.',
    '..kMMMk..',
    '...kkk...'
  ];
  var canteenPal = { k: '#2a3028', C: '#8a5a2c', g: '#9aa4b0', M: '#6a8a6a', H: '#aaccaa' };

  // 鉄鉱石 — ごつごつした原石 + 金属片 (9x9)
  var IRONORE = [
    '..kkkk...',
    '.kSSSSkk.',
    'kSSiSSSSk',
    'kSSSSSiSk',
    'kSiSSSSSk',
    'kSSSSiSSk',
    '.kSSSSSk.',
    '..kSSkk..',
    '...kk....'
  ];
  var ironorePal = { k: '#2a2a30', S: '#6a6a76', i: '#b8c0cc' };

  // オリデオコン — RO の貴重鉱石。 水色の細長い結晶 + 脇結晶 + 下の輝き (11x13)
  var ORIDECON = [
    '...k.......',
    '..kCk......',
    '.kCCCk.....',
    '.kCWCk.....',
    'kCCCCCk....',
    'kCWCCCk.kk.',
    'kCCCCCk.kCk',
    '.kCCCk..kCk',
    '.kCWCk..kCk',
    '..kCk...kk.',
    '..kCk......',
    '...k.......',
    '..gggg.....'
  ];
  var oridecornPal = { k: '#2a5a8a', C: '#7fd0ff', W: '#ffffff', g: '#bce8ff' };

  // ミスリル鉱石 — 青紫の結晶クラスター + 灰色の岩の土台 (11x13)
  var MITHRIL = [
    '.....k.....',
    '....kMk....',
    '..k.kMk....',
    '..kMkMk.k..',
    '.kMMkMkkMk.',
    '.kMHkMkMMk.',
    'kMMMkMkMMMk',
    'kMMMMMMMMMk',
    'kMHMMMMMHMk',
    'kMMMMMMMMMk',
    '.RRRRRRRRR.',
    'kRRRRRRRRRk',
    '.kkkkkkkkk.'
  ];
  var mithrilPal = { k: '#1a1a3a', M: '#5a6ae8', H: '#d0d8ff', R: '#7a7a86' };

  // ---- 低レア: 素朴で出てうれしい小物 (r1) ----
  // ウィング — ワープ用の羽 (11x10)
  var WING = [
    '........kk.',
    '......kkWk.',
    '.....kWWWk.',
    '...kkWWWWk.',
    '..kWWWWWWk.',
    '.kWWWWWWWk.',
    'kWWWWWWWk..',
    '.kkWWWWk...',
    '...kkWk....',
    '.....kk....'
  ];
  var wingPal = { k: '#5a7a9a', W: '#eaf2ff' };

  // マジックベリー — 光る木の実 + 葉 (9x11)
  var MAGICBERRY = [
    '....k....',
    '...kLk...',
    '..kLLk...',
    '...kk....',
    '..kBBBk..',
    '.kBBBBBk.',
    'kBBHBBBBk',
    'kBBBBBBBk',
    '.kBBBBBk.',
    '..kBBBk..',
    '...kkk...'
  ];
  var magicberryPal = { k: '#3a1a2a', B: '#ff5a8a', H: '#ffd0e0', L: '#4fbf3f' };

  // ろうそく — 火の灯ったロウソク (7x13)
  var CANDLE = [
    '...k...',
    '..kfk..',
    '..kFk..',
    '...k...',
    '.kWWWk.',
    '.kWWWk.',
    'kWWWWWk',
    'kWWWWWk',
    'kWWWWWk',
    'kWWWWWk',
    'kWWWWWk',
    '.kWWWk.',
    '..kkk..'
  ];
  var candlePal = { k: '#3a2a1a', f: '#ffe04a', F: '#ff8a2a', W: '#f4ecd8' };

  // 釣り竿 — 竿 + リール + 糸 + 針 (11x13)
  var FISHINGROD = [
    '.........kR',
    '........kRk',
    '.......kRk.',
    '......kRk..',
    '.....kRk.l.',
    '....kRk..l.',
    '...kRk...l.',
    '..kRko...l.',
    '.kRRko...h.',
    '.kRRk...hh.',
    '..kk.......',
    '...........',
    '...........'
  ];
  var fishingrodPal = { k: '#2a1c0a', R: '#a9763f', o: '#8a929e', l: '#cfd6e0', h: '#9aa4b0' };

  // 砥石 — 研ぎ石 (11x7)
  var WHETSTONE = [
    '.kkkkkkkkk.',
    'kSSSSSSSSSk',
    'kSSdddddSSk',
    'kSSSSSSSSSk',
    'kSSdddddSSk',
    'kSSSSSSSSSk',
    '.kkkkkkkkk.'
  ];
  var whetstonePal = { k: '#2a2a30', S: '#8a8a96', d: '#5a5a64' };

  // 光り苔 — 光る苔の塊 (11x7)
  var GLOWMOSS = [
    '..k.k.k.k..',
    '.kGkGkGkGk.',
    'kGGgGGgGGGk',
    'kGgGGGGgGGk',
    'kGGGgGGGGgk',
    '.kGGGGGGGk.',
    '..kkkkkkk..'
  ];
  var glowmossPal = { k: '#1a3a1a', G: '#3a8a3a', g: '#9affb0' };

  // 釣り餌 — くねった虫 (11x7)
  var BAIT = [
    '.kkk.......',
    'kWWWk......',
    'kWWWkkk....',
    '.kkWWWk....',
    '...kWWWkk..',
    '.....kWWWk.',
    '......kkk..'
  ];
  var baitPal = { k: '#5a3a3a', W: '#e89a8a' };

  // どんぐり — 帽子付きの実 (7x9)
  var ACORN = [
    '.kkkkk.',
    'kHHHHHk',
    'kCCCCCk',
    '.kAAAk.',
    '.kAAAk.',
    '.kAAAk.',
    '..kAk..',
    '..kAk..',
    '...k...'
  ];
  var acornPal = { k: '#3a2410', H: '#8a5a2c', C: '#6e4a26', A: '#c8a070' };

  // 貝殻 — 扇形のホタテ貝 (11x7)
  var SHELL = [
    '....kkk....',
    '...kSSSk...',
    '..kSPSPSk..',
    '.kSPSPSPSk.',
    'kSPSPSPSPSk',
    'kSPSPSPSPSk',
    '.kkkkkkkkk.'
  ];
  var shellPal = { k: '#8a6a7a', S: '#ffd8e0', P: '#e8a8c0' };

  // ビー玉 — 渦巻きガラス玉 (9x9)
  var MARBLE = [
    '..kkkkk..',
    '.kMMMMMk.',
    'kMWMMMMMk',
    'kMMMSSMMk',
    'kMMSSSMMk',
    'kMMMSSMMk',
    'kMMMMMMMk',
    '.kMMMMMk.',
    '..kkkkk..'
  ];
  var marblePal = { k: '#3a4a5a', M: '#bce0f0', W: '#ffffff', S: '#ff6db0' };

  // 鈴 — 金の鈴 (9x11)
  var BELL = [
    '....k....',
    '...k.k...',
    '...kGk...',
    '..kGGGk..',
    '.kGGGGGk.',
    'kGGGHGGGk',
    'kGGGGGGGk',
    'kGGGGGGGk',
    '.kGGGGGk.',
    '.kGkGkGk.',
    '..kkkkk..'
  ];
  var bellPal = { k: '#5a3a00', G: '#ffd24a', H: '#fff2b8' };

  // 銅貨 — 角穴の古銭 (9x9)
  var COPPER = [
    '..kkkkk..',
    '.kCCCCCk.',
    'kCCkkkCCk',
    'kCk...kCk',
    'kCk...kCk',
    'kCk...kCk',
    'kCCkkkCCk',
    '.kCCCCCk.',
    '..kkkkk..'
  ];
  var copperPal = { k: '#3a1c0a', C: '#c87a3a' };

  // リボン — 蝶結びのリボン (11x8)
  var RIBBON = [
    '.kkk...kkk.',
    'kHHHk.kHHHk',
    'kHHHHkHHHHk',
    '.kHHkkkHHk.',
    '..kkkHkkk..',
    '...kHkHk...',
    '...kHkHk...',
    '...kkkkk...'
  ];
  var ribbonPal = { k: '#7a2a4a', H: '#ff6db0' };

  // あめ玉 — 包み飴 (11x7)
  var CANDY = [
    '.k.......k.',
    'kWk.....kWk',
    '.kWkRRRkWk.',
    '..kRRRRRk..',
    '.kWkRRRkWk.',
    'kWk.....kWk',
    '.k.......k.'
  ];
  var candyPal = { k: '#5a2a3a', W: '#ffe0ec', R: '#ff5a7a' };

  // ウィザードハット — 星付きの三角帽 + 金の鍔 (11x13)
  var WIZHAT = [
    '.....k.....',
    '....kPk....',
    '....kPk....',
    '...kPPPk...',
    '...kPPPk...',
    '..kPPPPPk..',
    '..kPSWSPk..',
    '.kPPPPPPPk.',
    '.kPPPPPPPk.',
    'kPPPPPPPPPk',
    'kBBBBBBBBBk',
    'kkBBBBBBBkk',
    '.kkkkkkkkk.'
  ];
  var wizhatPal = { k: '#1a1430', P: '#5a3a8a', S: '#ffe23a', W: '#ffffff', B: '#c89a3a' };

  // 花の種 — 苗が出た種袋 (9x11)
  var SEED = [
    '....G....',
    '...GkG...',
    '...kgk...',
    '..kkkkk..',
    '.kBBBBBk.',
    'kBBBBBBBk',
    'kBsBsBsBk',
    'kBBBBBBBk',
    'kBsBsBsBk',
    '.kBBBBBk.',
    '..kkkkk..'
  ];
  var seedPal = { k: '#3a2a14', B: '#b89860', s: '#6e4a26', G: '#4fbf3f', g: '#3a8a2a' };

  // エクスカリバー — 最高レアの聖剣。 金縁の刃 + 樋 + 宝石付き鍔 + 青の柄 + 宝玉の柄頭 (11x20)
  var EXCALIBUR = [
    '.....k.....',
    '....kHk....',
    '...kHSHk...',
    '..kGSSSGk..',
    '..kGSfSGk..',
    '..kGSSSGk..',
    '..kGSfSGk..',
    '..kGSSSGk..',
    '..kGSfSGk..',
    '..kGSSSGk..',
    '..kGSfSGk..',
    '..kGSSSGk..',
    'kBGGGGGGGBk',
    '.kdGGGGGdk.',
    '....kuk....',
    '....kuk....',
    '....kuk....',
    '....kuk....',
    '...kGBGk...',
    '....kkk....'
  ];
  var excaliburPal = { k: '#1a2030', S: '#dfe8f4', H: '#ffffff', f: '#9fb0c8', G: '#ffd24a', d: '#c8901a', B: '#5ad0ff', u: '#2a6cc8' };
  var swordPal = { k: '#20242c', S: '#aeb8c4', H: '#ffffff', G: '#ffd24a', g: '#c8901a', b: '#6e4a26', o: '#ff4d6d' };

  // 短剣 — 短い刃 + 鍔 + 赤宝石の柄頭 (7x12)
  var DAGGER = [
    '...k...',
    '..kHk..',
    '..kSk..',
    '..kSk..',
    '..kSk..',
    '..kSk..',
    '.kGGGk.',
    'kGGGGGk',
    '..kbk..',
    '..kbk..',
    '..kok..',
    '..kkk..'
  ];

  // 槍 — 長い柄 + 葉型の穂先 (5x18)
  var SPEAR = [
    '..k..',
    '.kHk.',
    'kHSSk',
    'kSSSk',
    'kSSSk',
    '.kSk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kbk.',
    '.kGk.',
    '.kkk.'
  ];

  // 魔法の杖 — 柄 + 紫のオーブ (7x17)
  var STAFF = [
    '..kBk..',
    '.kBWBk.',
    'kBBBBBk',
    'kBBBBBk',
    '.kBBBk.',
    '..kGk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kGk..',
    '..kkk..'
  ];
  var staffPal = { k: '#241204', B: '#c77dff', W: '#ffffff', G: '#ffd24a', b: '#6e4a26' };

  // 炎の大剣 — 炎色の刃 + 金の鍔 + 赤宝石 (9x18)
  var FSWORD = [
    '....F....',
    '...FFF...',
    '...kFk...',
    '..kFrFk..',
    '..kFrFk..',
    '..kFrFk..',
    '..kFrFk..',
    '..kFrFk..',
    '..kFrFk..',
    '..kFrFk..',
    '.kGGGGGk.',
    'kGoGGGoGk',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '..kGoGk..',
    '..kGGGk..',
    '...kkk...'
  ];
  var fswordPal = { k: '#3a1500', F: '#ff8a3c', r: '#ff3b3b', G: '#ffd24a', o: '#ff4d6d', b: '#6e4a26' };

  // 黒騎士の剣 — 暗い大剣 + 翼状の鍔 (11x20)
  var BLACKSWORD = [
    '.....k.....',
    '....kDk....',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    '...kDSDk...',
    'Gk..kDk..kG',
    '.Gk.kDk.kG.',
    '..GkkDkkG..',
    '..kGGGGGk..',
    '....kbk....',
    '....kbk....',
    '...kGoGk...',
    '....kkk....'
  ];
  var blackswordPal = { k: '#08080c', D: '#2e2e3a', S: '#7a808e', G: '#454038', b: '#1c1814', o: '#7a6038' };

  // 黄金銃 — チート級の金のピストル (13x11)
  var GOLDGUN = [
    '..kkkkkkkkk..',
    '.kGGGGGGGGGk.',
    '.kGHGGGGGGGkk',
    'kkGGGGGGGGGGk',
    'kGGGGkGGGGGk.',
    'kGGGkokGGkk..',
    'kGGGkkk......',
    'kGGGk........',
    '.kGGGk.......',
    '.kGGGk.......',
    '..kkk........'
  ];
  var goldgunPal = { k: '#5a3a00', G: '#ffd24a', H: '#fff2b8', o: '#3a2a00' };

  // グングニル — 伝説の槍。 金縁の刃 + 青宝石 + 翼状の護り + 金帯の柄 (9x18)
  var GUNGNIR = [
    '....k....',
    '...kGk...',
    '..kGSGk..',
    '..kGSGk..',
    '.kGSSSGk.',
    '.kGSBSGk.',
    '.kGSSSGk.',
    '..kGSGk..',
    '..kGSGk..',
    'kGGGGGGGk',
    '.kGGGGGk.',
    '...kGk...',
    '...kbk...',
    '...kGk...',
    '...kbk...',
    '...kGk...',
    '...kGk...',
    '...kkk...'
  ];
  var gungnirPal = { k: '#3a2a00', G: '#ffd24a', S: '#dfe6ee', B: '#4fd0ff', b: '#6e4a26' };

  // 鉄の剣 — 標準の片手剣。 鋼の刃 + 鉄の鍔 (9x18)
  var IRON = [
    '....k....',
    '...kHk...',
    '..kHSSk..',
    '..kHSSk..',
    '..kHSSk..',
    '..kHSSk..',
    '..kHSSk..',
    '..kHSSk..',
    '..kHSSk..',
    '..kHSSk..',
    '.kiiiiik.',
    'kiiiiiiik',
    '...kbk...',
    '...kbk...',
    '...kbk...',
    '..kiiik..',
    '..kiiik..',
    '...kkk...'
  ];
  var ironPal = { k: '#1c2028', S: '#b8c0cc', H: '#e8edf3', i: '#8a929e', b: '#5b3819' };

  // 氷の剣 — 氷青の刃 + 青宝石 + 青の柄 (9x18)
  var FROST = [
    '....k....',
    '...kWk...',
    '..kCWCk..',
    '..kCWCk..',
    '..kCWCk..',
    '..kCWCk..',
    '..kCWCk..',
    '..kCWCk..',
    '..kCWCk..',
    '..kCWCk..',
    '.kSSBSSk.',
    'kSSSSSSSk',
    '...kuk...',
    '...kuk...',
    '...kuk...',
    '..kSBSk..',
    '..kSSSk..',
    '...kkk...'
  ];
  var frostPal = { k: '#16283a', C: '#7fd8ff', W: '#ffffff', S: '#c8d4e0', B: '#3aa0ff', u: '#2a6cc8' };

  // 盗賊の短剣 — ブルーイングの葉型刃 + 真鍮の鍔 + 革巻き柄 + 緑(毒)の宝玉 (7x13)
  var THIEF = [
    '...k...',
    '..kHk..',
    '..kDk..',
    '.kDDDk.',
    '.kDHDk.',
    '.kDDDk.',
    '..kDk..',
    '.kGGGk.',
    '..kbk..',
    '..kbk..',
    '..kbk..',
    '..kPk..',
    '..kkk..'
  ];
  var thiefPal = { k: '#15161c', D: '#3a4a5a', H: '#8aa0b8', G: '#b08d57', b: '#5b3819', P: '#5cff8f' };

  // ---- 探検アイテム ----
  // 宝の鍵 — 金の鍵。 環の握り (穴) + 軸 + 歯 (7x14)
  var KEY = [
    '..kkk..',
    '.kGHGk.',
    '.kG.Gk.',
    '.kGGGk.',
    '..kGk..',
    '..kGk..',
    '..kGk..',
    '..kGk..',
    '..kGk..',
    '..kGGk.',
    '..kGk..',
    '..kGGk.',
    '..kGk..',
    '..kkk..'
  ];
  var keyPal = { k: '#5a3a00', G: '#ffd24a', H: '#fff2b8' };

  // ランタン — 真鍮の枠 + ガラス + 中の炎 (9x14)
  var LANTERN = [
    '...kkk...',
    '..kG.Gk..',
    '...kGk...',
    '.kGGGGGk.',
    'kGkkkkkGk',
    'kGLLLLLGk',
    'kGLfFfLGk',
    'kGLfFfLGk',
    'kGLLfLLGk',
    'kGLLLLLGk',
    'kGkkkkkGk',
    '.kGGGGGk.',
    '..kGGGk..',
    '...kkk...'
  ];
  var lanternPal = { k: '#3a2a10', G: '#c8901a', L: '#ffe9a8', F: '#ff8a3c', f: '#ffd24a' };

  // 古地図 — 羊皮紙 + 点線ルート + 赤い X (11x9)
  var MAP = [
    '.kkkkkkkkk.',
    'kPdPPPPPPPk',
    'kPPdPPPPPPk',
    'kPPPdPPPPPk',
    'kPPPPdPPPPk',
    'kPPPPRPRPPk',
    'kPPPPPRPPPk',
    'kPPPPRPRPPk',
    '.kkkkkkkkk.'
  ];
  var mapPal = { k: '#6e5a2c', P: '#e8d8a8', d: '#9a6a3a', R: '#ff3b3b' };

  // コンパス — 真鍮の円ケース + 赤白の針 (11x11)
  var COMPASS = [
    '...kkkkk...',
    '.kkGGGGGkk.',
    '.kGGGRGGGk.',
    'kGGGGRGGGGk',
    'kGGGGRGGGGk',
    'kGGGGoGGGGk',
    'kGGGGWGGGGk',
    'kGGGGWGGGGk',
    '.kGGGWGGGk.',
    '.kkGGGGGkk.',
    '...kkkkk...'
  ];
  var compassPal = { k: '#3a2a10', G: '#c8901a', R: '#ff3b3b', W: '#ffffff', o: '#2a2018' };

  // 守りの盾 — ヒーター型 + 金の十字紋章 + 角の金鋲 (13x15)
  var SHIELD = [
    '.GkkkkkkkkkG.',
    '.kHSSSSSSSsk.',
    'kHSSSSGSSSSsk',
    'kHSSSSGSSSSsk',
    'kHGGGGHGGGGsk',
    'kHSSSSGSSSSsk',
    'kHSSSSGSSSSsk',
    'kHSSSSGSSSSsk',
    'kHSSSSSSSSSsk',
    '.kHSSSSSSSsk.',
    '.kHSSSSSSSsk.',
    '..kHSSSSSsk..',
    '...kHSSSsk...',
    '....kHSsk....',
    '.....ksk.....'
  ];
  var shieldPal = { k: '#2a3038', S: '#aeb8c4', H: '#e8edf3', s: '#6e7a8a', G: '#ffd24a' };

  // 木の丸盾 — 円形 + 鉄リム + 木の板目 + 中央の金ボス (13x13)
  var RSHIELD = [
    '....kkkkk....',
    '..kkIIIIIkk..',
    '.kIWWWWWWWIk.',
    '.kIWwWWWwWIk.',
    'kIWWWWWWWWWIk',
    'kIWWWoooWWWIk',
    'kIWwWoOoWwWIk',
    'kIWWWoooWWWIk',
    'kIWWWWWWWWWIk',
    '.kIWwWWWwWIk.',
    '.kIWWWWWWWIk.',
    '..kkIIIIIkk..',
    '....kkkkk....'
  ];
  var rshieldPal = { k: '#241204', I: '#8a929e', W: '#8a5a2c', w: '#5b3819', o: '#ffd24a', O: '#fff2b8' };

  // 黄金の盾 — ヒーター型 + 金地 + 青宝石 (13x15)
  var GSHIELD = [
    '.WkkkkkkkkkW.',
    '.kHGGGGGGGdk.',
    'kHGGGGGGGGGdk',
    'kHGGGGBGGGGdk',
    'kHGGGBWBGGGdk',
    'kHGGGGBGGGGdk',
    'kHGGGGGGGGGdk',
    'kHGGGGGGGGGdk',
    'kHGGGGGGGGGdk',
    '.kHGGGGGGGdk.',
    '.kHGGGGGGGdk.',
    '..kHGGGGGdk..',
    '...kHGGGdk...',
    '....kHGdk....',
    '.....kGk.....'
  ];
  var gshieldPal = { k: '#4a3000', G: '#ffd24a', H: '#fff2b8', d: '#c8901a', B: '#4fd0ff', W: '#ffffff' };

  // バックラー — 小型の円盾 + 金ボス (9x9)
  var BUCKLER = [
    '..kkkkk..',
    '.kIIIIIk.',
    'kIIIIIIIk',
    'kIIoooIIk',
    'kIIoOoIIk',
    'kIIoooIIk',
    'kIIIIIIIk',
    '.kIIIIIk.',
    '..kkkkk..'
  ];
  var bucklerPal = { k: '#241a0a', I: '#9aa0a8', o: '#ffd24a', O: '#fff2b8' };

  // カイトシールド — 涙滴型 + 青宝石 (12x15)
  var KSHIELD = [
    '...kkkkkk...',
    '.kkSSSSSSkk.',
    'kHSSSSSSSSsk',
    'kHSSSBBSSSsk',
    'kHSSSBBSSSsk',
    'kHSSSSSSSSsk',
    'kHSSSSSSSSsk',
    '.kHSSSSSSsk.',
    '.kHSSSSSSsk.',
    '..kHSSSSsk..',
    '..kHSSSSsk..',
    '...kHSSsk...',
    '...kHSSsk...',
    '....kHsk....',
    '.....kk.....'
  ];
  var kshieldPal = { k: '#2a3038', S: '#aeb8c4', H: '#e8edf3', s: '#6e7a8a', B: '#4fd0ff' };

  // ドラゴンシールド — ヒーター型 + 赤い竜鱗 + 赤宝石 + 金縁 (13x15)
  var DSHIELD = [
    '.GkkkkkkkkkG.',
    '.kDvDvDvDvDk.',
    'kDvDvDvDvDvDk',
    'kvDvDvDvDvDvk',
    'kDvDvDRDvDvDk',
    'kvDvDRWRDvDvk',
    'kDvDvDRDvDvDk',
    'kvDvDvDvDvDvk',
    'kDvDvDvDvDvDk',
    '.kDvDvDvDvDk.',
    '.kvDvDvDvDvk.',
    '..kDvDvDvDk..',
    '...kvDvDvk...',
    '....kDvDk....',
    '.....kvk.....'
  ];
  var dshieldPal = { k: '#1a0c0c', D: '#6e4242', v: '#3e2424', R: '#ff3b3b', W: '#ffd0d0', G: '#ffd24a' };

  function gemSvg(color, scale) {
    var dark = shade(color, -40), hi = '#ffffff';
    return pix(gemRows(), { k: '#1a1030', C: color, c: dark, H: hi }, scale);
  }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    var b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // 指輪 (魔法の指輪) — 金のバンド + 宝石。 中央の穴 (.) は透過
  var RING = [
    '...kCk...',
    '..kCWCk..',
    '..kCCck..',
    '.kkGGGkk.',
    'kGGGGGGGk',
    'kGd...dGk',
    'kGd...dGk',
    '.kGd.dGk.',
    '..kGGGk..',
    '...kkk...'
  ];
  function ringSvg(color, scale) {
    return pix(RING, { k: '#3a2a08', G: '#ffd24a', d: '#c8901a', C: color, c: shade(color, -55), W: '#ffffff' }, scale);
  }

  // 任意アイテムの sprite を返す共通ヘルパー (pile / showcase 兼用)
  function itemSprite(type, color, scale) {
    if (type === 'coin') return pix(COIN, coinPal, scale);
    if (type === 'potion') return pix(POTION, potionPal, scale);
    if (type === 'mana') return pix(MANA, manaPal, scale);
    if (type === 'antidote') return pix(ANTIDOTE, antidotePal, scale);
    if (type === 'elixir') return pix(ELIXIR, elixirPal, scale);
    if (type === 'herb') return pix(HERB, herbPal, scale);
    if (type === 'mushroom') return pix(MUSHROOM, mushroomPal, scale);
    if (type === 'flower') return pix(FLOWER, flowerPal, scale);
    if (type === 'clover') return pix(CLOVER, cloverPal, scale);
    if (type === 'sacred') return pix(SACRED, sacredPal, scale);
    if (type === 'necklace') return pix(NECKLACE, necklacePal, scale);
    if (type === 'tiara') return pix(TIARA, tiaraPal, scale);
    if (type === 'chalice') return pix(CHALICE, chalicePal, scale);
    if (type === 'idol') return pix(IDOL, idolPal, scale);
    if (type === 'hourglass') return pix(HOURGLASS, hourglassPal, scale);
    if (type === 'vase') return pix(VASE, vasePal, scale);
    if (type === 'brooch') return pix(BROOCH, broochPal, scale);
    if (type === 'mirror') return pix(MIRROR, mirrorPal, scale);
    if (type === 'ring') return ringSvg(color || GEM_COLORS[3], scale);
    if (type === 'crown') return pix(CROWN, crownPal, scale);
    if (type === 'sword') return pix(EXCALIBUR, excaliburPal, scale);
    if (type === 'dagger') return pix(DAGGER, swordPal, scale);
    if (type === 'thief') return pix(THIEF, thiefPal, scale);
    if (type === 'iron') return pix(IRON, ironPal, scale);
    if (type === 'frost') return pix(FROST, frostPal, scale);
    if (type === 'spear') return pix(SPEAR, swordPal, scale);
    if (type === 'gungnir') return pix(GUNGNIR, gungnirPal, scale);
    if (type === 'staff') return pix(STAFF, staffPal, scale);
    if (type === 'fsword') return pix(FSWORD, fswordPal, scale);
    if (type === 'blacksword') return pix(BLACKSWORD, blackswordPal, scale);
    if (type === 'goldgun') return pix(GOLDGUN, goldgunPal, scale);
    if (type === 'key') return pix(KEY, keyPal, scale);
    if (type === 'lantern') return pix(LANTERN, lanternPal, scale);
    if (type === 'map') return pix(MAP, mapPal, scale);
    if (type === 'compass') return pix(COMPASS, compassPal, scale);
    if (type === 'shield') return pix(SHIELD, shieldPal, scale);
    if (type === 'rshield') return pix(RSHIELD, rshieldPal, scale);
    if (type === 'gshield') return pix(GSHIELD, gshieldPal, scale);
    if (type === 'buckler') return pix(BUCKLER, bucklerPal, scale);
    if (type === 'kshield') return pix(KSHIELD, kshieldPal, scale);
    if (type === 'dshield') return pix(DSHIELD, dshieldPal, scale);
    if (type === 'worldleaf') return pix(WORLDLEAF, worldleafPal, scale);
    if (type === 'jug') return pix(JUG, jugPal, scale);
    if (type === 'smelling') return pix(SMELLING, smellingPal, scale);
    if (type === 'rope') return pix(ROPE, ropePal, scale);
    if (type === 'shuriken') return pix(SHURIKEN, shurikenPal, scale);
    if (type === 'throwknife') return pix(THROWKNIFE, throwknifePal, scale);
    if (type === 'healring') return pix(HEALRING, healringPal, scale);
    if (type === 'paring') return pix(PARING, paringPal, scale);
    if (type === 'claymore') return pix(CLAYMORE, swordPal, scale);
    if (type === 'longsword') return pix(LONGSWORD, swordPal, scale);
    if (type === 'broadsword') return pix(BROADSWORD, swordPal, scale);
    if (type === 'rapier') return pix(RAPIER, rapierPal, scale);
    if (type === 'spear2') return pix(SPEAR2, spear2Pal, scale);
    if (type === 'mace') return pix(MACE, macePal, scale);
    if (type === 'egg') return pix(EGG, eggPal, scale);
    if (type === 'wizstaff') return pix(WIZSTAFF, wizstaffPal, scale);
    if (type === 'rubyring') return pix(RUBYRING, rubyringPal, scale);
    if (type === 'sleipnir') return pix(SLEIPNIR, sleipnirPal, scale);
    if (type === 'hglove') return pix(GLOVE, glovePal, scale);
    if (type === 'dragonmail') return pix(DRAGONMAIL, dragonmailPal, scale);
    if (type === 'bikini') return pix(BIKINI, bikiniPal, scale);
    if (type === 'kigurumi') return pix(KIGURUMI, kigurumiPal, scale);
    if (type === 'grimoire') return pix(GRIMOIRE, grimoirePal, scale);
    if (type === 'crystalball') return pix(CRYSTALBALL, crystalballPal, scale);
    if (type === 'rune') return pix(RUNE, runePal, scale);
    if (type === 'firecrystal') return pix(FIRECRYSTAL, firecrystalPal, scale);
    if (type === 'icecrystal') return pix(ICECRYSTAL, icecrystalPal, scale);
    if (type === 'thundercrystal') return pix(THUNDERCRYSTAL, thundercrystalPal, scale);
    if (type === 'scroll') return pix(SCROLL, scrollPal, scale);
    if (type === 'star') return pix(STAR, starPal, scale);
    if (type === 'fairybottle') return pix(FAIRYBOTTLE, fairybottlePal, scale);
    if (type === 'sapphire') return pix(SAPPHIRE, sapphirePal, scale);
    if (type === 'emerald') return pix(EMERALD, emeraldPal, scale);
    if (type === 'topaz') return pix(TOPAZ, topazPal, scale);
    if (type === 'pearl') return pix(PEARL, pearlPal, scale);
    if (type === 'ofuda') return pix(OFUDA, ofudaPal, scale);
    if (type === 'woodrune') return pix(WOODRUNE, woodrunePal, scale);
    if (type === 'quill') return pix(QUILL, quillPal, scale);
    if (type === 'torch') return pix(TORCH, torchPal, scale);
    if (type === 'canteen') return pix(CANTEEN, canteenPal, scale);
    if (type === 'ironore') return pix(IRONORE, ironorePal, scale);
    if (type === 'oridecon') return pix(ORIDECON, oridecornPal, scale);
    if (type === 'mithril') return pix(MITHRIL, mithrilPal, scale);
    if (type === 'wing') return pix(WING, wingPal, scale);
    if (type === 'magicberry') return pix(MAGICBERRY, magicberryPal, scale);
    if (type === 'candle') return pix(CANDLE, candlePal, scale);
    if (type === 'fishingrod') return pix(FISHINGROD, fishingrodPal, scale);
    if (type === 'whetstone') return pix(WHETSTONE, whetstonePal, scale);
    if (type === 'glowmoss') return pix(GLOWMOSS, glowmossPal, scale);
    if (type === 'bait') return pix(BAIT, baitPal, scale);
    if (type === 'acorn') return pix(ACORN, acornPal, scale);
    if (type === 'shell') return pix(SHELL, shellPal, scale);
    if (type === 'marble') return pix(MARBLE, marblePal, scale);
    if (type === 'bell') return pix(BELL, bellPal, scale);
    if (type === 'copper') return pix(COPPER, copperPal, scale);
    if (type === 'ribbon') return pix(RIBBON, ribbonPal, scale);
    if (type === 'candy') return pix(CANDY, candyPal, scale);
    if (type === 'wizhat') return pix(WIZHAT, wizhatPal, scale);
    if (type === 'seed') return pix(SEED, seedPal, scale);
    return gemSvg(color || GEM_COLORS[0], scale);   // gem / big
  }

  var GEM_COLORS = ['#4fd0ff', '#5cff8f', '#ff6db0', '#c77dff', '#ff5a5a'];

  // ---- Tier 設定 (金額で段階。 高 Tier 限定アイテムあり) ----
  var TIERS = [
    { key: 'blue',    amt: '¥100',    color: '#4a90ff', coins: 6,  gems: 0, big: 0, crown: false, rainbow: false, stars: 1, rank: 'COMMON' },
    { key: 'teal',    amt: '¥200',    color: '#1de9b6', coins: 8,  gems: 1, big: 0, crown: false, rainbow: false, stars: 2, rank: 'UNCOMMON' },
    { key: 'green',   amt: '¥500',    color: '#42d742', coins: 10, gems: 2, big: 0, crown: false, rainbow: false, stars: 3, rank: 'RARE' },
    { key: 'yellow',  amt: '¥1,000',  color: '#ffcf33', coins: 14, gems: 3, big: 1, crown: false, rainbow: false, stars: 4, rank: 'SUPER RARE' },
    { key: 'orange',  amt: '¥2,000',  color: '#ff9a3c', coins: 18, gems: 4, big: 1, crown: false, rainbow: false, stars: 4, rank: 'EPIC' },
    { key: 'magenta', amt: '¥5,000',  color: '#ff4db8', coins: 24, gems: 5, big: 2, crown: true,  rainbow: false, stars: 5, rank: 'LEGENDARY' },
    { key: 'red',     amt: '¥10,000', color: '#ff3b3b', coins: 32, gems: 7, big: 2, crown: true,  rainbow: true,  stars: 6, rank: 'MYTHIC' }
  ];

  // アイテム名 + 固有レアリティ (1=COMMON .. 5=LEGENDARY)。 名前の見せ方はこの r で変わる
  var ITEM_INFO = {
    coin:   { name: '金貨',           r: 1 },
    gem:    { name: '宝石',           r: 2 },
    big:    { name: '大粒の宝石',     r: 3 },
    potion: { name: '回復のポーション', r: 2 },
    mana:   { name: 'マナポーション', r: 2 },
    antidote:{ name: '解毒薬',        r: 2 },
    elixir: { name: 'エリクサー',     r: 4 },
    herb:   { name: '薬草',           r: 1 },
    mushroom:{ name: '薬用キノコ',    r: 1 },
    flower: { name: '回復の花',       r: 2 },
    clover: { name: '四つ葉のクローバー', r: 2 },
    sacred: { name: '霊草',           r: 3 },
    necklace:{ name: 'ネックレス',    r: 3 },
    tiara:  { name: 'ティアラ',       r: 4 },
    chalice:{ name: '聖杯',           r: 4 },
    idol:   { name: '黄金像',         r: 4 },
    hourglass:{ name: '砂時計',       r: 3 },
    vase:   { name: '黄金の壺',       r: 3 },
    brooch: { name: 'ブローチ',       r: 2 },
    mirror: { name: '真実の鏡',       r: 3 },
    worldleaf:{ name: '世界樹の葉',   r: 4 },
    jug:    { name: '密造酒',         r: 4 },
    smelling:{ name: '気付け薬',      r: 3 },
    rope:   { name: 'ロープ',         r: 1 },
    shuriken:{ name: '手裏剣',        r: 1 },
    throwknife:{ name: '投げナイフ',  r: 1 },
    healring:{ name: 'ヒールリング',  r: 5 },
    paring: { name: 'パワーリング',   r: 4 },
    claymore:{ name: 'クレイモア',    r: 4 },
    longsword:{ name: 'ロングソード', r: 3 },
    broadsword:{ name: 'ブロードソード', r: 2 },
    rapier: { name: 'レイピア',       r: 1 },
    spear2: { name: 'スピア',         r: 1 },
    mace:   { name: 'メイス',         r: 1 },
    egg:    { name: 'ドラゴンの卵',   r: 5 },
    wizstaff:{ name: 'ウィザードスタッフ', r: 5 },
    rubyring:{ name: 'ルビーの指輪',  r: 2 },
    sleipnir:{ name: 'スレイプニール', r: 5 },
    hglove: { name: '神官の手袋',     r: 5 },
    dragonmail:{ name: 'ドラゴンメイル', r: 5 },
    bikini: { name: 'マジカルビキニ', r: 4 },
    kigurumi:{ name: 'きぐるみ',      r: 4 },
    grimoire:{ name: '魔導書',        r: 4 },
    crystalball:{ name: '水晶玉',     r: 4 },
    rune:   { name: 'ルーン石',       r: 3 },
    firecrystal:{ name: '炎の結晶',   r: 3 },
    icecrystal:{ name: '氷の結晶',    r: 3 },
    thundercrystal:{ name: '雷の結晶', r: 3 },
    scroll: { name: '魔法の巻物',     r: 3 },
    star:   { name: '星のかけら',     r: 3 },
    fairybottle:{ name: '妖精のビン', r: 3 },
    sapphire:{ name: 'サファイア',    r: 2 },
    emerald:{ name: 'エメラルド',     r: 2 },
    topaz:  { name: 'トパーズ',       r: 2 },
    pearl:  { name: '真珠',           r: 2 },
    ofuda:  { name: 'お札',           r: 2 },
    woodrune:{ name: '木のルーン',    r: 2 },
    quill:  { name: '羽根ペン',       r: 2 },
    torch:  { name: '松明',           r: 2 },
    canteen:{ name: '水筒',           r: 2 },
    ironore:{ name: '鉄鉱石',         r: 2 },
    oridecon:{ name: 'オリデオコン',  r: 3 },
    mithril:{ name: 'ミスリル鉱石',   r: 4 },
    wing:   { name: 'ウィング',       r: 1 },
    magicberry:{ name: 'マジックベリー', r: 1 },
    candle: { name: 'ろうそく',       r: 1 },
    fishingrod:{ name: '釣り竿',      r: 1 },
    whetstone:{ name: '砥石',         r: 1 },
    glowmoss:{ name: '光り苔',        r: 1 },
    bait:   { name: '釣り餌',         r: 1 },
    acorn:  { name: 'どんぐり',       r: 1 },
    shell:  { name: '貝殻',           r: 1 },
    marble: { name: 'ビー玉',         r: 1 },
    bell:   { name: '鈴',             r: 1 },
    copper: { name: '銅貨',           r: 1 },
    ribbon: { name: 'リボン',         r: 1 },
    candy:  { name: 'あめ玉',         r: 1 },
    wizhat: { name: 'ウィザードハット', r: 4 },
    seed:   { name: '花の種',         r: 1 },
    ring:   { name: '魔法の指輪',     r: 3 },
    dagger: { name: '短剣',           r: 2 },
    thief:  { name: '盗賊の短剣',     r: 3 },
    iron:   { name: '鉄の剣',         r: 3 },
    frost:  { name: '氷の剣',         r: 4 },
    spear:  { name: '鉄の槍',         r: 2 },
    gungnir:{ name: 'グングニル',     r: 5 },
    staff:  { name: '魔法の杖',       r: 4 },
    fsword: { name: '炎の大剣',       r: 5 },
    blacksword:{ name: '黒騎士の剣',  r: 5 },
    goldgun:{ name: '黄金銃',         r: 5 },
    map:    { name: '古地図',         r: 2 },
    compass:{ name: 'コンパス',       r: 2 },
    lantern:{ name: 'ランタン',       r: 3 },
    key:    { name: '宝の鍵',         r: 3 },
    buckler:{ name: 'バックラー',     r: 1 },
    rshield:{ name: '木の丸盾',       r: 2 },
    shield: { name: '守りの盾',       r: 3 },
    kshield:{ name: 'カイトシールド', r: 3 },
    gshield:{ name: '黄金の盾',       r: 4 },
    dshield:{ name: 'ドラゴンシールド', r: 5 },
    crown:  { name: '王者の冠',       r: 4 },
    sword:  { name: 'エクスカリバー', r: 5 }
  };
  // 一回の宝箱で「名前を出す主役」 = その中で最もレアなアイテム
  // レアリティ別の主役プール (= coin/gem/big は「基本の宝」なので主役からは除外)
  var POOLS = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  Object.keys(ITEM_INFO).forEach(function (k) {
    if (k === 'coin' || k === 'gem' || k === 'big') return;
    if (POOLS[ITEM_INFO[k].r]) POOLS[ITEM_INFO[k].r].push(k);
  });
  // Tier → 主役のレアリティ帯
  var TIER_HR = { blue: 1, teal: 1, green: 2, yellow: 3, orange: 3, magenta: 4, red: 5 };
  function pickHeadline(tier) {
    var pool = POOLS[TIER_HR[tier.key] || tier.stars] || [];
    return pool[(Math.random() * pool.length) | 0] || 'gem';
  }

  // ===== モジュールレベル状態 (同時 1 件想定。 要素参照は play() 冒頭で毎回セットし直す) =====
  var scene, chest, flash, beam, lootEl, rarityEl, itemEl, msg, msgLine, msgAmt, dim, legend, showcase;
  var timers = [];
  function later(fn, t) { timers.push(setTimeout(fn, t)); }
  function clearAll() { timers.forEach(clearTimeout); timers = []; if (lootEl) lootEl.innerHTML = ''; }

  // チェスト口 (loot 発生原点) — scene 座標
  var MOUTH_X = 260, MOUTH_Y = 240;

  function spawnLoot(tier, featured) {
    var items = [];
    // 金貨 + (宝石) + (大宝石) = 基本の宝。 主役は featured 指定時のみ pile に出す
    var coinCount = (TIER_HR[tier.key] === 1) ? 0 : tier.coins;   // r1 (最低帯) はコインなし
    for (var i = 0; i < coinCount; i++) items.push({ type: 'coin' });
    for (var g = 0; g < tier.gems; g++) items.push({ type: 'gem', color: GEM_COLORS[g % GEM_COLORS.length] });
    for (var b = 0; b < tier.big; b++) items.push({ type: 'big', color: GEM_COLORS[(b + 2) % GEM_COLORS.length] });
    if (featured) items.push({ type: featured, color: GEM_COLORS[3], featured: true });
    // 最高レア (rainbow=true) の主役は spawnLegendary (剣のホールドアロフト) に分離

    items.forEach(function (it, idx) {
      var el = document.createElement('div');
      el.className = 'loot-item';
      if (it.type === 'coin') el.innerHTML = pix(COIN, coinPal, 5);
      else if (it.type === 'potion') el.innerHTML = pix(POTION, potionPal, 8);
      else if (it.type === 'mana') el.innerHTML = pix(MANA, manaPal, 8);
      else if (it.type === 'antidote') el.innerHTML = pix(ANTIDOTE, antidotePal, 8);
      else if (it.type === 'elixir') el.innerHTML = pix(ELIXIR, elixirPal, 7);
      else if (it.type === 'herb') el.innerHTML = pix(HERB, herbPal, 8);
      else if (it.type === 'mushroom') el.innerHTML = pix(MUSHROOM, mushroomPal, 8);
      else if (it.type === 'flower') el.innerHTML = pix(FLOWER, flowerPal, 7);
      else if (it.type === 'clover') el.innerHTML = pix(CLOVER, cloverPal, 8);
      else if (it.type === 'sacred') el.innerHTML = pix(SACRED, sacredPal, 7);
      else if (it.type === 'necklace') el.innerHTML = pix(NECKLACE, necklacePal, 7);
      else if (it.type === 'tiara') el.innerHTML = pix(TIARA, tiaraPal, 7);
      else if (it.type === 'chalice') el.innerHTML = pix(CHALICE, chalicePal, 7);
      else if (it.type === 'idol') el.innerHTML = pix(IDOL, idolPal, 7);
      else if (it.type === 'hourglass') el.innerHTML = pix(HOURGLASS, hourglassPal, 8);
      else if (it.type === 'vase') el.innerHTML = pix(VASE, vasePal, 7);
      else if (it.type === 'brooch') el.innerHTML = pix(BROOCH, broochPal, 7);
      else if (it.type === 'mirror') el.innerHTML = pix(MIRROR, mirrorPal, 7);
      else if (it.type === 'ring') el.innerHTML = ringSvg(it.color || GEM_COLORS[3], 8);
      else if (it.type === 'gem') el.innerHTML = gemSvg(it.color, 5);
      else if (it.type === 'big') el.innerHTML = gemSvg(it.color, 8);
      else if (it.type === 'crown') el.innerHTML = pix(CROWN, crownPal, 7);
      else if (it.type === 'sword') el.innerHTML = pix(EXCALIBUR, excaliburPal, 6);
      else if (it.type === 'dagger') el.innerHTML = pix(DAGGER, swordPal, 7);
      else if (it.type === 'thief') el.innerHTML = pix(THIEF, thiefPal, 7);
      else if (it.type === 'iron') el.innerHTML = pix(IRON, ironPal, 6);
      else if (it.type === 'frost') el.innerHTML = pix(FROST, frostPal, 6);
      else if (it.type === 'spear') el.innerHTML = pix(SPEAR, swordPal, 6);
      else if (it.type === 'gungnir') el.innerHTML = pix(GUNGNIR, gungnirPal, 6);
      else if (it.type === 'staff') el.innerHTML = pix(STAFF, staffPal, 7);
      else if (it.type === 'fsword') el.innerHTML = pix(FSWORD, fswordPal, 6);
      else if (it.type === 'blacksword') el.innerHTML = pix(BLACKSWORD, blackswordPal, 6);
      else if (it.type === 'goldgun') el.innerHTML = pix(GOLDGUN, goldgunPal, 6);
      else if (it.type === 'key') el.innerHTML = pix(KEY, keyPal, 7);
      else if (it.type === 'lantern') el.innerHTML = pix(LANTERN, lanternPal, 7);
      else if (it.type === 'map') el.innerHTML = pix(MAP, mapPal, 7);
      else if (it.type === 'compass') el.innerHTML = pix(COMPASS, compassPal, 7);
      else if (it.type === 'shield') el.innerHTML = pix(SHIELD, shieldPal, 7);
      else if (it.type === 'rshield') el.innerHTML = pix(RSHIELD, rshieldPal, 7);
      else if (it.type === 'gshield') el.innerHTML = pix(GSHIELD, gshieldPal, 7);
      else if (it.type === 'buckler') el.innerHTML = pix(BUCKLER, bucklerPal, 7);
      else if (it.type === 'kshield') el.innerHTML = pix(KSHIELD, kshieldPal, 7);
      else if (it.type === 'dshield') el.innerHTML = pix(DSHIELD, dshieldPal, 7);
      else if (it.type === 'worldleaf') el.innerHTML = pix(WORLDLEAF, worldleafPal, 7);
      else if (it.type === 'jug') el.innerHTML = pix(JUG, jugPal, 7);
      else if (it.type === 'smelling') el.innerHTML = pix(SMELLING, smellingPal, 8);
      else if (it.type === 'rope') el.innerHTML = pix(ROPE, ropePal, 7);
      else if (it.type === 'shuriken') el.innerHTML = pix(SHURIKEN, shurikenPal, 7);
      else if (it.type === 'throwknife') el.innerHTML = pix(THROWKNIFE, throwknifePal, 7);
      else if (it.type === 'healring') el.innerHTML = pix(HEALRING, healringPal, 7);
      else if (it.type === 'paring') el.innerHTML = pix(PARING, paringPal, 7);
      else if (it.type === 'claymore') el.innerHTML = pix(CLAYMORE, swordPal, 6);
      else if (it.type === 'longsword') el.innerHTML = pix(LONGSWORD, swordPal, 6);
      else if (it.type === 'broadsword') el.innerHTML = pix(BROADSWORD, swordPal, 7);
      else if (it.type === 'rapier') el.innerHTML = pix(RAPIER, rapierPal, 7);
      else if (it.type === 'spear2') el.innerHTML = pix(SPEAR2, spear2Pal, 7);
      else if (it.type === 'mace') el.innerHTML = pix(MACE, macePal, 7);
      else if (it.type === 'egg') el.innerHTML = pix(EGG, eggPal, 7);
      else if (it.type === 'wizstaff') el.innerHTML = pix(WIZSTAFF, wizstaffPal, 7);
      else if (it.type === 'rubyring') el.innerHTML = pix(RUBYRING, rubyringPal, 7);
      else if (it.type === 'sleipnir') el.innerHTML = pix(SLEIPNIR, sleipnirPal, 7);
      else if (it.type === 'hglove') el.innerHTML = pix(GLOVE, glovePal, 7);
      else if (it.type === 'dragonmail') el.innerHTML = pix(DRAGONMAIL, dragonmailPal, 7);
      else if (it.type === 'bikini') el.innerHTML = pix(BIKINI, bikiniPal, 7);
      else if (it.type === 'kigurumi') el.innerHTML = pix(KIGURUMI, kigurumiPal, 7);
      else if (it.type === 'grimoire') el.innerHTML = pix(GRIMOIRE, grimoirePal, 7);
      else if (it.type === 'crystalball') el.innerHTML = pix(CRYSTALBALL, crystalballPal, 7);
      else if (it.type === 'rune') el.innerHTML = pix(RUNE, runePal, 7);
      else if (it.type === 'firecrystal') el.innerHTML = pix(FIRECRYSTAL, firecrystalPal, 7);
      else if (it.type === 'icecrystal') el.innerHTML = pix(ICECRYSTAL, icecrystalPal, 7);
      else if (it.type === 'thundercrystal') el.innerHTML = pix(THUNDERCRYSTAL, thundercrystalPal, 7);
      else if (it.type === 'scroll') el.innerHTML = pix(SCROLL, scrollPal, 7);
      else if (it.type === 'star') el.innerHTML = pix(STAR, starPal, 7);
      else if (it.type === 'fairybottle') el.innerHTML = pix(FAIRYBOTTLE, fairybottlePal, 7);
      else if (it.type === 'sapphire') el.innerHTML = pix(SAPPHIRE, sapphirePal, 8);
      else if (it.type === 'emerald') el.innerHTML = pix(EMERALD, emeraldPal, 7);
      else if (it.type === 'topaz') el.innerHTML = pix(TOPAZ, topazPal, 8);
      else if (it.type === 'pearl') el.innerHTML = pix(PEARL, pearlPal, 8);
      else if (it.type === 'ofuda') el.innerHTML = pix(OFUDA, ofudaPal, 7);
      else if (it.type === 'woodrune') el.innerHTML = pix(WOODRUNE, woodrunePal, 8);
      else if (it.type === 'quill') el.innerHTML = pix(QUILL, quillPal, 7);
      else if (it.type === 'torch') el.innerHTML = pix(TORCH, torchPal, 7);
      else if (it.type === 'canteen') el.innerHTML = pix(CANTEEN, canteenPal, 7);
      else if (it.type === 'ironore') el.innerHTML = pix(IRONORE, ironorePal, 8);
      else if (it.type === 'oridecon') el.innerHTML = pix(ORIDECON, oridecornPal, 8);
      else if (it.type === 'mithril') el.innerHTML = pix(MITHRIL, mithrilPal, 8);
      else if (it.type === 'wing') el.innerHTML = pix(WING, wingPal, 7);
      else if (it.type === 'magicberry') el.innerHTML = pix(MAGICBERRY, magicberryPal, 7);
      else if (it.type === 'candle') el.innerHTML = pix(CANDLE, candlePal, 7);
      else if (it.type === 'fishingrod') el.innerHTML = pix(FISHINGROD, fishingrodPal, 7);
      else if (it.type === 'whetstone') el.innerHTML = pix(WHETSTONE, whetstonePal, 7);
      else if (it.type === 'glowmoss') el.innerHTML = pix(GLOWMOSS, glowmossPal, 7);
      else if (it.type === 'bait') el.innerHTML = pix(BAIT, baitPal, 7);
      else if (it.type === 'acorn') el.innerHTML = pix(ACORN, acornPal, 8);
      else if (it.type === 'shell') el.innerHTML = pix(SHELL, shellPal, 7);
      else if (it.type === 'marble') el.innerHTML = pix(MARBLE, marblePal, 8);
      else if (it.type === 'bell') el.innerHTML = pix(BELL, bellPal, 7);
      else if (it.type === 'copper') el.innerHTML = pix(COPPER, copperPal, 8);
      else if (it.type === 'ribbon') el.innerHTML = pix(RIBBON, ribbonPal, 7);
      else if (it.type === 'candy') el.innerHTML = pix(CANDY, candyPal, 7);
      else if (it.type === 'wizhat') el.innerHTML = pix(WIZHAT, wizhatPal, 7);
      else if (it.type === 'seed') el.innerHTML = pix(SEED, seedPal, 7);
      else if (it.type === 'rainbow') { el.innerHTML = gemSvg('#ff5a5a', 9); el.dataset.rainbow = '1'; }
      lootEl.appendChild(el);

      // 「溢れ出る」 軌道: 口元から少しだけ持ち上がり → 前へこぼれて積もる (爆発させない)
      var special = !!it.featured || (it.type !== 'coin' && it.type !== 'gem');
      var brim = !special && Math.random() < 0.35;     // 一部は口で溢れて留まる
      var apexX = MOUTH_X + (Math.random() * 160 - 80);
      var apexY = MOUTH_Y - (8 + Math.random() * 34);  // ほんの少し上へ
      var settleX, settleY;
      if (special) { settleX = MOUTH_X + (Math.random() * 70 - 35); settleY = MOUTH_Y + 34 + Math.random() * 26; }       // 特別は手前中央で目立つ
      else if (brim) { settleX = MOUTH_X + (Math.random() * 130 - 65); settleY = MOUTH_Y + (Math.random() * 26 - 6); }    // 口で溢れる
      else { settleX = MOUTH_X + (Math.random() * 190 - 95); settleY = MOUTH_Y + 50 + Math.random() * 100; }              // 前にこぼれて山
      var spin = (Math.random() * 420 - 210);
      var rest = (it.type === 'coin') ? (Math.random() * 36 - 18) : 0;   // コインは寝た角度、 宝石/特別は正立
      var delay = Math.random() * 650 + (it.type === 'coin' ? 0 : 120);  // 長めにばらけ = 「溢れ続ける」

      el.style.left = MOUTH_X + 'px'; el.style.top = MOUTH_Y + 'px';
      el.style.zIndex = (it.type === 'coin') ? 5 : 6;
      el.animate([
        // 0%: 箱の中 (scale0 / opacity0) — fill:both で delay 中も隠れている
        { transform: 'translate(-50%,-50%) translate(0,8px) rotate(0deg) scale(0.2)', opacity: 0, offset: 0 },
        // 口元からニュッと顔を出す
        { transform: 'translate(-50%,-50%) translate(0,-4px) rotate(0deg) scale(0.95)', opacity: 1, offset: 0.12 },
        { transform: 'translate(-50%,-50%) translate(' + (apexX - MOUTH_X) + 'px,' + (apexY - MOUTH_Y) + 'px) rotate(' + (spin * 0.5) + 'deg) scale(1)', opacity: 1, offset: 0.45 },
        { transform: 'translate(-50%,-50%) translate(' + (settleX - MOUTH_X) + 'px,' + (settleY - MOUTH_Y) + 'px) rotate(' + rest + 'deg) scale(1)', opacity: 1, offset: 0.86 },
        { transform: 'translate(-50%,-50%) translate(' + (settleX - MOUTH_X) + 'px,' + (settleY - MOUTH_Y - 7) + 'px) rotate(' + rest + 'deg) scale(1)', opacity: 1, offset: 0.93 },
        { transform: 'translate(-50%,-50%) translate(' + (settleX - MOUTH_X) + 'px,' + (settleY - MOUTH_Y) + 'px) rotate(' + rest + 'deg) scale(1)', opacity: 1, offset: 1 }
      ], { duration: 1100 + Math.random() * 400, delay: delay, easing: 'cubic-bezier(0.2,0.55,0.4,1)', fill: 'both' });
    });

    // キラ
    for (var s = 0; s < 8 + tier.gems; s++) {
      var sp = document.createElement('div');
      sp.className = 'spark go';
      sp.style.left = (MOUTH_X + Math.random() * 200 - 100) + 'px';
      sp.style.top = (MOUTH_Y + Math.random() * 120 - 90) + 'px';
      sp.style.animationDelay = (Math.random() * 1.2) + 's';
      sp.style.background = (s % 4 === 0) ? tier.color : '#fff';
      lootEl.appendChild(sp);
    }
  }

  function typeOn(el, text, cb) {
    el.innerHTML = ''; var i = 0;
    (function step() {
      if (i > text.length) { if (cb) cb(); return; }
      var safe = document.createElement('div'); safe.textContent = text.slice(0, i);
      el.innerHTML = safe.innerHTML.replace(/\n/g, '<br>') + (i < text.length ? '<span style="opacity:.35">▮</span>' : '');
      i++;
      later(step, 48);
    })();
  }

  // アイテム名を常時表示。 見せ方は固有レアリティ r (1..5) で変化
  function showItemName(type, r) {
    var info = ITEM_INFO[type] || { name: type, r: 1 };
    var lvl = r || info.r;
    var label = info.name;
    if (lvl >= 5) label = '⚔ ' + info.name + ' を手に入れた！';
    else if (lvl === 4) label = '✦ ' + info.name + ' ✦';
    itemEl.className = 'itemname r' + lvl;
    itemEl.textContent = label;
    void itemEl.offsetWidth;
    itemEl.classList.add('show');
  }

  // 中レアの見せ場: 目玉アイテムが宙にポップ + 回転 + 後光 + キラリング → 山の上に鎮座
  function spawnShowcase(tier, hero) {
    showcase.innerHTML = '';
    var SHOW_Y = 200, REST_Y = 262;
    var glow = document.createElement('div'); glow.className = 'sc-glow';
    glow.style.left = MOUTH_X + 'px'; glow.style.top = SHOW_Y + 'px';
    showcase.appendChild(glow);
    later(function () { glow.classList.add('show'); }, 30);

    var h = document.createElement('div'); h.className = 'loot-item'; h.style.zIndex = '9';
    h.style.left = MOUTH_X + 'px'; h.style.top = SHOW_Y + 'px';
    h.innerHTML = itemSprite(hero.type, hero.color || GEM_COLORS[3], 7);
    showcase.appendChild(h);
    h.animate([
      { transform: 'translate(-50%,-50%) translate(0,40px) rotate(0deg) scale(0.3)', opacity: 0, offset: 0 },
      { transform: 'translate(-50%,-50%) translate(0,0) rotate(360deg) scale(1.3)', opacity: 1, offset: 0.32 },
      { transform: 'translate(-50%,-50%) translate(0,0) rotate(360deg) scale(1.3)', opacity: 1, offset: 0.62 },
      { transform: 'translate(-50%,-50%) translate(0,' + (REST_Y - SHOW_Y) + 'px) rotate(360deg) scale(1)', opacity: 1, offset: 1 }
    ], { duration: 2000, easing: 'cubic-bezier(0.3,0.7,0.4,1)', fill: 'both' });

    later(function () {        // キラのリング (1 回)
      for (var i = 0; i < 9; i++) {
        var s = document.createElement('div'); s.className = 'spark';
        s.style.left = MOUTH_X + 'px'; s.style.top = SHOW_Y + 'px'; s.style.opacity = '1';
        s.style.width = '8px'; s.style.height = '8px'; s.style.zIndex = '9';
        s.style.background = (i % 2 === 0) ? tier.color : '#fff';
        showcase.appendChild(s);
        var ang = (i / 9) * 360; var dist = 48 + Math.random() * 22;
        var dx = Math.cos(ang * Math.PI / 180) * dist, dy = Math.sin(ang * Math.PI / 180) * dist;
        s.animate([
          { transform: 'translate(0,0) scale(1.2)', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.2)', opacity: 0 }
        ], { duration: 600, easing: 'ease-out', fill: 'forwards' });
      }
    }, 350);

    later(function () { glow.classList.remove('show'); glow.style.opacity = '0'; }, 1500);
  }

  // 最高レア: 伝説の品を宙に掲げるホールドアロフト
  function spawnLegendary(type) {
    var info = ITEM_INFO[type] || ITEM_INFO.sword;
    dim.classList.add('show');
    legend.innerHTML = '<div class="aura" style="left:' + MOUTH_X + 'px; top:154px;"></div>'
      + '<div class="legend-hero" id="lhero"></div>'
      + '<div class="legend-name" id="lname">⚔ ' + info.name + ' を手に入れた！</div>';
    var lhero = legend.querySelector('#lhero');
    var lname = legend.querySelector('#lname');
    lhero.innerHTML = itemSprite(type, GEM_COLORS[0], 7);
    lhero.style.left = MOUTH_X + 'px'; lhero.style.top = '154px';
    // 箱の中 (口元) からゆっくり昇って静止 (掲げる)
    lhero.animate([
      { transform: 'translate(-50%,-50%) translate(0,86px) rotate(-16deg) scale(0.35)', opacity: 0, offset: 0 },
      { transform: 'translate(-50%,-50%) translate(0,80px) rotate(-14deg) scale(0.6)', opacity: 1, offset: 0.12 },
      { transform: 'translate(-50%,-50%) translate(0,0) rotate(0deg) scale(1)', opacity: 1, offset: 0.82 },
      { transform: 'translate(-50%,-50%) translate(0,-7px) rotate(0deg) scale(1.05)', opacity: 1, offset: 0.9 },
      { transform: 'translate(-50%,-50%) translate(0,0) rotate(0deg) scale(1)', opacity: 1, offset: 1 }
    ], { duration: 1300, easing: 'cubic-bezier(0.18,0.8,0.3,1)', fill: 'both' });
    // きらめき: 剣の各所で 4 点星がポンポン明滅 (増量・大きめ・高速)
    later(function () {
      var pts = [[0, -54], [-13, -18], [15, 4], [0, 40], [-20, 20], [20, -30], [-24, -42], [26, -10], [-9, 30], [12, 30]];
      pts.forEach(function (p, i) {
        var g = document.createElement('div'); g.className = 'glint go';
        g.style.left = (MOUTH_X + p[0]) + 'px';
        g.style.top = (154 + p[1]) + 'px';
        var sz = (i % 3 === 0) ? 34 : (i % 3 === 1 ? 22 : 16);
        g.style.width = sz + 'px'; g.style.height = sz + 'px';
        g.style.animationDelay = (i * 0.16) + 's';
        legend.appendChild(g);
      });
    }, 500);
    // 掲げ位置に決まる瞬間: 白い閃光 + キラ爆ぜ (コンパクトな半径)
    later(function () {
      var f = document.createElement('div');
      f.style.cssText = 'position:absolute;left:' + MOUTH_X + 'px;top:154px;'
        + 'transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;z-index:9;pointer-events:none;'
        + 'background:radial-gradient(circle,#fff 0%,#fff2b0 42%,transparent 72%);';
      legend.appendChild(f);
      f.animate([
        { width: '10px', height: '10px', opacity: 0, offset: 0 },
        { width: '150px', height: '150px', opacity: 0.95, offset: 0.3 },
        { width: '210px', height: '210px', opacity: 0, offset: 1 }
      ], { duration: 480, easing: 'ease-out', fill: 'forwards' });
      for (var i = 0; i < 14; i++) {
        var s = document.createElement('div'); s.className = 'spark';
        s.style.left = MOUTH_X + 'px'; s.style.top = '154px'; s.style.opacity = '1';
        s.style.width = '9px'; s.style.height = '9px'; s.style.zIndex = '11';
        s.style.background = (i % 3 === 0) ? '#ffe24a' : '#fff';
        legend.appendChild(s);
        var ang = (i / 14) * 360 + Math.random() * 20;
        var dist = 65 + Math.random() * 40;
        var dx = Math.cos(ang * Math.PI / 180) * dist, dy = Math.sin(ang * Math.PI / 180) * dist;
        s.animate([
          { transform: 'translate(0,0) scale(1.3) rotate(0deg)', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.2) rotate(200deg)', opacity: 0 }
        ], { duration: 650 + Math.random() * 250, easing: 'ease-out', fill: 'forwards' });
      }
    }, 1100);
    later(function () { lname.classList.add('show'); }, 1300);
  }

  function spawnDust() {
    for (var i = 0; i < 7; i++) {
      var d = document.createElement('div');
      d.className = 'dust';
      d.style.left = (MOUTH_X + (Math.random() * 130 - 65)) + 'px';
      d.style.top = (MOUTH_Y + 86) + 'px';
      lootEl.appendChild(d);
      var dx = (Math.random() * 70 - 35), dy = -(8 + Math.random() * 22);
      d.animate([
        { opacity: 0.6, transform: 'translate(-50%,-50%) scale(0.4)' },
        { opacity: 0, transform: 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(2.6)' }
      ], { duration: 520, easing: 'ease-out', fill: 'forwards' });
    }
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // 金額 → tier index を解決
  function tierIndexFromAmount(amount) {
    var a = Number(amount) || 0;
    if (a >= 10000) return 6;  // red
    if (a >= 5000) return 5;   // magenta
    if (a >= 2000) return 4;   // orange
    if (a >= 1000) return 3;   // yellow
    if (a >= 500) return 2;    // green
    if (a >= 200) return 1;    // teal
    return 0;                  // blue
  }

  // ===== 公開 API: play(hostEl, opts, onDone) =====
  function play(hostEl, opts, onDone) {
    if (!hostEl) return;
    opts = opts || {};
    clearAll();
    ensureFonts();

    // Shadow DOM を attach (既存があれば再利用) し、 シーン DOM を構築
    var root = hostEl.shadowRoot;
    if (!root) root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + STYLE + '</style>' + SCENE_HTML;

    // 要素参照は毎回 shadowRoot から取り直す
    scene = root.getElementById('scene');
    chest = root.getElementById('chest');
    flash = root.getElementById('flash');
    beam = root.getElementById('beam');
    lootEl = root.getElementById('loot');
    dim = root.getElementById('dim');
    showcase = root.getElementById('showcase');
    legend = root.getElementById('legend');
    rarityEl = root.getElementById('rarity');
    itemEl = root.getElementById('itemname');
    msg = root.getElementById('msg');
    msgLine = root.getElementById('msgLine');
    msgAmt = root.getElementById('msgAmt');

    chest.innerHTML = '<div class="chest-inner">' + chestBaseSvg() + chestLidSvg() + '</div>';

    var tier = TIERS[tierIndexFromAmount(opts.amount)];
    var name = opts.name || 'ゲスト';
    var amtDisplay = opts.amountDisplay || tier.amt;

    scene.style.transition = ''; scene.style.opacity = '1';
    chest.className = 'chest-wrap';
    flash.className = 'flash';
    beam.getAnimations().forEach(function (a) { a.cancel(); });   // fill:forwards の残留を解除 (= 後光の残骸防止)
    beam.className = 'beam'; beam.style.opacity = '0';
    rarityEl.className = 'rarity'; rarityEl.innerHTML = '';
    itemEl.className = 'itemname'; itemEl.innerHTML = '';
    msg.className = 'msgwin'; msgLine.textContent = ''; msgAmt.innerHTML = '';
    dim.classList.remove('show'); legend.innerHTML = ''; showcase.innerHTML = '';
    lootEl.style.opacity = '1';
    void chest.offsetWidth;

    var legendary = (tier.key === 'red');               // 最高レア = 別格の流れ
    var special = pickHeadline(tier);                   // この箱の主役 = レア帯プールからランダム
    var midShow = !legendary && tier.stars >= 3;        // 主役を showcase で持ち上げて見せる

    // (1) 上空から落下 → バウンド着地 (土煙)
    chest.classList.add('show');
    later(spawnDust, 510);
    // (2) 中から押されてガタガタ (溜め)
    later(function () { chest.classList.add('shake'); }, 1050);
    // (3) パカッ! → 宝が口元から溢れ出る (宝箱は開いたまま残す)
    later(function () {
      chest.classList.remove('shake');
      chest.classList.add('lit');
      flash.classList.add('go');
      beam.style.opacity = '1';
      beam.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'forwards' });
      spawnLoot(tier, (!midShow && !legendary) ? special : null);
    }, 1750);
    // (3.5a) 中レア: 主役アイテムの見せ場
    if (midShow) later(function () { spawnShowcase(tier, { type: special, color: GEM_COLORS[3] }); }, 2200);
    // (3.5b) 最高レアのみ: 暗転 → 選ばれた r5 を宙に掲げる
    if (legendary) later(function () { spawnLegendary(special); }, 2300);
    // (4) レアリティ表示 (全 Tier ★ランク)
    later(function () {
      var on = ''; for (var i = 0; i < tier.stars; i++) on += '★';
      var off = ''; for (var j = 0; j < 5 - tier.stars; j++) off += '☆';
      // 最高レアは暗転(黒背景)の上に出るため、純赤(#ff3b3b)だと輝度が低く沈む。
      // レアリティ表示だけ高輝度の明るい赤に上げて視認性を確保する (loot 等は tier.color のまま)。
      rarityEl.style.color = legendary ? '#ff7a66' : tier.color;
      rarityEl.innerHTML = '<div class="stars">' + on + '<span class="off">' + off + '</span></div>'
        + '<div class="rank">' + tier.rank + '</div>';
      rarityEl.style.top = legendary ? '-18px' : '34px';   // R1-R4: 上の空きへ寄せてアイテム名(top:160)との被りを防ぐ / 最高レアは掲げる剣の更に上へ
      rarityEl.classList.add('show');
    }, legendary ? 3700 : 2500);
    // (4.5) アイテム名 (常時表示・固有レアリティで見せ方変化)。 最高レアは spawnLegendary のバナーが担当
    if (!legendary) {
      later(function () { showItemName(special); }, 2750);
    }
    // (5) お礼メッセージ (名前タイプオン)
    later(function () {
      msg.classList.add('show');
      typeOn(msgLine, name + 'さん、おうえん\nありがとう！', function () {
        msgLine.innerHTML = '<span class="nm">' + esc(name) + '</span>さん、おうえん<br>ありがとう！';
      });
      msgAmt.innerHTML = esc(amtDisplay) + '<span class="tierlabel">SUPER THANKS</span>';
    }, legendary ? 4100 : 2950);

    // (6) 宝箱 + 宝 + レアリティ + メッセージ が揃って完了 → 一拍おいて全部まとめてフェードアウト
    var fadeAt = legendary ? 9800 : 7800;
    later(function () {
      scene.style.transition = 'opacity 0.7s'; scene.style.opacity = '0';
    }, fadeAt);
    // フェードアウト完了 (0.7s) の ~800ms 後に onDone
    later(function () { if (onDone) onDone(); }, fadeAt + 800);
  }

  return { play: play, VERSION: '1.0.0' };
})();

// OBS ブラウザソース (window グローバル) でも参照できるよう公開
if (typeof window !== 'undefined') {
  window.TreasureEngine = TreasureEngine;
}
