/**
 * 芽吹きエフェクト
 * コメント・スパチャ・メンバーシップを吹き出しで表示
 * 組み込みテンプレートを使用し、ユーザーがHTML素材を追加すると上書き可能
 * 重複防止: 既存吹き出しの占有範囲を除外した空き領域からランダムに配置
 */
var Sprout = (function () {
  var container;
  var templateCache = {};

  // === 重複防止: 占有領域の管理 ===
  var MIN_GAP = 20;          // 吹き出し間の最小間隔(px)
  var activeRegions = [];    // { left, right, id } 使用中の横範囲
  var queue = [];
  var queueTimer = null;
  var spawnLock = false;      // 同時spawn防止

  // === テロップバー (ticker) 単独表示: 常に画面に 1 本のみ、 表示中は queue で順番待ち ===
  var tickerBusy = false;
  var tickerQueue = [];
  var TICKER_MAX_QUEUE = 1000;

  function removeRegion(id) {
    for (var i = activeRegions.length - 1; i >= 0; i--) {
      if (activeRegions[i].id === id) { activeRegions.splice(i, 1); break; }
    }
    processQueue();
  }

  // 空き領域を算出し、指定幅の吹き出しが収まるものだけ抽出
  // originX: 表示領域の中心(0-100%), displayWidth: 表示領域の幅(0-100%)
  // centerExclusion: 画面中央の表示禁止幅(0-100%、 人物立ち絵の回避用)
  function findPlaceableRanges(bubbleWidth, originX, displayWidth, centerExclusion) {
    var screenW = window.innerWidth;
    var half = bubbleWidth / 2;

    // 表示領域の制限
    var cx = (originX != null ? originX : 50);
    var dw = (displayWidth != null ? displayWidth : 80);
    var rangeLeft = screenW * (cx - dw / 2) / 100;
    var rangeRight = screenW * (cx + dw / 2) / 100;

    var areaLeft = Math.max(half, rangeLeft);
    var areaRight = Math.min(screenW - half, rangeRight);
    if (areaLeft >= areaRight) return [];

    // 占有領域 (= 既存吹き出し) + 中央禁止帯 (= 人物回避) を合わせて除外対象にする
    var occupied = activeRegions.slice();
    var ce = centerExclusion || 0;
    if (ce > 0) {
      var ceHalf = screenW * ce / 100 / 2;
      occupied.push({ left: screenW / 2 - ceHalf, right: screenW / 2 + ceHalf, id: '__center__' });
    }
    var sorted = occupied.sort(function (a, b) { return a.left - b.left; });

    // 占有領域の間にできる空き区間を列挙
    var gaps = [];
    var cursor = areaLeft;
    for (var i = 0; i < sorted.length; i++) {
      var occupiedLeft = sorted[i].left - MIN_GAP;
      var occupiedRight = sorted[i].right + MIN_GAP;
      if (occupiedLeft > cursor) {
        gaps.push({ from: cursor, to: occupiedLeft });
      }
      if (occupiedRight > cursor) cursor = occupiedRight;
    }
    if (cursor < areaRight) {
      gaps.push({ from: cursor, to: areaRight });
    }

    // 吹き出しが収まる幅を持つ空き領域だけをピックアップ
    var placeable = [];
    for (var j = 0; j < gaps.length; j++) {
      if (gaps[j].to - gaps[j].from >= bubbleWidth) {
        placeable.push(gaps[j]);
      }
    }
    return placeable;
  }

  // 表示可能な空き領域からランダムに1つ選び、その中でランダムにX座標を決める
  function pickRandomX(bubbleWidth, originX, displayWidth, centerExclusion) {
    var placeable = findPlaceableRanges(bubbleWidth, originX, displayWidth, centerExclusion);
    if (placeable.length === 0) return -1;

    var chosen = placeable[Math.floor(Math.random() * placeable.length)];

    var half = bubbleWidth / 2;
    var minX = chosen.from + half;
    var maxX = chosen.to - half;
    return minX + Math.random() * (maxX - minX);
  }

  function processQueue() {
    if (queue.length === 0) return;
    if (overlayPaused) return;
    // キューの先頭を実行（spawn内で空きなしなら再キューされる）
    var job = queue.shift();
    job();
    if (queue.length > 0 && !queueTimer) {
      queueTimer = setTimeout(function () {
        queueTimer = null;
        processQueue();
      }, 200);
    }
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // HTMLからテキストとimg要素のみを残すサニタイズ
  function sanitizeCommentHtml(html) {
    if (!html) return '';
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var result = document.createElement('div');
    function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3) {
          // テキストノード
          result.appendChild(document.createTextNode(child.textContent));
        } else if (child.nodeType === 1 && child.tagName === 'IMG') {
          // img要素: src, alt, style(幅高さ)のみ残す
          var img = document.createElement('img');
          img.src = child.src;
          if (child.alt) img.alt = child.alt;
          img.style.height = '1.2em';
          img.style.verticalAlign = 'middle';
          img.style.margin = '0 1px';
          result.appendChild(img);
        } else if (child.nodeType === 1) {
          // その他の要素は中身だけ再帰
          walk(child);
        }
      }
    }
    walk(temp);
    return result.innerHTML;
  }

  function buildValues(ctx, design, normalColor, bgOpacity, wandSymbols) {
    // 全 design は専用 build 関数で全種別 (通常/スパチャ/ステッカー/メンバー/ギフト) を統合表示する
    if (design === 'ticker') return buildTickerValues(ctx, normalColor);
    if (design === 'wand') return buildWandValues(ctx, bgOpacity, wandSymbols);
    if (design === 'gacha') return buildGachaValues(ctx);
    if (design === 'holo') return buildHoloValues(ctx);
    return buildBudValues(ctx); // bud = デフォルト
  }

  function replacePlaceholders(html, values) {
    return html.replace(/\{\{(\w+)\}\}/g, function (match, key) {
      return values[key] != null ? values[key] : '';
    });
  }

  // asset 無し時に使うデフォルトテンプレートを values の design フラグで選ぶ (= 全 design が必ずいずれかを立てる)
  function pickDefaultTemplate(values) {
    if (values.useTickerTemplate) return TICKER_TEMPLATE;
    if (values.useHoloTemplate) return HOLO_TEMPLATE;
    if (values.useGachaTemplate) return GACHA_TEMPLATE;
    if (values.useWandTemplate) return WAND_TEMPLATE;
    return BUD_TEMPLATE;
  }

  // 新芽 v1 テンプレート (= 通常コメ枝専用)。 SVG defs id は同時表示の競合を避けるため
  // __NONCE__ プレースホルダで spawn 毎にユニーク化する。
  var BUD_TEMPLATE = [
    '<div style="display:flex;flex-direction:column;align-items:center;font-family:\'Segoe UI\',\'Yu Gothic UI\',\'Hiragino Sans\',sans-serif;filter:drop-shadow(0 8px 18px rgba(34,80,20,0.45));">',
      // 双葉 SVG (= 葉脈 + 鏡像 + 葉先ハイライト + 中央節)
      '<svg width="96" height="56" viewBox="0 0 96 56" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:-8px;position:relative;z-index:2;">',
        '<defs>',
          '<radialGradient id="leafL__NONCE__" cx="65%" cy="55%" r="70%">',
            '<stop offset="0%" stop-color="#bef264"/>',
            '<stop offset="55%" stop-color="#84cc16"/>',
            '<stop offset="100%" stop-color="#4d7c0f"/>',
          '</radialGradient>',
          '<radialGradient id="leafR__NONCE__" cx="35%" cy="55%" r="70%">',
            '<stop offset="0%" stop-color="#bef264"/>',
            '<stop offset="55%" stop-color="#84cc16"/>',
            '<stop offset="100%" stop-color="#4d7c0f"/>',
          '</radialGradient>',
        '</defs>',
        // 左葉
        '<g transform="translate(2, 4)">',
          '<path d="M 44 48 Q 8 44 4 22 Q 4 6 20 4 Q 36 4 44 22 Q 46 36 44 48 Z" fill="url(#leafL__NONCE__)" stroke="#365314" stroke-width="0.6"/>',
          '<path d="M 44 48 Q 30 38 18 22 Q 14 12 10 8" fill="none" stroke="#365314" stroke-width="0.5" opacity="0.55" stroke-linecap="round"/>',
          '<path d="M 28 30 Q 22 26 14 24" fill="none" stroke="#365314" stroke-width="0.35" opacity="0.4" stroke-linecap="round"/>',
          '<path d="M 24 22 Q 20 18 14 14" fill="none" stroke="#365314" stroke-width="0.35" opacity="0.4" stroke-linecap="round"/>',
          '<ellipse cx="18" cy="14" rx="6" ry="3" fill="#fff" opacity="0.35" transform="rotate(-30 18 14)"/>',
        '</g>',
        // 右葉 (= 左の鏡像)
        '<g transform="translate(94, 4) scale(-1, 1)">',
          '<path d="M 44 48 Q 8 44 4 22 Q 4 6 20 4 Q 36 4 44 22 Q 46 36 44 48 Z" fill="url(#leafR__NONCE__)" stroke="#365314" stroke-width="0.6"/>',
          '<path d="M 44 48 Q 30 38 18 22 Q 14 12 10 8" fill="none" stroke="#365314" stroke-width="0.5" opacity="0.55" stroke-linecap="round"/>',
          '<path d="M 28 30 Q 22 26 14 24" fill="none" stroke="#365314" stroke-width="0.35" opacity="0.4" stroke-linecap="round"/>',
          '<path d="M 24 22 Q 20 18 14 14" fill="none" stroke="#365314" stroke-width="0.35" opacity="0.4" stroke-linecap="round"/>',
          '<ellipse cx="18" cy="14" rx="6" ry="3" fill="#fff" opacity="0.35" transform="rotate(-30 18 14)"/>',
        '</g>',
        // 中央節 (= 双葉の付け根)
        '<ellipse cx="48" cy="50" rx="4" ry="3" fill="#4d7c0f"/>',
        '<ellipse cx="48" cy="49" rx="2.5" ry="1.5" fill="#bef264" opacity="0.7"/>',
      '</svg>',
      // カード本体
      '<div style="position:relative;background:',
        'repeating-linear-gradient(112deg,transparent 0 18px,rgba(101,163,13,0.04) 18px 19px),',
        'linear-gradient(180deg,rgba(255,255,255,0.4) 0%,transparent 25%),',
        'linear-gradient(160deg,#f7fee7 0%,#ecfccb 35%,#d9f99d 100%);',
        'border:1.5px solid #84cc16;',
        'border-radius:28px 28px 18px 18px / 24px 24px 16px 16px;',
        'padding:14px 26px;color:#1a2e05;max-width:320px;min-width:240px;',
        'box-shadow:0 0 0 1px rgba(132,204,22,0.25),',
          'inset 0 1px 0 rgba(255,255,255,0.65),',
          'inset 0 -2px 4px rgba(101,163,13,0.15),',
          '0 4px 0 -1px rgba(101,163,13,0.25),',
          '0 10px 24px rgba(34,80,20,0.35);">',
        // 上端ガラス反射ライン
        '<div style="position:absolute;top:4px;left:24px;right:24px;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent);border-radius:1px;"></div>',
        // 朝露
        '<div style="position:absolute;top:6px;right:12px;width:6px;height:6px;background:radial-gradient(circle at 35% 35%,#fff 0%,rgba(180,230,255,0.9) 40%,rgba(132,204,22,0.3) 100%);border-radius:50%;box-shadow:0 1px 3px rgba(0,50,0,0.3);"></div>',
        // 名前
        '<div style="font-size:11px;color:#4d7c0f;margin-bottom:4px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;display:flex;align-items:center;gap:4px;text-shadow:0 1px 0 rgba(255,255,255,0.6);">',
          '<span style="width:8px;height:8px;background:#84cc16;border-radius:50%;box-shadow:0 0 0 2px rgba(132,204,22,0.3),inset 0 1px 0 rgba(255,255,255,0.6);flex-shrink:0;"></span>',
          '<span>{{userName}}</span>',
        '</div>',
        // 金額 (スパチャ時)
        '{{amountHtml}}',
        // 本文 (= コメント or スーパーステッカー画像)
        '<div style="font-size:16px;line-height:1.55;color:#14532d;letter-spacing:0.02em;font-weight:500;">{{contentHtml}}</div>',
        // サブ行 (メンバー / ギフト時)
        '{{subHtml}}',
      '</div>',
      // 茎 SVG (= 太細テーパー + 中央節 + 縦光沢線)
      '<svg width="12" height="38" viewBox="0 0 12 38" xmlns="http://www.w3.org/2000/svg" style="margin-top:-2px;position:relative;z-index:1;">',
        '<defs>',
          '<linearGradient id="stemGrad__NONCE__" x1="0" y1="0" x2="1" y2="0">',
            '<stop offset="0%" stop-color="#4d7c0f"/>',
            '<stop offset="40%" stop-color="#84cc16"/>',
            '<stop offset="60%" stop-color="#bef264"/>',
            '<stop offset="100%" stop-color="#365314"/>',
          '</linearGradient>',
        '</defs>',
        '<path d="M 4 0 Q 3.5 19 4 38 L 8 38 Q 8.5 19 8 0 Z" fill="url(#stemGrad__NONCE__)"/>',
        '<ellipse cx="6" cy="14" rx="3.5" ry="1.5" fill="#365314"/>',
        '<ellipse cx="6" cy="14" rx="2.5" ry="0.8" fill="#84cc16" opacity="0.6"/>',
        '<line x1="5" y1="2" x2="5" y2="36" stroke="#f7fee7" stroke-width="0.6" opacity="0.55"/>',
      '</svg>',
    '</div>'
  ].join('');

  // ホログラム v1 テンプレート (= 通常コメ枝専用、 design === 'holo')。
  // keyframes は init() で document.head に注入済み (= kh-holo-edge / kh-holo-pulse / kh-holo-base-pulse)。
  // SVG defs id は __NONCE__ で spawn 毎にユニーク化。
  var HOLO_TEMPLATE = [
    '<div style="display:flex;flex-direction:column;align-items:center;position:relative;font-family:\'Segoe UI\',\'Yu Gothic UI\',\'Hiragino Sans\',sans-serif;">',
      // メインカード wrapper (= 虹色エッジの親、 position:relative)
      '<div style="position:relative;">',
        // 虹色エッジ (= ::before 代替、 グラデ 6s 流動)
        '<div style="position:absolute;inset:-2px;background:linear-gradient(90deg,#ff00ff 0%,#00ffff 25%,#ffff00 50%,#ff00ff 75%,#00ffff 100%);background-size:200% 100%;border-radius:3px;z-index:0;animation:kh-holo-edge 6s linear infinite;filter:blur(5px);opacity:0.55;"></div>',

        // カード本体
        '<div style="position:relative;z-index:1;padding:16px 28px 14px;max-width:340px;min-width:260px;color:#fff;background:',
          'repeating-linear-gradient(0deg,transparent 0 3px,rgba(0,255,255,0.045) 3px 4px),',
          'linear-gradient(180deg,rgba(0,255,255,0.18) 0%,rgba(20,10,60,0.85) 8%,rgba(10,5,40,0.92) 50%,rgba(40,10,80,0.85) 92%,rgba(255,0,255,0.18) 100%);',
          'border:1px solid rgba(0,255,255,0.35);border-radius:2px;',
          'box-shadow:inset 0 0 12px rgba(0,255,255,0.2),inset 0 0 32px rgba(20,10,60,0.5),',
            '0 0 0 1px rgba(0,255,255,0.4),0 0 12px rgba(0,255,255,0.35),',
            '0 0 24px rgba(139,92,246,0.3),0 0 42px rgba(255,0,255,0.2);">',

          // 上端ハイライト (= ::after 代替)
          '<div style="position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(0,255,255,0.9),transparent);box-shadow:0 0 6px rgba(0,255,255,0.7);"></div>',

          // 4 角 L 字マーカー (= 上 cyan / 下 magenta)
          '<div style="position:absolute;top:3px;left:3px;width:12px;height:12px;pointer-events:none;">',
            '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M 1 5 L 1 1 L 5 1" fill="none" stroke="#00ffff" stroke-width="1.2" stroke-linecap="round"/></svg>',
          '</div>',
          '<div style="position:absolute;top:3px;right:3px;width:12px;height:12px;pointer-events:none;transform:scaleX(-1);">',
            '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M 1 5 L 1 1 L 5 1" fill="none" stroke="#00ffff" stroke-width="1.2" stroke-linecap="round"/></svg>',
          '</div>',
          '<div style="position:absolute;bottom:3px;left:3px;width:12px;height:12px;pointer-events:none;transform:scaleY(-1);">',
            '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M 1 5 L 1 1 L 5 1" fill="none" stroke="#ff00ff" stroke-width="1.2" stroke-linecap="round"/></svg>',
          '</div>',
          '<div style="position:absolute;bottom:3px;right:3px;width:12px;height:12px;pointer-events:none;transform:scale(-1,-1);">',
            '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M 1 5 L 1 1 L 5 1" fill="none" stroke="#ff00ff" stroke-width="1.2" stroke-linecap="round"/></svg>',
          '</div>',

          // SF データタグ (= 右上、 通常は「ID:XXXX」、 種別時は SUPER CHAT / MEMBER / GIFT)
          '<div style="position:absolute;top:-12px;right:14px;background:rgba(0,255,255,0.12);border:1px solid rgba(0,255,255,0.55);padding:2px 8px;font-family:Consolas,\'SF Mono\',monospace;font-size:9px;color:#00ffff;letter-spacing:0.15em;text-shadow:0 0 4px #00ffff;">{{metaTag}}</div>',

          // ユーザー名 (= chromatic aberration + 脈動ドット)
          '<div style="font-size:11px;margin-bottom:6px;color:#00ffff;font-family:Consolas,\'SF Mono\',\'Yu Gothic UI\',monospace;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;text-shadow:1px 0 0 rgba(255,0,255,0.75),-1px 0 0 rgba(0,255,255,0.75),0 0 8px rgba(0,255,255,0.45);display:flex;align-items:center;gap:7px;">',
            '<span style="width:6px;height:6px;background:#00ffff;border-radius:50%;box-shadow:0 0 6px #00ffff,0 0 12px rgba(0,255,255,0.6);animation:kh-holo-pulse 1.5s ease-in-out infinite;flex-shrink:0;"></span>',
            '<span>{{userName}}</span>',
          '</div>',

          // 金額 (スパチャ時)
          '{{amountHtml}}',
          // 本文 (= コメント or スーパーステッカー画像)
          '<div style="font-size:16px;line-height:1.55;letter-spacing:0.025em;color:#f0fbff;text-shadow:0 0 8px rgba(0,255,255,0.35),1px 0 0 rgba(255,0,255,0.18),-1px 0 0 rgba(0,255,255,0.18);font-weight:500;">{{contentHtml}}</div>',
          // サブ行 (メンバー / ギフト時)
          '{{subHtml}}',

        '</div>',
      '</div>',

      // 投影ベース台座 (= 楕円リング 3 重 + 光源点 + 補助マーカー + 脈動 glow)
      '<div style="width:180px;height:32px;margin-top:6px;position:relative;">',
        '<svg width="100%" height="100%" viewBox="0 0 180 32" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 0 8px rgba(0,255,255,0.6));">',
          '<defs>',
            '<radialGradient id="kh-holo-baseRing__NONCE__" cx="50%" cy="60%" r="65%">',
              '<stop offset="0%" stop-color="#00ffff" stop-opacity="0.9"/>',
              '<stop offset="50%" stop-color="#00ffff" stop-opacity="0.45"/>',
              '<stop offset="100%" stop-color="#00ffff" stop-opacity="0"/>',
            '</radialGradient>',
            '<linearGradient id="kh-holo-baseGlow__NONCE__" x1="0" y1="0" x2="0" y2="1">',
              '<stop offset="0%" stop-color="#fff" stop-opacity="0.7"/>',
              '<stop offset="100%" stop-color="#00ffff" stop-opacity="0.3"/>',
            '</linearGradient>',
          '</defs>',
          '<ellipse cx="90" cy="16" rx="86" ry="12" fill="none" stroke="url(#kh-holo-baseRing__NONCE__)" stroke-width="1.5"/>',
          '<ellipse cx="90" cy="16" rx="72" ry="9" fill="none" stroke="#00ffff" stroke-width="0.8" stroke-opacity="0.5"/>',
          '<ellipse cx="90" cy="16" rx="60" ry="7" fill="url(#kh-holo-baseRing__NONCE__)" opacity="0.5"/>',
          '<ellipse cx="90" cy="13" rx="55" ry="2.5" fill="url(#kh-holo-baseGlow__NONCE__)"/>',
          '<circle cx="90" cy="16" r="2" fill="#fff"/>',
          '<circle cx="90" cy="16" r="4" fill="#00ffff" opacity="0.5"/>',
          '<line x1="4" y1="16" x2="14" y2="16" stroke="#00ffff" stroke-width="1" opacity="0.7"/>',
          '<line x1="166" y1="16" x2="176" y2="16" stroke="#00ffff" stroke-width="1" opacity="0.7"/>',
        '</svg>',
        // 脈動 glow overlay
        '<div style="position:absolute;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 60%,rgba(0,255,255,0.35),transparent 70%);animation:kh-holo-base-pulse 2.5s ease-in-out infinite;pointer-events:none;"></div>',
      '</div>',
    '</div>'
  ].join('');

  // ガチャカプセル v2 テンプレート (= 通常コメ枝専用、 design === 'gacha')。
  // カラーは spawn 毎にランダム選択して {{capLight}} / {{capColor}} / {{capDark}} に注入。
  // ルート .kh-gacha-root に着地 wobble (= init で inject した kh-gacha-wobble) を spawn() で付与。
  var GACHA_TEMPLATE = [
    '<div class="kh-gacha-root" style="display:flex;flex-direction:column;align-items:center;position:relative;filter:drop-shadow(0 8px 16px rgba(80,20,50,0.45));transform-origin:bottom center;--cap-light:{{capLight}};--cap-color:{{capColor}};--cap-dark:{{capDark}};">',
      // キラキラ 3 個 (= 別 delay)
      '<span style="position:absolute;top:6px;left:-14px;font-size:14px;color:#fff;text-shadow:0 0 6px var(--cap-color),0 0 12px var(--cap-light);animation:kh-gacha-twinkle 1.6s ease-in-out infinite;pointer-events:none;z-index:6;">✦</span>',
      '<span style="position:absolute;top:50px;right:-16px;font-size:11px;color:#fff;text-shadow:0 0 6px var(--cap-color),0 0 12px var(--cap-light);animation:kh-gacha-twinkle 1.6s ease-in-out infinite;animation-delay:0.5s;pointer-events:none;z-index:6;">✧</span>',
      '<span style="position:absolute;top:90px;left:-10px;font-size:10px;color:#fff;text-shadow:0 0 6px var(--cap-color),0 0 12px var(--cap-light);animation:kh-gacha-twinkle 1.6s ease-in-out infinite;animation-delay:1s;pointer-events:none;z-index:6;">✦</span>',

      // カプセル容器 (= 卵形、 上クリア → 下カラー)
      '<div style="position:relative;width:234px;padding:58px 26px 50px;',
        'border-radius:125px 125px 112px 112px / 105px 105px 122px 122px;',
        'background:linear-gradient(180deg,rgba(255,255,255,0.94) 0%,rgba(255,255,255,0.75) 20%,var(--cap-light) 42%,var(--cap-color) 70%,var(--cap-dark) 100%);',
        'border:2px solid rgba(255,255,255,0.55);',
        'box-shadow:inset 0 7px 18px rgba(255,255,255,0.95),inset 0 -12px 22px rgba(0,0,0,0.16),',
          'inset 7px 0 16px rgba(255,255,255,0.32),inset -7px 0 16px rgba(0,0,0,0.1),',
          '0 8px 24px rgba(0,0,0,0.32),0 2px 0 rgba(255,255,255,0.5);">',

        // 左上大ハイライト
        '<div style="position:absolute;top:14px;left:24px;width:62px;height:44px;background:radial-gradient(ellipse at 42% 38%,rgba(255,255,255,0.97) 0%,rgba(255,255,255,0.4) 45%,transparent 68%);border-radius:50%;transform:rotate(-28deg);pointer-events:none;z-index:4;"></div>',
        // 右上小ハイライト
        '<div style="position:absolute;top:32px;right:34px;width:18px;height:13px;background:radial-gradient(ellipse,rgba(255,255,255,0.9) 0%,transparent 70%);border-radius:50%;transform:rotate(-28deg);pointer-events:none;z-index:4;"></div>',

        // 合わせ目ライン + 左右の留め具
        '<div style="position:absolute;top:44%;left:-2px;right:-2px;height:8px;background:linear-gradient(180deg,rgba(255,255,255,0.55) 0%,var(--cap-dark) 42%,rgba(0,0,0,0.18) 56%,rgba(255,255,255,0.45) 100%);opacity:0.55;z-index:2;">',
          '<div style="position:absolute;top:-3px;left:26px;width:12px;height:13px;background:var(--cap-dark);border-radius:4px;opacity:0.45;box-shadow:inset 0 1px 0 rgba(255,255,255,0.4);"></div>',
          '<div style="position:absolute;top:-3px;right:26px;width:12px;height:13px;background:var(--cap-dark);border-radius:4px;opacity:0.45;box-shadow:inset 0 1px 0 rgba(255,255,255,0.4);"></div>',
        '</div>',

        // 白ラベル (= 中身)
        '<div style="position:relative;z-index:3;background:linear-gradient(180deg,#ffffff 0%,#fffafc 100%);border-radius:10px;padding:9px 15px 10px;box-shadow:0 3px 9px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.95);border:1.5px solid rgba(255,255,255,0.85);">',
          // 留めテープ
          '<div style="position:absolute;top:-5px;left:50%;transform:translateX(-50%);width:24px;height:7px;background:var(--cap-dark);opacity:0.28;border-radius:3px;"></div>',
          // 名前
          '<div style="font-size:10px;color:var(--cap-dark);font-weight:800;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:3px;display:flex;align-items:center;gap:5px;justify-content:center;">',
            '<span style="width:7px;height:7px;background:radial-gradient(circle at 30% 30%,#fff 0%,var(--cap-color) 50%,var(--cap-dark) 100%);border-radius:50%;box-shadow:inset 0 1px 0 rgba(255,255,255,0.6);flex-shrink:0;"></span>',
            '<span>{{userName}}</span>',
          '</div>',
          // 金額 (スパチャ時)
          '{{amountHtml}}',
          // 本文 (= コメント or スーパーステッカー画像)
          '<div style="font-size:14px;color:#4a3040;line-height:1.45;font-weight:600;text-align:center;letter-spacing:0.01em;">{{contentHtml}}</div>',
          // サブ行 (メンバー / ギフト時)
          '{{subHtml}}',
        '</div>',
      '</div>',
    '</div>'
  ].join('');

  // ガチャカプセルのカラーパレット (= spawn 毎にランダム選択)
  var GACHA_COLORS = [
    { light: '#ffc4dd', color: '#ff8fb8', dark: '#d93c82' }, // ピンク
    { light: '#bce8ff', color: '#7cc6f5', dark: '#2a85c0' }, // 水色
    { light: '#c4f5d4', color: '#8ee0a8', dark: '#3a9858' }, // ミント
    { light: '#fff0b3', color: '#ffd54f', dark: '#f9a825' }, // 黄
    { light: '#e0c4ff', color: '#c08ef0', dark: '#8e44c0' }  // 紫
  ];

  // ガチャ: 全種別 (通常 / スパチャ / スーパーステッカー / メンバー / ギフト) を統合
  function buildGachaValues(ctx) {
    var v = { useGachaTemplate: true };
    var amount = ctx.amount || 0;
    var isSuperchat = amount > 0;
    var isMembershipGift = ctx.isMembershipGift || false;
    var isMembership = ctx.isMembership || false;
    var giftCount = ctx.giftCount || 0;
    var stickerImage = ctx.stickerImage || '';
    v.userName = esc(ctx.userName || '');
    var content = ctx.commentHtml ? sanitizeCommentHtml(ctx.commentHtml) : esc(ctx.comment || '');
    v.amountHtml = '';
    v.subHtml = '';

    if (isMembershipGift) {
      v.capLight = '#e6c9ff'; v.capColor = '#ab47bc'; v.capDark = '#7b1fa2';
      v.contentHtml = content;
      v.subHtml = '<div style="font-size:10px;color:#7b1fa2;margin-top:4px;font-weight:700;">🎁 ' + (giftCount > 0 ? giftCount + ' 人にギフト' : 'メンバーシップギフト') + '</div>';
    } else if (isMembership) {
      v.capLight = '#c8f5d4'; v.capColor = '#66bb6a'; v.capDark = '#2e7d32';
      v.contentHtml = content;
      v.subHtml = '<div style="font-size:10px;color:#2e7d32;margin-top:4px;font-weight:700;">🎉 ' + esc(ctx.membershipHeader || 'メンバー登録') + '</div>';
    } else if (isSuperchat) {
      var tier = wandScColor(ctx.superchatTier || 'blue');
      v.capLight = tier.light; v.capColor = tier.main; v.capDark = tier.dark;
      v.amountHtml = '<div style="font-size:16px;font-weight:800;color:' + tier.dark + ';margin-bottom:3px;letter-spacing:0.02em;">' + esc(ctx.amountDisplay || ('¥' + amount)) + '</div>';
      if (stickerImage) {
        v.contentHtml = '<div style="text-align:center;"><img src="' + esc(stickerImage) + '" style="max-width:88px;max-height:88px;object-fit:contain;"></div>';
      } else {
        v.contentHtml = content;
      }
    } else {
      var gc = GACHA_COLORS[Math.floor(Math.random() * GACHA_COLORS.length)];
      v.capLight = gc.light; v.capColor = gc.color; v.capDark = gc.dark;
      v.contentHtml = content;
    }
    return v;
  }

  // 新芽: 全種別。 カードは緑のまま (= 新芽らしさ維持)、 金額 / サブ行 / ステッカー画像を追加
  function buildBudValues(ctx) {
    var v = { useBudTemplate: true };
    var amount = ctx.amount || 0;
    var isSuperchat = amount > 0;
    var isMembershipGift = ctx.isMembershipGift || false;
    var isMembership = ctx.isMembership || false;
    var giftCount = ctx.giftCount || 0;
    var stickerImage = ctx.stickerImage || '';
    v.userName = esc(ctx.userName || '');
    var content = ctx.commentHtml ? sanitizeCommentHtml(ctx.commentHtml) : esc(ctx.comment || '');
    v.amountHtml = '';
    v.subHtml = '';
    if (isMembershipGift) {
      v.contentHtml = content;
      v.subHtml = '<div style="font-size:11px;color:#9333ea;margin-top:4px;font-weight:700;">🎁 ' + (giftCount > 0 ? giftCount + ' 人にギフト' : 'メンバーシップギフト') + '</div>';
    } else if (isMembership) {
      v.contentHtml = content;
      v.subHtml = '<div style="font-size:11px;color:#15803d;margin-top:4px;font-weight:700;">🎉 ' + esc(ctx.membershipHeader || 'メンバー登録') + '</div>';
    } else if (isSuperchat) {
      v.amountHtml = '<div style="font-size:16px;font-weight:800;color:#b45309;margin-bottom:3px;letter-spacing:0.02em;">' + esc(ctx.amountDisplay || ('¥' + amount)) + '</div>';
      if (stickerImage) {
        v.contentHtml = '<div style="text-align:center;"><img src="' + esc(stickerImage) + '" style="max-width:90px;max-height:90px;object-fit:contain;"></div>';
      } else {
        v.contentHtml = content;
      }
    } else {
      v.contentHtml = content;
    }
    return v;
  }

  // ホログラム: 全種別。 虹色は維持 (= holo らしさ)、 金額 (cyan) / サブ行 / ステッカー + データタグを種別表示
  function buildHoloValues(ctx) {
    var v = { useHoloTemplate: true };
    var amount = ctx.amount || 0;
    var isSuperchat = amount > 0;
    var isMembershipGift = ctx.isMembershipGift || false;
    var isMembership = ctx.isMembership || false;
    var giftCount = ctx.giftCount || 0;
    var stickerImage = ctx.stickerImage || '';
    v.userName = esc(ctx.userName || '');
    var content = ctx.commentHtml ? sanitizeCommentHtml(ctx.commentHtml) : esc(ctx.comment || '');
    v.amountHtml = '';
    v.subHtml = '';
    if (isMembershipGift) {
      v.metaTag = 'GIFT';
      v.contentHtml = content;
      v.subHtml = '<div style="font-size:11px;color:#d8b4fe;margin-top:4px;text-shadow:0 0 6px rgba(217,70,239,0.5);">🎁 ' + (giftCount > 0 ? giftCount + ' 人にギフト' : 'メンバーシップギフト') + '</div>';
    } else if (isMembership) {
      v.metaTag = 'MEMBER';
      v.contentHtml = content;
      v.subHtml = '<div style="font-size:11px;color:#6ee7b7;margin-top:4px;text-shadow:0 0 6px rgba(16,185,129,0.5);">🎉 ' + esc(ctx.membershipHeader || 'メンバー登録') + '</div>';
    } else if (isSuperchat) {
      v.metaTag = 'SUPER CHAT';
      v.amountHtml = '<div style="font-size:18px;font-weight:800;color:#67e8f9;margin-bottom:4px;text-shadow:0 0 10px rgba(0,255,255,0.6);">' + esc(ctx.amountDisplay || ('¥' + amount)) + '</div>';
      if (stickerImage) {
        v.contentHtml = '<div style="text-align:center;"><img src="' + esc(stickerImage) + '" style="max-width:90px;max-height:90px;object-fit:contain;filter:drop-shadow(0 0 8px rgba(0,255,255,0.5));"></div>';
      } else {
        v.contentHtml = content;
      }
    } else {
      var idNum = Math.floor(Math.random() * 0x10000);
      var idTag = idNum.toString(16).toUpperCase();
      while (idTag.length < 4) idTag = '0' + idTag;
      v.metaTag = 'ID:' + idTag;
      v.contentHtml = content;
    }
    return v;
  }

  // ===== テロップバー (ticker) =====

  // 通常コメント (= 2 回目以降) のカラープリセット。 uiSchema の normalColor で選択。
  var TICKER_NORMAL_COLORS = {
    cyan:    { light: '#a5f3fc', main: '#22d3ee', glow: 'rgba(34,211,238,0.6)',  name: '#c8e8f0' },
    silver:  { light: '#e2e8f0', main: '#94a3b8', glow: 'rgba(203,213,225,0.5)', name: '#e2e8f0' },
    gold:    { light: '#fde68a', main: '#f59e0b', glow: 'rgba(245,158,11,0.5)',  name: '#fef3c7' },
    magenta: { light: '#f5a3ff', main: '#d946ef', glow: 'rgba(217,70,239,0.55)', name: '#f5d0fe' },
    green:   { light: '#86efac', main: '#22c55e', glow: 'rgba(34,197,94,0.5)',   name: '#bbf7d0' }
  };

  // スパチャ tier → CSS class suffix (= 金額帯の色)
  function tickerScClass(tierKey) {
    // Rust superchat_tier_key の値: blue / teal / green / yellow / orange / magenta / red
    var map = { blue: 'blue', teal: 'cyan', cyan: 'cyan', green: 'green', yellow: 'yellow', orange: 'orange', magenta: 'magenta', red: 'red' };
    return 'kh-tk-sc-' + (map[tierKey] || 'blue');
  }

  // per-comment listener_status → { rankClass, label }
  function tickerRank(status) {
    switch (status) {
      case 'first-time':       return { cls: 'kh-tk-rank-first',   label: 'NEW',    badge: true };
      case 'returning':        return { cls: 'kh-tk-rank-return',  label: 'BACK',   badge: false };
      case 'regular-arrival':  return { cls: 'kh-tk-rank-arrival', label: 'JOIN',   badge: false };
      case 'long-absence':     return { cls: 'kh-tk-rank-absence', label: 'RETURN', badge: false };
      default:                 return { cls: 'kh-tk-rank-none',    label: 'LIVE',   badge: false };
    }
  }

  var TICKER_CSS = [
    ".kh-tk-ticker{display:flex;flex-direction:column;align-items:stretch;width:100%;filter:drop-shadow(0 10px 20px rgba(0,0,0,0.6));}",
    ".kh-tk-bar{display:flex;align-items:stretch;width:100%;min-height:62px;background:linear-gradient(180deg,rgba(40,46,58,0.6) 0%,transparent 30%),linear-gradient(180deg,#1b1f29 0%,#12151d 45%,#0c0e15 80%,#08090e 100%);box-shadow:0 6px 20px rgba(0,0,0,0.7),0 14px 36px rgba(0,0,0,0.45),inset 0 1px 0 rgba(255,255,255,0.18),inset 0 0 40px rgba(34,211,238,0.04);position:relative;overflow:hidden;}",
    ".kh-tk-bar::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.45),transparent);}",
    ".kh-tk-bar::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--tag-mid) 0%,var(--tag-mid) 13%,#22d3ee 19%,#22d3ee 81%,var(--tag-mid) 87%,var(--tag-mid) 100%);box-shadow:0 0 8px rgba(34,211,238,0.5);}",
    ".kh-tk-tag{background:linear-gradient(135deg,var(--tag-light) 0%,var(--tag-mid) 50%,var(--tag-dark) 100%);color:var(--tag-text,#fff);padding:0 20px;font-weight:800;font-size:15px;letter-spacing:0.14em;display:flex;align-items:center;gap:8px;text-shadow:0 1px 2px rgba(0,0,0,0.5);box-shadow:inset 0 1px 0 rgba(255,255,255,0.4),inset 0 -2px 0 rgba(0,0,0,0.35),2px 0 10px var(--tag-glow);position:relative;z-index:2;white-space:nowrap;font-family:'Segoe UI','Yu Gothic UI',sans-serif;}",
    ".kh-tk-tag-dot{width:9px;height:9px;background:var(--dot,#fff);border-radius:50%;box-shadow:0 0 6px var(--dot,#fff),0 0 12px rgba(255,255,255,0.6);animation:kh-tk-blink 1.1s ease-in-out infinite;flex-shrink:0;}",
    ".kh-tk-tag-emoji{font-size:16px;}",
    ".kh-tk-tag::after{content:'';position:absolute;right:-16px;top:0;bottom:0;width:16px;background:linear-gradient(135deg,var(--tag-mid) 0%,var(--tag-dark) 100%);clip-path:polygon(0 0,100% 50%,0 100%);filter:drop-shadow(2px 0 4px rgba(0,0,0,0.5));z-index:2;}",
    ".kh-tk-body{flex:1;padding:7px 24px 7px 32px;display:flex;flex-direction:column;justify-content:center;position:relative;}",
    ".kh-tk-body::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(34,211,238,0.035) 2px,rgba(34,211,238,0.035) 3px);pointer-events:none;}",
    ".kh-tk-body::before{content:'';position:absolute;left:22px;top:11px;bottom:11px;width:3px;background:linear-gradient(180deg,var(--rank-light) 0%,var(--rank-main) 50%,var(--rank-light) 100%);box-shadow:0 0 6px var(--rank-glow);border-radius:2px;z-index:1;}",
    ".kh-tk-name{font-size:12px;color:var(--rank-light);letter-spacing:0.08em;font-weight:700;margin-bottom:2px;text-shadow:0 0 4px var(--rank-glow),0 1px 2px rgba(0,0,0,0.5);display:flex;align-items:center;gap:8px;position:relative;z-index:1;}",
    ".kh-tk-badge{background:var(--rank-bg);color:var(--rank-light);padding:1px 8px;border:1px solid var(--rank-main);font-size:9px;letter-spacing:0.08em;font-weight:700;border-radius:2px;box-shadow:0 0 6px var(--rank-glow);}",
    ".kh-tk-text{font-size:17px;color:#fff;line-height:1.3;letter-spacing:0.02em;font-weight:500;text-shadow:0 1px 3px rgba(0,0,0,0.7);position:relative;z-index:1;}",
    ".kh-tk-sub{font-size:11px;color:var(--tag-light);margin-top:2px;letter-spacing:0.04em;font-weight:600;position:relative;z-index:1;}",
    ".kh-tk-sparkle{position:absolute;color:var(--tag-light);text-shadow:0 0 6px var(--tag-glow);animation:kh-tk-blink 1.4s ease-in-out infinite;pointer-events:none;z-index:3;}",
    ".kh-tk-subbar{width:100%;height:19px;background:linear-gradient(180deg,rgba(0,0,0,0.9),rgba(0,0,0,0.96));border-top:1px solid rgba(34,211,238,0.18);display:flex;align-items:center;padding:0 18px;font-family:'SF Mono',Consolas,monospace;font-size:9px;letter-spacing:0.18em;color:rgba(180,200,210,0.5);box-shadow:0 4px 12px rgba(0,0,0,0.5);gap:14px;}",
    ".kh-tk-subitem{display:flex;align-items:center;gap:4px;}",
    ".kh-tk-subitem::before{content:'\\25C6';color:#22d3ee;font-size:7px;text-shadow:0 0 4px rgba(34,211,238,0.6);}",
    ".kh-tk-subspacer{flex:1;}",
    ".kh-tk-subclock{color:rgba(34,211,238,0.6);}",
    ".kh-tk-kind-normal{--tag-light:var(--rank-light);--tag-mid:var(--rank-main);--tag-dark:var(--rank-dark);--tag-glow:var(--rank-glow);--dot:#fff;}",
    ".kh-tk-kind-member{--tag-light:#6ee7b7;--tag-mid:#10b981;--tag-dark:#047857;--tag-glow:rgba(16,185,129,0.6);--dot:#fff;}",
    ".kh-tk-kind-gift{--tag-light:#d8b4fe;--tag-mid:#9333ea;--tag-dark:#6b21a8;--tag-glow:rgba(147,51,234,0.6);--dot:#fff;}",
    ".kh-tk-sc-blue{--tag-light:#90caf9;--tag-mid:#5b9bd5;--tag-dark:#3a6ea5;--tag-glow:rgba(91,155,213,0.55);}",
    ".kh-tk-sc-cyan{--tag-light:#80deea;--tag-mid:#4db8c8;--tag-dark:#2a8a98;--tag-glow:rgba(77,184,200,0.55);}",
    ".kh-tk-sc-green{--tag-light:#a5d6a7;--tag-mid:#7cb342;--tag-dark:#558b2f;--tag-glow:rgba(124,179,66,0.55);}",
    ".kh-tk-sc-yellow{--tag-light:#fff176;--tag-mid:#ffca28;--tag-dark:#f9a825;--tag-glow:rgba(255,202,40,0.55);--tag-text:#5a3d00;}",
    ".kh-tk-sc-orange{--tag-light:#ffcc80;--tag-mid:#fb8c00;--tag-dark:#e65100;--tag-glow:rgba(251,140,0,0.55);}",
    ".kh-tk-sc-magenta{--tag-light:#f48fb1;--tag-mid:#ec407a;--tag-dark:#c2185b;--tag-glow:rgba(236,64,122,0.55);}",
    ".kh-tk-sc-red{--tag-light:#ef9a9a;--tag-mid:#e53935;--tag-dark:#c62828;--tag-glow:rgba(229,57,53,0.55);}",
    ".kh-tk-rank-first{--rank-light:#4ade80;--rank-main:#22c55e;--rank-dark:#15803d;--rank-glow:rgba(34,197,94,0.5);--rank-bg:rgba(34,197,94,0.14);}",
    ".kh-tk-rank-return{--rank-light:#7dd3fc;--rank-main:#38bdf8;--rank-dark:#0284c7;--rank-glow:rgba(56,189,248,0.5);--rank-bg:rgba(56,189,248,0.14);}",
    ".kh-tk-rank-arrival{--rank-light:#fcd34d;--rank-main:#f59e0b;--rank-dark:#b45309;--rank-glow:rgba(245,158,11,0.5);--rank-bg:rgba(245,158,11,0.14);}",
    ".kh-tk-rank-absence{--rank-light:#fda4af;--rank-main:#fb7185;--rank-dark:#be123c;--rank-glow:rgba(251,113,133,0.5);--rank-bg:rgba(251,113,133,0.14);}",
    ".kh-tk-rank-none{--rank-light:#cfd8e0;--rank-main:#8a96a4;--rank-dark:#56606e;--rank-glow:var(--tkn-glow,rgba(34,211,238,0.4));--rank-bg:var(--tkn-bg,rgba(34,211,238,0.12));}",
    ".kh-tk-kind-normal.kh-tk-rank-none .kh-tk-tag{background:linear-gradient(135deg,#3a4654 0%,#232c38 50%,#141a24 100%);color:#d6f5fb;box-shadow:inset 0 1px 0 rgba(255,255,255,0.28),inset 0 -2px 0 rgba(0,0,0,0.45),inset 0 0 14px var(--tkn-glow,rgba(34,211,238,0.28)),2px 0 12px var(--tkn-glow,rgba(34,211,238,0.45));text-shadow:0 0 7px var(--tkn-glow,rgba(34,211,238,0.55));}",
    ".kh-tk-kind-normal.kh-tk-rank-none .kh-tk-tag::after{background:linear-gradient(135deg,#232c38 0%,#141a24 100%);}",
    ".kh-tk-kind-normal.kh-tk-rank-none .kh-tk-tag-dot{background:var(--tkn-main,#22d3ee);box-shadow:0 0 7px var(--tkn-main,#22d3ee),0 0 14px var(--tkn-glow,rgba(34,211,238,0.85));}",
    ".kh-tk-kind-normal.kh-tk-rank-none .kh-tk-body::before{background:linear-gradient(180deg,var(--tkn-light,#a5f3fc) 0%,var(--tkn-main,#22d3ee) 50%,var(--tkn-light,#a5f3fc) 100%);box-shadow:0 0 8px var(--tkn-glow,rgba(34,211,238,0.7));}",
    ".kh-tk-kind-normal.kh-tk-rank-none .kh-tk-name{color:var(--tkn-name,#c8e8f0);text-shadow:0 0 6px var(--tkn-glow,rgba(34,211,238,0.4)),0 1px 2px rgba(0,0,0,0.5);}",
    ".kh-tk-kind-normal.kh-tk-rank-none .kh-tk-bar::after{background:linear-gradient(90deg,transparent 0%,var(--tkn-main,#22d3ee) 12%,var(--tkn-light,#67e8f9) 50%,var(--tkn-main,#22d3ee) 88%,transparent 100%);box-shadow:0 0 10px var(--tkn-glow,rgba(34,211,238,0.6));}",
    "@keyframes kh-tk-blink{0%,100%{opacity:1;}50%{opacity:0.4;}}"
  ].join('');

  var TICKER_TEMPLATE = [
    '<div class="kh-tk-ticker">',
      '<div class="kh-tk-bar {{barClass}}" style="{{barStyle}}">',
        '{{sparkles}}',
        '<div class="kh-tk-tag">{{tagInner}}</div>',
        '<div class="kh-tk-body">',
          '<div class="kh-tk-name">{{nameInner}}</div>',
          '<div class="kh-tk-text">{{contentHtml}}</div>',
          '{{subHtml}}',
        '</div>',
      '</div>',
      '<div class="kh-tk-subbar">{{subbarHtml}}</div>',
    '</div>'
  ].join('');

  // テロップバーは全種別 (通常 / スパチャ / メンバー / ギフト) を 1 つの template に統合表示する。
  // タグ = 種別の色と装飾 + ランク文言 (通常時) / body アクセント = ランク色 / 新規バッジ = 初見のみ。
  function buildTickerValues(ctx, normalColor) {
    var v = { useTickerTemplate: true };
    var amount = ctx.amount || 0;
    var isSuperchat = amount > 0;
    var isMembershipGift = ctx.isMembershipGift || false;
    var isMembership = ctx.isMembership || false;
    var giftCount = ctx.giftCount || 0;
    var userName = esc(ctx.userName || '');
    v.contentHtml = ctx.commentHtml ? sanitizeCommentHtml(ctx.commentHtml) : esc(ctx.comment || '');

    var rank = tickerRank(ctx.listenerStatus || ctx.listener_status || '');

    var kindClass, tagInner, subHtml = '', subbarItems, sparkles = '';
    if (isMembershipGift) {
      kindClass = 'kh-tk-kind-gift';
      tagInner = '<span class="kh-tk-tag-emoji">🎁</span><span>GIFT</span>';
      subHtml = '<div class="kh-tk-sub">🎁 ' + (giftCount > 0 ? giftCount + ' 人にギフト' : 'メンバーシップギフト') + '</div>';
      subbarItems = '<span class="kh-tk-subitem">GIFT MEMBERSHIP</span>' + (giftCount > 0 ? '<span class="kh-tk-subitem">×' + giftCount + '</span>' : '');
    } else if (isMembership) {
      kindClass = 'kh-tk-kind-member';
      tagInner = '<span class="kh-tk-tag-emoji">🎉</span><span>MEMBER</span>';
      subHtml = '<div class="kh-tk-sub">★ ' + esc(ctx.membershipHeader || '新規メンバー登録') + '</div>';
      subbarItems = '<span class="kh-tk-subitem">NEW MEMBER</span><span class="kh-tk-subitem">MEMBERSHIP</span>';
    } else if (isSuperchat) {
      kindClass = tickerScClass(ctx.superchatTier || 'blue');
      var emoji = amount >= 5000 ? '💸' : (amount >= 1000 ? '💰' : '💴');
      var amtStr = esc(ctx.amountDisplay || ('¥' + amount));
      tagInner = '<span class="kh-tk-tag-emoji">' + emoji + '</span><span>' + amtStr + '</span>';
      subbarItems = '<span class="kh-tk-subitem">SUPER CHAT</span><span class="kh-tk-subitem">' + amtStr + '</span>';
      if (amount >= 5000) {
        sparkles = '<span class="kh-tk-sparkle" style="left:12px;top:8px;font-size:12px;">✦</span>' +
          '<span class="kh-tk-sparkle" style="left:42%;top:40px;font-size:10px;animation-delay:0.5s;">✧</span>';
      }
    } else {
      kindClass = 'kh-tk-kind-normal';
      tagInner = '<span class="kh-tk-tag-dot"></span><span>' + rank.label + '</span>';
      subbarItems = '<span class="kh-tk-subitem">COMMENT FEED</span><span class="kh-tk-subitem">CH.STREAMING</span>';
    }

    v.tagInner = tagInner;
    v.nameInner = '<span>' + userName + '</span>' + (rank.badge ? '<span class="kh-tk-badge">新規</span>' : '');
    v.subHtml = subHtml;
    v.sparkles = sparkles;
    v.barClass = kindClass + ' ' + rank.cls;
    v.subbarHtml = subbarItems + '<span class="kh-tk-subspacer"></span><span class="kh-tk-subclock">REC ● LIVE</span>';

    // 通常カラー (= rank-none のときのみ、 cyan 以外のプリセットを CSS 変数で注入)
    var barStyle = '';
    if (rank.cls === 'kh-tk-rank-none') {
      var nc = TICKER_NORMAL_COLORS[normalColor] || TICKER_NORMAL_COLORS.cyan;
      barStyle = '--tkn-light:' + nc.light + ';--tkn-main:' + nc.main + ';--tkn-glow:' + nc.glow + ';--tkn-name:' + nc.name + ';';
    }
    v.barStyle = barStyle;

    return v;
  }

  // ===== 魔法ステッキ (wand、 歌枠用) =====

  // シンボル + 色のパレット (= spawn 毎にランダム選択)
  var WAND_SYMBOLS = [
    { sym: '🌙', main: '#ffd700', light: '#fff3b0', dark: '#8b6914', glow: 'rgba(255,215,0,0.7)' },
    { sym: '⭐', main: '#ffe54c', light: '#fff7c0', dark: '#a88a00', glow: 'rgba(255,229,76,0.75)' },
    { sym: '💖', main: '#ff4d8d', light: '#ffc1d8', dark: '#c2185b', glow: 'rgba(255,77,141,0.75)' },
    { sym: '🎵', main: '#c77dff', light: '#e9ccff', dark: '#6a1b9a', glow: 'rgba(199,125,255,0.75)' },
    { sym: '✨', main: '#a5f3fc', light: '#ffffff', dark: '#4db8c8', glow: 'rgba(165,243,252,0.8)' }
  ];

  // hex を明 (factor>0=白寄せ) / 暗 (factor<0=黒寄せ) に調整
  function khWandAdjust(hex, factor) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if (isNaN(r)) return hex;
    if (factor >= 0) {
      r = Math.round(r + (255 - r) * factor); g = Math.round(g + (255 - g) * factor); b = Math.round(b + (255 - b) * factor);
    } else {
      var f = 1 + factor; r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
    }
    function hx(x) { x = Math.max(0, Math.min(255, x)).toString(16); return x.length < 2 ? '0' + x : x; }
    return '#' + hx(r) + hx(g) + hx(b);
  }
  function khWandRgba(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if (isNaN(r)) return 'rgba(255,255,255,' + a + ')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  // ユーザー設定 (= 絵文字 + 色) から light/dark/glow を自動生成
  function wandSymbolFromConfig(emoji, color) {
    return { sym: emoji, main: color, light: khWandAdjust(color, 0.45), dark: khWandAdjust(color, -0.4), glow: khWandRgba(color, 0.72) };
  }

  // ユーザーのシンボル設定 (= sym1..5 の絵文字 + 色) からシンボルプールを構築。
  // 未設定なら WAND_SYMBOLS (= デフォルトの手調整パレット) をそのまま使う。
  function buildWandSymbolPool(data) {
    if (!data) return WAND_SYMBOLS;
    var configured = false;
    for (var i = 1; i <= 5; i++) {
      if (data['sym' + i + 'Emoji'] != null || data['sym' + i + 'Color'] != null || data['sym' + i + 'Image'] || data['sym' + i + 'Enabled'] != null) { configured = true; break; }
    }
    if (!configured) return WAND_SYMBOLS;
    var base = data._assetsBase || '';
    var defs = [['🌙', '#ffd700'], ['⭐', '#ffe54c'], ['💖', '#ff4d8d'], ['🎵', '#c77dff'], ['✨', '#a5f3fc']];
    function build(respectEnabled) {
      var pool = [];
      for (var j = 1; j <= 5; j++) {
        if (respectEnabled) {
          var en = data['sym' + j + 'Enabled'] != null ? data['sym' + j + 'Enabled'] : true;
          if (!en) continue;
        }
        var img = data['sym' + j + 'Image'];
        var em = data['sym' + j + 'Emoji'] != null ? data['sym' + j + 'Emoji'] : defs[j - 1][0];
        var col = data['sym' + j + 'Color'] != null ? data['sym' + j + 'Color'] : defs[j - 1][1];
        if (img) {
          // 画像優先 (= 素材ファイル名を assetsBase で URL 化)
          var c = wandSymbolFromConfig('', col);
          c.sym = base + img;
          c.isImage = true;
          pool.push(c);
        } else if (em && String(em).trim()) {
          pool.push(wandSymbolFromConfig(em, col));
        }
      }
      return pool;
    }
    var pool = build(true);
    // 最低 1 つは有効を保証: 全無効なら enabled を無視して再構築
    if (pool.length === 0) pool = build(false);
    return pool.length ? pool : WAND_SYMBOLS;
  }

  var WAND_CSS = [
    ".kh-wand-root{display:flex;flex-direction:column;align-items:center;transform-origin:bottom center;}",
    ".kh-wand-head{display:flex;flex-direction:column;align-items:center;position:relative;margin-bottom:-6px;z-index:2;}",
    ".kh-wand-comment{background:linear-gradient(180deg,rgba(255,255,255,0.16) 0%,rgba(255,255,255,0.04) 100%),rgba(14,11,26,var(--bg-opacity,0));backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1.5px solid var(--sym);border-radius:18px;padding:9px 18px;max-width:240px;color:#fff;box-shadow:0 0 16px var(--sym-glow),inset 0 1px 0 rgba(255,255,255,0.4);text-align:center;margin-bottom:8px;position:relative;font-family:'Segoe UI','Yu Gothic UI',sans-serif;}",
    ".kh-wand-name{font-size:10px;color:var(--sym-light);font-weight:700;letter-spacing:0.08em;margin-bottom:2px;text-shadow:0 0 6px var(--sym-glow);}",
    ".kh-wand-text{font-size:15px;line-height:1.4;font-weight:600;text-shadow:0 0 6px var(--sym-glow),0 1px 2px rgba(0,0,0,0.4);}",
    ".kh-wand-amount{font-size:18px;font-weight:800;color:var(--sym-light);text-shadow:0 0 8px var(--sym-glow),0 1px 2px rgba(0,0,0,0.5);margin-bottom:2px;letter-spacing:0.03em;}",
    ".kh-wand-sub{font-size:11px;color:var(--sym-light);margin-top:3px;font-weight:600;text-shadow:0 0 6px var(--sym-glow);}",
    ".kh-wand-comment::after{content:'';position:absolute;bottom:-7px;left:50%;transform:translateX(-50%) rotate(45deg);width:12px;height:12px;background:rgba(255,255,255,0.12);border-right:1.5px solid var(--sym);border-bottom:1.5px solid var(--sym);}",
    ".kh-wand-symbol{font-size:46px;line-height:1;position:relative;z-index:2;filter:drop-shadow(0 0 5px var(--sym));}",
    ".kh-wand-symbol::before{content:'';position:absolute;left:50%;top:50%;width:76px;height:76px;background:radial-gradient(circle,var(--sym-glow) 0%,var(--sym-glow) 12%,transparent 66%);border-radius:50%;z-index:-1;pointer-events:none;animation:kh-wand-glow 2.6s ease-in-out infinite;}",
    ".kh-wand-stick{width:16px;height:120px;margin-top:-4px;position:relative;z-index:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));}",
    ".kh-wand-spark{position:absolute;color:var(--sym-light);text-shadow:0 0 6px var(--sym),0 0 12px var(--sym-glow);animation:kh-wand-twinkle 1.5s ease-in-out infinite;pointer-events:none;z-index:3;}",
    "@keyframes kh-wand-glow{0%,100%{opacity:0.55;transform:translate(-50%,-50%) scale(0.82);}50%{opacity:1;transform:translate(-50%,-50%) scale(1.18);}}",
    "@keyframes kh-wand-twinkle{0%,100%{opacity:0.4;transform:scale(0.6) rotate(0deg);}50%{opacity:1;transform:scale(1.2) rotate(30deg);}}"
  ].join('');

  var WAND_TEMPLATE = [
    '<div class="kh-wand-root" style="--sym:{{symMain}};--sym-light:{{symLight}};--sym-glow:{{symGlow}};--bg-opacity:{{bgOpacity}};">',
      '<div class="kh-wand-head">',
        '{{sparkles}}',
        '<div class="kh-wand-comment">',
          '<div class="kh-wand-name">{{userName}}</div>',
          '{{amountHtml}}',
          '<div class="kh-wand-text">{{contentHtml}}</div>',
          '{{subHtml}}',
        '</div>',
        '<span class="kh-wand-symbol">{{symbolHtml}}</span>',
      '</div>',
      '<svg class="kh-wand-stick" viewBox="0 0 16 120" xmlns="http://www.w3.org/2000/svg">',
        '<defs><linearGradient id="khWand__NONCE__" x1="0" y1="0" x2="1" y2="0">',
          '<stop offset="0%" stop-color="{{symDark}}"/>',
          '<stop offset="40%" stop-color="{{symMain}}"/>',
          '<stop offset="55%" stop-color="{{symLight}}"/>',
          '<stop offset="100%" stop-color="{{symDark}}"/>',
        '</linearGradient></defs>',
        '<rect x="6" y="0" width="4" height="120" rx="2" fill="url(#khWand__NONCE__)"/>',
        '<path d="M 8 6 Q 14 16 10 28 Q 4 40 10 52 Q 15 64 10 76 Q 4 88 9 100" fill="none" stroke="{{symLight}}" stroke-width="2.2" opacity="0.65" stroke-linecap="round"/>',
        '<line x1="7.4" y1="4" x2="7.4" y2="116" stroke="#fffde7" stroke-width="0.8" opacity="0.5"/>',
      '</svg>',
    '</div>'
  ].join('');

  // スパチャ金額帯 → 杖・シンボルの色
  function wandScColor(tierKey) {
    var m = {
      blue:    { main: '#5b9bd5', light: '#90caf9', dark: '#3a6ea5', glow: 'rgba(91,155,213,0.7)' },
      teal:    { main: '#4db8c8', light: '#80deea', dark: '#2a8a98', glow: 'rgba(77,184,200,0.7)' },
      cyan:    { main: '#4db8c8', light: '#80deea', dark: '#2a8a98', glow: 'rgba(77,184,200,0.7)' },
      green:   { main: '#7cb342', light: '#a5d6a7', dark: '#558b2f', glow: 'rgba(124,179,66,0.7)' },
      yellow:  { main: '#ffca28', light: '#fff176', dark: '#f9a825', glow: 'rgba(255,202,40,0.75)' },
      orange:  { main: '#fb8c00', light: '#ffcc80', dark: '#e65100', glow: 'rgba(251,140,0,0.75)' },
      magenta: { main: '#ec407a', light: '#f48fb1', dark: '#c2185b', glow: 'rgba(236,64,122,0.75)' },
      red:     { main: '#e53935', light: '#ef9a9a', dark: '#c62828', glow: 'rgba(229,57,53,0.75)' }
    };
    return m[tierKey] || m.blue;
  }

  // 魔法ステッキ: 全種別 (通常 / スパチャ / スーパーステッカー / メンバー / ギフト) を統合
  function buildWandValues(ctx, bgOpacity, wandSymbols) {
    var v = { useWandTemplate: true };
    var amount = ctx.amount || 0;
    var isSuperchat = amount > 0;
    var isMembershipGift = ctx.isMembershipGift || false;
    var isMembership = ctx.isMembership || false;
    var giftCount = ctx.giftCount || 0;
    var stickerImage = ctx.stickerImage || '';
    v.userName = esc(ctx.userName || '');
    v.contentHtml = ctx.commentHtml ? sanitizeCommentHtml(ctx.commentHtml) : esc(ctx.comment || '');
    v.bgOpacity = (bgOpacity != null ? bgOpacity : 0) / 100;
    v.amountHtml = '';
    v.subHtml = '';
    v.sparkles = '<span class="kh-wand-spark" style="top:-8px;left:-16px;font-size:13px;">✦</span>' +
      '<span class="kh-wand-spark" style="top:30px;right:-18px;font-size:10px;animation-delay:0.5s;">✧</span>' +
      '<span class="kh-wand-spark" style="top:6px;right:-22px;font-size:8px;animation-delay:1s;">✦</span>';

    if (isMembershipGift) {
      v.symMain = '#c77dff'; v.symLight = '#e9ccff'; v.symDark = '#6a1b9a'; v.symGlow = 'rgba(199,125,255,0.75)';
      v.symbolHtml = '🎁';
      v.subHtml = '<div class="kh-wand-sub">🎁 ' + (giftCount > 0 ? giftCount + ' 人にギフト' : 'メンバーシップギフト') + '</div>';
    } else if (isMembership) {
      v.symMain = '#34d399'; v.symLight = '#a7f3d0'; v.symDark = '#047857'; v.symGlow = 'rgba(16,185,129,0.75)';
      v.symbolHtml = '🎉';
      v.subHtml = '<div class="kh-wand-sub">★ ' + esc(ctx.membershipHeader || '新規メンバー登録') + '</div>';
    } else if (isSuperchat) {
      var tier = wandScColor(ctx.superchatTier || 'blue');
      v.symMain = tier.main; v.symLight = tier.light; v.symDark = tier.dark; v.symGlow = tier.glow;
      v.amountHtml = '<div class="kh-wand-amount">' + esc(ctx.amountDisplay || ('¥' + amount)) + '</div>';
      if (stickerImage) {
        // スーパーステッカー: 画像を杖の先 (= シンボル位置) に表示
        v.symbolHtml = '<img src="' + esc(stickerImage) + '" style="width:72px;height:72px;object-fit:contain;filter:drop-shadow(0 0 10px ' + tier.glow + ');">';
      } else {
        v.symbolHtml = '⭐';
      }
    } else {
      // 通常コメ: シンボル + 色を spawn 毎にランダム選択 (= ユーザー設定プール or デフォルト)
      var pool = (wandSymbols && wandSymbols.length) ? wandSymbols : WAND_SYMBOLS;
      var ws = pool[Math.floor(Math.random() * pool.length)];
      v.symMain = ws.main; v.symLight = ws.light; v.symDark = ws.dark; v.symGlow = ws.glow;
      v.symbolHtml = ws.isImage
        ? '<img src="' + esc(ws.sym) + '" style="width:52px;height:52px;object-fit:contain;filter:drop-shadow(0 0 6px ' + ws.glow + ');">'
        : esc(ws.sym);
    }

    return v;
  }

  function init(c) {
    container = c;
    // ホログラム用 keyframes を document.head に 1 度だけ注入。
    // inline style では @keyframes が書けないため、 重複 inject 回避のため id ガード。
    if (!document.getElementById('kh-sprout-holo-styles')) {
      var st = document.createElement('style');
      st.id = 'kh-sprout-holo-styles';
      st.textContent =
        '@keyframes kh-holo-edge{0%{background-position:0% 50%;}100%{background-position:200% 50%;}}' +
        '@keyframes kh-holo-pulse{0%,100%{opacity:.55;transform:scale(.9);}50%{opacity:1;transform:scale(1.05);}}' +
        '@keyframes kh-holo-base-pulse{0%,100%{opacity:.55;}50%{opacity:1;}}' +
        '@keyframes kh-gacha-twinkle{0%,100%{opacity:.45;transform:scale(.75) rotate(0deg);}50%{opacity:1;transform:scale(1.2) rotate(20deg);}}' +
        '@keyframes kh-gacha-wobble{0%{transform:rotate(0deg);}18%{transform:rotate(-6deg);}35%{transform:rotate(4.5deg);}52%{transform:rotate(-3deg);}68%{transform:rotate(2deg);}82%{transform:rotate(-1.2deg);}92%{transform:rotate(.6deg);}100%{transform:rotate(0deg);}}';
      document.head.appendChild(st);
    }
    // テロップバー用 CSS を 1 度だけ注入 (= 走査線/サブチッカー/タグ質感/ランク・種別・tier パレット)
    if (!document.getElementById('kh-sprout-ticker-styles')) {
      var ts = document.createElement('style');
      ts.id = 'kh-sprout-ticker-styles';
      ts.textContent = TICKER_CSS;
      document.head.appendChild(ts);
    }
    // 魔法ステッキ用 CSS を 1 度だけ注入 (= シンボル発光 / キラキラ / 杖)
    if (!document.getElementById('kh-sprout-wand-styles')) {
      var ws = document.createElement('style');
      ws.id = 'kh-sprout-wand-styles';
      ws.textContent = WAND_CSS;
      document.head.appendChild(ws);
    }
  }

  function show(params, assets, data) {
    if (!container) return;

    var noOverlap = (data && data.noOverlap != null) ? data.noOverlap : true;
    var scaleFactor = ((data && data.scale) || 100) / 100;
    var stayDuration = (data && data.stayDuration != null) ? data.stayDuration : 3000; // 表示しきってから下がるまで(ms)
    var animSpeed = (data && data.animSpeed != null) ? data.animSpeed : 400;           // 出入りの速度(ms)
    var originX = (data && data.originX != null) ? data.originX : 50;                  // 表示位置X(0-100%)
    var displayWidth = (data && data.displayWidth != null) ? data.displayWidth : 80;   // 表示領域幅(0-100%)
    var tickerWidth = (data && data.tickerWidth != null) ? data.tickerWidth : 55;      // テロップ幅(0-100%、 ticker 専用)
    var centerExclusion = (data && data.centerExclusion != null) ? data.centerExclusion : 0; // 中央表示禁止幅(0-80%、 人物回避)
    var MAX_QUEUE = 1000;
    var duration = animSpeed + stayDuration + animSpeed; // 出現 + 待機 + 退場
    var ctx = (data && data.context) || {};
    // デザイン選択 (= 'bud' = 新芽デフォルト / 'holo' = ホログラム / 'gacha' / 'ticker')
    var design = (data && data.design) ? data.design : 'bud';
    var normalColor = (data && data.normalColor) ? data.normalColor : 'cyan';
    var bgOpacity = (data && data.bgOpacity != null) ? data.bgOpacity : 0;             // 吹き出し背景の濃さ(0-100%、 wand、 default OFF=雰囲気重視)
    var wandSymbols = (design === 'wand') ? buildWandSymbolPool(data) : null;          // wand のシンボル+色プール (= ユーザー設定 or デフォルト)
    var values = buildValues(ctx, design, normalColor, bgOpacity, wandSymbols);

    // キュー上限チェック（溢れたら捨てる）
    if (noOverlap && queue.length >= MAX_QUEUE) return;

    function resolveHtml(callback) {
      var htmlAsset = null;
      var hasNonHtmlAsset = false;
      if (assets && assets.length > 0) {
        for (var i = 0; i < assets.length; i++) {
          if (assets[i].indexOf('.html') !== -1) {
            htmlAsset = assets[i];
          } else {
            hasNonHtmlAsset = true;
          }
        }
      }

      if (htmlAsset) {
        if (templateCache[htmlAsset]) {
          callback(templateCache[htmlAsset]);
        } else {
          fetch(htmlAsset).then(function (r) { return r.text(); }).then(function (html) {
            templateCache[htmlAsset] = html;
            callback(html);
          }).catch(function () {
            callback(pickDefaultTemplate(values));
          });
        }
      } else if (hasNonHtmlAsset) {
        var asset = assets[Math.floor(Math.random() * assets.length)];
        if (asset.indexOf('/') !== -1 || asset.indexOf('.') !== -1) {
          callback('<div style="text-align:center;"><img src="' + esc(asset) + '" style="max-width:120px;max-height:120px;"></div>');
        } else {
          callback('<div style="font-size:48px;text-align:center;line-height:1;">' + asset + '</div>');
        }
      } else {
        // ユーザー asset 無し: 通常コメは design で分岐、 メンバー / スパチャ / ギフトは既存テンプレ
        callback(pickDefaultTemplate(values));
      }
    }

    function spawn() {
      if (noOverlap && spawnLock) {
        // 別のspawnが位置計算中 → キューに入れて待つ
        if (queue.length < MAX_QUEUE) queue.push(function () { spawn(); });
        return;
      }
      if (noOverlap) spawnLock = true;

      var regionId = Date.now() + '-' + Math.random();

      resolveHtml(function (html) {
        // SVG defs id の同時表示衝突を避けるため、 BUD_TEMPLATE 内 __NONCE__ を spawn 毎にユニーク化
        var nonce = Math.random().toString(36).slice(2, 10);
        html = html.replace(/__NONCE__/g, nonce);
        html = replacePlaceholders(html, values);

        // 1. 非表示で仮配置して実際の幅を計測
        var el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.bottom = '0px';
        el.style.left = '0px';
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
        el.style.zIndex = (data && data.zOrder) || 1;
        if (scaleFactor !== 1) el.style.transform = 'scale(' + scaleFactor + ')';
        el.innerHTML = html;
        container.appendChild(el);

        var actualW = (el.offsetWidth || 300) * scaleFactor;
        // wand は計測 (= offsetWidth、 transform 非含有) の後に .kh-wand-root へ
        // scale(1.5)+rotate(±30°) を適用するため、 actualW のまま配置すると実描画が
        // 予約より広く端で見切れる + 占有領域が過小で wand 同士が重なる。配置クランプと
        // 占有領域は scale(1.5) 込みの reserveW で予約し、 回転分の最終補正は下の
        // wand ブロックで実 bbox を計測して行う (= bottom-center 支点のスイング幾何は
        // 解析より実測が確実)。 elLeft の中心合わせは従来どおり actualW を使う。
        var reserveW = (design === 'wand') ? actualW * 1.5 : actualW;

        // 2. 位置決定
        var centerX;
        if (noOverlap) {
          centerX = pickRandomX(reserveW, originX, displayWidth, centerExclusion);
          if (centerX === -1) {
            // 空きなし → キューに入れて待つ
            el.remove();
            spawnLock = false;
            queue.push(function () { spawn(); });
            return;
          }
        } else {
          var half = reserveW / 2;
          var sw = window.innerWidth;
          if (centerExclusion > 0) {
            // 中央帯を避けて左右どちらかの領域からランダムに
            var ceHalf = sw * centerExclusion / 100 / 2;
            var leftMax = sw / 2 - ceHalf - half;   // 左領域の右端 (= 中心)
            var rightMin = sw / 2 + ceHalf + half;  // 右領域の左端 (= 中心)
            var leftOK = leftMax > half;
            var rightOK = rightMin < sw - half;
            if (leftOK && rightOK) {
              centerX = (Math.random() < 0.5)
                ? half + Math.random() * (leftMax - half)
                : rightMin + Math.random() * (sw - half - rightMin);
            } else if (leftOK) {
              centerX = half + Math.random() * (leftMax - half);
            } else if (rightOK) {
              centerX = rightMin + Math.random() * (sw - half - rightMin);
            } else {
              centerX = half + Math.random() * (sw - reserveW);
            }
          } else {
            centerX = half + Math.random() * (sw - reserveW);
          }
        }

        // 3. 占有領域を登録 → ロック解放
        // centerX は要素中心のピクセル座標。el の中心合わせは actualW、 占有領域は
        // reserveW (= wand は scale 込み) で登録する。wand は下で実 bbox に更新する。
        var elLeft = centerX - actualW / 2;
        var region = { left: centerX - reserveW / 2, right: centerX + reserveW / 2, id: regionId };
        activeRegions.push(region);
        spawnLock = false;

        // 4. 位置を設定して表示（left基準、translateXは使わない）
        el.style.left = elLeft + 'px';
        el.style.transformOrigin = 'bottom center';
        el.style.willChange = 'transform, opacity';
        el.style.visibility = '';

        // アニメーションのタイミングを動的に計算
        var scaleStr = scaleFactor !== 1 ? ' scale(' + scaleFactor + ')' : '';
        var enterEnd = animSpeed / duration;         // 出現完了
        var bounceEnd = (animSpeed + 100) / duration; // ポヨン
        var settleEnd = (animSpeed + 200) / duration; // 着地
        var stayEnd = (animSpeed + stayDuration) / duration; // 待機終了

        var anim = el.animate([
          { transform: 'translateY(100%)' + scaleStr, opacity: 0, offset: 0 },
          { transform: 'translateY(0)' + scaleStr, opacity: 1, offset: Math.min(enterEnd, 0.99) },
          { transform: 'translateY(-5px)' + scaleStr, opacity: 1, offset: Math.min(bounceEnd, 0.99) },
          { transform: 'translateY(0)' + scaleStr, opacity: 1, offset: Math.min(settleEnd, 0.99) },
          { transform: 'translateY(0)' + scaleStr, opacity: 1, offset: Math.min(stayEnd, 0.99) },
          { transform: 'translateY(100%)' + scaleStr, opacity: 0, offset: 1 }
        ], {
          duration: duration,
          easing: 'ease-in-out',
          fill: 'forwards'
        });
        anim.onfinish = function () {
          el.remove();
          removeRegion(regionId);
        };

        // ガチャは着地後 (= animSpeed ms 後) に底支点で左右ぐらぐら → 減衰。
        // el の translateY とは別要素 (= .kh-gacha-root の rotate) なので transform 競合しない。
        if (design === 'gacha') {
          var gachaRoot = el.querySelector('.kh-gacha-root');
          if (gachaRoot) {
            gachaRoot.style.animation = 'kh-gacha-wobble 700ms ease-out ' + animSpeed + 'ms 1 both';
          }
        }

        // 魔法ステッキは画面 X 位置に応じて外側ほど斜めに振りかざす (= 中央直立、 左右端で放射状)。
        // el の translateY とは別要素 (= .kh-wand-root の rotate) なので transform 競合しない。
        if (design === 'wand') {
          var wandRoot = el.querySelector('.kh-wand-root');
          if (wandRoot) {
            var frac = centerX / (window.innerWidth || 1920); // 0..1
            var angle = (frac - 0.5) * 2 * 30;                 // -30°..+30°
            if (angle > 30) angle = 30; else if (angle < -30) angle = -30;
            // ベースを 1.5 倍に (= サイズ slider の scaleFactor とは別、 wand のデフォルト拡大)
            wandRoot.style.transform = 'rotate(' + angle.toFixed(1) + 'deg) scale(1.5)';
            // scale(1.5)+rotate 適用後の実フットプリントを計測し、 画面外へはみ出す分だけ
            // el を内側へ寄せて見切れを防ぐ + 占有領域を実寸へ更新する (= bottom-center 支点の
            // 回転スイングは予約幅だけでは吸収しきれないため、 実 bbox 基準で最終補正)。
            // getBoundingClientRect は border-box 基準なので装飾の sparkle 微小はみ出しは
            // 対象外 (= 本文の見切れ防止が目的、 余白でカバー)。
            var swc = window.innerWidth || 1920;
            var edgeMargin = 12;
            var rrect = wandRoot.getBoundingClientRect();
            var shiftX = 0;
            if (rrect.left < edgeMargin) shiftX = edgeMargin - rrect.left;
            else if (rrect.right > swc - edgeMargin) shiftX = (swc - edgeMargin) - rrect.right;
            if (shiftX !== 0) {
              elLeft += shiftX;
              el.style.left = elLeft + 'px';
            }
            region.left = rrect.left + shiftX;
            region.right = rrect.right + shiftX;
          }
        }
      });
    }

    // テロップバーは単独表示 (= 中央 1 本)。 表示中は queue で順番待ち、 前の退場で次を pop。
    if (design === 'ticker') {
      var job = { values: values, animSpeed: animSpeed, stayDuration: stayDuration, duration: duration, originX: originX, tickerWidth: tickerWidth, zOrder: (data && data.zOrder) || 1, scaleFactor: scaleFactor };
      if (tickerBusy) {
        if (tickerQueue.length < TICKER_MAX_QUEUE) tickerQueue.push(job);
      } else {
        doSpawnTicker(job);
      }
      return;
    }

    spawn();
  }

  // テロップバー 1 本を中央配置で下から出す。 onfinish で次を pop。
  function doSpawnTicker(job) {
    if (!container) return;
    tickerBusy = true;
    var html = replacePlaceholders(TICKER_TEMPLATE, job.values);
    var el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.bottom = '0px';
    el.style.left = job.originX + '%';
    // 幅は scale で割って補正 → scale (サイズ) は高さ・フォントだけ拡大し、 横幅は tickerWidth% に固定
    var sf = job.scaleFactor || 1;
    el.style.width = (job.tickerWidth / sf) + '%';
    el.style.maxWidth = (96 / sf) + 'vw';
    el.style.zIndex = job.zOrder;
    el.style.pointerEvents = 'none';
    el.style.willChange = 'transform, opacity';
    el.innerHTML = html;
    el.style.transformOrigin = 'bottom center';
    container.appendChild(el);

    var enterEnd = job.animSpeed / job.duration;
    var stayEnd = (job.animSpeed + job.stayDuration) / job.duration;
    // サイズ slider (scale) を ticker でも反映 (= 下端中央基準で縮小、 中央配置を維持)
    var scaleStr = (job.scaleFactor && job.scaleFactor !== 1) ? ' scale(' + job.scaleFactor + ')' : '';
    var base = 'translateX(-50%)' + scaleStr + ' ';
    var anim = el.animate([
      { transform: base + 'translateY(110%)', opacity: 0, offset: 0 },
      { transform: base + 'translateY(0)', opacity: 1, offset: Math.min(enterEnd, 0.99) },
      { transform: base + 'translateY(0)', opacity: 1, offset: Math.min(stayEnd, 0.99) },
      { transform: base + 'translateY(110%)', opacity: 0, offset: 1 }
    ], { duration: job.duration, easing: 'ease-in-out', fill: 'forwards' });
    anim.onfinish = function () {
      el.remove();
      tickerBusy = false;
      if (overlayPaused) return;
      if (tickerQueue.length > 0) doSpawnTicker(tickerQueue.shift());
    };
  }

  var overlayPaused = false;
  function setPaused(val) {
    overlayPaused = val;
    if (!val) {
      processQueue();
      if (!tickerBusy && tickerQueue.length > 0) doSpawnTicker(tickerQueue.shift());
    }
  }

  return { init: init, show: show, setPaused: setPaused };
})();
