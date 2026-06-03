(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;

  function ensureCommentTemplate(id) {
    var template = document.getElementById(id);
    if (template) return template;
    template = document.createElement('template');
    template.id = id;
    template.innerHTML = ''
      + '<div class="comment">'
      + '  <img class="avatar" data-kh="avatar" alt="">'
      + '  <div class="body-wrap">'
      + '    <span class="name-wrap">'
      + '      <img class="badge" data-kh="badge" alt="">'
      + '      <span class="name" data-kh="name"></span>'
      + '      <span class="amount" data-kh="amount"></span>'
      + '    </span>'
      + '    <div class="membership-header" data-kh="membershipHeader"></div>'
      + '    <span class="text" data-kh="text"></span>'
      + '    <img class="sticker" data-kh="sticker" alt="">'
      + '  </div>'
      + '</div>';
    document.body.appendChild(template);
    return template;
  }

  runtime.starters.list({
    container: '#comments',
    maxComments: 20,
    direction: 'append',
    cellTemplate: ensureCommentTemplate('comment-template'),
    styleId: 'game-fps-config-style',
    config: {
      maxComments: true,
      cssVars: {
        fontSize: ['--font-size', 'px'],
        nameSize: ['--name-size', 'em'],
        lineHeight: '--line-height',
        commentGap: ['--comment-gap', 'px'],
        nameFont: '--name-font-family',
        textFont: '--text-font-family',
        nameColor: '--name-color',
        textColor: '--text-color',
        memberColorValue: '--member-color'
      },
      toggleCssVars: {
        showAvatar: ['--avatar-display', 'block', 'none'],
        showBadge: ['--badge-display', 'inline', 'none'],
        showName: ['--name-display', 'inline', 'none']
      },
      toggleClasses: {
        nameInline: 'name-inline',
        memberColor: 'member-color'
      },
      directionClasses: {
        direction: 'direction-down'
      },
      backgroundImages: {
        backgroundImage: ['body', 'cover', 'center', 'no-repeat']
      },
      customCss: true
    }
  });
})();
