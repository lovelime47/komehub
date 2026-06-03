# Notification Sounds (Phase D-2)

このディレクトリには、 こめはぶの「コメント通知」 機能で使用する音源 (= プリセット
8 種) を配置します。

## ライセンス方針

同梱されている音源ファイルは Pixabay Content License (= 商用利用可・帰属不要・改変可)
のもとで配布されます。 こめはぶアプリの一部として **UI 通知音に統合** する用途は
Pixabay License の標準的な許可範囲であり、 配布バイナリへの同梱に問題ありません。

**制約**: これらの音源を **standalone audio file として単体販売 / 単体再配布** する
ことは禁止されています (= こめはぶアプリの一部としての同梱は OK、 音源パックとして
切り出して別配布する用途は NG)。

詳細: https://pixabay.com/service/license-summary/

## 同梱ファイル一覧

| プリセット ID | ファイル名 | 用途 |
|---|---|---|
| chime   | `chime.mp3`         | チャイム (= やわらかい) |
| bell    | `bell.mp3`          | ベル (= 鈴) |
| pop     | `pop.mp3`           | ポップ (= 短い「ポン」) |
| coin    | `coin.mp3`          | コイン (= 獲得風) |
| fanfare | `game-start.mp3`    | ファンファーレ (= 祝福) |
| sparkle | `sparkle-magic.mp3` | キラキラ (= 高音) |
| drum    | `drum.mp3`          | ドラム (= 低音) |
| glass   | `glass-ting.mp3`    | ガラス (= 透明感) |

## 音源の追加 / 差し替え

ユーザーが好みの音源を追加したい場合は、 任意の wav/mp3/ogg/flac ファイルをこの
ディレクトリに置き、 `core/src/notification_sound.rs` の `PRESET_METADATA` に
エントリを追加してください (= プリセット selector に出すため、 9 種目以降は Rust
側コード追加が必要)。 名前を既存と同じにすれば差し替えとして動作します。

任意の音源を 1 回限り使うだけなら、 設定モーダルの「— カスタムファイル —」 から
ファイルパス指定で使えます (= Rust コード変更不要)。

## 参考: Pixabay からの追加 DL

新規プリセットを増やしたい場合の検索先:

- チャイム系: https://pixabay.com/sound-effects/search/notification%20chime/
- ベル系: https://pixabay.com/sound-effects/search/notification%20bell/
- ポップ系: https://pixabay.com/sound-effects/search/pop%20notification/
- コイン系: https://pixabay.com/sound-effects/search/coin%20collect/
- ファンファーレ系: https://pixabay.com/sound-effects/search/fanfare/
- キラキラ系: https://pixabay.com/sound-effects/search/sparkle%20magic/
- ドラム系: https://pixabay.com/sound-effects/search/drum-hit/
- ガラス系: https://pixabay.com/sound-effects/search/glass%20ting/

## その他の CC0 / Public Domain ソース

Pixabay 以外を試したい場合:

- **freesound.org** (CC0 タグ): 厳密な CC0 音源。 要無料登録。
  https://freesound.org/search/?q=notification&f=license%3A%22Creative+Commons+0%22
- **OpenGameArt** (CC0):
  https://opengameart.org/art-search?keys=notification&field_art_licenses_tid%5B%5D=4
