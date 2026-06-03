# list-html-first-sample

> **公開ドキュメント** — 配布バイナリに同梱される。

`htmlFirst.start()` + `cellTemplate` の最小 27 行サンプル。
`通常` (縦リスト) 入口の最短 HTML-first スターター。

## 要点

- HTML 側に `data-kh-start="list"` と `data-kh-template` を置く
- `<script type="application/json">` に `config` と `preview` を書く
- JS は `window.KomehubTemplateRuntime.htmlFirst.start();` のみ

## 関連 doc

- `docs/template-authoring-guide.md` §5「HTML-first の最短コース」
- `docs/template-runtime.md` §8「`htmlFirst.start()`」

最初に読むサンプルとしてはこれが一番短い。動きを理解した後、配信用の土台は
`effects-overlay/templates/standard-renderless/` から複製する。

## 派生する場合

主軸テンプレから派生したいなら、本サンプルではなく
`effects-overlay/templates/standard-renderless/` (= 同等の最短形 + renderless model 経路) を
複製元にする方が後の拡張が楽。
