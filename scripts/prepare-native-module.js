#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// 配布バイナリは release ビルド固定 (= CLAUDE.md ハード制約)。debug ビルドを
// 同梱すると最適化なし + シンボル付きで配布サイズと性能が悪化する。
const profile = process.env.KOMEHUB_BUILD_PROFILE === 'debug' ? 'debug' : 'release';
const targetDir = path.join(root, 'core', 'target', profile);
const outputPath = path.join(targetDir, 'komehub_core.node');

const candidates = process.platform === 'win32'
  ? ['komehub_core.dll', 'komehub_core.node']
  : process.platform === 'darwin'
    ? ['libkomehub_core.dylib', 'komehub_core.node']
    : ['libkomehub_core.so', 'komehub_core.node'];

const sourceName = candidates.find((name) => {
  const candidate = path.join(targetDir, name);
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
});

if (!sourceName) {
  throw new Error('Native module artifact was not found in ' + targetDir);
}

const sourcePath = path.join(targetDir, sourceName);
if (path.resolve(sourcePath) !== path.resolve(outputPath)) {
  fs.copyFileSync(sourcePath, outputPath);
}

console.log('Prepared native module:', path.relative(root, outputPath), '<-', sourceName);
