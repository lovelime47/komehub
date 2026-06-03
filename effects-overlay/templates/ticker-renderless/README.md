# ticker-renderless

横流れコメントの正式サンプルです。

歌枠やテロップのように、コメントを右から左へ流したい場合はこのテンプレートを読みます。
最小コードだけを見たい場合は `docs/examples/template-ticker-basic/`、実用的な横流れの完成例から派生したい場合はこのテンプレートを複製します。

## 位置づけ

- `横流れ` 入口の built-in サンプルです。
- `htmlFirst.start({ mode: 'ticker', renderlessModel: true })` を使います。
- HTML の `<template>` と `data-kh` でコメント1件分の DOM を定義します。
- runtime が `#track` の幅と位置を計算し、横方向の移動を管理します。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | 速度、文字サイズ、名前表示、光彩色などの設定 UI を定義します。 |
| `index.html` | 横移動する `#track` と、コメント1件分の `<template>` を持ちます。 |
| `style.css` | グロー、名前位置、スパチャ強調、track transition を定義します。 |
| `script.js` | ticker starter を起動し、設定変更時に速度や再計算を runtime へ伝えます。 |
| `structure.html` | 全体構造をブラウザで読むための解説ページです。 |
| `guides/` | 見た目、表示項目、設定、横流れの動きの詳説です。 |

## 最初に見る場所

1. `structure.html` で `#comments` と `#track` の関係を見る。
2. `index.html` の `<template id="ticker-item-template">` を見る。
3. `script.js` の `htmlFirst.start({ mode: 'ticker' ... })` を見る。
4. `style.css` の `#track` と `.comment` 周辺を調整する。

## 次に読むもの

- 最小チュートリアル: `docs/examples/template-ticker-basic/`
- 共通の作り方: `docs/template-authoring-guide.md`
- runtime API: `docs/template-runtime.md`
