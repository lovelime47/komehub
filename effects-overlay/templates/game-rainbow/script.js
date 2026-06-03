(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;
  var DEFAULT_RAINBOW_COLORS = [
    '#e8a87c', '#7eb8da', '#c9b1ff', '#82d882',
    '#f472b6', '#fbbf24', '#67e8f9'
  ];

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

  function hashNameColor(name, colors) {
    var hash = 0;
    for (var i = 0; i < name.length; i += 1) {
      hash = ((hash << 5) - hash) + name.charCodeAt(i);
      hash |= 0;
    }
    return colors[Math.abs(hash) % colors.length];
  }

  runtime.starters.list({
    container: '#comments',
    maxComments: 10,
    direction: 'append',
    cellTemplate: ensureCommentTemplate('comment-template'),
    styleId: 'game-rainbow-config-style',
    config: {
      maxComments: true,
      cssVars: {
        fontSize: ['--font-size', 'px'],
        nameSize: ['--name-size', 'em'],
        lineHeight: '--line-height',
        commentGap: ['--comment-gap', 'px'],
        nameFont: '--name-font-family',
        textFont: '--text-font-family',
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
    },
    onConfig: function (config, starter) {
      starter.customNameColor = typeof config.nameColor === 'string' ? config.nameColor.trim() : '';
      starter.memberColorEnabled = !!config.memberColor;
      starter.rainbowColors = DEFAULT_RAINBOW_COLORS.map(function (fallback, index) {
        var key = 'color' + String(index + 1);
        return config[key] || fallback;
      });
    },
    afterRenderComment: function (comment, node, starter) {
      var nameNode = node && node.querySelector ? node.querySelector('.name') : null;
      if (!nameNode) return node;
      var useDynamicColor = !node.classList.contains('is-superchat')
        && !node.classList.contains('is-membership')
        && !node.classList.contains('is-moderator')
        && !node.classList.contains('is-owner')
        && !(starter.memberColorEnabled && node.classList.contains('is-member'));
      if (useDynamicColor) {
        nameNode.style.color = starter.customNameColor
          || hashNameColor(comment && comment.name ? comment.name : '', starter.rainbowColors || DEFAULT_RAINBOW_COLORS);
      } else {
        nameNode.style.removeProperty('color');
      }
      return node;
    }
  });
})();
