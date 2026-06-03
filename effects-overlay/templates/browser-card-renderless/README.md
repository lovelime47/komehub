# browser-card-renderless

多層カード型コメントの参考サンプルです。

コメントを1枚ずつカードとして見せ、奥行きのあるレイヤーやテーマアイコンを使いたい場合に読みます。
スクロール管理には rigid scroll backend を使っているため、最小サンプルではなく「実用的な発展例」として扱います。

## 位置づけ

- `通常` リストの発展サンプルです。
- HTML の `<template>` でカードの DOM 階層を定義します。
- `beforeCommitComment()` で `display.html`、role、notice、theme key などの表示用 model を作ります。
- CSS で多層背景、左レール、typing、スパチャ pulse を表現します。
- rigid scroll backend により、カード追加/退場時の位置管理を安定させています。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | カード幅、色、表示件数、アニメーションなどの設定 UI を定義します。 |
| `index.html` | コメント一覧の差し込み先と、カード1件分の `<template>` を持ちます。 |
| `style.css` | 多層カードの見た目、typing、theme、pulse を定義します。 |
| `script.js` | 表示用 model、theme、rigid backend 向け設定反映を担当します。 |
| `assets/` | テーマごとの SVG アイコンを置きます。 |
| `structure.html` | 全体構造をブラウザで読むための解説ページです。 |
| `guides/` | 見た目、表示項目、model、設定、テーマ、一時効果の詳説です。 |

## 最初に見る場所

1. `structure.html` でカード構造とコメント表示の流れを見る。
2. `index.html` の `<template id="comment-template">` を見る。
3. `script.js` の `beforeCommitComment()` を見る。
4. `style.css` の `.browser-card` / `.card-shell` / `.typing-char` 周辺を調整する。

## 次に読むもの

- 最小リスト: `effects-overlay/templates/standard-renderless/`
- 枠付き完成サンプル: `effects-overlay/templates/framed-list-renderless/`
- runtime API: `docs/template-runtime.md`
