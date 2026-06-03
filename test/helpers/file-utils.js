const path = require('node:path');

function sanitizeFilenameSegment(segment) {
  var sanitized = String(segment || '')
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return sanitized || 'asset';
}

function safeFilename(originalName, prefix) {
  var ext = path.extname(originalName).toLowerCase();
  var uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return sanitizeFilenameSegment(prefix) + '_' + uid + ext;
}

module.exports = {
  sanitizeFilenameSegment: sanitizeFilenameSegment,
  safeFilename: safeFilename
};
