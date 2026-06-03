# ticker-basic-sample

> **公開ドキュメント** — 配布バイナリに同梱される。

横流れコメントの最小スターター。
`htmlFirst.start({ mode: 'ticker', renderlessModel: true })` で起動する。

## 要点

- HTML 側で `data-kh-start="ticker"` を指定
- `cellTemplate` でコメント 1 件分の DOM を定義
- `renderlessModel: true` で beforeCommitComment 経路を有効化

## 関連 doc

- `docs/template-authoring-guide.md` §3「`横流れ`」
- `docs/template-runtime.md` §9.2「ticker」

このサンプルは ticker の最小形を確認するための教材。配信用の横流れテンプレを
作る場合は、まず `effects-overlay/templates/ticker-renderless/` を複製する。

## 派生する場合

正式な横流れサンプル (README + structure.html + guides 同梱) は
`effects-overlay/templates/ticker-renderless/` にある。本サンプルは最小
スターターとして読み、実装の足場にしたい場合は ticker-renderless を複製する。
