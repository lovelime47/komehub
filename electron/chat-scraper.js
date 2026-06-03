/**
 * YouTubeチャットページに注入するスクレイパー
 * webContents.executeJavaScript() で実行される
 * データは console.log('__YT_SCRAPER__:' + JSON.stringify(data)) で返送
 *
 * 2つの経路を持つ:
 * 1. fetch インターセプト: YouTube の InnerTube API レスポンスを横取り（低遅延）
 * 2. DOM MutationObserver: フォールバック（fetch が効かない場合）
 */
(function () {
  var PREFIX = '__YT_SCRAPER__:';
  var seenIds = {};
  var seenIdCount = 0;
  var MAX_SEEN_IDS = 5000;
  var observerStarted = false;
  var fetchInterceptActive = false; // fetch インターセプトがデータを返したら true
  var fetchInterceptReady = false;  // fetch インターセプトのセットアップ完了

  function send(type, data) {
    console.log(PREFIX + JSON.stringify({ type: type, data: data }));
  }

  function parseMessage(messageEl) {
    if (!messageEl) return { text: '', html: '', emojis: [] };

    var emojis = [];
    var imgs = messageEl.querySelectorAll('img.emoji');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.src || '';
      emojis.push({
        src: src,
        alt: img.alt || '',
        emojiId: img.getAttribute('data-emoji-id') || '',
        isCustom: src.indexOf('yt3.ggpht.com') !== -1
      });
    }

    // テキスト+絵文字altを結合（キーワードマッチ用）
    var fullText = '';
    messageEl.childNodes.forEach(function (node) {
      if (node.nodeType === 3) {
        fullText += node.textContent;
      } else if (node.nodeType === 1 && node.tagName === 'IMG') {
        fullText += node.alt || '';
      } else if (node.nodeType === 1) {
        // span等の入れ子
        node.childNodes.forEach(function (child) {
          if (child.nodeType === 3) fullText += child.textContent;
          else if (child.nodeType === 1 && child.tagName === 'IMG') fullText += child.alt || '';
        });
      }
    });

    return {
      text: fullText.trim(),
      html: messageEl.innerHTML,
      emojis: emojis
    };
  }

  // バッジ情報を共通抽出（メンバー・モデレーター・オーナー + バッジ画像URL）
  function parseBadges(node) {
    var result = {
      isMember: false,
      memberMonths: 0,
      memberBadgeUrl: '',
      isModerator: false,
      isOwner: false,
      isVerified: false
    };
    var badges = node.querySelectorAll('#chat-badges yt-live-chat-author-badge-renderer');
    for (var i = 0; i < badges.length; i++) {
      var badge = badges[i];
      var badgeType = badge.getAttribute('type') || '';
      var badgeIcon = badge.querySelector('img');

      if (badgeType === 'moderator') {
        result.isModerator = true;
      } else if (badgeType === 'owner') {
        result.isOwner = true;
      } else if (badgeType === 'verified') {
        result.isVerified = true;
      } else if (badgeType === 'member' || (badgeIcon && (badgeIcon.src || '').indexOf('badge') !== -1)) {
        result.isMember = true;
        if (badgeIcon) result.memberBadgeUrl = badgeIcon.src || '';
        // ツールチップ・aria-label・altから月数を抽出
        var badgeText = badge.getAttribute('aria-label') || badge.getAttribute('tooltip') || '';
        if (!badgeText && badgeIcon) {
          badgeText = badgeIcon.getAttribute('alt') || badgeIcon.getAttribute('aria-label') || '';
        }
        // 「メンバー（6 か月）」「Member (6 months)」「メンバー（2 年）」等
        var yearMatch = badgeText.match(/(\d+)\s*(?:年|year)/i);
        var monthMatch = badgeText.match(/(\d+)\s*(?:か月|ヶ月|ケ月|カ月|month)/i);
        if (yearMatch) {
          result.memberMonths = (parseInt(yearMatch[1]) || 0) * 12;
        }
        if (monthMatch) {
          result.memberMonths += parseInt(monthMatch[1]) || 0;
        }
        if (!yearMatch && !monthMatch) {
          if (badgeText.indexOf('新規') !== -1 || badgeText.toLowerCase().indexOf('new') !== -1) {
            result.memberMonths = 0;
          }
        }
      }
    }
    // #chat-badges にバッジがない場合、#author-name の class からフォールバック検出
    if (!result.isModerator || !result.isOwner) {
      var nameEl = node.querySelector('#author-name');
      if (nameEl) {
        var nameClass = nameEl.className || '';
        if (!result.isOwner && nameClass.indexOf('owner') !== -1) result.isOwner = true;
        if (!result.isModerator && nameClass.indexOf('moderator') !== -1) result.isModerator = true;
        if (!result.isMember && nameClass.indexOf('member') !== -1) result.isMember = true;
      }
    }
    return result;
  }

  // DOM 上の whole-message-clickable JSON から author の YouTube channel ID (UC...) を抽出。
  // YouTube DOM は author の channel ID を生で属性に出さないため、コンテキストメニューの
  // base64 エンコード protobuf params をデコードして取り出す。形式:
  //   1) whole-message-clickable は JSON 文字列。liveChatItemContextMenuEndpoint.params が
  //      URL-encoded base64 文字列 (= 内部はもう一段の base64 文字列)。
  //   2) 二重 base64 デコードした生バイトには UC[22] 形式が複数現れる。先頭は配信オーナー、
  //      末尾が author。
  // backfill (= DOM scrape) で取り込んだコメに userId が無いと listener_channel_id が
  // 'yt-unknown' に集約され、リスナータブの集計 (新メンバー含む) が壊れる。
  function extractAuthorUserIdFromNode(node) {
    try {
      var raw = node.getAttribute('whole-message-clickable');
      if (!raw) return '';
      var meta = JSON.parse(raw);
      var p = meta && meta.liveChatItemContextMenuEndpoint && meta.liveChatItemContextMenuEndpoint.params;
      if (!p) return '';
      // params は %3D (= '=') が URL-encoded で外側にも内側にも残るので両段で decode する
      var decoded1 = atob(decodeURIComponent(p));
      var decoded2 = atob(decodeURIComponent(decoded1));
      var ucs = decoded2.match(/UC[A-Za-z0-9_-]{22}/g);
      if (!ucs || ucs.length === 0) return '';
      return ucs[ucs.length - 1];
    } catch (e) {
      return '';
    }
  }

  function parseComment(node) {
    try {
      var id = node.getAttribute('id') || node.id || ('gen-' + Date.now() + '-' + Math.random());
      if (seenIds[id]) return null;
      seenIds[id] = true;
      seenIdCount++;
      // メモリリーク防止: 古いIDを定期的にクリア
      if (seenIdCount > MAX_SEEN_IDS) {
        seenIds = {};
        seenIdCount = 0;
      }

      var nameEl = node.querySelector('#author-name');
      var messageEl = node.querySelector('#message');
      var imgEl = node.querySelector('#img');
      var timestampEl = node.querySelector('#timestamp');

      var name = nameEl ? nameEl.textContent.trim() : '';
      var profileImage = imgEl ? imgEl.src : '';
      var timestamp = timestampEl ? timestampEl.textContent.trim() : '';

      var badges = parseBadges(node);

      // メッセージをリッチ形式で取得（テキスト + スタンプ）
      var parsed = parseMessage(messageEl);

      // 空のメッセージは無視
      if (!parsed.text && !parsed.emojis.length && !name) return null;

      return {
        id: id,
        userId: extractAuthorUserIdFromNode(node),
        name: name,
        comment: parsed.text,
        commentHtml: parsed.html,
        emojis: parsed.emojis,
        profileImage: profileImage,
        // timestamp は DOM #timestamp ("12:50 PM" 等) を今日の日付と組み合わせた ISO 8601。
        // Rust 側 parse_iso_to_unix_ms で正しく posted_at になり、 UI の「X 分前」 表示が機能。
        timestamp: buildIsoFromDomTimestamp(node),
        hasGift: false,
        isMember: badges.isMember,
        memberMonths: badges.memberMonths,
        memberBadgeUrl: badges.memberBadgeUrl,
        isModerator: badges.isModerator,
        isOwner: badges.isOwner
      };
    } catch (e) {
      return null;
    }
  }

  function parseAmount(text) {
    if (!text) return { amount: 0, currency: '¥' };
    var cleaned = text.replace(/,/g, '').trim();
    // 通貨記号を先頭または末尾から検出
    var match = cleaned.match(/^([^\d\s.]+)\s*([\d.]+)/) || cleaned.match(/([\d.]+)\s*([^\d\s.]+)$/);
    if (match) {
      // 先頭に通貨記号がある場合
      if (/[^\d.]/.test(match[1])) {
        return { amount: parseFloat(match[2]) || 0, currency: match[1] };
      }
      return { amount: parseFloat(match[1]) || 0, currency: match[2] };
    }
    var num = parseFloat(cleaned.replace(/[^\d.]/g, ''));
    return { amount: num || 0, currency: '¥' };
  }

  // === ステッカー lazy load 対応 (= 2026-05-23) ============================
  // YouTube は backfill 経路 (= 接続前の過去 sticker、 画面外) では sticker img を
  // lazy load し、 表示直前まで src が transparent placeholder (= 42-byte 1x1 GIF /
  // 空 / data:URI) のまま残る。 そのまま読むと image_cache に透明画像が保存され、
  // 「sticker が真っ黒で出ない」 バグになる (= 2026-05-23 修正)。
  //
  // 対策フロー:
  //   1. backfill / observer scrape 時に sticker img の placeholder を検出
  //   2. parsePaidMessage を呼ばずに skip + MutationObserver で src 変化を待つ
  //   3. 実 URL 到着で parsePaidMessage(node) → send('comments', [comment]) 再 emit
  //      Rust 既存パイプライン (= cache_comment_images / canonical_comment_store /
  //      DB writeback) を再利用する。 Rust SEEN_IDS で他経路 (= fetch intercept
  //      初回 payload) との重複は自動 dedup
  //
  // 観点 (= avatar / badge / emoji への横展開可能性): 本症状は sticker 限定で
  // 報告された。 他の image 種別で同じ 「media-cache に小サイズ画像が溜まる」
  // 現象が出たら、 placeholder 検出ロジック (= isLazyStickerPlaceholder) を
  // helper 化して同じ guard を適用すること。 観測 log は [Scraper] sticker
  // lazy-deferred 接頭辞で出る。
  var DEFERRED_STICKER_MAX = 200;     // 同時 attach 上限 (= OOM 防止)
  var DEFERRED_STICKER_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分で諦める (= observer 解放)
  var deferredStickerCount = 0;

  function findStickerImageEl(node) {
    if (!node || !node.querySelector) return null;
    return node.querySelector('#sticker-container #sticker #img')
      || node.querySelector('#sticker img')
      || node.querySelector('#sticker-icon img')
      || null;
  }

  function isLazyStickerPlaceholder(imgEl) {
    if (!imgEl) return false;  // sticker el 自体が無い: 別問題、 placeholder 扱いではない
    var src = imgEl.src || '';
    if (!src) return true;
    // data:URI placeholder (= YouTube が transparent GIF を base64 embed)
    if (src.indexOf('data:') === 0) return true;
    // img load 未完了 / 1x1 GIF (= 多くの placeholder は 1x1)
    if (!imgEl.complete) return true;
    if (imgEl.naturalWidth <= 1 && imgEl.naturalHeight <= 1) return true;
    return false;
  }

  function registerDeferredStickerEmit(node, imgEl) {
    if (deferredStickerCount >= DEFERRED_STICKER_MAX) {
      send('log', { message: '[Scraper] deferred sticker observers at cap (' + DEFERRED_STICKER_MAX + '), skipping new attach' });
      return;
    }
    var id = node && node.getAttribute ? (node.getAttribute('id') || '') : '';
    if (!id) return;
    // 既に MutationObserver を attach 済の img には重ねない (= 同じ node が
    // 再 scrape された場合の二重 attach 防止)
    if (imgEl.__komehubLazyAttached) return;
    imgEl.__komehubLazyAttached = true;
    deferredStickerCount += 1;
    var resolved = false;
    var timeoutHandle = null;

    function cleanup() {
      if (resolved) return;
      resolved = true;
      deferredStickerCount = Math.max(0, deferredStickerCount - 1);
      try { observer.disconnect(); } catch (_e) {}
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    }

    function tryEmit() {
      if (resolved) return;
      if (isLazyStickerPlaceholder(imgEl)) return;  // まだ placeholder
      cleanup();
      // seenIds に id 未登録 (= 上流で parsePaidMessage 呼んでいない) なので
      // 通常 path 同様に parse + emit。 Rust 側 SEEN_IDS が他経路と dedup する。
      try {
        var comment = parsePaidMessage(node);
        if (!comment) return;
        comment.isBackfill = true;
        comment._komehubTrace = {
          scraperDetectedAtMs: Date.now(),
          scraperReadyToSendAtMs: Date.now(),
          scraperSource: 'dom-sticker-lazy-deferred'
        };
        send('comments', [comment]);
        send('log', { message: '[Scraper] sticker lazy-deferred emit id=' + id.slice(0, 30) });
      } catch (e) {
        send('log', { message: '[Scraper] sticker lazy-deferred parse error: ' + (e && e.message ? e.message : e) });
      }
    }

    var observer = new MutationObserver(tryEmit);
    observer.observe(imgEl, { attributes: true, attributeFilter: ['src'] });
    // load event でも一応チェック (= src 変化なしで complete=true になるケース保険)
    imgEl.addEventListener('load', tryEmit);

    timeoutHandle = setTimeout(function () {
      if (!resolved) {
        cleanup();
        send('log', { message: '[Scraper] sticker lazy-deferred timeout id=' + id.slice(0, 30) });
      }
    }, DEFERRED_STICKER_TIMEOUT_MS);
  }

  function parsePaidMessage(node) {
    try {
      var id = node.getAttribute('id') || ('paid-' + Date.now() + '-' + Math.random());
      if (seenIds[id]) return null;
      seenIds[id] = true;

      var tagName = node.tagName ? node.tagName.toLowerCase() : '';
      var isSticker = tagName === 'yt-live-chat-paid-sticker-renderer';

      var nameEl = node.querySelector('#author-name') || node.querySelector('#author-name-chip');
      var profileImgEl = node.querySelector('#img');
      var name = nameEl ? nameEl.textContent.trim() : '';
      var profileImage = profileImgEl ? profileImgEl.src : '';

      // 金額
      var amountEl = node.querySelector('#purchase-amount') || node.querySelector('#purchase-amount-chip');
      var parsed = parseAmount(amountEl ? amountEl.textContent.trim() : '');

      // コメント（スパチャメッセージ / ステッカーにはコメントがない場合あり）
      var messageEl = node.querySelector('#message');
      var commentParsed = parseMessage(messageEl);

      // ステッカー画像
      var stickerImage = '';
      if (isSticker) {
        var stickerEl = node.querySelector('#sticker-container #sticker #img')
          || node.querySelector('#sticker img')
          || node.querySelector('#sticker-icon img');
        if (stickerEl) {
          stickerImage = stickerEl.src || '';
          // プロトコル相対URLを正規化
          if (stickerImage.startsWith('//')) stickerImage = 'https:' + stickerImage;
        }
      }

      // DOM背景色からティアカラーを取得
      var tierColor = '';
      try {
        var cs = getComputedStyle(node);
        tierColor = cs.getPropertyValue('--yt-live-chat-paid-message-background-color').trim();
        if (!tierColor) {
          // フォールバック: header要素の背景色
          var headerEl = node.querySelector('#header');
          if (headerEl) tierColor = getComputedStyle(headerEl).backgroundColor.trim();
        }
      } catch (e) { /* ignore */ }

      var badges = parseBadges(node);

      return {
        id: id,
        userId: extractAuthorUserIdFromNode(node),
        name: name,
        comment: commentParsed.text,
        commentHtml: commentParsed.html,
        profileImage: profileImage,
        // timestamp は DOM #timestamp 由来。 SC は scrape 時刻焼きだと過去 SC が
        // 「たった今」表示で UI 末尾固まりになるため、 正しい投稿時刻を使う。
        timestamp: buildIsoFromDomTimestamp(node),
        hasGift: true,
        amount: parsed.amount,
        currency: parsed.currency,
        stickerImage: stickerImage,
        tierColor: tierColor,
        isMember: badges.isMember,
        memberMonths: badges.memberMonths,
        memberBadgeUrl: badges.memberBadgeUrl,
        isModerator: badges.isModerator,
        isOwner: badges.isOwner
      };
    } catch (e) {
      return null;
    }
  }

  function parseMembershipMessage(node) {
    try {
      var id = node.getAttribute('id') || ('member-' + Date.now() + '-' + Math.random());
      if (seenIds[id]) return null;
      seenIds[id] = true;

      var nameEl = node.querySelector('#author-name');
      var primaryEl = node.querySelector('#header-primary-text');
      var subtextEl = node.querySelector('#header-subtext');
      var messageEl = node.querySelector('#message');
      var imgEl = node.querySelector('#img');

      var name = nameEl ? nameEl.textContent.trim() : '';
      var primaryText = primaryEl ? primaryEl.textContent.trim() : '';
      var subtextText = subtextEl ? subtextEl.textContent.trim() : '';
      // 新規加入 ("X へようこそ！") は header-primary-text が空 + header-subtext 非空。
      // 継続記念 ("X カ月メンバー") は header-primary-text 非空 (= 主見出し)。
      var isMilestone = primaryText.length > 0;
      var header = isMilestone ? primaryText : subtextText;
      var profileImage = imgEl ? imgEl.src : '';

      var commentParsed = parseMessage(messageEl);
      var badges = parseBadges(node);

      return {
        id: id,
        userId: extractAuthorUserIdFromNode(node),
        name: name,
        comment: commentParsed.text || header,
        commentHtml: commentParsed.html,
        profileImage: profileImage,
        timestamp: buildIsoFromDomTimestamp(node),
        hasGift: false,
        isMembership: true,
        isMembershipMilestone: isMilestone,
        membershipHeader: header,
        isMember: badges.isMember,
        memberMonths: badges.memberMonths,
        memberBadgeUrl: badges.memberBadgeUrl,
        isModerator: badges.isModerator,
        isOwner: badges.isOwner
      };
    } catch (e) {
      return null;
    }
  }

  function parseMembershipGift(node) {
    try {
      var id = node.getAttribute('id') || ('gift-' + Date.now() + '-' + Math.random());
      if (seenIds[id]) return null;
      seenIds[id] = true;

      var nameEl = node.querySelector('#author-name') || node.querySelector('#header-author-name');
      var headerEl = node.querySelector('#header-content-primary-text') || node.querySelector('#primary-text');
      var imgEl = node.querySelector('#img') || node.querySelector('#author-photo img');

      var name = nameEl ? nameEl.textContent.trim() : '';
      var header = headerEl ? headerEl.textContent.trim() : '';
      var profileImage = imgEl ? imgEl.src : '';

      // ギフト数を抽出（「ギフトを 20 個贈りました」「gifted 5 memberships」等）
      var giftCount = 0;
      var giftMatch = header.match(/ギフトを\s*(\d+)\s*個/) || header.match(/gifted\s+(\d+)/i) || header.match(/(\d+)\s*(?:個|memberships)/i);
      if (giftMatch) giftCount = parseInt(giftMatch[1]) || 0;

      return {
        id: id,
        userId: extractAuthorUserIdFromNode(node),
        name: name,
        comment: header,
        profileImage: profileImage,
        timestamp: buildIsoFromDomTimestamp(node),
        hasGift: true,
        isMembershipGift: true,
        giftCount: giftCount
      };
    } catch (e) {
      return null;
    }
  }

  function classifyReactionEmoji(emojiNode) {
    // EMOJI要素の内部画像のalt属性やsrcから種別を判定
    var img = emojiNode.querySelector('img') || emojiNode;
    var alt = (img.alt || img.getAttribute('aria-label') || '').toLowerCase();
    var src = (img.src || '').toLowerCase();

    // ハート系
    if (alt.indexOf('heart') !== -1 || alt.indexOf('love') !== -1 ||
        alt === '\u2764\uFE0F' || alt === '\u2764' || alt.indexOf('\u2764') !== -1) {
      return 'heart';
    }
    // 笑顔系
    if (alt.indexOf('smile') !== -1 || alt.indexOf('laugh') !== -1 ||
        alt.indexOf('happy') !== -1 || alt.indexOf('grin') !== -1 ||
        alt === '\uD83D\uDE04') {
      return 'smile';
    }
    // お祝い系
    if (alt.indexOf('party') !== -1 || alt.indexOf('celebrat') !== -1 ||
        alt.indexOf('tada') !== -1 || alt === '\uD83C\uDF89') {
      return 'celebration';
    }
    // 驚き系
    if (alt.indexOf('surprise') !== -1 || alt.indexOf('wow') !== -1 ||
        alt.indexOf('open_mouth') !== -1 || alt === '\uD83D\uDE2E') {
      return 'surprise';
    }
    // 💯系
    if (alt.indexOf('100') !== -1 || alt.indexOf('hundred') !== -1 ||
        alt.indexOf('fire') !== -1 || alt === '\uD83D\uDCAF') {
      return 'hundred';
    }

    // デフォルトはheart
    return 'heart';
  }

  function detectReactions() {
    // リアクションは yt-emoji-fountain-view-model 内に EMOJI 要素として追加される
    var fountain = document.querySelector('yt-emoji-fountain-view-model');
    if (!fountain) return;

    var reactionObserver = new MutationObserver(function (mutations) {
      var reactions = {};
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === 1 && node.tagName === 'EMOJI') {
            var emojiType = classifyReactionEmoji(node);
            reactions[emojiType] = (reactions[emojiType] || 0) + 1;
          }
        });
      });
      var types = Object.keys(reactions);
      for (var t = 0; t < types.length; t++) {
        send('reaction', { emoji: types[t], count: reactions[types[t]], timestamp: Date.now() });
      }
    });

    reactionObserver.observe(fountain, { childList: true, subtree: true });
    send('log', { message: 'Reaction observer started on yt-emoji-fountain-view-model' });
  }

  // ─── fetch インターセプト経路 ───────────────────────────────────────────
  // YouTube の InnerTube API レスポンスを横取りし、Rust 側へ転送する。
  // IPC ペイロード削減のため、Rust が参照するフィールドだけ抽出して送る。
  // 重い変換（runs 展開・バッジ解析・金額パース・ソート）は Rust 側で行う。

  // renderer から Rust が参照するフィールドだけ抽出
  function slimRenderer(r) {
    if (!r) return r;
    return {
      id: r.id,
      authorName: r.authorName,
      // PT-1a: 投稿者 YouTube channel id (UC...) - リスナー DB の主キー (yt-{...}) になる
      authorExternalChannelId: r.authorExternalChannelId,
      authorPhoto: r.authorPhoto ? { thumbnails: r.authorPhoto.thumbnails } : undefined,
      authorBadges: r.authorBadges,
      message: r.message,
      timestampUsec: r.timestampUsec,
      purchaseAmountText: r.purchaseAmountText,
      bodyBackgroundColor: r.bodyBackgroundColor,
      backgroundColor: r.backgroundColor,
      sticker: r.sticker ? { thumbnails: r.sticker.thumbnails } : undefined,
      headerSubtext: r.headerSubtext,
      header: r.header ? {
        liveChatSponsorshipsHeaderRenderer: r.header.liveChatSponsorshipsHeaderRenderer ? {
          authorName: r.header.liveChatSponsorshipsHeaderRenderer.authorName,
          // PT-1a: メンバーシップギフト時の投稿者 channel id (header 経由)
          authorExternalChannelId: r.header.liveChatSponsorshipsHeaderRenderer.authorExternalChannelId,
          authorPhoto: r.header.liveChatSponsorshipsHeaderRenderer.authorPhoto
            ? { thumbnails: r.header.liveChatSponsorshipsHeaderRenderer.authorPhoto.thumbnails }
            : undefined,
          primaryText: r.header.liveChatSponsorshipsHeaderRenderer.primaryText
        } : undefined
      } : undefined
    };
  }

  function slimAction(action) {
    if (!action) return null;
    // 削除アクション
    if (action.markChatItemAsDeletedAction) {
      return { markChatItemAsDeletedAction: { targetItemId: action.markChatItemAsDeletedAction.targetItemId } };
    }
    if (action.markChatItemsByAuthorAsDeletedAction) {
      return { markChatItemsByAuthorAsDeletedAction: { externalChannelId: action.markChatItemsByAuthorAsDeletedAction.externalChannelId } };
    }
    // replayChatItemAction
    if (action.replayChatItemAction && action.replayChatItemAction.actions) {
      var inner = [];
      for (var i = 0; i < action.replayChatItemAction.actions.length; i++) {
        var s = slimAction(action.replayChatItemAction.actions[i]);
        if (s) inner.push(s);
      }
      return inner.length > 0 ? { replayChatItemAction: { actions: inner } } : null;
    }
    // addChatItemAction
    var add = action.addChatItemAction;
    if (!add || !add.item) return null;
    var item = add.item;
    var slimItem = {};
    var rendererKeys = [
      'liveChatTextMessageRenderer',
      'liveChatPaidMessageRenderer',
      'liveChatPaidStickerRenderer',
      'liveChatMembershipItemRenderer',
      'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer',
      'liveChatSponsorshipsGiftRedemptionAnnouncementRenderer'
    ];
    var found = false;
    for (var j = 0; j < rendererKeys.length; j++) {
      if (item[rendererKeys[j]]) {
        slimItem[rendererKeys[j]] = slimRenderer(item[rendererKeys[j]]);
        found = true;
        break;
      }
    }
    if (!found) return null;
    return { addChatItemAction: { item: slimItem } };
  }

  function slimActions(actions) {
    var result = [];
    for (var i = 0; i < actions.length; i++) {
      var s = slimAction(actions[i]);
      if (s) result.push(s);
    }
    return result;
  }

  // DOM の <span id="timestamp"> textContent ("12:44 PM" / "12:44" 等) を分単位 number に。
  // 失敗時 -1。 同日内であれば lex 比較可能なように 24h 制で「時*60 + 分」を返す。
  // 日付情報は DOM に無いため、 「今日同日」 を前提とする (= ライブ配信は通常同日内)。
  function parseDomTimestampToMinutes(text) {
    if (!text) return -1;
    var m = String(text).match(/(\d+):(\d+)\s*(AM|PM|am|pm)?/);
    if (!m) return -1;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    var ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    if (isNaN(h) || isNaN(min)) return -1;
    return h * 60 + min;
  }

  // DOM node から timestamp element を読んで分単位 number を返す。 1 度だけ querySelector。
  function domNodeTimestampMinutes(node) {
    var tsEl = node && node.querySelector ? node.querySelector('#timestamp') : null;
    if (!tsEl) return -1;
    return parseDomTimestampToMinutes(tsEl.textContent || '');
  }

  // DOM の #timestamp ("12:50 PM" / "23:55" 等) を今日の日付と組み合わせて ISO 8601 文字列を生成。
  // Rust 側 parse_iso_to_unix_ms で正しく posted_at になり、 UI の「X 分前」 表示が機能する。
  // 取得失敗時は scrape 時刻にフォールバック。
  // 日跨ぎ対応: 生成時刻が現在時刻より 4 時間以上未来なら昨日扱い (= 配信が 23:50 開始で
  // 0:30 過ぎ後の backfill に「23:55」が含まれるケースを救う)。
  function buildIsoFromDomTimestamp(node) {
    var mins = domNodeTimestampMinutes(node);
    if (mins < 0) return new Date().toISOString();
    var d = new Date();
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    if (d.getTime() > Date.now() + 4 * 3600 * 1000) {
      d.setDate(d.getDate() - 1);
    }
    return d.toISOString();
  }

  function startFetchIntercept() {
    if (fetchInterceptReady) return;
    fetchInterceptReady = true;

    var originalFetch = window.fetch;
    window.fetch = function () {
      var args = arguments;
      var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');

      var isLiveChat = url.indexOf('/youtubei/v1/live_chat/get_live_chat') !== -1;

      return originalFetch.apply(this, args).then(function (response) {
        if (!isLiveChat) return response;

        // レスポンスを1回だけ json() する（clone 不要）。
        // こちらで消費した後、YouTube には actions を空にしたレスポンスを返すことで
        // YouTube 内部のコメント蓄積・レンダリングを抑止し、メモリ成長を防ぐ。
        return response.json().then(function (data) {
          try {
            var actions = data
              && data.continuationContents
              && data.continuationContents.liveChatContinuation
              && data.continuationContents.liveChatContinuation.actions;
            if (actions && actions.length > 0) {
              // fetch intercept 初回 payload も初期 backfill 相当 (= 過去 N 件含む可能性) なので
              // initial: true を立て、 parse_innertube_actions の timestamp sort + is_backfill=true 経路で扱う。
              // 2 回目以降の polling は initial: false (= 通常のリアルタイム新着扱い)。
              var isInitial = !fetchInterceptActive;
              send('innertube-actions', {
                actions: slimActions(actions),
                initial: isInitial,
                _komehubTrace: { scraperDetectedAtMs: Date.now(), scraperSource: 'fetch-intercept' }
              });
              if (!fetchInterceptActive) {
                fetchInterceptActive = true;
                send('log', { message: 'Fetch intercept active — switching to low-latency path (initial=' + isInitial + ')' });
              }
              // YouTube にはコメントを渡さない
              data.continuationContents.liveChatContinuation.actions = [];
            }
          } catch (e) {
            send('log', { message: 'Fetch intercept parse error: ' + (e.message || e) });
          }
          // continuation は残して YouTube のポーリングを維持しつつ、
          // actions を空にした JSON を返す
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }).catch(function () {
          return response;
        });
      });
    };

    // 接続直前の過去コメ取得は startObserver 内の DOM scrape backfill 経路で行う。
    // 過去には window.ytInitialData.contents.liveChatRenderer.actions[] を読む経路を
    // 試みたが、 実機ではこの actions が常に空 (= YouTube 側で削除済) で機能しないため
    // 廃止 (= 2026-05-14、 詳細は docs/architecture/chat-scraper-backfill.md)。
    send('log', { message: 'Fetch intercept installed' });
  }


  // ─── MutationObserver フォールバック経路 ─────────────────────────────

  var observerRetryCount = 0;
  var MAX_OBSERVER_RETRIES = 15; // 最大15回（15秒）

  function startObserver() {
    // チャットのメッセージコンテナを探す
    var chatContainer =
      document.querySelector('#chat-messages #items') ||
      document.querySelector('#items.yt-live-chat-item-list-renderer') ||
      document.querySelector('yt-live-chat-item-list-renderer #items');

    if (!chatContainer) {
      observerRetryCount++;

      // 配信終了・チャット無効を先にチェック
      var endedIndicator =
        document.querySelector('#chat-messages[hidden]') ||
        document.querySelector('yt-live-chat-viewer-engagement-message-renderer');

      if (endedIndicator || observerRetryCount >= MAX_OBSERVER_RETRIES) {
        send('log', { message: 'Chat not available (ended or not a live stream)' });
        send('status', { connected: false, message: 'チャットが見つかりません（配信終了または非ライブ）' });
        return;
      }

      setTimeout(startObserver, 1000);
      return;
    }

    if (observerStarted) return;
    observerStarted = true;

    send('log', { message: 'Chat container found, starting observer' });

    // 既存メッセージを backfill として Rust に送る (= 接続直前にチャット欄に表示
    // されていた過去コメを取り込む)。parseXxx は seenIds に登録するので、後続の
    // observer は同じメッセージを再送しない。Rust 側で is_backfill=true は演出 /
    // TTS をスキップするので過去コメで TTS や cracker は走らない。
    var backfillNodes = chatContainer.querySelectorAll(
      'yt-live-chat-text-message-renderer,' +
      'yt-live-chat-paid-message-renderer,' +
      'yt-live-chat-paid-sticker-renderer,' +
      'yt-live-chat-membership-item-renderer,' +
      'yt-live-chat-sponsor-gifts-purchase-announcement-renderer,' +
      'ytd-sponsorships-live-chat-gift-purchase-announcement-renderer'
    );
    var backfill = [];
    var backfillDetectedAtMs = Date.now();
    var backfillScSummary = [];  // 観測用: backfill 内の SC / メンバー位置と timestamp
    var scDeepDumped = false;    // 詳細 dump は 1 件のみ (= log 量爆発回避)
    for (var bi = 0; bi < backfillNodes.length; bi++) {
      var bnode = backfillNodes[bi];
      var btag = bnode.tagName ? bnode.tagName.toLowerCase() : '';
      var bcomment = null;
      if (btag === 'yt-live-chat-text-message-renderer') bcomment = parseComment(bnode);
      else if (btag === 'yt-live-chat-paid-message-renderer' || btag === 'yt-live-chat-paid-sticker-renderer') {
        // sticker は backfill 時に lazy load 未完了 (= placeholder src) の可能性が高い。
        // 検出時は parsePaidMessage を呼ばずに skip (= seenIds に登録しない) →
        // MutationObserver で実 URL 到着を待ち、 deferred で send('comments') 再 emit。
        // 詳細: 同ファイル冒頭 「ステッカー lazy load 対応」 セクション
        if (btag === 'yt-live-chat-paid-sticker-renderer') {
          var stickerImgEl = findStickerImageEl(bnode);
          if (stickerImgEl && isLazyStickerPlaceholder(stickerImgEl)) {
            var lazyBid = bnode.getAttribute('id') || '';
            send('log', {
              message: '[Scraper] sticker img placeholder detected during backfill, deferring emit'
                + ' id=' + lazyBid.slice(0, 30)
                + ' complete=' + stickerImgEl.complete
                + ' nw=' + stickerImgEl.naturalWidth
                + ' srcLen=' + (stickerImgEl.src || '').length
            });
            registerDeferredStickerEmit(bnode, stickerImgEl);
            continue;  // 通常の backfill 配列には積まない
          }
        }
        bcomment = parsePaidMessage(bnode);
      }
      else if (btag === 'yt-live-chat-membership-item-renderer') bcomment = parseMembershipMessage(bnode);
      else if (btag === 'yt-live-chat-sponsor-gifts-purchase-announcement-renderer' || btag === 'ytd-sponsorships-live-chat-gift-purchase-announcement-renderer') bcomment = parseMembershipGift(bnode);
      if (bcomment) {
        bcomment.isBackfill = true;
        bcomment._komehubTrace = {
          scraperDetectedAtMs: backfillDetectedAtMs,
          scraperReadyToSendAtMs: backfillDetectedAtMs,
          scraperSource: 'dom-initial-scrape'
        };
        // DOM の <span id="timestamp"> から分単位 sort key を保持。
        // 送信前に backfill 配列を _sortKey で stable sort → 流入順 = 時系列順となり、
        // ピン留め SC が DOM 末尾位置でも時系列の正しい位置に流入する。
        // -1 (= timestamp 取れず) は keep だが sort で先頭に来る、 同分内は stable sort で DOM 順維持。
        bcomment._sortKey = domNodeTimestampMinutes(bnode);
        bcomment._sortIdx = bi;  // tie-break (= 同分内は DOM 順)
        backfill.push(bcomment);
        // 観測用 log (= SC / メンバー / ギフトのみ、 DOM index と timestamp を記録)
        if (btag !== 'yt-live-chat-text-message-renderer') {
          var tsEl = bnode.querySelector('#timestamp');
          backfillScSummary.push({
            idx: bi,
            tag: btag.replace('yt-live-chat-', '').replace('-renderer', ''),
            domTs: tsEl ? tsEl.textContent.trim() : '',
            id: (bcomment.id || '').slice(0, 30),
            amt: bcomment.amount || 0
          });
          // 詳細 dump (= 1 件目の SC / メンバー / ギフトだけ Polymer __data / 全 attr / outerHTML head を log)
          if (!scDeepDumped) {
            scDeepDumped = true;
            try {
              var dump = { tag: btag, idx: bi };
              // 全 attribute
              dump.attrs = {};
              for (var ai = 0; ai < bnode.attributes.length; ai++) {
                dump.attrs[bnode.attributes[ai].name] = bnode.attributes[ai].value;
              }
              // dataset
              dump.dataset = {};
              if (bnode.dataset) {
                for (var dk in bnode.dataset) {
                  if (Object.prototype.hasOwnProperty.call(bnode.dataset, dk)) {
                    dump.dataset[dk] = bnode.dataset[dk];
                  }
                }
              }
              // Polymer __data (= Polymer 2/3 internal binding)
              if (bnode.__data && typeof bnode.__data === 'object') {
                dump.polymerKeys = Object.keys(bnode.__data).slice(0, 60);
                // timestamp 系の候補 field を抜く (= 全部 stringify は循環参照で失敗するため)
                var d = bnode.__data;
                dump.polymerSelected = {
                  timestampUsec: d.timestampUsec || d['timestampUsec'],
                  timestampText: d.timestampText && (d.timestampText.simpleText || JSON.stringify(d.timestampText).slice(0, 100)),
                  id: d.id,
                  authorName: d.authorName && (d.authorName.simpleText || ''),
                  purchaseAmountText: d.purchaseAmountText && d.purchaseAmountText.simpleText,
                  showItemEndpoint: !!d.showItemEndpoint,
                  contextMenuEndpoint: !!d.contextMenuEndpoint
                };
              }
              // outerHTML 先頭 800 字 (= 全 element tree 検査用)
              dump.outerHtml = (bnode.outerHTML || '').slice(0, 800);
              send('log', { message: 'SC DOM deep dump (1st found): ' + JSON.stringify(dump) });
            } catch (e) {
              send('log', { message: 'SC DOM deep dump error: ' + (e.message || e) });
            }
          }
        }
      }
    }
    if (backfill.length > 0) {
      // 流入順 (= 配信時系列順) で送信。 DOM index ではピン留め SC が末尾位置に
      // 再表示されるため、 そのまま送ると UI コメ列の最新位置に過去 SC が出る。
      // _sortKey (= 分単位) で stable sort → 同分内は DOM 順 (= 通常コメ → SC の挿入順) 維持。
      backfill.sort(function (a, b) {
        var ak = (a._sortKey == null || a._sortKey < 0) ? -1 : a._sortKey;
        var bk = (b._sortKey == null || b._sortKey < 0) ? -1 : b._sortKey;
        if (ak !== bk) return ak - bk;
        return (a._sortIdx || 0) - (b._sortIdx || 0);
      });
      // _sortKey / _sortIdx は内部用、 送信前に削除 (= Rust 側で warn 防止)
      for (var si = 0; si < backfill.length; si++) {
        delete backfill[si]._sortKey;
        delete backfill[si]._sortIdx;
      }
      send('comments', backfill);
      send('log', { message: 'DOM backfill: sent ' + backfill.length + ' existing messages to Rust (sorted by #timestamp)' });
      if (backfillScSummary.length > 0) {
        send('log', { message: 'DOM backfill SC/member positions (n=' + backfillScSummary.length + ' / total=' + backfill.length + '): ' + JSON.stringify(backfillScSummary) });
      }
    } else {
      send('log', { message: 'DOM backfill: no existing messages found' });
    }

    // 新しいメッセージを監視
    var observer = new MutationObserver(function (mutations) {
      var newComments = [];
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;

          var tagName = node.tagName ? node.tagName.toLowerCase() : '';

          if (tagName === 'yt-live-chat-text-message-renderer') {
            var comment = parseComment(node);
            if (comment) newComments.push(comment);
          } else if (
            tagName === 'yt-live-chat-paid-message-renderer' ||
            tagName === 'yt-live-chat-paid-sticker-renderer'
          ) {
            // sticker は observer 経路でも lazy load 未完了の可能性がある (= 上スクロール
            // で復活した過去 sticker や fetch intercept active 化前の live sticker)。
            // backfill と同じく placeholder 検出 → deferred 経路に振り分ける。
            if (tagName === 'yt-live-chat-paid-sticker-renderer') {
              var liveStickerImgEl = findStickerImageEl(node);
              if (liveStickerImgEl && isLazyStickerPlaceholder(liveStickerImgEl)) {
                var liveLazyId = node.getAttribute('id') || '';
                send('log', {
                  message: '[Scraper] sticker img placeholder detected during observer, deferring emit'
                    + ' id=' + liveLazyId.slice(0, 30)
                });
                registerDeferredStickerEmit(node, liveStickerImgEl);
                return;  // addedNodes.forEach の callback 終了 (= 直接 emit せず deferred へ)
              }
            }
            var paid = parsePaidMessage(node);
            if (paid) newComments.push(paid);
          } else if (
            tagName === 'yt-live-chat-membership-item-renderer'
          ) {
            var member = parseMembershipMessage(node);
            if (member) newComments.push(member);
          } else if (
            tagName === 'yt-live-chat-sponsor-gifts-header-v2-renderer' ||
            tagName === 'yt-live-chat-sponsor-gifts-purchase-announcement-renderer' ||
            tagName === 'ytd-sponsorships-live-chat-gift-purchase-announcement-renderer'
          ) {
            var gift = parseMembershipGift(node);
            if (gift) newComments.push(gift);
          }
        });
      });

      // fetch インターセプトが動いていればDOMからのコメント送信は抑止
      if (newComments.length > 0 && !fetchInterceptActive) {
        var detectedAtMs = Date.now();
        // 観測用: SC / メンバー / ギフトのみ、 fetchInterceptActive 状態と
        // DOM timestamp を log に出して 「再接続直後の SC が observer 経由で
        // 来ているか / DOM 上の表示時刻はどうか」 を確認できるようにする
        var observerScSummary = [];
        newComments.forEach(function (comment) {
          if (!comment || typeof comment !== 'object') return;
          if (!comment._komehubTrace || typeof comment._komehubTrace !== 'object') {
            comment._komehubTrace = {};
          }
          comment._komehubTrace.scraperDetectedAtMs = detectedAtMs;
          comment._komehubTrace.scraperReadyToSendAtMs = detectedAtMs;
          comment._komehubTrace.scraperSource = 'dom-observer';
          // SC / メンバー / ギフト判定 (= amount 持ち or isMembership/isGift フラグ)
          if (comment.amount > 0 || comment.isMembership || comment.hasGift) {
            observerScSummary.push({
              id: (comment.id || '').slice(0, 30),
              ts: comment.timestamp || '',
              amt: comment.amount || 0,
              isMember: !!comment.isMembership,
              hasGift: !!comment.hasGift,
              fia: fetchInterceptActive  // 期待: false (= 9 秒待ち中)
            });
          }
        });
        send('comments', newComments);
        if (observerScSummary.length > 0) {
          send('log', { message: 'DOM observer SC/member/gift (n=' + observerScSummary.length + ' / total=' + newComments.length + '): ' + JSON.stringify(observerScSummary) });
        }
      }

      // コメント削除検出（モデレーター削除・自動モデレーション等）
      // fetchInterceptActive 時は InnerTube の markChatItemAsDeletedAction で
      // 正しく検出されるため、DOM の removedNodes は無視する。
      // YouTube は表示最適化のために古いコメントを DOM から定期パージするが、
      // これはモデレーター削除ではない。
      if (!fetchInterceptActive) {
        var deletedIds = [];
        mutations.forEach(function (mutation) {
          mutation.removedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            var id = node.getAttribute('id') || node.id;
            if (id && seenIds[id]) {
              deletedIds.push(id);
              delete seenIds[id];
              seenIdCount--;
            }
          });
        });
        if (deletedIds.length > 0) {
          send('deleted', { ids: deletedIds });
        }
      }

      // DOM トリミング: fetch intercept 経由でコメントを取得している場合、
      // DOM はこちらから参照しないため、全て刈ってメモリを抑える。
      if (fetchInterceptActive && chatContainer.children.length > 0) {
        chatContainer.textContent = '';
      }
    });

    observer.observe(chatContainer, { childList: true });

    // コメント削除検出: #deleted-state にテキストが挿入されるのを監視
    // YouTube は削除時に <span id="deleted-state"> の中身を
    // 空→「[メッセージが撤回されました]」に変更する
    var deleteObserver = new MutationObserver(function (mutations) {
      var deletedIds = [];
      mutations.forEach(function (mutation) {
        if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) return;
        var target = mutation.target;
        if (!target.id || target.id !== 'deleted-state') return;
        // 親の renderer 要素から ID を取得
        var renderer = target.closest('yt-live-chat-text-message-renderer');
        if (!renderer) return;
        var commentId = renderer.getAttribute('id') || renderer.id;
        if (commentId && seenIds[commentId]) {
          deletedIds.push(commentId);
          delete seenIds[commentId];
          seenIdCount--;
        }
      });
      if (deletedIds.length > 0) {
        send('deleted', { ids: deletedIds });
      }
    });
    deleteObserver.observe(chatContainer, { childList: true, subtree: true });

    // リアクション監視も開始
    detectReactions();

    // yt-emoji-fountain-view-model が後から現れる場合のリトライ
    if (!document.querySelector('yt-emoji-fountain-view-model')) {
      var retryReaction = setInterval(function () {
        if (document.querySelector('yt-emoji-fountain-view-model')) {
          detectReactions();
          clearInterval(retryReaction);
        }
      }, 3000);
    }

    send('status', { connected: true });

    // チャット終了検出（配信終了時にチャットコンテナが消失する）
    setInterval(function () {
      var stillExists =
        document.querySelector('#chat-messages #items') ||
        document.querySelector('#items.yt-live-chat-item-list-renderer') ||
        document.querySelector('yt-live-chat-item-list-renderer #items');
      var disabledChat = document.querySelector('#chat-messages[hidden]');
      if (!stillExists || disabledChat) {
        send('log', { message: 'Chat container disappeared or was hidden' });
        send('status', { connected: false, message: '配信が終了しました' });
      }
    }, 10000);
  }

  // fetch インターセプトを最優先でセットアップ（DOM より前にフックする）
  startFetchIntercept();

  // MutationObserver はフォールバックとして起動（fetch が効かない場合に備える）
  if (document.readyState === 'complete') {
    startObserver();
  } else {
    window.addEventListener('load', function () {
      // YouTubeの動的レンダリングを待つ
      setTimeout(startObserver, 2000);
    });
  }

  // すぐにも試行
  setTimeout(startObserver, 3000);
})();
