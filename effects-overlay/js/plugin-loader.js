/**
 * プラグインローダー
 * エフェクトプラグインを動的にロードし、レジストリで管理する
 */
var PluginLoader = (function () {
  var registry = {};
  var loadedCount = 0;
  var totalCount = 0;

  /**
   * プラグイン一覧をロード
   * @param {Array} pluginList - [{ type, basePath, manifest }]
   * @param {Function} callback - 全ロード完了時に registry を渡す
   */
  function loadAll(pluginList, callback) {
    totalCount = pluginList.length;
    loadedCount = 0;

    if (totalCount === 0) {
      console.log('[PluginLoader] No plugins to load');
      callback(registry);
      return;
    }

    console.log('[PluginLoader] Loading', totalCount, 'plugins');

    pluginList.forEach(function (info) {
      var script = document.createElement('script');
      script.src = info.basePath + info.manifest.entry + '?_=' + Date.now();
      script.onload = function () {
        var handler = window[info.manifest.globalName];
        if (handler) {
          registry[info.type] = {
            manifest: info.manifest,
            handler: handler
          };
          console.log('[PluginLoader] Loaded:', info.type);
        } else {
          console.warn('[PluginLoader] Global not found:', info.manifest.globalName);
        }
        checkDone(callback);
      };
      script.onerror = function () {
        console.warn('[PluginLoader] Failed to load:', info.type, info.basePath + info.manifest.entry);
        checkDone(callback);
      };
      document.head.appendChild(script);
    });
  }

  function checkDone(callback) {
    loadedCount++;
    if (loadedCount >= totalCount) {
      console.log('[PluginLoader] All plugins loaded:', Object.keys(registry).length + '/' + totalCount);
      callback(registry);
    }
  }

  /**
   * タイプからプラグインを取得
   * @returns {{ manifest, handler } | null}
   */
  function get(type) {
    return registry[type] || null;
  }

  /**
   * 全プラグインを取得
   * @returns {Object} type → { manifest, handler }
   */
  function getAll() {
    return registry;
  }

  return { loadAll: loadAll, get: get, getAll: getAll };
})();
