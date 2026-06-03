# framed-list-renderless

雑談シーン向けの、フレーム付きコメントリストテンプレートです。
アプリ上の表示名は `フレーム` です。

このテンプレートは renderless 構成の完成サンプルでもあります。HTML の `<template>`、`data-kh` 属性、`beforeCommitComment()`、CSS の lifecycle class を組み合わせて、テンプレート作者が見た目と動きを作り替えやすい形にしています。

## まず最初に触る場所

最初は大きく作り替えず、1か所だけ変えて表示が変わることを確認します。

| やりたいこと | 最初に触る場所 |
| --- | --- |
| タイトルを変える | `manifest.json` の `headerText.default` |
| 右上の `ON AIR` を変える | `manifest.json` の `statusText.default` |
| 色を変える | `manifest.json` の `colorPreset` または `accentColor.default` |
| コメントカードの見た目を変える | `style.css` の `.comment` |
| コメント本文の表示を変える | `style.css` の `.comment-text` |
| タイピングを速く/遅くする | `manifest.json` の `typingSpeed` と `style.css` の `--typing-step` |

さらに進める場合は `guides/first-edit.html` から始めると、HTML / CSS / JS / manifest のどれを触るべきか迷いにくくなります。

## 位置づけ

- 雑談シーンのデフォルトテンプレートです。
- OBS のブラウザソースで画面の左寄せ / 右寄せ（いずれも下端固定）に置く想定です。
- コメント本文は通常テキストならタイピング表示、HTML 絵文字を含むコメントはタグを壊さないため通常表示します。
- 配信者がアプリ設定から調整しやすいように、色、サイズ、表示位置、コメント間隔、ヘッダー、フッター、タイピング速度、アニメーションを `manifest.json` に出しています。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | アプリのテンプレート一覧、設定 UI、デフォルト値を定義します。 |
| `index.html` | OBS / ブラウザで表示される本体です。`data-kh` 属性で model の値を DOM に流し込みます。 |
| `style.css` | 見た目、配置、コメントカード、タイピング、登場/退場アニメーションを定義します。 |
| `script.js` | 設定値の DOM 反映、コメント表示用 model の加工、スパチャ強調などを担当します。 |
| `structure.html` | テンプレート全体の構造をブラウザで読むための解説ページです。 |
| `guides/` | 設定、見た目、model、演出、配信者向け調整の詳説です。 |

## よく触る設定

| やりたいこと | 触る場所 |
| --- | --- |
| アプリ設定に項目を追加する | `manifest.json` の `uiSchema` |
| 設定値を CSS 変数に流す | `index.html` の `cssVars` |
| ON/OFF 設定で class を切り替える | `index.html` の `toggleClasses` |
| ヘッダーやフッター文言を変える | `script.js` の `config.callbacks` |
| コメント本文の加工を変える | `script.js` の `beforeCommitComment()` |
| コメントカードの見た目を変える | `style.css` の `.comment` 周辺 |
| タイピング速度や上限を変える | `manifest.json` の `typingSpeed`、`style.css` の `--typing-step` / `--typing-cap` |
| 登場アニメーションを増やす | `manifest.json` の `animationStyle`、`script.js` の `animationClasses`、`style.css` の `kh-anim-*` |

## 読む順番

1. `guides/first-edit.html` で、最初に触る場所を確認します。
2. `structure.html` をブラウザで開き、全体構造を確認します。
3. `guides/usage.html` で、配信者がどの設定を触る想定か確認します。
4. `manifest.json` と `index.html` の `komehub-template-options` を見比べます。
5. `script.js` の `beforeCommitComment()` で、raw comment が表示用 model に変わる流れを確認します。
6. `style.css` の `.comment`、`.typing-char`、`kh-anim-*` を調整します。
