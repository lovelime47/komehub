# Template Runtime

> **公開ドキュメント** — 配布バイナリに同梱される。

この文書は、TemplateKit / template runtime の
**API と実装リファレンス**である。

新しくテンプレートを作る人は、まず `docs/template-authoring-guide.md` で
`通常` / `横流れ` / `カスタム` のどれから始めるかを決めてから読むこと。

この文書は API の契約を確認するためのリファレンスである。最初から通読するより、
作りたいテンプレートの入口を決めてから、該当する章だけ参照する使い方を想定する。

## 1. Overview

`/templates/.../` で配信されるテンプレートページには、共通ランタイム
`/templates/__runtime/runtime.js` が自動で読み込まれる。

runtime の主な責務:

- テンプレート用 SSE への接続
- 再接続時の自動リロード
- `sceneVisible` の反映
- preview 背景色の反映
- 共通レイアウト（表示位置 左/右 + 横幅）の `body` class / CSS 変数への反映
- `manifest.json` の `fonts` / `fontSources` に基づくフォント CSS の自動読み込み
- OneComme 互換テンプレ向け WebSocket URL の共通化
- renderless list / ticker の identity / lifecycle / bind / cleanup

原則:

- 新規テンプレートは `starters.*` または `htmlFirst.start()` から始める
- `register()` 直書きは escape hatch である

## 2. Runtime Config

ページ配信時に `window.__KOMEHUB_TEMPLATE_RUNTIME_CONFIG` が注入される。

主なキー:

- `contractVersion`
- `sceneId`
- `templateId`
- `templateKind`
- `streamPath`
- `previewDefaultBackground`
- `resetOnVisible`
- `fonts`
- `fontSources`

互換目的で次のグローバル値も使える。

- `window.__KOMEHUB_PREVIEW`
- `window.__KOMEHUB_PREVIEW_DEFAULT_BG`
- `window.__KOMEHUB_RESET_ON_VISIBLE`

## 2.5 共通レイアウト（表示位置 / 横幅）

表示位置（左 / 右）と横幅（`width`）は、全テンプレートに自動で付与される共通設定である（背景色・カスタムCSS と同様）。テンプレート作者が manifest に書かなくても、配信者の設定 UI に「表示位置」「横幅」が出る。

runtime は config を受け取るたびに次を適用する。

- `position` が `"left"` / `"right"` → `body` に `kh-pos-left` / `kh-pos-right` class を付与
- `width` → `body` に CSS 変数 `--kh-stage-width`（px）を設定

テンプレート CSS 側は、この class / 変数を解釈するだけでよい。

- `body` 直下に `#comments` を `position: fixed` で置く構成では、`body.kh-pos-* > #comments` に横幅・左右寄せを当てるルールが効く。**このルールは `template-runtime/common.css` 側にある**ので、`common.css` を `@import` しているテンプレートは追記不要。`common.css` を読み込まないテンプレートは、同等のルールを自分の `style.css` に持つ必要がある（`body.kh-pos-left/right > #comments { width: var(--kh-stage-width, ...); left/right }`）。
- フレーム / カードを `body` の flex で配置する構成では、`body.kh-pos-left` / `body.kh-pos-right` を見て `justify-content` / `align-items` を切り替え、横幅は `--kh-stage-width`（または cssVars で独自変数へ束ねた値）を使う。

manifest 側で独自に `width` を定義すると（範囲・ラベル・初期値を変えたい場合）その定義が優先される。`width` を CSS 変数へ流したいときは `cssVars` で `"width": ["--your-var", "px"]` のように束ねる。

横スクロール（ticker）など左右・横幅の概念が合わないテンプレートは、manifest に `"commonLayout": false` を書くと共通レイアウト設定の対象外になる。

## 3. Adapter Contract

低レベルで使う場合は `window.KomehubTemplateRuntime.register(adapter)` を呼ぶ。

`adapter` で実装できるもの:

- `mount(payload, context)`
- `onConfig(config, context)`
- `onComments(comments, context)`
- `onDeleted(payload, context)`
- `onClear(payload, context)`
- `dispose(payload, context)`

`context` には少なくとも次が入る。

- `root`
- `body`
- `container`
- `runtimeConfig`
- `latestConfig`

## 4. TemplateKit Helpers

`register()` の上に、薄い補助 API がある。

### 4.1 List Controller

```javascript
var list = KomehubTemplateRuntime.createListController({
  container: document.getElementById('comments'),
  maxComments: 20,
  direction: 'append'
});
```

主なメソッド:

- `setMaxComments(count)`
- `setDirection('append' | 'prepend')`
- `append(comment, renderFn)`
- `removeById(id)`
- `clear()`
- `trim()`
- `getItems()`

### 4.2 DOM Parts

`KomehubTemplateRuntime.parts` にはよく使う部品がある。

- `createAvatar(comment, options)`
- `createBadge(comment, options)`
- `createName(comment, options)`
- `createAmount(comment, options)`
- `createText(comment, options)`
- `createSticker(comment, options)`

### 4.3 Config Helpers

`KomehubTemplateRuntime.config` には設定反映の補助がある。

- `setVar(target, name, value)`
- `setPxVar(target, name, value)`
- `toggleClass(target, className, enabled)`
- `setBackgroundImage(target, value, options)`

## 5. Bindings

starter から設定反映を宣言的に書きたい場合は
`KomehubTemplateRuntime.bindings` を使う。

- `maxComments(key?)`
- `direction(key?)`
- `cssVar(key, cssName, unit?, target?)`
- `toggleCssVar(key, cssName, trueValue, falseValue, target?)`
- `toggleClass(key, className, target?, invert?)`
- `valueClass(key, className, activeValue, target?)`
- `backgroundImage(key?, target?, options?)`
- `customCss(key?, styleId?)`
- `callback(key, handler)`

starter では、`configBindings` を直接書かず、
短い `config` shorthand も使える。

```javascript
runtime.starters.list({
  styleId: 'sample-style',
  config: {
    maxComments: true,
    cssVars: {
      fontSize: ['--font-size', 'px'],
      accentColor: '--accent-color'
    },
    toggleCssVars: {
      showAvatar: ['--avatar-display', 'block', 'none']
    },
    customCss: true
  }
});
```

主な shorthand キー:

- `maxComments`
- `direction`
- `cssVars`
- `toggleCssVars`
- `toggleClasses`
- `directionClasses`
- `backgroundImages`
- `callbacks`
- `customCss`

### 5.1 callbacks の signature

`config.callbacks` に書く handler は `function (value, config, helpers)` で呼ばれる。

```javascript
runtime.starters.list({
  config: {
    callbacks: {
      headerText: function (value, config, helpers) {
        var node = helpers.body && helpers.body.querySelector('.frame-title');
        if (node) node.textContent = value || 'Comment Board';
      }
    }
  }
});
```

`helpers` には starter 起動時の DOM / controller 参照が入る。

| プロパティ | 内容 |
|---|---|
| `helpers.root` | `<html>` 要素 (CSS 変数の root target) |
| `helpers.body` | `<body>` 要素 |
| `helpers.container` | `data-kh-start` 要素 (= `#comments` 等、コメント差し込み先) |
| `helpers.track` | ticker の流れ track 要素 (ticker 系のみ) |
| `helpers.list` | list controller (`setMaxComments` / `setDirection` 等を持つ) |
| `helpers.ticker` | ticker controller (ticker 系のみ) |
| `helpers.styleTag` | `customCss` 注入先の `<style>` 要素 |
| `helpers.styleId` | `data-kh-style-id` で指定した id |

## 6. Starters

高レベルの主入口は次の 3 つである。

- `KomehubTemplateRuntime.starters.list(options)`
- `KomehubTemplateRuntime.starters.ticker(options)`
- `KomehubTemplateRuntime.starters.custom(options)`

役割:

- `list`
  - 縦リスト型
- `ticker`
  - 横流れ型
- `custom`
  - 自由構成の escape hatch

## 7. `cellTemplate`

`list` や軽い `ticker` を HTML + CSS 中心で作りたい場合は、
`cellTemplate` を渡す。

```javascript
runtime.starters.list({
  container: '#comments',
  cellTemplate: '#comment-template'
});
```

`cellTemplate` は `<template>` 要素か、その selector を指定する。
template の中は root 要素 1 個にすること。

### 7.1 `data-kh`

差し込みに使える代表例:

- `avatar`
- `badge`
- `name`
- `amount`
- `membershipHeader`
- `text`
- `sticker`
- `timestamp`
- `giftCount`
- `display.prefix`
- `display.html`

例:

```html
<template id="comment-template">
  <article class="comment">
    <img class="avatar" data-kh="avatar" alt="">
    <div class="body">
      <div class="meta">
        <img class="badge" data-kh="badge" alt="">
        <span class="name" data-kh="name"></span>
        <span class="amount" data-kh="amount"></span>
      </div>
      <div class="membership-header" data-kh="membershipHeader"></div>
      <div class="text" data-kh="text"></div>
      <img class="sticker" data-kh="sticker" alt="">
    </div>
  </article>
</template>
```

### 7.2 補助属性

`data-kh` を付けた要素には、次の補助属性が使える。

- `data-kh-source`
  - `data-kh` と別のフィールドを参照したい時
- `data-kh-empty="remove|hide|keep"`
  - 空値時の挙動
- `data-kh-mode="plain|html"`
  - `textContent` か `innerHTML` か
- `data-kh-attr`
  - 値を属性へ入れる
- `data-kh-prefix`
  - 値の前に固定文字列を付ける
- `data-kh-suffix`
  - 値の後に固定文字列を付ける

例:

```html
<template id="comment-template">
  <article class="comment" data-kh="name" data-kh-attr="title">
    <img class="avatar" data-kh="avatar" data-kh-empty="hide" alt="">
    <div class="body">
      <span class="amount" data-kh="amount" data-kh-prefix="SUPER CHAT " data-kh-empty="hide"></span>
      <div class="text" data-kh="text" data-kh-mode="plain"></div>
    </div>
  </article>
</template>
```

### 7.3 cellTemplate で root に自動付与される class / data 属性

cellTemplate 経路では、コメント root 要素（template 内の 1 個目の要素）に
以下の class / data 属性が runtime により自動で付与される。CSS でスタイル分岐に
使える。

class:

- `kh-comment`
- `is-superchat`
- `is-membership`
- `is-membership-gift`
- `is-member`
- `is-moderator`
- `is-owner`
- `is-verified`
- `has-avatar`
- `has-badge`
- `has-amount`
- `has-text`
- `has-sticker`
- `has-membership-header`
- `tier-blue`
- `tier-teal`
- `tier-green`
- `tier-yellow`
- `tier-orange`
- `tier-magenta`
- `tier-red`

data 属性:

- `data-kh-kind` — `'comment' | 'superchat' | 'membership' | 'membershipGift'`
- `data-kh-superchat-tier` — tier 名
- `data-kh-gift-count` — メンバーシップギフト数

**ライフサイクル系 class（`is-entering` / `is-active` / `is-leaving`）や
`data-kh-id` / `data-kh-phase` / `data-kh-theme` は cellTemplate では付かず、
renderless 経路限定である**（§9.3 参照）。cellTemplate でアニメーション段階を
判別したい場合は callback 経由で自前設定する必要がある。

## 8. `htmlFirst.start()`

`script.js` を最小化したい場合は、
HTML 側へ starter 宣言を寄せて `KomehubTemplateRuntime.htmlFirst.start()` を使う。

### 8.1 最小形

```html
<div
  id="comments"
  data-kh-start="list"
  data-kh-template="#comment-template"
  data-kh-style-id="html-first-list-style"
  data-kh-options="#komehub-template-options"></div>

<script id="komehub-template-options" type="application/json">
{
  "config": {
    "maxComments": true,
    "cssVars": {
      "fontSize": ["--font-size", "px"]
    }
  },
  "preview": {
    "preset": "list-basic",
    "title": "HTML-first list sample"
  }
}
</script>
```

```javascript
window.KomehubTemplateRuntime.htmlFirst.start();
```

### 8.2 `lifecycle`

renderless list / ticker の timing を明示したい時は、次のように書く。

```javascript
window.KomehubTemplateRuntime.htmlFirst.start({
  lifecycle: {
    enterActiveDelayMs: 24,
    leaveRemoveDelayMs: 180
  }
});
```

意味:

- `enterActiveDelayMs`
  - `entering -> active` までの待ち時間
- `leaveRemoveDelayMs`
  - `leaving -> remove` までの待ち時間

### 8.3 `themeAssets`

theme ごとに画像差分を持たせたい場合は、`themeAssets` で comment root へ
CSS 変数を注入できる。

```javascript
window.KomehubTemplateRuntime.htmlFirst.start({
  themeAssets: {
    _common: {
      '--theme-star-image': 'assets/star-common.png'
    },
    'theme-pink': {
      '--theme-frame-image': 'assets/frame-pink.png'
    }
  }
});
```

挙動:

- `_common` は全 theme 共通で毎回注入される
- `display.themeKey` と一致する map は `_common` に重ねて注入される
- 同じ CSS 変数名がある場合は theme 側が優先される

CSS 側では次のように受ける。

```css
.comment::before {
  background-image: var(--theme-frame-image);
}
```

asset path は runtime が正規化する。

- 単なるファイル名は `assets/` 付きへ補完される
- `images/foo.png` のような相対パスはそのまま使われる

## 9. renderless list / ticker

`beforeCommitComment()` を渡すか、`renderlessModel: true` を明示すると、
`renderComment()` を書かずに comment model + `cellTemplate` で始められる。

### 9.1 list

```javascript
window.KomehubTemplateRuntime.htmlFirst.start({
  beforeCommitComment: function (rawComment) {
    return {
      display: {
        html: rawComment.commentHtml || rawComment.comment || '',
        prefix: rawComment.amountDisplay ? 'SC' : ''
      }
    };
  }
});
```

### 9.2 ticker

```javascript
runtime.starters.ticker({
  container: '#comments',
  track: '#track',
  cellTemplate: '#comment-template',
  beforeCommitComment: function (rawComment) {
    return {
      display: {
        html: rawComment.commentHtml || rawComment.comment || '',
        prefix: rawComment.amountDisplay ? 'SC' : ''
      }
    };
  }
});
```

### 9.3 root に自動で付く class / data 属性（renderless 経路）

renderless 経路では、§7.3 の cellTemplate root decoration に加えて、
identity / lifecycle / theme 用の属性が付く。

§7.3 のコメント属性由来 class / data 属性（`is-superchat`、`tier-*`,
`is-membership`、`data-kh-kind` など）は renderless でも使える。renderless model は
raw comment の主要フィールドを保持したまま bind されるためである。

ここで列挙するのは **renderless 経路（`htmlFirst.start` + `beforeCommitComment`、
または `renderlessModel: true` 明示）で追加される lifecycle 系の属性**である。

class:

- `kh-comment`
- `is-entering`
- `is-active`
- `is-leaving`

data 属性:

- `data-kh-id`
- `data-kh-phase`
- `data-kh-theme`

注意:

- `display.themeKey` を返すと `data-kh-theme` に反映され、`themeAssets` の解決にも使われる
- `flags.*` の独自キーは自動で class 化されない。必要なら `data-kh="flags.foo"` で受けるか、callback で class / data 属性へ投影する
- `is-entering` / `is-active` / `is-leaving` は runtime lifecycle の状態であり、コメント種別ではない

### 9.4 update 契約

現行 runtime / core 契約では、同じ `id` の comment が再送される可能性がある。

runtime は次を保証する。

- `id` ごとに既存 entry / node を再利用する
- render 結果に差分がある場合だけ再 bind する
- render 結果が不変の再送では再 bind をスキップする
- 不要な detach / append を避けて既存 DOM state を保つ

これにより、typing のような進行中 animation を巻き戻しにくくする。

### 9.5 `rawComment` フィールド

`beforeCommitComment(rawComment, prevModel, context)` が受け取る `rawComment` は、
runtime が正規化したコメント情報である。次のフィールドが利用できる。

#### 表示系

| フィールド | 型 | 内容 |
|---|---|---|
| `id` | string | コメント識別子 |
| `name` | string | 投稿者名 |
| `comment` | string | コメント本文 (plain text) |
| `commentHtml` | string \| undefined | HTML 化されたコメント本文 (絵文字 img 等を含む) |
| `amount` | number \| undefined | スパチャ金額の数値部分 (0 のときは非スパチャ) |
| `amountDisplay` | string \| undefined | スパチャ金額の表示文字列 (例: `¥1,000`) |
| `profileImage` | string \| undefined | プロフィール画像 URL (`data-kh="avatar"` の参照先) |
| `memberBadgeUrl` | string \| undefined | メンバーバッジ画像 URL (`data-kh="badge"` の参照先) |
| `stickerImage` | string \| undefined | Super Sticker 画像 URL |
| `superchatTier` | string \| undefined | スパチャ tier 名 (`'blue' / 'teal' / 'green' / 'yellow' / 'orange' / 'magenta' / 'red'`) |
| `membershipHeader` | string \| undefined | メンバー加入ヘッダ文言 |
| `timestamp` | number \| undefined | 投稿時刻 (Unix ms) |
| `giftCount` | number \| undefined | メンバーシップギフト数 |

#### フラグ系 (boolean)

| フィールド | 内容 |
|---|---|
| `isOwner` | 配信者本人 |
| `isModerator` | モデレーター |
| `isMember` | 既存メンバー (継続) |
| `isMembership` | メンバー加入 |
| `isMembershipGift` | メンバーシップギフト |
| `isVerified` | YouTube 認証済 |
| `hasPriorListenerComment` | 同 listener が過去にコメント済 |
| `isFirstCommentInStream` | 配信内最初のコメント |
| `isFirstTimeListener` | 初見 listener |
| `isReturningListener` | 復帰 listener |
| `isRegularListener` | 常連 listener |
| `isRegularArrival` | 常連の今配信初コメント |

#### リスナー系

| フィールド | 内容 |
|---|---|
| `listenerStatus` | listener ステータス |
| `listenerTag` | listener タグ |
| `listenerPreviousStreamLastSeenAt` | 前回配信での最終視認時刻 (Unix ms) |

#### `data-kh` alias マッピング

cellTemplate の `data-kh` 値は、上記 raw フィールドへの便宜名である。
便宜名以外の任意 path は `data-kh="任意.path"` で直接読める。

| `data-kh` 値 | 参照先 |
|---|---|
| `name` | `rawComment.name` |
| `text` | `rawComment.commentHtml` または `rawComment.comment` |
| `avatar` | `rawComment.profileImage` |
| `badge` | `rawComment.memberBadgeUrl` |
| `amount` | `rawComment.amountDisplay` または `rawComment.amount` 文字列化 |
| `sticker` | `rawComment.stickerImage` |
| `membershipHeader` | `rawComment.membershipHeader` |
| `timestamp` | `rawComment.timestamp` |
| `giftCount` | `rawComment.giftCount` |
| `display.prefix` | `model.display.prefix` (`beforeCommitComment` が返す値) |
| `display.html` | `model.display.html` |
| `flags.foo` | `model.flags.foo` |

### 9.6 `context.helpers`

`beforeCommitComment(rawComment, prevModel, context)` の `context` には、
派生 model 構築を支援する helper が入っている。

| ヘルパー | 戻り値 | 用途 |
|---|---|---|
| `context.helpers.assignThemeKey(rawComment, prevModel, options)` | string \| undefined | theme 自動振り分けの内部ロジックを再利用する |
| `context.helpers.buildDefaultModel(nextRawComment)` | object | 標準 model を生成して上書き / マージのベースにする |

例 (標準 model に派生値を上乗せする):

```javascript
beforeCommitComment: function (rawComment, prevModel, context) {
  var base = context.helpers.buildDefaultModel(rawComment);
  return Object.assign({}, base, {
    display: Object.assign({}, base.display, {
      prefix: rawComment.amountDisplay ? 'SUPER CHAT' : ''
    })
  });
}
```

`context` には他に `starterType` (`'list' | 'ticker'`)、`sceneId`、`templateId`、
`nowMs`、`isUpdate`、`isNew`、`latestConfig` が入る。

## 10. effect callback

renderless list / ticker では、次の callback が使える。

- `afterBindComment(node, model, context)`
- `onCommentStateChange(model, prevPhase, nextPhase, context)`
- `beforeRemoveComment(node, model, context)`

これらの callback では `context.effects` が使える。`starterType` は `list` または
`ticker` である。

### 10.1 最小例

```javascript
afterBindComment: function (node, model, context) {
  context.effects.addClass('pulse', 'is-pulsing', {
    removeOnPhases: ['leaving']
  });
  context.effects.setTimeout('ready-flag', 120, function (effectContext) {
    effectContext.node.dataset.ready = '1';
  });
}
```

### 10.2 `context.effects` の API

- `register(effectKey, setup)`
- `addClass(effectKey, className, options?)`
- `setTimeout(effectKey, delayMs, handler)`
- `cleanup(effectKey, reason?)`
- `cleanupAll(reason?)`
- `keys()`

使い分け:

- `addClass(...)`
  - bind 時に class を付け、cleanup 時に外す
- `setTimeout(...)`
  - comment 単位の安全な timer
  - remove / clear / dispose 時は runtime cleanup で自動停止する

`context` には少なくとも次が入る。

- `commentId`
- `node`
- `model`
- `phase`
- `reason`

安全側の考え方:

- callback は effect の開始点として使う
- `node.innerHTML = ...` や root 全置換はしない
- cleanup は template 側タイマーへ散らさず、runtime lifecycle に寄せる

## 11. Dev Preview

見た目を確認しながら作る時は、プレビュー URL に
`?preview=1&devPreview=1` を付ける。

list sample ではこのモードで、通常コメント、スパチャ、メンバー継続、
メンギフ、役職色、全部表示を切り替えられる。

おすすめ手順:

1. `index.html` に `cellTemplate` を置く
2. `style.css` で差分 class を書く
3. `?preview=1&devPreview=1` で開く
4. 差分パターンを切り替えて見た目を確認する

## 12. Fonts

テンプレート作者は、フォントの読み込みコードを `script.js` に書く必要はない。

`manifest.json` では次の 2 通りが使える。

- `fonts`
  - こめはぶ標準取得の簡易指定
- `fontSources`
  - 任意フォントの正式指定
  - `assetCss` または `remoteCss`

```json
{
  "fonts": ["Noto Sans JP", "M PLUS Rounded 1c"]
}
```

```json
{
  "fontSources": [
    {
      "family": "MyCommercialFont",
      "type": "assetCss",
      "css": "fonts/my-commercial-font.css"
    }
  ]
}
```

ルール:

- `assetCss`
  - テンプレルートからの相対パス
- `remoteCss`
  - `https://` のみ
- `script.js` にフォント読み込み処理を書く必要はない

## 13. Export Policy

`assetCss` を使うテンプレートは、同梱リソースの再配布可否を
テンプレ作者が判断する必要がある。

```json
{
  "exportPolicy": {
    "allowTemplateExport": false,
    "note": "Bundled commercial font is not redistributable."
  }
}
```

考え方:

- `allowTemplateExport: true`
  - テンプレ作者が再配布可否を確認済み
- `allowTemplateExport: false`
  - こめはぶからのテンプレエクスポートを拒否する
- `assetCss` あり + 未設定
  - 安全側のため、エクスポートを拒否する

## 14. Minimal Example

```javascript
(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;
  runtime.starters.list({
    container: '#comments',
    cellTemplate: '#comment-template',
    config: {
      maxComments: true,
      cssVars: {
        fontSize: ['--font-size', 'px']
      }
    }
  });
})();
```

## 15. Low-Level Example

`register()` 契約を直接使いたい場合は、引き続き次の形でも書ける。

```javascript
(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;
  var container = document.getElementById('comments');
  var list = runtime.createListController({
    container: container,
    maxComments: 10,
    direction: 'append'
  });

  function renderComment(comment) {
    var el = document.createElement('div');
    el.className = 'comment';
    var name = runtime.parts.createName(comment);
    var text = runtime.parts.createText(comment);
    if (name) el.appendChild(name);
    if (text) el.appendChild(text);
    return el;
  }

  runtime.register({
    onConfig: function (config) {
      if (config.fontSize != null) {
        runtime.config.setPxVar(document.documentElement, '--font-size', config.fontSize);
      }
    },
    onComments: function (comments) {
      comments.forEach(function (comment) {
        if (comment) list.append(comment, renderComment);
      });
    },
    onDeleted: function (payload) {
      if (payload && payload.id) list.removeById(payload.id);
    },
    onClear: function () {
      list.clear();
    }
  });
})();
```

## 16. Sample Paths

主軸 sample は `effects-overlay/templates/` にある (アプリと同梱)。

- `effects-overlay/templates/standard-renderless/`
  - 最小 renderless サンプル (`htmlFirst.start` + `beforeCommitComment` の最短形)
- `effects-overlay/templates/framed-list-renderless/`
  - ヘッダー / フッター付き縦リストの正式 sample (README + structure.html + guides 同梱)
- `effects-overlay/templates/browser-card-renderless/`
  - 多層カードの renderless 実装 (rigid scroll backend)
- `effects-overlay/templates/ticker-renderless/`
  - 横流れの正式 sample

最小チュートリアル (`docs/examples/`) は、短いコードで API の使い方だけを確認する
ための教材である。配信で使うテンプレートの土台にする場合は、上の built-in を
複製してから編集する方がよい。

- `template-list-html-first/`
  - `htmlFirst.start()` + cellTemplate の最小 27 行
- `template-ticker-basic/`
  - 横流れの最小 HTML-first / renderless starter
- `template-list-basic/`
  - `starters.list` + `cellTemplate` の最小 + dev preview controller 例
- `template-custom-basic/`
  - `starters.custom()` の最小例
- `template-register-basic/`
  - 低レベル `register()` 互換用サンプル。新規作成の主ルートではない

## 17. OneComme Compatibility

OneComme テンプレートは引き続き `onesdk.js` を利用できる。
共通ランタイムが存在する場合、`onesdk.js` は WebSocket 作成時に
`KomehubTemplateRuntime.createOneCommeWebSocket()` を優先して使う。

これにより transport 解決を共通ランタイム側へ寄せつつ、
既存の OneComme テンプレート互換を維持する。
