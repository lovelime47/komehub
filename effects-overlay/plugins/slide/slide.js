/**
 * スライドエフェクト
 * 画面の一端から入り、反対側へ通り抜けて出ていく
 *
 * モード:
 *   asset (default)   = 個数指定でアセット (絵文字 / 画像 / 文字) を流す
 *   comment           = コメ本文を 1 件、色 + フォント指定で流す
 */
var Slide = (function () {
  var container;
  // 最近流した comment セルの Y position を記録 (= すれ違い表示で重なり防止)
  var recentCommentYPositions = [];

  function init(c) { container = c; }

  // HTML から text + img のみを残すサニタイズ (= sprout/fixed.js と同パターン)
  function sanitizeCommentHtml(html) {
    if (!html) return null;
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var result = document.createElement('span');
    function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3) {
          result.appendChild(document.createTextNode(child.textContent));
        } else if (child.nodeType === 1 && child.tagName === 'IMG') {
          var img = document.createElement('img');
          img.src = child.src;
          if (child.alt) img.alt = child.alt;
          img.style.height = '1em';
          img.style.verticalAlign = 'middle';
          img.style.margin = '0 1px';
          result.appendChild(img);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    }
    walk(temp);
    return result;
  }

  // 最近流した comment セルから minDistance 以上離れた Y を選ぶ (= 重なり防止)。
  // comment モードは縦に散らせる必要があるので spreadHeight 最低 30% を強制
  // (= ユーザー設定が 5% でも、 コメ流入時は事実上 30% で散らす)
  function pickCommentYPosition(originY, spreadHeight, duration) {
    // spreadHeight は配信者設定値そのまま使用 (= asset mode と同じ仕様)
    var effectiveSpread = spreadHeight;
    var now = Date.now();
    recentCommentYPositions = recentCommentYPositions.filter(function (r) {
      return r.expireAt > now;
    });
    var halfSpread = effectiveSpread / 2;
    var minY = Math.max(5, originY - halfSpread);
    var maxY = Math.min(95, originY + halfSpread);
    var minDistancePercent = Math.max(8, effectiveSpread / 9);

    // 制約を満たす候補がなければ「最も離れた候補」 を fallback (= random ではなく最大化、
    // 同時発火が多くても重なり最小化)
    var bestCandidate = null;
    var bestMinDist = -1;
    for (var attempt = 0; attempt < 20; attempt++) {
      var candidate = minY + Math.random() * (maxY - minY);
      var minDistToRecent = Infinity;
      for (var ri = 0; ri < recentCommentYPositions.length; ri++) {
        var d = Math.abs(recentCommentYPositions[ri].yPercent - candidate);
        if (d < minDistToRecent) minDistToRecent = d;
      }
      if (minDistToRecent >= minDistancePercent) {
        recentCommentYPositions.push({ yPercent: candidate, expireAt: now + duration });
        return candidate;
      }
      if (minDistToRecent > bestMinDist) {
        bestMinDist = minDistToRecent;
        bestCandidate = candidate;
      }
    }
    // 制約を満たせなくても、 「最も離れた候補」 で配置 (= 完全 random より重なりにくい)
    if (bestCandidate == null) bestCandidate = minY + Math.random() * (maxY - minY);
    recentCommentYPositions.push({ yPercent: bestCandidate, expireAt: now + duration });
    return bestCandidate;
  }

  function show(params, assets, data) {
    if (!container) return;

    var mode = (data && data.mode) || params.mode || 'comment';
    var zOrder = (data && data.zOrder) || 1;
    var direction = (data && data.direction) || params.direction || 'left';
    var baseWidth = params.width || 40;
    // 速度倍率: 0.2 〜 5.0 倍 (= 1.0 で基準時間 params.duration = 4000ms 全幅移動)。
    // 5.0 倍は基準の 5 倍速 = 800ms、 0.2 倍は 1/5 速 = 20000ms
    var baseDuration = params.duration || 4000;
    var speedMultiplier = (data && data.speedMultiplier != null) ? data.speedMultiplier : 1;
    if (speedMultiplier < 0.2) speedMultiplier = 0.2;
    var duration = baseDuration / speedMultiplier;
    // UI 上の「サイズ 100%」 を実サイズ 1.3 倍として扱う (= 配信者目線で 100% =
    // 視認性のある default、 内部で 1.3 倍補正してフォント / 絵文字サイズ拡大)
    var scaleFactor = ((data && data.scale) || 100) / 100 * 1.3;
    var width = baseWidth * scaleFactor;

    // 表示領域（Y位置）
    var originY = (data && data.originY != null) ? data.originY : 90;
    var spreadHeight = (data && data.spreadHeight != null) ? data.spreadHeight : 20;

    // モード別の事前判定
    var commentNode = null;
    var commentText = '';
    var commentColor = '';
    // フォントは両 mode 共通 (= asset mode の文字 asset でも適用)
    var commentFontFamily = (data && data.commentFontFamily) || 'default';
    var commentStrokeWidth = 30;
    var count;
    if (mode === 'comment') {
      var ctx = (data && data.context) || {};
      // カスタム絵文字対応: commentHtml を sanitize して img tag を残す。 空ならプレーン text fallback
      commentNode = ctx.commentHtml ? sanitizeCommentHtml(ctx.commentHtml) : null;
      commentText = ctx.comment || '';
      if (!commentNode && !commentText) return; // 本文が空ならスキップ (= 設定ミス時の事故防止)
      commentColor = (data && data.commentColor) || '#ffffff';
      // strokeWidth は文字サイズに対する % (= 0-100、 default 30 = fontSize の 30%)。
      // slider が parseInt 経路のため integer で持つ
      commentStrokeWidth = (data && data.commentStrokeWidth != null) ? data.commentStrokeWidth : 30;
      count = 1;
    } else {
      if (assets.length === 0) return;
      count = (data && data.count != null) ? data.count : 1;
    }

    for (var i = 0; i < count; i++) {
      (function (delay) {
        setTimeout(function () {
          var el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.pointerEvents = 'none';
          el.style.willChange = 'transform';
          el.style.backfaceVisibility = 'hidden';
          el.style.zIndex = zOrder;

          if (mode === 'comment') {
            // 個別 element transform 経路 (= 落下物 fall plugin と同じ GPU compositor
            // 経路)。 板 (= el) は GPU layer で移動のみ担当、 描画系 (= 文字 / stroke
            // / shadow) は子 span (= content) に閉じる。 canvas 経路と違って毎フレーム
            // CPU 再描画が発生しないため滑らか
            var fontSize = Math.max(width * 0.6, 12);
            var content = document.createElement('span');
            content.style.display = 'inline-block';
            content.style.fontSize = fontSize + 'px';
            content.style.lineHeight = '1';
            content.style.whiteSpace = 'nowrap';
            content.style.color = commentColor;
            // strokeWidth は文字サイズに対する % (= fontSize * (percent / 100))。
            // 旧 0-1.0 倍率値 (= < 1) との後方互換も保持
            var effectiveStrokePx = commentStrokeWidth < 1
              ? fontSize * commentStrokeWidth
              : fontSize * (commentStrokeWidth / 100);
            content.style.webkitTextStrokeWidth = effectiveStrokePx + 'px';
            content.style.webkitTextStrokeColor = 'rgba(0,0,0,0.95)';
            content.style.paintOrder = 'stroke fill';
            content.style.textShadow = '0 0 4px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.7), 0 0 14px rgba(0,0,0,0.4)';
            if (commentFontFamily && commentFontFamily !== 'default') {
              content.style.fontFamily = commentFontFamily;
            }
            if (commentNode) {
              content.appendChild(commentNode);
            } else {
              content.textContent = commentText;
            }
            el.appendChild(content);
          } else {
            var asset = assets[Math.floor(Math.random() * assets.length)];
            if (isImageUrl(asset)) {
              var img = document.createElement('img');
              img.src = asset;
              img.style.width = width + 'px';
              img.style.height = 'auto';
              el.appendChild(img);
            } else {
              // 不可視文字を除去（ZWJ、バリアントセレクタ等）
              var cleanAsset = asset.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');
              // 複数文字の場合はサイズを調整して1行に収める
              var charCount = Array.from(cleanAsset).length;
              var fontSize = charCount > 1 ? Math.max(width / charCount * 1.5, 12) : width;
              el.style.fontSize = fontSize + 'px';
              el.style.lineHeight = '1';
              el.style.textAlign = 'center';
              el.style.whiteSpace = 'nowrap';
              if (commentFontFamily && commentFontFamily !== 'default') {
                el.style.fontFamily = commentFontFamily;
              }
              el.textContent = cleanAsset;
            }
          }

          // Y位置: comment モードは重なり防止経路、 asset は従来通り random
          // 上下 5% マージン (= 文字高さ / 絵文字高さ分のはみ出し防止)
          var yPercent;
          if (mode === 'comment') {
            yPercent = pickCommentYPosition(originY, spreadHeight, duration);
          } else {
            var halfSpread = spreadHeight / 2;
            yPercent = originY - halfSpread + Math.random() * spreadHeight;
            yPercent = Math.max(5, Math.min(95, yPercent));
          }

          el.style.left = '0px';
          el.style.top = yPercent + '%';

          // 先に DOM 追加して実描画幅 (offsetWidth) を計測する。 コメントはテキスト幅
          // (whitespace:nowrap) が width 設定値と無関係に大きくなり得るため、 endPos を
          // 固定 width で算出すると「要素が反対端を抜け切る前に onfinish で消える」 不具合に
          // なる。 実幅で start/end を出し、 要素全体が画面外へ抜けてから remove する。
          container.appendChild(el);
          var screenW = window.innerWidth;
          var margin = 20;
          var elemWidth = el.offsetWidth || width;
          var startPos, endPos;
          if (direction === 'left') {
            startPos = screenW + margin;      // 右端の外から入る
            endPos = -elemWidth - margin;     // 左端を要素ごと完全に抜けるまで
          } else {
            startPos = -elemWidth - margin;   // 左端の外から入る
            endPos = screenW + margin;        // 右端を要素ごと完全に抜けるまで
          }

          // 移動距離に比例した duration にして、 コメント長に依らずスクロール速度 (px/s) を
          // 一定に保つ。 baseDuration は「画面幅 screenW を渡る基準時間」 とみなす。 これが
          // ないと、 実幅で移動距離が伸びた分だけ長いコメントが速くなりすぎる。
          var totalTravel = screenW + elemWidth + margin * 2;
          var animDuration = totalTravel * baseDuration / (Math.max(screenW, 1) * speedMultiplier);

          // シンプルな線形 transform animation。 GPU compositor が transform を
          // 直接処理するため滑らかにスクロールする
          el.style.transform = 'translate3d(' + Math.round(startPos) + 'px, 0, 0)';
          var anim = el.animate([
            { transform: 'translate3d(' + Math.round(startPos) + 'px, 0, 0)' },
            { transform: 'translate3d(' + Math.round(endPos) + 'px, 0, 0)' }
          ], {
            duration: animDuration,
            easing: 'linear',
            fill: 'forwards'
          });
          anim.onfinish = function () { el.remove(); };
        }, delay);
      })(i * (150 + Math.random() * 100));
    }
  }

  return { init: init, show: show };
})();
