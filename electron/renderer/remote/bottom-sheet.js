// === remote shared: bottom-sheet ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §5.7 (Phase A2)
//
// スマホ用の bottom-sheet overlay。 下から swipe up で出てくる UI 要素 (= 本体
// PC の center modal の代替)。 コメ検索の 4 popover (期間 / ユーザー / 配信枠 /
// タグ管理) と保存検索の作成ダイアログ等で共通利用する。
//
// API:
//   window.KomehubBottomSheet.open({
//     title: 'タイトル',
//     content: HTMLElement,             // body にレンダリングする要素
//     footer: HTMLElement | null,       // 任意。 確定/キャンセルボタンなどを置く
//     onClose: function() {},           // 閉じた時の callback (cancel/swipe-down 共通)
//     allowSwipeDown: true              // backdrop タップ・swipe down で閉じるか (default true)
//   })
//   → { close: function() {} }
//
// 設計判断:
//   - backdrop タップで閉じる (= cancel 扱い)
//   - スマホ縦の半分〜2/3 を占有。 内部スクロールで content の余白を吸収
//   - swipe down で閉じる手触り感は将来追加 (= touch event 制御。 現状は backdrop タップのみ)
//   - 1 度に 1 sheet のみ。 既に開いていれば前の sheet を close してから新 sheet を open
//   - body の z-index は rh-tabbar (= 10) より上、 max(20) を使う

(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var bottomSheetLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('BottomSheet')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var ns = window.KomehubBottomSheet = window.KomehubBottomSheet || {};

  var currentSheet = null; // { backdrop, sheet, opts }

  function open(opts) {
    if (!opts) opts = {};
    // 観点 I: bottom-sheet open を user 操作として記録 (= 詳細: docs/logging.md)
    bottomSheetLog.info('user: bottom-sheet-open, title=' + (opts.title || '(no title)'));
    // 既存があれば先に閉じる (= 切替時に直前のものを残さない)
    if (currentSheet) closeInternal(currentSheet, true);

    var backdrop = document.createElement('div');
    backdrop.className = 'rh-bs-backdrop';

    var sheet = document.createElement('div');
    sheet.className = 'rh-bs-sheet';

    // ハンドル (= 上端の灰色バー、 視覚的にスワイプできそうな印象)
    var handle = document.createElement('div');
    handle.className = 'rh-bs-handle';
    handle.setAttribute('aria-hidden', 'true');
    sheet.appendChild(handle);

    // header
    var header = document.createElement('div');
    header.className = 'rh-bs-header';
    var titleEl = document.createElement('div');
    titleEl.className = 'rh-bs-title';
    titleEl.textContent = opts.title || '';
    header.appendChild(titleEl);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'rh-bs-close';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function () { close(); });
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    // body
    var body = document.createElement('div');
    body.className = 'rh-bs-body';
    if (opts.content instanceof HTMLElement) {
      body.appendChild(opts.content);
    }
    sheet.appendChild(body);

    // footer (任意)
    if (opts.footer instanceof HTMLElement) {
      var footerEl = document.createElement('div');
      footerEl.className = 'rh-bs-footer';
      footerEl.appendChild(opts.footer);
      sheet.appendChild(footerEl);
    }

    // backdrop タップで閉じる
    var allowSwipeDown = opts.allowSwipeDown !== false;
    backdrop.addEventListener('click', function (ev) {
      if (!allowSwipeDown) return;
      if (ev.target !== backdrop) return;
      close();
    });

    // Esc 押下で閉じる (= 物理キーボードのある端末向け)
    function onKeyDown(ev) {
      if (ev.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);

    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);

    // 表示直後に open class を付ける (= transition 用)
    requestAnimationFrame(function () { backdrop.classList.add('open'); });

    var record = {
      backdrop: backdrop,
      sheet: sheet,
      opts: opts,
      onKeyDown: onKeyDown
    };
    currentSheet = record;

    function close() {
      closeInternal(record, false);
    }
    return { close: close };
  }

  function closeInternal(record, replacedImmediately) {
    if (!record) return;
    if (record !== currentSheet) {
      // 既に他の sheet に置き換わっていたら処理しない
      return;
    }
    document.removeEventListener('keydown', record.onKeyDown);
    record.backdrop.classList.remove('open');
    var done = function () {
      if (record.backdrop.parentNode) record.backdrop.parentNode.removeChild(record.backdrop);
      if (currentSheet === record) currentSheet = null;
      if (record.opts && typeof record.opts.onClose === 'function') {
        try { record.opts.onClose(); } catch (err) { bottomSheetLog.warn('onClose callback threw:', err); }
      }
    };
    if (replacedImmediately) {
      // 連続 open: animation を待たず即除去
      done();
    } else {
      // transition 待ち (= 200ms)
      setTimeout(done, 200);
    }
  }

  ns.open = open;
  ns.closeCurrent = function () {
    if (currentSheet) closeInternal(currentSheet, false);
  };
})();
