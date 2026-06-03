(function () {
  'use strict';

  /*
    このテンプレートでは、コメントごとにカードのテーマ色と左レールの icon を変えます。
    key は CSS の [data-kh-theme="..."] と themeAssets の key にも使うので、追加/削除するときは
    style.css と下の themeAssets も同じ名前で揃えます。
  */
  var THEME_LABELS = {
    'theme-teal': 'MINT',
    'theme-violet': 'VIOLET',
    'theme-sunset': 'SUNSET'
  };
  var THEME_KEYS = Object.keys(THEME_LABELS);

  /*
    themeMode が rotate のときは空文字にして、コメントごとに順番でテーマを割り当てます。
    teal / violet / sunset のような固定モードでは、そのテーマを全コメントに使います。
  */
  var fixedTheme = '';

  /*
    typing-char の HTML を自前で組み立てるため、通常テキストは必ず escape します。
    rawComment.commentHtml をそのまま使う分岐では、runtime 側で生成済みの HTML を信頼しています。
  */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /*
    コメント本文を 1 文字ずつ <span class="typing-char"> に分解します。

    重要な挙動:
    - --char-index を CSS に渡し、文字ごとに animation-delay をずらします。
    - 同じ id のコメントが再送された場合、prevModel.display.html を再利用します。
      これにより既存カードの typing animation が更新のたびに最初から再生されるのを避けます。
    - rawComment.commentHtml が plain text と違う場合は、emoji 画像などを含む HTML を優先します。
      この場合は文字ごとの typing span にはしません。
  */
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

  /*
    カードのテーマを決めます。
    context.helpers.assignThemeKey() は runtime が用意している helper で、
    prevModel があるときは前回の themeKey を維持し、新規コメントでは themes を順番に割り当てます。
  */
  function resolveTheme(rawComment, prevModel, context) {
    if (fixedTheme) {
      return fixedTheme;
    }
    return context.helpers.assignThemeKey(rawComment, prevModel, {
      themes: THEME_KEYS
    });
  }

  /*
    roleLabel は画面上部の小さな pill 表示です。
    空文字を返すと index.html の data-kh-empty="hide" により非表示になります。
  */
  function roleLabel(rawComment) {
    if (rawComment.isOwner) return 'OWNER';
    if (rawComment.isModerator) return 'MOD';
    if (rawComment.isMember || rawComment.isMembership) return 'MEMBER';
    return '';
  }

  /*
    noticeLabel はカード本文の上に出す強調メッセージです。
    スパチャ、メンバーシップギフト、メンバー加入だけに表示します。
  */
  function noticeLabel(rawComment) {
    if (rawComment.amountDisplay) return 'SUPER CHAT ' + rawComment.amountDisplay;
    if (rawComment.isMembershipGift) return 'MEMBERSHIP GIFT';
    if (rawComment.isMembership) return rawComment.membershipHeader || 'NEW MEMBER';
    return '';
  }

  window.KomehubTemplateRuntime.htmlFirst.start({
    /*
      rigid-board layout backend に切替: 全カードを単一 scrollOffset で同期スクロール。
      個別カードの `.is-leaving` 退場アニメと `.comment-move` FLIP は無効になり、
      退場は scrollOffset 進行で container 上端を超えたカードを自然消滅させる。
      cardGap (manifest uiSchema) は config callback から rigid backend の gap に反映する。
      詳細: docs/architecture/rigid-scroll-engine.md
    */
    useRigidScroll: true,
    gap: 12,
    paddingTop: 8,
    paddingBottom: 8,
    cardLeft: '0',
    cardRight: '0',
    maxComments: 15,
    lifecycle: {
      enterActiveDelayMs: 32,
      // rigid では退場アニメなし。leaveRemoveDelayMs は明示的 removeById 経由でも
      // 即削除される。維持はしているが効きはしない。
      leaveRemoveDelayMs: 0
    },
    config: {
      callbacks: {
        cardGap: function (value, _config, helpers) {
          var n = typeof value === 'number' ? value : parseFloat(value);
          if (!isFinite(n) || n < 0) return;
          if (helpers && typeof helpers.setGap === 'function') helpers.setGap(n);
        },
        /*
          themeMode は CSS 変数だけでは完結せず、以後のコメントに割り当てる themeKey を変える設定です。
          そのため cssVars ではなく callback で fixedTheme を更新します。
        */
        themeMode: function (value) {
          var mode = String(value || 'rotate');
          var nextTheme = 'theme-' + mode;
          fixedTheme = mode === 'rotate' || !THEME_LABELS[nextTheme] ? '' : nextTheme;
        }
      }
    },
    /*
      themeAssets は display.themeKey に応じて CSS 変数へ asset URL を流し込みます。
      .theme-icon は CSS の background-image: var(--theme-icon-image) でこの値を使います。
    */
    themeAssets: {
      '_common': {
        '--theme-icon-image': 'assets/icon-common.svg'
      },
      'theme-teal': {
        '--theme-icon-image': 'assets/icon-teal.svg'
      },
      'theme-violet': {
        '--theme-icon-image': 'assets/icon-violet.svg'
      },
      'theme-sunset': {
        '--theme-icon-image': 'assets/icon-sunset.svg'
      }
    },
    /*
      beforeCommitComment は「runtime の標準 model にはない、表示専用の値」を足す場所です。
      index.html では display.html / display.role / display.notice / display.themeLabel を data-kh で読んでいます。
    */
    beforeCommitComment: function (rawComment, prevModel, context) {
      var themeKey = resolveTheme(rawComment, prevModel, context);
      return {
        display: {
          html: buildTypingHtml(rawComment, prevModel),
          role: roleLabel(rawComment),
          notice: noticeLabel(rawComment),
          themeKey: themeKey
        }
      };
    },
    /*
      afterBindComment は DOM に値が差し込まれた後の hook です。
      ここではスパチャだけ .is-paid-pulse を一時的に付け、CSS の pulse animation を再生します。
      context.effects を使うと、コメント削除時の cleanup と timer の管理を runtime に任せられます。
    */
    afterBindComment: function (node, model, context) {
      if (!node || !model || !model.raw || !model.raw.amountDisplay) return;
      context.effects.addClass('paid-pulse', 'is-paid-pulse', {
        removeOnPhases: ['leaving']
      });
      context.effects.setTimeout('paid-pulse-timeout', 1000, function (effectContext) {
        if (effectContext.node && effectContext.node.classList) {
          effectContext.node.classList.remove('is-paid-pulse');
        }
      });
    }
  });
})();
