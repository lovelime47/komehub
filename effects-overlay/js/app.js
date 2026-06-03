/**
 * 演出オーバーレイ エントリポイント
 * SSEに接続して演出指示を受信し、Rendererに振り分ける
 */
(function () {
  // URLからsceneIdを取得: /effects/game/ → "game"
  var pathParts = location.pathname.split('/').filter(function (p) { return p; });
  var sceneId = pathParts[1] || 'game';

  var streamUrl = '/effects/' + sceneId + '/stream';
  var assetsBase = '/effects/' + sceneId + '/assets/';

  console.log('[EffectsOverlay] Scene:', sceneId);
  console.log('[EffectsOverlay] Stream:', streamUrl);

  // DOM準備完了後にプラグインロード→初期化
  var container = document.getElementById('effects-container');
  var pluginsUrl = '/effects/' + sceneId + '/plugins/';

  // ハブ再起動を能動検知して自己回復する (= EventSource 自動再接続に依存しない)。
  // テンプレ側 selected ラッパの bootId ポーリングと同じ思想。
  startBootIdWatch();

  // プラグインを動的ロードしてから初期化・SSE接続（キャッシュバスタ付き）
  fetch(pluginsUrl + '?_=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (pluginList) {
      PluginLoader.loadAll(pluginList, function () {
        Renderer.init(container, assetsBase);
        connectSSE();
      });
    })
    .catch(function (err) {
      console.error('[EffectsOverlay] Failed to load plugins:', err);
      if (container) {
        container.innerHTML = '';
        var message = document.createElement('div');
        message.style.cssText = 'color:#fff;background:rgba(0,0,0,0.75);border:1px solid #ef4444;border-radius:8px;padding:12px 16px;font-family:sans-serif;font-size:14px;';
        message.textContent = 'Failed to load effect plugins. Check hub logs and reload.';
        container.appendChild(message);
      }
    });

  function connectSSE() {
  // SSE接続
  var source = new EventSource(streamUrl);
  var initialVersion = null;

  source.onopen = function () {
    console.log('[EffectsOverlay] SSE connected');
  };

  source.onmessage = function (event) {
    try {
      var msg = JSON.parse(event.data);

      if (msg.type === 'performance') {
        Renderer.execute(msg.data);
      } else if (msg.type === 'performance-clear') {
        Renderer.clear();
      } else if (msg.type === 'pause') {
        var isPaused = msg.data && msg.data.paused;
        // 動的にpause対応プラグインに通知
        var all = PluginLoader.getAll();
        for (var type in all) {
          if (all[type].manifest.interface.hasPause && all[type].handler.setPaused) {
            all[type].handler.setPaused(isPaused);
          }
        }
        console.log('[EffectsOverlay] Paused:', isPaused);
      } else if (msg.type === 'reload') {
        location.reload();
      } else if (msg.type === 'version') {
        // 初回はバージョンを記録。再接続時にバージョンが変わっていたらリロード
        if (initialVersion === null) {
          initialVersion = msg.data;
          console.log('[EffectsOverlay] Server version:', msg.data);
        } else {
          // 再接続検出 → プラグイン再ロードのためリロード
          // 短時間での連続リロードを防止（5秒以内の再接続はスキップ）
          var now = Date.now();
          if (!window._lastReload || now - window._lastReload > 5000) {
            window._lastReload = now;
            console.log('[EffectsOverlay] Reconnected, reloading');
            location.reload();
          }
        }
      }
    } catch (e) {
      // パースエラーは無視
    }
  };

  source.onerror = function () {
    console.log('[EffectsOverlay] SSE connection error, will auto-reconnect');
  };

  // デバッグ用: コンソールから手動テスト可能
  window.testEffect = function (type, assets) {
    Renderer.execute({
      effect: {
        type: type || 'com.comment-hub.cracker',
        params: Renderer.container ? {} : {}
      },
      assets: assets || ['🎉'],
      sound: null
    });
  };
  } // connectSSE

  // /api/health の bootId をポーリングし、値が変わったら (= ハブ再起動) キャッシュバスト
  // 付きで reload して自己回復する。EventSource が再接続できず OBS で「透明・演出ゼロ」の
  // まま固まる状況でも、fetch ポーリングが確実にハブ復帰を検知する (= 張り直し不要)。
  function startBootIdWatch() {
    var knownBootId = null;
    var recovering = false;
    setInterval(function () {
      if (recovering) return;
      fetch('/api/health?_=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          if (!info || !info.bootId) return;
          if (knownBootId === null) {
            knownBootId = info.bootId; // 初回ポーリング = baseline 記録
            return;
          }
          if (info.bootId !== knownBootId) {
            recovering = true;
            console.log('[EffectsOverlay] hub restart detected (bootId changed), reloading');
            // 物理的に URL を変えて CEF のサブリソースキャッシュを確実に回避する。
            location.replace(location.pathname + '?_kh=' + encodeURIComponent(info.bootId));
          }
        })
        .catch(function () { /* ハブダウン中: 次回ポーリングで復帰を検知する */ });
    }, 2000);
  }
})();
