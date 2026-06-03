# standard-renderless

最小の renderless 縦リストテンプレートです。

`htmlFirst.start()` と `beforeCommitComment()` の入口だけを見たい場合は、このテンプレートから読むのが一番短いです。見た目を作り込んだ教材として読む場合は、`framed-list-renderless/` の README、`structure.html`、`guides/` を参照してください。

## 位置づけ

- `通常` テンプレートの最小サンプルです。
- HTML の `<template>` と `data-kh` でコメント1件の DOM を定義します。
- `script.js` は表示用の `display.html` を作る最小の renderless 例です。
- `style.css` は共通 CSS を使わず、テンプレート単体で読めるようにしています。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | テンプレート名、設定 UI、既定値を定義します。 |
| `index.html` | コメント一覧の差し込み先と、コメント1件分の `<template>` を持ちます。 |
| `style.css` | コメントカードの基本レイアウトと入退場表示を定義します。 |
| `script.js` | `beforeCommitComment()` で通常コメント本文を `display.html` に変換します。 |

## 最初に見る場所

1. `index.html` の `<template id="comment-template">` を見る。
2. `script.js` の `beforeCommitComment()` で `display.html` を作っている箇所を見る。
3. `index.html` の `data-kh="display.html"` がその値を受け取ることを確認する。
4. `style.css` の `.comment` と `.comment-text` で見た目を変える。

## 次に読むもの

- 共通の作り方: `docs/template-authoring-guide.md`
- runtime API: `docs/template-runtime.md`
- この最小構成の地図: `structure.html`
- 実用的な完成サンプル: `effects-overlay/templates/framed-list-renderless/`
