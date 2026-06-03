const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_NODE_PATH = path.join(PROJECT_ROOT, 'core', 'target', 'debug', 'komehub_core.node');
const DLL_PATH = path.join(PROJECT_ROOT, 'core', 'target', 'debug', 'komehub_core.dll');
const SO_PATH = path.join(PROJECT_ROOT, 'core', 'target', 'debug', 'libkomehub_core.so');
const DYLIB_PATH = path.join(PROJECT_ROOT, 'core', 'target', 'debug', 'libkomehub_core.dylib');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'core', 'Cargo.toml');

function resolveCargoCommand() {
  var candidates = [];
  var i;

  if (process.env.CARGO) candidates.push(process.env.CARGO);
  candidates.push('cargo');
  if (process.platform === 'win32') {
    candidates.push(path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.cargo', 'bin', 'cargo'));
  }

  for (i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    var result = childProcess.spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  throw new Error('cargo command not found. Set CARGO or install Rust toolchain.');
}

function ensureNativeModuleBuilt() {
  var cargo = resolveCargoCommand();
  var result = childProcess.spawnSync(
    cargo,
    ['build', '--manifest-path', MANIFEST_PATH],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('cargo build failed with exit code ' + result.status);
  }
}

function prepareNativeModulePath(outputPath) {
  var sourcePath = DEFAULT_NODE_PATH;
  if (process.platform === 'win32' && fs.existsSync(DLL_PATH)) {
    sourcePath = DLL_PATH;
  } else if (process.platform === 'darwin' && fs.existsSync(DYLIB_PATH)) {
    sourcePath = DYLIB_PATH;
  } else if (process.platform !== 'win32' && fs.existsSync(SO_PATH)) {
    sourcePath = SO_PATH;
  }

  assert.ok(fs.existsSync(sourcePath), 'native module not found: ' + sourcePath);
  fs.copyFileSync(sourcePath, outputPath);
  return outputPath;
}

module.exports = {
  DEFAULT_NODE_PATH,
  DLL_PATH,
  SO_PATH,
  DYLIB_PATH,
  MANIFEST_PATH,
  ensureNativeModuleBuilt,
  prepareNativeModulePath,
  resolveCargoCommand
};
