/**
 * ロガーモジュール
 *
 * 使い方:
 *   var log = require('./log');
 *   log.init(logDir);              // 起動時に1回
 *   var L = log.create('Module');   // モジュールごとにタグ付きロガー生成
 *   L.info('message', data);
 *   L.error('failed', err);        // Errorオブジェクトはstack自動展開
 *
 * レベル: trace < debug < info < warn < error (= Rust 側 tracing と統一)
 * trace は特殊用途 (= 性能計測 / プロトコル wire debug)、 デフォルト OFF。
 *   log.setLevel('trace') で明示的に有効化する。
 * 出力先: logDir/app.log + コンソール同時出力
 * ローテーション: 起動時に世代管理（3世代保持、それ以前は削除）
 *
 * 機密情報ポリシー:
 *   - ユーザー名・パスワード・トークン・APIキーをログに含めないこと
 *   - ファイルパスに含まれるユーザー名はOS由来のため許容
 */

var fs = require('fs');
var path = require('path');
var util = require('util');

var LEVELS = { trace: -1, debug: 0, info: 1, warn: 2, error: 3 };
var LEVEL_LABELS = { trace: 'TRACE', debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
var MAX_GENERATIONS = 3; // current + 2 previous

var logDir = null;
var logStream = null;
var currentLevel = LEVELS.info;

function init(dir, opts) {
  logDir = dir;
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  if (opts && opts.level && LEVELS[opts.level] !== undefined) {
    currentLevel = LEVELS[opts.level];
  }

  rotate();

  var logPath = path.join(logDir, 'app.log');
  logStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf-8' });

  // 初回ログ
  var startLine = '=== App started at ' + formatTimestamp(new Date()) + ' ===';
  logStream.write(startLine + '\n');
  console.log(startLine);
}

function rotate() {
  // app.log → app.1.log → app.2.log → ... → 古いものは削除
  // MAX_GENERATIONS以上の古いログを削除
  for (var g = MAX_GENERATIONS + 5; g >= MAX_GENERATIONS; g--) {
    var old = path.join(logDir, 'app.' + g + '.log');
    if (fs.existsSync(old)) {
      try { fs.unlinkSync(old); } catch (e) { /* ignore */ }
    }
  }

  // 世代をシフト
  for (var i = MAX_GENERATIONS - 1; i >= 1; i--) {
    var from = path.join(logDir, i === 1 ? 'app.log' : 'app.' + (i - 1) + '.log');
    var to = path.join(logDir, 'app.' + i + '.log');
    if (fs.existsSync(from)) {
      try { fs.renameSync(from, to); } catch (e) { /* ignore */ }
    }
  }
}

function formatTimestamp(date) {
  var y = date.getFullYear();
  var mo = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  var h = String(date.getHours()).padStart(2, '0');
  var mi = String(date.getMinutes()).padStart(2, '0');
  var s = String(date.getSeconds()).padStart(2, '0');
  var ms = String(date.getMilliseconds()).padStart(3, '0');
  return y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + s + '.' + ms;
}

function formatArgs(args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg instanceof Error) {
      parts.push(arg.message);
      if (arg.stack) {
        parts.push('\n  ' + arg.stack.split('\n').slice(1).join('\n  '));
      }
    } else if (typeof arg === 'object' && arg !== null) {
      try {
        parts.push(util.inspect(arg, { depth: 3, colors: false, maxArrayLength: 20 }));
      } catch (e) {
        parts.push('[Object]');
      }
    } else {
      parts.push(String(arg));
    }
  }
  return parts.join(' ');
}

function write(level, tag, args) {
  if (LEVELS[level] < currentLevel) return;

  var timestamp = formatTimestamp(new Date());
  var label = LEVEL_LABELS[level];
  var message = formatArgs(args);
  var line = timestamp + ' [' + label + '] [' + tag + '] ' + message;

  // コンソール出力
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // ファイル出力
  if (logStream) {
    logStream.write(line + '\n');
  }
}

function create(tag) {
  return {
    trace: function () { write('trace', tag, arguments); },
    debug: function () { write('debug', tag, arguments); },
    info: function () { write('info', tag, arguments); },
    warn: function () { write('warn', tag, arguments); },
    error: function () { write('error', tag, arguments); }
  };
}

function setLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

function close() {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

module.exports = {
  init: init,
  create: create,
  setLevel: setLevel,
  close: close
};
