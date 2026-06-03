# Live Comment Hub (こめはぶ)

YouTube Live のコメント・リアクションをリアルタイムに取得し、SSE API で外部へ配信する
Electron アプリケーションです。アバターオーバーレイ、コメント表示テンプレート、リスナー
分析などの機能を備えます。

> 本リポジトリはアプリをビルドするために必要なソース一式を公開したものです。
> 配布ビルドの入手・使い方は公式サイト <https://www.komehub.com/> を参照してください。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `core/` | Rust 製コアエンジン (napi-rs ネイティブアドオン)。コメント取得・演出評価・SSE 配信 |
| `electron/` | Electron アプリ本体 (メインプロセス / レンダラ / preload) |
| `effects-overlay/` | 演出エフェクトプラグイン + コメント表示テンプレート |
| `docs/` | テンプレート開発者向けドキュメントとサンプル |
| `test/` | ユニットテスト |

## 必要環境

- [Node.js](https://nodejs.org/) 20 以上
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain) + Cargo
- Windows (配布ターゲット。ビルドは Windows を想定)

## ビルド

```sh
npm install
npm run build
```

`npm run build` は次を順に実行します。

1. `npm run build:core` — `cargo build --release` でコアをビルドし、ネイティブアドオン
   (`komehub_core.node`) を配置
2. `electron-builder` — インストーラ + ポータブル exe を `dist/` に出力

Windows では `build.bat` をダブルクリックしても同じビルドが走ります。

## 開発起動

```sh
npm start
```

開発用にコア (debug) のビルド + 起動をまとめて行う `start-dev.bat` も利用できます。

## テスト

```sh
npm test
```

`core/` の Rust テストは次で実行できます。

```sh
cargo test --manifest-path core/Cargo.toml
```

## 貢献

Issue / Pull Request を歓迎します。開発の進め方・ブランチ運用は
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT License](LICENSE) で公開しています。
