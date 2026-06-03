/**
 * 花火エフェクト (entry)
 * 演出本体は同ディレクトリの firework-engine.js (window.FireworkEngine) = canvas パーティクル。
 * plugin-loader は entry (= firework.js) しか読まないため、ここから同プラグインディレクトリの
 * firework-engine.js を script タグで動的ロードする (エクスポートは plugins/firework/ を丸ごと同梱)。
 *
 * fire 時: スパチャ金額 → 金額帯 → その帯の「許可ショー」 から random に 1 つ選んで再生。
 * 金額帯の境界と各帯の許可ショーは uiSchema (data) で設定。 空選択の帯は花火なし。
 */
(function loadFireworkEngine() {
  if (typeof document === 'undefined') return;
  if (window.FireworkEngine) return;
  var self = document.currentScript;
  if (!self || !self.src) return;
  var base = self.src.replace(/[^/]*$/, '');
  var s = document.createElement('script');
  s.src = base + 'firework-engine.js?_=' + Date.now();
  s.onerror = function () { console.warn('[firework] firework-engine.js の読み込みに失敗しました'); };
  document.head.appendChild(s);
})();

var Firework = (function () {
  var container;
  // YouTube スパチャの色帯 (= ctx.superchatTier の値域)。 境界は YouTube 固定。
  var DEFAULT_TIER = {
    blue: ['small'], teal: ['small'], green: ['small', 'medium'], yellow: ['medium'],
    orange: ['medium', 'large'], magenta: ['large'], red: ['large', 'grand']
  };

  function init(c) { container = c; if (window.FireworkEngine) window.FireworkEngine.attach(c); }

  // 金額 → 色帯 (ctx.superchatTier が無い時のフォールバック。 YouTube の固定境界に一致)
  function tierFromAmount(a) {
    return a < 200 ? 'blue' : a < 500 ? 'teal' : a < 1000 ? 'green' : a < 2000 ? 'yellow'
      : a < 5000 ? 'orange' : a < 10000 ? 'magenta' : 'red';
  }

  // effect params (= uiSchema 値) を engine に反映。% スライダーは整数 (parseInt 経路) なので /100。
  // 未設定キーは applyConfig 側で skip され engine の既定値が使われる。
  function applyEngineConfig(params) {
    if (!window.FireworkEngine || !window.FireworkEngine.applyConfig) return;
    var p = params || {};
    window.FireworkEngine.applyConfig({
      opacity: typeof p.fwOpacity === 'number' ? p.fwOpacity / 100 : null,
      noZone: typeof p.fwNoZone === 'boolean' ? p.fwNoZone : null,
      noZoneW: typeof p.fwNoZoneWidth === 'number' ? p.fwNoZoneWidth / 100 : null
    });
  }

  function fire(params, assets, data) {
    if (!window.FireworkEngine) { console.warn('[firework] FireworkEngine 未ロード'); return; }
    window.FireworkEngine.attach(container);
    applyEngineConfig(params);
    var d = data || {};
    var ctx = d.context || {};
    var amount = ctx.amount || 0;

    var pool;
    if (amount > 0) {
      var tier = ctx.superchatTier || tierFromAmount(amount);
      pool = Array.isArray(d['tier_' + tier]) ? d['tier_' + tier] : (DEFAULT_TIER[tier] || []);
    } else {
      pool = Array.isArray(d.nonScShows) ? d.nonScShows : ['small', 'medium'];
    }

    if (!pool || pool.length === 0) return;   // 空選択 → 花火なし
    window.FireworkEngine.playShow(pool[(Math.random() * pool.length) | 0]);
  }

  return { init: init, fire: fire };
})();
