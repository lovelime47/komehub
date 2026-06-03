(function () {
  'use strict';

  var animationClasses = ['kh-anim-slide-up', 'kh-anim-slide-left', 'kh-anim-fade-in', 'kh-anim-none'];

  function setText(selector, value, fallback) {
    var node = document.querySelector(selector);
    if (!node) return;
    node.textContent = value == null || value === '' ? fallback : String(value);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildHtml(rawComment, prevModel) {
    var plainText = rawComment.comment || '';
    if (prevModel && prevModel.raw && prevModel.raw.comment === plainText
      && prevModel.raw.commentHtml === rawComment.commentHtml
      && prevModel.display && prevModel.display.html) {
      return prevModel.display.html;
    }
    if (rawComment.commentHtml && rawComment.commentHtml !== plainText) {
      return rawComment.commentHtml;
    }
    return escapeHtml(plainText).replace(/\n/g, '<br>');
  }

  window.KomehubTemplateRuntime.htmlFirst.start({
    lifecycle: {
      enterActiveDelayMs: 32,
      leaveRemoveDelayMs: 240
    },
    config: {
      callbacks: {
        kickerText: function (value) { setText('.frame-kicker', value, 'SECTOR 7'); },
        headerText: function (value) { setText('.frame-title', value, 'COMMS'); },
        footerText: function (value) { setText('.frame-footer-text', value, 'SIGNAL 87% / OPS 0214Z'); },
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
        prefix = '◆ TIP ' + rawComment.amountDisplay;
      } else if (rawComment.isMembershipGift) {
        prefix = '◆ GIFT';
      } else if (rawComment.isMembership) {
        prefix = '◆ MEMBER';
      }
      return {
        display: {
          prefix: prefix,
          html: buildHtml(rawComment, prevModel)
        }
      };
    },
    afterBindComment: function (node, model, context) {
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
