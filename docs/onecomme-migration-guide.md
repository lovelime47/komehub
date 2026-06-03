# OneComme Migration Guide

> **公開ドキュメント** — 配布バイナリに同梱される。

わんコメ (OneComme) 用のテンプレートを、こめはぶの **TemplateKit** で書き直す
ときの対応表と落とし穴集。実際の移植経験から洗い出したものを中心にまとめる。

> 対象読者: わんコメテンプレの作者で、こめはぶ向けに書き直し（または新規に
> 書き始め）したい人。

既存テンプレをまず表示できるかだけ確認したい場合は、「そのままインポート」から
試す。見た目や設定 UI をこめはぶ向けに整えたい段階で、このガイドの
TemplateKit 対応表を使う。

## 前提: 2 つの入り口

こめはぶでわんコメのテンプレを動かす方法は 2 通り:

| 方法 | 内容 | いつ使うか |
|---|---|---|
| **そのままインポート** | わんコメ形式 (`@import '../__origin/...'` + OneSDK) を変更せずに `/templates/{scene}/one/{id}/` で配信 | **既存テンプレをそのまま動かしたい時**。こめはぶの onesdk.js 互換レイヤーが担う |
| **TemplateKit で書き直し** | cellTemplate + 自動付与 class + uiSchema に翻訳する | **こめはぶの機能を前提に磨き込みたい時**（今回のガイドの対象） |

「そのまま動かせれば十分」であればこのガイドを読む必要はない。以下は書き直す
場合の対応表。

## 参照テンプレート

`effects-overlay/templates/framed-list-renderless/` — ヘッダー / フッター付き縦リストの
正式 sample。わんコメ移植のゴール形 (= cellTemplate + uiSchema + 自動付与 class +
共通 CSS の活用) を実コードで確認できる。

`effects-overlay/templates/standard-renderless/` — 最小 renderless サンプル。
わんコメ側の薄いテンプレからの移植で、まずこの形に落としてから装飾を足すと早い。

---

## 対応表

### 1. JavaScript / ランタイム

| わんコメ (OneSDK / Vue) | TemplateKit (こめはぶ) | 備考 |
|---|---|---|
| `<script src="../__origin/js/vue.min.js">` | 不要 | Vue に依存しない。cellTemplate が `<template>` を複製する |
| `<script src="../__origin/js/onesdk.js">` | `/templates/__runtime/runtime.js`（自動挿入） | runtime は HTML 配信時に自動で `<script>` が挿入される |
| `OneSDK.ready().then(() => app.mount())` | `script.js` 直書きで `starters.list({...})` を呼ぶだけ | runtime の ready 状態は意識しなくてよい |
| `OneSDK.setup({ commentLimit: N })` | `starters.list({ maxComments: N, config: { maxComments: true } })` | uiSchema の `maxComments` で動的調整も可能 |
| `OneSDK.subscribe({ action: 'comments', callback })` | 不要。cellTemplate の `data-kh="..."` で自動差し込み | 加工が必要なときだけ renderless (`htmlFirst.start` + `beforeCommitComment`) |
| `OneSDK.connect()` | 不要。runtime が SSE 自動接続 | |
| `OneSDK.getCommentStyle(comment)` | 不要。runtime が自動で `.is-superchat.tier-{blue,teal,green,yellow,orange,magenta,red}` 等を root 要素に付与 | CSS 側で `.tier-red .comment-body { background: #... }` で上書き |

### 2. HTML 構造

| わんコメ | TemplateKit | 備考 |
|---|---|---|
| `<transition-group class="comments" name="comment" tag="div">` | `<div id="comments"></div>` + `<template id="comment-template">` | runtime の createListController が append/remove 時に `.comment-enter-*` / `.comment-leave-*` / `.comment-move` class を自動付与 |
| `v-for="comment in comments"` | 不要。runtime がループする | |
| `:data-user="comment.data.name"` 等の動的 data 属性 | runtime 自動付与の class で代替（下の「data 属性 → class 対応表」参照） | 作者が手で data 属性を書かなくてよい |
| `v-if="comment.data.paidText"` | CSS `.is-superchat` で表示切替、あるいは `data-kh="amount" data-kh-empty="hide"` | |
| `{{comment.data.displayName}}` | `<span data-kh="name"></span>` | cellTemplate の `data-kh` がフィールド名と対応 |
| `v-html="comment.data.comment"` | `<div data-kh="text"></div>` | `data-kh-mode="plain"` で plain 強制も可能 |

### 3. コメントデータ（`comment.data.*` → `comment.*`）

わんコメは `comment.data.*` の 2 階層。こめはぶはフラット。

| わんコメ | こめはぶ（cellTemplate の `data-kh="..."` で指し示すフィールド） |
|---|---|
| `comment.data.id` | `id` |
| `comment.data.name` | `name` |
| `comment.data.displayName` | `name`（displayName がなければ name） |
| `comment.data.comment` | `comment` |
| `comment.data.commentHtml` | `commentHtml`（`data-kh="text"` のデフォルトソース） |
| `comment.data.profileImage` | `profileImage`（`data-kh="avatar"`） |
| `comment.data.memberBadgeUrl` | `memberBadgeUrl`（`data-kh="badge"`） |
| `comment.data.paidText` | `amountDisplay`（`data-kh="amount"`） |
| `comment.data.amount` | `amount` |
| `comment.data.membership` | `membershipHeader`（`data-kh="membershipHeader"`） |
| `comment.data.isMember` | `isMember` → 自動 class `.is-member` |
| `comment.data.isOwner` | `isOwner` → 自動 class `.is-owner` |
| `comment.data.isModerator` | `isModerator` → 自動 class `.is-moderator` |
| `comment.data.isFirstTime` | `isFirstTime`（専用 class は今のところ無し） |
| `comment.data.hasGift` | `hasGift`（`.is-membership-gift` で membership gift は自動判定） |
| `comment.data.badges` | 配列。`data-kh="badge"` で先頭 1 件だけ描画。複数描画は renderComment で |

### 4. data 属性フック → 自動付与 class

わんコメの `[data-*]` CSS フックは、こめはぶでは**コメント root に自動付与
される class**で置き換える。

| わんコメ | こめはぶ（自動付与） |
|---|---|
| `[data-paid="true"]` | `.is-superchat` |
| `[data-gift="true"]` | membership gift なら `.is-membership-gift`（単発ギフト検出は `hasGift` フィールド参照） |
| `[data-owner="true"]` | `.is-owner` |
| `[data-moderator="true"]` | `.is-moderator` |
| `[data-member="true"]` | `.is-member` |
| `.comment.tier-red` 等（getCommentStyle 経由） | `.tier-red` 等（`.is-superchat` と併置） |
| `[data-is-new]` | 現時点で対応する自動 class なし。必要なら `beforeCommitComment` で手動 |

### 5. CSS の `@import`

| わんコメ | TemplateKit |
|---|---|
| `@import '../__origin/css/common.css'` | `@import '/templates/__runtime/common.css'`（opt-in） |
| `@import '../__origin/css/theme/basic.css'` | 該当なし。テンプレ側で装飾を書く |
| `@import '../__origin/css/direction/bottom-to-top.css'` | 共通 CSS の `#comments` が既定で下詰め。上詰めは `.direction-down` を付与（`config.directionClasses.direction: 'direction-down'`） |
| `@import '../__origin/css/animation/move.css'` | 共通 CSS に FLIP ベースの `.comment-move` transition を含む |
| `@import '../__origin/css/animation/slide-up.css'` | 共通 CSS に既定の slide-up transition を含む |
| `@import '../__origin/css/animation/fade-in.css'` 等の別演出 | 共通 CSS の `.comment-enter-*` / `.comment-leave-*` をテンプレ側で上書き |

### 6. CSS カスタムプロパティ

| わんコメ | TemplateKit | 備考 |
|---|---|---|
| `--lcv-enter-duration` | `--kh-enter-duration` | 名前空間が変わる。意味は同じ |
| `--lcv-move-duration` | `--kh-move-duration` | |
| `--lcv-font-size` 等 | テンプレ側で独自に定義 | 共通 CSS は font-size を出さない（装飾の一部として扱う） |
| `--lcv-background-color` / `--lcv-text-color`（getCommentStyle 注入） | runtime 自動 class で代替。`.tier-red .comment-body { background: ... }` をテンプレ CSS で直書き | |

### 7. アニメーション class

runtime が append/remove 時に以下を動的付与する（createListController の
`animate: true`、既定で有効）。これはわんコメの Vue transition-group と
**同じ命名規則**。

| タイミング | class | 解説 |
|---|---|---|
| append 直前 | `.comment-enter-from` | transition の初期値 |
| append 直後 | `.comment-enter-active` + `.comment-enter-to` | transition 起動後の目標値 |
| transition 終了 | class 除去 | |
| removeById 直前 | `.comment-leave-from` | |
| removeById 直後 | `.comment-leave-active` + `.comment-leave-to` | |
| 他要素の押し動かし | `.comment-move` | FLIP で transform を transition |

わんコメの `slide-up.css` 相当が共通 CSS に既定で入っている。別のアニメーションを
使いたければ、テンプレの style.css で同 class を上書きする。

---

## 移植の典型的な落とし穴

以下は実テンプレ移植中に実際に踏んだもの。**どれも移植者が自分で掘り
起こす必要があった**点が、現状の開発者体験の弱さでもある。

### 落とし穴 1: CSS コメント内の `*/`

`/* ... class (.tier-*/.is-membership 等) ... */` のようにコメント内に `*/`
を書くと、CSS パーサーは最初の `*/` でコメント終了を検出し、後続の `:root`
ブロック等を丸ごと破棄する。**CSS 変数がすべて空になる**と訴える不具合は
ほぼこれ。

対処: コメント内では `/` の直前に `*` を置かない。`tier クラス / is-membership`
と言葉で書くか、`tier-xxx` のようにメタ記号を外す。

### 落とし穴 2: 枠入りレイアウトで flex と absolute の基準が違う

元わんコメテンプレが `.title_area { position: absolute; top: 0 }` で container
の padding-box 上端基準だったものを、flex 並びに組み替えると flex item として
content-box 上端基準になり、container padding 分ずれる。

対処: 元テンプレが absolute で組んでいるなら、そのまま absolute を使う。

### 落とし穴 3: `<p>` の UA デフォルト margin を `margin: 0` で殺す

元テンプレの `<p class="disp_time">` は UA デフォルトの `margin: 1em 0` を
使って位置を決めているケースがある。`margin: 0` で殺すと top 値だけでは
中央に届かない。

対処: 移植時に `margin: 1em 0` 相当を明示（font-size 変動に追随させるため
em 単位）。

### 落とし穴 4: uiSchema を変更したのに古い設定が配信される

manifest.uiSchema の key を変更しても、**既存 scene.json に保存された
settings は自動更新されない**。新規 addSceneTemplate なら新 key で埋まるが、
既存シーンでは古い key が残り続ける（SSE 配信直前に reconcile するため見える
key は新 uiSchema に合う、ただし値は default のまま）。

対処:
- 開発中に uiSchema の key 名を変えたら、シーンからテンプレを一度外して追加し直す
- または scene.json を直接編集して古い key を削除

### 落とし穴 5: 吹き出しが親幅いっぱいになる

`.comment-body` に width 指定が無いわんコメ元テンプレは、共通 CSS 側の
`.comment { display: flex }` と `.comment-body { flex: 0 1 auto }` で内容依存
幅になる。こめはぶの共通 CSS を @import しないと、デフォルトで block 要素の
親幅いっぱいになる。

対処: `@import '/templates/__runtime/common.css'` を style.css 先頭に書く。

---

## 移植ワークフロー（推奨）

1. わんコメ元テンプレの `index.html` / `style.css` / `script.js` / `template.json`
   を読み、何が**装飾**で何が**骨格**かを切り分ける
2. 共通 CSS (`/templates/__runtime/common.css`) を `@import` する方針で、
   骨格 CSS は原則書かない
3. cellTemplate の `<template>` を作り、`data-kh="name"` 等でフィールドを割り当てる
4. OneSDK 由来の JS (subscribe / getCommentStyle / connect) は削除し、
   `starters.list({ container, cellTemplate, config })` の最小呼び出しだけ残す
5. わんコメの `[data-paid]` / `[data-gift]` / `[data-member]` 等の CSS フックを、
   自動付与 class (`.is-superchat` / `.is-member` / `.tier-*` 等) に置き換える
6. フォントは `manifest.json` の `fonts` / `fontSources` で宣言する
7. 実機プレビューで描画確認。差分が出る場合は CSS 変数 / 自動付与 class /
   layout の順に切り分ける
8. 共通 CSS 由来の動きが気に入らなければ、style.css で `.comment-enter-active`
   等を上書きして独自アニメーションを定義する

## 非対応プラグイン

こめはぶは わんコメの **公式プリセット (`__origin`)** のみ同梱しており、
コミュニティプラグイン (`onecomme.plugin.<作者>.<名前>` 形式) は一切同梱
していない。したがって、`/plugins/onecomme.plugin.XXX/` を読み込むテンプレートは
**黒画面になる**か、**機能が欠落する**。

### 代表例

| プラグイン | 典型的な依存テンプレ | 主な機能 |
|---|---|---|
| `onecomme.plugin.template-utils` | hana-ticket 系、kentax 派生の一部 | SVG 生成 / preset JSON 読み込み / CSS 変数ヘルパー |

他にも多数のコミュニティプラグインがあり、個別対応は行っていない。

### インポート時の挙動

こめはぶは `install_template` 時に index.html / script.js / style.css を
スキャンし、`/plugins/onecomme.plugin.XXX/` の参照が見つかった場合は次の 2 つを行う:

1. **ハブログに WARN** — `Imported template 'XXX' requires unsupported OneComme community plugins: ...` を `%APPDATA%/live-comment-hub/logs/app.log` に記録
2. **インポート完了ダイアログに警告文を併記** — user が原因を特定できるよう、要求プラグインを列挙した上でインポートは完了させる（user が削除するかは任意）

さらに実行時に overlay からプラグインが参照されると、こめはぶは
`/plugins/<path>` に 404 + 説明本文を返し、同じ plugin id について
初回だけ WARN を出す（ログスパム回避のため 2 回目以降は沈黙）。

### 黒画面になったときの診断

1. ブラウザ開発者ツール（OBS なら `ctrl+shift+i`）で Console を見る
2. `Failed to load resource: the server responded with a status of 404 (Not Found)` で
   `/plugins/onecomme.plugin.XXX/...` が出ていれば本節のケース
3. ハブログ (`app.log`) を開き `Imported template` / `community プラグイン` で検索
4. 該当テンプレートはこめはぶでは動作しない。**元テンプレ作者に「こめはぶ用に
   plugin 依存を剥がしたバージョン」を依頼する**か、**別のテンプレートに変更する**

### 将来の方針

個別に需要が高いプラグインについては、TemplateKit に
**互換 shim を同梱する**ことを検討する余地がある（例:
`/plugins/onecomme.plugin.template-utils/template.js` をこめはぶ側で提供）。
ただし 1 プラグインずつ shim を書くコストと、わんコメ側の API 追随コストを
ユーザー需要と天秤にかけて判断する。現時点では shim は無い。

## 関連ドキュメント

- `docs/template-authoring-guide.md` — 新規 TemplateKit 作成の主ルート
- `docs/template-runtime.md` — runtime API と cellTemplate 規約
- `effects-overlay/templates/framed-list-renderless/` — 移植のゴール形になる正式 sample
  (README + structure.html + guides 同梱)
