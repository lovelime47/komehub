(function () {
  'use strict';

  var animationClasses = ['kh-anim-slide-up', 'kh-anim-fade-in', 'kh-anim-none'];

  function setText(selector, value, fallback) {
    var node = document.querySelector(selector);
    if (!node) return;
    node.textContent = value == null || value === '' ? fallback : String(value);
  }

  /* HH:MM:SS の 24 時間表記。ターミナル風に短く */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function formatClock(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* CRT 演出: 1 文字ずつタイピング表示で、ターミナルらしくテキストが流れる雰囲気を出す。
     既存 framed-list-renderless と同じパターン (style.css の .typing-char と対) */
  function buildTypingHtml(rawComment, prevModel) {
    var plainText = rawComment.comment || '';
    if (prevModel && prevModel.raw && prevModel.raw.comment === plainText
      && prevModel.raw.commentHtml === rawComment.commentHtml
      && prevModel.display && prevModel.display.html) {
      return prevModel.display.html;
    }
    if (rawComment.commentHtml && rawComment.commentHtml !== plainText) {
      return rawComment.commentHtml;
    }
    return Array.from(plainText).map(function (char, index) {
      if (char === '\n') return '<br>';
      return '<span class="typing-char" style="--char-index:' + index + '">' + escapeHtml(char) + '</span>';
    }).join('');
  }

  window.KomehubTemplateRuntime.htmlFirst.start({
    lifecycle: {
      enterActiveDelayMs: 32,
      leaveRemoveDelayMs: 240
    },
    config: {
      callbacks: {
        kickerText: function (value) { setText('.frame-kicker', value, 'SYSTEM v2.1'); },
        headerText: function (value) { setText('.frame-title', value, '$ chat --live'); },
        animationStyle: function (value, _config, helpers) {
          var selected = value ? 'kh-anim-' + String(value) : 'kh-anim-slide-up';
          if (!helpers.container || !helpers.container.classList) return;
          animationClasses.forEach(function (cls) { helpers.container.classList.remove(cls); });
          helpers.container.classList.add(selected);
        }
      }
    },
    beforeCommitComment: function (rawComment, prevModel) {
      var prefix = '';
      if (rawComment.amountDisplay) {
        prefix = '$ tip ' + rawComment.amountDisplay;
      } else if (rawComment.isMembershipGift) {
        prefix = '$ gift';
      } else if (rawComment.isMembership) {
        prefix = '$ subscribe';
      }
      return {
        display: {
          prefix: prefix,
          html: buildTypingHtml(rawComment, prevModel)
        }
      };
    },
    afterBindComment: function (node, model, context) {
      /* 最終コメント時刻をフッターに反映 ($ last HH:MM:SS) */
      setText('.frame-footer-text', '$ last ' + formatClock(new Date()), '$ waiting for input...');

      if (!node || !model || !model.raw || !model.raw.amountDisplay) return;
      context.effects.addClass('paid-highlight', 'is-paid-highlight', { removeOnPhases: ['leaving'] });
      context.effects.setTimeout('paid-highlight-timeout', 900, function (effectContext) {
        if (effectContext.node && effectContext.node.classList) {
          effectContext.node.classList.remove('is-paid-highlight');
        }
      });
    }
  });
})();
