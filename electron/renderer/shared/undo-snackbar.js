// === KomehubShared / undo-snackbar ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §7
//
// 即時トグル + Snackbar Undo 共通実装。本体・remote 両方から使う。
//
// 仕様:
//   - 5 秒で自動消去 → undo 不可
//   - queue を作らず、最後の操作で上書き (= Material Design Snackbar 仕様準拠)
//   - 連続トグル時は最新の操作だけ undo 可能
//   - スタイルは shared/shared.css に定義 (= .kh-snackbar / .kh-snackbar-action 等)

(function () {
  'use strict';

  var ns = window.KomehubShared = window.KomehubShared || {};

  var currentEl = null;
  var hideTimer = null;
  var removeTimer = null;

  // 公開 API。複数回呼ばれた場合は最新のものに上書きする。
  // options = { message, actionLabel?, duration?, onAction? }
  //   message: 表示文字列 (必須)
  //   actionLabel: アクションボタン文字列 (省略時は「元に戻す」)
  //   duration: ms (省略時は 5000)
  //   onAction: アクションボタンタップ時のコールバック (省略時はボタン非表示)
  ns.showUndoSnackbar = function (options) {
    options = options || {};
    var message = options.message != null ? String(options.message) : '';
    var actionLabel = options.actionLabel != null ? String(options.actionLabel) : '元に戻す';
    var duration = typeof options.duration === 'number' ? options.duration : 5000;
    var onAction = typeof options.onAction === 'function' ? options.onAction : null;

    dismissCurrent(true);

    var el = document.createElement('div');
    el.className = 'kh-snackbar';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    var msgEl = document.createElement('span');
    msgEl.className = 'kh-snackbar-message';
    msgEl.textContent = message;
    el.appendChild(msgEl);

    if (onAction) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kh-snackbar-action';
      btn.textContent = actionLabel;
      btn.addEventListener('click', function () {
        try {
          onAction();
        } finally {
          dismissCurrent(false);
        }
      });
      el.appendChild(btn);
    }

    document.body.appendChild(el);
    currentEl = el;

    // CSS transition を効かせるため、次の frame で visible class を付ける
    requestAnimationFrame(function () {
      if (el.isConnected) el.classList.add('kh-snackbar-visible');
    });

    hideTimer = window.setTimeout(function () {
      hideTimer = null;
      dismissCurrent(false);
    }, duration);
  };

  // 既存 Snackbar を即時隠す (= 公開しないが内部で使う)。
  // immediate=true で transition なしに即削除 (= 上書き時)。
  function dismissCurrent(immediate) {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (removeTimer) {
      window.clearTimeout(removeTimer);
      removeTimer = null;
    }
    var el = currentEl;
    currentEl = null;
    if (!el || !el.isConnected) return;
    if (immediate) {
      el.remove();
      return;
    }
    el.classList.remove('kh-snackbar-visible');
    removeTimer = window.setTimeout(function () {
      removeTimer = null;
      if (el.isConnected) el.remove();
    }, 220);
  }

  // 外部から強制クリアしたい場合に呼ぶ (= テンプレ管理画面遷移時など)
  ns.dismissUndoSnackbar = function () {
    dismissCurrent(false);
  };
})();
