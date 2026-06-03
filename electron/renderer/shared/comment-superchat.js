// === KomehubShared / comment-superchat ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §6
//
// スパチャ / メンバーシップ / ギフトの判定と tier 色テーブル。
// 本体 renderer.js と remote (将来) 両方から使う。純粋関数: 副作用なし、注入なし。

(function () {
  'use strict';

  var ns = window.KomehubShared = window.KomehubShared || {};

  // YouTube tier 色テーブル (= 配信に出る色と一致させる)
  function tierColorMap() {
    return {
      blue: { bg: '#1565c0', fg: '#ffffff', muted: 'rgba(255, 255, 255, 0.82)' },
      teal: { bg: '#00bfa5', fg: '#06111a', muted: 'rgba(6, 17, 26, 0.78)' },
      green: { bg: '#1de9b6', fg: '#06111a', muted: 'rgba(6, 17, 26, 0.78)' },
      yellow: { bg: '#ffb300', fg: '#06111a', muted: 'rgba(6, 17, 26, 0.78)' },
      orange: { bg: '#f57c00', fg: '#06111a', muted: 'rgba(6, 17, 26, 0.82)' },
      magenta: { bg: '#e91e63', fg: '#ffffff', muted: 'rgba(255, 255, 255, 0.82)' },
      red: { bg: '#e62117', fg: '#ffffff', muted: 'rgba(255, 255, 255, 0.82)' }
    };
  }

  function tierFromColor(color) {
    var normalized = String(color || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === '#1565c0') return 'blue';
    if (normalized === '#00bfa5') return 'teal';
    if (normalized === '#1de9b6') return 'green';
    if (normalized === '#ffb300' || normalized === '#ffca28') return 'yellow';
    if (normalized === '#e65100' || normalized === '#f57c00') return 'orange';
    if (normalized === '#c2185b' || normalized === '#e91e63') return 'magenta';
    if (normalized === '#e62117' || normalized === '#ff0000') return 'red';
    return '';
  }

  function tierFromAmount(amount, currency) {
    var value = Number(amount) || 0;
    if (value <= 0) return '';
    var key = String(currency || '¥').trim();
    var thresholds = [100, 200, 500, 1000, 2000, 5000, 10000];
    if (key === '$' || key === 'USD' || key === 'US$') thresholds = [1, 2, 5, 10, 20, 50, 100];
    if (key === '€' || key === 'EUR' || key === '£' || key === 'GBP') thresholds = [1, 2, 5, 10, 20, 50, 100];
    var tiers = ['blue', 'teal', 'green', 'yellow', 'orange', 'magenta', 'red'];
    for (var i = thresholds.length - 1; i >= 0; i--) {
      if (value >= thresholds[i]) return tiers[i];
    }
    return 'blue';
  }

  function tierFromGiftCount(giftCount) {
    var value = Number(giftCount) || 0;
    if (value <= 0) return 'teal';
    return tierFromAmount(value * 500, '¥');
  }

  ns.commentSuperchatTierColorMap = tierColorMap;
  ns.commentTierFromColor = tierFromColor;
  ns.commentTierFromAmount = tierFromAmount;
  ns.commentTierFromGiftCount = tierFromGiftCount;

  // SC / メンバーシップ / ギフトのいずれか = 課金コメ
  ns.isCommentSuperchat = function (data) {
    return !!(data && (data.hasGift || data.amountDisplay || data.amount > 0 || data.isMembership || data.isMembershipGift));
  };

  // 課金コメの背景・前景・muted 色を返す
  // メンバーシップ継続 / メンバーシップギフト / 通常 SC をすべて区別する
  ns.commentSuperchatColors = function (data) {
    if (data && data.isMembership && !data.isMembershipGift && !(data.amount > 0)) {
      return { bg: '#0f9d58', fg: '#ffffff', muted: 'rgba(255, 255, 255, 0.84)' };
    }
    // ギフト (= 贈り主) は課金なのでスパチャと同じ扱い。推定金額 (amount > 0) が付く
    // 自チャンネル枠では下の汎用 SC 経路で金額ベースの tier 色になる (= 金額で色が変わる、
    // これは好ましい挙動)。推定金額が付かない他チャンネル枠 (amount == 0) のみ、ここで
    // ギフト個数ベースの色にフォールバックする。
    if (data && data.isMembershipGift && !(data.amount > 0)) {
      var giftTier = tierFromGiftCount(data.giftCount);
      var giftMap = tierColorMap();
      return giftMap[giftTier] || giftMap.teal;
    }
    var tier = data && data.superchatTier ? String(data.superchatTier) : '';
    if (!tier && data && data.tierColor) tier = tierFromColor(data.tierColor);
    if (!tier && data && data.amount > 0) tier = tierFromAmount(data.amount, data.currency || '¥');
    var map = tierColorMap();
    return map[tier] || map.yellow;
  };

  // 課金コメの金額 / メンバ加入 / ギフト数の表示文字列
  ns.commentSuperchatAmountText = function (data) {
    if (!data) return '';
    if (data.amountDisplay) return data.amountDisplay;
    if (data.amount > 0) {
      return (data.currency || '¥') + data.amount;
    }
    if (data.isMembership) {
      return data.membershipHeader || 'メンバー加入';
    }
    if (data.isMembershipGift && data.giftCount) {
      return 'ギフト ' + data.giftCount;
    }
    return '';
  };
})();
