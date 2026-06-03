# custom-basic-sample

> **公開ドキュメント** — 配布バイナリに同梱される。

`starters.custom()` の最小サンプル。一覧でも ticker でもない自由構成
(固定ステージ / 単一の大きな表示 / 外部ライブラリ依存の独自描画) の入口。

## 要点

- `runtime.starters.custom()` を呼ぶ
- DOM Parts (`runtime.parts.createName` 等) を使ってコメントから部品を組み立てる
- 一覧 / ticker の制約から外れた構成にできる

## 関連 doc

- `docs/template-authoring-guide.md` §3「`カスタム`」
- `docs/template-runtime.md` §6「Starters」、§4.2「DOM Parts」

`通常` / `横流れ` で表現できる場合は、先にそちらを選ぶ。カスタムは固定ステージや
独自描画など、一覧や ticker の枠に収まらない場合の入口。

## 注意

カスタム入口でも最初に作るのは HTML/CSS。`register()` 直書きは escape hatch
として最小限に留め、まず `starters.custom()` + parts で書けないか検討する。
