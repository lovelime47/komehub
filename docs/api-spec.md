# Live Comment Hub API 仕様書

> **公開ドキュメント** — 配布バイナリに同梱される。Live Comment Hub と連携するアプリ・オーバーレイを実装する開発者向けの公開 API 仕様です。

## 概要

Live Comment Hub は YouTube Live のコメントとリアクションを取得し、HTTP と SSE で外部クライアントへ配信する。  
加えて、シーン別の演出オーバーレイ配信と、演出の手動発火 API も提供する。

- デフォルトポート: `11280`
- ベースURL: `http://localhost:11280`
- バインド先: 既定は `127.0.0.1`。通常の API / OBS オーバーレイはローカル PC からだけ到達できる
- リモート操作: ポン出し Window から明示的に有効化した場合だけ、別ポートでリモート専用 Router を開く
- 公開 API の正本実装は Rust `axum`
- 公開 HTTP / SSE / WS と静的配信はすべて Rust core が担当する
- Electron からの主経路は `komehub_core.node` への napi 直接呼び出し

## SSE ストリーム

### 1. グローバルストリーム

```
GET /api/stream
```

用途:

- コメントとリアクションをリアルタイム受信する
- 接続状態の変化を受ける
- オーバーレイ用の `version` / `reload` を受ける
- 演出発火の `performance` もまとめて監視する

接続時に即座に送信されるメッセージ:

- `version`
- `status`

その後に送信されるメッセージ:

- `event`
- `pause`
- `performance`
- `reload`
- `: keepalive` コメントを30秒ごと

### 2. シーン別演出ストリーム

```
GET /effects/{sceneId}/stream
```

用途:

- 特定シーン向けの演出指示だけを受ける
- `effects-overlay/` が内部で利用する

接続時に即座に送信されるメッセージ:

- `version`

その後に送信されるメッセージ:

- `performance`
- `pause`
- `reload`
- `: keepalive` コメントを30秒ごと

## メッセージ形式

すべての SSE メッセージは `data:` 行に JSON として送信される。

### `event`

ユーザーアクションを表す標準イベント。

```json
{
  "type": "event",
  "event": "comment",
  "data": { "...": "..." },
  "timestamp": 1710806400000
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `type` | string | 常に `"event"` |
| `event` | string | 現在は `comment` または `reaction` |
| `data` | object | イベント固有データ |
| `timestamp` | number | サーバー受信時刻の Unix ミリ秒 |

### `status`

接続状態の変化を表す。

```json
{
  "type": "status",
  "data": {
    "connected": true,
    "videoId": "xxx",
    "viewerCount": 0
  }
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `type` | string | 常に `"status"` |
| `data.connected` | boolean | YouTube Live への接続状態 |
| `data.videoId` | string\|null | 接続中の動画ID |
| `data.viewerCount` | number | 未実装のため現在は `0` 固定 |

### `version`

SSE 接続直後に送信されるアプリバージョン。

```json
{
  "type": "version",
  "data": "0.3.1"
}
```

### `reload`

設定変更後、オーバーレイに再読み込みを促す通知。

```json
{
  "type": "reload"
}
```

### `pause`

演出エンジンの一時停止状態変化を表す。

```json
{
  "type": "pause",
  "data": {
    "paused": true
  }
}
```

### `performance`

演出エンジンが生成した演出指示。

```json
{
  "type": "performance",
  "sceneId": "game",
  "data": {
    "sceneId": "game",
    "performanceId": "perf_abc123",
    "effect": {
      "id": "sprout",
      "type": "sprout",
      "params": { "duration": 3000 }
    },
    "assets": ["sample.html"],
    "sounds": ["se.mp3"],
    "context": {
      "userName": "@viewer",
      "comment": "こんにちは"
    }
  },
  "timestamp": 1710806400000
}
```

補足:

- `/api/stream` では `sceneId` を含むラップ形式で流れる
- `/effects/{sceneId}/stream` では `data` の中身だけがそのまま流れる
- `context` にはコメント、スパチャ額、メンバー情報、ギフト数などが入ることがある

## イベント種別

### `comment`

通常コメント、スーパーチャット、スーパーステッカー、メンバー加入、メンバーギフトを含む。  
現在の API では、これらはすべて `event: "comment"` として流れ、種別は `data` の追加フィールドで見分ける。

通常コメントの例:

```json
{
  "type": "event",
  "event": "comment",
  "data": {
    "id": "yt-ChwKGkNO...",
    "name": "@username",
    "comment": "こんにちは",
    "commentHtml": "こんにちは <img src=\"https://yt3.ggpht.com/...\" alt=\"stamp\">",
    "emojis": [
      {
        "src": "https://yt3.ggpht.com/...",
        "alt": "stamp",
        "emojiId": "UCxxx/xxxxx",
        "isCustom": true
      }
    ],
    "profileImage": "https://yt4.ggpht.com/...",
    "timestamp": "12:34",
    "hasGift": false,
    "isMember": true,
    "memberMonths": 6
  },
  "timestamp": 1710806400000
}
```

スーパーチャット系の例:

```json
{
  "type": "event",
  "event": "comment",
  "data": {
    "id": "paid-...",
    "name": "@supporter",
    "comment": "応援しています！",
    "profileImage": "https://yt4.ggpht.com/...",
    "timestamp": "2026-03-19T00:00:00.000Z",
    "hasGift": true,
    "amount": 1000,
    "currency": "¥",
    "stickerImage": ""
  },
  "timestamp": 1710806400000
}
```

主なフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | コメントの一意ID |
| `name` | string | 表示名 |
| `comment` | string | プレーンテキストの本文 |
| `commentHtml` | string | 絵文字 `<img>` を含む HTML。通常コメント時のみ |
| `emojis` | array | コメント内の絵文字・スタンプ。通常コメント時のみ |
| `profileImage` | string | プロフィール画像 URL |
| `timestamp` | string | YouTube 表示時刻または ISO 8601 |
| `hasGift` | boolean | 課金系メッセージかどうか |
| `isMember` | boolean | 通常コメント送信者がメンバーか |
| `memberMonths` | number | メンバー継続月数 |
| `amount` | number | スーパーチャット額 |
| `currency` | string | 通貨記号または通貨コード |
| `stickerImage` | string | スーパーステッカー画像 URL |
| `isMembership` | boolean | メンバー加入・更新メッセージ |
| `membershipHeader` | string | メンバー加入ヘッダ文言 |
| `isMembershipGift` | boolean | メンバーギフトメッセージ |
| `giftCount` | number | ギフト人数 |

補足:

- `commentHtml` はそのまま信用せず、描画時はサニタイズを推奨
- 課金系・加入系のメッセージでは `commentHtml` や `emojis` が存在しないことがある

### `reaction`

視聴者がリアクションボタンを押した際のイベント。

```json
{
  "type": "event",
  "event": "reaction",
  "data": {
    "emoji": "heart",
    "count": 1
  },
  "timestamp": 1710806400000
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `emoji` | string | `heart`, `smile`, `celebration`, `surprise`, `hundred` |
| `count` | number | 同時に検出された数 |

## HTTP エンドポイント

### `GET /api/status`

現在の接続状態を返す。

```json
{
  "connected": true,
  "videoId": "BimDylJsK_U",
  "viewerCount": 0
}
```

Rust core 未起動時はこのエンドポイント自体に接続できない。

### `GET /api/events`

最近のイベントを返す。保持数は最大500件。

```
GET /api/events
GET /api/events?limit=50
GET /api/events?type=comment
GET /api/events?type=reaction&limit=50
```

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `limit` | number | `500` | 返却件数上限 |
| `type` | string | 指定なし | `comment` または `reaction` でフィルタ |

### `GET /api/comments`

後方互換用。`comment` イベントの `data` だけを返す。

```
GET /api/comments
GET /api/comments?limit=50
```

新規実装では `GET /api/events?type=comment` を推奨。

### `POST /api/trigger/{sceneId}/{performanceId}`

指定シーンの演出を手動発火する。

```
POST /api/trigger/game/perf_abc123
```

レスポンス例:

```json
{
  "success": true
}
```

Rust core 未起動時はこのエンドポイント自体に接続できない。

ブラウザから `fetch()` する場合は、`OPTIONS` プリフライトにも対応している。

## Step 3: リスナー管理 API (v0.4.0〜)

配信者が「誰がいつ何をコメントしたか」を後から振り返るための SQLite データベースを公開する HTTP API。
すべて `data/listeners.db` を Rust core 経由で参照する。**自チャンネル設定 (UC...) が済んでいる必要あり**。

### `GET /api/listeners`

リスナー一覧を返す。

| パラメータ | 型 | 既定 | 説明 |
|---|---|---|---|
| `sort` | string | `lastSeen` | `lastSeen` / `commentCount` / `superchatAmount` / `displayName` |
| `q` | string | (なし) | 表示名の部分一致検索 (大小文字無視) |
| `limit` | number | `100` | 1 ページの行数 (1〜1000) |
| `offset` | number | `0` | ページング |
| `streamVideoId` | string | (なし) | 指定枠で発言したリスナーだけに絞り込み、`greetedAt` / `perStreamScAmountJpy` を含める |
| `unGreetedOnly` | boolean | `false` | `streamVideoId` 指定時、未対応リスナーだけに絞り込み |
| `firstInStreamOnly` | boolean | `false` | `streamVideoId` 指定時、この枠で初めてコメントしたリスナーだけ |
| `comebackOnly` | boolean | `false` | `streamVideoId` 指定時、直近 14 枠に不在だった復帰リスナーだけ |
| `newMemberOnly` | boolean | `false` | `streamVideoId` 指定時、この枠でメンバー加入したリスナーだけ |
| `systemTags` | string[] | `[]` | `first-time` / `returning` / `regular` / `veteran` |

レスポンス:
```json
{
  "ok": true,
  "page": {
    "total": 1234,
    "limit": 100,
    "offset": 0,
    "rows": [
      {
        "channelId": "yt-UCxxxxxxxxxxxxxxxxxxxxxx",
        "displayName": "alice",
        "username": "@alice",
        "iconUrl": "https://...",
        "nameHistory": [],
        "firstSeenAt": 1730000000000,
        "lastSeenAt": 1730086400000,
        "commentCount": 42,
        "superchatCount": 3,
        "superchatAmountJpy": 4500,
        "isMember": true,
        "isModerator": false,
        "memberMonthsMax": 12,
        "notes": "",
        "label": "",
        "nickname": "",
        "lastCommentBody": "こんにちは",
        "lastCommentHtml": "こんにちは",
        "greetedAt": 0,
        "perStreamScAmountJpy": 0,
        "raw": null
      }
    ]
  }
}
```

### `GET /api/listeners/by-channel/{channel_id}`

リスナー詳細 + 直近コメント。`channel_id` は `yt-` prefix の有無どちらでも可。

| パラメータ | 型 | 既定 | 説明 |
|---|---|---|---|
| `recentCommentLimit` | number | `50` | 直近コメントの取得件数 (1〜200) |

```json
{
  "ok": true,
  "detail": {
    "channelId": "yt-UCxxx",
    "displayName": "alice",
    /* ListenerRow と同じフィールド */
    "recentComments": [ /* CommentRow 配列 */ ]
  }
}
```

### `GET /api/listeners/by-channel/{channel_id}/chip-counts`

リスナー詳細画面用の件数と、必要に応じて現枠での対応済み状態を返す。

| パラメータ | 型 | 既定 | 説明 |
|---|---|---|---|
| `contextVideoId` | string | (なし) | 指定時、この枠の `greetedAt` を返す |

レスポンス: `{"ok": true, "counts": {...}}`

### `GET /api/listeners/owner-channel` / `PUT /api/listeners/owner-channel`

自チャンネル設定一覧の取得・一括上書き。**複数 ID 対応** (サブチャンネル等)。各要素は `{channelId, handle?}`。`handle` は `@`接頭子なしの YouTube チャンネルハンドル (例: `amanotobari`)。

GET レスポンス: `{"ownerChannels": [{"channelId":"UCxxx","handle":"name"|null}, ...]}`

PUT リクエスト: `{"ownerChannels": [{"channelId":"UCxxx","handle":"name"}, ...]}` (空配列で全クリア)

PUT レスポンス: `{"ok": true, "ownerChannels": [...]}` または `{"ok": false, "error": "Invalid YouTube channel id (must match ^UC[A-Za-z0-9_-]+$): ..."}`

判定: `import_from_onecomme` / `dispatch_listener_record` で `configured_ids` のいずれかと `stream_owner` が一致すれば自チャンネル配信扱い。

### `GET /api/listeners/streams`

配信ログ一覧。

| パラメータ | 型 | 既定 | 説明 |
|---|---|---|---|
| `sort` | string | `startedAt` | `startedAt` / `commentCount` / `superchatAmount` |
| `limit` | number | `100` | 1 ページの行数 (1〜500) |
| `offset` | number | `0` | ページング |

レスポンス: `{"ok": true, "page": {"total": N, "limit": L, "offset": O, "rows": [...]}}` (rows は StreamRow 配列)

### `GET /api/listeners/streams/{video_id}`

配信詳細 + 直近コメント。

| パラメータ | 型 | 既定 | 説明 |
|---|---|---|---|
| `recentCommentLimit` | number | `100` | 直近コメントの取得件数 (1〜500) |

### `GET /api/listeners/comments/search`

コメント検索 (任意の組合せで絞り込み + ページング)。

| パラメータ | 型 | 説明 |
|---|---|---|
| `streamId` | string | 配信 ID 完全一致 |
| `listenerChannelId` | string | リスナー channel id 完全一致 (yt- prefix 任意) |
| `commentType` | string | `chat` / `superchat` / `membership` / `sticker` / `gift` |
| `q` | string | 本文の部分一致 (大小文字無視) |
| `bodyQ` | string | 本文の部分一致。POST body ではこちらを使う |
| `streamTitleQ` | string | 配信タイトルの部分一致 |
| `nameQ` | string | リスナー表示名 / nickname の部分一致 |
| `unrespondedOnly` | boolean | `true` なら `respondedAt = 0` のコメントだけ |
| `memberOnly` | boolean | `true` ならメンバーのコメントだけ |
| `limit` | number | 既定 100 (1〜500) |
| `offset` | number | ページング |

レスポンス: `{"ok": true, "page": {"total": N, "rows": [...]}}` (rows は CommentRow 配列)

複数値条件が必要な場合は同じ path に `POST` し、`CommentsQuery` JSON を body に入れる。
対象フィールド: `streamIds`, `listenerChannelIds`, `commentTypes`, `systemTags`, `userTags`, `streamTags` など。

### `POST /api/listeners/by-channel/{channel_id}/greeted`

現枠でのリスナー「対応済み」状態を更新する。public core port と remote port の両方で公開される限定書き込み。

```json
{ "streamVideoId": "BimDylJsK_U", "value": 1 }
```

レスポンス: `{"ok": true, "greetedAt": 1710806400000}`。`value: 0` で解除。

### `POST /api/comments/{comment_id}/responded`

コメントの「対応済み」状態を更新する。public core port と remote port の両方で公開される限定書き込み。

```json
{ "value": 1 }
```

レスポンス: `{"ok": true, "respondedAt": 1710806400000}`。`value: 0` で解除。

### `POST /api/listeners/by-channel/{channel_id}/hidden`

配信者 UI 上の非表示状態を更新する。テンプレート / OBS / 演出評価には影響しない。

```json
{
  "hideFromComments": true,
  "hideFromListeners": false
}
```

レスポンス: `{"ok": true, ...}`。両方 `false` なら `hiddenListeners` の record は削除される。

### Electron IPC 専用 API

以下は **HTTP からは公開しない** (任意パス書き込み・読み込みリスク回避)。Electron renderer から `window.api.listeners.{...}` で呼び出す。

| 機能 | preload API | 内部 ModelCommand |
|---|---|---|
| こめはぶ形式 JSON Lines エクスポート | `api.listeners.exportJsonl()` (dialog でファイル保存先選択) | `ExportKomehubJsonl` |
| こめはぶ形式 JSON Lines インポート | `api.listeners.importJsonl()` (dialog でファイル選択) | `ImportKomehubJsonl` |
| わんコメインポート (Plan A 単方向取込) | `api.listeners.importFromOnecomme()` (dialog でフォルダ選択) | `ImportFromOnecomme` |
| わんコメ書き戻し (Plan A) | `api.listeners.exportToOnecomme()` | `ExportToOnecomme` |
| わんコメ起動検知 | `api.listeners.detectOnecommeRunning()` | `DetectOnecommeRunning` |
| 双方向同期 (今すぐ同期) | `api.listeners.runBidirectionalSync()` | `RunBidirectionalSync` |
| 自チャンネル設定取得 (複数 ID) | `api.listeners.getOwnerChannels()` | `GetOwnerChannels` |
| 自チャンネル設定一括上書き | `api.listeners.setOwnerChannels(channels)` | `SetOwnerChannels` |
| @ハンドル ⇔ UC 双方向解決 | `api.listeners.resolveChannelInfo(input)` | (main.js HTTP fetch) |
| リスナーメタデータ更新 (nickname/notes/label) | `api.listeners.updateMetadata(channelId, fields)` | `UpdateListenerMetadata` |
| 配信メタデータ更新 (動的値含む) | `coreBridge.updateStreamMetadata(videoId, fields)` | `UpdateStreamMetadata` |

### Step 4: 配信メタデータ取得 (HTTP スクレイピング、main.js 内部)

配信接続時に main.js が `https://www.youtube.com/watch?v={id}` を **30 秒間隔で fetch** し、`ytInitialData` / `ytInitialPlayerResponse` を解析して `update_stream_metadata` 経由で core に push する (gzip 圧縮で約 124 KB/req)。

抽出フィールド:

| 項目 | 取得元 | 動的更新 |
|---|---|---|
| タイトル | `playerResponse.videoDetails.title` | 静的 (初回) |
| チャンネル名 | `playerResponse.videoDetails.author` | 静的 |
| チャンネル ID | `playerResponse.videoDetails.channelId` | 静的 |
| アイコン URL | `videoSecondaryInfoRenderer.owner.videoOwnerRenderer.thumbnail.thumbnails[-1].url` | 静的 |
| 開始時刻 (絶対) | `microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp` | 静的 |
| 概要欄 | `playerResponse.videoDetails.shortDescription` | 静的 |
| 同時接続数 | `videoPrimaryInfoRenderer.viewCount.videoViewCountRenderer.viewCount.runs[0].text` | ✓ 30s |
| 維持ピーク | (クライアント計算) 直近 5 分窓内最小値を peak 候補に MAX 蓄積 | ✓ 30s |
| いいね数 | `videoActions.menuRenderer.topLevelButtons[].segmentedLikeDislikeButtonViewModel.likeButtonViewModel.likeButtonViewModel.toggleButtonViewModel.toggleButtonViewModel.defaultButtonViewModel.buttonViewModel.title` | ✓ 30s |
| 登録者数 | `videoOwnerRenderer.subscriberCountText.simpleText` (「1,120人」「1.2万人」「12K」等を `parseJapaneseNumber` で正規化) | ✓ 30s |
| 配信終了時刻 | `microformat.playerMicroformatRenderer.liveBroadcastDetails.endTimestamp` (`isLiveNow=false` 時) または切断時の `Date.now()` | 終了検知時 |

renderer 側は SSE event `stream-metadata-updated` を購読して受信。配信時間カウンタは `startedAt` から 1 秒間隔で renderer 側 setInterval で計算 (DB 不要)。

### 動作条件

- リスナー記録: **自チャンネル設定済み + chat-scraper が自チャンネル配信に接続中** のときだけ書き込み
- わんコメ書き戻し: **わんコメ終了 + 配信切断 + 観測スキーマハッシュ記録済み + 両必須テーブル (`comments` / `users`) 揃う** ときだけ実行 (どれか欠けると `aborted: true` で何も書かない)
- 起動時自動同期 (F-20): Electron `onReady` 直後に自動発火、上記条件を満たさない場合は skip

## オーバーレイ配信

### 演出オーバーレイ

```
GET /effects/{sceneId}/
GET /effects/{sceneId}/stream
GET /effects/{sceneId}/assets/{filename}
GET /effects/{sceneId}/mascot/{filename}
```

用途:

- `/effects/{sceneId}/` は演出オーバーレイ HTML
- `/effects/{sceneId}/stream` はシーン別演出 SSE
- `/effects/{sceneId}/assets/{filename}` は演出素材ファイル
- `/effects/{sceneId}/mascot/{filename}` はシーン別マスコット素材ファイル

### 静的ファイル

```
GET /effects/{sceneId}/js/{file}
GET /effects/{sceneId}/css/{file}
```

演出オーバーレイが使用する JS / CSS ファイルを配信する。

### プラグイン

```
GET /effects/{sceneId}/plugins/
GET /effects/{sceneId}/plugins/{pluginDir}/{file}
```

用途:

- `/effects/{sceneId}/plugins/` はプラグイン一覧を JSON 配列で返す。各要素は `{ type, basePath, manifest }` 形式
- `/effects/{sceneId}/plugins/{pluginDir}/{file}` はプラグインの静的ファイル（JS、画像等）を配信する

補足:

- `entry` ファイルが欠損しているプラグインは一覧から除外される
- `minHubVersion` がハブバージョンより新しいプラグインも除外される

### テンプレートとわんコメ互換

```
GET /templates/{sceneId}/one/{seq}/
GET /templates/{sceneId}/one/{seq}/stream
GET /templates/{sceneId}/one/{seq}/{file}
GET /templates/{sceneId}/built-in/{shortName}/
GET /templates/{sceneId}/built-in/{shortName}/stream
GET /templates/{sceneId}/built-in/{shortName}/{file}
GET /templates/{sceneId}/comehub/{id}/
GET /templates/{sceneId}/comehub/{id}/stream
GET /templates/{sceneId}/comehub/{id}/{file}
GET /templates/{sceneId}/selected/
GET /templates/{sceneId}/selected/meta
GET /templates/__runtime/{file}
GET /templates/__origin/{file}
GET /templates/{sceneId}/__origin/{file}
GET /templates/{sceneId}/one/__origin/{file}
GET /templates/{sceneId}/built-in/__origin/{file}
GET /templates/{sceneId}/comehub/__origin/{file}
GET /onecomme/sub
```

用途:

- `/templates/...` はコメント表示テンプレート本体と関連静的ファイルを配信する
- `/templates/.../stream` はテンプレート向け config / comments / deleted を送る SSE
- `/templates/{sceneId}/selected/` は現在選択中テンプレートへ解決する wrapper
- `/templates/{sceneId}/selected/meta` は選択中テンプレートの meta 情報を返す
- `/templates/__runtime/...` は TemplateKit runtime / common CSS を配信する
- `one/{seq}` は scene 内の OneComme テンプレート順を表す
- `built-in/{shortName}` は built-in manifest の短縮名を使う
- `comehub/{id}` は custom / imported テンプレートの canonical id を使う
- `/onecomme/sub` はわんコメ互換テンプレート向け WebSocket

### キャッシュと補助配信

```
GET /cache/fonts/{family}/font.css
GET /cache/fonts/{family}/{file}
GET /cache/{avatars|badges|emojis|stickers}/{file}
GET /template-preview
```

用途:

- `/cache/fonts/...` は事前取得済みフォント CSS / font file を返す
- `/cache/{...}` はコメント描画やテンプレートで参照する画像キャッシュを返す
- `/template-preview` はテンプレート確認用のプレビュー HTML を返す

## CORS とセキュリティ

ブラウザからのアクセス時、サーバーは以下を前提にしている。

- 許可オリジン: `http://localhost:*`, `http://127.0.0.1:*`
- `Origin` ヘッダなしのリクエストは許可
- `file://` からのアクセス時は `Origin: null` に対して `Access-Control-Allow-Origin: null` を返す
- `OPTIONS` プリフライトは `GET, POST, OPTIONS` と `Content-Type` を許可
- 通常の `11280` はローカル専用で、LAN からの操作用には使わない
- リモート操作を有効化した場合だけ、Rust core が別ポートで remote 用 Router を開く
- remote 用 Router にはポン出し操作、停止 / クリア、TTS 即時操作、状態取得、コメント / リスナー閲覧、必要な素材配信だけを載せる
- 削除、import/export、復元、初期化、テンプレート編集、演出詳細編集などは remote 用 Router に載せない
- 静的配信には公開パス制限とパストラバーサル防止が入る

remote 用 Router の主な公開範囲:

- `GET /remote/` — コメント / リスナー閲覧
- `GET /remote/comments`, `GET /remote/listeners`, `GET /remote/listeners/{channel_id}`, `GET /remote/search`
- `GET /remote/ponout/` — ポン出しリモート
- `GET /api/status`, `GET /api/stream`, `GET /api/comments`, `GET /api/events`
- `GET /api/listeners`, `GET /api/listeners/by-channel/{channel_id}`, `GET /api/listeners/by-channel/{channel_id}/chip-counts`
- `GET /api/listeners/comments/search`
- `GET /api/scenes`, `GET /api/app/active-scene`, `GET /api/paused`, `GET /api/tts/state`
- `POST /api/trigger/{scene_id}/{performance_id}`, `POST /api/paused`
- `POST /api/scenes/{scene_id}/performances/clear`
- `POST /api/tts/enabled`, `POST /api/tts/paused`, `POST /api/tts/clear`
- `POST /api/listeners/by-channel/{channel_id}/greeted`
- `POST /api/listeners/by-channel/{channel_id}/hidden`
- `POST /api/comments/{comment_id}/responded`
- `POST /api/listeners/comments/search`

## クライアント実装例

### JavaScript: グローバルストリーム

```js
var es = new EventSource('http://localhost:11280/api/stream');

es.onmessage = function (event) {
  var msg = JSON.parse(event.data);

  if (msg.type === 'version' || msg.type === 'reload') {
    return;
  }

  if (msg.type === 'status') {
    console.log('connected:', msg.data.connected, 'videoId:', msg.data.videoId);
    return;
  }

  if (msg.type === 'performance') {
    console.log('performance:', msg.sceneId, msg.data.effect.type);
    return;
  }

  if (msg.type === 'event') {
    if (msg.event === 'comment') {
      console.log(msg.data.name + ': ' + msg.data.comment);
    } else if (msg.event === 'reaction') {
      console.log('reaction:', msg.data.emoji, 'x' + msg.data.count);
    }
  }
};
```

### JavaScript: シーン別演出ストリーム

```js
var es = new EventSource('http://localhost:11280/effects/game/stream');

es.onmessage = function (event) {
  var msg = JSON.parse(event.data);

  if (msg.type === 'performance') {
    console.log('effect:', msg.data.effect.type);
  } else if (msg.type === 'reload') {
    location.reload();
  }
};
```

### curl

```bash
# グローバルストリーム
curl http://localhost:11280/api/stream

# 接続状態
curl http://localhost:11280/api/status

# 最新コメント50件
curl "http://localhost:11280/api/events?type=comment&limit=50"

# 手動発火
curl -X POST http://localhost:11280/api/trigger/game/perf_abc123
```

### Python

```python
import json
import requests

response = requests.get('http://localhost:11280/api/stream', stream=True)
for line in response.iter_lines():
    if line and line.startswith(b'data: '):
        data = json.loads(line[6:])
        print(data)
```
