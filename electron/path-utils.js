var path = require('path');

function isPathInside(basePath, targetPath) {
  var relative = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// 配布版では process.resourcesPath/docs/、開発版ではリポジトリ内 docs/ を返す。
// app は electron app オブジェクト。テスト用に省略時は dev path にフォールバック。
function getDevGuideDir(app) {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'docs');
  }
  return path.join(__dirname, '..', 'docs');
}

function getDevGuideExamplesDir(app) {
  return path.join(getDevGuideDir(app), 'examples');
}

module.exports = {
  isPathInside: isPathInside,
  getDevGuideDir: getDevGuideDir,
  getDevGuideExamplesDir: getDevGuideExamplesDir
};
