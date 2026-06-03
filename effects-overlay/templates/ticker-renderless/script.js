(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;

  /*
    設定 UI の animSpeed は文字列で届きます。
    ticker runtime の setTravelSeconds() は「1回の移動 transition にかける秒数」なので、
    数字が小さいほど速く流れます。
  */
  var ANIM_SPEEDS = { slow: 1.2, normal: 0.8, fast: 0.5 };

  /*
    glowCustomColor が未指定のときに使う候補色です。
    manifest.json の選択肢を増やす場合は、ここにも同じ key を追加します。
  */
  var GLOW_COLORS = {
    pink: [255, 100, 180],
    cyan: [0, 220, 255],
    gold: [255, 200, 50],
    green: [100, 255, 100],
    silver: [200, 210, 220]
  };
  var currentGlowRgb = GLOW_COLORS.cyan;
  var currentIntensity = 50;

  /*
    #rgb / #rrggbb の設定値を [r, g, b] に変換します。
    不正な値が来た場合は cyan に戻し、CSS 変数へ壊れた色を流さないようにします。
  */
  function hexToRgb(hex) {
    var value = String(hex || '').replace(/^#/, '');
    if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    var parsed = parseInt(value, 16);
    if (Number.isNaN(parsed)) return GLOW_COLORS.cyan;
    return [parsed >> 16 & 255, parsed >> 8 & 255, parsed & 255];
  }

  function setVar(root, key, value) {
    runtime.config.setVar(root, key, value);
  }

  /*
    glowIntensity と glowCustomColor から、CSS 側で使う光彩変数をまとめて更新します。

    変更しやすい値:
    - strokeW: 文字の縁取りの太さ
    - aCore / aMain: 光の濃さ
    - bCore / bMain: ぼかしの広がり
  */
  function applyGlow(root) {
    var rgb = currentGlowRgb || GLOW_COLORS.cyan;
    var t = (currentIntensity != null ? currentIntensity : 50) / 100;
    var strokeW = (0.03 + t * 0.02).toFixed(3);
    var aCore = (0.5 + t * 0.5).toFixed(2);
    var bCore = (0.1 + t * 0.2).toFixed(2);
    var aMain = (0.15 + t * 0.45).toFixed(2);
    var bMain = (0.3 + t * 0.5).toFixed(2);
    setVar(root, '--stroke-width', strokeW + 'em');
    setVar(root, '--glow-core', 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + aCore + ')');
    setVar(root, '--glow-main', 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + aMain + ')');
    setVar(root, '--blur-core', bCore + 'em');
    setVar(root, '--blur-main', bMain + 'em');
  }

  function recalcTicker(helpers) {
    /* fontSize や名前位置が変わると各コメントの幅/高さが変わるため、track の移動距離を再計算します。 */
    var ticker = helpers.ticker || helpers;
    if (ticker && ticker.recalcTrack) ticker.recalcTrack();
  }

  function setTravelSeconds(helpers, seconds) {
    /* runtime 側に移動 transition の秒数を渡します。CSS の --anim-duration も runtime が更新します。 */
    var ticker = helpers.ticker || helpers;
    if (ticker && ticker.setTravelSeconds) ticker.setTravelSeconds(seconds);
  }

  runtime.htmlFirst.start({
    /*
      mode: 'ticker' は横流れ starter を使う指定です。
      renderlessModel: true により、renderComment() ではなく index.html の <template> + data-kh で描画します。
    */
    mode: 'ticker',
    renderlessModel: true,

    /*
      padding は runtime の横流れ計算で使う余白です。
      CSS の #comments padding と見た目を合わせておくと、端で切れにくくなります。
    */
    padding: 24,

    /* 同時に保持するコメント数です。古いコメントは画面外へ出たあとに整理されます。 */
    maxComments: 8,

    /* 初期速度です。設定 UI の animSpeed callback で後から変更できます。 */
    travelSeconds: ANIM_SPEEDS.normal,

    /* 横移動の加減速です。旧 singing-glow 系に近い、入ってくる勢いのある動きにしています。 */
    transitionTiming: 'cubic-bezier(0.12, 0, 0, 1)',

    config: {
      callbacks: {
        positionY: function (value, _config, helpers) {
          /* 縦位置スライダーの値を #comments の bottom に反映します。 */
          if (value != null) runtime.config.setPxVar(helpers.container, 'bottom', value);
        },
        fontSize: function (_value, _config, helpers) {
          /* 文字サイズ変更後はコメント幅が変わるので、移動距離を再計算します。 */
          recalcTicker(helpers);
        },
        namePosition: function (value, _config, helpers) {
          /* name-bottom class で、名前行を本文の上/下に切り替えます。 */
          helpers.container.classList.toggle('name-bottom', value === 'bottom');
          recalcTicker(helpers);
        },
        glowIntensity: function (value, _config, helpers) {
          /* 光彩の強さだけ変わった場合も、色と一緒に CSS 変数を再生成します。 */
          currentIntensity = value != null ? value : 50;
          applyGlow(helpers.container);
        },
        glowCustomColor: function (value, _config, helpers) {
          /* カスタム色を RGB に変換し、光彩 CSS 変数へ反映します。 */
          currentGlowRgb = hexToRgb(value || '#00dcff');
          applyGlow(helpers.container);
        },
        animSpeed: function (value, _config, helpers) {
          /* slow / normal / fast を秒数に変換して ticker runtime へ渡します。 */
          setTravelSeconds(helpers, ANIM_SPEEDS[value] || ANIM_SPEEDS.normal);
        }
      }
    }
  });
})();
