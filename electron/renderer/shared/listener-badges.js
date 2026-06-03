// === KomehubShared listener-badges ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §6.1 (= 「small primitive のみ」)
//
// listener row / detail で再利用する「リスナーバッジ」DOM ファクトリ群。
// row composition そのものは本体・remote が自前で組むので、ここでは小さい primitive
// (= rank / member / mod / label / greeted) だけを切り出す。
//
// API 値 → CSS クラス + ラベル文字列のマッピングは Rust 側 SSoT (= classify_listener_rank)
// と本体 renderer.js の systemTagLabel() に合わせる:
//   first-time  → first      / "新規"
//   returning   → returning  / "新参"
//   regular     → (class なし、 default amber) / "常連"
//   veteran     → veteran    / "古参"
//   comeback    → comeback   / "復帰"
//   abandoned   → abandoned  / "離脱"
//
// 本体側 ".lst-bg.tag-system.first" 等の selector はそのまま残し、 ここで作るのは
// 独立クラス ".kh-rank-badge.first" 等。 本体への影響ゼロを保つ。

(function () {
  'use strict';

  if (!window.KomehubShared) window.KomehubShared = {};
  var KS = window.KomehubShared;

  // ───── API systemTag 値 → CSS modifier class マッピング ─────
  // regular は modifier 無し (= default amber) なので空文字
  var RANK_CLASS_MAP = {
    'first-time': 'first',
    'returning': 'returning',
    'regular': '',
    'veteran': 'veteran',
    'comeback': 'comeback',
    'abandoned': 'abandoned'
  };

  // ───── API systemTag 値 → 表示ラベル マッピング ─────
  // 本体 renderer.js の systemTagLabel() と完全一致させる
  var RANK_LABEL_MAP = {
    'first-time': '新規',
    'returning': '新参',
    'regular': '常連',
    'veteran': '古参',
    'comeback': '復帰',
    'abandoned': '離脱'
  };

  /**
   * systemTag 値からランクバッジ DOM を生成する。
   * 未対応の値や null は null を返す (= 描画スキップ)。
   *
   * @param {string} systemTag - "first-time" / "returning" / "regular" / "veteran" / "comeback" / "abandoned"
   * @returns {HTMLSpanElement|null}
   */
  KS.createRankBadge = function (systemTag) {
    if (!systemTag || !Object.prototype.hasOwnProperty.call(RANK_LABEL_MAP, systemTag)) {
      return null;
    }
    var span = document.createElement('span');
    var cls = RANK_CLASS_MAP[systemTag];
    span.className = cls ? ('kh-rank-badge ' + cls) : 'kh-rank-badge';
    span.textContent = RANK_LABEL_MAP[systemTag];
    return span;
  };

  /**
   * メンバーバッジ DOM (= 👑 + 累計月数)。
   * @param {number} months - memberMonthsMax (= 0 でも表示する、 未加入時は呼び出し側で skip)
   */
  KS.createMemberBadge = function (months) {
    var span = document.createElement('span');
    span.className = 'kh-listener-badge member';
    span.textContent = '👑 ' + (months || 0) + 'mo';
    return span;
  };

  /**
   * モデレーターバッジ DOM。
   */
  KS.createModeratorBadge = function () {
    var span = document.createElement('span');
    span.className = 'kh-listener-badge moderator';
    span.textContent = 'モデ';
    return span;
  };

  /**
   * ユーザー設定ラベル バッジ DOM (= 任意のテキストラベル)。
   * 内容はテキストノードで設定するため XSS 安全。
   *
   * @param {string} label - 表示テキスト
   */
  KS.createLabelBadge = function (label) {
    if (!label) return null;
    var span = document.createElement('span');
    span.className = 'kh-listener-badge label';
    span.textContent = label;
    return span;
  };

  /**
   * 対応済みバッジ DOM (= ✓ 対応済み)。
   * 主に listener row / detail で「現枠で挨拶済み」状態を示す。
   */
  KS.createGreetedBadge = function () {
    var span = document.createElement('span');
    span.className = 'kh-listener-badge greeted';
    span.textContent = '✓ 対応済み';
    return span;
  };

  // ───── 直接マッピング参照 (= ラベルだけ欲しい時など) ─────
  KS.rankTagLabel = function (systemTag) {
    return RANK_LABEL_MAP[systemTag] || '';
  };
  KS.rankTagClass = function (systemTag) {
    return RANK_CLASS_MAP[systemTag] || '';
  };
})();
