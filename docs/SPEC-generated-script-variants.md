# 仕様書: 生成スクリプトのバリエーション自動追加

- 版: v1.0（確定）
- 状態: 承認済み・実装済み
- 対象: `backend/services/generated_store.py` / `backend/routes/generate.py` / `renderer/js/generated-variants.js` / `renderer/js/app.js` / `renderer/player-popout.js`
- 日付: 2026-11-15

## 1. 目的と現状のギャップ

生成ダイアログ（audio ベース / motion ベースの 2 エンジン）が作った funscript は、アプリ内ストア `<userData>/generated-scripts/` に保存される（`<動画名>-audio.funscript` / `<動画名>-motion.funscript`）。動画の隣には「動画と同じ場所に保存」を選んだ時だけ書かれる。

そのためストア内のスクリプトはライブラリスキャン（`scan-directory`）の視界に入らず、再生中のバリエーション一覧にも出てこなかった。生成しても、使うには毎回ダイアログを開く必要がある。

本仕様は、これを**再生中のバリエーション一覧へ自動で追加**するもの。ただし由来バッジは既存の「自動」ではなく、**audio / motion のどちらの解析で生まれたか分かるラベル**にする（「自動」では、ユーザーが見ている違いそのものを隠してしまう）。

## 2. データフロー（ストア → 一覧）

1. バックエンドが絶対パスを渡す。`GET /api/generate/store?video_path=...` の各 item に `store.script_path(record)` で解決した絶対 `path` を付与する（`_with_paths`）。ファイルが実在しない item は一覧から落とす。
2. レンダラーはストアのルートを決めない。Electron はバックエンドと同じ `userDataDir` を渡すが、dev で `python main.py` を素で起動するとストアが tempdir になり、JS 側でパスを組み直すと食い違う。だから**パスはバックエンドが与える、レンダラーは再構成しない**（設計 A）。
3. `renderer/js/generated-variants.js` の `generatedVariantRows(items, labelFor)` が行を作る。`id` / `path` 無し、およびこのプレイヤーがラベル付けできないエンジンファミリー（`audio` / `motion` 以外）は捨てる。誤ったバッジは不在より悪い。ファミリーごとに 1 行、パスの重複も除く。ストアの新しい順はそのまま保つ。
4. 行は `{ label, path, name, _generatedFamily, scriptId }`。`_generatedFamily` が由来の印で、`_autoDetected`（スキャン由来）でも `_isManual`（手動登録）でもない。`name` はストアフォルダ内のファイル名で、トルチップでは絶対パスの代わりにこれを出す（フォルダはアプリの内部事情でユーザーの用事ではない）。

## 3. 由来バッジ（audio / motion）

- `variantOrigin(v)`（`renderer/js/variant-select.js`）が `_generatedFamily` を `'audio'` / `'motion'` として返す。優先順位は `manual` → `audio`/`motion` → `auto`。手動で登録された生成スクリプトはユーザーの判断であり、こちらの知ったことではない。知らないファミリーは `''`（バッジなし）。
- 行のラベルは `variants.generatedAudioLabel` / `generatedMotionLabel`（例: `Generated audio`）。バッジは短い単語 `audio` / `motion`（`variants.audioTag` / `motionTag`）で、トルチップに説明（`audioTagTitle` / `motionTagTitle`）とファイル名を出す。
- 色は `--badge-info`（青＝音）と `--badge-multi`（ティール＝動き）。どちらもライブラリカードで既に使われている AA 調整済みトークンで、テーマごとに定義済み。`--accent` は 1 行上の `manual` が専有しているため使わない。ルールは `renderer/styles/player.css` に 1 組だけ。ポップアウトも同じ `player.css` を読むので、そのまま効く。
- 永続化はしない。`_generatedFamily` はマージ時にスプレッドコピーへ付ける描画時のタグで、設定にもストアにも書かない。

## 4. 設定

- `library.useGeneratedVariants`（**デフォルト true**）。設定パネルのライブラリ節にチェックボックス（`sp-generated-variants`）。
- オフにするのは「プレイヤーが提案しない」ことだけ。スクリプトはストアに残り、生成ダイアログの一覧にも出続けるので、戻せば行も戻る。
- 変更時の再スキャンは不要（行はスキャンではなくストア由来）。app.js は現在の動画の行をもう一度引き直すだけ。

## 5. 読み取りと安全策

- 生成行は `_readScriptResilient` を**通さない**。あの関数は「動画の隣にあるファイル」前提で、ミスすると同じ basename を動画フォルダで再試行し、それでもダメなら `manualVariants` から条目を削除する。ストアファイルに対してはどれも意味がない。`_switchVariant` に `_generatedFamily` の分岐を置き、`readFunscript` を直接読む。
- 消えていた場合（生成ダイアログで削除、ストア消去）は、行をその場で一覧から落とし、`toast.generatedScriptGone` を出し、アクティブ行を戻す。既存の `if (!read) return;` と同じ形の扱い（追加の cloud 後始末を足さない）とすることを認める。
- スクリプトエディタには**パスを渡さない**（`setFunscriptPath(null)`）。そのパスは自動保存の書き込み先で、アプリ自身のストアファイルを指すことになる。エディタの `loadScript()` はエンジン内のメモリから読むので、生成スクリプトの内容自体はそのまま表示できる。動画の隣へ保存する用途は、生成ダイアログの「動画と同じ場所に保存」が担う。
- 生成が終わる・消える・隣へ保存されるたびに、`GeneratePanel` の `onStoredChanged` が app.js を呼ぶ。app.js はストアの引き直しと、動画の隣に現れたファイルを拾うためのディスク由来更新の両方を行う。

## 6. マージと優先順位

`_updateVariantSelector()` の行順は **スキャン → 手動 → 生成**。生成行は最後に足す。生成ファイルがスキャン済みや手動の行と衝突した場合、その行がバッジを保ち、生成側は隠れる（パス単位の重複排除）。

- 生成行は `_generatedForPath` が現在の動画と一致する場合だけ混ぜる。読み取りは非同期なので、動画の切替や再読み込みで in-flight の照合は無効化する（トークン `_generatedToken`）。
- 動画読み込み時の照合は fire-and-forget。待つと再生が遅れる。失敗時は `false` を返し、行は出ない。
- ★ピン（`library.preferredVariants`）は生成行では**非表示**。ピンは動画読み込み時に適用されるが、ストアの照合はその後で解決するため、ピンが効かない場面が出る。恒久的に既定へしたいなら「動画と同じ場所に保存」でサイドカーを作れば、スキャンが拾って通常の行になる。
- 「再生時にランダムでバリエーションを選ぶ」が有効な場合、照合が間に合っていれば生成行が選ばれることがある。これは許容（既知の挙動）。

## 7. ポップアウト

新しいメッセージ種別は作らない。既存の `variants` メッセージの各要素に `origin`（`'auto'|'manual'|'audio'|'motion'|''`）と `name` を入れるだけ（`renderer/js/player-popout-protocol.js` L44 に型を記載）。ポップアウト側のドロップダウンは同じキー・同じ文言・同じ CSS クラスを使うので、2 つの表面が「この行は何か」で食い違わない。生成行のトルチップはパスではなくファイル名を出す。

ポップアウトから本体への `switch-variant` は従来どおりラベル指定。★ピンと同じ曖昧性（同一ラベルが複数ある場合）は本項の範囲外だが、生成行のラベルはファミリーごとに異なるので実用上は衝突しない。

## 8. 既知の制限（決定済み・対応しない）

| 制限 | 内容 |
|---|---|
| スマホ / Web リモート | 一覧はスキャン由来の `video.variants` を見ている（`backend/web-remote/app.js`）。ストア由来の生成行は出ない |
| ライブラリカードの関連付けメニュー | 対象外。変更はプレイヤーのドロップダウンとポップアウトのみ |
| ★ピン | 生成行では非表示（§6）。ランダム再生は照合が間に合えば生成行を選ぶ |
| 再生成でファイル名が変わる | ストアは衝突時にファイル名へハッシュや連番を足すため、再生成でアクティブ行のパスが古くなることがある。次の読み直しで正しい行に載り替わる |
| dev で素の `python main.py` | ストアが tempdir になる。パスをバックエンドが渡す設計（§2）なので表示は正しい |

## 9. テスト方針

- バックエンド: `script_path` の解決と外方向パスの basename 化、一覧 item の `path` 実在、消えたファイルの item を落とす（`backend/tests/test_generated_store.py` / `test_generate_routes.py`）。
- `tests/unit/generated-variants.test.js`: 行の成形、捨てられる条件（id / path / 未知のファミリー）、ファミリーごと 1 行、パス重複、`name` のフォールバック。
- `tests/unit/variant-select.test.js`: `variantOrigin` の audio / motion と優先順位。
- `tests/unit/variants.test.js`: ソース形状（マージ、照合、`_readScriptResilient` を通さない、エディタへパスを渡さない、★非表示、設定、`onStoredChanged` の 4 箇所、プロトコルのコメント）と、8 ロケールすべてのキー・CSS ルール。

## 10. ロールバック

- `library.useGeneratedVariants: false` で一覧から消える。ストアのファイルも生成機能も無傷。
- 生成行は永続化しないので、データ移行・マイグレーションは不要。

## 11. 決定記録

| 論点 | 決定 |
|---|---|
| パスの出所 | バックエンドが絶対パスを渡す（設計 A）。レンダラーはストアのルートを組み直さない |
| バッジの文言 | 「自動」ではなく `audio` / `motion`。行のラベルは `Generated audio` / `Generated motion` |
| 色 | `--badge-info`（audio）/ `--badge-multi`（motion）。`--accent` は manual 専用 |
| 既定 | `library.useGeneratedVariants` = true |
| 未知のエンジンファミリー | 行を作らない（誤ったバッジは不在より悪い） |
| エディタ | 生成行にはパスを渡さない（自動保存先になるため） |
| ★ピン | 生成行では非表示。恒久的な既定はサイドカー書き出しで実現する |
| スマホ / Web リモート | 対応しない（既知の制限） |
