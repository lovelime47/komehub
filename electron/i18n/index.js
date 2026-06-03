/**
 * i18n モジュール
 * OS言語を自動検出し、対応する翻訳を返す
 */
const fs = require('fs');
const path = require('path');

var SUPPORTED = ['ja', 'en', 'zh-CN', 'zh-TW', 'ko', 'de', 'fr', 'es', 'pt'];
var DEFAULT_LANG = 'ja';
var translations = {};
var currentLang = DEFAULT_LANG;

// 全言語ファイルを読み込み
SUPPORTED.forEach(function (lang) {
  var filePath = path.join(__dirname, lang + '.json');
  if (fs.existsSync(filePath)) {
    translations[lang] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
});

function detectLanguage() {
  var locale = (process.env.LANG || process.env.LANGUAGE || '').split('.')[0];
  // Electron の app.getLocale() はモジュール外から渡す
  if (!locale) return DEFAULT_LANG;
  return resolveLocale(locale);
}

function resolveLocale(locale) {
  // 完全一致
  if (translations[locale]) return locale;
  // zh-Hans → zh-CN, zh-Hant → zh-TW
  if (locale.startsWith('zh-Hans') || locale === 'zh-CN') return 'zh-CN';
  if (locale.startsWith('zh-Hant') || locale === 'zh-TW') return 'zh-TW';
  if (locale.startsWith('zh')) return 'zh-CN';
  // 言語コードのみ
  var lang = locale.split('-')[0].split('_')[0];
  if (translations[lang]) return lang;
  return DEFAULT_LANG;
}

function setLanguage(lang) {
  currentLang = resolveLocale(lang);
}

function t(key, params) {
  var text = (translations[currentLang] && translations[currentLang][key])
    || (translations[DEFAULT_LANG] && translations[DEFAULT_LANG][key])
    || key;
  if (params) {
    Object.keys(params).forEach(function (k) {
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
    });
  }
  return text;
}

function getAllTranslations() {
  return translations[currentLang] || translations[DEFAULT_LANG] || {};
}

function getCurrentLang() {
  return currentLang;
}

function getSupportedLanguages() {
  return SUPPORTED.slice();
}

module.exports = {
  detectLanguage: detectLanguage,
  resolveLocale: resolveLocale,
  setLanguage: setLanguage,
  t: t,
  getAllTranslations: getAllTranslations,
  getCurrentLang: getCurrentLang,
  getSupportedLanguages: getSupportedLanguages
};
