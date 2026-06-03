# アーキテクチャ概要

このドキュメントは、コントリビューターが全体像をつかむための**高レベルな設計概要**です。
細かい API はコードと各 `docs/` のテンプレート開発ドキュメントを参照してください。

## 全体像

Live Comment Hub は 3 つの層で構成されます。

```
            YouTube Live
                │  (コメント / リアクション)
                ▼
┌───────────────────────────────────────────────┐
│ Electron (electron/)                           │
│  chat-scraper … YouTube からコメントを取得      │
│  main / preload / renderer … UI と補助 I/O      │
│  core-bridge … Rust コア (ネイティブアドオン) 呼出 │
└───────────────────────────────────────────────┘
                │  (取得コメントをコアへ投入)
                ▼
┌───────────────────────────────────────────────┐
│ Rust core (core/)  ← アプリの中核エンジン        │
│  コメントの評価・集計・リスナー分類・演出評価     │
│  HTTP / SSE / WebSocket を Rust 側に集約         │
└───────────────────────────────────────────────┘
                │  (SSE / WebSocket)
                ▼
┌───────────────────────────────────────────────┐
│ Overlay (effects-overlay/)                     │
│  コメント表示テンプレート / 演出エフェクト        │
│  OBS のブラウザソースとして読み込まれる           │
└───────────────────────────────────────────────┘
```

データの流れ（コメント 1 件）:
**YouTube → chat-scraper (Electron) → Rust コア（評価・集計）→ SSE → コメント表示テンプレート / 演出（OBS）**

## コンポーネント

### `core/`（Rust コア）

アプリの中核。`napi-rs` でビルドされた**ネイティブアドオン**（`komehub_core.node`）として Electron に組み込まれます。

| モジュール | 役割 |
|---|---|
| `engine/` | 演出エンジン・コメント処理・リスナー分類などのドメインロジック |
| `model_queue` / `model_queue.rs` | 中核状態（MainStore / MainSession）の更新を直列化するキュー |
| `state/` | 接続状態・リスナーなどの状態表現 |
| `surface/` | HTTP / SSE / WebSocket の入口（ルーティング） |
| `shared_memory.rs` | Rust ↔ Electron 間の状態共有（固定レイアウト） |
| `napi_bridge.rs` | JS から呼ばれる公開 API（napi 境界） |
| `image_cache/` / `font_cache/` | 画像・フォントのローカルキャッシュ |
| `tts.rs` / `notification_*` | 読み上げ・通知 |
| `innertube_parser.rs` | YouTube InnerTube レスポンスの解析 |
| `common/` / `infra/` / `logging.rs` | 共通ユーティリティ・基盤・ロギング |

### `electron/`（アプリ本体）

| ファイル | 役割 |
|---|---|
| `chat-scraper.js` | YouTube からのコメント取得（InnerTube JSON の横取り） |
| `main.js` | メインプロセス。ウィンドウ・IPC・補助 I/O のオーケストレーション |
| `core-bridge.js` | Rust ネイティブアドオンのロードと呼び出し |
| `preload.js` | レンダラへの安全な API 公開（contextBridge） |
| `renderer/` | 設定・リスナー分析・検索などの UI |
| `migration.js` | バージョン間のデータマイグレーション |

### `effects-overlay/`（オーバーレイ）

| ディレクトリ | 役割 |
|---|---|
| `templates/` | コメント表示テンプレート（ビルトイン） |
| `template-runtime/` | 全テンプレート共通のランタイム（SSE 接続・設定注入・描画補助） |
| `plugins/` | 演出エフェクトプラグイン（`manifest.json` + JS） |
| `onecomme/` | OneComme 互換レイヤー（`onesdk.js` / WebSocket 配信） |
| `js/` | 物理・サウンド等の汎用共有ライブラリ |

## 設計原則

- **Rust コアが演出・評価エンジンの単体実装**。コメント → Rust で評価 → SSE → Node.js API → OBS、という一方向の流れ。
- **中核状態の更新は ModelQueue 経由に一本化**（単一ライター）。Surface / bridge / 補助 I/O から直接状態を書き換えない。
- **状態は「共有インターフェース」として読み取り自由・書き込みはオーナーのみ**。エンジン間でデータを内部コピーして持たない。
- **エンジンの分岐はステートマシン駆動**。`paused: bool` のようなフラグの二重管理を避け、状態の列挙に置き換える。
- **ダブルバッファリングは Rust ↔ Electron 間のみ**。Rust 内部は ModelQueue の単一スレッド保証があるため不要。
- **派生値も状態フィールド化し、shared_memory レイアウトと 1:1 で同期**。SSE に後付けで inject する設計は採らない。
- **HTTP / SSE / WebSocket の面は Rust 側に集約**。JS 側は外部 I/O 能力の提供と UI に徹する。

## データの保存

| 保存先 | 用途 |
|---|---|
| `listeners.db`（SQLite） | コメント・リスナー・配信ログ。コメント本文は zstd 圧縮して格納 |
| `app-config.json`（Rust 側 AppConfig） | 機能設定の正本（TTS・通知・リスナー分類など） |
| `electron-store`（config.json） | ウィンドウ位置などの UI 一時状態のみ |

> ユーザーデータ（コメント・リスナー情報・設定）はすべてユーザーの PC 内に保存されます。

## コメント配信（テンプレート / OBS 向け）

- テンプレートは `http://localhost:{port}/templates/{sceneId}/{templateName}/` で配信。
- コメントは **SSE**（`/.../stream`）でリアルタイム push。
- OneComme 互換テンプレート向けには **WebSocket**（`onesdk.js`）でも配信。
- 設定は SSE の `config` イベントで初回送信 + 変更時 push。

## エフェクトプラグイン

- 1 エフェクト = `effects-overlay/plugins/<dir>/`（`manifest.json` + JS）。
- OBS ブラウザソース互換のため ES module は使わず、IIFE + 動的 script 注入。
- エフェクト ID はリバースドメイン形式。`manifest.json` の `uiSchema` で設定 UI を動的生成。

## ビルド

- `npm run build:core` … `cargo build --release` でコアをビルドし、ネイティブアドオンを配置。
- `npm run build` … 上記に続けて `electron-builder` でインストーラ / ポータブルを生成。
- 詳細は [README.md](README.md) を参照。
