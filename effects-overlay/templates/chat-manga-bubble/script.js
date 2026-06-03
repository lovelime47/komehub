(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;

  // 表示位置 (左/右) と横幅は共通機構が処理する (runtime applyCommonLayout →
  // body.kh-pos-left/kh-pos-right + --kh-stage-width)。ふきだしの尻尾の向きは
  // style.css 側で body.kh-pos-right を見て左右反転する (= JS 配線不要)。

  function ensureCommentTemplate(id) {
    var template = document.getElementById(id);
    if (template) return template;
    template = document.createElement('template');
    template.id = id;
    template.innerHTML = ''
      + '<div class="comment">'
      + '  <img class="avatar" data-kh="avatar" alt="">'
      + '  <div class="bubble">'
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

  // rigid-board layout backend を有効化: renderless controller の経路に乗せ、
  // 全カードを単一 scrollOffset で同期スクロールする。useRigidScroll が true なら
  // controller 側で自動的に renderless 経路へ乗るが、明示性のため renderlessModel
  // も true で渡す。詳細: docs/architecture/rigid-scroll-engine.md
  runtime.starters.list({
    container: '#comments',
    maxComments: 8,
    cellTemplate: ensureCommentTemplate('comment-template'),
    styleId: 'chat-manga-bubble-config-style',
    renderlessModel: true,
    useRigidScroll: true,
    // ふきだしの tail (= 三角) は bubble の左右に飛び出す。card を container 内側に
    // 寄せて tail がクリップされないように両端の余白を確保する。
    // 値は --tail-len (0.85em) + --border-w (2.5px) ≈ 1em を上回るよう 1em に設定。
    cardLeft: '1em',
    cardRight: '1em',
    // scrollDuration: '0.15s',  // default
    // scrollEasing: 'cubic-bezier(0.12, 0, 0.32, 1)',  // default
    config: {
      maxComments: true,
      callbacks: {
        // commentGap は rigid backend の slot 間隔として動的反映する。
        // CSS var (--comment-gap) は内部 gap 値に届かないため callback 経由で setGap を呼ぶ。
        // helpers (= starter) の setGap を呼ぶ標準パターン (closure 不要)。
        commentGap: function (value, _config, helpers) {
          var n = typeof value === 'number' ? value : parseFloat(value);
          if (!isFinite(n) || n < 0) return;
          if (helpers && typeof helpers.setGap === 'function') helpers.setGap(n);
        }
      },
      cssVars: {
        paddingBottom: ['--padding-bottom', 'px'],
        paddingLeft: ['--padding-left', 'px'],
        paddingRight: ['--padding-right', 'px'],
        fontSize: ['--font-size', 'px'],
        nameSize: ['--name-size', 'em'],
        bubbleColor: '--bubble-bg',
        borderColor: '--border-color',
        nameColor: '--name-color',
        textColor: '--text-color',
        memberColorValue: '--member-color',
        // リソ/ポスター スタイルの背面板の色。既存の配色 (bubbleColor 等) とは独立した軸で、
        // bubbleStyle=riso のときだけ意味を持つ (= .style-riso CSS が --riso-accent を参照)。
        risoAccent: '--riso-accent'
      },
      // bubbleStyle (= ふきだしスタイル) を valueClass で container に反映。
      // 既定 manga はクラス無し (= 既存 CSS)、riso のとき style-riso を付与して上書きする。
      // directionClasses は内部で valueClass バインディングを生成する shorthand。
      directionClasses: {
        bubbleStyle: ['style-riso', 'container', 'riso']
      },
      toggleCssVars: {
        showAvatar: ['--avatar-display', 'block', 'none'],
        showBadge: ['--badge-display', 'inline', 'none'],
        showName: ['--name-display', 'inline', 'none']
      },
      toggleClasses: {
        nameInline: 'name-inline',
        memberColor: 'member-color',
        showName: 'show-name',
        showTail: 'show-tail'
      },
      backgroundImages: {
        backgroundImage: ['body', 'contain', 'left bottom', 'no-repeat']
      },
      customCss: true
    }
  });
})();
