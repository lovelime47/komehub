(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;

  /*
   * game-compact は Render 最小サンプルです。
   *
   * - HTML 側は #comments だけを用意する
   * - この関数で 1 コメント分の <template> を作る
   * - data-kh="..." の属性は runtime が name / text / avatar などを差し込む場所
   * - 見た目の変更は style.css、設定 UI との接続は starters.list の config に集約する
   */
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

  /*
   * starters.list は「縦に積むコメント表示」の最小入口です。
   * maxComments / direction / cellTemplate を渡すだけで、SSE 購読、DOM 追加、
   * 古いコメントの削除、コメントデータの bind を runtime が処理します。
   */
  runtime.starters.list({
    container: '#comments',
    maxComments: 10,
    direction: 'append',
    cellTemplate: ensureCommentTemplate('comment-template'),
    styleId: 'game-compact-config-style',
    config: {
      /* manifest.json の uiSchema と同じ key を、CSS 変数や class に接続します。 */
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
        /* toggle は CSS 変数にしておくと、CSS 側だけで表示/非表示を決められます。 */
        showAvatar: ['--avatar-display', 'block', 'none'],
        showBadge: ['--badge-display', 'inline', 'none'],
        showName: ['--name-display', 'inline', 'none']
      },
      toggleClasses: {
        /* レイアウトが変わる設定は class にします。 */
        nameInline: 'name-inline',
        memberColor: 'member-color'
      },
      directionClasses: {
        /* direction-down が付くと CSS 側で上から下へ積む表示になります。 */
        direction: 'direction-down'
      },
      backgroundImages: {
        backgroundImage: ['body', 'cover', 'center', 'no-repeat']
      },
      customCss: true
    }
  });
})();
