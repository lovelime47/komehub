const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  OFFICIAL_COMMENT_DATA_FIELDS,
  OFFICIAL_COMMENT_FIELDS,
  OFFICIAL_ONESDK_METHODS,
  auditOneCommeTemplate
} = require('../tools/onecomme-template-audit');

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'onecomme-audit-'));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'onecomme');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createFixture(name, files) {
  const dir = path.join(TEMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files).forEach(function (relativePath) {
    writeFile(path.join(dir, relativePath), files[relativePath]);
  });
  return dir;
}

describe('onecomme compatibility audit', function () {
  after(function () {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('exposes official baseline fields and methods', function () {
    assert.ok(OFFICIAL_COMMENT_DATA_FIELDS.includes('userId'));
    assert.ok(OFFICIAL_COMMENT_DATA_FIELDS.includes('commentVisible'));
    assert.ok(OFFICIAL_COMMENT_FIELDS.includes('service'));
    assert.ok(OFFICIAL_ONESDK_METHODS.includes('getCommentStyle'));
    assert.ok(OFFICIAL_ONESDK_METHODS.includes('getInfo'));
  });

  it('audits OneSDK field usage, __origin refs, and Vue2 rewrite hints', function () {
    const fixtureDir = createFixture('vue2-template', {
      'index.html': [
        '<!doctype html>',
        '<html>',
        '<head>',
        '  <script src="../__origin/js/vue.min.js"></script>',
        '  <script src="./js/app.js"></script>',
        '  <link rel="stylesheet" href="../__origin/css/animation/blur.css">',
        '  <link rel="stylesheet" href="../__origin/css/theme/fancy.css">',
        '</head>',
        '<body></body>',
        '</html>'
      ].join('\n'),
      'js/app.js': [
        'new Vue({});',
        'OneSDK.setup({ permissions: ["comments"] });',
        'OneSDK.getInfo();',
        'console.log(comment.data.userId, comment.data.commentVisible, comment.commentIndex);'
      ].join('\n')
    });

    const result = auditOneCommeTemplate(fixtureDir);

    assert.equal(result.usesOneSDK, true);
    assert.equal(result.vue.needsVue2Rewrite, true);
    assert.ok(result.commentDataFields.includes('userId'));
    assert.ok(result.commentDataFields.includes('commentVisible'));
    assert.ok(result.commentFields.includes('commentIndex'));
    assert.ok(result.oneSdkMethods.includes('setup'));
    assert.ok(result.oneSdkMethods.includes('getInfo'));
    assert.ok(result.originPaths.includes('css/animation/blur.css'));
    assert.ok(result.originPaths.includes('css/theme/fancy.css'));
    assert.ok(result.missingOriginFiles.includes('css/theme/fancy.css'));
    assert.equal(result.status, 'warning');
  });

  it('finds newly supported __origin files as available', function () {
    const fixtureDir = createFixture('origin-files-template', {
      'index.html': [
        '<!doctype html>',
        '<html>',
        '<head>',
        '  <script src="../__origin/js/onesdk.legacy.js"></script>',
        '  <script src="../__origin/js/html-escaper.min.js"></script>',
        '  <script src="../__origin/js/one-marquee.js"></script>',
        '  <link rel="stylesheet" href="../__origin/css/animation/flip-x.css">',
        '  <link rel="stylesheet" href="../__origin/css/animation/flip-y.css">',
        '  <link rel="stylesheet" href="../__origin/css/animation/nomove.css">',
        '  <link rel="stylesheet" href="../__origin/css/animation/purun.css">',
        '  <link rel="stylesheet" href="../__origin/css/animation/scale-in.css">',
        '  <link rel="stylesheet" href="../__origin/css/ext/fadeOut.css">',
        '  <link rel="stylesheet" href="../__origin/css/ext/hide.css">',
        '  <link rel="stylesheet" href="../__origin/css/ext/marquee.css">',
        '</head>',
        '<body></body>',
        '</html>'
      ].join('\n')
    });

    const result = auditOneCommeTemplate(fixtureDir);

    assert.deepEqual(result.missingOriginFiles, []);
    assert.equal(result.status, 'compatible');
  });

  it('tracks representative OneComme fixture corpus', function () {
    const scriptOnly = auditOneCommeTemplate(path.join(FIXTURE_ROOT, 'script-only'));
    const vue2Rewrite = auditOneCommeTemplate(path.join(FIXTURE_ROOT, 'vue2-rewrite'));
    const themeWarning = auditOneCommeTemplate(path.join(FIXTURE_ROOT, 'theme-warning'));

    assert.equal(scriptOnly.usesOneSDK, true);
    assert.equal(scriptOnly.status, 'compatible');

    assert.equal(vue2Rewrite.vue.needsVue2Rewrite, true);
    assert.ok(vue2Rewrite.oneSdkMethods.includes('setup'));

    assert.ok(themeWarning.missingOriginFiles.includes('css/theme/fancy.css'));
    assert.equal(themeWarning.status, 'warning');
  });
});
