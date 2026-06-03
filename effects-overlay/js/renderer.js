/**
 * エフェクトレンダラー統括
 * 演出指示を受け取り、適切なレンダラーに振り分ける
 */

// --- 素材ユーティリティ（全レンダラーから使用） ---

function isImageUrl(asset) {
  if (!asset || typeof asset !== 'string') return false;
  return /\.(png|jpg|jpeg|gif|apng|svg|webp)(\?|$)/i.test(asset) || asset.startsWith('http') || asset.startsWith('data:image/');
}

function isVideoAsset(asset) {
  if (!asset || typeof asset !== 'string') return false;
  return /\.webm(\?|$)/i.test(asset);
}

function isHtmlAsset(asset) {
  if (!asset || typeof asset !== 'string') return false;
  return /\.html(\?|$)/i.test(asset);
}

function setAssetContent(el, asset, size) {
  if (isImageUrl(asset)) {
    var img = document.createElement('img');
    img.src = asset;
    img.style.width = size + 'px';
    img.style.height = size + 'px';
    img.style.objectFit = 'contain';
    el.appendChild(img);
    el.style.width = size + 'px';
    el.style.height = size + 'px';
  } else {
    // 絵文字テキスト
    el.textContent = asset;
    el.style.fontSize = size + 'px';
    el.style.lineHeight = '1';
  }
}

// 落下物デフォルト素材: CSSデコレーションした「ｗ」のSVG
var W_SVGS = [
  // A: ピンク丸
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b9d"/><stop offset="1" stop-color="#c44dff"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#a)"/><text x="32" y="42" text-anchor="middle" font-size="32" font-weight="900" fill="white">ｗ</text></svg>'),
  // B: 角丸カード
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd54f"/><stop offset="1" stop-color="#ffb300"/></linearGradient></defs><rect x="2" y="2" width="54" height="54" rx="14" fill="url(#b)"/><rect x="4" y="5" width="54" height="54" rx="14" fill="#e65100" opacity="0.3"/><text x="30" y="40" text-anchor="middle" font-size="30" font-weight="900" fill="#5d4037">ｗ</text></svg>'),
  // C: ネオン
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><filter id="c"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><text x="32" y="44" text-anchor="middle" font-size="44" font-weight="900" fill="#00ffff" filter="url(#c)">ｗ</text></svg>'),
  // D: ふわパステル
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fce4ec"/><stop offset="1" stop-color="#f3e5f5"/></linearGradient></defs><circle cx="32" cy="32" r="29" fill="url(#d)" stroke="#f48fb1" stroke-width="3"/><text x="32" y="42" text-anchor="middle" font-size="28" font-weight="900" fill="#e91e63">ｗ</text></svg>'),
  // E: 吹き出し
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="64"><rect x="2" y="2" width="56" height="48" rx="24" fill="white"/><polygon points="30,50 24,58 36,58" fill="white"/><text x="30" y="34" text-anchor="middle" font-size="26" font-weight="900" fill="#7c3aed">ｗ</text></svg>'),
  // G: レインボー
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b6b"/><stop offset="0.33" stop-color="#feca57"/><stop offset="0.66" stop-color="#48dbfb"/><stop offset="1" stop-color="#ff9ff3"/></linearGradient></defs><text x="32" y="46" text-anchor="middle" font-size="52" font-weight="900" fill="url(#g)">ｗ</text></svg>'),
  // H: もこもこ雲
  'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="64"><ellipse cx="36" cy="38" rx="34" ry="24" fill="white"/><circle cx="18" cy="22" r="12" fill="white"/><circle cx="50" cy="20" r="10" fill="white"/><circle cx="34" cy="16" r="14" fill="white"/><text x="36" y="46" text-anchor="middle" font-size="28" font-weight="900" fill="#ff4081">ｗ</text></svg>'),
  // おまけ: 笑い絵文字
  '🤣'
];

function resolveAssets(assets, assetsBase, effectType) {
  if (!assets || assets.length === 0) {
    // プラグインのmanifestからデフォルト素材を取得
    var plugin = PluginLoader.get(effectType);
    var defaults = plugin && plugin.manifest.defaultAssets;
    // fall は特殊: SVG素材がある場合はそちらを使う
    if (effectType === 'com.comment-hub.fall' && W_SVGS && W_SVGS.length > 0) return W_SVGS;
    // defaultAssetsが明示的に定義されていればそれを使う（空配列も尊重）
    if (defaults) return defaults;
    return ['🎉'];
  }
  return assets.map(function (asset) {
    // 絵文字・テキスト素材（ファイルパスでないもの）はそのまま
    if (!/[./\\]/.test(asset) && !asset.startsWith('data:')) return asset;
    // URLはそのまま
    if (asset.startsWith('http')) return asset;
    // ファイル名にはassetsBaseを付与
    return assetsBase + asset;
  });
}

function resolveSounds(sounds, assetsBase) {
  if (!sounds || sounds.length === 0) return [];
  return sounds.map(function (snd) {
    if (snd.startsWith('http')) return snd;
    return assetsBase + snd;
  });
}

// --- レンダラー統括 ---

var MAX_OVERLAY_EFFECTS = 30; // エフェクト発火回数の上限（パーティクル個数ではない）
var activeOverlayEffects = 0;

var Renderer = {
  container: null,
  assetsBase: '',

  init: function (container, assetsBase) {
    this.container = container;
    this.assetsBase = assetsBase;

    // 全プラグインを初期化
    var all = PluginLoader.getAll();
    for (var type in all) {
      if (all[type].handler && all[type].handler.init) {
        all[type].handler.init(container);
      }
    }
  },

  execute: function (data) {
    var effect = data.effect;
    if (!effect || !effect.type) return;

    var plugin = PluginLoader.get(effect.type);
    if (!plugin) {
      console.log('[Renderer] Unknown effect type:', effect.type);
      return;
    }

    // オーバーレイ側の同時表示上限チェック
    if (activeOverlayEffects >= MAX_OVERLAY_EFFECTS) return;
    activeOverlayEffects++;
    var duration = (effect.params && effect.params.duration) || 2000;
    setTimeout(function () { activeOverlayEffects--; }, duration);

    var assets = resolveAssets(data.assets, this.assetsBase, effect.type);
    var rawSounds = data.sounds || [];
    var sounds = rawSounds.length > 0 ? resolveSounds(rawSounds, this.assetsBase) : [];

    // 素材と効果音のインデックスを合わせる
    var maxLen = Math.max(assets.length, sounds.length, 1);
    var idx = Math.floor(Math.random() * maxLen);
    var pickedAsset = assets.length > 0 ? assets[idx % assets.length] : null;
    var pickedSound = sounds.length > 0 ? sounds[idx % sounds.length] : null;

    var pickedAssets = pickedAsset ? [pickedAsset] : assets;

    // 動的ディスパッチ: manifestのmethodsに従ってfire/showを呼ぶ
    var method = plugin.manifest.interface.methods[0];
    // uiSchema の image 型値 (= 素材ファイル名) を plugin 側で URL 化できるよう assetsBase を渡す
    data._assetsBase = this.assetsBase;
    if (plugin.handler[method]) {
      plugin.handler[method](effect.params, pickedAssets, data);
    }

    if (pickedSound) {
      Sound.play(pickedSound);
    }
  },

  clear: function () {
    activeOverlayEffects = 0;
    if (this.container) this.container.innerHTML = '';
    if (window.Physics && typeof window.Physics.clear === 'function') {
      window.Physics.clear();
    }
  }
};
