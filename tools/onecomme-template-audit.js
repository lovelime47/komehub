'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OFFICIAL_COMMENT_DATA_FIELDS = [
  'id',
  'userId',
  'liveId',
  'name',
  'screenName',
  'isOwner',
  'isSupporter',
  'displayName',
  'nickname',
  'hasGift',
  'autoModerated',
  'profileImage',
  'originalProfileImage',
  'badges',
  'timestamp',
  'comment',
  'speechText',
  'isFirstTime',
  'isRepeater',
  'commentVisible',
  'meta'
];

const OFFICIAL_COMMENT_FIELDS = [
  'id',
  'service',
  'name',
  'url',
  'color',
  'meta',
  'data'
];

const OFFICIAL_ONESDK_METHODS = [
  'ready',
  'setup',
  'subscribe',
  'unsubscribe',
  'reset',
  'getStyleVariable',
  'getCommentStyle',
  'checkLicensed',
  'connect',
  'getInfo',
  'getOrders',
  'cancelOrder',
  'completeOrder',
  'getSetList',
  'getComments',
  'getConfig',
  'getPinnedComment',
  'getServices',
  'getTemplates',
  'searchComments',
  'get',
  'post',
  'put',
  'delete'
];

function collectFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function readUtf8Safe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function uniq(items) {
  return Array.from(new Set(items)).sort();
}

function collectMatches(content, regex, groupIndex) {
  const matches = [];
  let match = regex.exec(content);
  while (match) {
    matches.push(match[groupIndex]);
    match = regex.exec(content);
  }
  return matches;
}

function detectVueMode(contents) {
  const joined = contents.join('\n');
  const referencesVue2 = /vue2\.min\.js/.test(joined);
  const referencesVue3 = /vue3\.min\.js/.test(joined);
  const referencesVueDefault = /vue\.min\.js/.test(joined);
  const legacyVue = /new\s+Vue\s*\(|Vue\.extend\s*\(|Vue\.component\s*\(/.test(joined);

  return {
    referencesVue2,
    referencesVue3,
    referencesVueDefault,
    needsVue2Rewrite: referencesVueDefault && legacyVue && !referencesVue2 && !referencesVue3,
    usesLegacyVuePattern: legacyVue
  };
}

function auditOneCommeTemplate(templateDir, options) {
  options = options || {};
  const originDir = options.originDir || path.join(__dirname, '..', 'effects-overlay', 'onecomme', '__origin');
  const files = collectFiles(templateDir);
  const textFiles = files.filter(function (filePath) {
    return /\.(html?|css|js|json)$/i.test(filePath);
  });
  const contents = textFiles.map(readUtf8Safe);
  const joined = contents.join('\n');

  const commentDataFields = uniq(collectMatches(joined, /comment\.data\.([A-Za-z0-9_.]+)/g, 1));
  const commentFields = uniq(collectMatches(joined, /(?<!data\.)comment\.([A-Za-z0-9_]+)/g, 1));
  const oneSdkMethods = uniq(collectMatches(joined, /OneSDK\.([A-Za-z0-9_]+)/g, 1));
  const originPaths = uniq(collectMatches(joined, /__origin\/([A-Za-z0-9_./-]+)/g, 1));
  const vue = detectVueMode(contents);
  const usesOneSDK = /onesdk(?:\.legacy)?\.js|OneSDK(?:\.|$)/.test(joined);

  const missingOriginFiles = originPaths.filter(function (relativePath) {
    return !fs.existsSync(path.join(originDir, relativePath.replace(/\//g, path.sep)));
  });

  const unsupportedCommentDataFields = commentDataFields.filter(function (field) {
    return OFFICIAL_COMMENT_DATA_FIELDS.indexOf(field) === -1
      && !/^membership\./.test(field)
      && !/^colors\./.test(field);
  });
  const unsupportedCommentFields = commentFields.filter(function (field) {
    return OFFICIAL_COMMENT_FIELDS.indexOf(field) === -1
      && field !== 'commentIndex';
  });
  const unsupportedOneSdkMethods = oneSdkMethods.filter(function (method) {
    return OFFICIAL_ONESDK_METHODS.indexOf(method) === -1
      && method !== 'toShortNumberFormat'
      && method !== 'toNumberFromShortNumberFormat';
  });

  const warnings = [];
  if (!usesOneSDK) warnings.push('OneSDK 参照が見つかりません');
  if (missingOriginFiles.length > 0) warnings.push('未実装の __origin 参照があります');
  if (unsupportedCommentDataFields.length > 0) warnings.push('公式 CommentData 外の参照があります');
  if (unsupportedCommentFields.length > 0) warnings.push('公式 Comment 外の参照があります');
  if (unsupportedOneSdkMethods.length > 0) warnings.push('公式 OneSDK 外の参照があります');
  if (vue.needsVue2Rewrite) warnings.push('Vue2 パターンのため vue.min.js -> vue2.min.js 救済が必要です');

  const status = missingOriginFiles.length > 0 || unsupportedOneSdkMethods.length > 0
    ? 'warning'
    : 'compatible';

  return {
    templateDir,
    usesOneSDK,
    commentDataFields,
    commentFields,
    oneSdkMethods,
    originPaths,
    missingOriginFiles,
    unsupportedCommentDataFields,
    unsupportedCommentFields,
    unsupportedOneSdkMethods,
    vue,
    warnings,
    status
  };
}

module.exports = {
  OFFICIAL_COMMENT_DATA_FIELDS,
  OFFICIAL_COMMENT_FIELDS,
  OFFICIAL_ONESDK_METHODS,
  auditOneCommeTemplate
};

if (require.main === module) {
  const templateDir = process.argv[2];
  if (!templateDir) {
    console.error('usage: node tools/onecomme-template-audit.js <templateDir>');
    process.exit(1);
  }
  const result = auditOneCommeTemplate(path.resolve(templateDir));
  process.stdout.write(JSON.stringify(result, null, 2));
}
