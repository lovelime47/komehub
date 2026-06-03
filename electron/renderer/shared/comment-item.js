// === KomehubShared / comment-item ===
// 設計正本: docs/architecture/remote-viewing-redesign.md §6
//
// 1 コメ cell の DOM ファクトリ。本体 renderer.js と remote (将来) 両方から使う。
// 設計原則: 純粋な DOM ファクトリ。I/O (= click handler / format helper) は注入式。
//
// 依存:
//   - shared/comment-sanitize.js (sanitizeCommentHtml)
//   - shared/comment-superchat.js (isCommentSuperchat / commentSuperchatColors / commentSuperchatAmountText)

(function () {
  'use strict';

  var ns = window.KomehubShared = window.KomehubShared || {};

  // listener tag の表示文字列 (= 初見 / 再訪 / 今北 / 帰還)
  ns.listenerTagLabel = function (status) {
    switch (status) {
      case 'first-time': return '初見';
      case 'returning': return '再訪';
      case 'regular-arrival': return '今北';
      case 'long-absence': return '帰還';
      default: return '';
    }
  };

  // listener-meta chip 群 (前回コメント / この枠SC / 前回枠) を組み立てる
  // deps = { formatTime, formatYen, truncate }
  ns.buildCommentListenerMeta = function (data, deps) {
    if (!data) return null;
    var formatTime = (deps && deps.formatTime) || function (v) { return v ? String(v) : ''; };
    var formatYen = (deps && deps.formatYen) || function (v) { return v ? '¥' + v : ''; };
    var truncate = (deps && deps.truncate) || function (text, max) {
      var value = String(text == null ? '' : text);
      if (!max || value.length <= max) return value;
      return value.substring(0, max) + '...';
    };

    var chips = [];
    if (data.listenerPreviousCommentAtMs || data.listenerPreviousCommentAt) {
      chips.push('前回コメント: ' + formatTime(data.listenerPreviousCommentAtMs || data.listenerPreviousCommentAt));
    }
    if (data.listenerCurrentStreamSuperchatAmountJpy) {
      chips.push('この枠SC: ' + formatYen(data.listenerCurrentStreamSuperchatAmountJpy));
    }
    if (data.isFirstCommentInStream && data.listenerStatus !== 'first-time') {
      var previousStreamParts = [];
      if (data.listenerPreviousStreamTitle || data.listenerPreviousStreamId) {
        previousStreamParts.push(truncate(data.listenerPreviousStreamTitle || data.listenerPreviousStreamId, 30));
      }
      if (data.listenerPreviousStreamStartedAtMs || data.listenerPreviousStreamStartedAt) {
        previousStreamParts.push(formatTime(data.listenerPreviousStreamStartedAtMs || data.listenerPreviousStreamStartedAt));
      }
      if (previousStreamParts.length > 0) {
        chips.push('前回枠: ' + previousStreamParts.join(' / '));
      }
    }
    if (chips.length === 0) return null;
    var meta = document.createElement('div');
    meta.className = 'comment-listener-meta';
    for (var i = 0; i < chips.length; i++) {
      var chip = document.createElement('span');
      chip.textContent = chips[i];
      meta.appendChild(chip);
    }
    return meta;
  };

  // 1 コメ cell の DOM を生成
  // data: RawComment 形式 (= 本体・remote 共通の serde struct)
  // deps = { onClick, onToggleResponded, formatTime, formatYen, truncate, rewriteUrl }
  //   onClick: cell 全体クリック時に呼ばれる (= 詳細モーダルを開く等)
  //   onToggleResponded: 対応済みボタン押下時に (commentId, nextValue: boolean) で呼ばれる
  //     省略時は対応済みボタンを表示しない (= remote-viewing-redesign.md §5.3)
  //   format*: buildCommentListenerMeta 用
  //   rewriteUrl: avatar 等の image URL を変換する関数 (= remote 端末で hostname を相対化する用)
  //     省略時は identity (本体 renderer 側はそのまま使う)
  ns.createCommentItem = function (data, deps) {
    deps = deps || {};
    var item = document.createElement('div');
    item.className = 'comment-item';
    if (data.isMember) item.classList.add('comment-item-member');
    if (ns.isCommentSuperchat(data)) {
      item.classList.add('comment-item-superchat');
      var superchatColors = ns.commentSuperchatColors(data);
      item.style.setProperty('--comment-superchat-bg', superchatColors.bg);
      item.style.setProperty('--comment-superchat-fg', superchatColors.fg);
      item.style.setProperty('--comment-superchat-muted-fg', superchatColors.muted);
    }
    item.dataset.id = data.id || '';
    if (data.respondedAt && data.respondedAt > 0) {
      item.dataset.responded = '1';
    }
    // クリックハンドラが渡されたときだけ cursor を pointer に。
    // 渡されなければクリック非対応として default cursor (= listener 詳細「全コメ」タブで
    // 再帰的に詳細を開かないように使う、2026-05-13)。
    item.style.cursor = (typeof deps.onClick === 'function') ? 'pointer' : 'default';

    var img = document.createElement('img');
    var srcRaw = data.profileImage || '';
    img.src = (typeof deps.rewriteUrl === 'function') ? deps.rewriteUrl(srcRaw) : srcRaw;
    img.alt = '';
    // 読み込み失敗時の fallback:
    //   1) data._fallbackIconUrl (= listener の現在 iconUrl 等、 cache 不在時の救済) を試す
    //   2) それも失敗 or 未指定なら initial 文字 placeholder に差し替える
    // 背景: profileImage は CommentRow.raw 由来でハッシュ付き cache URL を持つが、
    // listener の avatar 更新で過去 cache file が削除されると古いコメだけ 404 になる。
    // display:none だと grid container で 1 列目が空になり本文が縦書き化するため、
    // 必ず同 size のノードを置く (img → fallback img → placeholder div)。
    img.onerror = function () {
      var self = this;
      if (self.dataset.fallbackTried !== '1' && data._fallbackIconUrl) {
        self.dataset.fallbackTried = '1';
        var fb = data._fallbackIconUrl;
        self.src = (typeof deps.rewriteUrl === 'function') ? deps.rewriteUrl(fb) : fb;
        return;
      }
      var placeholder = document.createElement('div');
      placeholder.className = 'kh-comment-avatar-placeholder';
      placeholder.textContent = String(data.name || '?').charAt(0).toUpperCase();
      if (self.parentNode) self.parentNode.replaceChild(placeholder, self);
    };

    var content = document.createElement('div');
    content.className = 'comment-content';

    var name = document.createElement('div');
    name.className = 'comment-name';
    name.textContent = data.name || '';

    var tagText = data.listenerTag || ns.listenerTagLabel(data.listenerStatus);
    if (tagText) {
      var tag = document.createElement('span');
      tag.className = 'comment-listener-tag comment-listener-tag-' + String(data.listenerStatus || '').replace(/[^a-z0-9-]/gi, '');
      tag.textContent = tagText;
      name.appendChild(tag);
    }
    var superchatAmount = ns.commentSuperchatAmountText(data);
    if (superchatAmount) {
      var amountBadge = document.createElement('span');
      amountBadge.className = 'comment-superchat-amount';
      amountBadge.textContent = superchatAmount;
      name.appendChild(amountBadge);
    }
    var listenerMeta = ns.buildCommentListenerMeta(data, deps);
    if (listenerMeta) name.appendChild(listenerMeta);

    var text = document.createElement('div');
    text.className = 'comment-text';
    if (data.commentHtml) {
      text.innerHTML = ns.sanitizeCommentHtml(data.commentHtml);
      // sanitize 後の <img> (= カスタム絵文字 / 旧 sticker 等) の src も rewriteUrl で
      // 書き換える。本体ではこの処理は no-op (= rewriteUrl 未指定)、
      // remote では http://127.0.0.1:11280/cache/... を相対化する。
      if (typeof deps.rewriteUrl === 'function') {
        var imgs = text.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
          var orig = imgs[i].getAttribute('src') || '';
          var rewritten = deps.rewriteUrl(orig);
          if (rewritten !== orig) imgs[i].src = rewritten;
        }
      }
    } else {
      text.textContent = data.comment || '';
    }

    content.appendChild(name);
    content.appendChild(text);

    // スーパーステッカー画像 (= liveChatPaidStickerRenderer 由来)。
    // core/innertube_parser::parse_paid_sticker が sticker_image に絶対 URL を入れ、
    // image_cache 経由で http://127.0.0.1:11280/cache/stickers/... に書き換えられる経路がある。
    // ただし YouTube が // プロトコル相対 URL (= 「//lh3.googleusercontent.com/...」) を返す
    // ケースで cache 化が機能していない実例があるため、 https: を補って表示できるよう保険する。
    // 本文 (comment) は通常空、ステッカー画像のみ。本文があれば両方表示する。
    if (typeof data.stickerImage === 'string' && data.stickerImage) {
      var stickerImg = document.createElement('img');
      stickerImg.className = 'comment-sticker';
      var stickerSrc = data.stickerImage;
      if (stickerSrc.indexOf('//') === 0) stickerSrc = 'https:' + stickerSrc;
      if (typeof deps.rewriteUrl === 'function') stickerSrc = deps.rewriteUrl(stickerSrc);
      stickerImg.src = stickerSrc;
      stickerImg.alt = '';
      stickerImg.loading = 'lazy';
      stickerImg.onerror = function () { this.style.display = 'none'; };
      content.appendChild(stickerImg);
    }

    item.appendChild(img);
    item.appendChild(content);
    if (data.listenerCurrentStreamCommentCount) {
      var streamCount = document.createElement('div');
      streamCount.className = 'comment-listener-count';
      streamCount.textContent = String(data.listenerCurrentStreamCommentCount);
      item.appendChild(streamCount);
    }

    // 「対応済み」トグル (= deps.onToggleResponded が渡されたときだけ表示)
    if (typeof deps.onToggleResponded === 'function') {
      var respondedBtn = document.createElement('button');
      respondedBtn.type = 'button';
      respondedBtn.className = 'kh-toggle-responded';
      respondedBtn.title = '対応済みにする / 戻す';
      respondedBtn.dataset.responded = data.respondedAt && data.respondedAt > 0 ? '1' : '0';
      respondedBtn.textContent = '✓';
      respondedBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var prev = respondedBtn.dataset.responded === '1';
        deps.onToggleResponded(data.id || '', !prev);
      });
      item.appendChild(respondedBtn);
    }

    if (typeof deps.onClick === 'function') {
      item.addEventListener('click', function () {
        deps.onClick(data);
      });
    }

    return item;
  };
})();
