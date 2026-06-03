# エフェクトプラグイン開発ガイド

> **公開ドキュメント** — 配布バイナリに同梱される。

Live Comment Hub（こめはぶ）のエフェクトプラグインを開発するためのガイドです。

## 目次

- [概要](#概要)
- [ディレクトリ構成](#ディレクトリ構成)
- [manifest.json 仕様](#manifestjson-仕様)
- [JS ファイルの構造](#js-ファイルの構造)
- [インターフェースの2パターン](#インターフェースの2パターン)
- [uiSchema — パラメータ設定UI](#uischema--パラメータ設定ui)
- [data パラメータ](#data-パラメータ)
- [バージョニングとマイグレーション](#バージョニングとマイグレーション)
- [共有ライブラリ](#共有ライブラリ)
- [エントリ以外の JS ファイルの動的ロード](#エントリ以外の-js-ファイルの動的ロード)
- [実装上の注意事項](#実装上の注意事項)
- [配布方法](#配布方法)
- [チュートリアル: 最小構成のプラグインを作る](#チュートリアル-最小構成のプラグインを作る)

---

## 概要

エフェクトプラグインは、YouTube Live のコメントやスーパーチャットに対して画面上にビジュアル演出を表示する仕組みです。OBS のブラウザソースとして動作するため、ES module は使わず IIFE パターンで記述します。

## ディレクトリ構成

各プラグインは `effects-overlay/plugins/<dirname>/` に配置します。

```
effects-overlay/plugins/
  my-effect/
    manifest.json    ← 必須: プラグインのメタ情報
    my-effect.js     ← 必須: エフェクト本体（manifest.entry）
    engine.js        ← 任意: 分離した演出ロジック等（エントリから動的ロード）
    template.html    ← 任意: HTMLテンプレート等
    assets/          ← 任意: 画像等の素材
```

エントリ（`manifest.entry`）以外の JS をプラグインディレクトリに置く場合は、エントリから動的ロードします（→ [エントリ以外の JS ファイルの動的ロード](#エントリ以外の-js-ファイルの動的ロード)）。プラグインディレクトリ配下のファイルはエクスポート時にまるごと同梱されます。

## manifest.json 仕様

manifest.json はプラグインの定義ファイルです。全フィールドの一覧を以下に示します。

```json
{
  "id": "com.example.my-effect",
  "version": "1.0.0",
  "name": "マイエフェクト",
  "emoji": "✨",
  "entry": "my-effect.js",
  "globalName": "MyEffect",
  "interface": {
    "methods": ["fire"],
    "hasPause": false
  },
  "defaultAssets": ["🎉"],
  "defaultParams": {
    "count": 16,
    "duration": 3000
  },
  "dependencies": [],
  "migrations": {},
  "minHubVersion": "0.3.0",
  "badgeColor": {
    "bg": "#4a1d00",
    "fg": "#fb923c"
  },
  "uiSchema": [
    {
      "key": "count",
      "type": "slider",
      "label": "個数",
      "min": 0,
      "max": 30,
      "default": 1
    }
  ]
}
```

### フィールド一覧

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | Yes | リバースドメイン形式のグローバルユニークID（例: `com.example.my-effect`） |
| `version` | string | Yes | セマンティックバージョニング（例: `1.0.0`） |
| `name` | string | Yes | ハブUIに表示される名前 |
| `emoji` | string | Yes | アイコン（絵文字 or 画像パス） |
| `entry` | string | Yes | エフェクト本体のJSファイル名 |
| `globalName` | string | Yes | `window` に公開するグローバル変数名 |
| `interface` | object | Yes | エフェクトの動作インターフェース定義 |
| `interface.methods` | string[] | Yes | `"fire"` または `"show"` を含む配列 |
| `interface.hasPause` | boolean | Yes | 一時停止に対応するか |
| `defaultAssets` | string[] | Yes | デフォルトの素材配列（絵文字 or 画像パス）。空配列 `[]` も可 |
| `defaultParams` | object | Yes | デフォルトパラメータ（effects.json で上書き可能） |
| `dependencies` | string[] | Yes | 共有ライブラリの依存（例: `["physics"]`）。不要なら `[]` |
| `migrations` | object | Yes | バージョンアップ時のパラメータ変換ルール。不要なら `{}` |
| `minHubVersion` | string | No | 動作に必要なハブの最小バージョン（例: `"0.3.0"`）。非互換の場合インポート拒否・ロード除外される |
| `badgeColor` | object | No | ハブUIでのバッジ色 |
| `badgeColor.bg` | string | — | 背景色（CSS色） |
| `badgeColor.fg` | string | — | 文字色（CSS色） |
| `uiSchema` | array | No | ハブUIに表示するパラメータ設定のウィジェット定義 |

## JS ファイルの構造

IIFE（即時実行関数式）パターンで `window` にグローバル公開します。

```javascript
var MyEffect = (function () {
  var container;

  function init(c) {
    container = c;
  }

  function fire(params, assets, data) {
    if (!container) return;

    // params: manifest.defaultParams の値（effects.json で上書き可能）
    // assets: 素材配列（絵文字 or 画像パス）
    // data:   演出ごとのオーバーライド値（uiSchema で定義したキー等）

    // ここにエフェクトの実装を書く
  }

  return { init: init, fire: fire };
})();
```

### 関数の役割

| 関数 | 説明 |
|---|---|
| `init(container)` | 初期化。描画先のDOM要素（container）を受け取る。必ず実装する |
| `fire(params, assets, data)` | fire型エフェクトのエントリポイント |
| `show(params, assets, data)` | show型エフェクトのエントリポイント |
| `setPaused(value)` | `hasPause: true` の場合に実装する。`true` で一時停止、`false` で再開 |

### 引数の詳細

**params** — `manifest.defaultParams` をベースに、ユーザーが effects.json で上書きした値がマージされたオブジェクト。

**assets** — 素材の配列。絵文字の場合は文字列（例: `"🎉"`）、画像の場合はパス文字列。

**data** — 演出呼び出し時のオーバーライド値。uiSchema で定義したキーの値に加え、以下の共通キーが含まれます:

| キー | 型 | 説明 |
|---|---|---|
| `count` | number | 個数 |
| `scale` | number | サイズ（%） |
| `zOrder` | number | z-index値 |
| その他 | any | uiSchema で定義した任意のキー |

## インターフェースの2パターン

### fire 型 — パーティクル・一発発火系

呼ばれたら即座にエフェクトを生成し、アニメーションして自然に消えるタイプ。

**適した用途**: クラッカー、紙吹雪、落下、上昇、花火など

```javascript
function fire(params, assets, data) {
  if (!container) return;

  var count = (data && data.count != null) ? data.count : 3;
  var scale = (data && data.scale != null) ? data.scale : 100;
  var zOrder = (data && data.zOrder) || 1;

  for (var i = 0; i < count; i++) {
    var el = document.createElement('div');
    el.textContent = assets[Math.floor(Math.random() * assets.length)];
    el.style.cssText =
      'position:absolute;' +
      'font-size:' + (32 * scale / 100) + 'px;' +
      'z-index:' + zOrder + ';';
    container.appendChild(el);

    // アニメーション後に削除
    animate(el);
  }
}
```

### show 型 — 表示系

要素を表示し、一定時間待機してから消えるタイプ。

**適した用途**: 固定メッセージ表示、スライドイン、全画面オーバーレイなど

```javascript
function show(params, assets, data) {
  if (!container) return;

  var stayDuration = (data && data.stayDuration != null) ? data.stayDuration : 10000;

  var el = document.createElement('div');
  // ... 要素を構築 ...
  container.appendChild(el);

  // 表示時間後に消す
  setTimeout(function () {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.5s';
    safeRemove(el, 600);
  }, stayDuration);
}
```

### setPaused — 一時停止対応

`interface.hasPause` を `true` にした場合、`setPaused` 関数を実装する必要があります。

```javascript
var paused = false;

function setPaused(val) {
  paused = val;
  // アニメーションの一時停止/再開処理
}

return { init: init, show: show, setPaused: setPaused };
```

## uiSchema — パラメータ設定UI

uiSchema でハブの設定画面にパラメータ調整UIを自動生成できます。利用可能なウィジェット種別は slider / buttons / toggle / text / textarea / color / image / checks、 および全種別で使える補助プロパティ group / showIf です。

### slider — スライダー

```json
{
  "key": "count",
  "type": "slider",
  "label": "個数",
  "min": 0,
  "max": 30,
  "step": 1,
  "default": 10,
  "suffix": "個"
}
```

| プロパティ | 型 | 必須 | 説明 |
|---|---|---|---|
| `key` | string | Yes | パラメータのキー名 |
| `type` | `"slider"` | Yes | ウィジェット種別 |
| `label` | string | Yes | 表示ラベル |
| `min` | number | Yes | 最小値 |
| `max` | number | Yes | 最大値 |
| `step` | number | No | ステップ値（省略時は1） |
| `default` | number | Yes | デフォルト値 |
| `suffix` | string | No | 単位の表示（`"%"`, `"ms"`, `"px"` 等） |

### buttons — ラジオボタン風

```json
{
  "key": "direction",
  "type": "buttons",
  "label": "方向",
  "default": "left",
  "options": [
    { "value": "left", "label": "左から" },
    { "value": "right", "label": "右から" },
    { "value": "random", "label": "ランダム" }
  ]
}
```

| プロパティ | 型 | 必須 | 説明 |
|---|---|---|---|
| `key` | string | Yes | パラメータのキー名 |
| `type` | `"buttons"` | Yes | ウィジェット種別 |
| `label` | string | Yes | 表示ラベル |
| `default` | string | Yes | デフォルト値 |
| `options` | array | Yes | 選択肢の配列 |
| `options[].value` | string | Yes | 値 |
| `options[].label` | string | Yes | 表示ラベル |

### toggle — ON/OFFトグル

```json
{
  "key": "noOverlap",
  "type": "toggle",
  "label": "重複防止",
  "default": true,
  "onLabel": "ON — 空きがなければキュー",
  "offLabel": "OFF — 重複を許可"
}
```

| プロパティ | 型 | 必須 | 説明 |
|---|---|---|---|
| `key` | string | Yes | パラメータのキー名 |
| `type` | `"toggle"` | Yes | ウィジェット種別 |
| `label` | string | Yes | 表示ラベル |
| `default` | boolean | Yes | デフォルト値 |
| `onLabel` | string | Yes | ON時の表示テキスト |
| `offLabel` | string | Yes | OFF時の表示テキスト |

### text / textarea — テキスト入力

```json
{ "key": "label", "type": "text", "label": "ラベル", "default": "", "placeholder": "入力してください" }
```

`text` は1行入力、 `textarea` は複数行入力。 `default` / `placeholder` / `hint` を任意で指定できます。

### color — カラーピッカー

```json
{ "key": "tint", "type": "color", "label": "色", "default": "#ffd700" }
```

カラーピッカーと選択中の hex 値を表示します。値は `"#rrggbb"` 形式で `data` に渡されます。

### image — 画像アップロード

```json
{ "key": "icon", "type": "image", "label": "アイコン画像" }
```

ドラッグ&ドロップ / クリックで画像を選択し、演出の素材として保存します。`data` には素材ファイル名が渡されます。プラグイン側で URL 化するには、`data._assetsBase`（= 演出素材の配信ベース URL）にファイル名を連結します:

```javascript
var url = (data._assetsBase || '') + data.icon; // → /effects/{sceneId}/assets/{filename}
```

### checks — 複数選択（マルチセレクト）

```json
{
  "key": "bandShows",
  "type": "checks",
  "label": "発射するショー",
  "default": ["small", "medium"],
  "options": [
    { "value": "small", "label": "小" },
    { "value": "medium", "label": "中" }
  ]
}
```

`buttons` の複数選択版。値は選択された `value` の**配列**（`string[]`）として `data` に渡されます。
チップをクリックするたびに選択/解除がトグルされます。`default` も配列で指定します。
「許可された候補のうち実行時にランダムで 1 つ選ぶ」用途（例: 花火の金額帯ごとの発射ショー）に向きます。

| プロパティ | 型 | 必須 | 説明 |
|---|---|---|---|
| `key` | string | Yes | パラメータのキー名 |
| `type` | `"checks"` | Yes | ウィジェット種別 |
| `label` | string | Yes | 表示ラベル |
| `default` | string[] | Yes | デフォルトの選択配列 |
| `options` | array | Yes | 選択肢（`{ value, label }`）の配列 |
| `hint` | string | No | 補足説明 |

> **補足**: `checks` は設定画面の **runtime 描画に対応**しています。アプリ内 manifest エディタの
> type 選択ドロップダウンには未登録のため、現状は **manifest.json に直接記述**して使います
> （ビルトインプラグイン向け）。

### group — 折りたたみグループ（補助プロパティ）

各ウィジェットに `"group": "見出し"` を付けると、同じ見出しの項目が折りたたみセクション（`<details>`）にまとめられます。設定項目が多いときに使います。`group` を指定しない項目は従来通り直接表示されます。

```json
{ "key": "sym1Color", "type": "color", "label": "色", "default": "#ffd700", "group": "シンボル1" }
```

### showIf — 条件表示（補助プロパティ）

`"showIf": { "key": "<別キー>", "value": <値> }` を付けると、指定キーの現在値が一致するときだけ表示されます。`{ "key": ..., "not": <値> }`（不一致で表示）、`{ "key": ..., "value": true }`（真偽）も使えます。

```json
{ "key": "tickerWidth", "type": "slider", "label": "幅", "min": 30, "max": 100, "default": 55, "suffix": "%", "showIf": { "key": "design", "value": "ticker" } }
```

## data パラメータ

uiSchema で定義したキーの値は、エフェクト呼び出し時に `data` オブジェクトとして渡されます。

```javascript
function fire(params, assets, data) {
  // uiSchema の key に対応する値を取得
  var count = (data && data.count != null) ? data.count : params.count;
  var scale = (data && data.scale != null) ? data.scale : 100;
  var direction = (data && data.direction) || 'random';
}
```

**重要**: 値の取得には `value || default` ではなく `value != null ? value : default` を使ってください。`0` が falsy として扱われ、意図しないデフォルト値に置き換わる問題を防ぎます。

## バージョニングとマイグレーション

プラグインのパラメータ構造を変更する場合、`migrations` フィールドでバージョンごとの変換ルールを定義します。ユーザーが古いバージョンのエフェクト設定をインポートした際、自動的にパラメータが変換されます。

```json
"migrations": {
  "2.0.0": {
    "description": "swayをswayAmountにリネーム",
    "renamed": { "sway": "swayAmount" },
    "removed": ["oldParam"],
    "added": { "newParam": 0.5 }
  },
  "3.0.0": {
    "description": "速度パラメータの単位変更",
    "renamed": {},
    "removed": ["legacySpeed"],
    "added": { "speedMultiplier": 1.0 }
  }
}
```

| プロパティ | 型 | 説明 |
|---|---|---|
| `description` | string | 変更内容の説明 |
| `renamed` | object | キー名の変更（`{ "旧名": "新名" }`） |
| `removed` | string[] | 削除されたパラメータ |
| `added` | object | 追加されたパラメータとデフォルト値 |

## 共有ライブラリ

汎用の共有ライブラリは `effects-overlay/js/` に置かれ、`index.html` でグローバルに読み込まれます。**全プラグインから常に `window` 経由で利用できます**。`dependencies` フィールドには利用するライブラリ名を宣言します。

| ライブラリ | 依存名 | 説明 |
|---|---|---|
| Matter.js | `"physics"` | 2D物理演算エンジン。紙吹雪の落下や衝突シミュレーションに利用 |
| Sound | `"sound"` | 効果音再生ユーティリティ |

使用例:

```json
"dependencies": ["physics"]
```

> **注意**: `effects-overlay/js/` は physics / sound のような**汎用・再利用前提**のライブラリ専用です。**特定エフェクト固有のコードはここに置かないでください**。(1) エクスポート時に同梱されず配布先で動かなくなる、(2) 共有領域に固有コードが混ざり責務が崩れる、の2点が理由です。固有の追加 JS はプラグインディレクトリに置き、エントリから動的ロードします（→ [エントリ以外の JS ファイルの動的ロード](#エントリ以外の-js-ファイルの動的ロード)）。

## エントリ以外の JS ファイルの動的ロード

プラグイン本体（`manifest.entry`）が大きくなる場合や、演出ロジックを別ファイルに分離したい場合は、**プラグインディレクトリ内に追加 JS を置き、エントリ JS から動的ロード**します。これが正式な手順です。

### 原則

- **プラグインローダーが読み込むのは `manifest.entry` の 1 ファイルだけ**です（`effects-overlay/js/plugin-loader.js` が `basePath + manifest.entry` を `<script>` 注入する）。追加ファイルは自動では読み込まれません。`dependencies` フィールドも追加ファイルのロードには使われません。
- **エフェクト固有のコードは必ずプラグインディレクトリ（`plugins/<dirname>/`）に置きます**。`effects-overlay/js/`（共有ライブラリ置き場）には置かないでください（理由は[共有ライブラリ](#共有ライブラリ)節の注意を参照）。
- **プラグインディレクトリ配下はエクスポート時にまるごと ZIP 同梱**されるため、追加 JS も一緒に配布されます。

### 手順

エントリ JS の先頭（同期実行されるトップレベル）で、自分自身の `<script>` 要素から配信ベース URL を求め、同ディレクトリの追加ファイルを `<script>` で注入します。

```javascript
// エントリ JS (manifest.entry) の冒頭に置く
(function loadEngine() {
  if (typeof document === 'undefined') return;
  if (window.MyEngine) return;               // 二重ロード防止
  var self = document.currentScript;         // ロード中はこの script 要素を指す
  if (!self || !self.src) return;
  var base = self.src.replace(/[^/]*$/, ''); // 末尾 "entry.js?_=..." を除去 → ディレクトリ URL
  var s = document.createElement('script');
  s.src = base + 'engine.js?_=' + Date.now();
  s.onerror = function () { console.warn('[my-effect] engine.js の読み込みに失敗'); };
  document.head.appendChild(s);
})();
```

ポイント:

- **`document.currentScript` はトップレベルの同期実行中のみ有効**です。コールバックの中ではなく、エントリ JS の冒頭で読み取ってください。
- **`script.src` プロパティは絶対 URL に解決済み**で返ります。ローダーが相対 `basePath`（`plugins/<dir>/`）で読み込んでいても、`replace(/[^/]*$/, '')` で正しいディレクトリ URL が得られます。追加ファイルは `/effects/{sceneId}/plugins/{dir}/{file}` の静的ルートで配信されます。
- **動的ロードは非同期**です。読み込み完了前に演出が呼ばれても落ちないよう、**消費側に未ロードガードを置きます**（例: `if (!window.MyEngine) { console.warn(...); return; }`）。早期 return では `activeCount` 等のキュー状態を変更せず、詰まりを防ぎます。OBS 起動から最初の演出発火までは通常間があるため、初回取りこぼしは実運用で問題化しません。

### 実例

固定表示プラグインの宝箱演出（`plugins/fixed/treasure-engine.js`、約 2800 行）がこの方式です。エントリ `fixed.js` が冒頭で `treasure-engine.js` を動的ロードし、`window.TreasureEngine.play(hostEl, opts, onDone)` を呼びます。

## 実装上の注意事項

### OBS ブラウザソース互換

OBS のブラウザソースで動作させるため、以下を守ってください。

- **ES module (`import`/`export`) は使わない** — IIFE パターンで `window` に公開する
- **`require()` は使えない** — preload.js の制約で、`contextBridge` が壊れる
- **`contextBridge.exposeInMainWorld` は1回だけ** — 2回呼ぶと Electron 28 で壊れる

### transform の競合回避

複数のアニメーションを重ねる場合、`transform` プロパティが競合します。外側の要素で軌道（移動）、内側の要素で回転を担当する **2要素構成** を推奨します。

```javascript
// 外側: 軌道（移動アニメーション）
var wrapper = document.createElement('div');
wrapper.style.cssText = 'position:absolute;';

// 内側: 回転アニメーション
var inner = document.createElement('div');
inner.textContent = '🎉';
inner.style.animation = 'spin 1s linear infinite';

wrapper.appendChild(inner);
container.appendChild(wrapper);
```

### animationend の信頼性

`animationend` イベントが発火しないケースがあります。要素の削除には `safeRemove()` パターンで二重保証してください。

```javascript
function safeRemove(el, timeoutMs) {
  var removed = false;
  function remove() {
    if (removed) return;
    removed = true;
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  el.addEventListener('animationend', remove);
  setTimeout(remove, timeoutMs || 5000);
}
```

### falsy 値の扱い

`0` を有効な値として使うパラメータでは、`||` 演算子を使わないでください。

```javascript
// NG: count が 0 のとき defaultValue になってしまう
var count = data.count || defaultValue;

// OK: null/undefined のみデフォルト値にフォールバック
var count = data.count != null ? data.count : defaultValue;
```

## 配布方法

### エクスポート

1. ハブの設定画面を開く
2. エフェクト一覧から対象のエフェクトを選択
3. 詳細画面で「エクスポート」を実行
4. ZIP ファイルが生成される

### ZIP の内部構造

**エフェクトパッケージ**（エフェクト単体のエクスポート）:

```
effect.json          ← エフェクト定義（id, name, params 等）
plugin/              ← プラグインディレクトリ配下を丸ごと同梱
  manifest.json
  my-effect.js
  (追加JS・テンプレートHTML等)
assets/              ← 素材ファイル（あれば）
```

**演出パッケージ**（演出のエクスポート）:

```
performance.json     ← 演出定義
effect.json          ← 使用するエフェクト定義
plugin/              ← プラグインファイル一式
assets/              ← 演出素材（画像・音声等）
```

**シーンパッケージ**（シーン全体のエクスポート）:

```
scene.json           ← シーン定義（performances[] 含む）
performances/        ← 演出素材
effects/effects.json ← 使用するエフェクト定義一覧
plugins/             ← エフェクトごとのプラグインファイル
  com.comment-hub.cracker/
    manifest.json
    cracker.js
  com.example.my-effect/
    manifest.json
    my-effect.js
```

### インポート

1. ハブの設定画面を開く
2. エフェクト一覧で「インポート」を選択
3. ZIP ファイルを指定して読み込み

### インポート時のバージョン解決

同じIDのエフェクトが既に存在する場合、以下のルールで処理されます:

| 環境版 vs インポート版 | プラグイン状態 | 動作 |
|---|---|---|
| 環境が新しい or 同等 | 正常 | 既存を維持（プラグイン展開スキップ） |
| 同一バージョン | 壊れている | インポート版で**修復** |
| 環境が新しい | 壊れている | 拒否（古いバージョンでの修復は不整合を招くため） |
| 環境が古い | — | **アップグレード提案**（確認→自動バックアップ→マイグレーション） |

バージョンアップ時は `migrations` で定義したパラメータ変換ルールが自動適用されます。

## チュートリアル: 最小構成のプラグインを作る

簡単な「絵文字が上に浮かんで消える」エフェクトを作成する例です。

### 1. ディレクトリを作成

```
effects-overlay/plugins/float-up/
```

### 2. manifest.json を作成

```json
{
  "id": "com.example.float-up",
  "version": "1.0.0",
  "name": "浮上エフェクト",
  "emoji": "🫧",
  "entry": "float-up.js",
  "globalName": "FloatUp",
  "interface": {
    "methods": ["fire"],
    "hasPause": false
  },
  "defaultAssets": ["🫧", "✨"],
  "defaultParams": {
    "riseSpeed": 2000,
    "spread": 80
  },
  "dependencies": [],
  "migrations": {},
  "badgeColor": {
    "bg": "#1a2744",
    "fg": "#7dd3fc"
  },
  "uiSchema": [
    {
      "key": "count",
      "type": "slider",
      "label": "個数",
      "min": 1,
      "max": 20,
      "default": 5
    },
    {
      "key": "scale",
      "type": "slider",
      "label": "サイズ",
      "min": 10,
      "max": 300,
      "default": 100,
      "suffix": "%"
    }
  ]
}
```

### 3. float-up.js を作成

```javascript
/**
 * 浮上エフェクト
 * 絵文字が下から上に浮かんで消える
 */
var FloatUp = (function () {
  var container;

  function init(c) { container = c; }

  function fire(params, assets, data) {
    if (!container) return;

    var count = (data && data.count != null) ? data.count : 5;
    var scale = (data && data.scale != null) ? data.scale : 100;
    var zOrder = (data && data.zOrder) || 1;
    var riseSpeed = params.riseSpeed || 2000;
    var spread = params.spread || 80;

    for (var i = 0; i < count; i++) {
      createBubble(assets, scale, zOrder, riseSpeed, spread, i * 100);
    }
  }

  function createBubble(assets, scale, zOrder, riseSpeed, spread, delay) {
    setTimeout(function () {
      var emoji = assets[Math.floor(Math.random() * assets.length)];
      var size = 32 * scale / 100;
      var x = 50 + (Math.random() - 0.5) * spread;

      // 外側: 軌道（上昇）
      var wrapper = document.createElement('div');
      wrapper.style.cssText =
        'position:absolute;' +
        'left:' + x + '%;' +
        'bottom:-50px;' +
        'z-index:' + zOrder + ';' +
        'animation:float-up-rise ' + riseSpeed + 'ms ease-out forwards;';

      // 内側: 揺れ
      var inner = document.createElement('div');
      inner.textContent = emoji;
      inner.style.cssText =
        'font-size:' + size + 'px;' +
        'animation:float-up-sway ' + (riseSpeed / 3) + 'ms ease-in-out infinite alternate;';

      wrapper.appendChild(inner);
      container.appendChild(wrapper);

      // 二重保証で削除
      safeRemove(wrapper, riseSpeed + 500);
    }, delay);
  }

  function safeRemove(el, timeoutMs) {
    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    el.addEventListener('animationend', remove);
    setTimeout(remove, timeoutMs);
  }

  return { init: init, fire: fire };
})();
```

このチュートリアルのように、最小限の manifest.json と JS ファイルを用意するだけでカスタムエフェクトを作成できます。既存プラグイン（`effects-overlay/plugins/` 内）のソースコードも参考にしてください。
