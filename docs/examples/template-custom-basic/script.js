(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;
  var label = document.getElementById('label');
  var empty = document.getElementById('empty');
  var content = document.getElementById('content');
  var latestCommentId = '';

  // カスタム型では、renderLatestComment() の中身を自分の演出に合わせて自由に組めます。
  // ListController は必須ではありません。
  function clearStage() {
    latestCommentId = '';
    content.innerHTML = '';
    content.hidden = true;
    empty.hidden = false;
  }

  function renderLatestComment(comment) {
    latestCommentId = comment.id || '';
    content.innerHTML = '';

    var header = document.createElement('div');
    header.className = 'header';

    var avatar = runtime.parts.createAvatar(comment);
    if (avatar) header.appendChild(avatar);

    var meta = document.createElement('div');
    meta.className = 'meta';

    var name = runtime.parts.createName(comment, {
      text: comment.name || 'unknown'
    });
    if (name) meta.appendChild(name);

    var amount = runtime.parts.createAmount(comment);
    if (amount) meta.appendChild(amount);

    header.appendChild(meta);
    content.appendChild(header);

    var text = runtime.parts.createText(comment, { tagName: 'div' });
    if (text) {
      content.appendChild(text);
    } else {
      var fallback = document.createElement('div');
      fallback.className = 'text';
      fallback.textContent = '(本文なし)';
      content.appendChild(fallback);
    }

    empty.hidden = true;
    content.hidden = false;
  }

  runtime.starters.custom({
    styleId: 'sample-custom-config-style',
    config: {
      cssVars: {
        fontSize: ['--font-size', 'px'],
        accentColor: '--accent-color',
        panelColor: '--panel-color'
      },
      toggleCssVars: {
        showAvatar: ['--avatar-display', 'block', 'none']
      },
      customCss: true
    },
    onComments: function (comments) {
      if (!Array.isArray(comments) || comments.length === 0) return;
      renderLatestComment(comments[comments.length - 1]);
    },
    onDeleted: function (payload) {
      if (payload && payload.id && payload.id === latestCommentId) {
        clearStage();
      }
    },
    onClear: function () {
      clearStage();
    }
  });
})();
