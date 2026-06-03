process.on('uncaughtException', function (e) {
  try {
    require('fs').writeFileSync(require('path').join(__dirname, '..', 'crash.log'), e.stack, 'utf-8');
    console.error(e.stack);
  } catch (_) {
    // intentional: crash.log への書き込み自体が失敗 (= 権限 / disk full 等)。
    // ここで例外を波及させると process.exit に到達できないため、 cleanup の
    // best-effort で握る。 元の例外 (= e) は console.error で出力済み (= 同じ
    // try の中で先に呼ばれている)。
  }
  // graceful shutdown を試みてからプロセス終了
  // (= shutdownApp 経由で coreBridge.stop() を呼び、Rust 側 listener を解放する)
  try {
    if (typeof shutdownApp === 'function') {
      shutdownApp('uncaught-exception')
        .catch(function () {
          // intentional: graceful shutdown の async 失敗を握る。 続く .then で
          // process.exit(1) に必ず到達させるため、 失敗しても reject を波及しない。
        })
        .then(function () { process.exit(1); });
      return;
    }
  } catch (_) {
    // intentional: shutdownApp 同期部分の例外を握って、 直後の process.exit(1) を保証する。
  }
  process.exit(1);
});
const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { extractVideoId, buildChatUrl, buildWatchUrl } = require('./youtube-url');
const coreBridge = require('./core-bridge');
const i18n = require('./i18n');
const { autoUpdater } = require('electron-updater');
const migration = require('./migration');
var pathUtils = require('./path-utils');
var log = require('./log');
var L = log.create('Main');
var LU = log.create('Updater');

var isDemo = process.argv.includes('--demo');
// デモモード状態 (= prepareDemoData がセット、startDemo が参照)
var demoSeed = null;          // demo-seed.json をパースしたオブジェクト
var demoLiveVideoId = null;   // seed 内 live:true の配信 videoId

/**
 * app-config.json を peek して debugLoggingEnabled の現在値を取得する。
 * ロガー初期化前 (= Rust core 起動前) に呼ぶため、 fs で直接読む。
 * ファイル不在 / parse 失敗時は false (= 通常運用)。
 * 正本は Rust AppConfig.debug_logging_enabled、 ここは「読み取り専用」 でロガー
 * level 決定に使う。 詳細仕様: docs/logging.md。
 */
function peekDebugLoggingEnabled(userDataDir) {
  try {
    var configPath = path.join(userDataDir, 'app-config.json');
    if (!fs.existsSync(configPath)) return false;
    var content = fs.readFileSync(configPath, 'utf-8');
    var config = JSON.parse(content);
    return !!(config && config.debugLoggingEnabled === true);
  } catch (e) {
    return false;
  }
}

const store = new Store({
  defaults: {
    lastUrl: '',
    windowBounds: { width: 976, height: 1234 },
    sidebarCollapsed: false,
    appsCollapsed: false,
    lastVersion: '0.0.0',
    onecommeDir: '', // Step 3 フェーズ 3.5: わんコメ書き戻し / 同期で使うパス
    autoImportOnStart: true, // 起動時にわんコメから取り込む (= 読み取りのみで安全)
    // 書き戻しはユーザーの「別アプリ (わんコメ) の DB」を改変するため、出荷デフォルトは
    // OFF (= 設定画面で明示的に有効化するオプトイン)。無断改変での破損リスクを避ける。
    autoExportEnabled: false
  }
});

function defaultOnboardingState() {
  return {
    version: 1,
    collapsed: false,
    dismissed: false,
    lastActiveStage: 'connect',
    stages: {
      connect: { skipped: false, completedAt: null },
      obs: {
        copiedCommentUrlAt: null,
        copiedEffectsUrlAt: null,
        openedPreviewAt: null,
        userConfirmedAt: null,
        skipped: false
      },
      listenerHistory: {
        wantsListenerHistory: null,
        wantsOneComme: null,
        firstImportCompletedAt: null,
        skipped: false
      }
    }
  };
}

function mergePlainObject(base, patch) {
  var out = Array.isArray(base) ? base.slice() : Object.assign({}, base || {});
  if (!patch || typeof patch !== 'object') return out;
  Object.keys(patch).forEach(function (key) {
    var val = patch[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = mergePlainObject(out[key], val);
    } else {
      out[key] = val;
    }
  });
  return out;
}

function getOnboardingState() {
  return mergePlainObject(defaultOnboardingState(), store.get('onboardingState') || {});
}

function updateOnboardingState(patch) {
  var next = mergePlainObject(getOnboardingState(), patch || {});
  next.version = 1;
  store.set('onboardingState', next);
  return next;
}

function onboardingStageIsComplete(state, stageId) {
  var stages = state && state.stages ? state.stages : {};
  var st = stages[stageId] || {};
  if (st.skipped) return true;
  if (stageId === 'connect') return !!st.completedAt;
  if (stageId === 'obs') return !!st.userConfirmedAt;
  if (stageId === 'listenerHistory') return st.wantsListenerHistory === false || !!(st.completedAt || st.firstImportCompletedAt);
  return false;
}

// 実データ (自チャンネル設定 / 接続実績) があれば「経験者」とみなす。onboardingState は
// 初期化 (config.json リセット) で消えるため、フラグだけに頼ると既に使い込んでいるユーザーにも
// 準備が出続ける。実データを正本シグナルにし、経験者には準備 (オンボーディング) を出さない。
async function userLooksEstablished() {
  if (!coreBridge.isRunning()) return false;
  try {
    var owners = await coreBridge.getOwnerChannels();
    if (owners && Array.isArray(owners.ownerChannels) && owners.ownerChannels.length > 0) return true;
  } catch (_e) { /* コア未応答時は未確定として扱う */ }
  try {
    var overview = await coreBridge.getDataOverview();
    if (overview && (((overview.commentsCount || 0) > 0) || ((overview.listenersCount || 0) > 0))) return true;
  } catch (_e) { /* 同上 */ }
  return false;
}

// 準備 (オンボーディング) をまだ出すべきか。dismissed / 全ステージ完了 / 経験者 のいずれかなら
// false (= 起動時の自動オープンをしない + ヘッダーの「準備」ボタンを隠す、の共通判定)。
async function onboardingPending() {
  var state = getOnboardingState();
  if (state.dismissed) return false;
  if (await userLooksEstablished()) return false;
  return !(
    onboardingStageIsComplete(state, 'connect') &&
    onboardingStageIsComplete(state, 'obs') &&
    onboardingStageIsComplete(state, 'listenerHistory')
  );
}

// ユーザー素材ディレクトリ（app.whenReady後に初期化）
var userDataDir;
var userAssetsDir;
var userFramesDir;
var presetsDir;

var missingBundledAssetWarnings = Object.create(null);

function resolveBundledAssetPath(relativePath, label) {
  var resolved = path.join(__dirname, '..', relativePath);
  if (fs.existsSync(resolved)) return resolved;
  if (!missingBundledAssetWarnings[resolved]) {
    missingBundledAssetWarnings[resolved] = true;
    L.warn('Bundled ' + label + ' is missing:', resolved);
  }
  return null;
}

function getBundledWindowIconPath() {
  return resolveBundledAssetPath(path.join('assets', 'app-icon.png'), 'window icon');
}

function applyWindowIconOption(options) {
  var iconPath = getBundledWindowIconPath();
  if (iconPath) options.icon = iconPath;
  return options;
}

function initUserAssets() {
  // デフォルト素材のソース（パッケージ内）
  var defaultAssetsDir = path.join(__dirname, '..', 'assets');

  // ディレクトリ作成
  // リアクションアバターのフレーム / icon は配信者が「素材」UI から
  // 個別にアップロードする運用。デフォルト素材は同梱しない。
  if (!fs.existsSync(userAssetsDir)) fs.mkdirSync(userAssetsDir, { recursive: true });
  if (!fs.existsSync(userFramesDir)) fs.mkdirSync(userFramesDir, { recursive: true });

  // particles フォルダ作成
  var userParticlesDir = path.join(userAssetsDir, 'particles');
  if (!fs.existsSync(userParticlesDir)) fs.mkdirSync(userParticlesDir, { recursive: true });

  // particles 素材をコピー（存在しない場合のみ）
  var defaultParticlesDir = path.join(defaultAssetsDir, 'particles');
  if (fs.existsSync(defaultParticlesDir)) {
    var pFiles = fs.readdirSync(defaultParticlesDir);
    pFiles.forEach(function (file) {
      var dest = path.join(userParticlesDir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(defaultParticlesDir, file), dest);
      }
    });
  }

  // config.json をコピー（存在しない場合のみ）
  var defaultConfig = path.join(defaultAssetsDir, 'config.json');
  var userConfig = path.join(userAssetsDir, 'config.json');
  if (!fs.existsSync(userConfig) && fs.existsSync(defaultConfig)) {
    fs.copyFileSync(defaultConfig, userConfig);
  }

  // プリセットディレクトリ作成
  if (!fs.existsSync(presetsDir)) fs.mkdirSync(presetsDir, { recursive: true });
}

let mainWindow = null;
let chatWindow = null;
let loginWindow = null;
let setupWindow = null;
let ponoutWindow = null;
let currentVideoId = null;
let currentConnectionMessage = '未接続';
let reconnectTimer = null;
let isManualDisconnect = false;
let apiClientsInterval = null;
let singleInstanceDialogOpen = false;
let shuttingDown = false;

function hasUsableMainWindow() {
  return !!(mainWindow && !mainWindow.isDestroyed());
}

function clearApiClientsInterval() {
  if (apiClientsInterval) {
    clearInterval(apiClientsInterval);
    apiClientsInterval = null;
  }
}

function closeAuxiliaryWindows() {
  disconnectChat();

  if (manualWindow && !manualWindow.isDestroyed()) {
    manualWindow.close();
    manualWindow = null;
  }

  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
    setupWindow = null;
  }

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
    loginWindow = null;
  }
}

// ===== EADDRINUSE 自動復旧 (= zombie LISTEN socket 解消) =====
// 真因: 死んだハブ親 PID の子プロセスが socket handle を継承して保持
// → ハブが直接子プロセス全部 (= owner PID を ParentProcessId に持つ全プロセス) を
//   taskkill /T /F すると、kernel object の ref count が 0 になって socket 解放
// 詳細: memory `project_zombie_listen_root_cause`
function attemptZombieRecovery(port) {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32') {
      L.warn('Zombie recovery: not on Windows, skip');
      resolve({ recovered: false, reason: 'not_windows' });
      return;
    }
    L.info('Zombie recovery: probing port', port);
    probeZombieOwner(port).then(function (probe) {
      if (!probe || !probe.ok) {
        L.warn('Zombie recovery: probe failed:', probe && probe.reason);
        resolve({ recovered: false, reason: probe && probe.reason });
        return;
      }
      if (probe.ownerAlive) {
        // 合法な使用中 (= 別アプリが本当に 11280 を使っている)
        L.warn('Zombie recovery: port held by live PID', probe.ownerPid, '- not a zombie');
        resolve({ recovered: false, reason: 'owner_alive', ownerPid: probe.ownerPid });
        return;
      }
      if (!probe.descendants || probe.descendants.length === 0) {
        L.warn('Zombie recovery: dead owner PID', probe.ownerPid, 'has no descendants - cannot recover');
        resolve({ recovered: false, reason: 'no_descendants', ownerPid: probe.ownerPid });
        return;
      }
      L.info('Zombie recovery: killing', probe.descendants.length, 'descendant(s) of dead PID', probe.ownerPid);
      probe.descendants.forEach(function (d) {
        L.info('  - PID=' + d.pid + ' ' + d.name);
      });
      killProcessTrees(probe.descendants.map(function (d) { return d.pid; })).then(function () {
        // socket release を OS 側に伝播させる猶予
        setTimeout(function () { resolve({ recovered: true, killed: probe.descendants }); }, 1500);
      }).catch(function (e) {
        L.error('Zombie recovery: taskkill failed:', e && e.message ? e.message : e);
        resolve({ recovered: false, reason: 'taskkill_failed' });
      });
    }).catch(function (e) {
      L.error('Zombie recovery: probe threw:', e && e.message ? e.message : e);
      resolve({ recovered: false, reason: 'probe_exception' });
    });
  });
}

// PowerShell で LISTEN owner と直接子プロセスを取得する。
// 戻り値: {ok, ownerPid, ownerAlive, descendants:[{pid,name}]}
function probeZombieOwner(port) {
  return new Promise(function (resolve, reject) {
    var execFile = require('child_process').execFile;
    var ps = ''
      + '$ErrorActionPreference = "Stop"; '
      + '$port = ' + Number(port) + '; '
      + '$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; '
      + 'if (-not $conn) { ConvertTo-Json -Compress -InputObject @{ok=$false; reason="no_listen"}; exit 0 } '
      + '$ownerPid = [int]$conn.OwningProcess; '
      + '$owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue; '
      + '$alive = if ($owner) { $true } else { $false }; '
      + '$descendants = @(); '
      + 'if (-not $alive) { '
      + '  $children = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ownerPid }); '
      + '  foreach ($c in $children) { $descendants += @{pid=[int]$c.ProcessId; name=$c.Name} } '
      + '} '
      + 'ConvertTo-Json -Compress -Depth 4 -InputObject @{ok=$true; ownerPid=$ownerPid; ownerAlive=$alive; descendants=@($descendants)}; ';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000, windowsHide: true }, function (err, stdout) {
      if (err) {
        L.warn('probeZombieOwner: powershell failed:', err.message);
        return resolve({ ok: false, reason: 'powershell_failed' });
      }
      var line = String(stdout || '').trim();
      try {
        var parsed = JSON.parse(line);
        // ConvertTo-Json は要素 1 個の配列を object として吐くが、descendants は @() で配列強制済
        if (parsed.descendants && !Array.isArray(parsed.descendants)) {
          parsed.descendants = [parsed.descendants];
        }
        resolve(parsed);
      } catch (e) {
        L.warn('probeZombieOwner: JSON parse failed:', e.message, 'raw:', line);
        resolve({ ok: false, reason: 'parse_failed' });
      }
    });
  });
}

// 各 PID をツリーごと taskkill /T /F で終了する (= 同一ユーザのプロセスなので admin 不要)
function killProcessTrees(pids) {
  var execFile = require('child_process').execFile;
  return Promise.all(pids.map(function (pid) {
    return new Promise(function (resolve) {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, function (err, stdout, stderr) {
        if (err) {
          // 既に死んでた等は無視
          L.warn('taskkill /PID ' + pid + ' /T /F failed (continuing):', err.message);
        } else {
          L.info('taskkill /PID ' + pid + ' /T /F: ' + String(stdout || '').trim());
        }
        resolve();
      });
    });
  }));
}

// EADDRINUSE / EBIND / EUNKNOWN 共通の致命ダイアログ → app.exit
function showFatalCoreErrorDialog(code, err, recoveryResult) {
  // 技術用語 (port / process / OBS 等) はユーザ向け文言から排除
  // (= memory `feedback_user_capability_assumption`)
  var message = 'こめはぶを起動できませんでした';
  var detail;
  if (code === 'EADDRINUSE') {
    detail = [
      '前回こめはぶが正しく終了できなかったため、一時的に起動できない状態になっています。',
      '',
      'お手数ですが、PC を再起動してから、もう一度こめはぶを開いてください。'
    ].join('\n');
  } else if (code === 'EBIND') {
    detail = '通信の準備に失敗しました。PC を再起動してから、もう一度お試しください。';
  } else {
    detail = '原因不明のエラーです。PC を再起動してから、もう一度お試しください。';
  }
  if (recoveryResult) {
    L.info('Fatal dialog after recovery attempt: result=', JSON.stringify(recoveryResult));
  }
  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Live Comment Hub',
      message: message,
      detail: detail,
      buttons: ['終了'],
      defaultId: 0,
      noLink: true
    });
  } catch (e) {
    L.error('Failed to show core-error dialog:', e && e.message ? e.message : e);
  }
  app.exit(1);
}

async function shutdownApp(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  L.warn('App shutdown requested:', reason);
  clearApiClientsInterval();
  closeAuxiliaryWindows();
  await coreBridge.stop();
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pendingResetMarkerPath() {
  return path.join(app.getPath('temp'), 'live-comment-hub-pending-reset.json');
}

function isPathInside(parent, child) {
  var rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// リセット種別ごとの削除対象。
//   'settings' = 設定 / 構成のみ (= 既定に戻す)。データ / バックアップ / ログインは残す
//   'data'     = 蓄積データ (= listeners.db / media-cache) のみ。設定 / バックアップ / ログインは残す
//   'all'      = 完全初期化 (= 上記 + バックアップ + ログイン / Chromium ランタイム一式)
function resetTargetPaths(kind) {
  var settingsTargets = [
    store.path,                                 // config.json (UI 状態 / オンボーディング)
    path.join(userDataDir, 'app-config.json'),  // Rust 設定 (TTS / 通知 / 分類 / 全体設定 / owner_channels)
    path.join(userDataDir, 'assets'),
    path.join(userDataDir, 'presets'),
    path.join(userDataDir, 'scenes'),
    path.join(userDataDir, 'effects'),
    path.join(userDataDir, 'plugins'),
    path.join(userDataDir, 'templates')
  ];
  var dataTargets = [
    path.join(userDataDir, 'data'),             // listeners.db (リスナー/コメント/タグ/わんコメ退避/watermark)
    path.join(userDataDir, 'media-cache')       // キャッシュ画像 (アバター/スタンプ/絵文字)
  ];
  // 完全初期化でのみ消す: バックアップ + ログインセッション / Chromium ランタイム一式
  var loginAndRuntimeTargets = [
    path.join(userDataDir, 'backups'),
    path.join(userDataDir, 'Partitions'),
    path.join(userDataDir, 'Local Storage'),
    path.join(userDataDir, 'Session Storage'),
    path.join(userDataDir, 'IndexedDB'),
    path.join(userDataDir, 'blob_storage'),
    path.join(userDataDir, 'Network'),
    path.join(userDataDir, 'Cache'),
    path.join(userDataDir, 'Code Cache'),
    path.join(userDataDir, 'GPUCache'),
    path.join(userDataDir, 'DawnCache'),
    path.join(userDataDir, 'Local State'),
    path.join(userDataDir, 'Preferences'),
    path.join(userDataDir, 'SharedStorage'),
    path.join(userDataDir, 'Shared Dictionary')
  ];
  var targets;
  if (kind === 'settings') targets = settingsTargets;
  else if (kind === 'data') targets = dataTargets;
  else targets = settingsTargets.concat(dataTargets, loginAndRuntimeTargets); // 'all'
  return targets.filter(function (target) {
    return target && (target === store.path || isPathInside(userDataDir, target));
  });
}

function snapshotPathSync(src, dest, warnings) {
  try {
    if (!fs.existsSync(src)) return;
    var stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach(function (entry) {
        snapshotPathSync(path.join(src, entry.name), path.join(dest, entry.name), warnings);
      });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  } catch (err) {
    warnings.push({
      path: src,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function snapshotResetTargets(snapshotDir, targets) {
  var warnings = [];
  fs.mkdirSync(snapshotDir, { recursive: true });
  targets.forEach(function (target) {
    if (!fs.existsSync(target)) return;
    var dest = path.join(snapshotDir, path.basename(target));
    snapshotPathSync(target, dest, warnings);
  });
  fs.writeFileSync(path.join(snapshotDir, 'RESET-README.txt'), [
    'Live Comment Hub reset backup',
    'Created at: ' + new Date().toISOString(),
    'Original userData: ' + userDataDir,
    '',
    'This folder was created before resetting all app settings.',
    warnings.length ? '' : null,
    warnings.length ? 'Some files could not be copied because they were locked or unavailable:' : null,
    warnings.length ? JSON.stringify(warnings, null, 2) : null
  ].filter(Boolean).join('\n'), 'utf-8');
  return warnings;
}

function removeResetTargetsSync(targets) {
  var errors = [];
  targets.forEach(function (target) {
    if (!fs.existsSync(target)) return;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      errors.push({
        path: target,
        error: err && err.message ? err.message : String(err)
      });
    }
  });
  return errors;
}

function performPendingResetIfNeeded() {
  var markerPath = pendingResetMarkerPath();
  if (!fs.existsSync(markerPath)) return null;

  var marker = {};
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch (err) {
    L.warn('Pending reset marker could not be read:', err && err.message ? err.message : err);
  }

  if (marker.userDataDir && marker.userDataDir !== userDataDir) {
    L.warn('Pending reset marker ignored because userDataDir differs:', marker.userDataDir);
    fs.rmSync(markerPath, { force: true });
    return null;
  }

  var kind = marker.kind || 'all';
  L.warn('Performing pending reset before app initialization (kind=' + kind + ')');
  // config.json (= store) は settings / all のときだけクリア。data リセットでは UI 状態を残す。
  if (kind !== 'data') store.clear();
  var errors = removeResetTargetsSync(resetTargetPaths(kind));
  if (errors.length) {
    L.error('Pending reset completed with errors:', JSON.stringify(errors).slice(0, 1000));
  }
  fs.rmSync(markerPath, { force: true });
  return marker;
}

function writePendingResetMarker(kind, snapshotDir, warnings) {
  fs.writeFileSync(pendingResetMarkerPath(), JSON.stringify({
    createdAt: new Date().toISOString(),
    kind: kind || 'all',
    userDataDir: userDataDir,
    backupDir: snapshotDir,
    backupWarnings: warnings || []
  }, null, 2), 'utf-8');
}

function relaunchSoon() {
  setTimeout(function () {
    app.relaunch();
    app.exit(0);
  }, 1500);
}

async function resetAndRelaunch(kind) {
  kind = (kind === 'settings' || kind === 'data') ? kind : 'all';
  L.warn('Reset requested (kind=' + kind + ')');
  await shutdownApp('reset-' + kind);

  var snapshotRoot = path.join(app.getPath('documents'), 'Live Comment Hub reset backups');
  var snapshotDir = path.join(snapshotRoot, 'reset-' + kind + '-' + timestampForPath());
  var targets = resetTargetPaths(kind);
  var warnings = snapshotResetTargets(snapshotDir, targets);
  if (warnings.length) {
    L.warn('Reset backup completed with warnings:', JSON.stringify(warnings).slice(0, 1000));
  }
  writePendingResetMarker(kind, snapshotDir, warnings);
  relaunchSoon();

  return {
    ok: true,
    kind: kind,
    backupDir: snapshotDir,
    pendingReset: true,
    backupWarnings: warnings
  };
}

// 終了時 export 用ステート (close 抑制 + 進捗通知)
var shutdownExportInProgress = false;
var shutdownExportDone = false;
// shutdown export の stall 監視用 (= 進捗ベースの timeout)。
// registerExportProgressReporter の callback で更新する。 runShutdownExport は
// 直近 STALL_TIMEOUT_MS 進捗が無ければ timeout で打ち切る。 進捗中は無制限に待つ
// ことで、 数十万件の全件書き戻しでも完走できる。
var lastExportProgressAt = 0;

// 起動時自動 sync (= triggerStartupListenerSync) の進行状態。
// shutdown export は同時並行で SQLite を触ると competing して中途半端な状態になるので、
// startup sync が進行中なら shutdown export を skip する。
// 通常運用 (= ハブを長く開いて閉じる) では startup sync は数秒で終わるので影響なし。
// わんコメ DB が大きい (= 数百 MB) ケースで顕在化する設計エッジを防ぐ。
var startupSyncInProgress = false;
// startup sync 中に window close が要求された場合、 sync 完了を待ってから close を再試行
// するため deferred 状態を記録。 これがないと startup の import / export が途中で
// 切れてデータ破損 (例: わんコメ書き戻しの部分書き込み) を引き起こす可能性がある。
var pendingCloseDuringStartup = false;

function shouldRunShutdownExport() {
  if (isDemo) return false; // デモモードはわんコメへ書き戻さない
  if (!store.get('autoExportEnabled')) return false;
  var dir = store.get('onecommeDir');
  if (!dir || !fs.existsSync(dir)) return false;
  if (startupSyncInProgress) {
    L.info('Skip shutdown export: startup sync still in progress');
    return false;
  }
  return true;
}

async function runShutdownExport() {
  var dir = store.get('onecommeDir');
  L.info('Triggering shutdown export:', dir);
  // 進捗 stall 監視: 直近 STALL_TIMEOUT_MS 進捗が来なければ timeout で打ち切る。
  // 進捗 (= export-progress IPC) が継続している限り何分でも待つので、 数十万件の
  // 全件書き戻しでも完走可能。 Rust 側 stall / フリーズは 30 秒で検出 → 強制 close。
  var STALL_TIMEOUT_MS = 30000;
  lastExportProgressAt = Date.now();
  try {
    var resp = await new Promise(function (resolve, reject) {
      var settled = false;
      var stallTimer = setInterval(function () {
        if (settled) return;
        if (Date.now() - lastExportProgressAt > STALL_TIMEOUT_MS) {
          settled = true;
          clearInterval(stallTimer);
          reject(new Error('Shutdown export stalled (= no progress for ' + (STALL_TIMEOUT_MS / 1000) + 's)'));
        }
      }, 5000);
      coreBridge.exportToOnecomme(dir).then(function (r) {
        if (settled) return;
        settled = true;
        clearInterval(stallTimer);
        resolve(r);
      }).catch(function (e) {
        if (settled) return;
        settled = true;
        clearInterval(stallTimer);
        reject(e);
      });
    });
    if (resp && resp.aborted) {
      L.info('Shutdown export aborted:', JSON.stringify(resp.warnings || []).slice(0, 200));
    } else if (resp && resp.ok) {
      L.info('Shutdown export completed');
    } else {
      L.warn('Shutdown export result:', JSON.stringify(resp).slice(0, 200));
    }
  } catch (err) {
    L.warn('Shutdown export failed:', err && err.message ? err.message : err);
  }
}

function describeStaleInstanceState() {
  var details = [];
  if (chatWindow && !chatWindow.isDestroyed()) details.push('hidden chat window is still alive');
  if (manualWindow && !manualWindow.isDestroyed()) details.push('manual window is still alive');
  if (setupWindow && !setupWindow.isDestroyed()) details.push('setup window is still alive');
  if (loginWindow && !loginWindow.isDestroyed()) details.push('login window is still alive');
  if (reconnectTimer) details.push('reconnect timer is active');
  if (apiClientsInterval) details.push('api-clients timer is active');
  return details.length ? details.join(', ') : 'no remaining window was identified';
}

function sceneEntries(scenes) {
  if (Array.isArray(scenes)) {
    return scenes.map(function (scene, index) {
      return { id: scene && (scene.id || scene.name) ? (scene.id || scene.name) : String(index), scene: scene };
    });
  }
  return Object.keys(scenes || {}).map(function (sceneId) {
    return { id: sceneId, scene: scenes[sceneId] };
  });
}

function templateIdOf(template) {
  return template && (template.id || template.name || template.templateId || template.templateName) || '';
}

async function collectConfiguredTemplateFonts() {
  var fonts = Object.create(null);
  var templateNames = Object.create(null);
  var sceneResponse = await coreBridge.getScenes();
  var scenes = sceneResponse && sceneResponse.scenes ? sceneResponse.scenes : sceneResponse;
  var manifests = await coreBridge.getTemplateManifests() || {};
  var entries = sceneEntries(scenes || {});

  await Promise.all(entries.map(async function (entry) {
    var scene = entry.scene || {};
    var sceneId = entry.id || scene.id || '';
    if (!sceneId || scene.templatesEnabled === false) return;
    var data = await coreBridge.getSceneTemplates(sceneId);
    data = data || {};
    var availableMap = Object.create(null);
    (data.availableTemplates || []).forEach(function (template) {
      if (template && template.id) availableMap[template.id] = template;
    });
    var sceneTemplates = data.sceneTemplates || scene.templates || [];
    var enabledTemplates = sceneTemplates.filter(function (template) {
      return template && template.enabled !== false;
    });
    if (enabledTemplates.length === 0 && data.selectedTemplateId) {
      enabledTemplates = [{ id: data.selectedTemplateId }];
    }
    enabledTemplates.forEach(function (template) {
      var templateId = templateIdOf(template);
      if (!templateId) return;
      var manifest = manifests[templateId] || availableMap[templateId] || {};
      var manifestFonts = Array.isArray(manifest.fonts) ? manifest.fonts : [];
      if (manifestFonts.length === 0) return;
      manifestFonts.forEach(function (font) {
        if (font) fonts[font] = true;
      });
      templateNames[manifest.displayName || manifest.name || templateId] = true;
    });
  }));

  return {
    fonts: Object.keys(fonts),
    templateNames: Object.keys(templateNames)
  };
}

function ensureConfiguredTemplateFontsInBackground() {
  if (!coreBridge.isRunning()) return;
  collectConfiguredTemplateFonts()
    .then(function (target) {
      if (!target.fonts.length) {
        L.info('Configured template fonts: no downloadable fonts declared');
        return null;
      }
      L.info('Preparing configured template fonts:', target.fonts.join(', '), 'for', target.templateNames.join(', ') || 'configured templates');
      return coreBridge.ensureTemplateFonts(target.fonts, function (progress) {
        if (!progress) return;
        L.info('Template font download:', progress.current + '/' + progress.total, progress.family);
      });
    })
    .then(function (result) {
      if (!result) return;
      if (result.ok === false) {
        L.warn('Configured template font preparation failed:', JSON.stringify(result).slice(0, 500));
      } else {
        L.info('Configured template fonts are ready');
      }
    })
    .catch(function (err) {
      L.warn('Configured template font preparation failed:', err && err.message ? err.message : err);
    });
}

function createMainWindow() {
  var bounds = store.get('windowBounds') || {};
  if (typeof bounds.width !== 'number') bounds.width = 976;
  if (typeof bounds.height !== 'number') bounds.height = 1234;
  if (bounds.width < 500) bounds.width = 500;
  if (bounds.height < 400) bounds.height = 400;
  // ディスプレイ解像度より大きいと画面外に飛び出すので clamp する
  // (= 初期起動でデフォルト 1234px の Window が 1080p ディスプレイに収まらない問題対応)。
  // primary display の workArea を取って、 ウィンドウ枠 / タスクバーは引かない (= バッファとして
  // 余白を取って 95% に縮める = ユーザーが手動 resize しなくても見える範囲に収まる)。
  try {
    var primaryDisplay = require('electron').screen.getPrimaryDisplay();
    var workArea = primaryDisplay.workAreaSize;
    var maxW = Math.floor(workArea.width * 0.95);
    var maxH = Math.floor(workArea.height * 0.95);
    if (bounds.width > maxW) bounds.width = maxW;
    if (bounds.height > maxH) bounds.height = maxH;
  } catch (err) {
    L.warn('screen.getPrimaryDisplay failed (windowBounds clamp skipped): ' + (err && err.message ? err.message : err));
  }

  mainWindow = new BrowserWindow(applyWindowIconOption({
    width: bounds.width,
    height: bounds.height,
    minWidth: 500,
    minHeight: 400,
    title: 'Live Comment Hub',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }));

  L.info('Main window created');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', async function () {
    try {
      if (await onboardingPending()) {
        setTimeout(function () {
          openSetupWindow();
        }, 150);
      }
    } catch (err) {
      L.warn('onboarding auto-open check failed: ' + (err && err.message));
    }
  });

  // ウィンドウサイズ変更時に保存
  mainWindow.on('resize', function () {
    var size = mainWindow.getSize();
    store.set('windowBounds', { width: size[0], height: size[1] });
  });

  // 終了時 export を await してから close する (close 抑制 + 進捗通知)。
  // 完了 or タイムアウト 60 秒で必ず close を許可する。
  // 配信中に終了された場合は、先に切断して ConnectionState を Rust 側へ伝えてから
  // export を実行する。Rust 側の export_to_onecomme は connected=true の間は
  // aborted=true で中断する仕様で、それを回避する必要があるため。
  mainWindow.on('close', function (event) {
    if (shutdownExportDone) return;            // 既に完了 → 通常の close へ
    if (shutdownExportInProgress) {            // 実行中の追加 close 操作は無視
      event.preventDefault();
      return;
    }
    // 起動時自動 sync (= import + 初回 export) 中の close は、 sync 完了まで保留する
    // (= triggerStartupListenerSync の finally で mainWindow.close() を再呼出)。
    // 部分書き込み / pristine backup 中断 / DB スキーマハッシュ未保存などの
    // 破損リスクを避けるため。 ユーザーには shutdown export と同じモーダルで
    // 「書き戻し中、 完了まで待機」 を表示する。
    if (startupSyncInProgress) {
      event.preventDefault();
      if (!pendingCloseDuringStartup) {
        pendingCloseDuringStartup = true;
        L.info('Window close requested during startup sync, deferring until completion');
        if (mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.webContents.send('shutdown-export-progress', { phase: 'started' }); } catch (e) { L.debug('shutdown-export-progress send (started) failed (window destroyed?):', e && e.message ? e.message : e); }
        }
      }
      return;
    }
    if (!shouldRunShutdownExport()) {
      shutdownExportDone = true;
      return;
    }
    // ここまで同期判定 (= autoExport=on + onecommeDir 有効)。 dirty 判定は async なので、
    // close を一旦止めて async で問い合わせ → 結果に応じて即 close or shutdown export 実行。
    event.preventDefault();
    shutdownExportInProgress = true;
    setTimeout(async function () {
      var dirtyResp = await coreBridge.isListenerDbDirty().catch(function (err) {
        L.warn('isListenerDbDirty failed (treating as dirty=true): ' + (err && err.message ? err.message : err));
        return { ok: false, dirty: true };
      });
      if (!dirtyResp || !dirtyResp.dirty) {
        // データ変更なし → shutdown export 不要、 即終了
        L.info('Skip shutdown export: no pending data changes (listener_db not dirty)');
        shutdownExportInProgress = false;
        shutdownExportDone = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        return;
      }
      // dirty=true → モーダル表示 + 配信切断 + shutdown export
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('shutdown-export-progress', { phase: 'started' }); } catch (e) { L.debug('shutdown-export-progress send (started, dirty=true) failed (window destroyed?):', e && e.message ? e.message : e); }
      }
      if (currentVideoId) {
        try {
          disconnectChat();
        } catch (e) {
          L.warn('disconnect before shutdown export failed: ' + (e && e.message ? e.message : e));
        }
      }
      // ConnectionStateChanged が Rust 側に伝播するまで少し待つ (= fire-and-forget なので)。
      setTimeout(function () {
        runShutdownExport().finally(function () {
          shutdownExportInProgress = false;
          shutdownExportDone = true;
          if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('shutdown-export-progress', { phase: 'done' }); } catch (e) { L.debug('shutdown-export-progress send (done) failed (window destroyed?):', e && e.message ? e.message : e); }
            // モーダルが完了表示する余地を 200ms 与えてから閉じる
            setTimeout(function () {
              if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
            }, 200);
          }
        });
      }, 300);
    }, 0);
  });

  mainWindow.on('closed', function () {
    L.info('Main window closed');
    mainWindow = null;
    disconnectChat();
    if ((!chatWindow || chatWindow.isDestroyed()) &&
        (!manualWindow || manualWindow.isDestroyed()) &&
        (!setupWindow || setupWindow.isDestroyed()) &&
        (!loginWindow || loginWindow.isDestroyed())) {
      shutdownApp('main-window-closed').then(function () {
        app.quit();
      }).catch(function (err) {
        L.error('Shutdown after main window close failed:', err && err.message ? err.message : err);
        app.quit();
      });
    }
  });
}

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  var parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  var setupBounds = { width: 860, height: 620 };
  if (parentWindow) {
    var parentBounds = parentWindow.getBounds();
    var display = screen.getDisplayMatching(parentBounds);
    var workArea = display.workArea;
    setupBounds.x = parentBounds.x + Math.round((parentBounds.width - setupBounds.width) / 2);
    setupBounds.y = parentBounds.y + Math.round((parentBounds.height - setupBounds.height) / 2);
    setupBounds.x = Math.max(workArea.x, Math.min(setupBounds.x, workArea.x + workArea.width - setupBounds.width));
    setupBounds.y = Math.max(workArea.y, Math.min(setupBounds.y, workArea.y + workArea.height - setupBounds.height));
  }
  setupWindow = new BrowserWindow(applyWindowIconOption({
    width: setupBounds.width,
    height: setupBounds.height,
    x: setupBounds.x,
    y: setupBounds.y,
    minWidth: 800,
    minHeight: 480,
    title: 'Live Comment Hub - 配信準備',
    autoHideMenuBar: true,
    parent: parentWindow,
    modal: !!parentWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }));
  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWindow.on('closed', function () {
    setupWindow = null;
    // オンボーディングを進めた / 完了した可能性があるため、メイン側に「準備」ボタンの再評価を促す。
    sendToRenderer('onboarding-entry-refresh');
  });
}

// YouTube ライブチャットの接続状態。後から開いた window が pull で初期同期できるよう、
// sendToRenderer('status', ...) のたびにここに最新値をミラーする。
var currentChatStatus = { connected: false, message: '未接続' };

function sendToRenderer(channel, data) {
  if (channel === 'status' && data && typeof data === 'object') {
    currentChatStatus = data;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send(channel, data);
  }
  // ponoutWindow も同じ broadcast 経路で受ける (主に port / core-ready で接続状態を判定)。
  // listen していないチャンネルは renderer 側で黙って捨てられるので、余分な購読は出ない。
  if (ponoutWindow && !ponoutWindow.isDestroyed()) {
    ponoutWindow.webContents.send(channel, data);
  }
}

ipcMain.handle('get-chat-status', function () {
  return currentChatStatus;
});

// === Core (Rust) 接続状態 ===
// 真の正本は Rust core プロセス。core-bridge.js が JS 側ミラー (running / port) を保持する。
// 各 renderer は「初期 pull (getCoreStatus IPC)」+「変化 push (core-status broadcast)」の
// 二系統で同期する。
function getCoreStatus() {
  return {
    running: !!coreBridge.isRunning(),
    port: Number(coreBridge.getPort()) || 0
  };
}

function broadcastCoreStatus() {
  sendToRenderer('core-status', getCoreStatus());
}

ipcMain.handle('get-core-status', function () {
  return getCoreStatus();
});

// scene / performance を変更した IPC ハンドラはこの関数で全 renderer に broadcast する。
// 各 renderer は受信したら自前で getScenes() / getSelectedScene() で pull し直す。
// payload.kind は consumer がフィルタしたい時用 ('selection' / 'scene-saved' / etc)。
function broadcastScenesChanged(payload) {
  var data = payload || {};
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scenes-changed', data);
  }
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('scenes-changed', data);
  }
  if (ponoutWindow && !ponoutWindow.isDestroyed()) {
    ponoutWindow.webContents.send('scenes-changed', data);
  }
}

// スクレイパースクリプトを読み込む
var scraperCode = fs.readFileSync(
  path.join(__dirname, 'chat-scraper.js'),
  'utf-8'
);

function checkYouTubeLogin(callback) {
  var { session } = require('electron');
  var ses = session.fromPartition('persist:youtube');
  ses.cookies.get({ url: 'https://www.youtube.com' }).then(function (cookies) {
    var loggedIn = cookies.some(function (c) {
      return c.name === 'SID' || c.name === 'SSID' || c.name === 'APISID';
    });
    callback(loggedIn);
  }).catch(function () {
    callback(false);
  });
}

function recheckLoginWarning() {
  checkYouTubeLogin(function (loggedIn) {
    if (!loggedIn) {
      coreBridge.hasReactionTrigger().then(function (hasReactionTrigger) {
        sendToRenderer('login-warning', !!hasReactionTrigger);
      }).catch(function () {
        sendToRenderer('login-warning', false);
      });
    } else {
      sendToRenderer('login-warning', false);
    }
  });
}

function enqueueCommentBatch(comments) {
  try {
    var receivedAtMs = Date.now();
    if (Array.isArray(comments)) {
      var batchSize = comments.length;
      comments.forEach(function (comment, index) {
        if (!comment || typeof comment !== 'object') return;
        if (!comment._komehubTrace || typeof comment._komehubTrace !== 'object') {
          comment._komehubTrace = {};
        }
        comment._komehubTrace.mainReceivedAtMs = receivedAtMs;
        comment._komehubTrace.mainBatchSize = batchSize;
        comment._komehubTrace.mainBatchIndex = index;
      });
    }
    coreBridge.pushComments(comments);
  } catch (error) {
    L.error('Failed to push comments:', error && error.message ? error.message : error);
  }
}

/**
 * 単一 video の watch ページを net.request で fetch して owner / タイトル / チャンネル名を
 * 抽出して返す Promise 版。 Cookie / cache は electron net モジュールが OS シェアと共有する。
 *
 * Rust core の `resolve_unknown_owners_blocking` から呼ばれる resolver の中で並列実行される。
 * 取得失敗時 (= fetch error / status >= 400 / channelId 抽出失敗) は null を resolve する
 * (= reject せず、 呼び出し側が `filter(m => m)` で除外する想定)。
 */
function fetchVideoMeta(videoId) {
  return new Promise(function (resolve) {
    if (!videoId) return resolve(null);
    var watchUrl = buildWatchUrl(videoId);
    var net = require('electron').net;
    var req = net.request({ method: 'GET', url: watchUrl, redirect: 'follow' });
    var chunks = [];
    req.on('response', function (response) {
      if (response.statusCode >= 400) {
        L.warn('fetchVideoMeta: status=' + response.statusCode + ' videoId=' + videoId);
        return resolve(null);
      }
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () {
        try {
          var html = Buffer.concat(chunks).toString('utf-8');
          // ytInitialPlayerResponse > videoDetails 内の各 field を非貪欲マッチで抽出
          var ownerMatch = html.match(/"videoDetails":\{[\s\S]*?"channelId":"(UC[\w-]+)"/);
          if (!ownerMatch) {
            // フォールバック: HTML 中の最初の "channelId":"UC..."
            ownerMatch = html.match(/"channelId":"(UC[\w-]+)"/);
          }
          if (!ownerMatch || !ownerMatch[1]) {
            L.warn('fetchVideoMeta: no channelId for ' + videoId);
            return resolve(null);
          }
          var titleMatch = html.match(/"videoDetails":\{[\s\S]*?"title":"((?:[^"\\]|\\.)+)"/);
          var channelNameMatch = html.match(/"videoDetails":\{[\s\S]*?"author":"((?:[^"\\]|\\.)+)"/);
          resolve({
            videoId: videoId,
            ownerChannelId: ownerMatch[1],
            title: titleMatch ? unescapeYoutubeJsonString(titleMatch[1]) : null,
            channelName: channelNameMatch ? unescapeYoutubeJsonString(channelNameMatch[1]) : null,
          });
        } catch (err) {
          L.warn('fetchVideoMeta parse failed for ' + videoId + ': ' + (err && err.message ? err.message : err));
          resolve(null);
        }
      });
    });
    req.on('error', function (err) {
      L.warn('fetchVideoMeta request failed for ' + videoId + ': ' + (err && err.message ? err.message : err));
      resolve(null);
    });
    req.end();
  });
}

/**
 * Rust core の `register_video_owner_resolver` に渡す resolver 実装。
 * `import_from_onecomme` 中に streams 未登録の video_id 群が渡されてくる。
 *
 * 並列度 5 でワーカープールを組んで `fetchVideoMeta` を回し、 解決できたメタだけ返す。
 * (= 解決失敗は returns で除外、 Rust 側は「該当 video は streams に登録されず既存 filter で弾かれる」 既存挙動を維持)
 *
 * Cookie / cache 共有 (= electron net) なので、 メンバー限定 / ログイン必要動画も
 * ハブにログイン済セッションがあれば取得可能。
 */
// 注: napi ThreadsafeFunction の CalleeHandled=true (デフォルト) 動作で、 第 1 引数は Node.js
// error-first 規約の err (Rust 側が Ok を渡せば null)、 第 2 引数以降が実データ。
// subscribeRuntimeEvents も同じパターン: `function(err, eventJson) {...}`
async function resolveVideoOwnersForImport(err, videoIds) {
  if (err) {
    L.warn('resolveVideoOwnersForImport: received error from core: ' + err);
    return [];
  }
  if (!Array.isArray(videoIds) || videoIds.length === 0) {
    L.warn('resolveVideoOwnersForImport: videoIds is not non-empty array, returning [] (type='
      + (Array.isArray(videoIds) ? 'array' : typeof videoIds) + ')');
    return [];
  }
  L.info('resolveVideoOwnersForImport: ' + videoIds.length + ' unknown video ids: '
    + JSON.stringify(videoIds.slice(0, 3)) + (videoIds.length > 3 ? '...' : ''));
  var CONCURRENCY = 5;
  var results = [];
  var cursor = 0;
  async function worker() {
    while (cursor < videoIds.length) {
      var i = cursor++;
      try {
        var meta = await fetchVideoMeta(videoIds[i]);
        if (meta) results.push(meta);
      } catch (err) {
        L.warn('worker fetch threw for ' + videoIds[i] + ': ' + (err && err.message ? err.message : err));
      }
    }
  }
  var workers = [];
  for (var w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  L.info('resolveVideoOwnersForImport: resolved ' + results.length + ' / ' + videoIds.length);
  return results;
}

// PT-1b: 配信の owner channel id (UC...) を watch ページから抽出して core に通知する。
// ytInitialPlayerResponse 内の videoDetails.channelId、または ytInitialData の
// "channelId":"UC..." 文字列マッチで取得する。Step 3 リスナー管理の自チャンネル判定用。
function resolveAndAnnounceStreamOwner(videoId) {
  if (!videoId) return;
  L.info('resolveAndAnnounceStreamOwner: starting for video=' + videoId);
  var watchUrl = buildWatchUrl(videoId);
  // electron の net モジュールを使う (Cookie / cache / proxy が consistent)
  var net = require('electron').net;
  var req = net.request({ method: 'GET', url: watchUrl, redirect: 'follow' });
  var chunks = [];
  req.on('response', function (response) {
    if (response.statusCode >= 400) {
      L.warn('Failed to fetch watch page (status=' + response.statusCode + ', videoId=' + videoId + ')');
      return;
    }
    response.on('data', function (chunk) { chunks.push(chunk); });
    response.on('end', function () {
      try {
        var html = Buffer.concat(chunks).toString('utf-8');
        // ytInitialPlayerResponse 内の videoDetails.channelId が最も信頼できる位置
        // (videoDetails JSON は長いので [\s\S]*? で非貪欲マッチ)
        var match = html.match(/"videoDetails":\{[\s\S]*?"channelId":"(UC[\w-]+)"/);
        if (!match) {
          // フォールバック: 単純な "channelId":"UC..." パターン (最初の一致)
          // YouTube ページ HTML では最初に出現する channelId は配信主の場合が多い
          match = html.match(/"channelId":"(UC[\w-]+)"/);
        }
        if (match && match[1]) {
          var ownerChannelId = match[1];
          L.info('Resolved stream owner channel id: ' + ownerChannelId + ' (videoId=' + videoId + ')');
          if (coreBridge.isRunning()) {
            try { coreBridge.announceStreamOwner(videoId, ownerChannelId); }
            catch (err) { L.warn('announceStreamOwner failed: ' + (err && err.message ? err.message : err)); }
          }
        } else {
          L.warn('Could not extract channelId from watch page (videoId=' + videoId + ')');
        }
      } catch (err) {
        L.warn('resolveAndAnnounceStreamOwner parse failed: ' + (err && err.message ? err.message : err));
      }
    });
  });
  req.on('error', function (err) {
    L.warn('resolveAndAnnounceStreamOwner request failed: ' + (err && err.message ? err.message : err));
  });
  req.end();
}

// YouTube チャンネル情報解決 (双方向)。
// 入力が `@handle` なら handle ページを、`UC...` なら channel ページを fetch して、
// 同じパターンで `channelId` (UC...) と `vanityChannelUrl` (@handle) を抽出する。
// 戻り値: { ok, channelId?, handle?, error? }。
// gzip 自動 + Cookie 共有 (electron net)。
/**
 * YouTube チャンネルページ HTML から channelId / handle / name / thumbnailUrl を抽出する。
 * (= resolveYoutubeChannelInfo + getCurrentYoutubeChannel 共通の HTML パーサ)
 */
function parseYoutubeChannelPage(html) {
  var idMatch = html.match(/"externalId":"(UC[A-Za-z0-9_-]+)"/)
    || html.match(/"channelId":"(UC[A-Za-z0-9_-]+)"/);
  var handleMatch = html.match(/"vanityChannelUrl":"http[s]?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/@([A-Za-z0-9._-]+)"/)
    || html.match(/"canonicalChannelUrl":"http[s]?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/@([A-Za-z0-9._-]+)"/);
  // チャンネル表示名: c4TabbedHeaderRenderer.title 直下の simpleText / "title":"..." を順に試す
  var nameMatch = html.match(/"c4TabbedHeaderRenderer":\{[^}]*?"title":"((?:[^"\\]|\\.)+)"/)
    || html.match(/"pageHeaderRenderer":\{[^}]*?"pageTitle":"((?:[^"\\]|\\.)+)"/)
    || html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  // アバター URL: avatar.thumbnails 配列の最大解像度 (= 通常 176x176 以上)
  // 例: "avatar":{"thumbnails":[{"url":"https://yt3.googleusercontent.com/.../no-nd/s48-c-k-c0x00ffffff-no-rj","width":48,"height":48}, ...]}
  var thumbMatch = html.match(/"avatar":\{[^}]*?"thumbnails":\[\{"url":"([^"]+)"/)
    || html.match(/<link\s+rel="image_src"\s+href="([^"]+)"/i)
    || html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return {
    channelId: idMatch ? idMatch[1] : null,
    handle: handleMatch ? handleMatch[1] : null,
    name: nameMatch ? unescapeYoutubeJsonString(nameMatch[1]) : null,
    thumbnailUrl: thumbMatch ? thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null
  };
}

/**
 * YouTube 内蔵 JSON 文字列のエスケープ復元。`\"` `\\` `\u00xx` 程度を解く。
 * 完全な JSON.parse は単一文字列だけでは難しいので簡易対応。
 */
function unescapeYoutubeJsonString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    })
    .replace(/\\\\/g, '\\');
}

/**
 * persist:youtube セッション (= ログイン中の cookie) で youtube.com を fetch し、
 * 現在ログインしているアカウントの自チャンネル情報を返す。
 * 未ログイン / 取得失敗時は { ok: false, reason } を返す。
 *
 * 仕組み: youtube.com top page を session cookies 付きで取得すると、
 * page header の avatar / vanityChannelUrl 等にユーザ自身のチャンネル情報が
 * 埋め込まれる。これを parseYoutubeChannelPage で抽出する。
 */
// /feed/you はログイン中ユーザの「あなた」ページ。 HTML から自分の channel ID を抽出する。
// 2026-05-14 確認: YouTube はもう redirect ではなく 200 で HTML を返す。
function fetchUserChannelViaFeedYou(ses, net) {
  return new Promise(function (resolve) {
    var req = net.request({
      method: 'GET',
      url: 'https://www.youtube.com/feed/you',
      session: ses,
      useSessionCookies: true,
      redirect: 'follow'
    });
    var chunks = [];
    req.on('response', function (response) {
      if (response.statusCode >= 400) {
        resolve({ reason: 'feed_you_status_' + response.statusCode });
        return;
      }
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () {
        try {
          var html = Buffer.concat(chunks).toString('utf-8');
          // /feed/you 内の pageHeaderRenderer (= 自分のチャンネルバナー) から抽出。
          // 2026-05-14 確認の構造:
          //   "pageHeaderRenderer":{"pageTitle":"","content":{"pageHeaderViewModel":{
          //     "title":{"dynamicTextViewModel":{"text":{"content":"<NAME>"}, ...
          //       ...."browseEndpoint":{"browseId":"UC..."}},
          //     "image":{"decoratedAvatarViewModel":{"avatar":{"avatarViewModel":
          //       {"image":{"sources":[{"url":"https://yt3.ggpht.com/...",...}]}}}}},
          //     "metadata":{"contentMetadataViewModel":{"metadataParts":[
          //       {"text":{"content":"@<HANDLE>"}}, ...]}}}}
          var channelId = null;
          var handle = null;
          var name = null;
          var thumbnailUrl = null;
          var m;
          // pageHeaderViewModel ブロック (= 先頭の自分セクション、 約 2000 文字以内)
          var headerBlock = null;
          m = html.match(/"pageHeaderRenderer":\{[^]{0,5000}/);
          if (m) headerBlock = m[0];
          if (headerBlock) {
            // channelId: pageHeaderViewModel 内の最初の "browseId":"UC..."
            m = headerBlock.match(/"pageHeaderViewModel":\{[^]{0,3000}?"browseId":"(UC[A-Za-z0-9_-]+)"/);
            if (m) channelId = m[1];
            // name: dynamicTextViewModel.text.content
            m = headerBlock.match(/"dynamicTextViewModel":\{"text":\{"content":"((?:[^"\\]|\\.)+)"/);
            if (m) name = unescapeYoutubeJsonString(m[1]);
            // handle: metadataParts の "@xxx"
            m = headerBlock.match(/"metadataParts":\[\{"text":\{"content":"@([A-Za-z0-9._-]+)"/);
            if (m) handle = m[1];
            // avatar (= 一番大きい源を取りたいので "sources":\[\{...\},...\] の最後寄り)
            // 簡略化: 最初の sources[0] を取る (= s72 や s120)。 サムネは sNN を sNN にリサイズ可
            m = headerBlock.match(/"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)"/);
            if (m) thumbnailUrl = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          }
          if (channelId || handle || name) {
            resolve({ channelId: channelId, handle: handle, name: name, thumbnailUrl: thumbnailUrl });
          } else {
            try {
              var dumpPath = path.join(app.getPath('userData'), 'logs', 'yt-feed-you-dump.html');
              fs.writeFileSync(dumpPath, html, 'utf-8');
              L.warn('fetchUserChannelViaFeedYou: parse miss, HTML dumped to ' + dumpPath);
            } catch (e) { /* swallow */ }
            resolve({ reason: 'feed_you_html_parse_miss' });
          }
        } catch (e) {
          resolve({ reason: 'feed_you_parse_error: ' + e.message });
        }
      });
    });
    req.on('error', function (err) {
      resolve({ reason: 'feed_you_error: ' + (err && err.message || err) });
    });
    req.end();
  });
}

function getCurrentYoutubeChannel() {
  return new Promise(function (resolve) {
    var electron = require('electron');
    var ses = electron.session.fromPartition('persist:youtube');
    var net = electron.net;
    var req = net.request({
      method: 'GET',
      url: 'https://www.youtube.com/',
      session: ses,
      useSessionCookies: true,
      redirect: 'follow'
    });
    var chunks = [];
    req.on('response', function (response) {
      if (response.statusCode >= 400) {
        resolve({ ok: false, reason: 'http ' + response.statusCode });
        return;
      }
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () {
        try {
          var html = Buffer.concat(chunks).toString('utf-8');
          // 未ログインだと "loggedIn":false / "LOGGED_IN":false が含まれる
          if (/"LOGGED_IN":\s*false/.test(html) || /"loggedIn":\s*false/.test(html)) {
            resolve({ ok: false, reason: 'not_logged_in' });
            return;
          }
          // 現在ログイン中ユーザの channel info を抽出するため、より絞ったパターンで取る:
          // youtube top page には "URL_BUILDER_PARAMS" 系や "delegated_session_info" 等が
          // 含まれるが、最も信頼できるのは header の topbarMenuButtonRenderer / accountItem 内の
          // ownerExternalChannelId / channelHandle。これらが無い場合は parseYoutubeChannelPage
          // の汎用抽出にフォールバック (= 通常 top page にも自チャンネル情報が埋まっている)。
          var ownerIdMatch = html.match(/"ownerExternalChannelId":"(UC[A-Za-z0-9_-]+)"/);
          var ownerHandleMatch = html.match(/"channelHandle":"@?([A-Za-z0-9._-]+)"/);
          var channelId = ownerIdMatch ? ownerIdMatch[1] : null;
          var handle = ownerHandleMatch ? ownerHandleMatch[1] : null;
          if (!channelId) {
            // フォールバック: 汎用パーサで先頭の UC を拾う
            var parsed = parseYoutubeChannelPage(html);
            channelId = parsed.channelId;
            if (!handle) handle = parsed.handle;
          }
          if (!channelId) {
            // ホームページから抽出できない (= YouTube 仕様変更で自分の channel ID が
            // home HTML から消えた、 2026-05-14)。 /feed/you の pageHeaderRenderer から取得する。
            L.info('getCurrentYoutubeChannel: home parse miss, trying /feed/you');
            fetchUserChannelViaFeedYou(ses, net).then(function (fallback) {
              if (fallback && (fallback.channelId || fallback.handle)) {
                // /feed/you の HTML から name + avatar も同時に取れているので、 そのまま返す。
                // (= もし名前 / avatar が欠けていれば resolveYoutubeChannelInfo にフォールバック)
                if (fallback.channelId && fallback.name && fallback.thumbnailUrl) {
                  resolve({
                    ok: true,
                    channelId: fallback.channelId,
                    handle: fallback.handle || null,
                    name: fallback.name,
                    thumbnailUrl: fallback.thumbnailUrl
                  });
                  return;
                }
                resolveYoutubeChannelInfo(fallback.handle ? '@' + fallback.handle : fallback.channelId)
                  .then(function (detail) {
                    if (detail && detail.ok) {
                      resolve({
                        ok: true,
                        channelId: detail.channelId || fallback.channelId,
                        handle: detail.handle || fallback.handle,
                        name: detail.name || fallback.name || null,
                        thumbnailUrl: detail.thumbnailUrl || fallback.thumbnailUrl || null
                      });
                    } else {
                      resolve({
                        ok: true,
                        channelId: fallback.channelId,
                        handle: fallback.handle,
                        name: fallback.name || null,
                        thumbnailUrl: fallback.thumbnailUrl || null
                      });
                    }
                  });
              } else {
                resolve({ ok: false, reason: (fallback && fallback.reason) || 'channel_not_found_in_page' });
              }
            });
            return;
          }
          // 詳細情報 (name + thumbnail) は固有のチャンネルページから取り直す方が確実。
          // top page の avatar はちらつき + 別チャンネル (= subscriptions) と混ざりがちなので。
          resolveYoutubeChannelInfo(handle ? '@' + handle : channelId).then(function (detail) {
            if (detail && detail.ok) {
              resolve({
                ok: true,
                channelId: detail.channelId || channelId,
                handle: detail.handle || handle,
                name: detail.name,
                thumbnailUrl: detail.thumbnailUrl
              });
            } else {
              // チャンネルページ取得失敗でも channelId は返せる
              resolve({ ok: true, channelId: channelId, handle: handle, name: null, thumbnailUrl: null });
            }
          });
        } catch (err) {
          resolve({ ok: false, reason: 'parse_error: ' + (err && err.message ? err.message : err) });
        }
      });
    });
    req.on('error', function (err) {
      resolve({ ok: false, reason: 'request_failed: ' + (err && err.message ? err.message : err) });
    });
    req.end();
  });
}

function resolveYoutubeChannelInfo(input) {
  return new Promise(function (resolve) {
    if (!input || typeof input !== 'string') {
      resolve({ ok: false, error: 'empty input' });
      return;
    }
    var raw = input.trim();
    if (raw.length === 0) {
      resolve({ ok: false, error: 'empty input' });
      return;
    }
    var url;
    if (/^UC[A-Za-z0-9_-]+$/.test(raw)) {
      url = 'https://www.youtube.com/channel/' + raw;
    } else {
      var handle = raw.charAt(0) === '@' ? raw.substring(1) : raw;
      if (!/^[A-Za-z0-9._-]+$/.test(handle)) {
        resolve({ ok: false, error: 'invalid handle/id format' });
        return;
      }
      url = 'https://www.youtube.com/@' + encodeURIComponent(handle);
    }
    var net = require('electron').net;
    var req = net.request({ method: 'GET', url: url, redirect: 'follow' });
    var chunks = [];
    req.on('response', function (response) {
      if (response.statusCode === 404) {
        resolve({ ok: false, error: 'channel not found' });
        return;
      }
      if (response.statusCode >= 400) {
        resolve({ ok: false, error: 'http ' + response.statusCode });
        return;
      }
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () {
        try {
          var html = Buffer.concat(chunks).toString('utf-8');
          var parsed = parseYoutubeChannelPage(html);
          if (parsed.channelId) {
            resolve({
              ok: true,
              channelId: parsed.channelId,
              handle: parsed.handle,
              name: parsed.name,
              thumbnailUrl: parsed.thumbnailUrl
            });
          } else {
            resolve({ ok: false, error: 'channelId not found in page' });
          }
        } catch (err) {
          resolve({ ok: false, error: 'parse error: ' + (err && err.message ? err.message : err) });
        }
      });
    });
    req.on('error', function (err) {
      resolve({ ok: false, error: 'request failed: ' + (err && err.message ? err.message : err) });
    });
    req.end();
  });
}

// 配信メタデータ (タイトル / チャンネル名 / 同時接続数 等) の取得・更新。
// Phase 2: HTTP fetch + JSON 抽出 (BrowserWindow なし)。Accept-Encoding: gzip で
// 約 124KB に圧縮、Electron net が自動 decompress する。
//
// 静的フィールド (タイトル等) は接続時 1 回、動的フィールド (同時接続/いいね/登録者数)
// は STREAM_METADATA_POLL_INTERVAL_MS 間隔で再取得する。
var STREAM_METADATA_POLL_INTERVAL_MS = 30 * 1000;
var PEAK_VIEWERS_WINDOW_MS = 5 * 60 * 1000; // 5 分以上維持された値を peak として記録
var streamMetadataPollHandle = null;
// 配信ごとの polling 状態 (現在見てる配信のみ保持)
var streamMetadataState = null;

function startStreamMetadataPolling(videoId) {
  stopStreamMetadataPolling();
  if (!videoId) return;
  if (isDemo) return; // デモは実 YouTube を scrape しない (= startDemo が demo メタを push)
  streamMetadataState = {
    videoId: videoId,
    initialFetched: false,
    viewerSamples: [], // [{at: ms, viewers: n}, ...] (5 分維持ピーク計算用)
    peakSustained: 0,  // 「5 分以上維持できた最大」のローカル候補
    // 初回 fetch で取得した静的フィールド (= title / icon 等) を merge 用に保持。
    // 動的 poll では meta に含まれないので、毎回これを混ぜて updateStreamMetadata を
    // 呼ぶ。理由: 自チャンネル設定追加で他枠 ephemeral → 自枠 persisted 経路に切り替わ
    // った瞬間、空 stub INSERT + COALESCE(None, '') で静的フィールドが空のまま固定
    // されてしまう問題への対策。
    cachedStatic: {}
  };
  // 接続直後は即時 1 回、以降は定期間隔
  fetchAndUpdateStreamMetadata(videoId, true);
  streamMetadataPollHandle = setInterval(function () {
    fetchAndUpdateStreamMetadata(videoId, false);
  }, STREAM_METADATA_POLL_INTERVAL_MS);
}

function stopStreamMetadataPolling() {
  if (streamMetadataPollHandle) {
    clearInterval(streamMetadataPollHandle);
    streamMetadataPollHandle = null;
  }
  streamMetadataState = null;
}

// 5 分以上維持できた最大 viewers を計算する。
// 直近 5 分間のサンプル window 内の最小値 = 「window 期間中に常に >= だった値」
// → これが「5 分以上維持できた値」のうち最大の候補。既存 peak と max を取る。
// 戻り値: 更新された peak 値、または null (まだ window が 5 分に満たない)。
function recordViewerSampleAndComputePeak(viewers) {
  if (!streamMetadataState || typeof viewers !== 'number' || viewers < 0) return null;
  var now = Date.now();
  var samples = streamMetadataState.viewerSamples;
  samples.push({ at: now, viewers: viewers });
  // 5 分前以前のサンプルを削除
  var cutoff = now - PEAK_VIEWERS_WINDOW_MS;
  while (samples.length > 0 && samples[0].at < cutoff) {
    samples.shift();
  }
  // window が 5 分以上の期間をカバーしているかは「最古サンプルが cutoff 直前」で判定。
  // shift 後に最古サンプルが残っていて、その at <= cutoff + サンプリング間隔 程度なら OK
  if (samples.length < 2) return null;
  var span = samples[samples.length - 1].at - samples[0].at;
  if (span < PEAK_VIEWERS_WINDOW_MS - STREAM_METADATA_POLL_INTERVAL_MS) {
    // 5 分にまだ満たない (許容: poll 1 回分のずれ)
    return null;
  }
  var minInWindow = Infinity;
  for (var i = 0; i < samples.length; i++) {
    if (samples[i].viewers < minInWindow) minInWindow = samples[i].viewers;
  }
  if (minInWindow > streamMetadataState.peakSustained) {
    streamMetadataState.peakSustained = minInWindow;
  }
  return streamMetadataState.peakSustained;
}

function fetchAndUpdateStreamMetadata(videoId, isInitial) {
  if (!videoId || !coreBridge.isRunning()) return;
  var watchUrl = buildWatchUrl(videoId);
  var net = require('electron').net;
  // gzip で取得 (電子 net はデフォルトで Accept-Encoding 設定 + 自動 decompress)
  var req = net.request({ method: 'GET', url: watchUrl, redirect: 'follow' });
  var chunks = [];
  req.on('response', function (response) {
    if (response.statusCode >= 400) {
      L.warn('Failed to fetch stream metadata (status=' + response.statusCode + ', videoId=' + videoId + ')');
      return;
    }
    response.on('data', function (chunk) { chunks.push(chunk); });
    response.on('end', function () {
      // 切断後に到着した in-flight レスポンスは破棄する。
      // (clearInterval は次の polling を止めるだけで、進行中の fetch は止めない)
      if (!streamMetadataState || streamMetadataState.videoId !== videoId) {
        return;
      }
      try {
        var html = Buffer.concat(chunks).toString('utf-8');
        // ライブ backfill: 初回 fetch で title 等の静的フィールドが取れなかった場合、取れるまで
        // 動的 poll でも静的フィールドを抽出し直す (= 初回失敗の後追い回復)。取得済みなら従来通り
        // 動的のみ (= 余計な再抽出を避ける)。HTTP は同じ poll fetch を流用するので追加リクエスト無し。
        var needStaticBackfill = !(streamMetadataState.cachedStatic && streamMetadataState.cachedStatic.title);
        var meta = parseStreamMetadataFromHtml(html, videoId, isInitial || needStaticBackfill);
        if (!meta) return;
        // 5 分維持ピーク計算 (currentViewers が取れた場合のみ)
        if (typeof meta.currentViewers === 'number') {
          var peak = recordViewerSampleAndComputePeak(meta.currentViewers);
          if (peak !== null) {
            meta.peakConcurrentViewers = peak;
          }
        }
        // 静的フィールドを cache し、動的 poll でも merge して送る。
        // これで自チャンネル設定追加で「他枠 ephemeral → 自枠 persisted」経路切替時にも
        // 空 stub のまま固定されない (= ModelQueue は COALESCE で更新するので
        // None でなく実値が渡れば正しく persist される)
        var staticKeys = ['title', 'description', 'channelName', 'channelIconUrl',
          'ownerChannelId', 'streamUrl', 'subscriberCount', 'startedAt'];
        if (streamMetadataState && streamMetadataState.cachedStatic) {
          staticKeys.forEach(function (k) {
            if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') {
              streamMetadataState.cachedStatic[k] = meta[k];
            }
          });
          // 動的 poll に cache を merge (= meta が新値を持っていれば優先、無ければ cache 値)
          var merged = Object.assign({}, streamMetadataState.cachedStatic, meta);
          coreBridge.updateStreamMetadata(videoId, merged).catch(function (err) {
            L.warn('updateStreamMetadata IPC failed: ' + (err && err.message ? err.message : err));
          });
        } else {
          coreBridge.updateStreamMetadata(videoId, meta).catch(function (err) {
            L.warn('updateStreamMetadata IPC failed: ' + (err && err.message ? err.message : err));
          });
        }
        // 他枠も含めて UI 表示は ModelQueue 側で SSE 通知される
        // (= 自枠は listeners.db 書き込み後の SSE、他枠は ephemeral SSE)
        if (isInitial && streamMetadataState) {
          streamMetadataState.initialFetched = true;
        }
      } catch (err) {
        L.warn('parseStreamMetadataFromHtml failed: ' + (err && err.message ? err.message : err));
      }
    });
  });
  req.on('error', function (err) {
    L.warn('fetchStreamMetadata request failed: ' + (err && err.message ? err.message : err));
  });
  req.end();
}

// HTML から ytInitialPlayerResponse / ytInitialData を切り出して必要フィールドを抽出。
// 静的・動的の両方を 1 度に取り、isInitial=false なら静的フィールドは null で返して
// Rust 側で「触らない」扱いにする。
// ytInitialPlayerResponse の JSON 全体を brace counting で正確に切り出す。
// 正規表現の `[\s\S]*?\});\s*var meta` は JSON 内部に同パターンが偶然出現すると
// 途中で停止し videoDetails まで届かない (実例: N9SiV3V5iQU で 3772 chars stop、
// JSON.parse は valid だが title/author/channelId が全部 undefined)。
function extractJsonObject(html, marker) {
  var idx = html.indexOf(marker);
  if (idx === -1) return null;
  var start = idx + marker.length;
  // marker 直後の最初の '{' まで空白等をスキップ
  while (start < html.length && html[start] !== '{') start++;
  if (html[start] !== '{') return null;
  var depth = 0;
  var inStr = false;
  var esc = false;
  for (var i = start; i < html.length; i++) {
    var ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return html.substring(start, i + 1);
      }
    }
  }
  return null;
}

function parseStreamMetadataFromHtml(html, videoId, isInitial) {
  var meta = {};
  // ytInitialPlayerResponse: タイトル / 概要 / 開始時刻 / チャンネル名
  // partial poll でも parse する (= 初回 fetch で何らかの理由で取れなかった場合の
  // 復旧経路。動的フィールドと一緒に毎回 parse → cachedStatic に積み直しても
  // 副作用ゼロ、coreBridge.updateStreamMetadata の merge で送られる)
  var prJson = extractJsonObject(html, 'var ytInitialPlayerResponse =');
  if (prJson) {
    try {
      var pr = JSON.parse(prJson);
      var vd = pr.videoDetails || {};
      var mb = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
      if (vd.title) meta.title = vd.title;
      if (vd.shortDescription) meta.description = vd.shortDescription;
      if (vd.author) meta.channelName = vd.author;
      if (vd.channelId) meta.ownerChannelId = vd.channelId;
      meta.streamUrl = buildWatchUrl(videoId);
      var bd = mb.liveBroadcastDetails;
      if (bd && bd.startTimestamp) {
        var ts = Date.parse(bd.startTimestamp);
        if (!isNaN(ts)) meta.startedAt = ts;
      }
      // 配信終了検知 (リアルタイム値なので isInitial に関係なく毎回チェック)
      // microformat.liveBroadcastDetails.isLiveNow が false → 配信終了
      // endTimestamp があればそれを、無ければ now を ended_at として記録
      //
      // 注意: isLiveNow=false は 2 通りの意味がある:
      //   (A) 配信予定 (= まだ live になっていない、未来時刻)
      //   (B) 配信終了 (= 実際に終わった、過去時刻)
      // bd.endTimestamp が未来時刻の場合は (A) なので endedAt を立てない。
      // 立てると Rust 側 MAX 蓄積で未来時刻が ended_at に焼き付き、配信中なのに
      // "ended" 扱いになる (2026-05-10 fuQvDeeO7wo 事例)。
      var bdAny = pr && pr.microformat
        && pr.microformat.playerMicroformatRenderer
        && pr.microformat.playerMicroformatRenderer.liveBroadcastDetails;
      if (bdAny && bdAny.isLiveNow === false) {
        var endTs = bdAny.endTimestamp ? Date.parse(bdAny.endTimestamp) : Date.now();
        if (!isNaN(endTs) && endTs <= Date.now()) {
          meta.endedAt = endTs;
          L.debug('Stream ended detected (polling): isLiveNow=false, endTimestamp='
            + (bdAny.endTimestamp || '(none)') + ', endedAt=' + endTs + ', videoId=' + videoId);
        }
      }
    } catch (e) {
      L.warn('parse ytInitialPlayerResponse failed: ' + e.message);
    }
  }
  // ytInitialData: アイコン / 登録者数 (静的) + 同時接続数 / いいね数 (動的)
  var idMatch = html.match(/var ytInitialData = (\{[\s\S]*?\});\s*<\/script>/);
  if (idMatch) {
    try {
      var d = JSON.parse(idMatch[1]);
      var contents = d && d.contents && d.contents.twoColumnWatchNextResults
        && d.contents.twoColumnWatchNextResults.results
        && d.contents.twoColumnWatchNextResults.results.results
        && d.contents.twoColumnWatchNextResults.results.results.contents;
      if (contents) {
        // チャンネルアイコン + 登録者数 (静的)
        if (isInitial) {
          var sec = contents.find(function (c) { return c.videoSecondaryInfoRenderer; });
          if (sec) {
            var ownerR = sec.videoSecondaryInfoRenderer.owner
              && sec.videoSecondaryInfoRenderer.owner.videoOwnerRenderer;
            if (ownerR) {
              var thumbs = ownerR.thumbnail && ownerR.thumbnail.thumbnails;
              if (thumbs && thumbs.length > 0) {
                meta.channelIconUrl = thumbs[thumbs.length - 1].url;
              }
            }
          }
        }
        // 動的フィールド (毎回取得)
        var subText = null;
        var sec2 = contents.find(function (c) { return c.videoSecondaryInfoRenderer; });
        if (sec2) {
          var ownerR2 = sec2.videoSecondaryInfoRenderer.owner
            && sec2.videoSecondaryInfoRenderer.owner.videoOwnerRenderer;
          if (ownerR2 && ownerR2.subscriberCountText) {
            subText = ownerR2.subscriberCountText.simpleText
              || (ownerR2.subscriberCountText.runs && ownerR2.subscriberCountText.runs.map(function (r) { return r.text; }).join(''));
          }
        }
        var subscribers = parseJapaneseNumber(subText);
        if (subscribers !== null) meta.subscriberCount = subscribers;

        var primary = contents.find(function (c) { return c.videoPrimaryInfoRenderer; });
        if (primary) {
          var pi = primary.videoPrimaryInfoRenderer;
          // 同時接続数: viewCount.runs[0].text (e.g. "78") + runs[1].text (" 人が視聴中")
          // ライブ終了後は YouTube が同じ videoViewCountRenderer に「X 回視聴」 (= 総再生回数)
          // を入れて返してくる。 我々は同接として記録してしまう (= 2026-05-14 HgO1m5VefSU
          // peak=518 事例) ため、 「視聴中」 ラベルが含まれている時だけ currentViewers を
          // 更新する。 isLive boolean を上位構造 (= viewCount.videoViewCountRenderer.isLive)
          // で持つ場合もあるが、 ラベル文字列の方が確実。
          var vc = pi.viewCount && pi.viewCount.videoViewCountRenderer;
          if (vc && vc.viewCount) {
            var vcStr = vc.viewCount.simpleText
              || (vc.viewCount.runs && vc.viewCount.runs.map(function (r) { return r.text; }).join(''));
            var isLive = (typeof vcStr === 'string' && vcStr.indexOf('視聴中') >= 0)
              || vc.isLive === true;
            if (isLive) {
              var viewers = parseJapaneseNumber(vcStr);
              if (viewers !== null) meta.currentViewers = viewers;
            } else if (vcStr) {
              L.debug('skip currentViewers (= not live anymore): "' + vcStr + '"');
            }
          }
          // いいね数: segmentedLikeDislikeButtonViewModel から再帰的に title 抽出
          var likes = extractLikeCount(pi.videoActions);
          if (likes !== null) meta.likes = likes;
        }
      }
    } catch (e) {
      L.warn('parse ytInitialData failed: ' + e.message);
    }
  }
  meta.liveMetadataUpdatedAt = Date.now();
  return meta;
}

// "1,120" "1.2万" "12K" 等の表記から数値を抽出する (登録者数 / 視聴数共通)。
function parseJapaneseNumber(text) {
  if (!text || typeof text !== 'string') return null;
  // 日本語表記: "1.2万" → 12000、"1.2億" → 120000000
  var jpMatch = text.match(/([\d.]+)\s*([万億])/);
  if (jpMatch) {
    var n = parseFloat(jpMatch[1]);
    if (jpMatch[2] === '万') return Math.round(n * 10000);
    if (jpMatch[2] === '億') return Math.round(n * 100000000);
  }
  // 英語表記: "12K" → 12000、"1.2M" → 1200000
  var enMatch = text.match(/([\d.]+)\s*([KMB])/i);
  if (enMatch) {
    var en = parseFloat(enMatch[1]);
    if (enMatch[2].toUpperCase() === 'K') return Math.round(en * 1000);
    if (enMatch[2].toUpperCase() === 'M') return Math.round(en * 1000000);
    if (enMatch[2].toUpperCase() === 'B') return Math.round(en * 1000000000);
  }
  // 単純な数字 (カンマ区切り含む)
  var plain = text.match(/[\d,]+/);
  if (plain) return parseInt(plain[0].replace(/,/g, ''), 10);
  return null;
}

// segmentedLikeDislikeButtonViewModel から likes 数を抽出する。
// 構造: ...likeButtonViewModel.likeButtonViewModel.toggleButtonViewModel
//       .toggleButtonViewModel.defaultButtonViewModel.buttonViewModel.title
function extractLikeCount(videoActions) {
  if (!videoActions) return null;
  var buttons = videoActions.menuRenderer && videoActions.menuRenderer.topLevelButtons;
  if (!Array.isArray(buttons)) return null;
  for (var i = 0; i < buttons.length; i++) {
    var seg = buttons[i].segmentedLikeDislikeButtonViewModel;
    if (!seg) continue;
    // 入れ子が深いので再帰的に title プロパティを探す
    var found = findFirstButtonTitle(seg);
    if (found !== null) {
      var n = parseJapaneseNumber(found);
      if (n !== null) return n;
    }
  }
  return null;
}
function findFirstButtonTitle(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.buttonViewModel && typeof node.buttonViewModel.title === 'string') {
    return node.buttonViewModel.title;
  }
  for (var k in node) {
    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
    var v = node[k];
    if (v && typeof v === 'object') {
      var r = findFirstButtonTitle(v);
      if (r !== null) return r;
    }
  }
  return null;
}

function connectChat(videoId) {
  disconnectChat();
  isManualDisconnect = false;
  currentVideoId = videoId;
  // 接続開始を即時 renderer に伝えるためのメッセージ。これを更新せずに
  // pushConnectionState すると renderer 側で msg='未接続' (disconnectChat の初期化値)
  // が届き、「未接続」と誤判定されて URL 入力欄が一時的に再表示される。
  currentConnectionMessage = '接続中...';

  recheckLoginWarning();

  // PT-1b A 案: video_id を core に先に確定させる (race condition 防御)
  // resolveAndAnnounceStreamOwner の watch ページ fetch (数百 ms) は scraper status
  // (loadURL → did-finish-load → 3000ms wait → scraper inject → status 送信、合計 3+秒)
  // より早く完了することが多い。core 側の connection.video_id が未設定だと
  // AnnounceStreamOwner が破棄される。ここで先に video_id を入れておくことで、続く
  // announce がほぼ即時で適用される。
  // (B 案として ModelQueue 側でも pending owner を保持するため、ここを忘れても回復する)
  if (coreBridge.isRunning()) {
    try { coreBridge.pushConnectionState(false, videoId); }
    catch (err) { L.warn('preliminary pushConnectionState failed: ' + (err && err.message ? err.message : err)); }
  }

  // PT-1b: 配信 owner channel id を非同期で取得・通知 (chat 接続と並行)
  // 上記 pushConnectionState の後に呼ぶ (順序が重要)
  resolveAndAnnounceStreamOwner(videoId);

  // 配信メタデータの初回取得 + 30 秒間隔 polling 起動
  startStreamMetadataPolling(videoId);

  var chatUrl = buildChatUrl(videoId);
  L.info('Loading chat:', chatUrl);

  chatWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 600,
    webPreferences: {
      backgroundThrottling: false,
      partition: 'persist:youtube',
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  // console-message でスクレイパーからデータを受信
  chatWindow.webContents.on('console-message', function (_event, _level, message) {
    if (!message.startsWith('__YT_SCRAPER__:')) return;

    try {
      var payload = JSON.parse(message.slice('__YT_SCRAPER__:'.length));

      switch (payload.type) {
        case 'comments':
          if (coreBridge.isRunning()) {
            enqueueCommentBatch(payload.data);
          }
          break;

        case 'innertube-actions':
          if (coreBridge.isRunning() && payload.data) {
            try {
              coreBridge.pushInnertubeActions(payload.data);
            } catch (error) {
              L.error('Failed to push innertube actions:', error && error.message ? error.message : error);
            }
          }
          break;

        case 'reaction':
          if (coreBridge.isRunning() && payload.data) {
            coreBridge.pushReaction(payload.data);
          }
          break;

        case 'deleted':
          if (coreBridge.isRunning() && payload.data) {
            L.debug('[Scraper] deleted ids:', JSON.stringify(payload.data.ids).slice(0, 500));
            coreBridge.pushCommentDeleted(payload.data.ids);
          }
          break;

        case 'status':
          currentConnectionMessage = payload.data.message || undefined;
          if (coreBridge.isRunning()) {
            coreBridge.pushConnectionState(payload.data.connected, videoId);
          }
          break;

        case 'log':
          L.info('[Scraper]', payload.data.message);
          break;
      }
    } catch (e) {
      L.warn('[Scraper] console-message parse failed:', e && e.message ? e.message : e);
    }
  });

  chatWindow.webContents.on('did-finish-load', function () {
    L.info('Chat page loaded, injecting scraper');
    setTimeout(function () {
      if (!chatWindow || chatWindow.isDestroyed()) return;
      chatWindow.webContents.executeJavaScript(scraperCode).catch(function (err) {
        L.error('Scraper injection failed:', err.message);
        sendToRenderer('status', { connected: false, message: 'スクレイパー注入失敗' });
        scheduleReconnect();
      });
    }, 3000);
  });

  chatWindow.webContents.on('did-fail-load', function (_event, errorCode, errorDescription) {
    L.error('Chat page failed to load:', errorCode, errorDescription);
    sendToRenderer('status', { connected: false, message: 'ページ読み込み失敗: ' + errorDescription });
    coreBridge.pushConnectionState(false, videoId);
    scheduleReconnect();
  });

  // ページクラッシュ時の再接続
  chatWindow.webContents.on('render-process-gone', function (_event, details) {
    L.error('Renderer process gone:', details.reason);
    sendToRenderer('status', { connected: false, message: 'チャットページがクラッシュしました' });
    coreBridge.pushConnectionState(false, videoId);
    scheduleReconnect();
  });

  // ウィンドウが予期せず閉じた場合の再接続
  chatWindow.on('closed', function () {
    chatWindow = null;
    if (!isManualDisconnect && currentVideoId) {
      L.info('Chat window closed unexpectedly, reconnecting...');
      sendToRenderer('status', { connected: false, message: '再接続中...' });
      scheduleReconnect();
    }
  });

  // 定期的なヘルスチェック: Hidden Windowのメモリ使用量を監視
  var healthCheckInterval = setInterval(function () {
    if (!chatWindow || chatWindow.isDestroyed()) {
      clearInterval(healthCheckInterval);
      return;
    }
    var memInfo = process.memoryUsage();
    var heapMB = Math.round(memInfo.heapUsed / 1024 / 1024);
    if (heapMB > 500) {
      L.warn('High memory usage:', heapMB, 'MB. Reloading chat window.');
      chatWindow.webContents.reload();
    }
  }, 60000);

  sendToRenderer('status', { connected: false, message: '接続中...' });
  chatWindow.loadURL(chatUrl);
}

function scheduleReconnect() {
  if (reconnectTimer || isManualDisconnect || !currentVideoId) return;
  L.info('Scheduling reconnect in 5 seconds...');
  sendToRenderer('status', { connected: false, message: '5秒後に再接続...' });
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (currentVideoId && !isManualDisconnect) {
      L.info('Reconnecting to:', currentVideoId);
      connectChat(currentVideoId);
    }
  }, 5000);
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function disconnectChat() {
  isManualDisconnect = true;
  cancelReconnect();
  // 切断時刻を ended_at として記録 (DB 側 MAX で蓄積)。
  // polling 停止前に呼ばないと streamMetadataState が null 化されて videoId が引けない。
  var disconnectingVideoId = streamMetadataState && streamMetadataState.videoId;
  stopStreamMetadataPolling();
  if (disconnectingVideoId) {
    L.info('Stream metadata polling stopped for video=' + disconnectingVideoId);
  }

  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.close();
    chatWindow = null;
  }
  if (disconnectingVideoId && coreBridge.isRunning()) {
    var endedAt = Date.now();
    coreBridge
      .updateStreamMetadata(disconnectingVideoId, { endedAt: endedAt })
      .then(function () {
        L.info('Stream ended_at recorded: video=' + disconnectingVideoId + ', ended_at=' + endedAt);
      })
      .catch(function (err) {
        L.warn('Failed to record stream ended_at for video=' + disconnectingVideoId
          + ': ' + (err && err.message ? err.message : err));
      });
  }
  currentVideoId = null;
  currentConnectionMessage = '未接続';
  sendToRenderer('status', { connected: false, message: '未接続' });
  coreBridge.pushConnectionState(false, null);
}

// Rust コア⇔レンダラー準備完了の双方向ハンドシェイク
var coreReady = false;
var rendererReady = false;

ipcMain.on('renderer-ready', function () {
  rendererReady = true;
  if (coreReady) {
    sendToRenderer('core-ready');
    broadcastCoreStatus();
  }
});

// IPC: 前回のURLを取得
// レンダラープロセスのエラーログ受信
// 旧 renderer-error 経路は Phase 1c (2026-05-21) で撤去。 renderer 側未捕捉エラーは
// `api.log.create('RendererUncaught').error(...)` 経由で renderer.log に記録される。
// (= docs/logging.md「console.log 例外」 セクション + 「Renderer 側タグ一覧」 参照)

ipcMain.on('get-last-url', function () {
  if (isDemo) {
    sendToRenderer('last-url', 'https://www.youtube.com/watch?v=xK7mD3q2F9w');
    return;
  }
  var lastUrl = store.get('lastUrl');
  if (lastUrl) {
    sendToRenderer('last-url', lastUrl);
  }
});

// IPC: 接続
ipcMain.on('connect', function (_event, url) {
  var videoId = extractVideoId(url);
  if (!videoId) {
    sendToRenderer('status', { connected: false, message: '無効なURLです' });
    return;
  }
  store.set('lastUrl', url);
  L.info('Connecting to video:', videoId);
  connectChat(videoId);
});

// IPC: 切断
ipcMain.on('disconnect', function () {
  L.info('Disconnecting');
  disconnectChat();
});

// IPC: 外部ブラウザで開く
ipcMain.on('open-external', function (_event, url) {
  if (typeof url === 'string' && url.startsWith('http')) {
    shell.openExternal(url);
  }
});

// IPC: フォルダをエクスプローラーで開く
ipcMain.on('open-folder', function (_event, name) {
  var folders = {
    frames: userFramesDir,
    assets: userAssetsDir
  };
  var folderPath = folders[name];
  if (folderPath) {
    shell.openPath(folderPath);
  }
});

// IPC: フレーム一覧取得
// 旧グローバルフレームIPC削除済み → シーン対応版は下部に移動

// IPC: アセットのエクスポート
ipcMain.handle('export-assets', async function (_event, exportName) {
  if (!exportName || !exportName.trim()) return false;
  exportName = exportName.trim();

  return runZipExport('アバター設定をエクスポート', 'preset.zip', function (filePath) {
    if (!coreBridge.isRunning()) return false;
    return coreBridge.exportPreset(filePath, exportName).then(function (res) {
      return res && res.ok;
    });
  });
});

// IPC: アセットのインポート（プリセットとして保存 + 即切り替え）
ipcMain.handle('import-assets', async function () {
  var filePath = await chooseZipOpenPath('アバター設定をインポート');
  if (!filePath) return false;

  if (!coreBridge.isRunning()) {
    showImportError('サイドカーが起動していません。');
    return false;
  }

  var res = await coreBridge.importPreset(filePath);
  if (res && res.error) {
    showImportError(res.error);
    return false;
  }
  // Rust 側で切替済み → オーバーレイをリロード
  coreBridge.broadcastReload();
  return res;
});

// IPC: プリセット一覧
ipcMain.handle('get-preset-list', function () {
  return coreBridge.getPresetList();
});

// IPC: 現在のプリセット名
ipcMain.handle('get-current-preset', function () {
  return coreBridge.getCurrentPreset();
});

// IPC: プリセット切り替え
ipcMain.handle('switch-preset', async function (_event, name) {
  if (!coreBridge.isRunning()) return false;
  var res = await coreBridge.switchPreset(name);
  if (res && !res.error) {
    coreBridge.broadcastReload();
    return true;
  }
  return false;
});

// IPC: プリセット複製
ipcMain.handle('duplicate-preset', function (_event, newName) {
  if (!newName) return Promise.resolve(false);
  return coreBridge.duplicatePreset(newName);
});

// IPC: プリセット削除
ipcMain.handle('delete-preset', function (_event, name) {
  return coreBridge.deletePreset(name);
});

// 2026-05-09 仕様変更: 旧 normalizeBannedUser / getBannedUsers / syncBannedUsers (= 演出フィルタ向け) は撤廃。
// 演出フィルタを廃止し、UI 表示抑制 (= hidden_listeners、hideFromComments / hideFromListeners 2 軸) に集約。
function normalizeHiddenListener(userInfo) {
  if (typeof userInfo === 'string') {
    return { id: userInfo, name: userInfo, profileImage: '', hideFromComments: true, hideFromListeners: true };
  }
  return {
    id: userInfo && userInfo.id ? userInfo.id : '',
    name: userInfo && userInfo.name ? userInfo.name : (userInfo && userInfo.id ? userInfo.id : ''),
    profileImage: userInfo && userInfo.profileImage ? userInfo.profileImage : '',
    hideFromComments: !!(userInfo && userInfo.hideFromComments),
    hideFromListeners: !!(userInfo && userInfo.hideFromListeners),
  };
}

function getHiddenListeners() {
  return coreBridge.getHiddenListeners().then(function (raw) {
    var users = (typeof raw === 'string') ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : []);
    return Array.isArray(users) ? users.map(normalizeHiddenListener) : [];
  });
}

function syncHiddenListeners(users) {
  return coreBridge.setHiddenListeners(users.map(normalizeHiddenListener));
}

// IPC: 言語
ipcMain.handle('get-i18n', function () {
  return {
    version: require('../package.json').version,
    lang: i18n.getCurrentLang(),
    translations: i18n.getAllTranslations(),
    supported: i18n.getSupportedLanguages()
  };
});

ipcMain.handle('set-language', function (_event, lang) {
  i18n.setLanguage(lang);
  store.set('language', lang);
  return {
    lang: i18n.getCurrentLang(),
    translations: i18n.getAllTranslations()
  };
});

// IPC: ベータチャンネル設定
ipcMain.handle('get-beta-channel', function () {
  return store.get('betaChannel', false);
});

ipcMain.handle('set-beta-channel', function (_event, enabled) {
  store.set('betaChannel', enabled);
  return true;
});

// IPC: アプリバージョン (= ブランド表示等に使う。preload で require 不可なので main から渡す)
ipcMain.handle('get-app-version', function () {
  return app.getVersion();
});

// IPC: renderer process からの log event を Rust 側 renderer.log に転送
// 詳細仕様: docs/logging.md (= 3 経路構成 / 専用 mpsc + writer task)
// fire-and-forget (= ipcMain.on、 invoke ではない、 renderer は await 不要)。
// Rust 未起動時は app.log の [Renderer] タグに fallback して落とさない (= 観点 J)。
var rendererFallbackLogger = null;
ipcMain.on('log-renderer', function (_event, level, tag, message) {
  if (coreBridge.isRunning() && coreBridge.isRendererLoggingInitialized()) {
    coreBridge.logRenderer(level, tag, message);
    return;
  }
  // fallback: core 起動前 or 初期化失敗時、 app.log に [Renderer:<tag>] で残す
  if (!rendererFallbackLogger) {
    rendererFallbackLogger = log.create('Renderer');
  }
  var fn = rendererFallbackLogger[level] || rendererFallbackLogger.info;
  fn.call(rendererFallbackLogger, '[' + tag + ']', message);
});

// IPC: デバッグ・サポート (= デバッグログ ON/OFF)
// 詳細仕様: docs/logging.md
ipcMain.handle('get-debug-logging-enabled', async function () {
  try {
    var result = await coreBridge.getDebugLoggingEnabled();
    return !!(result && result.enabled);
  } catch (err) {
    L.warn('get-debug-logging-enabled failed:', err && err.message ? err.message : err);
    return false;
  }
});

ipcMain.handle('set-debug-logging-enabled', async function (_event, enabled) {
  try {
    var result = await coreBridge.setDebugLoggingEnabled(!!enabled);
    return !!(result && result.ok);
  } catch (err) {
    L.warn('set-debug-logging-enabled failed:', err && err.message ? err.message : err);
    return false;
  }
});

// IPC: アップデート
ipcMain.handle('download-update', function () {
  autoUpdater.downloadUpdate();
  return true;
});

ipcMain.handle('install-update', function () {
  autoUpdater.quitAndInstall();
  return true;
});

// IPC: アイコン差し替え
// 旧グローバルchange-icon削除済み → シーン対応版は下部に移動

// IPC: マニュアルウィンドウ
var manualWindow = null;
ipcMain.on('open-manual', function () {
  if (manualWindow && !manualWindow.isDestroyed()) {
    manualWindow.focus();
    return;
  }
  manualWindow = new BrowserWindow(applyWindowIconOption({
    width: 920,
    height: 720,
    title: 'こめはぶ ヘルプ',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }));
  manualWindow.loadFile(path.join(__dirname, 'renderer', 'manual.html'));
  manualWindow.on('closed', function () {
    manualWindow = null;
  });
});

// IPC: テンプレ開発ガイドビューア
var templateDevGuideWindow = null;
var TEMPLATE_DEV_GUIDE_DOCS = [
  { id: 'authoring', title: 'テンプレート開発ガイド', file: 'template-authoring-guide.md' },
  { id: 'runtime', title: 'API リファレンス', file: 'template-runtime.md' },
  { id: 'onecomme', title: 'わんコメ移植ガイド', file: 'onecomme-migration-guide.md' },
  { id: 'example-list-html-first', title: 'チュートリアル: list HTML-first 最小', file: 'examples/template-list-html-first/README.md' },
  { id: 'example-ticker-basic', title: 'チュートリアル: ticker 最小', file: 'examples/template-ticker-basic/README.md' },
  { id: 'example-list-basic', title: 'チュートリアル: list starter + dev preview', file: 'examples/template-list-basic/README.md' },
  { id: 'example-custom-basic', title: 'チュートリアル: custom starter', file: 'examples/template-custom-basic/README.md' }
];

ipcMain.on('open-template-dev-guide', function () {
  if (templateDevGuideWindow && !templateDevGuideWindow.isDestroyed()) {
    templateDevGuideWindow.focus();
    return;
  }
  templateDevGuideWindow = new BrowserWindow(applyWindowIconOption({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Live Comment Hub - テンプレート開発ガイド',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }));
  templateDevGuideWindow.loadFile(path.join(__dirname, 'renderer', 'template-dev-guide.html'));
  templateDevGuideWindow.on('closed', function () {
    templateDevGuideWindow = null;
  });
});

ipcMain.handle('template-dev-guide-list', function () {
  return TEMPLATE_DEV_GUIDE_DOCS;
});

ipcMain.handle('template-dev-guide-read', function (_event, fileRelative) {
  if (typeof fileRelative !== 'string' || fileRelative.length === 0) {
    throw new Error('invalid file argument');
  }
  // 公開対象一覧に登録された file パスのみ許可 (= 任意パス読み込みを禁止)
  var allowed = TEMPLATE_DEV_GUIDE_DOCS.some(function (doc) { return doc.file === fileRelative; });
  if (!allowed) {
    throw new Error('file not in allowlist: ' + fileRelative);
  }
  var devGuideDir = pathUtils.getDevGuideDir(app);
  var resolvedPath = path.join(devGuideDir, fileRelative);
  // パストラバーサル防止 (allowlist 通過後の二重保険)
  if (!pathUtils.isPathInside(devGuideDir, resolvedPath)) {
    throw new Error('path outside dev guide dir');
  }
  return fs.readFileSync(resolvedPath, 'utf8');
});

// IPC: ポン出し専用ウィンドウ
// 配信中に手動発火する performance だけを並べた専用 UI。
// scene / performance の状態は scenes-changed broadcast 経由で同期する。
ipcMain.on('open-ponout-window', function () {
  if (ponoutWindow && !ponoutWindow.isDestroyed()) {
    ponoutWindow.focus();
    return;
  }
  ponoutWindow = new BrowserWindow(applyWindowIconOption({
    width: 820,
    height: 520,
    minWidth: 700,
    minHeight: 360,
    title: 'Live Comment Hub - ポン出し',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }));
  ponoutWindow.loadFile(path.join(__dirname, 'renderer', 'ponout.html'));
  // 初期状態は ponout.js が `api.getCoreStatus()` で pull する。
  // 状態変化は `core-status` broadcast で push される。
  ponoutWindow.on('closed', function () {
    ponoutWindow = null;
  });
});

ipcMain.handle('ponout-open-remote', function () {
  return coreBridge.startPonoutRemote();
});

ipcMain.handle('listener-open-remote', function () {
  return coreBridge.startListenerRemote();
});

ipcMain.handle('ponout-get-remote-warning-dismissed', function () {
  return !!store.get('ponoutRemoteWarningDismissed');
});

ipcMain.handle('ponout-set-remote-warning-dismissed', function (_event, dismissed) {
  store.set('ponoutRemoteWarningDismissed', !!dismissed);
  return !!dismissed;
});

// IPC: 初期セットアップウィンドウ
ipcMain.on('open-onboarding', function () {
  openSetupWindow();
});

// IPC: YouTubeログイン
ipcMain.on('open-login', function () {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow(applyWindowIconOption({
    width: 500,
    height: 700,
    autoHideMenuBar: true,
    title: 'YouTubeにログイン',
    webPreferences: {
      partition: 'persist:youtube',
      contextIsolation: true,
      nodeIntegration: false
    }
  }));
  loginWindow.loadURL('https://accounts.google.com/ServiceLogin?service=youtube');

  // ログイン完了後にYouTubeにリダイレクトされたら自動で閉じる
  loginWindow.webContents.on('did-navigate', function (_event, url) {
    if (url.startsWith('https://www.youtube.com')) {
      L.info('YouTube login successful');
      sendToRenderer('login-warning', false);
      loginWindow.close();
      // ログインでセッションが変わるためチャットを再接続
      if (currentVideoId) {
        L.info('Reconnecting chat after login');
        connectChat(currentVideoId);
      }
    }
  });

  loginWindow.on('closed', function () {
    loginWindow = null;
  });
});

// IPC: YouTubeログイン状態チェック
ipcMain.handle('check-login', function () {
  return new Promise(function (resolve) {
    checkYouTubeLogin(function (loggedIn) {
      resolve(loggedIn);
    });
  });
});

// IPC: YouTubeログアウト
ipcMain.handle('logout', function () {
  var ses = require('electron').session.fromPartition('persist:youtube');
  return ses.clearStorageData().then(function () {
    return ses.clearCache();
  }).then(function () {
    L.info('YouTube session cleared');
    return true;
  });
});

// --- 演出素材 IPC ---

async function chooseSingleFilePath(title, filters) {
  return chooseOpenPath({
    title: title,
    filters: filters,
    properties: ['openFile']
  });
}

async function chooseOpenPath(options) {
  var { dialog } = require('electron');
  if (options.debugLabel) L.debug(options.debugLabel + ': showing dialog');
  var result = await dialog.showOpenDialog(mainWindow, {
    title: options.title,
    filters: options.filters,
    properties: options.properties
  });
  if (options.debugLabel) L.debug(options.debugLabel + ': dialog result', result.canceled, result.filePaths);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

async function chooseDirectoryPath(title) {
  return chooseOpenPath({
    title: title,
    properties: ['openDirectory']
  });
}

ipcMain.handle('add-performance-asset', async function (_event, sceneId, performanceId) {
  var srcPath = await chooseSingleFilePath('素材を選択', [
    { name: '画像・動画', extensions: ['png', 'jpg', 'jpeg', 'gif', 'apng', 'webp', 'svg', 'webm'] },
    { name: 'HTML', extensions: ['html'] },
    { name: 'すべて', extensions: ['*'] }
  ]);
  if (!srcPath) return null;
  if (!coreBridge.isRunning()) return null;
  return coreBridge.copyPerformanceAsset(sceneId, srcPath, performanceId);
});

ipcMain.handle('copy-performance-asset', function (_event, sceneId, srcPath, performanceId) {
  return coreBridge.copyPerformanceAsset(sceneId, srcPath, performanceId);
});

ipcMain.handle('check-default-template-context', function (_event, effectId) {
  return coreBridge.checkDefaultTemplateContext(effectId);
});

ipcMain.handle('add-performance-sound', async function (_event, sceneId, performanceId) {
  var srcPath = await chooseSingleFilePath('効果音を選択', [
    { name: '音声', extensions: ['mp3', 'wav', 'ogg'] }
  ]);
  if (!srcPath) return null;
  if (!coreBridge.isRunning()) return null;
  return coreBridge.copyPerformanceAsset(sceneId, srcPath, performanceId);
});

// --- シーン管理 IPC ---

ipcMain.handle('get-scene-list', async function () {
  return coreBridge.getSceneList();
});

ipcMain.handle('get-scene', async function (_event, sceneId) {
  var res = await coreBridge.getScenes();
  if (!res) return null;
  var scenes = res.scenes || res;
  return scenes[sceneId] || null;
});

ipcMain.handle('get-scenes', async function () {
  var res = await coreBridge.getScenes();
  if (!res) return {};
  return res.scenes || res || {};
});

ipcMain.handle('save-scene', async function (_event, sceneId, sceneData) {
  var res = await coreBridge.saveScene(sceneId, sceneData);
  if (res && res.ok) {
    broadcastScenesChanged({ kind: 'scene-saved', sceneId: sceneId });
  }
  return res && res.ok;
});

ipcMain.handle('create-scene', function (_event, name) {
  if (!coreBridge.isRunning()) return null;
  L.info('create-scene: name=' + name);
  var newId = coreBridge.createScene(name);
  if (newId) broadcastScenesChanged({ kind: 'scene-created', sceneId: newId });
  return newId;
});

ipcMain.handle('duplicate-scene', function (_event, sourceId, newName) {
  if (!coreBridge.isRunning()) return null;
  var newId = coreBridge.duplicateScene(sourceId, newName);
  if (newId) broadcastScenesChanged({ kind: 'scene-duplicated', sceneId: newId });
  return newId;
});

ipcMain.handle('reorder-scenes', function (_event, orderedIds) {
  coreBridge.reorderScenes(orderedIds);
  broadcastScenesChanged({ kind: 'scenes-reordered' });
  return true;
});

ipcMain.handle('delete-scene', function (_event, sceneId) {
  L.info('delete-scene: sceneId=' + sceneId);
  var res = coreBridge.deleteScene(sceneId);
  broadcastScenesChanged({ kind: 'scene-deleted', sceneId: sceneId });
  return res;
});

ipcMain.handle('rename-scene', async function (_event, sceneId, newName) {
  var res = await coreBridge.renameScene(sceneId, newName);
  if (res && res.ok) {
    broadcastScenesChanged({ kind: 'scene-renamed', sceneId: sceneId });
  }
  return res && res.ok;
});

ipcMain.handle('set-scene-enabled', function (_event, sceneId, enabled) {
  var res = coreBridge.setSceneEnabled(sceneId, enabled);
  broadcastScenesChanged({ kind: 'scene-enabled-changed', sceneId: sceneId });
  return res;
});

ipcMain.handle('restore-default-scene', function (_event, sceneId) {
  var res = coreBridge.restoreDefaultScene(sceneId);
  broadcastScenesChanged({ kind: 'scene-restored', sceneId: sceneId });
  return res;
});

ipcMain.handle('get-selected-scene', function () {
  if (!coreBridge.isRunning()) return '';
  return coreBridge.getActiveScene();
});

ipcMain.handle('set-selected-scene', function (_event, sceneId) {
  coreBridge.setActiveSceneAndSave(sceneId);
  broadcastScenesChanged({ kind: 'selection', sceneId: sceneId });
  return true;
});

// --- 演出 IPC ---

ipcMain.handle('get-performances', function (_event, sceneId) {
  return coreBridge.getPerformances(sceneId);
});

ipcMain.handle('save-performance', async function (_event, sceneId, performance) {
  L.info('save-performance: sceneId=' + sceneId + ', performanceId=' + (performance && performance.id));
  var result = await coreBridge.savePerformance(sceneId, performance);
  recheckLoginWarning();
  broadcastScenesChanged({
    kind: 'performance-saved',
    sceneId: sceneId,
    performanceId: performance && performance.id
  });
  return result;
});

ipcMain.handle('delete-performance', async function (_event, sceneId, performanceId) {
  L.info('delete-performance: sceneId=' + sceneId + ', performanceId=' + performanceId);
  var result = await coreBridge.deletePerformance(sceneId, performanceId);
  recheckLoginWarning();
  broadcastScenesChanged({
    kind: 'performance-deleted',
    sceneId: sceneId,
    performanceId: performanceId
  });
  return result;
});

ipcMain.handle('set-performance-enabled', async function (_event, sceneId, performanceId, enabled) {
  var result = await coreBridge.setPerformanceEnabled(sceneId, performanceId, enabled);
  recheckLoginWarning();
  broadcastScenesChanged({
    kind: 'performance-enabled-changed',
    sceneId: sceneId,
    performanceId: performanceId
  });
  return result;
});

ipcMain.handle('reorder-performances', function (_event, sceneId, orderedIds) {
  var res = coreBridge.reorderPerformances(sceneId, orderedIds);
  broadcastScenesChanged({ kind: 'performances-reordered', sceneId: sceneId });
  return res;
});

// --- テンプレート IPC ---

ipcMain.handle('get-templates', function () {
  return coreBridge.getTemplates();
});

ipcMain.handle('install-template', async function () {
  var zipPath = await chooseZipOpenPath('テンプレートをインポート', 'install-template');
  if (!zipPath) return { ok: false, cancelled: true };
  return coreBridge.installTemplate(zipPath);
});

ipcMain.handle('create-template-from-starter', function (_event, starterType, templateId, displayName) {
  return coreBridge.createTemplateFromStarter(starterType, templateId, displayName);
});

ipcMain.handle('export-template', async function (_event, templateName, exportName, sceneId, templateSettings) {
  return runZipExport('テンプレートをエクスポート', (exportName || templateName) + '.zip', function (filePath) {
    return coreBridge.exportTemplate(templateName, exportName, sceneId, templateSettings, filePath);
  }, { failureMessage: 'テンプレートのエクスポートに失敗しました。' });
});

ipcMain.handle('remove-template', function (_event, name) {
  return coreBridge.removeTemplate(name);
});

ipcMain.handle('create-template-from-builtin', function (_event, sourceTemplateId, templateId, displayName) {
  return coreBridge.createTemplateFromBuiltin(sourceTemplateId, templateId, displayName);
});

ipcMain.handle('open-template-folder', async function (_event, templateName) {
  var result = await coreBridge.getTemplateDirectory(templateName);
  var folderPath = result && result.path;
  if (!folderPath) return { ok: false, error: 'テンプレートフォルダが見つかりません。' };
  var openResult = await shell.openPath(folderPath);
  if (openResult) {
    return { ok: false, error: openResult };
  }
  return { ok: true, path: folderPath };
});

ipcMain.handle('choose-template-font-import', async function () {
  var filePath = await chooseOpenPath({
    title: '同梱フォントを選択',
    filters: [
      { name: 'Fonts / ZIP', extensions: ['woff2', 'woff', 'otf', 'ttf', 'zip'] },
      { name: 'Fonts', extensions: ['woff2', 'woff', 'otf', 'ttf'] },
      { name: 'ZIP', extensions: ['zip'] }
    ],
    properties: ['openFile']
  });
  return filePath ? { ok: true, path: filePath } : { ok: false, cancelled: true };
});

ipcMain.handle('import-template-bundled-font', function (_event, templateName, srcPath, family) {
  if (!coreBridge.isRunning()) return { ok: false, error: 'Rust core not running' };
  return coreBridge.importTemplateBundledFont(templateName, srcPath, family);
});

ipcMain.handle('get-scene-templates', function (_event, sceneId) {
  return coreBridge.getSceneTemplates(sceneId);
});

ipcMain.handle('add-scene-template', function (_event, sceneId, templateName) {
  return coreBridge.addSceneTemplate(sceneId, templateName);
});

ipcMain.handle('ensure-template-fonts', function (_event, fonts) {
  if (!Array.isArray(fonts) || fonts.length === 0) return Promise.resolve({ ok: true });
  return coreBridge.ensureTemplateFonts(fonts, function (progress) {
    if (!progress) return;
    sendToRenderer('font-dl-progress', progress);
  });
});

ipcMain.handle('remove-scene-template', function (_event, sceneId, templateName) {
  return coreBridge.removeSceneTemplate(sceneId, templateName);
});

ipcMain.handle('set-selected-scene-template', function (_event, sceneId, templateName) {
  return coreBridge.setSelectedSceneTemplate(sceneId, templateName);
});

ipcMain.handle('set-scene-template-enabled', function (_event, sceneId, templateName, enabled) {
  return coreBridge.setSceneTemplateEnabled(sceneId, templateName, enabled);
});
ipcMain.handle('set-scene-templates-enabled', function (_event, sceneId, enabled) {
  return coreBridge.setSceneTemplatesEnabled(sceneId, enabled);
});
ipcMain.handle('set-scene-template-config', function (_event, sceneId, templateName, settings) {
  return coreBridge.setSceneTemplateConfig(sceneId, templateName, settings);
});
ipcMain.handle('get-template-manifests', function () {
  return coreBridge.getTemplateManifests();
});
ipcMain.handle('get-template-manifest', function (_event, templateName) {
  return coreBridge.getTemplateManifest(templateName);
});
ipcMain.handle('save-template-manifest', function (_event, templateName, manifest) {
  return coreBridge.saveTemplateManifest(templateName, manifest);
});

// --- エフェクト IPC ---

ipcMain.handle('get-effects', function () {
  return coreBridge.getEffects();
});

ipcMain.handle('get-plugin-manifests', function () {
  return coreBridge.getPluginManifests();
});

ipcMain.handle('get-effect', function (_event, effectId) {
  return coreBridge.getEffect(effectId);
});

ipcMain.handle('add-effect', function (_event, effect) {
  return coreBridge.addEffect(effect);
});

ipcMain.handle('update-effect', function (_event, effect) {
  return coreBridge.updateEffect(effect);
});

ipcMain.handle('remove-effect', function (_event, effectId) {
  return coreBridge.removeEffect(effectId);
});

ipcMain.handle('duplicate-effect', function (_event, effectId, newName) {
  return coreBridge.duplicateEffect(effectId, newName);
});

// --- エクスポート/インポート IPC ---

async function chooseZipSavePath(title, defaultPath) {
  var { dialog } = require('electron');
  var result = await dialog.showSaveDialog(mainWindow, {
    title: title,
    defaultPath: defaultPath,
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  });
  return result.canceled ? null : result.filePath;
}

async function chooseZipOpenPath(title, debugLabel) {
  return chooseOpenPath({
    title: title,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
    properties: ['openFile'],
    debugLabel: debugLabel
  });
}

async function runZipExport(title, defaultPath, exportFn, options) {
  var filePath = await chooseZipSavePath(title, defaultPath);
  if (!filePath) return { ok: false, cancelled: true };
  try {
    var exportResult = exportFn(filePath);
    if (exportResult === false) {
      var failureMessage = options && options.failureMessage ? options.failureMessage : 'ZIP のエクスポートに失敗しました。';
      showExportError(failureMessage);
      return { ok: false, error: failureMessage, alreadyNotified: true };
    }
    return { ok: true, data: exportResult };
  } catch (e) {
    L.error('zip export failed:', title, e);
    var exportError = e && e.message ? e.message : 'ZIP のエクスポートに失敗しました。';
    showExportError(exportError);
    return { ok: false, error: exportError, alreadyNotified: true };
  }
}

function showExportError(message) {
  var { dialog } = require('electron');
  dialog.showErrorBox('エクスポートエラー', message);
}

function showImportError(message) {
  var { dialog } = require('electron');
  dialog.showErrorBox('インポートエラー', message);
}

async function runZipImport(title, errorPrefix, importFn, options) {
  var filePath = await chooseZipOpenPath(title, options && options.debugLabel);
  if (!filePath) return { ok: false, cancelled: true };

  try {
    var importResult = importFn(filePath);
    if (options && options.debugLabel) L.debug(options.debugLabel + ': result', importResult);
    if (options && typeof options.normalizeResult === 'function') {
      return options.normalizeResult(importResult);
    }
    return { ok: true, data: importResult };
  } catch (e) {
    if (options && options.debugLabel) L.error(options.debugLabel + ': error', e);
    var importError = errorPrefix + e.message;
    showImportError(importError);
    return { ok: false, error: importError, alreadyNotified: true };
  }
}

function normalizeSceneImportResult(result) {
  if (!result) {
    return { ok: false, error: 'シーンの読み込みに失敗しました。' };
  }
  if (typeof result === 'string') {
    return { ok: true, sceneId: result, warnings: [] };
  }
  if (result.sceneId) {
    return { ok: true, sceneId: result.sceneId, warnings: result.warnings || [] };
  }
  if (result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: false, error: 'シーンの読み込みに失敗しました。' };
}

function normalizePerformanceImportResult(result) {
  if (result === true) {
    return { ok: true };
  }
  if (result && result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: false, error: '演出の読み込みに失敗しました。' };
}

function normalizeEffectImportResult(result) {
  if (typeof result === 'string') {
    return { ok: true, effectId: result };
  }
  if (result && result.needsUpgrade) {
    return {
      ok: false,
      needsUpgrade: true,
      zipPath: result.zipPath,
      upgradeInfo: result.upgradeInfo
    };
  }
  if (result && result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: false, error: 'エフェクトの読み込みに失敗しました。' };
}

ipcMain.handle('export-scene', async function (_event, sceneId, sceneName) {
  return runZipExport('シーンをエクスポート', (sceneName || sceneId) + '.zip', function (filePath) {
    if (!coreBridge.isRunning()) return false;
    return coreBridge.exportScene(sceneId, filePath).then(function (res) {
      return res && res.ok;
    });
  }, { failureMessage: 'シーンのエクスポートに失敗しました。' });
});

ipcMain.handle('import-scene', async function () {
  var result = await runZipImport('シーンをインポート', 'シーンの読み込みに失敗しました: ', function (filePath) {
    if (!coreBridge.isRunning()) return null;
    return coreBridge.importScene(filePath);
  }, { normalizeResult: normalizeSceneImportResult });
  if (result && result.ok && result.sceneId) {
    broadcastScenesChanged({ kind: 'scene-imported', sceneId: result.sceneId });
  }
  return result;
});

ipcMain.handle('export-performance', async function (_event, sceneId, performanceId, perfName) {
  return runZipExport('演出をエクスポート', (perfName || performanceId) + '.zip', function (filePath) {
    if (!coreBridge.isRunning()) return false;
    return coreBridge.exportPerformance(sceneId, performanceId, filePath).then(function (res) {
      return res && res.ok;
    });
  }, { failureMessage: '演出のエクスポートに失敗しました。' });
});

ipcMain.handle('import-performance', async function (_event, sceneId) {
  var result = await runZipImport('演出をインポート', '演出の読み込みに失敗しました: ', function (filePath) {
    if (!coreBridge.isRunning()) return false;
    return coreBridge.importPerformance(sceneId, filePath);
  }, { normalizeResult: normalizePerformanceImportResult });
  if (result && result.ok) {
    broadcastScenesChanged({ kind: 'performance-imported', sceneId: sceneId });
  }
  return result;
});

ipcMain.handle('export-effect', async function (_event, effectId, effectName) {
  return runZipExport('エフェクトをエクスポート', (effectName || effectId) + '.zip', function (filePath) {
    if (!coreBridge.isRunning()) return false;
    return coreBridge.exportEffect(effectId, filePath).then(function (res) {
      return res && res.ok;
    });
  }, { failureMessage: 'エフェクトのエクスポートに失敗しました。' });
});

ipcMain.handle('import-effect', async function () {
  return runZipImport('エフェクトをインポート', 'エフェクトの読み込みに失敗しました: ', function (filePath) {
    if (!coreBridge.isRunning()) return null;
    return coreBridge.importEffect(filePath);
  }, { normalizeResult: normalizeEffectImportResult, debugLabel: 'import-effect' });
});

ipcMain.handle('confirm-upgrade-effect', async function (_event, zipPath, effectId) {
  if (!coreBridge.isRunning()) return { upgraded: false, error: 'Rust core not running' };
  var result = await coreBridge.confirmUpgradeEffect(zipPath, effectId);
  if (result && result.upgraded) {
    // エフェクトアップグレードは複数 scene の performance に影響しうるため scene 全体に通知。
    broadcastScenesChanged({ kind: 'effect-upgraded', effectId: effectId });
  }
  return result;
});

// --- グローバル設定 IPC ---

// 2026-05-09 仕様変更: 旧 IPC (get/add/remove-banned-user) を hidden-listeners 系に置換。
ipcMain.handle('listeners-get-hidden', function () {
  return getHiddenListeners();
});

ipcMain.handle('listeners-set-hidden-list', function (_event, users) {
  // BAN リストモーダルからの一括 set (= 全クリア / 複数解除用)
  if (!Array.isArray(users)) return Promise.resolve([]);
  return syncHiddenListeners(users);
});

// --- Step 3 リスナー管理 IPC (フェーズ 3.2a) ---

ipcMain.handle('listeners-get-owner-channels', async function () {
  return coreBridge.getOwnerChannels();
});

ipcMain.handle('listeners-set-owner-channels', async function (_event, channels) {
  var arr = Array.isArray(channels) ? channels : [];
  return coreBridge.setOwnerChannels(arr);
});

// YouTube チャンネル情報解決 (双方向)。
// 入力が @handle なら UC... を、UC... なら @handle を引いて返す。
ipcMain.handle('youtube-resolve-channel-info', async function (_event, input) {
  return resolveYoutubeChannelInfo(input);
});

ipcMain.handle('youtube-get-current-channel', async function () {
  var result = await getCurrentYoutubeChannel();
  L.info('youtube-get-current-channel result: ok=' + (result && result.ok)
    + ' reason=' + (result && result.reason || '-')
    + ' channelId=' + (result && result.channelId || '-')
    + ' handle=' + (result && result.handle || '-')
    + ' name=' + (result && result.name || '-'));
  return result;
});

ipcMain.handle('listeners-list', async function (_event, query) {
  return coreBridge.listListeners(query || {});
});

ipcMain.handle('listeners-activity', async function (_event, query) {
  return coreBridge.listListenersActivity(query || {});
});

// 配信サムネのローカル DL (mqdefault.jpg → media-cache/stream-thumbs/{videoId}.jpg)
ipcMain.handle('cache-stream-thumbnail', async function (_event, videoId) {
  return coreBridge.cacheStreamThumbnail(videoId || '');
});

ipcMain.handle('listeners-detail', async function (_event, channelId, recentCommentLimit) {
  return coreBridge.getListenerDetail(channelId, recentCommentLimit);
});

ipcMain.handle('listeners-update-metadata', async function (_event, channelId, fields) {
  return coreBridge.updateListenerMetadata(channelId, fields || {});
});

// リモート閲覧 redesign §4.1: 「挨拶済み」「対応済み」トグル
ipcMain.handle('listeners-set-greeted', async function (_event, streamVideoId, listenerChannelId, value) {
  return coreBridge.setListenerGreeted(streamVideoId, listenerChannelId, !!value);
});

ipcMain.handle('comments-set-responded', async function (_event, commentId, value) {
  return coreBridge.setCommentResponded(commentId, !!value);
});

// 2026-05-09 仕様変更: 旧 BAN を「コメ非表示 / リスナー非表示」2 軸独立に置換。
// listeners.db から name/icon を補完して app_config.hidden_listeners に保存。
ipcMain.handle('listeners-set-hidden', async function (_event, channelId, hideFromComments, hideFromListeners) {
  return coreBridge.setListenerHidden(channelId, !!hideFromComments, !!hideFromListeners);
});

ipcMain.handle('listeners-streams', async function (_event, query) {
  return coreBridge.listStreams(query || {});
});

ipcMain.handle('listeners-delete-streams', async function (_event, videoIds) {
  return coreBridge.deleteStreams(Array.isArray(videoIds) ? videoIds : []);
});

ipcMain.handle('listeners-stream-detail', async function (_event, videoId, recentCommentLimit) {
  return coreBridge.getStreamDetail(videoId, recentCommentLimit);
});

ipcMain.handle('listeners-search-comments', async function (_event, query) {
  return coreBridge.searchComments(query || {});
});

ipcMain.handle('listeners-stream-listeners', async function (_event, videoId, query) {
  return coreBridge.listStreamListeners(videoId || '', query || {});
});

ipcMain.handle('listeners-stream-stats', async function (_event, videoId, binMinutes) {
  return coreBridge.getStreamStats(videoId || '', binMinutes);
});

ipcMain.handle('listeners-comment-chip-counts', async function (_event, videoId) {
  return coreBridge.getCommentChipCounts(videoId || '');
});

ipcMain.handle('listeners-listener-chip-counts', async function (_event, channelId, contextVideoId) {
  return coreBridge.getListenerChipCounts(channelId || '', contextVideoId || '');
});

ipcMain.handle('listeners-listener-superchats', async function (_event, channelId, limit) {
  return coreBridge.listListenerSuperchats(channelId || '', typeof limit === 'number' ? limit : 200);
});

ipcMain.handle('listeners-listener-comments-in-stream', async function (_event, channelId, streamVideoId, limit) {
  return coreBridge.listListenerCommentsInStream(
    channelId || '',
    streamVideoId || '',
    typeof limit === 'number' ? limit : 1000,
  );
});

ipcMain.handle('listeners-search-rank-counts', async function (_event, baselineVideoId) {
  return coreBridge.getListenerSearchRankCounts(baselineVideoId || '');
});

ipcMain.handle('listeners-stream-scoped-counts', async function (_event, streamVideoId, q) {
  return coreBridge.getStreamScopedListenerCounts(streamVideoId || '', q == null ? null : String(q));
});

ipcMain.handle('listeners-stream-listener-pill-counts', async function (_event, videoId, query) {
  return coreBridge.getStreamListenerPillCounts(videoId || '', query || {});
});

ipcMain.handle('listeners-get-tags', async function (_event, channelId) {
  return coreBridge.getListenerTags(channelId || '');
});

ipcMain.handle('listeners-set-tags', async function (_event, channelId, tags) {
  return coreBridge.setListenerTags(channelId || '', Array.isArray(tags) ? tags : []);
});

ipcMain.handle('listeners-list-all-tags', async function () {
  return coreBridge.listAllListenerTags();
});

ipcMain.handle('listeners-list-all-tag-assignments', async function () {
  return coreBridge.listAllListenerTagAssignments();
});

ipcMain.handle('streams-get-tags', async function (_event, videoId) {
  return coreBridge.getStreamTags(videoId || '');
});

ipcMain.handle('streams-set-tags', async function (_event, videoId, tags) {
  return coreBridge.setStreamTags(videoId || '', Array.isArray(tags) ? tags : []);
});

ipcMain.handle('streams-list-all-tags', async function () {
  return coreBridge.listAllStreamTags();
});

ipcMain.handle('streams-list-all-tag-assignments', async function () {
  return coreBridge.listAllStreamTagAssignments();
});

ipcMain.handle('streams-rename-tag', async function (_event, oldName, newName) {
  return coreBridge.renameStreamTag(oldName || '', newName || '');
});

ipcMain.handle('streams-delete-tag', async function (_event, name) {
  return coreBridge.deleteStreamTag(name || '');
});

ipcMain.handle('listeners-rename-tag', async function (_event, oldName, newName) {
  return coreBridge.renameListenerTag(oldName || '', newName || '');
});

ipcMain.handle('listeners-delete-tag', async function (_event, name) {
  return coreBridge.deleteListenerTag(name || '');
});

ipcMain.handle('listeners-list-saved-searches', async function (_event, scope) {
  return coreBridge.listSavedSearches(scope || 'comment-search');
});

ipcMain.handle('listeners-create-saved-search', async function (_event, scope, name, conditions) {
  var json = (conditions && typeof conditions === 'object')
    ? JSON.stringify(conditions)
    : (typeof conditions === 'string' ? conditions : '{}');
  return coreBridge.createSavedSearch(scope || 'comment-search', name || '', json);
});

ipcMain.handle('listeners-update-saved-search', async function (_event, id, patch) {
  var p = patch || {};
  var conditions = (p.conditions != null && typeof p.conditions === 'object')
    ? JSON.stringify(p.conditions)
    : (typeof p.conditions === 'string' ? p.conditions : null);
  return coreBridge.updateSavedSearch(
    Number(id) | 0,
    typeof p.name === 'string' ? p.name : null,
    conditions,
    typeof p.sortOrder === 'number' ? p.sortOrder : null
  );
});

ipcMain.handle('listeners-delete-saved-search', async function (_event, id) {
  return coreBridge.deleteSavedSearch(Number(id) | 0);
});

// --- フェーズ 3.3: こめはぶ形式 JSON Lines エクスポート / インポート ---

ipcMain.handle('listeners-export-jsonl', async function () {
  // ファイル保存ダイアログ → 選択されたパスへ Rust が直接書き出す
  var defaultName = 'komehub-listeners-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl';
  var result = await dialog.showSaveDialog({
    title: 'こめはぶ形式エクスポート (JSON Lines)',
    defaultPath: defaultName,
    filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  return coreBridge.exportKomehubJsonl(result.filePath);
});

ipcMain.handle('listeners-import-jsonl', async function () {
  var result = await dialog.showOpenDialog({
    title: 'こめはぶ形式インポート (JSON Lines)',
    properties: ['openFile'],
    filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  return coreBridge.importKomehubJsonl(result.filePaths[0]);
});

ipcMain.handle('listeners-import-from-onecomme', async function () {
  var dir = await pickOnecommeDirectory();
  if (!dir) return { ok: false, canceled: true };
  var result = await coreBridge.importFromOnecomme(dir);
  // 成功したらパスを記憶 (次回 export で再利用、起動時自動同期にも使う)
  if (result && result.ok) store.set('onecommeDir', dir);
  return result;
});

// 配信ログ「更新」ボタン等から、タイトル等が未取得の自チャ過去枠を resolver で再取得する。
// fire-and-forget (= Rust 側で対象を SELECT、無ければ no-op、補完できた枠は SSE で UI 反映)。
ipcMain.handle('listeners-backfill-stream-meta', function () {
  coreBridge.backfillStreamMeta();
  return true;
});

ipcMain.handle('listeners-export-to-onecomme', async function () {
  var dir = await pickOnecommeDirectory();
  if (!dir) return { ok: false, canceled: true };
  var result = await coreBridge.exportToOnecomme(dir);
  if (result && result.ok) store.set('onecommeDir', dir);
  return result;
});

ipcMain.handle('listeners-detect-onecomme-running', async function () {
  return coreBridge.detectOnecommeRunning();
});

ipcMain.handle('listeners-run-bidirectional-sync', async function () {
  var dir = await pickOnecommeDirectory();
  if (!dir) return { ok: false, canceled: true };
  var result = await coreBridge.runBidirectionalSync(dir);
  if (result && result.ok) store.set('onecommeDir', dir);
  return result;
});

// わんコメ DB リセット検出後、 watermark をクリア (= 次回 export で全件書き直し)
ipcMain.handle('listeners-reset-onecomme-watermarks', async function (_event, onecommeDir) {
  var dir = onecommeDir || store.get('onecommeDir') || '';
  return await coreBridge.resetOnecommeWatermarks(dir);
});

ipcMain.handle('listeners-delete', async function (_event, channelIds) {
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return { ok: false, error: 'channelIds is empty' };
  }
  return await coreBridge.deleteListeners(channelIds);
});

ipcMain.handle('listeners-get-auto-sync-settings', async function () {
  return {
    autoImportOnStart: !!store.get('autoImportOnStart'),
    autoExportEnabled: !!store.get('autoExportEnabled')
  };
});

ipcMain.handle('listeners-set-auto-sync-settings', async function (_event, settings) {
  if (settings && typeof settings.autoImportOnStart === 'boolean') {
    store.set('autoImportOnStart', settings.autoImportOnStart);
  }
  if (settings && typeof settings.autoExportEnabled === 'boolean') {
    store.set('autoExportEnabled', settings.autoExportEnabled);
  }
  return {
    ok: true,
    autoImportOnStart: !!store.get('autoImportOnStart'),
    autoExportEnabled: !!store.get('autoExportEnabled')
  };
});

ipcMain.handle('onboarding-get-state', function () {
  return getOnboardingState();
});

ipcMain.handle('onboarding-set-state', function (_event, patch) {
  return updateOnboardingState(patch || {});
});

ipcMain.handle('onboarding-reset', function () {
  store.delete('onboardingState');
  return getOnboardingState();
});

// ヘッダーの「準備」ボタンを出すべきか (= 自動オープンと同じ判定)。
// dismissed / 全ステージ完了 / 経験者 (自チャンネル・接続実績あり) のいずれかなら false。
ipcMain.handle('onboarding-should-show-entry', function () {
  return onboardingPending();
});

/**
 * わんコメデータディレクトリの自動検出。
 * OS 標準の userData 配置 (`%APPDATA%/onecomme` 等) を試し、
 * `onecomme.db` または `comments.db` のどちらかが存在すれば採用する。
 * 見つからなければ null を返す (呼び出し側でフォルダ選択 dialog にフォールバック)。
 */
function detectOnecommeDirectory() {
  var candidates = [path.join(app.getPath('appData'), 'onecomme')];
  for (var i = 0; i < candidates.length; i++) {
    var dir = candidates[i];
    try {
      if (!fs.existsSync(dir)) continue;
      var hasOnecommeDb = fs.existsSync(path.join(dir, 'onecomme.db'));
      var hasCommentsDb = fs.existsSync(path.join(dir, 'comments.db'));
      if (hasOnecommeDb || hasCommentsDb) return dir;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * 起動時のリスナー自動同期 (F-20)。
 * 保存済み onecommeDir → 自動検出の順に解決し、見つからなければ skip する。
 * 配信中・わんコメ起動中・自チャンネル未設定はすべて Rust 側で判定して skip される。
 * 失敗しても起動を妨げないよう catch で握る。
 */
function triggerStartupListenerSync() {
  if (isDemo) {
    L.info('Skip startup listener sync: demo mode');
    return;
  }
  var onecommeDir = store.get('onecommeDir');
  if (!onecommeDir || !fs.existsSync(onecommeDir)) {
    onecommeDir = detectOnecommeDirectory();
    if (onecommeDir) {
      store.set('onecommeDir', onecommeDir);
      L.info('Auto-detected onecommeDir for startup sync:', onecommeDir);
    } else {
      L.info('Skip startup listener sync: onecommeDir not detected');
      return;
    }
  }
  var importEnabled = store.get('autoImportOnStart');
  if (!importEnabled) {
    L.info('Skip startup listener sync: autoImportOnStart is off');
    return;
  }
  // startup sync は **import のみ** に変更 (2026-05-16 改修)。 起動時の自動 export は
  // 廃止し、 書き戻しは close 時の shutdown export に集約する:
  //   - 接続中コメは shutdown export で拾える (= 漏れ防止)
  //   - 「2 回書き戻し」 が見えていた UX 問題も解消
  //   - 前回 close が異常終了で書き戻し漏れがあった場合の救済は ListenerManager::open()
  //     時の data_dirty 初期化 (= MAX(posted_at) > watermark) で対応
  L.info('Triggering startup listener sync (import only):', onecommeDir);
  startupSyncInProgress = true;
  sendToRenderer('startup-sync-progress', { phase: 'started', importEnabled: true, exportEnabled: false });
  setTimeout(async function () {
    try {
      L.info('Startup sync: invoking coreBridge.importFromOnecomme()');
      sendToRenderer('startup-sync-progress', { phase: 'import-started' });
      var imp = await coreBridge.importFromOnecomme(onecommeDir);
      if (imp && imp.ok) {
        L.info('Startup import completed');
        sendToRenderer('startup-sync-progress', { phase: 'import-completed', summary: imp.summary || null });
      } else {
        L.warn('Startup import result:', JSON.stringify(imp).slice(0, 200));
        sendToRenderer('startup-sync-progress', { phase: 'import-failed', error: (imp && imp.error) || 'unknown' });
      }
      sendToRenderer('startup-sync-progress', { phase: 'done' });
    } catch (err) {
      L.warn('Startup listener sync failed:', err && err.message ? err.message : err);
      sendToRenderer('startup-sync-progress', { phase: 'error', error: err && err.message ? err.message : String(err) });
    } finally {
      startupSyncInProgress = false;
      // close が deferred されていた場合は通常 close 経路に進める。
      // close ハンドラ内で data_dirty を判定して shutdown export を実行 / skip する
      // (= 接続中コメがあれば shutdown export で拾う、 なければ即終了)。
      if (pendingCloseDuringStartup) {
        pendingCloseDuringStartup = false;
        L.info('Startup sync completed, proceeding with deferred close');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.close();
        }
      }
    }
  }, 3000);
}

/**
 * わんコメフォルダを取得する。
 * 1) 保存済みパス (検証成功) を最優先。
 * 2) 標準位置 (%APPDATA%/onecomme 等) の自動検出を試す。検出時は store に保存。
 * 3) どちらも空振りなら dialog でユーザーに選択させる (検出 fallback)。
 */
async function pickOnecommeDirectory() {
  var saved = store.get('onecommeDir');
  if (saved && fs.existsSync(saved)) {
    return saved;
  }
  var detected = detectOnecommeDirectory();
  if (detected) {
    store.set('onecommeDir', detected);
    L.info('Auto-detected onecommeDir:', detected);
    return detected;
  }
  var defaultDir = path.join(app.getPath('appData'), 'onecomme');
  var result = await dialog.showOpenDialog({
    title: 'わんコメデータフォルダを選択 (comments.db / onecomme.db を含むディレクトリ)',
    defaultPath: fs.existsSync(defaultDir) ? defaultDir : undefined,
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}

ipcMain.handle('listeners-get-onecomme-status', async function () {
  var saved = store.get('onecommeDir');
  var detected = saved && fs.existsSync(saved) ? saved : detectOnecommeDirectory();
  var running = { running: false };
  if (coreBridge.isRunning()) {
    try {
      running = await coreBridge.detectOnecommeRunning();
    } catch (err) {
      L.warn('Failed to detect OneComme status for onboarding:', err && err.message ? err.message : err);
    }
  }
  return {
    onecommeDir: detected || '',
    hasDirectory: !!detected,
    running: !!(running && running.running)
  };
});

// --- トリガー判定エンジン IPC ---

ipcMain.handle('trigger-manual', function (_event, sceneId, performanceId) {
  if (!coreBridge.isRunning()) return false;
  coreBridge.triggerManual(sceneId, performanceId);
  return true;
});

ipcMain.handle('clear-performances', function (_event, sceneId) {
  if (!coreBridge.isRunning()) return { ok: false };
  return coreBridge.clearPerformances(sceneId);
});

ipcMain.handle('trigger-test', function (_event, sceneId, performanceId) {
  return coreBridge.triggerTest(sceneId, performanceId);
});

ipcMain.handle('trigger-test-with-context', function (_event, sceneId, performanceId, context) {
  return coreBridge.triggerTestWithContext(sceneId, performanceId, context);
});

ipcMain.handle('trigger-test-reaction', function (_event, sceneId, performanceId) {
  return coreBridge.triggerTestReaction(sceneId, performanceId);
});

ipcMain.handle('trigger-test-reaction-custom', function (_event, sceneId, performanceId, reactionKey) {
  return coreBridge.triggerTestReactionCustom(sceneId, performanceId, reactionKey);
});

ipcMain.handle('send-template-test-comment', function (_event, sceneId, context) {
  return coreBridge.sendTemplateTestComment(sceneId, context);
});

ipcMain.handle('set-paused', function (_event, paused) {
  coreBridge.pushPaused(paused);
  return true;
});

ipcMain.handle('get-paused', function () {
  return coreBridge.getPaused();
});

ipcMain.handle('reload-overlays', function () {
  coreBridge.broadcastReload();
  return true;
});

ipcMain.handle('get-global-cooldown', function () {
  return coreBridge.getGlobalCooldown();
});

ipcMain.handle('set-global-cooldown', function (_event, settings) {
  if (coreBridge.isRunning()) {
    coreBridge.pushGlobalCooldown(settings);
  }
  return true;
});

ipcMain.handle('get-membership-gift-pricing', function () {
  return coreBridge.getMembershipGiftPricing();
});

ipcMain.handle('set-membership-gift-pricing', function (_event, settings) {
  return coreBridge.setMembershipGiftPricing(settings);
});

ipcMain.handle('get-listener-classification-config', function () {
  return coreBridge.getListenerClassificationConfig();
});

ipcMain.handle('set-listener-classification-config', function (_event, settings) {
  if (coreBridge.isRunning()) {
    return coreBridge.setListenerClassificationConfig(settings);
  }
  return settings;
});

// --- TTS 読み上げ IPC ---

ipcMain.handle('tts-get-settings', function () {
  return coreBridge.getTtsSettings();
});

ipcMain.handle('tts-save-settings', function (_event, patch) {
  L.info('IPC tts-save-settings invoked, patch=', patch ? JSON.stringify(patch) : '(null)');
  return coreBridge.setTtsSettings(patch || {});
});

ipcMain.handle('tts-get-state', function () {
  return coreBridge.getTtsState();
});

ipcMain.handle('tts-set-enabled', function (_event, enabled) {
  L.info('IPC tts-set-enabled invoked, enabled=', enabled);
  return coreBridge.setTtsEnabled(enabled);
});

ipcMain.handle('tts-set-paused', function (_event, paused) {
  return coreBridge.setTtsPaused(paused);
});

ipcMain.handle('tts-clear', function () {
  return coreBridge.clearTts();
});

ipcMain.handle('tts-test-speech', function (_event, text) {
  return coreBridge.testTtsSpeech(text);
});

ipcMain.handle('tts-get-voices', async function (_event, provider) {
  return coreBridge.getTtsVoices(provider);
});

ipcMain.handle('tts-check-provider', async function (_event, provider) {
  return coreBridge.checkTtsProvider(provider);
});

ipcMain.handle('tts-launch-provider', async function (_event, provider) {
  return coreBridge.launchTtsProvider(provider);
});

ipcMain.handle('tts-detect-provider-executable', async function (_event, provider) {
  return coreBridge.detectTtsProviderExecutable(provider);
});

ipcMain.handle('tts-get-audio-outputs', async function () {
  return coreBridge.getTtsAudioOutputs();
});

ipcMain.handle('tts-select-executable', async function (_event, provider) {
  var label = provider === 'voicevox' ? 'VOICEVOX' : (provider === 'bouyomi' ? '棒読みちゃん' : '読み上げソフト');
  return chooseSingleFilePath(label + ' の起動ファイルを選択', [
    { name: '実行ファイル', extensions: ['exe'] },
    { name: 'すべてのファイル', extensions: ['*'] }
  ]);
});

// --- コメント通知 IPC (Phase C: Rust 経由) ---
// Phase A は electron-store 完結だったが、 Phase C で Rust 側 AppConfig に正本を移行。
// 起動時 migration (= app.whenReady 内) で electron-store の値を Rust に push し、
// 以降は Rust app-config.json が正本。 electron-store の値は読み捨て (= 削除はしない)。

function summarizeNotificationState(settings) {
  // notificationGetState は Rust が「サマリ」 を返してくれるが、 save-settings 系は
  // settings 全体を返す。 renderer 側がバッジ表示に必要な enabledEventCount/totalEventCount
  // を毎回計算しなくて済むよう、 ここで再集計して state 形に揃える。
  if (!settings || typeof settings !== 'object') {
    return { enabled: false, paused: false, provider: 'builtin', enabledEventCount: 0, totalEventCount: 8 };
  }
  var events = settings.events || {};
  var ids = Object.keys(events);
  var enabledCount = ids.filter(function (id) { return events[id] && events[id].enabled; }).length;
  return {
    enabled: !!settings.enabled,
    paused: !!settings.paused,
    provider: settings.provider || 'builtin',
    enabledEventCount: enabledCount,
    totalEventCount: ids.length || 8
  };
}

ipcMain.handle('notification-get-settings', function () {
  return coreBridge.getNotificationSettings();
});

ipcMain.handle('notification-save-settings', function (_event, patch) {
  L.info('IPC notification-save-settings invoked, patch=', patch ? JSON.stringify(patch) : '(null)');
  return coreBridge.setNotificationSettings(patch || {});
});

ipcMain.handle('notification-get-state', async function () {
  var settings = await coreBridge.getNotificationSettings();
  return summarizeNotificationState(settings);
});

ipcMain.handle('notification-set-enabled', async function (_event, enabled) {
  L.info('IPC notification-set-enabled invoked, enabled=', enabled);
  return coreBridge.setNotificationEnabled(!!enabled);
});

ipcMain.handle('notification-set-paused', async function (_event, paused) {
  return coreBridge.setNotificationPaused(!!paused);
});

// 試聴 (= 設定モーダルの ▶ 試聴 ボタン)
ipcMain.handle('notification-test-sound', function (_event, file, volume, outputDevice) {
  return coreBridge.testNotificationSound(file || '', volume, outputDevice || '');
});

// プレビュー (= 設定モーダルの ▶ プレビュー ボタン)
ipcMain.handle('notification-preview-tts', function (_event, text, provider, outputDevice) {
  return coreBridge.previewNotificationTts(text || '', provider || 'builtin', outputDevice || '');
});

// 通知音用の出力デバイス一覧 (= TTS の出力デバイスとは別系統 = cpal name)
ipcMain.handle('notification-list-sound-devices', function () {
  return coreBridge.listNotificationSoundDevices();
});

// プリセット音源 8 種の一覧 (= Phase D-2)。
// effects-overlay/notification-sounds/ の場所は配布バイナリ / 開発時で違うので main.js で解決。
ipcMain.handle('notification-list-sound-presets', function () {
  var presetsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'effects-overlay', 'notification-sounds')
    : path.join(__dirname, '..', 'effects-overlay', 'notification-sounds');
  return coreBridge.listNotificationSoundPresets(presetsDir);
});

// 8 イベント毎の default テンプレ文言 + sound preset id (= 旧 JS NOTIFICATION_EVENT_DEFS
// 内に二重正本があった tplDefault / soundPreset の Rust 正本一元化)。 renderer.js 起動時に
// 1 度 fetch して module-scoped cache に入れる。
ipcMain.handle('notification-get-event-defaults', function () {
  return coreBridge.getNotificationEventDefaults();
});

// 「デフォルトに戻す」 用: 出荷シーンプリセット (electron/defaults/scenes/<sceneId>.json) の
// 該当 performance を返す。 ビルトイン演出 (= 初見歓迎 等) のリセット先をプラグイン汎用既定
// (= card 等) ではなくシーンプリセット (= ネオン看板 等) にするため。 該当なしは null を返し、
// renderer 側は manifest 既定に fallback する。 defaults パス解決は coreBridge.setAppRootDir と同じ。
ipcMain.handle('get-default-performance', function (event, sceneId, performanceId) {
  try {
    var appRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
    var scenePath = path.join(appRoot, 'electron', 'defaults', 'scenes', sceneId + '.json');
    if (!fs.existsSync(scenePath)) return null;
    var scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    var perfs = (scene && scene.performances) || [];
    for (var i = 0; i < perfs.length; i++) {
      if (perfs[i].id === performanceId) return perfs[i];
    }
    return null;
  } catch (e) {
    L.warn('get-default-performance failed (scene=' + sceneId + ', perf=' + performanceId + '): ' + e.message);
    return null;
  }
});

// Phase D-3: SAPI token → cpal name 対応表を再構築 (= TTS の出力デバイス設定値で
// 通知音側 (rodio) も同じ物理デバイスに鳴らすため、 起動時 + UI mousedown 連動で呼ぶ)。
ipcMain.handle('notification-refresh-device-map', function () {
  return coreBridge.refreshNotificationSoundDeviceMap();
});

// ファイル選択ダイアログ (wav/mp3/ogg/flac)
ipcMain.handle('notification-pick-sound-file', function () {
  return chooseSingleFilePath('通知音ファイルを選択', [
    { name: '音声ファイル', extensions: ['wav', 'mp3', 'ogg', 'flac'] },
    { name: 'すべてのファイル', extensions: ['*'] }
  ]);
});

// --- バックアップ管理 ---

ipcMain.handle('get-backup-list', function () {
  return coreBridge.getBackupList();
});

ipcMain.handle('create-backup', function (_event, options) {
  return coreBridge.createBackup(options);
});

ipcMain.handle('create-full-backup', function (_event, name) {
  return coreBridge.createFullBackup(name);
});

ipcMain.handle('restore-backup', function (_event, backupId) {
  if (!coreBridge.isRunning()) return { restored: false, error: 'Rust core not running' };
  return coreBridge.restoreBackup(backupId);
});

// 復元前の「データの規模を確認して強めの警告を出すかどうか」 判定用。
// Rust 側で listeners.db に対する SELECT COUNT(*) を実行し、 コメント / リスナー件数を返す
// (= ファイルパスを JS に露出させないため Rust 経由)。
ipcMain.handle('get-data-overview', function () {
  return coreBridge.getDataOverview();
});

ipcMain.handle('delete-backup', function (_event, backupId) {
  return coreBridge.deleteBackup(backupId);
});

ipcMain.handle('get-backups-dir', function () {
  return coreBridge.getBackupsDir();
});

ipcMain.handle('set-backups-dir', async function () {
  var newDir = await chooseDirectoryPath('バックアップフォルダを選択');
  if (!newDir) return null;
  coreBridge.setBackupsDir(newDir);
  return newDir;
});

ipcMain.handle('reset-backups-dir', function () {
  coreBridge.setBackupsDir('');
  return true;
});

ipcMain.handle('reset-app', async function (_event, kind) {
  return await resetAndRelaunch(kind);
});
// 後方互換: 旧 reset-all-settings は完全初期化に委譲
ipcMain.handle('reset-all-settings', async function () {
  return await resetAndRelaunch('all');
});

// 多重起動防止
var gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    app.whenReady().then(async function () {
      if (hasUsableMainWindow()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        if (!singleInstanceDialogOpen) {
          singleInstanceDialogOpen = true;
          try {
            await dialog.showMessageBox(mainWindow, {
              type: 'info',
              buttons: ['OK'],
              defaultId: 0,
              noLink: true,
              message: 'Live Comment Hub は既に起動しています。',
              detail: '既存のウィンドウを前面に表示しました。'
            });
          } finally {
            singleInstanceDialogOpen = false;
          }
        }
        return;
      }

      if (singleInstanceDialogOpen) return;
      singleInstanceDialogOpen = true;
      try {
        var result = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['終了して再起動', 'キャンセル'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          message: '既存インスタンスが異常な状態で残っています。',
          detail: [
            'メインウィンドウが無いまま単一インスタンスロックだけが残っています。',
            'このままでは新しい起動を引き継げないため、既存プロセスを終了して再起動できます。',
            '検出状態: ' + describeStaleInstanceState()
          ].join('\n')
        });
        if (result.response !== 0) {
          L.warn('Stale instance recovery was cancelled by user');
          return;
        }

        L.warn('Restarting from stale single-instance lock state');
        app.relaunch();
        await shutdownApp('stale-single-instance-restart');
        app.quit();
      } finally {
        singleInstanceDialogOpen = false;
      }
    }).catch(function (err) {
      L.error('Failed to handle second-instance event:', err && err.message ? err.message : err);
    });
  });

  app.whenReady().then(function () {
    // パス初期化
    userDataDir = app.getPath('userData');
    userAssetsDir = path.join(userDataDir, 'assets');
    userFramesDir = path.join(userAssetsDir, 'frames');
    presetsDir = path.join(userDataDir, 'presets');

    // ロガー初期化
    // 通常運用は info 固定、 設定画面「デバッグ・サポート」 で ON にした時のみ
    // trace まで落とす (= app-config.json の debugLoggingEnabled を直接 peek、
    // Rust 側 logging::peek_debug_logging_enabled と同じ方式)。
    // 詳細仕様: docs/logging.md。
    var logDir = path.join(userDataDir, 'logs');
    var debugLoggingEnabled = peekDebugLoggingEnabled(userDataDir);
    log.init(logDir, { level: debugLoggingEnabled ? 'trace' : 'info' });

    // 設定初期化は Local Storage 等のロックを避けるため、再起動直後に実行する。
    performPendingResetIfNeeded();

    // 言語初期化
    var savedLang = store.get('language');
    if (savedLang) {
      i18n.setLanguage(savedLang);
    } else {
      i18n.setLanguage(app.getLocale());
    }

    // データマイグレーション
    var currentVersion = require('../package.json').version;
    migration.run(store, userDataDir, currentVersion);

    initUserAssets();

    // Rust サイドカー起動（演出エンジン主系統）
    // main window 作成は core init 結果を待ってから (= EADDRINUSE 等で壊れ画面を出さない)。
    // 通常 ~300ms で onReady なので体感ロスは小さい。失敗時はダイアログ → 終了で完結する。
    // EADDRINUSE 自動復旧フローのため、options を変数化して retry 時に再利用できるように。
    var zombieRecoveryAttempted = false;
    // アップグレード受け渡し (= 旧版終了 → 新版即起動) の隙間で旧コアの port 解放が
    // 間に合わない一過性 EADDRINUSE を、 短い遅延 + 数回のバインド再試行で無音吸収する。
    // kill 対象が居る恒久ゾンビは attemptZombieRecovery 側で処理する。
    var transientBindRetries = 0;
    var MAX_TRANSIENT_BIND_RETRIES = 5;
    var TRANSIENT_BIND_RETRY_DELAY_MS = 1500;
    // 一過性 EADDRINUSE (= no_listen / no_descendants 等、 倒す相手が居ないレース) で
    // バインドをやり直す。 ポートは数秒で解放されるので PC 再起動は不要
    // (= memory `feedback_user_capability_assumption`)。 上限超過で初めて致命ダイアログ。
    function retryTransientBind(err, reason) {
      if (transientBindRetries >= MAX_TRANSIENT_BIND_RETRIES) {
        L.warn('Transient EADDRINUSE: retries exhausted (' + transientBindRetries + '), giving up');
        showFatalCoreErrorDialog('EADDRINUSE', err, { recovered: false, reason: reason || 'transient_exhausted' });
        return;
      }
      transientBindRetries += 1;
      L.info('Transient EADDRINUSE (reason=' + (reason || 'unknown') + '): retry '
        + transientBindRetries + '/' + MAX_TRANSIENT_BIND_RETRIES + ' in '
        + TRANSIENT_BIND_RETRY_DELAY_MS + 'ms');
      setTimeout(function () {
        coreBridge.start(coreStartOptions);
      }, TRANSIENT_BIND_RETRY_DELAY_MS);
    }
    var coreStartOptions = {
      dataDir: userDataDir,
      onReady: function (port) {
        L.info('Rust core ready on port', port);
        // ここで初めて main window を作る (= 壊れ画面を出さないための主目的)
        createMainWindow();
        sendToRenderer('port', port);
        coreReady = true;
        // renderer が既に準備完了を通知済みなら即送信
        if (rendererReady) {
          sendToRenderer('core-ready');
        }
        // 集約版 broadcast (新規 API。後から開いた window も pull で同等情報を取れる)
        broadcastCoreStatus();

        // 初期状態をコアエンジンに同期
        coreBridge.setAppRootDir(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'));

        // OBS ブラウザソースにリロード指示
        // テンプレート JS/CSS のキャッシュバスター更新のため起動時に必須
        coreBridge.broadcastReload();

        // わんコメ書き戻し import で未知 video_id の owner を Cookie 共有 fetch で解決する
        // resolver を Rust core に登録 (= triggerStartupListenerSync の前に必須)
        try {
          coreBridge.registerVideoOwnerResolver(resolveVideoOwnersForImport);
        } catch (err) {
          L.warn('registerVideoOwnerResolver failed: ' + (err && err.message ? err.message : err));
        }

        // 空 title/channel_name の自チャ過去枠を起動時に resolver で後追い補完 (= backfill、
        // fire-and-forget)。resolver 登録後に呼ぶ (= 未登録なら Rust 側で no-op)。完了時に
        // SSE stream-meta-repaired が飛んで 配信ログ UI が更新される。
        try {
          coreBridge.backfillStreamMeta();
        } catch (err) {
          L.warn('backfillStreamMeta failed: ' + (err && err.message ? err.message : err));
        }

        // import_from_onecomme の中間進捗を receive して renderer フッタに転送
        try {
          coreBridge.registerImportProgressReporter(function (err, jsonStr) {
            if (err || !jsonStr) return;
            try {
              var payload = JSON.parse(jsonStr);
              sendToRenderer('import-progress', payload);
            } catch (e) {
              L.warn('Failed to parse import-progress JSON: ' + (e && e.message ? e.message : e));
            }
          });
        } catch (err) {
          L.warn('registerImportProgressReporter failed: ' + (err && err.message ? err.message : err));
        }

        // export_to_onecomme の中間進捗を receive して renderer に転送
        // (起動時 sync の export phase / 終了時 shutdown export 両方で同じ経路)
        // 進捗到達のたびに lastExportProgressAt を更新 = shutdown export の stall 監視に使う
        try {
          coreBridge.registerExportProgressReporter(function (err, jsonStr) {
            if (err || !jsonStr) return;
            lastExportProgressAt = Date.now();
            try {
              var payload = JSON.parse(jsonStr);
              sendToRenderer('export-progress', payload);
            } catch (e) {
              L.warn('Failed to parse export-progress JSON: ' + (e && e.message ? e.message : e));
            }
          });
        } catch (err) {
          L.warn('registerExportProgressReporter failed: ' + (err && err.message ? err.message : err));
        }

        // Step 3 フェーズ 3.5: 起動時のリスナー自動同期 (F-20)
        // わんコメ未起動・配信中でない・自チャンネル設定済み・前回 onecommeDir
        // 設定済みの 4 条件すべてで実行する。
        // Rust 側の RunBidirectionalSync ハンドラが内部で再度判定するので、
        // ここでは onecommeDir 設定の有無だけ確認すれば十分。
        triggerStartupListenerSync();

        // Phase D-3: SAPI token → cpal name の対応表を 1 回構築 (= TTS の outputDevice
        // 値で通知音側 (rodio) も同じデバイスに鳴らすため)。 PowerShell SAPI を呼ぶので
        // 数百 ms かかるが startup の重要動作はすでに完了しているので非同期で進める。
        coreBridge.refreshNotificationSoundDeviceMap().then(function (result) {
          if (result && result.ok) {
            L.info('notification: SAPI→cpal device map built, size=' + result.size);
          }
        }).catch(function (err) {
          L.warn('notification device map refresh failed: ' + (err && err.message ? err.message : err));
        });

        // 初期セットアップを実行しない場合でも、設定済みテンプレートは文字化けせず表示できるようにする。
        ensureConfiguredTemplateFontsInBackground();
      },
      onError: function (err) {
        L.error('Rust core error:', err && err.message ? err.message : err);
        var code = err && err.code ? err.code : 'EUNKNOWN';
        var port = err && typeof err.port === 'number' ? err.port : null;

        // EADDRINUSE 復旧:
        //   (1) 恒久ゾンビ = 死んだハブ親 PID の子プロセス (= かつての VOICEVOX 等) が
        //       socket handle を継承して LISTEN を保持しているケース
        //       (= memory `project_zombie_listen_root_cause`)。 初回だけ probe し、
        //       倒せる相手が居れば taskkill /T /F で解放 (admin 不要) → 再起動。
        //   (2) 一過性レース = アップグレード受け渡し等で旧コアの port 解放が間に合わず、
        //       倒す相手も居ない (no_listen / no_descendants) ケース。 ポートは数秒で
        //       解放されるので、 PC 再起動ダイアログを出す前にバインドを数回リトライする。
        if (code === 'EADDRINUSE' && port != null) {
          if (!zombieRecoveryAttempted) {
            zombieRecoveryAttempted = true;
            attemptZombieRecovery(port).then(function (result) {
              if (result && result.recovered) {
                L.info('Zombie recovery succeeded, retrying core init');
                coreBridge.start(coreStartOptions);
                return;
              }
              // 別アプリが本当に 11280 を使用中 → リトライ無意味、 即ダイアログ
              if (result && result.reason === 'owner_alive') {
                showFatalCoreErrorDialog(code, err, result);
                return;
              }
              // 倒す相手が居ない一過性レース → バインド再試行
              retryTransientBind(err, result && result.reason);
            }).catch(function (e) {
              L.error('Zombie recovery threw:', e && e.message ? e.message : e);
              retryTransientBind(err, 'probe_exception');
            });
            return;
          }
          // リトライ後もまだ握られている → さらにリトライ (上限到達で致命ダイアログ)
          retryTransientBind(err, 'still_in_use');
          return;
        }

        showFatalCoreErrorDialog(code, err, null);
      },
      onStaticUpdate: function (path, data) {
        if (path === 'connection') {
          sendToRenderer('status', {
            connected: !!(data && data.connected),
            videoId: data && data.videoId ? data.videoId : currentVideoId,
            // リモート閲覧 redesign §5.3: 自チャンネル枠かどうか (= push_connection_status
            // helper が injection 済み)。本体 renderer.js は対応済み/挨拶済みトグルの
            // 表示判定にこのフラグを使う
            isOwnStream: !!(data && data.isOwnStream),
            message: currentConnectionMessage
          });
        }
        // フルバックアップ進捗通知 + 'done' phase で scenes 再 broadcast
        // (= 復元後の renderer state を refresh するため、 scene 作成系の通常経路と
        // 干渉しないよう backup-progress 'done' でだけ発火させる)
        if (path === 'backup-progress' && data && data.phase === 'done') {
          broadcastScenesChanged({ kind: 'restore-completed' });
        }
        // Step 3 フェーズ 3.2a: リスナー記録時の自動 UI 更新通知
        if (path === 'listener-updated') {
          sendToRenderer('listener-updated', data);
        }
        // 配信メタデータ更新 (動的値: 視聴数 / いいね数 / 登録者数)
        if (path === 'stream-metadata-updated') {
          sendToRenderer('stream-metadata-updated', data);
        }
        // リモート閲覧 redesign §7.4: 「対応済み」「挨拶済み」トグルを本体・remote 双方で同期
        if (path === 'comment-responded') {
          sendToRenderer('comment-responded', data);
        }
        if (path === 'listener-greeted') {
          sendToRenderer('listener-greeted', data);
        }
        // 2026-05-09 仕様変更: 非表示リスナー (= コメ非表示 / リスナー非表示) の更新通知
        if (path === 'listener-hidden') {
          sendToRenderer('listener-hidden', data);
        }
        // フルバックアップ進捗通知 (= モーダルダイアログのバー / パーセント更新)
        if (path === 'backup-progress') {
          sendToRenderer('backup-progress', data);
        }
        // わんコメ DB リセット / 巻き戻し検出 → renderer で警告モーダル
        if (path === 'onecomme-reset-detected') {
          sendToRenderer('onecomme-reset-detected', data);
        }
        // 毎コメ・毎メタデータ更新で発火する高頻度イベントは debug ログから除外
        // (中身が path 文字列だけで情報量が薄く、他の DEBUG ログを埋もれさせるため)。
        if (path !== 'listener-updated' && path !== 'stream-metadata-updated'
            && path !== 'comment-responded' && path !== 'listener-greeted'
            && path !== 'listener-hidden' && path !== 'backup-progress') {
          L.debug('Static update:', path);
        }
      },
      onSessionComment: function (data) {
        sendToRenderer('comment', data);
      },
      onSessionReaction: function (data) {
        sendToRenderer('reaction', data);
      },
      onCommentDeleted: function (data) {
        sendToRenderer('comment-deleted', data);
      },
      onTtsState: function (data) {
        sendToRenderer('tts-state', data);
      }
    };

    // デモモード: 専用データ dir に切り替え、デモ DB を seed + 画像配置してから core 起動。
    // 実データ dir (= userData/data) は一切触らない。
    if (isDemo) {
      var demoDir = path.join(userDataDir, 'demo-data');
      coreStartOptions.dataDir = demoDir;
      try {
        prepareDemoData(demoDir);
      } catch (e) {
        L.error('Demo data preparation failed:', e && e.message ? e.message : e);
      }
    }

    coreBridge.start(coreStartOptions);

    // APIクライアント数を定期的にUIに通知
    apiClientsInterval = setInterval(function () {
      sendToRenderer('api-clients', { count: coreBridge.getPublicClientCount() });
    }, 2000);

    // デモモード
    if (isDemo) {
      setTimeout(function () { startDemo(); }, 1500);
    }

    // 自動更新チェック（インストーラー版のみ）
    if (!isDemo && !process.env.PORTABLE_EXECUTABLE_DIR) {
      initAutoUpdater();
    }

    L.info('Initialization complete');
  });

  app.on('window-all-closed', async function () {
    await shutdownApp('window-all-closed');
    app.quit();
  });

  // 終了経路の網羅: before-quit / SIGINT / SIGTERM / SIGHUP のいずれでも
  // shutdownApp を確実に通して coreBridge.stop() (= Rust の listener 解放) まで走らせる。
  // これを入れない場合、タスクトレイ右クリック終了 / Win shutdown signal 等で
  // Rust core が握る LISTEN ソケットがゾンビとして残り、再起動時に EADDRINUSE で詰まる。
  function gracefulExit(reason, exitCode) {
    var code = typeof exitCode === 'number' ? exitCode : 0;
    Promise.resolve()
      .then(function () { return shutdownApp(reason); })
      .catch(function (err) {
        L.error('graceful exit error:', err && err.message ? err.message : err);
      })
      .then(function () { app.exit(code); });
  }

  app.on('before-quit', function (e) {
    if (shuttingDown) return;
    e.preventDefault();
    gracefulExit('before-quit', 0);
  });

  process.on('SIGINT', function () { gracefulExit('sigint', 0); });
  process.on('SIGTERM', function () { gracefulExit('sigterm', 0); });
  process.on('SIGHUP', function () { gracefulExit('sighup', 0); });
}

function initAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ベータチャンネル: バージョンに -beta が含まれるか、設定で有効化
  var version = require('../package.json').version;
  if (version.includes('-beta') || store.get('betaChannel', false)) {
    autoUpdater.channel = 'beta';
  }

  autoUpdater.on('update-available', function (info) {
    LU.info('Update available:', info.version);
    sendToRenderer('update-available', { version: info.version });
  });

  autoUpdater.on('update-not-available', function () {
    LU.info('No update available');
  });

  autoUpdater.on('download-progress', function (progress) {
    sendToRenderer('update-progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', function () {
    LU.info('Update downloaded');
    sendToRenderer('update-ready', {});
  });

  autoUpdater.on('error', function (err) {
    LU.error('Error:', err.message);
    sendToRenderer('update-error', { message: err.message });
  });

  // 起動5秒後にチェック（通知のみ）
  setTimeout(function () {
    autoUpdater.checkForUpdates().catch(function (err) {
      LU.warn('Check failed:', err.message);
    });
  }, 5000);
}

// デモ用データ dir に listeners.db を seed + デモ画像を media-cache に配置する。
// core init より前に同期実行する (= seed 完了後に core が DB を開く)。
function prepareDemoData(demoDir) {
  var appRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  var demoSrc = path.join(appRoot, 'demo');
  var imgDir = path.join(demoSrc, 'asset', 'img');
  var seedPath = path.join(demoSrc, 'demo-seed.json');
  var seedJson = fs.readFileSync(seedPath, 'utf8');
  demoSeed = JSON.parse(seedJson);

  // 画像を demo-data/media-cache/{avatars,stream-thumbs}/ へ配置
  var mediaCache = path.join(demoDir, 'media-cache');
  var avatarsDir = path.join(mediaCache, 'avatars');
  var thumbsDir = path.join(mediaCache, 'stream-thumbs');
  fs.mkdirSync(avatarsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  function copyImg(rel, dest) {
    try {
      var src = path.join(imgDir, rel);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      } else {
        L.warn('Demo image missing:', src);
      }
    } catch (e) {
      L.warn('Demo image copy failed:', rel, e && e.message ? e.message : e);
    }
  }

  if (demoSeed.owner && demoSeed.owner.icon) {
    copyImg(demoSeed.owner.icon, path.join(avatarsDir, demoSeed.owner.channelId + '.png'));
  }
  (demoSeed.listeners || []).forEach(function (l) {
    if (l.icon) copyImg(l.icon, path.join(avatarsDir, l.channelId + '.png'));
  });
  (demoSeed.streams || []).forEach(function (s) {
    if (s.thumb) copyImg(s.thumb, path.join(thumbsDir, s.videoId + '.jpg'));
    if (s.live) demoLiveVideoId = s.videoId;
  });

  // listeners.db に seed (Rust napi、同期)
  coreBridge.seedDemoData(demoDir, seedJson);
  L.info('Demo data seeded', {
    listeners: (demoSeed.listeners || []).length,
    streams: (demoSeed.streams || []).length,
    liveVideoId: demoLiveVideoId
  });
}

function startDemo() {
  var liveVid = demoLiveVideoId || 'demo_live';

  // ライブ配信の同接 (= seed の peakViewers)
  var liveStream = ((demoSeed && demoSeed.streams) || []).filter(function (s) { return s.live; })[0];
  var viewerCount = liveStream && liveStream.peakViewers ? liveStream.peakViewers : 1620;
  var mult = (demoSeed && demoSeed.commentMultiplier) || 1; // seed のコメント倍率 (= DB と揃える)

  // 接続状態を送信 (= リスナー一覧の baseline = この配信の started_at)。
  // isOwnStream:true で「自枠」扱いになりランク UI が有効化される。
  sendToRenderer('status', { connected: true, videoId: liveVid, viewerCount: viewerCount, isOwnStream: true });
  coreBridge.pushConnectionState(true, liveVid);

  // Rust に配信オーナー (= 自チャンネル) を通知。これをしないと Rust の connection 静的更新が
  // isOwnStream=false で上書きし「他チャンネル配信に接続中」バナーが出てランク UI も無効化される。
  if (demoSeed && demoSeed.owner && demoSeed.owner.channelId) {
    try {
      coreBridge.announceStreamOwner(liveVid, demoSeed.owner.channelId);
    } catch (e) {
      L.warn('announceStreamOwner (demo) failed:', e && e.message ? e.message : e);
    }
  }

  var port = coreBridge.getPort();
  function avatarUrl(channelId) {
    return 'http://127.0.0.1:' + port + '/cache/avatars/' + encodeURIComponent(channelId) + '.png';
  }

  // トップの配信情報パネル (接続枠) を demo メタで描画する。
  // 通常はライブ poll が 'stream-metadata-updated' を送るが demo は poll しないため
  // ここで 1 回 push する。集計値は seed の live コメントから概算。
  var liveCommentCount = 0;
  var liveSc = 0;
  ((demoSeed && demoSeed.listeners) || []).forEach(function (l) {
    if ((l.presentInStreams || []).indexOf('live') >= 0) {
      liveCommentCount += (l.commentsPerStream || 5) * mult;
      if (l.scInStreams && l.scInStreams.live) liveSc += l.scInStreams.live;
    }
  });
  sendToRenderer('stream-metadata-updated', {
    videoId: liveVid,
    title: liveStream ? liveStream.title : '【雑談】ねむっとお話し🌙',
    channelName: (demoSeed && demoSeed.owner && demoSeed.owner.name) || '雫宮ねむ',
    channelIconUrl: (demoSeed && demoSeed.owner) ? avatarUrl(demoSeed.owner.channelId) : '',
    description: '雫宮ねむのデモ配信です🌙 まったりお話ししてます。',
    subscriberCount: 12800,
    currentViewers: viewerCount,
    peakConcurrentViewers: viewerCount,
    likes: 1180,
    commentCount: liveCommentCount,
    superchatAmountJpy: liveSc,
    startedAt: Date.now() - 35 * 60 * 1000
  });

  // ライブコメント feed: 倍率分のコメントを listener 横断でインターリーブして busy に。
  // 文面は seed と同じ要領で per-listener seed + 素数ステップでばらけさせ、塊にしない。
  var comments = [];
  var pool = (demoSeed && demoSeed.commentTemplates && demoSeed.commentTemplates.live) ||
    ['こんねむ〜', 'かわいい', '今日もおつかれさま'];
  var liveListeners = (demoSeed && demoSeed.listeners ? demoSeed.listeners : [])
    .filter(function (l) { return (l.presentInStreams || []).indexOf('live') >= 0; });

  // listener ごとのコメント配列を作る (倍率反映)
  var perListener = liveListeners.map(function (l) {
    var seed = 0;
    for (var b = 0; b < l.channelId.length; b++) seed += l.channelId.charCodeAt(b);
    var n = (l.commentsPerStream || 5) * mult;
    var arr = [];
    for (var k = 0; k < n; k++) {
      arr.push({
        name: l.name,
        comment: pool[(k * 13 + seed) % pool.length],
        profileImage: avatarUrl(l.channelId),
        channelId: l.channelId // クリックで listener 詳細を開けるように
      });
    }
    return arr;
  });

  // round-robin インターリーブ (= 同一 listener が連続しない)
  var maxN = 0;
  perListener.forEach(function (a) { if (a.length > maxN) maxN = a.length; });
  for (var round = 0; round < maxN; round++) {
    for (var li = 0; li < perListener.length; li++) {
      if (perListener[li][round]) comments.push(perListener[li][round]);
    }
  }

  // 可視 feed は直近 INJECT_CAP 件に絞る (= 投入時間短縮、画面は十分埋まる)
  var INJECT_CAP = 130;
  if (comments.length > INJECT_CAP) comments = comments.slice(comments.length - INJECT_CAP);

  // 末尾 17 件 (= スクショ対象の可視部) はキュレーションして自然に見せる。
  // 同じ listener が連続しない順 + タグ (初見/再訪/今北/帰還) をほどよく散らす。
  var finale = [
    { id: 'yt-UC_demo_l02', name: 'ぷりんちゃま', comment: 'ねむちゃんこんばんは' },
    { id: 'yt-UC_demo_l13', name: 'ねむ初見です', comment: '初見です！', tag: 'first-time' },
    { id: 'yt-UC_demo_l04', name: 'ねこむすび', comment: '今日の衣装かわいい' },
    { id: 'yt-UC_demo_l07', name: 'まろんラテ', comment: '声落ち着く〜' },
    { id: 'yt-UC_demo_l18', name: 'おかえり古参', comment: 'ひさしぶりに来たよ！', tag: 'long-absence' },
    { id: 'yt-UC_demo_l08', name: 'こんぺいとう', comment: 'わこつ〜' },
    { id: 'yt-UC_demo_l03', name: 'みかん大福', comment: 'ねむぴの話おもしろいね', tag: 'returning' },
    { id: 'yt-UC_demo_l11', name: 'しおんブルー', comment: 'かわいい😻' },
    { id: 'yt-UC_demo_l06', name: 'ゆきうさぎ', comment: '癒される〜' },
    { id: 'yt-UC_demo_l14', name: 'とおりすがり', comment: 'はじめまして！' },
    { id: 'yt-UC_demo_l01', name: 'ねむ警備隊長', comment: '今日も来たよ〜', tag: 'regular-arrival' },
    { id: 'yt-UC_demo_l12', name: 'ことりさん', comment: 'まってました！' },
    { id: 'yt-UC_demo_l19', name: 'ひさしぶり', comment: 'おひさしぶりです🌙' },
    { id: 'yt-UC_demo_l09', name: 'はじめまして桜', comment: '今日もまったりだね' },
    { id: 'yt-UC_demo_l05', name: 'ほしぞらカフェ', comment: '初見でおじゃまします', tag: 'first-time' },
    { id: 'yt-UC_demo_l10', name: 'あおぞらくん', comment: 'ねむぴ〜' },
    { id: 'yt-UC_demo_l17', name: 'はつこめ', comment: '今日も癒された' }
  ];
  finale.forEach(function (f) {
    comments.push({
      name: f.name,
      comment: f.comment,
      profileImage: avatarUrl(f.id),
      listenerStatus: f.tag || '',
      channelId: f.id // クリックで listener 詳細を開けるように
    });
  });

  if (comments.length === 0) {
    comments = [{ name: '雫宮ねむ', comment: 'こんねむ〜🌙', profileImage: '' }];
  }

  comments.forEach(function (c, i) {
    setTimeout(function () {
      sendToRenderer('comment', {
        id: 'demo-live-' + i,
        name: c.name,
        comment: c.comment,
        commentHtml: c.comment,
        emojis: [],
        profileImage: c.profileImage,
        listenerStatus: c.listenerStatus || undefined,
        userId: c.channelId || undefined, // listener 詳細を開く際の channelId
        timestamp: new Date().toISOString(),
        hasGift: false
      });
    }, i * 60);
  });

  // リアクションカウント
  setTimeout(function () {
    for (var r = 0; r < 334; r++) {
      sendToRenderer('reaction', { count: 1 });
    }
  }, comments.length * 60 + 200);
}
