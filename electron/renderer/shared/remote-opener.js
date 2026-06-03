// === KomehubShared.openRemote — LAN リモート起動モーダル (確認 → QR/URL 表示) ===
//
// 設計: docs/architecture/remote-viewing-redesign.md §6
// ponout 画面の「スマホでポン出し操作」モーダル / 本体メイン画面の「スマホでコメ閲覧」モーダル
// の両方から呼ばれる共通 UI。LAN ポート開放警告 → 起動 → QR + URL 表示までを 1 関数で担う。
//
// 呼び出し例:
//   KomehubShared.openRemote({
//     confirmTitle: 'スマホ操作を有効にしますか？',
//     confirmParagraphs: ['説明 1', '説明 2', ...],
//     resultTitle: 'スマホで開く',
//     fetchInfo: () => api.startListenerRemote(),     // {ok, url, qrSvg} を返す Promise
//     getDismissed: () => api.ponout.getRemoteWarningDismissed(), // 確認スキップ設定取得
//     setDismissed: (val) => api.ponout.setRemoteWarningDismissed(val), // 永続化
//   });
//
// 確認スキップ設定 (= LAN ポート開放警告を次回スキップ) は ponout / コメ閲覧 で **共有**
// (= 同じ LAN ポート開放警告を意味する)。既存 api.ponout.* のキー名はそのまま流用。
(function () {
  'use strict';

  var ns = (window.KomehubShared = window.KomehubShared || {});

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var openerLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('RemoteOpener')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function closeModal() {
    var existing = document.getElementById('remoteModal');
    if (existing) existing.remove();
  }

  function setCopyHint(message, failed) {
    var hint = document.getElementById('remoteCopyHint');
    if (!hint) return;
    hint.textContent = message;
    hint.classList.toggle('failed', !!failed);
  }

  function fallbackCopyUrl(url) {
    var textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand && document.execCommand('copy')) {
        setCopyHint('URLをコピーしました', false);
      } else {
        setCopyHint('コピーできませんでした。URLを長押しして選択してください。', true);
      }
    } catch (_) {
      setCopyHint('コピーできませんでした。URLを長押しして選択してください。', true);
    } finally {
      textarea.remove();
    }
  }

  function copyUrl(url) {
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        setCopyHint('URLをコピーしました', false);
      }).catch(function () {
        fallbackCopyUrl(url);
      });
      return;
    }
    fallbackCopyUrl(url);
  }

  function showResult(opts, result) {
    closeModal();
    var modal = document.createElement('div');
    modal.className = 'remote-modal';
    modal.id = 'remoteModal';
    var qr = result && result.qrSvg ? result.qrSvg : '';
    var url = result && result.url ? result.url : '';
    modal.innerHTML = '<div class="remote-panel remote-result">'
      + '<h2>' + escapeHtml(opts.resultTitle || 'スマホで開く') + '</h2>'
      + '<div class="remote-qr">' + qr + '</div>'
      + '<button class="remote-url" id="remoteUrl" type="button" title="タップしてURLをコピー">' + escapeHtml(url) + '</button>'
      + '<div class="remote-copy-hint" id="remoteCopyHint">URLをタップするとコピーできます</div>'
      + '<p>スマホが同じ Wi-Fi / LAN に接続されていることを確認してから、QRコードを読み取ってください。</p>'
      + '<div class="remote-actions">'
      + '<button class="remote-confirm" type="button" id="remoteClose">閉じる</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(modal);
    document.getElementById('remoteClose').addEventListener('click', closeModal);
    document.getElementById('remoteUrl').addEventListener('click', function () {
      copyUrl(url);
    });
  }

  function showError(message) {
    closeModal();
    var modal = document.createElement('div');
    modal.className = 'remote-modal';
    modal.id = 'remoteModal';
    modal.innerHTML = '<div class="remote-panel">'
      + '<h2>リモートを開始できませんでした</h2>'
      + '<p>' + escapeHtml(message || 'Rust core が起動しているか確認してください。') + '</p>'
      + '<div class="remote-actions">'
      + '<button class="remote-confirm" type="button" id="remoteClose">閉じる</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(modal);
    document.getElementById('remoteClose').addEventListener('click', closeModal);
  }

  function startFromConfirm(opts, modal) {
    var confirmBtn = document.getElementById('remoteConfirm');
    var skipChk = document.getElementById('remoteSkipWarning');
    var skipChecked = !!(skipChk && skipChk.checked);
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '開始中...';
    }
    var savePref = (skipChecked && typeof opts.setDismissed === 'function')
      ? Promise.resolve(opts.setDismissed(true)).catch(function (err) { openerLog.debug('setDismissed rejected (catch swallow):', err); })
      : Promise.resolve();
    savePref.then(function () {
      return opts.fetchInfo();
    }).then(function (result) {
      if (!result || result.ok === false) {
        showError(result && result.error);
        return;
      }
      showResult(opts, result);
    }).catch(function (error) {
      showError(error && error.message);
    }).finally(function () {
      if (modal && modal.parentNode) modal.remove();
    });
  }

  function showConfirm(opts) {
    closeModal();
    var modal = document.createElement('div');
    modal.className = 'remote-modal';
    modal.id = 'remoteModal';
    var paragraphs = (opts.confirmParagraphs || []).map(function (p) {
      return '<p>' + escapeHtml(p) + '</p>';
    }).join('');
    modal.innerHTML = '<div class="remote-panel">'
      + '<h2>' + escapeHtml(opts.confirmTitle || 'スマホ操作を有効にしますか？') + '</h2>'
      + paragraphs
      + '<label class="remote-check"><input type="checkbox" id="remoteSkipWarning"> <span>次からこの確認を表示しない</span></label>'
      + '<div class="remote-actions">'
      + '<button class="remote-confirm" type="button" id="remoteConfirm">有効にしてQR表示</button>'
      + '<button class="remote-cancel" type="button" id="remoteCancel">キャンセル</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(modal);
    document.getElementById('remoteCancel').addEventListener('click', closeModal);
    document.getElementById('remoteConfirm').addEventListener('click', function () {
      startFromConfirm(opts, modal);
    });
  }

  ns.openRemote = function (opts) {
    opts = opts || {};
    if (typeof opts.fetchInfo !== 'function') {
      // eslint-disable-next-line no-console
      openerLog.error('[KomehubShared.openRemote] fetchInfo is required');
      return;
    }
    var getDismissed = (typeof opts.getDismissed === 'function')
      ? Promise.resolve(opts.getDismissed()).catch(function () { return false; })
      : Promise.resolve(false);
    getDismissed.then(function (dismissed) {
      if (dismissed) {
        startFromConfirm(opts, null);
      } else {
        showConfirm(opts);
      }
    });
  };

  ns.closeRemoteModal = closeModal;
})();
