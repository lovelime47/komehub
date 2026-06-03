(function () {
  'use strict';

  var animationClasses = [
    /*
      animationStyle 設定で切り替えるテンプレート側の preset class 一覧です。
      manifest.json の animationStyle options と揃えます。
      新しい選択肢を増やす場合は manifest.json、ここ、style.css の class を揃えます。
    */
    'kh-anim-slide-up',
    'kh-anim-slide-down',
    'kh-anim-slide-left',
    'kh-anim-slide-right',
    'kh-anim-fade-in',
    'kh-anim-pop',
    'kh-anim-scale-in',
    'kh-anim-blur',
    'kh-anim-none'
  ];
  // 表示位置 (左/右) と幅は共通機構が処理する (runtime applyCommonLayout →
  // body.kh-pos-left/kh-pos-right + config.width)。body flex で panel を左右に寄せる
  // のは style.css 側で body.kh-pos-* を見て行う (= JS 配線不要)。

  /*
    headerText / footerText の設定値を、固定ヘッダー/フッターの DOM に反映する helper です。
    selector が見つからない場合は何もしないので、HTML から該当要素を削除しても壊れません。
    value が空なら fallback を使い、画面上に空見出しが残らないようにします。
  */
  function setText(selector, value, fallback) {
    var node = document.querySelector(selector);
    if (!node) return;
    var text = value == null || value === '' ? fallback : String(value);
    node.textContent = text;
  }

  /*
    通常テキストを display.html に入れる前に最低限 escape します。
    buildTypingHtml() は HTML 文字列を返すため、rawComment.comment をそのまま混ぜると
    < や & が HTML として解釈されます。通常コメントは必ずここを通します。

    rawComment.commentHtml が別途ある場合は、YouTube 絵文字などを含む HTML として扱います。
    その経路では typing span に分解せず、runtime 側の HTML sanitizer 前提で表示します。
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
    コメント本文を typing 表現用の HTML に変換します。

    触るポイント:
    - typing をやめたい: この関数を rawComment.commentHtml || rawComment.comment に近い形へ簡略化する
    - typing を速く/遅くしたい: style.css の .typing-char animation-delay を変える
    - 絵文字を壊したくない: Array.from(text) で code point 単位に分ける
    - HTML 絵文字を優先したい: rawComment.commentHtml がある場合はそのまま返す

    prevModel と同じ内容なら前回の display.html を返します。
    これにより同一 id 更新時に typing animation が巻き戻りにくくなります。

    戻り値は index.html の data-kh="display.html" に入り、
    data-kh-mode="html" によって HTML として描画されます。
  */
  function buildTypingHtml(rawComment, prevModel) {
    var plainText = rawComment.comment || '';
    if (prevModel && prevModel.raw && prevModel.raw.comment === plainText
      && prevModel.raw.commentHtml === rawComment.commentHtml
      && prevModel.display && prevModel.display.html) {
      return prevModel.display.html;
    }
    if (rawComment.commentHtml && rawComment.commentHtml !== plainText) {
      /*
        commentHtml は YouTube 絵文字などが HTML として入る経路です。
        ここを1文字ずつ split するとタグを壊すため、そのまま返します。
      */
      return rawComment.commentHtml;
    }
    return Array.from(plainText).map(function (char, index) {
      if (char === '\n') return '<br>';
      return '<span class="typing-char" style="--char-index:' + index + '">' + escapeHtml(char) + '</span>';
    }).join('');
  }

  /*
    htmlFirst.start() が TemplateKit の入口です。
    HTML 側の data-kh-start / data-kh-template / JSON config を読み、
    list starter + renderless model として起動します。

    この sample では renderComment() を使いません。
    HTML は index.html の <template>、表示用データ加工は beforeCommitComment()、
    見た目は style.css という分担にしています。
  */
  window.KomehubTemplateRuntime.htmlFirst.start({
    lifecycle: {
      // entering -> active へ移るまでの待ち時間です。CSS transition の開始タイミングに影響します。
      enterActiveDelayMs: 32,
      // leaving になってから DOM を取り除くまでの待ち時間です。退場 animation より長めにします。
      leaveRemoveDelayMs: 240
    },
    config: {
      callbacks: {
        // manifest.json の kickerText 設定が変わったときに呼ばれます。
        kickerText: function (value) {
          setText('.frame-kicker', value, 'LIVE COMMENTS');
        },
        // manifest.json の headerText 設定が変わったときに呼ばれます。
        headerText: function (value) {
          setText('.frame-title', value, 'Comment Board');
        },
        // manifest.json の statusText 設定が変わったときに右上の状態バッジへ反映します。
        statusText: function (value) {
          setText('.frame-status', value, 'ON AIR');
        },
        // manifest.json の footerText 設定が変わったときに呼ばれます。
        footerText: function (value) {
          setText('.frame-footer-text', value, 'Thank you for watching');
        },
        /*
          animationStyle 設定を style.css の kh-anim-* class に変換します。
          helpers.container は data-kh-start="list" の #comments です。
          既存 class を先に外してから selected を付けることで、設定変更時に class が重複しません。
        */
        animationStyle: function (value, _config, helpers) {
          var selected = value ? 'kh-anim-' + String(value) : 'kh-anim-slide-up';
          animationClasses.forEach(function (className) {
            if (helpers.container && helpers.container.classList) {
              helpers.container.classList.remove(className);
            }
          });
          if (helpers.container && helpers.container.classList) {
            helpers.container.classList.add(selected);
          }
        }
      }
    },
    /*
      beforeCommitComment() は raw comment を画面表示用 model に変換する場所です。
      DOM は作らず、display.* や flags.* のような派生値だけ返します。
      返した値は runtime が raw comment と merge し、index.html の data-kh から参照できます。

      rawComment:
        runtime がテンプレート用に正規化した元コメント情報です。
        現在の主経路では YouTube コメント由来の name, comment, amountDisplay などを持ちます。
      prevModel:
        同じ id の前回 model です。typing HTML を維持したいときに使います。
    */
    beforeCommitComment: function (rawComment, prevModel) {
      var prefix = '';
      if (rawComment.amountDisplay) {
        prefix = 'SUPER CHAT ' + rawComment.amountDisplay;
      } else if (rawComment.isMembershipGift) {
        prefix = 'MEMBERSHIP GIFT';
      } else if (rawComment.isMembership) {
        prefix = 'MEMBER';
      }

      return {
        display: {
          // notice 要素に入る小ラベルです。
          prefix: prefix,
          // comment-text に HTML として入る本文です。
          html: buildTypingHtml(rawComment, prevModel)
        }
      };
    },
    /*
      afterBindComment() は template への値差し込み後に呼ばれます。
      ここではスパチャだけ一時 highlight class を付け、timeout で外しています。
      timer は context.effects が lifecycle に合わせて cleanup します。

      DOM を直接触る処理は、基本的にここへ寄せます。
      beforeCommitComment() では DOM を触らず、model だけを作ると役割が分かれます。
    */
    afterBindComment: function (node, model, context) {
      if (!node || !model || !model.raw || !model.raw.amountDisplay) return;
      context.effects.addClass('paid-highlight', 'is-paid-highlight', {
        removeOnPhases: ['leaving']
      });
      context.effects.setTimeout('paid-highlight-timeout', 900, function (effectContext) {
        if (effectContext.node && effectContext.node.classList) {
          effectContext.node.classList.remove('is-paid-highlight');
        }
      });
    }
  });
})();
