# Template Authoring Guide

> **公開ドキュメント** — 配布バイナリに同梱される。

この文書は、**新しくテンプレートを作る人が最初に読むガイド**である。

目的:

- どの starter から始めるべきかを決める
- 何を先に触るかを明確にする
- HTML/CSS-first と file-first の実務ルートを示す

API や option の一覧は `docs/template-runtime.md` を参照する。

この文書のパス表記は、開発環境またはテンプレート開発画面で開くファイルの場所を
示している。アプリ内の「テンプレート開発」画面から読む場合も、同じ名前の
ガイドとサンプルを順に辿ればよい。

## 0. 5分で最初のテンプレを触る

初回は新しい仕組みを全部理解しようとせず、既存テンプレを1か所だけ変える。

最短手順:

1. アプリで `テンプレート設定` を開く
2. `新規テンプレートを作成` または `ビルトインから複製` を選ぶ
3. 迷ったら `通常`、横に流したいなら `横流れ` を選ぶ
4. `テンプレート開発` 画面で `対象フォルダを開く`
5. まず `index.html` か `style.css` だけを変える
6. `プレビューをブラウザで表示` で見た目を確認する

最初に変えると分かりやすい場所:

| やりたいこと | 触る場所 |
|---|---|
| コメントカードの背景を変える | `style.css` の `.comment` |
| 名前や本文の見た目を変える | `style.css` の `.name` / `.comment-text` |
| 表示順を変える | `index.html` の `<template id="comment-template">` |
| 設定画面に項目を増やす | `manifest.json` の `uiSchema` |
| 表示用の文字を加工する | `script.js` の `beforeCommitComment()` |

最初の5分では `renderComment()`、低レベル `register()`、外部ライブラリ追加には進まない。
まず HTML と CSS で「変更したら画面が変わる」ことを確認する。

## 1. 最初に結論

新規の ComeHub テンプレートは、まず次の 3 入口から選ぶ。

- `通常`
- `横流れ`
- `カスタム`

この 3 つのうち、最初に選ぶべきものはほとんどの場合 `通常` か `横流れ` である。
`カスタム` は、一覧や ticker の形に収まらない時だけ使う。

重要:

- 最初に触るのは `index.html` と `style.css`
- `manifest.json` は後から必要分だけ足す
- `script.js` は最後に足す
- `renderComment()` は escape hatch であり、主ルートではない

## 1.5 どの書き方で始めるか（`cellTemplate` / `renderless` / `renderComment`）

starter を選んだ後に決めるのが、**コメント 1 件をどう書くか**である。
主ルートは 3 つあり、上から順に簡単。迷ったら **cellTemplate のみ** から始める。

### 決定フロー

```
Q1. コメント 1 件の HTML を何で定義する？
  A. index.html の <template id="..."> に書く    → cellTemplate
  B. JS から DOM を組み立てる (escape hatch)      → renderComment

Q2. (A を選んだ場合) 表示前に値を加工する必要がある？
  いいえ → cellTemplate のみ
  はい   → cellTemplate + beforeCommitComment (= renderless)
```

「表示前加工が必要か」の目安:

- tier 色 / membership / owner / moderator の分岐 → **不要**（runtime 自動付与 class `is-superchat`, `tier-*`, `is-membership`, `is-owner` 等で足りる。§7.3 / runtime.md §7.3）
- 金額表示のフォーマット変更、prefix 追加、絵文字置換等 → **必要**（`display.html` / `display.prefix` を返す）
- theme 切替（`display.themeKey` で CSS 変数を差す） → **必要**
- 完全に非定型の DOM、外部ライブラリ描画 → **renderComment** まで落とす

### 比較表

| 書き方 | 何を書くか | わんコメで相当するもの | 詳細 |
|---|---|---|---|
| **cellTemplate のみ** | `index.html` の `<template>` 内に `data-kh="..."` を置く。JS は `starters.list({ cellTemplate })` か `htmlFirst.start()` のみ | Vue 3 SFC の `<template>` に `{{ comment.name }}` を直書きするのと同じ感覚 | §5 / §7（runtime.md §7） |
| **cellTemplate + beforeCommitComment**（renderless） | HTML 側は雛形、JS は `display.html` / `display.prefix` / `display.themeKey` 等の派生値だけ返す | `OneSDK.getCommentStyle(comment)` で style 合成して Vue 側 bind と同じ分離 | §6（runtime.md §9） |
| **renderComment** | JS が DOM を生成して返す。escape hatch | Vue の render 関数を直接書く相当 | §8 |

### わんコメ作者向けの対応早見表

| わんコメでよくある書き方 | こめはぶでの書き方 |
|---|---|
| Vue `<template>` に `{{ comment.name }}` をバインド | `<template id="..."><span data-kh="name"></span></template>` + cellTemplate |
| `v-bind:style="getCommentStyle(comment)"` で tier 色を変える | CSS で `.is-superchat.tier-green { background: ... }`（属性分岐は runtime 自動付与） |
| `computed` で表示用の値を作って bind | `beforeCommitComment` で `display.html` / `display.prefix` を返して `data-kh="display.html"` で受ける |
| `v-if` で gift/paid/membership の DOM を分岐 | CSS で `.is-membership { display: ... }`、または `data-kh-empty="hide"` で空値時非表示 |
| 共有 CSS の `@import '../__origin/css/...'` | `@import url('/templates/__runtime/common.css')`（§10.5） |
| Vue の `render()` 直書き | `renderComment(comment)` で DOM を返す（最終手段） |

OneComme 移植の具体手順は `docs/onecomme-migration-guide.md` を参照。

## 2. アプリから始める最短コース

アプリ側では、テンプレート設定から次の流れで始める。

1. `新規テンプレートを作成` を押す
2. `通常` / `横流れ` / `カスタム` を選ぶ
3. テンプレート名と ID を入力する
4. 雛形生成後に `テンプレート開発` 画面へ移動する
5. `対象フォルダを開く` と `プレビューをブラウザで表示` を使って `index.html` / `style.css` を先に触る
6. `テストコメント` で流れ方と削除反映を確認する
7. 必要になった時だけ `manifest を編集` や `script.js` に進む

この順序は file-first を前提としている。

- 最初に触るもの:
  - `index.html`
  - `style.css`
- 次に使うもの:
  - `プレビュー`
  - `テストコメント`
- 後から触るもの:
  - `manifest.json`
  - `script.js`

`プレビュー` と `テストコメント` は別用途である。

- `プレビュー`
  - `?preview=1&devPreview=1` 付き URL を開いて、差分パターンを見比べる
- `テストコメント`
  - 実際の流れ方、削除、再送、OBS での見え方に近い確認をする

## 2.5 既存サンプルから派生して作る

ゼロから書くより、既存テンプレを複製してから変える方が早い場面が多い。

最短手順:

1. 派生元を選ぶ:
   - 最小骨格から始めたい → `effects-overlay/templates/standard-renderless/`
   - 枠/ヘッダー付き → `effects-overlay/templates/framed-list-renderless/`
   - 多層カード → `effects-overlay/templates/browser-card-renderless/`
   - 横流れ → `effects-overlay/templates/ticker-renderless/`
2. アプリの「テンプレート設定 → 新規テンプレート → ビルトインから複製」を選び、上記から派生
3. 雛形が `%APPDATA%/live-comment-hub/templates/tmpl-N/` に作られる
4. `manifest.json` の `id` / `name` / `displayName` を独自値に変える
5. `テンプレート開発` 画面の `対象フォルダを開く` で開いて編集する

`manifest.id` はリバースドメイン形式 (`com.example.your-template` 等) を推奨する。
重複しない値ならアプリで認識される。

ゼロから書きたい場合のみ、§2 の手順に戻って `通常` / `横流れ` / `カスタム` から雛形を生成する。

## 2.7 `docs/examples` と `effects-overlay/templates` の違い

テンプレ開発で見る場所は2種類ある。

| 場所 | 役割 | 使うタイミング |
|---|---|---|
| `docs/examples/` | 最小チュートリアル。短いコードで starter の使い方だけを見る | 仕組みを最短で理解したいとき |
| `effects-overlay/templates/` | 実際にアプリへ同梱される built-in。完成テンプレから派生する | 実用デザインを複製して作りたいとき |

判断:

- はじめて概念を読む → `docs/examples/template-list-html-first/`
- 最小の実用 built-in から派生 → `effects-overlay/templates/standard-renderless/`
- 枠付きの完成サンプルから派生 → `effects-overlay/templates/framed-list-renderless/`
- 横流れを作る → `effects-overlay/templates/ticker-renderless/`

`docs/examples` は教材であり、配信でそのまま使う完成品ではない。
配信で使うテンプレを作るなら、最終的には `effects-overlay/templates/` の built-in か、
アプリが作成するユーザーテンプレートフォルダを編集する。

## 3. どの starter を選ぶか

| 入口 | 使う場面 | 最初の参照先 |
| --- | --- | --- |
| `通常` | 一般的なコメント一覧、カード、吹き出し、縦積み | `effects-overlay/templates/standard-renderless/` (最小)、`docs/examples/template-list-html-first/` |
| `横流れ` | 歌枠・テロップ・右から左へ流れる表示 | `effects-overlay/templates/ticker-renderless/`、`docs/examples/template-ticker-basic/` |
| `カスタム` | 固定ステージ、単一の大きな表示、一覧でも ticker でもない UI | `docs/examples/template-custom-basic/` |
| `通常` + 枠/ヘッダー/フッター付き | 固定フレームにヘッダー / フッター / 装飾付きコメントを載せるタイプ | `effects-overlay/templates/framed-list-renderless/` (README + guides 同梱) |

### `通常`

一覧表示したいなら、まずこれを選ぶ。

- 主な土台:
  - `KomehubTemplateRuntime.starters.list()`
  - または `htmlFirst.start()` の list mode
- 向いているもの:
  - 標準チャット
  - コンパクト表示
  - カード型
  - ゲーム配信向けの縦一覧
- 向いていないもの:
  - 横スクロール専用の見せ方
  - 単一の大きな固定演出

### `横流れ`

コメントを流したいならこれを選ぶ。

- 主な土台:
  - `htmlFirst.start({ mode: 'ticker', renderlessModel: true })`
  - `cellTemplate` による renderless ticker
  - 標準 model にない表示用値が必要なときだけ `beforeCommitComment()` を足す
- 参照先:
  - `effects-overlay/templates/ticker-renderless/` — structure.html + guides 同梱の正式 sample
  - `docs/examples/template-ticker-basic/` — 最小スターター
- 向いているもの:
  - 歌枠の横流れ
  - テロップ型のコメント演出
- 向いていないもの:
  - 縦リストの一覧
  - 件数管理中心の UI

### `カスタム`

一覧や ticker に縛られないならこれを選ぶ。

- 主な土台:
  - `KomehubTemplateRuntime.starters.custom()`
  - `register()` 契約
- 向いているもの:
  - 固定ステージ
  - 単一の大きいコメント表示
  - 外部ライブラリ依存の特殊演出
- 注意:
  - ここでも最初は HTML/CSS を先に作る
  - `register()` 直書きは必要最小限に留める

## 4. まず何を変えるか

### 4.1 `index.html`

HTML の骨組みを作る場所である。

主に触るもの:

- `#comments`
- `<template id="comment-template">`
- 固定装飾の DOM
- `data-kh-*` 属性

通常テンプレでは、まずここから作るのが最短である。

### 4.2 `style.css`

見た目を変える主戦場である。

主に触るもの:

- レイアウト
- 配色
- state ごとの差分
- class / data 属性ごとの装飾
- entering / leaving / theme / tier 差分

### 4.3 `manifest.json`

設定項目や再配布ポリシーを足す場所である。

主に使うもの:

- `uiSchema`
- `fonts`
- `fontSources`
- `exportPolicy`
- `obsHint`

ただし順序としては、まず HTML/CSS で見た目を固めてから必要分だけ足す。

### 4.4 `script.js`

JS は最後に触る場所である。

よくある最短形:

```javascript
window.KomehubTemplateRuntime.htmlFirst.start();
```

または:

```javascript
window.KomehubTemplateRuntime.starters.list({
  container: '#comments',
  cellTemplate: '#comment-template'
});
```

## 5. HTML-first の最短コース

「通常テンプレをまず HTML/CSS で作りたい」なら、
`effects-overlay/templates/standard-renderless/` (最小) または
`docs/examples/template-list-html-first/` を参照先にする。

流れ:

1. `index.html`
   - `#comments` に `data-kh-start="list"` と `data-kh-template` を置く
2. `<script type="application/json">`
   - starter の `config` と preview 設定を JSON で書く
3. `style.css`
   - 見た目を作る
4. `script.js`
   - `window.KomehubTemplateRuntime.htmlFirst.start();` だけ書く

この方式では、テンプレ作者の主戦場を `index.html` と `style.css` に寄せられる。
高度な加工が必要になったときだけ `beforeCommitComment()` や callback を足す。

## 6. renderless をどう使うか

renderless は、JS が DOM を返さず、
comment model の加工だけを行う経路である。cellTemplate との使い分けは §1.5 を参照。

最小形:

```javascript
window.KomehubTemplateRuntime.htmlFirst.start({
  beforeCommitComment: function (rawComment, prevModel, context) {
    return {
      display: {
        html: rawComment.commentHtml || rawComment.comment || '',
        prefix: rawComment.amountDisplay ? 'SC' : '',
        themeKey: context.helpers.assignThemeKey(rawComment, prevModel, {
          themes: ['theme-pink', 'theme-blue']
        })
      }
    };
  }
});
```

このときの考え方:

- HTML 骨格は template 側に置く
- JS は `display.*`、`flags.*`、`themeKey` などの派生値だけ返す
- runtime が bind / lifecycle / identity を担当する

### 6.1 更新の考え方

現行契約では、同じ `id` の comment が後から再送される可能性がある。

runtime は次を行う。

- 同じ `id` の既存 comment root を再利用する
- render 結果が変わらない更新では再 bind を避ける
- そのため、進行中の DOM state や CSS animation を保護できる

テンプレ作者の実務上の理解としては、次で十分である。

- 新規 comment は追加される
- 削除は `deleted` で来る
- 同じ `id` の更新はたまに起こりうる

## 7. typing と effect の考え方

### 7.1 typing

HTML-first / renderless で typing を書くときは、`display.html` に
`typing-char` などの span を埋め込む方式をそのまま使ってよい。

注意:

- 更新時に毎回別 HTML を返すと、再 bind が必要な場合は animation がやり直される
- 進行中 animation を保ちたい場合は、内容不変の更新で `display.html` を変えないことが重要
- 現時点では typing 自体を runtime helper に寄せるより、
  template 側の表現として持つ方が安全
- runtime の役割は typing 専用 API ではなく、巻き戻し防止と DOM 継続保護である

### 7.2 effect

軽い effect は、まず callback と `context.effects` を使う。

- `afterBindComment()`
  - bind 直後に class や dataset を足す
- `onCommentStateChange()`
  - `entering` / `active` / `leaving` に応じて effect を止める
- `beforeRemoveComment()`
  - remove 直前の cleanup 準備をする

おすすめ:

- `context.effects.addClass('pulse', 'is-pulsing', { removeOnPhases: ['leaving'] })`
- `context.effects.setTimeout('ready', 120, function (effectContext) { ... })`

避けること:

- `node.innerHTML = ...` で骨組みを作り直す
- comment root を丸ごと置換する
- cleanup を template 側の散在した timer へ分散する

## 8. `renderComment()` を使ってよい場面

`renderComment()` は消えていない。ただし主ルートは cellTemplate（§1.5）であり、
`renderComment` は次を確認した上で使う最終手段である。

- `cellTemplate` + `data-kh` で足りないか
- `beforeCommitComment()` で表示用の値を整えれば済まないか
- lifecycle / theme / effect cleanup を runtime に任せられないか

それでも必要な代表例:

- 非定型 DOM を JS 主導で作る必要がある
- 一般化コストが高すぎる特殊アルゴリズムがある
- 外部ライブラリ依存の独自描画が必要

## 9. フォントと再配布ポリシー

フォント読み込みコードを `script.js` に書く必要はない。
`manifest.json` で次の 2 通りを使える。

- `fonts`
  - こめはぶ標準取得の簡易指定
- `fontSources`
  - 任意フォントの正式指定
  - `assetCss` か `remoteCss`

例:

```json
{
  "fonts": ["Noto Sans JP", "M PLUS Rounded 1c"]
}
```

```json
{
  "fontSources": [
    {
      "family": "MyBundledFont",
      "type": "assetCss",
      "css": "fonts/my-bundled-font.css"
    }
  ]
}
```

再配布に注意が必要な場合は、`exportPolicy` を明示する。

```json
{
  "exportPolicy": {
    "allowTemplateExport": false,
    "note": "Bundled commercial font is not redistributable."
  }
}
```

判断時の注意:

- 自分で書いた `script.js` / `style.css` だけでなく、同梱したフォント・画像・音声も確認する
- 商用フォント、購入素材、配布条件付き画像は「使える」ことと「再配布できる」ことが別の場合がある
- `assetCss` を使っていて `allowTemplateExport` が未設定のとき、こめはぶは安全側でエクスポートを拒否する

## 10. built-in とサンプルの読み方

built-in は「そのまま複製して使うもの」であると同時に、
starter の先にある参照実装でもある。テンプレ開発の主軸は **renderless 方式**
(`htmlFirst.start` + `beforeCommitComment` + cellTemplate) であり、主軸サンプルは
すべて `effects-overlay/templates/` にオリジナル素材として揃っている。

迷ったときは、まず built-in を複製する。`docs/examples/` は仕組みを短いコードで
確認するための教材であり、完成テンプレの土台としては built-in の方が向いている。

主軸サンプル (`effects-overlay/templates/`):

- `standard-renderless/` — 最小 renderless サンプル。README 同梱、`htmlFirst.start()` + `beforeCommitComment` の最短形
- `framed-list-renderless/` — ヘッダー / フッター付き縦リストの正式 sample。README + structure.html + guides 同梱
- `browser-card-renderless/` — 多層カードの参考実装 (rigid scroll backend 採用)
- `ticker-renderless/` — 横流れ正式 sample
- `frame-{crt-terminal,neon-cyber,scifi-hud}/` — `framed-list-renderless` 派生のテーマ別実装
- `chat-cute/` / `chat-wafuu/` / `singing-text/` — cellTemplate のみ (renderless 未使用) の簡易テンプレ
- `chat-manga-bubble/` — renderless × rigid scroll backend 統合の代表
- `game-compact/` / `game-fps/` / `game-rainbow/` — ゲーム配信向けの cellTemplate サンプル

読み順のおすすめ:

1. `effects-overlay/templates/standard-renderless/` で最小構成を見る
2. `docs/template-runtime.md` で契約を確認する
3. `effects-overlay/templates/framed-list-renderless/` の README + guides で実例を読む
4. 自分の作りたい形に近い built-in を上記から選んで派生する (§2.5 参照)

最小チュートリアル (`docs/examples/`):

- `template-list-html-first/` — `htmlFirst.start()` + cellTemplate の最小 27 行
- `template-ticker-basic/` — ticker 最小スターター
- `template-list-basic/` — `starters.list` + `cellTemplate` の最小 + dev preview controller 例
- `template-custom-basic/` — `starters.custom()` の最小例
- `template-register-basic/` — 互換用 (低レベル `register()` 直書き、主ルートではない)

## 10.5 共通 CSS（opt-in）

テンプレの骨格（`.comment` の flex 並び、`.avatar` の円形クリップ、
`.comment-body` の内容依存幅、`.comment-text img` の文字高さ揃えなど）を
毎回書きたくない場合は、TemplateKit 共通 CSS を `@import` で読み込める。

```css
/* style.css の先頭 */
@import url('/templates/__runtime/common.css');
```

opt-in 方式なので、`@import` を書かないテンプレには一切影響しない。

含まれているもの（抜粋）:

- html / body のリセット（margin 0、transparent 背景、overflow hidden）
- `*` への box-sizing: border-box
- body の `font-size: var(--kh-font-size)` / `line-height: var(--kh-line-height)`
- `body > #comments` の fixed overlay 配置（`position: fixed; inset: 0; gap; padding`）
- `.direction-down` で上詰めに切替
- `.comment` の `display: flex`
- `.avatar` の円形クリップ + 内側 img の object-fit（サイズは `--kh-avatar-size`）
- `.comment-body` の内容依存幅（`flex: 0 1 auto; min-width: 0`）
- `.badge`, `.name`, `.amount`, `.comment-text`, `.sticker` の寸法基本
- インライン画像の文字高さ揃え（`--kh-inline-image-height`）
- 本文中リンクの `color: inherit` + underline
- 役職/スパチャ時の `.name` font-weight 強調（色には触らない）
- アニメーション用時間変数 `--kh-anim-fast` / `--kh-anim-base` / `--kh-anim-slow`
- YouTube スパチャ tier 色 / 役職色の変数宣言（下記）

含めないもの（opt-in プリセットを除く）:

- 色の自動適用（変数は宣言されるが、`.kh-chat-colors` / `.kh-superchat-cards`
  class を付けたときだけ適用される。付けなければテンプレ側装飾は無干渉）
- フォント・影・背景の装飾（テンプレの個性はそのまま残す）
- アニメーションの具体定義（時間変数だけ提供し、動きはテンプレが定義）

### レイアウト既定値の変数

`:root` で次の変数を宣言する。テンプレ側で `:root { --kh-font-size: 22px }` のように
上書きすれば全体のベースが変わる。

| 変数 | 既定値 | 用途 |
|---|---|---|
| `--kh-font-size` | `20px` | body の font-size |
| `--kh-line-height` | `1.5` | body の line-height |
| `--kh-comment-gap` | `10px` | `body > #comments` の gap（コメント間隔） |
| `--kh-comment-padding` | `12px` | `body > #comments` の padding（画面余白） |
| `--kh-avatar-size` | `1.8em` | `.avatar` の幅/高さ |
| `--kh-name-size` | `inherit` | `.name` の font-size |
| `--kh-inline-image-height` | `1.2em` | `.comment-text img` の高さ |
| `--kh-sticker-height` | `2.4em` | `.sticker` の高さ |

上書きは通常の CSS カスケードで効く。例えば `.comment-body` を親幅いっぱいに
広げたいときは:

```css
.comment-body { flex-grow: 1; }
```

参考実装: `effects-overlay/templates/framed-list-renderless/style.css` が共通 CSS を
`@import` して独自装飾だけを書いている。

### アニメーション既定値の変数

共通 CSS を `@import` した時点で、以下の animation 系変数も `:root` に宣言される。
テンプレ側の `:root` で上書きすれば、全 transition / animation の挙動を一括で変えられる。

| 変数 | 既定値 | 用途 |
|---|---|---|
| `--kh-anim-fast` | `160ms` | 短い transition |
| `--kh-anim-base` | `280ms` | 標準 transition |
| `--kh-anim-slow` | `560ms` | ゆっくりした transition |
| `--kh-ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | 出現系 ease |
| `--kh-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | 双方向 ease |
| `--kh-enter-duration` | `var(--kh-anim-base)` | 入場 animation の duration (アニメプリセット用) |
| `--kh-enter-easing` | `var(--kh-ease-out)` | 入場 animation の easing |
| `--kh-leave-duration` | `var(--kh-anim-fast)` | 退場 animation の duration |
| `--kh-leave-easing` | `var(--kh-ease-in-out)` | 退場 animation の easing |
| `--kh-move-duration` | `var(--kh-anim-base)` | FLIP move の duration |
| `--kh-move-easing` | `var(--kh-ease-out)` | FLIP move の easing |

`--kh-enter-*` / `--kh-leave-*` / `--kh-move-*` はアニメプリセット (後述) が参照する。
プリセットを使わないテンプレでも変数として参照できる。

### YouTube 標準色の提供（変数のみ）

YouTube スパチャ / 役職色を `:root` に宣言する。opt-in プリセット（後述）を
使わない場合も、変数としては常に利用できる。

```css
/* スパチャ tier 色 */
--kh-tier-blue-bg     #1565c0   --kh-tier-blue-header     #0d47a1   --kh-tier-blue-ink     #90caf9
--kh-tier-teal-bg     #00e5ff   --kh-tier-teal-header     #00b8d4   --kh-tier-teal-ink     #80cbc4
--kh-tier-green-bg    #1de9b6   --kh-tier-green-header    #00bfa5   --kh-tier-green-ink    #a5d6a7
--kh-tier-yellow-bg   #ffca28   --kh-tier-yellow-header   #ffb300   --kh-tier-yellow-ink   #fff176
--kh-tier-orange-bg   #f57c00   --kh-tier-orange-header   #e65100   --kh-tier-orange-ink   #ffb74d
--kh-tier-magenta-bg  #e91e63   --kh-tier-magenta-header  #c2185b   --kh-tier-magenta-ink  #f48fb1
--kh-tier-red-bg      #d00000   --kh-tier-red-header      #9d0000   --kh-tier-red-ink      #ef9a9a

/* 役職色 */
--kh-role-owner             #ffd600
--kh-role-moderator         #5e84f1
--kh-role-member            #2ba640
--kh-role-membership-join   #2ba640
```

`bg` はカード背景、`header` は背景の濃い部分（カード上部のヘッダー帯など）、
`ink` は暗い overlay 上で名前色として使える薄い派生色。

### 色プリセット (opt-in)

色を自動適用したい場合は `#comments` に class を付ける。アニメプリセットと
同じ opt-in 方式なので、class を付けないテンプレには影響しない。

| class | 挙動 | 想定パターン |
|---|---|---|
| `kh-chat-colors` | tier 色 / 役職色を `.name` に当てる（薄い `ink` 色） | standard-renderless 風 |
| `kh-superchat-cards` | tier 色を `.comment-body` 背景に当て、`color` も白/黒で調整 | カード背景にスパチャ色を効かせたい場合 |

両者を併用しても干渉しない（片方は `.name` 色、もう片方は `.comment-body` 背景）。

### カスタムプリセットを作りたい場合

`kh-chat-colors` / `kh-superchat-cards` が合わない場合は、変数をそのまま使って
テンプレ独自のパターンを書ける。

```css
/* 例: tier 色を左側のボーダーに使う */
.is-superchat.tier-blue    .comment { border-left: 4px solid var(--kh-tier-blue-bg); }
.is-superchat.tier-red     .comment { border-left: 4px solid var(--kh-tier-red-bg); }
/* ... */
```

### アニメーションプリセット (opt-in)

共通 CSS を `@import` すると、既定で `slide-up` (要素高さぶん下から滑り込み) の
enter/leave + FLIP move が有効になる。別のアニメに切り替えるには
`<div id="comments" class="kh-anim-<preset>">` の形で class を付ける。

提供プリセット:

| class | 動き |
|---|---|
| `kh-anim-slide-up` (既定、class 無しと同じ) | 要素高さぶん下から滑り込み |
| `kh-anim-slide-down` | 上から滑り込み |
| `kh-anim-slide-left` | 右から滑り込み |
| `kh-anim-slide-right` | 左から滑り込み |
| `kh-anim-fade-in` | opacity のみ |
| `kh-anim-pop` | scale 0→1 + fade |
| `kh-anim-scale-in` | scale 0.8→1 + fade |
| `kh-anim-purun` | scale 0.3→1 をバウンス イージングで |
| `kh-anim-blur` | blur(12px)→0 + fade |
| `kh-anim-flip-x` | rotateX 90°→0 |
| `kh-anim-flip-y` | rotateY 90°→0 |
| `kh-anim-none` | transition 無し（即時切替） |
| `kh-move-none` | 既存要素の押し動かしを止める（FLIP 無効化） |

duration / easing は CSS 変数で統一制御。テンプレの style.css で
`:root { --kh-enter-duration: 400ms; --kh-enter-easing: ease-out; }` のように
上書き可能。

uiSchema から動的に切り替える場合は `buttons` 型の選択肢を作り、
`config.callbacks` で `#comments` の class を付け替える。
`effects-overlay/templates/framed-list-renderless/script.js` の
`callbacks.animationStyle` が参考例。

## 11. OneComme について

OneComme は ComeHub の新規 authoring の主ルートではなく、
**互換方式** として扱う。

新しく ComeHub テンプレートを作るときは、
まず `通常` / `横流れ` / `カスタム` から考える。

ただし、既存の OneComme テンプレートを取り込んで比較・移行する時は、
OneComme 互換 layer が重要な足場になる。

## 12. 次に読む文書

- 実装 API を知りたい: `docs/template-runtime.md`
- わんコメテンプレートを移植したい: `docs/onecomme-migration-guide.md`
- 最小コードだけ見たい: `docs/examples/template-list-html-first/`
