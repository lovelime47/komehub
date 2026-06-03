// === KomehubShared / comment-sanitize ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §6
//
// コメント HTML の sanitize。本体 renderer.js と remote (将来) 両方から使う。
// 純粋関数: 副作用なし、注入なしで動く。

(function () {
  'use strict';

  var ns = window.KomehubShared = window.KomehubShared || {};

  // YouTube からのコメント HTML には絵文字 <img> とテキストだけが期待値。
  // script / その他のタグは落とし、img と text のみを再構築する。
  ns.sanitizeCommentHtml = function (html) {
    var input = document.createElement('div');
    var output = document.createElement('div');
    input.innerHTML = html;

    function appendSafe(node, parent) {
      if (node.nodeType === 3) {
        parent.appendChild(document.createTextNode(node.textContent || ''));
        return;
      }
      if (node.nodeType !== 1) return;

      var tagName = node.tagName;
      if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'TEMPLATE') {
        return;
      }
      if (tagName === 'IMG') {
        var src = node.getAttribute('src') || '';
        if (!src) return;
        var img = document.createElement('img');
        img.className = 'comment-emoji';
        img.setAttribute('src', src);
        img.setAttribute('alt', node.getAttribute('alt') || '');
        parent.appendChild(img);
      } else if (node.childNodes && node.childNodes.length) {
        node.childNodes.forEach(function (child) {
          appendSafe(child, parent);
        });
      }
    }

    input.childNodes.forEach(function (node) {
      appendSafe(node, output);
    });
    return output.innerHTML;
  };
})();
