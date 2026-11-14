# 仕様書: ファイル名ベースのバリエーション自動検出

- 版: v1.0（確定）
- 状態: 承認済み・実装未着手（実装は指示があるまで着手しない）
- 対象: `electron/main.js` の `scan-directory`（funscript 分類・バリアント収集）
- 日付: 2026-11-11

## 1. 目的と現状のギャップ

現状（`electron/main.js` L1193–1297）の自動検出は次の 2 パターンのみ:

- 括弧バリアント: `Title (Soft).funscript`
- ドットバリアント: `Title.intense.funscript`（兄弟 primary がある場合のみ）

これ以外の命名（`Title-soft.funscript`、`Title_Soft.funscript`、`Title [Intense].funscript`、`Title Soft.funscript` など）は正規化名がベース名と一致せず `unmatchedFunscripts` に落ち、ユーザーが「バリエーションを追加」で手動登録（`library.manualVariants`）する必要がある。

本仕様は、これらをスキャン時に自動で `video.variants` へ追加するもの。

## 2. 検出文法

Funscript を `<ベース名><区切り><ラベル>.funscript` と解釈する。**strict モードは正規化前の生ファイル名**をパターン照合する（`normalizeName` は `-`/`_`/`.` をスペースに置換して消してしまうため、区切りの区別には生名が必要）。

| 区切りパターン（生名） | 例 | strict | generic |
|---|---|---|---|
| `(L)` | `Title (Soft)` | ✅ 現行どおり・**ラベル無制限** | 同左 |
| `[L]` | `Title [Soft]` | ✅ 要 ID ガード（§3-4） | 同左 |
| `.L` | `Title.soft` | ✅ 現行どおり（曖昧扱い） | 同左 |
| `[-_]L`（スペース有無問わず） | `Title-soft` / `Title - soft` | ✅ | 同左 |
| ` L`（スペースのみ） | `Title soft` | ❌ | ✅ |

- `Title-soft` と `Title - soft` と `Title_soft` と `Title soft` は正規化後すべて `title soft` になり同一扱い。ハイフンのスペース有無は判定に使わない。
- strict の新規区切り（`[L]` `[-_]L`）のラベルは**ホワイトリスト一致（大文字小文字無視・単一トークン）**に限る。
- 括弧 `(L)` は現行動作の後退防止のためラベル無制限（ノイズトークン禁止のみ適用）。
- ベース名・ラベルの比較は既存 `normalizeName`（小文字化・`_ - .`→スペース・空白圧縮）適用後に行う。

## 3. ガードレール（誤分類防止）

1. **動画の実在必須**: 正規化ベース名に対応する動画が同一ディレクトリ優先→グローバルフォールバックで実在する場合のみバリアント化する。存在しなければ従来どおり unmatched（または primary 候補）。
2. **完全一致動画が primary**: 末尾区切り込みの完全一致動画（正規化名一致なら `Title soft.mp4` 等でも可）が実在する場合、そのスクリプトはバリアントではなくその動画の primary である（括弧ルールの全パターンへの拡張）。
3. **軸サフィックス除外**: `AXIS_SUFFIXES`（surge/sway/twist/roll/pitch/vib/lube/pump/suction/valve）はマルチ軸機能側が優先。マルチ軸有効時はバリアントにしない。
4. **ノイズトークン禁止**（全モード共通）: `renderer/js/fuzzy-match.js` の NOISE_TOKENS と数値パターン（年・解像度・コーデック・VR パッキング・`S01E03`・純数値）を共有モジュール化してラベルに適用する。加えて **ID・ハッシュ風ラベル**（11 文字前後の大小英字+数字混在、`xK9pQ2mZ7wL` 型）は `[L]` で禁止。
5. **兄弟 post-pass 拡張**: 既存の曖昧ドット post-pass（L1267–1297）を新パターンにも適用する。「ベース名の非軸スクリプトが他に存在しない」ならバリアント化せず primary 候補に降格する。

## 4. ホワイトリスト初期メンバー（英語のみ・決定済み）

日本語ラベル（「やわらかい」等）のファイル名は実例が見られないため、英語のみのホワイトリストとする。

```
soft, gentle, light, easy, intense, hard, rough, heavy, edgy,
fast, slow, extended, short, loop, alt, pov, bonus, preview, teaser, intro
```

- 設定 `library.variantKeywords`（文字列配列）でユーザーが追加・削除できる（初期値は上記）。
- `part2` 等の連続動画トークンはノイズ扱いで禁止（primary 運用と衝突するため決定済み）。

## 5. 設定

- `library.autoVariantMode`: `'strict'`（**デフォルト**） | `'generic'` | `'off'`
  - `strict`: §2 の表の strict 列どおり
  - `generic`: ホワイトリストなし（ノイズトークン禁止のみ）。スペース区切りも許可
  - `off`: 無効（現行動作に完全復旧）
- `library.variantKeywords`: §4 の語彙。
- 設定パネルにセレクトとキーワード欄を追加（日本語/英語 i18n 必要）。

## 6. 結果データと優先順位

- 出力は既存の `video.variants` と同一形状 `{ label, path, name }` に `_autoDetected: true` を付与するのみ。**新規の永続化はしない**（スキャン毎に再計算のためロールバック安全）。
- 優先順位は現状維持:
  1. マニュアル関連付け（`library.associations` の single/multi/custom、sacred）
  2. 自動検出 variants
  3. `library.manualVariants`（パス重複除外でマージ、`renderer/js/app.js` L8701–8704）
- primary 決定の「先勝ち（first-wins）」挙動（`main.js` L1307–1308、走査順=readdir 順・ソースは設定順）は変更しない。
- 「primary 無し・バリアントのみ」は昇格せず現行動作維持（auto variants はそのまま渡され、renderer 側で表示判断）。

## 7. 同一ラベル重複の区分表示（決定済み）

同一動画の variants 内に同一ラベルが複数存在する場合、**末尾にメディアソース名を付与**して区分表示する。

- 表示ラベル例: `Soft (SourceB)`（内部の `label` は `Soft` のまま、表示用のみ変更）
- ソース名はスキャン時の `sourceMap`（`main.js` L1105、`sourceName` 解決の最長プレフィックス一致）から取得する。
- **同一ソース内の重複**（ソース名が同じで区別不能）または sourceMap 無しスキャン（`_refreshCurrentVariantsFromDisk` 等）の場合は、**直近フォルダ名**を付与する: `Soft (FolderB)`
- `Default` ラベルの重複にも同規則を適用する（2 本目以降は `Default (SourceB)`）。

参考: 現行コードは既に「同名重複は全部残して同一ラベルで並べる」方針（重複排除はパス単位、L1363・L1374）。本仕様はそこに区分表示を追加する。

### 7.1 由来の表示（自動 / 手動）

バリアント選択の場（インラインの `variant-selector` ドロップダウン、ポップアウトの同一メニュー、ライブラリカードの関連付け行）で、その行が**自動検出**か**手動追加**かをテキストバッジで示す。従来は両者が同じ見た目であり、区別するには削除を試すしかなかった（手動は削除できるが、自動は次のスキャンで復活する）。

- バッジは `variantOrigin(v)`（`renderer/js/variant-select.js`）が描画時に導出する。`_isManual`（`library.manualVariants` とマージする行のみ。コピーに付与し、設定オブジェクトへは書き込まない）→ `manual`、`_autoDetected`（スキャン由来、§6 参照）→ `auto`、**どちらも持たない行（合成 `Default` 行など）はバッジなし**。誤ったバッジは不在より悪い。
- トルチップには説明に加えて**ファイルパス**を出す。パスこそが同名スクリプトを区別する唯一の確実な情報で、§7 の区分表示は表示ラベルのみでパス自体は示さないため。
- 永続化はしない（§6 と同じ方針）。ポップアウトへは `variants` メッセージの各要素に `origin: 'auto'|'manual'|''` を追加するだけで、新しいメッセージ種別は作らない。
- 手動登録と自動検出が同一パスで衝突した場合、重複排除（パス単位）で自動行が残るためバッジは `auto` を示す。設定上の手動登録は自動ファイルが消えるまで隠れたまま、という現行動作どおり。
- ラベルキーの ★ピン（`library.preferredVariants`）とポップアウトからの `switch-variant` は従来どおりラベル指定で、同一ラベルが複数ある場合の曖昧性は本項の範囲外（既知の制限）。

## 8. 境界ケース（確定）

| ケース | 挙動 |
|---|---|
| 動画 `Title-soft.mp4` 実在 + `Title-soft.funscript` | バリアントでなくその動画の primary |
| 動画 `Title.mp4` + `Title-soft.funscript` | strict: バリアント "Soft"（`soft` がホワイトリスト一致）/ generic: 同左 |
| 動画 `Title.mp4` + `Title soft.funscript`（スペースのみ） | strict: 不可（unmatched or primary 候補）/ generic: バリアント "Soft" |
| `Title-2024.funscript` | 不可（ノイズトークン）→ primary 候補 or unmatched |
| `[Official Music Video] Example Artist 「Sample Song」 [xK9pQ2mZ7wL] (Simple).funscript` | 現行どおりバリアント `Simple`（括弧はホワイトリスト不要） |
| 同 `(AUTO-BPM).funscript` | 同様にバリアント `AUTO-BPM`（ラベルは生の文字列を保持、`-` はスペース化しない） |
| ラベルの大文字小文字衝突（`Soft`/`soft`） | 同一ラベルとして統合→§7 で区分表示 |
| 軸サフィックスとラベルの両方に該当 | 軸が優先 |
| 動画なし Funscript のみ（`A - Soft.funscript`、`A.mp4` 無し） | unmatched のまま |
| 同一ファイルが複数ソースに重複出現 | `canonicalise()` + `seenPaths` で 1 回のみ登録（現行どおり） |

## 9. 実装場所の想定（未実施）

- 分類関数を `electron/funscript-variants.js`（仮）として切り出し、NOISE_TOKENS を `renderer/js/fuzzy-match.js` と共有する。
- `scan-directory` の分類ブロック（`main.js` L1212–1246）と post-pass（L1267–1297）を拡張する。追加の fs 走査は行わず、既存 entries ループ内で完結させる。
- §7 の区分表示はバリアント収集直後の post-process（label 集計→ソース名/フォルダ名付与）として実装する。
- `_refreshCurrentVariantsFromDisk`（`renderer/js/app.js` L8744 付近）は同じ `scan-directory` を再利用しているため、プレイヤー側の再検出も自動的に同一ロジックになる。
- UI は新規追加なし: プレイヤーのバリアントドロップダウン（合成数 ≥2 で表示）とライブラリカードの既存チップがそのまま機能する。「未マッチ Funscript」タブの件数が減る。

## 10. テスト方針

- §2 の表と §8 の表をそのままユニットテストケース化する。
- 追加ケース: 重複ラベルの区分表示（ソース名付与/フォルダ名フォールバック）、`autoVariantMode: 'off'` での現行動作復旧、`variantKeywords` のユーザー拡張。

## 11. ロールバック

- `library.autoVariantMode: 'off'` で完全復旧。
- 自動検出結果は永続化しないため、データ移行・マイグレーションは不要。

## 12. 決定記録

| 論点 | 決定 |
|---|---|
| デフォルトモード | `strict`（日本語ラベルの実例がないため） |
| ホワイトリスト | 英語のみ（§4 の初期メンバー） |
| 同一ラベル重複の表示 | 区分表示。末尾にメディアソース名（同一ソース内重複・sourceMap 無しはフォルダ名） |
| primary 無し・バリアントのみ | 昇格なし、現行動作維持 |
| 括弧 `(L)` のホワイトリスト適用 | 適用しない（現行動作の後退防止） |
| `part2` 系トークン | ノイズ扱いでバリアント化禁止 |
