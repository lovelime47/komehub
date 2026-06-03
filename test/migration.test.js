const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compareVersion, run } = require('../electron/migration');

describe('compareVersion', function () {
  it('equal versions', function () {
    assert.equal(compareVersion('1.0.0', '1.0.0'), 0);
  });

  it('major difference', function () {
    assert.equal(compareVersion('1.0.0', '2.0.0'), -1);
    assert.equal(compareVersion('2.0.0', '1.0.0'), 1);
  });

  it('minor difference', function () {
    assert.equal(compareVersion('0.2.0', '0.3.0'), -1);
    assert.equal(compareVersion('0.3.0', '0.2.0'), 1);
  });

  it('patch difference', function () {
    assert.equal(compareVersion('0.2.1', '0.2.3'), -1);
    assert.equal(compareVersion('0.2.3', '0.2.1'), 1);
  });

  it('null/undefined treated as 0.0.0', function () {
    assert.equal(compareVersion(null, '0.1.0'), -1);
    assert.equal(compareVersion(undefined, '0.0.1'), -1);
    assert.equal(compareVersion(null, null), 0);
  });

  it('upgrade path detection', function () {
    assert.ok(compareVersion('0.2.0', '0.3.0') < 0);
    assert.ok(compareVersion('0.3.0', '0.3.0') >= 0);
    assert.ok(compareVersion('0.3.0', '0.2.0') >= 0);
  });

  it('prerelease < release of same core', function () {
    assert.equal(compareVersion('0.3.1-beta', '0.3.1'), -1);
    assert.equal(compareVersion('0.3.1', '0.3.1-beta'), 1);
  });

  it('different prerelease of same core are not equal', function () {
    // ★旧バグ回帰: "1-beta".map(Number)=NaN→0 で beta と beta2 が「同一」と誤判定され、
    // beta テスターへの version-gated マイグレーションが全スキップされていた。
    assert.equal(compareVersion('0.3.1-beta', '0.3.1-beta2'), -1);
    assert.equal(compareVersion('0.3.1-beta2', '0.3.1-beta'), 1);
    assert.equal(compareVersion('0.3.1-beta', '0.3.1-beta'), 0);
  });

  it('prerelease core still compared numerically', function () {
    assert.equal(compareVersion('0.3.1-beta', '0.4.0'), -1);
    assert.equal(compareVersion('0.4.0', '0.3.1-beta'), 1);
    // beta → 正式版 release は upgrade とみなす (= マイグレーション走る)
    assert.ok(compareVersion('0.3.1-beta', '0.4.0') < 0);
  });
});

describe('migration run', function () {
  var tmpDir;
  var fakeStore;
  var originalCopyFileSync;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'komehub-test-'));
    originalCopyFileSync = fs.copyFileSync;

    // fakeStore: electron-storeの最小モック
    var storeData = { lastVersion: '0.0.0', bannedUsers: [] };
    fakeStore = {
      get: function (key) { return storeData[key]; },
      set: function (key, val) { storeData[key] = val; },
      delete: function (key) { delete storeData[key]; },
      _data: storeData
    };
  });

  afterEach(function () {
    fs.copyFileSync = originalCopyFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips if already at current version', function () {
    fakeStore._data.lastVersion = '0.3.0';
    run(fakeStore, tmpDir, '0.3.0');
    assert.equal(fakeStore.get('lastVersion'), '0.3.0');
  });

  it('updates lastVersion after migration', function () {
    fakeStore._data.lastVersion = '0.2.0';
    // scenesディレクトリがなくてもクラッシュしない
    run(fakeStore, tmpDir, '0.3.0');
    assert.equal(fakeStore.get('lastVersion'), '0.3.0');
  });

  it('migrates bannedUsers from string to object', function () {
    fakeStore._data.lastVersion = '0.2.0';
    fakeStore._data.bannedUsers = ['user1', 'user2'];

    run(fakeStore, tmpDir, '0.3.0');

    var config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'app-config.json'), 'utf-8'));
    var banned = config.bannedUsers;
    assert.equal(banned.length, 2);
    assert.equal(banned[0].id, 'user1');
    assert.equal(banned[0].name, 'user1');
    assert.equal(typeof banned[0].profileImage, 'string');
    assert.equal(fakeStore.get('bannedUsers'), undefined);
  });

  it('preserves existing app-config currentPreset over legacy store', function () {
    fakeStore._data.lastVersion = '0.2.0';
    fakeStore._data.currentPreset = 'Legacy Preset';
    fs.writeFileSync(path.join(tmpDir, 'app-config.json'), JSON.stringify({
      currentPreset: 'Existing Preset',
      activeSceneId: 'game'
    }, null, 2));

    run(fakeStore, tmpDir, '0.3.0');

    var config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'app-config.json'), 'utf-8'));
    assert.equal(config.currentPreset, 'Existing Preset');
    assert.equal(config.activeSceneId, 'game');
    assert.equal(fakeStore.get('currentPreset'), undefined);
  });

  it('does not re-migrate already-object bannedUsers', function () {
    fakeStore._data.lastVersion = '0.2.0';
    fakeStore._data.bannedUsers = [{ id: 'user1', name: 'User One', profileImage: 'http://img' }];

    run(fakeStore, tmpDir, '0.3.0');

    var config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'app-config.json'), 'utf-8'));
    var banned = config.bannedUsers;
    assert.equal(banned[0].name, 'User One');
    assert.equal(banned[0].profileImage, 'http://img');
    assert.equal(fakeStore.get('bannedUsers'), undefined);
  });

  it('creates mascot dir from global assets', function () {
    fakeStore._data.lastVersion = '0.2.0';

    // グローバルassetsを作成
    var assetsDir = path.join(tmpDir, 'assets');
    var framesDir = path.join(assetsDir, 'frames');
    var particlesDir = path.join(assetsDir, 'particles');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(particlesDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify({
      frameInterval: 100,
      reactDuration: 3000,
      particles: { heart: ['heart_1.png'] },
      patterns: { heart: 'pop', smile: 'scatter' }
    }));
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), 'fake-icon');
    fs.writeFileSync(path.join(framesDir, 'frame_00.png'), 'fake-frame');
    fs.writeFileSync(path.join(particlesDir, 'heart_1.png'), 'fake-particle');

    // シーンを作成（mascotのpatternsは空）
    var sceneDir = path.join(tmpDir, 'scenes', 'game');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({
      name: 'Test Scene',
      mascot: { frameInterval: 150, reactDuration: 2000, particles: {}, patterns: {} }
    }));

    run(fakeStore, tmpDir, '0.3.0');

    // mascotディレクトリが作成されたか
    var mascotDir = path.join(sceneDir, 'mascot');
    assert.ok(fs.existsSync(mascotDir));
    assert.ok(fs.existsSync(path.join(mascotDir, 'config.json')));
    assert.ok(fs.existsSync(path.join(mascotDir, 'icon.png')));
    assert.ok(fs.existsSync(path.join(mascotDir, 'frames', 'frame_00.png')));
    assert.ok(fs.existsSync(path.join(mascotDir, 'particles', 'heart_1.png')));

    // config.jsonの内容: scene.jsonのmascotが空patternsなのでグローバルで補完
    var config = JSON.parse(fs.readFileSync(path.join(mascotDir, 'config.json'), 'utf-8'));
    assert.equal(config.frameInterval, 150); // scene.jsonの値
    assert.equal(config.patterns.heart, 'pop'); // グローバルで補完
    assert.equal(config.patterns.smile, 'scatter');
  });

  it('preserves scene mascot patterns over global', function () {
    fakeStore._data.lastVersion = '0.2.0';

    var assetsDir = path.join(tmpDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify({
      patterns: { heart: 'pop', smile: 'scatter' }
    }));

    var sceneDir = path.join(tmpDir, 'scenes', 'game');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({
      name: 'Test',
      mascot: { patterns: { heart: 'rain', smile: 'bounce' } }
    }));

    run(fakeStore, tmpDir, '0.3.0');

    var config = JSON.parse(fs.readFileSync(path.join(sceneDir, 'mascot', 'config.json'), 'utf-8'));
    assert.equal(config.patterns.heart, 'rain'); // scene.jsonの値が優先
    assert.equal(config.patterns.smile, 'bounce');
  });

  it('does not overwrite existing mascot dir', function () {
    fakeStore._data.lastVersion = '0.2.0';

    var sceneDir = path.join(tmpDir, 'scenes', 'game');
    var mascotDir = path.join(sceneDir, 'mascot');
    fs.mkdirSync(mascotDir, { recursive: true });
    fs.writeFileSync(path.join(mascotDir, 'config.json'), JSON.stringify({ custom: true }));

    run(fakeStore, tmpDir, '0.3.0');

    var config = JSON.parse(fs.readFileSync(path.join(mascotDir, 'config.json'), 'utf-8'));
    assert.equal(config.custom, true); // 上書きされていない
  });

  it('handles fresh install (no scenes dir)', function () {
    fakeStore._data.lastVersion = '0.0.0';
    // scenesディレクトリなし
    assert.doesNotThrow(function () {
      run(fakeStore, tmpDir, '0.3.0');
    });
    assert.equal(fakeStore.get('lastVersion'), '0.3.0');
  });

  it('does not advance lastVersion when a migration fails', function () {
    fakeStore._data.lastVersion = '0.2.0';

    var assetsDir = path.join(tmpDir, 'assets');
    var framesDir = path.join(assetsDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), 'fake-icon');
    fs.writeFileSync(path.join(framesDir, 'frame_00.png'), 'fake-frame');

    var sceneDir = path.join(tmpDir, 'scenes', 'game');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({
      name: 'Test Scene',
      mascot: {}
    }));

    fs.copyFileSync = function (srcPath, destPath) {
      if (srcPath === path.join(assetsDir, 'icon.png')) {
        throw new Error('copy failed');
      }
      return originalCopyFileSync(srcPath, destPath);
    };

    run(fakeStore, tmpDir, '0.3.0');

    assert.equal(fakeStore.get('lastVersion'), '0.2.0');
    assert.equal(fakeStore.get('bannedUsers').length, 0);
  });

  it('0.5.1: fixes game first-time-welcome trigger (superchat -> first-time)', function () {
    fakeStore._data.lastVersion = '0.5.0'; // 0.5.1 マイグレーションだけ走らせる
    var sceneDir = path.join(tmpDir, 'scenes', 'game');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({
      name: 'ゲーム',
      performances: [
        {
          id: 'first-time-welcome', name: '初見歓迎', effect: 'com.comment-hub.fixed',
          trigger: { type: 'superchat', keywords: [], listenerStatus: '' }
        }
      ]
    }, null, 2));

    run(fakeStore, tmpDir, '0.5.1');

    var s = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf-8'));
    var p = s.performances.find(function (x) { return x.id === 'first-time-welcome'; });
    assert.equal(p.trigger.type, 'keyword');
    assert.equal(p.trigger.listenerStatus, 'first-time');
    assert.equal(fakeStore.get('lastVersion'), '0.5.1');
  });

  it('0.5.1: leaves an already-correct first-time-welcome unchanged', function () {
    fakeStore._data.lastVersion = '0.5.0';
    var sceneDir = path.join(tmpDir, 'scenes', 'chat');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({
      performances: [
        { id: 'first-time-welcome', trigger: { type: 'keyword', listenerStatus: 'first-time' } }
      ]
    }, null, 2));

    run(fakeStore, tmpDir, '0.5.1');

    var s = JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf-8'));
    assert.equal(s.performances[0].trigger.type, 'keyword');
    assert.equal(s.performances[0].trigger.listenerStatus, 'first-time');
  });

  it('0.5.1: does not touch a non-welcome superchat perf', function () {
    fakeStore._data.lastVersion = '0.5.0';
    var sceneDir = path.join(tmpDir, 'scenes', 'game');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({
      performances: [
        { id: 'superchat-display', name: 'スパチャ宝箱', trigger: { type: 'superchat', listenerStatus: '' } }
      ]
    }, null, 2));

    run(fakeStore, tmpDir, '0.5.1');

    // 初見歓迎ではない (id 違い) ので変更されない
    assert.equal(JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf-8')).performances[0].trigger.type, 'superchat');
  });
});
