const { contextBridge, ipcRenderer } = require('electron');

// --- renderer 側 logger 用ヘルパ ---
// renderer 側で `var L = api.log.create('Tag'); L.info(...)` で呼ぶ。
// 引数を 1 行文字列にして IPC `log-renderer` で main → Rust → renderer.log へ。
// 詳細仕様: docs/logging.md。 fire-and-forget で即返却 (= await 不要)。
function formatRendererArgs(args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (a instanceof Error) {
      parts.push(a.message || String(a));
      if (a.stack) parts.push('\n  ' + a.stack.split('\n').slice(1).join('\n  '));
    } else if (typeof a === 'object' && a !== null) {
      try { parts.push(JSON.stringify(a)); } catch (_) { parts.push('[Object]'); }
    } else {
      parts.push(String(a));
    }
  }
  return parts.join(' ');
}

function createRendererLogger(tag) {
  var safeTag = String(tag || 'Renderer');
  function emit(level) {
    return function () {
      try {
        ipcRenderer.send('log-renderer', level, safeTag, formatRendererArgs(arguments));
      } catch (_) { /* IPC 失敗時は drop。 main 起動前等 */ }
    };
  }
  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error')
  };
}

contextBridge.exposeInMainWorld('api', {
  // --- Renderer logger (= renderer.log に出力、 詳細: docs/logging.md) ---
  // 旧 api.logError は Phase 1c で撤去済。 renderer 側は
  // `var L = api.log.create('Tag'); L.info(...)` を使う。
  log: {
    create: function (tag) { return createRendererLogger(tag); }
  },

  getLastUrl: function () {
    ipcRenderer.send('get-last-url');
  },
  onLastUrl: function (callback) {
    ipcRenderer.on('last-url', function (_event, url) {
      callback(url);
    });
  },
  connect: function (url) {
    ipcRenderer.send('connect', url);
  },
  disconnect: function () {
    ipcRenderer.send('disconnect');
  },
  openLogin: function () {
    ipcRenderer.send('open-login');
  },
  checkLogin: function () {
    return ipcRenderer.invoke('check-login');
  },
  logout: function () {
    return ipcRenderer.invoke('logout');
  },
  onComment: function (callback) {
    ipcRenderer.on('comment', function (_event, data) {
      callback(data);
    });
  },
  onCommentDeleted: function (callback) {
    ipcRenderer.on('comment-deleted', function (_event, data) {
      callback(data);
    });
  },
  /** Step 3: リスナー記録時のリアルタイム更新通知 (フェーズ 3.2a UI 自動更新) */
  onListenerUpdated: function (callback) {
    ipcRenderer.on('listener-updated', function (_event, data) {
      callback(data);
    });
  },
  /** 配信メタデータ更新 (タイトル / 同時接続数 / いいね数 等) */
  onStreamMetadataUpdated: function (callback) {
    ipcRenderer.on('stream-metadata-updated', function (_event, data) {
      callback(data);
    });
  },
  /** リモート閲覧 redesign §7.4: コメ「対応済み」状態同期 (= 他端末からのトグルを受信) */
  onCommentResponded: function (callback) {
    ipcRenderer.on('comment-responded', function (_event, data) {
      callback(data);
    });
  },
  /** リモート閲覧 redesign §7.4: リスナー「挨拶済み」状態同期 */
  onListenerGreeted: function (callback) {
    ipcRenderer.on('listener-greeted', function (_event, data) {
      callback(data);
    });
  },
  /** 2026-05-09 仕様変更: リスナー「コメ非表示 / リスナー非表示」状態同期 (= 別端末トグルで update) */
  onListenerHidden: function (callback) {
    ipcRenderer.on('listener-hidden', function (_event, data) {
      callback(data);
    });
  },
  /** フルバックアップ進捗 (= phase 名 + 0-100 のパーセント、 ダイアログのバー更新用) */
  onBackupProgress: function (callback) {
    ipcRenderer.on('backup-progress', function (_event, data) {
      callback(data);
    });
  },
  /** わんコメ DB リセット / 巻き戻し検出 (= watermark ズレ警告モーダル発火用) */
  onOnecommeResetDetected: function (callback) {
    ipcRenderer.on('onecomme-reset-detected', function (_event, data) {
      callback(data);
    });
  },
  /** 起動時自動 sync (= わんコメ書き戻し import + export) の進行状態通知。
   * phase: started / import-started / import-completed / import-failed /
   *        export-started / export-completed / export-aborted / export-failed /
   *        done / error
   * 受信側は UI に「取り込み中... → 完了 (X 件)」 を表示する想定。 */
  onStartupSyncProgress: function (callback) {
    ipcRenderer.on('startup-sync-progress', function (_event, data) {
      callback(data);
    });
  },
  /** import_from_onecomme の中間進捗 (= phase / current / total / message)。
   * 起動時自動 sync 中の細かい進捗バー描画用、 startup-sync-progress とは別経路 */
  onImportProgress: function (callback) {
    ipcRenderer.on('import-progress', function (_event, data) {
      callback(data);
    });
  },
  /** export_to_onecomme の中間進捗 (= phase / current / total / message / overallPercent)。
   * 起動時 sync の export phase / 終了時 shutdown export モーダル 両方で受信 */
  onExportProgress: function (callback) {
    ipcRenderer.on('export-progress', function (_event, data) {
      callback(data);
    });
  },
  onReaction: function (callback) {
    ipcRenderer.on('reaction', function (_event, data) {
      callback(data);
    });
  },
  onStatus: function (callback) {
    ipcRenderer.on('status', function (_event, data) {
      callback(data);
    });
  },
  /**
   * YouTube ライブチャットの現在の接続状態を pull する。
   * 後から開いた window が main UI と同じ接続状態を初期表示するために使う。
   * 戻り値: Promise<{ connected: boolean, videoId?: string, message?: string }>
   */
  getChatStatus: function () {
    return ipcRenderer.invoke('get-chat-status');
  },
  onApiClients: function (callback) {
    ipcRenderer.on('api-clients', function (_event, data) {
      callback(data);
    });
  },
  openExternal: function (url) {
    ipcRenderer.send('open-external', url);
  },
  openFolder: function (name) {
    ipcRenderer.send('open-folder', name);
  },
  onPort: function (callback) {
    ipcRenderer.on('port', function (_event, port) {
      callback(port);
    });
  },
  onLoginWarning: function (callback) {
    ipcRenderer.on('login-warning', function (_event, notLoggedIn) {
      callback(notLoggedIn);
    });
  },
  onCoreReady: function (callback) {
    ipcRenderer.on('core-ready', function () {
      callback();
    });
  },
  /**
   * Rust core の現在の接続状態を同期取得 (pull)。
   * 戻り値: Promise<{ running: boolean, port: number }>
   * - running: core プロセスが起動済みで使えるか
   * - port: HTTP / SSE ポート (0 なら未確定)
   * 後から開いた window が初期状態を取りに行くために使う。
   */
  getCoreStatus: function () {
    return ipcRenderer.invoke('get-core-status');
  },
  /**
   * Rust core 接続状態の変化通知 (push)。
   * callback には `{ running, port }` が渡る。
   * 戻り値の関数を呼ぶと購読解除。
   */
  onCoreStatus: function (callback) {
    var handler = function (_event, data) { callback(data || {}); };
    ipcRenderer.on('core-status', handler);
    return function () { ipcRenderer.removeListener('core-status', handler); };
  },
  notifyRendererReady: function () {
    ipcRenderer.send('renderer-ready');
  },

  // --- TTS 読み上げ ---
  ttsGetSettings: function () {
    return ipcRenderer.invoke('tts-get-settings');
  },
  ttsSaveSettings: function (patch) {
    return ipcRenderer.invoke('tts-save-settings', patch || {});
  },
  ttsGetState: function () {
    return ipcRenderer.invoke('tts-get-state');
  },
  ttsSetEnabled: function (enabled) {
    return ipcRenderer.invoke('tts-set-enabled', !!enabled);
  },
  ttsSetPaused: function (paused) {
    return ipcRenderer.invoke('tts-set-paused', !!paused);
  },
  ttsClear: function () {
    return ipcRenderer.invoke('tts-clear');
  },
  ttsTestSpeech: function (text) {
    return ipcRenderer.invoke('tts-test-speech', text || '');
  },
  ttsGetVoices: function (provider) {
    return ipcRenderer.invoke('tts-get-voices', provider || '');
  },
  ttsCheckProvider: function (provider) {
    return ipcRenderer.invoke('tts-check-provider', provider || '');
  },
  ttsLaunchProvider: function (provider) {
    return ipcRenderer.invoke('tts-launch-provider', provider || '');
  },
  ttsDetectProviderExecutable: function (provider) {
    return ipcRenderer.invoke('tts-detect-provider-executable', provider || '');
  },
  ttsSelectExecutable: function (provider) {
    return ipcRenderer.invoke('tts-select-executable', provider || '');
  },
  ttsGetAudioOutputs: function () {
    return ipcRenderer.invoke('tts-get-audio-outputs');
  },
  onTtsState: function (callback) {
    var handler = function (_event, data) { callback(data || {}); };
    ipcRenderer.on('tts-state', handler);
    return function () { ipcRenderer.removeListener('tts-state', handler); };
  },

  // --- コメント通知 (Phase A: UI スケルトン) ---
  notificationGetSettings: function () {
    return ipcRenderer.invoke('notification-get-settings');
  },
  notificationSaveSettings: function (patch) {
    return ipcRenderer.invoke('notification-save-settings', patch || {});
  },
  notificationGetState: function () {
    return ipcRenderer.invoke('notification-get-state');
  },
  notificationSetEnabled: function (enabled) {
    return ipcRenderer.invoke('notification-set-enabled', !!enabled);
  },
  notificationSetPaused: function (paused) {
    return ipcRenderer.invoke('notification-set-paused', !!paused);
  },
  notificationTestSound: function (file, volume, outputDevice) {
    return ipcRenderer.invoke('notification-test-sound', file || '', volume, outputDevice || '');
  },
  notificationPreviewTts: function (text, provider, outputDevice) {
    return ipcRenderer.invoke('notification-preview-tts', text || '', provider || 'builtin', outputDevice || '');
  },
  notificationListSoundDevices: function () {
    return ipcRenderer.invoke('notification-list-sound-devices');
  },
  notificationListSoundPresets: function () {
    return ipcRenderer.invoke('notification-list-sound-presets');
  },
  notificationGetEventDefaults: function () {
    return ipcRenderer.invoke('notification-get-event-defaults');
  },
  notificationRefreshDeviceMap: function () {
    return ipcRenderer.invoke('notification-refresh-device-map');
  },
  notificationPickSoundFile: function () {
    return ipcRenderer.invoke('notification-pick-sound-file');
  },

  getI18n: function () {
    return ipcRenderer.invoke('get-i18n');
  },
  setLanguage: function (lang) {
    return ipcRenderer.invoke('set-language', lang);
  },
  onboarding: {
    getState: function () {
      return ipcRenderer.invoke('onboarding-get-state');
    },
    setState: function (patch) {
      return ipcRenderer.invoke('onboarding-set-state', patch || {});
    },
    reset: function () {
      return ipcRenderer.invoke('onboarding-reset');
    },
    shouldShowEntry: function () {
      return ipcRenderer.invoke('onboarding-should-show-entry');
    },
    onEntryRefresh: function (callback) {
      ipcRenderer.on('onboarding-entry-refresh', function () { callback(); });
    }
  },
  openManual: function () {
    ipcRenderer.send('open-manual');
  },
  templateDevGuide: {
    open: function () {
      ipcRenderer.send('open-template-dev-guide');
    },
    list: function () {
      return ipcRenderer.invoke('template-dev-guide-list');
    },
    read: function (file) {
      return ipcRenderer.invoke('template-dev-guide-read', file);
    }
  },
  // リモート閲覧 redesign §4.1: コメント単位の書き込み (現状は「対応済み」のみ)
  comments: {
    /**
     * コメントの「対応済み」状態をトグル。
     * value=true で対応済み (= responded_at に現在時刻)、false で解除 (= 0)。
     */
    setResponded: function (commentId, value) {
      return ipcRenderer.invoke('comments-set-responded', commentId, !!value);
    },
  },
  ponout: {
    open: function () {
      ipcRenderer.send('open-ponout-window');
    },
    openRemote: function () {
      return ipcRenderer.invoke('ponout-open-remote');
    },
    getRemoteWarningDismissed: function () {
      return ipcRenderer.invoke('ponout-get-remote-warning-dismissed');
    },
    setRemoteWarningDismissed: function (dismissed) {
      return ipcRenderer.invoke('ponout-set-remote-warning-dismissed', !!dismissed);
    }
  },
  // LAN リスナー閲覧 (= スマホで /remote/ を開く) 用。ponout と同じインフラを共有
  // (= 既存ポート 11281 を流用、URL の path だけ /remote/)。
  startListenerRemote: function () {
    return ipcRenderer.invoke('listener-open-remote');
  },
  // scene / performance に何か変更があった時の broadcast。
  // 受信したら自前で getScenes() / getSelectedScene() を呼んで再描画する。
  onScenesChanged: function (callback) {
    var handler = function (_event, data) { callback(data || {}); };
    ipcRenderer.on('scenes-changed', handler);
    return function () { ipcRenderer.removeListener('scenes-changed', handler); };
  },
  openOnboarding: function () {
    ipcRenderer.send('open-onboarding');
  },
  onUpdateAvailable: function (callback) {
    ipcRenderer.on('update-available', function (_event, data) { callback(data); });
  },
  onUpdateProgress: function (callback) {
    ipcRenderer.on('update-progress', function (_event, data) { callback(data); });
  },
  onUpdateReady: function (callback) {
    ipcRenderer.on('update-ready', function (_event, data) { callback(data); });
  },
  onUpdateError: function (callback) {
    ipcRenderer.on('update-error', function (_event, data) { callback(data); });
  },
  downloadUpdate: function () {
    return ipcRenderer.invoke('download-update');
  },
  installUpdate: function () {
    return ipcRenderer.invoke('install-update');
  },
  getBetaChannel: function () {
    return ipcRenderer.invoke('get-beta-channel');
  },
  setBetaChannel: function (enabled) {
    return ipcRenderer.invoke('set-beta-channel', enabled);
  },

  // --- デバッグ・サポート (= デバッグログ ON/OFF、 詳細: docs/logging.md) ---
  getDebugLoggingEnabled: function () {
    return ipcRenderer.invoke('get-debug-logging-enabled');
  },
  setDebugLoggingEnabled: function (enabled) {
    return ipcRenderer.invoke('set-debug-logging-enabled', enabled);
  },

  // --- 演出素材 ---
  addPerformanceAsset: function (sceneId, performanceId) {
    return ipcRenderer.invoke('add-performance-asset', sceneId, performanceId);
  },
  copyPerformanceAsset: function (sceneId, srcPath, performanceId) {
    return ipcRenderer.invoke('copy-performance-asset', sceneId, srcPath, performanceId);
  },
  checkDefaultTemplateContext: function (effectId) {
    return ipcRenderer.invoke('check-default-template-context', effectId);
  },
  addPerformanceSound: function (sceneId, performanceId) {
    return ipcRenderer.invoke('add-performance-sound', sceneId, performanceId);
  },

  // --- シーン管理 ---
  getSceneList: function () {
    return ipcRenderer.invoke('get-scene-list');
  },
  getScene: function (sceneId) {
    return ipcRenderer.invoke('get-scene', sceneId);
  },
  getScenes: function () {
    return ipcRenderer.invoke('get-scenes');
  },
  saveScene: function (sceneId, sceneData) {
    return ipcRenderer.invoke('save-scene', sceneId, sceneData);
  },
  createScene: function (name) {
    return ipcRenderer.invoke('create-scene', name);
  },
  duplicateScene: function (sourceId, newName) {
    return ipcRenderer.invoke('duplicate-scene', sourceId, newName);
  },
  reorderScenes: function (orderedIds) {
    return ipcRenderer.invoke('reorder-scenes', orderedIds);
  },
  deleteScene: function (sceneId) {
    return ipcRenderer.invoke('delete-scene', sceneId);
  },
  renameScene: function (sceneId, newName) {
    return ipcRenderer.invoke('rename-scene', sceneId, newName);
  },
  setSceneEnabled: function (sceneId, enabled) {
    return ipcRenderer.invoke('set-scene-enabled', sceneId, enabled);
  },
  restoreDefaultScene: function (sceneId) {
    return ipcRenderer.invoke('restore-default-scene', sceneId);
  },
  getSelectedScene: function () {
    return ipcRenderer.invoke('get-selected-scene');
  },
  setSelectedScene: function (sceneId) {
    return ipcRenderer.invoke('set-selected-scene', sceneId);
  },

  // --- 演出 ---
  getPerformances: function (sceneId) {
    return ipcRenderer.invoke('get-performances', sceneId);
  },
  savePerformance: function (sceneId, performance) {
    return ipcRenderer.invoke('save-performance', sceneId, performance);
  },
  getDefaultPerformance: function (sceneId, performanceId) {
    return ipcRenderer.invoke('get-default-performance', sceneId, performanceId);
  },
  deletePerformance: function (sceneId, performanceId) {
    return ipcRenderer.invoke('delete-performance', sceneId, performanceId);
  },
  setPerformanceEnabled: function (sceneId, performanceId, enabled) {
    return ipcRenderer.invoke('set-performance-enabled', sceneId, performanceId, enabled);
  },
  reorderPerformances: function (sceneId, orderedIds) {
    return ipcRenderer.invoke('reorder-performances', sceneId, orderedIds);
  },

  // --- テンプレート ---
  getTemplates: function () {
    return ipcRenderer.invoke('get-templates');
  },
  installTemplate: function () {
    return ipcRenderer.invoke('install-template');
  },
  createTemplateFromStarter: function (starterType, templateId, displayName) {
    return ipcRenderer.invoke('create-template-from-starter', starterType, templateId, displayName);
  },
  createTemplateFromBuiltin: function (sourceTemplateId, templateId, displayName) {
    return ipcRenderer.invoke('create-template-from-builtin', sourceTemplateId, templateId, displayName);
  },
  removeTemplate: function (name) {
    return ipcRenderer.invoke('remove-template', name);
  },
  openTemplateFolder: function (templateName) {
    return ipcRenderer.invoke('open-template-folder', templateName);
  },
  chooseTemplateFontImport: function () {
    return ipcRenderer.invoke('choose-template-font-import');
  },
  importTemplateBundledFont: function (templateName, srcPath, family) {
    return ipcRenderer.invoke('import-template-bundled-font', templateName, srcPath, family);
  },
  getSceneTemplates: function (sceneId) {
    return ipcRenderer.invoke('get-scene-templates', sceneId);
  },
  addSceneTemplate: function (sceneId, templateName) {
    return ipcRenderer.invoke('add-scene-template', sceneId, templateName);
  },
  removeSceneTemplate: function (sceneId, templateName) {
    return ipcRenderer.invoke('remove-scene-template', sceneId, templateName);
  },
  setSelectedSceneTemplate: function (sceneId, templateName) {
    return ipcRenderer.invoke('set-selected-scene-template', sceneId, templateName);
  },
  setSceneTemplateEnabled: function (sceneId, templateName, enabled) {
    return ipcRenderer.invoke('set-scene-template-enabled', sceneId, templateName, enabled);
  },
  setSceneTemplatesEnabled: function (sceneId, enabled) {
    return ipcRenderer.invoke('set-scene-templates-enabled', sceneId, enabled);
  },
  setSceneTemplateConfig: function (sceneId, templateName, settings) {
    return ipcRenderer.invoke('set-scene-template-config', sceneId, templateName, settings);
  },
  getTemplateManifests: function () {
    return ipcRenderer.invoke('get-template-manifests');
  },
  getTemplateManifest: function (templateName) {
    return ipcRenderer.invoke('get-template-manifest', templateName);
  },
  saveTemplateManifest: function (templateName, manifest) {
    return ipcRenderer.invoke('save-template-manifest', templateName, manifest);
  },
  exportTemplate: function (templateName, exportName, sceneId, settings) {
    return ipcRenderer.invoke('export-template', templateName, exportName, sceneId, settings);
  },
  ensureTemplateFonts: function (fonts) {
    return ipcRenderer.invoke('ensure-template-fonts', fonts);
  },
  onFontDlProgress: function (callback) {
    var handler = function (_event, data) { callback(data); };
    ipcRenderer.on('font-dl-progress', handler);
    // リスナー解除関数を返す
    return function () { ipcRenderer.removeListener('font-dl-progress', handler); };
  },

  // --- エフェクト ---
  getEffects: function () {
    return ipcRenderer.invoke('get-effects');
  },
  getPluginManifests: function () {
    return ipcRenderer.invoke('get-plugin-manifests');
  },
  getEffect: function (effectId) {
    return ipcRenderer.invoke('get-effect', effectId);
  },
  addEffect: function (effect) {
    return ipcRenderer.invoke('add-effect', effect);
  },
  updateEffect: function (effect) {
    return ipcRenderer.invoke('update-effect', effect);
  },
  removeEffect: function (effectId) {
    return ipcRenderer.invoke('remove-effect', effectId);
  },
  duplicateEffect: function (effectId, newName) {
    return ipcRenderer.invoke('duplicate-effect', effectId, newName);
  },

  // --- エクスポート/インポート ---
  exportScene: function (sceneId, sceneName) {
    return ipcRenderer.invoke('export-scene', sceneId, sceneName);
  },
  importScene: function () {
    return ipcRenderer.invoke('import-scene');
  },
  exportPerformance: function (sceneId, performanceId, perfName) {
    return ipcRenderer.invoke('export-performance', sceneId, performanceId, perfName);
  },
  importPerformance: function (sceneId) {
    return ipcRenderer.invoke('import-performance', sceneId);
  },
  exportEffect: function (effectId, effectName) {
    return ipcRenderer.invoke('export-effect', effectId, effectName);
  },
  importEffect: function () {
    return ipcRenderer.invoke('import-effect');
  },

  // --- トリガー判定エンジン ---
  triggerManual: function (sceneId, performanceId) {
    return ipcRenderer.invoke('trigger-manual', sceneId, performanceId);
  },
  clearPerformances: function (sceneId) {
    return ipcRenderer.invoke('clear-performances', sceneId);
  },
  triggerTest: function (sceneId, performanceId) {
    return ipcRenderer.invoke('trigger-test', sceneId, performanceId);
  },
  triggerTestWithContext: function (sceneId, performanceId, context) {
    return ipcRenderer.invoke('trigger-test-with-context', sceneId, performanceId, context);
  },
  triggerTestReaction: function (sceneId, performanceId) {
    return ipcRenderer.invoke('trigger-test-reaction', sceneId, performanceId);
  },
  triggerTestReactionCustom: function (sceneId, performanceId, reactionKey) {
    return ipcRenderer.invoke('trigger-test-reaction-custom', sceneId, performanceId, reactionKey);
  },
  sendTemplateTestComment: function (sceneId, context) {
    return ipcRenderer.invoke('send-template-test-comment', sceneId, context);
  },
  setPaused: function (paused) {
    return ipcRenderer.invoke('set-paused', paused);
  },
  getPaused: function () {
    return ipcRenderer.invoke('get-paused');
  },

  // --- オーバーレイ ---
  reloadOverlays: function () {
    return ipcRenderer.invoke('reload-overlays');
  },

  /**
   * 配信サムネを media-cache/stream-thumbs/{videoId}.jpg にローカル DL する。
   * 既存ヒットなら即時 return。戻り: { ok, localUrl, hit, fileName }
   * fire-and-forget で OK (戻り値を待たずに <img onerror> でフォールバック可能)。
   */
  cacheStreamThumbnail: function (videoId) {
    return ipcRenderer.invoke('cache-stream-thumbnail', videoId || '');
  },

  // --- グローバル設定 ---
  // 2026-05-09 仕様変更: 旧 getBannedUsers / addBannedUser / removeBannedUser (= 演出フィルタ向け) は撤廃。
  // 代替は listeners.getHidden / setHidden / setHiddenList (= UI 表示抑制、コメ/リスナー 2 軸独立)。
  getGlobalCooldown: function () {
    return ipcRenderer.invoke('get-global-cooldown');
  },
  setGlobalCooldown: function (settings) {
    return ipcRenderer.invoke('set-global-cooldown', settings);
  },
  getMembershipGiftPricing: function () {
    return ipcRenderer.invoke('get-membership-gift-pricing');
  },
  setMembershipGiftPricing: function (settings) {
    return ipcRenderer.invoke('set-membership-gift-pricing', settings);
  },
  getListenerClassificationConfig: function () {
    return ipcRenderer.invoke('get-listener-classification-config');
  },
  setListenerClassificationConfig: function (settings) {
    return ipcRenderer.invoke('set-listener-classification-config', settings);
  },

  // --- Step 3 リスナー管理 (フェーズ 3.2a) ---
  listeners: {
    /** 自チャンネル設定一覧 (channelId + handle?) を取得 */
    getOwnerChannels: function () {
      return ipcRenderer.invoke('listeners-get-owner-channels');
    },
    /**
     * 自チャンネル設定一覧を一括上書き。各要素は `{ channelId, handle? }`。
     * 空配列で全クリア。
     */
    setOwnerChannels: function (channels) {
      return ipcRenderer.invoke('listeners-set-owner-channels',
        Array.isArray(channels) ? channels : []);
    },
    /**
     * YouTube チャンネル情報解決 (双方向): 入力 (@handle / UCxxx) から
     * { ok, channelId, handle, name, thumbnailUrl } を取得する。UC 入力時は handle を
     * 逆引き、@handle 入力時は UC を引く。name / thumbnailUrl は best-effort (無い場合 null)。
     */
    resolveChannelInfo: function (input) {
      return ipcRenderer.invoke('youtube-resolve-channel-info', input);
    },
    /**
     * 現在 YouTube にログイン中のアカウント自身のチャンネル情報を返す。
     * 戻り値: { ok, channelId, handle, name, thumbnailUrl } / 未ログイン時 { ok: false, reason }
     * persist:youtube セッション cookies で youtube.com を fetch して抽出する。
     */
    getCurrentChannel: function () {
      return ipcRenderer.invoke('youtube-get-current-channel');
    },
    /** リスナー一覧 (sort / q / limit / offset) */
    list: function (query) {
      return ipcRenderer.invoke('listeners-list', query || {});
    },
    /**
     * リスナー一覧 UI の heatmap (直近 N 日 daily activity) を一括取得。
     * query: { channelIds: ['yt-UC...'], days?: 14 }
     * 戻り: { ok, activities: [{ channelId, days: [{count, hasSc}, ...] }] }
     */
    activity: function (query) {
      return ipcRenderer.invoke('listeners-activity', query || {});
    },
    /** リスナー詳細 (リスナー単体 + 直近コメント) */
    detail: function (channelId, recentCommentLimit) {
      return ipcRenderer.invoke('listeners-detail', channelId, recentCommentLimit);
    },
    /**
     * nickname / notes / label の部分更新。
     * fields に渡したキーだけ更新、未指定キーは触らない。"" は明示クリア。
     */
    updateMetadata: function (channelId, fields) {
      return ipcRenderer.invoke('listeners-update-metadata', channelId, fields || {});
    },
    /**
     * リモート閲覧 redesign §3.1 / §4.1:
     * 配信枠 × リスナーの「挨拶済み」トグル (per-stream)。
     * value=true で挨拶済み、false で解除。
     */
    setGreeted: function (streamVideoId, listenerChannelId, value) {
      return ipcRenderer.invoke('listeners-set-greeted', streamVideoId, listenerChannelId, !!value);
    },
    /**
     * 2026-05-09 仕様変更: リスナーの「コメ非表示 / リスナー非表示」2 軸独立トグル。
     * 旧 setBanned (= 単一 BAN) を置換。演出フィルタは撤廃済 (= UI 表示抑制のみ)。
     * 両方 false なら record 自体を削除する (= ノイズ回避)。
     */
    setHidden: function (listenerChannelId, hideFromComments, hideFromListeners) {
      return ipcRenderer.invoke('listeners-set-hidden', listenerChannelId, !!hideFromComments, !!hideFromListeners);
    },
    /** 非表示リストの全件取得 (= 設定モーダルの一覧表示用)。 */
    getHidden: function () {
      return ipcRenderer.invoke('listeners-get-hidden');
    },
    /** 非表示リストの一括 set (= 全クリア / 複数解除用)。 */
    setHiddenList: function (users) {
      return ipcRenderer.invoke('listeners-set-hidden-list', users);
    },
    /** 配信一覧 (sort / limit / offset) */
    streams: function (query) {
      return ipcRenderer.invoke('listeners-streams', query || {});
    },
    /** 配信削除 */
    deleteStreams: function (videoIds) {
      return ipcRenderer.invoke('listeners-delete-streams',
        Array.isArray(videoIds) ? videoIds : []);
    },
    /** 配信詳細 (配信単体 + 直近コメント) */
    streamDetail: function (videoId, recentCommentLimit) {
      return ipcRenderer.invoke('listeners-stream-detail', videoId, recentCommentLimit);
    },
    /** コメント検索 (新仕様: bodyQ / streamTitleQ / nameQ / periodFrom-To / systemTags[] / userTags[] /
     *  streamIds[] / listenerChannelIds[] / commentTypes[] / includeKpi + ページング) */
    searchComments: function (query) {
      return ipcRenderer.invoke('listeners-search-comments', query || {});
    },
    /** 配信詳細モーダルのリスナータブ用: per-stream 集計 + heatmap + user_tags 付き */
    streamListeners: function (videoId, query) {
      return ipcRenderer.invoke('listeners-stream-listeners', videoId, query || {});
    },
    /** 配信詳細モーダルの統計タブ用: 時系列 / 累積 / 構成 / 頻出語 / misc を一括 */
    streamStats: function (videoId, binMinutes) {
      return ipcRenderer.invoke('listeners-stream-stats', videoId, binMinutes);
    },
    /** 配信詳細モーダルの chip 表示用: 5 種 COUNT を 1 SQL で */
    commentChipCounts: function (videoId) {
      return ipcRenderer.invoke('listeners-comment-chip-counts', videoId);
    },
    /** リスナー詳細モーダルの chip 表示用: 全期間 / SC / 当該枠 */
    listenerChipCounts: function (channelId, contextVideoId) {
      return ipcRenderer.invoke('listeners-listener-chip-counts', channelId, contextVideoId);
    },
    /** リスナー詳細モーダル「SC のみ」chip 用: 全期間 SC コメ取得 */
    listenerSuperchats: function (channelId, limit) {
      return ipcRenderer.invoke('listeners-listener-superchats', channelId, limit || 200);
    },
    /** リスナー詳細モーダル「この枠」chip 用: 指定枠でのコメを全件取得 */
    listenerCommentsInStream: function (channelId, streamVideoId, limit) {
      return ipcRenderer.invoke(
        'listeners-listener-comments-in-stream',
        channelId,
        streamVideoId,
        limit || 1000,
      );
    },
    /** 設定画面「リスナー判定」ライブプレビュー: 6 ランクの件数 */
    searchRankCounts: function (baselineVideoId) {
      return ipcRenderer.invoke('listeners-search-rank-counts', baselineVideoId || '');
    },
    /** リスナータブのミニタブ件数バッジ用: 接続中の枠の 6 種 (全て / 未挨拶 / 新規 /
     *  再訪 / 復帰 / 新メンバー) */
    streamScopedListenerCounts: function (streamVideoId, q) {
      return ipcRenderer.invoke('listeners-stream-scoped-counts', streamVideoId, q == null ? null : String(q));
    },
    /** 配信詳細モーダル: system pill 件数 (= 全 audience に対する集計、ページング非依存) */
    streamListenerPillCounts: function (videoId, query) {
      return ipcRenderer.invoke('listeners-stream-listener-pill-counts', videoId, query || {});
    },
    /** 1 リスナーに付けられた user-attached タグ一覧 */
    getListenerTags: function (channelId) {
      return ipcRenderer.invoke('listeners-get-tags', channelId);
    },
    /** 1 リスナーのタグ集合を完全置換 (空配列で全削除) */
    setListenerTags: function (channelId, tags) {
      return ipcRenderer.invoke('listeners-set-tags', channelId, Array.isArray(tags) ? tags : []);
    },
    /** 全 user-attached タグの一覧 + 利用リスナー数 */
    listAllTags: function () {
      return ipcRenderer.invoke('listeners-list-all-tags');
    },
    /** listener_tags 全行をフラットに (popover 用 channel_id → tags[] map) */
    listAllTagAssignments: function () {
      return ipcRenderer.invoke('listeners-list-all-tag-assignments');
    },
    /** 1 配信のタグ一覧 */
    getStreamTags: function (videoId) {
      return ipcRenderer.invoke('streams-get-tags', videoId);
    },
    /** 1 配信のタグを完全置換 */
    setStreamTags: function (videoId, tags) {
      return ipcRenderer.invoke('streams-set-tags', videoId, Array.isArray(tags) ? tags : []);
    },
    /** 配信枠タグ一覧 */
    listAllStreamTags: function () {
      return ipcRenderer.invoke('streams-list-all-tags');
    },
    /** 配信枠タグ assignment 全行 */
    listAllStreamTagAssignments: function () {
      return ipcRenderer.invoke('streams-list-all-tag-assignments');
    },
    /** 配信枠タグ rename */
    renameStreamTag: function (oldName, newName) {
      return ipcRenderer.invoke('streams-rename-tag', oldName, newName);
    },
    /** 配信枠タグ delete */
    deleteStreamTag: function (name) {
      return ipcRenderer.invoke('streams-delete-tag', name);
    },
    /** タグ名一括変更 (新名と既存衝突は統合) */
    renameTag: function (oldName, newName) {
      return ipcRenderer.invoke('listeners-rename-tag', oldName, newName);
    },
    /** タグ名を全リスナーから削除 */
    deleteTag: function (name) {
      return ipcRenderer.invoke('listeners-delete-tag', name);
    },
    /** 全保存検索一覧 (sort_order ASC) */
    listSavedSearches: function (scope) {
      return ipcRenderer.invoke('listeners-list-saved-searches', scope || 'comment-search');
    },
    /** 保存検索を新規作成。conditions は CommentsQuery 互換オブジェクト or 文字列 */
    createSavedSearch: function (scope, name, conditions) {
      return ipcRenderer.invoke('listeners-create-saved-search', scope || 'comment-search', name, conditions);
    },
    /** 保存検索の部分更新。patch = { name?, conditions?, sortOrder? } */
    updateSavedSearch: function (id, patch) {
      return ipcRenderer.invoke('listeners-update-saved-search', id, patch || {});
    },
    /** 保存検索を id 指定で削除 */
    deleteSavedSearch: function (id) {
      return ipcRenderer.invoke('listeners-delete-saved-search', id);
    },
    /** こめはぶ形式 JSON Lines エクスポート (ファイル保存ダイアログ → Rust が書き出し) */
    exportJsonl: function () {
      return ipcRenderer.invoke('listeners-export-jsonl');
    },
    /** こめはぶ形式 JSON Lines インポート (ファイル選択ダイアログ → Rust が読み込み) */
    importJsonl: function () {
      return ipcRenderer.invoke('listeners-import-jsonl');
    },
    /** わんコメ DB インポート (フォルダ選択ダイアログ → Rust が onecomme.db / comments.db を直読み) */
    importFromOnecomme: function () {
      return ipcRenderer.invoke('listeners-import-from-onecomme');
    },
    /** タイトル等が未取得の自チャ過去枠を resolver で再取得 (= backfill、fire-and-forget)。
     *  対象が無ければ Rust 側で no-op。補完できた枠は SSE stream-metadata-updated で反映。 */
    backfillStreamMeta: function () {
      return ipcRenderer.invoke('listeners-backfill-stream-meta');
    },
    /** わんコメ DB へ書き戻し (フェーズ 3.5、Plan A) */
    exportToOnecomme: function () {
      return ipcRenderer.invoke('listeners-export-to-onecomme');
    },
    /** わんコメ起動検知 (HTTP 11180) */
    detectOnecommeRunning: function () {
      return ipcRenderer.invoke('listeners-detect-onecomme-running');
    },
    /** わんコメフォルダ / 起動状態をセットアップ用にまとめて取得 */
    getOnecommeStatus: function () {
      return ipcRenderer.invoke('listeners-get-onecomme-status');
    },
    /** 双方向同期 (起動時自動 + 「今すぐ同期」ボタン) */
    runBidirectionalSync: function () {
      return ipcRenderer.invoke('listeners-run-bidirectional-sync');
    },
    /** わんコメ DB リセット検出後、 watermark をクリア (= 次回 export で全件書き直し) */
    resetOnecommeWatermarks: function (onecommeDir) {
      return ipcRenderer.invoke('listeners-reset-onecomme-watermarks', onecommeDir);
    },
    /**
     * 指定リスナー (複数可) を listeners 行 + アバター画像ファイルだけ削除する。
     * コメントは残す (配信履歴として永続化)、streams 集計値も触らない。
     * わんコメ DB は触らない。
     */
    deleteListeners: function (channelIds) {
      return ipcRenderer.invoke('listeners-delete',
        Array.isArray(channelIds) ? channelIds : []);
    },
    /** 自動同期設定の取得 (autoImportOnStart / autoExportEnabled) */
    getAutoSyncSettings: function () {
      return ipcRenderer.invoke('listeners-get-auto-sync-settings');
    },
    /** 自動同期設定の保存 */
    setAutoSyncSettings: function (settings) {
      return ipcRenderer.invoke('listeners-set-auto-sync-settings', settings || {});
    },
    /** 終了時 export の進捗を受信する (phase: 'started' | 'done') */
    onShutdownExportProgress: function (callback) {
      ipcRenderer.on('shutdown-export-progress', function (_event, payload) {
        callback(payload);
      });
    }
  },

  // --- アップグレード ---
  confirmUpgradeEffect: function (zipPath, effectId) {
    return ipcRenderer.invoke('confirm-upgrade-effect', zipPath, effectId);
  },

  // --- バックアップ管理 ---
  getBackupList: function () {
    return ipcRenderer.invoke('get-backup-list');
  },
  createBackup: function (options) {
    return ipcRenderer.invoke('create-backup', options);
  },
  createFullBackup: function (name) {
    return ipcRenderer.invoke('create-full-backup', name);
  },
  restoreBackup: function (backupId) {
    return ipcRenderer.invoke('restore-backup', backupId);
  },
  getDataOverview: function () {
    return ipcRenderer.invoke('get-data-overview');
  },
  deleteBackup: function (backupId) {
    return ipcRenderer.invoke('delete-backup', backupId);
  },
  getBackupsDir: function () {
    return ipcRenderer.invoke('get-backups-dir');
  },
  setBackupsDir: function () {
    return ipcRenderer.invoke('set-backups-dir');
  },
  resetBackupsDir: function () {
    return ipcRenderer.invoke('reset-backups-dir');
  },
  resetAllSettings: function () {
    return ipcRenderer.invoke('reset-all-settings');
  },
  // kind: 'settings' (設定のみ) / 'data' (蓄積データのみ) / 'all' (完全初期化)
  resetApp: function (kind) {
    return ipcRenderer.invoke('reset-app', kind);
  }
});
