# FunSync Player 設計書

- 対象: `funsync-player-main/`（バージョン 0.9.2）
- 作成日: 2026-10-21
- ライセンス: GPL-3.0-or-later / 作者: DaveMakesWaves / appId: `com.funsync.player`

---

## 1. 概要

FunSync Player は、ローカル（および Web 上）の動画 — 特に VR 動画 — を再生しつつ、**funscript**（位置情報付きモーションスクリプト）を使って外部デバイス（The Handy、Buttplug.io 対応 700 種以上のデバイス、TCode 系 OSR2/SR6、Autoblow Ultra / VacuGlide 2）を同期駆動するデスクトップアプリ。加えて以下の付随機能を持つ。

- **スマホリモコン / 携帯プレイヤー**（Web Remote PWA）
- **VR ヘッドセット向けコンテンツサーバー**（DeoVR / HereSphere 互換 JSON API）
- **PCVR コンパニオンブリッジ**（MultiFunPlayer 互換 TCP）
- **オーディエンスルーム**（複数 Handy のファン共有）
- **EroScripts コミュニティ funscript の検索・ダウンロード**（Discourse API + 2FA）
- **funscript エディタ**（波形グラフ、Undo/Redo、変種、多軸）

### 技術スタック

| 層 | 技術 |
|---|---|
| デスクトップシェル | Electron ^41.1.0（main / preload / renderer） |
| レンダラ UI | 素の ES modules + DOM（**フレームワーク不使用**）、CSS 12 枚 |
| ローカルバックエンド | Python 3.11 + FastAPI + uvicorn（ポート 5123、0.0.0.0） |
| 動画処理 | ffmpeg / ffprobe（同梱バイナリ、PyInstaller 経由） |
| Web 動画解決 | yt-dlp（Python API） |
| デバイス SDK | @ohdoki/handy-sdk ^2.3.4 / buttplug ^4.0.1 / @xsense/autoblow-sdk ^2.1.1 / serialport ^13 |
| i18n | intl-messageformat ^11.2.6（ICU MessageFormat）、8 ロケール |
| テスト | vitest ^4.1.4（jsdom、約 188 テストファイル）、Playwright e2e、pytest |
| 配布 | electron-builder ^25.1.8（Win NSIS + portable、Linux AppImage）、GitHub Actions |

---

## 2. アーキテクチャ全体像

アプリは **4 層**で構成される。

```
┌─────────────────────────────────────────────────────────────────────┐
│ FunSync Player (Electron)                                            │
│                                                                      │
│  ┌────────────────────┐  IPC (invoke/handle, 112ch)                 │
│  │ Electron メイン     │◄──────────────────┐                         │
│  │ electron/*.js      │                   │ window.funsync (preload)│
│  │ - main.js (2680行) │                   ▼                         │
│  │ - python-bridge    │  ┌─────────────────────────────────────┐   │
│  │ - store / backup   │  │ レンダラ renderer/                    │   │
│  │ - eroscripts-api   │  │ app.js (10,316行) = オーケストレータ  │   │
│  │ - popout windows   │  │ + components/ 30 + js/ 同期エンジン   │   │
│  │ - tcode/autoblow   │  └──┬──────────┬──────────┬────────────┘   │
│  └────────┬───────────┘     │          │          │                 │
│           │ spawn 子プロセス │ HTTP     │ WS       │ SDK (Node)      │
└───────────┼─────────────────┼──────────┼──────────┼─────────────────┘
            ▼                 ▼          ▼          ▼
   ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐
   │ Python バックエンド│  │ LAN クライアント     │  │ デバイス           │
   │ FastAPI :5123    │◄─┤ Web Remote PWA     │  │ Handy(クラウド)   │
   │ backend/         │  │ DeoVR/HereSphere   │  │ Intiface Central  │
   │ ffmpeg/ffprobe   │  │ PCVR (TCP 23554)   │  │ TCode (serial/UDP)│
   │ yt-dlp           │  └────────────────────┘  │ Autoblow(クラウド)│
   └──────────────────┘                           └──────────────────┘
```

### 層の責務

1. **Electron メインプロセス**（`electron/`）: ウィンドウ生成、バックエンド子プロセスの起動・監視・再起動、設定永続化（`config.json`）、データバックアップ/復旧、自動更新、EroScripts 認証、シリアル/UDP/WS 送信、ファイルダイアログ、ログ秘匿化。
2. **レンダラプロセス**（`renderer/`）: UI 全体と**デバイス同期エンジン本体**。動画再生（`<video>`）、funscript 解析・補間・変換、Handy/Buttplug/TCode/Autoblow への駆動出力、VR ブリッジ、リモート観測。
3. **Python バックエンド**（`backend/`）: LAN 公開の HTTP/WS サーバー。動画 Range ストリーミング、サムネイル生成、funscript→CSV 変換、DeoVR/HereSphere JSON、Web Remote 配信、yt-dlp プロキシ。
4. **Web Remote**（`backend/web-remote/`）: スマホ向け PWA（SPA）。バックエンドが `/remote/` に配信。

### プロセスモデルと接続の向き

- Electron がバックエンドを `spawn`（`--port 5123 --user-data-dir <userData>`）し、`/health` を 5 秒間隔でポーリング（2 回失敗で down 判定、レンダラにバナー通知 + Restart 操作）。
- **同期の仲裁は last-wins**: スマホが WS `/api/remote/sync` でコントローラ、Electron レンダラが `/api/remote/sync/observe` の単一観測者としてスマホの再生状態からデバイスを駆動する。
- デバイス SDK（Handy/Buttplug）は**レンダラから直接**（dynamic import）。TCode の物理送信のみメインプロセスの IPC（`tcode-send`）を経由する。

---

## 3. ディレクトリ構成

```
funsync-player-main/
├── package.json              # entry: electron/main.js
├── electron-builder.yml      # asar, extraResources(backend-dist→backend), ffmpeg 同梱
├── vitest.config.js          # jsdom, tests/unit/**, retry:2
├── playwright.config.js      # e2e
├── pytest.ini                # backend テスト
├── scripts/build.js          # 4 段階ガード付きビルドオーケストレータ
├── scripts/fetch-twemoji.mjs #絵文字アセット取得（100 SVG 未満で FATAL）
├── .github/workflows/        # build.yml (tag v* → win+linux matrix → GitHub Release)
├── electron/                 # メインプロセス 18 ファイル
├── renderer/                 # UI（index.html, js/ 101 ファイル, components/ 30, styles/ 12, locales/ 8）
├── backend/                  # FastAPI（main.py, routes/ 8, services/ 5, web-remote/）
│   └── funsync-backend.spec  # PyInstaller spec
├── tests/
│   ├── unit/                 # vitest 約 188 ファイル
│   ├── e2e/                  # Playwright
│   └── setup.js              # window.funsync（preload IPC）のモック
└── notes/                    # 機能仕様書（SCOPE-*.md, IMPL-*.md）— 実装の根拠
```

---

## 4. Electron メインプロセス（`electron/`）

### 4.1 main.js（2,680 行）— 起動フロー

**順序依存がコード内で明示コメント化されている**のが本アプリの特徴。

1. **ポータブルモード IIFE**（L19–49）: `PORTABLE_EXECUTABLE_DIR` 環境変数 or exe 隣の `FunSync-portable.txt` マーカー → `app.setPath('userData', <exe隣>/data)` + `app.setAppLogsPath()` + `process.env.FUNSYNC_PORTABLE='1'`。**`require('./logger')` / `require('./store')` より前に実行される必須の前処理**。
2. **Linux VA-API ゲート**（whenReady 前）: `config.json` を直接同期読込し、`player.hwVideoDecode`（既定 ON）に応じて `VaapiVideoDecoder,VaapiIgnoreDriverChecks` を enable または `disable-accelerated-video-decode`。
3. `store.preloadModule()`（L71）: electron-conf の ESM import を Chromium 起動と並列で先読み（コールド約 1 秒短縮）。
4. **単一インスタンスロック**（L159）: 2 番目のインスタンスは既存 mainWindow を focus/restore。
5. **`app.whenReady()`**（L303–411）の順序:
   1. `Menu.setApplicationMenu(buildAppMenu())`
   2. `dataBackup.verifyAndRecover()` — **`store.initStore()` より前に必須**（config.json 破損時、electron-conf がデフォルトへサイレントリセットする前にスナップショットから復元するため）
   3. `await store.initStore()`
   4. `setRedactionEnabled(store.getSetting('security.hideLogFileNames'))`
   5. `store.subscribe(...)` → 設定変更ごとに `dataBackup.scheduleSnapshot()`（60 秒デバウンス）
   6. 起動時スナップショット（復旧済みなら `TRIGGER.RECOVERY`、そうでなければ `TRIGGER.STARTUP`）→ 非同期で `pruneOld`
   7. **`startBackend()` をウィンドウ生成と並列**で起動（従来は逐次 await で約 2.1 秒の interpreter + FastAPI import が初描画を遅らせていた）。`setHealthListener` → 全ウィンドウへ `backend-status` 配信 → `startHealthMonitor()`
   8. `createWindow()`
6. **終了フロー**: `before-quit` 二段階（初回 `preventDefault()` → `TRIGGER.QUIT` スナップショット完了 → `stopBackend()` + `app.quit()` 再発火）。`will-quit` で冪等 `stopBackend()`。

**createWindow()**（L172–240）: スプラッシュ（320×200、frame:false、transparent）→ `resolveWindowColors()`（window-bg.js）でテーマ色を取得 → mainWindow 1280×800、win32 のみ `titleBarStyle:'hidden'` + `titleBarOverlay`。webPreferences: `contextIsolation:true`、`nodeIntegration:false`、**`backgroundThrottling:false`**（分離プレイヤーウィンドウ前面時にメインの同期エンジン setInterval がスロットリングされるのを防ぐ）。`ready-to-show` で splash 破棄 + show。パッケージ版かつ非ポータブルのみ `initAutoUpdater()`。

**バックエンドプロキシパターン**: 多くの IPC ハンドラが `getBackendPort()` → `fetchWithTimeout()`（L928–945）。最初に `_backendReadyPromise` を await するため初期リクエストは即失敗しない（uvicorn 起動完了を最大 10 秒待つ）。エンドポイント別タイムアウト: remux 600 秒 / resolve 90 秒 / metadata 20 秒 / thumbnails.generate 60 秒 / convert 15 秒 / speed-stats・durations 5 秒。

**ライブラリスキャン**（`scan-directory`、L1105–1433）: `VIDEO_EXTS` 11 個（音声含む）、`canonicalise()` 重複排除、funscript/字幕のローカル→グローバルフォールバック、バリアント判定 Pass1 同ディレクトリ / Pass2 グローバル、sourceName 最長プレフィックス、`dateAdded`=mtimeMs。同期スキャンの合間に `setImmediate` で yieldTick（UI フリーズ回避）。

**ファイル到達性**（`file-exists`/`files-exist`、L2050–2081）: `fs.promises.access` と setTimeout の race（800ms）。`existsSync` は死んだネットワークドライブで UI を約 5 秒フリーズさせたため（EroScripts #251/#255）。

### 4.2 preload.js（256 行）— `window.funsync` API

`contextBridge.exposeInMainWorld('funsync', {...})` の**単一グローバルのみ**。`platform`（`process.platform`）以外全て `ipcRenderer.invoke` の薄いラッパー。購読系（`onBackendStatus` 等）は解除関数を返す。

| カテゴリ | API |
|---|---|
| バックエンド | `getBackendPort` `getBackendHealth` `restartBackend` `onBackendStatus` `getAppVersion` `getPortableInfo` `openLogFile/Folder` `logLine` |
| ストア | `getAllData` `getSetting(path)` `setSetting(path,value)` `addRecentFile` |
| プレイリスト | `getPlaylists` `addPlaylist` `renamePlaylist` `setPlaylistLoop/Shuffle/Balance/PreferUnwatched` `addVideoToPlaylist` `removeVideoFromPlaylist` `setPlaylistVideoPaths` … |
| カテゴリ | `getCategories` `addCategory` `renameCategory` `setCategoryIcon/Color` `assignCategory` `unassignCategory` `getVideosByCategory` … |
| ライブラリ | `selectDirectory` `scanDirectory` `selectFunscript` `readFunscript` `selectSubtitle` `enumerateFolderVideos` `getPathForFile`（Electron v32 で削除された `File.path` の代替、`webUtils.getPathForFile`） |
| サムネイル | `selectThumbnailImage` `importCustomThumbnail` `getCustomThumbsDir` `readCustomThumbnail` |
| バックエンドプロキシ | `generateThumbnails` `generateSingleThumbnail` `remuxVideo` `resolveRemoteVideo` `getSpeedStats` `getDurations` `convertFunscript` |
| ファイル/エディタ | `openFileDialog` `saveFile` `saveFunscript` `writeFunscript` `fileExists` `filesExist` `openExternal`（http/https のみ） `showInFolder` |
| データ | `exportData` `importData` `migrateLocalStorage` `backupGetBootResult/List/SnapshotNow/Restore/OpenFolder/PreAction` |
| TCode | `tcodeListPorts` `tcodeConnect` `tcodeDisconnect` `tcodeSend` `tcodeStatus` `onTcodeDisconnected` |
| VR | `vrConnect(host,port)` `vrDisconnect` `vrSend(jsonStr)` `onVrState` `onVrDisconnected` |
| Autoblow | `autoblowConnect(token)` `autoblowDisconnect/Status` `autoblowUploadScript` `autoblowSyncStart/Stop/Offset` `autoblowLatency` |
| EroScripts | `eroscriptsLoginWindow` `eroscriptsLogout/RestoreSession/Status/Validate` `eroscriptsSearch` `eroscriptsTopic` `eroscriptsTopicImage` `eroscriptsDownload` |
| Popout | `editorPopoutOpen/Close/Status/Relay` `audiencePopout*` `playerPopout*` + 各 `on*Event` |
| アップデータ | `updaterCheck/Download/Install` `onUpdateEvent`（6 チャネル購読、クリーンアップ関数返却） |
| 診断 | `collectDiagnostics(rendererState)` |

### 4.3 IPC チャネル（`ipcMain.handle` 計 112 個）

`ipcMain.on` は electron ディレクトリ全体に存在しない（invoke/handle のみ）。代表例:

- アプリ/診断: `get-backend-port` `get-backend-health` `restart-backend` `get-app-version` `get-portable-info` `collect-diagnostics` `log-line` `open-log-file/folder`
- ストア: `get-all-data` `get-setting` `set-setting` `add-recent-file` + プレイリスト 12 + カテゴリ 10 + `update-window-chrome` `migrate-local-storage`
- ライブラリ: `select-directory` `scan-directory` `enumerate-folder-videos` `read-funscript` `save-funscript` `write-funscript` + セレクトダイアログ 4 + カスタムサムネイル 4
- バックエンドプロキシ: `fetch-metadata` `generate-thumbnails` `generate-single-thumbnail` `remux-video` `resolve-remote-video` `get-speed-stats` `get-durations` `convert-funscript`
- データ: `export-data` `import-data` `backup:*`（6）
- デバイス: `tcode-*`（5） `vr-*`（3） `autoblow-*`（8）
- Popout: `editor-popout:*` `audience-popout:*` `player-popout:*`（各 open/close/status/relay）
- その他: `file-exists` `files-exist` `open-external` `show-in-folder` `get-system-locale` `updater-*`（3） `eroscripts-*`（9）

**メイン→レンダラ配信チャネル**: `backend-status` `tcode-disconnected` `vr-state` `vr-disconnected` `editor-popout:event` `audience-popout:event` `player-popout:event` `update:checking|available|not-available|download-progress|downloaded|error`。

### 4.4 python-bridge.js（391 行）— バックエンド管理

- **ポート**: 既定 5123（store の `settings.backend.port` と一致）。
- **`killProcessesOnPort()`**（L52–107）: 起動前/停止後にポート占有プロセスを掃討。win32 は `netstat -ano` → `taskkill /T /F`、unix は lsof→ss→fuser の順で SIGKILL。前セッションの孤児バックエンド対策。
- **`startBackend()`**（L109–235）: パッケージ版は `process.resourcesPath/backend/funsync-backend(.exe)`。**実行ファイル欠損時はハードフェイル**（antivirus 隔離/PyInstaller 誤検知を説明するログ + `BACKEND_MISSING` 状態。dev パスにフォールバックしない）。dev は venv python → `python`/`python3` で `main.py`。stdout に **`'Uvicorn running'`** を見て resolve（error/close も resolve、reject しない。起動タイムアウト 10 秒は warn + resolve）。
- **生存監視**: `HEALTH_INTERVAL_MS=5000`、`HEALTH_TIMEOUT_MS=3000`、`HEALTH_FAIL_THRESHOLD=2`。状態は `unknown|running|down|restarting`。状態変化時のみ listener 発火 → レンダラに disconnected バナー + Restart。
- **`restartBackend()`**: 'restarting' 通知 → stop → 500ms sleep（Windows のポート解放待ち）→ start → monitor → probe。

### 4.5 store.js（570 行）— 設定永続化

electron-conf（ESM のため遅延 `import()`）で `userData/config.json` を管理。

- `preloadModule()` が import を先読み、`initStore()` で `new Conf({defaults: DEFAULTS})`。
- `getSetting/setSetting` は **`'settings.'` 接頭辞を自動付与**（main.js 側は素のパスを渡す）。
- `subscribe(cb)` は `conf.onDidAnyChange`（解除関数返却、バックアップデバウンスに使用）。
- `addRecentFile` は重複排除 + unshift + 20 件上限。

**DEFAULTS の主なキー**:

| キー | 内容 |
|---|---|
| `settings.handy` | connectionKey, defaultOffset, slideMin/Max, scriptHostMode:'local', syncRounds:30 |
| `settings.player` | volume, theme:'dark', uiStyle:'classic', recentFiles, gapSkip{mode,threshold}, upNext{mode,countdownSec}, preferMultiAxis, smoothing:'linear', speedLimit, orgasmSwitchMode:'hold', randomVariantOnPlay, rememberPlaybackSpeed, inlineTimeline/inlineHeatmap, miniPlayer:true, hwVideoDecode:true, language:'en' |
| `settings.backend` | port:5123, localIp:'auto' |
| `settings.library` | directory, sources, associations, manualVariants, manualVRType（'vr'/'flat' 手動上書き）, vrFlatten（レガシー） |
| `vrFormat` | パス別 `{projection:'sbs-half'|…, eye, zoom, source}` |
| `customThumbnails` | `{seekPct}` 旧形式 \| `{type:'image', imagePath}` |
| `resumePositions` | 動画パス → `{position,duration,updatedAt}` |
| `scriptTags` / `collections` / `playlists` / `categories` / `videoCategories` | メタデータ・グループ化 |
| `security.hideLogFileNames` | ログ秘匿化スイッチ（既定 false） |
| `tcode` | transport:'serial'|'udp'|'websocket', port, baudRate:115200, udpHost/Port, wsUrl, precision:3, updateRateHz:60, axisRanges, axisEnabled |
| `buttplug.port` | 12345（Intiface Central） |
| `autoblow` | token, offset |
| `knownDevices` / `editor` | デバイス履歴 / エディタ設定（popoutBounds） |

**レガシー移行**: `migrateFromLegacy()`（L485–535）が旧トップレベルキーを `settings.*` へコピーし `_migrated=true`。data-migration.js（33 行）はレンダラ localStorage（`funsync-settings`）からの一度きり移行を仲介。

### 4.6 data-backup.js（650 行）— config.json スナップショット/復旧

- 純関数層（`buildSnapshot`/`applyRetentionPolicy` 等、I/O なし・テスト対象）と公開 API 層に分離。
- 保持ポリシー: hourly 24 / daily 7 / weekly 4 / preAction 30 日、最低 3 個（最悪約 32MB）。`BACKUP_BLACKLIST`（speedStatsCache 等のキャッシュは保存しない）は data-export.js も共有（単一情報源）。
- `verifyAndRecover()`: live config が読めなければスナップショットを新しい順に「parse 成功 + sha256 一致」で走査し atomic write で復元。全滅ならフォールバック + トースト警告。
- `takeSnapshot()` は trigger 別（STARTUP/DEBOUNCED/PRE_ACTION/MANUAL/QUIT/RECOVERY/BASELINE）。`pruneOld` は**新しいスナップショット成功後にのみ**実行（最後の正常バックアップを先に消さない）。
- `backup:restore`（main.js L1837–1912）: 復元前スナップショット → sha256 再検証 → atomic write → `stopBackend()` してから `app.relaunch()`（孤児バックエンドがポートを競合させる防止）。
- `scheduleSnapshot` は 60 秒デバウンス、タイマーは `unref()`。

### 4.7 data-export.js（210 行）— `.funsync-backup`（zip）

`exportData`: stripBlacklist 適用（無だと base64 サムネイルで数十 MB 膨張）→ config.json + funscripts/ + metadata.json → DEFLATE zip。`importData(zip, 'merge')`: `mergeConfig` は settings を deep merge、playlists/categories は名前重複スキップで追加、videoCategories は和集合。インポート前に `backup:pre-action`。

### 4.8 auto-updater.js（116 行）

electron-updater（GitHub Releases）。`autoDownload=false`・`autoInstallOnAppQuit=false`（ユーザーが全ステップを制御）。イベントは `update:*` チャネルで mainWindow へ配信。`quitAndInstall(true,true)` = NSIS `/S` サイレント + 再起動。ポータブル版では `updater-check` 即 return。

### 4.9 eroscripts-api.js（457 行）

EroScripts（Discourse）HTTP クライアント。Chrome/120 UA 固定（Cloudflare 対策）。`restoreSession(_t クッキー)`、`validateSession()`（**5xx/ネットワークエラーは有効扱い** — 一時的障害でログアウトしない。HTML 応答は無効）、`search(q + " #scripts")`、`getTopicAttachments`、`downloadFile`。認証 UI は `eroscripts-login-window` IPC が実 Discourse UI を 520×720 の child BrowserWindow（`persist:eroscripts-login` パーティション、sandbox:true）で表示し、`_t` クッキーを検出したら `session/current.json` fetch でユーザー名を確認して `restoreSession()`。TOTP/WebAuthn 対応。

### 4.10 Popout ウィンドウ 3 種（同型パターン）

editor-popout-window.js（181 行）/ audience-popout-window.js（166 行）/ player-popout-window.js（183 行）。

- **メインプロセスが state-sync のブローカー**（BroadcastChannel ではなく IPC 経由が確定決定）。単一チャネル `*-popout:event` + `{type:'opened'|'closed'|'message', payload}` エンベロープ + `relay(direction, payload)` で順序保証と観測性を確保。
- bounds は**サイズのみ永続化・位置はしない**（マルチモニター対策）。
- player-popout のみ: `parent` なしのトップレベルウィンドウ（Windows で child だとタスクバーに出ず独立最小化できない）+ `parent.once('closed')` で孤児化防止 + `backgroundThrottling:false`。
- audience popout を閉じてもルーム自体はメインレンダラの AudienceBridge で生存継続。

### 4.11 window-bg.js（92 行）/ logger.js（25 行）/ log-redact.js（105 行）

- window-bg.js: ウィンドウ chrome 色の一元的解決。**store 初期化前に呼ばれるため config.json を直接同期読込**。色定数はレンダラ CSS とミラー必須。win32 のみ `titleBarStyle:'hidden'` + overlay（高さ 48 は `.nav-bar` と一致）。
- logger.js: electron-log ラッパー（5MB、`[Y-M-D h:i:s.ms] [level]`）。**`log.hooks.push` が全ログの唯一の秘匿化チョークポイント**（メインログ + レンダラ console 転送 + Python stdout 全て `maybeRedact` 経由）。
- log-redact.js: ログから**メディアファイル名のみ**を `[hidden]` に置換（ディレクトリと拡張子は保持: `D:\VR\SLR_..._1920p_LR.mp4` → `D:\VR\[hidden].mp4`）。URL エンコード済み区切り（`%5C`/`%2F`）も同一正規表現で処理。既定 OFF、`security.hideLogFileNames` と連動。

### 4.12 tcode-transports.js（452 行）/ autoblow-api.js（159 行）

- tcode-transports.js: TCode の通信層。**コマンド整形はレンダラ tcode-manager.js のまま**で、本モジュールは「バイトをどう届けるか」だけ。トランスポート契約: `connect/disconnect/send/get connected/onDisconnect/destroy`。SerialTransport（serialport）/ UdpTransport（dgram）/ WebsocketTransport（自動再接続 + backoff、注入可能でテスト容易）。`createTransport(kind)` は不明名で throw（サイレント無効化防止）。
- autoblow-api.js: Autoblow Ultra / VacuGlide 2 のクラウド HTTP クライアント（**SDK ではなく直接 fetch**、レンダラの ESM 問題回避）。`connect(token)`: latency サーバーで cluster 取得 → `autoblow/info` で deviceType 判定。SyncScript 系 API は deviceType でプレフィックス切替（`autoblow/…` vs `vacuglide/…`）。`estimateLatency(rounds=5)`。

### 4.13 safe-key.js（55 行）— 未使用

Handy 接続キーの `safeStorage`（DPAPI）暗号化ユーティリティ。ポータブルモードでは平文保存（USB 移植性のため）。**プロジェクト全体 grep で `require('./safe-key')` はどこにも存在しない**（main.js のコメント言及のみ）。現状未使用のスタンドアロンユーティリティ（将来組み込み予定かデッドコード）。

---

## 5. レンダラプロセス（`renderer/`）

### 5.1 index.html（414 行）

- **CSP**（L6）: `script-src 'self'`（インラインスクリプト禁止）、`connect-src` は localhost + handyfeeling.com + discuss.eroscripts.com 等。
- スタイルシート 12 枚 + `modern.css` を最後（uiStyle:'modern' 時に上書き）。
- 静的コンテナ: `#library-container`（既定）/ `#playlists-container` / `#categories-container` / `#player-container`（`#video`、`#miniplayer-bar`）。
- エントリ: `js/process-shim.js` + `js/app.js`（type=module）。
- 別ウィンドウ HTML: `audience-room.html` / `editor-popout.html` / `player-popout.html` / `splash.html`。

### 5.2 app.js（10,316 行）— God-object オーケストレータ

`class App`（L110）が**全マネージャと全コンポーネントを保持**する。

- マネージャ: VideoPlayer, FunscriptEngine, HandyManager, ButtplugManager+ButtplugSync, TCodeManager+TCodeSync, AutoblowManager+AutoblowSync, VRBridge, RemoteBridge, AudienceBridge, SessionTracker, dataService
- コンポーネント: library, playlists, categories, nav-bar, connection-panel, settings-panel, queue-panel, vr-format-panel, eroscripts-panel, script-editor …（L111–152）

**ビュー遷移**（SPA ルーターなし）:
- `_navigateTo(viewId)`（L5064–5094）: `hidden` 属性トグル + 自前 `_navStack` 履歴 + enter/leave フック。miniplayer 例外（L5075–5076: 離脱時もプレイヤーを止めない）。`#app` の `dataset.view` で CSS フック（L5125）。
- `_navigateBack()`（L5097–5118）。

**起動**: `installConsoleForwarding()`（レンダラ console → メインログ転送）→ `new App()` → `window.app = app`（L10280）→ `DOMContentLoaded` で `app.init()`。致命的エラーはログパス付きオーバーレイ表示（L10286–10316）。

### 5.3 コンポーネント（`components/` 30 ファイル）

| ファイル | 行数 | 役割 |
|---|---|---|
| library.js | 6,878 | サムネイルグリッド、仮想スクロール、検索/ソート/フィルタ、スキャン（並列 4） |
| script-editor.js | 3,416 | funscript エディタ本体 |
| connection-panel.js | 3,275 | デバイス接続 UI（Handy/Buttplug/TCode/Autoblow） |
| settings-panel.js | 2,318 | 設定 UI（SETTINGS_DEFAULTS L21–39） |
| playlists.js / categories.js / queue-panel.js | 1,593 / 781 / 658 | グループ化・再生キュー |
| nav-bar.js / vr-format-panel.js / eroscripts-panel.js / vr-modal.js | 598 / 579 / 528 / 457 | ナビ・VR 形式・EroScripts 検索・VR 再生モーダル |
| modal.js | 368 | **モーダル基盤**: `Modal.open()` Promise ベース、role=dialog / aria-modal / フォーカストラップ（L17–30） |
| feedback-modal.js / orgasm-config-modal.js / up-next-card.js | 372 / 353 / 330 | 他 |

**UI 規約**（全ファイル共通）:
- ヘッダコメントに設計根拠（Nielsen / Schneiderman の引用）+ `notes/features/SCOPE-*.md` 参照
- ES module クラス + **DI（constructor options）**、静的 HTML コンテナへマウント
- ファクトリ関数 / `Modal.open()` Promise ベースのモーダル起動
- 純関数はテストのため export（view/logic 分離）
- HTML エスケープヘルパー統一、a11y（aria / フォーカストラップ）

### 5.4 i18n（`js/i18n.js` 242 行 + `locales/` 8）

- `SUPPORTED_LOCALES`（L32）: en, zh, ja, ko, de, es, fr, ru。
- `resolveLocale()`（L66–78）: 設定 → システムロケール（`get-system-locale`）→ en。
- `t(key, params)`（L89–118）: ICU MessageFormat（intl-messageformat の **`.iife.js` ビルド**を vendor。bare specifier はレンダラで解決不可のため）。コンパイルキャッシュ `${locale}|${key}`、欠落キーは英語→キー文字列へフォールバック。
- `setLocale()`（L141–158）: 常に en をプリロード。`translatePage()`（L190–203）: `data-i18n` 属性スキャン。
- ロケール JSON は `import.meta.url` 経由で fetch。**ロケールキーパリティは CI テスト**（locale-key-parity）。

---

## 6. デバイス同期パイプライン（`renderer/js/`）

### 6.1 データフロー全体

```
<video> 再生時計 (currentTime)
   │
   ▼
FunscriptEngine ── funscript JSON 解析（BOM ストリップ、at 昇順、chapters/bookmarks）
   │               バリアント / auto-match / フィラー（FillerEngine）
   ▼
interpolation.js ── 線形 / step / PCHIP(Fritsch-Carlson) / Makima + applySpeedLimit
   │
   ▼
device-transform-stack.js ── 共通変換順: [1]Range Extender → [2]Invert → [3]Range(再スケール)
   │                          → [4]Cutoff(クリップ) → [5]SafetyCap
   │                          （速度制限とトランスポート符号化はスタック外）
   ▼
デバイス別エンジン ── Handy HSSP / Handy HDSP / Buttplug / TCode / Autoblow
```

### 6.2 再生基盤

- **video-player.js**（1,135 行）: `class VideoPlayer`（L34）が `<video>` をラップし、playing/pause/seeked/ended/emptied の**イベント供給源**。`loadSource`（L245）は pause イベントを出さずに paused を設定するため `emptied` ハンドラが存在する。`setPlaybackRate`（L994、PRESETS 0.25–2）。`setHandySyncRefs`（L1049）で Handy の HSSP↔HDSP を再生速度で切替。NONPLANAR_FORMATS（VR 180 等）は WebGL `VRProjectionRenderer`。
- **funscript-engine.js**（401 行）: `class FunscriptEngine`（L86）。`loadContent`（L113）: BOM ストリップ → 解析 → at 昇順 → chapters/bookmarks → `window.funsync.convertFunscript`（バックエンド CSV 変換）→ `_rebuildFiller`。**`getActions()`（L200）= 再生用（フィラー込み）/ `getAuthoredActions()`（L209）= 統計・自然レンジ用（著者作成のみ）** — L192–196 のコメント: フィラー配列からレンジエクステンダ係数を導出してはならない。`getPositionAt`（L271）は二分探索 + 線形。
- **interpolation.js**（272 行）: `findInterval`（L13、二分探索）、linear / step / **pchip**（Fritsch-Carlson、オーバーシュートなし、0–100 クランプ）/ makima。`applySpeedLimit`（L247）、`getInterpolator`（L264、既定 linear）。

### 6.3 Handy（The Handy）— 2 モード

- **handy-manager.js**（644 行）: @ohdoki/handy-sdk ラッパー（dynamic import）。`connect`（L114）、`syncTime`（L179）→ `_syncQuality{avgOffset,avgRtd}`（ドリフト監視に供給）。**`_hsspExclusive`（L214）: 全 HSSP 操作を `_hsspChain` で直列化**（クラウド RTT 200–750ms のため。破棄するのは stale な PLAY のみ、stop/setup は絶対に破棄しない L217–218）。`uploadAndSetScript`（L258）→ handyfeeling.com へ CSV アップロード。ヘルスポーリング 10 秒（L48–56、SDK の disconnect 見逃し = BT モード切替対策）。
- **sync-engine.js**（330 行）: **HSSP（time-anchor）モード**。`_handlePlaying`（L137）: `gen=++_playGen` → `hsspPlay(timeMs)`。L189 に 2500ms のダブルプレイ補正。pause/seeked/ended は gen を上げてから `hsspStop(+hsspPlay)`。`_startDriftMonitor`（L275）: rAF で 2000ms 毎、`avgRtd>200` → `syncTime(10)` → hsspStop+Play。コメント L67–70: tick 方式と違い HSSP はクラウドが自己進行するためドリフト監視が必須。
- **handy-hdsp-sync.js**（153 行）: **HDSP（リアルタイム tick）モード**。ヘッダ L1–21 の設計根拠: HSSP は再生速度≠1.0× で破綻する（クラウドが 1.0× で自己進行）。HDSP は毎 tick `(pos, durationMs)` を送る。TICK 33ms（約 30Hz）、LOOKAHEAD 100ms、MIN_POS_DELTA 1。
- **HSSP の変換適用先**: HSSP は tick 補間を持たないため、Range Extender / Clamp は**スクリプト内容そのもの**に適用（device-transform-stack.js の `extendRawScriptContent` L254 / `clampRawScriptContent` L305）。

### 6.4 Buttplug.io（Intiface Central）

- **buttplug-manager.js**（742 行）: buttplug.mjs dynamic import、`connect(port=12345)`。送信結果は SENT / NOT_CONNECTED / failed の結果オブジェクト（同期ループは failed を無視、次 tick で補正）。
- **buttplug-sync.js**（1,607 行）: `class ButtplugSync`（L38）。**`setInterval` 40ms（25Hz）— rAF ではない**（タブ非アクティブでも生き残るため）。既定 `'action-boundary'` モード = 境界毎に 1 個の LinearCmd（duration=全ストローク時間、BLE friendly）。`'interpolated'` はレガシー約 20Hz。導出強度（vibe）は常に interpolated。
  - `_sendPendingActions`（L616–681）: catch-up index、`duration=max(50, next.at - time)`、`>MAX_GAP(5000ms)` はスキップ、補間 → `applySpeedLimit` → delta<0.5 スキップ。
  - **設計不変条件（L669–673）**: 導出強度の分母は `sinceLastMs=max(1, now-_lastSendTime)` **のみ**。`duration` は LinearCmd 専用。混ぜると 1 ストローク毎のランプバグになる。
  - `_dispatchLinearAtBoundary`（L690–737）: `_lastLinearSentForIdx` で重複排除、`_lastSentPos` は更新しない。
  - `_sendToDevices`（L774–868）: 全デバイス共通ファンネル。Extender 1 回適用 → デバイス毎 invert(100-pos) → range → cutoff を **pos と prevPos 両方**に → actuator 分岐（linear / vibrate / scalar / oscillate（SCALAR 安全経路、フライホイール）/ rotate）。各分岐の最終値にはさらに **機能 range → 機能 cutoff → 安全上限** が適用される（下記）。
  - `_safe`（L887）: Max 上限 + ramp は `canScalar||canOscillate` のみ。
  - **機能別選択・range/下限上限（2026-11 追加）**: `_featureMap`（deviceIndex → {linear, vibrate, scalar, oscillate, rotate}、既定=全有効）を `_featureOn()`（L901）が全 funscript 駆動分岐でチェック。機能 OFF 時は 1 回 0 を送信（linear はゼロ送しない）。機能別変換はデバイスレベル range/cutoff を模した **ペア**: `_featureRangeMap`（**再スケール**、`applyRange`）と `_featureCutoffMap`（**ハードクリップ**、`applyCutoff`）を `_featureTransform()`（L914）が機能別最終値へ適用。適用順は**デバイスレベルのスタック（range/cutoff）の後、機能 range → 機能 cutoff、そのさらに後 `_applyScalarSafety` の前** — したがって Max 上限（既定 70）は常に絶対で、高い下限でも安全上限を迂回できない。min>=max は未設定扱い（degenerate passthrough）。公開 API: `setFeatureEnabled`/`getFeatureEnabled`/`getFeatures`（L1344〜）、`setFeatureCutoff`/`getFeatureCutoff`（L1384〜）、`setFeatureRange`/`getFeatureRange`（L1416〜）。UI: 接続パネルのデバイスカード「機能」行（機能毎チェックボックス + **チップボタン**（非既定時に `R 20–80 C 0–60` 形式で要約表示）。チップで**ポップオーバー**が開き Range min/max と Limits min/max を編集、min<max は push ロジックで強制、Reset あり）。永続化: `buttplug.deviceSettings` → `features` / `featureRanges`（再スケール）/ `featureCutoffs`（クリップ、いずれも非既定値のみ保存）。旧版の `featureRanges` はクリップ意味だったため、`featureCutoffs` キー自体が欠落した旧データは cutoff として読み込む移行処理あり。この判定で「range のみ」設定が旧データと誤認されないよう、保存側はいずれかが非既定のとき**両キーを必ず書く**（もう一方は `{}`。`featureCutoffs` 欠落が分割前フォーマットのマーカー）。
  - **`_handleSourceChange`（L421、`emptied`）**: stopAll + index リセット + ramp 再アーミング（コミュニティの「振動が止まらない」バグ修正）。
- **device-transform-stack.js**（329 行）: ヘッダ L1–38 が仕様書。全エンジンが `applyDeviceStack` を経由。L24–29: **Range=再スケール / Cutoff=クリップ** の区別。`computeNaturalRange`（L207）。

### 6.5 TCode（OSR2 / SR6、10 軸）

- **tcode-manager.js**（234 行）: `connect`（serial/WS/UDP → `window.funsync.tcodeSend`）。`sendAxes`（L171）: 0–100 → `_valueMax` にスケールし `"L0500I100 R0300I250\n"` 形式（軸毎の I サフィックス = XTEngine 形状）。**`stop()`（L201–224）の分岐**: シリアルでは DSTOP のみ（中立フレームを送らない — シリアルで 50% 中立は「stop thrash」、強度軸 50% は「停止後も半出力で回り続ける」V1/V2 ゼロドロップバグ修正 L204–217）。非シリアル（UDP/WS）のみ DSTOP + 中立フレーム。
- **tcode-sync.js**（719 行）: `class TCodeSync`（L44）。TICK=round(1000/60)≈60Hz、`setUpdateRate` クランプ [15,60]。`_axisActions` Map（軸毎 enabled/range/cutoff/inverted + Range Extender）。生成モーション `_axisMotion`（link/random、`createNoise1D` は**固定シードで再現可能**）。`_tick`（L493）: catch-up、初 tick スナップ、定常状態は target=次キーフレーム実位置 + duration=残り（XTEngine モデル）、変換スタック適用、delta>=0.5 で `axisValues.L0 + axisIntervals`、コンパニオン軸、生成軸 → `sendAxes(axisValues, undefined, axisIntervals)`（L604）。
- **multi-axis.js**（214 行）: `AXIS_DEFINITIONS`（L36）= TCode v0.3 軸表（L0 stroke, L1 surge, L2 sway, R0 twist, R1 roll, R2 pitch, V0 vib, **V1 pump, A0 valve, A1 suck, A2 lube**。Tempest OSR2 / TCodeESP32 / MFP と 2026-08-16 に検証）。`buildCompanionPath`（L181、`video.surge.funscript` 規約）。
- **embedded-multi-axis.js**（256 行）: 埋め込み多軸 5 フォーマット（A: additional_axes HereSphere / B: raw / C: sibling keys / D: inline TCode / E: axes array Iwara/99DM v1.1）、`extractEmbeddedAxes`（L109）。
  - **⚠ 既知の不整合**: L62 の `TCODE_TO_SUFFIX` は `V1→lube, V2→suction` だが、multi-axis.js の v0.3 表は `V1→pump, A1→suck, A2→lube`。両者が矛盾している。

### 6.6 Autoblow Ultra / VacuGlide 2

- **autoblow-sync.js**（110 行）: `class AutoblowSync`（L5）。**SyncEngine と同一アーキテクチャ**（スクリプトアップロード + 同期再生。tick 駆動ではない）。動画イベント → API 呼び出し（`syncStart`/`syncStop`、seek では await）。実 API 呼び出しはメインプロセスの autoblow-api.js（§4.12）。

### 6.7 フィラー / ギャップ

- **filler-engine.js**: `applyFiller`（L373）入口、`buildGapFiller`（L205）、`mergeFiller`（L315、`_filler` フラグで区別）、`limitSlewRate`（L99、DEFAULT_MAX_JOIN_SPEED=300）、`fillRawScriptContent`（L348）。
- **gap-filler.js**（UI 向け軽量版）: `detectGaps`（L12）、`fillGap`（L74）。
- **gap-skip.js**: `class GapSkipEngine`（L9）。しきい値 10 秒、LEAD 1.5 秒、クールダウン 3 秒、チェック 1 秒 — **動画側をスキップ**する（フィラーと逆のアプローチ）。

### 6.8 エディタ系

- **editable-script.js**: `class EditableScript`（L5）。Undo/Redo、insert/update/delete/move、copy/paste、`simplify`（L573、RDP 間引き）、`applyModifier`（L686）、`toFunscriptJSON`（L885）。**編集は著者側のみ**、再生は FunscriptEngine 経由。
- **script-modifiers.js**: 純関数群（halfSpeed / doubleSpeed / remapRange / offsetTime / removePauses / reverseActions / generatePattern）。
- **action-graph.js**: `class ActionGraph` — canvas 描画（波形、multiband、VAD、ビートマーカー、単調タンジェント L856、ヒートマップ L986、hitTest）。
- **motion-source.js**: `patternValue`、`createNoise1D(seed=1337)`、`fbm`、`sampleMotion`、`axisPhase`。

### 6.9 ブリッジ

- **remote-bridge.js**: `class RemoteBridge`（L16）。ポート 5123、再接続 backoff 1–15 秒、`RemotePlaybackProxy`（スマホの再生状態を `<video>` ソースとして扱う）。`/sync/observe` に接続。
- **vr-bridge.js**: `class VRBridge`（L25）。WayVR（MultiFunPlayer 互換 TCP 23554）、seek、状態購読、8 秒ウォッチドッグ。
- **audience-bridge.js**: `class AudienceBridge`（L40）。複数 Handy のロースター、`addViewer`、`hsspPlayAll/StopAll/SyncTimeAll`（L285〜）= HSSP の N 本へのファンアウト。
- **data-service.js**: `dataService` シングルトン（L317）。設定ツリー、playlists/categories CRUD（preload 経由）。
- **event-bus.js**: `eventBus` シングルトン（L77）。`on` は解除関数を返し、`emit` はハンドラ例外を catch。

---

## 7. Python バックエンド（`backend/`）

### 7.1 起動と構成（main.py、118 行）

- FastAPI（title "FunSync Backend" v0.1.0）+ uvicorn。**既定ポート 5123、ホスト 0.0.0.0**（LAN 公開）。CORS `allow_origins=["*"]`（Electron レンダラと LAN クライアント向け）。
- ルーター登録（L30–37）: `/scripts` `/thumbnails` `/metadata` `/api/media`（media）、vr_api（プレフィックスなし）、`/api/remote`（remote / remote_sync / locale）。
- 静的マウント（L42–45, L78–80）: `/remote` → `web-remote/`（html=True）、`/locales` → `renderer/locales/`。`sys._MEIPASS` 対応（PyInstaller）。
- **no-cache ミドルウェア**（L55–61）: `/remote*` と `/locales/*` に `Cache-Control: no-cache`（アプリ更新後にスマホが古い index.html と新しい app.js を混在させる事故対策。ETag で 304 になるため LAN では実質無料）。
- 根ルート: `/health`（生存確認）、`/`（VR サーバー識別テキスト）、`/network-info`（LAN IP）。
- CLI: `--port 5123 --host 0.0.0.0 --user-data-dir <userData>`（locale API が config.json を読むため）。

### 7.2 HTTP API 一覧

| ルート | 役割 |
|---|---|
| `GET /health` | 生存確認（python-bridge が 5 秒毎） |
| `GET /network-info` | LAN IP（VR URL 表示用） |
| `POST /scripts/convert` | funscript JSON → CSV（md5[:12] ハッシュ、512KiB 超で 413、`local_url: http://{ip}:5123/scripts/{hash}.csv` 返却） |
| `GET /scripts/{hash}.csv` | CSV 配信（The Handy が取得） |
| `POST /thumbnails/generate` / `single` / `GET /thumbnails/image` | サムネイル生成（content hash ディスクキャッシュ） |
| `GET /metadata/?video_path=` | ffprobe メタデータ（同期 def → threadpool） |
| `POST /api/media/register` | **Electron がライブラリ走査結果・コレクション/プレイリスト/カテゴリ/ソース/カスタムサムネイルを登録**（`_apply_registration` は threadpool 実行。イベントループを塞ぐと /health が止まる） |
| `GET /api/media/stream/{id}` | **Range ストリーミング本体**（512KB chunk、`run_in_executor`、`bytes=X-` は EOF まで、206 + Content-Range + ACAO* + no-store。切断検知で早期 break しない — L745–757 コメント） |
| `GET /api/media/script/{id}?variant=` / `subtitle/{id}` / `thumb/{id}` | funscript / 字幕 / サムネイル（生成中は 1x1 PNG プレースホルダ、生成は daemon thread 遅延実行） |
| `POST /api/media/remux` | mkv→mp4 stream copy（キャッシュ） |
| `POST /api/media/resolve` + `GET /api/media/remote/{token}/*` | yt-dlp 解決 + HLS/プログレッシブ透過プロキシ（トークン管理、`_REMOTE_MAX=32`） |
| `GET /api/media/durations` / `speed-stats` | 背景 ffprobe プローブ結果（**`DURATION_PROBE_WORKERS=2` Semaphore**。2026-08-09 事故: スレッド 1466 本で GIL 枯渇、/health 25.8 秒無応答） |
| `GET /api/media/vr-activity` | 直近ヘッドセットのシーン要求（コンパニオン自動接続） |
| `GET /api/media/rescan-request` | スマホ→デスクトップの再スキャン要求信号 |
| `GET /deovr` / `/deovr/{id}` | DeoVR ライブラリ/シーン JSON（**chunked 転送で DeoVR のパーサが壊れるため Content-Length 明示**） |
| `GET /heresphere` / `/heresphere/{id}` | HereSphere JSON（`HereSphere-JSON-Version: 1`、projection/stereo/fov、scripts に funscript URL） |
| `GET /api/remote/videos` | web-remote のメインデータ（`streamUrl` に `_BOOT_TOKEN`=uuid4[:8] キャッシュバスター） |
| `GET /api/remote/sources|collections|playlists|categories` | グループ配信 |
| `POST /api/remote/request-rescan` / `seek-timing` | 再スキャン要求 / シーク診断（sendBeacon） |
| `GET /api/remote/locale` | デスクトップ config.json の言語/テーマ（PWA の表示一致） |

**動画 ID**: `_path_to_id = md5(path)[:12]`（安定 ID）。

**VR 形式判定**（vr_api.py）: `VR_PATTERNS`（360/180/SBS/TB/fisheye/MKX200 等 36 種）→ `VR_STUDIO_FORMATS`（SIVR/KAVR/… → mkx200/sbs）→ `_dims_suggest_vr`（w>=3200 かつ aspect 1.9–2.1）→ 優先順: 手動上書き `manualVRType` → 明示タグ → スタジオ接頭辞 → XXVR-### 広域 → 解像度タグ → 裸の "VR"。

### 7.3 WebSocket 同期（remote_sync.py、265 行）

- `/api/remote/sync`（**スマホ=コントローラ**）: 接続時に既存スマホを last-wins で追放（`{"type":"kicked"}` + close 4000）。`hello/state/play/pause/seek/ended/bye` を受信し `{from:"phone", ip, ...}` として観測者へ転送。最新 state は `_last_state` にキャッシュし遅延接続の観測者にスナップショット配信。
- `/api/remote/sync/observe`（**Electron=単一観測者**）: 既存観測者は close 4001 で置換。観測者からのメッセージ（デバイス状態、script-*）はアクティブなスマホへ返送。

### 7.4 services/

| モジュール | 行数 | 責務 |
|---|---|---|
| ffmpeg.py | 750 | `_find_binary`（frozen → exe 隣 / dev → `ffmpeg/`・`ffmpeg-linux/` / PATH）、`run_silent`（CREATE_NO_WINDOW 0x08000000 — windowed exe で数百のコンソール窓が点滅する対策）、メタデータキャッシュ（(path,size,mtime) キー、5000 件、JSON 永続化。2026-08-03 実測: 420 本で起動 13 秒中約 7 秒浪費）、`get_metadata`（profile/pixFmt は Chromium が復号できない H.264 変種判別用）、`remux_to_mp4`（stream copy、動画 h264/hevc/av1・音声 aac/mp3 のみ copy）、`generate_single_thumbnail`（既定 seek 10%、黒イントロ回避。THUMBNAIL_TIMEOUT_SEC=25） |
| funscript.py | 65 | `parse_funscript`（検証 + at 昇順）、`funscript_to_csv`（"at_ms,pos"、pos 0–100 クランプ） |
| hls_proxy.py | 64 | `rewrite_manifest`（**純関数**）。m3u8 内 URI を `{base}/{token}/manifest|seg?u=` へ書換 |
| network.py | 23 | `get_local_ip()`（UDP で 8.8.8.8 に connect — パケット送信なし、getsockname） |
| resolver.py | 180 | yt-dlp **Python API**（サブプロセスではない）。`ResolveError(kind)` ∈ {unsupported, login, drm, geo, live, unavailable, error}。`_pick_format`: プログレッシブ MP4 → HLS マスター → トップレベル url。**ライブ配信は拒否**（「Live streams can't be synced」） |

### 7.5 web-remote/（スマホ PWA）

- **PWA**: `manifest.json`（display:standalone、アイコン 192/256/512）、iOS `apple-mobile-web-app-capable`。
- `index.html`（209 行）SPA シェル（タブ library/collections/playlists/categories、フィルタ/ソートシート、スケルトン）。単一 ES module エントリ `app.js`（3,280 行、vanilla SPA、**ハッシュナビ `#play/<id>`** でスマホの戻るボタン/スワイプが自然に効く。iOS 100vh バグ対策 `--app-vh`）。
- `remote-sync.js`（263 行）: `RemoteSyncClient`。WS `/api/remote/sync?videoId=`、250ms スロットルの state 送信、画面非表示時に再生停止（WS スロットリングでデバイスが置き去りになる対策）、バッファスタールを「実効 paused」扱い、再接続 backoff 最大 10 秒、`kicked` 受信時 UI 通知。
- `i18n.js`（205 行）: **アクティブ言語はバックエンド `/api/remote/locale` が決める**（スマホ側に言語ピッカーなし）。バンドルは `/locales/<lang>.json`。
- `vr-detect.js`（131 行）: バックエンド vr_api.py と同じ 5 段ロジックのクライアント移植。
- `library-search.js` / `folder-index.js` / `shuffle.js` / `search-context.js` / `heatmap.js` / `icons.js`: デスクトップ版の移植（Fisher–Yates + balanced shuffle 等）。

---

## 8. セキュリティ・プライバシー設計

| 項目 | 実装 |
|---|---|
| プロセス分離 | `contextIsolation:true`、`nodeIntegration:false`、preload の `window.funsync` 単一グローバルのみ |
| CSP | `script-src 'self'`（インライン禁止）、`connect-src` は localhost + handyfeeling.com + discuss.eroscripts.com 等ホワイトリスト。**CSP 準拠は CI テスト**（csp-compliance） |
| ログ秘匿化 | log-redact.js がメディアファイル名のみ `[hidden]`（既定 OFF、設定連動、全ログの単一チョークポイント） |
| 診断情報 | `collect-diagnostics` はログ末尾 80 行 + 状態のみ。**プライバシー契約（main.js L538–541）: ファイルパス・ユーザー名・デバイス鍵は絶対に含めない** |
| 認証 | EroScripts は `persist:eroscripts-login` パーティション + `_t` クッキー。safe-key.js（DPAPI）は未使用 |
| 外部リンク | `open-external` は http/https のみ |
| 更新 | autoDownload=false（ユーザー制御） |

---

## 9. テスト戦略

| 層 | 内容 |
|---|---|
| 単体（vitest ^4.1.4） | `tests/unit/` 約 188 ファイル。jsdom、`retry:2`（CI 不安定対策）、`pool: threads, maxWorkers 4`。`tests/setup.js`（282 行）が `globalThis.funsync`（preload IPC）をモック（getBackendPort→5123 等）、en.json を `_setBundlesForTests` で注入 |
| メタ/回帰テスト | `@vitest-environment node` docblock で**コードベース自体を検証**: locale-key-parity（8 ロケールのキー一致）、csp-compliance |
| e2e（Playwright ^1.58.2） | God-object（app.js / library.js）は単体テストされず e2e 依存 |
| バックエンド（pytest + pytest-asyncio + httpx） | `pytest.ini`、routes/services の純関数（rewrite_manifest 等）はテスト容易な設計 |

---

## 10. ビルド・配布・CI/CD

### scripts/build.js（138 行）— 4 段階ガード

1. vitest + pytest 実行
2. PyInstaller（`funsync-backend.spec`）→ **2b: バックエンド exe 欠損 or 1,000,000 バイト未満で FATAL**（実事故 2026-08-13）→ **2c: fetch-twemoji.mjs、SVG 100 個未満で FATAL**
3. electron-builder
4. **dist/{win,linux}-unpacked/resources/backend の欠損/空で FATAL**

### electron-builder.yml（105 行）

- `asar:true`、`npmRebuild:false`、`asarUnpack: ["**/*.node"]`（serialport 等のネイティブ）
- `extraResources: backend-dist → backend`（PyInstaller 出力をリソースへ）
- win: NSIS + portable（x64）+ `ffmpeg/` extraFiles / linux: AppImage + `ffmpeg-linux/`
- publish: GitHub Releases

### .github/workflows/build.yml（206 行）

tag `v*` で起動。win+linux matrix（`fail-fast:false`）、Node 22 + Python 3.11、vitest → pytest → PyInstaller → exe≥1MB ガード → twemoji ガード → electron-builder → `softprops/action-gh-release@v2`（tag に `-` を含むと prerelease）。

---

## 11. 設計上の特徴（強み）

1. **フレームワークゼロの素の DOM + ES modules**: ビルドステップなし、CSP `script-src 'self'` と両立。コンポーネントは DI + 静的 HTML コンテナマウントの統一パターン。
2. **設計根拠がコードに残る**: ヘッダコメントに UX 原則引用（Nielsen/Shneiderman）、`notes/features/SCOPE-*.md` 仕様参照、事故記録（2026-08-09 スレッド枯渇、2026-08-13 exe 欠損、cp1252 デコードクラッシュ等）と修正根拠がコメントで不変条件化されている。
3. **純関数分離によるテスト容易性**: `rewrite_manifest`、`applyRetentionPolicy`、script-modifiers、interpolation 等は I/O なしで単体テスト可能。
4. **フェイルセーフ方針の一貫性**: バックアップ失敗でクラッシュしない、バックエンド欠損は dev パスに落ちず明示失敗、EroScripts は一時的障害でログアウトしない、`file-exists` は 800ms race。
5. **順序依存の明示**: verifyAndRecover→initStore、ポータブル IIFE→logger/store、`'Uvicorn running'` マーカー→resolve、pruneOld はスナップショット成功後。
6. **成熟した i18n**: 8 ロケール、ICU、キーパリティ CI、PWA はデスクトップ設定に追従。
7. **打包失敗モードをコードでガード**: exe サイズ + dist チェックが build.js と CI の両方にある。

## 12. 技術的負債・留意点

1. **God-object**: `app.js`（10,316 行）と `library.js`（6,878 行）は単体テストされず e2e 依存。新機能は小さなコンポーネント + 純モジュールへ分割する傾向が続いている。
2. **既知の不整合**: `embedded-multi-axis.js` L62 の `TCODE_TO_SUFFIX`（V1→lube, V2→suction）が `multi-axis.js` の v0.3 軸表（V1→pump, A1→suck, A2→lube）と矛盾。
3. **未使用コード**: `safe-key.js` はどこからも require されていない（main.js のコメント言及のみ）。
4. **色定数のミラー**: window-bg.js とレンダラ CSS の色は手動同期必須（コメントで警告されているが単一情報源ではない）。
5. **CORS 全開 + 0.0.0.0**: LAN 公開前提の設計。絶対パスを API で返すのも LAN 内専用前提（remote.py L123–126 コメント）。

## 13. 押さえておくべき設計不変条件（改修時の注意）

- ButtplugSync: 導出強度の分母は `sinceLastMs` のみ、`duration` は LinearCmd 専用（buttplug-sync.js L669–672）
- `emptied` ハンドラで stopAll + ramp 再アーミング（振動が止まらないバグ、L400）
- HSSP 操作は `_hsspChain` で直列化、stop/setup は絶対に破棄しない（handy-manager.js L214–218）
- TCode `stop()`: シリアルは DSTOP のみ、非シリアルのみ中立フレーム（tcode-manager.js L201–224）
- 変換スタックの順序: Extender → Invert → Range → Cutoff → SafetyCap。速度制限と符号化はスタック外（device-transform-stack.js L8–22）
- HSSP には変換をスクリプト内容へ適用（tick 補間がない）
- 統計・自然レンジは authored アクションのみから導出（funscript-engine.js L192–196）
- `verifyAndRecover` は `initStore()` より前、ポータブル IIFE は logger/store require より前
- DeoVR 応答は Content-Length 必須（chunked でパーサ破綻）
- `/api/media/register` と `/metadata` は threadpool 実行（イベントループを塞ぐと /health が止まる）
