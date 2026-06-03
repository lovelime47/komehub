(function () {
  'use strict';

  // renderer.log 用ロガー (= 詳細: docs/logging.md)
  var ponoutApiLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('PonoutRemoteApi')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var sceneSnapshot = null;
  var sceneSnapshotText = '';
  var pollTimer = null;

  function request(path, options) {
    var init = options || {};
    init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {});
    return fetch(path, init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
      return res.text().then(function (text) {
        return text ? JSON.parse(text) : null;
      });
    });
  }

  function post(path, body) {
    return request(path, {
      method: 'POST',
      body: body == null ? '{}' : JSON.stringify(body)
    });
  }

  function normalizeSceneStore(data) {
    var store = data && typeof data === 'object' ? data : {};
    var scenes = store.scenes && typeof store.scenes === 'object' ? store.scenes : store;
    var order = Array.isArray(store.sceneOrder) ? store.sceneOrder.slice() : Object.keys(scenes).sort();
    order = order.filter(function (id) { return !!(scenes && scenes[id]); });
    Object.keys(scenes || {}).forEach(function (id) {
      if (order.indexOf(id) === -1) order.push(id);
      if (scenes[id] && !scenes[id].id) scenes[id].id = id;
    });
    return {
      scenes: scenes || {},
      sceneOrder: order,
      activeSceneId: store.activeSceneId || ''
    };
  }

  function getSceneStore() {
    return request('/api/scenes').then(function (data) {
      sceneSnapshot = normalizeSceneStore(data);
      sceneSnapshotText = JSON.stringify(sceneSnapshot);
      return sceneSnapshot;
    });
  }

  function cachedSceneStore() {
    return sceneSnapshot ? Promise.resolve(sceneSnapshot) : getSceneStore();
  }

  function sceneListFromStore(store) {
    return store.sceneOrder.map(function (id) {
      var scene = store.scenes[id] || {};
      return {
        id: id,
        name: scene.name || id,
        enabled: scene.enabled !== false,
        performanceCount: Array.isArray(scene.performances) ? scene.performances.length : 0
      };
    });
  }

  function subscribePublicStream(handler) {
    if (!window.EventSource) return function () {};
    var source = new EventSource('/api/stream');
    source.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (_) { return; }
      handler(data);
    };
    source.onerror = function () {};
    return function () { source.close(); };
  }

  window.api = {
    getCoreStatus: function () {
      return Promise.resolve({
        host: window.location.hostname,
        port: Number(window.location.port) || 80,
        origin: window.location.origin
      });
    },

    onCoreStatus: function () {},

    getSceneList: function () {
      return cachedSceneStore().then(sceneListFromStore);
    },

    getScenes: function () {
      return cachedSceneStore().then(function (store) { return store.scenes; });
    },

    getSelectedScene: function () {
      return request('/api/app/active-scene').then(function (sceneId) {
        if (sceneId) return sceneId;
        return cachedSceneStore().then(function (store) {
          return store.activeSceneId || store.sceneOrder[0] || '';
        });
      });
    },

    setSelectedScene: function (sceneId) {
      return post('/api/app/active-scene', { sceneId: sceneId }).then(function () {
        return getSceneStore();
      });
    },

    savePerformance: function (sceneId, performance) {
      return post('/api/scenes/' + encodeURIComponent(sceneId) + '/performances', performance)
        .then(function (result) {
          return getSceneStore().then(function () { return result; });
        });
    },

    triggerManual: function (sceneId, performanceId) {
      return post('/api/trigger/' + encodeURIComponent(sceneId) + '/' + encodeURIComponent(performanceId), {})
        .then(function (result) { return result && result.success !== false; });
    },

    clearPerformances: function (sceneId) {
      return post('/api/scenes/' + encodeURIComponent(sceneId) + '/performances/clear', {});
    },

    getPaused: function () {
      return request('/api/paused').then(function (paused) { return !!paused; });
    },

    setPaused: function (paused) {
      return post('/api/paused', { paused: !!paused });
    },

    getChatStatus: function () {
      return request('/api/status').then(function (status) {
        return {
          connected: !!(status && status.connected),
          message: status && status.connected ? '接続中' : '未接続',
          videoId: status && status.videoId
        };
      });
    },

    onStatus: function (callback) {
      return subscribePublicStream(function (message) {
        if (!message || message.type !== 'status') return;
        var data = message.data || {};
        callback({
          connected: !!data.connected,
          message: data.connected ? '接続中' : '未接続',
          videoId: data.videoId
        });
      });
    },

    onScenesChanged: function (callback) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(function () {
        request('/api/scenes').then(function (data) {
          var next = normalizeSceneStore(data);
          var nextText = JSON.stringify(next);
          if (nextText !== sceneSnapshotText) {
            sceneSnapshot = next;
            sceneSnapshotText = nextText;
            callback();
          }
        }).catch(function (err) { ponoutApiLog.debug('scene snapshot poll rejected (catch swallow):', err); });
      }, 2000);
      return function () {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      };
    },

    ttsGetState: function () {
      return request('/api/tts/state');
    },

    ttsSetEnabled: function (enabled) {
      return post('/api/tts/enabled', { enabled: !!enabled });
    },

    ttsSetPaused: function (paused) {
      return post('/api/tts/paused', { paused: !!paused });
    },

    ttsClear: function () {
      return post('/api/tts/clear', {});
    },

    onTtsState: function (callback) {
      return subscribePublicStream(function (message) {
        if (message && message.type === 'tts-state') callback(message.data);
      });
    }
  };
})();
