var fs = require('fs');
var path = require('path');

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  var entries = fs.readdirSync(src, { withFileTypes: true });
  entries.forEach(function (entry) {
    var srcPath = path.join(src, entry.name);
    var destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

function makeTempSiblingPath(targetPath, suffix) {
  return path.join(
    path.dirname(targetPath),
    '.' + path.basename(targetPath) + '.' + suffix + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  );
}

function replaceDirSync(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error('Source directory does not exist: ' + src);
  }

  var destParent = path.dirname(dest);
  if (!fs.existsSync(destParent)) fs.mkdirSync(destParent, { recursive: true });

  var tempDest = makeTempSiblingPath(dest, 'incoming');
  var backupDest = makeTempSiblingPath(dest, 'backup');
  var hadDest = fs.existsSync(dest);

  try {
    copyDirSync(src, tempDest);
    if (!fs.existsSync(tempDest)) {
      throw new Error('Failed to stage directory copy: ' + src);
    }

    if (hadDest) {
      fs.renameSync(dest, backupDest);
    }

    fs.renameSync(tempDest, dest);

    if (hadDest && fs.existsSync(backupDest)) {
      fs.rmSync(backupDest, { recursive: true, force: true });
    }
  } catch (e) {
    if (fs.existsSync(tempDest)) {
      fs.rmSync(tempDest, { recursive: true, force: true });
    }

    if (hadDest && fs.existsSync(backupDest)) {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.renameSync(backupDest, dest);
    }

    throw e;
  }
}

module.exports = {
  copyDirSync: copyDirSync,
  replaceDirSync: replaceDirSync
};
