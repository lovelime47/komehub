(function () {
  'use strict';

  window.KomehubTemplateRuntime.htmlFirst.start({
    lifecycle: {
      enterActiveDelayMs: 24,
      leaveRemoveDelayMs: 180
    },
    beforeCommitComment: function (rawComment, prevModel, context) {
      var prefix = '';
      if (rawComment.amountDisplay) {
        prefix = 'SUPER CHAT ' + rawComment.amountDisplay;
      } else if (rawComment.isMembership && rawComment.membershipHeader) {
        prefix = 'MEMBER';
      }
      return {
        display: {
          prefix: prefix,
          html: rawComment.commentHtml || rawComment.comment || '',
          themeKey: context.helpers.assignThemeKey(rawComment, prevModel, {
            themes: ['theme-cyan', 'theme-pink', 'theme-violet']
          })
        }
      };
    }
  });
})();
