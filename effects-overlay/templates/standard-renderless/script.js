(function () {
  'use strict';

  window.KomehubTemplateRuntime.htmlFirst.start({
    lifecycle: {
      enterActiveDelayMs: 24,
      leaveRemoveDelayMs: 200
    },
    beforeCommitComment: function (rawComment, prevModel, context) {
      return {
        display: {
          html: rawComment.commentHtml || rawComment.comment || ''
        }
      };
    }
  });
})();
