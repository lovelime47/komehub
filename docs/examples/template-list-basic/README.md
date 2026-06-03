# list-basic-sample

> **公開ドキュメント** — 配布バイナリに同梱される。

`starters.list({ cellTemplate })` の最小サンプル + dev preview controller の
利用例。`通常` (縦リスト) を JS 側 starter で起動するルートを示す。

## 要点

- JS から `runtime.starters.list({ container, cellTemplate })` を呼ぶ
- HTML 側は `<template id="...">` でコメント 1 件分を定義
- dev preview controller (`?preview=1&devPreview=1` URL) で差分パターンを切替表示

## 関連 doc

- `docs/template-authoring-guide.md` §3「`通常`」
- `docs/template-runtime.md` §6「Starters」、§7「`cellTemplate`」、§11「Dev Preview」

HTML-first だけでは足りず、JS 側で starter を直接呼びたい場合に読むサンプル。
最短で試すだけなら `template-list-html-first/`、配信用に派生するなら
`effects-overlay/templates/standard-renderless/` を先に見る。

## 主軸との関係

主軸 (renderless) は `htmlFirst.start()` + `beforeCommitComment` 経路。
本サンプルは「JS 側 starter で書きたい / dev preview を組み込みたい」用途の参考。
HTML-first で十分な場合は `template-list-html-first/` または
`effects-overlay/templates/standard-renderless/` を選ぶ。
