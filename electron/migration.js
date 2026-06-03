/**
 * データマイグレーション
 * バージョンアップ時にデータ構造を順次移行する
 */
const fs = require('fs');
const path = require('path');
var log = require('./log');
var L = log.create('Migration');

// バージョン比較（semver簡易版）。
// prerelease タグ (= "0.3.1-beta" 等) を正しく扱う。旧実装は "1-beta".map(Number) が NaN になり
// `NaN || 0` で patch が 0 に潰れていたため、同じ X.Y.Z で prerelease 違い (例: 0.3.1-beta と
// 0.3.1-beta2) が「同一」と誤判定され、beta テスターへの version-gated マイグレーションが
// 全スキップされる landmine があった (2026-05-25 認識)。core を数値、prerelease を分離して比較する。
function compareVersion(a, b) {
  function parse(v) {
    var str = String(v == null ? '0.0.0' : v);
    var dash = str.indexOf('-');
    var core = dash >= 0 ? str.slice(0, dash) : str;
    var pre = dash >= 0 ? str.slice(dash + 1) : '';
    var nums = core.split('.').map(function (x) {
      var n = parseInt(x, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { nums: nums, pre: pre };
  }
  var pa = parse(a);
  var pb = parse(b);
  for (var i = 0; i < 3; i++) {
    var na = pa.nums[i] || 0;
    var nb = pb.nums[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  // X.Y.Z が等しい場合: prerelease あり < prerelease なし (= 正式版)。semver と同じ順序。
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}

// === マイグレーション定義 ===

var MIGRATIONS = [
  {
    version: '0.3.0',
    run: function (ctx) {
      L.info('Running 0.3.0: Scene-based mascot assets');

      // 1. グローバルassetsの設定を各シーンのmascot/にコピー
      var globalAssetsDir = path.join(ctx.userDataDir, 'assets');
      var globalConfig = {};
      var globalConfigPath = path.join(globalAssetsDir, 'config.json');
      try {
        globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
      } catch (e) { /* ignore */ }

      var scenesDir = path.join(ctx.userDataDir, 'scenes');
      if (fs.existsSync(scenesDir)) {

      var sceneIds = fs.readdirSync(scenesDir).filter(function (f) {
        return fs.statSync(path.join(scenesDir, f)).isDirectory();
      });

      sceneIds.forEach(function (sceneId) {
        var mascotDir = path.join(scenesDir, sceneId, 'mascot');
        if (fs.existsSync(path.join(mascotDir, 'config.json'))) return; // 既に移行済み

        // ディレクトリ作成
        var framesDir = path.join(mascotDir, 'frames');
        var particlesDir = path.join(mascotDir, 'particles');
        if (!fs.existsSync(mascotDir)) fs.mkdirSync(mascotDir, { recursive: true });
        if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
        if (!fs.existsSync(particlesDir)) fs.mkdirSync(particlesDir, { recursive: true });

        // config.json: scene.jsonのmascotフィールドをベースにグローバル設定で補完
        var sceneJsonPath = path.join(scenesDir, sceneId, 'scene.json');
        var sceneData = {};
        try { sceneData = JSON.parse(fs.readFileSync(sceneJsonPath, 'utf-8')); } catch (e) { /* ignore */ }
        var mascotData = sceneData.mascot || {};

        var DEFAULT_PATTERNS = { heart: 'float-up', smile: 'pop', celebration: 'scatter', surprise: 'bounce', hundred: 'spiral' };

        var configData = {
          frameInterval: mascotData.frameInterval || globalConfig.frameInterval || 150,
          reactDuration: mascotData.reactDuration || globalConfig.reactDuration || 2000,
          particles: mascotData.particles || globalConfig.particles || {},
          patterns: mascotData.patterns && Object.keys(mascotData.patterns).length > 0
            ? mascotData.patterns
            : (globalConfig.patterns && Object.keys(globalConfig.patterns).length > 0 ? globalConfig.patterns : DEFAULT_PATTERNS)
        };

        fs.writeFileSync(path.join(mascotDir, 'config.json'), JSON.stringify(configData, null, 2));

        // icon.png
        var globalIcon = path.join(globalAssetsDir, 'icon.png');
        if (fs.existsSync(globalIcon)) {
          fs.copyFileSync(globalIcon, path.join(mascotDir, 'icon.png'));
        }

        // frames/
        var globalFrames = path.join(globalAssetsDir, 'frames');
        if (fs.existsSync(globalFrames)) {
          fs.readdirSync(globalFrames).forEach(function (f) {
            fs.copyFileSync(path.join(globalFrames, f), path.join(framesDir, f));
          });
        }

        // particles/
        var globalParticles = path.join(globalAssetsDir, 'particles');
        if (fs.existsSync(globalParticles)) {
          fs.readdirSync(globalParticles).forEach(function (f) {
            fs.copyFileSync(path.join(globalParticles, f), path.join(particlesDir, f));
          });
        }

        L.info('Migrated mascot assets for scene:', sceneId);
      });

      } // end scenesDir exists

      // 2. bannedUsersの文字列→オブジェクト変換
      var banned = ctx.store.get('bannedUsers') || [];
      var needsUpdate = banned.some(function (b) { return typeof b === 'string'; });
      if (needsUpdate) {
        banned = banned.map(function (b) {
          return typeof b === 'string' ? { id: b, name: b, profileImage: '' } : b;
        });
        ctx.store.set('bannedUsers', banned);
        L.info('Converted bannedUsers to object format');
      }

      // 3. currentPreset を Rust app-config.json へ移行
      var legacyPreset = ctx.store.get('currentPreset');
      var appConfig = readAppConfig(ctx.userDataDir);
      if (!appConfig.currentPreset && typeof legacyPreset === 'string' && legacyPreset) {
        appConfig.currentPreset = legacyPreset;
        writeAppConfig(ctx.userDataDir, appConfig);
        L.info('Migrated currentPreset into app-config.json');
      }
      if (typeof ctx.store.delete === 'function') {
        ctx.store.delete('currentPreset');
      } else {
        ctx.store.set('currentPreset', undefined);
      }

      // 4. Rust 正本へ移した設定を app-config.json に移行
      migrateRustOwnedLegacySettings(ctx.store, ctx.userDataDir);
    }
  },
  {
    // 2026-05-09 仕様変更: 旧 BAN (= 演出フィルタ) を「コメ非表示 / リスナー非表示」2 軸に置換。
    // 演出フィルタは廃止。app-config.json の banned_users をクリアし、新フィールド hidden_listeners を初期化。
    // 旧データを keep して 2 軸両方 ON で migrate も検討したが、ユーザーの選択は「クリア」。
    version: '0.3.1',
    run: function (ctx) {
      L.info('Running 0.3.1: BAN -> hidden_listeners 仕様変更 (= 旧 banned_users をクリア)');
      var appConfig = readAppConfig(ctx.userDataDir);
      var hadOldBanned = Array.isArray(appConfig.bannedUsers) && appConfig.bannedUsers.length > 0;
      delete appConfig.bannedUsers;
      appConfig.hiddenListeners = [];
      writeAppConfig(ctx.userDataDir, appConfig);
      if (hadOldBanned) {
        L.info('Cleared legacy bannedUsers (= 演出フィルタ廃止に伴い再設定が必要、UI から再登録してください)');
      }
    }
  },
  {
    // 2026-06-04: 出荷バグ修正。ゲーム scene の初見歓迎 (id=first-time-welcome) の trigger が
    // 誤って「スパチャ発火」(type=superchat / listenerStatus 空) になっていた。本来は「初見さんの
    // 初コメント発火」(type=keyword / listenerStatus=first-time、chat/singing と同じ)。デフォルト
    // scene は 0.5.1 で修正済みだが、既にインストール済みユーザーの scene.json は古い誤設定が残る
    // ため修正する。誤設定の指紋 (id + superchat + 空 listenerStatus) に一致するものだけ直す
    // (= ユーザーが意図的に変えた設定は触らない)。データ形式変更ではなく値の修正。
    version: '0.5.1',
    run: function (ctx) {
      L.info('Running 0.5.1: ゲーム初見歓迎の trigger 誤設定 (superchat→first-time) を修正');
      var scenesDir = path.join(ctx.userDataDir, 'scenes');
      if (!fs.existsSync(scenesDir)) return;

      var sceneIds = fs.readdirSync(scenesDir).filter(function (f) {
        try { return fs.statSync(path.join(scenesDir, f)).isDirectory(); } catch (e) { return false; }
      });

      sceneIds.forEach(function (sceneId) {
        var sceneJsonPath = path.join(scenesDir, sceneId, 'scene.json');
        var sceneData;
        try { sceneData = JSON.parse(fs.readFileSync(sceneJsonPath, 'utf-8')); } catch (e) { return; }
        if (!Array.isArray(sceneData.performances)) return;

        var changed = false;
        sceneData.performances.forEach(function (p) {
          // 誤設定の指紋: 初見歓迎 perf (id=first-time-welcome) が superchat 発火 + listenerStatus 空。
          if (p && p.id === 'first-time-welcome' && p.trigger &&
              p.trigger.type === 'superchat' && !p.trigger.listenerStatus) {
            p.trigger.type = 'keyword';
            p.trigger.listenerStatus = 'first-time';
            changed = true;
          }
        });

        if (changed) {
          fs.writeFileSync(sceneJsonPath, JSON.stringify(sceneData, null, 2));
          L.info('Fixed first-time-welcome trigger (superchat->first-time) in scene:', sceneId);
        }
      });
    }
  }
];

// === マイグレーション実行 ===

function run(store, userDataDir, currentVersion) {
  var lastVersion = store.get('lastVersion') || '0.0.0';

  if (compareVersion(lastVersion, currentVersion) >= 0) {
    return; // マイグレーション不要
  }

  L.info('Upgrading from', lastVersion, 'to', currentVersion);

  var ctx = { store: store, userDataDir: userDataDir };
  var appliedVersion = lastVersion;

  for (var i = 0; i < MIGRATIONS.length; i++) {
    var migration = MIGRATIONS[i];
    if (compareVersion(appliedVersion, migration.version) < 0 && compareVersion(migration.version, currentVersion) <= 0) {
      try {
        migration.run(ctx);
        appliedVersion = migration.version;
        store.set('lastVersion', appliedVersion);
        L.info('Completed:', migration.version);
      } catch (e) {
        L.error('Failed:', migration.version, e);
        L.warn('Migration stopped. Version remains at', appliedVersion);
        return;
      }
    }
  }

  if (compareVersion(appliedVersion, currentVersion) < 0) {
    appliedVersion = currentVersion;
    store.set('lastVersion', appliedVersion);
  }
  L.info('All migrations complete. Version set to', appliedVersion);
}

function readAppConfig(userDataDir) {
  var configPath = path.join(userDataDir, 'app-config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (_e) {
    return {};
  }
}

function writeAppConfig(userDataDir, config) {
  var configPath = path.join(userDataDir, 'app-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function migrateRustOwnedLegacySettings(store, userDataDir) {
  var appConfig = readAppConfig(userDataDir);
  var changed = false;

  var legacyBanned = store.get('bannedUsers');
  if (Array.isArray(legacyBanned)) {
    var normalizedBanned = legacyBanned
      .map(normalizeLegacyBannedUser)
      .filter(function (user) { return user && user.id; });
    if (!Array.isArray(appConfig.bannedUsers) || appConfig.bannedUsers.length === 0) {
      if (normalizedBanned.length > 0) {
        appConfig.bannedUsers = normalizedBanned;
        changed = true;
        L.info('Migrated bannedUsers into app-config.json');
      }
    }
    deleteStoreKey(store, 'bannedUsers');
  }

  var legacyGlobalCooldown = normalizeLegacyGlobalCooldown(store.get('globalCooldown'));
  if (legacyGlobalCooldown) {
    if (!appConfig.globalCooldown) {
      appConfig.globalCooldown = legacyGlobalCooldown;
      changed = true;
      L.info('Migrated globalCooldown into app-config.json');
    }
    deleteStoreKey(store, 'globalCooldown');
  }

  var legacyBackupsDir = store.get('backupsDir');
  if (typeof legacyBackupsDir === 'string') {
    if (!appConfig.backupsDir && legacyBackupsDir) {
      appConfig.backupsDir = legacyBackupsDir;
      changed = true;
      L.info('Migrated backupsDir into app-config.json');
    }
    deleteStoreKey(store, 'backupsDir');
  }

  if (changed) {
    writeAppConfig(userDataDir, appConfig);
  }
}

function normalizeLegacyBannedUser(userInfo) {
  if (!userInfo) return null;
  if (typeof userInfo === 'string') {
    return { id: userInfo, name: userInfo, profileImage: '' };
  }
  return {
    id: userInfo.id || '',
    name: userInfo.name || userInfo.id || '',
    profileImage: userInfo.profileImage || ''
  };
}

function normalizeLegacyGlobalCooldown(settings) {
  if (!settings || typeof settings !== 'object') return null;
  return {
    maxEffects: typeof settings.maxEffects === 'number' ? settings.maxEffects : 30,
    userInterval: typeof settings.userInterval === 'number' ? settings.userInterval : 5
  };
}

function deleteStoreKey(store, key) {
  if (typeof store.delete === 'function') {
    store.delete(key);
  } else {
    store.set(key, undefined);
  }
}

module.exports = { run: run, compareVersion: compareVersion };
