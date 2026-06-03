// === ファイルD&D: Electronデフォルト動作を抑止 ===
var internalReorderDragActive = false;

function setInternalReorderDragActive(active) {
  internalReorderDragActive = !!active;
  if (document.body) {
    document.body.classList.toggle('internal-reorder-drag-active', internalReorderDragActive);
  }
}

function isFileDragEvent(e) {
  var types = e && e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  if (typeof types.indexOf === 'function') return types.indexOf('Files') !== -1;
  if (typeof types.contains === 'function') return types.contains('Files');
  return false;
}

document.addEventListener('dragover', function (e) {
  if (!isFileDragEvent(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('drop', function (e) {
  if (!isFileDragEvent(e)) return;
  e.preventDefault();
});

// === renderer 内ロガー (= renderer.log に出力、 詳細: docs/logging.md) ===
// renderer.js 用の汎用 tag "Renderer"、 グローバルエラーハンドラ用 "RendererUncaught"。
// preload が壊れている場合は no-op object に fallback (= ログだけ落とすが renderer の
// 機能本体は止めない)。
function makeRendererLogger(tag) {
  if (window.api && window.api.log && window.api.log.create) {
    return window.api.log.create(tag);
  }
  return { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
}
var rendererLog = makeRendererLogger('Renderer');
var rendererUncaughtLogger = makeRendererLogger('RendererUncaught');
window.addEventListener('error', function (e) {
  if (rendererUncaughtLogger) {
    rendererUncaughtLogger.error(e.message, e.error && e.error.stack ? e.error.stack : '');
  }
});
window.addEventListener('unhandledrejection', function (e) {
  if (rendererUncaughtLogger) {
    var reason = e.reason;
    var msg = reason instanceof Error ? reason.message : String(reason);
    var stack = reason instanceof Error ? reason.stack : '';
    rendererUncaughtLogger.error('Unhandled rejection:', msg, stack);
  }
});

// === KomehubShared 共通 UI モジュールの別名 ===
// 本体と remote が同じ DOM ファクトリを共有するため、shared/*.js を index.html で renderer.js より先にロードしている。
// 設計: docs/architecture/remote-viewing-redesign.md §6
var sanitizeCommentHtml = window.KomehubShared.sanitizeCommentHtml;
var isCommentSuperchat = window.KomehubShared.isCommentSuperchat;
var commentSuperchatColors = window.KomehubShared.commentSuperchatColors;
var commentSuperchatAmountText = window.KomehubShared.commentSuperchatAmountText;
var commentSuperchatTierColorMap = window.KomehubShared.commentSuperchatTierColorMap;
var commentTierFromColor = window.KomehubShared.commentTierFromColor;
var commentTierFromAmount = window.KomehubShared.commentTierFromAmount;
var commentTierFromGiftCount = window.KomehubShared.commentTierFromGiftCount;

// === i18n ===
var i18nData = {};
var i18nLang = 'ja';
var i18nSupported = [];
var LANG_NAMES = { ja: '日本語', en: 'English' };

function t(key, params) {
  var text = i18nData[key] || key;
  if (params) {
    Object.keys(params).forEach(function (k) {
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
    });
  }
  return text;
}

// 初期化: i18nデータを取得してからUIを構築
// i18n 取得後にUI全体を初期化
(function () {
  var ready = window.api && window.api.getI18n
    ? window.api.getI18n().catch(function () { return { translations: {}, lang: 'ja', supported: ['ja'] }; })
    : Promise.resolve({ translations: {}, lang: 'ja', supported: ['ja'] });

  ready.then(function (data) {
    i18nData = data.translations;
    i18nLang = data.lang;
    i18nSupported = data.supported;
    if (data.version) document.title = 'Live Comment Hub v' + data.version;
    applyStaticTexts();
  });
})();

function applyStaticTexts() {
  var headerTitle = document.querySelector('header h1');
  var headerSub = document.getElementById('header-sub');
  var urlInput = document.getElementById('url-input');
  var connectBtn = document.getElementById('connect-btn');
  var statusText = document.getElementById('status-text');
  var appsLabel = document.querySelector('#apps-section .apps-label');
  var reactionCounter = document.getElementById('reaction-counter');
  var configTitle = document.querySelector('#config-header h2');
  var configCloseBtn = document.getElementById('config-close-btn');

  if (headerTitle) headerTitle.textContent = t('app.title');
  if (headerSub) headerSub.textContent = t('app.subtitle');
  if (urlInput) urlInput.placeholder = t('connection.placeholder');
  if (!isConnected && connectBtn) connectBtn.textContent = t('connection.connect');
  // login-btn は設定画面に移動
  if (!isConnected && statusText) statusText.textContent = t('connection.status.disconnected');
  if (appsLabel) appsLabel.textContent = t('apps.title');
  if (reactionCounter) {
    reactionCounter.textContent = isConnected
      ? t('footer.reaction', { count: '\u2764\uFE0F x' + totalReactions })
      : t('footer.reaction.none');
  }
  if (configTitle) configTitle.textContent = t('config.title');
  if (configCloseBtn) configCloseBtn.textContent = t('config.close');
}

function showZipActionError(result, fallbackMessage) {
  if (!result || result.cancelled || result.alreadyNotified) return;
  showAlertDialog(result.error || fallbackMessage);
}

// app-list は renderApps() が動的に再構築する。 旧 APPS 配列ベースの静的アプリ一覧機構は
// 唯一のエントリだったリアクション連動アバターのお蔵入りに伴い撤去した。
var currentPort = 11280;

function buildLocalHttpUrl(path) {
  return 'http://localhost:' + currentPort + path;
}

function canonicalTemplateAssetPath(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.indexOf('/') === -1 && value.indexOf(':') === -1) {
    return 'assets/' + value;
  }
  return value;
}

var currentSceneTemplates = [];
var currentTemplateInfoMap = {};
var currentAvailableTemplates = [];
var currentSelectedTemplateId = '';
var currentTemplatesEnabled = true;
var editingTemplateInfo = null;
var templateEditorMode = 'manager';
var templateCreateDraft = {
  starterType: 'list',
  displayName: '',
  templateId: '',
  sourceTemplateId: '',
  sourceTemplateName: '',
  sourceTemplateDisplayName: ''
};
var templateDevTemplateId = '';

function slugifyTemplateIdSegment(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+|\.+$/g, '');
}

function suggestTemplateId(displayName) {
  var slug = slugifyTemplateIdSegment(displayName);
  if (!slug) slug = 'new-template';
  return 'com.comment-hub.template.' + slug;
}

function suggestTemplateIdFromSource(sourceTemplateId, displayName) {
  var source = typeof sourceTemplateId === 'string' ? sourceTemplateId.trim().toLowerCase() : '';
  if (source) {
    if (source.slice(-7) === '.custom') {
      return source + '.copy';
    }
    return source + '.custom';
  }
  return suggestTemplateId(displayName);
}

function normalizeTemplateType(templateType) {
  if (!templateType || typeof templateType !== 'string') return 'custom';
  if (templateType === 'Builtin' || templateType === 'builtin') return 'builtin';
  if (templateType === 'Custom' || templateType === 'custom') return 'custom';
  if (templateType === 'OneComme' || templateType === 'oneComme') return 'oneComme';
  return templateType;
}

function getTemplateInfoForRoute(templateId, templateInfo, templateInfoMap) {
  var info = null;
  if (templateInfo && typeof templateInfo === 'object') info = templateInfo;
  else if (templateInfoMap && templateInfoMap[templateId]) info = templateInfoMap[templateId];
  else if (currentTemplateInfoMap && currentTemplateInfoMap[templateId]) info = currentTemplateInfoMap[templateId];
  else info = { id: templateId, templateType: 'custom' };

  if (info && typeof info === 'object') {
    info.templateType = normalizeTemplateType(info.templateType);
  }
  return info;
}

function getOneCommeTemplateSeq(templateId, sceneTemplates, templateInfoMap) {
  var templates = Array.isArray(sceneTemplates) ? sceneTemplates : currentSceneTemplates;
  var seq = 0;
  for (var i = 0; i < templates.length; i++) {
    var st = templates[i];
    var currentId = st.id || st.name;
    var info = getTemplateInfoForRoute(currentId, null, templateInfoMap);
    if (info.templateType !== 'oneComme') continue;
    seq += 1;
    if (currentId === templateId) return String(seq);
  }
  return '1';
}

function buildTemplateRoutePath(sceneId, templateId, templateInfo, sceneTemplates, templateInfoMap) {
  var info = getTemplateInfoForRoute(templateId, templateInfo, templateInfoMap);
  if (info.templateType === 'builtin') {
    return '/templates/' + sceneId + '/built-in/' + (info.shortName || info.storageName || templateId) + '/';
  }
  if (info.templateType === 'oneComme') {
    return '/templates/' + sceneId + '/one/' + getOneCommeTemplateSeq(templateId, sceneTemplates, templateInfoMap) + '/';
  }
  return '/templates/' + sceneId + '/comehub/' + templateId + '/';
}

function buildSelectedTemplateRoutePath(sceneId) {
  return '/templates/' + sceneId + '/selected/';
}

function buildTemplatePreviewUrl(url, settings) {
  if (!url) return '';
  var separator = url.indexOf('?') === -1 ? '?' : '&';
  return url + separator + 'preview=1';
}

function buildTemplateDevPreviewUrl(url) {
  if (!url) return '';
  var separator = url.indexOf('?') === -1 ? '?' : '&';
  return url + separator + 'preview=1&devPreview=1';
}

function getSceneTemplateById(templateId, sceneTemplates) {
  var templates = Array.isArray(sceneTemplates) ? sceneTemplates : currentSceneTemplates;
  for (var i = 0; i < templates.length; i++) {
    var currentId = templates[i].id || templates[i].name;
    if (currentId === templateId) return templates[i];
  }
  return null;
}

function syncLocalSceneTemplateSettings(templateId, settings) {
  if (!templateId) return;
  var template = getSceneTemplateById(templateId);
  if (!template) return;
  template.settings = JSON.parse(JSON.stringify(settings || {}));
}

function buildTemplateAssetPreviewUrl(sceneId, templateId, templateInfo, sceneTemplates, templateInfoMap, value) {
  var assetPath = canonicalTemplateAssetPath(value);
  if (!assetPath) return '';
  if (assetPath.indexOf('data:') === 0 || assetPath.indexOf('http://') === 0 || assetPath.indexOf('https://') === 0) {
    return assetPath;
  }
  if (assetPath.indexOf('assets/') === 0) {
    return buildLocalHttpUrl(buildTemplateRoutePath(sceneId, templateId, templateInfo, sceneTemplates, templateInfoMap) + assetPath);
  }
  return assetPath;
}

// ポート通知を受けて currentPort を更新する (= effect / app URL 構築に使う)。
window.api.onPort(function (port) {
  currentPort = port;
});

// アップデート通知
var updateBar = document.getElementById('update-bar');
var updateVersion = null;

window.api.onUpdateAvailable(function (data) {
  updateVersion = data.version;
  updateBar.innerHTML = '';
  var msg = document.createElement('span');
  msg.textContent = 'v' + data.version + ' ' + t('update.available');
  var btn = document.createElement('button');
  btn.textContent = t('update.download');
  btn.addEventListener('click', function () {
    window.api.downloadUpdate();
    btn.disabled = true;
    btn.textContent = t('update.downloading');
  });
  updateBar.appendChild(msg);
  updateBar.appendChild(btn);
  updateBar.style.display = 'flex';
});

window.api.onUpdateProgress(function (data) {
  var btn = updateBar.querySelector('button');
  if (btn) btn.textContent = t('update.downloading') + ' ' + data.percent + '%';
});

window.api.onUpdateReady(function () {
  updateBar.innerHTML = '';
  var msg = document.createElement('span');
  msg.textContent = 'v' + updateVersion + ' ' + t('update.ready');
  var btn = document.createElement('button');
  btn.textContent = t('update.install');
  btn.addEventListener('click', function () {
    window.api.installUpdate();
  });
  updateBar.appendChild(msg);
  updateBar.appendChild(btn);
});

window.api.onUpdateError(function () {
  updateBar.style.display = 'none';
});

// ログイン警告
var loginWarning = document.getElementById('login-warning');
window.api.onLoginWarning(function (notLoggedIn) {
  if (notLoggedIn) {
    loginWarning.innerHTML = '';
    var text = document.createTextNode('⚠ 未ログイン: リアクションが取得できません。');
    var link = document.createElement('a');
    link.textContent = '設定からログイン';
    link.href = '#';
    link.style.cssText = 'color:#ffab40;text-decoration:underline;cursor:pointer;margin-left:4px;';
    link.addEventListener('click', function (e) {
      e.preventDefault();
      openSettings('youtube');
    });
    loginWarning.appendChild(text);
    loginWarning.appendChild(link);
    loginWarning.style.display = 'block';
  } else {
    loginWarning.style.display = 'none';
  }
});

var urlInput = document.getElementById('url-input');
var connectBtn = document.getElementById('connect-btn');
var statusDot = document.getElementById('status-dot');
var statusText = document.getElementById('status-text');
var commentList = document.getElementById('comment-list');
var giftList = document.getElementById('gift-list');
var autoScrollEnabled = true;
var giftAutoScrollEnabled = true;
var clJumpLatestBtn = document.getElementById('cl-jump-latest');

// ユーザーが上にスクロールしたら自動スクロール停止、一番下で再開。
// 同時に「↓ 最新へ戻る」浮遊ボタン (= モバイル rh-jump-latest と同等) の
// 表示/非表示を切替。active タブ (comment / gift) のリストだけが対象。
function isCommentTabActive() {
  var p = commentList && commentList.parentElement;
  return !!(p && p.classList.contains('active'));
}
function isGiftTabActive() {
  var p = giftList && giftList.parentElement;
  return !!(p && p.classList.contains('active'));
}
function updateClJumpLatest() {
  if (!clJumpLatestBtn) return;
  var atBottom = true;
  if (isCommentTabActive()) atBottom = autoScrollEnabled;
  else if (isGiftTabActive()) atBottom = giftAutoScrollEnabled;
  else { clJumpLatestBtn.style.display = 'none'; return; }
  clJumpLatestBtn.style.display = atBottom ? 'none' : '';
}
commentList.addEventListener('scroll', function () {
  var atBottom = commentList.scrollHeight - commentList.scrollTop - commentList.clientHeight < 30;
  autoScrollEnabled = atBottom;
  if (isCommentTabActive()) updateClJumpLatest();
}, { passive: true });
if (giftList) {
  giftList.addEventListener('scroll', function () {
    var atBottom = giftList.scrollHeight - giftList.scrollTop - giftList.clientHeight < 30;
    giftAutoScrollEnabled = atBottom;
    if (isGiftTabActive()) updateClJumpLatest();
  }, { passive: true });
}
if (clJumpLatestBtn) {
  clJumpLatestBtn.addEventListener('click', function () {
    if (isCommentTabActive() && commentList) {
      commentList.scrollTop = commentList.scrollHeight;
      autoScrollEnabled = true;
    } else if (isGiftTabActive() && giftList) {
      giftList.scrollTop = giftList.scrollHeight;
      giftAutoScrollEnabled = true;
    }
    updateClJumpLatest();
  });
}

function hasRenderedComments() {
  return !!(commentList && commentList.querySelector('.comment-item'));
}

function renderCommentEmptyState(message) {
  if (!commentList || hasRenderedComments()) return;
  commentList.innerHTML = '<div class="comment-empty-state" style="padding:24px 12px;color:#5a6a78;font-size:12px;text-align:center">'
    + message
    + '</div>';
}

function refreshCommentEmptyState() {
  if (!commentList || hasRenderedComments()) return;
  if (!isConnected) {
    renderCommentEmptyState('配信に接続すると、この枠のコメントが表示されます。');
  } else {
    renderCommentEmptyState('この枠のコメントはまだありません。<br>新しいコメントが届くと、ここに表示されます。');
  }
}

var reactionCounter = document.getElementById('reaction-counter');

// loginBtn は設定画面に移動
var isConnected = false;

// cl-tabs の「現在配信」グループ (= comments / gifts / listeners) に接続中 pulse /
// 切断中の灰色 dot + 「未接続」テキストを反映する。isConnected の変化点
// (onStatus connected / 未接続) と起動時に呼び出す。
function updateClTabsLiveState() {
  var group = document.querySelector('.cl-tabs-live');
  if (!group) return;
  group.classList.toggle('connected', !!isConnected);
  group.classList.toggle('disconnected', !isConnected);
  var labelText = group.querySelector('.cl-tabs-group-label-text');
  if (labelText) labelText.textContent = isConnected ? '接続中' : '未接続';
}

// ─────────────────────────────────────────────────────────────
// リスナー検索 (cl-tab data-cl-tab="listener-search"、Phase 2a)
//   全期間 listeners を名前 + ソート で絞り込んで一覧表示。各 row クリックで
//   listener 詳細モーダル。フィルタの拡張は Phase 2b、 保存検索は Phase 2c。
// ─────────────────────────────────────────────────────────────
var listenerSearchState = {
  loaded: false,
  fetching: false,
  query: {
    nameQ: '',
    sort: 'lastSeen',
    limit: 100,
    offset: 0,
    // Phase 2b: フィルタ
    systemTags: [], // 'first-time' / 'returning' / 'regular' / 'veteran' / 'comeback' / 'abandoned'
    userTags: [],   // listener_tags の tag (= 動的取得)
  },
  page: null,
  availableUserTags: null, // listAllListenerTags の結果キャッシュ
  // Phase 2b': baseline 解決済 videoId。
  // 接続中は currentStreamVideoId、 切断中は owner_channels 配下の最新枠を採用。
  // 復帰 / 離脱 chip の判定に使う ([[listener-rank-classification]])。
  resolvedBaselineVideoId: '',
  baselineResolving: false,
};

// 6 種固定のシステムタグ (= Phase 2b' リスナー検索、 2026-05-14 改訂)
// baseline = 最終枠.started_at 基準で 5 ランク + 復帰 / 離脱 を per-row 判定。
//
// - 復帰 = NOT active + 復帰窓 (= last_n_streams ∪ baseline、 N+1 枠) でコメ済
//          → 直近巡回はしてるが M 枠未満の人
// - 離脱 = NOT active + 復帰窓でコメ無し
//          → 復帰窓 N+1 枠から完全に消えた人
//
// baseline 未解決 (= 自チャンネル枠なし) の場合は Rust 側で comeback / abandoned は
// 何にもマッチしない (= 結果空)。 接続が来れば自動で baseline が解決される。
var LISTENER_SEARCH_SYSTEM_TAGS = [
  { id: 'first-time', label: '新規' },
  { id: 'returning', label: '新参' },
  { id: 'regular', label: '常連' },
  { id: 'veteran', label: '古参' },
  { id: 'comeback', label: '復帰' },
  { id: 'abandoned', label: '離脱' },
];

// タブ初表示で 1 回だけ初回 fetch。再表示時はキャッシュ済の page を使う。
function listenerSearchEnsureLoaded() {
  var state = listenerSearchState;
  if (state.loaded) {
    // タブ切替で戻ってきた場合、ハンドラを再結線して既存 page を再描画
    listenerSearchAttachHandlers();
    listenerSearchRenderChips();
    listenerSearchAttachSavedStripHandlers();
    refreshListenerSearchSavedStrip();
    if (state.page) renderListenerSearchList(state.page);
    return;
  }
  state.loaded = true;
  listenerSearchAttachHandlers();
  listenerSearchRenderChips();
  listenerSearchAttachSavedStripHandlers();
  refreshListenerSearchSavedStrip();
  // user tag 一覧を取得 → chip 行を再描画
  listenerSearchFetchUserTags();
  // baseline 解決を済ませてから初回 fetch (= 復帰 / 離脱 chip が即時動く状態)
  listenerSearchResolveBaseline().then(function () {
    listenerSearchFetch();
  });
}

// 保存検索 pin の clic / 削除 / 保存ボタン handler を結線。idempotent。
function listenerSearchAttachSavedStripHandlers() {
  var saveBtn = document.getElementById('ls-save-current-btn');
  if (saveBtn) saveBtn.onclick = saveCurrentListenerSearch;
}

// 保存検索 pin 群を再描画 ([[count-vs-filter-consistency]] と同 pattern で
// scope='listener-search' を渡す)。
function refreshListenerSearchSavedStrip() {
  if (!api.listeners || !api.listeners.listSavedSearches) return;
  var pinsEl = document.getElementById('ls-saved-pins');
  if (!pinsEl) return;
  api.listeners.listSavedSearches('listener-search').then(function (resp) {
    if (!resp || !resp.ok) return;
    pinsEl.innerHTML = '';
    var searches = resp.searches || [];
    if (searches.length === 0) {
      var hint = document.createElement('span');
      hint.className = 'cs-form-hint';
      hint.style.cssText = 'font-size:10px;color:#5a6a78;padding:0 4px';
      hint.textContent = '保存検索なし';
      pinsEl.appendChild(hint);
      return;
    }
    for (var i = 0; i < searches.length; i++) {
      var s = searches[i];
      var pin = document.createElement('span');
      pin.className = 'cs-saved-pin';
      pin.dataset.id = String(s.id);
      var star = document.createElement('span');
      star.className = 'cs-star';
      star.textContent = '★';
      pin.appendChild(star);
      pin.appendChild(document.createTextNode(s.name));
      var x = document.createElement('span');
      x.className = 'cs-pin-x';
      x.textContent = '✕';
      x.title = '削除';
      pin.appendChild(x);
      (function (search) {
        pin.addEventListener('click', function (ev) {
          if (ev.target === x) return;
          applyListenerSearchSavedSearch(search);
        });
        x.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!confirm('「' + search.name + '」を削除しますか？')) return;
          api.listeners.deleteSavedSearch(search.id).then(function (r) {
            if (r && r.ok) refreshListenerSearchSavedStrip();
          });
        });
      }(s));
      pinsEl.appendChild(pin);
    }
  }).catch(function (err) {
    rendererLog.error('listenerSearch listSavedSearches failed', err);
  });
}

// 保存検索の conditions を listenerSearchState に流し込んで再 fetch。
function applyListenerSearchSavedSearch(search) {
  if (!search || !search.conditions) return;
  var cond;
  try { cond = JSON.parse(search.conditions); } catch (e) {
    rendererLog.error('bad listener-search conditions', e);
    return;
  }
  var state = listenerSearchState;
  state.query.nameQ = cond.nameQ || '';
  state.query.sort = cond.sort || 'lastSeen';
  state.query.systemTags = Array.isArray(cond.systemTags) ? cond.systemTags.slice() : [];
  state.query.userTags = Array.isArray(cond.userTags) ? cond.userTags.slice() : [];
  state.query.offset = 0;
  // form input を上書き
  var qEl = document.getElementById('listener-search-q');
  var sortEl = document.getElementById('listener-search-sort');
  if (qEl) qEl.value = state.query.nameQ;
  if (sortEl) sortEl.value = state.query.sort;
  listenerSearchRenderChips();
  listenerSearchFetch();
}

// 「＋ 保存」: 現在の listenerSearchState.query から共通ダイアログを開いて保存。
// baselineStreamVideoId は動的解決のため保存しない (= 接続/切断で変わる)。
// Electron で window.prompt は disabled なので、 cs-save-dialog を流用する。
function saveCurrentListenerSearch() {
  openSaveSearchDialog({
    scope: 'listener-search',
    getConditions: function () {
      var q = listenerSearchState.query;
      return {
        nameQ: q.nameQ || '',
        sort: q.sort || 'lastSeen',
        systemTags: (q.systemTags || []).slice(),
        userTags: (q.userTags || []).slice(),
      };
    },
    renderPreview: renderListenerSearchSavePreview,
    onSaved: refreshListenerSearchSavedStrip,
  });
}

// 保存ダイアログの preview 領域にリスナー検索の applied 条件を chip で描画する。
// cs-applied-chips と同じ見た目になるよう同 class を流用。
function renderListenerSearchSavePreview(el) {
  if (!el) return;
  var q = listenerSearchState.query;
  el.innerHTML = '';
  function appendChip(label) {
    var span = document.createElement('span');
    span.className = 'cs-applied-chip';
    span.textContent = label;
    el.appendChild(span);
  }
  if (q.nameQ) appendChip('名前: ' + q.nameQ);
  if (q.sort && q.sort !== 'lastSeen') {
    var sortLabel = ({
      commentCount: 'コメ数降順',
      superchatAmount: 'SC 累計降順',
      displayName: '表示名昇順',
      lastSeen: '最終コメ降順',
    })[q.sort] || q.sort;
    appendChip('並び: ' + sortLabel);
  }
  if (q.systemTags && q.systemTags.length) {
    for (var i = 0; i < q.systemTags.length; i++) {
      appendChip(listenerSearchSystemTagLabel(q.systemTags[i]));
    }
  }
  if (q.userTags && q.userTags.length) {
    for (var j = 0; j < q.userTags.length; j++) {
      appendChip('# ' + q.userTags[j]);
    }
  }
  if (!el.firstChild) {
    var hint = document.createElement('span');
    hint.className = 'cs-form-hint';
    hint.style.cssText = 'color:#5a6a78;font-size:11px';
    hint.textContent = '(条件なし = 全件)';
    el.appendChild(hint);
  }
}

// listener-search の system tag id を日本語 label に変換
function listenerSearchSystemTagLabel(id) {
  for (var i = 0; i < LISTENER_SEARCH_SYSTEM_TAGS.length; i++) {
    if (LISTENER_SEARCH_SYSTEM_TAGS[i].id === id) return LISTENER_SEARCH_SYSTEM_TAGS[i].label;
  }
  return id;
}

// baseline_stream_video_id を解決する。接続中は currentStreamVideoId、
// 切断中は owner_channels 配下の最新枠 (= list_streams scope=own sort=startedAt limit=1) を使う。
// 解決結果は state.resolvedBaselineVideoId にキャッシュし、 fetch 時に query へ載せる。
// 自チャンネル枠が一切無いユーザでは空文字のままになり、 Rust 側で comeback / abandoned
// は何にもマッチしない (= 結果空) 防御挙動になる。
function listenerSearchResolveBaseline() {
  var state = listenerSearchState;
  // 接続中: currentStreamVideoId をそのまま採用 (= 即時、 fetch 不要)
  if (currentStreamVideoId) {
    state.resolvedBaselineVideoId = currentStreamVideoId;
    return Promise.resolve(currentStreamVideoId);
  }
  // 既に解決済 (= 切断中のキャッシュ) があればそれを使う
  if (state.resolvedBaselineVideoId) {
    return Promise.resolve(state.resolvedBaselineVideoId);
  }
  if (state.baselineResolving) {
    return Promise.resolve('');
  }
  if (!api || !api.listeners || typeof api.listeners.streams !== 'function') {
    return Promise.resolve('');
  }
  state.baselineResolving = true;
  return api.listeners.streams({
    scope: 'own',
    sort: 'startedAt',
    limit: 1,
    offset: 0,
  }).then(function (resp) {
    state.baselineResolving = false;
    if (resp && resp.ok && resp.page && Array.isArray(resp.page.rows) && resp.page.rows.length > 0) {
      var v = resp.page.rows[0].videoId || '';
      state.resolvedBaselineVideoId = v;
      return v;
    }
    return '';
  }).catch(function () {
    state.baselineResolving = false;
    return '';
  });
}

// 全 user tag を取得 (= listAllListenerTags、 cs-panel と同じ API)
function listenerSearchFetchUserTags() {
  if (!api || !api.listeners || typeof api.listeners.listAllTags !== 'function') return;
  api.listeners.listAllTags().then(function (resp) {
    if (!resp || !resp.ok) return;
    listenerSearchState.availableUserTags = resp.tags || [];
    listenerSearchRenderChips();
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

// chip 行を描画 (= システムタグ + ユーザータグ)。idempotent。
function listenerSearchRenderChips() {
  var sysEl = document.getElementById('listener-search-sys-chips');
  var userEl = document.getElementById('listener-search-user-chips');
  var state = listenerSearchState;
  if (sysEl) {
    sysEl.innerHTML = '';
    for (var i = 0; i < LISTENER_SEARCH_SYSTEM_TAGS.length; i++) {
      var t = LISTENER_SEARCH_SYSTEM_TAGS[i];
      var chip = document.createElement('span');
      chip.className = 'listener-search-chip' +
        (state.query.systemTags.indexOf(t.id) >= 0 ? ' active' : '');
      chip.textContent = t.label;
      chip.dataset.tagId = t.id;
      (function (tagId) {
        chip.addEventListener('click', function () {
          var idx = state.query.systemTags.indexOf(tagId);
          if (idx >= 0) state.query.systemTags.splice(idx, 1);
          else state.query.systemTags.push(tagId);
          state.query.offset = 0;
          listenerSearchRenderChips();
          listenerSearchFetch();
        });
      }(t.id));
      sysEl.appendChild(chip);
    }
  }
  if (userEl) {
    userEl.innerHTML = '';
    var tags = state.availableUserTags || [];
    for (var j = 0; j < tags.length; j++) {
      var ut = tags[j];
      var utName = (typeof ut === 'string') ? ut : (ut && ut.tag) || '';
      if (!utName) continue;
      var utCount = (ut && typeof ut === 'object' && typeof ut.count === 'number') ? ut.count : null;
      var chip2 = document.createElement('span');
      chip2.className = 'listener-search-chip' +
        (state.query.userTags.indexOf(utName) >= 0 ? ' active' : '');
      chip2.textContent = utCount !== null ? (utName + ' (' + utCount + ')') : utName;
      chip2.dataset.tagName = utName;
      (function (tagName) {
        chip2.addEventListener('click', function () {
          var idx = state.query.userTags.indexOf(tagName);
          if (idx >= 0) state.query.userTags.splice(idx, 1);
          else state.query.userTags.push(tagName);
          state.query.offset = 0;
          listenerSearchRenderChips();
          listenerSearchFetch();
        });
      }(utName));
      userEl.appendChild(chip2);
    }
  }
}

// 検索フォームのハンドラを idempotent に結線
function listenerSearchAttachHandlers() {
  var qEl = document.getElementById('listener-search-q');
  var sortEl = document.getElementById('listener-search-sort');
  var goBtn = document.getElementById('listener-search-go');
  var prevBtn = document.getElementById('listener-search-prev');
  var nextBtn = document.getElementById('listener-search-next');
  if (!qEl || !sortEl || !goBtn) return;
  // input の現在値を state に反映 (= 再描画時のずれ防止)
  qEl.value = listenerSearchState.query.nameQ || '';
  sortEl.value = listenerSearchState.query.sort || 'lastSeen';
  goBtn.onclick = function () {
    listenerSearchState.query.nameQ = String(qEl.value || '').trim();
    listenerSearchState.query.sort = sortEl.value || 'lastSeen';
    listenerSearchState.query.offset = 0;
    listenerSearchFetch();
  };
  qEl.onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); goBtn.click(); }
  };
  if (prevBtn) {
    prevBtn.onclick = function () {
      if (!listenerSearchState.page || listenerSearchState.fetching) return;
      var q = listenerSearchState.query;
      var newOffset = Math.max(0, q.offset - q.limit);
      if (newOffset === q.offset) return;
      q.offset = newOffset;
      listenerSearchFetch();
    };
  }
  if (nextBtn) {
    nextBtn.onclick = function () {
      var state = listenerSearchState;
      if (!state.page || state.fetching) return;
      var total = state.page.total || 0;
      var q = state.query;
      if (q.offset + q.limit >= total) return;
      q.offset += q.limit;
      listenerSearchFetch();
    };
  }
}

function listenerSearchFetch() {
  var state = listenerSearchState;
  if (state.fetching) return;
  if (!api || !api.listeners || typeof api.listeners.list !== 'function') return;
  state.fetching = true;
  var q = state.query;
  // 接続中なら毎回 currentStreamVideoId を採用 (= 切断/接続切替に即追従)。
  // 切断中はキャッシュ済 baseline を使う (= 起動中の自枠最新は変化しない前提)。
  var baselineId = currentStreamVideoId || state.resolvedBaselineVideoId || '';
  api.listeners.list({
    q: q.nameQ || undefined,
    sort: q.sort || 'lastSeen',
    limit: q.limit,
    offset: q.offset,
    systemTags: (q.systemTags && q.systemTags.length) ? q.systemTags : undefined,
    userTags: (q.userTags && q.userTags.length) ? q.userTags : undefined,
    baselineStreamVideoId: baselineId || undefined,
  }).then(function (resp) {
    state.fetching = false;
    if (!resp || !resp.ok || !resp.page) {
      state.page = { total: 0, limit: q.limit, offset: 0, rows: [] };
    } else {
      state.page = resp.page;
    }
    renderListenerSearchList(state.page);
  }).catch(function (err) {
    state.fetching = false;
    rendererLog.error('listener-search list failed', err);
  });
}

function renderListenerSearchList(page) {
  var listEl = document.getElementById('listener-search-list');
  var countEl = document.getElementById('listener-search-count');
  var pagEl = document.getElementById('listener-search-pagination');
  var labelEl = document.getElementById('listener-search-page-label');
  var prevBtn = document.getElementById('listener-search-prev');
  var nextBtn = document.getElementById('listener-search-next');
  if (!listEl) return;
  if (countEl) countEl.textContent = '全 ' + (page.total || 0) + ' 件';

  if (!page.rows || page.rows.length === 0) {
    var emptyMsg = (listenerSearchState.query.nameQ)
      ? '条件に一致するリスナーはいません。<br>検索語を変更してください。'
      : 'リスナーが記録されていません。<br>コメントが届くとここに表示されます。';
    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:#4a6a7a">' + emptyMsg + '</div>';
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  // 既存 buildListenerItemHtml (= リスナー管理タブと同じ row) を流用。density 'm' (中) 固定。
  // heatmap は全期間検索では off (= isOwnStream / context が無く、 hydrateListenerHeatmaps が
  // 大量 listener × 14 bin で重いため Phase 2c で別途対応)。
  var html = '';
  for (var i = 0; i < page.rows.length; i++) {
    html += buildListenerItemHtml(page.rows[i], 'd-m');
  }
  listEl.innerHTML = html;
  var items = listEl.querySelectorAll('.listener-item');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', function () {
      var cid = this.getAttribute('data-channel-id');
      if (cid) openListenerDetail(cid);
    });
  }

  // ページング
  var totalPages = Math.max(1, Math.ceil((page.total || 0) / (page.limit || 1)));
  var currentPage = Math.floor((page.offset || 0) / (page.limit || 1)) + 1;
  if (pagEl) pagEl.style.display = (totalPages > 1) ? 'flex' : 'none';
  if (labelEl) labelEl.textContent = currentPage + ' / ' + totalPages + ' ページ';
  if (prevBtn) prevBtn.disabled = (currentPage <= 1);
  if (nextBtn) nextBtn.disabled = (currentPage >= totalPages);
  // 上端にスクロール (= ページ切替で結果先頭を見せる)
  if (listEl.scrollTop !== 0) listEl.scrollTop = 0;
}
// リモート閲覧 redesign §5.3 + ユーザー指摘: 自チャンネル枠 LIVE 中かどうか。
// 自枠は集計対象、他枠は表示用記録のみ。この値が false の時は自枠専用の分析 UI を抑制する。
var isOwnStream = false;
var totalReactions = 0;
// 現在開いている自配信の videoId。リスナー詳細モーダルの「この枠」フィルタで使用。
// onStatus(connected:true) で更新、未接続 (message='未接続') でクリア。
var currentStreamVideoId = '';

// stream のタイトル/開始時刻のキャッシュ。リスナー詳細モーダル Tab A の
// 「別配信 (3 日前)」表示を「📺 〇〇歌枠 #38 (3 日前)」へ in-place で書き換えるために
// 別配信ID 単位で 1 回だけ streamDetail を fetch する (modal を開き直しても再利用)。
var streamTitleCache = {};
var ttsState = { enabled: false, paused: false, speaking: false, queueCount: 0, provider: 'builtin', providerStatus: 'idle', providerError: '' };
// TTS の ON/OFF / プロバイダ切替は Rust 側で再生プロセス停止やキュークリアを伴うため
// 数百ミリ秒待つことがある。多重クリック防止と「処理中」表示のためのフラグ。
var ttsBusy = false;
// 現在 DOM に居る TTS app card の badge への参照。
// renderApps が card を作った直後にここに格納し、SSE 由来の状態更新は
// app-list 全体を rebuild せずに badge.textContent だけ in-place で書き換える。
// (app-list rebuild 中にクリックが重なるとクリックが捨てられる race を回避)
var ttsBadgeRef = null;
// 直近に読み込んだ TTS 設定 (apps card のバッジで provider のキャラ/スタイル表示に使う)
var ttsSettingsCache = null;

// SubsectionNav 動的 title 用 module 変数
var currentPerformanceEditTitle = '演出';

// performance-edit-section から戻った時に親 (= performance-list-section) を rebuild せず
// 差分更新するための ref。 通知 3 兄弟 / tts と同パターン。 件数 / 並び順が変わって
// いれば renderPerformanceList で rebuild にフォールバック。
var performanceViewRefs = null;   // { listEl, items: { id: { nameEl, summaryEl, toggleEl, badgeEl } } }
var performancesCache = null;     // 各 perf-item の click handler が closure で持つ perf を最新に保つため

// TTS provider 詳細設定 (= tts-provider-edit-section) 用の動的 title + ref。
// 通知側 (notificationViewRefs / currentNotificationProviderLabel) と同じパターン。
// SubsectionNav の title fn と refreshTtsView から参照する。
var currentTtsProviderLabel = '読み上げソフト設定';
var ttsViewRefs = null;

// providerOptions / findProviderOption を module-level に出して refreshTtsView から
// アクセスできるようにする (= 旧 showTtsSettings 内 closure から外出し)。
var TTS_PROVIDER_OPTIONS = [
  { value: 'builtin',  label: '内蔵読み上げ', meta: 'Windows 標準の音声で読み上げます',   detail: '追加ソフトなし' },
  { value: 'bouyomi',  label: '棒読みちゃん', meta: '棒読みちゃんへ送って読み上げます', detail: '棒読みちゃんを起動して使う' },
  { value: 'voicevox', label: 'VOICEVOX',     meta: 'VOICEVOX ENGINE で読み上げます',     detail: 'ずんだもん等のキャラクターを選べる' }
];
function findTtsProviderOption(provider) {
  for (var i = 0; i < TTS_PROVIDER_OPTIONS.length; i++) {
    if (TTS_PROVIDER_OPTIONS[i].value === provider) return TTS_PROVIDER_OPTIONS[i];
  }
  return TTS_PROVIDER_OPTIONS[0];
}

// --- コメント通知 (Phase A: UI スケルトン) ---
var notificationState = { enabled: false, paused: false, provider: 'builtin', enabledEventCount: 0, totalEventCount: 8 };
var notificationBusy = false;
var notificationBadgeRef = null;
var notificationSettingsCache = null;
// SubsectionNav が動的 title fn から読む module 変数 (= show*Settings 内で更新)
var currentNotificationEventLabel = 'イベント設定';
var currentNotificationProviderLabel = '読み上げソフト設定';
// 子 section から戻った時に親 (= notification-edit-section) を rebuild せず差分更新
// するための element ref。 showNotificationSettings の render() で各 element を保存し、
// refreshNotificationView() が ref 経由で textContent / class / 枠色のみ書き換える。
// rebuild を避けることで framework の scroll 復元が機能する。
var notificationViewRefs = null;
// 通知イベントの表示専用 metadata (= icon / name)。 旧 tplDefault / soundPreset は
// Rust 正本化のため撤去 (= notification_settings::EVENT_TEMPLATE_DEFAULTS /
// EVENT_SOUND_PRESET_DEFAULTS が SoT)。 default 値は notificationEventDefaults
// (= 起動時に napi getNotificationEventDefaults で fetch) から def.id をキーに引く。
var NOTIFICATION_EVENT_DEFS = [
  { id: 'first_seen',  icon: '🆕', name: '初見さん来訪' },
  { id: 'revisit',     icon: '🔁', name: '常連再訪' },
  { id: 'comeback',    icon: '👋', name: '古参の帰還' },
  { id: 'latecomer',   icon: '⏰', name: '今北 (常連・古参の初コメ)' },
  { id: 'superchat',   icon: '💰', name: 'スパチャ受信' },
  { id: 'new_member',  icon: '⭐', name: 'メンバーシップ加入' },
  { id: 'member_gift', icon: '🎁', name: 'メンバーシップギフト' },
  { id: 'moderator',   icon: '🛡', name: 'モデレータ発言' }
];

// 起動時に napi で fetch する Rust 正本のイベント別 default (= 旧 def.tplDefault /
// def.soundPreset 相当)。 { [event_id]: { template, sound_preset_id } } の object。
// fetch 失敗時は空 object のまま (= placeholder 表示は空文字列にフォールバック)。
var notificationEventDefaults = {};

function getNotificationEventDefault(eventId) {
  return notificationEventDefaults[eventId] || { template: '', sound_preset_id: '' };
}
function findNotificationEventDef(id) {
  for (var i = 0; i < NOTIFICATION_EVENT_DEFS.length; i++) {
    if (NOTIFICATION_EVENT_DEFS[i].id === id) return NOTIFICATION_EVENT_DEFS[i];
  }
  return null;
}
// 通知 provider と TTS provider が同じソフトなら TTS の providerStatus を流用
// (= 通知側に独自接続チェックがないためベスト effort)。 'none' / 'builtin' は常時 'ok'
// (= 読み上げ無し / OS 標準で常時利用可)。 別 provider なら判定不能で 'ok' 扱い。
function notificationProviderStatusForDisplay() {
  var p = notificationState.provider;
  if (!p || p === 'none' || p === 'builtin') return 'ok';
  if (p !== ttsState.provider) return 'ok';
  return ttsState.providerStatus || 'ok';
}

function notificationBadgeText() {
  // ON/OFF は別途トグルボタン (.u-btn.on / .u-btn) で表現するので badge には入れない。
  // TTS badge と同じく providerStatus を最優先で反映 (= unreachable / checking は
  // count を隠して状態だけ表示、 ok のみ count + provider 名)。
  var status = notificationProviderStatusForDisplay();
  if (status === 'unreachable') {
    return providerLabelForTts(notificationState.provider) + ' 未起動';
  }
  if (status === 'checking') {
    return '接続確認中…';
  }
  // ok: 「count + provider 名」 (= VOICEVOX ならキャラ/スタイル併記)
  var providerPart = providerLabelForTts(notificationState.provider);
  if (notificationState.provider === 'voicevox' && notificationSettingsCache && notificationSettingsCache.voicevox) {
    var vv = notificationSettingsCache.voicevox || {};
    var info = lookupVoicevoxName(cachedVoicevoxSpeakers, vv.speakerUuid, vv.styleId);
    if (info) {
      var parts = [info.name, info.style].filter(function (s) { return s && s.length > 0; });
      if (parts.length > 0) providerPart = 'VOICEVOX: ' + parts.join('/');
    }
  }
  var count = notificationState.enabledEventCount + '/' + notificationState.totalEventCount;
  return count + ' ' + providerPart;
}
function applyNotificationBadgeAppearance(el) {
  if (!el) return;
  // VOICEVOX キャラ表示用に speakers cache を温める (= TTS と共有、 通知 provider が
  // VOICEVOX なら fetch が発火する)
  maybeFetchVoicevoxSpeakers();
  el.textContent = notificationBadgeText();
  var status = notificationProviderStatusForDisplay();
  if (status === 'unreachable') {
    // 未起動: TTS badge の unreachable と同じ赤系
    el.style.color = '#ff8a8a';
    el.style.background = '#3a1a1a';
    el.title = ttsState.providerError || '読み上げソフトに接続できません';
  } else if (status === 'checking') {
    // 接続確認中: TTS badge の checking と同じ灰系
    el.style.color = '#cbd5e1';
    el.style.background = '#1a2742';
    el.title = '';
  } else {
    // 通常: TTS badge と同じ cyan 系 (= ON/OFF の色分けはトグルボタンに集約)
    el.style.color = '#00bcd4';
    el.style.background = '#004d54';
    el.title = '';
  }
}

function ttsBadgeText() {
  // provider が落ちている / 確認中は他の状態より優先で表示する
  // (配信者がワンセクで未起動を把握できるよう、speaking/queueCount より上)
  if (ttsState.providerStatus === 'unreachable') {
    return providerLabelForTts(ttsState.provider) + ' 未起動';
  }
  if (ttsState.providerStatus === 'checking') {
    return '接続確認中…';
  }
  // ベース表示は「ソフト名 (+ VOICEVOX のキャラ/モード)」。
  // 読み上げ中 / 待機 N件のときはサフィックスとして併記し、
  // 配信者が「どのソフトの誰が今読み上げているか」を一目で把握できるようにする。
  var providerLabel = providerLabelForTts(ttsState.provider);
  var providerPart = providerLabel;
  if (ttsState.provider === 'voicevox' && ttsSettingsCache) {
    var vv = ttsSettingsCache.voicevox || {};
    var info = lookupVoicevoxName(cachedVoicevoxSpeakers, vv.speakerUuid, vv.styleId);
    if (info) {
      var parts = [info.name, info.style].filter(function (s) { return s && s.length > 0; });
      if (parts.length > 0) providerPart = providerLabel + ': ' + parts.join('/');
    }
  }
  if (ttsState.speaking) return providerPart + ' / 読み上げ中';
  if (ttsState.queueCount > 0) return providerPart + ' / 待機 ' + ttsState.queueCount + '件';
  return providerPart;
}

// TTS バッジの textContent + 色を providerStatus に応じて in-place 更新する。
// SSE 駆動 UI で innerHTML 全 rebuild は禁止 (CLAUDE.md) なので、必ずこの関数経由で
// 既存ノードの style を書き換えること。
function applyTtsBadgeAppearance(el) {
  if (!el) return;
  // VOICEVOX 選択中で speakers cache が空なら fetch を発火 (起動時 unreachable で
  // skip されたケース、provider 切替で SSE 経由で更新が来たケースの両方をここで拾う)
  maybeFetchVoicevoxSpeakers();
  el.textContent = ttsBadgeText();
  if (ttsState.providerStatus === 'unreachable') {
    el.style.color = '#ff8a8a';
    el.style.background = '#3a1a1a';
    el.title = ttsState.providerError || '接続できませんでした';
  } else if (ttsState.providerStatus === 'checking') {
    el.style.color = '#cbd5e1';
    el.style.background = '#1a2742';
    el.title = '';
  } else {
    el.style.color = '#00bcd4';
    el.style.background = '#004d54';
    el.title = '';
  }
}

// VOICEVOX speakers のキャッシュ。状態カードでキャラ名/スタイル名を表示するために使う。
// VOICEVOX 接続が必要なので最初の参照時に lazy fetch、以降は使い回す。
var cachedVoicevoxSpeakers = null;
var voicevoxSpeakersFetching = false;
function ensureVoicevoxSpeakers() {
  if (cachedVoicevoxSpeakers) return Promise.resolve(cachedVoicevoxSpeakers);
  if (!window.api || !window.api.ttsGetVoices) return Promise.resolve(null);
  return window.api.ttsGetVoices('voicevox').then(function (data) {
    if (data && data.ok && Array.isArray(data.speakers)) {
      cachedVoicevoxSpeakers = data.speakers;
      return cachedVoicevoxSpeakers;
    }
    return null;
  }).catch(function () { return null; });
}
// 状態に応じて speakers の lazy fetch を発火する。VOICEVOX 選択中で provider が
// 落ちていない (= ok / idle / checking) のときだけ叩く。fetch 成功で cache が入ったら
// バッジを再描画する。SSE で provider が VOICEVOX に切り替わった直後や、起動時 unreachable
// から復旧した直後にもここから fetch がキックされる (= renderApps 時点だけに依存しない)。
// TTS / 通知 のどちらかが VOICEVOX を使っていれば cache を温める (= 通知 badge でも
// キャラ/スタイル表示に必要)。
function maybeFetchVoicevoxSpeakers() {
  if (cachedVoicevoxSpeakers) return;
  if (voicevoxSpeakersFetching) return;
  var ttsUsesVoicevox = ttsState.provider === 'voicevox' && ttsState.providerStatus !== 'unreachable';
  var notifUsesVoicevox = notificationState.provider === 'voicevox';
  if (!ttsUsesVoicevox && !notifUsesVoicevox) return;
  voicevoxSpeakersFetching = true;
  ensureVoicevoxSpeakers().then(function () {
    voicevoxSpeakersFetching = false;
    applyTtsBadgeAppearance(ttsBadgeRef);
    applyNotificationBadgeAppearance(notificationBadgeRef);
  }, function () {
    voicevoxSpeakersFetching = false;
  });
}
function lookupVoicevoxName(speakers, speakerUuid, styleId) {
  if (!Array.isArray(speakers) || !speakerUuid) return null;
  var sid = parseInt(styleId, 10);
  for (var i = 0; i < speakers.length; i++) {
    var s = speakers[i];
    if (s.speaker_uuid !== speakerUuid) continue;
    var styleName = '';
    if (Array.isArray(s.styles)) {
      for (var j = 0; j < s.styles.length; j++) {
        if (s.styles[j].id === sid) { styleName = s.styles[j].name; break; }
      }
    }
    return { name: s.name || '', style: styleName };
  }
  return null;
}

// 前回のURLを復元
window.api.getLastUrl();
window.api.onLastUrl(function (url) {
  urlInput.value = url;
});

connectBtn.addEventListener('click', function () {
  if (isConnected) {
    rendererLog.info('user: disconnect-click');
    window.api.disconnect();
  } else {
    var url = urlInput.value.trim();
    if (!url) return;
    // 隠しコマンド
    if (url === 'beta') {
      rendererLog.info('user: beta-channel-toggle-via-hidden-cmd');
      window.api.getBetaChannel().then(function (current) {
        var next = !current;
        window.api.setBetaChannel(next);
        urlInput.value = '';
        setStatus(next ? 'connected' : 'disconnected',
          next ? 'Beta channel ON (restart to apply)' : 'Beta channel OFF (restart to apply)');
        setTimeout(function () {
          if (!isConnected) setStatus('disconnected', t('connection.status.disconnected'));
        }, 3000);
      });
      return;
    }
    rendererLog.info('user: connect-click, url=' + url);
    window.api.connect(url);
    setStatus('connecting', '接続中...');
    renderCommentEmptyState('コメントを読み込んでいます。');
    // 接続開始時点で URL 入力欄を隠す (onStatus(connected:true) 待ちだと
    // chat-scraper status が遅れて一時的に両方表示される問題を回避)。
    // stream-info パネルは fetch 完了後に表示されるが、それまでは status-row
    // を見せる必要があるため、stream-info の display 状態に合わせて切り替える。
    setUrlInputVisible(false);
    setOuterStatusRowVisible(true);
  }
});

// YouTubeログインは設定画面から実行

urlInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !isConnected) {
    connectBtn.click();
  }
});

window.api.onComment(function (data) {
  addComment(data);
  // ギフト系 (= スパチャ / ステッカー / メンバー加入 / メンバーギフト) は
  // ギフトタブにも append。コメ tab とは独立した DOM ノードを作る。
  if (isGiftComment(data)) {
    appendGiftCard(data);
  }
  // リスナー一覧の「枠 SC」amber 表示を live で更新。
  // listenerCurrentStreamSuperchatAmountJpy は Rust 側で計算済みの「この listener が
  // この配信で出した SC 累計」(running total)。SC 以外のコメントでも値が乗ってくる
  // ことがあるため、type 判定はせず amount > 0 の値が来たら最新値で上書きする。
  // 正本は DB → list_listeners の row.perStreamScAmountJpy。ここでは
  // listenerMgrState.page.rows の対応 row を in-place 更新するだけ (= 次回 fetch まで反映)。
  if (data) {
    var rawCid = data.userId || data.channelId || '';
    var amt = Number(data.listenerCurrentStreamSuperchatAmountJpy || 0);
    if (rawCid && amt > 0) {
      var nk = normalizeListenerChannelId(rawCid);
      var page = listenerMgrState && listenerMgrState.page;
      if (page && Array.isArray(page.rows)) {
        for (var rIdx = 0; rIdx < page.rows.length; rIdx++) {
          if (page.rows[rIdx].channelId === nk) {
            // running total なので max ではなく単純上書き (= 常に最新値が最大)。
            page.rows[rIdx].perStreamScAmountJpy = amt;
            if (typeof isClFrameTabActive === 'function' &&
                isClFrameTabActive('listeners') &&
                typeof renderListenerList === 'function') {
              renderListenerList(page);
            }
            break;
          }
        }
      }
    }
  }
});

window.api.onCommentDeleted(function (data) {
  if (data && data.id) {
    var el = commentList.querySelector('[data-id="' + data.id + '"]');
    if (el) el.remove();
  }
});

if (window.api.onTtsState) {
  // Rust 側はコメント毎に tts-state を送ってくる (enqueue / 再生開始 / 再生終了)。
  // 過去は renderApps で app-list 全体を rebuild していたが、rebuild 中に
  // クリックが重なるとクリックが破棄された DOM に飛んで消失する race があった。
  // ここでは badge text だけを既存ノード上で in-place 更新する。
  // ON/OFF や provider の切替は user 操作経由で本体 renderApps が呼ばれるため、
  // SSE 側からは触らない (toggle button の click handler は ttsState を毎回参照するため
  // 表示が一瞬ズレてもクリック挙動は正しい)。
  window.api.onTtsState(function (state) {
    ttsState = state || ttsState;
    if (ttsBusy) return;
    applyTtsBadgeAppearance(ttsBadgeRef);
    // ttsState.providerStatus / .provider が変わると通知 badge の「未起動」 判定にも
    // 影響するので連動更新 (= 通知が同 provider を使っている場合のみ実質変化する)
    applyNotificationBadgeAppearance(notificationBadgeRef);
  });
}
if (window.api.ttsGetState) {
  window.api.ttsGetState().then(function (state) {
    if (state) {
      ttsState = state;
      renderApps();
    }
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}
// 起動時に TTS 設定を 1 回取得して ttsSettingsCache に入れる。これで apps card のバッジが
// VOICEVOX 時にキャラ/スタイルを表示できる。VOICEVOX speakers も裏で取得して cache に温める。
if (window.api.ttsGetSettings) {
  window.api.ttsGetSettings().then(function (settings) {
    if (settings) {
      ttsSettingsCache = settings;
      if (settings.provider === 'voicevox') {
        ensureVoicevoxSpeakers().then(function () {
          renderApps();
        });
      }
    }
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

// 起動時に通知設定を 1 回取得 (= GLOBAL カードのバッジ表示用)。 Phase A は表示の整合のみ。
if (window.api.notificationGetState) {
  window.api.notificationGetState().then(function (state) {
    if (state) {
      notificationState = state;
      renderApps();
    }
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}
if (window.api.notificationGetSettings) {
  window.api.notificationGetSettings().then(function (settings) {
    if (settings) notificationSettingsCache = settings;
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

// 通知イベント default の Rust 正本を 1 度 fetch する (= 旧 NOTIFICATION_EVENT_DEFS の
// tplDefault / soundPreset 二重正本を撤去したため、 placeholder 表示 / 「↺ デフォルトに戻す」
// で参照する values をここで取得する)。 fetch 失敗時は空 object のまま (= placeholder
// 表示は空文字列にフォールバック、 機能は壊さない best-effort)。
if (window.api.notificationGetEventDefaults) {
  window.api.notificationGetEventDefaults().then(function (json) {
    if (typeof json !== 'string') return;
    var arr;
    try { arr = JSON.parse(json); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    arr.forEach(function (entry) {
      if (entry && entry.event_id) {
        notificationEventDefaults[entry.event_id] = {
          template: entry.template || '',
          sound_preset_id: entry.sound_preset_id || ''
        };
      }
    });
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

// Phase C: 通知イベントの filter + TTS enqueue は Rust 側 (= model_queue/notification.rs)
// で完結するため、 renderer 側 SSE 受信は撤去。 ログは Rust の tracing::info で app.log に出る。

window.api.onReaction(function (data) {
  totalReactions = data && typeof data.total === 'number' ? data.total : totalReactions;
  reactionCounter.textContent = t('footer.reaction', { count: '\u2764\uFE0F x' + totalReactions });
});

function applyConnectionStatus(data) {
  if (data.connected) {
    var ownerLabel = data.isOwnStream ? ' [自枠]' : ' [他枠]';
    setStatus('connected', '接続中 (video: ' + data.videoId + ')' + ownerLabel);
    isConnected = true;
    updateClTabsLiveState();
    var prevOwn = isOwnStream;
    isOwnStream = !!data.isOwnStream;
    // 既存 commentList 内の各 cell に対応済みトグルを動的に追加/削除する
    // (= addComment は 1 件ずつ append、再 render しないため、フラグ変化を反映する)
    if (prevOwn !== isOwnStream) {
      applyIsOwnStreamToCommentList();
    }
    // 枠切替時の状態リセット。現枠 SC は listener row の perStreamScAmountJpy に集約済みで、
    // refreshListenerList で全置換されるためここでの個別 reset は不要。
    var prevVideoId = currentStreamVideoId;
    currentStreamVideoId = data.videoId || '';
    // 接続切替 (= 自枠フラグ or videoId 変化) に追従して、リスナータブの接続枠
    // フィルターをデフォルトへ戻す (= ON if 自枠接続中、それ以外 OFF)。
    // ユーザーの手動 toggle 状態は次の接続切替で破棄される (仕様)。
    if (prevOwn !== isOwnStream || prevVideoId !== currentStreamVideoId) {
      if (typeof resetListenerStreamFilterDefault === 'function') {
        resetListenerStreamFilterDefault();
        // 件数バッジは cl-tab「リスナー」の +N ピル (= tab 非アクティブでも可視) にも
        // 使うので、listener タブが開いていなくても fetch する。重い SQL だが
        // 接続切替時のみ、かつ Phase 1 最適化 (730ms→75ms) 済みで許容。
        if (typeof refreshListenerMiniTabCounts === 'function') refreshListenerMiniTabCounts();
        // 一覧の再取得は listener タブが見えている時だけ (= 描画コスト節約)
        if (typeof isClFrameTabActive === 'function' &&
            isClFrameTabActive('listeners')) {
          if (typeof refreshListenerList === 'function') refreshListenerList();
        }
      }
      // 接続切替時 (= prevOwn / prevVideoId 変化) は新枠の streams row が DB に
      // 登録された直後なので、 cache 済 page を再描画ではなく 再 fetch する。
      // 旧仕様 `renderStreamsList(streamsState.page)` は cache を再描画するだけで
      // 新枠 row が出てこない (= 「配信ログに接続中の配信が無い」 バグ、 2026-05-23)
      if (typeof isClFrameTabActive === 'function' &&
          isClFrameTabActive('streams') &&
          typeof refreshStreamsList === 'function') {
        refreshStreamsList();
      }
    }
    // ギフトタブを当該枠の DB 取得分で再構築 (= 接続直後 / 別枠切替直後)
    loadGiftsForStream(currentStreamVideoId);
    // 配信接続時に sumb をローカル DL (fire-and-forget)。
    // 後で配信ログを開いた時にローカル URL から即時表示できる。
    if (typeof ensureStreamThumbnailCached === 'function') {
      ensureStreamThumbnailCached(data.videoId);
    }
    connectBtn.textContent = t('connection.disconnect');
    connectBtn.classList.add('connected');
    // 接続後は URL 入力欄を隠す。stream-info パネルが既に表示済みなら
    // 外側 status-row も隠して二重表示を回避。
    setUrlInputVisible(false);
    var streamPanel = document.getElementById('stream-info');
    setOuterStatusRowVisible(!streamPanel || streamPanel.style.display === 'none');
  } else {
    var msg = data.message || '未接続';
    // 再接続中はconnectingスタイルを適用
    var state = msg.indexOf('再接続') !== -1 || msg.indexOf('接続中') !== -1 ? 'connecting' : 'disconnected';
    setStatus(state, msg);

    if (msg === '未接続') {
      // 手動切断 → 入力欄に戻す
      isConnected = false;
      isOwnStream = false;
      currentStreamVideoId = '';
      updateClTabsLiveState();
      // 接続枠フィルターをデフォルト (= 'all' タブ) へ + 件数バッジ 0 リセット。
      // 切断中は streamScopedListenerCounts を呼んでも 0 が返るので、内部で skip
      // される (refreshListenerMiniTabCounts が currentStreamVideoId 空なら no-op)。
      if (typeof resetListenerStreamFilterDefault === 'function') {
        resetListenerStreamFilterDefault();
        if (typeof isClFrameTabActive === 'function' &&
            isClFrameTabActive('listeners') &&
            typeof refreshListenerList === 'function') {
          refreshListenerList();
        }
      }
      // 切断時 (= ended_at が DB に書かれた直後) も cache 再描画ではなく再 fetch。
      // 旧仕様だと「接続中」 表示のまま残る (= ended_at 反映なし)。 同上 2026-05-23 修正
      if (typeof isClFrameTabActive === 'function' &&
          isClFrameTabActive('streams') &&
          typeof refreshStreamsList === 'function') {
        refreshStreamsList();
      }
      connectBtn.textContent = t('connection.connect');
      connectBtn.classList.remove('connected');
      totalReactions = 0;
      reactionCounter.textContent = t('footer.reaction.none');
      commentList.innerHTML = '';
      refreshCommentEmptyState();
      clearGifts();
      hideStreamInfoPanel();
      setUrlInputVisible(true);
      setOuterStatusRowVisible(true);
    } else {
      // 接続中 / 再接続中 / 5秒後再接続 等: 自動再接続経路は click ハンドラを
      // 通らないので、ここで URL 入力欄を hide する保険ロジックを置く。
      setUrlInputVisible(false);
      var sp = document.getElementById('stream-info');
      setOuterStatusRowVisible(!sp || sp.style.display === 'none');
    }
  }
  refreshCommentEmptyState();
  updateClRecordingStatus();
}

window.api.onStatus(function (data) {
  applyConnectionStatus(data || {});
});

if (window.api.getChatStatus) {
  window.api.getChatStatus().then(function (status) {
    if (status) applyConnectionStatus(status);
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

var apiStatus = document.getElementById('api-status');

window.api.onApiClients(function (data) {
  apiStatus.textContent = t('footer.sse', { port: currentPort, clients: data.count });
});

// === マニュアル ===

// === マニュアル ===
var manualBtn = document.getElementById('manual-btn');
manualBtn.addEventListener('click', function () {
  rendererLog.info('user: open-manual-window');
  window.api.openManual();
});

// === アプリ設定 ===
var settingsBtn = document.getElementById('settings-btn');
settingsBtn.addEventListener('click', function () {
  // log は openSettings 入口で集約 (= 他経路の openSettings 呼出も補足するため)
  openSettings();
});

var setupBtn = document.getElementById('setup-btn');
if (setupBtn) {
  setupBtn.addEventListener('click', function () {
    if (window.api && window.api.openOnboarding) window.api.openOnboarding();
  });
  // 「準備」ボタンは経験者 (= 自チャンネル設定 / 接続実績あり) や 完了/dismiss 済みでは隠す。
  // 経験者判定は Rust コアの実データに依るためコア ready 後に確定する。既定で隠しておき、
  // shouldShowEntry が true のときだけ表示する (= 経験者が大半 + 判定確定までのチラ見え防止)。
  setupBtn.style.display = 'none';
  function refreshSetupEntry() {
    var ob = window.api && window.api.onboarding;
    if (!ob || typeof ob.shouldShowEntry !== 'function') {
      setupBtn.style.display = '';
      return;
    }
    ob.shouldShowEntry().then(function (show) {
      setupBtn.style.display = show ? '' : 'none';
    }).catch(function () { /* 判定不可時は隠したまま (新規ユーザーは自動オープンで到達可) */ });
  }
  if (window.api && typeof window.api.onCoreReady === 'function') {
    window.api.onCoreReady(refreshSetupEntry);
  }
  if (window.api && window.api.onboarding && typeof window.api.onboarding.onEntryRefresh === 'function') {
    window.api.onboarding.onEntryRefresh(refreshSetupEntry);
  }
}

// 終了時 export モーダルの phase ラベル (= export_progress_reporter の phase に対応)
var EXPORT_PHASE_LABELS = {
  'started': 'わんコメ書き戻し開始',
  'schema-check': 'スキーマ照合中...',
  'preflight': 'わんコメ DB を確認中...',
  'pristine-backup': 'わんコメ DB のバックアップを取得中...',
  'select-comments': 'こめはぶからコメ取得中...',
  'transform': 'わんコメ形式へ変換中...',
  'write-comments': 'コメをわんコメへ書き込み中...',
  'aggregate-users': 'リスナーを集計中...',
  'write-users': 'リスナーをわんコメへ書き込み中...',
  'watermark': '同期位置を更新中...',
  'done': '完了',
  'aborted': '中断しました'
};

// startup-sync-progress (= main.js が emit する大マイルストーン) 用のモーダル表示ラベル
var STARTUP_SYNC_MODAL_LABELS = {
  'started': 'わんコメと同期を開始しています...',
  'import-started': 'わんコメから取り込み中...',
  'import-completed': 'わんコメ取り込み完了',
  'import-failed': 'わんコメ取り込み失敗',
  'export-started': 'わんコメへ書き戻し中...',
  'export-completed': 'わんコメ書き戻し完了',
  'export-aborted': 'わんコメ書き戻しスキップ',
  'export-failed': 'わんコメ書き戻し失敗',
  'done': '同期完了',
  'error': '同期エラー'
};

// active な shutdown export モーダル参照 (= onExportProgress から更新するため)
var _activeShutdownModal = null;

function showShutdownExportModal() {
  if (document.getElementById('shutdown-export-overlay')) return;

  var overlay = document.createElement('div');
  overlay.id = 'shutdown-export-overlay';
  overlay.className = 'prompt-overlay';

  var dialog = document.createElement('div');
  dialog.className = 'prompt-dialog backup-progress-dialog';

  var iconEl = document.createElement('div');
  iconEl.className = 'shutdown-export-icon';
  iconEl.textContent = '💾';

  var title = document.createElement('div');
  title.className = 'prompt-label';
  title.textContent = 'わんコメへ書き戻し中';

  var phaseEl = document.createElement('div');
  phaseEl.className = 'backup-progress-phase';
  phaseEl.textContent = '準備中...';

  var barTrack = document.createElement('div');
  barTrack.className = 'backup-progress-bar-track kh-progress-bar-track';

  var barFill = document.createElement('div');
  barFill.className = 'backup-progress-bar-fill kh-progress-bar-fill';

  var percentEl = document.createElement('div');
  percentEl.className = 'backup-progress-percent';
  percentEl.textContent = '0%';

  var countEl = document.createElement('div');
  countEl.className = 'shutdown-export-count';

  var elapsedEl = document.createElement('div');
  elapsedEl.className = 'backup-progress-elapsed';
  elapsedEl.textContent = '経過 0 秒';

  var startedAt = Date.now();
  var elapsedTimer = setInterval(function () {
    var sec = Math.floor((Date.now() - startedAt) / 1000);
    elapsedEl.textContent = '経過 ' + sec + ' 秒';
  }, 500);

  barTrack.appendChild(barFill);
  dialog.appendChild(iconEl);
  dialog.appendChild(title);
  dialog.appendChild(phaseEl);
  dialog.appendChild(barTrack);
  dialog.appendChild(percentEl);
  dialog.appendChild(countEl);
  dialog.appendChild(elapsedEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  /**
   * モーダル進捗更新。 起動時 sync 中 close でも呼ばれるため、 phase ラベル辞書を
   * 呼出側 (= onExportProgress / onImportProgress / onStartupSyncProgress) で
   * 渡せるようにジェネリック化。 phaseLabels 省略時は EXPORT_PHASE_LABELS。
   */
  function update(data, phaseLabels) {
    if (!data) return;
    var labels = phaseLabels || EXPORT_PHASE_LABELS;
    var label = labels[data.phase] || data.phase || '';
    if (data.message) label = label + ' — ' + data.message;
    phaseEl.textContent = label;
    var overall = (typeof data.overallPercent === 'number') ? data.overallPercent : null;
    if (overall != null) {
      var p = Math.max(0, Math.min(100, Math.round(overall)));
      barFill.style.width = p + '%';
      percentEl.textContent = p + '%';
    } else if (data.total > 0 && data.current >= 0) {
      // overall_percent が無いケース (= import-progress) は phase 内の current/total を出す
      var p2 = Math.max(0, Math.min(100, Math.round(data.current * 100 / data.total)));
      barFill.style.width = p2 + '%';
      percentEl.textContent = p2 + '%';
    }
    if (data.total > 0 && data.current >= 0) {
      countEl.textContent = Number(data.current).toLocaleString() + ' / ' + Number(data.total).toLocaleString();
    } else {
      countEl.textContent = '';
    }
    // 状態クラスの切替 (= done = 緑、 aborted / 'export-aborted' = 警告、 'error' / 'failed' = エラー)
    barFill.classList.remove('is-done', 'is-warn', 'is-error');
    percentEl.classList.remove('is-done', 'is-warn', 'is-error');
    if (data.phase === 'done') {
      barFill.classList.add('is-done');
      percentEl.classList.add('is-done');
    } else if (data.phase === 'aborted' || data.phase === 'export-aborted') {
      barFill.classList.add('is-warn');
      percentEl.classList.add('is-warn');
    } else if (data.phase === 'error' || data.phase === 'import-failed' || data.phase === 'export-failed') {
      barFill.classList.add('is-error');
      percentEl.classList.add('is-error');
    }
  }

  _activeShutdownModal = {
    update: update,
    _elapsedTimer: elapsedTimer
  };
}

function hideShutdownExportModal() {
  if (_activeShutdownModal && _activeShutdownModal._elapsedTimer) {
    clearInterval(_activeShutdownModal._elapsedTimer);
  }
  var existing = document.getElementById('shutdown-export-overlay');
  if (existing) existing.remove();
  _activeShutdownModal = null;
}

function showResetAllSettingsProgress(titleText, bodyText) {
  var existing = document.getElementById('reset-all-settings-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'reset-all-settings-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#020617;z-index:20000;display:flex;align-items:center;justify-content:center;color:#e2e8f0;';
  var box = document.createElement('div');
  box.style.cssText = 'background:#0f172a;border:1px solid #334155;border-radius:12px;padding:24px;max-width:420px;width:86%;box-shadow:0 24px 80px rgba(0,0,0,0.45);';
  var title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:bold;margin-bottom:10px;color:#f8fafc;';
  title.textContent = titleText || '初期化を準備しています';
  var body = document.createElement('div');
  body.id = 'reset-all-settings-progress-body';
  body.style.cssText = 'font-size:12px;line-height:1.7;color:#94a3b8;';
  body.textContent = bodyText || '現在のデータをローカルに退避し、アプリを再起動します。このままお待ちください。';
  box.appendChild(title);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// UI 整理 Phase 2-5: app-frame サブ画面 (perf-list/perf-edit/tmpl-edit/tts-edit) を
// 開く時に app-frame に editing class を付与して viewport を占有させる。
// cl-frame の hide は CSS (#app-frame.editing ~ #cl-frame { display:none }) に委譲し、
// ユーザーが panel-toggle で個別に hidden 状態を持っていても上書きしない (= 退出時に
// 復元される)。panel-toggle (app-frame / cl-frame) は editing 中 CSS で disable する。
function enterAppFrameSubsection() {
  var appFrame = document.getElementById('app-frame');
  if (appFrame) appFrame.classList.add('editing');
}
function leaveAppFrameSubsection() {
  var appFrame = document.getElementById('app-frame');
  if (appFrame) appFrame.classList.remove('editing');
}

// UI 整理 Phase 2: シーン ZIP の import/export ハンドラ (= 設定モーダルから呼ぶ)
function importSceneFromFile() {
  if (guardSceneSideWhileTemplateEditing()) return;
  rendererLog.info('user: scene-import');
  return api.importScene().then(function (result) {
    if (!result || result.cancelled) return result;
    if (!result.ok) {
      showZipActionError(result, 'シーンのインポートに失敗しました。');
      return result;
    }
    var sceneId = result.sceneId;
    if (sceneId) {
      api.setSelectedScene(sceneId);
      if (result.warnings && result.warnings.length > 0) {
        showAlertDialog('シーンをインポートしましたが、以下の問題があります:\n\n' + result.warnings.join('\n'));
      }
    }
    return result;
  });
}

function exportCurrentSceneToFile() {
  if (!selectedSceneId) {
    showAlertDialog('エクスポートするシーンが選択されていません。');
    return;
  }
  rendererLog.info('user: scene-export-current, sceneId=' + selectedSceneId);
  return api.getScene(selectedSceneId).then(function (scene) {
    if (!scene) return;
    return api.exportScene(scene.id, scene.name).then(function (result) {
      if (!result || result.ok || result.cancelled) return result;
      showZipActionError(result, 'シーンのエクスポートに失敗しました。');
      return result;
    });
  });
}

// ============================================================
// === アプリ設定 (= settings frame: sidebar + 6 panel)
//
// HTML 静的構造は index.html の #settings-frame に。
// openSettings(sectionName?) で frame を表示 + 全セクション初期化、
// closeSettings() で hide。Esc / × ボタン / settings-open class で他 frame の hide。
// ============================================================

function openSettings(sectionName) {
  var frame = document.getElementById('settings-frame');
  if (!frame) return;
  // 観点 I: 設定画面 open を user 操作として記録。 sectionName は呼出元から
  // 指定された場合のみ (= 例: 「特定セクションをディープリンクで開く」 経路で
  // 何のセクションを意図したか追える)
  rendererLog.info('user: open-settings-modal' + (sectionName ? ', section=' + sectionName : ''));
  frame.removeAttribute('hidden');
  document.body.classList.add('settings-open');
  // idempotent な init (= 各 init は重複呼び出しを内部で吸収する)
  initSettingsNav();
  initSettingsYoutube();
  initSettingsListener();
  initSettingsDisplay();
  initSettingsScene();
  initSettingsData();
  initSettingsDebug();
  initSettingsAdvanced();
  setSettingsSection(sectionName || 'youtube');
}

function closeSettings() {
  var frame = document.getElementById('settings-frame');
  if (!frame) return;
  frame.setAttribute('hidden', '');
  document.body.classList.remove('settings-open');
}

function setSettingsSection(name) {
  var navItems = document.querySelectorAll('#settings-nav .settings-nav-item');
  for (var i = 0; i < navItems.length; i++) {
    navItems[i].classList.toggle('active', navItems[i].dataset.settingsSection === name);
  }
  var panels = document.querySelectorAll('#settings-content .settings-panel');
  for (var j = 0; j < panels.length; j++) {
    if (panels[j].dataset.settingsPanel === name) panels[j].removeAttribute('hidden');
    else panels[j].setAttribute('hidden', '');
  }
  // パネル切替時にエフェクト詳細を抜けて一覧に戻す
  var effList = document.getElementById('settings-eff-list');
  var effDetail = document.getElementById('settings-eff-detail');
  if (effList && effDetail) {
    effList.removeAttribute('hidden');
    effDetail.setAttribute('hidden', '');
  }
}

var _settingsNavInited = false;
function initSettingsNav() {
  if (_settingsNavInited) return;
  _settingsNavInited = true;
  var navItems = document.querySelectorAll('#settings-nav .settings-nav-item');
  for (var i = 0; i < navItems.length; i++) {
    (function (it) {
      it.addEventListener('click', function () {
        setSettingsSection(it.dataset.settingsSection);
      });
    })(navItems[i]);
  }
  var closeBtn = document.getElementById('settings-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeSettings);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('settings-open')) {
      closeSettings();
    }
  });
}

// === YouTube ===
function initSettingsYoutube() {
  var status = document.getElementById('settings-yt-status');
  var loginBtn = document.getElementById('settings-yt-login');
  var logoutBtn = document.getElementById('settings-yt-logout');
  var accountEl = document.getElementById('settings-yt-account');
  var accountAvatarEl = document.getElementById('settings-yt-account-avatar');
  var accountNameEl = document.getElementById('settings-yt-account-name');
  var accountHandleEl = document.getElementById('settings-yt-account-handle');

  function showAccount(info) {
    if (!accountEl) return;
    if (!info || !info.channelId) {
      accountEl.style.display = 'none';
      return;
    }
    accountEl.style.display = '';
    if (accountAvatarEl) {
      if (info.thumbnailUrl) {
        accountAvatarEl.style.backgroundImage = "url('" + String(info.thumbnailUrl).replace(/'/g, '%27') + "')";
        accountAvatarEl.textContent = '';
      } else {
        accountAvatarEl.style.backgroundImage = '';
        accountAvatarEl.textContent = (info.name || '?').charAt(0);
      }
    }
    if (accountNameEl) accountNameEl.textContent = info.name || info.channelId;
    if (accountHandleEl) {
      var sub = [];
      if (info.handle) sub.push('@' + info.handle);
      sub.push(info.channelId);
      accountHandleEl.textContent = sub.join(' · ');
    }
  }

  function showAccountFailure(reason) {
    if (!accountEl) return;
    accountEl.style.display = '';
    if (accountAvatarEl) {
      accountAvatarEl.style.backgroundImage = '';
      accountAvatarEl.textContent = '?';
    }
    if (accountNameEl) accountNameEl.textContent = 'アカウント情報を取得できませんでした';
    if (accountHandleEl) accountHandleEl.textContent = reason || '(不明な理由)';
  }
  function refreshStatus() {
    if (!status) return;
    status.textContent = '確認中...';
    status.className = 'settings-status-badge';
    if (accountEl) accountEl.style.display = 'none';
    window.api.checkLogin().then(function (loggedIn) {
      if (loggedIn) {
        status.textContent = '✓ ログイン済み';
        status.classList.add('ok');
        // ログイン中アカウントの詳細を取得して表示 (= 失敗時はカードに理由を出す)
        if (api.listeners && api.listeners.getCurrentChannel) {
          api.listeners.getCurrentChannel().then(function (resp) {
            if (resp && resp.ok && resp.channelId) {
              showAccount(resp);
            } else {
              rendererLog.warn('getCurrentChannel failed', resp);
              showAccountFailure(resp && resp.reason ? 'reason: ' + resp.reason : '');
            }
          }).catch(function (err) {
            rendererLog.warn('getCurrentChannel exception', err);
            showAccountFailure(err && err.message ? err.message : String(err));
          });
        }
      } else {
        status.textContent = '✕ 未ログイン';
        status.classList.add('ng');
        showAccount(null);
      }
    });
  }
  refreshStatus();
  if (loginBtn && !loginBtn._inited) {
    loginBtn._inited = true;
    loginBtn.addEventListener('click', function () {
      rendererLog.info('user: open-login-window');
      window.api.openLogin();
      closeSettings();
    });
  }
  if (logoutBtn && !logoutBtn._inited) {
    logoutBtn._inited = true;
    logoutBtn.addEventListener('click', function () {
      window.api.logout().then(function () {
        refreshStatus();
        // 自チャンネル設定の「ログイン中チャンネル追加」ボタンも未ログイン状態に追従させる
        refreshSelfChannelButton();
        var orig = logoutBtn.textContent;
        logoutBtn.textContent = 'ログアウトしました';
        logoutBtn.disabled = true;
        setTimeout(function () { logoutBtn.textContent = orig; logoutBtn.disabled = false; }, 2000);
      });
    });
  }
}

// === Listener ===
function initSettingsListener() {
  var ownerInput = document.getElementById('settings-owner-input');
  if (ownerInput && !ownerInput._inited) {
    ownerInput._inited = true;
    ownerInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addOwnerFromSettingsInput(); }
    });
  }
  var ownerAdd = document.getElementById('settings-owner-add');
  if (ownerAdd && !ownerAdd._inited) {
    ownerAdd._inited = true;
    ownerAdd.addEventListener('click', addOwnerFromSettingsInput);
  }
  var ownerClear = document.getElementById('settings-owner-clear');
  if (ownerClear && !ownerClear._inited) {
    ownerClear._inited = true;
    ownerClear.addEventListener('click', function () {
      // アプリ内スタイル統一のため showPromptDialog で confirm (= 旧 window.confirm から移行)
      showPromptDialog(
        '自チャンネル設定を全クリアしますか?\n\n以後コメントは記録されなくなります。\n(後から再登録できます)',
        null,
        function (ok) {
          if (!ok) return;
          saveListenerOwners([]);
        }
      );
    });
  }
  if (api.listeners && api.listeners.getOwnerChannels) {
    api.listeners.getOwnerChannels().then(function (resp) {
      var channels = resp && Array.isArray(resp.ownerChannels) ? resp.ownerChannels : [];
      listenerMgrState.ownerChannels = channels;
      refreshOwnerSettingsSection();
      updateOwnerWarnBanner();
      autoResolveMissingOwnerHandles();
    }).catch(function () { refreshOwnerSettingsSection(); });
  } else {
    refreshOwnerSettingsSection();
  }
  // 「ログイン中チャンネルを追加」ボタン (= ログイン状態に応じ表示)
  refreshSelfChannelButton();

  // 設定「リスナー判定」ライブプレビュー: 現しきい値で 6 ランク件数を fetch + 表示。
  // baseline = 接続中なら currentStreamVideoId、 切断中なら owner_channels 配下の
  // 最新枠 (= listener-search タブと同じ解決ロジック)。 解決済 baseline を再利用する
  // ため `listenerSearchState.resolvedBaselineVideoId` を覗く。
  // 連続変更 (= input 'change' を立て続けに発火) でも 1 fetch にまとめるため debounce。
  var _rankPreviewFetchPending = null;
  var _rankPreviewBaselineCache = '';
  function refreshRankPreview() {
    if (_rankPreviewFetchPending) clearTimeout(_rankPreviewFetchPending);
    _rankPreviewFetchPending = setTimeout(function () {
      _rankPreviewFetchPending = null;
      resolveRankPreviewBaseline().then(function (baselineId) {
        if (!baselineId) {
          renderRankPreview(null, '自チャンネル枠が未記録です');
          return;
        }
        if (!api.listeners || typeof api.listeners.searchRankCounts !== 'function') {
          renderRankPreview(null, 'API 未接続');
          return;
        }
        api.listeners.searchRankCounts(baselineId).then(function (resp) {
          if (!resp || !resp.ok || !resp.counts) {
            renderRankPreview(null, '取得失敗');
            return;
          }
          renderRankPreview(resp.counts, '');
        }).catch(function (err) {
          rendererLog.error('rankPreview fetch failed', err);
          renderRankPreview(null, 'エラー');
        });
      });
    }, 250);
  }

  function resolveRankPreviewBaseline() {
    // 接続中: currentStreamVideoId 採用 (即時)
    if (currentStreamVideoId) {
      _rankPreviewBaselineCache = currentStreamVideoId;
      return Promise.resolve(currentStreamVideoId);
    }
    // listener-search タブで解決済みの値を流用 (= 重複 fetch 回避)
    if (listenerSearchState && listenerSearchState.resolvedBaselineVideoId) {
      _rankPreviewBaselineCache = listenerSearchState.resolvedBaselineVideoId;
      return Promise.resolve(_rankPreviewBaselineCache);
    }
    // 既に preview 経由で解決済ならそれを返す
    if (_rankPreviewBaselineCache) {
      return Promise.resolve(_rankPreviewBaselineCache);
    }
    // 切断中 + 未解決: list_streams scope=own で最新枠を取りに行く
    if (!api || !api.listeners || typeof api.listeners.streams !== 'function') {
      return Promise.resolve('');
    }
    return api.listeners.streams({
      scope: 'own', sort: 'startedAt', limit: 1, offset: 0,
    }).then(function (resp) {
      if (resp && resp.ok && resp.page && Array.isArray(resp.page.rows) && resp.page.rows.length > 0) {
        var v = resp.page.rows[0].videoId || '';
        _rankPreviewBaselineCache = v;
        return v;
      }
      return '';
    }).catch(function () { return ''; });
  }

  function renderRankPreview(counts, errorOrEmpty) {
    var box = document.getElementById('settings-rank-preview');
    var meta = document.getElementById('settings-rank-preview-meta');
    var listEl = document.getElementById('settings-rank-preview-counts');
    if (!box || !meta || !listEl) return;
    box.style.display = '';
    if (!counts) {
      meta.textContent = errorOrEmpty || '—';
      listEl.innerHTML = '<span class="settings-rank-preview-empty">' +
        (errorOrEmpty || '集計できません') + '</span>';
      return;
    }
    meta.textContent = '対象 ' + (counts.total || 0) + ' 人 (= 自チャンネル群でコメ済 listener)';
    var rows = [
      { id: 'first-time', label: '新規', n: counts.firstTime || 0, cls: 'label-first' },
      { id: 'returning', label: '新参', n: counts.returning || 0, cls: 'label-returning' },
      { id: 'regular', label: '常連', n: counts.regular || 0, cls: 'label-regular' },
      { id: 'veteran', label: '古参', n: counts.veteran || 0, cls: 'label-veteran' },
      { id: 'comeback', label: '復帰', n: counts.comeback || 0, cls: 'label-comeback' },
      { id: 'abandoned', label: '離脱', n: counts.abandoned || 0, cls: 'label-abandoned' },
    ];
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<span class="settings-rank-preview-chip ' + r.cls + '">' +
        '<span class="label">' + r.label + '</span>' +
        '<span class="count">' + r.n + ' 人</span></span>';
    }
    listEl.innerHTML = html;
  }

  // ランク一覧の動的変数 (X/Y/N/M) を現在の設定値で埋める。 ホットスポット 12 か所程度。
  // data-rank-var="x|y|n|m" を持つ span を一括で textContent 更新。
  function renderRankVars(x, y, n, m) {
    var els = document.querySelectorAll('.rank-var[data-rank-var]');
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute('data-rank-var');
      var v = '';
      if (key === 'x') v = String(x);
      else if (key === 'y') v = String(y);
      else if (key === 'n') v = String(n);
      else if (key === 'm') v = String(m);
      else v = els[i].textContent;
      els[i].textContent = v;
    }
  }

  // 視覚タイムライン: 初コメ時刻の軸上で 3 ゾーン (古参 / 常連 / 新参) を **対数スケール**
  // で描画。 線形だと X=5 / Y=60 のように小さい値だと右端に潰れて見えなかったので、
  // log(1+days) ベースで配置する。 max range は固定 3650 日 (= 10 年) で安定させる。
  // 軸: 左端 = 古い (= 10 年以上前)、 右端 = 最終枠 (= 0 日前 / NOW)。
  // X / Y の境界マーカーを「日数」ラベル付きで配置。 read-only (= 数値入力のフィードバック専用)。
  function renderRankTimeline(xDays, yDays) {
    var x = Math.max(1, xDays | 0);
    var y = Math.max(x + 1, yDays | 0);
    var MAX_DAYS = 3650; // 10 年固定。 これより古い first_seen_at は左端に張り付く扱い
    // log(1 + days) スケール。 右端 = 0 日前 = log(1) = 0、 左端 = log(1+3650) = max。
    // 位置 (右端から %) = log(1+days) / log(1+MAX_DAYS)
    var maxLog = Math.log(1 + MAX_DAYS);
    function posFromRight(days) {
      return Math.log(1 + days) / maxLog;
    }
    var xPosFromRight = posFromRight(x);       // X 日前の位置 (0..1、 右からの比率)
    var yPosFromRight = posFromRight(y);       // Y 日前の位置 (0..1)
    // 左端 = 100% from-right、 右端 = 0% from-right。
    // ゾーン (左 → 右):
    //   古参候補: 0 〜 (1 - yPosFromRight) 相当の width (= 一番左から Y まで)
    //   常連候補: yPosFromRight 〜 xPosFromRight 範囲の width
    //   新参:     xPosFromRight 〜 0 相当の width (= 一番右の細長部分)
    // width (left-to-right) を計算:
    var vetWidth = (1 - yPosFromRight) * 100;          // 0% 〜 (100% - yLeft%)
    var regWidth = (yPosFromRight - xPosFromRight) * 100;
    var retWidth = xPosFromRight * 100;
    var vetEl = document.getElementById('tl-zone-veteran');
    var regEl = document.getElementById('tl-zone-regular');
    var retEl = document.getElementById('tl-zone-returning');
    if (vetEl) vetEl.style.width = vetWidth.toFixed(2) + '%';
    if (regEl) regEl.style.width = regWidth.toFixed(2) + '%';
    if (retEl) retEl.style.width = retWidth.toFixed(2) + '%';
    // 境界マーカー (= 縦線) の left % を計算
    // 左端からの位置 = 100% - posFromRight * 100%
    var yLeftPct = (1 - yPosFromRight) * 100;
    var xLeftPct = (1 - xPosFromRight) * 100;
    var yMarker = document.getElementById('tl-marker-y');
    var xMarker = document.getElementById('tl-marker-x');
    if (yMarker) yMarker.style.left = yLeftPct.toFixed(2) + '%';
    if (xMarker) xMarker.style.left = xLeftPct.toFixed(2) + '%';
    // ラベル: 日数を表示
    var yLabel = document.getElementById('tl-marker-y-label');
    var xLabel = document.getElementById('tl-marker-x-label');
    if (yLabel) yLabel.textContent = y + ' 日前';
    if (xLabel) xLabel.textContent = x + ' 日前';
  }

  // プリセットボタンの active 状態を現在の値と比較して更新する。
  // プリセットの 4 値全てが一致した時だけ active クラスを付ける。
  function updateRankPresetActiveState() {
    var winEl = document.getElementById('settings-regular-window');
    var minEl = document.getElementById('settings-regular-min');
    var newEl = document.getElementById('settings-newcomer-days');
    var vetEl = document.getElementById('settings-veteran-days');
    if (!winEl || !minEl || !newEl || !vetEl) return;
    var cur = {
      x: parseInt(newEl.value, 10),
      y: parseInt(vetEl.value, 10),
      n: parseInt(winEl.value, 10),
      m: parseInt(minEl.value, 10),
    };
    var btns = document.querySelectorAll('.settings-rank-preset-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var match = (
        parseInt(b.dataset.x, 10) === cur.x &&
        parseInt(b.dataset.y, 10) === cur.y &&
        parseInt(b.dataset.n, 10) === cur.n &&
        parseInt(b.dataset.m, 10) === cur.m
      );
      b.classList.toggle('active', match);
    }
  }

  // Classification (活動チェック + 新参/古参 境界)
  if (api.getListenerClassificationConfig && api.setListenerClassificationConfig) {
    var winEl = document.getElementById('settings-regular-window');
    var minEl = document.getElementById('settings-regular-min');
    var newEl = document.getElementById('settings-newcomer-days');
    var vetEl = document.getElementById('settings-veteran-days');
    if (winEl && minEl && newEl && vetEl) {
      api.getListenerClassificationConfig().then(function (s) {
        winEl.value = s && s.regularStreamWindow ? s.regularStreamWindow : 10;
        minEl.value = s && s.regularMinStreams ? s.regularMinStreams : 3;
        newEl.value = s && s.newcomerFirstSeenDays ? s.newcomerFirstSeenDays : 30;
        vetEl.value = s && s.veteranFirstSeenDays ? s.veteranFirstSeenDays : 365;
        updateRankPresetActiveState();
        renderRankTimeline(parseInt(newEl.value, 10), parseInt(vetEl.value, 10));
        renderRankVars(
          parseInt(newEl.value, 10),
          parseInt(vetEl.value, 10),
          parseInt(winEl.value, 10),
          parseInt(minEl.value, 10)
        );
        refreshRankPreview();
      });
      var persist = function () {
        var w = Math.max(1, Math.min(100, parseInt(winEl.value, 10) || 10));
        var m = Math.max(1, Math.min(100, parseInt(minEl.value, 10) || 3));
        if (m > w) { m = w; minEl.value = m; }
        var n = Math.max(1, Math.min(3650, parseInt(newEl.value, 10) || 30));
        if (newEl.value && parseInt(newEl.value, 10) !== n) newEl.value = n;
        var v = Math.max(7, Math.min(3650, parseInt(vetEl.value, 10) || 365));
        if (vetEl.value && parseInt(vetEl.value, 10) !== v) vetEl.value = v;
        // newcomer < veteran を保証 (= サーバ側でも clamp + swap するが UI 側でも即時補正)
        if (n >= v) {
          n = Math.max(1, v - 1);
          newEl.value = n;
        }
        api.setListenerClassificationConfig({
          regularStreamWindow: w,
          regularMinStreams: m,
          newcomerFirstSeenDays: n,
          veteranFirstSeenDays: v
        });
        // JS 側 computeSystemTag のキャッシュも即時更新 → 配信詳細モーダル pill 等に反映される
        classificationCache.regularStreamWindow = w;
        classificationCache.regularMinStreams = m;
        classificationCache.newcomerFirstSeenDays = n;
        classificationCache.veteranFirstSeenDays = v;
        updateRankPresetActiveState();
        renderRankTimeline(n, v);
        renderRankVars(n, v, w, m);
        refreshRankPreview();
      };
      if (!winEl._inited) { winEl._inited = true; winEl.addEventListener('change', persist); }
      if (!minEl._inited) { minEl._inited = true; minEl.addEventListener('change', persist); }
      if (!newEl._inited) { newEl._inited = true; newEl.addEventListener('change', persist); }
      if (!vetEl._inited) { vetEl._inited = true; vetEl.addEventListener('change', persist); }

      // プリセットボタン (= ゆるめ / 標準 / 厳しめ) のハンドラ
      var presetBtns = document.querySelectorAll('.settings-rank-preset-btn');
      for (var pi = 0; pi < presetBtns.length; pi++) {
        var btn = presetBtns[pi];
        if (btn._inited) continue;
        btn._inited = true;
        btn.addEventListener('click', function () {
          var b = this;
          newEl.value = b.dataset.x;
          vetEl.value = b.dataset.y;
          winEl.value = b.dataset.n;
          minEl.value = b.dataset.m;
          // persist 経由で保存 + クランプ + active state 更新
          persist();
        });
      }
    }
  }

  // Auto sync
  if (api.listeners && api.listeners.getAutoSyncSettings) {
    var imp = document.getElementById('settings-auto-import');
    var exp = document.getElementById('settings-auto-export');
    if (imp && exp) {
      api.listeners.getAutoSyncSettings().then(function (s) {
        imp.checked = !!(s && s.autoImportOnStart);
        exp.checked = !!(s && s.autoExportEnabled);
      });
      var persistSync = function () {
        api.listeners.setAutoSyncSettings({
          autoImportOnStart: imp.checked,
          autoExportEnabled: exp.checked
        });
      };
      if (!imp._inited) { imp._inited = true; imp.addEventListener('change', persistSync); }
      if (!exp._inited) { exp._inited = true; exp.addEventListener('change', persistSync); }
    }
  }

  var banBtn = document.getElementById('settings-ban-open');
  if (banBtn && !banBtn._inited) {
    banBtn._inited = true;
    banBtn.addEventListener('click', function () { showBanList(); });
  }
}

// === Display / 言語 ===
var _settingsLangInited = false;
function initSettingsDisplay() {
  if (_settingsLangInited) return;
  _settingsLangInited = true;
  var sel = document.getElementById('settings-lang-select');
  if (!sel) return;
  i18nSupported.forEach(function (lang) {
    var opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = LANG_NAMES[lang] || lang;
    if (lang === i18nLang) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', function () {
    window.api.setLanguage(sel.value).then(function (data) {
      i18nData = data.translations;
      i18nLang = data.lang;
      applyStaticTexts();
    });
  });
}

// === Scene & Effects ===
function initSettingsScene() {
  var importBtn = document.getElementById('settings-scene-import');
  if (importBtn && !importBtn._inited) {
    importBtn._inited = true;
    importBtn.addEventListener('click', function () {
      importSceneFromFile().then(function (result) {
        if (result && result.ok && result.sceneId) closeSettings();
      });
    });
  }
  var exportBtn = document.getElementById('settings-scene-export');
  if (exportBtn && !exportBtn._inited) {
    exportBtn._inited = true;
    exportBtn.addEventListener('click', exportCurrentSceneToFile);
  }
  refreshSettingsEffectList();
  var effImport = document.getElementById('settings-eff-import');
  if (effImport && !effImport._inited) {
    effImport._inited = true;
    effImport.addEventListener('click', function () {
      rendererLog.info('user: effect-import (settings-modal)');
      api.importEffect().then(function (result) {
        if (!result || result.cancelled) return;
        if (result.needsUpgrade && result.upgradeInfo) {
          var info = result.upgradeInfo;
          var msg = 'エフェクト「' + info.effectName + '」を v' + info.currentVersion + ' → v' + info.newVersion + ' にアップグレードしますか？\n\n現在の設定は自動バックアップされます。';
          showPromptDialog(msg, null, function (ok) {
            if (!ok) return;
            api.confirmUpgradeEffect(result.zipPath, info.effectId).then(function (upgradeResult) {
              if (upgradeResult && upgradeResult.upgraded) {
                refreshSettingsEffectList();
              } else {
                showAlertDialog('アップグレードに失敗しました: ' + (upgradeResult && upgradeResult.error || '不明なエラー'));
              }
            }).catch(function () { showAlertDialog('アップグレードに失敗しました。'); });
          });
          return;
        }
        if (!result.ok) {
          showZipActionError(result, 'エフェクトのインポートに失敗しました。');
          return;
        }
        if (result.effectId) {
          refreshSettingsEffectList();
        }
      });
    });
  }
}

function refreshSettingsEffectList() {
  var list = document.getElementById('settings-eff-list');
  var detail = document.getElementById('settings-eff-detail');
  if (!list) return;
  if (detail) { detail.setAttribute('hidden', ''); list.removeAttribute('hidden'); }
  list.innerHTML = '';
  api.getEffects().then(function (effects) {
    effects.forEach(function (eff) {
      var row = document.createElement('div');
      row.className = 'settings-list-row';
      var icon = document.createElement('span');
      icon.className = 'settings-list-icon';
      icon.appendChild(createEffectIconEl(eff.icon, 16));
      var info = document.createElement('div');
      info.className = 'settings-list-info';
      var name = document.createElement('div');
      name.className = 'settings-list-name';
      name.textContent = eff.name;
      var sub = document.createElement('div');
      sub.className = 'settings-list-sub';
      sub.textContent = eff.id + ' v' + (eff.version || '?');
      info.appendChild(name);
      info.appendChild(sub);
      var badge = document.createElement('span');
      var badgeCls = eff.broken ? 'settings-list-badge-broken'
        : eff.builtin ? 'settings-list-badge-builtin'
          : 'settings-list-badge-custom';
      badge.className = 'settings-list-badge ' + badgeCls;
      badge.textContent = eff.broken ? '破損' : eff.builtin ? '公式' : 'カスタム';
      var chev = document.createElement('span');
      chev.className = 'settings-list-chevron';
      chev.textContent = '›';
      row.appendChild(icon);
      row.appendChild(info);
      row.appendChild(badge);
      row.appendChild(chev);
      row.addEventListener('click', function () { showSettingsEffectDetail(eff); });
      list.appendChild(row);
    });
  });
}

function showSettingsEffectDetail(eff) {
  var list = document.getElementById('settings-eff-list');
  var detail = document.getElementById('settings-eff-detail');
  if (!list || !detail) return;
  list.setAttribute('hidden', '');
  detail.removeAttribute('hidden');
  detail.innerHTML = '';

  var head = document.createElement('div');
  head.className = 'settings-detail-head';
  var back = document.createElement('button');
  back.type = 'button';
  back.className = 'settings-detail-back';
  back.textContent = '‹';
  back.title = '一覧に戻る';
  back.addEventListener('click', function () {
    detail.setAttribute('hidden', '');
    list.removeAttribute('hidden');
  });
  var title = document.createElement('div');
  title.className = 'settings-detail-title';
  title.appendChild(createEffectIconEl(eff.icon, 18));
  title.appendChild(document.createTextNode(' ' + eff.name));
  head.appendChild(back);
  head.appendChild(title);
  detail.appendChild(head);

  var fields = [
    { label: 'ID', value: eff.id },
    { label: 'バージョン', value: eff.version || '不明' },
    { label: '種別', value: eff.broken ? '破損' : eff.builtin ? '公式（ビルトイン）' : 'カスタム' }
  ];
  fields.forEach(function (f) {
    var row = document.createElement('div');
    row.className = 'settings-detail-row';
    var lbl = document.createElement('div');
    lbl.className = 'settings-detail-label';
    lbl.textContent = f.label;
    var val = document.createElement('div');
    val.className = 'settings-detail-value';
    val.textContent = f.value;
    row.appendChild(lbl);
    row.appendChild(val);
    detail.appendChild(row);
  });

  if (eff.params) {
    var pSection = document.createElement('div');
    pSection.style.marginTop = '12px';
    var pLabel = document.createElement('div');
    pLabel.className = 'settings-row-meta-text';
    pLabel.style.marginBottom = '4px';
    pLabel.textContent = 'デフォルトパラメータ';
    var pre = document.createElement('pre');
    pre.className = 'settings-detail-pre';
    pre.textContent = JSON.stringify(eff.params, null, 2);
    pSection.appendChild(pLabel);
    pSection.appendChild(pre);
    detail.appendChild(pSection);
  }

  if (eff.broken) {
    var warn = document.createElement('div');
    warn.className = 'settings-detail-warn';
    warn.style.marginTop = '12px';
    warn.textContent = 'プラグインファイルが見つかりません。このエフェクトは正常に動作しません。';
    detail.appendChild(warn);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'settings-btn settings-btn-danger settings-btn-block';
    delBtn.style.marginTop = '12px';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', function () {
      showPromptDialog('「' + eff.name + '」を削除しますか？', null, function (ok) {
        if (!ok) return;
        api.removeEffect(eff.id).then(function () { refreshSettingsEffectList(); });
      });
    });
    detail.appendChild(delBtn);
  } else {
    var expBtn = document.createElement('button');
    expBtn.type = 'button';
    expBtn.className = 'settings-btn settings-btn-primary settings-btn-block';
    expBtn.style.marginTop = '12px';
    expBtn.textContent = 'エクスポート';
    expBtn.addEventListener('click', function () {
      rendererLog.info('user: effect-export (settings-modal), effectId=' + eff.id);
      api.exportEffect(eff.id, eff.name).then(function (result) {
        if (!result || result.ok || result.cancelled) return;
        showZipActionError(result, 'エフェクトのエクスポートに失敗しました。');
      });
    });
    detail.appendChild(expBtn);
  }
}

// === Data & Backup ===
function initSettingsData() {
  // io-section は静的配置なので、io-* ハンドラ (= 既存) は別途 wire 済 → 何もしない
  // バックアップ管理だけ wire
  var dirPath = document.getElementById('settings-bk-dir-path');
  var dirChange = document.getElementById('settings-bk-dir-change');
  var dirReset = document.getElementById('settings-bk-dir-reset');
  var createBtn = document.getElementById('settings-bk-create');

  if (dirPath) {
    dirPath.textContent = '読み込み中...';
    api.getBackupsDir().then(function (customDir) {
      if (customDir) { dirPath.textContent = customDir; if (dirReset) dirReset.removeAttribute('hidden'); }
      else { dirPath.textContent = '(デフォルト)'; if (dirReset) dirReset.setAttribute('hidden', ''); }
    }).catch(function () { dirPath.textContent = '(取得失敗)'; });
  }
  if (dirChange && !dirChange._inited) {
    dirChange._inited = true;
    dirChange.addEventListener('click', function () {
      api.setBackupsDir().then(function (newDir) {
        if (newDir && dirPath) {
          dirPath.textContent = newDir;
          if (dirReset) dirReset.removeAttribute('hidden');
          renderSettingsBackupList();
        }
      }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
    });
  }
  if (dirReset && !dirReset._inited) {
    dirReset._inited = true;
    dirReset.addEventListener('click', function () {
      api.resetBackupsDir().then(function () {
        if (dirPath) dirPath.textContent = '(デフォルト)';
        dirReset.setAttribute('hidden', '');
        renderSettingsBackupList();
      }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
    });
  }
  if (createBtn && !createBtn._inited) {
    createBtn._inited = true;
    createBtn.addEventListener('click', function () {
      createBtn.disabled = true;
      var origText = createBtn.textContent;
      var dlg = showBackupProgressDialog('フルバックアップを作成中');
      api.createFullBackup('手動バックアップ').then(function (result) {
        if (result && typeof result === 'object' && result.error) {
          dlg.close();
          createBtn.disabled = false;
          createBtn.textContent = origText;
          showAlertDialog(result.error);
          return;
        }
        dlg.update('done', 100);
        setTimeout(function () {
          dlg.close();
          createBtn.disabled = false;
          createBtn.textContent = origText;
          renderSettingsBackupList();
          // 完了モーダル (= ユーザーが OK を押すまで残す)。
          // 自動 close だと、 ユーザーが目を離した間に 100% 到達 → close で
          // 「いつの間にか消えた = 失敗した?」 の誤認を生むので明示通知に変更
          showAlertDialog('バックアップを作成しました');
        }, 400);
      }).catch(function () {
        dlg.close();
        createBtn.disabled = false;
        createBtn.textContent = origText;
        showAlertDialog('バックアップの作成に失敗しました。');
      });
    });
  }
  renderSettingsBackupList();
}

var SETTINGS_BK_TYPE_LABELS = {
  'full': { text: 'フル', cls: 'settings-list-badge-full' },
  'scene': { text: 'シーン', cls: 'settings-list-badge-scene' },
  'effect': { text: 'エフェクト', cls: 'settings-list-badge-effect' },
  'plugin': { text: 'プラグイン', cls: 'settings-list-badge-plugin' },
  'auto-upgrade': { text: '自動', cls: 'settings-list-badge-auto-upgrade' }
};

function renderSettingsBackupList() {
  var listEl = document.getElementById('settings-bk-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  api.getBackupList().catch(function () { return []; }).then(function (backups) {
    if (!backups || backups.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'settings-list-empty';
      empty.textContent = 'バックアップはありません';
      listEl.appendChild(empty);
      return;
    }
    backups.forEach(function (bk) {
      var row = document.createElement('div');
      row.className = 'settings-list-row settings-list-row-static';
      var info = document.createElement('div');
      info.className = 'settings-list-info';
      var name = document.createElement('div');
      name.className = 'settings-list-name';
      name.textContent = bk.name || bk.id;
      var date = document.createElement('div');
      date.className = 'settings-list-sub';
      date.textContent = new Date(bk.createdAt).toLocaleString();
      info.appendChild(name);
      info.appendChild(date);
      var typeInfo = SETTINGS_BK_TYPE_LABELS[bk.type] || SETTINGS_BK_TYPE_LABELS['full'];
      var badge = document.createElement('span');
      badge.className = 'settings-list-badge ' + typeInfo.cls;
      badge.textContent = typeInfo.text;
      var restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'settings-list-action settings-list-action-restore';
      restoreBtn.textContent = '復元';
      restoreBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        showPromptDialog('「' + (bk.name || bk.id) + '」からリストアしますか？\n現在のデータは上書きされます。', null, function (ok) {
          if (!ok) return;
          // 2 段目: 既存データの規模を確認して強めの警告を出す。
          // Rust 側で listeners.db に SELECT COUNT(*) を実行し、 コメント or リスナーが 1 件でも
          // あれば「データあり」 と判定。 クリーン状態 (= 0 件) なら 2 段目スキップ。
          var proceedToRestore = function () {
          var origText = restoreBtn.textContent;
          restoreBtn.disabled = true;
          // 復元の進捗は前半 (= tar streaming = restore phase 4-50%) + 後半 (= migrate phase
          // 50-95% + reopen → done 100%) の 2 段で SSE が流れてくる。 dialog の close は
          // SSE 'done' 100% で行う (= reply restored:true は migration 前に返るため)。
          var dlg = showBackupProgressDialog('リストア中', {
            onComplete: function () {
              setTimeout(function () {
                dlg.close();
                restoreBtn.disabled = false;
                restoreBtn.textContent = origText;
                // 復元成功 → renderer の全 state (= scenes / ownerChannels / 自チャ警告 /
                // KPI 等) をフレッシュにするため、 アラート OK で画面リロード。
                showAlertDialog('リストアが完了しました。', function () {
                  window.location.reload();
                });
              }, 400);
            }
          });
          rendererLog.info('user: backup-restore, backupId=' + bk.id + ', type=' + (bk.type || 'unknown') + ', label=' + (bk.label || ''));
          dlg.update('start', 0);
          api.restoreBackup(bk.id).then(function (result) {
            if (!result || !result.restored) {
              // 失敗時は SSE done を待たずに即時 close + エラーモーダル
              dlg.close();
              restoreBtn.disabled = false;
              restoreBtn.textContent = origText;
              showAlertDialog('リストアに失敗しました: ' + (result && result.error || '不明なエラー'));
            }
            // 成功時は SSE done 100% で onComplete が発火するので、 ここでは何もしない
          }).catch(function () {
            dlg.close();
            restoreBtn.disabled = false;
            restoreBtn.textContent = origText;
            showAlertDialog('リストアに失敗しました。');
          });
          }; // proceedToRestore 閉じ

          // 既存データの規模で 2 段目警告の出し分け
          var overviewCheck = api.getDataOverview
            ? api.getDataOverview()
            : Promise.resolve({ commentsCount: 0, listenersCount: 0 });
          var fallbackWarning =
            '【最終確認: データは全て上書きされます】\n\n' +
            '現在のハブのデータは、 全てバックアップ作成時点の内容に置き換わります。\n\n' +
            '・現在のデータは保持されません\n' +
            '・この操作は取り消せません (= ロールバックは復元失敗時のみ自動実行)\n\n' +
            '本当に実行しますか？';
          overviewCheck.then(function (stats) {
            var c = (stats && stats.commentsCount) || 0;
            var l = (stats && stats.listenersCount) || 0;
            var hasData = c > 0 || l > 0;
            if (!hasData) {
              proceedToRestore();
              return;
            }
            var detail = [
              '【最終確認: データは全て上書きされます】',
              '',
              '現在のハブには以下のデータが存在します:',
              '  ・コメント: ' + c.toLocaleString() + ' 件',
              '  ・リスナー: ' + l.toLocaleString() + ' 人',
              '',
              'リストアを実行すると、 これらは全てバックアップ作成時点の内容に置き換わります。',
              '',
              '・現在のデータは保持されません',
              '・この操作は取り消せません (= ロールバックは復元失敗時のみ自動実行)',
              '',
              '本当に実行しますか？'
            ].join('\n');
            showPromptDialog(detail, null, function (ok2) {
              if (!ok2) return;
              proceedToRestore();
            });
          }).catch(function () {
            // 取得失敗時は安全側 (= 警告を出してから)
            showPromptDialog(fallbackWarning, null, function (ok2) {
              if (!ok2) return;
              proceedToRestore();
            });
          });
        });
      });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'settings-list-action settings-list-action-delete';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        showPromptDialog('このバックアップを削除しますか？', null, function (ok) {
          if (!ok) return;
          rendererLog.info('user: backup-delete, backupId=' + bk.id);
          api.deleteBackup(bk.id).then(function (result) {
            if (!result) showAlertDialog('バックアップの削除に失敗しました。');
            renderSettingsBackupList();
          }).catch(function () { showAlertDialog('バックアップの削除に失敗しました。'); });
        });
      });
      row.appendChild(info);
      row.appendChild(badge);
      row.appendChild(restoreBtn);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  });
}

// === Advanced ===
// === デバッグ・サポート (= デバッグログ ON/OFF) ===
// 詳細仕様: docs/logging.md。 正本は Rust AppConfig.debug_logging_enabled、 反映は再起動。
function initSettingsDebug() {
  var toggleBtn = document.getElementById('settings-debug-toggle');
  if (!toggleBtn || toggleBtn._inited) return;
  toggleBtn._inited = true;

  function applyVisual(v) {
    toggleBtn.className = 'u-btn' + (v ? ' on' : '');
    toggleBtn.textContent = v ? 'ON' : 'OFF';
    toggleBtn.disabled = false;
  }

  var current = false;
  api.getDebugLoggingEnabled().then(function (enabled) {
    current = !!enabled;
    applyVisual(current);
  }).catch(function () {
    toggleBtn.textContent = 'ERR';
  });

  toggleBtn.addEventListener('click', function () {
    if (toggleBtn.disabled) return;
    var next = !current;
    toggleBtn.disabled = true;
    api.setDebugLoggingEnabled(next).then(function (ok) {
      if (ok) {
        current = next;
        applyVisual(current);
        rendererLog.info('user: settings-debug-logging-toggle, enabled=' + current);
        showAlertDialog(
          'デバッグログを ' + (current ? 'ON' : 'OFF') + ' にしました。\n\n' +
          'ハブを再起動するとログレベルが反映されます。'
        );
      } else {
        applyVisual(current);
        showAlertDialog('設定の保存に失敗しました');
      }
    }).catch(function () {
      applyVisual(current);
      showAlertDialog('設定の保存に失敗しました');
    });
  });
}

function initSettingsAdvanced() {
  // 設定 / データ / 完全 の 3 種リセット。kind は main.js の reset-app に渡す。
  // typeConfirm を持つもの (= データ / 完全) は確認文字列の入力を必須にする。
  var RESET_DEFS = [
    {
      id: 'settings-reset-settings', kind: 'settings', label: '設定をリセット',
      confirm: '設定・シーン・演出・テンプレートを初期状態に戻します。\nリスナー履歴・バックアップ・ログインは保持されます。\n実行前にローカル退避を作成し、アプリを再起動します。\n\n続行しますか？',
      typeConfirm: null
    },
    {
      id: 'settings-reset-data', kind: 'data', label: 'データをリセット',
      confirm: 'リスナー履歴・コメント・タグ・キャッシュ画像を削除します。\n設定・バックアップ・ログインは保持されます。\n実行前にローカル退避を作成し、アプリを再起動します。\n\n削除したデータは元に戻せません（退避からの復元は手動）。続行しますか？',
      typeConfirm: { keyword: '削除する', prompt: '確認のため「削除する」と入力してください。' }
    },
    {
      id: 'settings-reset-all', kind: 'all', label: '完全に初期化',
      confirm: 'すべて（設定・データ・バックアップ・ログイン状態）を工場出荷状態に戻します。\n実行前にローカル退避を作成し、アプリを再起動します。\n\n続行しますか？',
      typeConfirm: { keyword: '初期化する', prompt: '確認のため「初期化する」と入力してください。' }
    }
  ];

  RESET_DEFS.forEach(function (def) {
    var btn = document.getElementById(def.id);
    if (!btn || btn._inited) return;
    btn._inited = true;

    function proceed() {
      rendererLog.info('user: app-reset, kind=' + def.kind);
      var orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '退避を作成して初期化中...';
      closeSettings();
      showResetAllSettingsProgress(def.label + 'を準備しています');
      api.resetApp(def.kind).then(function (result) {
        if (result && result.ok) {
          var progress = document.getElementById('reset-all-settings-overlay');
          if (progress) {
            var body = document.getElementById('reset-all-settings-progress-body');
            if (body) body.textContent = '退避を作成しました。アプリを再起動しています。このままお待ちください。';
          }
        } else {
          var failed = document.getElementById('reset-all-settings-overlay');
          if (failed) failed.remove();
          openSettings('advanced');
          btn.disabled = false;
          btn.textContent = orig;
          showAlertDialog('リセットに失敗しました。');
        }
      }).catch(function (err) {
        var p = document.getElementById('reset-all-settings-overlay');
        if (p) p.remove();
        openSettings('advanced');
        btn.disabled = false;
        btn.textContent = orig;
        showAlertDialog('リセットに失敗しました: ' + (err && err.message ? err.message : err));
      });
    }

    btn.addEventListener('click', function () {
      showPromptDialog(def.confirm, null, function (ok) {
        if (!ok) return;
        if (def.typeConfirm) {
          showPromptDialog(def.typeConfirm.prompt, '', function (value) {
            if (value !== def.typeConfirm.keyword) {
              showAlertDialog('入力が一致しなかったため、中止しました。');
              return;
            }
            proceed();
          });
        } else {
          proceed();
        }
      });
    });
  });
}

// === 旧 API 後方互換 (= showAppSettings(sectionName?) は openSettings に転送) ===
function showAppSettings(sectionName) { openSettings(sectionName); }


// === テストセットアップダイアログ ===
var TEMPLATE_TEST_AVATAR_SVGS = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#8b5cf6"/>' +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="48" fill="url(#g1)"/>' +
    '<circle cx="48" cy="38" r="18" fill="#e0f2fe"/>' +
    '<path d="M20 84c4-16 17-26 28-26s24 10 28 26" fill="#e0f2fe"/>' +
  '</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#ef4444"/>' +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="48" fill="url(#g2)"/>' +
    '<circle cx="48" cy="40" r="18" fill="#fff7ed"/>' +
    '<path d="M22 84c5-15 16-24 26-24s21 9 26 24" fill="#fff7ed"/>' +
    '<path d="M28 30c4-10 14-16 20-16s16 6 20 16c-8-3-12-4-20-4s-12 1-20 4" fill="#7c2d12"/>' +
  '</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g3" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#14b8a6"/>' +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="48" fill="url(#g3)"/>' +
    '<circle cx="48" cy="38" r="17" fill="#ecfeff"/>' +
    '<path d="M18 84c6-16 18-25 30-25s24 9 30 25" fill="#ecfeff"/>' +
    '<rect x="28" y="28" width="40" height="10" rx="5" fill="#083344"/>' +
    '<rect x="24" y="37" width="16" height="6" rx="3" fill="#083344"/>' +
    '<rect x="56" y="37" width="16" height="6" rx="3" fill="#083344"/>' +
  '</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g4" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#f472b6"/><stop offset="100%" stop-color="#a855f7"/>' +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="48" fill="url(#g4)"/>' +
    '<circle cx="48" cy="40" r="18" fill="#fdf2f8"/>' +
    '<path d="M20 84c4-17 17-27 28-27s24 10 28 27" fill="#fdf2f8"/>' +
    '<circle cx="34" cy="26" r="6" fill="#ffffff"/>' +
    '<circle cx="62" cy="26" r="6" fill="#ffffff"/>' +
    '<path d="M28 28c5-8 11-12 20-12s15 4 20 12c-9-2-14-3-20-3s-11 1-20 3" fill="#701a75"/>' +
  '</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g5" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#0f172a"/>' +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="48" fill="url(#g5)"/>' +
    '<circle cx="48" cy="39" r="18" fill="#eff6ff"/>' +
    '<path d="M20 84c6-16 17-25 28-25s22 9 28 25" fill="#eff6ff"/>' +
    '<path d="M26 33c5-11 14-17 22-17s17 6 22 17l-8 1c-2-5-7-9-14-9s-12 4-14 9z" fill="#1e293b"/>' +
    '<rect x="34" y="52" width="28" height="6" rx="3" fill="#93c5fd"/>' +
  '</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g6" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#eab308"/>' +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="48" fill="url(#g6)"/>' +
    '<circle cx="48" cy="40" r="18" fill="#f7fee7"/>' +
    '<path d="M20 84c5-16 17-25 28-25s23 9 28 25" fill="#f7fee7"/>' +
    '<path d="M26 31c7-9 14-13 22-13s15 4 22 13l-5 6c-6-4-11-6-17-6s-11 2-17 6z" fill="#365314"/>' +
    '<circle cx="66" cy="62" r="8" fill="#fef08a"/>' +
  '</svg>'
];

function buildTemplateTestProfileImage(seed) {
  var key = String(seed || 'template-test-avatar');
  var hash = 0;
  for (var i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  var svg = TEMPLATE_TEST_AVATAR_SVGS[Math.abs(hash) % TEMPLATE_TEST_AVATAR_SVGS.length];
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function resolveTemplateTestProfileImage(context) {
  if (context && context.profileImage) return context.profileImage;
  var seed = [
    context && context.userName ? context.userName : '',
    context && context.comment ? context.comment : '',
    context && context.amount ? context.amount : 0,
    context && context.giftCount ? context.giftCount : 0,
    context && context.isMembership ? 'membership' : '',
    context && context.isMembershipGift ? 'gift' : ''
  ].join('|');
  return buildTemplateTestProfileImage(seed);
}

var TEST_TEMPLATES = [
  { label: '通常コメント', ctx: { userName: 'リスナーさん', comment: 'こんばんは〜！' } },
  { label: 'メンバーコメント', ctx: { userName: 'メンバーさん', comment: '今日も配信ありがとう！', isMember: true, memberMonths: 6 } },
  { label: 'スパチャ ¥100（青）', ctx: { userName: 'ゲストA', comment: 'がんばれ〜', amount: 100 } },
  { label: 'スパチャ ¥200（ティール）', ctx: { userName: '応援隊B', comment: 'ないす〜！', amount: 200 } },
  { label: 'スパチャ ¥500（緑）', ctx: { userName: '抹茶ラテ', comment: 'いつも助かる！', amount: 500 } },
  { label: 'スパチャ ¥1,000（黄）', ctx: { userName: '常連さん', comment: '最高の配信！', amount: 1000 } },
  { label: 'スパチャ ¥2,000（オレンジ）', ctx: { userName: '夕焼けノート', comment: 'この演出好きです', amount: 2000 } },
  { label: 'スパチャ ¥5,000（マゼンタ）', ctx: { userName: '推し活ガチ勢', comment: '推しが最高すぎる', amount: 5000 } },
  { label: 'スパチャ ¥10,000（赤）', ctx: { userName: '大スポンサー', comment: '記念日おめでとう！', amount: 10000 } },
  { label: 'メンバー加入', ctx: { userName: '新メンバー', isMembership: true, membershipHeader: 'メンバーになりました' } },
  { label: 'ギフト（5人）', ctx: { userName: '太っ腹さん', isMembershipGift: true, giftCount: 5 } },
  { label: 'ギフト（50人）', ctx: { userName: '大太っ腹さん', isMembershipGift: true, giftCount: 50 } }
];

var REACTION_OPTIONS = [
  { key: 'heart', emoji: '❤', label: 'ハート' },
  { key: 'smile', emoji: '😄', label: 'スマイル' },
  { key: 'celebration', emoji: '🎉', label: 'お祝い' },
  { key: 'surprise', emoji: '😮', label: '驚き' },
  { key: 'hundred', emoji: '💯', label: '100点' }
];

function showTestSetupDialog(testBtn, perf, updateTestBtnLabel, isReactionTrigger) {
  var existing = document.getElementById('test-setup-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'test-setup-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;width:420px;max-height:80vh;overflow-y:auto;color:#e2e8f0;font-size:13px;';

  var titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:15px;font-weight:bold;margin-bottom:16px;color:#f1f5f9;';
  titleEl.textContent = 'テストボタン設定';
  dialog.appendChild(titleEl);

  // モード選択
  var modeLabel = document.createElement('div');
  modeLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:6px;';
  modeLabel.textContent = 'モード';
  dialog.appendChild(modeLabel);

  var modes = isReactionTrigger ? [
    { key: 'force', label: '強制発火（通常）' },
    { key: 'tier', label: 'エモーション巡回' },
    { key: 'custom', label: 'カスタム' }
  ] : [
    { key: 'force', label: '強制発火（通常）' },
    { key: 'tier', label: 'Tier巡回' },
    { key: 'custom', label: 'カスタム' }
  ];
  var modeGroup = document.createElement('div');
  modeGroup.style.cssText = 'display:flex;gap:6px;margin-bottom:16px;';
  var currentMode = testBtn._testMode;
  var customArea = null;

  modes.forEach(function (m) {
    var btn = document.createElement('button');
    btn.style.cssText = 'flex:1;padding:8px;border-radius:6px;border:1px solid #475569;font-size:12px;cursor:pointer;' +
      (currentMode === m.key ? 'background:#0ea5e9;color:#fff;border-color:#0ea5e9;' : 'background:#0f172a;color:#94a3b8;');
    btn.textContent = m.label;
    btn.addEventListener('click', function () {
      currentMode = m.key;
      Array.from(modeGroup.children).forEach(function (b, i) {
        var active = modes[i].key === currentMode;
        b.style.background = active ? '#0ea5e9' : '#0f172a';
        b.style.color = active ? '#fff' : '#94a3b8';
        b.style.borderColor = active ? '#0ea5e9' : '#475569';
      });
      if (customArea) customArea.style.display = currentMode === 'custom' ? 'block' : 'none';
    });
    modeGroup.appendChild(btn);
  });
  dialog.appendChild(modeGroup);

  // カスタムエリア
  customArea = document.createElement('div');
  customArea.style.cssText = 'display:' + (currentMode === 'custom' ? 'block' : 'none') + ';';

  var selectedReaction = testBtn._customReaction || 'heart';
  var readContext = null;

  if (isReactionTrigger) {
    // リアクション: エモーション選択UI
    var reactionLabel = document.createElement('div');
    reactionLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:8px;';
    reactionLabel.textContent = 'テストするエモーションを選択';
    customArea.appendChild(reactionLabel);

    var configuredTypes = (perf.trigger && perf.trigger.reactionTypes) || ['heart', 'smile', 'celebration', 'surprise', 'hundred'];

    var reactionGroup = document.createElement('div');
    reactionGroup.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    var reactionBtns = [];
    REACTION_OPTIONS.forEach(function (r) {
      var isConfigured = configuredTypes.indexOf(r.key) !== -1;
      var btn = document.createElement('button');
      var isActive = r.key === selectedReaction;
      btn.style.cssText = 'padding:10px 14px;border-radius:8px;border:2px solid ' + (isActive ? '#0ea5e9' : '#475569') + ';font-size:18px;cursor:pointer;' +
        'background:' + (isActive ? '#0c4a6e' : '#0f172a') + ';' +
        (isConfigured ? '' : 'opacity:0.4;');
      btn.textContent = r.emoji;
      btn.title = r.label + (isConfigured ? '' : '（無効）');
      btn.addEventListener('click', function () {
        selectedReaction = r.key;
        reactionBtns.forEach(function (b, i) {
          var active = REACTION_OPTIONS[i].key === selectedReaction;
          b.style.borderColor = active ? '#0ea5e9' : '#475569';
          b.style.background = active ? '#0c4a6e' : '#0f172a';
        });
      });
      reactionBtns.push(btn);
      reactionGroup.appendChild(btn);
    });
    customArea.appendChild(reactionGroup);
  } else {
    // コメント系: フォーム入力UI
    var templateLabel = document.createElement('div');
    templateLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:6px;';
    templateLabel.textContent = 'テンプレート（クリックで入力欄に反映）';
    customArea.appendChild(templateLabel);

    var templateRow = document.createElement('div');
    templateRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:14px;';

    var fieldInputStyle = 'width:100%;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:12px;padding:5px 8px;box-sizing:border-box;';
    var fieldLabelStyle = 'font-size:11px;color:#94a3b8;margin-bottom:2px;';
    var fieldRowStyle = 'margin-bottom:8px;';
    var halfRowStyle = 'display:flex;gap:8px;margin-bottom:8px;';

    var fields = {};
    function makeTextField(key, label, placeholder) {
      var row = document.createElement('div');
      row.style.cssText = fieldRowStyle;
      var lbl = document.createElement('div');
      lbl.style.cssText = fieldLabelStyle;
      lbl.textContent = label;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.style.cssText = fieldInputStyle;
      inp.placeholder = placeholder || '';
      row.appendChild(lbl);
      row.appendChild(inp);
      fields[key] = inp;
      return row;
    }
    function makeNumberField(key, label, placeholder) {
      var row = document.createElement('div');
      row.style.cssText = 'flex:1;';
      var lbl = document.createElement('div');
      lbl.style.cssText = fieldLabelStyle;
      lbl.textContent = label;
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.style.cssText = fieldInputStyle;
      inp.placeholder = placeholder || '0';
      row.appendChild(lbl);
      row.appendChild(inp);
      fields[key] = inp;
      return row;
    }
    function makeCheckField(key, label) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.style.cssText = 'accent-color:#0ea5e9;';
      var span = document.createElement('span');
      span.style.cssText = 'font-size:11px;color:#94a3b8;';
      span.textContent = label;
      row.appendChild(inp);
      row.appendChild(span);
      fields[key] = inp;
      return row;
    }

    customArea.appendChild(makeTextField('userName', 'ユーザー名', 'テストユーザー'));
    customArea.appendChild(makeTextField('comment', 'コメント', 'テストコメント'));

    var numRow = document.createElement('div');
    numRow.style.cssText = halfRowStyle;
    numRow.appendChild(makeNumberField('amount', 'スパチャ金額', '0'));
    numRow.appendChild(makeNumberField('memberMonths', 'メンバー月数', '0'));
    customArea.appendChild(numRow);

    var numRow2 = document.createElement('div');
    numRow2.style.cssText = halfRowStyle;
    numRow2.appendChild(makeNumberField('giftCount', 'ギフト個数', '0'));
    var currRow = document.createElement('div');
    currRow.style.cssText = 'flex:1;';
    var currLbl = document.createElement('div');
    currLbl.style.cssText = fieldLabelStyle;
    currLbl.textContent = '通貨';
    var currInp = document.createElement('input');
    currInp.type = 'text';
    currInp.style.cssText = fieldInputStyle;
    currInp.placeholder = '¥';
    currInp.value = '¥';
    currRow.appendChild(currLbl);
    currRow.appendChild(currInp);
    fields.currency = currInp;
    numRow2.appendChild(currRow);
    customArea.appendChild(numRow2);

    customArea.appendChild(makeTextField('membershipHeader', 'メンバーシップヘッダー', 'メンバーになりました'));

    var checkRow = document.createElement('div');
    checkRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;margin-top:4px;';
    checkRow.appendChild(makeCheckField('isMember', 'メンバー'));
    checkRow.appendChild(makeCheckField('isMembership', 'メンバー加入'));
    checkRow.appendChild(makeCheckField('isMembershipGift', 'ギフト'));
    customArea.appendChild(checkRow);

    function applyContext(ctx) {
      fields.userName.value = ctx.userName || '';
      fields.comment.value = ctx.comment || '';
      fields.amount.value = ctx.amount || '';
      fields.memberMonths.value = ctx.memberMonths || '';
      fields.giftCount.value = ctx.giftCount || '';
      fields.currency.value = ctx.currency || '¥';
      fields.membershipHeader.value = ctx.membershipHeader || '';
      fields.isMember.checked = !!ctx.isMember;
      fields.isMembership.checked = !!ctx.isMembership;
      fields.isMembershipGift.checked = !!ctx.isMembershipGift;
    }
    readContext = function () {
      return {
        userName: fields.userName.value || 'テストユーザー',
        comment: fields.comment.value || '',
        amount: parseInt(fields.amount.value) || 0,
        currency: fields.currency.value || '¥',
        isMember: fields.isMember.checked,
        memberMonths: parseInt(fields.memberMonths.value) || 0,
        isMembership: fields.isMembership.checked,
        membershipHeader: fields.membershipHeader.value || '',
        isMembershipGift: fields.isMembershipGift.checked,
        giftCount: parseInt(fields.giftCount.value) || 0
      };
    };

    if (testBtn._customContext) applyContext(testBtn._customContext);

    TEST_TEMPLATES.forEach(function (tpl) {
      var chip = document.createElement('button');
      chip.style.cssText = 'background:#1e3a5f;border:1px solid #2563eb;border-radius:4px;padding:3px 8px;font-size:11px;color:#93c5fd;cursor:pointer;';
      chip.textContent = tpl.label;
      chip.addEventListener('click', function () { applyContext(tpl.ctx); });
      templateRow.appendChild(chip);
    });
    customArea.insertBefore(templateRow, customArea.children[1]);
  }

  dialog.appendChild(customArea);

  // ボタン行
  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;';

  var cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#94a3b8;font-size:12px;cursor:pointer;';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', function () { overlay.remove(); });

  var okBtn = document.createElement('button');
  okBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:none;background:#0ea5e9;color:#fff;font-size:12px;cursor:pointer;';
  okBtn.textContent = '適用';
  okBtn.addEventListener('click', function () {
    testBtn._testMode = currentMode;
    if (currentMode === 'custom') {
      if (isReactionTrigger) {
        testBtn._customReaction = selectedReaction;
      } else {
        testBtn._customContext = readContext();
      }
    }
    updateTestBtnLabel();
    overlay.remove();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  dialog.appendChild(btnRow);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

function sendTemplateTestCommentWithContext(context, callback) {
  var payload = Object.assign({
    profileImage: resolveTemplateTestProfileImage(context || {})
  }, context || {});
  return window.api.sendTemplateTestComment(selectedSceneId, payload).then(function (result) {
    if (!result || result.ok === false) {
      showAlertDialog('テストコメントの送信に失敗しました。対象シーンをアクティブにしてから再度お試しください。');
      return result;
    }
    if (callback) callback(result);
    return result;
  }).catch(function () {
    showAlertDialog('テストコメントの送信に失敗しました。');
    return null;
  });
}

function buildTemplateTestBurstContexts(pattern, count) {
  var presets = {
    chat: {
      names: [
        'そらねこ', 'みかん箱', '星見ゆき', 'くろまめ', 'あおい', 'しろくま',
        'ねむりねこ', 'ぽてと', 'ゆず', 'たかな', 'しずく', 'るな',
        'はる', 'なつ', 'あき', 'ふゆ', 'しぐれ', 'かえで'
      ],
      comments: [
        'こんばんはー！', '今日も来ました', '音いい感じです', 'かわいい！', '助かる',
        'ナイスです', 'それ好き', 'いい雰囲気', '初見です！', '配信ありがとう',
        '作業BGMにしてます', 'わかる', 'たすかる〜', 'いい感じ！', 'その話おもしろい',
        'スクショしたい', '今日のテンプレ見やすい', '色合い好きです', 'OBS映えしてる',
        '確認しやすくなった'
      ],
      specials: {
        4: { isMember: true, memberMonths: 10, comment: 'メンバーです。今日のまったり感好き' },
        8: { amount: 200, comment: 'お茶代どうぞ〜' },
        13: { amount: 1000, comment: '雑談たのしい！' },
        21: { isMembership: true, membershipHeader: 'メンバーになりました', comment: '' },
        26: { isMembershipGift: true, giftCount: 5, comment: '' }
      }
    },
    gaming: {
      names: [
        'FPS好き', 'レベル上げ勢', 'BossHunter', 'コンボ職人', 'AIM太郎', '回避の民',
        'RTA見習い', '赤ポーション', '青ゲージ', 'クリア勢', '初見攻略', '残機0',
        '夜更かし勇者', 'スティック職人', 'おたすけマン', '沼の民', 'セーブ忘れ', '装備厨'
      ],
      comments: [
        'ないすううう！', '今のうまい', 'その立ち回り好き', 'ボス戦きた！', '回避うま',
        'つよい', 'そこ危ない！', '今の見えた', '火力えぐい', '初見殺しだ',
        'ナイス判断', 'それ勝ったでしょ', '落ち着いて！', '装備いい感じ', 'コンボつながった',
        '惜しい！', '今のリプレイしたい', 'そこショトカあるよ', 'ラスボス感ある', 'GG'
      ],
      specials: {
        3: { isMember: true, memberMonths: 14, comment: 'メン限で練習した成果出てる！' },
        9: { amount: 500, comment: 'ボス撃破祈願！' },
        15: { amount: 2000, comment: '神プレイ代です' },
        22: { isMembership: true, membershipHeader: 'メンバーになりました', comment: '' },
        27: { isMembershipGift: true, giftCount: 10, comment: '' }
      }
    },
    singing: {
      names: [
        '@starlit-sora', '@luna-humming', '@echo-frame', '@aurora-note', '@midi-sky', '@tone-canvas',
        '@night-chorus', '@fuwari-voice', '@stellar-melody', '@ribbon-mic', '@halcyon-beat', '@glass-harmony',
        '@lyric-orbit', '@moonlit-reverb', '@soft-nebula', '@verse-garden', '@silk-echo', '@opal-song'
      ],
      comments: [],
      specials: {
        5: { isMember: true, memberMonths: 12, comment: '🌟✨🎶🌟✨🎶' },
        11: { amount: 500, comment: 'リクエスト応援です！' },
        17: { amount: 3000, comment: '歌枠ありがとう、最高！' },
        24: { isMembership: true, membershipHeader: 'メンバーになりました', comment: '' },
        28: { isMembershipGift: true, giftCount: 5, comment: '' }
      }
    }
  };
  var preset = presets[pattern] || presets.chat;
  var names = preset.names;
  var comments = preset.comments;
  var singingBarrage = [
    '🌟✨🎶🌟✨🎶', '🌟✨🎶🌟', '✨🎶🌟✨🎶', '🌟🌟✨🎶', '✨🎶✨🎶',
    '🌟✨🎶🌟✨🎶', '🌟✨🎶🌟✨🎶', '✨🎶🌟✨🎶🌟', '🌟✨🎶', '🌟✨🎶🌟✨🎶'
  ];
  var singingCalls = ['Fu Fu!', 'oh oh!', 'はい！はい！', 'wow wow!', 'Hey!'];
  var singingApplause = ['8888888888', '👏👏👏👏👏', '拍手！！！', '最高でした', 'アンコール！', '大拍手'];
  var burst = [];
  for (var i = 0; i < count; i++) {
    var commentText = comments[i % comments.length];
    if (pattern === 'singing') {
      if (i < Math.floor(count * 0.7)) {
        commentText = singingBarrage[i % singingBarrage.length];
        ctxUserIsMemberLike();
      } else if (i < Math.floor(count * 0.8)) {
        commentText = singingCalls[(i - Math.floor(count * 0.7)) % singingCalls.length];
      } else {
        commentText = singingApplause[(i - Math.floor(count * 0.8)) % singingApplause.length];
      }
    }
    var ctx = {
      userName: names[i % names.length] + ((i % 3) === 0 ? '_jp' : ''),
      comment: commentText,
      amount: 0,
      currency: '¥',
      isMember: false,
      memberMonths: 0,
      isMembership: false,
      membershipHeader: '',
      isMembershipGift: false,
      giftCount: 0
    };
    function ctxUserIsMemberLike() {
      if ((i % 3) !== 1) return;
      ctx.isMember = true;
      ctx.memberMonths = [1, 6, 12, 24][i % 4];
    }
    if (preset.specials[i]) {
      Object.assign(ctx, preset.specials[i]);
    }
    burst.push(ctx);
  }
  return burst;
}

function sendTemplateTestCommentBurst(sendBtn, closeOverlay, pattern) {
  var burst = buildTemplateTestBurstContexts(pattern, 30);
  sendTemplateTestCommentSequence(sendBtn, burst, closeOverlay);
}

function sendTemplateTestCommentSequence(sendBtn, contexts, closeOverlay) {
  var burst = Array.isArray(contexts) ? contexts.slice() : [];
  var index = 0;
  var originalLabel = sendBtn.textContent;
  sendBtn.disabled = true;
  sendBtn.style.opacity = '0.7';

  function sendNext() {
    if (index >= burst.length) {
      sendBtn.disabled = false;
      sendBtn.style.opacity = '1';
      sendBtn.textContent = originalLabel;
      if (closeOverlay) closeOverlay();
      return;
    }
    sendBtn.textContent = '送信中... ' + (index + 1) + '/' + burst.length;
    sendTemplateTestCommentWithContext(burst[index]).then(function (result) {
      if (!result || result.ok === false) {
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        sendBtn.textContent = originalLabel;
        return;
      }
      index += 1;
      setTimeout(sendNext, 90 + (index % 4) * 30);
    });
  }

  sendNext();
}

function showTemplateCommentTestDialog() {
  var existing = document.getElementById('template-comment-test-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'template-comment-test-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;width:420px;max-height:80vh;overflow-y:auto;color:#e2e8f0;font-size:13px;';

  var titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:15px;font-weight:bold;margin-bottom:16px;color:#f1f5f9;';
  titleEl.textContent = 'テストコメント送信';
  dialog.appendChild(titleEl);

  var templateLabel = document.createElement('div');
  templateLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:6px;';
  templateLabel.textContent = 'テンプレート（クリックで入力欄に反映）';
  dialog.appendChild(templateLabel);

  var templateRow = document.createElement('div');
  templateRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:14px;';
  dialog.appendChild(templateRow);

  var fieldInputStyle = 'width:100%;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:12px;padding:5px 8px;box-sizing:border-box;';
  var fieldLabelStyle = 'font-size:11px;color:#94a3b8;margin-bottom:2px;';
  var fieldRowStyle = 'margin-bottom:8px;';
  var halfRowStyle = 'display:flex;gap:8px;margin-bottom:8px;';
  var fields = {};

  function makeTextField(key, label, placeholder) {
    var row = document.createElement('div');
    row.style.cssText = fieldRowStyle;
    var lbl = document.createElement('div');
    lbl.style.cssText = fieldLabelStyle;
    lbl.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.style.cssText = fieldInputStyle;
    inp.placeholder = placeholder || '';
    row.appendChild(lbl);
    row.appendChild(inp);
    fields[key] = inp;
    return row;
  }
  function makeNumberField(key, label, placeholder) {
    var row = document.createElement('div');
    row.style.cssText = 'flex:1;';
    var lbl = document.createElement('div');
    lbl.style.cssText = fieldLabelStyle;
    lbl.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.style.cssText = fieldInputStyle;
    inp.placeholder = placeholder || '0';
    row.appendChild(lbl);
    row.appendChild(inp);
    fields[key] = inp;
    return row;
  }
  function makeCheckField(key, label) {
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
    var inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.style.cssText = 'accent-color:#0ea5e9;';
    var span = document.createElement('span');
    span.style.cssText = 'font-size:11px;color:#94a3b8;';
    span.textContent = label;
    row.appendChild(inp);
    row.appendChild(span);
    fields[key] = inp;
    return row;
  }
  function applyContext(ctx) {
    fields.userName.value = ctx.userName || '';
    fields.comment.value = ctx.comment || '';
    fields.amount.value = ctx.amount || '';
    fields.memberMonths.value = ctx.memberMonths || '';
    fields.giftCount.value = ctx.giftCount || '';
    fields.currency.value = ctx.currency || '¥';
    fields.membershipHeader.value = ctx.membershipHeader || '';
    fields.isMember.checked = !!ctx.isMember;
    fields.isMembership.checked = !!ctx.isMembership;
    fields.isMembershipGift.checked = !!ctx.isMembershipGift;
  }
  function readContext() {
    return {
      userName: fields.userName.value || 'テストユーザー',
      comment: fields.comment.value || '',
      amount: parseInt(fields.amount.value, 10) || 0,
      currency: fields.currency.value || '¥',
      isMember: fields.isMember.checked,
      memberMonths: parseInt(fields.memberMonths.value, 10) || 0,
      isMembership: fields.isMembership.checked,
      membershipHeader: fields.membershipHeader.value || '',
      isMembershipGift: fields.isMembershipGift.checked,
      giftCount: parseInt(fields.giftCount.value, 10) || 0
    };
  }

  dialog.appendChild(makeTextField('userName', 'ユーザー名', 'テストユーザー'));
  dialog.appendChild(makeTextField('comment', 'コメント', 'テストコメント'));

  var numRow = document.createElement('div');
  numRow.style.cssText = halfRowStyle;
  numRow.appendChild(makeNumberField('amount', 'スパチャ金額', '0'));
  numRow.appendChild(makeNumberField('memberMonths', 'メンバー月数', '0'));
  dialog.appendChild(numRow);

  var numRow2 = document.createElement('div');
  numRow2.style.cssText = halfRowStyle;
  numRow2.appendChild(makeNumberField('giftCount', 'ギフト個数', '0'));
  var currRow = document.createElement('div');
  currRow.style.cssText = 'flex:1;';
  var currLbl = document.createElement('div');
  currLbl.style.cssText = fieldLabelStyle;
  currLbl.textContent = '通貨';
  var currInp = document.createElement('input');
  currInp.type = 'text';
  currInp.style.cssText = fieldInputStyle;
  currInp.placeholder = '¥';
  currInp.value = '¥';
  currRow.appendChild(currLbl);
  currRow.appendChild(currInp);
  fields.currency = currInp;
  numRow2.appendChild(currRow);
  dialog.appendChild(numRow2);

  dialog.appendChild(makeTextField('membershipHeader', 'メンバーシップヘッダー', 'メンバーになりました'));

  var checkRow = document.createElement('div');
  checkRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;margin-top:4px;';
  checkRow.appendChild(makeCheckField('isMember', 'メンバー'));
  checkRow.appendChild(makeCheckField('isMembership', 'メンバー加入'));
  checkRow.appendChild(makeCheckField('isMembershipGift', 'ギフト'));
  dialog.appendChild(checkRow);

  TEST_TEMPLATES.forEach(function (tpl) {
    var chip = document.createElement('button');
    chip.style.cssText = 'background:#0f172a;border:1px solid #334155;border-radius:999px;padding:6px 10px;font-size:11px;color:#cbd5e1;cursor:pointer;';
    chip.textContent = tpl.label;
    chip.addEventListener('click', function () {
      applyContext(tpl.ctx);
    });
    templateRow.appendChild(chip);
  });
  applyContext(TEST_TEMPLATES[0].ctx);

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:18px;';

  var cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px;font-size:12px;color:#cbd5e1;cursor:pointer;';
  cancelBtn.textContent = '閉じる';
  cancelBtn.addEventListener('click', function () {
    overlay.remove();
  });
  btnRow.appendChild(cancelBtn);

  var sendBtn = document.createElement('button');
  sendBtn.style.cssText = 'flex:1;background:#0ea5e9;border:none;border-radius:6px;padding:10px;font-size:12px;color:#fff;cursor:pointer;';
  sendBtn.textContent = '送信';
  sendBtn.addEventListener('click', function () {
    sendTemplateTestCommentWithContext(readContext(), function () {
      overlay.remove();
    });
  });
  btnRow.appendChild(sendBtn);

  var burstLabel = document.createElement('div');
  burstLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-top:18px;margin-bottom:8px;';
  burstLabel.textContent = '30件まとめて送信';
  dialog.appendChild(burstLabel);

  var burstRow = document.createElement('div');
  burstRow.style.cssText = 'display:flex;gap:8px;';

  [
    { key: 'chat', label: '雑談っぽい' },
    { key: 'gaming', label: 'ゲーム実況っぽい' },
    { key: 'singing', label: '歌枠っぽい' }
  ].forEach(function (preset) {
    var burstBtn = document.createElement('button');
    burstBtn.style.cssText = 'flex:1;background:#1d4ed8;border:none;border-radius:6px;padding:10px;font-size:12px;color:#fff;cursor:pointer;';
    burstBtn.textContent = preset.label;
    burstBtn.addEventListener('click', function () {
      sendTemplateTestCommentBurst(burstBtn, function () {
        overlay.remove();
      }, preset.key);
    });
    burstRow.appendChild(burstBtn);
  });

  dialog.appendChild(burstRow);

  var monetizationBtn = document.createElement('button');
  monetizationBtn.style.cssText = 'width:100%;background:#7c3aed;border:none;border-radius:6px;padding:10px;font-size:12px;color:#fff;cursor:pointer;margin-top:10px;';
  monetizationBtn.textContent = '課金系を全部送信';
  monetizationBtn.addEventListener('click', function () {
    var monetizationContexts = TEST_TEMPLATES
      .filter(function (tpl) {
        var ctx = tpl && tpl.ctx;
        return ctx && (ctx.amount > 0 || ctx.isMembership || ctx.isMembershipGift);
      })
      .map(function (tpl) { return tpl.ctx; });
    sendTemplateTestCommentSequence(monetizationBtn, monetizationContexts, function () {
      overlay.remove();
    });
  });
  dialog.appendChild(monetizationBtn);

  dialog.appendChild(btnRow);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

function createTemplateTestButton() {
  var btn = document.createElement('button');
  btn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
  btn.textContent = '▶ テストコメント';
  btn.addEventListener('click', function () {
    showTemplateCommentTestDialog();
  });
  return btn;
}

function deleteImportedTemplate(templateId, displayName, onDone) {
  window.api.getScenes().then(function (scenes) {
    var usage = [];
    var allScenes = scenes || {};
    var templateInfo = currentTemplateInfoMap && currentTemplateInfoMap[templateId] ? currentTemplateInfoMap[templateId] : null;
    var templateExists = !!templateInfo;
    Object.keys(allScenes).forEach(function (sceneId) {
      var scene = allScenes[sceneId];
      var templates = (scene && scene.templates) || [];
      var used = templates.some(function (template) {
        return template && ((template.id || template.name) === templateId);
      });
      if (!used) return;
      usage.push((scene && scene.name) ? scene.name : sceneId);
    });

    var message = '「' + (displayName || templateId) + '」を削除しますか？\n現在のシーンからも外し、インポート済みテンプレート本体を削除します。';
    if (usage.length > 0) {
      message += '\n\nこのテンプレートを使用しているシーン:\n- ' + usage.join('\n- ');
      message += '\n\n削除すると、これらのシーンでもテンプレート参照が失われます。';
    }
    if (!templateExists) {
      message = '「' + (displayName || templateId) + '」の本体は既に存在しません。\n残っているシーン参照だけを削除します。';
      if (usage.length > 0) {
        message += '\n\n参照が残っているシーン:\n- ' + usage.join('\n- ');
      }
    }

    showPromptDialog(message, null, function (ok) {
      if (!ok) return;
      var usedSceneIds = Object.keys(allScenes).filter(function (sceneId) {
        var scene = allScenes[sceneId];
        var templates = (scene && scene.templates) || [];
        return templates.some(function (template) {
          return template && ((template.id || template.name) === templateId);
        });
      });

      Promise.resolve()
        .then(function () {
          return usedSceneIds.reduce(function (chain, sceneId) {
            return chain.then(function () {
              var scene = allScenes[sceneId];
              if (!scene) return true;
              var nextScene = JSON.parse(JSON.stringify(scene));
              nextScene.templates = (nextScene.templates || []).filter(function (template) {
                return template && ((template.id || template.name) !== templateId);
              });
              if (nextScene.selectedTemplateId === templateId) {
                if (nextScene.templates.length > 0) {
                  nextScene.selectedTemplateId = nextScene.templates[0].id || nextScene.templates[0].name || '';
                } else {
                  nextScene.selectedTemplateId = '';
                }
              }
              return window.api.saveScene(sceneId, nextScene);
            });
          }, Promise.resolve());
        })
        .then(function () {
          if (!templateExists) return { ok: true, staleOnly: true };
          return window.api.removeTemplate(templateId);
        })
        .then(function (result) {
          if (result === true || (result && result.ok === true)) {
            refreshTemplateList().then(function () {
              if (onDone) onDone();
            });
          } else {
            showAlertDialog('テンプレートの削除に失敗しました。');
          }
        })
        .catch(function () {
          showAlertDialog('テンプレートの削除に失敗しました。');
        });
    });
  }).catch(function () {
    showAlertDialog('シーン参照の確認に失敗しました。');
  });
}

// === アラートダイアログ（alert 代替、 OK ボタン 1 つだけ） ===
// alertMode=true を showPromptDialog に渡してキャンセルボタンを非表示にする。
// callback は OK 押下 (= Enter / Escape も含む) で必ず呼ばれる、 引数は受けない。
function showAlertDialog(msg, callback) {
  showPromptDialog(msg, null, function () { if (callback) callback(); }, true);
}

// === バックアップ進捗ダイアログ ===
// phase + percent を Rust から push 受信して更新する。
// 返り値: { update(phase, percent), close() }。close() しない限り表示が残る。
var BACKUP_PHASE_LABELS = {
  'start': '準備中...',
  'scenes': 'シーンを保存中...',
  'plugins': 'プラグインを保存中...',
  'db-vacuum': 'DB スナップショット作成中...',
  'db-unpack': 'DB を展開中...',
  'db-compress': 'DB を圧縮中...',
  'db-done': 'DB 完了',
  'media-cache': 'メディアキャッシュを保存中...',
  'media-cache-done': 'メディアキャッシュ完了',
  'configs': '設定を保存中...',
  // 復元 phase
  'scan': 'バックアップを確認中...',
  'rescue': '既存データを退避中...',
  'restore': 'データを復元中...',
  'restore-tar-done': 'データの展開完了、 再構築準備中...',
  'migrate': 'DB を再構築中...',
  'done': '完了'
};
// 秒を「X 時間 Y 分 Z 秒」 に整形 (= 0 のセグメントは省略)。
function formatElapsedSec(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  if (h > 0) return h + ' 時間 ' + m + ' 分 ' + s + ' 秒';
  if (m > 0) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

// db-unpack の予想所要秒数は Rust 側で計算済 (= estimate_unpack_seconds、 並列度を考慮)。
// JS 側は SSE event の meta (= 秒数) をそのまま表示するだけ。 旧シリアル時代の固定計数は廃止。

function showBackupProgressDialog(titleText, options) {
  options = options || {};
  // SSE 'done' phase 100% を受信したときに呼ばれるコールバック (= 1 回限り)。
  // 復元経路で「reply restored:true は migration 前に返るので、 dialog の close は
  // SSE done 100% で行いたい」 という UX のために導入。
  var onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;

  var overlay = document.createElement('div');
  overlay.className = 'prompt-overlay';

  var dialog = document.createElement('div');
  dialog.className = 'prompt-dialog backup-progress-dialog';

  var title = document.createElement('div');
  title.className = 'prompt-label';
  title.textContent = titleText || 'バックアップ作成中';

  var phaseEl = document.createElement('div');
  phaseEl.className = 'backup-progress-phase';
  phaseEl.textContent = '準備中...';

  var barTrack = document.createElement('div');
  barTrack.className = 'backup-progress-bar-track kh-progress-bar-track';

  var barFill = document.createElement('div');
  barFill.className = 'backup-progress-bar-fill kh-progress-bar-fill';

  var percentEl = document.createElement('div');
  percentEl.className = 'backup-progress-percent';
  percentEl.textContent = '0%';

  var elapsedEl = document.createElement('div');
  elapsedEl.className = 'backup-progress-elapsed';

  var startedAt = Date.now();
  var elapsedTimer = setInterval(function () {
    var sec = Math.floor((Date.now() - startedAt) / 1000);
    elapsedEl.textContent = '経過 ' + formatElapsedSec(sec);
  }, 500);
  elapsedEl.textContent = '経過 ' + formatElapsedSec(0);

  barTrack.appendChild(barFill);
  dialog.appendChild(title);
  dialog.appendChild(phaseEl);
  dialog.appendChild(barTrack);
  dialog.appendChild(percentEl);
  dialog.appendChild(elapsedEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // phase 別の suffix (= "DB を展開中... (約 5 分)" のような動的補足) を保持する。
  // db-unpack の開始時に meta=総件数 を受け取り、 0.66 ms/件 で予想時間を計算する。
  var phaseSuffix = {};

  function update(phase, percent) {
    var label = BACKUP_PHASE_LABELS[phase] || phase || '';
    var suffix = phaseSuffix[phase];
    phaseEl.textContent = suffix ? label + ' ' + suffix : label;
    if (typeof percent === 'number' && !isNaN(percent)) {
      var p = Math.max(0, Math.min(100, Math.round(percent)));
      barFill.style.width = p + '%';
      percentEl.textContent = p + '%';
      if (phase === 'done' || p >= 100) {
        barFill.classList.add('is-done');
      }
    }
  }

  // SSE 経由の backup-progress を購読 (= 二重登録防止: グローバル 1 つだけ
  // listener を作って active dialog に転送する設計)
  var listener = function (data) {
    if (!data) return;
    // meta は phase 開始時に 1 回だけ届く補助数値 (= 予想所要秒数、 Rust が並列度込みで算出済)
    if (typeof data.meta === 'number' && data.meta > 0) {
      if (data.phase === 'db-unpack' || data.phase === 'db-compress' || data.phase === 'migrate') {
        phaseSuffix[data.phase] = '(約 ' + formatElapsedSec(data.meta) + ')';
      }
    }
    update(data.phase, data.percent);
    // 'done' 100% を受けて onComplete を発火 (= 1 回限り、 復元経路の完了 UX 用)
    if (onComplete && data.phase === 'done' && (data.percent || 0) >= 100) {
      var cb = onComplete;
      onComplete = null;
      try { cb(); } catch (err) { rendererLog.warn('backup onComplete callback threw:', err); }
    }
  };
  registerActiveBackupProgressListener(listener);

  function close() {
    clearInterval(elapsedTimer);
    unregisterActiveBackupProgressListener(listener);
    overlay.remove();
  }

  return { update: update, close: close };
}

// グローバル 1 個の IPC listener から active dialog に転送する仕組み。
// 二重 ipcRenderer.on 登録防止。
var _activeBackupProgressListeners = [];
function registerActiveBackupProgressListener(fn) {
  _activeBackupProgressListeners.push(fn);
  if (!registerActiveBackupProgressListener._inited) {
    registerActiveBackupProgressListener._inited = true;
    if (api && typeof api.onBackupProgress === 'function') {
      api.onBackupProgress(function (data) {
        for (var i = 0; i < _activeBackupProgressListeners.length; i++) {
          try { _activeBackupProgressListeners[i](data); } catch (err) { rendererLog.warn('backup progress listener threw (continuing chain):', err); }
        }
      });
    }
  }
}
function unregisterActiveBackupProgressListener(fn) {
  var i = _activeBackupProgressListeners.indexOf(fn);
  if (i >= 0) _activeBackupProgressListeners.splice(i, 1);
}

// わんコメ DB リセット / 巻き戻し検出時の警告モーダル ([[feedback_watermark_vs_external_db_reset]])。
// Rust 側で起動時 import 前に detect_onecomme_reset() が走り、 異常検出で SSE push される。
// ユーザーが「リセット」 を選ぶと resetOnecommeWatermarks API で 2 つの watermark をクリア →
// 次回 export で全件書き直し。
var _onecommeResetShown = false;
function setupOnecommeResetListener() {
  if (setupOnecommeResetListener._inited) return;
  setupOnecommeResetListener._inited = true;
  if (!api || typeof api.onOnecommeResetDetected !== 'function') return;
  api.onOnecommeResetDetected(function (payload) {
    if (_onecommeResetShown) return; // 同セッション中に複数発火しても 1 回だけ表示
    _onecommeResetShown = true;
    var sig = payload && payload.signal;
    var dir = payload && payload.onecommeDir;
    if (!sig || !sig.kind) return;
    var kindLabel = ({
      'deleted': 'わんコメ DB が削除された可能性',
      'rolledBack': 'わんコメ DB が過去の状態に巻き戻された可能性',
      'largeDecrease': 'わんコメ DB のデータが大幅に減少',
      'pathChanged': 'わんコメ DB の保存場所が変わりました'
    })[sig.kind] || 'わんコメ DB に予期しない変化';
    var prev = sig.prev || {};
    var curr = sig.curr || {};
    var msg = [
      '【検出: ' + kindLabel + '】',
      '',
      '前回観測 → 現在:',
      '  ・users: ' + (prev.usersCount || 0).toLocaleString() + ' → ' + (curr.usersCount || 0).toLocaleString(),
      '  ・comments: ' + (prev.commentsCount || 0).toLocaleString() + ' → ' + (curr.commentsCount || 0).toLocaleString(),
      '  ・max(created_at): ' + (prev.maxCreatedAt || '(なし)') + ' → ' + (curr.maxCreatedAt || '(なし)'),
      '',
      'こめはぶ側は「すでにわんコメに書き戻し済」 と認識しているため、',
      'このまま運用すると 書き戻されない コメが発生する可能性があります。',
      '',
      'こめはぶ側の book-keeping (= watermark) をリセットしますか？',
      '【はい】 次回 こめはぶ閉じる時に 全件 わんコメに書き戻し',
      '【いいえ】 そのまま (= 後から設定 → わんコメ連携 で実行可能)'
    ].join('\n');
    showPromptDialog(msg, null, function (ok) {
      if (!ok) return;
      api.resetOnecommeWatermarks(dir).then(function (result) {
        if (result && result.ok) {
          showAlertDialog('watermark をリセットしました。\n次回ハブを閉じる際に わんコメへ全件書き戻されます。');
        } else {
          showAlertDialog('watermark のリセットに失敗しました: ' + ((result && result.error) || '不明なエラー'));
        }
      }).catch(function () {
        showAlertDialog('watermark のリセット中にエラーが発生しました。');
      });
    });
  });
}
// renderer 起動直後に setup
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOnecommeResetListener);
  } else {
    setupOnecommeResetListener();
  }
}

// インポート結果に `unsupportedPlugins` が含まれていれば警告ダイアログを出す。
// こめはぶは わんコメ community プラグインを同梱しないため、これらに依存した
// テンプレートは黒画面化する。user が原因を特定できるよう明示する。
function notifyUnsupportedOneCommePlugins(result) {
  if (!result || !result.ok) return;
  var plugins = result.unsupportedPlugins;
  if (!Array.isArray(plugins) || plugins.length === 0) return;
  var tmplName = (result.template && (result.template.displayName || result.template.name)) || 'このテンプレート';
  var msg =
    tmplName + ' は、こめはぶに同梱されていないわんコメ community プラグインを要求しています。\n\n' +
    '要求されているプラグイン:\n  ' + plugins.join('\n  ') + '\n\n' +
    'テンプレートは正しく表示されない可能性があります（黒画面等）。\n' +
    '詳細は docs/onecomme-migration-guide.md の「非対応プラグイン」節を参照してください。';
  showAlertDialog(msg);
}

// === プロンプトダイアログ ===
// alertMode=true で alert (= OK 1 ボタンのみ) として動作する。 showAlertDialog から指定。
// 既存 callee (= 入力 / confirm 系) は alertMode 省略で 2 ボタン (OK + キャンセル) のまま。
function showPromptDialog(title, defaultValue, callback, alertMode) {
  var isConfirm = defaultValue === null;

  var overlay = document.createElement('div');
  overlay.className = 'prompt-overlay';

  var dialog = document.createElement('div');
  dialog.className = 'prompt-dialog';

  var label = document.createElement('div');
  label.className = 'prompt-label';
  label.textContent = title;

  var input = null;
  if (!isConfirm) {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.value = defaultValue;
  }

  var btnRow = document.createElement('div');
  btnRow.className = 'prompt-btn-row';

  var okBtn = document.createElement('button');
  okBtn.className = 'prompt-ok-btn';
  okBtn.textContent = t('dialog.ok');

  var cancelBtn = null;
  if (!alertMode) {
    cancelBtn = document.createElement('button');
    cancelBtn.className = 'prompt-cancel-btn';
    cancelBtn.textContent = t('dialog.cancel');
  }

  function close(value) {
    overlay.remove();
    callback(value);
  }

  okBtn.addEventListener('click', function () {
    close(isConfirm ? true : input.value.trim());
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      close(null);
    });
  }

  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') close(input.value.trim());
      // alertMode では Escape も OK 扱い (= キャンセル概念なし)
      if (e.key === 'Escape') close(alertMode ? true : null);
    });
  }

  if (cancelBtn) btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  dialog.appendChild(label);
  if (input) dialog.appendChild(input);
  dialog.appendChild(btnRow);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  if (input) {
    input.focus();
    input.select();
  } else {
    okBtn.focus();
  }
}

// commentHtmlからimgタグ（スタンプ）とテキストのみ残す
function setStatus(state, text) {
  statusDot.className = 'dot ' + state;
  statusText.textContent = text;
  // stream-info パネル内の status 表示も同期 (パネル表示中はこちらを見せる)
  var sd = document.getElementById('stream-info-status-dot');
  var st = document.getElementById('stream-info-status-text');
  if (sd) sd.className = 'dot ' + state;
  if (st) st.textContent = text;
  // UI 整理 Phase 1: ヘッダの conn-pill (= 「接続中」緑 pill) を connected 時のみ表示
  var pill = document.getElementById('conn-pill');
  if (pill) pill.style.display = (state === 'connected') ? 'inline-flex' : 'none';
}

// === コメント詳細モーダル ===

var activeContextMenu = null;

function removeContextMenu() {
  if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
}

function attachCommentKeywordContextMenu(commentBody) {
  if (!commentBody) return;
  commentBody.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    removeContextMenu();

    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    // 選択範囲からテキスト+絵文字（imgのalt）を抽出
    var range = selection.getRangeAt(0);
    var fragment = range.cloneContents();
    var selectedText = '';
    fragment.childNodes.forEach(function (node) {
      if (node.nodeType === 3) {
        selectedText += node.textContent;
      } else if (node.nodeType === 1 && node.tagName === 'IMG') {
        selectedText += node.alt || '';
      } else if (node.nodeType === 1) {
        // 入れ子の場合
        node.querySelectorAll('img').forEach(function (img) { selectedText += img.alt || ''; });
        selectedText += node.textContent || '';
      }
    });
    selectedText = selectedText.trim();
    if (!selectedText) return;

    // キーワードトリガーの演出を取得
    api.getPerformances(selectedSceneId).then(function (performances) {
      var keywordPerfs = performances.filter(function (p) {
        return p.trigger && p.trigger.type === 'keyword';
      });
      if (keywordPerfs.length === 0) return;

      var menu = document.createElement('div');
      activeContextMenu = menu;
      menu.style.cssText = 'position:fixed;z-index:9999;background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:4px 0;min-width:200px;box-shadow:0 4px 20px rgba(0,0,0,0.5);';
      menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - (keywordPerfs.length * 32 + 40)) + 'px';

      // ヘッダー
      var menuHeader = document.createElement('div');
      menuHeader.style.cssText = 'padding:6px 12px;font-size:10px;color:#475569;text-transform:uppercase;';
      menuHeader.textContent = '「' + (selectedText.length > 15 ? selectedText.substring(0, 15) + '…' : selectedText) + '」を追加';
      menu.appendChild(menuHeader);

      keywordPerfs.forEach(function (perf) {
        var menuItem = document.createElement('div');
        menuItem.style.cssText = 'padding:6px 12px;font-size:13px;color:#d8e8e8;cursor:pointer;';
        menuItem.textContent = perf.name;
        menuItem.addEventListener('mouseenter', function () { menuItem.style.background = '#1a3a4a'; });
        menuItem.addEventListener('mouseleave', function () { menuItem.style.background = ''; });
        menuItem.addEventListener('click', function () {
          if (!perf.trigger.keywords) perf.trigger.keywords = [];
          var exists = perf.trigger.keywords.some(function (kw) {
            return (typeof kw === 'string' ? kw : kw.text) === selectedText;
          });
          if (!exists) {
            perf.trigger.keywords.push({ text: selectedText, regex: false });
            api.savePerformance(selectedSceneId, perf);
          }
          removeContextMenu();
        });
        menu.appendChild(menuItem);
      });

      document.body.appendChild(menu);

      // メニュー外クリックで閉じる
      setTimeout(function () {
        document.addEventListener('click', function handler() {
          removeContextMenu();
          document.removeEventListener('click', handler);
        });
      }, 0);
    });
  });
}

function commentDataToListenerChannelId(data) {
  if (!data) return '';
  return data.userId || data.channelId || data.listenerChannelId || '';
}

function commentDataToRecentComment(data) {
  // streamId はライブイベント由来のコメントにはフィールドが無いため、
  // 現在接続中の自配信 videoId にフォールバックする (リスナー詳細モーダルの
  // 「この枠」フィルタが focusComment を含めて正しく動作するため)。
  var streamId = (data && (data.streamId || data.liveId)) || currentStreamVideoId || '';
  return {
    id: data && data.id ? data.id : '',
    streamId: streamId,
    postedAt: data && data.timestamp ? data.timestamp : Date.now(),
    body: data && data.comment ? data.comment : '',
    commentType: data && data.type ? data.type : 'comment',
    superchatAmountJpy: data && data.amount ? data.amount : null,
    raw: {
      commentHtml: data && data.commentHtml ? sanitizeCommentHtml(data.commentHtml) : ''
    },
    _selected: true
  };
}

function commentDataToListenerDetail(data) {
  var channelId = commentDataToListenerChannelId(data) || (data && data.name ? data.name : '');
  return {
    channelId: channelId,
    displayName: data && data.name ? data.name : '(no name)',
    username: '',
    iconUrl: data && data.profileImage ? data.profileImage : '',
    firstSeenAt: data && data.timestamp ? data.timestamp : 0,
    lastSeenAt: data && data.timestamp ? data.timestamp : 0,
    commentCount: 1,
    superchatCount: 0,
    superchatAmountJpy: 0,
    isMember: !!(data && data.isMember),
    isModerator: !!(data && data.isModerator),
    memberMonthsMax: data && data.memberMonths ? data.memberMonths : 0,
    notes: '',
    label: '',
    nickname: '',
    recentComments: [commentDataToRecentComment(data)],
    _commentOnly: true
  };
}

function showCommentDetail(data) {
  removeContextMenu();
  var channelId = commentDataToListenerChannelId(data);
  if (channelId && api.listeners && api.listeners.detail) {
    openListenerDetail(channelId, { focusComment: data, fallbackDetail: commentDataToListenerDetail(data) });
    return;
  }
  renderListenerDetailModal(commentDataToListenerDetail(data), { focusComment: data });
}

// === 非表示リスト管理モーダル (= 旧 BAN リスト) ===
// 2026-05-09 仕様変更: 演出フィルタは撤廃。「コメ非表示」「リスナー非表示」の 2 軸独立を
// 行ごとにチェックボックス表示。両方 OFF にしたら record 自体が消える (= UI 上は「解除」)。
function showBanList() {
  var existing = document.getElementById('ban-list-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'ban-list-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;';
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

  var modal = document.createElement('div');
  modal.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:12px;padding:20px;max-width:480px;width:90%;max-height:70vh;display:flex;flex-direction:column;';

  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;';
  var title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:bold;color:#d8e8e8;';
  title.textContent = '非表示リスト';
  var closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;color:#64748b;font-size:20px;cursor:pointer;padding:4px 8px;';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', function () { overlay.remove(); });
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  var desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:12px;line-height:1.5;';
  desc.textContent = '配信者の管理 UI でだけ非表示にします。演出 / OBS / テンプレートには影響しません (= 相手に気付かれません)。両方 OFF で record が削除されます。';
  modal.appendChild(desc);

  var listContainer = document.createElement('div');
  listContainer.style.cssText = 'flex:1;overflow-y:auto;';

  function renderList() {
    listContainer.innerHTML = '';
    if (!api.listeners || typeof api.listeners.getHidden !== 'function') {
      listContainer.textContent = 'API 未提供';
      return;
    }
    api.listeners.getHidden().then(function (users) {
      if (!users || users.length === 0) {
        var empty = document.createElement('div');
        empty.style.cssText = 'font-size:13px;color:#475569;text-align:center;padding:20px;';
        empty.textContent = '非表示にしているユーザーはいません';
        listContainer.appendChild(empty);
        return;
      }
      users.forEach(function (user) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #1a2742;';

        var avatar = document.createElement('img');
        avatar.src = user.profileImage || '';
        avatar.style.cssText = 'width:28px;height:28px;border-radius:50%;flex-shrink:0;';
        avatar.onerror = function () { this.style.display = 'none'; };

        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        var nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:13px;color:#d8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nameEl.textContent = user.name || user.id;
        info.appendChild(nameEl);
        if (user.name && user.name !== user.id) {
          var idEl = document.createElement('div');
          idEl.style.cssText = 'font-size:10px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          idEl.textContent = user.id;
          info.appendChild(idEl);
        }

        var toggles = document.createElement('div');
        toggles.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;';
        function makeToggle(label, key) {
          var wrap = document.createElement('label');
          wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer;';
          var chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = !!user[key];
          chk.addEventListener('change', function () {
            var hideFromComments = (key === 'hideFromComments') ? chk.checked : !!user.hideFromComments;
            var hideFromListeners = (key === 'hideFromListeners') ? chk.checked : !!user.hideFromListeners;
            rendererLog.info('user: listener-hidden-toggle (modal), userId=' + user.id + ', hideComments=' + hideFromComments + ', hideListeners=' + hideFromListeners);
            api.listeners.setHidden(user.id, hideFromComments, hideFromListeners).then(function () {
              renderList();
            });
          });
          wrap.appendChild(chk);
          var t = document.createElement('span');
          t.textContent = label;
          wrap.appendChild(t);
          return wrap;
        }
        toggles.appendChild(makeToggle('コメ非表示', 'hideFromComments'));
        toggles.appendChild(makeToggle('リスナー非表示', 'hideFromListeners'));

        row.appendChild(avatar);
        row.appendChild(info);
        row.appendChild(toggles);
        listContainer.appendChild(row);
      });
    });
  }

  renderList();
  modal.appendChild(listContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// BAN リストボタンは設定モーダル内に移動 (= openAppSettingsModal 内で表示)。
// comments-header の現在のボタンは「📱 スマホで開く」に置き換わっている。
(function () {
  var btn = document.getElementById('open-remote-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (!window.KomehubShared || !window.KomehubShared.openRemote) {
      rendererLog.error('[renderer] KomehubShared.openRemote not loaded');
      return;
    }
    if (!window.api || typeof window.api.startListenerRemote !== 'function') {
      rendererLog.error('[renderer] api.startListenerRemote not exposed');
      return;
    }
    window.KomehubShared.openRemote({
      confirmTitle: 'スマホ操作を有効にしますか？',
      confirmParagraphs: [
        'スマホからコメントを閲覧するため、このPCのローカルネットワーク向けにリモート専用ポートを開きます。',
        'Windows セキュリティの警告が表示された場合は、同じ Wi-Fi / LAN のスマホから接続できるように「プライベート ネットワーク」を許可してください。パブリック ネットワークでは許可しないでください。',
        'リモート専用ポートでは、コメ閲覧 / 対応済み / リスナー対応済み / BAN 等の閲覧者管理機能だけを公開します。'
      ],
      resultTitle: 'スマホで開く',
      fetchInfo: function () { return window.api.startListenerRemote(); },
      // 確認スキップ設定は ponout と共有 (= LAN ポート開放警告は同じ意味)
      getDismissed: window.api.ponout && window.api.ponout.getRemoteWarningDismissed
        ? function () { return window.api.ponout.getRemoteWarningDismissed(); }
        : null,
      setDismissed: window.api.ponout && window.api.ponout.setRemoteWarningDismissed
        ? function (v) { return window.api.ponout.setRemoteWarningDismissed(v); }
        : null
    });
  });
})();

// メイン画面のコメントセル DOM を組み立てる純粋関数。
// 検索結果側 (Phase C) もこの関数を直接呼んで、見た目とクリック挙動を完全統一する。
// スクロール/件数上限処理は addComment 側に残す (この関数は副作用なし、DOM 1 要素を返すだけ)。
// shared/comment-item.js への薄いラッパ: click handler と format helper を注入する。
// 「対応済み」トグルは「そのコメが自枠で記録されたか」で表示可否を決める:
//   - options.streamIsOwn === true: 必ず表示 (= 過去枠が自枠だった文脈、stream-detail-modal 等)
//   - options.streamIsOwn === false: 必ず非表示 (= 過去他枠の文脈)
//   - options.streamIsOwn 未指定: global isOwnStream にフォールバック (= live コメ用既存挙動)
// 自枠以外でトグルを inject すると set_comment_responded が永続化できない (= comments
// テーブルに行が無いため) 混乱を避けたい。
function buildCommentItem(data, options) {
  options = options || {};
  var canRespond = (options.streamIsOwn !== undefined)
    ? !!options.streamIsOwn
    : isOwnStream;
  // options.disableClick: cell クリックで listener 詳細を開く挙動を無効化する
  // (= listener 詳細「全コメ」タブで自分自身を再帰的に開かないため、2026-05-13)
  var clickHandler = options.disableClick ? null : showCommentDetail;
  return window.KomehubShared.createCommentItem(data, {
    onClick: clickHandler,
    onToggleResponded: canRespond ? toggleCommentResponded : null,
    formatTime: listenerMgrFormatTime,
    formatYen: listenerMgrFormatYen,
    truncate: function (text, max) {
      var value = String(text == null ? '' : text);
      if (!max || value.length <= max) return value;
      return value.substring(0, max) + '...';
    }
  });
}

// 既存 commentList の DOM ノードをスキャンして、isOwnStream の現在値に応じて
// .kh-toggle-responded ボタンを動的に追加/削除する。
// 自チャンネル設定変更 (= configured 追加/削除) で SSE が来た瞬間に既存コメへ反映。
// addComment は 1 件ずつ append + 再 render しないので、これがないと既存コメは
// configured 変更後も古い状態のまま固定されてしまう。
function applyIsOwnStreamToCommentList() {
  if (!commentList) return;
  var items = commentList.querySelectorAll('.comment-item');
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var existingBtn = item.querySelector('.kh-toggle-responded');
    if (isOwnStream && !existingBtn) {
      // ボタンを動的に追加 (= shared/comment-item.js の同等ロジックを抜粋)
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kh-toggle-responded';
      btn.title = '対応済みにする / 戻す';
      var responded = item.dataset.responded === '1';
      btn.dataset.responded = responded ? '1' : '0';
      btn.textContent = '✓';
      (function (cell, button) {
        button.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var commentId = cell.dataset.id || '';
          var prev = button.dataset.responded === '1';
          toggleCommentResponded(commentId, !prev);
        });
      }(item, btn));
      item.appendChild(btn);
    } else if (!isOwnStream && existingBtn) {
      existingBtn.remove();
    }
  }
}

// コメ「対応済み」トグル。設計: docs/architecture/remote-viewing-redesign.md §7.1
// 即時 optimistic UI 更新 → API 呼び出し → Snackbar Undo (5 秒) を出す。
// SSE comment-responded event で他の端末からのトグルも追従できる (= updateCommentRespondedDom)。
function toggleCommentResponded(commentId, nextValue) {
  if (!commentId) return;
  if (!api || !api.comments || typeof api.comments.setResponded !== 'function') {
    rendererLog.warn('api.comments.setResponded is unavailable');
    return;
  }
  rendererLog.info('user: comment-responded-toggle, commentId=' + commentId + ', responded=' + !!nextValue);
  // optimistic update: 該当する全 comment-item の dataset を一括書き換え
  updateCommentRespondedDom(commentId, !!nextValue);
  api.comments.setResponded(commentId, !!nextValue).then(function (resp) {
    if (!resp || !resp.ok) {
      // 失敗時はロールバック + エラー Snackbar (= 失敗の事実は伝える)
      updateCommentRespondedDom(commentId, !nextValue);
      window.KomehubShared.showUndoSnackbar({
        message: '更新に失敗しました',
        actionLabel: '再試行',
        onAction: function () { toggleCommentResponded(commentId, nextValue); }
      });
      return;
    }
    // 成功時は Undo Snackbar を出さない (= 邪魔。戻したければもう一度クリックすれば良い)
  }).catch(function (err) {
    updateCommentRespondedDom(commentId, !nextValue);
    rendererLog.error('setResponded failed', err);
  });
}

// 該当する .comment-item の dataset.responded と内部のトグルボタン状態を in-place 更新する。
// SSE で他端末からの変更を受信した時にも使う (= 全 rebuild 禁止ルール準拠)。
function updateCommentRespondedDom(commentId, isResponded) {
  if (!commentId) return;
  var safe = String(commentId).replace(/"/g, '\\"');
  var nodes = document.querySelectorAll('.comment-item[data-id="' + safe + '"]');
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    node.dataset.responded = isResponded ? '1' : '0';
    var btn = node.querySelector('.kh-toggle-responded');
    if (btn) btn.dataset.responded = isResponded ? '1' : '0';
  }
}

// SSE 購読: 他端末 (= remote view 等) からの comment-responded トグル変更を受信して
// 本体 UI に同期する。本体での optimistic update 後に echo として戻ってくる場合も
// 同じ値で書き換えるだけなので無害。
if (api && api.onCommentResponded) {
  api.onCommentResponded(function (data) {
    if (!data || !data.commentId) return;
    var isResponded = data.respondedAt > 0;
    updateCommentRespondedDom(data.commentId, isResponded);
    // 配信詳細モーダルが開いていて、対象コメがその配信枠のものなら、
    // 「未対応」chip count を in-place で更新する (= 全 rebuild 禁止ルール準拠)。
    sdApplyCommentResponded(data.commentId, isResponded);
    // ギフトタブの未対応ピル: 該当コメが現枠のロード済みギフトに含まれていれば ±1。
    if (loadedGiftIds.has(data.commentId)) {
      unrespondedGiftCount = Math.max(0, unrespondedGiftCount + (isResponded ? -1 : 1));
      updateGiftUnrespondedPin();
    }
  });
}

// 配信詳細モーダルの chip count + allCommentRows を SSE comment-responded で in-place 更新。
// 全 rebuild は禁止 (CLAUDE.md 準拠) なので、対象の chip span の数字だけ書き換える。
function sdApplyCommentResponded(commentId, isResponded) {
  if (typeof sdState === 'undefined' || !sdState || !sdState.allCommentRows) return;
  // 該当コメがこの配信枠の (= partial cache に乗っている) ものか確認。
  // allCommentRows[i].id は DB 由来で yt- prefix 付き、commentId は SSE 由来で
  // prefix なし (= commentRowToCellData で stripping した後の値)。両方 normalize して比較。
  var normalizedTarget = String(commentId || '').replace(/^yt-/, '');
  var matched = false;
  for (var i = 0; i < sdState.allCommentRows.length; i++) {
    var rowId = String(sdState.allCommentRows[i].id || '').replace(/^yt-/, '');
    if (rowId === normalizedTarget) {
      sdState.allCommentRows[i].respondedAt = isResponded ? Date.now() : 0;
      matched = true;
      break;
    }
  }
  if (!matched) return;
  if (!sdState.chipCounts || typeof sdState.chipCounts.unresponded !== 'number') return;
  sdState.chipCounts.unresponded = Math.max(0, sdState.chipCounts.unresponded + (isResponded ? -1 : 1));
  var chipsRow = document.getElementById('sd-comment-filter-chips');
  if (!chipsRow) return;
  var span = chipsRow.querySelector('[data-chip-id="unresponded"] .ct');
  if (span) span.textContent = String(sdState.chipCounts.unresponded);
}

// 2026-05-09 仕様変更: 配信者の管理 UI 上で「コメ非表示」「リスナー非表示」を担う Set。
// SSE listener-hidden で update。テンプレート / OBS 側には影響しない (= broadcast 自体は素のまま)。
var hiddenForComments = new Set();
var hiddenForListeners = new Set();

function isListenerCommentsHidden(listenerId) {
  if (!listenerId) return false;
  return hiddenForComments.has(String(listenerId).replace(/^yt-/, ''));
}

function refreshHiddenSetsFromBackend() {
  if (!api.listeners || typeof api.listeners.getHidden !== 'function') return;
  api.listeners.getHidden().then(function (users) {
    hiddenForComments = new Set();
    hiddenForListeners = new Set();
    (users || []).forEach(function (u) {
      var id = String(u.id || '').replace(/^yt-/, '');
      if (!id) return;
      if (u.hideFromComments) hiddenForComments.add(id);
      if (u.hideFromListeners) hiddenForListeners.add(id);
    });
  });
}
refreshHiddenSetsFromBackend();

if (api && api.onListenerHidden) {
  api.onListenerHidden(function (data) {
    if (!data || !data.listenerChannelId) return;
    var id = String(data.listenerChannelId).replace(/^yt-/, '');
    if (data.hideFromComments) { hiddenForComments.add(id); }
    else { hiddenForComments.delete(id); }
    if (data.hideFromListeners) { hiddenForListeners.add(id); }
    else { hiddenForListeners.delete(id); }
    // listener 一覧画面が開いていれば 1 行除外/復帰のため refresh をかける
    if (typeof scheduleListenerAutoRefresh === 'function') scheduleListenerAutoRefresh();
  });
}

function addComment(data) {
  // hideFromComments: 配信者の管理 UI には出さない。テンプレ / OBS には影響しない (= broadcast 自体は流れ続ける)
  var listenerId = data && (data.userId || data.channelId || data.listenerChannelId);
  if (isListenerCommentsHidden(listenerId)) return;
  // is_backfill (= 接続直前の過去コメ) と通常コメで同じ id が二重に来る可能性がある
  // (= reconnect 時に initial 再送)。DOM に既に同 id があれば skip。
  if (data && data.id && commentList.querySelector('[data-id="' + String(data.id).replace(/"/g, '\\"') + '"]')) {
    return;
  }
  var empty = commentList.querySelector('.comment-empty-state');
  if (empty) empty.remove();
  var item = buildCommentItem(data);
  commentList.appendChild(item);

  // 自動スクロール（ユーザーが上にスクロール中は停止）
  if (autoScrollEnabled) {
    commentList.scrollTop = commentList.scrollHeight;
  }

  // 最大1000件に制限
  while (commentList.children.length > 1000) {
    commentList.removeChild(commentList.firstChild);
  }
}

// === ギフトタブ (Phase 4) ===
//
// 当該枠のスパチャ / ステッカー / メンバー加入 / メンバーギフトだけを
// 投稿時系列順 (古い順、autoScroll で底張り) に並べる「お礼漏れ防止」専用一覧。
// セルはコメ tab と同じ buildCommentItem を使う (= 同じ操作系・同じ見た目)。
//
// 「ギフト」の定義 = お金を投げる行為 (= superchat + sticker + membership_gift の 3 種)。
// メンバー加入 (= membership) はお金を投げる行為ではないので除外する。
// (= cs-form の「ギフト」pill / sdBuildSearchQuery の「SC のみ」chip と整合)
//
// データソース:
//   - 初期ロード: api.listeners.searchComments({streamIds, commentTypes:['superchat','sticker','gift'], limit:500})
//     → CommentRow[] (posted_at DESC) を reverse して古い順に append
//   - リアルタイム: SSE comment イベントで isGiftComment() で抽出して append
// 配信切替 (videoId 変化) でリセット + 再ロード。disconnect で clear。
//
// 重複防止: loadedGiftIds Set で初期ロード分と SSE 後続分の dedupe。
// CommentRow.id と SSE comment.data.id が同じであることを前提。

var loadedGiftIds = new Set();
var loadedGiftStreamId = '';
// 現枠で「未対応」(= responded_at == 0) の状態にあるギフト件数。タブの開閉とは独立で、
// ユーザーが「対応済み」トグルを ON / OFF した時のみ増減する。ヘッダのピル
// (#cl-tab-unresponded-gifts) で可視化する。「捌くべき残件」の指標であり、
// 「未読」(= 開いていない期間に来た新着) ではない点に注意。
// 単一更新源は SSE comment-responded ハンドラ (= 配信詳細モーダルの未対応 chip と同じ
// 流儀)。optimistic UI 経路では更新しない。
var unrespondedGiftCount = 0;

// 「ギフト」= お金を投げる行為 (= スパチャ + ステッカー + メンバーシップギフト)。
// 「メンバー加入」(isMembership) はお金を投げる行為ではないので除外。
// classify_comment_type (core/src/engine/listener_manager.rs:4226) と整合:
//   has_gift → Superchat / sticker_image → Sticker / is_membership_gift → Gift
function isGiftComment(data) {
  if (!data) return false;
  return !!(
    data.hasGift ||
    data.isMembershipGift ||
    (typeof data.stickerImage === 'string' && data.stickerImage)
  );
}

function renderGiftEmptyState(message) {
  if (!giftList || giftList.querySelector('.comment-item')) return;
  giftList.innerHTML = '<div class="gift-empty-state" style="padding:24px 12px;color:#5a6a78;font-size:12px;text-align:center">'
    + message
    + '</div>';
}

function refreshGiftEmptyState() {
  if (!giftList || giftList.querySelector('.comment-item')) return;
  if (!currentStreamVideoId) {
    renderGiftEmptyState('配信に接続すると、この枠のギフトが表示されます。');
  } else {
    renderGiftEmptyState('この枠のギフトはまだありません。<br>スパチャ、ステッカー、メンバーシップギフトが届くと、ここに表示されます。');
  }
}

function updateGiftTabCount() {
  var ct = document.getElementById('cl-tab-ct-gifts');
  if (!ct) return;
  var n = giftList ? giftList.querySelectorAll('.comment-item').length : 0;
  ct.textContent = n > 0 ? String(n) : '';
}

// 未対応ギフト件数のピルを更新。0 件なら hide。
function updateGiftUnrespondedPin() {
  var pin = document.getElementById('cl-tab-unresponded-gifts');
  if (!pin) return;
  if (unrespondedGiftCount > 0) {
    pin.textContent = String(unrespondedGiftCount);
    pin.style.display = '';
  } else {
    pin.style.display = 'none';
  }
}

function appendGiftCard(data) {
  if (!giftList || !data || !data.id) return;
  if (loadedGiftIds.has(data.id)) return;
  loadedGiftIds.add(data.id);
  var listenerId = data.userId || data.channelId || data.listenerChannelId;
  if (isListenerCommentsHidden(listenerId)) return;
  var empty = giftList.querySelector('.gift-empty-state');
  if (empty) empty.remove();
  var item = buildCommentItem(data);
  giftList.appendChild(item);
  updateGiftTabCount();
  // 新着 SSE のギフトは常に未対応 (= 直前に到着したので responded_at は 0)。
  // タブの active / 非 active は関係ない。
  unrespondedGiftCount += 1;
  updateGiftUnrespondedPin();
  if (giftAutoScrollEnabled) {
    giftList.scrollTop = giftList.scrollHeight;
  }
}

function clearGifts() {
  if (giftList) giftList.innerHTML = '';
  loadedGiftIds = new Set();
  loadedGiftStreamId = '';
  unrespondedGiftCount = 0;
  updateGiftTabCount();
  updateGiftUnrespondedPin();
  refreshGiftEmptyState();
}

function loadGiftsForStream(videoId) {
  if (!giftList) return;
  if (!videoId) {
    clearGifts();
    return;
  }
  if (videoId === loadedGiftStreamId) return; // 同じ枠への再呼び出しは no-op
  if (!api || !api.listeners || typeof api.listeners.searchComments !== 'function') return;
  clearGifts();
  renderGiftEmptyState('ギフトを読み込んでいます。');
  loadedGiftStreamId = videoId;
  api.listeners.searchComments({
    streamIds: [videoId],
    scope: 'all',
    // 「お金を投げる行為」3 種のみ (isGiftComment と整合)。membership 加入は除外。
    commentTypes: ['superchat', 'sticker', 'gift'],
    limit: 500,
    offset: 0,
    includeKpi: false
  }).then(function (resp) {
    // 切替判定: 取得中に別の枠へ切替えていた場合は破棄
    if (loadedGiftStreamId !== videoId) return;
    if (!resp || !resp.ok || !resp.page || !Array.isArray(resp.page.rows)) return;
    // CommentsPage.rows は posted_at DESC (= 最新が先頭)。表示は古い順 → reverse
    var rows = resp.page.rows.slice().reverse();
    for (var i = 0; i < rows.length; i++) {
      var data = commentRowToCellData(rows[i]);
      if (!data || !data.id) continue;
      if (loadedGiftIds.has(data.id)) continue;
      var listenerId = rows[i].listenerChannelId || data.userId || '';
      if (isListenerCommentsHidden(listenerId)) continue;
      loadedGiftIds.add(data.id);
      var empty = giftList.querySelector('.gift-empty-state');
      if (empty) empty.remove();
      giftList.appendChild(buildCommentItem(data));
      // 初期ロード時点で未対応 (= responded_at == 0) のものをカウント。
      if (!(data.respondedAt > 0)) unrespondedGiftCount += 1;
    }
    updateGiftTabCount();
    updateGiftUnrespondedPin();
    refreshGiftEmptyState();
    if (giftAutoScrollEnabled) giftList.scrollTop = giftList.scrollHeight;
  }).catch(function (err) {
    rendererLog.error('loadGiftsForStream failed', err);
    if (loadedGiftStreamId === videoId && giftList && !giftList.querySelector('.comment-item')) {
      giftList.innerHTML = '<div style="padding:24px 12px;color:#ffb74d;font-size:12px;text-align:center">ギフトの取得に失敗しました。</div>';
    }
  });
}

function listenerTriggerLabel(status) {
  switch (status) {
    case 'first-time': return '初見のみ';
    case 'returning': return '再訪のみ';
    case 'regular-arrival': return '今北のみ';
    case 'long-absence': return '帰還のみ';
    case 'regular': return '常連のみ';
    default: return '';
  }
}

function listenerAtomicConditionLabel(value, yesLabel, noLabel) {
  switch (value) {
    case 'yes': return yesLabel;
    case 'no': return noLabel;
    default: return '';
  }
}

function listenerConditionSummary(trigger) {
  if (!trigger) return '';
  var parts = [];
  var preset = listenerTriggerLabel(trigger.listenerStatus);
  if (preset) parts.push(preset);
  var prior = listenerAtomicConditionLabel(trigger.listenerHasPriorComment, '過去あり', '過去なし');
  var stream = listenerAtomicConditionLabel(trigger.listenerFirstCommentInStream, '配信初コメ', '配信2回目以降');
  var regular = listenerAtomicConditionLabel(trigger.listenerRegular, '常連', '常連以外');
  [prior, stream, regular].forEach(function (label) {
    if (label) parts.push(label);
  });
  return parts.join(' + ');
}

function hasCustomListenerCondition(trigger) {
  return !!(trigger && (
    trigger.listenerHasPriorComment ||
    trigger.listenerFirstCommentInStream ||
    trigger.listenerRegular
  ));
}

// === シーン管理UI ===

var selectedSceneId = 'chat';
// currentPort は 63行目で既に宣言済み

// 既存のonPortリスナーを拡張（63行目のcurrentPortを更新後にシーンUIもリフレッシュ）
var _origOnPortHandler = null;
(function () {
  // 既存のonPortで更新されたcurrentPortを使ってシーンUIを更新
  var checkPort = setInterval(function () {
    if (currentPort !== 11280) {
      clearInterval(checkPort);
      refreshSceneUI();
    }
  }, 200);
  // 3秒後にも一度確認（ポートが11280のままの場合）
  setTimeout(function () {
    clearInterval(checkPort);
    refreshSceneUI();
  }, 3000);
})();

// サイドバー折りたたみ
(function () {
  var toggle = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      toggle.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
    });
  }
})();

// アプリ枠折りたたみ (= 旧 sidebar レイアウト時代のハンドラ)。
// #apps-header DOM は UI 整理 Phase 1 で撤去済 → 現在は getElementById が null
// を返して no-op。将来 UI を再編して折りたたみが復活する可能性があるので、
// ハンドラ本体は残置する。再利用時は対応する DOM (apps-header / apps-section
// の collapsed CSS) を index.html / style.css に戻すこと。
(function () {
  var header = document.getElementById('apps-header');
  var section = document.getElementById('apps-section');
  if (header && section) {
    header.addEventListener('click', function () {
      section.classList.toggle('collapsed');
    });
  }
})();

// 演出全停止ボタン
(function () {
  var btn = document.getElementById('pause-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      api.getPaused().then(function (paused) {
        api.setPaused(!paused);
        btn.classList.toggle('active', !paused);
        btn.textContent = !paused ? '▶ 再開' : '⏸ 演出全停止';
      });
    });
  }

  var clearBtn = document.getElementById('clear-performances-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      if (!selectedSceneId || !api.clearPerformances) return;
      clearBtn.disabled = true;
      Promise.resolve(api.clearPerformances(selectedSceneId)).catch(function () {
        /* noop */
      }).then(function () {
        clearBtn.disabled = false;
      });
    });
  }
})();

// エフェクトのアイコン文字列を取得（絵文字 or フォールバック）
function effectIcon(effectId) {
  var effs = cachedEffects || [];
  for (var i = 0; i < effs.length; i++) {
    if (effs[i].id === effectId && effs[i].icon) return effs[i].icon;
  }
  return '✨';
}

// エフェクトのバッジ色を取得
function effectBadgeColor(effectId) {
  var effs = cachedEffects || [];
  for (var i = 0; i < effs.length; i++) {
    if (effs[i].id === effectId && effs[i].badgeColor) return effs[i].badgeColor;
  }
  return { bg: '#1a2742', fg: '#94a3b8' };
}

// アイコン表示要素を生成（絵文字テキスト or 画像）
function createEffectIconEl(icon, size) {
  size = size || 16;
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(icon)) {
    var img = document.createElement('img');
    img.src = icon;
    img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;object-fit:contain;vertical-align:middle;';
    return img;
  }
  var span = document.createElement('span');
  span.textContent = icon || '✨';
  span.style.fontSize = size + 'px';
  return span;
}

// 設定画面が開いているかどうか
function isSettingsOpen() {
  var perfList = document.getElementById('performance-list-section');
  var perfEdit = document.getElementById('performance-edit-section');
  var effectMgr = document.getElementById('effect-manager-section');
  var appConfig = document.getElementById('app-config-section');
  var tmplEdit = document.getElementById('template-edit-section');
  var ttsEdit = document.getElementById('tts-edit-section');
  var notifEdit = document.getElementById('notification-edit-section');
  var notifEvEdit = document.getElementById('notification-event-edit-section');
  return (perfList && perfList.style.display !== 'none') ||
         (perfEdit && perfEdit.style.display !== 'none') ||
         (effectMgr && effectMgr.style.display !== 'none') ||
         (appConfig && appConfig.style.display !== 'none') ||
         (tmplEdit && tmplEdit.style.display !== 'none') ||
         (ttsEdit && ttsEdit.style.display !== 'none') ||
         (notifEdit && notifEdit.style.display !== 'none') ||
         (notifEvEdit && notifEvEdit.style.display !== 'none');
}

function isTemplateSettingsOpen() {
  var tmplEdit = document.getElementById('template-edit-section');
  return !!(tmplEdit && tmplEdit.style.display !== 'none');
}

function guardSceneSideWhileTemplateEditing() {
  if (!isTemplateSettingsOpen()) return false;
  showAlertDialog('テンプレート設定中はシーン側を操作できません。先にテンプレート設定を閉じてください。');
  return true;
}

// シーン一覧のロック状態を更新
function updateSceneLock() {
  var locked = isTemplateSettingsOpen();
  var items = document.querySelectorAll('.scene-item');
  for (var i = 0; i < items.length; i++) {
    items[i].draggable = !locked;
    items[i].style.opacity = locked ? '0.4' : '';
    items[i].style.cursor = locked ? 'not-allowed' : '';
    items[i].title = locked ? 'テンプレート設定中はシーン操作できません' : '';
  }
  var addBtn = document.getElementById('add-scene-btn');
  if (addBtn) {
    addBtn.disabled = locked;
    addBtn.style.opacity = locked ? '0.4' : '';
    addBtn.style.cursor = locked ? 'not-allowed' : '';
    addBtn.title = locked ? 'テンプレート設定中はシーン操作できません' : '';
  }
  var importBtn = document.getElementById('import-scene-btn');
  if (importBtn) {
    importBtn.disabled = locked;
    importBtn.style.opacity = locked ? '0.4' : '';
    importBtn.style.cursor = locked ? 'not-allowed' : '';
    importBtn.title = locked ? 'テンプレート設定中はシーン操作できません' : '';
  }
}

// シーン一覧の読み込みと表示
function refreshSceneUI() {
  Promise.all([
    api.getSceneList(),
    api.getSelectedScene()
  ]).then(function (results) {
    var scenes = results[0];
    selectedSceneId = results[1] || 'chat';
    renderSceneList(scenes);
    renderApps();
  });
}

// シーン識別色のプリセットパレット。シーンリストの並び順 index で割り当て、6 個目以降は
// ループする (= 自動。手動指定なし)。暗背景で読みやすく相互に判別しやすい 6 色。
// 黄/琥珀は GLOBAL セクションの eyebrow (#fbbf24) と被るため除外。index 2 (= 既定シーン順で
// 歌枠) を紫にしている。左リストのシーン名 + 右パネルのシーン名を同色にして「右に表示中の
// シーンが左のどれか」を色で直結する (= 選択ハイライトだけでは判別しにくい問題への対処)。
// 空 / 緑 / 紫 / 桃 / 薔薇 / 橙
var SCENE_PALETTE = ['#38bdf8', '#34d399', '#a78bfa', '#f472b6', '#fb7185', '#fb923c'];
// 現在の並び順で確定した scene.id → 色。renderSceneList が再構築し、renderApps が右パネルで参照する。
var sceneColorById = Object.create(null);
function sceneColorForIndex(i) {
  return SCENE_PALETTE[((i % SCENE_PALETTE.length) + SCENE_PALETTE.length) % SCENE_PALETTE.length];
}

function renderSceneList(scenes) {
  var list = document.getElementById('scene-list');
  if (!list) return;
  list.innerHTML = '';

  var dragSrcScene = null;
  sceneColorById = Object.create(null);

  scenes.forEach(function (scene, sceneIndex) {
    var item = document.createElement('div');
    item.className = 'scene-item' + (scene.id === selectedSceneId ? ' selected' : '');
    item.setAttribute('data-scene-id', scene.id);
    // 識別色を index で割り当て、CSS 変数で .scene-name / .selected バー / バッジ へ流す。
    var sceneColor = sceneColorForIndex(sceneIndex);
    sceneColorById[scene.id] = sceneColor;
    item.style.setProperty('--scene-color', sceneColor);
    item.draggable = !isTemplateSettingsOpen();

    // ドラッグ&ドロップ
    item.addEventListener('dragstart', function (e) {
      if (guardSceneSideWhileTemplateEditing()) { e.preventDefault(); return; }
      dragSrcScene = item;
      setInternalReorderDragActive(true);
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', scene.id);
    });
    item.addEventListener('dragend', function () {
      item.style.opacity = '';
      dragSrcScene = null;
      setInternalReorderDragActive(false);
      list.querySelectorAll('.scene-item').forEach(function (el) { el.classList.remove('scene-drag-over'); });
    });
    item.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcScene && dragSrcScene !== item) {
        item.classList.add('scene-drag-over');
      }
    });
    item.addEventListener('dragleave', function () {
      item.classList.remove('scene-drag-over');
    });
    item.addEventListener('drop', function (e) {
      e.preventDefault();
      item.classList.remove('scene-drag-over');
      if (!dragSrcScene || dragSrcScene === item) return;

      var items = Array.from(list.querySelectorAll('.scene-item'));
      var fromIdx = items.indexOf(dragSrcScene);
      var toIdx = items.indexOf(item);
      if (fromIdx < toIdx) {
        list.insertBefore(dragSrcScene, item.nextSibling);
      } else {
        list.insertBefore(dragSrcScene, item);
      }

      var orderedIds = Array.from(list.querySelectorAll('.scene-item')).map(function (el) {
        return el.getAttribute('data-scene-id');
      });
      api.reorderScenes(orderedIds);
    });

    // off class は scene-item 自体に付与 (= mock 仕様、scene-power は ::after で dot 表現)
    if (!scene.enabled) item.classList.add('off');

    var power = document.createElement('span');
    power.className = 'scene-power';
    power.title = 'ON / OFF';
    power.addEventListener('click', function (e) {
      e.stopPropagation();
      if (guardSceneSideWhileTemplateEditing()) return;
      api.setSceneEnabled(scene.id, !scene.enabled);
    });

    var name = document.createElement('span');
    name.className = 'scene-name';
    name.textContent = scene.name;

    var meta = document.createElement('span');
    meta.className = 'scene-meta';
    var perfSpan = document.createElement('span');
    perfSpan.className = 'perf';
    perfSpan.textContent = String(scene.performanceCount || 0);
    meta.appendChild(perfSpan);

    item.appendChild(power);
    item.appendChild(name);
    item.appendChild(meta);

    item.addEventListener('click', function () {
      if (guardSceneSideWhileTemplateEditing()) return;
      rendererLog.info('user: scene-switch, sceneId=' + scene.id);
      api.setSelectedScene(scene.id);
    });

    // 右クリックメニュー
    item.addEventListener('contextmenu', function (e) {
      if (guardSceneSideWhileTemplateEditing()) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      removeContextMenu();

      var menu = document.createElement('div');
      activeContextMenu = menu;
      menu.style.cssText = 'position:fixed;z-index:9999;background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:4px 0;min-width:150px;box-shadow:0 4px 20px rgba(0,0,0,0.5);';
      menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';

      // 名前変更
      var renameItem = document.createElement('div');
      renameItem.style.cssText = 'padding:6px 12px;font-size:13px;color:#d8e8e8;cursor:pointer;';
      renameItem.textContent = '名前を変更';
      renameItem.addEventListener('mouseenter', function () { renameItem.style.background = '#1a3a4a'; });
      renameItem.addEventListener('mouseleave', function () { renameItem.style.background = ''; });
      renameItem.addEventListener('click', function () {
        removeContextMenu();
        showPromptDialog('新しいシーン名を入力', scene.name, function (newName) {
          if (newName && newName !== scene.name) {
            rendererLog.info('user: scene-rename, sceneId=' + scene.id + ', newName=' + newName);
            api.renameScene(scene.id, newName);
          }
        });
      });
      menu.appendChild(renameItem);

      // 複製
      var dupItem = document.createElement('div');
      dupItem.style.cssText = 'padding:6px 12px;font-size:13px;color:#d8e8e8;cursor:pointer;';
      dupItem.textContent = '複製';
      dupItem.addEventListener('mouseenter', function () { dupItem.style.background = '#1a3a4a'; });
      dupItem.addEventListener('mouseleave', function () { dupItem.style.background = ''; });
      dupItem.addEventListener('click', function () {
        removeContextMenu();
        showPromptDialog('複製後のシーン名を入力', scene.name + ' (コピー)', function (newName) {
          if (newName) {
            rendererLog.info('user: scene-duplicate, sceneId=' + scene.id + ', newName=' + newName);
            api.duplicateScene(scene.id, newName);
          }
        });
      });
      menu.appendChild(dupItem);

      // エクスポート
      var exportItem = document.createElement('div');
      exportItem.style.cssText = 'padding:6px 12px;font-size:13px;color:#d8e8e8;cursor:pointer;';
      exportItem.textContent = 'エクスポート';
      exportItem.addEventListener('mouseenter', function () { exportItem.style.background = '#1a3a4a'; });
      exportItem.addEventListener('mouseleave', function () { exportItem.style.background = ''; });
      exportItem.addEventListener('click', function () {
        removeContextMenu();
        rendererLog.info('user: scene-export (context-menu), sceneId=' + scene.id);
        api.exportScene(scene.id, scene.name).then(function (result) {
          if (!result || result.ok || result.cancelled) return;
          showZipActionError(result, 'シーンのエクスポートに失敗しました。');
        });
      });
      menu.appendChild(exportItem);

      // 区切り線
      var sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:#1a3a4a;margin:4px 0;';
      menu.appendChild(sep);

      // 削除
      var deleteItem = document.createElement('div');
      deleteItem.style.cssText = 'padding:6px 12px;font-size:13px;color:#ef4444;cursor:pointer;';
      deleteItem.textContent = '削除';
      deleteItem.addEventListener('mouseenter', function () { deleteItem.style.background = '#1a3a4a'; });
      deleteItem.addEventListener('mouseleave', function () { deleteItem.style.background = ''; });
      deleteItem.addEventListener('click', function () {
        removeContextMenu();
        if (scenes.length <= 1) {
          showPromptDialog('最後のシーンは削除できません。', null, function () {});
          return;
        }
        showPromptDialog('「' + scene.name + '」を削除しますか？\nこのシーンの演出設定はすべて失われます。', null, function (ok) {
          if (!ok) return;
          rendererLog.info('user: scene-delete, sceneId=' + scene.id);
          api.deleteScene(scene.id).then(function () {
            // 削除した scene が選択中だった場合のみ次の scene を選び直す。
            // 選び直しは setSelectedScene → broadcast 経由で再描画される。
            if (selectedSceneId === scene.id) {
              api.getSceneList().then(function (remaining) {
                if (remaining.length > 0) {
                  api.setSelectedScene(remaining[0].id);
                }
              });
            }
          });
        });
      });
      menu.appendChild(deleteItem);

      document.body.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', function handler() {
          removeContextMenu();
          document.removeEventListener('click', handler);
        });
      }, 0);
    });

    list.appendChild(item);
  });
}

function renderApps() {
  var appList = document.getElementById('app-list');
  var sceneName = document.getElementById('apps-scene-name');
  if (!appList) return;

  api.getScene(selectedSceneId).then(function (scene) {
    if (!scene) return;
    if (sceneName) {
      sceneName.textContent = scene.name;
      // 右パネルのシーン名 + ヘッダ左バー + eyebrow + カードタイトルを左リストの選択中シーンと
      // 同じ識別色にする。--scene-color を SCENE の .content-section に付与し、head と #app-list
      // 内のカード (.unit-name) の両方に継承させる (= head だけだとカードに届かない)。
      var sceneColor = sceneColorById[selectedSceneId] || SCENE_PALETTE[0];
      var sceneSection = sceneName.closest('.content-section');
      if (sceneSection) sceneSection.style.setProperty('--scene-color', sceneColor);
    }

    appList.innerHTML = '';

    // コメント連動演出 (= performancesEnabled の ON/OFF トグル + 全体設定 + ポン出し画面 + ポン出しバー)
    var perfEnabled = scene.performancesEnabled !== false;
    var effectsCard = createAppCard(
      'コメント連動演出',
      buildLocalHttpUrl('/effects/' + selectedSceneId + '/'),
      function () { openPerformanceList(); },
      scene.performances ? scene.performances.length + ' 演出' : '0 演出',
      null,
      perfEnabled,
      function (ctx) {
        // saveScene は短い async なので楽観的に視覚切替し、応答後に renderApps で確定する。
        var nextEnabled = !perfEnabled;
        rendererLog.info('user: performances-enabled-toggle, enabled=' + nextEnabled);
        if (ctx && typeof ctx.setVisualToggle === 'function') ctx.setVisualToggle(nextEnabled);
        var nextScene = Object.assign({}, scene, { performancesEnabled: nextEnabled });
        api.saveScene(selectedSceneId, nextScene).then(function () {
          renderApps();
        }).catch(function (err) {
          rendererLog.debug('saveScene (performancesEnabled) failed:', err);
          renderApps();
        });
      },
      [
        {
          label: '▶ ポン出し画面',
          title: 'ポン出し操作 UI を別ウィンドウで開く',
          variant: 'ponout',
          onClick: function () {
            if (window.api && window.api.ponout && window.api.ponout.open) {
              window.api.ponout.open();
            }
          }
        }
      ],
      { iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' }
    );
    appList.appendChild(effectsCard);
    // ポン出しバーを演出カードの中に表示
    var ponoutBar = document.getElementById('ponout-bar');
    if (ponoutBar) effectsCard.appendChild(ponoutBar);

    var ttsBadge = ttsBadgeText();
    // モック合意: URL 行 (= 旧「音声ソース経由で配信に乗せます」) は撤去。
    // テスト/クリアの 2 ボタンも撤去 (テストは設定モーダルへ移植、クリアは廃止)。
    var ttsCard = createAppCard(
      'コメント読み上げ',
      '',
      showTtsSettings,
      ttsBadge,
      null,
      ttsState.enabled,
      function (ctx) {
        // Rust 側の処理 (clear_pending / taskkill / save) に時間がかかることがあるため、
        // 押した瞬間にボタンを「処理中…」表示で disable し、応答が戻ってから確定描画する。
        if (ttsBusy) return;
        ttsBusy = true;
        if (ctx && typeof ctx.markBusy === 'function') ctx.markBusy();
        var nextEnabled = !ttsState.enabled;
        rendererLog.info('user: tts-enabled-toggle, enabled=' + nextEnabled);
        api.ttsSetEnabled(nextEnabled).then(function (state) {
          if (state) ttsState = state;
        }).catch(function () {
          return api.ttsGetState().then(function (state) {
            if (state) ttsState = state;
          }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
        }).then(function () {
          ttsBusy = false;
          renderApps();
        });
      },
      [
        {
          // ラベルは「一時停止」固定。active 中 (paused=true) は amber 発光で
          // 「今止まっている」状態を表す (ponout UI と同じ)。
          label: '⏸ 一時停止',
          title: 'クリックで一時停止 / 再度クリックで再開',
          variant: 'amber',
          active: ttsState.paused,
          disabled: !ttsState.enabled,
          onClick: function () {
            var nextPaused = !ttsState.paused;
            rendererLog.info('user: tts-paused-toggle, paused=' + nextPaused);
            api.ttsSetPaused(nextPaused).then(function (state) {
              if (state) ttsState = state;
              renderApps();
            });
          }
        }
      ],
      { global: true, urlPlaceholder: false, iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>' }
    );
    var globalList = document.getElementById('global-list');
    if (globalList) {
      globalList.innerHTML = '';
      globalList.appendChild(ttsCard);
    } else {
      // fallback: GLOBAL コンテナが無ければ apps-list 末尾 (= 旧構造互換)
      appList.appendChild(ttsCard);
    }
    ttsBadgeRef = ttsCard.querySelector('.app-card-badge');
    // 初期表示で providerStatus に応じた色を反映 (createAppCard の既定色を上書き) +
    // VOICEVOX 利用中なら speakers の lazy fetch を内側でキック
    applyTtsBadgeAppearance(ttsBadgeRef);

    // --- コメント通知カード (Phase A: UI スケルトン) ---
    // 配置: GLOBAL コメント読み上げ直下。 トグル / 一時停止 / 設定の構造は TTS と揃える。
    var notifCard = createAppCard(
      'コメント通知',
      '',
      showNotificationSettings,
      notificationBadgeText(),
      null,
      notificationState.enabled,
      function (ctx) {
        if (notificationBusy) return;
        notificationBusy = true;
        var nextEnabled = !notificationState.enabled;
        rendererLog.info('user: notification-enabled-toggle, enabled=' + nextEnabled);
        // 通知は app-config 保存だけの短い async なので、 楽観的に視覚切替して
        // 応答を待たずに即反応させる。 失敗時は renderApps の再描画で正しい状態に戻る。
        if (ctx && typeof ctx.setVisualToggle === 'function') {
          ctx.setVisualToggle(nextEnabled);
        }
        notificationState.enabled = nextEnabled;
        api.notificationSetEnabled(nextEnabled).then(function (state) {
          if (state) notificationState = state;
        }).catch(function () {
          return api.notificationGetState().then(function (state) {
            if (state) notificationState = state;
          }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
        }).then(function () {
          notificationBusy = false;
          renderApps();
        });
      },
      [
        {
          // active 中 (= 一時停止中) はラベルを切り替えて 「今止まっている」 を文字でも明示する。
          // 再起動時には Rust 側で paused=false に強制リセットされる (= セッション内 pause 扱い)。
          label: notificationState.paused ? '⏸ 一時停止中' : '⏸ 一時停止',
          title: 'クリックで一時停止 / 再度クリックで再開',
          variant: 'amber',
          active: notificationState.paused,
          disabled: !notificationState.enabled,
          onClick: function () {
            var nextPaused = !notificationState.paused;
            rendererLog.info('user: notification-paused-toggle, paused=' + nextPaused);
            api.notificationSetPaused(nextPaused).then(function (state) {
              if (state) notificationState = state;
              renderApps();
            });
          }
        }
      ],
      { global: true, urlPlaceholder: false, iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' }
    );
    if (globalList) {
      globalList.appendChild(notifCard);
    } else {
      appList.appendChild(notifCard);
    }
    notificationBadgeRef = notifCard.querySelector('.app-card-badge');
    applyNotificationBadgeAppearance(notificationBadgeRef);

    // ポン出しボタン
    renderPonoutButtons(scene);
  });
}

function providerLabelForTts(provider) {
  if (provider === 'none') return '読み上げ無し';
  if (provider === 'voicevox') return 'VOICEVOX';
  if (provider === 'bouyomi') return '棒読みちゃん';
  return '内蔵';
}

function showTtsSettings() {
  // section 表示 / enter は framework に委譲 (= SubsectionNav)
  var bodyEl = document.getElementById('tts-edit-body');
  if (!bodyEl) return;

  bodyEl.innerHTML = '';

  var statusEl = document.createElement('div');
  statusEl.style.cssText = 'display:none;border-radius:6px;font-size:12px;padding:8px 10px;margin-bottom:12px;';
  bodyEl.appendChild(statusEl);

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.style.display = message ? '' : 'none';
    statusEl.style.background = isError ? '#3b1111' : '#082f2a';
    statusEl.style.border = '1px solid ' + (isError ? '#7f1d1d' : '#166534');
    statusEl.style.color = isError ? '#fecaca' : '#bbf7d0';
  }

  var body = document.createElement('div');
  body.textContent = '読み込み中...';
  body.style.cssText = 'font-size:13px;color:#64748b;padding:8px 0;';
  bodyEl.appendChild(body);

  function createField(labelText, input) {
    var label = document.createElement('label');
    label.style.cssText = 'display:block;margin-bottom:12px;';
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
    titleEl.textContent = labelText;
    label.appendChild(titleEl);
    input.style.cssText += 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;';
    label.appendChild(input);
    return label;
  }

  function createFileField(labelText, input, button) {
    var label = document.createElement('label');
    label.style.cssText = 'display:block;margin-bottom:12px;';
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
    titleEl.textContent = labelText;
    label.appendChild(titleEl);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    input.style.cssText += 'flex:1;min-width:0;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;';
    button.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 10px;font-size:12px;color:#94a3b8;cursor:pointer;flex-shrink:0;';
    row.appendChild(input);
    row.appendChild(button);
    label.appendChild(row);
    return label;
  }

  function makeInput(type, value) {
    var input = document.createElement('input');
    input.type = type || 'text';
    input.value = value != null ? value : '';
    return input;
  }

  function makeSelect(options, value) {
    var select = document.createElement('select');
    options.forEach(function (opt) {
      var option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    });
    select.value = value;
    return select;
  }

  // providerOptions / findProviderOption は module-level の TTS_PROVIDER_OPTIONS /
  // findTtsProviderOption に集約 (= refreshTtsView から参照する必要があるため)。
  var providerOptions = TTS_PROVIDER_OPTIONS;
  var findProviderOption = findTtsProviderOption;

  function mergeProviderSettings(base, providerPatch, nextProvider) {
    var next = Object.assign({}, base || {});
    next.provider = nextProvider || next.provider || 'builtin';
    Object.keys(providerPatch || {}).forEach(function (key) {
      next[key] = providerPatch[key];
    });
    return next;
  }

  function refreshTtsStateFromCore() {
    if (!api.ttsGetState) return Promise.resolve(null);
    return api.ttsGetState().then(function (state) {
      if (state) ttsState = state;
      renderApps();
      return state;
    }).catch(function () { return null; });
  }

  function checkProviderAndRefresh(provider) {
    if (!api.ttsCheckProvider) return Promise.resolve({ ok: false, error: '接続確認に対応していません。' });
    return api.ttsCheckProvider(provider).then(function (result) {
      return refreshTtsStateFromCore().then(function () { return result; });
    });
  }

  function waitForProviderConnection(provider) {
    var startedAt = Date.now();
    var timeoutMs = provider === 'bouyomi' ? 15000 : 20000;
    var intervalMs = provider === 'bouyomi' ? 1000 : 1500;
    var lastResult = null;

    function attempt() {
      return checkProviderAndRefresh(provider).then(function (result) {
        lastResult = result;
        if (result && result.ok) return result;
        if (Date.now() - startedAt >= timeoutMs) {
          return lastResult || result || { ok: false, error: '接続確認がタイムアウトしました。' };
        }
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(attempt()); }, intervalMs);
        });
      });
    }

    return attempt();
  }

  function rememberProviderExecutablePath(settings, provider, path) {
    if (!path || provider === 'builtin' || !api.ttsSaveSettings) return Promise.resolve(settings);
    var current = settings && settings[provider] ? settings[provider] : {};
    if (current.executablePath) return Promise.resolve(settings);
    var next = Object.assign({}, settings || {});
    next[provider] = Object.assign({}, current, { executablePath: path });
    return api.ttsSaveSettings(next).then(function (saved) {
      if (saved) {
        ttsSettingsCache = saved;
        return saved;
      }
      return next;
    }).catch(function () { return settings; });
  }

  function detectAndRememberProviderExecutable(settings, provider, input) {
    if (!api.ttsDetectProviderExecutable || provider === 'builtin') return Promise.resolve(settings);
    var current = settings && settings[provider] ? settings[provider] : {};
    if (current.executablePath) return Promise.resolve(settings);
    return api.ttsDetectProviderExecutable(provider).then(function (result) {
      if (!result || !result.ok || !result.path) return settings;
      if (input) input.value = result.path;
      return rememberProviderExecutablePath(settings, provider, result.path);
    }).catch(function () { return settings; });
  }

  function render(settings) {
    body.innerHTML = '';
    body.style.cssText = '';
    setStatus('', false);

    // 子 section (= tts-provider-edit-section) から戻った時に差分更新するための ref
    ttsViewRefs = {
      stateMeta: null,
      stateToggle: null,
      providerRows: {},  // provider id → { rowEl, rowMetaEl }
    };

    var providerValue = settings.provider || 'builtin';

    function autoSave(patch) {
      var next = Object.assign({}, settings, patch || {});
      settings = next;
      api.ttsSaveSettings(next).then(function (saved) {
        if (saved) {
          settings = saved;
          ttsSettingsCache = saved;
          ttsState.enabled = !!saved.enabled;
          ttsState.provider = saved.provider || ttsState.provider;
        }
        renderApps();
      });
    }

    // ── 状態カード (master ON/OFF) ──
    // 設定画面で apps-section を隠しているため、ここに ON/OFF を置く。
    // 挙動はアプリ一覧カードの toggle と同じ (api.ttsSetEnabled 経由)。
    var stateCard = document.createElement('div');
    stateCard.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:12px;';
    var stateLeft = document.createElement('div');
    stateLeft.style.cssText = 'min-width:0;flex:1;';
    var stateName = document.createElement('div');
    stateName.style.cssText = 'font-size:13px;font-weight:600;color:#00bcd4;';
    stateName.textContent = 'コメント読み上げ';
    stateLeft.appendChild(stateName);
    var stateMeta = document.createElement('div');
    stateMeta.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px;';
    function updateStateMeta() {
      if (!settings.enabled) {
        stateMeta.textContent = 'OFF: コメントは読み上げません';
        return;
      }
      var providerLabel = providerLabelForTts(settings.provider);
      if (settings.provider === 'voicevox') {
        var vv = settings.voicevox || {};
        var info = lookupVoicevoxName(cachedVoicevoxSpeakers, vv.speakerUuid, vv.styleId);
        if (info) {
          var parts = [info.name, info.style].filter(function (s) { return s && s.length > 0; });
          stateMeta.textContent = providerLabel + ': ' + parts.join(' / ');
        } else {
          stateMeta.textContent = providerLabel;
        }
      } else {
        stateMeta.textContent = providerLabel;
      }
    }
    updateStateMeta();
    if (settings.enabled && settings.provider === 'voicevox' && !cachedVoicevoxSpeakers) {
      ensureVoicevoxSpeakers().then(function () {
        if (stateMeta.isConnected) updateStateMeta();
      });
    }
    stateLeft.appendChild(stateMeta);
    stateCard.appendChild(stateLeft);
    ttsViewRefs.stateMeta = stateMeta;

    var toggleBtn = document.createElement('button');
    var isOn = !!settings.enabled;
    // 「処理中…」が収まる幅を確保して固定する。ON/OFF 時に余白が出るが、
    // 状態によって幅が変動するより UI として安定する。cursor:wait はシステムスピナーが
    // 出るので使わない。
    var mtBase = 'border-radius:4px;padding:5px 14px;font-size:11px;cursor:pointer;flex-shrink:0;min-width:78px;text-align:center;';
    var mtOn = mtBase + 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;';
    var mtOff = mtBase + 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;';
    var mtBusy = mtBase + 'background:#1a2742;border:1px solid #475569;color:#94a3b8;';
    if (ttsBusy) {
      toggleBtn.style.cssText = mtBusy;
      toggleBtn.textContent = '処理中…';
      toggleBtn.disabled = true;
    } else {
      toggleBtn.style.cssText = isOn ? mtOn : mtOff;
      toggleBtn.textContent = isOn ? 'ON' : 'OFF';
    }
    toggleBtn.addEventListener('click', function () {
      if (toggleBtn.disabled || ttsBusy) return;
      ttsBusy = true;
      // 押した瞬間に処理中表示にする (renderApps/render の async getScene を待たない)
      toggleBtn.style.cssText = mtBusy;
      toggleBtn.textContent = '処理中…';
      toggleBtn.disabled = true;
      var nextEnabled = !settings.enabled;
      api.ttsSetEnabled(nextEnabled).then(function (state) {
        if (state) {
          ttsState = state;
          settings = Object.assign({}, settings, { enabled: !!state.enabled });
        } else {
          settings = Object.assign({}, settings, { enabled: nextEnabled });
          ttsState.enabled = nextEnabled;
        }
      }).catch(function () {
        return api.ttsGetState().then(function (state) {
          if (state) {
            ttsState = state;
            settings = Object.assign({}, settings, { enabled: !!state.enabled });
          }
        }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
      }).then(function () {
        ttsBusy = false;
        render(settings);
        renderApps();
      });
    });
    stateCard.appendChild(toggleBtn);
    ttsViewRefs.stateToggle = toggleBtn;

    // 演出カードから移植: テスト読み上げボタン (= モック合意でカード上から撤去)
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:4px;padding:5px 14px;font-size:11px;cursor:pointer;color:#94a3b8;flex-shrink:0;margin-left:6px;';
    testBtn.textContent = 'テスト';
    testBtn.title = 'テスト用の発話を再生 (現在の設定で 1 回読み上げ)';
    testBtn.addEventListener('click', function () {
      api.ttsTestSpeech('こめはぶの読み上げテストです。コメントを読み上げます。');
    });
    stateCard.appendChild(testBtn);

    body.appendChild(stateCard);

    // ── 共通設定 ──
    var commonCard = document.createElement('div');
    commonCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:12px;';
    var commonTitle = document.createElement('div');
    commonTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:10px;';
    commonTitle.textContent = '共通設定';
    commonCard.appendChild(commonTitle);

    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;';

    var maxLength = makeInput('number', settings.maxLength != null ? settings.maxLength : 120);
    maxLength.min = '1';
    maxLength.max = '500';
    maxLength.addEventListener('change', function () {
      autoSave({ maxLength: parseInt(maxLength.value, 10) || 120 });
    });
    grid.appendChild(createField('最大文字数', maxLength));

    var readName = makeSelect([
      { value: 'false', label: '読まない' },
      { value: 'true', label: '読む' }
    ], settings.readName ? 'true' : 'false');
    readName.addEventListener('change', function () {
      autoSave({ readName: readName.value === 'true' });
    });
    grid.appendChild(createField('投稿者名', readName));

    // ── 出力デバイス (builtin / VOICEVOX のみ適用、bouyomi は棒読み側で設定) ──
    // 起動時は「システム既定」だけの placeholder で出し、async に SAPI から
    // audio output 一覧を取って populate する。
    // bouyomi 選択中も populate は行う: 保存済みの outputDevice 値が option list に
    // 存在しないと select の表示が空白になる UX を避けるため。disabled は維持。
    var outputDeviceValue = settings.outputDevice || '';
    var outputDevice = makeSelect(
      [{ value: '', label: 'システム既定' }],
      outputDeviceValue
    );
    var isBouyomiProvider = settings.provider === 'bouyomi';
    if (isBouyomiProvider) {
      outputDevice.disabled = true;
      outputDevice.style.opacity = '0.5';
    }
    outputDevice.addEventListener('change', function () {
      autoSave({ outputDevice: outputDevice.value });
    });
    var outputField = createField('出力デバイス', outputDevice);
    outputField.style.gridColumn = '1 / -1';
    if (isBouyomiProvider) {
      var outputHint = document.createElement('div');
      outputHint.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:4px;';
      outputHint.textContent = '棒読みちゃん側で設定してください';
      outputField.appendChild(outputHint);
    }
    grid.appendChild(outputField);
    // 出力デバイス populate ヘルパ。fetch して option list を組み立て、保存済みの
    // outputDevice が一覧に無ければ「(設定済みのデバイスが見つかりません)」を
    // orphan option として表示する。再 fetch でも毎回再構築されるので OK。
    var outputDeviceFetching = false;
    function refreshOutputDeviceOptions() {
      if (!api.ttsGetAudioOutputs) return;
      if (outputDeviceFetching) return;
      outputDeviceFetching = true;
      api.ttsGetAudioOutputs().then(function (data) {
        outputDeviceFetching = false;
        if (!outputDevice.isConnected) return;
        if (!data || !data.ok || !Array.isArray(data.outputs)) return;
        while (outputDevice.firstChild) outputDevice.removeChild(outputDevice.firstChild);
        var defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'システム既定';
        outputDevice.appendChild(defaultOpt);
        var savedId = settings.outputDevice || '';
        var matchedSaved = false;
        data.outputs.forEach(function (dev) {
          if (!dev || !dev.id) return;
          var opt = document.createElement('option');
          opt.value = dev.id;
          opt.textContent = dev.description || dev.id;
          outputDevice.appendChild(opt);
          if (dev.id === savedId) matchedSaved = true;
        });
        if (savedId && !matchedSaved) {
          // PC からデバイスを抜いた / OS が登録解除した等で、保存値が
          // 現在の一覧に無いケース。orphan option を追加して状態を可視化する。
          var orphanOpt = document.createElement('option');
          orphanOpt.value = savedId;
          orphanOpt.textContent = '(設定済みのデバイスが見つかりません)';
          orphanOpt.style.color = '#ff8a8a';
          outputDevice.appendChild(orphanOpt);
        }
        outputDevice.value = savedId;
      }, function () { outputDeviceFetching = false; });
    }
    refreshOutputDeviceOptions();
    // ドロップダウンを開く瞬間に再 fetch して、デバイス追加 / 取り外しを反映する
    // (Windows IMMNotificationClient のネイティブ通知を使わない簡易版)。
    // disabled (= bouyomi 選択中) では再取得しても操作できないので skip。
    outputDevice.addEventListener('mousedown', function () {
      if (outputDevice.disabled) return;
      refreshOutputDeviceOptions();
    });

    var categories = settings.categories || {};
    var categoryBox = document.createElement('div');
    categoryBox.style.cssText = 'grid-column:1 / -1;background:#081421;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';
    var categoryTitle = document.createElement('div');
    categoryTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:10px;';
    categoryTitle.textContent = '読み上げ対象';
    categoryBox.appendChild(categoryTitle);
    var categoryChecks = {};
    function saveCategories() {
      autoSave({
        categories: {
          normal: categoryChecks.normal.checked,
          superchat: categoryChecks.superchat.checked,
          membership: categoryChecks.membership.checked,
          membershipGift: categoryChecks.membershipGift.checked
        }
      });
    }
    [
      ['normal', '通常コメント'],
      ['superchat', 'スパチャ'],
      ['membership', 'メンバーシップ'],
      ['membershipGift', 'ギフト']
    ].forEach(function (pair) {
      var label = document.createElement('label');
      label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:0 14px 8px 0;font-size:12px;color:#cbd5e1;cursor:pointer;';
      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = categories[pair[0]] !== false;
      check.addEventListener('change', saveCategories);
      categoryChecks[pair[0]] = check;
      label.appendChild(check);
      label.appendChild(document.createTextNode(pair[1]));
      categoryBox.appendChild(label);
    });
    grid.appendChild(categoryBox);
    commonCard.appendChild(grid);

    // ── 出力先ソフト (テンプレート選択と同じく行クリック=切替) ──
    var providerCard = document.createElement('div');
    providerCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:12px;';

    var providerHeader = document.createElement('div');
    providerHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;';
    var providerListTitle = document.createElement('div');
    providerListTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;';
    providerListTitle.textContent = '出力先ソフト';
    providerHeader.appendChild(providerListTitle);
    var providerSummary = document.createElement('div');
    providerSummary.style.cssText = 'font-size:11px;color:#94a3b8;';
    providerSummary.textContent = '配信中: ' + findProviderOption(providerValue).label;
    providerHeader.appendChild(providerSummary);
    providerCard.appendChild(providerHeader);

    providerOptions.forEach(function (option) {
      var isSelected = option.value === providerValue;
      var row = document.createElement('div');
      var rowCursor = ttsBusy ? 'default' : 'pointer';
      var rowOpacity = ttsBusy ? '0.6' : '1';
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid '
        + (isSelected ? '#00bcd4' : '#1a3a4a') + ';border-radius:6px;margin-bottom:8px;background:'
        + (isSelected ? '#0f2f3a' : '#0a1628') + ';cursor:' + rowCursor + ';opacity:' + rowOpacity + ';';
      row.addEventListener('mouseenter', function () {
        if (ttsBusy) return;
        row.style.borderColor = isSelected ? '#00bcd4' : '#2f4d68';
        if (!isSelected) row.style.background = '#0d1d31';
      });
      row.addEventListener('mouseleave', function () {
        if (ttsBusy) return;
        row.style.borderColor = isSelected ? '#00bcd4' : '#1a3a4a';
        row.style.background = isSelected ? '#0f2f3a' : '#0a1628';
      });
      row.addEventListener('click', function () {
        if (option.value === providerValue) return;
        if (ttsBusy) return;
        ttsBusy = true;
        // 行に「切替中…」を表示。cursor:wait は使わない (システムスピナー回避)
        rowMeta.textContent = '切替中…';
        row.style.cursor = 'default';
        row.style.opacity = '0.6';
        var next = Object.assign({}, settings, { provider: option.value });
        api.ttsSaveSettings(next).then(function (saved) {
          if (saved) {
            settings = saved;
            ttsSettingsCache = saved;
            ttsState.enabled = !!saved.enabled;
            ttsState.provider = saved.provider || ttsState.provider;
          }
        }).catch(function (err) {
          rendererLog.debug('ttsSaveSettings rejected (catch swallow):', err);
        }).then(function () {
          ttsBusy = false;
          render(settings);
          renderApps();
        });
      });

      var rowLeft = document.createElement('div');
      rowLeft.style.cssText = 'min-width:0;flex:1;';
      var rowName = document.createElement('div');
      rowName.style.cssText = 'font-size:12px;color:#d8e8e8;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      rowName.textContent = option.label;
      rowLeft.appendChild(rowName);
      var rowMeta = document.createElement('div');
      rowMeta.style.cssText = 'font-size:10px;color:' + (isSelected ? '#7dd3fc' : '#64748b') + ';margin-top:2px;';
      rowMeta.textContent = isSelected ? '選択中 / ' + option.meta : option.meta;
      rowLeft.appendChild(rowMeta);
      row.appendChild(rowLeft);

      var rowActions = document.createElement('div');
      rowActions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

      if (option.value !== 'builtin') {
        var launchBtn = document.createElement('button');
        launchBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 8px;font-size:11px;color:#94a3b8;cursor:pointer;';
        launchBtn.textContent = '起動';
        launchBtn.title = option.label + ' を起動';
        launchBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!api.ttsLaunchProvider) {
            setStatus('この環境では起動操作に対応していません。', true);
            return;
          }
          launchBtn.disabled = true;
          launchBtn.style.opacity = '0.6';
          rowMeta.textContent = '起動中…';
          api.ttsLaunchProvider(option.value).then(function (result) {
            if (!result || !result.ok) {
              rowMeta.textContent = isSelected ? '選択中 / ' + option.meta : option.meta;
              setStatus((result && result.error) || '起動できませんでした。', true);
              return;
            }
            rememberProviderExecutablePath(settings, option.value, result.path).then(function (saved) {
              if (saved) settings = saved;
            });
            rowMeta.textContent = '起動しました / 接続確認中…';
            setStatus(result.alreadyRunning ? 'すでに起動しています。接続確認します。' : '起動しました。接続できるまで少し待ちます。', false);
            waitForProviderConnection(option.value).then(function (checkResult) {
              if (!rowMeta.isConnected) return;
              rowMeta.textContent = isSelected ? '選択中 / ' + option.meta : option.meta;
              setStatus(checkResult && checkResult.ok ? '接続できました。' : ((checkResult && checkResult.error) || '接続できませんでした。'), !(checkResult && checkResult.ok));
            });
          }).catch(function (err) {
            rowMeta.textContent = isSelected ? '選択中 / ' + option.meta : option.meta;
            setStatus(err && err.message ? err.message : String(err), true);
          }).then(function () {
            launchBtn.disabled = false;
            launchBtn.style.opacity = '1';
          });
        });
        rowActions.appendChild(launchBtn);
      }

      var settingsBtn = document.createElement('button');
      settingsBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 8px;font-size:11px;color:#94a3b8;cursor:pointer;';
      settingsBtn.textContent = '設定';
      settingsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openProviderSettings(settings, option.value);
      });
      rowActions.appendChild(settingsBtn);

      row.appendChild(rowActions);
      providerCard.appendChild(row);
      ttsViewRefs.providerRows[option.value] = { rowEl: row, rowMetaEl: rowMeta };
    });
    body.appendChild(providerCard);
    body.appendChild(commonCard);
    detectAndRememberProviderExecutable(settings, 'bouyomi').then(function (saved) {
      if (saved && saved !== settings) settings = saved;
    });
  }

  function openProviderSettings(settings, provider) {
    // tts-provider-edit-section の body に詳細フォームを描画 + framework 経由で表示。
    // 旧実装は同 body 内 display 切替方式だったが、 section ヘッダーの「◀ 戻る」 が見えた
    // まま残るため階層飛びバグ (= 旧通知側 wrapDetails と同パターン) があった。 section
    // 切替方式に変更して解消。
    var bodyDetails = document.getElementById('tts-provider-edit-body');
    if (!bodyDetails) return;
    bodyDetails.innerHTML = '';
    setStatus('', false);

    var option = findProviderOption(provider);
    currentTtsProviderLabel = option.label + ' 設定';

    // option.detail (= 「ずんだもん等のキャラクターを選べる」 等) を本文上部に表示
    var providerMeta = document.createElement('div');
    providerMeta.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:12px;';
    providerMeta.textContent = option.detail;
    bodyDetails.appendChild(providerMeta);

    var loading = document.createElement('div');
    loading.style.cssText = 'font-size:12px;color:#64748b;padding:10px 0;';
    loading.textContent = '設定を読み込んでいます...';
    bodyDetails.appendChild(loading);

    api.ttsGetVoices(provider).then(function (voiceData) {
      renderProviderSettingsForm(settings, provider, voiceData, bodyDetails);
    }).catch(function () {
      renderProviderSettingsForm(settings, provider, null, bodyDetails);
      setStatus('一覧取得に失敗しました。接続設定を確認してください。', true);
    });

    // section 表示 + back text (= 「◀ コメント読み上げに戻る」) は framework が担当
    SubsectionNav.open('tts-provider-edit-section');
  }

  function renderProviderSettingsForm(settings, provider, voiceData, bodyDetails) {
    bodyDetails.innerHTML = '';

    var option = findProviderOption(provider);
    var providerMeta = document.createElement('div');
    providerMeta.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:12px;';
    providerMeta.textContent = option.detail;
    bodyDetails.appendChild(providerMeta);

    var providerBox = document.createElement('div');
    providerBox.style.cssText = 'background:#081421;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

    var providerGrid = document.createElement('div');
    providerGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;';

    var providerFields = {};
    if (provider === 'bouyomi') {
      var bouyomi = settings.bouyomi || {};
      providerFields.bouyomiExecutablePath = makeInput('text', bouyomi.executablePath || '');
      providerFields.bouyomiHost = makeInput('text', bouyomi.host || '127.0.0.1');
      providerFields.bouyomiPort = makeInput('number', bouyomi.port || 50001);
      providerFields.bouyomiSpeed = makeInput('number', bouyomi.speed != null ? bouyomi.speed : -1);
      providerFields.bouyomiVolume = makeInput('number', bouyomi.volume != null ? bouyomi.volume : -1);
      var bouyomiPickBtn = document.createElement('button');
      bouyomiPickBtn.type = 'button';
      bouyomiPickBtn.textContent = '参照';
      bouyomiPickBtn.addEventListener('click', function () {
        if (!api.ttsSelectExecutable) return;
        api.ttsSelectExecutable('bouyomi').then(function (path) {
          if (path) providerFields.bouyomiExecutablePath.value = path;
        });
      });
      var bouyomiFileField = createFileField('起動ファイル', providerFields.bouyomiExecutablePath, bouyomiPickBtn);
      bouyomiFileField.style.gridColumn = '1 / -1';
      providerGrid.appendChild(bouyomiFileField);
      detectAndRememberProviderExecutable(settings, 'bouyomi', providerFields.bouyomiExecutablePath).then(function (saved) {
        if (saved && saved !== settings) {
          settings = saved;
          setStatus('起動中の棒読みちゃんを検出し、起動ファイルを保存しました。', false);
        }
      });
      providerGrid.appendChild(createField('Host', providerFields.bouyomiHost));
      providerGrid.appendChild(createField('Port', providerFields.bouyomiPort));
      providerGrid.appendChild(createField('速度 (-1 で棒読みちゃん設定)', providerFields.bouyomiSpeed));
      providerGrid.appendChild(createField('音量 (-1 で棒読みちゃん設定)', providerFields.bouyomiVolume));
    } else if (provider === 'voicevox') {
      var vv = settings.voicevox || {};
      var speakers = voiceData && Array.isArray(voiceData.speakers) ? voiceData.speakers : [];
      // 状態カードの meta が次回これを使えるように cache を温めておく
      if (speakers.length > 0) cachedVoicevoxSpeakers = speakers;
      var currentSpeaker = speakers.find(function (s) { return s.speaker_uuid === vv.speakerUuid; }) || speakers[0];
      var speakerOptions = speakers.map(function (s) { return { value: s.speaker_uuid, label: s.name }; });
      if (speakerOptions.length === 0) speakerOptions.push({ value: vv.speakerUuid || '', label: 'VOICEVOXに接続して取得' });
      providerFields.voicevoxExecutablePath = makeInput('text', vv.executablePath || '');
      providerFields.voicevoxHost = makeInput('text', vv.host || '127.0.0.1');
      providerFields.voicevoxPort = makeInput('number', vv.port || 50021);
      providerFields.voicevoxSpeaker = makeSelect(speakerOptions, currentSpeaker ? currentSpeaker.speaker_uuid : (vv.speakerUuid || ''));
      var styleOptions = currentSpeaker && Array.isArray(currentSpeaker.styles)
        ? currentSpeaker.styles.map(function (s) { return { value: String(s.id), label: s.name }; })
        : [{ value: String(vv.styleId || 3), label: 'ノーマル' }];
      providerFields.voicevoxStyle = makeSelect(styleOptions, String(vv.styleId || (styleOptions[0] && styleOptions[0].value) || 3));
      providerFields.voicevoxSpeed = makeInput('number', vv.speedScale != null ? vv.speedScale : 1);
      providerFields.voicevoxSpeed.step = '0.1';
      var voicevoxPickBtn = document.createElement('button');
      voicevoxPickBtn.type = 'button';
      voicevoxPickBtn.textContent = '参照';
      voicevoxPickBtn.addEventListener('click', function () {
        if (!api.ttsSelectExecutable) return;
        api.ttsSelectExecutable('voicevox').then(function (path) {
          if (path) providerFields.voicevoxExecutablePath.value = path;
        });
      });
      var voicevoxFileField = createFileField('起動ファイル', providerFields.voicevoxExecutablePath, voicevoxPickBtn);
      voicevoxFileField.style.gridColumn = '1 / -1';
      providerGrid.appendChild(voicevoxFileField);
      providerGrid.appendChild(createField('Host', providerFields.voicevoxHost));
      providerGrid.appendChild(createField('Port', providerFields.voicevoxPort));
      providerGrid.appendChild(createField('キャラクター', providerFields.voicevoxSpeaker));
      providerGrid.appendChild(createField('スタイル', providerFields.voicevoxStyle));
      providerGrid.appendChild(createField('速度', providerFields.voicevoxSpeed));
      providerFields.voicevoxSpeaker.addEventListener('change', function () {
        var selected = speakers.find(function (s) { return s.speaker_uuid === providerFields.voicevoxSpeaker.value; });
        providerFields.voicevoxStyle.innerHTML = '';
        ((selected && selected.styles) || []).forEach(function (style) {
          var option = document.createElement('option');
          option.value = String(style.id);
          option.textContent = style.name;
          providerFields.voicevoxStyle.appendChild(option);
        });
      });
    } else {
      var builtin = settings.builtin || {};
      var voices = voiceData && Array.isArray(voiceData.voices) ? voiceData.voices : [];
      var voiceOptions = [{ value: '', label: '既定の音声' }].concat(voices.map(function (v) {
        return { value: v.name, label: v.name };
      }));
      providerFields.builtinVoice = makeSelect(voiceOptions, builtin.voice || '');
      providerFields.builtinRate = makeInput('number', builtin.rate != null ? builtin.rate : 0);
      providerFields.builtinVolume = makeInput('number', builtin.volume != null ? builtin.volume : 100);
      providerGrid.appendChild(createField('音声', providerFields.builtinVoice));
      providerGrid.appendChild(createField('速度 (-10〜10)', providerFields.builtinRate));
      providerGrid.appendChild(createField('音量', providerFields.builtinVolume));
    }

    providerBox.appendChild(providerGrid);
    bodyDetails.appendChild(providerBox);

    function collectProviderSettings() {
      var next = {
        provider: provider
      };
      if (provider === 'bouyomi') {
        next.bouyomi = {
          executablePath: providerFields.bouyomiExecutablePath.value || '',
          host: providerFields.bouyomiHost.value || '127.0.0.1',
          port: parseInt(providerFields.bouyomiPort.value, 10) || 50001,
          speed: parseInt(providerFields.bouyomiSpeed.value, 10),
          volume: parseInt(providerFields.bouyomiVolume.value, 10),
          tone: settings.bouyomi && settings.bouyomi.tone != null ? settings.bouyomi.tone : -1,
          voice: settings.bouyomi && settings.bouyomi.voice != null ? settings.bouyomi.voice : 0
        };
      } else if (provider === 'voicevox') {
        next.voicevox = {
          executablePath: providerFields.voicevoxExecutablePath.value || '',
          host: providerFields.voicevoxHost.value || '127.0.0.1',
          port: parseInt(providerFields.voicevoxPort.value, 10) || 50021,
          speakerUuid: providerFields.voicevoxSpeaker.value,
          styleId: parseInt(providerFields.voicevoxStyle.value, 10) || 3,
          speedScale: parseFloat(providerFields.voicevoxSpeed.value) || 1,
          pitchScale: settings.voicevox && settings.voicevox.pitchScale != null ? settings.voicevox.pitchScale : 0,
          intonationScale: settings.voicevox && settings.voicevox.intonationScale != null ? settings.voicevox.intonationScale : 1,
          volumeScale: settings.voicevox && settings.voicevox.volumeScale != null ? settings.voicevox.volumeScale : 1
        };
      } else if (provider === 'builtin') {
        next.builtin = {
          voice: providerFields.builtinVoice.value,
          rate: parseInt(providerFields.builtinRate.value, 10) || 0,
          volume: parseInt(providerFields.builtinVolume.value, 10) || 100
        };
      }
      return next;
    }

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';

    if (provider !== 'builtin') {
      var launchBtn = document.createElement('button');
      launchBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 12px;font-size:12px;color:#94a3b8;cursor:pointer;';
      launchBtn.textContent = '起動';
      launchBtn.addEventListener('click', function () {
        if (!api.ttsLaunchProvider) {
          setStatus('この環境では起動操作に対応していません。', true);
          return;
        }
        launchBtn.disabled = true;
        launchBtn.style.opacity = '0.6';
        setStatus('起動中…', false);
        var next = mergeProviderSettings(settings, collectProviderSettings(), provider);
        api.ttsSaveSettings(next).then(function (saved) {
          if (saved) {
            settings = saved;
            ttsSettingsCache = saved;
          }
          return api.ttsLaunchProvider(provider);
        }).then(function (result) {
          if (!result || !result.ok) {
            setStatus((result && result.error) || '起動できませんでした。', true);
            return;
          }
          if (provider === 'bouyomi' && providerFields.bouyomiExecutablePath && result.path) {
            providerFields.bouyomiExecutablePath.value = result.path;
          } else if (provider === 'voicevox' && providerFields.voicevoxExecutablePath && result.path) {
            providerFields.voicevoxExecutablePath.value = result.path;
          }
          return rememberProviderExecutablePath(settings, provider, result.path).then(function (saved) {
            if (saved) settings = saved;
            return result;
          });
        }).then(function (result) {
          if (!result || !result.ok) return;
          setStatus(result.alreadyRunning ? 'すでに起動しています。接続確認します。' : '起動しました。接続できるまで少し待ちます。', false);
          waitForProviderConnection(provider).then(function (checkResult) {
            setStatus(checkResult && checkResult.ok ? '接続できました。' : ((checkResult && checkResult.error) || '接続できませんでした。'), !(checkResult && checkResult.ok));
          });
        }).catch(function (err) {
          setStatus(err && err.message ? err.message : String(err), true);
        }).then(function () {
          launchBtn.disabled = false;
          launchBtn.style.opacity = '1';
        });
      });
      actions.appendChild(launchBtn);
    }

    var checkBtn = document.createElement('button');
    checkBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 12px;font-size:12px;color:#94a3b8;cursor:pointer;';
    checkBtn.textContent = '接続確認';
    checkBtn.addEventListener('click', function () {
      var next = mergeProviderSettings(settings, collectProviderSettings(), provider);
      api.ttsSaveSettings(next).then(function (saved) {
        if (saved) settings = saved;
        return detectAndRememberProviderExecutable(settings, provider, provider === 'bouyomi' ? providerFields.bouyomiExecutablePath : null);
      }).then(function (saved) {
        if (saved) settings = saved;
        return api.ttsCheckProvider(provider);
      }).then(function (result) {
        setStatus(result && result.ok ? '接続できました。' : ((result && result.error) || '接続できませんでした。'), !(result && result.ok));
      });
    });
    actions.appendChild(checkBtn);

    var testBtn = document.createElement('button');
    testBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:6px;padding:8px 12px;font-size:12px;color:#00bcd4;cursor:pointer;';
    testBtn.textContent = 'テスト再生';
    testBtn.addEventListener('click', function () {
      var next = mergeProviderSettings(settings, collectProviderSettings(), provider);
      api.ttsSaveSettings(next).then(function () {
        return api.ttsTestSpeech('こめはぶの読み上げテストです。コメントを読み上げます。');
      });
    });
    actions.appendChild(testBtn);

    var saveBtn = document.createElement('button');
    saveBtn.style.cssText = 'background:#00bcd4;border:none;border-radius:6px;padding:8px 14px;font-size:12px;color:#07131f;font-weight:600;cursor:pointer;';
    saveBtn.textContent = provider === settings.provider ? '保存' : 'このソフトを使う';
    saveBtn.addEventListener('click', function () {
      var next = mergeProviderSettings(settings, collectProviderSettings(), provider);
      api.ttsSaveSettings(next).then(function (saved) {
        if (saved) {
          settings = saved;
          ttsSettingsCache = saved;
          ttsState.enabled = !!saved.enabled;
          ttsState.provider = saved.provider || ttsState.provider;
        }
        // 親 view に戻る (= framework の onReturn で refreshTtsView が走り差分更新)
        SubsectionNav.close('tts-provider-edit-section');
        renderApps();
      });
    });
    actions.appendChild(saveBtn);

    bodyDetails.appendChild(actions);
  }

  api.ttsGetSettings().then(function (settings) {
    settings = settings || {};
    render(settings);
  }).catch(function (err) {
    body.textContent = 'TTS設定を読み込めませんでした。';
    setStatus(err && err.message ? err.message : String(err), true);
  });

  // section 表示は framework に委譲。 既に開いていれば no-op、 そうでなければ
  // SubsectionNav が scroll 復元 / header text 更新 / enter を担当。
  SubsectionNav.open('tts-edit-section');
}

SubsectionNav.register({
  id: 'tts-edit-section',
  parentId: null,
  title: 'コメント読み上げ',
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () { renderApps(); },
});

// 子 section (= tts-provider-edit-section) から戻った時に親 (= tts-edit-section)
// の親 view を rebuild せず差分更新する。 ttsViewRefs は showTtsSettings の render()
// 内で構築される。 通知側 refreshNotificationView と同パターン (= scroll 維持のため)。
function refreshTtsView() {
  if (!ttsViewRefs) return;
  if (!api.ttsGetSettings) return;
  api.ttsGetSettings().then(function (settings) {
    if (!settings || !ttsViewRefs) return;
    ttsSettingsCache = settings;
    ttsState.enabled = !!settings.enabled;
    ttsState.provider = settings.provider || ttsState.provider;

    // state meta (= 「OFF / provider / VOICEVOX キャラ・スタイル」)
    if (ttsViewRefs.stateMeta) {
      if (!settings.enabled) {
        ttsViewRefs.stateMeta.textContent = 'OFF: コメントは読み上げません';
      } else {
        var providerLabel = providerLabelForTts(settings.provider);
        if (settings.provider === 'voicevox') {
          var vv = settings.voicevox || {};
          var info = lookupVoicevoxName(cachedVoicevoxSpeakers, vv.speakerUuid, vv.styleId);
          if (info) {
            var parts = [info.name, info.style].filter(function (s) { return s && s.length > 0; });
            ttsViewRefs.stateMeta.textContent = providerLabel + ': ' + parts.join(' / ');
          } else {
            ttsViewRefs.stateMeta.textContent = providerLabel;
          }
        } else {
          ttsViewRefs.stateMeta.textContent = providerLabel;
        }
      }
    }

    // provider 各行 (= selected/非 selected の枠色・背景・メタテキスト)
    var providerValue = settings.provider || 'builtin';
    Object.keys(ttsViewRefs.providerRows).forEach(function (key) {
      var refs = ttsViewRefs.providerRows[key];
      var isSelected = key === providerValue;
      refs.rowEl.style.borderColor = isSelected ? '#00bcd4' : '#1a3a4a';
      refs.rowEl.style.background = isSelected ? '#0f2f3a' : '#0a1628';
      var option = findTtsProviderOption(key);
      refs.rowMetaEl.textContent = isSelected ? '選択中 / ' + option.meta : option.meta;
    });

    renderApps();
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

SubsectionNav.register({
  id: 'tts-provider-edit-section',
  parentId: 'tts-edit-section',
  title: function () { return currentTtsProviderLabel; },
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () { refreshTtsView(); },
});

// --- デバッグ・サポート (= デバッグログ ON/OFF) は settings frame の独立 nav 配下に移動 ---
// 詳細仕様: docs/logging.md。 通常運用は trace/debug OFF、 ここで ON にすると次回起動
// から trace まで出力される。 正本は Rust AppConfig.debug_logging_enabled、 反映は再起動。
// (2026-05-23 移動: GLOBAL カード + subsection 経路 → settings-panel "debug" 経路へ)

// --- コメント通知設定画面 (Phase A: UI スケルトン) ---
// 個別イベントの「設定」 (= 通知音ファイル / テンプレート) は Phase D で実装。
// ここでは master ON/OFF + provider/outputDevice 選択 + イベント一覧の ON/OFF までを提供。
function showNotificationSettings() {
  var bodyEl = document.getElementById('notification-edit-body');
  if (!bodyEl) return;

  // section の表示 / enter/leave は SubsectionNav.open() に任せる (= 後段で呼ぶ)
  bodyEl.innerHTML = '';

  var statusEl = document.createElement('div');
  statusEl.style.cssText = 'display:none;border-radius:6px;font-size:12px;padding:8px 10px;margin-bottom:12px;';
  bodyEl.appendChild(statusEl);

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.style.display = message ? '' : 'none';
    statusEl.style.background = isError ? '#3b1111' : '#082f2a';
    statusEl.style.border = '1px solid ' + (isError ? '#7f1d1d' : '#166534');
    statusEl.style.color = isError ? '#fecaca' : '#bbf7d0';
  }

  var body = document.createElement('div');
  body.textContent = '読み込み中...';
  body.style.cssText = 'font-size:13px;color:#64748b;padding:8px 0;';
  bodyEl.appendChild(body);

  function render(settings) {
    body.innerHTML = '';
    body.style.cssText = '';
    setStatus('', false);

    // 差分更新用 ref を初期化 (= refreshNotificationView から参照)
    notificationViewRefs = {
      stateMeta: null,
      stateToggle: null,
      providerRows: {},  // provider id → { rowEl, metaEl, metaText }
      eventRows: {},     // event id → { hintEl, toggleEl }
    };

    function autoSave(patch) {
      var next = Object.assign({}, settings, patch || {});
      // events パッチ用に shallow merge では不十分なケースは呼び出し側で組み立て済とする
      settings = next;
      api.notificationSaveSettings(next).then(function (saved) {
        if (saved) {
          settings = saved;
          notificationSettingsCache = saved;
        }
        return api.notificationGetState();
      }).then(function (state) {
        if (state) notificationState = state;
        renderApps();
      }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
    }

    // ── 状態カード (master ON/OFF) ── TTS と同じスタイル
    var stateCard = document.createElement('div');
    stateCard.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:12px;';
    var stateLeft = document.createElement('div');
    stateLeft.style.cssText = 'min-width:0;flex:1;';
    var stateName = document.createElement('div');
    stateName.style.cssText = 'font-size:13px;font-weight:600;color:#00bcd4;';
    stateName.textContent = 'コメント通知';
    stateLeft.appendChild(stateName);
    var stateMeta = document.createElement('div');
    stateMeta.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px;';
    function updateStateMeta() {
      if (!settings.enabled) {
        stateMeta.textContent = 'OFF: イベント通知は再生しません';
        return;
      }
      var providerLabel = providerLabelForTts(settings.provider);
      var enabledCount = NOTIFICATION_EVENT_DEFS.filter(function (def) {
        var ev = settings.events && settings.events[def.id];
        return ev && ev.enabled;
      }).length;
      stateMeta.textContent = providerLabel + ' / ' + enabledCount + '/' + NOTIFICATION_EVENT_DEFS.length + ' イベント ON';
    }
    updateStateMeta();
    stateLeft.appendChild(stateMeta);
    stateCard.appendChild(stateLeft);
    notificationViewRefs.stateMeta = stateMeta;

    var stateToggle = document.createElement('button');
    stateToggle.type = 'button';
    function applyStateToggleAppearance(enabled) {
      stateToggle.className = 'u-btn' + (enabled ? ' on' : '');
      stateToggle.textContent = enabled ? 'ON' : 'OFF';
    }
    applyStateToggleAppearance(settings.enabled);
    notificationViewRefs.stateToggle = stateToggle;
    stateToggle.addEventListener('click', function () {
      var nextEnabled = !settings.enabled;
      // 楽観的: 押下と同時に切替表示、 autoSave 完了で renderApps が状態整合する
      settings.enabled = nextEnabled;
      applyStateToggleAppearance(nextEnabled);
      updateStateMeta();
      autoSave({ enabled: nextEnabled });
    });
    stateCard.appendChild(stateToggle);
    body.appendChild(stateCard);

    // ── 通知全体の設定 ──
    var globalHeader = document.createElement('div');
    globalHeader.style.cssText = 'font-size:12px;font-weight:600;color:#94a3b8;margin:16px 0 8px;text-transform:uppercase;letter-spacing:0.5px;';
    globalHeader.textContent = '▼ 通知全体の設定';
    body.appendChild(globalHeader);

    var globalGrid = document.createElement('div');
    globalGrid.style.cssText = 'display:grid;grid-template-columns:1fr;gap:10px;background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:16px;';

    // 出力先ソフト (= 3 行カード、 既存 TTS と同じ UI)。 詳細 (= speaker/style/speed
    // / 棒読み speed/tone 等) は各行の「設定」 ボタン → showNotificationProviderSettings へ。
    var providerCardTitle = document.createElement('div');
    providerCardTitle.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
    providerCardTitle.textContent = '読み上げソフト ※コメント読み上げと別設定';
    globalGrid.appendChild(providerCardTitle);

    var notifProviderOptions = [
      { value: 'none',     label: '読み上げ無し', meta: '通知音だけ鳴らして読み上げしない' },
      { value: 'builtin',  label: '内蔵読み上げ', meta: 'Windows 標準音声で読み上げ' },
      { value: 'bouyomi',  label: '棒読みちゃん', meta: '棒読みちゃんに送って読み上げ' },
      { value: 'voicevox', label: 'VOICEVOX',     meta: 'VOICEVOX エンジンで読み上げ' }
    ];
    notifProviderOptions.forEach(function (opt) {
      var isSelected = opt.value === (settings.provider || 'builtin');
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid '
        + (isSelected ? '#00bcd4' : '#1a3a4a') + ';border-radius:6px;margin-bottom:6px;background:'
        + (isSelected ? '#0f2f3a' : '#0a1628') + ';cursor:pointer;';
      row.addEventListener('mouseenter', function () {
        row.style.borderColor = isSelected ? '#00bcd4' : '#2f4d68';
        if (!isSelected) row.style.background = '#0d1d31';
      });
      row.addEventListener('mouseleave', function () {
        row.style.borderColor = isSelected ? '#00bcd4' : '#1a3a4a';
        row.style.background = isSelected ? '#0f2f3a' : '#0a1628';
      });
      row.addEventListener('click', function () {
        if (opt.value === settings.provider) return;
        settings.provider = opt.value;
        autoSave({ provider: opt.value });
        render(settings);
      });
      var rowLeft = document.createElement('div');
      rowLeft.style.cssText = 'min-width:0;flex:1;';
      var rowName = document.createElement('div');
      rowName.style.cssText = 'font-size:12px;color:#d8e8e8;font-weight:600;';
      rowName.textContent = opt.label;
      rowLeft.appendChild(rowName);
      var rowMeta = document.createElement('div');
      rowMeta.style.cssText = 'font-size:10px;color:' + (isSelected ? '#7dd3fc' : '#64748b') + ';margin-top:2px;';
      rowMeta.textContent = isSelected ? '選択中 / ' + opt.meta : opt.meta;
      rowLeft.appendChild(rowMeta);
      row.appendChild(rowLeft);
      // 「起動」 ボタン: bouyomi / voicevox は外部プロセスなので起動が必要。
      // 'none' (= 読み上げ無し) / 'builtin' (= OS 標準で常時利用可) は起動不要。
      // ttsLaunchProvider は TTS / 通知 共通の起動 API (= 実体は同 OS プロセス)。
      if (opt.value !== 'none' && opt.value !== 'builtin') {
        var launchBtn = document.createElement('button');
        launchBtn.type = 'button';
        launchBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 8px;font-size:11px;color:#94a3b8;cursor:pointer;flex-shrink:0;';
        launchBtn.textContent = '起動';
        launchBtn.title = opt.label + ' を起動 (= 通知 / コメント読み上げ 共通)';
        launchBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!api.ttsLaunchProvider) {
            setStatus('この環境では起動操作に対応していません', true);
            return;
          }
          launchBtn.disabled = true;
          launchBtn.style.opacity = '0.6';
          setStatus(opt.label + ' を起動中…', false);
          api.ttsLaunchProvider(opt.value).then(function (result) {
            launchBtn.disabled = false;
            launchBtn.style.opacity = '1';
            if (!result || !result.ok) {
              setStatus((result && result.error) || (opt.label + ' を起動できませんでした'), true);
              return;
            }
            setStatus(result.alreadyRunning ? (opt.label + ' は既に起動しています') : (opt.label + ' を起動しました'), false);
          }).catch(function (err) {
            launchBtn.disabled = false;
            launchBtn.style.opacity = '1';
            setStatus(err && err.message ? err.message : String(err), true);
          });
        });
        row.appendChild(launchBtn);
      }
      // 「設定」 ボタン: builtin / bouyomi / voicevox いずれも詳細編集画面を持つ。
      // 'none' (= 読み上げ無し) は詳細設定がないので設定ボタンを表示しない。
      if (opt.value !== 'none') {
        var settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 8px;font-size:11px;color:#94a3b8;cursor:pointer;flex-shrink:0;';
        settingsBtn.textContent = '設定';
        settingsBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          showNotificationProviderSettings(opt.value);
        });
        row.appendChild(settingsBtn);
      }
      globalGrid.appendChild(row);
      notificationViewRefs.providerRows[opt.value] = { rowEl: row, metaEl: rowMeta, metaText: opt.meta };
    });

    // 出力デバイス選択
    var deviceLabel = document.createElement('label');
    deviceLabel.style.cssText = 'display:block;';
    var deviceTitle = document.createElement('div');
    deviceTitle.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
    deviceTitle.textContent = '出力デバイス ※コメント読み上げと別設定';
    deviceLabel.appendChild(deviceTitle);
    var deviceRow = document.createElement('div');
    deviceRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
    var deviceSelect = document.createElement('select');
    deviceSelect.style.cssText = 'flex:1;min-width:0;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;';
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'システム既定';
    deviceSelect.appendChild(defaultOpt);
    // 起動済みデバイス一覧を fetch (TTS と同じ API を流用)
    if (api.ttsGetAudioOutputs) {
      api.ttsGetAudioOutputs().then(function (data) {
        if (!data || !Array.isArray(data.outputs)) return;
        data.outputs.forEach(function (out) {
          var o = document.createElement('option');
          o.value = out.id;
          o.textContent = out.description;
          deviceSelect.appendChild(o);
        });
        deviceSelect.value = settings.outputDevice || '';
      }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
    }
    deviceSelect.value = settings.outputDevice || '';
    // Phase D-3: デバイス一覧を開くタイミング (= mousedown) で SAPI→cpal map を refresh。
    // デバイス抜き差しに追従するため (= 起動時 1 回だけでなく、 必要時にも再構築)。
    deviceSelect.addEventListener('mousedown', function () {
      if (api.notificationRefreshDeviceMap) {
        api.notificationRefreshDeviceMap().catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
      }
    });

    // 棒読みちゃん選択時は出力デバイスを棒読みちゃん側で設定する仕様 → select を disable
    // + 注意 hint を表示。 既存 TTS と同じ挙動。
    var deviceHint = document.createElement('div');
    deviceHint.style.cssText = 'font-size:11px;color:#fbbf24;margin-top:4px;display:none;';
    deviceHint.textContent = '⚠ 出力デバイスは棒読みちゃん側で設定してください';
    deviceLabel.appendChild(deviceHint);
    function applyDeviceAvailability() {
      var isBouyomi = settings.provider === 'bouyomi';
      deviceSelect.disabled = isBouyomi;
      deviceSelect.style.opacity = isBouyomi ? '0.5' : '1';
      copyFromTts.disabled = isBouyomi;
      copyFromTts.style.opacity = isBouyomi ? '0.5' : '1';
      deviceHint.style.display = isBouyomi ? '' : 'none';
    }
    deviceSelect.addEventListener('change', function () {
      autoSave({ outputDevice: deviceSelect.value });
    });
    deviceRow.appendChild(deviceSelect);

    var copyFromTts = document.createElement('button');
    copyFromTts.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 10px;font-size:11px;color:#94a3b8;cursor:pointer;flex-shrink:0;white-space:nowrap;';
    copyFromTts.textContent = 'コメント読み上げと同じ';
    copyFromTts.title = 'コメント読み上げの provider / 出力デバイス設定を 1 回コピーします';
    copyFromTts.addEventListener('click', function () {
      if (!api.ttsGetSettings) return;
      api.ttsGetSettings().then(function (ttsSettings) {
        if (!ttsSettings) return;
        var patch = {
          provider: ttsSettings.provider || 'builtin',
          outputDevice: ttsSettings.outputDevice || ''
        };
        providerSelect.value = patch.provider;
        deviceSelect.value = patch.outputDevice;
        autoSave(patch);
        setStatus('コメント読み上げの設定をコピーしました', false);
      });
    });
    deviceRow.appendChild(copyFromTts);
    deviceLabel.appendChild(deviceRow);
    globalGrid.appendChild(deviceLabel);
    // 初期表示時に bouyomi の場合の disable / hint も反映する
    applyDeviceAvailability();

    body.appendChild(globalGrid);

    // ── 通知するイベント一覧 ──
    var eventsHeader = document.createElement('div');
    eventsHeader.style.cssText = 'font-size:12px;font-weight:600;color:#94a3b8;margin:16px 0 8px;text-transform:uppercase;letter-spacing:0.5px;';
    eventsHeader.textContent = '▼ 通知するイベント';
    body.appendChild(eventsHeader);

    var eventsCard = document.createElement('div');
    eventsCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;overflow:hidden;';

    NOTIFICATION_EVENT_DEFS.forEach(function (def, idx) {
      var ev = (settings.events && settings.events[def.id]) || { enabled: false };
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;' + (idx < NOTIFICATION_EVENT_DEFS.length - 1 ? 'border-bottom:1px solid #1a3a4a;' : '');

      var iconEl = document.createElement('div');
      iconEl.style.cssText = 'font-size:18px;width:24px;text-align:center;flex-shrink:0;';
      iconEl.textContent = def.icon;
      row.appendChild(iconEl);

      var labelEl = document.createElement('div');
      labelEl.style.cssText = 'flex:1;min-width:0;';
      var nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:13px;color:#d8e8e8;';
      nameEl.textContent = def.name;
      labelEl.appendChild(nameEl);
      var hintEl = document.createElement('div');
      hintEl.style.cssText = 'font-size:11px;color:#64748b;margin-top:2px;';
      // 設定の現状を 1 行で要約 (= 通知音ファイル名 / テンプレが入っていればその抜粋)
      var summaryParts = [];
      if (ev.sound && ev.sound.enabled) {
        summaryParts.push('🔔 ' + (ev.sound.file ? ev.sound.file.replace(/^.*[\\/]/, '') : '(ファイル未設定)'));
      }
      if (ev.tts && ev.tts.enabled) {
        var tplPreview = (ev.tts.template || getNotificationEventDefault(def.id).template).slice(0, 30);
        summaryParts.push('🗣 ' + tplPreview + (tplPreview.length >= 30 ? '...' : ''));
      }
      hintEl.textContent = summaryParts.length ? summaryParts.join(' / ') : '通知音 / 読み上げ 共に OFF';
      labelEl.appendChild(hintEl);
      row.appendChild(labelEl);

      var toggle = document.createElement('button');
      toggle.type = 'button';
      function applyToggleAppearance(enabled) {
        // GLOBAL コメント通知カード の ON/OFF (= createAppCard 内 toggleBtn) と
        // 完全に同じ見た目 = .u-btn / .u-btn.on の class ベース (style.css)。
        toggle.className = 'u-btn' + (enabled ? ' on' : '');
        toggle.textContent = enabled ? 'ON' : 'OFF';
      }
      applyToggleAppearance(ev.enabled);
      toggle.addEventListener('click', function () {
        var nextEnabled = !ev.enabled;
        // 押した瞬間に in-place で見た目を切替 (= TTS master トグルと同じ挙動)。
        // autoSave 完了を待たずに視覚的に反応させる。
        ev.enabled = nextEnabled;
        applyToggleAppearance(nextEnabled);
        var nextEvents = Object.assign({}, settings.events || {});
        nextEvents[def.id] = Object.assign({}, ev, { enabled: nextEnabled });
        autoSave({ events: nextEvents });
      });
      row.appendChild(toggle);

      var settingsBtn = document.createElement('button');
      settingsBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;flex-shrink:0;';
      settingsBtn.textContent = '⚙ 設定';
      settingsBtn.title = '通知音 / 読み上げ / テンプレート を編集';
      settingsBtn.addEventListener('click', function () {
        showNotificationEventSettings(def.id);
      });
      row.appendChild(settingsBtn);

      eventsCard.appendChild(row);
      notificationViewRefs.eventRows[def.id] = { hintEl: hintEl, toggleEl: toggle };
    });
    body.appendChild(eventsCard);
  }

  // 読み上げソフト詳細編集画面は notification-provider-edit-section (= 並列 section)
  // に切替える。 旧実装は wrapDetails を body 内に追加して display 切替していたが、
  // section ヘッダーの notification-edit-close ボタンが見えたまま残るため誤って閉じると
  // トップまで戻る (= 2 階層飛び) バグがあった。 section 切替方式 (= 個別イベント設定と
  // 同パターン) で notification-edit-section を display:none にすることで解消した。
  api.notificationGetSettings().then(function (settings) {
    notificationSettingsCache = settings || {};
    render(notificationSettingsCache);
  }).catch(function (err) {
    body.textContent = '設定の読み込みに失敗しました: ' + (err && err.message ? err.message : err);
    body.style.color = '#fecaca';
  });

  // section 表示 / enter は framework に委譲。 既に開いていれば no-op、 そうでなければ
  // SubsectionNav が parent chain / scroll 復元 / header text 更新を担当する。
  SubsectionNav.open('notification-edit-section');
}

// 子 section (= notification-event-edit / notification-provider-edit) から戻った時に
// 親 (= notification-edit-body) を **rebuild せず** 差分更新するための関数。
// rebuild すると framework の scroll 復元が無効になる (= scrollHeight が一時 0 に縮む)
// ため、 ref 経由で textContent / class / 枠色のみ書き換えて DOM ツリー構造は保持する。
//
// 呼ばれるのは register の onReturn 経由 (= 旧実装の showNotificationSettings() 再呼び出し
// の代替)。
function refreshNotificationView() {
  if (!notificationViewRefs) return;
  api.notificationGetSettings().then(function (settings) {
    if (!settings || !notificationViewRefs) return;
    notificationSettingsCache = settings;

    // state meta + toggle (= 状態カード)
    if (notificationViewRefs.stateMeta) {
      if (!settings.enabled) {
        notificationViewRefs.stateMeta.textContent = 'OFF: イベント通知は再生しません';
      } else {
        var providerLabel = providerLabelForTts(settings.provider);
        var enabledCount = NOTIFICATION_EVENT_DEFS.filter(function (def) {
          var ev = settings.events && settings.events[def.id];
          return ev && ev.enabled;
        }).length;
        notificationViewRefs.stateMeta.textContent = providerLabel + ' / ' + enabledCount + '/' + NOTIFICATION_EVENT_DEFS.length + ' イベント ON';
      }
    }
    if (notificationViewRefs.stateToggle) {
      var enabledNow = !!settings.enabled;
      notificationViewRefs.stateToggle.className = 'u-btn' + (enabledNow ? ' on' : '');
      notificationViewRefs.stateToggle.textContent = enabledNow ? 'ON' : 'OFF';
    }

    // provider rows (= 枠色 + メタテキスト)
    Object.keys(notificationViewRefs.providerRows).forEach(function (providerValue) {
      var refs = notificationViewRefs.providerRows[providerValue];
      var isSelected = providerValue === (settings.provider || 'builtin');
      refs.rowEl.style.borderColor = isSelected ? '#00bcd4' : '#1a3a4a';
      refs.rowEl.style.background = isSelected ? '#0f2f3a' : '#0a1628';
      refs.metaEl.style.color = isSelected ? '#7dd3fc' : '#64748b';
      refs.metaEl.textContent = isSelected ? '選択中 / ' + refs.metaText : refs.metaText;
    });

    // event rows (= summary hint + toggle 状態)
    NOTIFICATION_EVENT_DEFS.forEach(function (def) {
      var refs = notificationViewRefs.eventRows[def.id];
      if (!refs) return;
      var ev = (settings.events && settings.events[def.id]) || { enabled: false };
      var summaryParts = [];
      if (ev.sound && ev.sound.enabled) {
        summaryParts.push('🔔 ' + (ev.sound.file ? ev.sound.file.replace(/^.*[\\/]/, '') : '(ファイル未設定)'));
      }
      if (ev.tts && ev.tts.enabled) {
        var tplPreview = (ev.tts.template || getNotificationEventDefault(def.id).template).slice(0, 30);
        summaryParts.push('🗣 ' + tplPreview + (tplPreview.length >= 30 ? '...' : ''));
      }
      refs.hintEl.textContent = summaryParts.length ? summaryParts.join(' / ') : '通知音 / 読み上げ 共に OFF';
      var evEnabled = !!ev.enabled;
      refs.toggleEl.className = 'u-btn' + (evEnabled ? ' on' : '');
      refs.toggleEl.textContent = evEnabled ? 'ON' : 'OFF';
    });

    // 親一覧の TTS badge 等を反映
    renderApps();
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

// --- 読み上げソフト詳細設定画面 (Phase D-3) ---
// 通知用 provider (= builtin / bouyomi / voicevox) の詳細設定 (= 速度 / キャラクター 等) を
// 編集する画面。 個別イベント設定モーダルと同じ section 切替方式を採用 (= notification-edit-section
// を display:none で隠し、 notification-provider-edit-section を display:'' で表示)。 これで
// 戻るボタンが 1 つだけ見える状態になり、 「2 階層飛んでトップに戻る」 バグを回避できる。
function showNotificationProviderSettings(provider) {
  var bodyEl = document.getElementById('notification-provider-edit-body');
  if (!bodyEl) return;

  var providerLabels = { builtin: '内蔵読み上げ', bouyomi: '棒読みちゃん', voicevox: 'VOICEVOX' };
  currentNotificationProviderLabel = (providerLabels[provider] || provider) + ' 設定 (= 通知用)';

  bodyEl.innerHTML = '';

  var settings = notificationSettingsCache || {};

  function persist(patch) {
    var next = Object.assign({}, settings, patch || {});
    settings = next;
    notificationSettingsCache = next;
    api.notificationSaveSettings(next).then(function (saved) {
      if (saved) {
        settings = saved;
        notificationSettingsCache = saved;
      }
      return api.notificationGetState();
    }).then(function (state) {
      if (state) notificationState = state;
      renderApps();
    }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
  }

  // 注意 hint (= provider 別、 TTS 側と共有する設定がある旨を案内)
  if (provider !== 'builtin') {
    var hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#fbbf24;background:#241a08;border:1px solid #5b3a0a;border-radius:6px;padding:8px 10px;margin-bottom:12px;';
    if (provider === 'bouyomi') {
      hint.textContent = '⚠ 起動ファイル / Host / Port / 出力先デバイス は「コメント読み上げ」 設定で指定してください (= 通知側と共有)';
    } else {
      hint.textContent = '⚠ Host / Port は「コメント読み上げ」 設定で指定してください (= 通知側と共有)';
    }
    bodyEl.appendChild(hint);
  }

  var detailsCard = document.createElement('div');
  detailsCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';
  bodyEl.appendChild(detailsCard);

  if (provider === 'voicevox') {
    renderNotificationVoicevoxDetails(detailsCard, settings, persist);
  } else if (provider === 'bouyomi') {
    renderNotificationBouyomiDetails(detailsCard, settings, persist);
  } else if (provider === 'builtin') {
    renderNotificationBuiltinDetails(detailsCard, settings, persist);
  }

  // section 表示 + back text 更新 (= 動的 title) は framework が担当
  SubsectionNav.open('notification-provider-edit-section');
}


function renderNotificationBuiltinDetails(container, settings, persist) {
  container.innerHTML = '';
  var bi = settings.builtin || {};
  // voice 一覧を ttsGetVoices 経由で取得 (= 共有、 既存 API 流用)
  var voiceLabel = document.createElement('div');
  voiceLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
  voiceLabel.textContent = '音声';
  container.appendChild(voiceLabel);
  var voiceSelect = document.createElement('select');
  voiceSelect.style.cssText = 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;margin-bottom:10px;';
  var defaultVoice = document.createElement('option');
  defaultVoice.value = '';
  defaultVoice.textContent = '既定の音声';
  voiceSelect.appendChild(defaultVoice);
  voiceSelect.value = bi.voice || '';
  if (api.ttsGetVoices) {
    api.ttsGetVoices('builtin').then(function (data) {
      if (!data || !Array.isArray(data.voices)) return;
      data.voices.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.name;
        o.textContent = v.name;
        voiceSelect.appendChild(o);
      });
      voiceSelect.value = bi.voice || '';
    }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
  }
  voiceSelect.addEventListener('change', function () {
    var newBi = Object.assign({}, bi, { voice: voiceSelect.value });
    settings.builtin = newBi;
    persist({ builtin: newBi });
  });
  container.appendChild(voiceSelect);
  function appendBuiltinNumber(labelText, key, defaultVal, minVal, maxVal, hintText) {
    var lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:12px;color:#94a3b8;margin:4px 0 5px;';
    lbl.textContent = labelText;
    container.appendChild(lbl);
    var input = document.createElement('input');
    input.type = 'number';
    input.min = String(minVal);
    input.max = String(maxVal);
    input.value = (typeof bi[key] === 'number') ? bi[key] : defaultVal;
    input.style.cssText = 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;margin-bottom:4px;box-sizing:border-box;';
    input.addEventListener('change', function () {
      var n = parseInt(input.value, 10);
      if (Number.isNaN(n)) n = defaultVal;
      if (n < minVal) n = minVal;
      if (n > maxVal) n = maxVal;
      var newBi = Object.assign({}, bi, {});
      newBi[key] = n;
      settings.builtin = newBi;
      persist({ builtin: newBi });
    });
    container.appendChild(input);
    if (hintText) {
      var h = document.createElement('div');
      h.style.cssText = 'font-size:10px;color:#64748b;margin-bottom:8px;';
      h.textContent = hintText;
      container.appendChild(h);
    }
  }
  appendBuiltinNumber('速度 (-10〜10)', 'rate', 0, -10, 10, '-10: 最遅 / 0: 標準 / 10: 最速');
  appendBuiltinNumber('音量 (0〜100)', 'volume', 100, 0, 100, '0: 無音 / 100: 最大');
}

function renderNotificationVoicevoxDetails(container, settings, persist) {
  container.innerHTML = '';
  var vv = settings.voicevox || {};
  if (!cachedVoicevoxSpeakers || cachedVoicevoxSpeakers.length === 0) {
    var loadingMsg = document.createElement('div');
    loadingMsg.style.cssText = 'font-size:11px;color:#64748b;padding:8px 0;';
    loadingMsg.textContent = 'スピーカー一覧を VOICEVOX から取得中...';
    container.appendChild(loadingMsg);
    ensureVoicevoxSpeakers().then(function () {
      if (container.isConnected) renderNotificationVoicevoxDetails(container, settings, persist);
    }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
    return;
  }
  var spLabel = document.createElement('div');
  spLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
  spLabel.textContent = 'キャラクター';
  container.appendChild(spLabel);
  var spSelect = document.createElement('select');
  spSelect.style.cssText = 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;margin-bottom:10px;';
  cachedVoicevoxSpeakers.forEach(function (sp) {
    var o = document.createElement('option');
    o.value = sp.speaker_uuid;
    o.textContent = sp.name;
    spSelect.appendChild(o);
  });
  var currentSpeaker = cachedVoicevoxSpeakers.find(function (s) { return s.speaker_uuid === vv.speakerUuid; }) || cachedVoicevoxSpeakers[0];
  spSelect.value = currentSpeaker.speaker_uuid;
  spSelect.addEventListener('change', function () {
    var newSp = cachedVoicevoxSpeakers.find(function (s) { return s.speaker_uuid === spSelect.value; });
    var newStyleId = (newSp && newSp.styles && newSp.styles[0]) ? newSp.styles[0].id : (vv.styleId || 3);
    var newVv = Object.assign({}, vv, { speakerUuid: spSelect.value, styleId: newStyleId });
    settings.voicevox = newVv;
    persist({ voicevox: newVv });
    renderNotificationVoicevoxDetails(container, settings, persist);
  });
  container.appendChild(spSelect);
  var styles = (currentSpeaker && Array.isArray(currentSpeaker.styles)) ? currentSpeaker.styles : [];
  var stLabel = document.createElement('div');
  stLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
  stLabel.textContent = 'スタイル';
  container.appendChild(stLabel);
  var stSelect = document.createElement('select');
  stSelect.style.cssText = 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;margin-bottom:10px;';
  if (styles.length === 0) {
    var defOpt = document.createElement('option');
    defOpt.value = String(vv.styleId || 3);
    defOpt.textContent = 'ノーマル';
    stSelect.appendChild(defOpt);
  } else {
    styles.forEach(function (st) {
      var o = document.createElement('option');
      o.value = String(st.id);
      o.textContent = st.name;
      stSelect.appendChild(o);
    });
  }
  stSelect.value = String(vv.styleId || (styles[0] && styles[0].id) || 3);
  stSelect.addEventListener('change', function () {
    var newVv = Object.assign({}, vv, { styleId: parseInt(stSelect.value, 10) || 3 });
    settings.voicevox = newVv;
    persist({ voicevox: newVv });
  });
  container.appendChild(stSelect);
  var speedVal = (typeof vv.speedScale === 'number') ? vv.speedScale : 1.0;
  var spdLabel = document.createElement('div');
  spdLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
  spdLabel.textContent = '速度: ' + speedVal.toFixed(2) + 'x';
  container.appendChild(spdLabel);
  var spdInput = document.createElement('input');
  spdInput.type = 'range';
  spdInput.min = '0.5';
  spdInput.max = '2.0';
  spdInput.step = '0.05';
  spdInput.value = String(speedVal);
  spdInput.style.cssText = 'width:100%;';
  spdInput.addEventListener('input', function () {
    spdLabel.textContent = '速度: ' + parseFloat(spdInput.value).toFixed(2) + 'x';
  });
  spdInput.addEventListener('change', function () {
    var newVv = Object.assign({}, vv, { speedScale: parseFloat(spdInput.value) || 1.0 });
    settings.voicevox = newVv;
    persist({ voicevox: newVv });
  });
  container.appendChild(spdInput);
}

function renderNotificationBouyomiDetails(container, settings, persist) {
  container.innerHTML = '';
  var by = settings.bouyomi || {};
  function appendNumberField(labelText, key, defaultVal, hintText) {
    var lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:12px;color:#94a3b8;margin:4px 0 5px;';
    lbl.textContent = labelText;
    container.appendChild(lbl);
    var input = document.createElement('input');
    input.type = 'number';
    input.value = (typeof by[key] === 'number') ? by[key] : defaultVal;
    input.style.cssText = 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;margin-bottom:4px;box-sizing:border-box;';
    input.addEventListener('change', function () {
      var n = parseInt(input.value, 10);
      if (Number.isNaN(n)) n = defaultVal;
      var newBy = Object.assign({}, by, {});
      newBy[key] = n;
      settings.bouyomi = newBy;
      persist({ bouyomi: newBy });
    });
    container.appendChild(input);
    if (hintText) {
      var h = document.createElement('div');
      h.style.cssText = 'font-size:10px;color:#64748b;margin-bottom:8px;';
      h.textContent = hintText;
      container.appendChild(h);
    }
  }
  appendNumberField('速度 (-1 で棒読みちゃん設定)', 'speed', -1, '-1: 棒読み側を使う / 50-200 程度の整数');
  appendNumberField('音程 (-1 で棒読みちゃん設定)', 'tone', -1, '-1: 棒読み側 / 50-200 程度の整数');
  appendNumberField('音量 (-1 で棒読みちゃん設定)', 'volume', -1, '-1: 棒読み側 / 0-100 の整数');
  appendNumberField('声番号 (voice)', 'voice', 0, '0: 女性1 / 1: 女性2 / 2: 男性1 等、 棒読みちゃん依存');
}

// --- 個別イベント設定画面 (Phase D) ---
// 通知音 (= ファイル + 音量 + 試聴) と 読み上げ (= テンプレ + プレビュー) を 1 画面で編集。
// 設定保存は通知 settings 全体を notificationSaveSettings で送信 (= deep-merge は Rust 側)。
function showNotificationEventSettings(eventId) {
  var def = findNotificationEventDef(eventId);
  if (!def) return;
  var bodyEl = document.getElementById('notification-event-edit-body');
  if (!bodyEl) return;

  // 動的 title を更新 (= framework が register の title fn 経由で読み取る)
  currentNotificationEventLabel = def.icon + ' ' + def.name;

  bodyEl.innerHTML = '';

  var statusEl = document.createElement('div');
  statusEl.style.cssText = 'display:none;border-radius:6px;font-size:12px;padding:8px 10px;margin-bottom:12px;';
  bodyEl.appendChild(statusEl);
  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.style.display = message ? '' : 'none';
    statusEl.style.background = isError ? '#3b1111' : '#082f2a';
    statusEl.style.border = '1px solid ' + (isError ? '#7f1d1d' : '#166534');
    statusEl.style.color = isError ? '#fecaca' : '#bbf7d0';
  }

  var body = document.createElement('div');
  body.textContent = '読み込み中...';
  body.style.cssText = 'font-size:13px;color:#64748b;padding:8px 0;';
  bodyEl.appendChild(body);

  api.notificationGetSettings().then(function (allSettings) {
    notificationSettingsCache = allSettings || {};
    render(allSettings || {});
  }).catch(function (err) {
    body.textContent = '設定の読み込みに失敗しました: ' + (err && err.message ? err.message : err);
    body.style.color = '#fecaca';
  });

  // section 表示 + back text 更新は framework に委譲
  SubsectionNav.open('notification-event-edit-section');

  function render(settings) {
    body.innerHTML = '';
    body.style.cssText = '';

    var events = settings.events || {};
    var current = events[eventId] || { enabled: true, sound: {}, tts: {} };
    var sound = current.sound || {};
    var tts = current.tts || {};

    function persist(patch) {
      // 単一イベントを events[id] に deep-merge する shape で送信。
      var nextEvents = {};
      nextEvents[eventId] = patch;
      api.notificationSaveSettings({ events: nextEvents }).then(function (saved) {
        if (saved) {
          notificationSettingsCache = saved;
          // notificationState のバッジ表示用 enabledEventCount も更新するため再 fetch
          return api.notificationGetState();
        }
        return null;
      }).then(function (state) {
        if (state) notificationState = state;
        renderApps();
      }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
    }

    // ── 概要カード (= 通知音 + TTS のサマリ) ──
    var summaryCard = document.createElement('div');
    summaryCard.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:16px;';
    var summaryLeft = document.createElement('div');
    summaryLeft.style.cssText = 'min-width:0;flex:1;';
    var summaryName = document.createElement('div');
    summaryName.style.cssText = 'font-size:13px;font-weight:600;color:#00bcd4;';
    summaryName.textContent = def.icon + ' ' + def.name;
    summaryLeft.appendChild(summaryName);
    var summaryMeta = document.createElement('div');
    summaryMeta.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px;';
    summaryMeta.textContent = '通知音 + 読み上げ の組み合わせ設定';
    summaryLeft.appendChild(summaryMeta);
    summaryCard.appendChild(summaryLeft);

    var enabledToggle = document.createElement('button');
    enabledToggle.style.cssText = 'background:' + (current.enabled ? '#00bcd4' : '#1a2742') + ';border:1px solid ' + (current.enabled ? '#00bcd4' : '#1a3a4a') + ';border-radius:6px;padding:8px 14px;font-size:12px;color:' + (current.enabled ? '#07131f' : '#94a3b8') + ';font-weight:600;cursor:pointer;flex-shrink:0;';
    enabledToggle.textContent = current.enabled ? '● ON' : '○ OFF';
    enabledToggle.addEventListener('click', function () {
      persist({ enabled: !current.enabled });
      setTimeout(function () { showNotificationEventSettings(eventId); }, 100);
    });
    summaryCard.appendChild(enabledToggle);
    body.appendChild(summaryCard);

    // ── 通知音セクション ──
    var soundHeader = document.createElement('div');
    soundHeader.style.cssText = 'font-size:12px;font-weight:600;color:#94a3b8;margin:16px 0 8px;text-transform:uppercase;letter-spacing:0.5px;';
    soundHeader.textContent = '▼ 通知音';
    body.appendChild(soundHeader);

    var soundCard = document.createElement('div');
    soundCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:16px;';

    // 通知音 ON/OFF
    var soundOnRow = document.createElement('label');
    soundOnRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;';
    var soundOnCb = document.createElement('input');
    soundOnCb.type = 'checkbox';
    soundOnCb.checked = !!sound.enabled;
    soundOnCb.addEventListener('change', function () {
      persist({ sound: { enabled: soundOnCb.checked } });
    });
    soundOnRow.appendChild(soundOnCb);
    var soundOnLabel = document.createElement('span');
    soundOnLabel.style.cssText = 'font-size:12px;color:#d8e8e8;';
    soundOnLabel.textContent = '通知音を鳴らす';
    soundOnRow.appendChild(soundOnLabel);
    soundCard.appendChild(soundOnRow);

    // ファイル選択 (= プリセット dropdown + カスタムファイル の統合)
    var fileLabel = document.createElement('div');
    fileLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;gap:6px;';
    var fileLabelText = document.createElement('span');
    fileLabelText.textContent = '音源';
    fileLabel.appendChild(fileLabelText);
    var soundResetBtn = document.createElement('button');
    soundResetBtn.type = 'button';
    soundResetBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:3px 8px;font-size:10px;color:#94a3b8;cursor:pointer;';
    soundResetBtn.textContent = '↺ デフォルトに戻す';
    soundResetBtn.title = 'このイベントの初期音源プリセット (' + getNotificationEventDefault(def.id).sound_preset_id + ') に戻します';
    fileLabel.appendChild(soundResetBtn);
    soundCard.appendChild(fileLabel);

    // プリセット一覧をローカルキャッシュ (= 「↺ デフォルトに戻す」 で再解決に使う)
    var localPresets = [];

    // プリセット select (= 8 種 + 「カスタムファイル」 オプション)
    var presetSelect = document.createElement('select');
    presetSelect.style.cssText = 'width:100%;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:12px;padding:6px 8px;margin-bottom:8px;';
    var customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '— カスタムファイル —';
    presetSelect.appendChild(customOpt);

    var fileRow = document.createElement('div');
    fileRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:10px;';
    var fileInput = document.createElement('input');
    fileInput.type = 'text';
    fileInput.value = sound.file || '';
    fileInput.placeholder = 'ファイルパス (空欄なら通知音は鳴らない)';
    fileInput.style.cssText = 'flex:1;min-width:0;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:12px;padding:6px 8px;font-family:ui-monospace,Consolas,monospace;';
    fileInput.addEventListener('change', function () {
      persist({ sound: { file: fileInput.value } });
    });
    fileRow.appendChild(fileInput);
    var pickBtn = document.createElement('button');
    pickBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:6px 10px;font-size:12px;color:#94a3b8;cursor:pointer;flex-shrink:0;';
    pickBtn.textContent = '選択';
    pickBtn.addEventListener('click', function () {
      api.notificationPickSoundFile().then(function (path) {
        if (path) {
          fileInput.value = path;
          persist({ sound: { file: path } });
          // カスタムモードに切替
          presetSelect.value = '__custom__';
          applyPresetMode();
        }
      });
    });
    fileRow.appendChild(pickBtn);
    var testBtn = document.createElement('button');
    testBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:6px;padding:6px 10px;font-size:12px;color:#00bcd4;cursor:pointer;flex-shrink:0;';
    testBtn.textContent = '▶ 試聴';
    testBtn.addEventListener('click', function () {
      var file = fileInput.value;
      if (!file) {
        setStatus('ファイルを指定してください', true);
        return;
      }
      var volume = (parseInt(volumeInput.value, 10) || 70) / 100;
      var device = settings.outputDevice || '';
      setStatus('再生中...', false);
      api.notificationTestSound(file, volume, device).then(function (result) {
        if (result && result.ok) {
          setStatus('再生しました', false);
        } else {
          setStatus('再生失敗: ' + (result && result.error ? result.error : '原因不明'), true);
        }
      });
    });
    fileRow.appendChild(testBtn);

    soundCard.appendChild(presetSelect);
    soundCard.appendChild(fileRow);

    function applyPresetMode() {
      var isCustom = presetSelect.value === '__custom__';
      fileInput.disabled = !isCustom;
      pickBtn.disabled = !isCustom;
      fileInput.style.opacity = isCustom ? '1' : '0.6';
      pickBtn.style.opacity = isCustom ? '1' : '0.6';
      pickBtn.style.cursor = isCustom ? 'pointer' : 'not-allowed';
    }

    // プリセット一覧を非同期 fetch して select を populate (= 初期値も自動選択)
    api.notificationListSoundPresets().then(function (presets) {
      if (!Array.isArray(presets)) return;
      localPresets = presets;
      var currentFile = sound.file || '';
      var matchedPresetId = null;
      presets.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.icon + ' ' + p.name + (p.available ? '' : '  (未配置)');
        opt.disabled = !p.available;
        opt.dataset.filePath = p.file_path;
        // 既存 file パスがプリセットのどれかと一致するか判定
        if (p.file_path && currentFile && p.file_path === currentFile) {
          matchedPresetId = p.id;
        }
        presetSelect.appendChild(opt);
      });
      presetSelect.value = matchedPresetId || '__custom__';
      applyPresetMode();
    }).catch(function () {
      presetSelect.value = '__custom__';
      applyPresetMode();
    });

    // 「↺ デフォルトに戻す」: getNotificationEventDefault(def.id).sound_preset_id を localPresets で解決して fileInput +
    // presetSelect + persist を一括更新。 presets fetch 前に押された場合は no-op。
    soundResetBtn.addEventListener('click', function () {
      var targetId = getNotificationEventDefault(def.id).sound_preset_id;
      if (!targetId) return;
      var preset = null;
      for (var i = 0; i < localPresets.length; i++) {
        if (localPresets[i].id === targetId) { preset = localPresets[i]; break; }
      }
      if (!preset) {
        setStatus('プリセット情報が読込中のため再試行してください', true);
        return;
      }
      if (!preset.available) {
        setStatus('デフォルトプリセット ' + targetId + ' のファイルが未配置です', true);
        return;
      }
      fileInput.value = preset.file_path;
      presetSelect.value = preset.id;
      applyPresetMode();
      persist({ sound: { file: preset.file_path } });
      setStatus('音源を「' + preset.name + '」 に戻しました', false);
    });

    presetSelect.addEventListener('change', function () {
      var val = presetSelect.value;
      if (val === '__custom__') {
        applyPresetMode();
        return;
      }
      // プリセット選択 → file_path を取り出して保存 + input 更新
      var opt = presetSelect.options[presetSelect.selectedIndex];
      var path = opt && opt.dataset ? opt.dataset.filePath : '';
      if (path) {
        fileInput.value = path;
        persist({ sound: { file: path } });
      }
      applyPresetMode();
    });

    // 音量
    var volLabel = document.createElement('div');
    volLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;';
    var volPct = Math.round((typeof sound.volume === 'number' ? sound.volume : 0.7) * 100);
    volLabel.textContent = '音量: ' + volPct + '%';
    soundCard.appendChild(volLabel);
    var volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '100';
    volumeInput.value = String(volPct);
    volumeInput.style.cssText = 'width:100%;';
    volumeInput.addEventListener('input', function () {
      volLabel.textContent = '音量: ' + volumeInput.value + '%';
    });
    volumeInput.addEventListener('change', function () {
      persist({ sound: { volume: (parseInt(volumeInput.value, 10) || 70) / 100 } });
    });
    soundCard.appendChild(volumeInput);

    body.appendChild(soundCard);

    // ── 読み上げセクション ──
    var ttsHeader = document.createElement('div');
    ttsHeader.style.cssText = 'font-size:12px;font-weight:600;color:#94a3b8;margin:16px 0 8px;text-transform:uppercase;letter-spacing:0.5px;';
    ttsHeader.textContent = '▼ 読み上げ';
    body.appendChild(ttsHeader);

    var ttsCard = document.createElement('div');
    ttsCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:16px;';

    var ttsOnRow = document.createElement('label');
    ttsOnRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;';
    var ttsOnCb = document.createElement('input');
    ttsOnCb.type = 'checkbox';
    ttsOnCb.checked = !!tts.enabled;
    ttsOnCb.addEventListener('change', function () {
      persist({ tts: { enabled: ttsOnCb.checked } });
    });
    ttsOnRow.appendChild(ttsOnCb);
    var ttsOnLabel = document.createElement('span');
    ttsOnLabel.style.cssText = 'font-size:12px;color:#d8e8e8;';
    ttsOnLabel.textContent = '読み上げる';
    ttsOnRow.appendChild(ttsOnLabel);
    ttsCard.appendChild(ttsOnRow);

    var tplLabel = document.createElement('div');
    tplLabel.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;gap:6px;';
    var tplLabelText = document.createElement('span');
    tplLabelText.textContent = 'テンプレート';
    tplLabel.appendChild(tplLabelText);
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:3px 8px;font-size:10px;color:#94a3b8;cursor:pointer;';
    resetBtn.textContent = '↺ デフォルトに戻す';
    resetBtn.title = 'デフォルト文をこの欄に入れ直す (= 編集起点として使えます)';
    tplLabel.appendChild(resetBtn);
    ttsCard.appendChild(tplLabel);
    var tplInput = document.createElement('textarea');
    // 初期表示はユーザー保存値 or デフォルト文。 これによりユーザーは「デフォルト文を
    // 起点にカスタマイズ」 できる (= 空欄からの試行錯誤がいらない)。
    tplInput.value = tts.template || getNotificationEventDefault(def.id).template;
    tplInput.style.cssText = 'width:100%;min-height:60px;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:13px;padding:8px 10px;font-family:inherit;resize:vertical;box-sizing:border-box;';
    tplInput.addEventListener('change', function () {
      persist({ tts: { template: tplInput.value } });
    });
    ttsCard.appendChild(tplInput);
    resetBtn.addEventListener('click', function () {
      tplInput.value = getNotificationEventDefault(def.id).template;
      persist({ tts: { template: getNotificationEventDefault(def.id).template } });
      updatePreviewDisplay();
    });

    var varsHint = document.createElement('div');
    varsHint.style.cssText = 'font-size:11px;color:#64748b;margin-top:6px;';
    varsHint.textContent = '使える変数: {name} {message} {amount} {currency} {tier} {daysAway} {streamTitle}';
    ttsCard.appendChild(varsHint);

    // リアルタイムプレビュー (= Phase D-3): textarea の入力中に変数代入結果を表示。
    // 「▶ プレビュー」 ボタンは音 (TTS) で確認、 このプレビュー文字列は目で確認する用。
    var previewLabel = document.createElement('div');
    previewLabel.style.cssText = 'font-size:11px;color:#64748b;margin-top:10px;';
    previewLabel.textContent = 'プレビュー (= サンプル値で変数を代入したもの):';
    ttsCard.appendChild(previewLabel);
    var previewDisplay = document.createElement('div');
    previewDisplay.style.cssText = 'background:#0a1622;border:1px solid #1a3a4a;border-radius:6px;padding:8px 10px;margin-top:4px;font-size:12px;color:#bbf7d0;font-family:inherit;min-height:20px;word-break:break-word;white-space:pre-wrap;';
    function updatePreviewDisplay() {
      var sample = previewTemplate(tplInput.value, def);
      // 長すぎるテンプレは末尾省略 (= 300 文字まで)
      if (sample.length > 300) {
        sample = sample.slice(0, 300) + '…';
      }
      previewDisplay.textContent = sample || '(空)';
    }
    updatePreviewDisplay();
    tplInput.addEventListener('input', updatePreviewDisplay);
    ttsCard.appendChild(previewDisplay);

    var previewRow = document.createElement('div');
    previewRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';
    var previewBtn = document.createElement('button');
    previewBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:6px;padding:6px 12px;font-size:12px;color:#00bcd4;cursor:pointer;';
    previewBtn.textContent = '▶ プレビュー';
    previewBtn.addEventListener('click', function () {
      // テンプレ簡易評価 (= サンプル値を代入してプレビュー文を作る)
      var sampleText = previewTemplate(tplInput.value || getNotificationEventDefault(def.id).template, def);
      var provider = settings.provider || 'builtin';
      var device = settings.outputDevice || '';
      setStatus('読み上げ中: 「' + sampleText + '」', false);
      api.notificationPreviewTts(sampleText, provider, device).then(function (result) {
        if (result && result.ok) {
          setStatus('読み上げ完了: 「' + sampleText + '」', false);
        } else {
          setStatus('読み上げ失敗: ' + (result && result.error ? result.error : '原因不明'), true);
        }
      });
    });
    previewRow.appendChild(previewBtn);
    ttsCard.appendChild(previewRow);

    body.appendChild(ttsCard);
  }
}

// プレビュー用のサンプル変数代入。 実発火時とほぼ同じ apply_template ロジックの JS 版。
// {streamTitle} はプレビュー時のみダミー値、 実発火時は live_stream_stats.stream_title。
function previewTemplate(template, def) {
  return (template || getNotificationEventDefault(def.id).template)
    .replace(/\{name\}/g, '山田太郎')
    .replace(/\{message\}/g, 'こんにちは!')
    .replace(/\{amount\}/g, '¥500')
    .replace(/\{currency\}/g, 'JPY')
    .replace(/\{tier\}/g, 'メンバー')
    .replace(/\{daysAway\}/g, '14')
    .replace(/\{streamTitle\}/g, '歌枠 #38');
}

// --- SubsectionNav 登録 (Phase 1: 通知 3 兄弟) ---
// 各 section の親子関係 / 戻り後 hook / scroll target を framework に伝える。
// adopt 経由で既存 HTML の close button + title element を吸収するので、 ヘッダー DOM の
// 書き換えは不要。 close 関数 (= 薄ラッパー) は既存の呼び出し側互換で残置。
// scrollSelector は全 section 共通の '#app-frame .frame-body' (= style.css の
// `.frame#app-frame.editing .frame-body { overflow-y: auto }` が scroll を持つ)。
// section 自身や section 内 body は overflow 設定がないため scrollTop は常に 0。
// scrollTop は frame-body 上に乗っており section 切替で再利用されるが、 framework は
// sectionId 単位で _scrollMemory を分けているので各 section の位置は独立に保存される。
SubsectionNav.register({
  id: 'notification-edit-section',
  parentId: null,
  title: 'コメント通知',
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () { renderApps(); },
});

SubsectionNav.register({
  id: 'notification-event-edit-section',
  parentId: 'notification-edit-section',
  title: function () { return currentNotificationEventLabel; },
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () {
    // 設定が変わった可能性があるので親 view を差分更新 (= rebuild しないので scroll 維持)
    refreshNotificationView();
  },
});

SubsectionNav.register({
  id: 'notification-provider-edit-section',
  parentId: 'notification-edit-section',
  title: function () { return currentNotificationProviderLabel; },
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () {
    // 親 view を差分更新 (= rebuild しないので scroll 維持)
    refreshNotificationView();
  },
});

// UI 整理 Phase 2-2: app-card → unit-card (mock 仕様) に全面書き換え。
// 引数互換 (extraActions の color/borderColor/background/boxShadow/minWidth は維持)、
// 第 9 引数 opts {iconSvg, global, urlPlaceholder} を追加。
function createAppCard(name, url, onSettings, badge, onEffects, enabled, onToggle, extraActions, opts) {
  opts = opts || {};
  var card = document.createElement('div');
  card.className = 'unit-card' + (opts.global ? ' unit-card-global' : '');

  var row = document.createElement('div');
  row.className = 'unit-card-row';

  if (opts.iconSvg) {
    var iconEl = document.createElement('span');
    iconEl.className = 'unit-icon';
    iconEl.innerHTML = opts.iconSvg;
    row.appendChild(iconEl);
  }

  var nameEl = document.createElement('span');
  nameEl.className = 'unit-name';
  nameEl.textContent = name;
  nameEl.title = name;
  row.appendChild(nameEl);

  if (badge) {
    var badgeEl = document.createElement('span');
    badgeEl.className = 'unit-badge app-card-badge';
    badgeEl.textContent = badge;
    row.appendChild(badgeEl);
  }

  var actions = document.createElement('div');
  actions.className = 'unit-actions';

  if (onEffects) {
    var effectsBtn = document.createElement('button');
    effectsBtn.className = 'u-btn';
    effectsBtn.type = 'button';
    effectsBtn.textContent = 'エフェクト';
    effectsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      onEffects();
    });
    actions.appendChild(effectsBtn);
  }

  if (onToggle) {
    var toggleBtn = document.createElement('button');
    var isOn = enabled !== false;
    toggleBtn.type = 'button';
    toggleBtn.className = 'u-btn' + (isOn ? ' on' : '');
    toggleBtn.textContent = isOn ? 'ON' : 'OFF';
    function markBusy(label) {
      toggleBtn.className = 'u-btn';
      toggleBtn.textContent = label || '処理中…';
      toggleBtn.disabled = true;
    }
    // 楽観的トグル: 押下と同時に視覚を切り替えて、 async 完了の renderApps を待たずに
    // 即反応させる用。 失敗時は renderApps の再描画で正しい状態に戻る。 TTS のように
    // 長い async (= bouyomi 停止) を持つカードは markBusy を、 通知のように short
    // async (= app-config 保存だけ) のカードは setVisualToggle を選んで使う。
    function setVisualToggle(enabled) {
      toggleBtn.className = 'u-btn' + (enabled ? ' on' : '');
      toggleBtn.textContent = enabled ? 'ON' : 'OFF';
    }
    toggleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (toggleBtn.disabled) return;
      onToggle({ markBusy: markBusy, setVisualToggle: setVisualToggle });
    });
    actions.appendChild(toggleBtn);
  }

  if (Array.isArray(extraActions)) {
    extraActions.forEach(function (action) {
      if (!action || typeof action.onClick !== 'function') return;
      var extraBtn = document.createElement('button');
      extraBtn.type = 'button';
      var cls = 'u-btn';
      if (action.variant === 'amber') cls += ' amber';
      else if (action.variant === 'danger') cls += ' danger';
      else if (action.variant === 'ponout') cls += ' ponout';
      if (action.active) cls += ' on';
      extraBtn.className = cls;
      // 旧呼び出し互換: color/borderColor/background/boxShadow/minWidth は inline style で受ける
      var inline = '';
      if (action.color) inline += 'color:' + action.color + ';';
      if (action.borderColor) inline += 'border-color:' + action.borderColor + ';';
      if (action.background) inline += 'background:' + action.background + ';';
      if (action.boxShadow) inline += 'box-shadow:' + action.boxShadow + ';';
      if (action.minWidth) inline += 'min-width:' + action.minWidth + ';justify-content:center;';
      if (inline) extraBtn.style.cssText = inline;
      extraBtn.textContent = action.label || '操作';
      if (action.title) extraBtn.title = action.title;
      if (action.disabled) {
        extraBtn.disabled = true;
        extraBtn.style.opacity = '0.5';
        extraBtn.style.cursor = 'default';
      }
      extraBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (extraBtn.disabled) return;
        action.onClick();
      });
      actions.appendChild(extraBtn);
    });
  }

  if (onSettings) {
    var settingsBtn = document.createElement('button');
    settingsBtn.className = 'u-btn';
    settingsBtn.type = 'button';
    settingsBtn.textContent = '設定';
    settingsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      onSettings();
    });
    actions.appendChild(settingsBtn);
  }

  row.appendChild(actions);
  card.appendChild(row);

  // url bar (= mock の OBS drag&drop URL 行)
  var hasUrl = typeof url === 'string' && /^https?:\/\//.test(url);
  if (hasUrl || opts.urlPlaceholder !== false) {
    var urlEl = document.createElement('div');
    urlEl.className = 'unit-url';
    urlEl.draggable = hasUrl;

    var urlIcon = document.createElement('span');
    urlIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>';
    urlEl.appendChild(urlIcon);

    var urlText = document.createElement('span');
    urlText.className = 'unit-url-text';
    urlText.textContent = url || 'サイドカー起動待ち';
    urlText.title = hasUrl ? 'OBS にドラッグ&ドロップで追加 / クリックでコピー' : (url || '');
    urlEl.appendChild(urlText);

    if (hasUrl) {
      var urlHint = document.createElement('span');
      urlHint.className = 'hint';
      urlHint.textContent = '↓ OBS';
      urlEl.appendChild(urlHint);

      urlEl.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/uri-list', url);
        e.dataTransfer.setData('text/plain', url);
        e.dataTransfer.effectAllowed = 'copy';
      });
      urlEl.addEventListener('click', function () {
        navigator.clipboard.writeText(url);
      });
    } else {
      urlEl.style.opacity = '0.65';
      urlEl.style.cursor = 'default';
    }

    card.appendChild(urlEl);
  }

  return card;
}

// コメント連動演出の全体設定 (= 最大同時演出数 / 同一ユーザー間隔)。
// 演出リスト (= performance-list-section) のヘッダ「全体設定」ボタンから、
// 個別設定と同じ subsection ナビゲーションで開く (= 旧モーダルから移行)。
function showGlobalCooldownSettings() {
  var bodyEl = document.getElementById('global-cooldown-edit-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = '';

  var errorEl = document.createElement('div');
  errorEl.style.cssText = 'display:none;background:#3b1111;border:1px solid #7f1d1d;border-radius:6px;color:#fecaca;font-size:12px;padding:8px 10px;margin-bottom:12px;';
  bodyEl.appendChild(errorEl);

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = '';
  }

  function createNumberField(labelText, value, suffix, hint) {
    var field = document.createElement('label');
    field.style.cssText = 'display:block;margin-bottom:14px;';

    var label = document.createElement('div');
    label.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:6px;';
    label.textContent = labelText;
    field.appendChild(label);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';

    var input = document.createElement('input');
    input.type = 'number';
    input.value = value;
    input.style.cssText = 'flex:1;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:14px;padding:8px 10px;';
    row.appendChild(input);

    var suffixEl = document.createElement('span');
    suffixEl.style.cssText = 'font-size:12px;color:#64748b;width:36px;';
    suffixEl.textContent = suffix;
    row.appendChild(suffixEl);

    field.appendChild(row);

    if (hint) {
      var hintEl = document.createElement('div');
      hintEl.style.cssText = 'font-size:11px;color:#475569;margin-top:4px;line-height:1.5;';
      hintEl.textContent = hint;
      field.appendChild(hintEl);
    }

    return { field: field, input: input };
  }

  var loading = document.createElement('div');
  loading.style.cssText = 'font-size:13px;color:#64748b;padding:8px 0;';
  loading.textContent = '読み込み中...';
  bodyEl.appendChild(loading);

  SubsectionNav.open('global-cooldown-edit-section');

  api.getGlobalCooldown().then(function (settings) {
    settings = settings || {};
    loading.remove();

    var maxField = createNumberField(
      '最大同時演出数',
      settings.maxEffects != null ? settings.maxEffects : 30,
      '件',
      '画面に同時に出す演出数の上限です。重い素材が多い場合は下げます。通常コメ・リアクションは上限到達で破棄されますが、 スパチャ・メンバーシップ・手動ポン出しは破棄されず queue で待機して必ず発火します。'
    );
    maxField.input.min = '1';
    maxField.input.step = '1';
    bodyEl.appendChild(maxField.field);

    var userField = createNumberField(
      '同一ユーザー間隔',
      settings.userInterval != null ? settings.userInterval : 5,
      '秒',
      '同じユーザーの連投で演出が出続けるのを抑えます。0 で無効です。スパチャ・メンバーシップ (= 課金 trigger) には適用されません (= 連投高額スパチャも全て発火)。'
    );
    userField.input.min = '0';
    userField.input.step = '0.5';
    bodyEl.appendChild(userField.field);

    var queueNote = document.createElement('div');
    queueNote.style.cssText = 'background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#64748b;font-size:11px;line-height:1.6;padding:10px;margin-bottom:16px;';
    queueNote.textContent = 'テスト発火も同じ演出上限を通るため、 上限中はすぐ表示されないことがあります。';
    bodyEl.appendChild(queueNote);

    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'display:none;font-size:12px;margin-bottom:12px;color:#bbf7d0;';
    bodyEl.appendChild(statusEl);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

    var saveBtn = document.createElement('button');
    saveBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:6px;padding:8px 14px;font-size:12px;color:#00e5ff;cursor:pointer;';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      errorEl.style.display = 'none';
      statusEl.style.display = 'none';
      var maxEffects = parseInt(maxField.input.value, 10);
      var userInterval = parseFloat(userField.input.value);
      if (!Number.isFinite(maxEffects) || maxEffects < 1) {
        showError('最大同時演出数は 1 以上の整数にしてください。');
        return;
      }
      if (!Number.isFinite(userInterval) || userInterval < 0) {
        showError('同一ユーザー間隔は 0 以上の数値にしてください。');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
      rendererLog.info('user: global-cooldown-save, maxEffects=' + maxEffects + ', userInterval=' + userInterval);
      api.setGlobalCooldown({ maxEffects: maxEffects, userInterval: userInterval }).then(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        statusEl.textContent = '保存しました。';
        statusEl.style.display = '';
      }).catch(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        showError('保存に失敗しました。');
      });
    });
    actions.appendChild(saveBtn);

    bodyEl.appendChild(actions);
  }).catch(function () {
    loading.remove();
    showError('設定の読み込みに失敗しました。');
  });
}

function renderPonoutButtons(scene) {
  var container = document.getElementById('ponout-buttons');
  if (!container) return;
  container.innerHTML = '';

  var performances = scene.performances || [];
  var count = 0;
  performances.forEach(function (perf) {
    if (!perf.ponout) return;
    if (perf.requiresContext) return;
    count += 1;

    var btn = document.createElement('button');
    btn.className = 'ponout-btn';
    btn.title = 'クリックするとこの演出を手動発火します。混雑時は短い queue に入り、順番に表示されます。';
    var firstAsset = perf.assets && perf.assets[0] ? perf.assets[0] : '🎉';
    if (/\.(png|jpg|jpeg|gif|apng|svg|webp)$/i.test(firstAsset)) {
      var ponImg = document.createElement('img');
      ponImg.src = buildLocalHttpUrl('/effects/' + selectedSceneId + '/assets/' + firstAsset);
      ponImg.style.cssText = 'width:16px;height:16px;object-fit:contain;vertical-align:middle;margin-right:4px;';
      btn.appendChild(ponImg);
      btn.appendChild(document.createTextNode(perf.name));
    } else {
      var icon = /\.webm$/i.test(firstAsset) ? '🎬' : firstAsset;
      btn.textContent = icon + ' ' + perf.name;
    }
    btn.addEventListener('click', function () {
      api.triggerManual(selectedSceneId, perf.id);
    });
    container.appendChild(btn);
  });

  if (count === 0) {
    var empty = document.createElement('span');
    empty.className = 'ponout-empty';
    empty.textContent = '演出編集で「ポン出しバーに表示」を ON にすると、ここから手動発火できます。';
    container.appendChild(empty);
  }
}

// === 演出リスト画面 ===

function openPerformanceList() {
  updateSceneLock();

  // エフェクト一覧とプラグインマニフェストをキャッシュ（演出編集時に同期的に使用）
  Promise.all([
    api.getPerformances(selectedSceneId),
    api.getEffects(),
    api.getPluginManifests()
  ]).then(function (results) {
    cachedEffects = results[1];
    cachedPluginManifests = results[2];
    renderPerformanceList(results[0]);
  });

  // section 表示 + enter は framework に委譲
  SubsectionNav.open('performance-list-section');
}

// summary text 構築 helper (= 差分更新時にも使うので外出し)。 トリガー条件 +
// effect 名併記 (= 一覧から effect が分かるように)
function buildPerformanceSummaryText(trigger, effectId) {
  var triggerText = '';
  if (trigger) {
    if (trigger.type === 'keyword') {
      var kwTexts = (trigger.keywords || []).map(function (kw) { return typeof kw === 'object' ? kw.text : kw; });
      triggerText = kwTexts.join(', ') || '全コメント';
    } else if (trigger.type === 'superchat') {
      triggerText = trigger.minAmount ? '¥' + trigger.minAmount + '以上' : '全額';
    } else if (trigger.type === 'reaction') {
      var rt = trigger.reactionTypes || ['heart', 'smile', 'celebration', 'surprise', 'hundred'];
      triggerText = rt.length === 5 ? '全リアクション' : rt.join(', ');
    } else if (trigger.type === 'manual') {
      triggerText = 'ポン出し';
    }
    var listenerLabel = listenerConditionSummary(trigger);
    if (listenerLabel) triggerText += ' / ' + listenerLabel;
  }
  var effectName = '';
  var effId = effectId || 'com.comment-hub.cracker';
  var effs = cachedEffects || [];
  for (var i = 0; i < effs.length; i++) {
    if (effs[i].id === effId) { effectName = effs[i].name; break; }
  }
  if (effectName) return triggerText ? triggerText + ' / → ' + effectName : '→ ' + effectName;
  return triggerText;
}

// effect icon 再構築 helper (= 行頭 icon を差分更新時にも使う)
function applyPerformanceIcon(iconEl, effectId) {
  iconEl.innerHTML = '';
  iconEl.appendChild(createEffectIconEl(effectIcon(effectId || 'com.comment-hub.cracker'), 18));
}

function renderPerformanceList(performances) {
  var list = document.getElementById('perf-list');
  if (!list) return;
  list.innerHTML = '';

  var dragSrcItem = null;

  // 差分更新用 ref + click handler 用 cache を初期化
  performanceViewRefs = { listEl: list, items: {} };
  performancesCache = performances;

  performances.forEach(function (perf) {
    var item = document.createElement('div');
    item.className = 'perf-item';
    item.setAttribute('data-perf-id', perf.id);
    item.draggable = true;

    // ドラッグ&ドロップ
    item.addEventListener('dragstart', function (e) {
      dragSrcItem = item;
      setInternalReorderDragActive(true);
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', perf.id);
    });
    item.addEventListener('dragend', function () {
      item.style.opacity = '';
      dragSrcItem = null;
      setInternalReorderDragActive(false);
      list.querySelectorAll('.perf-item').forEach(function (el) { el.classList.remove('perf-drag-over'); });
    });
    item.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcItem && dragSrcItem !== item) {
        item.classList.add('perf-drag-over');
      }
    });
    item.addEventListener('dragleave', function () {
      item.classList.remove('perf-drag-over');
    });
    item.addEventListener('drop', function (e) {
      e.preventDefault();
      item.classList.remove('perf-drag-over');
      if (!dragSrcItem || dragSrcItem === item) return;

      // DOM上で並べ替え
      var items = Array.from(list.querySelectorAll('.perf-item'));
      var fromIdx = items.indexOf(dragSrcItem);
      var toIdx = items.indexOf(item);
      if (fromIdx < toIdx) {
        list.insertBefore(dragSrcItem, item.nextSibling);
      } else {
        list.insertBefore(dragSrcItem, item);
      }

      // 新しい順序を保存
      var orderedIds = Array.from(list.querySelectorAll('.perf-item')).map(function (el) {
        return el.getAttribute('data-perf-id');
      });
      api.reorderPerformances(selectedSceneId, orderedIds);
    });

    // 行頭 effect icon (= 通知イベント row の iconEl と同位置)
    var iconEl = document.createElement('div');
    iconEl.className = 'perf-effect-icon';
    applyPerformanceIcon(iconEl, perf.effect);

    // info (= name + summary)
    var info = document.createElement('div');
    info.className = 'perf-info';
    var name = document.createElement('div');
    name.className = 'perf-name';
    name.textContent = perf.name;
    var summary = document.createElement('div');
    summary.className = 'perf-summary';
    summary.textContent = buildPerformanceSummaryText(perf.trigger, perf.effect);
    info.appendChild(name);
    info.appendChild(summary);

    // toggle (= .u-btn ON/OFF、 通知 イベント / TTS と統一)
    var toggle = document.createElement('button');
    toggle.type = 'button';
    function applyToggleAppearance(enabled) {
      toggle.className = 'u-btn' + (enabled ? ' on' : '');
      toggle.textContent = enabled ? 'ON' : 'OFF';
    }
    applyToggleAppearance(perf.enabled);
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var nextEnabled = !perf.enabled;
      applyToggleAppearance(nextEnabled);  // 楽観的更新、 broadcast で再描画される
      api.setPerformanceEnabled(selectedSceneId, perf.id, nextEnabled);
    });

    // 「⚙ 設定」 ボタン (= 詳細編集画面に遷移、 row click は廃止)
    var settingsBtn = document.createElement('button');
    settingsBtn.className = 'perf-settings-btn';
    settingsBtn.textContent = '⚙ 設定';
    settingsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      // 差分更新後に perf 内容が古くなる可能性があるため performancesCache から id で
      // 最新を引く (= refresh 経由で cache 更新済み)
      var latest = (performancesCache || []).find(function (p) { return p.id === perf.id; });
      openPerformanceEdit(latest || perf);
    });

    item.appendChild(iconEl);
    item.appendChild(info);
    item.appendChild(toggle);
    item.appendChild(settingsBtn);

    list.appendChild(item);
    performanceViewRefs.items[perf.id] = {
      nameEl: name,
      summaryEl: summary,
      toggleEl: toggle,
      iconEl: iconEl,
    };
  });
}

// 子 section (= performance-edit-section) から戻った時に親 view を rebuild せず
// 差分更新する。 通知側 refreshNotificationView / tts 側 refreshTtsView と同パターン。
// 件数 or 並び順が変わっていれば renderPerformanceList で rebuild にフォールバック。
function refreshPerformanceListView() {
  if (!performanceViewRefs) return;
  Promise.all([
    api.getPerformances(selectedSceneId),
    api.getEffects(),
    api.getPluginManifests()
  ]).then(function (results) {
    var performances = results[0];
    cachedEffects = results[1];
    cachedPluginManifests = results[2];
    if (!performanceViewRefs) return;

    // 件数 / 並び順が一致するか判定
    var newIds = performances.map(function (p) { return p.id; });
    var domIds = Array.from(performanceViewRefs.listEl.querySelectorAll('.perf-item'))
      .map(function (el) { return el.getAttribute('data-perf-id'); });
    var sameStructure = newIds.length === domIds.length;
    if (sameStructure) {
      for (var i = 0; i < newIds.length; i++) {
        if (domIds[i] !== newIds[i]) { sameStructure = false; break; }
      }
    }
    if (!sameStructure) {
      // 件数 / 並び順変化 → 全 rebuild (= scroll は失われるが安全)
      renderPerformanceList(performances);
      return;
    }
    // 同じ → 各 perf-item を ref 経由で in-place 更新 (= scroll 維持)
    performancesCache = performances;
    performances.forEach(function (perf) {
      var refs = performanceViewRefs.items[perf.id];
      if (!refs) return;
      refs.nameEl.textContent = perf.name;
      refs.summaryEl.textContent = buildPerformanceSummaryText(perf.trigger, perf.effect);
      var enabled = !!perf.enabled;
      refs.toggleEl.className = 'u-btn' + (enabled ? ' on' : '');
      refs.toggleEl.textContent = enabled ? 'ON' : 'OFF';
      applyPerformanceIcon(refs.iconEl, perf.effect);
    });
  });
}

// 演出リスト section は SubsectionNav.register の adopt 経由で framework が close button を bind
SubsectionNav.register({
  id: 'performance-list-section',
  parentId: null,
  title: 'コメント連動演出',
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () {
    updateSceneLock();
    refreshSceneUI();
    api.reloadOverlays();
  },
});

// 演出追加ボタン
(function () {
  var btn = document.getElementById('perf-add-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      var newPerf = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: '新しい演出',
        enabled: true,
        trigger: { type: 'keyword', keywords: [], regex: false },
        effect: 'com.comment-hub.cracker',
        assets: [],
        sounds: [],
        ponout: false,
        cooldown: 0
      };
      rendererLog.info('user: performance-create, sceneId=' + selectedSceneId + ', perfId=' + newPerf.id);
      // 先に保存してから編集画面を開く
      api.savePerformance(selectedSceneId, newPerf).then(function () {
        openPerformanceEdit(newPerf, true);
      });
    });

    // 演出インポートボタン (= 「+ 演出を追加」 の下に同じ width で並べる)
    var importBtn = document.createElement('button');
    importBtn.className = 'perf-add-btn';
    importBtn.textContent = '📥 インポート';
    importBtn.addEventListener('click', function () {
      rendererLog.info('user: performance-import, sceneId=' + selectedSceneId);
      api.importPerformance(selectedSceneId).then(function (result) {
        if (!result || result.cancelled) return;
        if (!result.ok) {
          showZipActionError(result, '演出のインポートに失敗しました。');
          return;
        }
        openPerformanceList();
      });
    });
    btn.parentNode.appendChild(importBtn);
  }
})();

// === 演出設定画面 ===

var editingPerformance = null;
var cachedEffects = null; // エフェクト一覧キャッシュ
var cachedPluginManifests = null; // プラグインマニフェストキャッシュ（type → manifest）
var cachedTemplateManifests = null; // テンプレートマニフェストキャッシュ（name → manifest）
var isNewPerformance = false;
var kwRegexModeOn = false;
var pendingAutoSave = null; // closePerformanceEditで即フラッシュ用
var performanceModified = false; // 新規作成で何か変更されたかのフラグ

function openPerformanceEdit(perf, isNew) {
  editingPerformance = JSON.parse(JSON.stringify(perf));
  isNewPerformance = !!isNew;
  performanceModified = false;
  kwRegexModeOn = false;
  updateSceneLock();

  // 動的 title を更新 (= framework が title fn 経由で読む)
  currentPerformanceEditTitle = isNew ? '新しい演出' : (perf.name || '演出');

  renderPerformanceEditForm();

  // section 表示 + 親 (perf-list) hide は framework が担当
  SubsectionNav.open('performance-edit-section');
}

// 薄ラッパー: 自動削除 / auto-save flush は SubsectionNav.close 前に。 戻り後の
// performance-list 再 fetch は register の onReturn (= openPerformanceList を呼ぶ) で。
function closePerformanceEdit() {
  // 新規作成で未変更のまま戻った場合は自動削除
  if (isNewPerformance && !performanceModified && editingPerformance) {
    if (pendingAutoSave) {
      clearTimeout(pendingAutoSave.timer);
      pendingAutoSave = null;
    }
    rendererLog.info('user: performance-auto-delete (new+unmodified), sceneId=' + selectedSceneId + ', perfId=' + editingPerformance.id);
    api.deletePerformance(selectedSceneId, editingPerformance.id);
  } else if (pendingAutoSave) {
    // pending中の自動保存を即実行
    clearTimeout(pendingAutoSave.timer);
    pendingAutoSave.save();
    pendingAutoSave = null;
  }
  isNewPerformance = false;
  performanceModified = false;
  SubsectionNav.close('performance-edit-section');
}

function renderPerformanceEditForm() {
  // 拡張版が下で再定義される
}

// フォームヘルパー
function createField(label, input, hint) {
  var field = document.createElement('div');
  field.className = 'perf-field';
  var labelEl = document.createElement('div');
  labelEl.className = 'perf-field-label';
  labelEl.textContent = label;
  field.appendChild(labelEl);
  field.appendChild(input);
  if (hint) {
    var hintEl = document.createElement('div');
    hintEl.className = 'perf-field-hint';
    hintEl.textContent = hint;
    field.appendChild(hintEl);
  }
  return field;
}

function createInput(value, onChange) {
  var input = document.createElement('input');
  input.className = 'perf-field-input';
  input.type = 'text';
  input.value = value || '';
  input.addEventListener('input', function () { onChange(input.value); });
  return input;
}

function createSelect(value, options, onChange) {
  var select = document.createElement('select');
  select.className = 'perf-field-select';
  options.forEach(function (opt) {
    var option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === value) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener('change', function () { onChange(select.value); });
  return select;
}

function createTextarea(value, onChange) {
  var textarea = document.createElement('textarea');
  textarea.className = 'perf-keywords';
  textarea.value = value || '';
  textarea.addEventListener('change', function () { onChange(textarea.value); });
  return textarea;
}

function createAmountInput(value, onChange) {
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;gap:8px;align-items:center;';
  var label1 = document.createElement('span');
  label1.style.cssText = 'font-size:12px;color:#4a6a7a;';
  label1.textContent = '¥';
  var input = document.createElement('input');
  input.className = 'perf-field-input';
  input.type = 'number';
  input.value = value;
  input.style.width = '80px';
  input.style.textAlign = 'right';
  input.addEventListener('change', function () { onChange(input.value); });
  var label2 = document.createElement('span');
  label2.style.cssText = 'font-size:12px;color:#4a6a7a;';
  label2.textContent = '以上';
  wrapper.appendChild(label1);
  wrapper.appendChild(input);
  wrapper.appendChild(label2);
  return wrapper;
}

function createCooldownInput(value, onChange) {
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;gap:8px;align-items:center;';
  var input = document.createElement('input');
  input.className = 'perf-field-input';
  input.type = 'number';
  input.value = value;
  input.min = '0';
  input.max = '300';
  input.style.width = '60px';
  input.style.textAlign = 'center';
  input.addEventListener('change', function () { onChange(input.value); });
  var unit = document.createElement('span');
  unit.style.cssText = 'font-size:12px;color:#4a6a7a;';
  unit.textContent = '秒';
  wrapper.appendChild(input);
  wrapper.appendChild(unit);
  return wrapper;
}

function createListenerConditionEditor(p, autoSave) {
  if (!p.trigger) p.trigger = {};
  if (typeof autoSave !== 'function') autoSave = function () {};
  var field = document.createElement('div');
  field.className = 'perf-field';
  var details = document.createElement('details');
  details.className = 'listener-condition-editor';

  var summary = document.createElement('summary');
  var title = document.createElement('span');
  title.textContent = 'リスナー条件';
  var value = document.createElement('span');
  value.className = 'listener-condition-summary';
  value.textContent = listenerConditionSummary(p.trigger) || '指定なし';
  summary.appendChild(title);
  summary.appendChild(value);
  details.appendChild(summary);

  var presetOptions = [
    { value: '', label: '指定なし' },
    { value: 'first-time', label: '初見のみ' },
    { value: 'returning', label: '再訪のみ' },
    { value: 'regular-arrival', label: '今北のみ' },
    { value: 'long-absence', label: '帰還のみ' },
    { value: 'regular', label: '常連のみ' },
    { value: 'custom', label: 'カスタム' }
  ];
  var boolOptions = [
    { value: '', label: '指定なし' },
    { value: 'yes', label: 'はい' },
    { value: 'no', label: 'いいえ' }
  ];

  function refreshSummary() {
    value.textContent = listenerConditionSummary(p.trigger) || '指定なし';
  }

  function clearCustomConditions() {
    p.trigger.listenerHasPriorComment = '';
    p.trigger.listenerFirstCommentInStream = '';
    p.trigger.listenerRegular = '';
  }

  var presetField = document.createElement('div');
  presetField.className = 'listener-condition-grid listener-condition-preset';
  var presetLabel = document.createElement('label');
  presetLabel.textContent = '条件';
  var initialMode = hasCustomListenerCondition(p.trigger) ? 'custom' : (p.trigger.listenerStatus || '');
  presetLabel.appendChild(createSelect(initialMode, presetOptions, function (v) {
    if (v === 'custom') {
      p.trigger.listenerStatus = '';
    } else {
      p.trigger.listenerStatus = v;
      clearCustomConditions();
    }
    customGrid.style.display = v === 'custom' ? 'grid' : 'none';
    refreshSummary();
    autoSave();
  }));
  presetField.appendChild(presetLabel);
  details.appendChild(presetField);

  var grid = document.createElement('div');
  grid.className = 'listener-condition-grid';
  grid.style.display = initialMode === 'custom' ? 'grid' : 'none';
  var customGrid = grid;
  [
    ['過去コメント', 'listenerHasPriorComment', boolOptions],
    ['この配信で初コメ', 'listenerFirstCommentInStream', boolOptions],
    ['常連', 'listenerRegular', boolOptions]
  ].forEach(function (item) {
    var label = document.createElement('label');
    label.textContent = item[0];
    label.appendChild(createSelect(p.trigger[item[1]] || '', item[2], function (v) {
      p.trigger[item[1]] = v;
      refreshSummary();
      autoSave();
    }));
    grid.appendChild(label);
  });
  details.appendChild(grid);

  var hint = document.createElement('div');
  hint.className = 'perf-field-hint';
  hint.textContent = 'まずはプリセットを選びます。細かく指定したい場合だけカスタムを選び、下の条件を組み合わせます。';
  details.appendChild(hint);
  field.appendChild(details);
  return field;
}

// 演出設定 section は SubsectionNav.register の adopt 経由で framework が close button bind
SubsectionNav.register({
  id: 'performance-edit-section',
  parentId: 'performance-list-section',
  title: function () { return currentPerformanceEditTitle; },
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () {
    // 親 view を差分更新 (= 件数 / 並び順が変わっていなければ ref ベース in-place、
    // 変わっていれば renderPerformanceList で rebuild にフォールバック)。
    // rebuild を避けることで framework の rAF scroll 復元が機能する。
    refreshPerformanceListView();
  },
});

// コメント連動演出の全体設定 section (= 演出リストヘッダの「全体設定」ボタンから、
// 個別演出設定と同じ subsection ナビゲーションで開く)。close button は framework が adopt。
SubsectionNav.register({
  id: 'global-cooldown-edit-section',
  parentId: 'performance-list-section',
  title: 'コメント連動演出の全体設定',
  scrollSelector: '#app-frame .frame-body',
});

(function () {
  var btn = document.getElementById('perf-global-settings-btn');
  if (btn) btn.addEventListener('click', showGlobalCooldownSettings);
})();

// シーン追加ボタン
(function () {
  var btn = document.getElementById('add-scene-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      if (guardSceneSideWhileTemplateEditing()) return;
      // インラインダイアログでシーン名を入力
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
      var dialog = document.createElement('div');
      dialog.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;min-width:300px;';
      var label = document.createElement('div');
      label.style.cssText = 'font-size:13px;color:#c9d1d9;margin-bottom:8px;';
      label.textContent = 'シーン名を入力:';
      var input = document.createElement('input');
      input.type = 'text';
      input.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;color:#c9d1d9;outline:none;';
      input.addEventListener('focus', function () { input.style.borderColor = '#00bcd4'; });
      input.addEventListener('blur', function () { input.style.borderColor = '#30363d'; });
      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
      var cancelBtn = document.createElement('button');
      cancelBtn.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:4px;padding:5px 14px;font-size:12px;color:#8b949e;cursor:pointer;';
      cancelBtn.textContent = 'キャンセル';
      var okBtn = document.createElement('button');
      okBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:4px;padding:5px 14px;font-size:12px;color:#00bcd4;cursor:pointer;';
      okBtn.textContent = '作成';
      function submit() {
        var name = input.value.trim();
        if (name) {
          rendererLog.info('user: scene-create, name=' + name);
          api.createScene(name).then(function (newId) {
            if (newId) {
              // setSelectedScene → broadcast 経由で selectedSceneId 更新 + 再描画。
              api.setSelectedScene(newId);
            }
          });
        }
        overlay.remove();
      }
      cancelBtn.addEventListener('click', function () { overlay.remove(); });
      okBtn.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') overlay.remove();
      });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      dialog.appendChild(label);
      dialog.appendChild(input);
      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      setTimeout(function () { input.focus(); }, 50);
    });

    // UI 整理 Phase 2: シーンインポート/エクスポートは設定モーダルへ移行
    // (= 旧 scene-col 内の importBtn は廃止、ハンドラは importSceneFromFile() に集約)
  }
})();

// === エフェクト管理画面 ===

function openEffectManager() {
  // Phase 5: section 骨組み + header は index.html 側に静的化済。 本関数は body の
  // 中身だけ動的構築する。 旧実装は performance-list / performance-edit を手動 hide
  // していたが、 framework 経由なら openPerformanceList の close (= 兄弟 section
  // 関係なし、 メインアプリ top にいるという前提) で十分。 ただし安全策として既存
  // 兄弟 section が表示中なら明示 close する。
  var bodyEl = document.getElementById('effect-manager-body');
  if (!bodyEl) return;

  // 兄弟 section (= performance-list/edit) が表示中なら閉じる (= 既存挙動互換)
  if (SubsectionNav._openStack.indexOf('performance-list-section') >= 0) {
    SubsectionNav.close('performance-list-section');
  }

  bodyEl.innerHTML = '';
  updateSceneLock();

  // エフェクト一覧
  api.getEffects().then(function (effects) {
    var list = document.createElement('div');
    list.style.cssText = 'padding:8px;';

    effects.forEach(function (eff) {
      var item = document.createElement('div');
      item.className = 'perf-item';

      var info = document.createElement('div');
      info.className = 'perf-info';
      var name = document.createElement('div');
      name.className = 'perf-name';
      name.textContent = eff.name;
      var desc = document.createElement('div');
      desc.className = 'perf-summary';
      desc.textContent = eff.builtin ? 'ビルトイン' : 'カスタム';
      info.appendChild(name);
      info.appendChild(desc);

      var badge = document.createElement('span');
      var bc = eff.badgeColor || { bg: '#1a2742', fg: '#94a3b8' };
      badge.className = 'perf-badge';
      badge.style.background = bc.bg;
      badge.style.color = bc.fg;
      badge.textContent = eff.builtin ? 'デフォルト' : 'カスタム';

      var chevron = document.createElement('span');
      chevron.className = 'perf-chevron';
      chevron.textContent = '›';

      var exportBtn = document.createElement('button');
      exportBtn.style.cssText = 'background:none;border:1px solid #1a3a4a;border-radius:4px;padding:4px 10px;font-size:11px;color:#94a3b8;cursor:pointer;margin-left:auto;';
      exportBtn.textContent = '📤';
      exportBtn.title = 'エクスポート';
      exportBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        rendererLog.info('user: effect-export (effect-manager), effectId=' + eff.id);
        api.exportEffect(eff.id, eff.name).then(function (result) {
          if (!result || result.ok || result.cancelled) return;
          showZipActionError(result, 'エフェクトのエクスポートに失敗しました。');
        });
      });

      item.appendChild(info);
      item.appendChild(badge);
      item.appendChild(exportBtn);
      item.appendChild(chevron);
      item.addEventListener('click', function () {
        showAlertDialog('エフェクト設定: ' + eff.name + '\nID: ' + eff.id + '\nバージョン: ' + (eff.version || '不明') + '\n（詳細設定画面は開発中）');
      });

      list.appendChild(item);
    });

    bodyEl.appendChild(list);

    // インポートボタン
    var importBtn = document.createElement('button');
    importBtn.className = 'perf-add-btn';
    importBtn.textContent = '📥 エフェクトをインポート';
    importBtn.addEventListener('click', function () {
      rendererLog.info('user: effect-import (effect-manager)');
      api.importEffect().then(function (result) {
        if (!result || result.cancelled) return;
        if (result.needsUpgrade && result.upgradeInfo) {
          var info = result.upgradeInfo;
          var msg = 'エフェクト「' + info.effectName + '」を v' + info.currentVersion + ' → v' + info.newVersion + ' にアップグレードしますか？\n\n現在の設定は自動バックアップされます。';
          showPromptDialog(msg, null, function (ok) {
            if (!ok) return;
            api.confirmUpgradeEffect(result.zipPath, info.effectId).then(function (upgradeResult) {
              if (upgradeResult && upgradeResult.upgraded) {
                openEffectManager();
              } else {
                showAlertDialog('アップグレードに失敗しました: ' + (upgradeResult && upgradeResult.error || '不明なエラー'));
              }
            }).catch(function () { showAlertDialog('アップグレードに失敗しました。'); });
          });
          return;
        }
        if (!result.ok) {
          showZipActionError(result, 'エフェクトのインポートに失敗しました。');
          return;
        }
        if (result.effectId) {
          openEffectManager();
        }
      });
    });
    bodyEl.appendChild(importBtn);
  });

  // section 表示 + enter は framework に委譲
  SubsectionNav.open('effect-manager-section');
}

SubsectionNav.register({
  id: 'effect-manager-section',
  parentId: null,
  title: 'エフェクト管理',
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () { updateSceneLock(); },
});

// === 演出設定画面: 素材・効果音編集の追加 ===

// renderPerformanceEditFormを拡張（素材・効果音セクション追加）
var _origRenderPerformanceEditForm = renderPerformanceEditForm;
renderPerformanceEditForm = function () {
  var body = document.getElementById('perf-edit-body');
  if (!body || !editingPerformance) return;
  var p = editingPerformance;

  body.innerHTML = '';

  // フォーカス保護: 非同期DOM操作後にフォーカスを復元
  var lastFocusedInput = null;
  body.addEventListener('focusin', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      lastFocusedInput = e.target;
    }
  }, true);
  function restoreFocus() {
    if (lastFocusedInput && document.body.contains(lastFocusedInput)) {
      lastFocusedInput.focus();
    }
  }

  // 自動保存（変更のたびに呼ばれる）
  var autoSaveTimer = null;
  function doSave() {
    autoSaveTimer = null;
    pendingAutoSave = null;
    api.savePerformance(selectedSceneId, p);
  }
  function autoSave() {
    performanceModified = true;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(doSave, 300);
    pendingAutoSave = { timer: autoSaveTimer, save: doSave };
  }

  // 素材変更時にrequiresContextを再評価
  function recheckRequiresContext() {
    var hasHtmlAsset = false;
    if (p.assets && p.assets.length > 0) {
      for (var i = 0; i < p.assets.length; i++) {
        if (p.assets[i].indexOf('.html') !== -1) { hasHtmlAsset = true; break; }
      }
    }
    if (hasHtmlAsset) {
      // HTML素材あり → requiresContextは素材追加時に設定済み
      return;
    }
    if (!p.assets || p.assets.length === 0) {
      // 素材なし → デフォルトテンプレートを確認
      api.checkDefaultTemplateContext(p.effect).then(function (result) {
        p.requiresContext = !!result;
        autoSave();
        restoreFocus();
      });
    } else {
      // 絵文字/画像のみ → コンテキスト不要
      p.requiresContext = false;
    }
  }

  // 演出名 + テストボタン
  var nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:flex-end;gap:10px;margin-bottom:14px;';
  var nameField = createField('演出名', createInput(p.name, function (v) { p.name = v; autoSave(); }));
  nameField.style.flex = '1';
  nameField.style.marginBottom = '0';
  nameRow.appendChild(nameField);

  var testBtn = document.createElement('button');
  testBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:4px;padding:6px 12px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
  testBtn.title = 'クリックで保存後にテスト発火します。長押しするとスパチャ tier やリアクション種別などのテスト条件を変更できます。';
  var isReactionTrigger = p.trigger && p.trigger.type === 'reaction';
  // テストモード: 'force'=強制発火, 'tier'=Tier/エモーション巡回, 'custom'=カスタム
  testBtn._testMode = 'force';
  testBtn._customContext = null;
  testBtn._customReaction = null; // リアクション用カスタムキー
  function updateTestBtnLabel() {
    var mode = testBtn._testMode;
    if (mode === 'tier') testBtn.textContent = isReactionTrigger ? '▶ エモーション巡回' : '▶ Tier巡回';
    else if (mode === 'custom') testBtn.textContent = isReactionTrigger ? '▶ ' + (testBtn._customReaction || '❤') : '▶ カスタム';
    else testBtn.textContent = '▶ テスト';
  }
  updateTestBtnLabel();

  // 長押しでセットアップウィンドウ（click抑制フラグ付き）
  var longPressTimer = null;
  var longPressFired = false;
  testBtn.addEventListener('mousedown', function () {
    longPressFired = false;
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      longPressFired = true;
      showTestSetupDialog(testBtn, p, updateTestBtnLabel, isReactionTrigger);
    }, 600);
  });
  testBtn.addEventListener('mouseup', function () {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });
  testBtn.addEventListener('mouseleave', function () {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  testBtn.addEventListener('click', function () {
    if (longPressFired) { longPressFired = false; return; }
    api.savePerformance(selectedSceneId, p).then(function () {
      var mode = testBtn._testMode;
      if (isReactionTrigger) {
        // リアクショントリガー
        if (mode === 'custom' && testBtn._customReaction) {
          api.triggerTestReactionCustom(selectedSceneId, p.id, testBtn._customReaction).then(function (result) {
            if (result && result.matched === false) {
              testBtn.textContent = '✕ 不一致（発火せず）';
              setTimeout(updateTestBtnLabel, 2000);
            }
          });
        } else if (mode === 'tier') {
          api.triggerTestReaction(selectedSceneId, p.id).then(function (result) {
            if (result && typeof result === 'object') {
              testBtn.textContent = '▶ 次: ' + (result.nextLabel || 'エモーション巡回');
            }
          });
        } else {
          api.triggerTestReaction(selectedSceneId, p.id).then(function (result) {
            if (result && typeof result === 'object') {
              testBtn.textContent = '▶ 次: ' + (result.nextLabel || 'テスト');
            }
          });
        }
      } else {
        // コメント系トリガー
        if (mode === 'custom' && testBtn._customContext) {
          api.triggerTestWithContext(selectedSceneId, p.id, testBtn._customContext).then(function (result) {
            if (result && result.matched === false) {
              testBtn.textContent = '✕ 不一致（発火せず）';
              setTimeout(updateTestBtnLabel, 2000);
            }
          });
        } else if (mode === 'tier') {
          api.triggerTest(selectedSceneId, p.id).then(function (result) {
            if (result && typeof result === 'object') {
              testBtn.textContent = '▶ 次: ' + (result.nextLabel || 'Tier巡回');
            }
          });
        } else {
          api.triggerTest(selectedSceneId, p.id).then(function (result) {
            if (result && typeof result === 'object') {
              testBtn.textContent = '▶ 次: ' + (result.nextLabel || 'テスト');
            }
          });
        }
      }
    });
  });

  nameRow.appendChild(testBtn);
  body.appendChild(nameRow);

  var testHint = document.createElement('div');
  testHint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin:-8px 0 14px;';
  testHint.textContent = 'テストは見た目と条件確認用です。クリックで現在の設定を保存して発火、長押しでテスト条件を変更します。上限中は queue の後に表示されることがあります。';
  body.appendChild(testHint);

  // トリガー + エフェクト（横並び）
  var row = document.createElement('div');
  row.className = 'perf-field-row';

  var triggerOptions = [
    { value: 'keyword', label: 'キーワード' },
    { value: 'superchat', label: 'スパチャ' },
    { value: 'reaction', label: 'リアクション' },
    { value: 'manual', label: '手動（ポン出し専用）' }
  ];
  row.appendChild(createField('トリガー', createSelect(p.trigger ? p.trigger.type : 'keyword', triggerOptions, function (v) {
    if (!p.trigger) p.trigger = {};
    p.trigger.type = v;
    // 手動トリガーは自動でポン出しON
    if (v === 'manual') p.ponout = true;
    autoSave();
    renderPerformanceEditForm();
  })));

  var effects = cachedEffects || [];
  var effectOptions = effects.map(function (e) { return { value: e.id, label: e.name }; });
  row.appendChild(createField('エフェクト', createSelect(p.effect, effectOptions, function (v) {
    // 新規で名前がデフォルトまたは他のエフェクト名ならエフェクト名に合わせる
    if (isNewPerformance) {
      var isDefaultName = p.name === '新しい演出';
      if (!isDefaultName) {
        for (var ei2 = 0; ei2 < effectOptions.length; ei2++) {
          if (effectOptions[ei2].label === p.name) { isDefaultName = true; break; }
        }
      }
      if (isDefaultName) {
        for (var ei = 0; ei < effectOptions.length; ei++) {
          if (effectOptions[ei].value === v) { p.name = effectOptions[ei].label; break; }
        }
      }
    }
    p.effect = v;
    // 新規でトリガー未変更なら、固定表示はスパチャをデフォルトに
    if (isNewPerformance) {
      var selType = '';
      for (var eti = 0; eti < effects.length; eti++) {
        if (effects[eti].id === v) { selType = effects[eti].id; break; }
      }
      if (selType === 'com.comment-hub.fixed' && p.trigger && p.trigger.type === 'keyword' && (!p.trigger.keywords || p.trigger.keywords.length === 0)) {
        p.trigger.type = 'superchat';
      }
    }
    recheckRequiresContext();
    autoSave(); renderPerformanceEditForm();
  })));

  body.appendChild(row);

  if (p.trigger && (p.trigger.type === 'keyword' || p.trigger.type === 'superchat')) {
    body.appendChild(createListenerConditionEditor(p, autoSave));
  }

  // トリガー種別に応じた入力
  if (p.trigger && p.trigger.type === 'keyword') {
    var kwField = document.createElement('div');
    kwField.className = 'perf-field';
    var kwLabel = document.createElement('div');
    kwLabel.className = 'perf-field-label';
    kwLabel.textContent = 'キーワード';
    kwField.appendChild(kwLabel);

    // キーワードの後方互換: 文字列配列をオブジェクト配列に変換
    if (p.trigger.keywords) {
      p.trigger.keywords = p.trigger.keywords.map(function (kw) {
        if (typeof kw === 'string') return { text: kw, regex: !!p.trigger.regex };
        return kw;
      });
    }

    var kwHint = document.createElement('div');
    kwHint.className = 'perf-field-hint';
    kwHint.textContent = '空欄で全コメントに反応';
    kwField.appendChild(kwHint);

    // タグ表示
    var kwTags = document.createElement('div');
    kwTags.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;';
    (p.trigger.keywords || []).forEach(function (kw, idx) {
      var tag = document.createElement('span');
      var isRegex = kw.regex;
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;border-radius:4px;padding:2px 8px;font-size:11px;'
        + (isRegex
          ? 'background:#2d1a3a;border:1px solid #7c3aed;color:#c4b5fd;font-family:monospace;'
          : 'background:#1a2742;border:1px solid #1a3a4a;color:#d8e8e8;');
      var tagText = document.createTextNode(kw.text);
      tag.appendChild(tagText);
      var removeTag = document.createElement('span');
      removeTag.style.cssText = 'color:#ef4444;cursor:pointer;font-size:10px;margin-left:4px;';
      removeTag.textContent = '✕';
      removeTag.addEventListener('click', function () {
        p.trigger.keywords.splice(idx, 1);
        autoSave();
        renderPerformanceEditForm();
      });
      tag.appendChild(removeTag);
      kwTags.appendChild(tag);
    });
    kwField.appendChild(kwTags);

    // 入力欄 + 正規表現チェック + 追加ボタン
    var kwInputRow = document.createElement('div');
    kwInputRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
    var kwInput = document.createElement('input');
    kwInput.className = 'perf-field-input';
    kwInput.type = 'text';
    kwInput.placeholder = 'キーワードを入力';
    kwInput.style.flex = '1';

    var kwRegexBtn = document.createElement('button');
    kwRegexBtn.style.cssText = 'border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;white-space:nowrap;font-family:monospace;'
      + (kwRegexModeOn ? 'background:#2d1a3a;border:1px solid #7c3aed;color:#c4b5fd;' : 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;');
    kwRegexBtn.textContent = '.*';
    kwRegexBtn.title = '正規表現モード（クリックで切替）';
    kwRegexBtn.addEventListener('click', function () {
      kwRegexModeOn = !kwRegexModeOn;
      kwRegexBtn.style.background = kwRegexModeOn ? '#2d1a3a' : '#1a2742';
      kwRegexBtn.style.borderColor = kwRegexModeOn ? '#7c3aed' : '#1a3a4a';
      kwRegexBtn.style.color = kwRegexModeOn ? '#c4b5fd' : '#64748b';
    });

    var kwAddBtn = document.createElement('button');
    kwAddBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 12px;font-size:11px;color:#94a3b8;cursor:pointer;white-space:nowrap;';
    kwAddBtn.textContent = '追加';

    function addKeyword() {
      var val = kwInput.value.trim();
      if (!val) return;
      if (!p.trigger.keywords) p.trigger.keywords = [];
      var isRegex = kwRegexModeOn;
      var newKws = val.split('\n').map(function (k) { return k.trim(); }).filter(function (k) { return k; });
      newKws.forEach(function (k) {
        var exists = p.trigger.keywords.some(function (existing) { return existing.text === k; });
        if (!exists) p.trigger.keywords.push({ text: k, regex: isRegex });
      });
      kwInput.value = '';
      autoSave();
      renderPerformanceEditForm();
    }

    kwAddBtn.addEventListener('click', addKeyword);
    kwInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addKeyword(); }
    });

    kwInputRow.appendChild(kwInput);
    kwInputRow.appendChild(kwAddBtn);
    kwField.appendChild(kwInputRow);

    var kwOptionRow = document.createElement('div');
    kwOptionRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;';
    kwOptionRow.appendChild(kwRegexBtn);
    var kwRegexHint = document.createElement('span');
    kwRegexHint.style.cssText = 'font-size:10px;color:#475569;';
    kwRegexHint.textContent = '正規表現として追加';
    kwOptionRow.appendChild(kwRegexHint);
    kwField.appendChild(kwOptionRow);

    body.appendChild(kwField);
  } else if (p.trigger && p.trigger.type === 'superchat') {
    body.appendChild(createField('金額条件', createAmountInput(p.trigger.minAmount || 0, function (v) {
      p.trigger.minAmount = parseInt(v) || 0; autoSave();
    })));

    var memberChip = document.createElement('button');
    var includeMember = p.trigger.includeMembership !== false;
    memberChip.style.cssText = 'border-radius:4px;padding:6px 14px;font-size:11px;cursor:pointer;margin-bottom:14px;'
      + (includeMember
        ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
        : 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;');
    memberChip.textContent = 'メンバー加入にも反応' + (includeMember ? ' : ON' : ' : OFF');
    memberChip.addEventListener('click', function () {
      p.trigger.includeMembership = !(p.trigger.includeMembership !== false);
      autoSave();
      renderPerformanceEditForm();
    });
    body.appendChild(memberChip);
  } else if (p.trigger && p.trigger.type === 'reaction') {
    var reactionField = document.createElement('div');
    reactionField.className = 'perf-field';
    var reactionLabel = document.createElement('div');
    reactionLabel.className = 'perf-field-label';
    reactionLabel.textContent = 'リアクション種別';
    reactionField.appendChild(reactionLabel);

    var allReactions = [
      { key: 'heart', label: '❤️ ハート' },
      { key: 'smile', label: '😄 スマイル' },
      { key: 'celebration', label: '🎉 お祝い' },
      { key: 'surprise', label: '😮 驚き' },
      { key: 'hundred', label: '💯 100点' }
    ];
    if (!p.trigger.reactionTypes) p.trigger.reactionTypes = ['heart', 'smile', 'celebration', 'surprise', 'hundred'];

    var reactionRow = document.createElement('div');
    reactionRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
    allReactions.forEach(function (r) {
      var isOn = p.trigger.reactionTypes.indexOf(r.key) !== -1;
      var chip = document.createElement('button');
      chip.style.cssText = 'border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer;'
        + (isOn
          ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
          : 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;');
      chip.textContent = r.label;
      chip.addEventListener('click', function () {
        var idx = p.trigger.reactionTypes.indexOf(r.key);
        if (idx !== -1) {
          if (p.trigger.reactionTypes.length <= 1) return; // 最低1つは必要
          p.trigger.reactionTypes.splice(idx, 1);
        } else {
          p.trigger.reactionTypes.push(r.key);
        }
        autoSave();
        renderPerformanceEditForm();
      });
      reactionRow.appendChild(chip);
    });
    reactionField.appendChild(reactionRow);
    body.appendChild(reactionField);
  }

  // 素材
  var assetsField = document.createElement('div');
  assetsField.className = 'perf-field';
  var assetsLabel = document.createElement('div');
  assetsLabel.className = 'perf-field-label';
  assetsLabel.textContent = '素材';
  assetsField.appendChild(assetsLabel);

  var assetsGrid = document.createElement('div');
  assetsGrid.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

  if (!p.assetMeta) p.assetMeta = {};

  (p.assets || []).forEach(function (asset, idx) {
    var thumb = document.createElement('div');
    thumb.style.cssText = 'width:40px;height:40px;background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;position:relative;cursor:pointer;';

    // アイコン表示: テキスト素材はそのまま表示、動画は🎬、画像はサムネイル、その他は📎
    if (!/[./\\]/.test(asset) && !asset.startsWith('data:')) {
      thumb.textContent = asset;
      // 長い文字列はサイズ調整
      if (Array.from(asset).length > 1) {
        thumb.style.fontSize = Math.max(10, 18 / Array.from(asset).length * 1.5) + 'px';
      }
    } else if (/\.webm$/i.test(asset)) {
      thumb.textContent = '🎬';
    } else if (/\.(png|jpg|jpeg|gif|apng|svg|webp)$/i.test(asset)) {
      var thumbImg = document.createElement('img');
      thumbImg.src = buildLocalHttpUrl('/effects/' + selectedSceneId + '/assets/' + asset);
      thumbImg.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:4px;';
      thumb.appendChild(thumbImg);
    } else {
      thumb.textContent = '📎';
    }

    // ホバーで元ファイル名を表示
    var meta = p.assetMeta[asset];
    thumb.title = (meta && meta.originalName) ? meta.originalName : asset;

    var removeBtn = document.createElement('span');
    removeBtn.style.cssText = 'position:absolute;top:-4px;right:-4px;width:14px;height:14px;background:#ef4444;border-radius:50%;font-size:8px;color:white;display:none;align-items:center;justify-content:center;cursor:pointer;';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      p.assets.splice(idx, 1);
      recheckRequiresContext();
      renderPerformanceEditForm();
    });
    thumb.appendChild(removeBtn);
    thumb.addEventListener('mouseenter', function () { removeBtn.style.display = 'flex'; });
    thumb.addEventListener('mouseleave', function () { removeBtn.style.display = 'none'; });

    assetsGrid.appendChild(thumb);
  });

  var addAssetBtn = document.createElement('div');
  addAssetBtn.style.cssText = 'width:40px;height:40px;background:#1a2742;border:1px dashed #1a3a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;color:#475569;cursor:pointer;position:relative;z-index:2;';
  addAssetBtn.textContent = '+';
  addAssetBtn.addEventListener('click', function () {
    // ファイル選択ダイアログを開く。テキスト素材は横の入力欄から。
    api.addPerformanceAsset(selectedSceneId, p.id).then(function (result) {
      if (result && result.filename) {
        if (!p.assets) p.assets = [];
        if (p.assets.length >= 100) return;
        p.assets.push(result.filename);
        if (!p.assetMeta) p.assetMeta = {};
        if (result.originalName) p.assetMeta[result.filename] = { originalName: result.originalName };
        if (result.requiresContext) p.requiresContext = true;
        autoSave();
        renderPerformanceEditForm();
      }
    });
  });
  // ドラッグ&ドロップ対応
  assetsGrid.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.stopPropagation();
    assetsGrid.style.borderColor = '#00bcd4';
    assetsGrid.style.border = '1px dashed #00bcd4';
  });
  assetsGrid.addEventListener('dragleave', function () {
    assetsGrid.style.border = '';
  });
  assetsGrid.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    assetsGrid.style.border = '';
    var files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    var pending = files.length;
    for (var fi = 0; fi < files.length; fi++) {
      (function (file) {
        api.copyPerformanceAsset(selectedSceneId, file.path, p.id).then(function (result) {
          if (result && result.filename) {
            if (!p.assets) p.assets = [];
            if (p.assets.length < 100) {
              p.assets.push(result.filename);
              if (!p.assetMeta) p.assetMeta = {};
              if (result.originalName) p.assetMeta[result.filename] = { originalName: result.originalName };
            }
            if (result.requiresContext) p.requiresContext = true;
          }
          pending--;
          if (pending <= 0) {
            autoSave();
            renderPerformanceEditForm();
          }
        });
      })(files[fi]);
    }
  });

  // テキスト/絵文字入力欄
  var assetTextRow = document.createElement('div');
  assetTextRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
  var assetTextInput = document.createElement('input');
  assetTextInput.className = 'perf-field-input';
  assetTextInput.type = 'text';
  assetTextInput.placeholder = '絵文字/テキストを入力';
  assetTextInput.style.cssText = 'flex:1;font-size:12px;padding:4px 8px;';
  var assetTextBtn = document.createElement('button');
  assetTextBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  assetTextBtn.textContent = '追加';
  function addTextAsset() {
    var val = assetTextInput.value.trim();
    if (!val) return;
    if (!p.assets) p.assets = [];
    if (p.assets.length >= 100) return;
    p.assets.push(val);
    assetTextInput.value = '';
    recheckRequiresContext();
    autoSave();
    renderPerformanceEditForm();
  }
  assetTextBtn.addEventListener('click', addTextAsset);
  assetTextInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addTextAsset(); }
  });
  assetTextRow.appendChild(assetTextInput);
  assetTextRow.appendChild(assetTextBtn);
  assetsGrid.appendChild(addAssetBtn);
  assetsField.appendChild(assetsGrid);
  assetsField.appendChild(assetTextRow);

  var assetsHint = document.createElement('div');
  assetsHint.className = 'perf-field-hint';
  if ((p.assets || []).length >= 100) {
    assetsHint.textContent = '素材数が上限（100）に達しています';
    assetsHint.style.color = '#ef4444';
  } else {
    assetsHint.textContent = '複数指定でランダム選択。ドラッグ&ドロップ可能';
  }
  assetsField.appendChild(assetsHint);
  body.appendChild(assetsField);

  // 効果音（複数対応、素材と同じグリッド形式）
  // 後方互換: sound(単一) → sounds(配列) に移行
  if (!p.sounds && p.sound) { p.sounds = [p.sound]; p.sound = null; }
  if (!p.sounds) p.sounds = [];

  var soundField = document.createElement('div');
  soundField.className = 'perf-field';
  var soundLabel = document.createElement('div');
  soundLabel.className = 'perf-field-label';
  soundLabel.textContent = '効果音';
  soundField.appendChild(soundLabel);

  var soundGrid = document.createElement('div');
  soundGrid.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

  if (!p.soundMeta) p.soundMeta = {};

  p.sounds.forEach(function (snd, idx) {
    var thumb = document.createElement('div');
    thumb.style.cssText = 'width:40px;height:40px;background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;position:relative;cursor:default;';
    thumb.textContent = '🎵';
    var sndMeta = p.soundMeta[snd];
    thumb.title = (sndMeta && sndMeta.originalName) ? sndMeta.originalName : snd;

    var removeBtn = document.createElement('span');
    removeBtn.style.cssText = 'position:absolute;top:-4px;right:-4px;width:14px;height:14px;background:#ef4444;border-radius:50%;font-size:8px;color:white;display:none;align-items:center;justify-content:center;cursor:pointer;';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      p.sounds.splice(idx, 1);
      autoSave();
      renderPerformanceEditForm();
    });
    thumb.addEventListener('mouseenter', function () { removeBtn.style.display = 'flex'; });
    thumb.addEventListener('mouseleave', function () { removeBtn.style.display = 'none'; });
    thumb.appendChild(removeBtn);
    soundGrid.appendChild(thumb);
  });

  var addSoundBtn = document.createElement('div');
  addSoundBtn.style.cssText = 'width:40px;height:40px;background:#1a2742;border:1px dashed #1a3a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;color:#475569;cursor:pointer;';
  addSoundBtn.textContent = '+';
  addSoundBtn.addEventListener('click', function () {
    api.addPerformanceSound(selectedSceneId, p.id).then(function (result) {
      if (result && result.filename) {
        if (p.sounds.length >= 100) return;
        p.sounds.push(result.filename);
        if (!p.soundMeta) p.soundMeta = {};
        if (result.originalName) p.soundMeta[result.filename] = { originalName: result.originalName };
        autoSave();
        renderPerformanceEditForm();
      }
    });
  });
  soundGrid.appendChild(addSoundBtn);

  // ドラッグ&ドロップ
  soundGrid.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.stopPropagation();
    soundGrid.style.border = '1px dashed #00bcd4';
  });
  soundGrid.addEventListener('dragleave', function () {
    soundGrid.style.border = '';
  });
  soundGrid.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    soundGrid.style.border = '';
    var files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    var pending = files.length;
    for (var fi = 0; fi < files.length; fi++) {
      (function (file) {
        if (!/\.(mp3|wav|ogg)$/i.test(file.name)) { pending--; return; }
        api.copyPerformanceAsset(selectedSceneId, file.path, p.id).then(function (result) {
          if (result && result.filename && p.sounds.length < 100) {
            p.sounds.push(result.filename);
            if (!p.soundMeta) p.soundMeta = {};
            if (result.originalName) p.soundMeta[result.filename] = { originalName: result.originalName };
          }
          pending--;
          if (pending <= 0) {
            autoSave();
            renderPerformanceEditForm();
          }
        });
      })(files[fi]);
    }
  });

  soundField.appendChild(soundGrid);

  var soundHint = document.createElement('div');
  soundHint.className = 'perf-field-hint';
  soundHint.textContent = '素材とインデックスが対応。ドラッグ&ドロップ可能';
  soundField.appendChild(soundHint);

  body.appendChild(soundField);

  // エフェクトタイプに応じた設定の出し分け（uiSchemaベース）
  var effectType = '';
  var effs = cachedEffects || [];
  for (var ei = 0; ei < effs.length; ei++) {
    if (effs[ei].id === p.effect) { effectType = effs[ei].id; break; }
  }

  var effectSettingsContainer = document.createElement('div');
  body.appendChild(effectSettingsContainer);
  renderEffectSettings(effectType);

  function renderEffectSettings(type) {
    effectSettingsContainer.innerHTML = '';

    // マニフェストからuiSchemaを取得
    var manifests = cachedPluginManifests || {};
    var manifest = manifests[type];
    if (!manifest || !manifest.uiSchema || manifest.uiSchema.length === 0) return;

    // group 属性を持つ項目は折りたたみセクション (= <details>) にまとめる
    var _groupBodies = {};
    function getContainer(schema) {
      if (!schema.group) return effectSettingsContainer;
      if (!_groupBodies[schema.group]) {
        var details = document.createElement('details');
        details.style.cssText = 'margin:6px 0;border:1px solid #1a3a4a;border-radius:6px;background:#0a1929;overflow:hidden;';
        var summary = document.createElement('summary');
        summary.textContent = schema.group;
        summary.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:12px;font-weight:600;color:#7dd3fc;user-select:none;';
        details.appendChild(summary);
        var gbody = document.createElement('div');
        gbody.style.cssText = 'padding:4px 12px 10px;';
        details.appendChild(gbody);
        effectSettingsContainer.appendChild(details);
        _groupBodies[schema.group] = gbody;
      }
      return _groupBodies[schema.group];
    }

    manifest.uiSchema.forEach(function (schema) {
      // showIf: 指定キーの値が一致しなければスキップ (= テンプレ用 renderTemplateSchemaFields と同じロジック)
      if (schema.showIf) {
        var conditions = Array.isArray(schema.showIf) ? schema.showIf : [schema.showIf];
        var allMet = true;
        for (var ci = 0; ci < conditions.length; ci++) {
          var cond = conditions[ci];
          var dep = p[cond.key];
          if (dep == null) {
            for (var di = 0; di < manifest.uiSchema.length; di++) {
              if (manifest.uiSchema[di].key === cond.key) {
                dep = manifest.uiSchema[di]['default'];
                break;
              }
            }
          }
          if (cond.value === true) { if (!dep) { allMet = false; break; } }
          else if (cond.value === false) { if (dep) { allMet = false; break; } }
          else if (cond.not != null) { if (dep === cond.not) { allMet = false; break; } }
          else { if (dep !== cond.value) { allMet = false; break; } }
        }
        if (!allMet) return;
      }
      if (schema.type === 'slider') {
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;';
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = schema.min;
        slider.max = schema.max;
        if (schema.step) slider.step = schema.step;
        slider.value = p[schema.key] != null ? p[schema.key] : schema.default;
        slider.style.cssText = 'flex:1;';
        var suffix = schema.suffix || '';
        var valWidth = suffix ? '50px' : '30px';
        var val = document.createElement('span');
        val.style.cssText = 'font-size:12px;color:#94a3b8;width:' + valWidth + ';text-align:right;';
        val.textContent = (p[schema.key] != null ? p[schema.key] : schema.default) + suffix;
        slider.addEventListener('input', function () {
          val.textContent = slider.value + suffix;
          p[schema.key] = parseInt(slider.value);
          autoSave();
        });
        row.appendChild(slider);
        row.appendChild(val);
        field.appendChild(row);
        getContainer(schema).appendChild(field);

      } else if (schema.type === 'buttons') {
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;';
        schema.options.forEach(function (opt) {
          var btn = document.createElement('button');
          btn.style.cssText = 'flex:1;border-radius:4px;padding:6px;font-size:11px;cursor:pointer;'
            + (((p[schema.key] != null ? p[schema.key] : schema.default)) === opt.value
              ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
              : 'background:#1a2742;border:1px solid #1a3a4a;color:#94a3b8;');
          btn.textContent = opt.label;
          btn.addEventListener('click', function () {
            p[schema.key] = opt.value;
            autoSave();
            renderEffectSettings(type);
          });
          row.appendChild(btn);
        });
        field.appendChild(row);
        getContainer(schema).appendChild(field);

      } else if (schema.type === 'toggle') {
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var isOn = p[schema.key] != null ? p[schema.key] : schema.default;
        var chip = document.createElement('button');
        chip.style.cssText = 'border-radius:4px;padding:6px 14px;font-size:11px;cursor:pointer;'
          + (isOn
            ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
            : 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;');
        chip.textContent = isOn ? schema.onLabel : schema.offLabel;
        chip.addEventListener('click', function () {
          p[schema.key] = !(p[schema.key] != null ? p[schema.key] : schema.default);
          autoSave();
          renderEffectSettings(type);
        });
        field.appendChild(chip);
        getContainer(schema).appendChild(field);
      } else if (schema.type === 'text' || schema.type === 'textarea') {
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var input = schema.type === 'textarea'
          ? createTextarea(p[schema.key] != null ? p[schema.key] : schema.default, function (v) {
            p[schema.key] = v;
            autoSave();
          })
          : createInput(p[schema.key] != null ? p[schema.key] : schema.default, function (v) {
            p[schema.key] = v;
            autoSave();
          });
        if (schema.placeholder) input.placeholder = schema.placeholder;
        field.appendChild(input);
        if (schema.hint) {
          var hint = document.createElement('div');
          hint.className = 'perf-field-hint';
          hint.textContent = schema.hint;
          field.appendChild(hint);
        }
        getContainer(schema).appendChild(field);
      } else if (schema.type === 'color') {
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var crow = document.createElement('div');
        crow.style.cssText = 'display:flex;gap:8px;align-items:center;';
        var colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = p[schema.key] != null ? p[schema.key] : schema.default;
        colorInput.style.cssText = 'width:40px;height:30px;padding:0;border:1px solid #1a3a4a;border-radius:4px;background:#0a1929;cursor:pointer;';
        var chex = document.createElement('span');
        chex.style.cssText = 'font-size:12px;color:#94a3b8;font-family:monospace;';
        chex.textContent = colorInput.value;
        colorInput.addEventListener('input', function () {
          p[schema.key] = colorInput.value;
          chex.textContent = colorInput.value;
          autoSave();
        });
        crow.appendChild(colorInput);
        crow.appendChild(chex);
        field.appendChild(crow);
        getContainer(schema).appendChild(field);
      } else if (schema.type === 'checks') {
        // 複数選択 (= マルチセレクト)。 値は string[]。 選択トグル方式。
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var crow = document.createElement('div');
        crow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
        (schema.options || []).forEach(function (opt) {
          var cur0 = Array.isArray(p[schema.key]) ? p[schema.key] : (Array.isArray(schema.default) ? schema.default : []);
          var on = cur0.indexOf(opt.value) >= 0;
          var btn = document.createElement('button');
          btn.style.cssText = 'flex:1;min-width:46px;border-radius:4px;padding:6px;font-size:11px;cursor:pointer;'
            + (on
              ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
              : 'background:#1a2742;border:1px solid #1a3a4a;color:#94a3b8;');
          btn.textContent = opt.label;
          btn.addEventListener('click', function () {
            var arr = Array.isArray(p[schema.key]) ? p[schema.key].slice() : (Array.isArray(schema.default) ? schema.default.slice() : []);
            var i = arr.indexOf(opt.value), nowOn;
            if (i >= 0) { arr.splice(i, 1); nowOn = false; } else { arr.push(opt.value); nowOn = true; }
            p[schema.key] = arr;
            autoSave();
            // 全再描画 (renderEffectSettings) はしない: group <details> の開閉やスクロールが
            // リセットされてしまうため、 押したボタンの見た目だけ in-place で更新する。
            btn.style.cssText = 'flex:1;min-width:46px;border-radius:4px;padding:6px;font-size:11px;cursor:pointer;'
              + (nowOn
                ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
                : 'background:#1a2742;border:1px solid #1a3a4a;color:#94a3b8;');
          });
          crow.appendChild(btn);
        });
        field.appendChild(crow);
        if (schema.hint) {
          var hint = document.createElement('div');
          hint.className = 'perf-field-hint';
          hint.textContent = schema.hint;
          field.appendChild(hint);
        }
        getContainer(schema).appendChild(field);
      } else if (schema.type === 'image') {
        var field = document.createElement('div');
        field.className = 'perf-field';
        var label = document.createElement('div');
        label.className = 'perf-field-label';
        label.textContent = schema.label;
        field.appendChild(label);

        var imgKey = schema.key;
        var imgCurrent = p[imgKey] || '';
        var dropZone = document.createElement('div');
        dropZone.style.cssText = 'width:100%;min-height:54px;background:#0a1929;border:1px dashed #1a3a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;position:relative;';

        if (imgCurrent) {
          var preview = document.createElement('img');
          preview.src = buildLocalHttpUrl('/effects/' + selectedSceneId + '/assets/' + imgCurrent);
          preview.style.cssText = 'max-width:100%;max-height:90px;object-fit:contain;';
          dropZone.appendChild(preview);
          var clearBtn = document.createElement('button');
          clearBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.6);border:1px solid #1a3a4a;border-radius:4px;padding:2px 6px;font-size:10px;color:#ef4444;cursor:pointer;';
          clearBtn.textContent = '✕';
          clearBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            delete p[imgKey];
            autoSave();
            renderEffectSettings(type);
          });
          dropZone.appendChild(clearBtn);
        } else {
          var placeholder = document.createElement('span');
          placeholder.style.cssText = 'font-size:11px;color:#475569;';
          placeholder.textContent = '画像をドラッグ&ドロップ / クリックで選択';
          dropZone.appendChild(placeholder);
        }

        var applyEffectImage = function (result) {
          if (result && result.filename) {
            p[imgKey] = result.filename;
            autoSave();
            renderEffectSettings(type);
          }
        };
        dropZone.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = '#00bcd4'; });
        dropZone.addEventListener('dragleave', function () { dropZone.style.borderColor = '#1a3a4a'; });
        dropZone.addEventListener('drop', function (e) {
          e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = '#1a3a4a';
          var files = e.dataTransfer.files;
          if (files && files.length > 0 && files[0].path) {
            api.copyPerformanceAsset(selectedSceneId, files[0].path, p.id).then(applyEffectImage);
          }
        });
        dropZone.addEventListener('click', function () {
          api.addPerformanceAsset(selectedSceneId, p.id).then(applyEffectImage);
        });
        field.appendChild(dropZone);
        getContainer(schema).appendChild(field);
      }
    });
  } // end renderEffectSettings

  // クールダウン
  body.appendChild(createField('クールダウン', createCooldownInput(p.cooldown != null ? p.cooldown : 0, function (v) {
    p.cooldown = parseInt(v) || 0; autoSave();
  })));

  // ポン出し設定（requiresContextの演出は設定不可）
  if (!p.requiresContext) {
    var ponoutChip = document.createElement('button');
    ponoutChip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;margin-bottom:14px;'
      + (p.ponout
        ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
        : 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;');
    ponoutChip.textContent = 'ポン出しバーに表示';
    ponoutChip.addEventListener('click', function () {
      p.ponout = !p.ponout;
      autoSave();
      renderPerformanceEditForm();
    });
    body.appendChild(ponoutChip);

    var ponoutHint = document.createElement('div');
    ponoutHint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin:-6px 0 14px;';
    ponoutHint.textContent = 'ON にするとメイン画面のポン出しバーに出ます。ポン出しはコメント条件を待たずに手動で出す演出で、混雑時は短い queue に入ります。';
    body.appendChild(ponoutHint);
  }

  // フッター
  var footer = document.createElement('div');
  footer.className = 'perf-edit-footer';

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'perf-btn-delete';
  deleteBtn.textContent = '削除';
  deleteBtn.addEventListener('click', function () {
    showPromptDialog('「' + (p.name || '新しい演出') + '」を削除しますか？', null, function (ok) {
      if (!ok) return;
      rendererLog.info('user: performance-delete, sceneId=' + selectedSceneId + ', perfId=' + p.id);
      api.deletePerformance(selectedSceneId, p.id).then(function () {
        isNewPerformance = false;
        closePerformanceEdit();
      });
    });
  });

  var resetBtn = document.createElement('button');
  resetBtn.style.cssText = 'background:none;border:1px solid #1a3a4a;border-radius:4px;padding:6px 12px;font-size:11px;color:#94a3b8;cursor:pointer;';
  resetBtn.textContent = 'デフォルトに戻す';
  resetBtn.addEventListener('click', function () {
    showPromptDialog('設定をデフォルトに戻しますか？', null, function (ok) {
      if (!ok) return;

      // リセット先の決定:
      // - ビルトイン演出 (= 出荷シーンプリセット electron/defaults に同 scene+id が定義済) は
      //   そのプリセット値 (= 初見歓迎ならネオン看板) に戻す。
      // - ユーザー追加演出は preset=null となり、 従来どおり manifest uiSchema 既定に戻す。
      // 優先順位: シーンプリセット値 > manifest 既定 > delete。 delete 経路は undefined で
      // plugin fallback chain 事故が起きるため最後の手段 ([[feedback_no_legacy_compat_for_bug_data]] 隣接規律)。
      api.getDefaultPerformance(selectedSceneId, p.id).then(function (preset) {
        var manifests = cachedPluginManifests || {};
        var manifest = manifests[effectType];
        if (manifest && manifest.uiSchema) {
          manifest.uiSchema.forEach(function (schema) {
            if (preset && preset[schema.key] !== undefined) {
              p[schema.key] = preset[schema.key];
            } else if (schema['default'] !== undefined) {
              p[schema.key] = schema['default'];
            } else {
              delete p[schema.key];
            }
          });
        }

        // 素材のリセット確認
        var hasAssets = (p.assets && p.assets.length > 0) || (p.sounds && p.sounds.length > 0);
        if (hasAssets) {
          showPromptDialog('素材の設定も全て解除しますか？', null, function (ok2) {
            if (ok2) {
              p.assets = [];
              p.sounds = [];
              p.assetMeta = {};
              p.soundMeta = {};
            }
            autoSave();
            renderPerformanceEditForm();
          });
          return;
        }

        autoSave();
        renderPerformanceEditForm();
      });
    });
  });

  var exportBtn = document.createElement('button');
  exportBtn.style.cssText = 'background:none;border:1px solid #1a3a4a;border-radius:4px;padding:6px 12px;font-size:11px;color:#94a3b8;cursor:pointer;';
  exportBtn.textContent = 'エクスポート';
  exportBtn.addEventListener('click', function () {
    rendererLog.info('user: performance-export, sceneId=' + selectedSceneId + ', perfId=' + p.id);
    api.exportPerformance(selectedSceneId, p.id, p.name).then(function (result) {
      if (!result || result.ok || result.cancelled) return;
      showZipActionError(result, '演出のエクスポートに失敗しました。');
    });
  });

  footer.appendChild(deleteBtn);
  footer.appendChild(resetBtn);
  footer.appendChild(exportBtn);
  body.appendChild(footer);
};

// 初期化
refreshSceneUI();

// Rust コア準備完了後にシーン一覧を再取得
if (api.onCoreReady) {
  api.onCoreReady(function () {
    refreshSceneUI();
    refreshTemplateList();
  });
}

// scene / performance の変更通知 (broadcast 駆動の正本)。
// 編集中フォーム (performance-edit-section) は active editing 中なので body は触らず、
// サイドバーだけ整える。
if (api.onScenesChanged) {
  api.onScenesChanged(function (payload) {
    if (payload && payload.kind === 'selection' && payload.sceneId) {
      selectedSceneId = payload.sceneId;
    }
    var editSection = document.getElementById('performance-edit-section');
    var perfListSection = document.getElementById('performance-list-section');
    var editingActive = editSection && editSection.style.display !== 'none';
    if (editingActive) {
      api.getSceneList().then(function (scenes) {
        if (Array.isArray(scenes)) renderSceneList(scenes);
      });
      return;
    }
    if (perfListSection && perfListSection.style.display !== 'none') {
      api.getPerformances(selectedSceneId).then(function (performances) {
        if (Array.isArray(performances)) renderPerformanceList(performances);
      });
    }
    refreshSceneUI();
  });
}

// === テンプレート管理UI ===

var tmplListEl = document.getElementById('tmpl-list');
var tmplHeaderEl = document.getElementById('tmpl-header');

var TYPE_LABELS = {
  builtin: 'ビルトイン',
  custom: 'カスタム',
  oneComme: 'わんコメ互換'
};

function refreshTemplateList() {
  // シーンデータ・テンプレート一覧・マニフェストを並行取得
  return Promise.all([
    window.api.getScene(selectedSceneId),
    window.api.getSceneTemplates(selectedSceneId),
    window.api.getTemplateManifests()
  ]).then(function (results) {
    var scene = results[0];
    var data = results[1];
    cachedTemplateManifests = results[2] || {};
    var templatesEnabled = scene ? scene.templatesEnabled !== false : true;
    renderTemplateList(
      data.sceneTemplates || [],
      data.availableTemplates || [],
      templatesEnabled,
      data.selectedTemplateId || (scene && scene.selectedTemplateId) || ''
    );
  });
}

function renderTemplateList(sceneTemplates, availableTemplates, templatesEnabled, selectedTemplateId) {
  currentSceneTemplates = sceneTemplates || [];
  currentAvailableTemplates = availableTemplates || [];
  currentSelectedTemplateId = selectedTemplateId || '';
  currentTemplatesEnabled = templatesEnabled !== false;
  tmplListEl.innerHTML = '';
  // UI 整理 Phase 2-4: tmpl-header DOM は廃止 (= SCENE 見出しに統合)。null ガードで no-op。
  if (tmplHeaderEl) tmplHeaderEl.style.display = '';

  var existingToggle = document.getElementById('tmpl-scene-toggle');
  if (existingToggle) existingToggle.remove();

  // テンプレート情報のルックアップ
  var tmplInfoMap = {};
  availableTemplates.forEach(function (t) { tmplInfoMap[t.id] = t; });
  currentTemplateInfoMap = tmplInfoMap;
  var selectedTemplate = getSceneTemplateById(currentSelectedTemplateId, sceneTemplates) || sceneTemplates[0] || null;
  var selectedId = selectedTemplate ? (selectedTemplate.id || selectedTemplate.name) : '';
  var selectedInfo = selectedId
    ? getTemplateInfoForRoute(selectedId, tmplInfoMap[selectedId] || { id: selectedId, name: selectedId, displayName: selectedId, templateType: 'custom' }, tmplInfoMap)
    : { displayName: 'テンプレート未選択', templateType: 'custom' };
  var selectedUrl = buildLocalHttpUrl(buildSelectedTemplateRoutePath(selectedSceneId));
  // コメント表示テンプレートカード:
  //   - バッジは選択中テンプレ名
  //   - ON/OFF は templatesEnabled トグル (setSceneTemplatesEnabled)
  //   - アクションは [プレビュー] [設定] (= ポン出し画面ボタンは演出カードへ移動)
  var badgeText = selectedTemplate
    ? (selectedInfo.displayName || selectedInfo.id || selectedInfo.name || '')
    : '未選択';

  var tmplEnabled = currentTemplatesEnabled;
  var card = createAppCard(
    'コメント表示テンプレート',
    selectedUrl,
    function () {
      openTemplateSettings(selectedTemplate, selectedInfo);
    },
    badgeText,
    null,
    tmplEnabled,
    function (ctx) {
      // setSceneTemplatesEnabled は短い async。楽観的に視覚切替し、応答後にリスト再描画。
      var nextEnabled = !tmplEnabled;
      rendererLog.info('user: templates-enabled-toggle, enabled=' + nextEnabled);
      if (ctx && typeof ctx.setVisualToggle === 'function') ctx.setVisualToggle(nextEnabled);
      window.api.setSceneTemplatesEnabled(selectedSceneId, nextEnabled).then(function () {
        refreshTemplateList();
      }).catch(function (err) {
        rendererLog.debug('setSceneTemplatesEnabled failed:', err);
        refreshTemplateList();
      });
    },
    selectedTemplate ? [
      {
        label: 'プレビュー',
        title: '?preview=1 でブラウザ表示',
        onClick: function () {
          if (window.api && window.api.openExternal && selectedUrl) {
            window.api.openExternal(buildTemplatePreviewUrl(selectedUrl));
          }
        }
      }
    ] : null,
    { iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>' }
  );

  if (selectedTemplate) {
    var manifest = cachedTemplateManifests[selectedId];
    var obsHint = manifest && manifest.obsHint;
    if (obsHint) {
      var sizeRow = document.createElement('div');
      sizeRow.style.cssText = 'margin:4px 16px 0;display:flex;justify-content:flex-end;align-items:center;gap:6px;';

      var sizeLabel = document.createElement('span');
      sizeLabel.style.cssText = 'font-size:11px;color:#94a3b8;';
      sizeLabel.textContent = 'OBS推奨サイズ: ' + obsHint;
      sizeRow.appendChild(sizeLabel);

      var helpBtn = document.createElement('button');
      helpBtn.type = 'button';
      helpBtn.textContent = '?';
      helpBtn.title = 'OBS サイズの仕組みを表示';
      helpBtn.style.cssText = 'font-size:10px;width:18px;height:18px;line-height:1;padding:0;border-radius:50%;background:#1a2742;border:1px solid #1a3a4a;color:#94a3b8;cursor:pointer;flex-shrink:0;';
      helpBtn.addEventListener('mouseenter', function () { helpBtn.style.borderColor = '#00bcd4'; helpBtn.style.color = '#00bcd4'; });
      helpBtn.addEventListener('mouseleave', function () { helpBtn.style.borderColor = '#1a3a4a'; helpBtn.style.color = '#94a3b8'; });
      sizeRow.appendChild(helpBtn);

      card.appendChild(sizeRow);

      var helpPanel = document.createElement('div');
      helpPanel.style.cssText = 'display:none;margin:6px 16px 0;padding:10px 12px;background:#0a1929;border:1px solid #1a3a4a;border-left:3px solid #00bcd4;border-radius:4px;font-size:11px;color:#94a3b8;line-height:1.7;';
      helpPanel.innerHTML = ''
        + '<div style="font-weight:600;color:#d8e8e8;margin-bottom:6px;">OBS でサイズを変えると文字まで拡大/縮小される理由</div>'
        + 'OBS のブラウザソースには 2 種類のサイズ概念があります。'
        + '<div style="margin-top:8px;"><b style="color:#d8e8e8;">①「幅 × 高さ」プロパティ</b>: ページ自体が描画される解像度。ここを変えると <b>文字サイズはそのまま</b>で領域だけ広がる/狭まる (推奨)</div>'
        + '<div style="margin-top:6px;"><b style="color:#d8e8e8;">② シーン内のドラッグリサイズ</b>: 描画後の画像を OBS が一律ストレッチ。<b>文字もアバターも一緒に拡大/縮小される</b> (テンプレ側で防げない)</div>'
        + '<div style="margin-top:8px;font-weight:600;color:#d8e8e8;">推奨ワークフロー</div>'
        + '<div style="margin-top:4px;">1. OBS でソースを右クリック → <b>プロパティ</b></div>'
        + '<div>2. <b>幅 / 高さ</b>を上の推奨サイズに合わせる</div>'
        + '<div>3. シーン内では <b>位置だけ動かす</b> (ドラッグで大きさは変えない)</div>'
        + '<div>4. 大きく/小さく出したい場合は <b>プロパティの幅・高さを再設定</b>。これなら文字サイズは維持される</div>'
        + '<div style="margin-top:8px;color:#64748b;">※ 万一ドラッグでサイズが変わってしまったら、ソースを右クリック → 「変換」 → 「変換をリセット」で元に戻せます</div>';
      card.appendChild(helpPanel);

      helpBtn.addEventListener('click', function () {
        var open = helpPanel.style.display !== 'none';
        helpPanel.style.display = open ? 'none' : 'block';
        helpBtn.textContent = open ? '?' : '×';
        helpBtn.title = open ? 'OBS サイズの仕組みを表示' : 'ヘルプを閉じる';
      });
    }
  }

  tmplListEl.appendChild(card);
}

// --- テンプレート設定パネル ---

var CUSTOM_CSS_EXAMPLES = [
  '/* コメント本文を太くする */',
  '/* .text { font-weight: 700; } */',
  '',
  '/* コメント全体に半透明の背景や角丸を付ける */',
  '/* .comment { background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px; } */',
  '',
  '/* コメント同士の間隔を広げる */',
  '/* #comments { gap: 16px; } */',
  '',
  '/* 名前文字の見やすさを上げる（影を付ける） */',
  '/* .name { text-shadow: 0 0 4px rgba(0,0,0,0.8); } */',
  '',
  '/* コメント本文の見やすさを上げる（影を付ける） */',
  '/* .text { text-shadow: 0 0 4px rgba(0,0,0,0.8); } */',
  '',
  '/* スパチャだけ左線を付けて目立たせる */',
  '/* .comment.is-superchat { border-left: 3px solid #ffb74d; padding-left: 8px; } */',
  '',
  '/* ステッカーを大きくする */',
  '/* .sticker { height: 4em; } */',
  '',
  '/* 本文内の絵文字や画像を大きくする */',
  '/* .text img { height: 2em; } */',
  '',
  '/* 1ライン表示で名前と本文の間隔を広げる */',
  '/* .name-inline .body-wrap { gap: 8px; } */',
  '',
  '/* アバターの大きさを変更する */',
  '/* .avatar { --avatar-size: 1.8em; } */'
].join('\n');

var COMMON_TEMPLATE_UI_SCHEMA = [
  {
    key: 'customCss',
    type: 'textarea',
    label: 'カスタムCSS',
    'default': CUSTOM_CSS_EXAMPLES
  },
  {
    key: 'testBackgroundColor',
    type: 'color',
    label: 'テスト背景色',
    'default': '#111827'
  }
];

// 全対応テンプレに自動付与する共通レイアウト設定 (表示位置 左/右 + 横幅)。
// runtime の applyCommonLayout が config.position / config.width を body.kh-pos-* /
// --kh-stage-width に流し、common.css (Group A) または各テンプレ CSS (Group B) が解釈する。
// OneComme 形式 (common.css 非依存) と ticker (横スクロールで左右/横幅が無意味、
// manifest.commonLayout=false で opt-out) は対象外。新規テンプレも自動で付く。
var COMMON_LAYOUT_UI_SCHEMA = [
  {
    key: 'width',
    type: 'slider',
    label: '横幅',
    min: 240,
    max: 1280,
    step: 10,
    'default': 480,
    suffix: 'px'
  },
  {
    key: 'position',
    type: 'buttons',
    label: '表示位置',
    'default': 'left',
    options: [
      { value: 'left', label: '左' },
      { value: 'right', label: '右' }
    ]
  }
];

var COMMON_TEMPLATE_FONT_UI_SCHEMA = [
  {
    key: 'nameFont',
    type: 'font',
    label: '名前のフォント',
    'default': ''
  },
  {
    key: 'textFont',
    type: 'font',
    label: 'コメントのフォント',
    'default': ''
  }
];

var STANDARD_TEMPLATE_EXTENSION_SCHEMA = [
  {
    key: 'memberColor',
    type: 'toggle',
    label: 'メンバーシップ色分け',
    'default': false,
    onLabel: 'ON',
    offLabel: 'OFF'
  },
  {
    key: 'memberColorValue',
    type: 'color',
    label: 'メンバーの名前色',
    'default': '#2ba640',
    showIf: { key: 'memberColor', value: true }
  },
  {
    key: 'paddingTop',
    type: 'slider',
    label: '上パディング',
    min: 0,
    max: 200,
    step: 1,
    'default': 12,
    suffix: 'px',
    showIf: [{ key: 'backgroundImage', value: true }, { key: 'direction', value: 'down' }]
  },
  {
    key: 'paddingBottom',
    type: 'slider',
    label: '下パディング',
    min: 0,
    max: 200,
    step: 1,
    'default': 12,
    suffix: 'px',
    showIf: [{ key: 'backgroundImage', value: true }, { key: 'direction', value: 'up' }]
  },
  {
    key: 'paddingLeft',
    type: 'slider',
    label: '左パディング',
    min: 0,
    max: 200,
    step: 1,
    'default': 12,
    suffix: 'px',
    showIf: { key: 'backgroundImage', value: true }
  },
  {
    key: 'paddingRight',
    type: 'slider',
    label: '右パディング',
    min: 0,
    max: 200,
    step: 1,
    'default': 12,
    suffix: 'px',
    showIf: { key: 'backgroundImage', value: true }
  }
];

function getSchemaItem(schema, key) {
  for (var i = 0; i < schema.length; i++) {
    if (schema[i] && schema[i].key === key) return schema[i];
  }
  return null;
}

function hasAnyTemplateSetting(settings, keys) {
  if (!settings) return false;
  for (var i = 0; i < keys.length; i++) {
    if (settings[keys[i]] != null) return true;
  }
  return false;
}

function isStandardLikeTemplateSchema(manifest, templateSchema, settings, info) {
  if (hasAnyTemplateSetting(settings, ['memberColor', 'memberColorValue', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'])) {
    return true;
  }

  var backgroundItem = getSchemaItem(templateSchema, 'backgroundImage');
  return !!(backgroundItem && backgroundItem.type === 'image');
}

function appendMissingSchemaItems(target, extras) {
  var existingKeys = {};
  target.forEach(function (s) {
    if (s && s.key) existingKeys[s.key] = true;
  });
  extras.forEach(function (s) {
    if (!s || !s.key || existingKeys[s.key]) return;
    target.push(s);
    existingKeys[s.key] = true;
  });
}

function prependMissingSchemaItems(target, extras) {
  var existingKeys = {};
  target.forEach(function (s) {
    if (s && s.key) existingKeys[s.key] = true;
  });
  // 末尾から unshift して extras の並び順を保つ
  for (var i = extras.length - 1; i >= 0; i--) {
    var s = extras[i];
    if (!s || !s.key || existingKeys[s.key]) continue;
    target.unshift(s);
    existingKeys[s.key] = true;
  }
}

// 共通レイアウト設定 (表示位置 / 横幅) を出すべきテンプレか。OneComme 形式と
// ticker (manifest.commonLayout=false で明示 opt-out) は対象外。
function templateSupportsCommonLayout(manifest, info) {
  if (info && info.templateType === 'oneComme') return false;
  if (manifest && manifest.commonLayout === false) return false;
  return true;
}

function insertMissingSchemaItemsAfterKey(target, afterKey, extras) {
  var existingKeys = {};
  var insertIndex = -1;
  target.forEach(function (s, index) {
    if (s && s.key) {
      existingKeys[s.key] = true;
      if (s.key === afterKey) insertIndex = index;
    }
  });
  var nextIndex = insertIndex + 1;
  extras.forEach(function (s) {
    if (!s || !s.key || existingKeys[s.key]) return;
    if (insertIndex >= 0) {
      target.splice(nextIndex, 0, s);
      nextIndex += 1;
    } else {
      target.push(s);
    }
    existingKeys[s.key] = true;
  });
}

function extractTemplateFontFamilies(manifest) {
  var seen = Object.create(null);
  var families = [];
  function pushFamily(value) {
    var family = String(value || '').trim();
    if (!family || seen[family]) return;
    seen[family] = true;
    families.push(family);
  }
  dedupeManifestFontList(manifest && manifest.fonts).forEach(pushFamily);
  (Array.isArray(manifest && manifest.fontSources) ? manifest.fontSources : []).forEach(function (source) {
    if (source && typeof source.family === 'string') pushFamily(source.family);
  });
  return families;
}

function escapeCssFontFamily(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function buildTemplateFontSettingOptions(manifest) {
  var families = extractTemplateFontFamilies(manifest);
  var options = [
    { value: '', label: 'テンプレ既定を使う' }
  ];
  families.forEach(function (family) {
    options.push({
      value: '"' + escapeCssFontFamily(family) + '"',
      label: family
    });
  });
  return options;
}

function getCommonTemplateFontSchema(manifest) {
  if (extractTemplateFontFamilies(manifest).length === 0) return [];
  return COMMON_TEMPLATE_FONT_UI_SCHEMA.slice();
}

var editingTemplateSettings = null;
var editingTemplateId = null;
var editingTemplateManifest = null;
var templateManifestSourceId = '';
var templateConfigReturnMode = 'manager';
var tmplPendingAutoSave = null;

function resetTemplateEditorDraft() {
  templateCreateDraft = {
    starterType: 'list',
    displayName: '',
    templateId: '',
    sourceTemplateId: '',
    sourceTemplateName: '',
    sourceTemplateDisplayName: ''
  };
  templateDevTemplateId = '';
}

function openTemplateCreateWizard() {
  templateEditorMode = 'create';
  templateDevTemplateId = '';
  if (!templateCreateDraft || !templateCreateDraft.starterType) {
    resetTemplateEditorDraft();
  }
  renderTemplateEditForm(null, null);
}

function openTemplateCreateWizardFromBuiltin(templateSt, templateInfo) {
  var templateId = templateSt ? (templateSt.id || templateSt.name) : '';
  if (!templateId) return;
  var displayName = (templateInfo && templateInfo.displayName) || templateId;
  templateCreateDraft = {
    starterType: 'custom',
    displayName: displayName + ' カスタム',
    templateId: suggestTemplateIdFromSource(templateId, displayName),
    sourceTemplateId: templateId,
    sourceTemplateName: (templateInfo && templateInfo.name) || templateId,
    sourceTemplateDisplayName: displayName
  };
  templateEditorMode = 'create';
  templateDevTemplateId = '';
  renderTemplateEditForm(null, null);
}

function openTemplateDevelopmentWorkspace(templateId) {
  templateEditorMode = 'dev';
  templateConfigReturnMode = 'dev';
  templateDevTemplateId = templateId || '';
  renderTemplateEditForm(getSceneTemplateById(templateDevTemplateId), null);
}

function openTemplateManifestEditorMode(templateSt, templateInfo, mode) {
  var templateId = templateSt ? (templateSt.id || templateSt.name) : '';
  if (!templateId) return;
  templateEditorMode = mode || 'manifest';
  templateDevTemplateId = templateId;
  editingTemplateId = templateId;
  editingTemplateInfo = templateInfo || null;
  editingTemplateManifest = null;
  templateManifestSourceId = templateId;
  renderTemplateEditForm(templateSt, templateInfo);
  window.api.getTemplateManifest(templateId).then(function (result) {
    if (templateEditorMode !== (mode || 'manifest') || templateManifestSourceId !== templateId) return;
    var manifest = result && result.manifest ? result.manifest : ((cachedTemplateManifests && cachedTemplateManifests[templateId]) || null);
    if (!manifest || typeof manifest !== 'object') {
      showAlertDialog('manifest.json を読み込めませんでした。');
      return;
    }
    editingTemplateManifest = JSON.parse(JSON.stringify(manifest));
    renderTemplateEditForm(getSceneTemplateById(editingTemplateId) || templateSt, templateInfo);
  }).catch(function () {
    showAlertDialog('manifest.json の読み込みに失敗しました。');
  });
}

function openTemplateManifestEditor(templateSt, templateInfo) {
  openTemplateManifestEditorMode(templateSt, templateInfo, 'manifest');
}

function openTemplateBasicInfoEditor(templateSt, templateInfo) {
  openTemplateManifestEditorMode(templateSt, templateInfo, 'manifest-basic');
}

function openTemplateSchemaEditor(templateSt, templateInfo) {
  openTemplateManifestEditorMode(templateSt, templateInfo, 'manifest-schema');
}

function openTemplateFontEditor(templateSt, templateInfo) {
  openTemplateManifestEditorMode(templateSt, templateInfo, 'fonts');
}

function openTemplateConfigView(templateSt, templateInfo, returnMode) {
  templateEditorMode = 'config';
  templateConfigReturnMode = returnMode === 'dev' ? 'dev' : 'manager';
  if (templateConfigReturnMode !== 'dev') {
    templateDevTemplateId = '';
  }
  renderTemplateEditForm(templateSt, templateInfo);
}

function returnFromTemplateConfig() {
  if (templateConfigReturnMode === 'dev' && (templateDevTemplateId || editingTemplateId)) {
    openTemplateDevelopmentWorkspace(templateDevTemplateId || editingTemplateId);
    return;
  }
  returnToTemplateManager();
}

function returnToTemplateManager() {
  editingTemplateId = null;
  editingTemplateInfo = null;
  editingTemplateSettings = null;
  editingTemplateManifest = null;
  templateManifestSourceId = '';
  templateConfigReturnMode = 'manager';
  templateEditorMode = 'manager';
  templateDevTemplateId = '';
  renderTemplateEditForm(null, null);
}

function showTemplateFontGuide(templateId) {
  var templateLabel = templateId || 'このテンプレート';
  showAlertDialog(
    templateLabel
      + ' のフォント追加は、対象フォルダ内の manifest.json に fonts または fontSources を追記して行います。\n\n'
      + '1. 「対象フォルダを開く」でテンプレートフォルダを開く\n'
      + '2. manifest.json を編集する\n'
      + '3. リモートCSSなら fontSources.remoteCss、標準フォントなら fonts を使う\n'
      + '4. 保存後にプレビューを再読み込みする'
  );
}

function openTemplateSettings(st, info) {
  editingTemplateId = null;
  editingTemplateInfo = null;
  editingTemplateSettings = null;
  editingTemplateManifest = null;
  templateManifestSourceId = '';
  templateEditorMode = 'manager';
  templateDevTemplateId = '';

  // updateSceneLock は section 表示直後に必要 (= renderTemplateEditForm が依存)
  updateSceneLock();

  var title = document.getElementById('tmpl-edit-title');
  if (title) title.textContent = 'テンプレート設定';

  renderTemplateEditForm(null, null);

  // section 表示 + enter は framework に委譲
  SubsectionNav.open('template-edit-section');
}

// 薄ラッパー: 自動保存 flush は SubsectionNav.close 前に実行 (= 保存完了を保証)、
// state クリア + refreshTemplateList + updateSceneLock は register の onReturn で。
function closeTemplateSettings() {
  if (tmplPendingAutoSave) {
    clearTimeout(tmplPendingAutoSave.timer);
    tmplPendingAutoSave.save();
    tmplPendingAutoSave = null;
  }
  SubsectionNav.close('template-edit-section');
}

function rerenderTemplateSettingsIfOpen(preferredTemplateId) {
  var section = document.getElementById('template-edit-section');
  if (!section || section.style.display === 'none') return;
  var nextId = preferredTemplateId || (templateEditorMode === 'dev' ? templateDevTemplateId : editingTemplateId);
  var nextTemplate = nextId ? getSceneTemplateById(nextId) : null;
  var resolvedId = nextTemplate ? (nextTemplate.id || nextTemplate.name) : '';
  var nextInfo = resolvedId
    ? getTemplateInfoForRoute(resolvedId, currentTemplateInfoMap[resolvedId] || { id: resolvedId, displayName: resolvedId, templateType: 'custom' }, currentTemplateInfoMap)
    : null;
  renderTemplateEditForm(nextTemplate, nextInfo);
}

function renderTemplateCreateView(body) {
  var isBuiltinClone = !!(templateCreateDraft && templateCreateDraft.sourceTemplateId);
  var card = document.createElement('div');
  card.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

  var backRow = document.createElement('div');
  backRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = templateConfigReturnMode === 'dev'
    ? '◀ テンプレート開発に戻る'
    : '◀ テンプレート一覧に戻る';
  backBtn.addEventListener('click', returnFromTemplateConfig);
  backRow.appendChild(backBtn);
  card.appendChild(backRow);

  var desc = document.createElement('div');
  desc.style.cssText = 'font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:12px;';
  desc.textContent = isBuiltinClone
    ? 'built-in テンプレートを custom カテゴリへ複製して開発します。元の built-in は変更されません。名前と ID を決めて作成すると、そのまま開発画面へ移動します。'
    : 'タイプを選び、テンプレート名と ID を入力すると custom template の雛形を作成します。作成後はそのまま開発画面へ移動します。';
  card.appendChild(desc);

  var firstStepCard = document.createElement('div');
  firstStepCard.style.cssText = 'margin-bottom:12px;padding:10px 12px;background:#0a1929;border:1px solid #1a3a4a;border-radius:6px;';
  var firstStepTitle = document.createElement('div');
  firstStepTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:6px;';
  firstStepTitle.textContent = '生成後の最短コース';
  firstStepCard.appendChild(firstStepTitle);
  [
    '1. まず index.html と style.css で見た目を作る',
    '2. プレビューで差分を見ながら CSS を調整する',
    '3. 必要になったときだけ script.js や manifest を触る'
  ].forEach(function (text) {
    var line = document.createElement('div');
    line.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;';
    line.textContent = text;
    firstStepCard.appendChild(line);
  });
  card.appendChild(firstStepCard);

  if (isBuiltinClone) {
    var sourceCard = document.createElement('div');
    sourceCard.style.cssText = 'margin-bottom:12px;padding:10px 12px;background:#0a1929;border:1px solid #1a3a4a;border-radius:6px;';
    var sourceLabel = document.createElement('div');
    sourceLabel.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:4px;';
    sourceLabel.textContent = '複製元 built-in';
    sourceCard.appendChild(sourceLabel);

    var sourceName = document.createElement('div');
    sourceName.style.cssText = 'font-size:13px;color:#d8e8e8;';
    sourceName.textContent = templateCreateDraft.sourceTemplateDisplayName || templateCreateDraft.sourceTemplateId;
    sourceCard.appendChild(sourceName);

    var sourceId = document.createElement('div');
    sourceId.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:4px;font-family:monospace;';
    sourceId.textContent = templateCreateDraft.sourceTemplateId;
    sourceCard.appendChild(sourceId);
    card.appendChild(sourceCard);
  } else {
    var starterLabel = document.createElement('div');
    starterLabel.className = 'perf-field-label';
    starterLabel.textContent = 'テンプレートタイプ';
    card.appendChild(starterLabel);

    var typeRow = document.createElement('div');
    typeRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;';
    [
      { id: 'list', label: 'セル + 縦スクロール' },
      { id: 'ticker', label: 'セル + 横スクロール' },
      { id: 'custom', label: 'カスタム' }
    ].forEach(function (option) {
      var btn = document.createElement('button');
      var active = templateCreateDraft.starterType === option.id;
      btn.style.cssText = 'background:' + (active ? '#004d54' : '#1a2742')
        + ';border:1px solid ' + (active ? '#00bcd4' : '#1a3a4a')
        + ';border-radius:6px;padding:8px 10px;font-size:12px;color:' + (active ? '#00bcd4' : '#94a3b8')
        + ';cursor:pointer;';
      btn.textContent = option.label;
      btn.addEventListener('click', function () {
        templateCreateDraft.starterType = option.id;
        renderTemplateEditForm(null, null);
      });
      typeRow.appendChild(btn);
    });
    card.appendChild(typeRow);
  }

  var nameField = document.createElement('div');
  nameField.className = 'perf-field';
  var nameLabel = document.createElement('div');
  nameLabel.className = 'perf-field-label';
  nameLabel.textContent = 'テンプレート名';
  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = templateCreateDraft.displayName || '';
  nameInput.placeholder = '例: かわいい新テンプレ';
  nameInput.style.cssText = 'width:100%;background:#0a1929;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:8px;box-sizing:border-box;';
  nameInput.addEventListener('input', function () {
    templateCreateDraft.displayName = nameInput.value;
    var previousSuggestedId = templateCreateDraft.sourceTemplateId
      ? suggestTemplateIdFromSource(templateCreateDraft.sourceTemplateId, templateCreateDraft._lastDisplayName || '')
      : suggestTemplateId(templateCreateDraft._lastDisplayName || '');
    if (!templateCreateDraft.templateId || templateCreateDraft.templateId === previousSuggestedId) {
      templateCreateDraft.templateId = templateCreateDraft.sourceTemplateId
        ? suggestTemplateIdFromSource(templateCreateDraft.sourceTemplateId, nameInput.value)
        : suggestTemplateId(nameInput.value);
    }
    templateCreateDraft._lastDisplayName = nameInput.value;
    idInput.value = templateCreateDraft.templateId;
  });
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);
  card.appendChild(nameField);

  var idField = document.createElement('div');
  idField.className = 'perf-field';
  var idLabel = document.createElement('div');
  idLabel.className = 'perf-field-label';
  idLabel.textContent = 'テンプレート ID';
  var idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = templateCreateDraft.templateId
    || (templateCreateDraft.sourceTemplateId
      ? suggestTemplateIdFromSource(templateCreateDraft.sourceTemplateId, templateCreateDraft.displayName || '')
      : suggestTemplateId(templateCreateDraft.displayName || ''));
  templateCreateDraft.templateId = idInput.value;
  idInput.placeholder = 'com.comment-hub.template.my-template';
  idInput.style.cssText = 'width:100%;background:#0a1929;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:8px;box-sizing:border-box;font-family:monospace;';
  idInput.addEventListener('input', function () {
    templateCreateDraft.templateId = idInput.value;
  });
  idField.appendChild(idLabel);
  idField.appendChild(idInput);
  card.appendChild(idField);

  var hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-bottom:12px;';
  hint.textContent = 'ID は reverse domain 形式を推奨します。作成後は対象フォルダ内の html + css を編集し、プレビューと既存テストコメント機能で確認します。';
  card.appendChild(hint);

  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
  var createBtn = document.createElement('button');
  createBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:6px;padding:8px 12px;font-size:12px;color:#00bcd4;cursor:pointer;';
  createBtn.textContent = '作成して開発画面へ';
  createBtn.addEventListener('click', function () {
    var displayName = (templateCreateDraft.displayName || '').trim();
    var templateId = (templateCreateDraft.templateId || '').trim().toLowerCase();
    if (!displayName) {
      showAlertDialog('テンプレート名を入力してください。');
      return;
    }
    if (!templateId) {
      showAlertDialog('テンプレート ID を入力してください。');
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = '作成中...';
    var createPromise = templateCreateDraft.sourceTemplateId
      ? window.api.createTemplateFromBuiltin(templateCreateDraft.sourceTemplateId, templateId, displayName)
      : window.api.createTemplateFromStarter(templateCreateDraft.starterType, templateId, displayName);
    createPromise
      .then(function (result) {
        if (!result || result.ok === false || !result.template) {
          showAlertDialog('テンプレート作成に失敗しました: ' + ((result && result.error) || '不明なエラー'));
          return null;
        }
        return window.api.ensureTemplateFonts(['Noto Sans JP']).then(function () {
          return result;
        });
      })
      .then(function (result) {
        if (!result || !result.template) return null;
        var createdId = result.template.id || result.template.name;
        return window.api.addSceneTemplate(selectedSceneId, createdId).then(function () {
          return window.api.setSelectedSceneTemplate(selectedSceneId, createdId);
        }).then(function () {
          templateDevTemplateId = createdId;
          resetTemplateEditorDraft();
          return refreshTemplateList().then(function () {
            openTemplateDevelopmentWorkspace(createdId);
          });
        });
      })
      .catch(function () {
        showAlertDialog('テンプレート作成に失敗しました。');
      })
      .finally(function () {
        createBtn.disabled = false;
        createBtn.textContent = '作成して開発画面へ';
      });
  });
  actions.appendChild(createBtn);
  card.appendChild(actions);

  body.appendChild(card);
}

function renderTemplateDevelopmentView(body, activeTemplate, activeInfo, manifests) {
  var activeTemplateId = activeTemplate ? (activeTemplate.id || activeTemplate.name) : '';
  var manifest = manifests[activeTemplateId] || {};
  var configUrlValue = buildLocalHttpUrl(buildTemplateRoutePath(selectedSceneId, activeTemplateId, activeInfo, currentSceneTemplates, currentTemplateInfoMap));
  var devPreviewUrl = buildTemplateDevPreviewUrl(configUrlValue);

  var card = document.createElement('div');
  card.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

  var topRow = document.createElement('div');
  topRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = '◀ テンプレート一覧に戻る';
  backBtn.addEventListener('click', returnToTemplateManager);
  topRow.appendChild(backBtn);
  var devGuideBtn = document.createElement('button');
  devGuideBtn.style.cssText = 'background:#0f2f3a;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;';
  devGuideBtn.textContent = '開発者向けガイドを開く';
  devGuideBtn.title = 'HTML / CSS / JS / manifest を編集するときのガイドです';
  devGuideBtn.addEventListener('click', function () {
    if (window.api && window.api.templateDevGuide) {
      window.api.templateDevGuide.open();
    }
  });
  topRow.appendChild(devGuideBtn);
  card.appendChild(topRow);

  var summary = document.createElement('div');
  summary.style.cssText = 'font-size:12px;color:#d8e8e8;line-height:1.7;margin-bottom:12px;';
  [
    ['名前', activeInfo.displayName || activeTemplateId, ''],
    ['ID', activeTemplateId, 'font-family:monospace;color:#94a3b8;'],
    ['カテゴリ', TYPE_LABELS[activeInfo.templateType] || activeInfo.templateType, '']
  ].forEach(function (item) {
    var row = document.createElement('div');
    var label = document.createElement('strong');
    label.textContent = item[0] + ': ';
    row.appendChild(label);
    var value = document.createElement('span');
    value.textContent = item[1];
    if (item[2]) value.style.cssText = item[2];
    row.appendChild(value);
    summary.appendChild(row);
  });
  card.appendChild(summary);

  var workflowSection = document.createElement('div');
  workflowSection.style.cssText = 'margin-bottom:12px;';
  var workflowTitle = document.createElement('div');
  workflowTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:8px;';
  workflowTitle.textContent = 'まずは HTML/CSS から';
  workflowSection.appendChild(workflowTitle);
  var workflowSummary = document.createElement('div');
  workflowSummary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;margin-bottom:8px;';
  workflowSummary.textContent = 'テンプレ作者の主ルートです。最初は対象フォルダを開いて index.html / style.css を整え、必要になったときだけ script や manifest を触ります。';
  workflowSection.appendChild(workflowSummary);
  var workflowGrid = document.createElement('div');
  workflowGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;';
  [
    {
      title: 'ファイル編集',
      description: '対象フォルダを開いて、まず index.html と style.css を触ります。',
      color: '#94a3b8',
      buttonLabel: '対象フォルダを開く',
      action: function () {
        window.api.openTemplateFolder(activeTemplateId).then(function (result) {
          if (result && result.ok === false) {
            showAlertDialog('テンプレートフォルダを開けませんでした: ' + (result.error || '不明なエラー'));
          }
        });
      }
    },
    {
      title: 'プレビュー',
      description: '?preview=1&devPreview=1 をブラウザで開き、差分を見ながら CSS を詰めます。',
      color: '#00bcd4',
      buttonLabel: 'プレビューをブラウザで表示',
      action: function () {
        window.api.openExternal(devPreviewUrl);
      }
    },
    {
      title: 'テストコメント',
      description: '削除反映や実際の流れ方は、既存のテストコメント機能で確認します。',
      color: '#22c55e',
      buttonLabel: 'テストコメントを送る',
      action: function () {
        var inlineTestBtn = createTemplateTestButton();
        inlineTestBtn.click();
      }
    }
  ].forEach(function (item) {
    var box = document.createElement('div');
    box.style.cssText = 'background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;padding:10px;display:flex;flex-direction:column;height:100%;';
    var heading = document.createElement('div');
    heading.style.cssText = 'font-size:12px;font-weight:600;color:' + item.color + ';margin-bottom:6px;';
    heading.textContent = item.title;
    box.appendChild(heading);
    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.6;min-height:36px;margin-bottom:8px;flex:1;';
    desc.textContent = item.description;
    box.appendChild(desc);
    var btn = document.createElement('button');
    btn.style.cssText = 'width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 10px;font-size:12px;color:' + item.color + ';cursor:pointer;margin-top:auto;';
    btn.textContent = item.buttonLabel;
    btn.addEventListener('click', item.action);
    box.appendChild(btn);
    workflowGrid.appendChild(box);
  });
  workflowSection.appendChild(workflowGrid);
  card.appendChild(workflowSection);

  var fileOrderSection = document.createElement('div');
  fileOrderSection.style.cssText = 'margin-bottom:12px;';
  var fileOrderTitle = document.createElement('div');
  fileOrderTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:8px;';
  fileOrderTitle.textContent = '触る順番の目安';
  fileOrderSection.appendChild(fileOrderTitle);
  var fileOrderCard = document.createElement('div');
  fileOrderCard.style.cssText = 'background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;padding:10px;';
  [
    ['1. index.html', 'レイアウトと cellTemplate の骨格を決めます。'],
    ['2. style.css', '見た目、theme 差分、enter / leave を詰めます。'],
    ['3. script.js', 'htmlFirst.start() や beforeCommitComment が必要なときだけ触ります。'],
    ['4. manifest.json', '設定項目、フォント、再配布ポリシーなど構造情報だけを足します。']
  ].forEach(function (item, index) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;' + (index > 0 ? 'margin-top:8px;padding-top:8px;border-top:1px solid #102338;' : '');
    var key = document.createElement('div');
    key.style.cssText = 'min-width:120px;font-size:11px;color:#d8e8e8;font-family:monospace;';
    key.textContent = item[0];
    row.appendChild(key);
    var value = document.createElement('div');
    value.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.6;';
    value.textContent = item[1];
    row.appendChild(value);
    fileOrderCard.appendChild(row);
  });
  fileOrderSection.appendChild(fileOrderCard);
  card.appendChild(fileOrderSection);

  var editSection = document.createElement('div');
  editSection.style.cssText = 'margin-bottom:12px;';
  var editTitle = document.createElement('div');
  editTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:8px;';
  editTitle.textContent = '編集メニュー';
  editSection.appendChild(editTitle);
  var editSummary = document.createElement('div');
  editSummary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;margin-bottom:8px;';
  editSummary.textContent = 'テンプレ構造とメタ情報を扱う領域です。HTML/CSS を先に固めた後で、manifest を編集し、フォント・基本情報・設定項目(uiSchema)を必要なときだけ調整します。';
  editSection.appendChild(editSummary);

  var editGrid = document.createElement('div');
  editGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;';
  [
    {
      title: 'フォント',
      description: '標準フォントや同梱フォントの取り込みを編集します。',
      color: '#f59e0b',
      buttonLabel: 'フォントを開く',
      action: function () {
        openTemplateFontEditor(activeTemplate, activeInfo);
      }
    },
    {
      title: '基本情報',
      description: 'テンプレ名、ID、obsHint、再配布ポリシーなどの基本情報を編集します。',
      color: '#a78bfa',
      buttonLabel: '基本情報を開く',
      action: function () {
        openTemplateBasicInfoEditor(activeTemplate, activeInfo);
      }
    },
    {
      title: '設定項目',
      description: 'uiSchema を編集して、設定画面にどの項目を出すかを決めます。',
      color: '#60a5fa',
      buttonLabel: '設定項目を開く',
      action: function () {
        openTemplateSchemaEditor(activeTemplate, activeInfo);
      }
    }
  ].forEach(function (item) {
    var box = document.createElement('div');
    box.style.cssText = 'background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;padding:10px;display:flex;flex-direction:column;height:100%;';
    var heading = document.createElement('div');
    heading.style.cssText = 'font-size:12px;font-weight:600;color:' + item.color + ';margin-bottom:6px;';
    heading.textContent = item.title;
    box.appendChild(heading);
    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.6;min-height:36px;margin-bottom:8px;flex:1;';
    desc.textContent = item.description;
    box.appendChild(desc);
    var btn = document.createElement('button');
    btn.style.cssText = 'width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 10px;font-size:12px;color:' + item.color + ';cursor:pointer;margin-top:auto;';
    btn.textContent = item.buttonLabel;
    btn.addEventListener('click', item.action);
    box.appendChild(btn);
    editGrid.appendChild(box);
  });
  editSection.appendChild(editGrid);
  card.appendChild(editSection);

  var settingsSection = document.createElement('div');
  settingsSection.style.cssText = 'margin-bottom:12px;';
  var settingsTitle = document.createElement('div');
  settingsTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;margin-bottom:8px;';
  settingsTitle.textContent = '設定';
  settingsSection.appendChild(settingsTitle);
  var settingsCard = document.createElement('div');
  settingsCard.style.cssText = 'background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;padding:10px;';
  var settingsHeading = document.createElement('div');
  settingsHeading.style.cssText = 'font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:6px;';
  settingsHeading.textContent = '現在の設定';
  settingsCard.appendChild(settingsHeading);
  var settingsDesc = document.createElement('div');
  settingsDesc.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.6;margin-bottom:8px;';
  settingsDesc.textContent = 'プレビューや配信で使う実際の値を編集します。ここに出る項目は uiSchema 編集で決まります。';
  settingsCard.appendChild(settingsDesc);
  var settingsBtn = document.createElement('button');
  settingsBtn.style.cssText = 'width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:8px 10px;font-size:12px;color:#94a3b8;cursor:pointer;';
  settingsBtn.textContent = '設定を開く';
  settingsBtn.addEventListener('click', function () {
    openTemplateConfigView(activeTemplate, activeInfo, 'dev');
  });
  settingsCard.appendChild(settingsBtn);
  settingsSection.appendChild(settingsCard);
  card.appendChild(settingsSection);

  var urlBox = document.createElement('div');
  urlBox.style.cssText = 'font-size:11px;color:#64748b;font-family:monospace;background:#0a1929;border:1px solid #1a3a4a;border-radius:6px;padding:8px;margin-bottom:12px;word-break:break-all;cursor:pointer;';
  urlBox.textContent = devPreviewUrl;
  urlBox.title = 'クリックでコピー';
  urlBox.addEventListener('click', function () {
    navigator.clipboard.writeText(devPreviewUrl);
  });
  card.appendChild(urlBox);

  var guide = document.createElement('div');
  guide.style.cssText = 'font-size:12px;color:#94a3b8;line-height:1.7;';
  [
    '1. 「対象フォルダを開く」でテンプレートフォルダを開く',
    '2. まず index.html / style.css を編集する',
    '3. 「プレビューをブラウザで表示」で ?preview=1&devPreview=1 を開く',
    '4. 必要になったら manifest / uiSchema / script を編集する',
    '5. 既存のテストコメント機能で実際の流れ方を確認する'
  ].forEach(function (text) {
    var line = document.createElement('div');
    line.textContent = text;
    guide.appendChild(line);
  });
  var obsHint = document.createElement('div');
  obsHint.style.cssText = 'margin-top:8px;color:#64748b;';
  obsHint.textContent = 'OBS目安: ' + (manifest.obsHint || '任意');
  guide.appendChild(obsHint);
  card.appendChild(guide);

  body.appendChild(card);
}

var MANIFEST_SCHEMA_TYPES = ['slider', 'buttons', 'toggle', 'color', 'text', 'textarea', 'image', 'font'];
var TEMPLATE_FONT_PRESETS = [
  { family: 'Noto Sans JP', note: '標準 sans-serif' },
  { family: 'M PLUS Rounded 1c', note: '丸みのある本文向け' },
  { family: 'Zen Maru Gothic', note: 'やわらかい丸ゴシック' },
  { family: 'Kiwi Maru', note: '和風・やさしい見た目' },
  { family: 'BIZ UDGothic', note: '読みやすいUD系' }
];

function createManifestSectionCard(title, description) {
  var card = document.createElement('div');
  card.style.cssText = 'background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-top:12px;';
  var heading = document.createElement('div');
  heading.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;';
  heading.textContent = title;
  card.appendChild(heading);
  if (description) {
    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-top:4px;margin-bottom:10px;';
    desc.textContent = description;
    card.appendChild(desc);
  }
  var body = document.createElement('div');
  card.appendChild(body);
  return { card: card, body: body };
}

function createManifestField(labelText) {
  var field = document.createElement('div');
  field.className = 'perf-field';
  var label = document.createElement('div');
  label.className = 'perf-field-label';
  label.textContent = labelText;
  field.appendChild(label);
  return field;
}

function createManifestTextInput(labelText, value, onInput, options) {
  var field = createManifestField(labelText);
  var input = document.createElement('input');
  input.type = 'text';
  input.value = value == null ? '' : String(value);
  input.placeholder = options && options.placeholder ? options.placeholder : '';
  input.style.cssText = 'width:100%;background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:8px;box-sizing:border-box;'
    + ((options && options.monospace) ? 'font-family:monospace;' : '');
  input.addEventListener('input', function () {
    onInput(input.value);
  });
  field.appendChild(input);
  return field;
}

function createManifestTextareaInput(labelText, value, onInput, options) {
  var field = createManifestField(labelText);
  var input = document.createElement('textarea');
  input.value = value == null ? '' : String(value);
  input.placeholder = options && options.placeholder ? options.placeholder : '';
  input.style.cssText = 'width:100%;min-height:' + ((options && options.minHeight) || 70)
    + 'px;background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;'
    + 'font-size:12px;padding:8px;box-sizing:border-box;resize:vertical;'
    + ((options && options.monospace) ? 'font-family:monospace;' : '');
  input.addEventListener('input', function () {
    onInput(input.value);
  });
  field.appendChild(input);
  return field;
}

function createManifestNumberInput(labelText, value, onInput, options) {
  var field = createManifestField(labelText);
  var input = document.createElement('input');
  input.type = 'number';
  input.value = value == null || value === '' ? '' : String(value);
  if (options && options.step != null) input.step = options.step;
  input.style.cssText = 'width:100%;background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:8px;box-sizing:border-box;';
  input.addEventListener('input', function () {
    if (input.value === '') {
      onInput(null);
      return;
    }
    onInput(parseFloat(input.value));
  });
  field.appendChild(input);
  return field;
}

function createManifestCheckboxInput(labelText, checked, onChange, labels) {
  var field = createManifestField(labelText);
  var row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#d8e8e8;cursor:pointer;';
  var input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.addEventListener('change', function () {
    onChange(input.checked);
  });
  row.appendChild(input);
  var text = document.createElement('span');
  text.textContent = (labels && labels[1]) || 'ON';
  row.appendChild(text);
  field.appendChild(row);
  return field;
}

function createManifestSelectInput(labelText, value, options, onChange) {
  var field = createManifestField(labelText);
  var select = document.createElement('select');
  select.style.cssText = 'width:100%;background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:8px;box-sizing:border-box;';
  options.forEach(function (option) {
    var opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.value === value) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', function () {
    onChange(select.value);
  });
  field.appendChild(select);
  return field;
}

function getTemplateFontPresetFamilySet() {
  var set = Object.create(null);
  TEMPLATE_FONT_PRESETS.forEach(function (preset) {
    set[preset.family] = true;
  });
  return set;
}

function dedupeManifestFontList(fonts) {
  var seen = Object.create(null);
  return (Array.isArray(fonts) ? fonts : [])
    .map(function (value) { return String(value || '').trim(); })
    .filter(function (value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
}

function updateDraftPresetFonts(draft, selectedPresets) {
  var presetSet = getTemplateFontPresetFamilySet();
  var selectedSet = Object.create(null);
  selectedPresets.forEach(function (family) {
    if (presetSet[family]) selectedSet[family] = true;
  });
  var unknownFonts = dedupeManifestFontList(draft.fonts).filter(function (family) {
    return !presetSet[family];
  });
  draft.fonts = TEMPLATE_FONT_PRESETS
    .map(function (preset) { return preset.family; })
    .filter(function (family) { return !!selectedSet[family]; })
    .concat(unknownFonts);
}

function createEmptyManifestSchemaItem(type) {
  var item = {
    key: '',
    type: type || 'slider',
    label: ''
  };
  if (item.type === 'slider') {
    item.min = 0;
    item.max = 100;
    item.step = 1;
    item.default = 0;
    item.suffix = 'px';
  } else if (item.type === 'buttons') {
    item.default = '';
    item.options = [{ value: '', label: '' }];
  } else if (item.type === 'toggle') {
    item.default = false;
    item.onLabel = 'ON';
    item.offLabel = 'OFF';
  } else if (item.type === 'color') {
    item.default = '#ffffff';
  } else if (item.type === 'font') {
    item.default = '';
  } else if (item.type === 'textarea') {
    item.default = '';
    item.placeholder = '';
  }
  return item;
}

function pruneManifestSchemaItemForType(item) {
  if (!item || typeof item !== 'object') return;
  var allowed = {
    key: true,
    type: true,
    label: true,
    showIf: true,
    default: item.type !== 'image',
    min: item.type === 'slider',
    max: item.type === 'slider',
    step: item.type === 'slider',
    suffix: item.type === 'slider',
    options: item.type === 'buttons',
    linkedColor: item.type === 'buttons',
    onLabel: item.type === 'toggle',
    offLabel: item.type === 'toggle',
    placeholder: item.type === 'textarea'
  };
  Object.keys(item).forEach(function (key) {
    if (allowed[key] === false) delete item[key];
  });
  if (item.type === 'buttons' && !Array.isArray(item.options)) item.options = [{ value: '', label: '' }];
  if (item.type === 'toggle' && typeof item.default !== 'boolean') item.default = !!item.default;
  if (item.type === 'image') delete item.default;
}

function readManifestShowIfRows(item) {
  var raw = item && item.showIf;
  if (!raw) return [];
  var conditions = Array.isArray(raw) ? raw : [raw];
  return conditions.map(function (cond) {
    if (!cond || typeof cond !== 'object') return { key: '', mode: 'equals', value: '' };
    if (cond.not != null) {
      return { key: cond.key || '', mode: 'not', value: String(cond.not) };
    }
    if (cond.value === true) {
      return { key: cond.key || '', mode: 'truthy', value: '' };
    }
    if (cond.value === false) {
      return { key: cond.key || '', mode: 'falsy', value: '' };
    }
    return {
      key: cond.key || '',
      mode: 'equals',
      value: cond.value == null ? '' : String(cond.value)
    };
  });
}

function writeManifestShowIfRows(item, rows) {
  if (!item || typeof item !== 'object') return;
  var conditions = (rows || []).filter(function (row) {
    return row && typeof row.key === 'string' && row.key.trim();
  }).map(function (row) {
    var key = row.key.trim();
    if (row.mode === 'truthy') return { key: key, value: true };
    if (row.mode === 'falsy') return { key: key, value: false };
    if (row.mode === 'not') return { key: key, not: row.value == null ? '' : String(row.value) };
    return { key: key, value: row.value == null ? '' : String(row.value) };
  });
  if (conditions.length === 0) {
    delete item.showIf;
  } else if (conditions.length === 1) {
    item.showIf = conditions[0];
  } else {
    item.showIf = conditions;
  }
}

function validateManifestDraft(draft) {
  var errors = [];
  if (!draft || typeof draft !== 'object') {
    return ['manifest の下書きが壊れています。'];
  }
  ['id', 'name', 'displayName', 'version', 'obsHint'].forEach(function (key) {
    if (typeof draft[key] !== 'string' || !draft[key].trim()) {
      errors.push('manifest.' + key + ' は必須です。');
    }
  });
  if (!Array.isArray(draft.fonts)) {
    errors.push('manifest.fonts は配列である必要があります。');
  } else if (draft.fonts.some(function (value) { return typeof value !== 'string' || !value.trim(); })) {
    errors.push('manifest.fonts に空の項目があります。');
  }
  if (!Array.isArray(draft.uiSchema)) {
    errors.push('manifest.uiSchema は配列である必要があります。');
  } else {
    draft.uiSchema.forEach(function (item, index) {
      if (!item || typeof item !== 'object') {
        errors.push('uiSchema[' + index + '] は object である必要があります。');
        return;
      }
      if (!item.key || !String(item.key).trim()) errors.push('uiSchema[' + index + '].key は必須です。');
      if (!item.label || !String(item.label).trim()) errors.push('uiSchema[' + index + '].label は必須です。');
      if (MANIFEST_SCHEMA_TYPES.indexOf(item.type) === -1) {
        errors.push('uiSchema[' + index + '].type が未対応です。');
      }
      if (item.type === 'slider') {
        if (typeof item.min !== 'number' || typeof item.max !== 'number') {
          errors.push('uiSchema[' + index + '] slider は min/max が必要です。');
        } else if (item.min > item.max) {
          errors.push('uiSchema[' + index + '] slider は min <= max である必要があります。');
        }
      } else if (item.type === 'buttons') {
        if (!Array.isArray(item.options) || item.options.length === 0) {
          errors.push('uiSchema[' + index + '] buttons は options が必要です。');
        } else {
          item.options.forEach(function (option, optionIndex) {
            if (!option || typeof option !== 'object') {
              errors.push('uiSchema[' + index + '].options[' + optionIndex + '] は object である必要があります。');
              return;
            }
            if (!option.value || !String(option.value).trim()) {
              errors.push('uiSchema[' + index + '].options[' + optionIndex + '].value は必須です。');
            }
            if (!option.label || !String(option.label).trim()) {
              errors.push('uiSchema[' + index + '].options[' + optionIndex + '].label は必須です。');
            }
          });
        }
      }
    });
  }
  if (draft.fontSources != null) {
    if (!Array.isArray(draft.fontSources)) {
      errors.push('manifest.fontSources は配列である必要があります。');
    } else {
      draft.fontSources.forEach(function (source, index) {
        if (!source || typeof source !== 'object') {
          errors.push('fontSources[' + index + '] は object である必要があります。');
          return;
        }
        if (!source.family || !String(source.family).trim()) {
          errors.push('fontSources[' + index + '].family は必須です。');
        }
        if (source.type !== 'assetCss' && source.type !== 'remoteCss') {
          errors.push('fontSources[' + index + '].type は assetCss / remoteCss のいずれかです。');
        }
        if (source.type === 'assetCss' && (!source.css || !String(source.css).trim())) {
          errors.push('fontSources[' + index + '].css は必須です。');
        }
        if (source.type === 'remoteCss' && (!source.url || !String(source.url).trim())) {
          errors.push('fontSources[' + index + '].url は必須です。');
        }
      });
    }
  }
  return errors;
}

function appendTemplateFontSections(container, draft, rerender, templateId) {
  var presetSet = getTemplateFontPresetFamilySet();
  var normalizedFonts = dedupeManifestFontList(draft.fonts);
  var selectedPresetFonts = normalizedFonts.filter(function (family) { return !!presetSet[family]; });
  var unknownFonts = normalizedFonts.filter(function (family) { return !presetSet[family]; });

  var fontsSection = createManifestSectionCard('fonts', 'こめはぶ標準取得の簡易指定です。Google Fonts 系のプリセットだけ選べます。任意フォントは下の fontSources を使います。');
  var presetField = createManifestField('標準フォントを選ぶ');
  var presetHint = document.createElement('div');
  presetHint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-bottom:8px;';
  presetHint.textContent = '複数選択できます。テンプレで使いたい family を選んでください。';
  presetField.appendChild(presetHint);
  var presetList = document.createElement('div');
  presetList.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
  TEMPLATE_FONT_PRESETS.forEach(function (preset) {
    var selected = selectedPresetFonts.indexOf(preset.family) !== -1;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'min-width:180px;text-align:left;background:'
      + (selected ? '#083344' : '#081521')
      + ';border:1px solid '
      + (selected ? '#22d3ee' : '#1a3a4a')
      + ';border-radius:6px;padding:8px 10px;color:'
      + (selected ? '#cffafe' : '#d8e8e8')
      + ';cursor:pointer;';
    btn.addEventListener('click', function () {
      var nextSelected = selectedPresetFonts.slice();
      var currentIndex = nextSelected.indexOf(preset.family);
      if (currentIndex === -1) nextSelected.push(preset.family);
      else nextSelected.splice(currentIndex, 1);
      updateDraftPresetFonts(draft, nextSelected);
      rerender();
    });

    var family = document.createElement('div');
    family.style.cssText = 'font-size:12px;font-weight:600;';
    family.textContent = preset.family;
    btn.appendChild(family);

    var note = document.createElement('div');
    note.style.cssText = 'font-size:10px;color:' + (selected ? '#a5f3fc' : '#94a3b8') + ';margin-top:4px;';
    note.textContent = preset.note;
    btn.appendChild(note);
    presetList.appendChild(btn);
  });
  presetField.appendChild(presetList);

  var selectedSummary = document.createElement('div');
  selectedSummary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.6;margin-top:8px;';
  selectedSummary.textContent = selectedPresetFonts.length > 0
    ? '選択中: ' + selectedPresetFonts.join(', ')
    : '選択中: なし';
  presetField.appendChild(selectedSummary);
  fontsSection.body.appendChild(presetField);

  if (unknownFonts.length > 0) {
    var unknownField = createManifestField('プリセット外の fonts');
    var unknownHint = document.createElement('div');
    unknownHint.style.cssText = 'font-size:11px;color:#fbbf24;line-height:1.6;margin-bottom:8px;';
    unknownHint.textContent = 'このテンプレにはプリセット外の fonts が残っています。新規追加はできません。必要なら削除し、任意フォントは fontSources に移してください。';
    unknownField.appendChild(unknownHint);

    var unknownList = document.createElement('div');
    unknownList.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    unknownFonts.forEach(function (family) {
      var chip = document.createElement('div');
      chip.style.cssText = 'display:flex;align-items:center;gap:6px;background:#2a1605;border:1px solid #92400e;border-radius:999px;padding:6px 10px;color:#fde68a;';
      var text = document.createElement('span');
      text.style.cssText = 'font-size:11px;font-family:monospace;';
      text.textContent = family;
      chip.appendChild(text);
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.style.cssText = 'background:transparent;border:none;color:#fca5a5;font-size:11px;cursor:pointer;padding:0;';
      removeBtn.textContent = '削除';
      removeBtn.addEventListener('click', function () {
        draft.fonts = normalizedFonts.filter(function (value) { return value !== family; });
        rerender();
      });
      chip.appendChild(removeBtn);
      unknownList.appendChild(chip);
    });
    unknownField.appendChild(unknownList);
    fontsSection.body.appendChild(unknownField);
  }
  container.appendChild(fontsSection.card);

  var fontSourcesSection = createManifestSectionCard('fontSources', '任意フォントの正式指定です。外部 CSS を指定するか、同梱フォントを取り込んで自動生成した CSS を使います。');
  if (!Array.isArray(draft.fontSources)) draft.fontSources = [];
  var fontSourceGuide = document.createElement('div');
  fontSourceGuide.style.cssText = 'font-size:11px;color:#64748b;line-height:1.7;margin-bottom:10px;';
  fontSourceGuide.textContent = '同梱フォントは zip / woff2 / woff / otf / ttf を取り込めます。対応形式は内部メタデータから family・weight・style を自動設定し、zip 内に複数 family がある場合は family ごとに CSS を生成します。';
  fontSourcesSection.body.appendChild(fontSourceGuide);
  draft.fontSources.forEach(function (source, index) {
    if (!source || typeof source !== 'object') draft.fontSources[index] = {};
    source = draft.fontSources[index];
    var sourceCard = document.createElement('div');
    sourceCard.style.cssText = 'border:1px solid #1a3a4a;border-radius:6px;padding:10px;margin-bottom:10px;background:#081521;';
    var sourceHeader = document.createElement('div');
    sourceHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;';
    var sourceTitle = document.createElement('div');
    sourceTitle.style.cssText = 'font-size:11px;color:#d8e8e8;font-weight:600;';
    sourceTitle.textContent = (source.type === 'remoteCss' ? '外部CSSフォント #' : '同梱フォント #') + (index + 1);
    sourceHeader.appendChild(sourceTitle);
    var removeSourceBtn = document.createElement('button');
    removeSourceBtn.style.cssText = 'background:#1a2742;border:1px solid #7f1d1d;border-radius:4px;padding:4px 8px;font-size:10px;color:#f87171;cursor:pointer;';
    removeSourceBtn.textContent = '削除';
    removeSourceBtn.addEventListener('click', function () {
      draft.fontSources.splice(index, 1);
      rerender();
    });
    sourceHeader.appendChild(removeSourceBtn);
    sourceCard.appendChild(sourceHeader);
    var sourceHint = document.createElement('div');
    sourceHint.style.cssText = 'font-size:10px;color:#64748b;line-height:1.6;margin-bottom:8px;';
    sourceHint.textContent = source.type === 'remoteCss'
      ? '配布元の CSS URL をそのまま読みます。'
      : 'テンプレート内の CSS ファイルから @font-face を読みます。通常は「同梱フォントを取り込む」で自動生成されます。';
    sourceCard.appendChild(sourceHint);
    sourceCard.appendChild(createManifestTextInput('CSSで使うフォント名', source.family, function (value) {
      source.family = value;
    }, { placeholder: 'My Imported Font' }));
    sourceCard.appendChild(createManifestSelectInput('方式', source.type || 'assetCss', [
      { value: 'assetCss', label: '同梱フォント (assetCss)' },
      { value: 'remoteCss', label: '外部CSSフォント (remoteCss)' }
    ], function (value) {
      source.type = value;
      if (value === 'assetCss') delete source.url;
      if (value === 'remoteCss') delete source.css;
      rerender();
    }));
    sourceCard.appendChild(createManifestTextInput(
      source.type === 'remoteCss' ? '外部CSS URL' : 'テンプレ内CSSファイル',
      source.type === 'remoteCss' ? source.url : source.css,
      function (value) {
        if (source.type === 'remoteCss') source.url = value;
        else source.css = value;
      },
      {
        monospace: true,
        placeholder: source.type === 'remoteCss'
          ? 'https://example.com/fonts.css'
          : 'fonts/bundled-font.css'
      }
    ));
    fontSourcesSection.body.appendChild(sourceCard);
  });
  var actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  var importBundledBtn = document.createElement('button');
  importBundledBtn.type = 'button';
  importBundledBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#67e8f9;cursor:pointer;';
  importBundledBtn.textContent = '同梱フォントを取り込む';
  importBundledBtn.addEventListener('click', function () {
    if (!templateId) {
      showAlertDialog('テンプレート ID を解決できませんでした。');
      return;
    }
    window.api.chooseTemplateFontImport().then(function (picked) {
      if (!picked || !picked.ok || !picked.path) {
        if (picked && picked.error) showAlertDialog('フォント選択に失敗しました: ' + picked.error);
        return;
      }
      window.api.importTemplateBundledFont(templateId, picked.path, '').then(function (result) {
        if (!result || result.ok === false || !Array.isArray(result.imports) || result.imports.length === 0) {
          showAlertDialog('同梱フォントの取り込みに失敗しました: ' + ((result && result.error) || '不明なエラー'));
          return;
        }
        result.imports.forEach(function (item) {
          if (item && item.fontSource) draft.fontSources.push(item.fontSource);
        });
        rerender();
        var familyLines = result.imports.map(function (item) {
          return '- ' + (item.family || 'Imported Font')
            + ' (' + (((item.importedFiles && item.importedFiles.length) || 0)) + ' files)';
        }).join('\n');
        showAlertDialog(
          '同梱フォントを追加しました。\n'
          + 'family 一覧:\n' + familyLines + '\n\n'
          + 'manifest を保存すると反映されます。'
        );
      }).catch(function () {
        showAlertDialog('同梱フォントの取り込みに失敗しました。');
      });
    });
  });
  actionRow.appendChild(importBundledBtn);

  var addRemoteBtn = document.createElement('button');
  addRemoteBtn.type = 'button';
  addRemoteBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  addRemoteBtn.textContent = '外部CSSフォントを追加';
  addRemoteBtn.addEventListener('click', function () {
    draft.fontSources.push({ family: '', type: 'remoteCss', url: '' });
    rerender();
  });
  actionRow.appendChild(addRemoteBtn);
  fontSourcesSection.body.appendChild(actionRow);
  container.appendChild(fontSourcesSection.card);
}

function renderManifestShowIfEditor(container, item, rerender) {
  var rows = readManifestShowIfRows(item);
  var section = createManifestField('表示条件');
  var desc = document.createElement('div');
  desc.style.cssText = 'font-size:10px;color:#64748b;line-height:1.5;margin-bottom:8px;';
  desc.textContent = 'すべての条件を満たしたときにだけ表示されます。';
  section.appendChild(desc);

  rows.forEach(function (row, index) {
    var rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:grid;grid-template-columns:1.2fr 0.9fr 1fr auto;gap:6px;margin-bottom:6px;';

    var keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.value = row.key || '';
    keyInput.placeholder = '参照キー';
    keyInput.style.cssText = 'background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:6px;';
    keyInput.addEventListener('input', function () {
      rows[index].key = keyInput.value;
      writeManifestShowIfRows(item, rows);
    });
    rowEl.appendChild(keyInput);

    var modeSelect = document.createElement('select');
    modeSelect.style.cssText = 'background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:6px;';
    [
      { value: 'equals', label: '一致' },
      { value: 'truthy', label: 'ON' },
      { value: 'falsy', label: 'OFF' },
      { value: 'not', label: '不一致' }
    ].forEach(function (opt) {
      var option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === row.mode) option.selected = true;
      modeSelect.appendChild(option);
    });
    modeSelect.addEventListener('change', function () {
      rows[index].mode = modeSelect.value;
      writeManifestShowIfRows(item, rows);
      rerender();
    });
    rowEl.appendChild(modeSelect);

    var valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = row.value || '';
    valueInput.placeholder = '値';
    valueInput.disabled = row.mode === 'truthy' || row.mode === 'falsy';
    valueInput.style.cssText = 'background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:6px;';
    valueInput.addEventListener('input', function () {
      rows[index].value = valueInput.value;
      writeManifestShowIfRows(item, rows);
    });
    rowEl.appendChild(valueInput);

    var removeBtn = document.createElement('button');
    removeBtn.style.cssText = 'background:#1a2742;border:1px solid #7f1d1d;border-radius:4px;padding:6px 8px;font-size:11px;color:#f87171;cursor:pointer;';
    removeBtn.textContent = '削除';
    removeBtn.addEventListener('click', function () {
      rows.splice(index, 1);
      writeManifestShowIfRows(item, rows);
      rerender();
    });
    rowEl.appendChild(removeBtn);
    section.appendChild(rowEl);
  });

  var addBtn = document.createElement('button');
  addBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  addBtn.textContent = '+ 条件を追加';
  addBtn.addEventListener('click', function () {
    rows.push({ key: '', mode: 'equals', value: '' });
    writeManifestShowIfRows(item, rows);
    rerender();
  });
  section.appendChild(addBtn);
  container.appendChild(section);
}

function renderTemplateFontEditorView(body, activeTemplate, activeInfo) {
  var activeTemplateId = activeTemplate ? (activeTemplate.id || activeTemplate.name) : (editingTemplateId || templateManifestSourceId);
  var draft = editingTemplateManifest;
  var card = document.createElement('div');
  card.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

  var topRow = document.createElement('div');
  topRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = '◀ テンプレート開発に戻る';
  backBtn.addEventListener('click', function () {
    openTemplateDevelopmentWorkspace(templateDevTemplateId || activeTemplateId || templateManifestSourceId);
  });
  topRow.appendChild(backBtn);

  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  var folderBtn = document.createElement('button');
  folderBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  folderBtn.textContent = '対象フォルダを開く';
  folderBtn.addEventListener('click', function () {
    window.api.openTemplateFolder(activeTemplateId).then(function (result) {
      if (result && result.ok === false) {
        showAlertDialog('テンプレートフォルダを開けませんでした: ' + (result.error || '不明なエラー'));
      }
    });
  });
  actions.appendChild(folderBtn);

  var saveBtn = document.createElement('button');
  saveBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
  saveBtn.textContent = 'フォント設定を保存';
  actions.appendChild(saveBtn);
  topRow.appendChild(actions);
  card.appendChild(topRow);

  if (!draft) {
    var loading = document.createElement('div');
    loading.style.cssText = 'font-size:12px;color:#94a3b8;';
    loading.textContent = 'manifest.json を読み込んでいます...';
    card.appendChild(loading);
    body.appendChild(card);
    return;
  }

  function rerender() {
    editingTemplateManifest = draft;
    renderTemplateEditForm(getSceneTemplateById(editingTemplateId || activeTemplateId) || activeTemplate, activeInfo);
  }

  saveBtn.addEventListener('click', function () {
    var errors = validateManifestDraft(draft);
    if (errors.length > 0) {
      showAlertDialog(errors.join('\n'));
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    window.api.saveTemplateManifest(templateManifestSourceId || activeTemplateId, draft).then(function (result) {
      if (!result || result.ok === false) {
        showAlertDialog('フォント設定の保存に失敗しました: ' + ((result && result.error) || '不明なエラー'));
        return;
      }
      editingTemplateManifest = result.manifest ? JSON.parse(JSON.stringify(result.manifest)) : draft;
      editingTemplateId = result.templateId || activeTemplateId;
      templateManifestSourceId = editingTemplateId;
      templateDevTemplateId = editingTemplateId;
      return refreshTemplateList().then(function () {
        rerenderTemplateSettingsIfOpen(editingTemplateId);
      });
    }).catch(function () {
      showAlertDialog('フォント設定の保存に失敗しました。');
    }).finally(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = 'フォント設定を保存';
    });
  });

  var summary = document.createElement('div');
  summary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;margin-bottom:8px;';
  summary.textContent = 'フォント名一覧と fontSources だけを UI で編集します。未知のキーは保持したまま保存されます。';
  card.appendChild(summary);

  var usage = document.createElement('div');
  usage.style.cssText = 'font-size:11px;color:#64748b;line-height:1.7;margin-bottom:8px;';
  usage.textContent = '標準フォント名は fonts、同梱 CSS は assetCss、外部 CSS は remoteCss を使います。保存後はプレビューを再読み込みしてください。';
  card.appendChild(usage);

  appendTemplateFontSections(card, draft, rerender, activeTemplateId);
  body.appendChild(card);
}

function appendTemplateBasicManifestSections(container, draft) {
  var basicSection = createManifestSectionCard('基本情報', 'テンプレートの基本メタデータです。ID を変更した場合はシーン参照も自動で追従します。');
  basicSection.body.appendChild(createManifestTextInput('ID', draft.id, function (value) {
    draft.id = value;
  }, { monospace: true, placeholder: 'com.comment-hub.template.my-template' }));
  basicSection.body.appendChild(createManifestTextInput('name', draft.name, function (value) {
    draft.name = value;
  }, { monospace: true, placeholder: 'my-template' }));
  basicSection.body.appendChild(createManifestTextInput('displayName', draft.displayName, function (value) {
    draft.displayName = value;
  }, { placeholder: '表示名' }));
  basicSection.body.appendChild(createManifestTextInput('version', draft.version, function (value) {
    draft.version = value;
  }, { monospace: true, placeholder: '1.0.0' }));
  basicSection.body.appendChild(createManifestTextInput('obsHint', draft.obsHint, function (value) {
    draft.obsHint = value;
  }, { placeholder: 'OBS幅 480px 推奨 / 高さは任意' }));
  container.appendChild(basicSection.card);

  var exportPolicySection = createManifestSectionCard('エクスポート', '再配布可否と注意書きを設定します。');
  if (!draft.exportPolicy || typeof draft.exportPolicy !== 'object') draft.exportPolicy = {};
  exportPolicySection.body.appendChild(createManifestCheckboxInput('allowTemplateExport', !!draft.exportPolicy.allowTemplateExport, function (checked) {
    draft.exportPolicy.allowTemplateExport = checked;
  }));
  exportPolicySection.body.appendChild(createManifestTextareaInput('note', draft.exportPolicy.note || '', function (value) {
    if (value && value.trim()) draft.exportPolicy.note = value;
    else delete draft.exportPolicy.note;
  }, {
    minHeight: 70,
    placeholder: '同梱フォントや画像などの再配布ライセンスを確認してから true にしてください。'
  }));
  container.appendChild(exportPolicySection.card);
}

function appendTemplateManifestSchemaSection(container, draft, rerender) {
  var schemaSection = createManifestSectionCard('uiSchema', '表示順のまま並びます。ここで編集するのは「設定の値」ではなく「どの設定項目を出すか」です。');
  if (!Array.isArray(draft.uiSchema)) draft.uiSchema = [];
  draft.uiSchema.forEach(function (item, index) {
    if (!item || typeof item !== 'object') draft.uiSchema[index] = createEmptyManifestSchemaItem('slider');
    item = draft.uiSchema[index];
    pruneManifestSchemaItemForType(item);
    var itemCard = document.createElement('div');
    itemCard.style.cssText = 'border:1px solid #1a3a4a;border-radius:6px;padding:10px;margin-bottom:10px;background:#081521;';

    var itemHeader = document.createElement('div');
    itemHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;';
    var itemTitle = document.createElement('div');
    itemTitle.style.cssText = 'font-size:11px;color:#d8e8e8;font-weight:600;';
    itemTitle.textContent = (item.label || item.key || ('item #' + (index + 1))) + ' [' + (item.type || 'unknown') + ']';
    itemHeader.appendChild(itemTitle);
    var itemActions = document.createElement('div');
    itemActions.style.cssText = 'display:flex;gap:6px;';
    [
      {
        label: '↑',
        action: function () {
          if (index === 0) return;
          var tmp = draft.uiSchema[index - 1];
          draft.uiSchema[index - 1] = draft.uiSchema[index];
          draft.uiSchema[index] = tmp;
          rerender();
        }
      },
      {
        label: '↓',
        action: function () {
          if (index >= draft.uiSchema.length - 1) return;
          var tmp = draft.uiSchema[index + 1];
          draft.uiSchema[index + 1] = draft.uiSchema[index];
          draft.uiSchema[index] = tmp;
          rerender();
        }
      },
      {
        label: '削除',
        danger: true,
        action: function () {
          draft.uiSchema.splice(index, 1);
          rerender();
        }
      }
    ].forEach(function (actionItem) {
      var btn = document.createElement('button');
      btn.style.cssText = 'background:#1a2742;border:1px solid ' + (actionItem.danger ? '#7f1d1d' : '#1a3a4a')
        + ';border-radius:4px;padding:4px 8px;font-size:10px;color:' + (actionItem.danger ? '#f87171' : '#94a3b8')
        + ';cursor:pointer;';
      btn.textContent = actionItem.label;
      btn.addEventListener('click', actionItem.action);
      itemActions.appendChild(btn);
    });
    itemHeader.appendChild(itemActions);
    itemCard.appendChild(itemHeader);

    itemCard.appendChild(createManifestTextInput('key', item.key, function (value) {
      item.key = value;
    }, { monospace: true, placeholder: 'fontSize' }));
    itemCard.appendChild(createManifestTextInput('label', item.label, function (value) {
      item.label = value;
    }, { placeholder: '文字サイズ' }));
    itemCard.appendChild(createManifestSelectInput('type', item.type || 'slider', MANIFEST_SCHEMA_TYPES.map(function (type) {
      return { value: type, label: type };
    }), function (value) {
      item.type = value;
      pruneManifestSchemaItemForType(item);
      if (value === 'slider') {
        if (item.min == null) item.min = 0;
        if (item.max == null) item.max = 100;
        if (item.step == null) item.step = 1;
        if (item.default == null) item.default = 0;
      } else if (value === 'buttons') {
        if (!Array.isArray(item.options)) item.options = [{ value: '', label: '' }];
        if (item.default == null) item.default = '';
      } else if (value === 'toggle') {
        if (typeof item.default !== 'boolean') item.default = false;
        if (item.onLabel == null) item.onLabel = 'ON';
        if (item.offLabel == null) item.offLabel = 'OFF';
      } else if (value === 'color') {
        if (item.default == null) item.default = '#ffffff';
      } else if (value === 'font') {
        if (item.default == null) item.default = '';
      } else if (value === 'textarea') {
        if (item.default == null) item.default = '';
        if (item.placeholder == null) item.placeholder = '';
      }
      rerender();
    }));

    if (item.type === 'slider') {
      var sliderGrid = document.createElement('div');
      sliderGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;';
      sliderGrid.appendChild(createManifestNumberInput('min', item.min, function (value) { item.min = value; }, { step: 'any' }));
      sliderGrid.appendChild(createManifestNumberInput('max', item.max, function (value) { item.max = value; }, { step: 'any' }));
      sliderGrid.appendChild(createManifestNumberInput('step', item.step, function (value) {
        if (value == null) delete item.step;
        else item.step = value;
      }, { step: 'any' }));
      sliderGrid.appendChild(createManifestNumberInput('default', item.default, function (value) { item.default = value; }, { step: 'any' }));
      itemCard.appendChild(sliderGrid);
      itemCard.appendChild(createManifestTextInput('suffix', item.suffix || '', function (value) {
        if (value) item.suffix = value;
        else delete item.suffix;
      }, { placeholder: 'px' }));
    } else if (item.type === 'buttons') {
      itemCard.appendChild(createManifestTextInput('default', item.default || '', function (value) {
        item.default = value;
      }, { placeholder: 'up' }));
      itemCard.appendChild(createManifestTextInput('linkedColor', item.linkedColor || '', function (value) {
        if (value) item.linkedColor = value;
        else delete item.linkedColor;
      }, { monospace: true, placeholder: 'glowCustomColor' }));
      var optionsField = createManifestField('options');
      if (!Array.isArray(item.options)) item.options = [];
      item.options.forEach(function (option, optionIndex) {
        if (!option || typeof option !== 'object') item.options[optionIndex] = {};
        option = item.options[optionIndex];
        var optionRow = document.createElement('div');
        optionRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;';
        [
          {
            value: option.value || '',
            placeholder: 'value',
            onInput: function (value) { option.value = value; }
          },
          {
            value: option.label || '',
            placeholder: 'label',
            onInput: function (value) { option.label = value; }
          },
          {
            value: option.hex || '',
            placeholder: 'hex (任意)',
            onInput: function (value) {
              if (value) option.hex = value;
              else delete option.hex;
            }
          }
        ].forEach(function (fieldInfo) {
          var input = document.createElement('input');
          input.type = 'text';
          input.value = fieldInfo.value;
          input.placeholder = fieldInfo.placeholder;
          input.style.cssText = 'background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:6px;';
          input.addEventListener('input', function () { fieldInfo.onInput(input.value); });
          optionRow.appendChild(input);
        });
        var removeOptionBtn = document.createElement('button');
        removeOptionBtn.style.cssText = 'background:#1a2742;border:1px solid #7f1d1d;border-radius:4px;padding:6px 8px;font-size:10px;color:#f87171;cursor:pointer;';
        removeOptionBtn.textContent = '削除';
        removeOptionBtn.addEventListener('click', function () {
          item.options.splice(optionIndex, 1);
          rerender();
        });
        optionRow.appendChild(removeOptionBtn);
        optionsField.appendChild(optionRow);
      });
      var addOptionBtn = document.createElement('button');
      addOptionBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
      addOptionBtn.textContent = '+ option を追加';
      addOptionBtn.addEventListener('click', function () {
        item.options.push({ value: '', label: '' });
        rerender();
      });
      optionsField.appendChild(addOptionBtn);
      itemCard.appendChild(optionsField);
    } else if (item.type === 'toggle') {
      itemCard.appendChild(createManifestCheckboxInput('default', !!item.default, function (checked) {
        item.default = checked;
      }));
      itemCard.appendChild(createManifestTextInput('onLabel', item.onLabel || '', function (value) {
        item.onLabel = value;
      }, { placeholder: '表示' }));
      itemCard.appendChild(createManifestTextInput('offLabel', item.offLabel || '', function (value) {
        item.offLabel = value;
      }, { placeholder: '非表示' }));
    } else if (item.type === 'color') {
      itemCard.appendChild(createManifestTextInput('default', item.default || '', function (value) {
        if (value) item.default = value;
        else delete item.default;
      }, { monospace: true, placeholder: '#ffffff' }));
    } else if (item.type === 'font') {
      itemCard.appendChild(createManifestTextInput('default', item.default || '', function (value) {
        item.default = value;
      }, { monospace: true, placeholder: '"Noto Sans JP", var(--font-family)' }));
      var fontHelp = document.createElement('div');
      fontHelp.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-top:4px;';
      fontHelp.textContent = '候補は manifest.fonts と fontSources.family から自動で表示されます。default には CSS の font-family 値を指定できます。';
      itemCard.appendChild(fontHelp);
    } else if (item.type === 'textarea') {
      itemCard.appendChild(createManifestTextareaInput('default', item.default || '', function (value) {
        item.default = value;
      }, { minHeight: 90, monospace: true }));
      itemCard.appendChild(createManifestTextInput('placeholder', item.placeholder || '', function (value) {
        if (value) item.placeholder = value;
        else delete item.placeholder;
      }, { placeholder: '.comment { color: red; }' }));
    }

    renderManifestShowIfEditor(itemCard, item, rerender);
    schemaSection.body.appendChild(itemCard);
  });

  var addSchemaRow = document.createElement('div');
  addSchemaRow.style.cssText = 'display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;';
  var schemaTypeField = createManifestSelectInput('追加する type', 'slider', MANIFEST_SCHEMA_TYPES.map(function (type) {
    return { value: type, label: type };
  }), function (value) {
    addSchemaRow.dataset.nextType = value;
  });
  addSchemaRow.dataset.nextType = 'slider';
  addSchemaRow.appendChild(schemaTypeField);
  var addSchemaBtn = document.createElement('button');
  addSchemaBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:8px 12px;font-size:11px;color:#94a3b8;cursor:pointer;';
  addSchemaBtn.textContent = '+ uiSchema item を追加';
  addSchemaBtn.addEventListener('click', function () {
    draft.uiSchema.push(createEmptyManifestSchemaItem(addSchemaRow.dataset.nextType || 'slider'));
    rerender();
  });
  addSchemaRow.appendChild(addSchemaBtn);
  schemaSection.body.appendChild(addSchemaRow);
  container.appendChild(schemaSection.card);
}

function renderTemplateBasicInfoEditorView(body, activeTemplate, activeInfo) {
  var activeTemplateId = activeTemplate ? (activeTemplate.id || activeTemplate.name) : (editingTemplateId || templateManifestSourceId);
  var draft = editingTemplateManifest;
  var card = document.createElement('div');
  card.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

  var topRow = document.createElement('div');
  topRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = '◀ テンプレート開発に戻る';
  backBtn.addEventListener('click', function () {
    openTemplateDevelopmentWorkspace(templateDevTemplateId || activeTemplateId || templateManifestSourceId);
  });
  topRow.appendChild(backBtn);

  var saveBtn = document.createElement('button');
  saveBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
  saveBtn.textContent = '基本情報を保存';
  topRow.appendChild(saveBtn);
  card.appendChild(topRow);

  if (!draft) {
    var loading = document.createElement('div');
    loading.style.cssText = 'font-size:12px;color:#94a3b8;';
    loading.textContent = 'manifest.json を読み込んでいます...';
    card.appendChild(loading);
    body.appendChild(card);
    return;
  }

  saveBtn.addEventListener('click', function () {
    var errors = validateManifestDraft(draft);
    if (errors.length > 0) {
      showAlertDialog(errors.join('\n'));
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    window.api.saveTemplateManifest(templateManifestSourceId || activeTemplateId, draft).then(function (result) {
      if (!result || result.ok === false) {
        showAlertDialog('基本情報の保存に失敗しました: ' + ((result && result.error) || '不明なエラー'));
        return;
      }
      editingTemplateManifest = result.manifest ? JSON.parse(JSON.stringify(result.manifest)) : draft;
      editingTemplateId = result.templateId || activeTemplateId;
      templateManifestSourceId = editingTemplateId;
      templateDevTemplateId = editingTemplateId;
      return refreshTemplateList().then(function () {
        rerenderTemplateSettingsIfOpen(editingTemplateId);
      });
    }).catch(function () {
      showAlertDialog('基本情報の保存に失敗しました。');
    }).finally(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = '基本情報を保存';
    });
  });

  var summary = document.createElement('div');
  summary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;margin-bottom:8px;';
  summary.textContent = 'manifest の基本メタデータだけを編集します。フォントや uiSchema は別メニューに分けています。';
  card.appendChild(summary);

  var note = document.createElement('div');
  note.style.cssText = 'font-size:11px;color:#64748b;line-height:1.7;margin-bottom:8px;';
  note.textContent = 'ここでは ID・表示名・バージョン・OBS 向けヒント・再配布ポリシーを編集します。';
  card.appendChild(note);

  appendTemplateBasicManifestSections(card, draft);
  body.appendChild(card);
}

function renderTemplateSchemaEditorView(body, activeTemplate, activeInfo) {
  var activeTemplateId = activeTemplate ? (activeTemplate.id || activeTemplate.name) : (editingTemplateId || templateManifestSourceId);
  var draft = editingTemplateManifest;
  var card = document.createElement('div');
  card.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

  var topRow = document.createElement('div');
  topRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = '◀ テンプレート開発に戻る';
  backBtn.addEventListener('click', function () {
    openTemplateDevelopmentWorkspace(templateDevTemplateId || activeTemplateId || templateManifestSourceId);
  });
  topRow.appendChild(backBtn);

  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  var configBtn = document.createElement('button');
  configBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  configBtn.textContent = '設定を開く';
  configBtn.addEventListener('click', function () {
    openTemplateConfigView(activeTemplate, activeInfo, 'dev');
  });
  actions.appendChild(configBtn);

  var saveBtn = document.createElement('button');
  saveBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
  saveBtn.textContent = '設定項目を保存';
  actions.appendChild(saveBtn);
  topRow.appendChild(actions);
  card.appendChild(topRow);

  if (!draft) {
    var loading = document.createElement('div');
    loading.style.cssText = 'font-size:12px;color:#94a3b8;';
    loading.textContent = 'manifest.json を読み込んでいます...';
    card.appendChild(loading);
    body.appendChild(card);
    return;
  }

  function rerender() {
    editingTemplateManifest = draft;
    renderTemplateEditForm(getSceneTemplateById(editingTemplateId || activeTemplateId) || activeTemplate, activeInfo);
  }

  saveBtn.addEventListener('click', function () {
    var errors = validateManifestDraft(draft);
    if (errors.length > 0) {
      showAlertDialog(errors.join('\n'));
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    window.api.saveTemplateManifest(templateManifestSourceId || activeTemplateId, draft).then(function (result) {
      if (!result || result.ok === false) {
        showAlertDialog('設定項目の保存に失敗しました: ' + ((result && result.error) || '不明なエラー'));
        return;
      }
      editingTemplateManifest = result.manifest ? JSON.parse(JSON.stringify(result.manifest)) : draft;
      editingTemplateId = result.templateId || activeTemplateId;
      templateManifestSourceId = editingTemplateId;
      templateDevTemplateId = editingTemplateId;
      return refreshTemplateList().then(function () {
        rerenderTemplateSettingsIfOpen(editingTemplateId);
      });
    }).catch(function () {
      showAlertDialog('設定項目の保存に失敗しました。');
    }).finally(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = '設定項目を保存';
    });
  });

  var summary = document.createElement('div');
  summary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;margin-bottom:8px;';
  summary.textContent = 'ここでは uiSchema を編集して、テンプレート設定画面にどの項目を出すかを決めます。';
  card.appendChild(summary);

  var note = document.createElement('div');
  note.style.cssText = 'font-size:11px;color:#64748b;line-height:1.7;margin-bottom:8px;';
  note.textContent = '実際の値を変える画面ではありません。プレビューや配信で使う値は「設定」から開いて調整します。';
  card.appendChild(note);

  appendTemplateManifestSchemaSection(card, draft, rerender);
  body.appendChild(card);
}

function renderTemplateManifestView(body, activeTemplate, activeInfo) {
  var activeTemplateId = activeTemplate ? (activeTemplate.id || activeTemplate.name) : (editingTemplateId || templateManifestSourceId);
  var draft = editingTemplateManifest;
  var card = document.createElement('div');
  card.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';

  var topRow = document.createElement('div');
  topRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = '◀ テンプレート開発に戻る';
  backBtn.addEventListener('click', function () {
    openTemplateDevelopmentWorkspace(templateDevTemplateId || activeTemplateId || templateManifestSourceId);
  });
  topRow.appendChild(backBtn);

  var saveBtn = document.createElement('button');
  saveBtn.style.cssText = 'background:#004d54;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
  saveBtn.textContent = 'manifest を保存';
  topRow.appendChild(saveBtn);
  card.appendChild(topRow);

  if (!draft) {
    var loading = document.createElement('div');
    loading.style.cssText = 'font-size:12px;color:#94a3b8;';
    loading.textContent = 'manifest.json を読み込んでいます...';
    card.appendChild(loading);
    body.appendChild(card);
    return;
  }

  function rerender() {
    editingTemplateManifest = draft;
    renderTemplateEditForm(getSceneTemplateById(editingTemplateId || activeTemplateId) || activeTemplate, activeInfo);
  }

  saveBtn.addEventListener('click', function () {
    var errors = validateManifestDraft(draft);
    if (errors.length > 0) {
      showAlertDialog(errors.join('\n'));
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    window.api.saveTemplateManifest(templateManifestSourceId || activeTemplateId, draft).then(function (result) {
      if (!result || result.ok === false) {
        showAlertDialog('manifest.json の保存に失敗しました: ' + ((result && result.error) || '不明なエラー'));
        return;
      }
      editingTemplateManifest = result.manifest ? JSON.parse(JSON.stringify(result.manifest)) : draft;
      editingTemplateId = result.templateId || activeTemplateId;
      templateManifestSourceId = editingTemplateId;
      templateDevTemplateId = editingTemplateId;
      return refreshTemplateList().then(function () {
        rerenderTemplateSettingsIfOpen(editingTemplateId);
      });
    }).catch(function () {
      showAlertDialog('manifest.json の保存に失敗しました。');
    }).finally(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = 'manifest を保存';
    });
  });

  var summary = document.createElement('div');
  summary.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.7;margin-bottom:8px;';
  summary.textContent = 'custom template の manifest.json を structured editor で編集します。未知のキーは保持したまま保存されます。';
  card.appendChild(summary);

  var basicSection = createManifestSectionCard('基本情報', 'テンプレートの基本メタデータです。ID を変更した場合はシーン参照も自動で追従します。');
  basicSection.body.appendChild(createManifestTextInput('ID', draft.id, function (value) {
    draft.id = value;
  }, { monospace: true, placeholder: 'com.comment-hub.template.my-template' }));
  basicSection.body.appendChild(createManifestTextInput('name', draft.name, function (value) {
    draft.name = value;
  }, { monospace: true, placeholder: 'my-template' }));
  basicSection.body.appendChild(createManifestTextInput('displayName', draft.displayName, function (value) {
    draft.displayName = value;
  }, { placeholder: '表示名' }));
  basicSection.body.appendChild(createManifestTextInput('version', draft.version, function (value) {
    draft.version = value;
  }, { monospace: true, placeholder: '1.0.0' }));
  basicSection.body.appendChild(createManifestTextInput('obsHint', draft.obsHint, function (value) {
    draft.obsHint = value;
  }, { placeholder: 'OBS幅 480px 推奨 / 高さは任意' }));
  card.appendChild(basicSection.card);

  appendTemplateFontSections(card, draft, rerender, activeTemplateId);

  var exportPolicySection = createManifestSectionCard('exportPolicy', '再配布可否と注意書きを設定します。');
  if (!draft.exportPolicy || typeof draft.exportPolicy !== 'object') draft.exportPolicy = {};
  exportPolicySection.body.appendChild(createManifestCheckboxInput('allowTemplateExport', !!draft.exportPolicy.allowTemplateExport, function (checked) {
    draft.exportPolicy.allowTemplateExport = checked;
  }));
  exportPolicySection.body.appendChild(createManifestTextareaInput('note', draft.exportPolicy.note || '', function (value) {
    if (value && value.trim()) draft.exportPolicy.note = value;
    else delete draft.exportPolicy.note;
  }, {
    minHeight: 70,
    placeholder: '同梱フォントや画像などの再配布ライセンスを確認してから true にしてください。'
  }));
  card.appendChild(exportPolicySection.card);

  var schemaSection = createManifestSectionCard('uiSchema', '表示順のまま並びます。各 item は type 別フォームで編集できます。');
  if (!Array.isArray(draft.uiSchema)) draft.uiSchema = [];
  draft.uiSchema.forEach(function (item, index) {
    if (!item || typeof item !== 'object') draft.uiSchema[index] = createEmptyManifestSchemaItem('slider');
    item = draft.uiSchema[index];
    pruneManifestSchemaItemForType(item);
    var itemCard = document.createElement('div');
    itemCard.style.cssText = 'border:1px solid #1a3a4a;border-radius:6px;padding:10px;margin-bottom:10px;background:#081521;';

    var itemHeader = document.createElement('div');
    itemHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;';
    var itemTitle = document.createElement('div');
    itemTitle.style.cssText = 'font-size:11px;color:#d8e8e8;font-weight:600;';
    itemTitle.textContent = (item.label || item.key || ('item #' + (index + 1))) + ' [' + (item.type || 'unknown') + ']';
    itemHeader.appendChild(itemTitle);
    var itemActions = document.createElement('div');
    itemActions.style.cssText = 'display:flex;gap:6px;';
    [
      {
        label: '↑',
        action: function () {
          if (index === 0) return;
          var tmp = draft.uiSchema[index - 1];
          draft.uiSchema[index - 1] = draft.uiSchema[index];
          draft.uiSchema[index] = tmp;
          rerender();
        }
      },
      {
        label: '↓',
        action: function () {
          if (index >= draft.uiSchema.length - 1) return;
          var tmp = draft.uiSchema[index + 1];
          draft.uiSchema[index + 1] = draft.uiSchema[index];
          draft.uiSchema[index] = tmp;
          rerender();
        }
      },
      {
        label: '削除',
        danger: true,
        action: function () {
          draft.uiSchema.splice(index, 1);
          rerender();
        }
      }
    ].forEach(function (actionItem) {
      var btn = document.createElement('button');
      btn.style.cssText = 'background:#1a2742;border:1px solid ' + (actionItem.danger ? '#7f1d1d' : '#1a3a4a')
        + ';border-radius:4px;padding:4px 8px;font-size:10px;color:' + (actionItem.danger ? '#f87171' : '#94a3b8')
        + ';cursor:pointer;';
      btn.textContent = actionItem.label;
      btn.addEventListener('click', actionItem.action);
      itemActions.appendChild(btn);
    });
    itemHeader.appendChild(itemActions);
    itemCard.appendChild(itemHeader);

    itemCard.appendChild(createManifestTextInput('key', item.key, function (value) {
      item.key = value;
    }, { monospace: true, placeholder: 'fontSize' }));
    itemCard.appendChild(createManifestTextInput('label', item.label, function (value) {
      item.label = value;
    }, { placeholder: '文字サイズ' }));
    itemCard.appendChild(createManifestSelectInput('type', item.type || 'slider', MANIFEST_SCHEMA_TYPES.map(function (type) {
      return { value: type, label: type };
    }), function (value) {
      item.type = value;
      pruneManifestSchemaItemForType(item);
      if (value === 'slider') {
        if (item.min == null) item.min = 0;
        if (item.max == null) item.max = 100;
        if (item.step == null) item.step = 1;
        if (item.default == null) item.default = 0;
      } else if (value === 'buttons') {
        if (!Array.isArray(item.options)) item.options = [{ value: '', label: '' }];
        if (item.default == null) item.default = '';
      } else if (value === 'toggle') {
        if (typeof item.default !== 'boolean') item.default = false;
        if (item.onLabel == null) item.onLabel = 'ON';
        if (item.offLabel == null) item.offLabel = 'OFF';
      } else if (value === 'color') {
        if (item.default == null) item.default = '#ffffff';
      } else if (value === 'font') {
        if (item.default == null) item.default = '';
      } else if (value === 'textarea') {
        if (item.default == null) item.default = '';
        if (item.placeholder == null) item.placeholder = '';
      }
      rerender();
    }));

    if (item.type === 'slider') {
      var sliderGrid = document.createElement('div');
      sliderGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;';
      sliderGrid.appendChild(createManifestNumberInput('min', item.min, function (value) { item.min = value; }, { step: 'any' }));
      sliderGrid.appendChild(createManifestNumberInput('max', item.max, function (value) { item.max = value; }, { step: 'any' }));
      sliderGrid.appendChild(createManifestNumberInput('step', item.step, function (value) {
        if (value == null) delete item.step;
        else item.step = value;
      }, { step: 'any' }));
      sliderGrid.appendChild(createManifestNumberInput('default', item.default, function (value) { item.default = value; }, { step: 'any' }));
      itemCard.appendChild(sliderGrid);
      itemCard.appendChild(createManifestTextInput('suffix', item.suffix || '', function (value) {
        if (value) item.suffix = value;
        else delete item.suffix;
      }, { placeholder: 'px' }));
    } else if (item.type === 'buttons') {
      itemCard.appendChild(createManifestTextInput('default', item.default || '', function (value) {
        item.default = value;
      }, { placeholder: 'up' }));
      itemCard.appendChild(createManifestTextInput('linkedColor', item.linkedColor || '', function (value) {
        if (value) item.linkedColor = value;
        else delete item.linkedColor;
      }, { monospace: true, placeholder: 'glowCustomColor' }));
      var optionsField = createManifestField('options');
      if (!Array.isArray(item.options)) item.options = [];
      item.options.forEach(function (option, optionIndex) {
        if (!option || typeof option !== 'object') item.options[optionIndex] = {};
        option = item.options[optionIndex];
        var optionRow = document.createElement('div');
        optionRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;';
        [
          {
            value: option.value || '',
            placeholder: 'value',
            onInput: function (value) { option.value = value; }
          },
          {
            value: option.label || '',
            placeholder: 'label',
            onInput: function (value) { option.label = value; }
          },
          {
            value: option.hex || '',
            placeholder: 'hex (任意)',
            onInput: function (value) {
              if (value) option.hex = value;
              else delete option.hex;
            }
          }
        ].forEach(function (fieldInfo) {
          var input = document.createElement('input');
          input.type = 'text';
          input.value = fieldInfo.value;
          input.placeholder = fieldInfo.placeholder;
          input.style.cssText = 'background:#081521;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:6px;';
          input.addEventListener('input', function () { fieldInfo.onInput(input.value); });
          optionRow.appendChild(input);
        });
        var removeOptionBtn = document.createElement('button');
        removeOptionBtn.style.cssText = 'background:#1a2742;border:1px solid #7f1d1d;border-radius:4px;padding:6px 8px;font-size:10px;color:#f87171;cursor:pointer;';
        removeOptionBtn.textContent = '削除';
        removeOptionBtn.addEventListener('click', function () {
          item.options.splice(optionIndex, 1);
          rerender();
        });
        optionRow.appendChild(removeOptionBtn);
        optionsField.appendChild(optionRow);
      });
      var addOptionBtn = document.createElement('button');
      addOptionBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
      addOptionBtn.textContent = '+ option を追加';
      addOptionBtn.addEventListener('click', function () {
        item.options.push({ value: '', label: '' });
        rerender();
      });
      optionsField.appendChild(addOptionBtn);
      itemCard.appendChild(optionsField);
    } else if (item.type === 'toggle') {
      itemCard.appendChild(createManifestCheckboxInput('default', !!item.default, function (checked) {
        item.default = checked;
      }));
      itemCard.appendChild(createManifestTextInput('onLabel', item.onLabel || '', function (value) {
        item.onLabel = value;
      }, { placeholder: '表示' }));
      itemCard.appendChild(createManifestTextInput('offLabel', item.offLabel || '', function (value) {
        item.offLabel = value;
      }, { placeholder: '非表示' }));
    } else if (item.type === 'color') {
      itemCard.appendChild(createManifestTextInput('default', item.default || '', function (value) {
        if (value) item.default = value;
        else delete item.default;
      }, { monospace: true, placeholder: '#ffffff' }));
    } else if (item.type === 'font') {
      itemCard.appendChild(createManifestTextInput('default', item.default || '', function (value) {
        item.default = value;
      }, { monospace: true, placeholder: '"Noto Sans JP", var(--font-family)' }));
      var fontHelp = document.createElement('div');
      fontHelp.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-top:4px;';
      fontHelp.textContent = '候補は manifest.fonts と fontSources.family から自動で表示されます。default には CSS の font-family 値を指定できます。';
      itemCard.appendChild(fontHelp);
    } else if (item.type === 'textarea') {
      itemCard.appendChild(createManifestTextareaInput('default', item.default || '', function (value) {
        item.default = value;
      }, { minHeight: 90, monospace: true }));
      itemCard.appendChild(createManifestTextInput('placeholder', item.placeholder || '', function (value) {
        if (value) item.placeholder = value;
        else delete item.placeholder;
      }, { placeholder: '.comment { color: red; }' }));
    }

    renderManifestShowIfEditor(itemCard, item, rerender);
    schemaSection.body.appendChild(itemCard);
  });

  var addSchemaRow = document.createElement('div');
  addSchemaRow.style.cssText = 'display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;';
  var schemaTypeField = createManifestSelectInput('追加する type', 'slider', MANIFEST_SCHEMA_TYPES.map(function (type) {
    return { value: type, label: type };
  }), function (value) {
    addSchemaRow.dataset.nextType = value;
  });
  addSchemaRow.dataset.nextType = 'slider';
  addSchemaRow.appendChild(schemaTypeField);
  var addSchemaBtn = document.createElement('button');
  addSchemaBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:8px 12px;font-size:11px;color:#94a3b8;cursor:pointer;';
  addSchemaBtn.textContent = '+ uiSchema item を追加';
  addSchemaBtn.addEventListener('click', function () {
    draft.uiSchema.push(createEmptyManifestSchemaItem(addSchemaRow.dataset.nextType || 'slider'));
    rerender();
  });
  addSchemaRow.appendChild(addSchemaBtn);
  schemaSection.body.appendChild(addSchemaRow);
  card.appendChild(schemaSection.card);

  body.appendChild(card);
}

function renderTemplateEditForm(st, info) {
  var body = document.getElementById('tmpl-edit-body');
  var closeBtn = document.getElementById('tmpl-edit-close');
  body.innerHTML = '';
  var templates = currentSceneTemplates || [];
  var availableTemplates = currentAvailableTemplates || [];
  var manifests = cachedTemplateManifests || {};
  var preferredTemplateId = templateEditorMode === 'dev' ? templateDevTemplateId : editingTemplateId;
  var activeTemplate = st || getSceneTemplateById(preferredTemplateId) || null;
  var activeTemplateId = activeTemplate ? (activeTemplate.id || activeTemplate.name) : '';
  var activeInfo = activeTemplateId
    ? (info || getTemplateInfoForRoute(activeTemplateId, currentTemplateInfoMap[activeTemplateId] || { id: activeTemplateId, displayName: activeTemplateId, templateType: 'custom' }, currentTemplateInfoMap))
    : null;

  if (templateEditorMode === 'create') {
    if (closeBtn) closeBtn.style.display = 'none';
    var createTitle = document.getElementById('tmpl-edit-title');
    if (createTitle) createTitle.textContent = '新規テンプレートを作成';
    renderTemplateCreateView(body);
    return;
  }

  if (templateEditorMode === 'dev') {
    if (closeBtn) closeBtn.style.display = 'none';
    if (!activeTemplate || !activeInfo) {
      returnToTemplateManager();
      return;
    }
    var devTitle = document.getElementById('tmpl-edit-title');
    if (devTitle) devTitle.textContent = 'テンプレート開発';
    renderTemplateDevelopmentView(body, activeTemplate, activeInfo, manifests);
    return;
  }

  if (templateEditorMode === 'manifest') {
    if (closeBtn) closeBtn.style.display = 'none';
    var manifestTitle = document.getElementById('tmpl-edit-title');
    if (manifestTitle) manifestTitle.textContent = 'manifest.json 編集';
    renderTemplateManifestView(body, activeTemplate, activeInfo || editingTemplateInfo || null);
    return;
  }

  if (templateEditorMode === 'manifest-basic') {
    if (closeBtn) closeBtn.style.display = 'none';
    var basicTitle = document.getElementById('tmpl-edit-title');
    if (basicTitle) basicTitle.textContent = '基本情報';
    renderTemplateBasicInfoEditorView(body, activeTemplate, activeInfo || editingTemplateInfo || null);
    return;
  }

  if (templateEditorMode === 'manifest-schema') {
    if (closeBtn) closeBtn.style.display = 'none';
    var schemaTitle = document.getElementById('tmpl-edit-title');
    if (schemaTitle) schemaTitle.textContent = '設定項目';
    renderTemplateSchemaEditorView(body, activeTemplate, activeInfo || editingTemplateInfo || null);
    return;
  }

  if (templateEditorMode === 'fonts') {
    if (closeBtn) closeBtn.style.display = 'none';
    var fontTitle = document.getElementById('tmpl-edit-title');
    if (fontTitle) fontTitle.textContent = 'フォント設定';
    renderTemplateFontEditorView(body, activeTemplate, activeInfo || editingTemplateInfo || null);
    return;
  }

  editingTemplateId = activeTemplateId;
  editingTemplateInfo = activeInfo;
  editingTemplateSettings = JSON.parse(JSON.stringify((activeTemplate && activeTemplate.settings) || {}));
  if (closeBtn) closeBtn.style.display = activeTemplate ? 'none' : '';

  var title = document.getElementById('tmpl-edit-title');
  if (title) title.textContent = activeInfo ? ((activeInfo.displayName || activeTemplateId) + ' 設定') : 'テンプレート設定';

  if (!activeTemplate || !activeInfo) {
    var managerCard = document.createElement('div');
    managerCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;margin-bottom:12px;';

    var managerHeader = document.createElement('div');
    managerHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;';

    var managerTitle = document.createElement('div');
    managerTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;';
    managerTitle.textContent = 'テンプレート選択';
    managerHeader.appendChild(managerTitle);

    var headerTestBtn = createTemplateTestButton();
    headerTestBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:4px;padding:4px 8px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;';
    managerHeader.appendChild(headerTestBtn);

    managerCard.appendChild(managerHeader);

    var selectedSummary = document.createElement('div');
    selectedSummary.style.cssText = 'font-size:11px;color:#94a3b8;margin-bottom:10px;';
    selectedSummary.textContent = currentSelectedTemplateId
      ? '配信中: ' + (currentTemplateInfoMap[currentSelectedTemplateId] ? (currentTemplateInfoMap[currentSelectedTemplateId].displayName || currentSelectedTemplateId) : currentSelectedTemplateId)
      : '配信中テンプレート: なし';
    managerCard.appendChild(selectedSummary);

    if (templates.length === 0) {
      var emptyState = document.createElement('div');
      emptyState.style.cssText = 'font-size:12px;color:#64748b;margin-bottom:10px;';
      emptyState.textContent = 'シーンにテンプレートがありません。';
      managerCard.appendChild(emptyState);
    } else {
      templates.forEach(function (templateSt) {
        var templateId = templateSt.id || templateSt.name;
        var templateInfo = getTemplateInfoForRoute(templateId, currentTemplateInfoMap[templateId] || { id: templateId, displayName: templateId, templateType: 'custom' }, currentTemplateInfoMap);
        var row = document.createElement('div');
        var isSelected = templateId === currentSelectedTemplateId;
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid '
          + (isSelected ? '#00bcd4' : '#1a3a4a') + ';border-radius:6px;margin-bottom:8px;background:'
          + (isSelected ? '#0f2f3a' : '#0a1628') + ';cursor:pointer;';
        row.addEventListener('mouseenter', function () {
          row.style.borderColor = isSelected ? '#00bcd4' : '#2f4d68';
          if (!isSelected) row.style.background = '#0d1d31';
        });
        row.addEventListener('mouseleave', function () {
          row.style.borderColor = isSelected ? '#00bcd4' : '#1a3a4a';
          row.style.background = isSelected ? '#0f2f3a' : '#0a1628';
        });
        row.addEventListener('click', function () {
          if (templateId === currentSelectedTemplateId) return;
          window.api.setSelectedSceneTemplate(selectedSceneId, templateId).then(function () {
            refreshTemplateList().then(function () {
              rerenderTemplateSettingsIfOpen();
            });
          });
        });

        var rowLeft = document.createElement('div');
        rowLeft.style.cssText = 'min-width:0;flex:1;';
        var rowName = document.createElement('div');
        rowName.style.cssText = 'font-size:12px;color:#d8e8e8;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        rowName.textContent = templateInfo.displayName || templateId;
        rowLeft.appendChild(rowName);

        var rowMeta = document.createElement('div');
        rowMeta.style.cssText = 'font-size:10px;color:' + (isSelected ? '#7dd3fc' : '#64748b') + ';margin-top:2px;';
        rowMeta.textContent = isSelected ? '選択中' : (TYPE_LABELS[templateInfo.templateType] || templateInfo.templateType);
        rowLeft.appendChild(rowMeta);
        row.appendChild(rowLeft);

        var rowActions = document.createElement('div');
        rowActions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

        if (templateInfo.templateType === 'custom') {
          var devBtn = document.createElement('button');
          devBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 8px;font-size:11px;color:#a78bfa;cursor:pointer;';
          devBtn.textContent = '開発を開く';
          devBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            openTemplateDevelopmentWorkspace(templateId);
          });
          rowActions.appendChild(devBtn);
        }

        var settingsBtn = document.createElement('button');
        settingsBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:4px 8px;font-size:11px;color:#94a3b8;cursor:pointer;';
        settingsBtn.textContent = '設定';
        settingsBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openTemplateConfigView(templateSt, templateInfo, 'manager');
        });
        rowActions.appendChild(settingsBtn);

        row.appendChild(rowActions);
        managerCard.appendChild(row);
      });
    }

    var addBtn = document.createElement('button');
    addBtn.style.cssText = 'width:100%;background:#1a2742;border:1px dashed #1a3a4a;border-radius:8px;padding:8px;font-size:12px;color:#4a6a7a;cursor:pointer;';
    addBtn.textContent = '+ テンプレートを追加';
    addBtn.addEventListener('mouseenter', function () { addBtn.style.borderColor = '#00bcd4'; addBtn.style.color = '#00bcd4'; });
    addBtn.addEventListener('mouseleave', function () { addBtn.style.borderColor = '#1a3a4a'; addBtn.style.color = '#4a6a7a'; });
    addBtn.addEventListener('click', function () {
      showTemplatePickerDropdown(addBtn, templates, availableTemplates);
    });
    managerCard.appendChild(addBtn);

    var developerSection = document.createElement('details');
    developerSection.style.cssText = 'margin-top:12px;background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;';
    var developerSummary = document.createElement('summary');
    developerSummary.style.cssText = 'padding:9px 10px;font-size:11px;font-weight:600;color:#94a3b8;cursor:pointer;';
    developerSummary.textContent = '開発者向け';
    developerSection.appendChild(developerSummary);

    var developerBody = document.createElement('div');
    developerBody.style.cssText = 'padding:0 10px 10px;';
    var developerHint = document.createElement('div');
    developerHint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-bottom:8px;';
    developerHint.textContent = 'HTML / CSS / JS を編集して新しいテンプレートを作る場合だけ使います。配信で使うテンプレートを選ぶだけなら上の「テンプレートを追加」を使います。';
    developerBody.appendChild(developerHint);

    var createBtn = document.createElement('button');
    createBtn.style.cssText = 'width:100%;background:#1a2742;border:1px solid #4c1d95;border-radius:8px;padding:8px;font-size:12px;color:#c4b5fd;cursor:pointer;';
    createBtn.textContent = '新規テンプレートを作成';
    createBtn.addEventListener('click', openTemplateCreateWizard);
    developerBody.appendChild(createBtn);

    var managerGuideBtn = document.createElement('button');
    managerGuideBtn.style.cssText = 'margin-top:6px;width:100%;background:transparent;border:1px solid #1a3a4a;border-radius:8px;padding:8px;font-size:11px;color:#94a3b8;cursor:pointer;';
    managerGuideBtn.textContent = '開発者向けガイドを開く';
    managerGuideBtn.title = '色や表示件数の調整は各テンプレートの「設定」、HTML / CSS / JS の編集はこのガイドです';
    managerGuideBtn.addEventListener('click', function () {
      if (window.api && window.api.templateDevGuide) {
        window.api.templateDevGuide.open();
      }
    });
    developerBody.appendChild(managerGuideBtn);
    developerSection.appendChild(developerBody);
    managerCard.appendChild(developerSection);

    body.appendChild(managerCard);
    return;
  }

  var settings = editingTemplateSettings;
  var manifest = manifests[activeTemplateId];
  var templateSchema = (manifest && manifest.uiSchema) ? manifest.uiSchema : [];
  var fullSchema = templateSchema.slice();
  if (templateSupportsCommonLayout(manifest, activeInfo)) {
    prependMissingSchemaItems(fullSchema, COMMON_LAYOUT_UI_SCHEMA);
  }
  if (isStandardLikeTemplateSchema(manifest, templateSchema, settings, activeInfo)) {
    appendMissingSchemaItems(fullSchema, STANDARD_TEMPLATE_EXTENSION_SCHEMA);
  }
  insertMissingSchemaItemsAfterKey(fullSchema, 'textColor', getCommonTemplateFontSchema(manifest));
  appendMissingSchemaItems(fullSchema, COMMON_TEMPLATE_UI_SCHEMA);

  var backRow = document.createElement('div');
  backRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
  var backBtn = document.createElement('button');
  backBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:6px 10px;font-size:11px;color:#94a3b8;cursor:pointer;';
  backBtn.textContent = templateConfigReturnMode === 'dev'
    ? '◀ テンプレート開発に戻る'
    : '◀ テンプレート一覧に戻る';
  backBtn.addEventListener('click', returnFromTemplateConfig);
  backRow.appendChild(backBtn);
  var configTestBtn = createTemplateTestButton();
  configTestBtn.style.cssText = 'background:#1a2742;border:1px solid #00bcd4;border-radius:4px;padding:6px 10px;font-size:11px;color:#00bcd4;cursor:pointer;white-space:nowrap;margin-left:auto;';
  backRow.appendChild(configTestBtn);
  body.appendChild(backRow);

  var configCard = document.createElement('div');
  configCard.style.cssText = 'background:#0d1b2a;border:1px solid #1a3a4a;border-radius:8px;padding:12px;';
  var configHeader = document.createElement('div');
  configHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;';
  var configTitle = document.createElement('div');
  configTitle.style.cssText = 'font-size:12px;font-weight:600;color:#00bcd4;';
  configTitle.textContent = (activeInfo.displayName || activeTemplateId) + ' の設定';
  configHeader.appendChild(configTitle);

  var configHeaderRight = document.createElement('div');
  configHeaderRight.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;margin-left:auto;';

  var configUrlValue = buildLocalHttpUrl(buildTemplateRoutePath(selectedSceneId, activeTemplateId, activeInfo, templates, currentTemplateInfoMap));
  var configUrl = document.createElement('div');
  configUrl.style.cssText = 'font-size:10px;color:#64748b;font-family:monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:grab;';
  configUrl.textContent = configUrlValue;
  configUrl.title = '確認用URL / OBSにドラッグ&ドロップで追加 / クリックでコピー';
  configUrl.draggable = true;
  configUrl.addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('text/uri-list', configUrlValue);
    e.dataTransfer.setData('text/plain', configUrlValue);
    e.dataTransfer.effectAllowed = 'copy';
  });
  configUrl.addEventListener('click', function () {
    navigator.clipboard.writeText(configUrlValue);
  });
  configHeaderRight.appendChild(configUrl);

  var previewBtn = document.createElement('button');
  previewBtn.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:3px 8px;font-size:11px;color:#94a3b8;cursor:pointer;white-space:nowrap;';
  previewBtn.textContent = '確認用に開く';
  previewBtn.title = 'このテンプレートをテスト背景色付きで開く';
  previewBtn.addEventListener('click', function () {
    window.api.openExternal(buildTemplatePreviewUrl(configUrlValue, settings));
  });
  configHeaderRight.appendChild(previewBtn);

  configHeader.appendChild(configHeaderRight);
  configCard.appendChild(configHeader);

  var fieldsBody = document.createElement('div');
  configCard.appendChild(fieldsBody);

  function tmplAutoSave() {
    if (tmplPendingAutoSave) clearTimeout(tmplPendingAutoSave.timer);
    var timer = setTimeout(function () {
      tmplPendingAutoSave = null;
      window.api.setSceneTemplateConfig(selectedSceneId, activeTemplateId, settings).then(function (result) {
        if (result && result.ok === false) {
          alert('テンプレート設定の保存に失敗しました。');
        } else {
          syncLocalSceneTemplateSettings(activeTemplateId, settings);
        }
      }).catch(function () {
        alert('テンプレート設定の保存に失敗しました。');
      });
    }, 300);
    tmplPendingAutoSave = { timer: timer, save: function () {
      clearTimeout(timer);
      tmplPendingAutoSave = null;
      window.api.setSceneTemplateConfig(selectedSceneId, activeTemplateId, settings).then(function (result) {
        if (result && result.ok === false) {
          alert('テンプレート設定の保存に失敗しました。');
        } else {
          syncLocalSceneTemplateSettings(activeTemplateId, settings);
        }
      }).catch(function () {
        alert('テンプレート設定の保存に失敗しました。');
      });
    }};
  }

  renderTemplateSchemaFields(fieldsBody, fullSchema, settings, tmplAutoSave, manifest);

  var resetBtn = document.createElement('button');
  resetBtn.style.cssText = 'margin-top:12px;width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:8px;font-size:12px;color:#94a3b8;cursor:pointer;';
  resetBtn.textContent = 'デフォルトに戻す';
  resetBtn.addEventListener('mouseenter', function () { resetBtn.style.borderColor = '#f0883e'; resetBtn.style.color = '#f0883e'; });
  resetBtn.addEventListener('mouseleave', function () { resetBtn.style.borderColor = '#1a3a4a'; resetBtn.style.color = '#94a3b8'; });
  resetBtn.addEventListener('click', function () {
    showPromptDialog('設定をデフォルトに戻しますか？', null, function (ok) {
      if (!ok) return;
      var hasImage = fullSchema.some(function (s) {
        return s.type === 'image' && settings[s.key];
      });
      function doReset(resetImages) {
        fullSchema.forEach(function (s) {
          if (!resetImages && s.type === 'image') return;
          if (s['default'] != null) settings[s.key] = s['default'];
          else delete settings[s.key];
        });
        editingTemplateSettings = settings;
        // renderTemplateEditForm は内部で editingTemplateSettings を activeTemplate.settings から
        // 再クローンする (9837 行)。activeTemplate.settings がまだ古い値だと、リセット結果が
        // 上書きで戻され、UI に旧値が残る (= スライダー / プリセットボタン等)。
        // ローカルキャッシュ側を先に同期してから render する。
        syncLocalSceneTemplateSettings(activeTemplateId, settings);
        renderTemplateEditForm(activeTemplate, activeInfo);
        window.api.setSceneTemplateConfig(selectedSceneId, activeTemplateId, settings).then(function (result) {
          if (result && result.ok !== false) {
            syncLocalSceneTemplateSettings(activeTemplateId, settings);
          }
        });
      }
      if (hasImage) {
        showPromptDialog('背景画像もリセットしますか？', null, function (ok2) {
          doReset(!!ok2);
        });
      } else {
        doReset(false);
      }
    });
  });
  configCard.appendChild(resetBtn);

  if (templateConfigReturnMode !== 'dev') {
    var developerActionCard = document.createElement('details');
    developerActionCard.style.cssText = 'margin-top:12px;background:#0a1929;border:1px solid #1a3a4a;border-radius:8px;';
    var developerActionSummary = document.createElement('summary');
    developerActionSummary.style.cssText = 'padding:9px 10px;font-size:11px;font-weight:600;color:#94a3b8;cursor:pointer;';
    developerActionSummary.textContent = '開発者向け';
    developerActionCard.appendChild(developerActionSummary);

    var developerActionBody = document.createElement('div');
    developerActionBody.style.cssText = 'padding:0 10px 10px;';
    var developerActionHint = document.createElement('div');
    developerActionHint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.6;margin-bottom:8px;';
    developerActionHint.textContent = 'HTML / CSS / JS / manifest を編集する場合や、テンプレートファイルを配布・更新する場合だけ使います。';
    developerActionBody.appendChild(developerActionHint);

    if (!activeInfo.builtin) {
      if (activeInfo.templateType === 'custom') {
        var devOpenBtn = document.createElement('button');
        devOpenBtn.style.cssText = 'width:100%;background:#1a2742;border:1px solid #7c3aed;border-radius:4px;padding:8px;font-size:12px;color:#c4b5fd;cursor:pointer;';
        devOpenBtn.textContent = '開発画面を開く';
        devOpenBtn.addEventListener('mouseenter', function () { devOpenBtn.style.borderColor = '#a78bfa'; devOpenBtn.style.color = '#ddd6fe'; });
        devOpenBtn.addEventListener('mouseleave', function () { devOpenBtn.style.borderColor = '#7c3aed'; devOpenBtn.style.color = '#c4b5fd'; });
        devOpenBtn.addEventListener('click', function () {
          openTemplateDevelopmentWorkspace(activeTemplateId);
        });
        developerActionBody.appendChild(devOpenBtn);
      }

      var manifestBtn = document.createElement('button');
      manifestBtn.style.cssText = 'margin-top:8px;width:100%;background:#1a2742;border:1px solid #6d28d9;border-radius:4px;padding:8px;font-size:12px;color:#c4b5fd;cursor:pointer;';
      manifestBtn.textContent = '開発者向け: 設定項目を編集';
      manifestBtn.title = 'manifest.json の uiSchema など、テンプレート構造を編集します';
      manifestBtn.addEventListener('mouseenter', function () { manifestBtn.style.borderColor = '#a78bfa'; manifestBtn.style.color = '#ddd6fe'; });
      manifestBtn.addEventListener('mouseleave', function () { manifestBtn.style.borderColor = '#6d28d9'; manifestBtn.style.color = '#c4b5fd'; });
      manifestBtn.addEventListener('click', function () {
        openTemplateManifestEditor(activeTemplate, activeInfo);
      });
      developerActionBody.appendChild(manifestBtn);

      var reimportBtn = document.createElement('button');
      reimportBtn.style.cssText = 'margin-top:8px;width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:8px;font-size:12px;color:#94a3b8;cursor:pointer;';
      reimportBtn.textContent = '再インポート（アップデート）';
      reimportBtn.addEventListener('mouseenter', function () { reimportBtn.style.borderColor = '#00bcd4'; reimportBtn.style.color = '#00bcd4'; });
      reimportBtn.addEventListener('mouseleave', function () { reimportBtn.style.borderColor = '#1a3a4a'; reimportBtn.style.color = '#94a3b8'; });
      reimportBtn.addEventListener('click', function () {
        window.api.installTemplate().then(function (result) {
          if (result && result.ok) {
            notifyUnsupportedOneCommePlugins(result);
            refreshTemplateList().then(function () {
              renderTemplateEditForm(getSceneTemplateById(activeTemplateId), activeInfo);
            });
          } else if (result && result.error) {
            showAlertDialog('インポート失敗: ' + result.error);
          }
        });
      });
      developerActionBody.appendChild(reimportBtn);
    }

    if (activeInfo.builtin) {
      var builtinDevBtn = document.createElement('button');
      builtinDevBtn.style.cssText = 'width:100%;background:#1a2742;border:1px solid #7c3aed;border-radius:4px;padding:8px;font-size:12px;color:#c4b5fd;cursor:pointer;';
      builtinDevBtn.textContent = '複製して開発';
      builtinDevBtn.addEventListener('mouseenter', function () { builtinDevBtn.style.borderColor = '#a78bfa'; builtinDevBtn.style.color = '#ddd6fe'; });
      builtinDevBtn.addEventListener('mouseleave', function () { builtinDevBtn.style.borderColor = '#7c3aed'; builtinDevBtn.style.color = '#c4b5fd'; });
      builtinDevBtn.addEventListener('click', function () {
        showAlertDialog(
          'この built-in を元に custom テンプレートを新規作成します。元の built-in は変更されません。複製後はまず index.html / style.css を触り、必要になったら script.js や manifest を編集してください。',
          function () {
            openTemplateCreateWizardFromBuiltin(activeTemplate, activeInfo);
          }
        );
      });
      developerActionBody.appendChild(builtinDevBtn);
    }

    var exportBtn = document.createElement('button');
    exportBtn.style.cssText = 'margin-top:8px;width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:8px;font-size:12px;color:#94a3b8;cursor:pointer;';
    exportBtn.textContent = 'テンプレートをエクスポート';
    exportBtn.addEventListener('mouseenter', function () { exportBtn.style.borderColor = '#00bcd4'; exportBtn.style.color = '#00bcd4'; });
    exportBtn.addEventListener('mouseleave', function () { exportBtn.style.borderColor = '#1a3a4a'; exportBtn.style.color = '#94a3b8'; });
    exportBtn.addEventListener('click', function () {
      showPromptDialog('エクスポート名を入力', activeInfo.displayName || activeTemplateId, function (exportName) {
        if (!exportName) return;
        rendererLog.info('user: template-export, templateId=' + activeTemplateId + ', sceneId=' + selectedSceneId + ', exportName=' + exportName);
        window.api.exportTemplate(activeTemplateId, exportName, selectedSceneId, settings).then(function (result) {
          if (result && result.ok) {
            showAlertDialog('エクスポートしました。');
          } else if (result && !result.cancelled && result.error) {
            showAlertDialog(result.error);
          }
        });
      });
    });
    developerActionBody.appendChild(exportBtn);

    var removeBtn = document.createElement('button');
    removeBtn.style.cssText = 'margin-top:12px;width:100%;background:#1a2742;border:1px solid #1a3a4a;border-radius:4px;padding:8px;font-size:12px;color:#94a3b8;cursor:pointer;';
    removeBtn.textContent = 'シーンから削除';
    removeBtn.addEventListener('mouseenter', function () { removeBtn.style.borderColor = '#ef4444'; removeBtn.style.color = '#ef4444'; });
    removeBtn.addEventListener('mouseleave', function () { removeBtn.style.borderColor = '#1a3a4a'; removeBtn.style.color = '#94a3b8'; });
    removeBtn.addEventListener('click', function () {
      showPromptDialog('「' + (activeInfo.displayName || activeTemplateId) + '」をシーンから削除しますか？', null, function (ok) {
        if (!ok) return;
        window.api.removeSceneTemplate(selectedSceneId, activeTemplateId).then(function () {
          refreshTemplateList().then(function () {
            var nextTemplate = getSceneTemplateById(currentSelectedTemplateId) || currentSceneTemplates[0] || null;
            var nextId = nextTemplate ? (nextTemplate.id || nextTemplate.name) : '';
            var nextInfo = nextId ? getTemplateInfoForRoute(nextId, currentTemplateInfoMap[nextId] || { id: nextId, displayName: nextId, templateType: 'custom' }, currentTemplateInfoMap) : null;
            renderTemplateEditForm(nextTemplate, nextInfo);
          });
        });
      });
    });
    configCard.appendChild(removeBtn);
  }

  if (!activeInfo.builtin) {
    var deleteImportedBtn = document.createElement('button');
    deleteImportedBtn.style.cssText = 'margin-top:12px;width:100%;background:#1a2742;border:1px solid #7f1d1d;border-radius:4px;padding:8px;font-size:12px;color:#f87171;cursor:pointer;';
    deleteImportedBtn.textContent = 'インポート済みテンプレートを削除';
    deleteImportedBtn.addEventListener('mouseenter', function () { deleteImportedBtn.style.borderColor = '#ef4444'; deleteImportedBtn.style.color = '#ef4444'; });
    deleteImportedBtn.addEventListener('mouseleave', function () { deleteImportedBtn.style.borderColor = '#7f1d1d'; deleteImportedBtn.style.color = '#f87171'; });
    deleteImportedBtn.addEventListener('click', function () {
      deleteImportedTemplate(activeTemplateId, activeInfo.displayName || activeTemplateId, function () {
        editingTemplateId = null;
        editingTemplateInfo = null;
        editingTemplateSettings = null;
        renderTemplateEditForm(null, null);
      });
    });
    configCard.appendChild(deleteImportedBtn);
  }

  if (developerActionCard && developerActionBody && developerActionBody.childNodes.length > 1) {
    developerActionCard.appendChild(developerActionBody);
    configCard.appendChild(developerActionCard);
  }

  body.appendChild(configCard);
}

// 閉じるボタンは SubsectionNav.register の adopt 経由で framework が bind。
// register call は同ファイル末尾 (= 該当 section ブロック) を参照。
SubsectionNav.register({
  id: 'template-edit-section',
  parentId: null,
  title: 'テンプレート設定',
  scrollSelector: '#app-frame .frame-body',
  onReturn: function () {
    editingTemplateId = null;
    editingTemplateInfo = null;
    editingTemplateSettings = null;
    editingTemplateManifest = null;
    templateManifestSourceId = '';
    templateEditorMode = 'manager';
    templateDevTemplateId = '';
    updateSceneLock();
    refreshTemplateList();
  },
});

function findSchemaDefault(schema, key) {
  for (var i = 0; i < schema.length; i++) {
    if (schema[i].key === key) return schema[i]['default'];
  }
  return undefined;
}

function clampColorChannel(value) {
  var num = parseInt(value, 10);
  if (Number.isNaN(num)) return 255;
  if (num < 0) return 0;
  if (num > 255) return 255;
  return num;
}

function toHexColor(value) {
  if (typeof value !== 'string') return '#ffffff';
  var trimmed = value.trim();
  var shortHex = trimmed.match(/^#([0-9a-f]{3})$/i);
  if (shortHex) {
    return '#' + shortHex[1].split('').map(function (ch) { return ch + ch; }).join('').toLowerCase();
  }
  var longHex = trimmed.match(/^#([0-9a-f]{6})$/i);
  if (longHex) return '#' + longHex[1].toLowerCase();

  var rgb = trimmed.match(/^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(?:0|1|0?\.\d+)\s*)?\)$/i);
  if (rgb) {
    return '#'
      + clampColorChannel(rgb[1]).toString(16).padStart(2, '0')
      + clampColorChannel(rgb[2]).toString(16).padStart(2, '0')
      + clampColorChannel(rgb[3]).toString(16).padStart(2, '0');
  }
  return '#ffffff';
}

function renderTemplateSchemaFields(container, schema, settings, autoSaveFn, manifest) {
  schema.forEach(function (s) {
    // showIf: 指定キーの値が一致しなければスキップ
    if (s.showIf) {
      var conditions = Array.isArray(s.showIf) ? s.showIf : [s.showIf];
      var allMet = true;
      for (var ci = 0; ci < conditions.length; ci++) {
        var cond = conditions[ci];
        var dep = settings[cond.key] != null ? settings[cond.key] : findSchemaDefault(schema, cond.key);
        if (cond.value === true) { if (!dep) { allMet = false; break; } }
        else if (cond.value === false) { if (dep) { allMet = false; break; } }
        else if (cond.not != null) { if (dep === cond.not) { allMet = false; break; } }
        else { if (dep !== cond.value) { allMet = false; break; } }
      }
      if (!allMet) return;
    }
    if (s.type === 'slider') {
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;';
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = s.min;
      slider.max = s.max;
      if (s.step) slider.step = s.step;
      slider.value = settings[s.key] != null ? settings[s.key] : s['default'];
      slider.style.cssText = 'flex:1;';
      var suffix = s.suffix || '';
      var valWidth = suffix ? '50px' : '30px';
      var val = document.createElement('span');
      val.style.cssText = 'font-size:12px;color:#94a3b8;width:' + valWidth + ';text-align:right;';
      val.textContent = (settings[s.key] != null ? settings[s.key] : s['default']) + suffix;
      slider.addEventListener('input', function () {
        val.textContent = slider.value + suffix;
        settings[s.key] = parseFloat(slider.value);
        autoSaveFn();
      });
      row.appendChild(slider);
      row.appendChild(val);
      field.appendChild(row);
      container.appendChild(field);

    } else if (s.type === 'buttons') {
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
      s.options.forEach(function (opt) {
        var btn = document.createElement('button');
        btn.style.cssText = 'flex:1 1 60px;border-radius:4px;padding:6px;font-size:11px;cursor:pointer;'
          + (((settings[s.key] != null ? settings[s.key] : s['default'])) === opt.value
            ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
            : 'background:#1a2742;border:1px solid #1a3a4a;color:#94a3b8;');
        btn.textContent = opt.label;
        btn.addEventListener('click', function () {
          settings[s.key] = opt.value;
          // linkedColor: ボタンの hex 値でカラーピッカーも連動更新
          if (s.linkedColor && opt.hex) {
            settings[s.linkedColor] = opt.hex;
          }
          // applyValues: ボタン選択時に複数の設定キーを一括上書き (色プリセット等)。
          // ユーザーは適用後に個別キーを微調整できる (= プリセットを起点にカスタム可)。
          if (opt.applyValues && typeof opt.applyValues === 'object') {
            Object.keys(opt.applyValues).forEach(function (applyKey) {
              settings[applyKey] = opt.applyValues[applyKey];
            });
          }
          autoSaveFn();
          // re-render buttons
          container.innerHTML = '';
          renderTemplateSchemaFields(container, schema, settings, autoSaveFn, manifest);
        });
        row.appendChild(btn);
      });
      field.appendChild(row);
      container.appendChild(field);

    } else if (s.type === 'toggle') {
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var isOn = settings[s.key] != null ? settings[s.key] : s['default'];
      var chip = document.createElement('button');
      chip.style.cssText = 'border-radius:4px;padding:6px 14px;font-size:11px;cursor:pointer;'
        + (isOn
          ? 'background:#004d54;border:1px solid #00bcd4;color:#00bcd4;'
          : 'background:#1a2742;border:1px solid #1a3a4a;color:#64748b;');
      chip.textContent = isOn ? (s.onLabel || 'ON') : (s.offLabel || 'OFF');
      chip.addEventListener('click', function () {
        settings[s.key] = !(settings[s.key] != null ? settings[s.key] : s['default']);
        autoSaveFn();
        // re-render
        container.innerHTML = '';
        renderTemplateSchemaFields(container, schema, settings, autoSaveFn, manifest);
      });
      field.appendChild(chip);
      container.appendChild(field);

    } else if (s.type === 'color') {
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;';
      var colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.style.cssText = 'width:32px;height:28px;padding:0;border:1px solid #1a3a4a;border-radius:4px;background:#0a1929;cursor:pointer;';
      var colorPreview = document.createElement('div');
      colorPreview.style.cssText = 'width:18px;height:18px;border-radius:4px;border:1px solid #1a3a4a;background:#0a1929;flex-shrink:0;';
      var colorLabel = document.createElement('span');
      colorLabel.style.cssText = 'font-size:12px;color:#94a3b8;';

      var clearBtn = document.createElement('button');
      clearBtn.style.cssText = 'background:none;border:1px solid #1a3a4a;border-radius:4px;padding:2px 8px;font-size:10px;color:#94a3b8;cursor:pointer;';
      clearBtn.textContent = 'クリア';

      function syncColorField() {
        var storedVal = settings[s.key];
        var defaultVal = s['default'];
        var hasStoredColor = typeof storedVal === 'string' && storedVal.trim() !== '';
        var hasDefaultColor = typeof defaultVal === 'string' && defaultVal.trim() !== '';
        var displayVal = hasStoredColor ? storedVal.trim() : (hasDefaultColor ? defaultVal.trim() : '');

        colorInput.value = toHexColor(displayVal);
        colorPreview.style.background = displayVal || '#0a1929';
        if (displayVal) {
          colorInput.style.opacity = '1';
          colorInput.style.filter = 'none';
          colorPreview.style.opacity = '1';
        } else {
          colorInput.style.opacity = '0.4';
          colorInput.style.filter = 'grayscale(1)';
          colorPreview.style.opacity = '0.4';
        }

        if (hasStoredColor) {
          colorLabel.textContent = storedVal.trim();
        } else if (hasDefaultColor) {
          colorLabel.textContent = defaultVal.trim() + ' (既定)';
        } else {
          colorLabel.textContent = '未設定';
        }

        clearBtn.disabled = settings[s.key] == null;
        clearBtn.style.opacity = clearBtn.disabled ? '0.45' : '1';
      }

      syncColorField();

      clearBtn.addEventListener('click', function () {
        delete settings[s.key];
        syncColorField();
        autoSaveFn();
      });

      colorInput.addEventListener('input', function () {
        settings[s.key] = colorInput.value;
        syncColorField();
        autoSaveFn();
      });
      row.appendChild(colorInput);
      row.appendChild(colorPreview);
      row.appendChild(colorLabel);
      row.appendChild(clearBtn);
      field.appendChild(row);
      container.appendChild(field);

    } else if (s.type === 'font') {
      var fontOptions = buildTemplateFontSettingOptions(manifest);
      var hasFontChoices = fontOptions.length > 1;
      var fontField = document.createElement('div');
      fontField.className = 'perf-field';
      var fontLabel = document.createElement('div');
      fontLabel.className = 'perf-field-label';
      fontLabel.textContent = s.label;
      fontField.appendChild(fontLabel);

      var fontSelect = document.createElement('select');
      fontSelect.style.cssText = 'width:100%;background:#0a1929;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:8px;box-sizing:border-box;';
      fontOptions.forEach(function (option) {
        var optEl = document.createElement('option');
        optEl.value = option.value;
        optEl.textContent = option.label;
        fontSelect.appendChild(optEl);
      });
      if (!hasFontChoices) {
        var emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '利用可能フォントなし';
        fontSelect.appendChild(emptyOpt);
      }
      fontSelect.value = settings[s.key] != null ? settings[s.key] : (s['default'] || '');
      if (!hasFontChoices) fontSelect.disabled = true;
      fontSelect.addEventListener('change', function () {
        if (fontSelect.value) settings[s.key] = fontSelect.value;
        else delete settings[s.key];
        autoSaveFn();
      });
      fontField.appendChild(fontSelect);
      container.appendChild(fontField);

    } else if (s.type === 'textarea') {
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var ta = document.createElement('textarea');
      ta.style.cssText = 'width:100%;min-height:80px;background:#0a1929;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-family:monospace;font-size:11px;padding:6px;resize:vertical;';
      ta.value = settings[s.key] != null ? settings[s.key] : (s['default'] || '');
      if (s.placeholder) ta.placeholder = s.placeholder;
      ta.addEventListener('input', function () {
        settings[s.key] = ta.value;
        autoSaveFn();
      });
      field.appendChild(ta);
      container.appendChild(field);

    } else if (s.type === 'text') {
      // 1 行テキスト入力。ヘッダータイトル / kicker 等の短い文字列向け。
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var input = document.createElement('input');
      input.type = 'text';
      input.style.cssText = 'width:100%;background:#0a1929;border:1px solid #1a3a4a;border-radius:4px;color:#d8e8e8;font-size:12px;padding:6px 8px;';
      input.value = settings[s.key] != null ? settings[s.key] : (s['default'] || '');
      if (s.placeholder) input.placeholder = s.placeholder;
      input.addEventListener('input', function () {
        settings[s.key] = input.value;
        autoSaveFn();
      });
      field.appendChild(input);
      container.appendChild(field);

    } else if (s.type === 'image') {
      var field = document.createElement('div');
      field.className = 'perf-field';
      var label = document.createElement('div');
      label.className = 'perf-field-label';
      label.textContent = s.label;
      field.appendChild(label);

      var currentFile = settings[s.key] || '';
      var dropZone = document.createElement('div');
      dropZone.style.cssText = 'width:100%;min-height:60px;background:#0a1929;border:1px dashed #1a3a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;position:relative;';

      if (currentFile) {
        var assetUrl = buildTemplateAssetPreviewUrl(
          selectedSceneId,
          editingTemplateId,
          editingTemplateInfo,
          currentSceneTemplates,
          currentTemplateInfoMap,
          currentFile
        );
        var preview = document.createElement('img');
        preview.src = assetUrl;
        preview.style.cssText = 'max-width:100%;max-height:120px;object-fit:contain;';
        dropZone.appendChild(preview);
        // クリアボタン
        var clearBtn = document.createElement('button');
        clearBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.6);border:1px solid #1a3a4a;border-radius:4px;padding:2px 6px;font-size:10px;color:#ef4444;cursor:pointer;';
        clearBtn.textContent = '✕';
        clearBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          delete settings[s.key];
          autoSaveFn();
          container.innerHTML = '';
          renderTemplateSchemaFields(container, schema, settings, autoSaveFn, manifest);
        });
        dropZone.appendChild(clearBtn);
      } else {
        var placeholder = document.createElement('span');
        placeholder.style.cssText = 'font-size:11px;color:#475569;';
        placeholder.textContent = '画像をドラッグ&ドロップ / クリックで選択';
        dropZone.appendChild(placeholder);
      }

      function handleImageFile(filePath) {
        window.api.copyPerformanceAsset(selectedSceneId, filePath, 'tmpl').then(function (result) {
          if (result && result.filename) {
            settings[s.key] = canonicalTemplateAssetPath(result.filename);
            autoSaveFn();
            container.innerHTML = '';
            renderTemplateSchemaFields(container, schema, settings, autoSaveFn, manifest);
          }
        });
      }

      dropZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.style.borderColor = '#00bcd4';
      });
      dropZone.addEventListener('dragleave', function () {
        dropZone.style.borderColor = '#1a3a4a';
      });
      dropZone.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.style.borderColor = '#1a3a4a';
        var files = e.dataTransfer.files;
        if (files && files.length > 0) handleImageFile(files[0].path);
      });
      dropZone.addEventListener('click', function () {
        window.api.addPerformanceAsset(selectedSceneId, 'tmpl').then(function (result) {
          if (result && result.filename) {
            settings[s.key] = result.filename;
            autoSaveFn();
            container.innerHTML = '';
            renderTemplateSchemaFields(container, schema, settings, autoSaveFn);
          }
        });
      });

      field.appendChild(dropZone);
      container.appendChild(field);
    }
  });
}

function addTemplateWithFontCheck(templateId) {
  var manifests = cachedTemplateManifests || {};
  var manifest = manifests[templateId];
  var fonts = (manifest && manifest.fonts) || [];

  if (fonts.length === 0) {
    window.api.addSceneTemplate(selectedSceneId, templateId).then(function () {
      refreshTemplateList().then(function () {
        rerenderTemplateSettingsIfOpen();
      });
    });
    return;
  }

  // 進捗ダイアログ（DLが発生した時だけ表示）
  var overlay = null;
  var msgEl = null;

  function showDlDialog() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'prompt-dialog';
    msgEl = document.createElement('div');
    msgEl.className = 'prompt-label';
    msgEl.textContent = 'フォントをダウンロード中...';
    dialog.appendChild(msgEl);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  var removeListener = window.api.onFontDlProgress(function (data) {
    showDlDialog();
    msgEl.textContent = 'フォントをダウンロード中... (' + data.current + '/' + data.total + ') ' + data.family;
  });

  window.api.ensureTemplateFonts(fonts).then(function () {
    removeListener();
    if (overlay) overlay.remove();
    return window.api.addSceneTemplate(selectedSceneId, templateId);
  }).then(function () {
    refreshTemplateList().then(function () {
      rerenderTemplateSettingsIfOpen();
    });
  }).catch(function () {
    removeListener();
    if (overlay) overlay.remove();
  });
}

function showTemplatePickerDropdown(anchor, sceneTemplates, availableTemplates) {
  // 既存のドロップダウンを閉じる
  var existing = document.getElementById('tmpl-picker-dropdown');
  if (existing) { existing.remove(); return; }

  var notAdded = availableTemplates.filter(function (t) {
    return !sceneTemplates.some(function (st) { return (st.id || st.name) === t.id; });
  });

  var dropdown = document.createElement('div');
  dropdown.id = 'tmpl-picker-dropdown';
  dropdown.style.cssText = 'background:#1a2742;border:1px solid #1a3a4a;border-radius:6px;padding:4px 0;margin:4px 16px;';

  notAdded.forEach(function (tmpl) {
    var item = document.createElement('div');
    item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:12px;color:#d8e8e8;display:flex;justify-content:space-between;align-items:center;';
    item.addEventListener('mouseenter', function () { item.style.background = '#0d1b2a'; });
    item.addEventListener('mouseleave', function () { item.style.background = ''; });

    var label = document.createElement('span');
    label.textContent = tmpl.displayName || tmpl.id || tmpl.name;

    var badge = document.createElement('span');
    badge.style.cssText = 'font-size:9px;color:#00bcd4;background:#004d54;padding:1px 5px;border-radius:3px;';
    badge.textContent = TYPE_LABELS[tmpl.templateType] || tmpl.templateType;

    item.appendChild(label);
    item.appendChild(badge);
    item.addEventListener('click', function () {
      dropdown.remove();
      addTemplateWithFontCheck(tmpl.id || tmpl.name);
    });
    dropdown.appendChild(item);
  });

  // インポートオプション
  var importItem = document.createElement('div');
  importItem.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:12px;color:#00bcd4;border-top:1px solid #1a3a4a;margin-top:2px;';
  importItem.textContent = '📦 新しいテンプレートをインポート...';
  importItem.addEventListener('mouseenter', function () { importItem.style.background = '#0d1b2a'; });
  importItem.addEventListener('mouseleave', function () { importItem.style.background = ''; });
  importItem.addEventListener('click', function () {
    dropdown.remove();
    window.api.installTemplate().then(function (result) {
      if (result && result.ok) {
        notifyUnsupportedOneCommePlugins(result);
        var tmplId = result.template && (result.template.id || result.template.name);
        if (tmplId) {
          window.api.addSceneTemplate(selectedSceneId, tmplId).then(function () {
            refreshTemplateList().then(function () {
              rerenderTemplateSettingsIfOpen();
            });
          });
        } else {
          refreshTemplateList().then(function () {
            rerenderTemplateSettingsIfOpen();
          });
        }
      } else if (result && result.error) {
        showAlertDialog('インポート失敗: ' + result.error);
      }
    });
  });
  dropdown.appendChild(importItem);

  // ドロップダウンをボタンの後に挿入
  anchor.parentNode.insertBefore(dropdown, anchor.nextSibling);

  // 外側クリックで閉じる
  setTimeout(function () {
    document.addEventListener('click', function closeDropdown(e) {
      if (!dropdown.contains(e.target) && e.target !== anchor) {
        dropdown.remove();
        document.removeEventListener('click', closeDropdown);
      }
    });
  }, 0);
}

// 折りたたみトグル
var tmplToggleEl = document.getElementById('tmpl-toggle');
var tmplBodyEl = document.getElementById('tmpl-body');
if (tmplToggleEl && tmplBodyEl) {
  document.getElementById('tmpl-header').addEventListener('click', function (e) {
    // ON/OFF ボタンクリック時は折りたたみしない
    if (e.target.id === 'tmpl-scene-toggle') return;
    var collapsed = tmplBodyEl.style.display === 'none';
    tmplBodyEl.style.display = collapsed ? '' : 'none';
    tmplToggleEl.textContent = collapsed ? '▼' : '▶';
  });
}

// シーン切り替え時にテンプレート一覧もリフレッシュ
var _origRenderApps = renderApps;
renderApps = function () {
  _origRenderApps();
  var tmplSceneName = document.getElementById('tmpl-scene-name');
  if (tmplSceneName) {
    api.getScene(selectedSceneId).then(function (scene) {
      if (scene) tmplSceneName.textContent = scene.name;
    });
  }
  refreshTemplateList();
};

// 初期表示
refreshTemplateList();

// renderer 準備完了を main に通知（サイドカーとのハンドシェイク）
if (api.notifyRendererReady) {
  api.notifyRendererReady();
}

// ============================================================
// Step 3 リスナー管理 (フェーズ 3.2a)
// 既存の openTemplateSettings / closeTemplateSettings と同じパターンで
// セクション表示/非表示を切り替える。
// ============================================================

var listenerMgrState = {
  page: { total: 0, rows: [], limit: 100, offset: 0 },
  sort: 'streamFirstAt',
  q: '',
  ownerChannels: [], // [{ channelId, handle? }] 複数 ID 対応
  selectedIds: new Set(), // 一覧で選択中の channel_id (廃止、UI 復活時に備えて残置)
  density: 'm', // 表示密度 'l' (大) / 'm' (中) / 's' (小)。default = 中
  // ミニタブフィルター。接続中の枠のリスナー母集団に対する 6 タブ排他選択。
  // 値: 'all' / 'unGreeted' / 'firstTime' / 'returning' / 'comeback' / 'newMember'
  // 接続切替時は 'all' にリセット (= デフォルト)。
  miniTab: 'all',
  // 6 タブの件数バッジ用 cache。streamScopedListenerCounts で取得。
  miniTabCounts: { all: 0, unGreeted: 0, firstTime: 0, returning: 0, comeback: 0, newMember: 0 }
};

// 現枠 SC は listener row の `perStreamScAmountJpy` を正本として直接読む
// (= Rust list_listeners が当該枠コメ集計から計算済み)。過去は別 cache を
// 持っていたが、起動前に発生した SC が永遠に拾えない / 正本 2 重化で同期
// バグの温床になる問題があった。live 更新は onComment 経路で
// listenerMgrState.page.rows の対応 row を in-place 更新する。

// listener heatmap キャッシュ: { 'yt-{UC...}': [{count, scAmountJpy}, ...] (cells, N 個) }
// listener.list 完了後に api.listeners.activity を 1 度叩いて埋める。
// 密度 (大/中/小) 切替の re-render では再 fetch せずキャッシュから即座に再描画。
var listenerActivityCacheByChannelId = {};

// heatmap で表示する直近 N 配信枠 (oldest → newest)。各要素 { videoId, title, startedAt }。
// streams[i] と各 listener の cells[i] は index 一致 (= i 番目のセル = i 番目の配信枠)。
var heatmapStreams = [];
var LISTENER_HEATMAP_STREAM_COUNT = 14;

// streams 配列を共通キャッシュ + streamTitleCache に bulk populate。
function populateHeatmapStreams(streams) {
  if (!Array.isArray(streams)) {
    heatmapStreams = [];
    return;
  }
  heatmapStreams = streams.slice();
  for (var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if (!s || !s.videoId) continue;
    if (!streamTitleCache[s.videoId]) {
      streamTitleCache[s.videoId] = {
        title: s.title || '',
        startedAt: Number(s.startedAt) || 0
      };
    }
  }
}

// listener.channel_id 形式 (yt-{UC...}) に正規化する。
// onComment 由来の userId は yt- prefix 無しの場合があるため。
function normalizeListenerChannelId(id) {
  if (!id) return '';
  return id.indexOf('yt-') === 0 ? id : 'yt-' + id;
}

// Step 3 フェーズ 3.2a: listener-updated runtime event を受けたときの
// debounce 付きタブ自動 refresh タイマー
var listenerAutoRefreshTimer = null;

var streamsState = {
  page: { total: 0, rows: [], limit: 100, offset: 0 },
  sort: 'startedAt',
  scope: 'all',
  density: 'l', // 大 (Card) default、'm' 中 (Rank), 's' 小 (Table)
  editMode: false,
  selectedIds: new Set(),
  pendingDeleteRows: []
};

// コメント検索 (Phase C 新 UI)。query は CommentsQuery 互換のフラット dict。
// stream/listener の絞り込みは Phase C2 で popover が追加されるまで未使用 ([])。
var commentSearchState = {
  query: {
    bodyQ: '',
    streamTitleQ: '',
    nameQ: '',
    commentTypes: [],
    periodFrom: null,
    periodTo: null,
    streamIds: [],
    listenerChannelIds: [],
    systemTags: [],
    userTags: [],
    streamTags: [],
    scope: 'own'
  },
  lastResult: null
};

function listenerMgrEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// CommentRow を innerHTML 用 HTML に変換する。
// raw.commentHtml (Rust 側で html_escape 済み + <a>/<img> のみ含む安全な HTML) があれば
// そのまま採用、無ければ body を escape して返す。
// リスナー詳細・配信詳細・コメント検索の 3 箇所で共有する。
function listenerMgrCommentBodyHtml(c) {
  if (!c) return '';
  var html = c.raw && typeof c.raw.commentHtml === 'string' ? c.raw.commentHtml : '';
  if (html) return html;
  return listenerMgrEscape(c.body || '');
}

function listenerMgrFormatTime(unixMs) {
  if (!unixMs) return '';
  try {
    var d = new Date(Number(unixMs));
    if (isNaN(d.getTime())) return '';
    var diffMs = Date.now() - d.getTime();
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return diffMin + ' 分前';
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + ' 時間前';
    var diffD = Math.floor(diffH / 24);
    if (diffD < 30) return diffD + ' 日前';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  } catch (e) { return ''; }
}

function listenerMgrFormatYen(value) {
  if (!value || value === 0) return '';
  return '¥' + Number(value).toLocaleString();
}

// openListenerManager / closeListenerManager は cl-frame 統合 (= 旧 docs/session-status-archive-pre-2026-05-10.md
// commit 2) で listener-manager-section が解体された際に dead code 化した。 Phase 6
// (subsection-nav framework) で削除。

// 配信 owner の表示用ラベル: 自チャンネル設定に handle があれば「@handle」、
// 無ければ生 channel_id を返す。yt- prefix は剥がして比較する。
function ownerDisplayLabel(channelId) {
  if (!channelId) return '(unknown)';
  var stripped = String(channelId).replace(/^yt-/, '');
  var channels = listenerMgrState.ownerChannels || [];
  for (var i = 0; i < channels.length; i++) {
    if (channels[i].channelId === stripped && channels[i].handle) {
      return '@' + channels[i].handle;
    }
  }
  return channelId;
}

function refreshListenerOwnerStatus() {
  if (!api.listeners) return;
  api.listeners.getOwnerChannels().then(function (resp) {
    var channels = resp && Array.isArray(resp.ownerChannels) ? resp.ownerChannels : [];
    listenerMgrState.ownerChannels = channels;
    updateOwnerWarnBanner();
    refreshOwnerSettingsSection(); // 設定モーダル開いてれば再描画
    autoResolveMissingOwnerHandles();
  }).catch(function () { /* 取得失敗時は警告バナー出す手段がないので silent */ });
}

// リスナー管理ページの「自チャンネル未設定」警告バナー表示制御。
// 設定済み = hide / 未設定 = show。
function updateOwnerWarnBanner() {
  var banner = document.getElementById('listener-mgr-owner-warn');
  if (!banner) return;
  var configured = (listenerMgrState.ownerChannels || []).length > 0;
  banner.style.display = configured ? 'none' : '';
  updateClRecordingStatus();
}

function updateClRecordingStatus() {
  var el = document.getElementById('cl-recording-status');
  if (!el) return;
  var configured = (listenerMgrState.ownerChannels || []).length > 0;
  var klass = 'neutral';
  var msg = '';
  if (!configured) {
    msg = '自チャンネル未設定のため、自チャンネル集計・検索・書き戻しは無効です。コメントとリスナーは表示用に記録します。';
  } else if (!currentStreamVideoId) {
    msg = '配信に接続するとコメントを表示します。自チャンネル配信は集計にも記録し、他チャンネル配信は表示用に記録します。';
  } else if (isOwnStream) {
    el.style.display = 'none';
    return;
  } else {
    klass = 'other';
    msg = '他チャンネル配信に接続中。自チャンネルの履歴・集計には登録されません。';
  }
  el.className = 'cl-recording-status ' + klass;
  el.textContent = msg;
  el.style.display = '';
}

// handle が空の owner_channels に対して resolveChannelInfo で逆引きし、
// 取得できれば DB に保存して表示を更新する。失敗は無視 (best-effort)。
// 1 回呼ぶごとに 1 度だけ走るよう簡易ロックを使う。
var ownerHandleResolveInflight = false;
function autoResolveMissingOwnerHandles() {
  if (ownerHandleResolveInflight) return;
  if (!api.listeners || !api.listeners.resolveChannelInfo) return;
  var missing = (listenerMgrState.ownerChannels || []).filter(function (c) {
    return c && c.channelId && !c.handle;
  });
  if (missing.length === 0) return;
  ownerHandleResolveInflight = true;
  Promise.all(missing.map(function (c) {
    return api.listeners.resolveChannelInfo(c.channelId).then(function (resp) {
      if (resp && resp.ok && resp.handle) return { channelId: c.channelId, handle: resp.handle };
      return null;
    }).catch(function () { return null; });
  })).then(function (results) {
    var resolved = results.filter(function (r) { return r !== null; });
    if (resolved.length === 0) {
      ownerHandleResolveInflight = false;
      return;
    }
    var newChannels = (listenerMgrState.ownerChannels || []).map(function (c) {
      var hit = resolved.find(function (r) { return r.channelId === c.channelId; });
      return hit ? { channelId: c.channelId, handle: hit.handle } : c;
    });
    api.listeners.setOwnerChannels(newChannels).then(function (resp) {
      if (resp && resp.ok) {
        listenerMgrState.ownerChannels = Array.isArray(resp.ownerChannels)
          ? resp.ownerChannels : newChannels;
        renderOwnerChannelChips();
      }
    }).catch(function () { /* best-effort */ })
      .then(function () { ownerHandleResolveInflight = false; });
  });
}

// 設定モーダル内の「自チャンネル」セクションを再描画する。モーダル未表示なら no-op。
// セッション中のチャンネル情報メモリキャッシュ (channelId → {name, thumbnailUrl, handle})
// アプリ再起動でリセット (= 永続化はしない)。設定画面を開く度に未取得分を fetch する。
var ownerChannelInfoCache = Object.create(null);

function refreshOwnerSettingsSection() {
  // ギフト単価セクションも自チャンネル一覧に追従するので同時に再描画する
  // (= 自チャンネル追加/削除で対象行が増減する)。
  refreshGiftPricingSection();
  var cardsEl = document.getElementById('settings-owner-cards');
  if (!cardsEl) return;
  var channels = listenerMgrState.ownerChannels || [];
  cardsEl.innerHTML = '';
  if (channels.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'settings-owner-empty';
    empty.textContent = '⚠ 自チャンネルが未設定のため、コメント記録は無効になっています。';
    cardsEl.appendChild(empty);
    return;
  }
  for (var i = 0; i < channels.length; i++) {
    cardsEl.appendChild(buildOwnerChannelCard(channels[i]));
  }
  // 未キャッシュのチャンネルを背景で fetch して順次更新
  hydrateOwnerChannelCards(channels);
}

/**
 * メンバーシップギフトの推定単価セクションを再描画する。
 * 自チャンネル一覧 (= listenerMgrState.ownerChannels) を行に並べ、各行に単価入力 +
 * 未設定チャンネル向けの既定単価入力を出す。保存値は Rust 側 AppConfig.membership_gift_pricing
 * が正本 (= api.get/setMembershipGiftPricing)。owner 一覧変更で refreshOwnerSettingsSection
 * から呼ばれる。
 */
function refreshGiftPricingSection() {
  var listEl = document.getElementById('settings-gift-pricing-list');
  if (!listEl) return;
  if (!api.getMembershipGiftPricing) return;
  var channels = (listenerMgrState.ownerChannels || []).slice();
  api.getMembershipGiftPricing().then(function (pricing) {
    pricing = pricing || {};
    var defaultPrice = pricing.defaultPriceJpy != null ? pricing.defaultPriceJpy : 490;
    var perChannel = pricing.perChannel || {};
    renderGiftPricing(listEl, channels, defaultPrice, perChannel);
  }).catch(function () {
    renderGiftPricing(listEl, channels, 490, {});
  });
}

/** ギフト単価セクションの中身を組む (= 既定単価 + per-channel 入力 + 保存ボタン) */
function renderGiftPricing(listEl, channels, defaultPrice, perChannel) {
  listEl.innerHTML = '';

  var statusEl = document.createElement('div');
  statusEl.style.cssText = 'display:none;font-size:12px;margin-bottom:8px;';

  // 既定単価 (= per-channel 未設定の自チャンネル枠に使う)
  var defaultField = createGiftPriceField('既定単価 (未設定チャンネル)', defaultPrice, 490);
  listEl.appendChild(defaultField.field);

  var channelInputs = [];
  if (channels.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:12px;color:#64748b;margin:6px 0 10px;';
    empty.textContent = '自チャンネルを追加すると、チャンネルごとに単価を設定できます。';
    listEl.appendChild(empty);
  } else {
    var sub = document.createElement('p');
    sub.className = 'settings-section-desc settings-section-desc-tight';
    sub.textContent = 'チャンネルごとに上書きできます (= 空欄なら既定単価を使用)。';
    listEl.appendChild(sub);

    channels.forEach(function (ch) {
      var info = ownerChannelInfoCache[ch.channelId] || {};
      var label = info.name
        || (info.handle ? '@' + info.handle : (ch.handle ? '@' + ch.handle : ch.channelId));
      var current = perChannel[ch.channelId];
      var field = createGiftPriceField(label, current != null ? current : '', defaultPrice);
      listEl.appendChild(field.field);
      channelInputs.push({ channelId: ch.channelId, input: field.input });
    });
  }

  listEl.appendChild(statusEl);

  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px;';
  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-btn settings-btn-primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', function () {
    statusEl.style.display = 'none';
    var defaultVal = parseInt(defaultField.input.value, 10);
    if (!Number.isFinite(defaultVal) || defaultVal < 0) {
      showGiftPricingStatus(statusEl, '既定単価は 0 以上の整数にしてください。', true);
      return;
    }
    var perChannelOut = {};
    for (var i = 0; i < channelInputs.length; i++) {
      var raw = (channelInputs[i].input.value || '').trim();
      if (raw === '') continue; // 空欄 = 既定単価を使う
      var v = parseInt(raw, 10);
      if (!Number.isFinite(v) || v < 0) {
        showGiftPricingStatus(statusEl, '単価は 0 以上の整数にしてください。', true);
        return;
      }
      perChannelOut[channelInputs[i].channelId] = v;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    rendererLog.info('user: gift-pricing-save, default=' + defaultVal + ', perChannel=' + Object.keys(perChannelOut).length);
    api.setMembershipGiftPricing({ defaultPriceJpy: defaultVal, perChannel: perChannelOut }).then(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      showGiftPricingStatus(statusEl, '保存しました。', false);
    }).catch(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      showGiftPricingStatus(statusEl, '保存に失敗しました。', true);
    });
  });
  actions.appendChild(saveBtn);
  listEl.appendChild(actions);
}

function showGiftPricingStatus(statusEl, message, isError) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#fecaca' : '#bbf7d0';
  statusEl.style.display = '';
}

/** ギフト単価 1 行 (= ラベル + ¥ + 数値入力) を作る */
function createGiftPriceField(labelText, value, placeholder) {
  var field = document.createElement('div');
  field.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';

  var label = document.createElement('div');
  label.style.cssText = 'flex:1;font-size:13px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  label.textContent = labelText;
  label.title = labelText;
  field.appendChild(label);

  var yen = document.createElement('span');
  yen.style.cssText = 'font-size:13px;color:#94a3b8;';
  yen.textContent = '¥';
  field.appendChild(yen);

  var input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.value = value === '' || value == null ? '' : value;
  if (placeholder != null) input.placeholder = String(placeholder);
  input.style.cssText = 'width:110px;background:#081421;border:1px solid #1a3a4a;border-radius:6px;color:#d8e8e8;font-size:14px;padding:7px 10px;';
  field.appendChild(input);

  return { field: field, input: input };
}

/** OwnerChannel 1 件を表すカード DOM を組み立てる (= name/thumbnail はキャッシュから or 未取得状態) */
function buildOwnerChannelCard(ch) {
  var info = ownerChannelInfoCache[ch.channelId] || {};
  var card = document.createElement('div');
  card.className = 'settings-owner-card';
  card.setAttribute('data-channel-id', ch.channelId);

  var avatar = document.createElement('img');
  avatar.className = 'settings-owner-card-avatar';
  avatar.alt = '';
  if (info.thumbnailUrl) {
    avatar.src = info.thumbnailUrl;
  } else {
    avatar.classList.add('loading');
    avatar.src = OWNER_CARD_PLACEHOLDER_AVATAR;
  }
  // 画像取得失敗時は placeholder にフォールバック
  avatar.addEventListener('error', function () {
    avatar.classList.add('loading');
    avatar.src = OWNER_CARD_PLACEHOLDER_AVATAR;
  });

  var infoCol = document.createElement('div');
  infoCol.className = 'settings-owner-card-info';

  var nameEl = document.createElement('div');
  nameEl.className = 'settings-owner-card-name';
  if (info.name) {
    nameEl.textContent = info.name;
  } else {
    nameEl.classList.add('placeholder');
    nameEl.textContent = ch.handle ? '@' + ch.handle : 'チャンネル名取得中…';
  }

  var handleEl = document.createElement('div');
  handleEl.className = 'settings-owner-card-handle';
  var handle = info.handle || ch.handle;
  handleEl.textContent = handle ? '@' + handle : ch.channelId;

  // チャンネル名と handle が両方ある時だけ UC ID も別行で表示 (= 三段構成)。
  // 取得前 (= placeholder) では情報が重複するので handle 行で UC を見せて二段構成。
  infoCol.appendChild(nameEl);
  infoCol.appendChild(handleEl);
  if (info.name && handle) {
    var idEl = document.createElement('div');
    idEl.className = 'settings-owner-card-id';
    idEl.textContent = ch.channelId;
    infoCol.appendChild(idEl);
  }

  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'settings-owner-card-remove';
  removeBtn.title = '削除';
  removeBtn.setAttribute('aria-label', '削除');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', function () {
    var next = listenerMgrState.ownerChannels.filter(function (c) { return c.channelId !== ch.channelId; });
    saveListenerOwners(next);
  });

  card.appendChild(avatar);
  card.appendChild(infoCol);
  card.appendChild(removeBtn);
  return card;
}

// 1x1 transparent PNG (= 取得失敗時にも壊れた img アイコンが出ないよう placeholder)
var OWNER_CARD_PLACEHOLDER_AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 未キャッシュの owner channel について resolveChannelInfo で順次取得して DOM 更新 */
function hydrateOwnerChannelCards(channels) {
  if (!api.listeners || !api.listeners.resolveChannelInfo) return;
  channels.forEach(function (ch) {
    if (ownerChannelInfoCache[ch.channelId]) return;
    // handle 優先 (= UC より人間可読、resolveChannelInfo の URL も短くて済む)
    var query = ch.handle ? '@' + ch.handle : ch.channelId;
    api.listeners.resolveChannelInfo(query).then(function (resp) {
      if (!resp || !resp.ok || !resp.channelId) return;
      ownerChannelInfoCache[resp.channelId] = {
        name: resp.name || null,
        thumbnailUrl: resp.thumbnailUrl || null,
        handle: resp.handle || null
      };
      // 該当 card を in-place で再生成 (= replaceWith で event listener も更新される)
      var existing = document.querySelector(
        '#settings-owner-cards [data-channel-id="' + cssEscapeId(resp.channelId) + '"]'
      );
      if (existing && existing.parentNode) {
        existing.parentNode.replaceChild(buildOwnerChannelCard({
          channelId: resp.channelId,
          handle: resp.handle || ch.handle || null
        }), existing);
      }
    }).catch(function () { /* 失敗時はそのまま (placeholder のまま) */ });
  });
}

/** CSS attribute selector に使うため id 内の特殊文字を escape */
function cssEscapeId(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^A-Za-z0-9_-]/g, '\\$&');
}

/**
 * 「YouTube ログイン中のチャンネルを追加」ボタンの enable/disable + 文言切替。
 * 常時表示で「機能の存在を周知」し、未ログイン時は disabled + ガイド文言にする。
 * 設定 open 時 + ログイン/ログアウト操作後に呼ばれて状態を再同期する。
 */
function refreshSelfChannelButton() {
  var btn = document.getElementById('settings-owner-add-self');
  if (!btn) return;
  var textEl = btn.querySelector('.settings-owner-add-self-text');
  if (window.api && window.api.checkLogin) {
    window.api.checkLogin().then(function (loggedIn) {
      btn.disabled = !loggedIn;
      btn.title = loggedIn ? '' : 'YouTube ログインが必要です (上の「YouTube 接続」セクションからログイン)';
      if (textEl) {
        textEl.textContent = loggedIn
          ? 'YouTube ログイン中のチャンネルを追加'
          : 'YouTube ログイン中のチャンネルを追加 (要ログイン)';
      }
    });
  }
  if (btn._inited) return;
  btn._inited = true;
  btn.addEventListener('click', function () {
    // disabled は click 抑止が効くので追加 guard 不要、loading 中だけ guard する
    if (btn.classList.contains('loading')) return;
    if (!api.listeners || !api.listeners.getCurrentChannel) {
      setOwnerSettingsStatus('この機能は利用できません', true);
      return;
    }
    btn.classList.add('loading');
    var origText = btn.querySelector('.settings-owner-add-self-text').textContent;
    btn.querySelector('.settings-owner-add-self-text').textContent = '取得中';
    api.listeners.getCurrentChannel().then(function (resp) {
      btn.classList.remove('loading');
      btn.querySelector('.settings-owner-add-self-text').textContent = origText;
      if (!resp || !resp.ok || !resp.channelId) {
        setOwnerSettingsStatus(
          'ログイン中チャンネルの取得に失敗 (' + ((resp && resp.reason) || 'unknown') + ')',
          true
        );
        return;
      }
      // 重複チェック
      var dup = listenerMgrState.ownerChannels.some(function (c) { return c.channelId === resp.channelId; });
      if (dup) {
        setOwnerSettingsStatus(
          '既に登録済み: ' + (resp.name || resp.handle || resp.channelId),
          true
        );
        return;
      }
      // キャッシュに名前 / アバターを保存してから追加 → 即座にカードに反映される
      ownerChannelInfoCache[resp.channelId] = {
        name: resp.name || null,
        thumbnailUrl: resp.thumbnailUrl || null,
        handle: resp.handle || null
      };
      var label = resp.name || (resp.handle ? '@' + resp.handle : resp.channelId);
      setOwnerSettingsStatus('追加: ' + label, false);
      var next = listenerMgrState.ownerChannels.concat([{
        channelId: resp.channelId,
        handle: resp.handle || null
      }]);
      saveListenerOwners(next);
    }).catch(function (err) {
      btn.classList.remove('loading');
      btn.querySelector('.settings-owner-add-self-text').textContent = origText;
      setOwnerSettingsStatus('取得エラー: ' + (err && err.message ? err.message : err), true);
    });
  });
}

function setOwnerSettingsStatus(text, isError) {
  var st = document.getElementById('settings-owner-status');
  if (!st) return;
  st.textContent = text;
  st.style.color = isError ? '#ffabab' : '#80cbc4';
}

// 設定モーダルの入力欄から @handle / UC... を resolveChannelInfo で解決して追加 → 保存。
function addOwnerFromSettingsInput() {
  var input = document.getElementById('settings-owner-input');
  if (!input || !api.listeners) return;
  var raw = input.value.trim();
  if (!raw) return;

  var addChannel = function (info) {
    var dup = listenerMgrState.ownerChannels.some(function (c) {
      return c.channelId === info.channelId;
    });
    if (dup) {
      setOwnerSettingsStatus('既に登録済み: ' + info.channelId, true);
      return;
    }
    var next = listenerMgrState.ownerChannels.concat([{
      channelId: info.channelId,
      handle: info.handle || null,
    }]);
    saveListenerOwners(next);
    input.value = '';
  };

  var looksLikeUC = /^UC[A-Za-z0-9_-]+$/.test(raw);
  var handleCand = raw.charAt(0) === '@' ? raw.substring(1) : raw;
  if (!looksLikeUC && !/^[A-Za-z0-9._-]+$/.test(handleCand)) {
    setOwnerSettingsStatus('@handle または UC ID を入力してください', true);
    return;
  }
  setOwnerSettingsStatus(raw + ' を解決中...', false);
  api.listeners.resolveChannelInfo(raw).then(function (resp) {
    if (resp && resp.ok && resp.channelId) {
      // 解決時に取得した name / thumbnailUrl をキャッシュに入れて、追加直後の card 表示を即座に成立させる
      ownerChannelInfoCache[resp.channelId] = {
        name: resp.name || null,
        thumbnailUrl: resp.thumbnailUrl || null,
        handle: resp.handle || null
      };
      var label = resp.name
        || (resp.handle ? '@' + resp.handle + ' (' + resp.channelId + ')' : resp.channelId);
      setOwnerSettingsStatus('解決成功: ' + label, false);
      addChannel(resp);
    } else {
      setOwnerSettingsStatus('解決失敗: ' + ((resp && resp.error) || 'unknown'), true);
    }
  }).catch(function (err) {
    setOwnerSettingsStatus('解決エラー: ' + (err && err.message ? err.message : err), true);
  });
}

function saveListenerOwners(channels) {
  if (!api.listeners) return;
  api.listeners.setOwnerChannels(channels).then(function (resp) {
    if (resp && resp.ok) {
      listenerMgrState.ownerChannels = Array.isArray(resp.ownerChannels)
        ? resp.ownerChannels : channels;
      refreshOwnerSettingsSection();
      updateOwnerWarnBanner();
      setOwnerSettingsStatus('保存しました', false);
    } else {
      setOwnerSettingsStatus('保存失敗: ' + ((resp && resp.error) || 'unknown'), true);
    }
  }).catch(function (err) {
    setOwnerSettingsStatus('保存エラー: ' + (err && err.message ? err.message : err), true);
  });
}

function refreshListenerList() {
  if (!api.listeners) return;
  var sortEl = document.getElementById('listener-mgr-sort');
  var searchEl = document.getElementById('listener-mgr-search');
  var sort = sortEl ? sortEl.value : 'streamFirstAt';
  var q = searchEl ? searchEl.value.trim() : '';
  listenerMgrState.sort = sort;
  listenerMgrState.q = q;
  var offset = listenerMgrState.page.offset || 0;
  // 接続中の枠が無ければ一覧そのものを空表示にする (= 仕様: 接続中の枠のリスナーしか
  // 表示しない)。検索 / ソート等の UI は残しても OK だが、コンテンツは空。
  if (!currentStreamVideoId) {
    var listEl = document.getElementById('listener-mgr-list');
    if (listEl) {
      listEl.innerHTML = '<div style="padding:24px 12px;color:#5a6a78;font-size:11px;text-align:center">'
        + '配信に接続すると、この枠のリスナーが表示されます。'
        + '</div>';
    }
    listenerMgrState.page = { total: 0, rows: [], limit: 100, offset: 0 };
    refreshListenerMiniTabCounts(); // 0 リセット表示
    return;
  }
  var query = {
    sort: sort,
    q: q || null,
    limit: 100,
    offset: offset,
    streamVideoId: currentStreamVideoId
  };
  // ミニタブによる追加フィルター。排他選択。
  // 新規 = この枠で初コメ (first_seen_at >= 現枠 started_at)。
  //   累計 1 件以下の system_tags['first-time'] とは別概念 (= 連投新規も含む)。
  var tab = listenerMgrState.miniTab || 'all';
  if (isListenerMiniTabDisabledForOtherStream(tab)) {
    tab = 'all';
    listenerMgrState.miniTab = 'all';
  }
  if (tab === 'unGreeted') query.unGreetedOnly = true;
  else if (tab === 'firstTime') query.firstInStreamOnly = true;
  else if (tab === 'returning') query.systemTags = ['returning'];
  else if (tab === 'comeback') query.comebackOnly = true;
  else if (tab === 'newMember') query.newMemberOnly = true;
  // 'all' は追加 filter なし
  api.listeners.list(query).then(function (resp) {
    if (!resp || !resp.ok) {
      var listEl = document.getElementById('listener-mgr-list');
      if (listEl) listEl.innerHTML = '<div style="padding:12px;color:#ffb74d">リスナー一覧の取得に失敗しました: ' + listenerMgrEscape(resp && resp.error ? resp.error : 'unknown') + '</div>';
      return;
    }
    listenerMgrState.page = resp.page;
    renderListenerList(resp.page);
    // 件数バッジは「タブ切替で変わらない」(= 母集団 = 接続枠 + 検索 q が同じなら同じ値)
    // なので、ここでは更新しない。件数は別経路 (= 検索 q 変更 / 接続切替 / 更新ボタン /
    // 起動時) で refreshListenerMiniTabCounts を呼ぶ。
  }).catch(function (err) {
    rendererLog.error('listListeners failed', err);
  });
}

function isListenerMiniTabDisabledForOtherStream(name) {
  return !isOwnStream && (name === 'unGreeted' || name === 'firstTime' ||
    name === 'returning' || name === 'comeback');
}

// ミニタブ DOM (active class + 件数バッジ) を listenerMgrState に同期する。
// has-attention class は「未対応」タブ で count > 0 の時に付与し、 CSS 側で
// count badge を強調する (= 配信者が次にやるべき仕事を pulse で示す)。
// 2026-05-14: 旧 4 タブ (新規/再訪/復帰/新メンバー) 合算 → 未対応 1 本に変更
// (= +N ピンの仕様と揃え、 「対応すべき残数」を一目で示す)。
function refreshListenerMiniTabs() {
  var current = listenerMgrState.miniTab || 'all';
  var counts = listenerMgrState.miniTabCounts || {};
  var tabs = document.querySelectorAll('#listener-mgr-mini-tabs .lm-mtab');
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    var name = tab.getAttribute('data-mtab');
    var disabled = isListenerMiniTabDisabledForOtherStream(name);
    tab.disabled = disabled;
    tab.classList.toggle('disabled', disabled);
    if (disabled && name === current) {
      listenerMgrState.miniTab = 'all';
      current = 'all';
    }
    if (name === current) tab.classList.add('active');
    else tab.classList.remove('active');
    var n = counts[name];
    var hasN = !disabled && typeof n === 'number' && n > 0;
    var ct = tab.querySelector('.ct');
    if (ct) ct.textContent = hasN ? String(n) : '';
    var isAttentionTab = (name === 'unGreeted');
    if (isAttentionTab && hasN) tab.classList.add('has-attention');
    else tab.classList.remove('has-attention');
  }
  updateListenerAttentionPin();
}

// cl-tab「リスナー」に出す +N ピル。当該枠の「未対応 listener 数」を表示する。
// = stream_listener_state.greeted_at == 0 のリスナー (= 対応チェックを付けてない人)。
// 旧仕様 (新規 + 再訪 + 復帰 + 新メンバー 合計) は 2026-05-14 に未対応のみに変更
// (= 「対応すべきが残ってる人数」が一目で分かる)。 0 件なら hide。
function updateListenerAttentionPin() {
  var pin = document.getElementById('cl-tab-listener-attention');
  if (!pin) return;
  var c = listenerMgrState.miniTabCounts || {};
  var total = c.unGreeted || 0;
  if (total > 0) {
    pin.textContent = '+' + total;
    pin.style.display = '';
  } else {
    pin.style.display = 'none';
  }
}

// ミニタブをクリックして切り替え。
function selectListenerMiniTab(name) {
  if (!name) return;
  if (isListenerMiniTabDisabledForOtherStream(name)) {
    name = 'all';
  }
  if (listenerMgrState.miniTab === name) return;
  listenerMgrState.miniTab = name;
  // ページ位置を先頭に戻す (= タブ切替で総件数 / page 構成が変わる)
  if (listenerMgrState.page) listenerMgrState.page.offset = 0;
  refreshListenerMiniTabs();
  refreshListenerList();
}

// 接続枠の 6 タブ件数バッジを fetch して反映する。
// 接続中の枠が無ければ全 0 で reset するだけ。
function refreshListenerMiniTabCounts() {
  if (!currentStreamVideoId) {
    listenerMgrState.miniTabCounts = { all: 0, unGreeted: 0, firstTime: 0, returning: 0, comeback: 0, newMember: 0 };
    refreshListenerMiniTabs();
    return;
  }
  if (!api.listeners || typeof api.listeners.streamScopedListenerCounts !== 'function') return;
  var qStr = (listenerMgrState.q || '').trim() || null;
  api.listeners.streamScopedListenerCounts(currentStreamVideoId, qStr).then(function (resp) {
    if (!resp || !resp.ok || !resp.counts) return;
    listenerMgrState.miniTabCounts = resp.counts;
    refreshListenerMiniTabs();
  }).catch(function (err) {
    rendererLog.warn('streamScopedListenerCounts failed', err);
  });
}

// 接続切替時の「ミニタブをデフォルト (= 全て) に戻す」処理。
// 接続枠が変わると母集団自体が変わるので、今選んでいるサブフィルター状態は破棄して
// 「全て」表示に戻す。手動で別タブを選んだ状態は次の接続切替で消える (仕様)。
function resetListenerStreamFilterDefault() {
  listenerMgrState.miniTab = 'all';
  listenerMgrState.miniTabCounts = { all: 0, unGreeted: 0, firstTime: 0, returning: 0, comeback: 0, newMember: 0 };
  refreshListenerMiniTabs();
}

// メモを 20 字 + ellipsis に短縮 (改行は空白に置換し 1 行表示にする)
function listenerListTruncateMemo(memo, max) {
  if (!memo) return '';
  var single = String(memo).replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return single.substring(0, max) + '…';
}

// heatmap セル 1 個分の class 名を count から decide する (3 段階)。
// しきい値: 0 → empty / 1-3 → l1 / 4-9 → l2 / 10+ → l3
function listenerHeatmapCellClass(count) {
  if (count >= 10) return 'cell l3';
  if (count >= 4) return 'cell l2';
  if (count >= 1) return 'cell l1';
  return 'cell';
}

// セル hover で出す native title 文字列を組み立てる。
// セル = 1 配信枠。tooltip は配信タイトル + 開始日時 + 参加コメ数 (or 未参加)。
// 例 (参加):
//   ゲーム配信 #42
//   5/4 (火) 21:00
//   12 コメ · ¥1,000
// 例 (未参加):
//   雑談 #17
//   5/3 (月) 22:30
//   未参加
function buildHeatmapCellTitle(cell, streamIdx) {
  var stream = heatmapStreams[streamIdx];
  if (!stream) {
    // streams キャッシュ未着の placeholder (modal が先に開いた等)
    return '読み込み中…';
  }
  var lines = [];
  lines.push(stream.title || stream.videoId || '(配信)');

  if (stream.startedAt) {
    var d = new Date(Number(stream.startedAt) || 0);
    var dateStr = (d.getMonth() + 1) + '/' + d.getDate();
    var dow = '日月火水木金土'.charAt(d.getDay());
    var hh = d.getHours();
    var mm = d.getMinutes();
    var time = hh + ':' + (mm < 10 ? '0' + mm : mm);
    lines.push(dateStr + ' (' + dow + ') ' + time);
  }

  var count = (cell && cell.count) || 0;
  if (count > 0) {
    var stat = count + ' コメ';
    if (cell.scAmountJpy && cell.scAmountJpy > 0) {
      var yen = listenerMgrFormatYen(cell.scAmountJpy);
      if (yen) stat += ' · ' + yen;
    }
    lines.push(stat);
  } else {
    lines.push('未参加');
  }

  return lines.join('\n');
}

// list 用 heatmap (正方セル × N 枠) の inner HTML を生成する。
// cells は activity.cells (StreamActivityCell の配列、streams[] と index 一致)。
function buildListenerHeatmapInnerHtml(cells) {
  var n = LISTENER_HEATMAP_STREAM_COUNT;
  var html = '';
  for (var i = 0; i < n; i++) {
    var cell = cells && cells[i];
    var cls = cell ? listenerHeatmapCellClass(cell.count || 0) : 'cell';
    var titleStr = buildHeatmapCellTitle(cell || { count: 0 }, i);
    html += '<div class="' + cls + '" title="' + listenerMgrEscape(titleStr) + '"></div>';
  }
  return html;
}

// listener row 1 件を新レイアウトの HTML に変換する。densityClass は 'd-l' / 'd-m' / 'd-s'。
// HTML 構造は data-channel-id 属性 + 行クリックで詳細を開く構成のみ。
function buildListenerItemHtml(r, densityClass) {
  var density = densityClass === 'd-l' ? 'l' : densityClass === 'd-s' ? 's' : 'm';

  // === avatar (icon_url があれば img、無ければ initial 文字) ===
  var avClasses = 'lst-av';
  if (r.isMember) avClasses += ' is-member';
  else if (r.isModerator) avClasses += ' is-mod';
  var initial = (r.displayName || r.nickname || '?').charAt(0);
  var avatarHtml;
  if (r.iconUrl) {
    avatarHtml = '<div class="' + avClasses + '" style="background-image:url(\'' +
      listenerMgrEscape(r.iconUrl) + '\');"></div>';
  } else {
    avatarHtml = '<div class="' + avClasses + '">' + listenerMgrEscape(initial) + '</div>';
  }

  // === 表示名 / nickname / username ===
  // nickname があれば primary、display_name は secondary 扱い (nickname と異なれば併記)
  var primaryName = r.nickname ? r.nickname : (r.displayName || '');
  var secondaryName = '';
  if (r.nickname && r.displayName && r.nickname !== r.displayName) {
    secondaryName = r.displayName;
  } else if (!r.nickname && r.username) {
    secondaryName = r.username;
  }
  var nameHtml = '<span class="primary">' + listenerMgrEscape(primaryName || '(no name)') + '</span>';
  if (secondaryName) {
    nameHtml += '<span class="secondary">' + listenerMgrEscape(secondaryName) + '</span>';
  }

  // === badges ===
  var badges = '';
  // システムランクバッジ (= 新規 / 新参 / 常連 / 古参 / 復帰 / 離脱)。
  // Rust 側 list_listeners が stream_video_id or baseline_stream_video_id 指定時に
  // classify_listener_rank を経由して計算済み (= r.systemTag)。 2026-05-14 追加。
  // 配信詳細モーダルリスナータブ (= sd-listener-row-mgr) と同じ class / 色を流用。
  // regular (常連) はデフォルト色 (amber) なので modifier クラスを付けない。
  if (r.systemTag) {
    var sysClass = (r.systemTag === 'first-time') ? 'first'
      : (r.systemTag === 'returning') ? 'returning'
      : (r.systemTag === 'veteran') ? 'veteran'
      : (r.systemTag === 'comeback') ? 'comeback'
      : (r.systemTag === 'abandoned') ? 'abandoned' : '';
    var sysLabel = systemTagLabel(r.systemTag);
    if (sysLabel) {
      badges += '<span class="lst-bg tag-system' + (sysClass ? ' ' + sysClass : '') + '">' +
        listenerMgrEscape(sysLabel) + '</span>';
    }
  }
  if (r.isMember) {
    badges += '<span class="lst-bg is-member">👑 ' + (r.memberMonthsMax || 0) + 'mo</span>';
  }
  if (r.isModerator) badges += '<span class="lst-bg is-mod">モデ</span>';
  if (r.label) badges += '<span class="lst-bg is-label">' + listenerMgrEscape(r.label) + '</span>';

  // === 現枠 SC tint 判定 + 表示額 ===
  // perStreamScAmountJpy は Rust list_listeners が当該枠 (= streamVideoId) のコメから
  // 集計した正本値。ハブ再起動後の過去 SC も含む (= live cache の取りこぼし問題なし)。
  var currentSc = r.perStreamScAmountJpy || 0;
  var hasCurrentSc = currentSc > 0;
  var totalSc = r.superchatAmountJpy || 0;

  // === stat-end (count + 枠 SC + 累計 SC) ===
  // 接続中で枠 SC ありの場合: 枠 SC primary (amber) + 累計 secondary (dim "累計" prefix)
  // 接続中で枠 SC なし、累計あり: 累計のみ (dim, "累計" prefix)
  // 未接続: 累計を通常表示 (sc-cur と同じ amber)。"累計" prefix なし
  var scHtml = '';
  if (hasCurrentSc) {
    scHtml += '<div class="sc-cur">' + listenerMgrEscape(listenerMgrFormatYen(currentSc) || '¥0') + '</div>';
    if (totalSc > 0 && totalSc !== currentSc) {
      scHtml += '<div class="sc-tot">累計 ' + listenerMgrEscape(listenerMgrFormatYen(totalSc) || '') + '</div>';
    } else if (totalSc > 0 && totalSc === currentSc) {
      // 初 SC で枠 = 累計 のとき: 累計併記は冗長なので省略
    }
  } else if (totalSc > 0) {
    if (isConnected) {
      scHtml += '<div class="sc-tot">累計 ' + listenerMgrEscape(listenerMgrFormatYen(totalSc) || '') + '</div>';
    } else {
      // 未接続: 累計を通常表示として amber で出す
      scHtml += '<div class="sc-cur">' + listenerMgrEscape(listenerMgrFormatYen(totalSc) || '') + '</div>';
    }
  }

  var displayedCommentCount = currentStreamVideoId
    ? (r.perStreamCommentCount || 0)
    : (r.commentCount || 0);
  var statInner = '<div class="count">' + displayedCommentCount + '</div>' + scHtml;

  // === when (相対時刻) ===
  var lastSeenForList = currentStreamVideoId && r.perStreamLastAt
    ? r.perStreamLastAt
    : r.lastSeenAt;
  var whenStr = formatListenerLastSeenShort(lastSeenForList) || '—';

  // === last comment body / notes ===
  // last_comment_html: Rust 側で html_escape 済み + <img>/<a> のみ含む安全 HTML
  var bodyInner = r.lastCommentHtml
    ? r.lastCommentHtml
    : (r.lastCommentBody ? listenerMgrEscape(r.lastCommentBody) : '');
  var bodyTitleAttr = r.lastCommentBody
    ? ' title="' + listenerMgrEscape(r.lastCommentBody) + '"'
    : '';
  var lastCmtHtml = bodyInner
    ? '<span class="last-cmt"' + bodyTitleAttr + '>' + bodyInner + '</span>'
    : '<span class="last-cmt"></span>';

  var notesPreview = listenerListTruncateMemo(r.notes, 20);
  var notesEsc = listenerMgrEscape(notesPreview);
  var notesTitleAttr = notesPreview ? ' title="' + listenerMgrEscape(r.notes || '') + '"' : '';

  // === density 別の中身組み立て ===
  // 対応済みボタンは shared/comment-item.js のコメ側 .kh-toggle-responded と同じ
  // 見た目 / 位置 (= セル右端、 28x28、 cyan ハイライト) で統一する (2026-05-14)。
  var canToggleResponded = !!(currentStreamVideoId && isOwnStream);
  var isResponded = (r.greetedAt || 0) > 0;
  var itemClass = 'listener-item ' + densityClass + (hasCurrentSc ? ' current-sc' : '') +
    (canToggleResponded ? ' has-response-check' : '') +
    (isResponded ? ' listener-responded' : '');
  var dataAttr = ' data-channel-id="' + listenerMgrEscape(r.channelId) + '"';
  var respondedBtnHtml = canToggleResponded
    ? '<button type="button" class="kh-toggle-responded" data-channel-id="' +
      listenerMgrEscape(r.channelId) + '" data-responded="' + (isResponded ? '1' : '0') +
      '" title="対応済みにする / 戻す">✓</button>'
    : '';

  // heatmap: キャッシュにあれば即時 hydrate、無ければ placeholder セル (全 default 背景)
  var cachedActivity = listenerActivityCacheByChannelId[r.channelId];
  var heatHtml = isOwnStream
    ? '<div class="lst-heatmap" data-channel-id="' +
      listenerMgrEscape(r.channelId) + '">' +
      buildListenerHeatmapInnerHtml(cachedActivity) + '</div>'
    : '';

  var inner;
  if (density === 's') {
    // 単一行: avatar | name+badges | heatmap | when | stat | toggle
    inner =
      avatarHtml +
      '<div class="lst-name-row">' + nameHtml + badges + '</div>' +
      heatHtml +
      '<div class="when">' + listenerMgrEscape(whenStr) + '</div>' +
      '<div class="lst-stat">' + statInner + '</div>' +
      respondedBtnHtml;
  } else if (density === 'm') {
    // 中: name 行末尾に notes inline
    var inlineNotes = notesPreview
      ? '<span class="notes-inline"' + notesTitleAttr + '>' + notesEsc + '</span>'
      : '';
    inner =
      avatarHtml +
      '<div class="lst-main">' +
        '<div class="lst-name-row">' + nameHtml + badges + inlineNotes + '</div>' +
        '<div class="lst-meta-row">' +
          '<span class="when">' + listenerMgrEscape(whenStr) + '</span>' +
          lastCmtHtml +
        '</div>' +
      '</div>' +
      heatHtml +
      '<div class="lst-stat">' + statInner + '</div>' +
      respondedBtnHtml;
  } else {
    // 大: name / meta / standalone notes の 3 行
    var standaloneNotes = notesPreview
      ? '<div class="lst-notes"' + notesTitleAttr + '>' + notesEsc + '</div>'
      : '';
    inner =
      avatarHtml +
      '<div class="lst-main">' +
        '<div class="lst-name-row">' + nameHtml + badges + '</div>' +
        '<div class="lst-meta-row">' +
          '<span class="when">' + listenerMgrEscape(whenStr) + '</span>' +
          lastCmtHtml +
        '</div>' +
        standaloneNotes +
      '</div>' +
      heatHtml +
      '<div class="lst-stat">' + statInner + '</div>' +
      respondedBtnHtml;
  }

  return '<div class="' + itemClass + '"' + dataAttr + '>' + inner + '</div>';
}

// listener 一覧描画後、heatmap データ (activity + streams_in_window) を 1 RPC で取得し、
// 各 .lst-heatmap 要素を in-place で innerHTML 更新する。
// streams_in_window がレスポンスに同梱されるため、配信タイトルの追加 fetch は不要。
function hydrateListenerHeatmaps(listEl, rows) {
  if (!listEl || !api.listeners || !api.listeners.activity) return;
  if (!Array.isArray(rows) || rows.length === 0) return;

  var idsNeedingFetch = [];
  for (var i = 0; i < rows.length; i++) {
    var cid = rows[i].channelId;
    if (cid && !listenerActivityCacheByChannelId[cid]) {
      idsNeedingFetch.push(cid);
    }
  }

  // 全 listener 分キャッシュ済み (= 密度切替後の re-render など) かつ
  // heatmapStreams も既に揃っている → 再 fetch せず title だけ refresh
  if (idsNeedingFetch.length === 0 && heatmapStreams.length > 0) {
    rebuildHeatmapCellTitles(listEl, rows);
    return;
  }

  // streams 配列はリスナー横断で共有なので、毎 fetch で最新化したい
  // (新しい配信が始まったタイミングで反映される)。channelIds が空でも RPC は走らせる。
  api.listeners.activity({
    channelIds: idsNeedingFetch,
    streamCount: LISTENER_HEATMAP_STREAM_COUNT
  }).then(function (resp) {
    if (!resp || !resp.ok) return;

    // 1. streams を共有キャッシュへ (副次効果で streamTitleCache も bulk 充填)
    if (Array.isArray(resp.streams)) {
      populateHeatmapStreams(resp.streams);
    }

    // 2. 各 listener の activity をキャッシュ + 該当 heatmap を in-place 更新
    if (Array.isArray(resp.activities)) {
      for (var j = 0; j < resp.activities.length; j++) {
        var a = resp.activities[j];
        if (!a || !a.channelId || !Array.isArray(a.cells)) continue;
        listenerActivityCacheByChannelId[a.channelId] = a.cells;
        var safe = a.channelId.replace(/"/g, '\\"');
        var nodes = listEl.querySelectorAll('.lst-heatmap[data-channel-id="' + safe + '"]');
        for (var k = 0; k < nodes.length; k++) {
          nodes[k].innerHTML = buildListenerHeatmapInnerHtml(a.cells);
        }
      }
    }

    // 3. 既にキャッシュ済の listener (今回 fetch していない側) も streams が更新された
    //    可能性があるので tooltip を refresh
    rebuildHeatmapCellTitles(listEl, rows);
  }).catch(function () { /* heatmap は best-effort, 失敗時はそのまま空セル */ });
}

// === リスナー詳細モーダル用: 棒グラフ型 heatmap ===
// 一覧の正方 heatmap と違い、棒の高さ (log scale) で count を視覚化する。
// modal 横幅いっぱいに flex で広げ、各バーは透明な .bar-slot で全カラム高の hit area
// を確保 (= 0 コメ枠でも tooltip が hover で出る)。
var LISTENER_DETAIL_HEATMAP_MAX_HEIGHT_PX = 56;
var LISTENER_DETAIL_HEATMAP_LOG_SATURATE = 50;

function computeHeatmapBarHeight(count, maxHeight) {
  if (count <= 0) return 3;
  var logMax = Math.log10(LISTENER_DETAIL_HEATMAP_LOG_SATURATE);
  var ratio = Math.min(1, Math.log10(count + 1) / logMax);
  return Math.max(8, Math.round(maxHeight * ratio));
}

function buildListenerDetailHeatmapInnerHtml(cells) {
  var maxH = LISTENER_DETAIL_HEATMAP_MAX_HEIGHT_PX;
  var n = LISTENER_HEATMAP_STREAM_COUNT;
  var html = '';
  for (var i = 0; i < n; i++) {
    var cell = cells && cells[i];
    var count = (cell && cell.count) || 0;
    var hasSc = !!(cell && cell.scAmountJpy && cell.scAmountJpy > 0);
    var titleStr = buildHeatmapCellTitle(cell || { count: 0 }, i);
    var titleAttr = ' title="' + listenerMgrEscape(titleStr) + '"';
    var fillCls;
    var fillStyle;
    if (count === 0) {
      fillCls = 'bar-fill zero';
      fillStyle = '';
    } else {
      var h = computeHeatmapBarHeight(count, maxH);
      fillCls = hasSc ? 'bar-fill sc' : 'bar-fill';
      fillStyle = ' style="height:' + h + 'px"';
    }
    // .bar-slot が hover hit-area (フルカラム高), .bar-fill が見える棒。
    html += '<div class="bar-slot"' + titleAttr + '>' +
      '<div class="' + fillCls + '"' + fillStyle + '></div>' +
      '</div>';
  }
  return html;
}

// 詳細モーダル開いた直後に呼び、Tab B の #ld-detail-heatmap を populate する。
// activity がキャッシュ済なら即時描画 + streams が無ければ追加 fetch のみ。
function hydrateListenerDetailHeatmap(channelId) {
  var heatEl = document.getElementById('ld-detail-heatmap');
  if (!heatEl || !channelId || !api.listeners || !api.listeners.activity) return;

  var cached = listenerActivityCacheByChannelId[channelId];
  var needsStreams = heatmapStreams.length === 0;

  // 即時描画 (キャッシュ済 or 空 placeholder)
  heatEl.innerHTML = buildListenerDetailHeatmapInnerHtml(cached || null);

  if (cached && !needsStreams) return;

  api.listeners.activity({
    channelIds: cached ? [] : [channelId],
    streamCount: LISTENER_HEATMAP_STREAM_COUNT
  }).then(function (resp) {
    if (!resp || !resp.ok) return;
    if (Array.isArray(resp.streams)) {
      populateHeatmapStreams(resp.streams);
    }
    var cells = cached;
    if (!cached && Array.isArray(resp.activities) && resp.activities.length > 0) {
      var a = resp.activities[0];
      if (a && Array.isArray(a.cells)) {
        listenerActivityCacheByChannelId[channelId] = a.cells;
        cells = a.cells;
      }
    }
    if (heatEl.isConnected) {
      heatEl.innerHTML = buildListenerDetailHeatmapInnerHtml(cells || null);
    }
  }).catch(function () { /* heatmap は best-effort */ });
}

// 既に DOM に居る各 .lst-heatmap > .cell に対し、title 属性だけを更新する。
// セルの class (l1/l2/l3) は activity に依存し変わらないので innerHTML 再生成は不要。
// 全 N セル分回す (count=0 セルも配信情報を表示するため)。
function rebuildHeatmapCellTitles(listEl, rows) {
  for (var i = 0; i < rows.length; i++) {
    var cid = rows[i].channelId;
    var act = listenerActivityCacheByChannelId[cid];
    if (!Array.isArray(act)) continue;
    var safe = cid.replace(/"/g, '\\"');
    var heatmap = listEl.querySelector('.lst-heatmap[data-channel-id="' + safe + '"]');
    if (!heatmap) continue;
    var cellNodes = heatmap.children;
    for (var idx = 0; idx < LISTENER_HEATMAP_STREAM_COUNT && idx < cellNodes.length; idx++) {
      var cell = act[idx] || { count: 0 };
      cellNodes[idx].setAttribute('title', buildHeatmapCellTitle(cell, idx));
    }
  }
}

function renderListenerList(page) {
  var listEl = document.getElementById('listener-mgr-list');
  var countEl = document.getElementById('listener-mgr-count');
  var pagEl = document.getElementById('listener-mgr-pagination');
  var prevBtn = document.getElementById('listener-mgr-prev');
  var nextBtn = document.getElementById('listener-mgr-next');
  var labelEl = document.getElementById('listener-mgr-page-label');
  if (!listEl) return;

  if (countEl) countEl.textContent = '全 ' + (page.total || 0) + ' 件';

  if (!page.rows || page.rows.length === 0) {
    var hasFilter = !!((listenerMgrState.q || '').trim()) ||
      (listenerMgrState.miniTab && listenerMgrState.miniTab !== 'all');
    var emptyMsg = 'この枠のリスナーはまだいません。<br>コメントが記録されると、ここに表示されます。';
    if (isConnected && currentStreamVideoId && !isOwnStream) {
      emptyMsg = 'この配信でコメントしたリスナーはまだいません。<br>'
        + 'コメントが届くと、表示用のリスナーとしてここに表示されます。';
    } else if (hasFilter) {
      emptyMsg = '条件に一致するリスナーはいません。<br>検索語やフィルターを変更してください。';
    }
    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:#4a6a7a">'
      + emptyMsg
      + '</div>';
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  var density = listenerMgrState.density || 'm';
  var densityClass = 'd-' + density;
  var html = '';
  for (var i = 0; i < page.rows.length; i++) {
    html += buildListenerItemHtml(page.rows[i], densityClass);
  }
  listEl.innerHTML = html;
  // heatmap data を非同期 hydrate (cache 済みなら no-op)
  if (isOwnStream) hydrateListenerHeatmaps(listEl, page.rows);
  // 行クリックで詳細を開く
  var items = listEl.querySelectorAll('.listener-item');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', function () {
      openListenerDetail(this.getAttribute('data-channel-id'));
    });
  }
  var respondedBtns = listEl.querySelectorAll('.kh-toggle-responded');
  for (var rc = 0; rc < respondedBtns.length; rc++) {
    respondedBtns[rc].addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleListenerRespondedBtn(this, currentStreamVideoId, this.getAttribute('data-channel-id'));
    });
  }

  // ページング
  var totalPages = Math.max(1, Math.ceil(page.total / page.limit));
  var currentPage = Math.floor(page.offset / page.limit) + 1;
  if (totalPages > 1) {
    if (pagEl) pagEl.style.display = '';
    if (labelEl) labelEl.textContent = currentPage + ' / ' + totalPages + ' ページ';
    if (prevBtn) prevBtn.disabled = page.offset <= 0;
    if (nextBtn) nextBtn.disabled = (page.offset + page.limit) >= page.total;
  } else {
    if (pagEl) pagEl.style.display = 'none';
  }
}

function openListenerDetail(channelId, options) {
  if (!api.listeners || !channelId) return;
  options = options || {};
  // yt- prefix が付いていれば剥がして渡す (Rust 側で再付与)
  var rawId = channelId.indexOf('yt-') === 0 ? channelId.substring(3) : channelId;
  // 観点 I: モーダル open を user 操作として記録 (= 詳細: docs/logging.md)
  rendererLog.info('user: open-listener-detail-modal, channelId=' + rawId);
  var contextStreamVideoId = options.contextStreamVideoId || currentStreamVideoId || '';
  var contextStreamIsOwn = options.contextStreamIsOwn !== undefined
    ? !!options.contextStreamIsOwn
    : (contextStreamVideoId && contextStreamVideoId === currentStreamVideoId ? isOwnStream : false);
  // detail (= listener row + 直近 50 コメの表示用) と chip 数 (= 全期間 / SC / 当該枠の
  // 正確な総数) を並行 fetch。chip 数は server-side で 1 SQL 集計するので、
  // recentComments の cap (50) に縛られず正確。
  // SC のみ chip 用に全期間 SC コメも別 fetch する (= recentComments 直近 50 件圏外の
  // SC が抜ける問題の対処、2026-05-13)。
  // 「この枠」chip 用の全件 fetch は contextStreamVideoId がある時だけ。
  // 過去配信を開くと recentComments (= 直近 50 件) には現枠以外のコメも混じるので、
  // chip 数字 (= chipCounts.thisStream) との不整合を防ぐため server-side で取り直す。
  // 2026-05-14 [[count-vs-filter-consistency]] パターン。
  var thisStreamPromise = contextStreamVideoId && api.listeners.listenerCommentsInStream
    ? api.listeners.listenerCommentsInStream(rawId, contextStreamVideoId, 1000)
    : Promise.resolve(null);
  Promise.all([
    api.listeners.detail(rawId, 50),
    api.listeners.listenerChipCounts(rawId, contextStreamVideoId),
    api.listeners.listenerSuperchats(rawId, 200),
    thisStreamPromise,
  ]).then(function (results) {
    var detailResp = results[0];
    var chipResp = results[1];
    var scResp = results[2];
    var thisResp = results[3];
    if (!detailResp || !detailResp.ok || !detailResp.detail) {
      if (options.fallbackDetail) {
        renderListenerDetailModal(options.fallbackDetail, options);
        return;
      }
      alert('詳細の取得に失敗しました');
      return;
    }
    var chipCounts = (chipResp && chipResp.ok && chipResp.counts) ? chipResp.counts : null;
    var scComments = (scResp && scResp.ok && Array.isArray(scResp.comments)) ? scResp.comments : null;
    var thisStreamComments = (thisResp && thisResp.ok && Array.isArray(thisResp.comments))
      ? thisResp.comments
      : null;
    var mergedOptions = Object.assign({}, options, {
      contextStreamVideoId: contextStreamVideoId,
      contextStreamIsOwn: contextStreamIsOwn,
      chipCounts: chipCounts,
      scComments: scComments,
      thisStreamComments: thisStreamComments,
    });
    renderListenerDetailModal(detailResp.detail, mergedOptions);
  }).catch(function (err) {
    if (options.fallbackDetail) {
      renderListenerDetailModal(options.fallbackDetail, options);
      return;
    }
    alert('詳細取得エラー: ' + (err && err.message ? err.message : err));
  });
}

// ─────────────────────────────────────────────────────────────
// リスナー詳細モーダル
//   構造: サマリ (常時表示) + 下線タブ (直近のコメント / ユーザー詳細)
//   設計思想: 単一最適解は無いため、「枠の履歴を追う」と「誰で関係性は?」
//   両ユースケースを満たす最小セットをサマリで通常表示し、深掘りは tab で
//   ユーザーが選ぶ。
// ─────────────────────────────────────────────────────────────
function renderListenerDetailModal(detail, options) {
  options = options || {};
  var modal = document.getElementById('listener-detail-modal');
  var sumEl = document.getElementById('listener-detail-summary');
  var tabsEl = document.getElementById('listener-detail-tabs');
  var commentsTabEl = document.getElementById('listener-detail-tab-comments');
  var profileTabEl = document.getElementById('listener-detail-tab-profile');
  var chipsEl = document.getElementById('listener-detail-chips');
  var listEl = document.getElementById('listener-detail-comments');
  if (!modal || !sumEl || !tabsEl || !commentsTabEl || !profileTabEl) return;

  // recentComments の focus / 並び替えはサマリ・チップ計算前に確定させる
  var recentComments = detail.recentComments || [];
  if (options.focusComment) {
    var focused = commentDataToRecentComment(options.focusComment);
    // SSE で来た RawComment.id は prefix なしだが、DB に保存される CommentRow.id は
    // listener_manager 側で `yt-` prefix が付く (= with_yt_prefix)。両者を比較する
    // 時は normalize しないと常に不一致になり、focused が重複挿入されてしまう。
    var stripYt = function (id) { return String(id || '').replace(/^yt-/, ''); };
    var focusedId = stripYt(focused.id);
    var foundFocused = false;
    for (var fc = 0; fc < recentComments.length; fc++) {
      if (focusedId && stripYt(recentComments[fc].id) === focusedId) {
        recentComments[fc]._selected = true;
        if (fc > 0) {
          var selectedComment = recentComments.splice(fc, 1)[0];
          recentComments.unshift(selectedComment);
        }
        foundFocused = true;
        break;
      }
    }
    if (!foundFocused) recentComments = [focused].concat(recentComments);
  }

  // この枠フィルタの context: 呼び出し元から渡された videoId を優先 (= 配信詳細モーダルの
  // リスナータブから開いた場合は modal の枠)、無ければライブ接続中の stream に fallback。
  var contextStreamVideoId = options.contextStreamVideoId || currentStreamVideoId || '';
  var initialGreetedAt = (options.chipCounts && options.chipCounts.greetedAt) || 0;
  // リスナー対応済みトグル表示条件: context の配信枠が自チャンネル + listeners.db に行あり。
  // 配信ログから開いた過去枠でも同じ per-stream 状態を操作できる。
  var canGreet = !!(
    contextStreamVideoId &&
    options.contextStreamIsOwn &&
    !detail._commentOnly
  );
  renderListenerDetailSummary(sumEl, detail, {
    contextStreamVideoId: canGreet ? contextStreamVideoId : '',
    greetedAt: initialGreetedAt
  });
  renderListenerDetailTabs(tabsEl, recentComments.length);
  renderListenerDetailComments(
    chipsEl, listEl, recentComments,
    contextStreamVideoId,
    options.chipCounts || null,
    options.scComments || null,
    options.thisStreamComments || null,
    detail
  );
  renderListenerDetailProfile(profileTabEl, detail);

  attachListenerDetailTabSwitch();
  // 「対応済み」トグル attach: canGreet と同じ条件 (= summary 出力と整合)
  if (canGreet && detail.channelId) {
    attachListenerGreetedToggle(detail.channelId, contextStreamVideoId);
  }

  // 編集ハンドラは Tab B の DOM が描画された後に attach する。
  // _commentOnly の場合は nickname/label/notes/delete UI が無いので skip。
  if (!detail._commentOnly) {
    attachListenerMetadataEditor(detail);
    attachListenerTagEditor(detail);
    attachListenerDeleteButton(detail);
    // メモ欄の auto-resize (内部スクロール禁止 + 親側で modal スクロール許容方針)
    attachListenerNotesAutoResize();
  }
  attachListenerHideToggles(detail);

  // 開いたときは常に Tab A (直近のコメント) を表示。
  // Tab B は inactive クラスで layout には残しつつ visibility:hidden にする
  // (= modal の高さは Tab B の自然高で決まるため、タブ切替で揺れない)。
  commentsTabEl.classList.remove('inactive');
  profileTabEl.classList.add('inactive');
  var fullTabEl = document.getElementById('listener-detail-tab-full');
  if (fullTabEl) fullTabEl.classList.add('inactive');
  // 「全コメ」タブの state を新しい listener 用にリセット (= lazy load 待機)
  listenerDetailFullPrepare(detail && detail.channelId ? detail.channelId : '');

  modal.style.display = '';

  // textarea の高さは display 後に scrollHeight で測る必要があるため、
  // modal 表示後に sync resize する。
  if (!detail._commentOnly) resizeListenerNotesTextarea();

  // 直近 N 日 棒グラフを hydrate (Tab B の #ld-detail-heatmap)。
  // channelId が無いケース (フォールバック詳細) は skip。
  if (detail.channelId) hydrateListenerDetailHeatmap(detail.channelId);
}

// サマリ (V2 hero) — アバター + 名前 + バッジ + 1 行スタッツ
// summaryOpts = { contextStreamVideoId, greetedAt }
//   contextStreamVideoId: 現在表示中の枠 (= 「この枠で対応済み」の対象枠)。空ならボタン非表示
//   greetedAt: 0 = 未対応、>0 = 対応した時刻
function renderListenerDetailSummary(el, detail, summaryOpts) {
  var displayName = detail.displayName || '(no name)';
  var nick = detail.nickname || '';
  var iconUrl = detail.iconUrl || '';
  var memberMonths = detail.memberMonthsMax || 0;
  var label = detail.label || '';
  var amountText = listenerMgrFormatYen(detail.superchatAmountJpy) || '¥0';
  var scCount = detail.superchatCount || 0;
  var commentCount = detail.commentCount || 0;
  var lifeStr = formatListenerSinceShort(detail.firstSeenAt);
  var lastStr = formatListenerLastSeenShort(detail.lastSeenAt);

  // アバター: icon_url があれば background-image、無ければ initial 文字
  var memberClass = detail.isMember ? ' member' : '';
  var avatarHtml;
  if (iconUrl) {
    avatarHtml = '<div class="ld-avatar' + memberClass + '" style="background-image:url(\'' +
      listenerMgrEscape(iconUrl) + '\');"></div>';
  } else {
    var initial = (displayName || '?').charAt(0);
    avatarHtml = '<div class="ld-avatar' + memberClass + '">' + listenerMgrEscape(initial) + '</div>';
  }

  // バッジ
  var badges = '';
  if (detail.isMember) {
    badges += '<span class="ld-badge member">👑 メンバー ' + memberMonths + 'ヶ月</span>';
  }
  if (detail.isModerator) {
    badges += '<span class="ld-badge mod">MOD</span>';
  }
  if (label) {
    badges += '<span class="ld-badge label">' + listenerMgrEscape(label) + '</span>';
  }
  if (scCount > 0) {
    badges += '<span class="ld-badge sc">SC ' + listenerMgrEscape(amountText) + '</span>';
  }

  // ニックネーム / handle 行 (display_name と nickname が異なるときだけ括弧表示)
  var nickSubLine = '';
  if (nick && nick !== displayName) {
    nickSubLine = listenerMgrEscape(nick);
    if (detail.username) nickSubLine += ' · ' + listenerMgrEscape(detail.username);
  } else if (detail.username) {
    nickSubLine = listenerMgrEscape(detail.username);
  }
  var nickHtml = nickSubLine ? '<div class="ld-nick">' + nickSubLine + '</div>' : '';

  // リスナー「対応済み」トグル (= 現在の配信枠 context がある時だけ表示)。
  // 設計: docs/architecture/remote-viewing-redesign.md §5.5
  var greetedHtml = '';
  if (summaryOpts && summaryOpts.contextStreamVideoId) {
    var greeted = summaryOpts.greetedAt > 0;
    greetedHtml = '<button type="button" id="ld-greeted-toggle" class="ld-greeted-toggle" data-channel-id="' +
      listenerMgrEscape(detail.channelId || '') + '" data-greeted="' + (greeted ? '1' : '0') + '">' +
      (greeted ? '<span class="ld-greeted-icon">✓</span>' : '') +
      '<span class="ld-greeted-label">' + (greeted ? '対応済み' : '対応') + '</span>' +
    '</button>';
  }

  el.innerHTML =
    '<div class="ld-hero">' +
      avatarHtml +
      '<div class="ld-hero-meta">' +
        '<div class="ld-name">' + listenerMgrEscape(displayName) + '</div>' +
        nickHtml +
        (badges ? '<div class="ld-badges">' + badges + '</div>' : '') +
        '<div class="ld-stat-line">' +
          '<span>コメ <span class="v cyan">' + commentCount + '</span></span>' +
          '<span>SC <span class="v amber">' + listenerMgrEscape(amountText) + '</span> (' + scCount + ')</span>' +
          (lifeStr ? '<span>歴 <span class="v">' + listenerMgrEscape(lifeStr) + '</span></span>' : '') +
          (lastStr ? '<span>最終 <span class="v live">' + listenerMgrEscape(lastStr) + '</span></span>' : '') +
        '</div>' +
      '</div>' +
      greetedHtml +
    '</div>';
}

function renderListenerDetailTabs(el, commentsCount) {
  el.innerHTML =
    '<span class="ld-tab active" data-tab="comments">直近のコメント<span class="count">' + (commentsCount || 0) + '</span></span>' +
    '<span class="ld-tab" data-tab="profile">ユーザー詳細</span>' +
    '<span class="ld-tab" data-tab="full">全コメ</span>';
}

function attachListenerDetailTabSwitch() {
  var tabsEl = document.getElementById('listener-detail-tabs');
  var commentsBody = document.getElementById('listener-detail-tab-comments');
  var profileBody = document.getElementById('listener-detail-tab-profile');
  var fullBody = document.getElementById('listener-detail-tab-full');
  if (!tabsEl || !commentsBody || !profileBody || !fullBody) return;
  var tabs = tabsEl.querySelectorAll('.ld-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      var name = this.getAttribute('data-tab');
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
      this.classList.add('active');
      // .inactive class を切り替え。Tab B (profile) は visibility:hidden で layout に残し、
      // Tab A (comments) / Tab C (full) は display:none で完全に消す (CSS 側で挙動分け)。
      // これにより Tab B 切替時の modal 高さが揺れない。
      if (name === 'comments') {
        commentsBody.classList.remove('inactive');
        profileBody.classList.add('inactive');
        fullBody.classList.add('inactive');
      } else if (name === 'full') {
        commentsBody.classList.add('inactive');
        profileBody.classList.add('inactive');
        fullBody.classList.remove('inactive');
        // 「全コメ」タブ初表示で lazy load 開始
        listenerDetailFullEnsureLoaded();
      } else {
        commentsBody.classList.add('inactive');
        profileBody.classList.remove('inactive');
        fullBody.classList.add('inactive');
      }
    });
  }
}

// メモ textarea の auto-resize。内部スクロール禁止 + 親 (tab-area) 側スクロール方針。
// 各 keyup / input で scrollHeight に合わせて height を再計算する。
function attachListenerNotesAutoResize() {
  var notesEl = document.getElementById('listener-edit-notes');
  if (!notesEl) return;
  notesEl.addEventListener('input', resizeListenerNotesTextarea);
}

function resizeListenerNotesTextarea() {
  var notesEl = document.getElementById('listener-edit-notes');
  if (!notesEl) return;
  // height を auto に戻してから scrollHeight を読むことで、文字を消した時にも縮む
  notesEl.style.height = 'auto';
  notesEl.style.height = notesEl.scrollHeight + 'px';
}

// recent_comment (= 配信枠別 listener コメ row) を shared/comment-item.js の
// data 形状に変換する。 listener (= リスナー詳細モーダルの対象) から avatar / name /
// isMember を全セルに inject。 commentType を見て SC / メンバー / ギフト の bit を立てる。
function buildRecentCommentCellData(cm, listener) {
  var raw = (cm && cm.raw) || {};
  var amount = (cm && cm.superchatAmountJpy) ? cm.superchatAmountJpy : 0;
  var ct = (cm && cm.commentType) || '';
  var isMembership = ct === 'membership' || ct === 'membership_milestone';
  var isMembershipGift = ct === 'membership_gift' || ct === 'gift';
  return {
    id: (cm && cm.id) || '',
    name: (listener && (listener.nickname || listener.displayName)) || '',
    profileImage: (listener && listener.iconUrl) || '',
    comment: (cm && cm.body) || '',
    commentHtml: raw.commentHtml || (cm && cm.commentHtml) || '',
    isMember: !!(listener && listener.isMember),
    isModerator: !!(listener && listener.isModerator),
    amount: amount,
    currency: '¥',
    isMembership: isMembership,
    isMembershipGift: isMembershipGift,
    membershipHeader: isMembership ? (raw.membershipHeader || 'メンバー') : '',
    giftCount: isMembershipGift ? (raw.giftCount || 0) : 0,
    stickerImage: raw.stickerImage || '',
    respondedAt: (cm && cm.respondedAt) || 0
  };
}

// Tab A: フィルタチップ (この枠 / 全期間 / SC のみ) + 配信単位グルーピング
//
// chip 数は別 API (api.listeners.listenerChipCounts) で取得した正本値を使う。
// recentComments は表示・filter 対象 (= 直近 50 件) で、chip の母数とは別概念。
// chipCounts が無い (= 旧経路 / fetch 失敗) 時のみ recentComments から derive する fallback。
// thisStreamComments (= server-side で context 枠の全コメ取り直し) と
// scComments (= 同じく全期間 SC) は count-vs-filter 整合のため使う ([[count-vs-filter-consistency]])。
function renderListenerDetailComments(chipsEl, listEl, recentComments, contextStreamVideoId, chipCounts, scComments, thisStreamComments, listener) {
  if (!chipsEl || !listEl) return;
  var loadedCount = recentComments.length;
  var contextStreamId = contextStreamVideoId || '';
  // chipCounts (= server-side 正本) を優先、無ければ recentComments derive (= fallback)
  var totalCount = chipCounts ? chipCounts.all : loadedCount;
  var thisStreamCount = chipCounts
    ? chipCounts.thisStream
    : (contextStreamId
      ? recentComments.filter(function (c) { return c.streamId === contextStreamId; }).length
      : 0);
  var scCount = chipCounts
    ? chipCounts.sc
    : recentComments.filter(function (c) {
      return c.commentType === 'superchat' || c.superchatAmountJpy;
    }).length;
  // scComments (= server-side 全期間 SC) を優先、無ければ recentComments の SC filter (fallback)
  var scList = (Array.isArray(scComments) && scComments.length > 0)
    ? scComments
    : null;
  // thisStreamComments (= server-side で context 枠の全コメ) を優先、無ければ
  // recentComments の stream_id filter (fallback、 直近 50 件圏外を落とすが妥協)
  var thisList = (Array.isArray(thisStreamComments) && thisStreamComments.length > 0)
    ? thisStreamComments
    : null;

  // 初期フィルタは「この枠」が出せる時だけそれを既定に。出せないなら「全期間」。
  var initialFilter = (contextStreamId && thisStreamCount > 0) ? 'this' : 'all';

  function renderChips(activeFilter) {
    var html = '';
    if (contextStreamId && thisStreamCount > 0) {
      html += '<span class="ld-chip' + (activeFilter === 'this' ? ' active' : '') +
        '" data-filter="this">この枠<span class="count">' + thisStreamCount + '</span></span>';
    }
    html += '<span class="ld-chip' + (activeFilter === 'all' ? ' active' : '') +
      '" data-filter="all">全期間<span class="count">' + totalCount + '</span></span>';
    if (scCount > 0) {
      html += '<span class="ld-chip' + (activeFilter === 'sc' ? ' active' : '') +
        '" data-filter="sc">SC のみ<span class="count">' + scCount + '</span></span>';
    }
    chipsEl.innerHTML = html;
    var chips = chipsEl.querySelectorAll('.ld-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        var f = this.getAttribute('data-filter');
        renderChips(f);
        renderList(f);
      });
    }
  }

  function renderList(filter) {
    var filtered;
    if (filter === 'this' && contextStreamId) {
      // thisList (= server-side で context 枠の全コメ取り直し) を優先、 fallback で
      // recentComments の stream_id filter (= 直近 50 件圏外を取りこぼすが旧経路保持)。
      filtered = thisList || recentComments.filter(function (c) { return c.streamId === contextStreamId; });
    } else if (filter === 'sc') {
      // scList が server-side で取得済みならそれを使用 (= 全期間 SC、recentComments の
      // 直近 50 件圏外も含む)。無ければ recentComments の SC のみ filter (fallback)。
      filtered = scList || recentComments.filter(function (c) {
        return c.commentType === 'superchat' || c.superchatAmountJpy;
      });
    } else {
      filtered = recentComments;
    }

    if (!filtered || filtered.length === 0) {
      listEl.innerHTML = '<div class="ld-empty">該当するコメントはありません。</div>';
      return;
    }

    // streamId で順序を保ったままグループ化
    var groups = [];
    var groupMap = {};
    for (var ci = 0; ci < filtered.length; ci++) {
      var c = filtered[ci];
      var sid = c.streamId || '';
      if (!groupMap[sid]) {
        groupMap[sid] = { streamId: sid, comments: [] };
        groups.push(groupMap[sid]);
      }
      groupMap[sid].comments.push(c);
    }

    // DOM を組み立て。 各 comment は shared/comment-item.js (= 全コメ列と同じ factory)
    // で生成し、 リスナー詳細でも同一のセル形式 (= avatar + 名前 + tag + 本文 + SC 底色) にする。
    // 過去: 独自の .listener-detail-comment 構造 (= 時刻 + commentType の小 meta + 本文) を使っていたが、
    // 「独特のフォーマットで見づらい」というユーザ要望で全コメ側と統一 (2026-05-14)。
    listEl.replaceChildren();
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var groupEl = document.createElement('div');
      groupEl.className = 'ld-stream-group';
      var groupHeader = buildStreamGroupHeaderHtml(g.streamId, g.comments);
      if (groupHeader) {
        var hEl = document.createElement('div');
        hEl.className = 'ld-stream-h';
        hEl.dataset.streamId = g.streamId || '';
        hEl.innerHTML = groupHeader;
        groupEl.appendChild(hEl);
      }
      for (var i = 0; i < g.comments.length; i++) {
        var cm = g.comments[i];
        var cellData = buildRecentCommentCellData(cm, listener);
        var cellEl = window.KomehubShared.createCommentItem(cellData, {
          formatTime: listenerMgrFormatTime,
          formatYen: listenerMgrFormatYen
        });
        if (cm._selected) cellEl.classList.add('selected');
        var bodyEl = cellEl.querySelector('.comment-text');
        if (bodyEl) attachCommentKeywordContextMenu(bodyEl);
        groupEl.appendChild(cellEl);
      }
      listEl.appendChild(groupEl);
    }
    // 直近 N 件しか取得していないので、当該リスナーの累計が上限を超えている時は
    // 末尾に「直近 N 件まで表示」のヒントを出す (= 全期間 chip との数値差を補足)
    if (filter === 'all' && totalCount > loadedCount) {
      var hint1 = document.createElement('div');
      hint1.className = 'ld-truncated-hint';
      hint1.innerHTML = '直近 <b>' + loadedCount + '</b> 件まで表示 (全期間 ' + totalCount + ' 件中)';
      listEl.appendChild(hint1);
    } else if (filter === 'sc' && scList && scCount > scList.length) {
      var hint2 = document.createElement('div');
      hint2.className = 'ld-truncated-hint';
      hint2.innerHTML = '直近 <b>' + scList.length + '</b> 件まで表示 (全期間 ' + scCount + ' 件中)';
      listEl.appendChild(hint2);
    }
    // 別配信タイトルを後から in-place で hydrate (`📺 別配信 (N 日前)` → `📺 〇〇 (N 日前)`)
    hydrateStreamTitlesInList(listEl, groups);
  }

  renderChips(initialFilter);
  renderList(initialFilter);
}

// 別配信のタイトルを streamDetail で取得して header を in-place 更新する。
// - 現在配信 (currentStreamVideoId) は「📺 この枠」固定なので skip
// - 既にキャッシュ済みなら fetch しない
// - fetch 結果は streamTitleCache に保存し、modal を閉じても残す (再利用)
function hydrateStreamTitlesInList(listEl, groups) {
  if (!api.listeners || !api.listeners.streamDetail) return;
  var unique = {};
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g.streamId) continue;
    if (currentStreamVideoId && g.streamId === currentStreamVideoId) continue;
    if (streamTitleCache[g.streamId]) continue;
    unique[g.streamId] = g;
  }
  Object.keys(unique).forEach(function (sid) {
    var grp = unique[sid];
    // recent_comment_limit=1: 余計なコメント payload は要らないので最小化
    api.listeners.streamDetail(sid, 1).then(function (resp) {
      if (!resp || !resp.ok || !resp.detail) return;
      streamTitleCache[sid] = {
        title: resp.detail.title || '',
        startedAt: resp.detail.startedAt || 0
      };
      if (!streamTitleCache[sid].title) return;
      // listEl 内の該当 header を in-place 更新 (innerHTML 全 rebuild は禁止)
      var safeSid = sid.replace(/"/g, '\\"');
      var headers = listEl.querySelectorAll('.ld-stream-h[data-stream-id="' + safeSid + '"]');
      for (var hi = 0; hi < headers.length; hi++) {
        headers[hi].innerHTML = buildStreamGroupHeaderHtml(sid, grp.comments);
      }
    }).catch(function () { /* タイトル取得失敗は黙って fallback (= 別配信表示のまま) */ });
  });
}

// stream group のヘッダラベル HTML を生成する。
// - streamId が現在配信と一致なら「📺 この枠」
// - streamId 不明なら空文字 (呼び出し側で skip)
// - キャッシュにタイトルがあれば「📺 〇〇 (N 日前)」
// - キャッシュ無しは「📺 別配信 (N 日前)」(後から hydrateStreamTitlesInList で更新)
function buildStreamGroupHeaderHtml(streamId, comments) {
  if (!streamId) return '';
  var newest = comments && comments[0];
  var rel = newest ? formatRelativeDay(newest.postedAt) : '';
  var relHtml = rel ? ' <span class="when">(' + rel + ')</span>' : '';
  if (currentStreamVideoId && streamId === currentStreamVideoId) {
    return '📺 この枠' + relHtml;
  }
  var cached = streamTitleCache[streamId];
  if (cached && cached.title) {
    return '📺 ' + listenerMgrEscape(cached.title) + relHtml;
  }
  return '📺 別配信' + relHtml;
}

// Tab B: ラベル付き section (識別情報 / 関係性 / 編集)
function renderListenerDetailProfile(el, detail) {
  var memberMonths = detail.memberMonthsMax || 0;
  var firstStr = listenerMgrFormatTime(detail.firstSeenAt);
  var lastStr = listenerMgrFormatTime(detail.lastSeenAt);
  var firstRel = formatRelativeDay(detail.firstSeenAt);
  var lastRel = formatRelativeDay(detail.lastSeenAt);
  var amountText = listenerMgrFormatYen(detail.superchatAmountJpy) || '¥0';

  var html = '';

  // 識別情報
  html += '<div class="ld-section-h">識別情報</div>';
  html += '<div class="listener-detail-row"><span class="key">channel id</span><span class="v">' +
    listenerMgrEscape(detail.channelId || '') + '</span></div>';
  if (detail.username) {
    html += '<div class="listener-detail-row"><span class="key">handle</span><span class="v">' +
      listenerMgrEscape(detail.username) + '</span></div>';
  }
  html += '<div class="listener-detail-row"><span class="key">表示名</span><span class="v">' +
    listenerMgrEscape(detail.displayName || '') + '</span></div>';

  // 関係性
  html += '<div class="ld-section-h">関係性</div>';
  if (firstStr) {
    html += '<div class="listener-detail-row"><span class="key">初コメ</span><span class="v">' +
      listenerMgrEscape(firstStr) + (firstRel ? ' (' + firstRel + ')' : '') + '</span></div>';
  }
  if (lastStr) {
    html += '<div class="listener-detail-row"><span class="key">最終コメ</span><span class="v">' +
      listenerMgrEscape(lastStr) + (lastRel ? ' (' + lastRel + ')' : '') + '</span></div>';
  }
  html += '<div class="listener-detail-row"><span class="key">累計コメ</span><span class="v cyan">' +
    (detail.commentCount || 0) + '</span></div>';
  html += '<div class="listener-detail-row"><span class="key">累計スパチャ</span><span class="v amber">' +
    listenerMgrEscape(amountText) + ' (' + (detail.superchatCount || 0) + ' 件)</span></div>';
  if (detail.isMember) {
    html += '<div class="listener-detail-row"><span class="key">メンバー継続</span><span class="v">' +
      memberMonths + ' ヶ月</span></div>';
  }
  if (detail.isModerator) {
    html += '<div class="listener-detail-row"><span class="key">モデレーター</span><span class="v">はい</span></div>';
  }

  // 活動 (直近 N 配信枠 棒グラフ + tooltip で配信タイトル / 参加状況)
  // 描画は modal 表示後に hydrateListenerDetailHeatmap が in-place で更新する
  // (初期描画時点ではキャッシュがあれば即時、無ければ空セル placeholder)。
  html += '<div class="ld-section-h">活動 (直近 ' + LISTENER_HEATMAP_STREAM_COUNT + ' 配信枠)</div>';
  html += '<div class="ld-heat" id="ld-detail-heatmap"></div>';
  html += '<div class="ld-heat-meta"><span>古い</span><span>最新 →</span></div>';

  // 編集 (_commentOnly = フォールバック詳細では nickname/label/notes/delete を出さない)
  // 保存ボタンはメモ直下、危険操作 (BAN / 削除) は section を分けて最下段に配置する。
  // メモ編集中の保存動線で誤って BAN/削除 が目に入る問題を避けるため。
  if (!detail._commentOnly) {
    html += '<div class="ld-section-h">編集 (わんコメ memo と同期)</div>';
    html += '<div class="ld-form-grid">' +
      '<label><span class="ld-form-label">ニックネーム</span>' +
        '<input type="text" id="listener-edit-nickname" class="ld-form-input" value="' +
        listenerMgrEscape(detail.nickname || '') + '" placeholder="' +
        listenerMgrEscape(detail.displayName || '') + '"/></label>' +
      '<label><span class="ld-form-label">ラベル</span>' +
        '<input type="text" id="listener-edit-label" class="ld-form-input" value="' +
        listenerMgrEscape(detail.label || '') + '" placeholder="例: VIP / 常連"/></label>' +
    '</div>';
    // タグ chip 編集 UI (setListenerTags 経由で attached_at を維持しつつ差分置換)
    html += '<div class="ld-form-label" style="margin-top:8px">タグ</div>' +
      '<div id="listener-edit-tags" class="ld-tag-edit"' +
      ' data-channel-id="' + listenerMgrEscape(detail.channelId || '') + '">' +
      '<span class="ld-tag-loading" style="font-size:11px;color:#5a6a78">読み込み中…</span>' +
      '</div>' +
      '<datalist id="listener-edit-tag-suggest"></datalist>';
    html += '<label><span class="ld-form-label">メモ</span>' +
      '<textarea id="listener-edit-notes" class="ld-form-input" rows="3" placeholder="任意メモ (わんコメ memo と同期)">' +
      listenerMgrEscape(detail.notes || '') + '</textarea></label>';
    // 保存はメモ直下の primary action 行 (status を左、保存ボタンを右下に揃える)
    html += '<div class="ld-save-row">' +
      '<span id="listener-edit-status" class="ld-edit-status"></span>' +
      '<button type="button" class="ld-btn cyan" id="listener-edit-save">保存</button>' +
    '</div>';
    // 2026-05-09 仕様変更: 旧 BAN (= 演出フィルタ) を「コメ非表示 / リスナー非表示」2 軸独立に。
    // 演出には影響しない (= 相手に気付かれない)、配信者の管理 UI からだけ消える設計。
    html += '<div class="ld-section-h">表示設定</div>';
    html += '<div class="ld-hide-actions">' +
      '<button type="button" class="ld-btn ld-hide-toggle" id="listener-hide-comments" data-active="0" title="このリスナーのコメントを管理 UI に出さない (= 演出 / テンプレート / OBS には影響しない)">コメント非表示</button>' +
      '<button type="button" class="ld-btn ld-hide-toggle" id="listener-hide-listeners" data-active="0" title="このリスナーをリスナーリストに出さない (= 演出 / テンプレート / OBS には影響しない)">リスナー非表示</button>' +
    '</div>';
    html += '<div class="ld-section-h ld-danger-h">管理</div>';
    html += '<div class="ld-danger-actions">' +
      '<button type="button" class="ld-btn danger" id="listener-edit-delete" title="このリスナーと関連コメントを削除します">このリスナーを削除…</button>' +
    '</div>';
  } else {
    // _commentOnly: 表示設定のみ提供。
    html += '<div class="ld-section-h">表示設定</div>';
    html += '<div class="ld-hide-actions">' +
      '<button type="button" class="ld-btn ld-hide-toggle" id="listener-hide-comments" data-active="0">コメント非表示</button>' +
      '<button type="button" class="ld-btn ld-hide-toggle" id="listener-hide-listeners" data-active="0">リスナー非表示</button>' +
    '</div>';
    html += '<div class="ld-edit-status-row">' +
      '<span id="listener-edit-status" class="ld-edit-status"></span>' +
    '</div>';
  }

  el.innerHTML = html;
}

// 「歴」用: first_seen_at から相対の短表記 (例: 8ヶ月 / 12日 / 3年)
// 受け取った値を epoch ms (number) に正規化する。number / 文字列 (ISO 8601 等) 両対応。
// CommentRow.postedAt: i64 (number) と RawComment.timestamp: String (ISO) が混在するため、
// formatRelativeDay 等の手前でこれを噛ませて NaN を防ぐ。
function toEpochMs(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? v : NaN;
  }
  if (typeof v === 'string' && v) {
    // 数字文字列なら number 変換、それ以外は Date.parse で ISO を解釈
    var asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    var parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function formatListenerSinceShort(unixMs) {
  var ms = toEpochMs(unixMs);
  if (!Number.isFinite(ms)) return '';
  var diff = Date.now() - ms;
  if (diff < 0) return '';
  var days = Math.floor(diff / (24 * 3600 * 1000));
  if (days < 1) return '今日';
  if (days < 30) return days + '日';
  if (days < 365) return Math.floor(days / 30) + 'ヶ月';
  return Math.floor(days / 365) + '年';
}

// 「最終」用: last_seen_at の相対 (1分前 / 3時間前 / 2日前 / 5/4 等)
function formatListenerLastSeenShort(unixMs) {
  var ms = toEpochMs(unixMs);
  if (!Number.isFinite(ms)) return '';
  var diff = Date.now() - ms;
  if (diff < 0) return '';
  var sec = Math.floor(diff / 1000);
  if (sec < 60) return sec < 5 ? 'たった今' : sec + '秒前';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + '分前';
  var hour = Math.floor(min / 60);
  if (hour < 24) return hour + '時間前';
  var day = Math.floor(hour / 24);
  if (day < 7) return day + '日前';
  // 1 週間以上前は M/D 表記
  var d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// 共通: 相対日数 (Tab B の絶対日時補足 + Tab A の別配信ヘッダで使う)
function formatRelativeDay(unixMs) {
  var ms = toEpochMs(unixMs);
  if (!Number.isFinite(ms)) return '';
  var diff = Date.now() - ms;
  if (diff < 0) return '';
  var days = Math.floor(diff / (24 * 3600 * 1000));
  if (days < 1) return '今日';
  if (days < 2) return '1 日前';
  if (days < 7) return days + ' 日前';
  if (days < 30) return Math.floor(days / 7) + ' 週間前';
  if (days < 365) return Math.floor(days / 30) + ' ヶ月前';
  return Math.floor(days / 365) + ' 年前';
}

function closeListenerDetailModal() {
  var modal = document.getElementById('listener-detail-modal');
  if (modal) modal.style.display = 'none';
  // 全コメタブの virtual scroll / scroll handler / state を片付ける
  listenerDetailFullReset();
}

// ─────────────────────────────────────────────────────────────
// リスナー詳細モーダル「全コメ」タブ (= 第 3 タブ、Phase 1-3)
//   - 当該リスナーの全期間コメを chunked lazy load + 仮想スクロールで閲覧
//   - chip「すべて / SC のみ」 + 本文検索 (debounce 300ms)
//   - 行 hover で配信枠タイトルツールチップ
// 数十万件のリスナーを想定。Phase 4 (= スクロール先頭側のデータ解放) は別途。
// ─────────────────────────────────────────────────────────────
var listenerDetailFullState = {
  channelId: '',
  loaded: false,           // 初回 fetch 完了か (= タブ初表示 lazy load 用)
  fetching: false,         // 現在 fetch 中
  exhausted: false,        // 全件取得完了 (= total に達した)
  dataRows: [],            // 取得済 row (= 累積)
  total: 0,                // server-side total (= 件数バッジ表示)
  filter: 'all',           // 'all' or 'sc'
  bodyQ: '',               // 本文検索キーワード
  searchTimer: null,       // debounce タイマー
  virtCtrl: null,          // setupLazyCommentRender controller
  scrollHandler: null,     // tab-full の scroll listener (= 末尾検出 + virtCtrl.updateWindow)
  streamInfoCache: {},     // streamId → { tooltip: string } (= マウスオーバーツールチップ用、Phase 3)
  streamTitleFetching: {}, // streamId → true (= fetch 中フラグ、二重発火防止)
};

var LISTENER_FULL_CHUNK = 5000;
var LISTENER_FULL_SCROLL_END_THRESHOLD_PX = 600; // 末尾からこれ以下で次 chunk fetch
var LISTENER_FULL_SEARCH_DEBOUNCE_MS = 300;

// モーダル open 時に呼ぶ。state を新しい listener 用にリセットするだけ
// (= chunk fetch は「全コメ」タブを開いたタイミングで初回起動する lazy)。
function listenerDetailFullPrepare(channelId) {
  listenerDetailFullReset();
  listenerDetailFullState.channelId = channelId || '';
  // chip + 検索 UI の初期描画 (= モーダル表示後、タブ未表示でも準備しておく)
  listenerDetailFullRenderToolbar();
  listenerDetailFullUpdateStatus();
}

// モーダル close / 別 listener 表示 / 「全コメ」タブから離脱で呼ぶ
function listenerDetailFullReset() {
  var state = listenerDetailFullState;
  if (state.scrollHandler) {
    var listEl = document.getElementById('listener-detail-full-list');
    if (listEl) listEl.removeEventListener('scroll', state.scrollHandler);
    state.scrollHandler = null;
  }
  if (state.virtCtrl && typeof state.virtCtrl.destroy === 'function') {
    state.virtCtrl.destroy();
  }
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
  }
  state.channelId = '';
  state.loaded = false;
  state.fetching = false;
  state.exhausted = false;
  state.dataRows = [];
  state.total = 0;
  state.filter = 'all';
  state.bodyQ = '';
  state.searchTimer = null;
  state.virtCtrl = null;
  state.streamInfoCache = {};
  state.streamTitleFetching = {};
  var innerEl = document.getElementById('listener-detail-full-list-inner');
  if (innerEl) innerEl.innerHTML = '';
  var searchEl = document.getElementById('listener-detail-full-search');
  if (searchEl) searchEl.value = '';
}

// 「全コメ」タブ初表示で lazy load 開始
function listenerDetailFullEnsureLoaded() {
  var state = listenerDetailFullState;
  if (state.loaded) {
    // 既にロード済 (= 一度開いた → 別タブ → 戻ってきた) は何もしない (state 維持)
    // virtual scroll の rect 再計算だけ走らせる (= タブ切替で bodyRect が変わる可能性)
    if (state.virtCtrl) state.virtCtrl.updateWindow();
    return;
  }
  state.loaded = true;
  var listEl = document.getElementById('listener-detail-full-list');
  var innerEl = document.getElementById('listener-detail-full-list-inner');
  var tabFull = document.getElementById('listener-detail-tab-full');
  if (!listEl || !innerEl || !tabFull || !state.channelId) return;
  innerEl.innerHTML = '';
  // 仮想スクロールセットアップ。
  // - bodyEl = inner (= 内側、行 + spacer を持つ。scroll しない)
  // - scrollContainer = list (= 外側、overflow-y: auto)
  // 2 階層に分けることで getBoundingClientRect 差分が scroll に追従する。
  state.virtCtrl = setupLazyCommentRender(innerEl, state.dataRows, {
    streamIsOwn: false, // 全期間 = 複数枠混在のため対応済みトグルは非表示
    scrollContainer: listEl,
    disableClick: true,
    rowDecorator: function (node, row) {
      var sid = row && row.streamId;
      if (!sid) return;
      // stream_id 専用バッジ。title 属性はバッジ自身に付ける (= 行全体ではなく
      // バッジホバー時のみ tooltip 表示、UX 明確化)。
      // tooltip 内容は title + channel + 配信日時 + 配信時間 + ID + コメ数 (= 改行含む rich text)
      var info = state.streamInfoCache[sid];
      var tooltip = info ? info.tooltip : '(配信枠情報を読み込み中… ' + sid + ')';
      var badge = document.createElement('span');
      badge.className = 'ld-full-stream-badge';
      badge.textContent = sid;
      badge.dataset.streamId = sid;
      badge.setAttribute('title', tooltip);
      node.appendChild(badge);
    },
  });
  // scroll listener は list (= scrollContainer) に attach。
  state.scrollHandler = function () {
    var ctrl = state.virtCtrl;
    if (ctrl) ctrl.updateWindow();
    var remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
    if (remaining < LISTENER_FULL_SCROLL_END_THRESHOLD_PX
        && !state.fetching && !state.exhausted) {
      listenerDetailFullFetchNext();
    }
  };
  listEl.addEventListener('scroll', state.scrollHandler, { passive: true });
  // 初回 chunk fetch
  listenerDetailFullFetchNext();
}

function listenerDetailFullFetchNext() {
  var state = listenerDetailFullState;
  if (state.fetching || state.exhausted || !state.channelId) return;
  if (!api || !api.listeners || typeof api.listeners.searchComments !== 'function') return;
  state.fetching = true;
  listenerDetailFullUpdateStatus();
  var query = {
    listenerChannelIds: [state.channelId],
    bodyQ: state.bodyQ || undefined,
    commentTypes: state.filter === 'sc'
      ? ['superchat', 'sticker', 'gift']
      : undefined,
    limit: LISTENER_FULL_CHUNK,
    offset: state.dataRows.length,
    scope: 'all',
    includeKpi: false,
  };
  var fetchSeq = state.channelId + '|' + state.filter + '|' + state.bodyQ;
  state._fetchSeq = fetchSeq;
  api.listeners.searchComments(query).then(function (resp) {
    // 取得中に filter / 検索 / listener が変わっていたら破棄
    if (state._fetchSeq !== fetchSeq) return;
    state.fetching = false;
    if (!resp || !resp.ok || !resp.page) {
      listenerDetailFullUpdateStatus();
      return;
    }
    state.total = resp.page.total || 0;
    var newRows = resp.page.rows || [];
    for (var i = 0; i < newRows.length; i++) state.dataRows.push(newRows[i]);
    if (state.dataRows.length >= state.total || newRows.length === 0) {
      state.exhausted = true;
    }
    // Phase 3: 取得済 row の stream_id を集めて未取得タイトルを並行 fetch
    listenerDetailFullHydrateStreamTitles(newRows);
    if (state.virtCtrl) {
      state.virtCtrl.notifyDataExtended();
      // 初回データ着信時、innerEl の DOM 高さは元々 0 で getVisibleRange が
      // [0,-1] を返し描画がスキップされる。notifyDataExtended が末尾で
      // updateSpacers を呼んで innerEl 高さを反映するので、次フレームで
      // 改めて updateWindow を呼んで visible 範囲を描画させる
      // (= スクロール開始まで何も表示されない問題の対処、2026-05-13)。
      setTimeout(function () {
        if (state.virtCtrl) state.virtCtrl.updateWindow();
      }, 0);
    }
    listenerDetailFullUpdateStatus();
    // 描画後にまだ viewport が埋まらない場合は連続 fetch (= 初期表示でスクロールバー
    // が出ないと scroll event が走らず止まる)
    var listEl = document.getElementById('listener-detail-full-list');
    if (listEl && !state.exhausted) {
      var remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
      if (remaining < LISTENER_FULL_SCROLL_END_THRESHOLD_PX) {
        // 次のフレームで再 fetch (= renderer に描画機会を与える)
        setTimeout(listenerDetailFullFetchNext, 0);
      }
    }
  }).catch(function (err) {
    if (state._fetchSeq !== fetchSeq) return;
    state.fetching = false;
    rendererLog.error('listener detail full fetch failed', err);
    listenerDetailFullUpdateStatus();
  });
}

// chip + 検索 input の DOM 描画 + イベント結線
function listenerDetailFullRenderToolbar() {
  var chipsEl = document.getElementById('listener-detail-full-chips');
  var searchEl = document.getElementById('listener-detail-full-search');
  var state = listenerDetailFullState;
  if (chipsEl) {
    chipsEl.innerHTML = '';
    var chips = [
      { id: 'all', label: 'すべて' },
      { id: 'sc', label: 'SC のみ' },
    ];
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var pill = document.createElement('span');
      pill.className = 'ld-chip' + (state.filter === c.id ? ' active' : '');
      pill.dataset.filter = c.id;
      pill.textContent = c.label;
      (function (filterId) {
        pill.addEventListener('click', function () {
          if (state.filter === filterId) return;
          state.filter = filterId;
          listenerDetailFullResetDataAndRefetch();
          listenerDetailFullRenderToolbar();
        });
      }(c.id));
      chipsEl.appendChild(pill);
    }
  }
  if (searchEl) {
    // input listener は idempotent に再設定 (= prepare 時に毎回上書き)
    searchEl.oninput = function () {
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        state.searchTimer = null;
        var v = String(searchEl.value || '').trim();
        if (state.bodyQ === v) return;
        state.bodyQ = v;
        listenerDetailFullResetDataAndRefetch();
      }, LISTENER_FULL_SEARCH_DEBOUNCE_MS);
    };
  }
}

// filter / 検索が変わった時、データを破棄して再 fetch
function listenerDetailFullResetDataAndRefetch() {
  var state = listenerDetailFullState;
  state.dataRows.length = 0;
  state.total = 0;
  state.exhausted = false;
  state.fetching = false;
  if (state.virtCtrl) state.virtCtrl.notifyDataExtended();
  var listEl = document.getElementById('listener-detail-full-list');
  if (listEl) {
    // virtual scroll 内の現描画を消す (= spacer を残しつつ間の row を除去)
    if (state.virtCtrl && typeof state.virtCtrl.updateWindow === 'function') {
      state.virtCtrl.updateWindow();
    }
  }
  var listEl2 = document.getElementById('listener-detail-full-list');
  if (listEl2) listEl2.scrollTop = 0;
  listenerDetailFullUpdateStatus();
  listenerDetailFullFetchNext();
}

// status 行 (= "全 N 件中 M 件表示" 等) を更新
function listenerDetailFullUpdateStatus() {
  var statusEl = document.getElementById('listener-detail-full-status');
  if (!statusEl) return;
  var state = listenerDetailFullState;
  if (!state.channelId) {
    statusEl.textContent = '';
    return;
  }
  var loaded = state.dataRows.length;
  var total = state.total;
  var label = state.filter === 'sc' ? 'SC のみ' : '全期間';
  if (state.bodyQ) label += ' / 検索「' + state.bodyQ + '」';
  if (state.fetching && loaded === 0) {
    statusEl.textContent = label + ': 読み込み中…';
  } else if (state.exhausted) {
    statusEl.textContent = label + ': ' + loaded + ' 件 (= 全件)';
  } else {
    statusEl.textContent = label + ': ' + loaded + ' / ' + total + ' 件 表示中 (スクロールで続き読込)';
  }
}

// Phase 3: 取得済の新規 stream_id を集めて、配信枠詳細を並行 fetch (= タイトル / チャンネル名 /
// 開始時刻 / 配信時間 / コメ数 等)。取得後は streamInfoCache を更新し、DOM のバッジの
// title 属性を rich tooltip (改行含む) に in-place 書き換える。
function listenerDetailFullHydrateStreamTitles(rows) {
  var state = listenerDetailFullState;
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (!api || !api.listeners || typeof api.listeners.streamDetail !== 'function') return;
  var ids = {};
  for (var i = 0; i < rows.length; i++) {
    var sid = rows[i] && rows[i].streamId;
    if (!sid) continue;
    if (state.streamInfoCache[sid] !== undefined) continue;
    if (state.streamTitleFetching[sid]) continue;
    ids[sid] = true;
  }
  Object.keys(ids).forEach(function (sid) {
    state.streamTitleFetching[sid] = true;
    api.listeners.streamDetail(sid, 0).then(function (resp) {
      delete state.streamTitleFetching[sid];
      // StreamDetail は #[serde(flatten)] で StreamRow が detail 直下に展開される。
      // つまり resp.detail = { title, channelName, startedAt, ..., recentComments, uniqueCommenters }
      // で stream ネストは無い。resp.detail をそのまま StreamRow として扱う。
      var stream = (resp && resp.ok && resp.detail) ? resp.detail : null;
      var tooltip = buildListenerDetailStreamTooltip(sid, stream);
      state.streamInfoCache[sid] = { tooltip: tooltip };
      // 既存 DOM のバッジ title を in-place 更新 (= 描画済の全 row に反映)
      var innerEl = document.getElementById('listener-detail-full-list-inner');
      if (!innerEl) return;
      var nodes = innerEl.querySelectorAll('.ld-full-stream-badge[data-stream-id="' + cssEscapeSimple(sid) + '"]');
      for (var n = 0; n < nodes.length; n++) {
        nodes[n].setAttribute('title', tooltip);
      }
    }).catch(function () {
      delete state.streamTitleFetching[sid];
    });
  });
}

// 配信枠 tooltip 文字列を組み立てる (= 改行入り rich text、title 属性に当てる)。
// stream が null / title 空でも、ID と「読み込み失敗 / メタデータ未取得」のヒントを出す。
function buildListenerDetailStreamTooltip(sid, stream) {
  var lines = [];
  if (stream) {
    var title = (stream.title || '').trim();
    var channelName = (stream.channelName || '').trim();
    var startedAt = stream.startedAt || 0;
    var endedAt = stream.endedAt || 0;
    var commentCount = stream.commentCount || 0;
    var peakViewers = stream.peakConcurrentViewers || 0;
    var likes = stream.likes || 0;
    lines.push(title ? title : '(タイトル未取得)');
    if (channelName) lines.push(channelName);
    if (startedAt) {
      var startStr = listenerMgrFormatDateTime(startedAt);
      var rangeStr = startStr;
      if (endedAt && endedAt > startedAt) {
        var durMin = Math.floor((endedAt - startedAt) / 60000);
        var h = Math.floor(durMin / 60);
        var m = durMin % 60;
        rangeStr += ' (配信時間 ' + h + 'h' + (m < 10 ? '0' + m : m) + 'm)';
      }
      lines.push(rangeStr);
    }
    var statsBits = [];
    if (commentCount) statsBits.push('全コメ数 ' + Number(commentCount).toLocaleString());
    if (peakViewers) statsBits.push('ピーク同接 ' + Number(peakViewers).toLocaleString());
    if (likes) statsBits.push('いいね ' + Number(likes).toLocaleString());
    if (statsBits.length > 0) lines.push(statsBits.join(' / '));
  } else {
    lines.push('(配信枠情報の取得に失敗)');
  }
  lines.push('ID: ' + sid);
  return lines.join('\n');
}

// querySelector 用に CSS attribute selector で安全に使える文字に escape する簡易実装。
// stream_id は YouTube 由来 (= [A-Za-z0-9_-]) なので素のままで通るが念のため。
function cssEscapeSimple(s) {
  return String(s || '').replace(/(["\\])/g, '\\$1');
}

// リスナー詳細のタグ編集 UI を結線する。
// 1. getListenerTags で現在のタグ一覧を fetch して chip 描画
// 2. listAllTags でサジェスト候補を datalist に流し込む
// 3. chip の ✕ で削除 / "+ タグ追加" → input → Enter or Comma で追加
// 4. 各操作で setListenerTags(channelId, [...current]) を呼んで全置換 (差分は Rust 側で吸収)
function attachListenerTagEditor(detail) {
  var rootEl = document.getElementById('listener-edit-tags');
  if (!rootEl || !api.listeners) return;
  var channelId = rootEl.dataset.channelId || detail.channelId;
  if (!channelId) return;

  var current = []; // 現在付いているタグ (string[])

  function render() {
    rootEl.innerHTML = '';
    for (var i = 0; i < current.length; i++) {
      var t = current[i];
      var chip = document.createElement('span');
      chip.className = 'ld-tag-chip';
      chip.textContent = t;
      var x = document.createElement('span');
      x.className = 'ld-tag-x';
      x.textContent = '✕';
      x.title = '削除';
      (function (tagToRemove) {
        x.addEventListener('click', function (ev) {
          ev.stopPropagation();
          removeTag(tagToRemove);
        });
      }(t));
      chip.appendChild(x);
      rootEl.appendChild(chip);
    }
    // 入力 pill
    var addPill = document.createElement('span');
    addPill.className = 'ld-tag-add-pill';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '+ タグ追加';
    input.setAttribute('list', 'listener-edit-tag-suggest');
    input.className = 'ld-tag-add-input';
    addPill.appendChild(input);
    rootEl.appendChild(addPill);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        var v = input.value.trim().replace(/,/g, '');
        if (v) addTag(v);
        input.value = '';
      } else if (e.key === 'Backspace' && input.value === '' && current.length > 0) {
        removeTag(current[current.length - 1]);
      }
    });
    input.addEventListener('change', function () {
      // datalist 選択時にも発火
      var v = input.value.trim();
      if (v) {
        addTag(v);
        input.value = '';
      }
    });
  }

  function addTag(tag) {
    if (current.indexOf(tag) >= 0) return;
    current.push(tag);
    persist();
    render();
  }
  function removeTag(tag) {
    current = current.filter(function (t) { return t !== tag; });
    persist();
    render();
  }
  function persist() {
    api.listeners.setListenerTags(channelId, current).then(function (resp) {
      if (!resp || !resp.ok) {
        rendererLog.warn('setListenerTags failed', resp);
      }
      // 既存の検索 form の user-tag pill 列を最新状態に refresh
      // (新規タグが追加されたら検索条件にも候補が出るべき)
      refreshUserTagPills();
    }).catch(function (err) {
      rendererLog.error('setListenerTags failed', err);
    });
  }

  // 初期 fetch: 現在のタグ + サジェスト候補を並行で取得
  Promise.all([
    api.listeners.getListenerTags(channelId),
    api.listeners.listAllTags()
  ]).then(function (results) {
    var tagsResp = results[0];
    var allResp = results[1];
    current = (tagsResp && tagsResp.ok && tagsResp.tags) ? tagsResp.tags.slice() : [];
    // datalist にサジェスト候補を流し込む
    var dl = document.getElementById('listener-edit-tag-suggest');
    if (dl) {
      dl.innerHTML = '';
      var allTags = (allResp && allResp.ok && allResp.tags) ? allResp.tags : [];
      for (var i = 0; i < allTags.length; i++) {
        var opt = document.createElement('option');
        opt.value = allTags[i].tag;
        dl.appendChild(opt);
      }
    }
    render();
  }).catch(function (err) {
    rendererLog.error('tag editor init failed', err);
    rootEl.innerHTML = '<span style="font-size:11px;color:#ef9a9a">タグの読み込みに失敗</span>';
  });
}

// 詳細モーダルの「保存」ボタンに、変更があったフィールドだけ送る部分更新を結線する。
// nickname / label / notes 各フィールドで、初期値 (detail) と異なるものだけ payload に詰めて
// updateMetadata を呼ぶ。空文字 "" でクリアも可能 (Rust 側 3 値セマンティクス)。
function attachListenerMetadataEditor(detail) {
  var btn = document.getElementById('listener-edit-save');
  var status = document.getElementById('listener-edit-status');
  if (!btn || !api.listeners || !api.listeners.updateMetadata) return;
  var initial = {
    nickname: detail.nickname || '',
    label: detail.label || '',
    notes: detail.notes || '',
  };
  btn.addEventListener('click', function () {
    var nickEl = document.getElementById('listener-edit-nickname');
    var labelEl = document.getElementById('listener-edit-label');
    var notesEl = document.getElementById('listener-edit-notes');
    var payload = {};
    if (nickEl && nickEl.value !== initial.nickname) payload.nickname = nickEl.value;
    if (labelEl && labelEl.value !== initial.label) payload.label = labelEl.value;
    if (notesEl && notesEl.value !== initial.notes) payload.notes = notesEl.value;
    if (Object.keys(payload).length === 0) {
      if (status) status.textContent = '変更はありません';
      return;
    }
    btn.disabled = true;
    if (status) status.textContent = '保存中...';
    api.listeners.updateMetadata(detail.channelId, payload).then(function (resp) {
      btn.disabled = false;
      if (resp && resp.ok) {
        if (status) status.textContent = '保存しました';
        // 一覧側も値が変わるので最新化
        refreshListenerList();
        // 詳細モーダル自体も再 fetch して、保存後の最新値で再描画する。
        // (recent_comments も再取得されるので、消失バグの再現観測にも使える)
        var rawId = detail.channelId.indexOf('yt-') === 0
          ? detail.channelId.substring(3)
          : detail.channelId;
        api.listeners.detail(rawId, 50).then(function (r) {
          if (r && r.ok && r.detail) {
            renderListenerDetailModal(r.detail);
          }
        }).catch(function () { /* 詳細再取得は best-effort */ });
        // 初期値を更新して再差分判定が正しく動くように
        if ('nickname' in payload) initial.nickname = payload.nickname;
        if ('label' in payload) initial.label = payload.label;
        if ('notes' in payload) initial.notes = payload.notes;
      } else {
        if (status) status.textContent = '保存失敗: ' + ((resp && resp.error) || 'unknown');
      }
    }).catch(function (err) {
      btn.disabled = false;
      if (status) status.textContent = '保存失敗: ' + (err && err.message ? err.message : err);
    });
  });
}

// リスナー一覧の一括選択 / 削除バー (選択数 0 で hide、1+ で show)
// + 「全選択」チェックボックスを現ページの選択状態に同期する。
function updateListenerBulkBar() {
  var bar = document.getElementById('listener-mgr-bulk-bar');
  var label = document.getElementById('listener-mgr-bulk-label');
  var n = listenerMgrState.selectedIds ? listenerMgrState.selectedIds.size : 0;
  if (bar) {
    if (n === 0) bar.style.display = 'none';
    else {
      bar.style.display = '';
      if (label) label.textContent = n + ' 名を選択中';
    }
  }
  // 全選択チェックの同期:
  //   選択 0 件                       → unchecked
  //   選択数 = page.total (= 全件)    → checked
  //   それ以外                         → indeterminate (= 一部選択中)
  // ページ移動を跨いで selectedIds を保持しているので、現ページの行数ではなく
  // 全体件数 (page.total) と比較するのが正しい。
  var selectAll = document.getElementById('listener-mgr-select-all');
  if (selectAll) {
    var total = listenerMgrState.page ? (listenerMgrState.page.total || 0) : 0;
    if (n === 0 || total === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    } else if (n >= total) {
      selectAll.checked = true;
      selectAll.indeterminate = false;
    } else {
      selectAll.checked = false;
      selectAll.indeterminate = true;
    }
  }
}

// 「全選択」チェックボックスのトグル: 現在の検索条件 (q / sort) でヒットする
// 全件を選択 / 解除する。list_listeners の limit 上限 (1000) を超えるケースに
// 備えてクライアント側で 1000 件ずつページング取得する。
async function toggleSelectAllListeners(checked) {
  if (!listenerMgrState.selectedIds) listenerMgrState.selectedIds = new Set();
  if (!checked) {
    listenerMgrState.selectedIds.clear();
    refreshListenerList();
    return;
  }
  if (!api.listeners || !api.listeners.list) return;
  var selectAll = document.getElementById('listener-mgr-select-all');
  if (selectAll) selectAll.disabled = true;
  try {
    var batchSize = 1000;
    var offset = 0;
    var safetyMax = 1000000; // 暴走ガード (= 1M 件で止まる)
    while (offset < safetyMax) {
      var resp = await api.listeners.list({
        sort: listenerMgrState.sort || 'streamFirstAt',
        q: listenerMgrState.q || '',
        limit: batchSize,
        offset: offset
      });
      if (!resp || !resp.ok || !resp.page) break;
      var rows = resp.page.rows || [];
      for (var i = 0; i < rows.length; i++) {
        listenerMgrState.selectedIds.add(rows[i].channelId);
      }
      offset += rows.length;
      if (rows.length < batchSize) break;       // 最後のページに到達
      if (offset >= (resp.page.total || 0)) break; // 念のため total と比較
    }
  } catch (err) {
    alert('全選択取得失敗: ' + (err && err.message ? err.message : err));
  } finally {
    if (selectAll) selectAll.disabled = false;
    refreshListenerList();
  }
}

// 一括削除: 選択中の channelIds をまとめて Rust 側へ delete_listeners する
function bulkDeleteListeners() {
  if (!listenerMgrState.selectedIds || listenerMgrState.selectedIds.size === 0) return;
  if (!api.listeners || !api.listeners.deleteListeners) return;
  var ids = Array.from(listenerMgrState.selectedIds);
  var msg =
    '選択した ' + ids.length + ' 名のリスナーを削除します。\n\n' +
    'リスナー情報 (表示名・累計値・メモ等) とアバター画像のキャッシュを削除します。\n' +
    'コメント本文は配信履歴として残ります (再登場時は自動で再紐付け)。\n' +
    'タグ・対応済み状態は配信履歴に紐付くため、再登場時にそのまま継承されます。\n' +
    'わんコメ側のデータには影響しません。\n\n' +
    '続行しますか?';
  if (!confirm(msg)) return;
  rendererLog.info('user: listener-bulk-delete, count=' + ids.length);
  api.listeners.deleteListeners(ids).then(function (resp) {
    if (resp && resp.ok) {
      listenerMgrState.selectedIds.clear();
      updateListenerBulkBar();
      refreshListenerList();
      refreshStreamsList();
    } else {
      alert('削除失敗: ' + ((resp && resp.error) || 'unknown'));
    }
  }).catch(function (err) {
    alert('削除エラー: ' + (err && err.message ? err.message : err));
  });
}

// 詳細モーダルの「このリスナーを削除…」ボタンに、確認 → 削除 → モーダル閉鎖 + 一覧再読込 を結線する。
// わんコメ DB は触らないため、わんコメ起動中でも実行可能。streams の集計値は Rust 側で再計算される。
function attachListenerDeleteButton(detail) {
  var btn = document.getElementById('listener-edit-delete');
  var status = document.getElementById('listener-edit-status');
  if (!btn || !api.listeners || !api.listeners.deleteListeners) return;
  btn.addEventListener('click', function () {
    var label = detail.nickname || detail.displayName || detail.channelId;
    var msg =
      '"' + label + '" を削除します。\n\n' +
      'リスナー情報 (表示名・累計値・メモ等) とアバター画像のキャッシュを削除します。\n' +
      'コメント本文 ' + (detail.commentCount || 0) + ' 件は配信履歴として残り、\n' +
      '同じ channel id のリスナーが再登場した場合は自動で再紐付けされます。\n' +
      'タグ・対応済み状態は配信履歴に紐付くため、再登場時にそのまま継承されます。\n' +
      'わんコメ側のデータには影響しません。\n\n' +
      '続行しますか?';
    if (!confirm(msg)) return;
    rendererLog.info('user: listener-detail-delete, channelId=' + detail.channelId);
    btn.disabled = true;
    if (status) status.textContent = '削除中...';
    api.listeners.deleteListeners([detail.channelId]).then(function (resp) {
      btn.disabled = false;
      if (resp && resp.ok) {
        closeListenerDetailModal();
        refreshListenerList();
        refreshStreamsList();
      } else {
        if (status) status.textContent = '削除失敗: ' + ((resp && resp.error) || 'unknown');
      }
    }).catch(function (err) {
      btn.disabled = false;
      if (status) status.textContent = '削除失敗: ' + (err && err.message ? err.message : err);
    });
  });
}

// 詳細モーダルの BAN ボタン。コメント詳細も同じモーダルを使うため、
// コメントタップ・リスナー一覧タップのどちらから開いても同じ操作になる。
// リスナー詳細モーダルの「対応済み」トグル。
// 設計: docs/architecture/remote-viewing-redesign.md §5.5 / §7.1
// 即時 optimistic UI 更新 → API、失敗時はロールバック + エラー Snackbar。
// 成功時は Snackbar を出さない (= 邪魔。戻したければもう一度クリックすれば良い)
function attachListenerGreetedToggle(channelId, streamVideoId) {
  var btn = document.getElementById('ld-greeted-toggle');
  if (!btn || !api.listeners || typeof api.listeners.setGreeted !== 'function') return;
  if (!channelId || !streamVideoId) return;

  btn.addEventListener('click', function () {
    var prev = btn.dataset.greeted === '1';
    var next = !prev;
    rendererLog.info('user: listener-greeted-toggle (detail), channelId=' + channelId + ', streamVideoId=' + streamVideoId + ', greeted=' + next);
    setListenerGreetedDom(btn, next);
    api.listeners.setGreeted(streamVideoId, channelId, next).then(function (resp) {
      if (!resp || !resp.ok) {
        setListenerGreetedDom(btn, !next);
        window.KomehubShared.showUndoSnackbar({
          message: '更新に失敗しました',
          actionLabel: '再試行',
          onAction: function () { btn.click(); }
        });
      }
      // 成功時は無音
    }).catch(function (err) {
      setListenerGreetedDom(btn, !next);
      rendererLog.error('setGreeted failed', err);
    });
  });
}

function setListenerGreetedDom(btn, isGreeted) {
  if (!btn) return;
  btn.dataset.greeted = isGreeted ? '1' : '0';
  var icon = btn.querySelector('.ld-greeted-icon');
  var label = btn.querySelector('.ld-greeted-label');
  // 対応済み時のみ ✓ アイコンを出す。未対応時は icon ノード自体を削除する。
  if (isGreeted) {
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'ld-greeted-icon';
      icon.textContent = '✓';
      btn.insertBefore(icon, label || null);
    } else {
      icon.textContent = '✓';
    }
  } else if (icon) {
    icon.remove();
  }
  if (label) label.textContent = isGreeted ? '対応済み' : '対応';
}

function applyListenerRespondedDom(streamVideoId, channelId, isResponded) {
  var normalized = String(channelId || '').replace(/^yt-/, '');
  if (!normalized) return;
  var selectorId = normalized.replace(/"/g, '\\"');
  // 接続中リスナータブの行
  var items = document.querySelectorAll('.listener-item[data-channel-id="yt-' + selectorId + '"], .listener-item[data-channel-id="' + selectorId + '"]');
  for (var i = 0; i < items.length; i++) {
    if (streamVideoId && currentStreamVideoId && streamVideoId !== currentStreamVideoId) continue;
    items[i].classList.toggle('listener-responded', !!isResponded);
    var btn = items[i].querySelector('.kh-toggle-responded');
    if (btn) btn.dataset.responded = isResponded ? '1' : '0';
  }
  // 配信詳細モーダルのリスナータブの行 (= アーカイブからの閲覧)
  var sdRows = document.querySelectorAll('.sd-listener-row-mgr[data-channel-id="yt-' + selectorId + '"], .sd-listener-row-mgr[data-channel-id="' + selectorId + '"]');
  for (var j = 0; j < sdRows.length; j++) {
    if (streamVideoId && sdState.videoId && streamVideoId !== sdState.videoId) continue;
    sdRows[j].classList.toggle('listener-responded', !!isResponded);
    var sdBtn = sdRows[j].querySelector('.kh-toggle-responded');
    if (sdBtn) sdBtn.dataset.responded = isResponded ? '1' : '0';
  }
}

// 対応済みボタン (= .kh-toggle-responded) のクリックで トグル → API 呼出。
// コメ側 (shared/comment-item.js) と同じ data-responded セマンティクス。
function toggleListenerRespondedBtn(btn, streamVideoId, channelId) {
  if (!btn || !streamVideoId || !channelId) return;
  if (!api.listeners || typeof api.listeners.setGreeted !== 'function') return;
  var prev = btn.dataset.responded === '1';
  var next = !prev;
  rendererLog.info('user: listener-greeted-toggle (list-btn), channelId=' + channelId + ', streamVideoId=' + streamVideoId + ', greeted=' + next);
  applyListenerRespondedDom(streamVideoId, channelId, next);
  api.listeners.setGreeted(streamVideoId, channelId, next).then(function (resp) {
    if (!resp || !resp.ok) {
      applyListenerRespondedDom(streamVideoId, channelId, prev);
      window.KomehubShared.showUndoSnackbar({
        message: '更新に失敗しました',
        actionLabel: '再試行',
        onAction: function () {
          toggleListenerRespondedBtn(btn, streamVideoId, channelId);
        }
      });
      return;
    }
    if (typeof refreshListenerMiniTabCounts === 'function') refreshListenerMiniTabCounts();
  }).catch(function (err) {
    applyListenerRespondedDom(streamVideoId, channelId, prev);
    rendererLog.error('setGreeted failed', err);
  });
}

// SSE 購読: 他端末からの listener-greeted 同期 (= 別 PC / remote で操作した時)
if (api && api.onListenerGreeted) {
  api.onListenerGreeted(function (data) {
    if (!data || !data.listenerChannelId) return;
    applyListenerRespondedDom(data.streamVideoId || '', data.listenerChannelId, data.greetedAt > 0);
    if (typeof refreshListenerMiniTabCounts === 'function') refreshListenerMiniTabCounts();
    // 現在開いているリスナー詳細モーダルが対象なら DOM を更新
    var btn = document.getElementById('ld-greeted-toggle');
    if (!btn) return;
    var btnCh = String(btn.getAttribute('data-channel-id') || '').replace(/^yt-/, '');
    var dataCh = String(data.listenerChannelId || '').replace(/^yt-/, '');
    if (btnCh && dataCh && btnCh !== dataCh) return;
    setListenerGreetedDom(btn, data.greetedAt > 0);
  });
}

// 2026-05-09 仕様変更: 旧 attachListenerBanButton を「コメ非表示 / リスナー非表示」2 軸独立に。
// 演出フィルタは廃止 (= 相手に気付かれない、UI 表示抑制のみ)。両 false なら record 削除。
function attachListenerHideToggles(detail) {
  var commentsBtn = document.getElementById('listener-hide-comments');
  var listenersBtn = document.getElementById('listener-hide-listeners');
  var status = document.getElementById('listener-edit-status');
  if (!commentsBtn || !listenersBtn) return;
  if (!api.listeners || typeof api.listeners.setHidden !== 'function') {
    commentsBtn.disabled = true;
    listenersBtn.disabled = true;
    return;
  }
  var userId = detail.channelId || '';
  if (!userId) {
    commentsBtn.disabled = true;
    listenersBtn.disabled = true;
    if (status) status.textContent = '非表示設定に必要なユーザーIDがありません';
    return;
  }
  setHideToggleDom(commentsBtn, !!detail.hideFromComments);
  setHideToggleDom(listenersBtn, !!detail.hideFromListeners);

  function applyAndPersist(targetBtn, kind) {
    targetBtn.disabled = true;
    var nextHideComments = (kind === 'comments') ? !(commentsBtn.dataset.active === '1')
      : (commentsBtn.dataset.active === '1');
    var nextHideListeners = (kind === 'listeners') ? !(listenersBtn.dataset.active === '1')
      : (listenersBtn.dataset.active === '1');
    rendererLog.info('user: listener-hidden-toggle (detail), userId=' + userId + ', kind=' + kind + ', hideComments=' + nextHideComments + ', hideListeners=' + nextHideListeners);
    Promise.resolve(api.listeners.setHidden(userId, nextHideComments, nextHideListeners)).then(function (res) {
      var resp = (typeof res === 'string') ? JSON.parse(res) : res;
      if (!resp || resp.ok === false) {
        targetBtn.disabled = false;
        if (status) status.textContent = '更新に失敗しました: ' + ((resp && resp.error) || '');
        return;
      }
      setHideToggleDom(commentsBtn, nextHideComments);
      setHideToggleDom(listenersBtn, nextHideListeners);
      if (status) status.textContent = '';
      targetBtn.disabled = false;
    }).catch(function (err) {
      targetBtn.disabled = false;
      if (status) status.textContent = '更新に失敗しました: ' + (err && err.message ? err.message : err);
    });
  }

  commentsBtn.addEventListener('click', function () { applyAndPersist(commentsBtn, 'comments'); });
  listenersBtn.addEventListener('click', function () { applyAndPersist(listenersBtn, 'listeners'); });
}

function setHideToggleDom(btn, isActive) {
  if (!btn) return;
  btn.dataset.active = isActive ? '1' : '0';
  btn.classList.toggle('active', isActive);
}

// Step 3 フェーズ 3.2a: listener-updated runtime event ハンドラ。
// 毎コメント発火するため 500ms debounce + 表示中タブのみ refresh。
// UI 整理 Phase 1: listener-manager-section 廃止 → cl-frame の listeners/streams タブが
// active かどうかで判定するように変更。
function scheduleListenerAutoRefresh() {
  if (listenerAutoRefreshTimer) clearTimeout(listenerAutoRefreshTimer);
  listenerAutoRefreshTimer = setTimeout(function () {
    listenerAutoRefreshTimer = null;
    // 件数バッジ (= cl-tab「リスナー」の +N ピル) は tab 非アクティブでも可視なので
    // 常に更新する。Rust 側 cache が「件数変動時のみ invalidate」なので大半は cache hit
    // で安く済む (Phase 1 最適化 #157 参照)。
    if (typeof refreshListenerMiniTabCounts === 'function') refreshListenerMiniTabCounts();
    // 一覧の再描画は対応する tab がアクティブな時だけ
    if (isClFrameTabActive('listeners') && typeof refreshListenerList === 'function') {
      refreshListenerList();
    } else if (isClFrameTabActive('streams') && typeof refreshStreamsList === 'function') {
      refreshStreamsList();
    }
    // cs (検索) と io (退避中) はユーザー操作トリガなので自動更新しない
  }, 500);
}

// UI 整理 Phase 1: cl-frame の指定タブが active かを判定する helper
function isClFrameTabActive(clTabName) {
  var tab = document.querySelector('.cl-tab[data-cl-tab="' + clTabName + '"]');
  return !!(tab && tab.classList.contains('active'));
}

if (api.onListenerUpdated) {
  api.onListenerUpdated(function () { scheduleListenerAutoRefresh(); });
}

// --- タブ切り替え (UI 整理 Phase 1: cl-tab の active 切替は activateClTab 側で行う。
// ここでは内部 panel (= 旧 listener-mgr-tab-panel の中身) の display 切替のみ担当) ---
function switchListenerTab(tabName) {
  var panels = document.querySelectorAll('.listener-mgr-tab-panel');
  for (var j = 0; j < panels.length; j++) {
    panels[j].style.display = panels[j].getAttribute('data-tab-panel') === tabName ? '' : 'none';
  }
  // streams タブは tab switch 毎に再 fetch する (= 別タブ滞在中に接続した新規配信を
  // 取り逃がさない、 2026-05-23 修正)。 listeners タブ (activateClTab 内) と同じ挙動。
  // 旧仕様 `total === 0` ガードは初回 open でしか fire せず、 2 回目以降の switch では
  // stale cache を表示してしまう ([[project_streams_tab_stale_cache]])
  if (tabName === 'streams') refreshStreamsList();
}

// UI 整理 Phase 1: cl-frame の指定タブを active に切り替える。
// cl-tab 自体の .active 切替 + 各 cl-tab-panel の display 切替 + 旧 listener-mgr 系
// panel が必要なら switchListenerTab 経由で内部 panel (data-tab-panel) も同期。
// mapping: cl-tab[data-cl-tab="cs"] → switchListenerTab('comments') (= 旧名)
function activateClTab(clTabName) {
  if (!clTabName) return;
  // 観点 I: cl-frame タブ切替 (= ホーム / コメ / ギフト / リスナー / アーカイブ 等)
  // をユーザー操作として記録。 詳細: docs/logging.md。
  rendererLog.info('user: cl-tab-switch, tab=' + clTabName);
  var tabs = document.querySelectorAll('.cl-tab');
  for (var i = 0; i < tabs.length; i++) {
    var tn = tabs[i].getAttribute('data-cl-tab');
    if (tn === clTabName) tabs[i].classList.add('active');
    else tabs[i].classList.remove('active');
  }
  var panels = document.querySelectorAll('.cl-tab-panel');
  for (var k = 0; k < panels.length; k++) {
    var pn = panels[k].getAttribute('data-cl-tab');
    if (pn === clTabName) {
      panels[k].classList.add('active');
      panels[k].style.display = '';
    } else {
      panels[k].classList.remove('active');
      panels[k].style.display = 'none';
    }
  }
  // cs-panel (= コメント検索 top-level tab) は legacy listener-mgr-tab-panel の
  // `data-tab-panel="comments"` を流用しているため、cs を選んだ時だけ
  // switchListenerTab('comments') を呼ぶ必要がある (= cs-panel を内部 panel
  // 切替系で active 化)。
  // 注意: top-level "comments" tab (= 配信流入コメ = #comment-list) は
  // listener-mgr-tab-panel ではないので、ここで switchListenerTab を呼ぶと
  // 同じ data-tab-panel="comments" を持つ cs-panel が誤って display='' に
  // 復活する (= 「別タブから戻ると中身がコメント検索になる」バグ)。条件は
  // clTabName ベースで明示的に絞る。
  if (clTabName === 'listeners' || clTabName === 'streams' || clTabName === 'io') {
    switchListenerTab(clTabName);
  } else if (clTabName === 'cs') {
    switchListenerTab('comments');
  } else if (clTabName === 'listener-search') {
    // Phase 2a: 初回タブ open で listener 一覧を fetch (= lazy load)
    listenerSearchEnsureLoaded();
  }

  // listeners タブを開いた瞬間、件数バッジが古いままだと違和感があるので
  // この timing で 1 度更新しておく (= タブ click 時のみ。タブ滞在中は別経路で
  // 更新される)。重い SQL なので頻発させない。
  if (clTabName === 'listeners' && typeof refreshListenerMiniTabCounts === 'function') {
    refreshListenerMiniTabCounts();
    if (typeof refreshListenerList === 'function') refreshListenerList();
  }

  // 別タブから戻ってきた時の最新追従復帰:
  // display:none 中も addComment / appendGiftCard は append し続けるが、
  // 隠れている間 scroll handler が発火しないので autoScrollEnabled の整合が
  // ずれる。再表示直後に「底へ強制スクロール + autoScroll 再有効化」を
  // 行って「最新追従」状態に戻す (= タブ切替で見失わない UX)。
  if (clTabName === 'comments' && commentList) {
    commentList.scrollTop = commentList.scrollHeight;
    autoScrollEnabled = true;
  } else if (clTabName === 'gifts' && giftList) {
    giftList.scrollTop = giftList.scrollHeight;
    giftAutoScrollEnabled = true;
    // 未対応ピルはタブ切替で reset しない (= ユーザーが対応済みトグルを ON
    // するまで残件として残す。配信切替時のみ clearGifts() が 0 リセットする)
  }
  // jump-latest ボタンの表示状態を新タブ基準で再判定
  updateClJumpLatest();
}

// --- インポート / エクスポートタブ ---
function setIoResult(elId, kind, message) {
  var el = document.getElementById(elId);
  if (!el) return;
  el.className = 'io-result show ' + kind;
  el.textContent = message;
}

function runExportJsonl() {
  if (!api.listeners || !api.listeners.exportJsonl) return;
  var btn = document.getElementById('io-export-btn');
  if (btn) btn.disabled = true;
  setIoResult('io-export-result', '', 'エクスポート中…');
  api.listeners.exportJsonl().then(function (resp) {
    if (resp && resp.canceled) {
      setIoResult('io-export-result', 'warn', 'キャンセルしました');
    } else if (resp && resp.ok && resp.summary) {
      var s = resp.summary;
      setIoResult('io-export-result', 'ok',
        '✓ エクスポート完了\n' +
        '  パス: ' + s.outPath + '\n' +
        '  リスナー: ' + s.listenerCount + ' / 配信: ' + s.streamCount + ' / コメント: ' + s.commentCount + '\n' +
        '  ファイルサイズ: ' + (s.bytesWritten || 0).toLocaleString() + ' バイト');
    } else {
      setIoResult('io-export-result', 'err', '✗ エクスポート失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
    }
  }).catch(function (err) {
    setIoResult('io-export-result', 'err', 'エクスポートエラー: ' + (err && err.message ? err.message : err));
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

function runExportToOnecomme() {
  if (!api.listeners || !api.listeners.exportToOnecomme) return;
  var btn = document.getElementById('io-onecomme-export-btn');
  if (btn) btn.disabled = true;
  setIoResult('io-onecomme-export-result', '', 'わんコメ DB へ書き戻し中…');
  api.listeners.exportToOnecomme().then(function (resp) {
    if (resp && resp.canceled) {
      setIoResult('io-onecomme-export-result', 'warn', 'キャンセルしました');
    } else if (resp && resp.skipped) {
      setIoResult('io-onecomme-export-result', 'warn', '⚠ ' + (resp.message || resp.reason));
    } else if (resp && resp.ok && resp.summary) {
      var s = resp.summary;
      if (s.aborted) {
        setIoResult('io-onecomme-export-result', 'warn', '⚠ 書き戻しを中断:\n  ' + (s.warnings || []).join('\n  '));
      } else {
        var msg =
          '✓ わんコメ書き戻し完了\n' +
          '  フォルダ: ' + s.onecommeDir + '\n' +
          '  バックアップ: ' + (s.backupDir || '(なし)') + '\n' +
          '  users: 新規 ' + s.usersNew + ' / 更新 ' + s.usersUpdated + '\n' +
          '  comments: 新規 ' + s.commentsInserted + ' / 重複スキップ ' + s.commentsSkipped;
        if (s.warnings && s.warnings.length > 0) {
          msg += '\n  警告 ' + s.warnings.length + ' 件:';
          for (var i = 0; i < Math.min(5, s.warnings.length); i++) {
            msg += '\n    - ' + s.warnings[i];
          }
        }
        setIoResult('io-onecomme-export-result', s.warnings && s.warnings.length > 0 ? 'warn' : 'ok', msg);
      }
    } else {
      setIoResult('io-onecomme-export-result', 'err', '✗ 書き戻し失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
    }
  }).catch(function (err) {
    setIoResult('io-onecomme-export-result', 'err', 'エラー: ' + (err && err.message ? err.message : err));
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

function runBidirectionalSync() {
  if (!api.listeners || !api.listeners.runBidirectionalSync) return;
  var btn = document.getElementById('io-onecomme-sync-btn');
  if (btn) btn.disabled = true;
  setIoResult('io-onecomme-sync-result', '', '同期中…');
  api.listeners.runBidirectionalSync().then(function (resp) {
    if (resp && resp.canceled) {
      setIoResult('io-onecomme-sync-result', 'warn', 'キャンセルしました');
    } else if (resp && resp.skipped) {
      setIoResult('io-onecomme-sync-result', 'warn', '⚠ ' + (resp.message || resp.reason));
    } else if (resp && (resp.ok || resp.export || resp.import)) {
      // ok=false でも import/export 部分結果があれば表示する。
      // ただし export.aborted は警告扱い (Medium 指摘対応: 「同期完了」を表示しない)
      var exportAborted = resp.export && resp.export.aborted;
      var prefix = resp.ok ? '✓ 同期完了' : '⚠ 同期は警告で終了 (書き戻し中断)';
      var msg = prefix + '\n';
      if (resp.import && resp.import.commentsInserted != null) {
        msg += '  [import] リスナー: 新規 ' + resp.import.listenersNew + ' / 更新 ' + resp.import.listenersUpdated +
               ' / コメント: 新規 ' + resp.import.commentsInserted + ' / フィルタ ' + resp.import.commentsFilteredOtherChannel + '\n';
      }
      if (resp.export && !exportAborted) {
        msg += '  [export] users: 新規 ' + resp.export.usersNew + ' / 更新 ' + resp.export.usersUpdated +
               ' / comments: 新規 ' + resp.export.commentsInserted + ' / 重複 ' + resp.export.commentsSkipped;
        if (resp.export.backupDir) msg += '\n  バックアップ: ' + resp.export.backupDir;
        if (resp.export.warnings && resp.export.warnings.length > 0) {
          msg += '\n  [export] 警告: ' + resp.export.warnings.join(' / ');
        }
      } else if (exportAborted) {
        msg += '  [export] 中断: ' + (resp.export.warnings || []).join(' / ');
      }
      setIoResult('io-onecomme-sync-result', resp.ok ? 'ok' : 'warn', msg);
      // 同期後はリスナー一覧と配信ログを再読込
      if (typeof refreshListenerList === 'function') {
        listenerMgrState.page.offset = 0;
        refreshListenerList();
      }
      if (typeof refreshStreamsList === 'function') {
        streamsState.page.offset = 0;
        refreshStreamsList();
      }
    } else {
      setIoResult('io-onecomme-sync-result', 'err', '✗ 同期失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
    }
  }).catch(function (err) {
    setIoResult('io-onecomme-sync-result', 'err', 'エラー: ' + (err && err.message ? err.message : err));
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

function runImportFromOnecomme() {
  if (!api.listeners || !api.listeners.importFromOnecomme) return;
  var btn = document.getElementById('io-onecomme-import-btn');
  if (btn) btn.disabled = true;
  setIoResult('io-onecomme-import-result', '', 'わんコメ DB を読み込んでいます…');
  api.listeners.importFromOnecomme().then(function (resp) {
    if (resp && resp.canceled) {
      setIoResult('io-onecomme-import-result', 'warn', 'キャンセルしました');
    } else if (resp && resp.ok && resp.summary) {
      var s = resp.summary;
      var msg =
        '✓ わんコメインポート完了\n' +
        '  フォルダ: ' + s.onecommeDir + '\n' +
        '  schema_hash: ' + (s.schemaHash || '').substring(0, 12) + '…\n' +
        '  リスナー: 新規 ' + s.listenersNew + ' / 更新 ' + s.listenersUpdated + '\n' +
        '  配信:     新規 ' + s.streamsNew + ' / 更新 ' + s.streamsUpdated + '\n' +
        '  コメント: 新規 ' + s.commentsInserted + ' / 重複スキップ ' + s.commentsSkipped + '\n' +
        '          / 自チャンネル外 ' + s.commentsFilteredOtherChannel + ' / 不正 ' + s.commentsInvalid;
      if (s.warnings && s.warnings.length > 0) {
        msg += '\n  警告 ' + s.warnings.length + ' 件:';
        for (var i = 0; i < Math.min(5, s.warnings.length); i++) {
          msg += '\n    - ' + s.warnings[i];
        }
        if (s.warnings.length > 5) msg += '\n    ... 他 ' + (s.warnings.length - 5) + ' 件';
      }
      setIoResult('io-onecomme-import-result', s.warnings && s.warnings.length > 0 ? 'warn' : 'ok', msg);
      if (typeof refreshListenerList === 'function') {
        listenerMgrState.page.offset = 0;
        refreshListenerList();
      }
      if (typeof refreshStreamsList === 'function') {
        streamsState.page.offset = 0;
        refreshStreamsList();
      }
    } else {
      setIoResult('io-onecomme-import-result', 'err', '✗ わんコメインポート失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
    }
  }).catch(function (err) {
    setIoResult('io-onecomme-import-result', 'err', 'わんコメインポートエラー: ' + (err && err.message ? err.message : err));
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

function runImportJsonl() {
  if (!api.listeners || !api.listeners.importJsonl) return;
  var btn = document.getElementById('io-import-btn');
  if (btn) btn.disabled = true;
  setIoResult('io-import-result', '', 'インポート中…');
  api.listeners.importJsonl().then(function (resp) {
    if (resp && resp.canceled) {
      setIoResult('io-import-result', 'warn', 'キャンセルしました');
    } else if (resp && resp.ok && resp.summary) {
      var s = resp.summary;
      var msg =
        '✓ インポート完了\n' +
        '  ファイル: ' + s.srcPath + '\n' +
        '  schema_version: ' + (s.schemaVersion != null ? s.schemaVersion : '(meta なし)') + '\n' +
        '  リスナー: 新規 ' + s.listenersNew + ' / 更新 ' + s.listenersUpdated + '\n' +
        '  配信:     新規 ' + s.streamsNew + ' / 更新 ' + s.streamsUpdated + '\n' +
        '  コメント: 新規 ' + s.commentsInserted + ' / 重複スキップ ' + s.commentsSkipped;
      if (s.warnings && s.warnings.length > 0) {
        msg += '\n  警告 ' + s.warnings.length + ' 件:';
        for (var i = 0; i < Math.min(5, s.warnings.length); i++) {
          msg += '\n    - ' + s.warnings[i];
        }
        if (s.warnings.length > 5) msg += '\n    ... 他 ' + (s.warnings.length - 5) + ' 件';
      }
      setIoResult('io-import-result', s.warnings && s.warnings.length > 0 ? 'warn' : 'ok', msg);
      // インポート後はリスナー一覧を再読み込み
      if (typeof refreshListenerList === 'function') {
        listenerMgrState.page.offset = 0;
        refreshListenerList();
      }
      if (typeof refreshStreamsList === 'function') {
        streamsState.page.offset = 0;
        refreshStreamsList();
      }
    } else {
      setIoResult('io-import-result', 'err', '✗ インポート失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
    }
  }).catch(function (err) {
    setIoResult('io-import-result', 'err', 'インポートエラー: ' + (err && err.message ? err.message : err));
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

// --- 配信ログタブ ---
// 配信枠タグの map (videoId → tags[])。refresh の度に listAllStreamTagAssignments
// から再構築。renderStreamsList が参照する。
var streamsTagMap = {};

function refreshStreamsList() {
  if (!api.listeners) return;
  var sortEl = document.getElementById('streams-sort');
  var scopeEl = document.getElementById('streams-scope');
  var sort = sortEl ? sortEl.value : 'startedAt';
  var scope = scopeEl ? scopeEl.value : 'all';
  streamsState.sort = sort;
  streamsState.scope = scope;
  var offset = streamsState.page.offset || 0;
  var query = { sort: sort, scope: scope, limit: 100, offset: offset };
  var loadingEl = document.getElementById('streams-list');
  if (loadingEl && (!streamsState.page || !streamsState.page.rows || streamsState.page.rows.length === 0)) {
    loadingEl.innerHTML = '<div style="padding:24px;text-align:center;color:#5a6a78">配信ログを読み込んでいます。</div>';
  }
  // streams + tag assignments を並行 fetch
  var tagPromise = api.listeners.listAllStreamTagAssignments
    ? api.listeners.listAllStreamTagAssignments()
    : Promise.resolve({ ok: true, assignments: [] });
  Promise.all([api.listeners.streams(query), tagPromise]).then(function (results) {
    var resp = results[0];
    var tagsResp = results[1];
    if (!resp || !resp.ok) {
      var listEl = document.getElementById('streams-list');
      if (listEl) listEl.innerHTML = '<div style="padding:12px;color:#ffb74d">配信一覧の取得に失敗しました: ' + listenerMgrEscape(resp && resp.error ? resp.error : 'unknown') + '</div>';
      return;
    }
    // tag map 更新
    streamsTagMap = {};
    if (tagsResp && tagsResp.ok) {
      var arr = tagsResp.assignments || [];
      for (var i = 0; i < arr.length; i++) {
        var a = arr[i];
        if (!streamsTagMap[a.videoId]) streamsTagMap[a.videoId] = [];
        streamsTagMap[a.videoId].push(a.tag);
      }
    }
    streamsState.page = resp.page;
    if (streamsState.selectedIds && streamsState.selectedIds.size > 0) {
      var visible = new Set((resp.page.rows || []).map(function (row) { return row.videoId; }));
      Array.from(streamsState.selectedIds).forEach(function (id) {
        if (!visible.has(id)) streamsState.selectedIds.delete(id);
      });
    }
    renderStreamsList(resp.page);
  }).catch(function (err) {
    rendererLog.error('listStreams failed', err);
  });
}

function findStreamRowInCurrentPage(videoId) {
  var rows = streamsState.page && streamsState.page.rows ? streamsState.page.rows : [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].videoId === videoId) return rows[i];
  }
  return null;
}

function selectedStreamRows() {
  var rows = streamsState.page && streamsState.page.rows ? streamsState.page.rows : [];
  var selected = [];
  for (var i = 0; i < rows.length; i++) {
    if (streamsState.selectedIds && streamsState.selectedIds.has(rows[i].videoId)) {
      selected.push(rows[i]);
    }
  }
  return selected;
}

function updateStreamsEditControls() {
  var editBtn = document.getElementById('streams-edit-toggle');
  var delBtn = document.getElementById('streams-delete-selected');
  var cancelBtn = document.getElementById('streams-edit-cancel');
  var countEl = document.getElementById('streams-selection-count');
  var n = streamsState.selectedIds ? streamsState.selectedIds.size : 0;
  if (editBtn) {
    editBtn.textContent = streamsState.editMode ? '編集中' : '編集';
    editBtn.classList.toggle('active', !!streamsState.editMode);
  }
  if (delBtn) {
    delBtn.style.display = streamsState.editMode ? '' : 'none';
    delBtn.disabled = n === 0;
  }
  if (cancelBtn) cancelBtn.style.display = streamsState.editMode ? '' : 'none';
  if (countEl) {
    countEl.style.display = streamsState.editMode ? '' : 'none';
    countEl.textContent = n > 0 ? n + ' 件選択中' : '未選択';
  }
}

function setStreamsEditMode(enabled) {
  streamsState.editMode = !!enabled;
  if (!streamsState.editMode && streamsState.selectedIds) streamsState.selectedIds.clear();
  renderStreamsList(streamsState.page);
}

function toggleStreamSelection(videoId, checked) {
  if (!videoId || streamsIsCurrentLive(videoId)) return;
  if (!streamsState.selectedIds) streamsState.selectedIds = new Set();
  if (checked) streamsState.selectedIds.add(videoId);
  else streamsState.selectedIds.delete(videoId);
  updateStreamsEditControls();
  var rowEls = document.querySelectorAll('.stream-item[data-video-id]');
  for (var i = 0; i < rowEls.length; i++) {
    if (rowEls[i].getAttribute('data-video-id') === videoId) {
      rowEls[i].classList.toggle('selected', streamsState.selectedIds.has(videoId));
      break;
    }
  }
}

function deleteSelectedStreamLogs() {
  if (!api.listeners || !api.listeners.deleteStreams) return;
  var rows = selectedStreamRows().filter(function (row) {
    return row && row.videoId && !streamsIsCurrentLive(row.videoId);
  });
  if (rows.length === 0) return;
  openStreamDeleteConfirm(rows);
}

function streamDeleteRowTitle(row) {
  return row && row.title ? row.title : '(タイトル未取得)';
}

function streamDeleteThumbHtml(row) {
  if (!row || !row.videoId) {
    return '<div class="sdc-thumb sdc-thumb-empty">NO IMAGE</div>';
  }
  var localUrl = streamsLocalThumbUrl(row.videoId);
  var cdnUrl = streamsCdnThumbUrl(row.videoId);
  return '<div class="sdc-thumb">' +
    '<img class="stm-thumb-img" src="' + listenerMgrEscape(localUrl) + '" alt="" ' +
      'loading="lazy" data-cdn-url="' + listenerMgrEscape(cdnUrl) + '">' +
    '</div>';
}

function renderStreamDeleteConfirmRows(rows) {
  var listEl = document.getElementById('sdc-list');
  if (!listEl) return;
  if (!rows || rows.length === 0) {
    listEl.innerHTML = '<div class="sdc-empty">削除対象がありません。</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    html += '<div class="sdc-row">' +
      streamDeleteThumbHtml(row) +
      '<div class="sdc-row-body">' +
        '<div class="sdc-row-main">' +
          '<div class="sdc-row-title">' + listenerMgrEscape(streamDeleteRowTitle(row)) + '</div>' +
          '<div class="sdc-row-channel">' +
            '<span>' + listenerMgrEscape(streamChannelName(row)) + '</span>' +
            (streamChannelId(row) ? '<span>' + listenerMgrEscape(streamChannelId(row)) + '</span>' : '') +
          '</div>' +
          '<div class="sdc-row-meta">' +
            '<span>videoId: ' + listenerMgrEscape(row.videoId || '') + '</span>' +
            '<span>開始: ' + listenerMgrEscape(listenerMgrFormatTime(row.startedAt)) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="sdc-row-count">' + (Number(row.commentCount) || 0) + '<span>コメ</span></div>' +
      '</div>' +
    '</div>';
    if (row.videoId && typeof ensureStreamThumbnailCached === 'function') ensureStreamThumbnailCached(row.videoId);
  }
  listEl.innerHTML = html;
  if (typeof attachStreamThumbErrorHandlers === 'function') attachStreamThumbErrorHandlers(listEl);
}

function openStreamDeleteConfirm(rows) {
  var modal = document.getElementById('stream-delete-confirm-modal');
  var summaryEl = document.getElementById('sdc-summary');
  var confirmBtn = document.getElementById('sdc-confirm');
  if (!modal || !summaryEl || !confirmBtn) return;
  var safeRows = (rows || []).filter(function (row) {
    return row && row.videoId && !streamsIsCurrentLive(row.videoId);
  });
  streamsState.pendingDeleteRows = safeRows;
  var totalComments = safeRows.reduce(function (sum, row) {
    return sum + (Number(row.commentCount) || 0);
  }, 0);
  summaryEl.innerHTML =
    '<div class="sdc-summary-item"><span class="num">' + safeRows.length + '</span><span>配信ログ</span></div>' +
    '<div class="sdc-summary-item"><span class="num">' + totalComments + '</span><span>コメント</span></div>';
  renderStreamDeleteConfirmRows(safeRows);
  confirmBtn.disabled = safeRows.length === 0;
  modal.style.display = '';
}

function closeStreamDeleteConfirm() {
  var modal = document.getElementById('stream-delete-confirm-modal');
  if (modal) modal.style.display = 'none';
  streamsState.pendingDeleteRows = [];
}

function confirmStreamDelete() {
  var rows = streamsState.pendingDeleteRows || [];
  if (!rows.length || !api.listeners || !api.listeners.deleteStreams) return;
  var confirmBtn = document.getElementById('sdc-confirm');
  var cancelBtn = document.getElementById('sdc-cancel');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '削除中...';
  }
  if (cancelBtn) cancelBtn.disabled = true;
  var ids = rows.map(function (row) { return row.videoId; });
  api.listeners.deleteStreams(ids).then(function (resp) {
    if (resp && resp.ok) {
      closeStreamDeleteConfirm();
      streamsState.selectedIds.clear();
      streamsState.editMode = false;
      if (sdState && ids.indexOf(sdState.videoId) !== -1) closeStreamDetailModal();
      streamsState.page.offset = Math.max(0, streamsState.page.offset || 0);
      refreshStreamsList();
      refreshListenerList();
      refreshListenerMiniTabCounts();
      if (typeof runCommentSearch === 'function' &&
          commentSearchState.lastResult &&
          commentSearchState.lastResult.rows) {
        runCommentSearch();
      }
    } else {
      alert('配信ログ削除失敗: ' + ((resp && resp.error) || 'unknown'));
    }
  }).catch(function (err) {
    alert('配信ログ削除エラー: ' + (err && err.message ? err.message : err));
  }).finally(function () {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '削除する';
    }
    if (cancelBtn) cancelBtn.disabled = false;
  });
}

function deleteStreamLog(videoId) {
  if (!videoId || !api.listeners || !api.listeners.deleteStreams) return;
  if (streamsIsCurrentLive(videoId)) {
    alert('接続中の配信ログは削除できません。\n先に配信から切断してから削除してください。');
    return;
  }
  var row = findStreamRowInCurrentPage(videoId);
  if (!row && sdState && sdState.detail && sdState.detail.videoId === videoId) {
    row = sdState.detail;
  }
  if (!row) row = { videoId: videoId, title: videoId, startedAt: 0, commentCount: 0 };
  openStreamDeleteConfirm([row]);
}

// 配信時間の表記 (1h45m / 0h45m / 0h05m)。 ended_at が無い時は "—"
function streamsFormatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt || endedAt <= startedAt) return '—';
  var diffMin = Math.floor((endedAt - startedAt) / 60000);
  var h = Math.floor(diffMin / 60);
  var m = diffMin % 60;
  return h + 'h' + (m < 10 ? '0' + m : m) + 'm';
}

function streamsIsCurrentLive(videoId) {
  return !!(isConnected && currentStreamVideoId && videoId === currentStreamVideoId);
}

function streamsIsLive(s) {
  if (!s) return false;
  if (streamsIsCurrentLive(s.videoId)) return true;
  // 既存の暫定判定は残す。DB の ended_at は最終コメント時刻としても使われるため、
  // 現在接続中の枠は videoId を正として LIVE 扱いする。
  return s.endedAt === s.startedAt && (Date.now() - s.startedAt) < 24 * 3600 * 1000;
}

function streamsEffectiveEndedAt(s) {
  if (streamsIsLive(s)) return Date.now();
  return s && s.endedAt ? s.endedAt : 0;
}

// 1245 → "1.2k", 12345 → "12k" の k 表記。¥ 額にも使う。
function streamsCompactNum(n) {
  if (!Number.isFinite(n)) return '—';
  var abs = Math.abs(n);
  if (abs >= 10000) return Math.round(n / 1000) + 'k';
  if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// 配信サムネのローカル / リモート URL を返す。
// img.src のフォールバック cascade: ローカル → CDN → NO-IMAGE SVG
// (NO-IMAGE は data URL なので失敗しない、cascade はここで止まる)
function streamsLocalThumbUrl(videoId) {
  if (!videoId) return '';
  return 'http://127.0.0.1:' + currentPort + '/cache/stream-thumbs/' +
    encodeURIComponent(videoId) + '.jpg';
}
function streamsCdnThumbUrl(videoId) {
  if (!videoId) return '';
  return 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/mqdefault.jpg';
}

// 最終フォールバック (ローカル / CDN ともに 404 / 未 DL のとき)。
// 配信前 (live 化前) や削除済みなど、CDN 自体に thumbnail が無い枠で broken icon
// を出さないために SVG プレースホルダを表示する。viewBox なので任意サイズで縮尺。
var STREAM_NO_IMAGE_URL = "data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 45'>" +
  "<rect width='80' height='45' fill='%231a3a4a'/>" +
  "<text x='40' y='26' font-family='sans-serif' font-size='9' fill='%235a6a78' " +
  "text-anchor='middle' font-weight='700' letter-spacing='1'>NO IMAGE</text>" +
  "</svg>";

// 既に cache 要求を投げた videoId のセット (重複防止)
var streamsThumbCacheTriggered = {};
function ensureStreamThumbnailCached(videoId) {
  if (!videoId || streamsThumbCacheTriggered[videoId]) return;
  if (!api.cacheStreamThumbnail) return;
  streamsThumbCacheTriggered[videoId] = true;
  // fire-and-forget。失敗時は onerror フォールバックで CDN を見せる。
  api.cacheStreamThumbnail(videoId).catch(function () { /* best effort */ });
}

// 配信ページの URL。stream_url が空ならフォールバックで watch URL 直接構築。
function streamsWatchUrl(s) {
  if (s && s.streamUrl) return s.streamUrl;
  if (s && s.videoId) return 'https://www.youtube.com/watch?v=' + s.videoId;
  return '';
}

// thumbnail HTML (3 密度共通の核)
// <img> 構造: src=ローカル URL、error 時の cascade は attachStreamThumbErrorHandlers で
// programmatic に登録 (ローカル → CDN → NO-IMAGE SVG)。
// 同時に ensureStreamThumbnailCached で背景 DL を発火、次回以降ローカルから即時表示。
function buildStreamThumbHtml(s, isLive) {
  var watch = streamsWatchUrl(s);
  var localUrl = streamsLocalThumbUrl(s.videoId);
  var cdnUrl = streamsCdnThumbUrl(s.videoId);
  var liveOverlay = isLive ? '<span class="stm-thumb-live-mark">🔴</span>' : '';
  return '<div class="stm-thumb" data-watch-url="' + listenerMgrEscape(watch) + '" ' +
    'data-video-id="' + listenerMgrEscape(s.videoId) + '" title="ブラウザで配信を開く">' +
      '<img class="stm-thumb-img" src="' + listenerMgrEscape(localUrl) + '" alt="" ' +
        'loading="lazy" data-cdn-url="' + listenerMgrEscape(cdnUrl) + '">' +
      liveOverlay +
    '</div>';
}

// 全 .stm-thumb-img に error cascade ハンドラを attach する。
// step 0 (初期): src = ローカル URL → 失敗時 step 1 (CDN URL) へ
// step 1: src = CDN URL → 失敗時 step 2 (NO-IMAGE SVG) へ。SVG は失敗しないので cascade 終了
function attachStreamThumbErrorHandlers(rootEl) {
  if (!rootEl) return;
  var imgs = rootEl.querySelectorAll('.stm-thumb-img');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    if (img.dataset.errAttached) continue;
    img.dataset.errAttached = '1';
    img.addEventListener('error', function () {
      var step = this.dataset.fbStep || '0';
      if (step === '0') {
        var cdn = this.getAttribute('data-cdn-url') || '';
        if (cdn) {
          this.dataset.fbStep = '1';
          this.src = cdn;
          return;
        }
        // CDN URL 不明 → 直接 NO-IMAGE
        this.dataset.fbStep = '2';
        this.src = STREAM_NO_IMAGE_URL;
      } else if (step === '1') {
        this.dataset.fbStep = '2';
        this.src = STREAM_NO_IMAGE_URL;
      }
      // step === '2': data URL なので失敗しない、ここに来ない
    });
  }
}

// 大 (V2): card + thumb + KPI 4 tile
// 配信枠タグの chip HTML (大/中/小 共通)
function streamTagsHtml(videoId) {
  var tags = streamsTagMap[videoId] || [];
  if (tags.length === 0) return '';
  var parts = '';
  for (var i = 0; i < tags.length; i++) {
    parts += '<span class="stm-tag">' + listenerMgrEscape(tags[i]) + '</span>';
  }
  return '<div class="stm-tags">' + parts + '</div>';
}

function streamChannelName(s) {
  return (s && s.channelName) ? s.channelName : '(チャンネル名未取得)';
}

function streamChannelId(s) {
  return (s && s.ownerChannelId) ? s.ownerChannelId : '';
}

function streamChannelHtml(s) {
  var name = streamChannelName(s);
  var id = streamChannelId(s);
  return '<div class="stm-channel">' +
    '<span class="stm-channel-name">' + listenerMgrEscape(name) + '</span>' +
    (id ? '<span class="stm-channel-id">' + listenerMgrEscape(id) + '</span>' : '') +
    '</div>';
}

function streamSelectionControlHtml(videoId) {
  if (!streamsState.editMode) return '';
  var disabled = streamsIsCurrentLive(videoId);
  var checked = streamsState.selectedIds && streamsState.selectedIds.has(videoId);
  return '<label class="stream-select-wrap" title="' +
    (disabled ? '接続中の配信ログは削除できません' : '削除対象に選択') +
    '">' +
    '<input class="stream-select-box" type="checkbox" data-video-id="' +
    listenerMgrEscape(videoId || '') + '"' +
    (checked ? ' checked' : '') +
    (disabled ? ' disabled aria-disabled="true"' : '') +
    '>' +
    '</label>';
}

function buildStreamItemHtmlLarge(s) {
  var titleText = s.title && s.title.length > 0 ? s.title : '(タイトル未取得)';
  var startedStr = listenerMgrFormatTime(s.startedAt);
  var isLive = streamsIsLive(s);
  var dur = streamsFormatDuration(s.startedAt, streamsEffectiveEndedAt(s));
  var badges = isLive ? '<span class="stm-bg live">● LIVE</span>' : '';

  var commentCount = s.commentCount || 0;
  var scAmount = s.superchatAmountJpy || 0;
  var peak = s.peakConcurrentViewers || 0;
  var likes = s.likes || 0;

  var dataAttr = ' data-video-id="' + listenerMgrEscape(s.videoId) + '"';
  var selectedClass = streamsState.selectedIds && streamsState.selectedIds.has(s.videoId) ? ' selected' : '';
  return '<div class="stream-item d-l' + (streamsState.editMode ? ' editing' : '') + selectedClass + '"' + dataAttr + '>' +
    buildStreamThumbHtml(s, isLive) +
    '<div class="stm-meta">' +
      '<div class="stm-title">' + listenerMgrEscape(titleText) + '</div>' +
      streamChannelHtml(s) +
      '<div class="stm-sub"><span>' + listenerMgrEscape(startedStr) + ' · ' + dur + '</span>' + streamTagsHtml(s.videoId) + '</div>' +
      (badges ? '<div class="stm-badges">' + badges + '</div>' : '') +
    '</div>' +
    (streamsState.editMode ? '<div class="stm-actions">' + streamSelectionControlHtml(s.videoId) + '</div>' : '') +
    '<div class="stm-kpi-grid">' +
      '<div class="stm-kpi"><div class="v cyan">' + commentCount + '</div><div class="l">コメ</div></div>' +
      '<div class="stm-kpi"><div class="v ' + (scAmount > 0 ? 'amber' : 'dim') + '">' +
        (scAmount > 0 ? '¥' + streamsCompactNum(scAmount) : '—') + '</div><div class="l">SC</div></div>' +
      '<div class="stm-kpi"><div class="v ' + (peak > 0 ? '' : 'dim') + '">' +
        (peak > 0 ? streamsCompactNum(peak) : '—') + '</div><div class="l">peak</div></div>' +
      '<div class="stm-kpi"><div class="v ' + (likes > 0 ? '' : 'dim') + '">' +
        (likes > 0 ? streamsCompactNum(likes) : '—') + '</div><div class="l">like</div></div>' +
    '</div>' +
  '</div>';
}

// 中 (V5 改): thumb + KPI 4 列。
// 元々の rank 数字は視覚的価値が薄かったため thumb に差し替え。
// (sort 順は依然存在するが、ランキング金銀銅は廃止して中立化)
function buildStreamItemHtmlMedium(s) {
  var titleText = s.title && s.title.length > 0 ? s.title : '(タイトル未取得)';
  var startedStr = listenerMgrFormatTime(s.startedAt);
  var isLive = streamsIsLive(s);
  var dur = streamsFormatDuration(s.startedAt, streamsEffectiveEndedAt(s));

  var commentCount = s.commentCount || 0;
  var scAmount = s.superchatAmountJpy || 0;
  var peak = s.peakConcurrentViewers || 0;
  var likes = s.likes || 0;

  var dataAttr = ' data-video-id="' + listenerMgrEscape(s.videoId) + '"';
  var selectedClass = streamsState.selectedIds && streamsState.selectedIds.has(s.videoId) ? ' selected' : '';
  return '<div class="stream-item d-m' + (streamsState.editMode ? ' editing' : '') + selectedClass + '"' + dataAttr + '>' +
    buildStreamThumbHtml(s, isLive) +
    '<div class="stm-meta">' +
      '<div class="stm-title">' + listenerMgrEscape(titleText) + '</div>' +
      streamChannelHtml(s) +
      '<div class="stm-sub">' + listenerMgrEscape(startedStr) + ' · ' + dur + streamTagsHtml(s.videoId) + '</div>' +
    '</div>' +
    (streamsState.editMode ? '<div class="stm-actions">' + streamSelectionControlHtml(s.videoId) + '</div>' : '') +
    '<div class="stm-perf">' +
      '<div class="col"><div class="v cyan">' + commentCount + '</div><div class="l">コメ</div></div>' +
      '<div class="col"><div class="v ' + (scAmount > 0 ? 'amber' : 'dim') + '">' +
        (scAmount > 0 ? '¥' + streamsCompactNum(scAmount) : '—') + '</div><div class="l">SC</div></div>' +
      '<div class="col"><div class="v ' + (peak > 0 ? 'green' : 'dim') + '">' +
        (peak > 0 ? streamsCompactNum(peak) : '—') + '</div><div class="l">peak</div></div>' +
      '<div class="col"><div class="v ' + (likes > 0 ? 'pink' : 'dim') + '">' +
        (likes > 0 ? streamsCompactNum(likes) : '—') + '</div><div class="l">like</div></div>' +
    '</div>' +
  '</div>';
}

// 小 (V3): table 行 1 本。先頭にミニ thumb (40x23) を配置。
function buildStreamItemHtmlSmall(s) {
  var titleText = s.title && s.title.length > 0 ? s.title : '(タイトル未取得)';
  var startedStr = listenerMgrFormatTime(s.startedAt);
  var isLive = streamsIsLive(s);
  var dur = streamsFormatDuration(s.startedAt, streamsEffectiveEndedAt(s));
  var commentCount = s.commentCount || 0;
  var scAmount = s.superchatAmountJpy || 0;
  var peak = s.peakConcurrentViewers || 0;
  var likes = s.likes || 0;

  var dataAttr = ' data-video-id="' + listenerMgrEscape(s.videoId) + '"';
  var selectedClass = streamsState.selectedIds && streamsState.selectedIds.has(s.videoId) ? ' selected' : '';
  return '<tr class="stream-item' + selectedClass + '"' + dataAttr + '>' +
    (streamsState.editMode ? '<td class="stream-select-cell">' + streamSelectionControlHtml(s.videoId) + '</td>' : '') +
    '<td class="thumb-cell">' + buildStreamThumbHtml(s, isLive) + '</td>' +
    '<td class="title-cell">' + listenerMgrEscape(titleText) + streamTagsHtml(s.videoId) + '</td>' +
    '<td class="channel-cell">' +
      '<div class="stream-table-channel-name">' + listenerMgrEscape(streamChannelName(s)) + '</div>' +
      '<div class="stream-table-channel-id">' + listenerMgrEscape(streamChannelId(s)) + '</div>' +
    '</td>' +
    '<td class="date-cell num">' + listenerMgrEscape(startedStr) + '</td>' +
    '<td class="num dim">' + dur + '</td>' +
    '<td class="num cyan">' + commentCount + '</td>' +
    '<td class="num ' + (scAmount > 0 ? 'amber' : 'dim') + '">' +
      (scAmount > 0 ? '¥' + streamsCompactNum(scAmount) : '—') + '</td>' +
    '<td class="num ' + (peak > 0 ? 'green' : 'dim') + '">' +
      (peak > 0 ? streamsCompactNum(peak) : '—') + '</td>' +
    '<td class="num ' + (likes > 0 ? 'pink' : 'dim') + '">' +
      (likes > 0 ? streamsCompactNum(likes) : '—') + '</td>' +
  '</tr>';
}

function renderStreamsList(page) {
  var listEl = document.getElementById('streams-list');
  var countEl = document.getElementById('streams-count');
  var pagEl = document.getElementById('streams-pagination');
  var prevBtn = document.getElementById('streams-prev');
  var nextBtn = document.getElementById('streams-next');
  var labelEl = document.getElementById('streams-page-label');
  if (!listEl) return;

  if (countEl) {
    var scopeLabel = streamsState.scope === 'own' ? '自チャンネル ' : (streamsState.scope === 'other' ? '他チャンネル ' : '');
    countEl.textContent = scopeLabel + '全 ' + (page.total || 0) + ' 配信';
  }

  if (!page.rows || page.rows.length === 0) {
    listEl.className = '';
    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:#4a6a7a">'
      + (streamsState.scope === 'own'
        ? '自チャンネルの配信ログはまだありません。<br>自チャンネル設定に登録した配信でコメントが記録されると、ここに表示されます。'
        : streamsState.scope === 'other'
          ? '他チャンネルの配信ログはまだありません。<br>他チャンネル配信に接続すると、表示用に記録されます。'
          : '配信ログはまだありません。<br>配信に接続すると、ここに表示されます。')
      + '</div>';
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  var density = streamsState.density || 'l';
  var html;
  if (density === 's') {
    // table モード: 全行を <table> で wrap
    listEl.className = 'density-s';
    var rows = '';
    for (var si = 0; si < page.rows.length; si++) {
      rows += buildStreamItemHtmlSmall(page.rows[si]);
    }
    html =
      '<table class="stream-table"><thead><tr>' +
        (streamsState.editMode ? '<th class="select-col"></th>' : '') +
        '<th class="thumb-col"></th>' +
        '<th>タイトル</th>' +
        '<th>チャンネル</th>' +
        '<th class="num">日時</th>' +
        '<th class="num">時間</th>' +
        '<th class="num">コメ</th>' +
        '<th class="num">SC</th>' +
        '<th class="num">peak</th>' +
        '<th class="num">like</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  } else if (density === 'm') {
    listEl.className = '';
    html = '';
    for (var mi = 0; mi < page.rows.length; mi++) {
      html += buildStreamItemHtmlMedium(page.rows[mi]);
    }
  } else {
    listEl.className = '';
    html = '';
    for (var li = 0; li < page.rows.length; li++) {
      html += buildStreamItemHtmlLarge(page.rows[li]);
    }
  }
  listEl.innerHTML = html;

  // 行クリック → 配信詳細モーダル (thumb クリックは別 handler で stopPropagation)
  var items = listEl.querySelectorAll('.stream-item');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', function (e) {
      // thumb クリックはブラウザ open に取られるので skip
      if (e.target && e.target.classList && e.target.classList.contains('stm-thumb')) return;
      if (e.target && e.target.closest && e.target.closest('.stream-select-wrap')) return;
      if (streamsState.editMode) {
        var vid = this.getAttribute('data-video-id');
        if (!streamsIsCurrentLive(vid)) {
          toggleStreamSelection(vid, !(streamsState.selectedIds && streamsState.selectedIds.has(vid)));
          var box = this.querySelector('.stream-select-box');
          if (box) box.checked = streamsState.selectedIds.has(vid);
        }
        return;
      }
      openStreamDetail(this.getAttribute('data-video-id'));
    });
  }

  var selectBoxes = listEl.querySelectorAll('.stream-select-box');
  for (var di = 0; di < selectBoxes.length; di++) {
    selectBoxes[di].addEventListener('click', function (e) {
      e.stopPropagation();
      toggleStreamSelection(this.getAttribute('data-video-id'), this.checked);
    });
  }

  // thumb クリック → ブラウザで配信 URL を open (行クリックは抑制)
  var thumbs = listEl.querySelectorAll('.stm-thumb');
  for (var ti = 0; ti < thumbs.length; ti++) {
    thumbs[ti].addEventListener('click', function (e) {
      e.stopPropagation();
      var url = this.getAttribute('data-watch-url');
      if (url && api.openExternal) api.openExternal(url);
    });
  }

  // <img> error cascade (local → CDN → NO-IMAGE) ハンドラ登録
  attachStreamThumbErrorHandlers(listEl);

  // 表示中の各 stream について thumb のローカル DL を fire-and-forget で発火する
  // (重複 trigger は streamsThumbCacheTriggered で防止)。
  // 次回以降の表示は media-cache から即時、初回も <img onerror> で CDN フォールバック。
  for (var ri = 0; ri < page.rows.length; ri++) {
    ensureStreamThumbnailCached(page.rows[ri].videoId);
  }

  var totalPages = Math.max(1, Math.ceil(page.total / page.limit));
  var currentPage = Math.floor(page.offset / page.limit) + 1;
  if (totalPages > 1) {
    if (pagEl) pagEl.style.display = '';
    if (labelEl) labelEl.textContent = currentPage + ' / ' + totalPages + ' ページ';
    if (prevBtn) prevBtn.disabled = page.offset <= 0;
    if (nextBtn) nextBtn.disabled = (page.offset + page.limit) >= page.total;
  } else {
    if (pagEl) pagEl.style.display = 'none';
  }
  updateStreamsEditControls();
}

// ───────────────── 配信詳細モーダル (Hero + 6 KPI + Tags + 3 Tabs) ─────────────────
//
// mock: test/probe/stream-detail-final.html
// データ: get_stream_detail (Hero/KPI) + search_comments (コメント tab で virtualization) +
//         list_stream_listeners (リスナー tab) + get_stream_stats (統計 tab)。
// 状態は sdState に集約。close 時に teardown。
//
var sdState = {
  videoId: null,
  detail: null,
  // リスナータブ lazy load 状態 (= 1000 listeners + heatmap で重いので必要時に fetch)
  listenersPage: null,
  listenersStatus: 'idle',  // idle / loading / ready / error
  // 統計タブ lazy load 状態
  stats: null,
  statsStatus: 'idle',
  // コメント tab: chunked lazy load 状態
  allCommentRows: [],
  commentsLoaded: 0,
  commentsTotal: 0,
  commentsFetching: false,
  commentsFetchSeq: 0,     // filter 変更で in-flight 結果を破棄するための世代番号
  chipCounts: null,        // {all, sc, member, firstTime, veteran}
  commentFilter: 'all',    // all / sc / member / first / veteran / body
  commentBodyQ: '',
  commentBodyTimer: null,  // body 検索 input の debounce
  virtCtrl: null,
  listenerSearchTimer: null,
  listenerQuery: { text_q: '', name_q: '', body_q: '', system_tags: [], user_tags: [], member_join_only: false },
  // system pill (新規/新参/常連/古参/復帰/新メンバー) 件数。Rust 側 list_stream_listener_pill_counts
  // が name_q/body_q/user_tags を適用しつつ system_tags/member_join_only を無視した
  // 全 audience の集計値を返す (= ページング独立)。
  // null = まだ fetch していない、{all, firstTime, returning, regular, veteran, comeback, memberJoined}
  listenerPillCounts: null,
  prevVirtScrollContainer: null,
  scrollHandler: null,
};

// 1 chunk あたりの fetch 件数。virtualization の BUFFER_ROWS=30 を上回る量にする
// (= 1 chunk で viewport を確実に埋めて、scroll で次が間に合うように)。
var SD_COMMENT_CHUNK_SIZE = 200;

function openStreamDetail(videoId) {
  if (!api.listeners || !videoId) return;
  // 観点 I: モーダル open を user 操作として記録
  rendererLog.info('user: open-stream-detail-modal, videoId=' + videoId);
  // 開く度に classificationCache を再取得 → 設定を別所で変更されても rank 計算が追従する
  // (= 設定画面 → モーダル間で値がドリフトしないようにする保険)
  refreshClassificationCache();
  // 状態リセット
  sdState.videoId = videoId;
  sdState.detail = null;
  sdState.listenersPage = null;
  sdState.listenersStatus = 'idle';
  sdState.stats = null;
  sdState.statsStatus = 'idle';
  sdState.allCommentRows = [];
  sdState.commentsLoaded = 0;
  sdState.commentsTotal = 0;
  sdState.commentsFetching = false;
  sdState.commentsFetchSeq = 0;
  sdState.chipCounts = null;
  sdState.commentFilter = 'all';
  sdState.commentBodyQ = '';
  sdState.listenerQuery = { text_q: '', name_q: '', body_q: '', system_tags: [], user_tags: [], member_join_only: false };
  sdState.listenerPillCounts = null;

  var modal = document.getElementById('stream-detail-modal');
  if (modal) modal.style.display = '';

  // 並行 fetch (= 初期表示に必要な最小セット):
  //   - streamDetail (Hero / KPI 用、軽い)
  //   - 1 chunk 目の searchComments (= chunked lazy load 用、SD_COMMENT_CHUNK_SIZE 件)
  //   - commentChipCounts (chip 表示用 5 種 COUNT、軽い)
  // streamListeners は重いので lazy load (= リスナータブ初表示時に fetch)。
  // streamStats は重いので lazy load (= 統計タブ初表示時に fetch)。
  var firstChunkQuery = sdBuildSearchQuery('all', '');
  firstChunkQuery.limit = SD_COMMENT_CHUNK_SIZE;
  firstChunkQuery.offset = 0;
  Promise.all([
    api.listeners.streamDetail(videoId, 1),
    api.listeners.searchComments(firstChunkQuery),
    api.listeners.commentChipCounts(videoId),
  ]).then(function (results) {
    var detail = results[0] && results[0].ok ? results[0].detail : null;
    var commentsPage = results[1] && results[1].ok ? results[1].page : null;
    var chipCountsResp = results[2] && results[2].ok ? results[2].counts : null;
    if (!detail) {
      sdShowError('配信詳細が取得できませんでした');
      return;
    }
    sdState.detail = detail;
    var firstRows = (commentsPage && commentsPage.rows) || [];
    for (var i = 0; i < firstRows.length; i++) sdState.allCommentRows.push(firstRows[i]);
    sdState.commentsLoaded = sdState.allCommentRows.length;
    sdState.commentsTotal = (commentsPage && commentsPage.total) || sdState.commentsLoaded;
    sdState.chipCounts = chipCountsResp || null;
    renderStreamDetailModal();
  }).catch(function (err) {
    rendererLog.error('openStreamDetail failed', err);
    sdShowError('配信詳細エラー: ' + (err && err.message ? err.message : err));
  });
}

// 現在 filter / bodyQ / video から CommentsQuery を組み立てる。
// 「メンバー」「新規」「古参」「SC のみ」はサーバ側 filter (= chunk 内で再 filter する必要なし)。
// 「未対応」はリモート閲覧 redesign §5.3 の filter (= responded_at = 0)。
// 「本文検索」は bodyQ パラメータで送る。
function sdBuildSearchQuery(filter, bodyQ) {
  var q = { streamIds: [sdState.videoId], scope: 'all' };
  if (filter === 'sc') {
    q.commentTypes = ['superchat', 'sticker', 'gift'];
  } else if (filter === 'member') {
    q.memberOnly = true;
  } else if (filter === 'first') {
    q.systemTags = ['first-time'];
  } else if (filter === 'veteran') {
    q.systemTags = ['veteran'];
  } else if (filter === 'unresponded') {
    q.unrespondedOnly = true;
  } else if (filter === 'body') {
    var trimmed = (bodyQ || '').trim();
    if (trimmed) q.bodyQ = trimmed;
  }
  return q;
}

// 現在の filter / bodyQ で次の chunk を fetch して allCommentRows に append。
// commentsFetchSeq で in-flight の世代を管理し、filter 変更時に古い結果を破棄する。
function sdLoadCommentsChunk() {
  if (sdState.commentsFetching) return Promise.resolve();
  if (sdState.commentsLoaded > 0 && sdState.commentsLoaded >= sdState.commentsTotal) {
    return Promise.resolve();
  }
  if (!sdState.videoId) return Promise.resolve();
  sdState.commentsFetching = true;
  var seq = sdState.commentsFetchSeq;
  var q = sdBuildSearchQuery(sdState.commentFilter, sdState.commentBodyQ);
  q.limit = SD_COMMENT_CHUNK_SIZE;
  q.offset = sdState.commentsLoaded;
  return api.listeners.searchComments(q).then(function (resp) {
    if (sdState.commentsFetchSeq !== seq) return; // filter が変わった = 破棄
    sdState.commentsFetching = false;
    if (!resp || !resp.ok || !resp.page) return;
    var newRows = resp.page.rows || [];
    for (var i = 0; i < newRows.length; i++) sdState.allCommentRows.push(newRows[i]);
    sdState.commentsLoaded = sdState.allCommentRows.length;
    sdState.commentsTotal = resp.page.total;
    if (sdState.virtCtrl) sdState.virtCtrl.notifyDataExtended();
  }).catch(function (err) {
    if (sdState.commentsFetchSeq !== seq) return;
    sdState.commentsFetching = false;
    rendererLog.error('sdLoadCommentsChunk failed', err);
  });
}

// filter / bodyQ 変更で chunked load をリセットして 1 chunk 目から再 fetch。
function sdResetAndReloadComments() {
  // 世代番号を増やして in-flight 中の結果を破棄
  sdState.commentsFetchSeq += 1;
  sdState.commentsFetching = false;
  sdState.allCommentRows = [];
  sdState.commentsLoaded = 0;
  sdState.commentsTotal = 0;
  if (sdState.virtCtrl) {
    sdState.virtCtrl.destroy();
    sdState.virtCtrl = null;
  }
  // virtualization 描画前に loading placeholder を出す
  var bodyEl = document.getElementById('sd-comment-list');
  if (bodyEl) {
    bodyEl.innerHTML = '<div style="padding:16px 8px;color:#5a6a78;font-size:11px;text-align:center">読み込み中…</div>';
  }
  sdLoadCommentsChunk().then(function () {
    sdRefreshCommentList();
  });
}

// modal-content の scroll が末端付近に来たら次 chunk を fetch する。
// scroll handler から rAF 経由で呼ばれる。
function sdMaybeLoadMoreComments() {
  if (!sdState.virtCtrl) return;
  if (sdState.commentsFetching) return;
  if (sdState.commentsLoaded >= sdState.commentsTotal) return;
  // コメ tab がアクティブでなければ scroll しても意味がない (= リスナー / 統計が表示中)
  var activePane = document.querySelector('.sd-tab-pane.active');
  if (!activePane || activePane.dataset.tabPane !== 'comments') return;
  var modalContent = document.getElementById('stream-detail-modal-content');
  if (!modalContent) return;
  var scrollBottom = modalContent.scrollTop + modalContent.clientHeight;
  // 末端から 800px 手前で次 chunk を取得開始 (= ユーザーが空白に到達する前に間に合わせる)
  var trigger = modalContent.scrollHeight - 800;
  if (scrollBottom >= trigger) sdLoadCommentsChunk();
}

function sdEffectiveDuration(detail) {
  if (!detail) return 0;
  var end = sdIsLiveDetail(detail)
    ? Date.now()
    : (detail.endedAt && detail.endedAt > 0 ? detail.endedAt : Date.now());
  return Math.max(0, end - (detail.startedAt || 0));
}

function sdIsLiveDetail(detail) {
  if (!detail) return false;
  if (typeof streamsIsCurrentLive === 'function' && streamsIsCurrentLive(detail.videoId)) return true;
  return !detail.endedAt || detail.endedAt === 0;
}

// 短い枠 (~30 分以下) は 5 分、中程度 (~3 時間以下) は 15 分、長い枠は 30 分。
function sdComputeBinMinutes(durationMs) {
  var hours = durationMs / (60 * 60 * 1000);
  if (hours <= 0.5) return 5;
  if (hours <= 3) return 15;
  return 30;
}

function sdShowError(message) {
  var content = document.getElementById('stream-detail-modal-content');
  if (content) {
    content.innerHTML = '<div style="padding:24px;color:#ef9a9a">' +
      listenerMgrEscape(message) +
      '<br><br><button class="sd-action-btn" id="sd-error-close">閉じる</button></div>';
    var btn = document.getElementById('sd-error-close');
    if (btn) btn.onclick = closeStreamDetailModal;
  }
}

function renderStreamDetailModal() {
  var detail = sdState.detail;
  if (!detail) return;

  sdRenderHero(detail);
  sdRenderKpi(detail);
  sdRenderTags(detail);
  sdRenderTabs(detail);
  sdRenderCommentTab();
  // リスナータブ / 統計タブは lazy load なので、ここでは描画しない (= idle 状態)。
  // タブクリック時に sdEnsureListenersLoaded / sdEnsureStatsLoaded が走り、
  // 取得完了後に sdRenderListenerFilters/List / sdRenderStatsTab が呼ばれる。
  sdWireHeroActions();
  sdInstallVirtualScroll();
  sdSwitchTab('comments');
}

function sdRenderHero(detail) {
  var thumbEl = document.getElementById('sd-thumb');
  if (thumbEl) {
    thumbEl.innerHTML = '';
    if (detail.videoId) {
      // ローカルキャッシュ優先 → CDN フォールバック → NO-IMAGE プレースホルダ。
      // Google CDN への直アクセスを避けるため、配信ログと同じ cascade を再利用する。
      var img = document.createElement('img');
      img.className = 'stm-thumb-img';
      img.src = (typeof streamsLocalThumbUrl === 'function') ? streamsLocalThumbUrl(detail.videoId) : '';
      img.alt = '';
      img.dataset.cdnUrl = (typeof streamsCdnThumbUrl === 'function') ? streamsCdnThumbUrl(detail.videoId) : '';
      thumbEl.appendChild(img);
      if (typeof attachStreamThumbErrorHandlers === 'function') attachStreamThumbErrorHandlers(thumbEl);
      // バックグラウンド DL 発火 (= 次回開いた時にローカルから即時表示)。
      if (typeof ensureStreamThumbnailCached === 'function') ensureStreamThumbnailCached(detail.videoId);
    } else {
      var ph = document.createElement('div');
      ph.className = 'sd-thumb-placeholder';
      ph.textContent = '▶';
      thumbEl.appendChild(ph);
    }
  }

  var statusEl = document.getElementById('sd-status-badge');
  if (statusEl) {
    var isLive = sdIsLiveDetail(detail);
    statusEl.className = 'sd-status-badge ' + (isLive ? 'live' : 'ended');
    statusEl.innerHTML = '<span class="dot"></span>' + (isLive ? 'LIVE' : '配信終了');
  }
  var deleteBtn = document.getElementById('sd-delete-stream');
  if (deleteBtn) {
    var deletingCurrent = streamsIsCurrentLive(detail.videoId);
    deleteBtn.disabled = deletingCurrent;
    deleteBtn.title = deletingCurrent
      ? '接続中の配信ログは削除できません'
      : 'この配信ログを削除';
  }

  var dateEl = document.getElementById('sd-date');
  if (dateEl) dateEl.textContent = sdFormatStreamDate(detail);
  var durEl = document.getElementById('sd-duration');
  if (durEl) durEl.textContent = sdFormatDuration(sdEffectiveDuration(detail));

  var titleEl = document.getElementById('sd-title');
  if (titleEl) titleEl.textContent = detail.title || detail.videoId;

  var chEl = document.getElementById('sd-channel');
  if (chEl) {
    chEl.innerHTML = '';
    var icon = document.createElement('span');
    icon.className = 'ch-icon';
    if (detail.channelIconUrl) {
      var iconImg = document.createElement('img');
      iconImg.src = detail.channelIconUrl;
      iconImg.alt = '';
      icon.appendChild(iconImg);
    } else {
      icon.textContent = (detail.channelName || ' ').charAt(0);
    }
    var name = document.createElement('span');
    name.className = 'ch-name';
    name.textContent = detail.channelName || '(unknown)';
    chEl.appendChild(icon);
    chEl.appendChild(name);
    var ownerHandle = sdResolveOwnerHandle(detail.ownerChannelId);
    if (ownerHandle) {
      var sep = document.createElement('span');
      sep.style.color = '#5a6a78';
      sep.textContent = '·';
      var handle = document.createElement('span');
      handle.style.color = '#94a3b8';
      handle.textContent = '@' + ownerHandle;
      chEl.appendChild(sep);
      chEl.appendChild(handle);
    }
  }
}

function sdResolveOwnerHandle(channelId) {
  if (!channelId) return '';
  var stripped = String(channelId).replace(/^yt-/, '');
  var channels = (typeof listenerMgrState !== 'undefined' && listenerMgrState.ownerChannels) || [];
  for (var i = 0; i < channels.length; i++) {
    if (channels[i].channelId === stripped && channels[i].handle) return channels[i].handle;
  }
  return '';
}

// 渡された channelId が「自分の設定済み配信チャンネル」のどれかと一致するかを判定。
// 過去枠を開いた時 (stream-detail-modal 等) に「これは自枠だったか」を知るために使う。
// 現接続の自枠フラグ (= global isOwnStream) とは別軸。
function isOwnerChannelConfigured(channelId) {
  if (!channelId) return false;
  var stripped = String(channelId).replace(/^yt-/, '');
  var channels = (typeof listenerMgrState !== 'undefined' && listenerMgrState.ownerChannels) || [];
  for (var i = 0; i < channels.length; i++) {
    if (channels[i].channelId === stripped) return true;
  }
  return false;
}

function sdFormatStreamDate(detail) {
  if (!detail.startedAt) return '';
  var d = new Date(detail.startedAt);
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var weekDay = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  var base = d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
    ' (' + weekDay + ') ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (!sdIsLiveDetail(detail) && detail.endedAt && detail.endedAt > 0) {
    var e = new Date(detail.endedAt);
    base += ' – ' + pad(e.getHours()) + ':' + pad(e.getMinutes());
  }
  return base;
}

function sdFormatDuration(ms) {
  if (!ms || ms <= 0) return '';
  var totalMin = Math.floor(ms / 60000);
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  return h + ':' + (m < 10 ? '0' + m : m);
}

function sdRenderKpi(detail) {
  var grid = document.getElementById('sd-kpi-grid');
  if (!grid) return;
  var durMs = sdEffectiveDuration(detail);
  var durMin = durMs > 0 ? durMs / 60000 : 0;
  var commentCount = detail.commentCount || 0;
  var amount = detail.superchatAmountJpy || 0;
  var unique = detail.uniqueCommenters || 0;
  var likes = detail.likes || 0;
  var peakViewers = detail.peakConcurrentViewers || 0;
  var commentsPerMin = durMin > 0 ? (commentCount / durMin) : 0;
  var amountPerSc = (detail.superchatCount || 0) > 0 ? Math.round(amount / detail.superchatCount) : 0;
  var commentsPerListener = unique > 0 ? (commentCount / unique) : 0;
  var startTimeText = '';
  if (detail.startedAt) {
    var d = new Date(detail.startedAt);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    startTimeText = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' 開始';
  }

  grid.innerHTML = '';
  function tile(label, valHtml, valClass, subHtml) {
    var t = document.createElement('div');
    t.className = 'sd-kpi-tile';
    t.innerHTML =
      '<div class="sd-kpi-label">' + listenerMgrEscape(label) + '</div>' +
      '<div class="sd-kpi-value' + (valClass ? ' ' + valClass : '') + '">' + valHtml + '</div>' +
      (subHtml ? '<div class="sd-kpi-sub">' + subHtml + '</div>' : '');
    grid.appendChild(t);
  }
  tile('コメント',
    String(commentCount) + '<span class="unit">件</span>',
    '',
    commentsPerMin > 0 ? '<span class="v2">' + commentsPerMin.toFixed(1) + '</span> 件/分' : '');
  tile('金額',
    '¥' + amount.toLocaleString(),
    'amber',
    amountPerSc > 0 ? 'avg <span class="v2 amber">¥' + amountPerSc.toLocaleString() + '</span> /件' : '');
  tile('コメントリスナー',
    String(unique) + '<span class="unit">人</span>',
    'dim',
    commentsPerListener > 0 ? '<span class="v2">' + commentsPerListener.toFixed(1) + '</span> 件/人' : '');
  tile('いいね', likes.toLocaleString(), 'pink', '');
  tile('ピーク同接', peakViewers > 0 ? peakViewers.toLocaleString() : '—', 'green', '');
  tile('配信時間', sdFormatDuration(durMs) || '—', 'dim', startTimeText);
}

function sdRenderTags(detail) {
  var tagsRoot = document.getElementById('stream-detail-tags');
  if (!tagsRoot) return;
  tagsRoot.dataset.videoId = detail.videoId;
  tagsRoot.innerHTML = '<span class="ld-tag-loading" style="font-size:11px;color:#5a6a78">読み込み中…</span>';
  attachStreamTagEditor({ videoId: detail.videoId });
}

function sdRenderTabs(detail) {
  // コメント数は chipCounts.all (= サーバ側で COUNT 済の正しい総数)。
  // chunked load の都合で allCommentRows は部分ロード済 (= 200 件) なので使えない。
  var commentCount = (sdState.chipCounts && sdState.chipCounts.all) ||
    (detail && detail.commentCount) || 0;
  // リスナー数は detail.uniqueCommenters (= streamDetail に元から入っている、
  // streamListeners の lazy load を待たずに表示できる)。
  var listenerCount = (detail && detail.uniqueCommenters) || 0;
  var commentCt = document.getElementById('sd-tab-ct-comments');
  if (commentCt) commentCt.textContent = String(commentCount);
  var listenerCt = document.getElementById('sd-tab-ct-listeners');
  if (listenerCt) listenerCt.textContent = String(listenerCount);
}

function sdSwitchTab(name) {
  var tabs = document.querySelectorAll('#sd-tabs .sd-tab');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].dataset.tab === name) tabs[i].classList.add('active');
    else tabs[i].classList.remove('active');
  }
  var panes = document.querySelectorAll('.sd-tab-body .sd-tab-pane');
  for (var j = 0; j < panes.length; j++) {
    if (panes[j].dataset.tabPane === name) panes[j].classList.add('active');
    else panes[j].classList.remove('active');
  }
  // 統計タブ初表示 (= idle) のときに lazy load
  if (name === 'stats' && sdState.statsStatus === 'idle') sdEnsureStatsLoaded();
  // リスナータブ初表示 (= idle) のときに lazy load
  if (name === 'listeners' && sdState.listenersStatus === 'idle') sdEnsureListenersLoaded();
  // virtualization 表示状態が変わるので window 再計算
  if (sdState.virtCtrl) sdState.virtCtrl.updateWindow();
}

// リスナータブ用 lazy load。1000 listeners + heatmap で重いため、タブ初表示で fetch する。
function sdEnsureListenersLoaded() {
  if (!sdState.detail || !sdState.videoId) return;
  if (sdState.listenersStatus === 'loading' || sdState.listenersStatus === 'ready') return;
  sdState.listenersStatus = 'loading';
  sdShowListenersLoading();
  var videoIdAtFetch = sdState.videoId;
  // pill 件数は別 RPC (= ページング独立で全 audience 集計) と並行 fetch する
  api.listeners.streamListenerPillCounts(videoIdAtFetch, {}).then(function (resp) {
    if (sdState.videoId !== videoIdAtFetch) return;
    if (resp && resp.ok && resp.counts) {
      sdState.listenerPillCounts = resp.counts;
      sdRenderListenerFilters();
    }
  }).catch(function (err) {
    rendererLog.error('streamListenerPillCounts initial fetch failed', err);
  });
  api.listeners.streamListeners(videoIdAtFetch, {
    sort: 'countDesc',
    limit: 1000,
    offset: 0,
  }).then(function (resp) {
    if (sdState.videoId !== videoIdAtFetch) return; // 別の枠が開かれた = 結果破棄
    if (resp && resp.ok && resp.page) {
      sdState.listenersPage = resp.page;
      sdState.listenersStatus = 'ready';
      sdShowListenersContent();
      sdRenderListenerFilters();
      sdRenderListenerList();
    } else {
      sdState.listenersStatus = 'error';
      sdShowListenersError((resp && resp.error) || 'リスナーデータが返りませんでした');
    }
  }).catch(function (err) {
    if (sdState.videoId !== videoIdAtFetch) return;
    sdState.listenersStatus = 'error';
    sdShowListenersError(err && err.message ? err.message : String(err));
  });
}

function sdShowListenersLoading() {
  var loading = document.getElementById('sd-listeners-loading');
  var error = document.getElementById('sd-listeners-error');
  var content = document.getElementById('sd-listeners-content');
  if (loading) loading.style.display = '';
  if (error) error.style.display = 'none';
  if (content) content.style.display = 'none';
}
function sdShowListenersContent() {
  var loading = document.getElementById('sd-listeners-loading');
  var error = document.getElementById('sd-listeners-error');
  var content = document.getElementById('sd-listeners-content');
  if (loading) loading.style.display = 'none';
  if (error) error.style.display = 'none';
  if (content) content.style.display = '';
}
function sdShowListenersError(message) {
  var loading = document.getElementById('sd-listeners-loading');
  var error = document.getElementById('sd-listeners-error');
  var content = document.getElementById('sd-listeners-content');
  if (loading) loading.style.display = 'none';
  if (content) content.style.display = 'none';
  if (error) {
    error.style.display = '';
    error.textContent = 'リスナー一覧の取得に失敗しました: ' + (message || '');
  }
}

// 統計タブ用の lazy load。idle → loading → ready / error の状態遷移。
// 別の枠が開かれた場合 (= sdState.videoId 変化) は応答を破棄する。
function sdEnsureStatsLoaded() {
  if (!sdState.detail || !sdState.videoId) return;
  if (sdState.statsStatus === 'loading' || sdState.statsStatus === 'ready') return;
  sdState.statsStatus = 'loading';
  sdShowStatsLoading();
  var videoIdAtFetch = sdState.videoId;
  var binMinutes = sdComputeBinMinutes(sdEffectiveDuration(sdState.detail));
  api.listeners.streamStats(videoIdAtFetch, binMinutes).then(function (resp) {
    if (sdState.videoId !== videoIdAtFetch) return; // 別の枠が開かれた = 結果破棄
    if (resp && resp.ok && resp.stats) {
      sdState.stats = resp.stats;
      sdState.statsStatus = 'ready';
      sdShowStatsSections();
      sdRenderStatsTab();
    } else {
      sdState.statsStatus = 'error';
      sdShowStatsError((resp && resp.error) || '統計データが返りませんでした');
    }
  }).catch(function (err) {
    if (sdState.videoId !== videoIdAtFetch) return;
    sdState.statsStatus = 'error';
    sdShowStatsError(err && err.message ? err.message : String(err));
  });
}

function sdShowStatsLoading() {
  var loading = document.getElementById('sd-stats-loading');
  var error = document.getElementById('sd-stats-error');
  var sections = document.getElementById('sd-stats-sections');
  if (loading) loading.style.display = '';
  if (error) error.style.display = 'none';
  if (sections) sections.style.display = 'none';
}
function sdShowStatsSections() {
  var loading = document.getElementById('sd-stats-loading');
  var error = document.getElementById('sd-stats-error');
  var sections = document.getElementById('sd-stats-sections');
  if (loading) loading.style.display = 'none';
  if (error) error.style.display = 'none';
  if (sections) sections.style.display = '';
}
function sdShowStatsError(message) {
  var loading = document.getElementById('sd-stats-loading');
  var error = document.getElementById('sd-stats-error');
  var sections = document.getElementById('sd-stats-sections');
  if (loading) loading.style.display = 'none';
  if (sections) sections.style.display = 'none';
  if (error) {
    error.style.display = '';
    error.textContent = '統計の取得に失敗しました: ' + (message || '');
  }
}

// ─── コメント tab ───
// chip 数は sdState.chipCounts (= get_comment_chip_counts の結果) から取る。
// chunked lazy load では allCommentRows が partial なので、行集計から chip 数を
// 出すと正確な総数が出ない (= chip 数は別 SQL で 1 回計算済 = 1 SQL で済む軽量経路)。
function sdRenderCommentTab() {
  var c = sdState.chipCounts || { all: 0, sc: 0, member: 0, firstTime: 0, veteran: 0, unresponded: 0 };
  var streamIsOwn = sdState.detail
    ? isOwnerChannelConfigured(sdState.detail.ownerChannelId)
    : false;
  var ownOnlyChipIds = ['first', 'veteran', 'unresponded'];
  if (!streamIsOwn && ownOnlyChipIds.indexOf(sdState.commentFilter) !== -1) {
    sdState.commentFilter = 'all';
  }
  var chips = [
    { id: 'all', label: 'すべて', count: c.all },
    { id: 'sc', label: 'SC のみ', count: c.sc, klass: 'amber' },
    { id: 'member', label: 'メンバー', count: c.member },
    { id: 'first', label: '新規', count: c.firstTime },
    { id: 'veteran', label: '古参', count: c.veteran },
    // リモート閲覧 redesign §5.3: 「未対応」chip (= responded_at = 0)
    { id: 'unresponded', label: '未対応', count: c.unresponded },
    { id: 'body', label: '本文検索 ⌕', count: null },
  ];
  var chipsRow = document.getElementById('sd-comment-filter-chips');
  if (chipsRow) {
    chipsRow.innerHTML = '';
    for (var ci = 0; ci < chips.length; ci++) {
      var chip = chips[ci];
      if (!streamIsOwn && ownOnlyChipIds.indexOf(chip.id) !== -1) continue;
      var span = document.createElement('span');
      span.className = 'sd-filter-chip' + (chip.klass ? ' ' + chip.klass : '');
      span.dataset.chipId = chip.id;
      if (sdState.commentFilter === chip.id) span.classList.add('active');
      span.textContent = chip.label;
      if (chip.count !== null) {
        var ct = document.createElement('span');
        ct.className = 'ct';
        ct.textContent = String(chip.count);
        span.appendChild(ct);
      }
      (function (id) {
        span.addEventListener('click', function () {
          if (sdState.commentFilter === id && id !== 'body') return; // 同じ chip を連打しても何もしない
          sdState.commentFilter = id;
          sdState.commentBodyQ = '';
          var sr = document.getElementById('sd-comment-search-row');
          if (sr) sr.style.display = (id === 'body') ? '' : 'none';
          var inp = document.getElementById('sd-comment-search-input');
          if (inp) inp.value = '';
          sdRenderCommentTab(); // chip active 再描画
          sdResetAndReloadComments();
        });
      }(chip.id));
      chipsRow.appendChild(span);
    }
  }
  // 初回 render 時は allCommentRows に既に 1 chunk 目が入っているので virtualization セットアップ
  sdRefreshCommentList();
}

// virtualization controller を allCommentRows でセットアップ (or 再セットアップ)。
// chunked lazy load なので、ここでフィルタ適用は不要 (= サーバ側が filter 済 rows のみ返している)。
function sdRefreshCommentList() {
  var bodyEl = document.getElementById('sd-comment-list');
  if (!bodyEl) return;
  if (sdState.virtCtrl) {
    sdState.virtCtrl.destroy();
    sdState.virtCtrl = null;
  }
  bodyEl.innerHTML = '';
  if (sdState.allCommentRows.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'padding:16px 8px;color:#5a6a78;font-size:11px;text-align:center';
    empty.textContent = sdState.commentsTotal === 0
      ? '該当するコメントはありません'
      : '読み込み中…';
    bodyEl.appendChild(empty);
    return;
  }
  // この配信枠が自分の配信 (= 設定済み owner channel) かを判定して、
  // 「対応済み」トグルの表示可否を決める。global isOwnStream (= 現接続の状態)
  // ではなく、過去枠そのものの所有者で判定するのが正解。
  var streamIsOwn = sdState.detail
    ? isOwnerChannelConfigured(sdState.detail.ownerChannelId)
    : false;
  sdState.virtCtrl = setupLazyCommentRender(bodyEl, sdState.allCommentRows, { streamIsOwn: streamIsOwn });
  sdState.virtCtrl.notifyDataExtended();
}

// ─── リスナー tab ───
function sdRenderListenerFilters() {
  var page = sdState.listenersPage;
  var rows = (page && page.rows) || [];
  // system pill 件数は Rust 側 list_stream_listener_pill_counts が返す集計値を直接使う。
  // ページング (= limit 1000) と独立に、全 audience に対して計算済 (= 1000 人超の枠でも正確)。
  // 仕様の Single Source of Truth は Rust (= memory project_rust_sidecar.md
  // 「コアロジック変更は core/ 配下。Electron 側は IPC ハンドラと UI 描画のみ」)。
  // pillCounts が null (= 初回 fetch 前) の場合は 0 表示 (= 表示開始直後の短時間のみ)。
  var pc = sdState.listenerPillCounts || { all: 0, firstTime: 0, returning: 0, regular: 0, veteran: 0, comeback: 0, memberJoined: 0 };
  var sysCounts = {
    all: pc.all || 0,
    'first-time': pc.firstTime || 0,
    returning: pc.returning || 0,
    regular: pc.regular || 0,
    veteran: pc.veteran || 0,
    comeback: pc.comeback || 0,
    memberJoin: pc.memberJoined || 0,
  };
  // userTagsCounts (= per stream の listener_tags 集計、絞り込み結果との intersection)
  var userCounts = {};
  for (var i = 0; i < rows.length; i++) {
    var ut = rows[i].userTags || [];
    for (var u = 0; u < ut.length; u++) {
      userCounts[ut[u]] = (userCounts[ut[u]] || 0) + 1;
    }
  }

  var sysContainer = document.getElementById('sd-listener-system-tags');
  if (sysContainer) {
    sysContainer.innerHTML = '';
    // 他チャンネル枠 (= owner_channels 外の配信) では 5 ランク評価が意味を持たないので
    // 5 ランク pill (新規/新参/常連/古参/復帰) を非表示。「すべて」「新メンバー」のみ残す。
    var sdIsOwn = (sdState.detail
      ? isOwnerChannelConfigured(sdState.detail.ownerChannelId)
      : true);
    // pill.kind: 'system' = system_tags 配列に対する toggle / 'memberJoin' = 別軸の bool フィルタ。
    // 「すべて」は両方クリアする (= active 判定も system_tags 空 + member_join_only=false 両方)。
    var sysPills = [
      { id: '', kind: 'all', label: 'すべて', count: sysCounts.all },
    ];
    if (sdIsOwn) {
      sysPills.push(
        { id: 'first-time', kind: 'system', label: '新規', count: sysCounts['first-time'] },
        { id: 'returning', kind: 'system', label: '新参', count: sysCounts.returning },
        { id: 'regular', kind: 'system', label: '常連', count: sysCounts.regular },
        { id: 'veteran', kind: 'system', label: '古参', count: sysCounts.veteran },
        { id: 'comeback', kind: 'system', label: '復帰', count: sysCounts.comeback }
      );
    }
    sysPills.push(
      { id: 'memberJoin', kind: 'memberJoin', label: '新メンバー', count: sysCounts.memberJoin }
    );
    for (var s = 0; s < sysPills.length; s++) {
      var sp = sysPills[s];
      var pill = document.createElement('span');
      pill.className = 'tag-pill';
      var allActive = sdState.listenerQuery.system_tags.length === 0 && !sdState.listenerQuery.member_join_only;
      var pillActive;
      if (sp.kind === 'all') pillActive = allActive;
      else if (sp.kind === 'memberJoin') pillActive = !!sdState.listenerQuery.member_join_only;
      else pillActive = sdState.listenerQuery.system_tags.indexOf(sp.id) >= 0;
      if (pillActive) pill.classList.add('active');
      pill.textContent = sp.label;
      var sct = document.createElement('span');
      sct.className = 'ct';
      sct.textContent = String(sp.count);
      pill.appendChild(sct);
      (function (id, kind) {
        pill.addEventListener('click', function () {
          // システム pill 行 (= すべて / 新規 / 新参 / 常連 / 古参 / 新メンバー) は
          // single-select。user tag pill は別 row で multi-select のまま。
          // 既に active の pill を再クリック → 「すべて」に戻る (= deselect として動作)。
          if (kind === 'all') {
            sdState.listenerQuery.system_tags = [];
            sdState.listenerQuery.member_join_only = false;
          } else if (kind === 'memberJoin') {
            if (sdState.listenerQuery.member_join_only) {
              sdState.listenerQuery.member_join_only = false;
            } else {
              sdState.listenerQuery.member_join_only = true;
              sdState.listenerQuery.system_tags = []; // system tag と排他
            }
          } else {
            var alreadyActive =
              sdState.listenerQuery.system_tags.length === 1 &&
              sdState.listenerQuery.system_tags[0] === id;
            if (alreadyActive) {
              sdState.listenerQuery.system_tags = [];
            } else {
              sdState.listenerQuery.system_tags = [id];
              sdState.listenerQuery.member_join_only = false; // memberJoin と排他
            }
          }
          sdRefreshListenersFromServer();
        });
      }(sp.id, sp.kind));
      sysContainer.appendChild(pill);
    }
  }

  var userContainer = document.getElementById('sd-listener-user-tags');
  if (userContainer) {
    userContainer.innerHTML = '';
    var userTagNames = Object.keys(userCounts).sort();
    if (userTagNames.length === 0) {
      var empty = document.createElement('span');
      empty.style.cssText = 'font-size:10px;color:#5a6a78';
      empty.textContent = 'タグ未付与';
      userContainer.appendChild(empty);
    } else {
      for (var p = 0; p < userTagNames.length; p++) {
        var tagName = userTagNames[p];
        var pill2 = document.createElement('span');
        pill2.className = 'tag-pill user';
        if (sdState.listenerQuery.user_tags.indexOf(tagName) >= 0) pill2.classList.add('active');
        pill2.textContent = tagName;
        var uct = document.createElement('span');
        uct.className = 'ct';
        uct.textContent = String(userCounts[tagName]);
        pill2.appendChild(uct);
        (function (name) {
          pill2.addEventListener('click', function () {
            var idx = sdState.listenerQuery.user_tags.indexOf(name);
            if (idx >= 0) sdState.listenerQuery.user_tags.splice(idx, 1);
            else sdState.listenerQuery.user_tags.push(name);
            sdRefreshListenersFromServer();
          });
        }(tagName));
        userContainer.appendChild(pill2);
      }
    }
  }

  var searchInput = document.getElementById('sd-listener-search');
  if (searchInput) {
    // text_q (= 横断検索: name OR body) を使う。 旧 name_q + body_q を別々に
    // セットしていた挙動は AND 結合バグ (= 「セレス」が名前にあって本文に
    // 無いリスナーが除外される) を生むので、 text_q 1 本に集約 (2026-05-14)。
    searchInput.value = sdState.listenerQuery.text_q || '';
    searchInput.oninput = function () {
      var v = this.value.trim();
      if (sdState.listenerSearchTimer) clearTimeout(sdState.listenerSearchTimer);
      sdState.listenerSearchTimer = setTimeout(function () {
        sdState.listenerQuery.text_q = v;
        sdRefreshListenersFromServer();
      }, 250);
    };
  }
}

function sdRefreshListenersFromServer() {
  if (!sdState.videoId) return;
  // pill の active 状態は state 変更直後に即時反映したい (= server fetch を待たない)。
  // count は古い rows ベースで計算されるが、サーバ応答後に再描画して最新化する。
  sdRenderListenerFilters();
  var qDisplay = {
    sort: 'countDesc',
    limit: 1000,
    offset: 0,
    textQ: sdState.listenerQuery.text_q || undefined,
    systemTags: sdState.listenerQuery.system_tags,
    userTags: sdState.listenerQuery.user_tags,
    memberJoinOnly: !!sdState.listenerQuery.member_join_only,
  };
  api.listeners.streamListeners(sdState.videoId, qDisplay).then(function (resp) {
    if (!resp || !resp.ok) return;
    sdState.listenersPage = resp.page;
    sdRenderListenerList();
    sdRenderListenerFilters();
  }).catch(function (err) {
    rendererLog.error('streamListeners refresh failed', err);
  });
  // system pill 件数: 別 RPC で全 audience 集計を取得 (= ページング独立)。
  // text_q (= 名前 OR 本文) と user_tags は適用、 system_tags / member_join_only は無視
  // (= 切替候補を見せる)。
  api.listeners.streamListenerPillCounts(sdState.videoId, {
    textQ: sdState.listenerQuery.text_q || undefined,
    userTags: sdState.listenerQuery.user_tags,
  }).then(function (resp) {
    if (!resp || !resp.ok) return;
    sdState.listenerPillCounts = resp.counts || null;
    sdRenderListenerFilters();
  }).catch(function (err) {
    rendererLog.error('streamListenerPillCounts refresh failed', err);
  });
}

function sdRenderListenerList() {
  var listEl = document.getElementById('sd-listener-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  var rows = (sdState.listenersPage && sdState.listenersPage.rows) || [];
  if (rows.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'padding:16px 8px;color:#5a6a78;font-size:11px;text-align:center';
    empty.textContent = '該当するリスナーはいません';
    listEl.appendChild(empty);
    sdRenderListenerSummary();
    return;
  }
  for (var i = 0; i < rows.length; i++) {
    listEl.appendChild(sdBuildListenerRow(rows[i]));
  }
  sdRenderListenerSummary();
}

function sdBuildListenerRow(row) {
  var listener = row.listener;
  // ランク判定の Single Source of Truth は Rust 側 (= StreamListenerRow.systemTag)。
  // 他チャンネル枠ではランクラベル非表示 (= 自チャンネル群基準の評価値は不適切)
  var systemTag = row.systemTag || '';
  var rowIsOwn = sdState.detail ? isOwnerChannelConfigured(sdState.detail.ownerChannelId) : true;
  var systemLabel = rowIsOwn ? systemTagLabel(systemTag) : '';

  var node = document.createElement('div');
  node.className = 'sd-listener-row-mgr';
  node.dataset.channelId = listener.channelId;
  if ((row.perStreamScAmountJpy || 0) > 0) node.classList.add('current-sc');
  var canToggleResponded = !!(sdState.videoId && rowIsOwn);
  var isResponded = (listener.greetedAt || 0) > 0;
  if (canToggleResponded) node.classList.add('has-response-check');
  if (isResponded) node.classList.add('listener-responded');

  // 対応済みボタンは末尾に append する (= コメ側 .kh-toggle-responded と同じ右端配置)。
  // ボタン本体は av の前に作っておいて、 最後の appendChild で右端に置く。
  var respondedBtn = null;
  if (canToggleResponded) {
    respondedBtn = document.createElement('button');
    respondedBtn.type = 'button';
    respondedBtn.className = 'kh-toggle-responded';
    respondedBtn.title = '対応済みにする / 戻す';
    respondedBtn.textContent = '✓';
    respondedBtn.dataset.responded = isResponded ? '1' : '0';
    respondedBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleListenerRespondedBtn(respondedBtn, sdState.videoId, listener.channelId);
    });
  }

  var av = document.createElement('span');
  av.className = 'lst-av' + (listener.isMember ? ' is-member' : '');
  if (listener.iconUrl) {
    var img = document.createElement('img');
    img.src = listener.iconUrl;
    img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = (listener.displayName || ' ').charAt(0);
  }
  node.appendChild(av);

  var main = document.createElement('div');
  main.className = 'lst-main';
  var nameRow = document.createElement('div');
  nameRow.className = 'lst-name-row';
  var primary = document.createElement('span');
  primary.className = 'primary';
  primary.textContent = listener.nickname || listener.displayName || '(unknown)';
  nameRow.appendChild(primary);
  // secondary (= @ハンドル) は手動別名 (nickname) 設定済みで primary と内容が異なる時のみ表示。
  // YouTube は表示名カスタム未設定の視聴者を author chip に `@xxx` 1 文字列で返してくるため、
  // 通常は primary == username で重複表示になる。 username は既に `@` 込みでそのまま使う。
  if (listener.nickname && listener.username) {
    var sec = document.createElement('span');
    sec.className = 'secondary';
    sec.textContent = listener.username;
    nameRow.appendChild(sec);
  }
  if (listener.isMember) {
    var memBg = document.createElement('span');
    memBg.className = 'lst-bg is-member';
    memBg.textContent = '👑 ' + (listener.memberMonthsMax || 0) + 'mo';
    nameRow.appendChild(memBg);
  }
  if (systemLabel) {
    var sysClass = (systemTag === 'first-time') ? 'first'
      : (systemTag === 'returning') ? 'returning'
      : (systemTag === 'veteran') ? 'veteran'
      : (systemTag === 'comeback') ? 'comeback' : '';
    var sysBg = document.createElement('span');
    sysBg.className = 'lst-bg tag-system' + (sysClass ? ' ' + sysClass : '');
    sysBg.textContent = systemLabel;
    nameRow.appendChild(sysBg);
  }
  // この枠でメンバー加入したリスナーには独立バッジを追加 (= 既存システムタグと並列、
  // first-time / returning とは独立軸)。継続記念 (= comment_type='membership_milestone')
  // は対象外で、新規加入だけ立てる。
  if (row.perStreamMemberJoined) {
    var mjBg = document.createElement('span');
    mjBg.className = 'lst-bg tag-member-join';
    mjBg.textContent = 'メンバー加入';
    nameRow.appendChild(mjBg);
  }
  var userTags = row.userTags || [];
  for (var t = 0; t < userTags.length; t++) {
    var ub = document.createElement('span');
    ub.className = 'lst-bg tag-user';
    ub.textContent = userTags[t];
    nameRow.appendChild(ub);
  }
  if (listener.notes) {
    var notes = document.createElement('span');
    notes.className = 'notes-inline';
    notes.textContent = listener.notes;
    nameRow.appendChild(notes);
  }
  main.appendChild(nameRow);

  var metaRow = document.createElement('div');
  metaRow.className = 'lst-meta-row';
  var when = document.createElement('span');
  when.className = 'when';
  when.textContent = listenerMgrFormatTime(row.perStreamLastAt);
  metaRow.appendChild(when);
  if (listener.lastCommentBody || listener.lastCommentHtml) {
    var lc = document.createElement('span');
    lc.className = 'last-cmt';
    lc.title = listener.lastCommentBody || '';
    lc.innerHTML = listener.lastCommentHtml || listenerMgrEscape(listener.lastCommentBody || '');
    metaRow.appendChild(lc);
  }
  main.appendChild(metaRow);
  node.appendChild(main);

  var heat = document.createElement('div');
  heat.className = 'lst-heatmap';
  var bins = row.heatmapBins || [];
  var maxCount = 0;
  for (var b = 0; b < bins.length; b++) if (bins[b].count > maxCount) maxCount = bins[b].count;
  for (var bb = 0; bb < bins.length; bb++) {
    var cell = document.createElement('span');
    cell.className = 'cell';
    if (bins[bb].count > 0) {
      if (bins[bb].hasSc) cell.classList.add('sc');
      else if (maxCount > 0) {
        var ratio = bins[bb].count / maxCount;
        cell.classList.add(ratio > 0.66 ? 'l3' : ratio > 0.33 ? 'l2' : 'l1');
      }
    }
    heat.appendChild(cell);
  }
  node.appendChild(heat);

  var stat = document.createElement('div');
  stat.className = 'lst-stat';
  var count = document.createElement('div');
  count.className = 'count';
  count.textContent = String(row.perStreamCommentCount || 0);
  stat.appendChild(count);
  var sccur = document.createElement('div');
  sccur.className = 'sc-cur';
  sccur.textContent = (row.perStreamScAmountJpy || 0) > 0
    ? '¥' + Number(row.perStreamScAmountJpy).toLocaleString() : '';
  stat.appendChild(sccur);
  if ((listener.superchatAmountJpy || 0) > 0) {
    var sctot = document.createElement('div');
    sctot.className = 'sc-tot';
    sctot.textContent = '累計 ¥' + Number(listener.superchatAmountJpy).toLocaleString();
    stat.appendChild(sctot);
  }
  node.appendChild(stat);

  // 対応済みボタンは行の末尾に置く (= コメ側 .kh-toggle-responded と同じ右端配置)。
  if (respondedBtn) node.appendChild(respondedBtn);

  node.addEventListener('click', function () {
    if (typeof openListenerDetail === 'function') {
      // 配信詳細モーダル経由で開く場合、当該モーダルの枠を「この枠」filter の context にする
      // (= ライブ接続中の枠ではなく、ユーザーが見ている枠の集計を出すため)
      openListenerDetail(listener.channelId, {
        contextStreamVideoId: sdState.videoId,
        contextStreamIsOwn: rowIsOwn
      });
    }
  });
  return node;
}

function sdRenderListenerSummary() {
  var sumEl = document.getElementById('sd-listener-summary');
  if (!sumEl) return;
  var page = sdState.listenersPage;
  var n = page ? (page.total || (page.rows ? page.rows.length : 0)) : 0;
  var allCount = sdState.detail ? (sdState.detail.uniqueCommenters || 0) : 0;
  var sysSel = sdState.listenerQuery.system_tags;
  var userSel = sdState.listenerQuery.user_tags;
  var nameQ = sdState.listenerQuery.name_q;
  var memberJoinOnly = !!sdState.listenerQuery.member_join_only;
  var hasFilter = sysSel.length > 0 || userSel.length > 0 || memberJoinOnly || (nameQ && nameQ !== '');
  if (!hasFilter) {
    sumEl.innerHTML = 'この配信のコメントリスナー <b>' + n + '</b> 人';
  } else {
    var parts = [];
    if (sysSel.length > 0) parts.push(sysSel.map(systemTagLabel).join(' / '));
    if (memberJoinOnly) parts.push('新メンバー');
    if (userSel.length > 0) parts.push(userSel.join(' / '));
    if (nameQ) parts.push('検索: ' + nameQ);
    var summary = '条件「' + parts.map(function (p) {
      return '<b>' + listenerMgrEscape(p) + '</b>';
    }).join('」∩「') + '」に一致 ';
    sumEl.innerHTML = summary + '<b>' + n + '</b> 人 / この配信の全 ' + allCount + ' 人';
  }
}

// ─── 統計 tab ───
function sdRenderStatsTab() {
  var stats = sdState.stats;
  if (!stats) return;
  sdRenderStatsFreq(stats);
  sdRenderStatsCumulative(stats);
  sdRenderStatsComposition(stats);
  sdRenderStatsTopWords(stats);
  sdRenderStatsMisc(stats);
}

function sdRenderStatsFreq(stats) {
  var titleEl = document.getElementById('sd-stats-freq-title');
  if (titleEl) titleEl.textContent = 'コメント頻度 (' + stats.binMinutes + ' 分刻み)';
  var bars = document.getElementById('sd-stats-freq-bars');
  var axis = document.getElementById('sd-stats-freq-axis');
  var summary = document.getElementById('sd-stats-freq-summary');
  if (!bars || !axis || !summary) return;
  bars.innerHTML = '';
  axis.innerHTML = '';
  summary.innerHTML = '';
  var bins = stats.commentFreqBins || [];
  if (bins.length === 0) return;
  var maxCount = 0;
  for (var i = 0; i < bins.length; i++) if (bins[i].count > maxCount) maxCount = bins[i].count;
  for (var b = 0; b < bins.length; b++) {
    var bar = document.createElement('div');
    bar.className = 'bar' + (bins[b].hasPeak ? ' peak' : '');
    var h = maxCount > 0 ? (bins[b].count / maxCount * 100) : 0;
    bar.style.height = Math.max(2, h) + '%';
    bar.title = bins[b].count + ' 件';
    bars.appendChild(bar);
  }
  // axis: bin 数 > 10 のとき間引き
  var step = Math.max(1, Math.ceil(bins.length / 10));
  for (var a = 0; a <= bins.length; a += step) {
    var sp = document.createElement('span');
    var binStartMs = a < bins.length
      ? bins[a].binStartMs
      : (bins[bins.length - 1].binStartMs + stats.binMinutes * 60000);
    sp.textContent = sdFormatTimeOfDay(binStartMs);
    axis.appendChild(sp);
  }
  var peakBin = null;
  for (var p = 0; p < bins.length; p++) if (bins[p].hasPeak) { peakBin = bins[p]; break; }
  if (peakBin && peakBin.count > 0) {
    summary.innerHTML = 'ピーク: <b>' + sdFormatTimeOfDay(peakBin.binStartMs) +
      ' – ' + sdFormatTimeOfDay(peakBin.binStartMs + stats.binMinutes * 60000) +
      '</b> (' + peakBin.count + ' 件 / ' + stats.binMinutes + ' 分)';
  }
}

function sdRenderStatsCumulative(stats) {
  var bars = document.getElementById('sd-stats-cumulative-bars');
  var axis = document.getElementById('sd-stats-cumulative-axis');
  var totalEl = document.getElementById('sd-stats-cumulative-total');
  var summary = document.getElementById('sd-stats-cumulative-summary');
  if (!bars || !axis || !totalEl || !summary) return;
  bars.innerHTML = '';
  axis.innerHTML = '';
  var cum = stats.cumulativeUniqueBins || [];
  var bins = stats.commentFreqBins || [];
  if (cum.length === 0) {
    totalEl.textContent = '';
    summary.innerHTML = '';
    return;
  }
  var maxVal = cum[cum.length - 1] || 1;
  for (var i = 0; i < cum.length; i++) {
    var bar = document.createElement('div');
    bar.className = 'bar cumulative';
    var h = maxVal > 0 ? (cum[i] / maxVal * 100) : 0;
    bar.style.height = Math.max(2, h) + '%';
    bars.appendChild(bar);
  }
  totalEl.textContent = maxVal + ' 人 (= 100%)';
  var step = Math.max(1, Math.ceil(bins.length / 10));
  for (var a = 0; a <= bins.length; a += step) {
    var sp = document.createElement('span');
    var binStartMs = a < bins.length
      ? bins[a].binStartMs
      : (bins[bins.length - 1].binStartMs + stats.binMinutes * 60000);
    sp.textContent = sdFormatTimeOfDay(binStartMs);
    axis.appendChild(sp);
  }
  if (cum.length >= 2) {
    var earlyIdx = Math.floor(cum.length / 4);
    var earlyVal = cum[earlyIdx] || 0;
    var pct = maxVal > 0 ? Math.round(earlyVal / maxVal * 100) : 0;
    summary.innerHTML = '序盤 (~' + Math.round(stats.binMinutes * (earlyIdx + 1)) + ' 分) で <b>' +
      earlyVal + ' 人 (' + pct + '%)</b> が登場';
  }
}

function sdFormatTimeOfDay(ms) {
  var d = new Date(ms);
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function sdRenderStatsComposition(stats) {
  var box = document.getElementById('sd-stats-composition');
  if (!box) return;
  box.innerHTML = '';
  // 他チャンネル枠 (= owner_channels 外の配信) では 5 ランク評価が意味を持たない
  // (= 自チャンネル群の audience 履歴で常連/古参/復帰を測るため)。composition 表示を抑制。
  var detail = sdState && sdState.detail;
  var isOwn = detail ? isOwnerChannelConfigured(detail.ownerChannelId) : true;
  if (!isOwn) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  var c = stats.composition || { firstTime: 0, returning: 0, regular: 0, veteran: 0, comeback: 0 };
  var total = (c.firstTime || 0) + (c.returning || 0) + (c.regular || 0) + (c.veteran || 0) + (c.comeback || 0);
  if (total === 0) return;
  var entries = [
    { id: 'first', label: '新規', count: c.firstTime || 0 },
    { id: 'returning', label: '新参', count: c.returning || 0 },
    { id: 'regular', label: '常連', count: c.regular || 0 },
    { id: 'veteran', label: '古参', count: c.veteran || 0 },
    { id: 'comeback', label: '復帰', count: c.comeback || 0 },
  ];
  for (var i = 0; i < entries.length; i++) {
    var r = entries[i];
    var pct = total > 0 ? Math.round(r.count / total * 100) : 0;
    var row = document.createElement('div');
    row.className = 'sd-comp-row';
    row.innerHTML =
      '<span class="label-' + r.id + '">' + r.label + '</span>' +
      '<div class="bar-track"><div class="bar-fill ' + r.id + '" style="width:' + (total > 0 ? r.count / total * 100 : 0) + '%"></div></div>' +
      '<span class="pct label-' + r.id + '">' + r.count + ' (' + pct + '%)</span>';
    box.appendChild(row);
  }
}

function sdRenderStatsTopWords(stats) {
  var box = document.getElementById('sd-stats-top-words');
  if (!box) return;
  box.innerHTML = '';
  var words = stats.topWords || [];
  if (words.length === 0) {
    box.innerHTML = '<div style="font-size:10px;color:#5a6a78">頻出語が抽出できませんでした (= テキスト本文が少ない / 全て stopword)</div>';
    return;
  }
  var topCount = words[0].count || 1;
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    var pct = (w.count / topCount * 100);
    var row = document.createElement('div');
    row.className = 'sd-word-row';
    row.innerHTML =
      '<span class="rank">' + (i + 1) + '.</span>' +
      '<span class="word' + (i === 0 ? ' top' : '') + '">' + listenerMgrEscape(w.word) + '</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="count' + (i === 0 ? ' top' : '') + '">' + w.count + '</span>';
    box.appendChild(row);
  }
}

function sdRenderStatsMisc(stats) {
  var box = document.getElementById('sd-stats-misc');
  if (!box) return;
  box.innerHTML = '';
  var detail = sdState.detail;
  if (!detail) return;
  var leftCol = document.createElement('div');
  var rightCol = document.createElement('div');
  function row(col, key, valHtml, valClass) {
    var r = document.createElement('div');
    r.className = 'sd-stats-row';
    r.innerHTML = '<span class="key">' + listenerMgrEscape(key) +
      '</span><span class="val' + (valClass ? ' ' + valClass : '') + '">' + valHtml + '</span>';
    col.appendChild(r);
  }
  var ytUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(detail.videoId);
  row(leftCol, 'video_id', listenerMgrEscape(detail.videoId), 'dim');
  row(leftCol, '配信URL',
    '<a href="#" data-yt="' + listenerMgrEscape(ytUrl) + '">youtube.com/watch?v=' +
    listenerMgrEscape(detail.videoId) + ' ↗</a>');
  row(leftCol, '登録者',
    detail.subscriberCount > 0 ? Number(detail.subscriberCount).toLocaleString() + ' 人' : '—', 'dim');
  row(leftCol, 'いいね', Number(detail.likes || 0).toLocaleString());
  row(leftCol, '最大同接', Number(detail.peakConcurrentViewers || 0).toLocaleString());

  var unique = detail.uniqueCommenters || 0;
  var peak = detail.peakConcurrentViewers || 0;
  var engageText = peak > 0 ? (unique / peak * 100).toFixed(1) + '%' : '—';
  var avgInterval = (stats.misc && stats.misc.avgCommentIntervalSec) || 0;
  var avgLength = (stats.misc && stats.misc.avgCommentLengthChars) || 0;
  row(rightCol, 'エンゲージ率', engageText);
  row(rightCol, 'avg コメ間隔', avgInterval > 0 ? avgInterval.toFixed(1) + ' 秒' : '—');
  row(rightCol, 'avg コメ長', avgLength > 0 ? avgLength.toFixed(1) + ' 文字' : '—');
  row(rightCol, 'メンバー加入', Number((stats.misc && stats.misc.memberJoins) || 0) + ' 人');
  row(rightCol, '新規リスナー', Number((stats.misc && stats.misc.newListeners) || 0) + ' 人', 'green');

  box.appendChild(leftCol);
  box.appendChild(rightCol);

  var links = box.querySelectorAll('a[data-yt]');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (e) {
      e.preventDefault();
      var url = this.getAttribute('data-yt');
      if (api && api.openExternal) api.openExternal(url);
      else window.open(url, '_blank');
    });
  }
}

// ─── Hero アクション + タブクリック + 本文検索 input のワイヤリング ───
function sdWireHeroActions() {
  function openYouTube() {
    if (!sdState.detail || !sdState.detail.videoId) return;
    var url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(sdState.detail.videoId);
    if (api && api.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  }
  var openBtn = document.getElementById('sd-open-yt');
  if (openBtn) openBtn.onclick = openYouTube;
  var thumbEl = document.getElementById('sd-thumb');
  if (thumbEl) thumbEl.onclick = openYouTube;

  var searchBtn = document.getElementById('sd-search-this');
  if (searchBtn) searchBtn.onclick = function () {
    var videoId = sdState.detail && sdState.detail.videoId;
    if (!videoId) return;
    closeStreamDetailModal();
    if (typeof commentSearchState !== 'undefined' && commentSearchState && commentSearchState.query) {
      commentSearchState.query.streamIds = [videoId];
      commentSearchState.query.bodyQ = '';
      commentSearchState.query.nameQ = '';
      commentSearchState.query.streamTitleQ = '';
      commentSearchState.query.systemTags = [];
      commentSearchState.query.userTags = [];
      commentSearchState.query.streamTags = [];
      commentSearchState.query.commentTypes = [];
      commentSearchState.query.listenerChannelIds = [];
      commentSearchState.query.periodFrom = null;
      commentSearchState.query.periodTo = null;
    }
    if (typeof switchListenerTab === 'function') switchListenerTab('comments');
    if (typeof runCommentSearch === 'function') runCommentSearch();
  };

  var deleteBtn = document.getElementById('sd-delete-stream');
  if (deleteBtn) deleteBtn.onclick = function () {
    var videoId = sdState.detail && sdState.detail.videoId;
    if (videoId) deleteStreamLog(videoId);
  };

  var closeBtn = document.getElementById('stream-detail-close');
  if (closeBtn) closeBtn.onclick = closeStreamDetailModal;

  var searchInput = document.getElementById('sd-comment-search-input');
  if (searchInput) {
    searchInput.oninput = function () {
      var v = this.value;
      // debounce 250ms。入力中は server fetch せず最終値だけ反映する。
      if (sdState.commentBodyTimer) clearTimeout(sdState.commentBodyTimer);
      sdState.commentBodyTimer = setTimeout(function () {
        sdState.commentBodyQ = v;
        sdResetAndReloadComments();
      }, 250);
    };
  }

  var tabs = document.querySelectorAll('#sd-tabs .sd-tab');
  for (var i = 0; i < tabs.length; i++) {
    (function (t) {
      t.onclick = function () { sdSwitchTab(t.dataset.tab); };
    }(tabs[i]));
  }
}

// virtualization の scroll container を modal-content に切替 (close で復帰)
function sdInstallVirtualScroll() {
  if (sdState.scrollHandler) return;
  var modalContent = document.getElementById('stream-detail-modal-content');
  if (!modalContent) return;
  if (typeof ensureGlobalVirtualScrollHandler === 'function') ensureGlobalVirtualScrollHandler();
  sdState.prevVirtScrollContainer = csVirtualScrollContainer;
  csVirtualScrollContainer = modalContent;
  var rafScheduled = false;
  sdState.scrollHandler = function () {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      csActiveVirtualLists.forEach(function (ctrl) { ctrl.updateWindow(); });
      // 末端付近に来たら chunked lazy load の次 chunk を fetch
      sdMaybeLoadMoreComments();
    });
  };
  modalContent.addEventListener('scroll', sdState.scrollHandler, { passive: true });
}

function sdUninstallVirtualScroll() {
  var modalContent = document.getElementById('stream-detail-modal-content');
  if (modalContent && sdState.scrollHandler) {
    modalContent.removeEventListener('scroll', sdState.scrollHandler);
  }
  sdState.scrollHandler = null;
  csVirtualScrollContainer = sdState.prevVirtScrollContainer;
  sdState.prevVirtScrollContainer = null;
}

function closeStreamDetailModal() {
  var modal = document.getElementById('stream-detail-modal');
  if (!modal) return;
  modal.style.display = 'none';
  if (sdState.virtCtrl) {
    sdState.virtCtrl.destroy();
    sdState.virtCtrl = null;
  }
  sdUninstallVirtualScroll();
  // chunked lazy load の世代番号も bump して in-flight 結果を破棄
  sdState.commentsFetchSeq += 1;
  sdState.commentsFetching = false;
  if (sdState.commentBodyTimer) {
    clearTimeout(sdState.commentBodyTimer);
    sdState.commentBodyTimer = null;
  }
  sdState.videoId = null;
  sdState.detail = null;
  sdState.allCommentRows = [];
  sdState.commentsLoaded = 0;
  sdState.commentsTotal = 0;
  sdState.chipCounts = null;
  sdState.listenersPage = null;
  sdState.listenerPillCounts = null;
  sdState.listenersStatus = 'idle';
  sdState.stats = null;
  sdState.statsStatus = 'idle';
}

// 配信詳細モーダルのタグ chip 編集 (listener 版とほぼ同じ構造)
function attachStreamTagEditor(detail) {
  var rootEl = document.getElementById('stream-detail-tags');
  if (!rootEl || !api.listeners || !api.listeners.getStreamTags) return;
  var videoId = rootEl.dataset.videoId || detail.videoId;
  if (!videoId) return;

  var current = [];

  function render() {
    rootEl.innerHTML = '';
    for (var i = 0; i < current.length; i++) {
      var t = current[i];
      var chip = document.createElement('span');
      chip.className = 'ld-tag-chip';
      chip.textContent = t;
      var x = document.createElement('span');
      x.className = 'ld-tag-x';
      x.textContent = '✕';
      (function (tagToRemove) {
        x.addEventListener('click', function (ev) {
          ev.stopPropagation();
          removeTag(tagToRemove);
        });
      }(t));
      chip.appendChild(x);
      rootEl.appendChild(chip);
    }
    var addPill = document.createElement('span');
    addPill.className = 'ld-tag-add-pill';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '+ タグ追加';
    input.setAttribute('list', 'stream-detail-tag-suggest');
    input.className = 'ld-tag-add-input';
    addPill.appendChild(input);
    rootEl.appendChild(addPill);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        var v = input.value.trim().replace(/,/g, '');
        if (v) addTag(v);
        input.value = '';
      } else if (e.key === 'Backspace' && input.value === '' && current.length > 0) {
        removeTag(current[current.length - 1]);
      }
    });
    input.addEventListener('change', function () {
      var v = input.value.trim();
      if (v) {
        addTag(v);
        input.value = '';
      }
    });
  }

  function addTag(tag) {
    if (current.indexOf(tag) >= 0) return;
    current.push(tag);
    persist();
    render();
  }
  function removeTag(tag) {
    current = current.filter(function (t) { return t !== tag; });
    persist();
    render();
  }
  function persist() {
    api.listeners.setStreamTags(videoId, current).then(function (resp) {
      if (!resp || !resp.ok) rendererLog.warn('setStreamTags failed', resp);
    }).catch(function (err) {
      rendererLog.error('setStreamTags failed', err);
    });
  }

  Promise.all([
    api.listeners.getStreamTags(videoId),
    api.listeners.listAllStreamTags()
  ]).then(function (results) {
    var tagsResp = results[0];
    var allResp = results[1];
    current = (tagsResp && tagsResp.ok && tagsResp.tags) ? tagsResp.tags.slice() : [];
    var dl = document.getElementById('stream-detail-tag-suggest');
    if (dl) {
      dl.innerHTML = '';
      var allTags = (allResp && allResp.ok && allResp.tags) ? allResp.tags : [];
      for (var i = 0; i < allTags.length; i++) {
        var opt = document.createElement('option');
        opt.value = allTags[i].tag;
        dl.appendChild(opt);
      }
    }
    render();
  }).catch(function (err) {
    rendererLog.error('stream tag editor init failed', err);
    rootEl.innerHTML = '<span style="font-size:11px;color:#ef9a9a">タグの読み込みに失敗</span>';
  });
}

// --- コメント検索タブ (Phase C: 新 UI) ---

// --- popover state (user / stream picker 共通) ---
// type: 'user' | 'stream'
// items: [{ id, primary, secondary, stat }]
// selected: Set<id>
var csPopoverState = { type: null, items: [], selected: null, allItems: [] };

// 選択中アイテムの表示名を引くためのキャッシュ。popover fetch / 検索結果 streams / 個別 detail から逐次更新。
var csListenerCache = {}; // channel_id → { displayName, nickname, iconUrl, username }
var csStreamCache = {};   // video_id → { title, startedAt, endedAt }

function csCacheListenerFromPopover(l) {
  if (!l || !l.channelId) return;
  csListenerCache[l.channelId] = {
    displayName: l.displayName || '',
    nickname: l.nickname || '',
    iconUrl: l.iconUrl || '',
    username: l.username || ''
  };
}
function csCacheStreamFromKpi(s) {
  if (!s || !s.streamId) return;
  csStreamCache[s.streamId] = {
    title: s.title || '',
    startedAt: s.startedAt || 0,
    endedAt: s.endedAt || 0
  };
}
function csCacheStreamFromList(s) {
  if (!s || !s.videoId) return;
  csStreamCache[s.videoId] = {
    title: s.title || '',
    startedAt: s.startedAt || 0,
    endedAt: s.endedAt || 0
  };
}

// stream picker chip 列を再描画
function updatePickerLabel(type) {
  if (type === 'stream') renderStreamPickerChips();
}

// ユーザー picker chip 列を再描画 (mock 仕様: 個別 chip + 「+ 追加」)。
function updateUserPickerLabel() {
  renderUserPickerChips();
}

// ユーザー picker の chip 列: systemTags + userTags + 個別 listener + 「+ 追加」
function renderUserPickerChips() {
  var rowEl = document.getElementById('cs-user-picker-chips');
  if (!rowEl) return;
  rowEl.innerHTML = '';
  var q = commentSearchState.query;
  // システム判定タグ chip
  if (q.systemTags) {
    for (var i = 0; i < q.systemTags.length; i++) {
      var sys = q.systemTags[i];
      rowEl.appendChild(buildPickerChip(systemTagLabel(sys) + ' (システム)', 'cs-picker-chip-system', function (val) {
        return function () {
          commentSearchState.query.systemTags = commentSearchState.query.systemTags.filter(function (t) { return t !== val; });
          renderUserPickerChips();
          // chip 削除だけでは検索しない (= popover apply と同方針)
        };
      }(sys)));
    }
  }
  // ユーザー付与タグ chip
  if (q.userTags) {
    for (var j = 0; j < q.userTags.length; j++) {
      var ut = q.userTags[j];
      rowEl.appendChild(buildPickerChip(ut + ' (タグ)', 'cs-picker-chip-user-tag', function (val) {
        return function () {
          commentSearchState.query.userTags = commentSearchState.query.userTags.filter(function (t) { return t !== val; });
          renderUserPickerChips();
          // chip 削除だけでは検索しない (= popover apply と同方針)
        };
      }(ut)));
    }
  }
  // 個別 listener chip (キャッシュから名前/アバター)
  if (q.listenerChannelIds) {
    for (var k = 0; k < q.listenerChannelIds.length; k++) {
      var id = q.listenerChannelIds[k];
      var meta = csListenerCache[id] || {};
      var name = meta.nickname || meta.displayName || meta.username || id;
      var chip = buildPickerChip(name, '', function (idVal) {
        return function () {
          commentSearchState.query.listenerChannelIds = commentSearchState.query.listenerChannelIds.filter(function (cid) { return cid !== idVal; });
          renderUserPickerChips();
          // chip 削除だけでは検索しない (= popover apply と同方針)
        };
      }(id));
      // アバターを chip 内 textContent の前に挿入
      var avatar = document.createElement('span');
      avatar.className = 'cs-picker-chip-avatar';
      if (meta.iconUrl) {
        avatar.innerHTML = '<img src="' + listenerMgrEscape(meta.iconUrl) + '" alt="">';
      } else {
        avatar.textContent = (name.charAt(0) || '?').toUpperCase();
      }
      chip.insertBefore(avatar, chip.firstChild);
      rowEl.appendChild(chip);
    }
  }
  // 「+ 追加」ボタン (popover を開く)
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'cs-picker-add';
  addBtn.textContent = (q.systemTags && q.systemTags.length || q.userTags && q.userTags.length || q.listenerChannelIds && q.listenerChannelIds.length) ? '+ 追加' : '+ 選択';
  addBtn.addEventListener('click', openUserPopover);
  rowEl.appendChild(addBtn);
}

// 配信枠 picker の chip 列 (streamTags + 個別 streamIds + 「+ 追加」)
function renderStreamPickerChips() {
  var rowEl = document.getElementById('cs-stream-picker-chips');
  if (!rowEl) return;
  rowEl.innerHTML = '';
  var q = commentSearchState.query;
  // 配信枠タグ chip
  if (q.streamTags) {
    for (var ti = 0; ti < q.streamTags.length; ti++) {
      var tag = q.streamTags[ti];
      rowEl.appendChild(buildPickerChip(tag + ' (タグ)', 'cs-picker-chip-stream', function (val) {
        return function () {
          commentSearchState.query.streamTags = commentSearchState.query.streamTags.filter(function (t) { return t !== val; });
          renderStreamPickerChips();
          // chip 削除だけでは検索しない (= popover apply と同方針)
        };
      }(tag)));
    }
  }
  var ids = q.streamIds || [];
  for (var i = 0; i < ids.length; i++) {
    var sid = ids[i];
    var meta = csStreamCache[sid] || {};
    var label = meta.title || sid;
    if (meta.startedAt) {
      var d = new Date(meta.startedAt);
      label += ' ' + (d.getMonth() + 1) + '/' + d.getDate();
    }
    rowEl.appendChild(buildPickerChip(label, 'cs-picker-chip-stream', function (sidVal) {
      return function () {
        commentSearchState.query.streamIds = commentSearchState.query.streamIds.filter(function (id) { return id !== sidVal; });
        renderStreamPickerChips();
        // chip 削除だけでは検索しない (= popover apply と同方針)
      };
    }(sid)));
  }
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'cs-picker-add';
  addBtn.textContent = (q.streamTags && q.streamTags.length || ids.length) ? '+ 追加' : '+ 選択';
  addBtn.addEventListener('click', openStreamPopover);
  rowEl.appendChild(addBtn);
}

// 期間 picker の chip 列 (range 1 つ chip にまとめる)
function renderPeriodPickerChips() {
  var rowEl = document.getElementById('cs-period-picker-chips');
  if (!rowEl) return;
  rowEl.innerHTML = '';
  var q = commentSearchState.query;
  if (q.periodFrom || q.periodTo) {
    var fromStr = q.periodFrom ? listenerMgrFormatDate(q.periodFrom) : '?';
    var toStr = q.periodTo ? listenerMgrFormatDate(q.periodTo - 1) : '?';
    rowEl.appendChild(buildPickerChip(fromStr + ' – ' + toStr, '', function () {
      commentSearchState.query.periodFrom = null;
      commentSearchState.query.periodTo = null;
      renderPeriodPickerChips();
      // chip 削除だけでは検索しない (= popover apply と同方針)
    }));
  }
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'cs-picker-add';
  addBtn.textContent = (q.periodFrom || q.periodTo) ? '変更' : '+ 期間を指定';
  addBtn.addEventListener('click', openPeriodPopover);
  rowEl.appendChild(addBtn);
}

// updatePeriodPickerLabel は既存名を保ちつつ新仕様にリダイレクト
function _legacyUpdatePeriodPickerLabel() {
  // 旧: button のラベル更新。F3 で chip 列に置き換え。
}

// chip 1 個を作る共通ヘルパ
function buildPickerChip(text, extraClass, onRemove) {
  var chip = document.createElement('span');
  chip.className = 'cs-picker-chip' + (extraClass ? ' ' + extraClass : '');
  var label = document.createElement('span');
  label.textContent = text;
  chip.appendChild(label);
  var x = document.createElement('span');
  x.className = 'cs-picker-chip-x';
  x.textContent = '✕';
  x.addEventListener('click', function (e) {
    e.stopPropagation();
    onRemove();
  });
  chip.appendChild(x);
  return chip;
}

// popover を開く (type='user' or 'stream')。データ取得 → リスト描画 → 表示。
function openPickerPopover(type) {
  csPopoverState.type = type;
  // 現在の選択を Set 化 (キャンセル時に書き戻さないので、ここで一旦コピー)
  var currentIds = (type === 'user'
    ? (commentSearchState.query.listenerChannelIds || [])
    : (commentSearchState.query.streamIds || [])).slice();
  csPopoverState.selected = new Set(currentIds);

  var titleEl = document.getElementById('cs-popover-title');
  var searchEl = document.getElementById('cs-popover-search');
  var listEl = document.getElementById('cs-popover-list');
  var countEl = document.getElementById('cs-popover-count');
  var backdrop = document.getElementById('cs-popover-backdrop');
  if (titleEl) titleEl.textContent = type === 'user' ? 'ユーザーを選択' : '配信枠を選択';
  if (searchEl) {
    searchEl.value = '';
    searchEl.placeholder = type === 'user' ? '名前 / @ハンドルで検索' : 'タイトル / 日付で検索';
  }
  if (listEl) listEl.innerHTML = '<div class="cs-popover-empty">読み込み中…</div>';
  if (backdrop) backdrop.style.display = '';

  // データ取得 → state.allItems に格納 → 描画
  var fetchPromise = type === 'user' ? fetchListenersForPicker() : fetchStreamsForPicker();
  fetchPromise.then(function (items) {
    csPopoverState.allItems = items;
    renderPopoverList('');
  }).catch(function (err) {
    rendererLog.error('picker fetch failed', err);
    if (listEl) listEl.innerHTML = '<div class="cs-popover-empty">読み込みに失敗しました</div>';
  });
  // 検索入力で再描画
  if (searchEl) {
    searchEl.oninput = function () { renderPopoverList(searchEl.value.trim()); };
  }
  // count を初期反映
  if (countEl) countEl.textContent = csPopoverState.selected.size + ' 件選択中';
}

function closePickerPopover() {
  var backdrop = document.getElementById('cs-popover-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  csPopoverState.type = null;
  csPopoverState.items = [];
  csPopoverState.allItems = [];
  csPopoverState.selected = null;
}

// 全リスナー取得 (limit 1000 で一括 — 多い場合の対応は将来検討)
function fetchListenersForPicker() {
  if (!api.listeners) return Promise.resolve([]);
  return api.listeners.list({ sort: 'lastSeen', limit: 1000, offset: 0 }).then(function (resp) {
    if (!resp || !resp.ok) return [];
    return (resp.page.rows || []).map(function (l) {
      return {
        id: l.channelId,
        primary: l.nickname && l.nickname.length > 0 ? l.nickname : (l.displayName || ''),
        secondary: (l.nickname && l.username ? l.username : '') + (l.nickname && l.username && l.firstSeenAt ? ' · ' : '') + (l.firstSeenAt ? '初コメ ' + listenerMgrFormatDate(l.firstSeenAt) : ''),
        stat: l.commentCount + ' 件 / ' + listenerMgrFormatYen(l.superchatAmountJpy || 0)
      };
    });
  });
}

// 全配信枠取得
function fetchStreamsForPicker() {
  if (!api.listeners) return Promise.resolve([]);
  var scope = (commentSearchState.query && commentSearchState.query.scope) || 'own';
  return api.listeners.streams({ sort: 'startedAt', scope: scope, limit: 1000, offset: 0 }).then(function (resp) {
    if (!resp || !resp.ok) return [];
    return (resp.page.rows || []).map(function (s) {
      csCacheStreamFromList(s);
      return {
        id: s.videoId,
        primary: s.title || s.videoId,
        secondary: (s.startedAt ? listenerMgrFormatDateTime(s.startedAt) : '') + ' · ' + (s.commentCount || 0) + ' 件',
        stat: listenerMgrFormatYen(s.superchatAmountJpy || 0)
      };
    });
  });
}

// 検索フィルタを適用してリスト描画
function renderPopoverList(filterText) {
  var listEl = document.getElementById('cs-popover-list');
  var countEl = document.getElementById('cs-popover-count');
  if (!listEl) return;
  var lower = (filterText || '').toLowerCase();
  var visible = csPopoverState.allItems.filter(function (it) {
    if (!lower) return true;
    return (it.primary || '').toLowerCase().indexOf(lower) >= 0
      || (it.secondary || '').toLowerCase().indexOf(lower) >= 0;
  });
  csPopoverState.items = visible;

  listEl.innerHTML = '';
  if (visible.length === 0) {
    listEl.innerHTML = '<div class="cs-popover-empty">該当なし</div>';
    return;
  }
  for (var i = 0; i < visible.length; i++) {
    var it = visible[i];
    var row = document.createElement('label');
    row.className = 'cs-popover-row';
    var checked = csPopoverState.selected && csPopoverState.selected.has(it.id) ? 'checked' : '';
    row.innerHTML =
      '<input type="checkbox" data-id="' + listenerMgrEscape(it.id) + '" ' + checked + '>' +
      '<div class="cs-row-main">' +
        '<div class="cs-row-primary">' + listenerMgrEscape(it.primary) + '</div>' +
        (it.secondary ? '<div class="cs-row-secondary">' + listenerMgrEscape(it.secondary) + '</div>' : '') +
      '</div>' +
      (it.stat ? '<span class="cs-row-stat">' + listenerMgrEscape(it.stat) + '</span>' : '');
    listEl.appendChild(row);
  }
  // チェックボックス変更で selected を更新
  listEl.addEventListener('change', function (e) {
    if (e.target && e.target.tagName === 'INPUT') {
      var id = e.target.getAttribute('data-id');
      if (e.target.checked) csPopoverState.selected.add(id);
      else csPopoverState.selected.delete(id);
      if (countEl) countEl.textContent = csPopoverState.selected.size + ' 件選択中';
    }
  });
  if (countEl) countEl.textContent = csPopoverState.selected.size + ' 件選択中';
}

function applyPickerPopover() {
  if (!csPopoverState.type || !csPopoverState.selected) return;
  var ids = Array.from(csPopoverState.selected);
  if (csPopoverState.type === 'user') {
    commentSearchState.query.listenerChannelIds = ids;
  } else if (csPopoverState.type === 'stream') {
    commentSearchState.query.streamIds = ids;
  }
  updatePickerLabel(csPopoverState.type);
  closePickerPopover();
  // 選択変更だけでは検索しない。ユーザーが「検索」ボタンをクリックして発火させる。
}

function clearPickerPopover() {
  if (!csPopoverState.selected) return;
  csPopoverState.selected.clear();
  // チェックボックスを全部 off に
  var listEl = document.getElementById('cs-popover-list');
  if (listEl) {
    var checks = listEl.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < checks.length; i++) checks[i].checked = false;
  }
  var countEl = document.getElementById('cs-popover-count');
  if (countEl) countEl.textContent = '0 件選択中';
}

// --- フォーム collapsed / expanded toggle + applied-chips ---

function isFormCollapsed() {
  var formEl = document.getElementById('cs-form');
  return formEl && formEl.style.display === 'none';
}

// 検索成功時に呼ばれる: form を畳んで applied-chips に切り替え。
function collapseSearchForm() {
  var formEl = document.getElementById('cs-form');
  var chipsEl = document.getElementById('cs-applied-chips');
  var toggleBtn = document.getElementById('cs-toggle-form-btn');
  if (formEl) formEl.style.display = 'none';
  if (toggleBtn) toggleBtn.style.display = '';
  if (chipsEl) {
    renderAppliedChips(chipsEl);
    chipsEl.style.display = '';
  }
}

// 「条件を変更」クリックで form を再表示、chips を隠す。
function expandSearchForm() {
  var formEl = document.getElementById('cs-form');
  var chipsEl = document.getElementById('cs-applied-chips');
  var toggleBtn = document.getElementById('cs-toggle-form-btn');
  if (formEl) formEl.style.display = '';
  if (toggleBtn) toggleBtn.style.display = 'none';
  if (chipsEl) chipsEl.style.display = 'none';
}

// query state から chip を 1 行で生成。
// chip クリック / 削除はせず、chip 全体クリックで form 再展開する設計 (mock 準拠)。
function renderAppliedChips(chipsEl) {
  var q = commentSearchState.query;
  chipsEl.innerHTML = '';
  var label = document.createElement('span');
  label.className = 'cs-chips-label';
  label.textContent = '適用中';
  chipsEl.appendChild(label);

  var chips = [];
  if (q.scope && q.scope !== 'own') {
    chips.push({ text: '対象: ' + (q.scope === 'other' ? '他チャンネル' : 'すべて'), klass: 'cs-chip-amber' });
  }
  if (q.bodyQ) chips.push({ text: 'コメント本文: ' + q.bodyQ, klass: '' });
  if (q.streamTitleQ) chips.push({ text: '配信枠名: ' + q.streamTitleQ, klass: 'cs-chip-purple' });
  if (q.nameQ) chips.push({ text: 'リスナー名: ' + q.nameQ, klass: '' });
  if (q.commentTypes && q.commentTypes.length > 0) {
    chips.push({ text: '種別: ' + q.commentTypes.map(commentTypeLabel).join(' / '), klass: 'cs-chip-amber' });
  }
  if (q.systemTags && q.systemTags.length > 0) {
    chips.push({ text: 'システム: ' + q.systemTags.map(systemTagLabel).join(' / '), klass: 'cs-chip-amber' });
  }
  if (q.userTags && q.userTags.length > 0) {
    chips.push({ text: 'リスナータグ: ' + q.userTags.join(' / '), klass: 'cs-chip-purple' });
  }
  if (q.listenerChannelIds && q.listenerChannelIds.length > 0) {
    chips.push({ text: 'リスナー: ' + q.listenerChannelIds.length + ' 人', klass: '' });
  }
  if (q.streamTags && q.streamTags.length > 0) {
    chips.push({ text: '配信タグ: ' + q.streamTags.join(' / '), klass: 'cs-chip-purple' });
  }
  if (q.streamIds && q.streamIds.length > 0) {
    chips.push({ text: '配信: ' + q.streamIds.length + ' 枠', klass: 'cs-chip-purple' });
  }
  if (q.periodFrom || q.periodTo) {
    var fromStr = q.periodFrom ? listenerMgrFormatDate(q.periodFrom) : '';
    var toStr = q.periodTo ? listenerMgrFormatDate(q.periodTo) : '';
    chips.push({ text: '期間: ' + fromStr + ' – ' + toStr, klass: '' });
  }
  if (chips.length === 0) {
    var empty = document.createElement('span');
    empty.className = 'cs-chip-empty';
    empty.textContent = '(条件なし: 全件)';
    chipsEl.appendChild(empty);
    return;
  }
  for (var i = 0; i < chips.length; i++) {
    var c = chips[i];
    var ch = document.createElement('span');
    ch.className = 'cs-chip' + (c.klass ? ' ' + c.klass : '');
    ch.textContent = c.text;
    chipsEl.appendChild(ch);
  }
}

function commentTypeLabel(t) {
  switch (t) {
    case 'chat': return 'チャット';
    case 'superchat': return 'スパチャ';
    case 'membership': return 'メンバー加入';
    case 'membership_milestone': return 'メンバー継続';
    case 'sticker': return 'ステッカー';
    case 'gift': return 'ギフト';
    default: return t;
  }
}
function systemTagLabel(t) {
  switch (t) {
    case 'first-time': return '新規';
    case 'returning': return '新参';
    case 'regular': return '常連';
    case 'veteran': return '古参';
    case 'comeback': return '復帰';
    case 'abandoned': return '離脱';
    default: return t;
  }
}

// --- 保存検索ストリップ ---

function refreshSavedSearchStrip() {
  if (!api.listeners || !api.listeners.listSavedSearches) return;
  var pinsEl = document.getElementById('cs-saved-pins');
  if (!pinsEl) return;
  api.listeners.listSavedSearches('comment-search').then(function (resp) {
    if (!resp || !resp.ok) return;
    pinsEl.innerHTML = '';
    var searches = resp.searches || [];
    if (searches.length === 0) {
      var hint = document.createElement('span');
      hint.className = 'cs-form-hint';
      hint.style.cssText = 'font-size:10px;color:#5a6a78;padding:0 4px';
      hint.textContent = '保存検索なし';
      pinsEl.appendChild(hint);
      return;
    }
    for (var i = 0; i < searches.length; i++) {
      var s = searches[i];
      var pin = document.createElement('span');
      pin.className = 'cs-saved-pin';
      pin.dataset.id = String(s.id);
      var star = document.createElement('span');
      star.className = 'cs-star';
      star.textContent = '★';
      pin.appendChild(star);
      pin.appendChild(document.createTextNode(s.name));
      var x = document.createElement('span');
      x.className = 'cs-pin-x';
      x.textContent = '✕';
      x.title = '削除';
      pin.appendChild(x);
      // 各 pin: クリックで条件をロード、x クリックで削除
      (function (search) {
        pin.addEventListener('click', function (ev) {
          if (ev.target === x) return; // x クリックは削除
          applySavedSearch(search);
        });
        x.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!confirm('「' + search.name + '」を削除しますか？')) return;
          api.listeners.deleteSavedSearch(search.id).then(function (r) {
            if (r && r.ok) refreshSavedSearchStrip();
          });
        });
      }(s));
      pinsEl.appendChild(pin);
    }
  }).catch(function (err) {
    rendererLog.error('listSavedSearches failed', err);
  });
}

// 保存検索の条件を form / state に流し込んで再検索
function applySavedSearch(search) {
  if (!search || !search.conditions) return;
  var cond;
  try { cond = JSON.parse(search.conditions); } catch (e) { rendererLog.error('bad conditions', e); return; }
  // form input を上書き
  var bodyEl = document.getElementById('cs-body-q');
  var titleEl = document.getElementById('cs-stream-title-q');
  var nameEl = document.getElementById('cs-name-q');
  var scopeEl = document.getElementById('cs-scope');
  if (bodyEl) bodyEl.value = cond.bodyQ || '';
  if (titleEl) titleEl.value = cond.streamTitleQ || '';
  if (nameEl) nameEl.value = cond.nameQ || '';
  if (scopeEl) scopeEl.value = cond.scope || 'own';

  function setRowChecks(rowId, values) {
    var row = document.getElementById(rowId);
    if (!row) return;
    var checks = row.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < checks.length; i++) {
      checks[i].checked = (values || []).indexOf(checks[i].value) >= 0;
    }
  }
  setCommentTypesOnForm(cond.commentTypes);
  setRowChecks('cs-system-tag-row', cond.systemTags);
  setRowChecks('cs-user-tag-row', cond.userTags);

  // listenerChannelIds / streamIds / period / systemTags / userTags / streamTags は state に直書き
  commentSearchState.query.listenerChannelIds = cond.listenerChannelIds || [];
  commentSearchState.query.streamIds = cond.streamIds || [];
  commentSearchState.query.systemTags = cond.systemTags || [];
  commentSearchState.query.userTags = cond.userTags || [];
  commentSearchState.query.streamTags = cond.streamTags || [];
  commentSearchState.query.periodFrom = cond.periodFrom || null;
  commentSearchState.query.periodTo = cond.periodTo || null;
  commentSearchState.query.scope = cond.scope || 'own';
  updateUserPickerLabel();
  updatePickerLabel('stream');
  updatePeriodPickerLabel();

  runCommentSearch();
}

function msToDateInput(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var dd = d.getDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
}

// 保存ダイアログを開く際の scope 別コンテキスト。 confirmSaveDialog が参照する。
// Electron で window.prompt が無効化されているため、 listener-search も同じ
// HTML ダイアログ (= cs-save-dialog-backdrop) を流用する。
var savedSearchSaveContext = null;

// 共通保存ダイアログを開く。 ctx は以下を持つ:
// - scope: 'comment-search' | 'listener-search' (= IPC に渡す scope 文字列)
// - getConditions: () => object   (= JSON 化される条件オブジェクト)
// - renderPreview: (el) => void   (= optional、 preview 領域への描画。 null で空)
// - onSaved: () => void           (= 保存成功後の strip 再描画コールバック)
function openSaveSearchDialog(ctx) {
  if (!api.listeners || !api.listeners.createSavedSearch) return;
  savedSearchSaveContext = ctx || null;
  var backdrop = document.getElementById('cs-save-dialog-backdrop');
  var nameInput = document.getElementById('cs-save-name-input');
  var preview = document.getElementById('cs-save-preview');
  var errEl = document.getElementById('cs-save-error');
  if (errEl) errEl.textContent = '';
  if (nameInput) {
    nameInput.value = '';
    setTimeout(function () { nameInput.focus(); }, 30);
  }
  if (preview) {
    preview.innerHTML = '';
    if (ctx && typeof ctx.renderPreview === 'function') {
      ctx.renderPreview(preview);
    }
  }
  if (backdrop) backdrop.style.display = '';
}

// 現在の条件を保存 (F4: 専用ダイアログで名前入力 + 条件プレビュー、 scope='comment-search')
function saveCurrentSearch() {
  if (!api.listeners || !api.listeners.createSavedSearch) return;
  readCommentSearchForm();
  openSaveSearchDialog({
    scope: 'comment-search',
    getConditions: function () { return commentSearchState.query; },
    renderPreview: function (el) { renderAppliedChips(el); },
    onSaved: refreshSavedSearchStrip,
  });
}

function closeSaveDialog() {
  var backdrop = document.getElementById('cs-save-dialog-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  savedSearchSaveContext = null;
}

function confirmSaveDialog() {
  var ctx = savedSearchSaveContext;
  if (!ctx) return;
  var nameInput = document.getElementById('cs-save-name-input');
  var errEl = document.getElementById('cs-save-error');
  var name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    if (errEl) errEl.textContent = '名前を入力してください';
    if (nameInput) nameInput.focus();
    return;
  }
  var conditions;
  try {
    conditions = ctx.getConditions();
  } catch (e) {
    if (errEl) errEl.textContent = '条件の取得に失敗: ' + (e && e.message ? e.message : e);
    return;
  }
  api.listeners.createSavedSearch(ctx.scope, name, conditions).then(function (resp) {
    if (!resp || !resp.ok) {
      if (errEl) errEl.textContent = '保存に失敗: ' + (resp && resp.error ? resp.error : 'unknown');
      return;
    }
    closeSaveDialog();
    if (typeof ctx.onSaved === 'function') ctx.onSaved();
  }).catch(function (err) {
    if (errEl) errEl.textContent = '保存に失敗: ' + (err && err.message ? err.message : err);
  });
}

// --- タグ管理 modal (F4: 全タグ一覧 + rename / 削除) ---

// 現在 active なタブ ('listener' or 'stream')
var csTagAdminActiveTab = 'listener';

function openTagAdminModal() {
  if (!api.listeners) return;
  var backdrop = document.getElementById('cs-tag-admin-backdrop');
  if (backdrop) backdrop.style.display = '';
  switchTagAdminTab(csTagAdminActiveTab);
}

function closeTagAdminModal() {
  var backdrop = document.getElementById('cs-tag-admin-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function switchTagAdminTab(tab) {
  csTagAdminActiveTab = tab;
  var tabs = document.querySelectorAll('#cs-tag-admin-tabs .cs-tag-admin-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.target === tab);
  }
  var listenerList = document.getElementById('cs-tag-admin-list-listener');
  var streamList = document.getElementById('cs-tag-admin-list-stream');
  if (listenerList) listenerList.style.display = (tab === 'listener') ? '' : 'none';
  if (streamList) streamList.style.display = (tab === 'stream') ? '' : 'none';
  if (tab === 'listener') refreshTagAdminListenerList();
  else refreshTagAdminStreamList();
}

function refreshTagAdminListenerList() {
  refreshTagAdminListImpl({
    listElId: 'cs-tag-admin-list-listener',
    fetchFn: api.listeners.listAllTags,
    countLabel: '人',
    countField: 'listenerCount',
    deleteFn: api.listeners.deleteTag,
    renameFn: api.listeners.renameTag,
    deleteConfirmFn: function (name, count) {
      return '「' + name + '」をすべてのリスナーから削除しますか？\n(' + count + ' 人から削除されます)';
    },
    onAfterChange: function (op, oldName, newName) {
      // 検索フォームの query.userTags にも反映
      if (op === 'rename' && commentSearchState.query.userTags) {
        commentSearchState.query.userTags = commentSearchState.query.userTags.map(function (t) {
          return t === oldName ? newName : t;
        });
        renderUserPickerChips();
      } else if (op === 'delete' && commentSearchState.query.userTags) {
        commentSearchState.query.userTags = commentSearchState.query.userTags.filter(function (t) { return t !== oldName; });
        renderUserPickerChips();
      }
    }
  });
}

function refreshTagAdminStreamList() {
  refreshTagAdminListImpl({
    listElId: 'cs-tag-admin-list-stream',
    fetchFn: api.listeners.listAllStreamTags,
    countLabel: '枠',
    countField: 'streamCount',
    deleteFn: api.listeners.deleteStreamTag,
    renameFn: api.listeners.renameStreamTag,
    deleteConfirmFn: function (name, count) {
      return '「' + name + '」をすべての配信枠から削除しますか？\n(' + count + ' 枠から削除されます)';
    },
    onAfterChange: function (op, oldName, newName) {
      if (op === 'rename' && commentSearchState.query.streamTags) {
        commentSearchState.query.streamTags = commentSearchState.query.streamTags.map(function (t) {
          return t === oldName ? newName : t;
        });
        renderStreamPickerChips();
      } else if (op === 'delete' && commentSearchState.query.streamTags) {
        commentSearchState.query.streamTags = commentSearchState.query.streamTags.filter(function (t) { return t !== oldName; });
        renderStreamPickerChips();
      }
    }
  });
}

// リスナー / 配信枠 タグ管理リストの共通描画ロジック
function refreshTagAdminListImpl(opts) {
  var listEl = document.getElementById(opts.listElId);
  var sumEl = document.getElementById('cs-tag-admin-summary');
  if (!listEl) return;
  listEl.innerHTML = '<div class="cs-popover-empty">読み込み中…</div>';
  opts.fetchFn().then(function (resp) {
    if (!resp || !resp.ok) {
      listEl.innerHTML = '<div class="cs-popover-empty">読み込みに失敗しました</div>';
      return;
    }
    var tags = resp.tags || [];
    if (sumEl) sumEl.textContent = '全 ' + tags.length + ' タグ';
    listEl.innerHTML = '';
    if (tags.length === 0) {
      listEl.innerHTML = '<div class="cs-popover-empty">タグはまだ登録されていません</div>';
      return;
    }
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      var row = buildTagAdminRow(t.tag, t[opts.countField], opts);
      listEl.appendChild(row);
    }
  }).catch(function (err) {
    rendererLog.error('tag list fetch failed', err);
    listEl.innerHTML = '<div class="cs-popover-empty">読み込みに失敗しました</div>';
  });
}

function buildTagAdminRow(tagName, count, opts) {
  var row = document.createElement('div');
  row.className = 'cs-tag-admin-row';

  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'cs-tag-admin-name';
  nameInput.value = tagName;
  nameInput.addEventListener('blur', function () {
    var newName = nameInput.value.trim();
    if (newName === tagName || !newName) {
      nameInput.value = tagName;
      return;
    }
    opts.renameFn(tagName, newName).then(function (resp) {
      if (!resp || !resp.ok) {
        alert('リネーム失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
        nameInput.value = tagName;
        return;
      }
      if (opts.onAfterChange) opts.onAfterChange('rename', tagName, newName);
      // active タブを再描画
      switchTagAdminTab(csTagAdminActiveTab);
    }).catch(function (err) {
      alert('リネーム失敗: ' + (err && err.message ? err.message : err));
      nameInput.value = tagName;
    });
  });
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') nameInput.blur();
    else if (e.key === 'Escape') {
      nameInput.value = tagName;
      nameInput.blur();
    }
  });
  row.appendChild(nameInput);

  var countEl = document.createElement('span');
  countEl.className = 'cs-tag-admin-count';
  countEl.textContent = count + ' ' + opts.countLabel;
  row.appendChild(countEl);

  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'cs-tag-admin-del';
  del.textContent = '削除';
  del.addEventListener('click', function () {
    if (!confirm(opts.deleteConfirmFn(tagName, count))) return;
    opts.deleteFn(tagName).then(function (resp) {
      if (!resp || !resp.ok) {
        alert('削除失敗: ' + (resp && resp.error ? resp.error : 'unknown'));
        return;
      }
      if (opts.onAfterChange) opts.onAfterChange('delete', tagName);
      switchTagAdminTab(csTagAdminActiveTab);
    }).catch(function (err) {
      alert('削除失敗: ' + (err && err.message ? err.message : err));
    });
  });
  row.appendChild(del);
  return row;
}

// --- ユーザー popover (mock 仕様: タグ strip 2 系統 + bulk-row + アバター行) ---

var csUserPopoverState = {
  systemTags: null,        // Set: active system tags (filter & commit)
  userTags: null,          // Set: active user tags
  individualSelected: null, // Set: checked listener channel ids
  searchQ: '',
  allListeners: [],        // [{channelId, displayName, nickname, username, iconUrl, firstSeenAt, commentCount, superchatAmountJpy, systemTag, userTags[]}]
  filtered: [],            // 現在のフィルタを適用した listeners
  allTags: [],             // [{tag, listenerCount}]
};

// 1 リスナーの system tag を first_seen_at + comment_count から算出
// 設定画面で変更可能な ListenerClassificationConfig を JS 側にもキャッシュ。
// 設定読込時 (initSettingsListener) と保存時 (persist) に refreshClassificationCache で更新する。
// 旧ハードコード 30/365 を残すと、設定変えても computeSystemTag が古い値を使い続け、
// 配信詳細モーダルの pill 件数が反映されない (= 2026-05-13 ユーザ指摘)。
var classificationCache = {
  newcomerFirstSeenDays: 30,
  veteranFirstSeenDays: 365,
  regularStreamWindow: 10,
  regularMinStreams: 3
};
// DevTools から `window.__classificationCache` で確認できるようにする
// (= 設定が反映されてないように見える時の切り分け用)
if (typeof window !== 'undefined') window.__classificationCache = classificationCache;

function refreshClassificationCache() {
  if (!api.getListenerClassificationConfig) return;
  api.getListenerClassificationConfig().then(function (s) {
    if (!s) return;
    if (typeof s.newcomerFirstSeenDays === 'number') classificationCache.newcomerFirstSeenDays = s.newcomerFirstSeenDays;
    if (typeof s.veteranFirstSeenDays === 'number') classificationCache.veteranFirstSeenDays = s.veteranFirstSeenDays;
    if (typeof s.regularStreamWindow === 'number') classificationCache.regularStreamWindow = s.regularStreamWindow;
    if (typeof s.regularMinStreams === 'number') classificationCache.regularMinStreams = s.regularMinStreams;
  }).catch(function (err) { rendererLog.debug("promise rejected (catch swallow):", err); });
}

// 起動直後に一度 fetch (= モーダルを開く前にキャッシュを温める)
if (typeof window !== 'undefined') refreshClassificationCache();

/**
 * computeSystemTag:
 *   l (= リスナー or StreamListenerRow.listener) を受け取り、リスナーランクを返す。
 *   返り値: 'first-time' / 'returning' (新参) / 'regular' (常連) / 'veteran' (古参) / 'comeback' (復帰) / null
 *
 *   復帰 (= comeback) 判定は activityCtx.isActive フラグ (= Rust 側が active CTE で計算)
 *   が利用可能な場合のみ行う。activityCtx 未指定 / isActive 未定義の場合は従来通り
 *   「常連 / 古参」のままで返す (= 復帰判定情報なしの呼び出し元との後方互換)。
 *
 *   activityCtx 例: { isActive: row.isActive, referenceTimeMs: stream.startedAt }
 *
 *   referenceTimeMs:
 *     経過日数判定の基準時刻 (UNIX ms)。指定があればそれ、なければ Date.now()。
 *     配信詳細モーダル等で「その配信時点でのランク」を表示するため、stream.startedAt を渡す。
 *     未指定 (user popover 等の generic context) では現在時刻基準にフォールバック。
 */
function computeSystemTag(l, activityCtx) {
  if (!l || !l.firstSeenAt) return null;
  if ((l.commentCount || 0) <= 1) return 'first-time';
  var ref = (activityCtx && typeof activityCtx.referenceTimeMs === 'number')
    ? activityCtx.referenceTimeMs
    : Date.now();
  var oneMonth = classificationCache.newcomerFirstSeenDays * 24 * 3600 * 1000;
  var oneYear = classificationCache.veteranFirstSeenDays * 24 * 3600 * 1000;
  if (l.firstSeenAt >= ref - oneMonth) return 'returning';
  // 以下は 「常連 / 古参 候補」(= 30 日以上経過)。活動チェックで 復帰 を分岐
  var hasActivityInfo = activityCtx && typeof activityCtx.isActive === 'boolean';
  if (hasActivityInfo && !activityCtx.isActive) return 'comeback';
  if (l.firstSeenAt < ref - oneYear) return 'veteran';
  return 'regular';
}

function openUserPopover() {
  // state 復元 (popover 外の commentSearchState からコピー)
  csUserPopoverState.systemTags = new Set(commentSearchState.query.systemTags || []);
  csUserPopoverState.userTags = new Set(commentSearchState.query.userTags || []);
  csUserPopoverState.individualSelected = new Set(commentSearchState.query.listenerChannelIds || []);
  csUserPopoverState.searchQ = '';
  csUserPopoverState.allListeners = [];
  csUserPopoverState.filtered = [];
  csUserPopoverState.allTags = [];

  var listEl = document.getElementById('cs-user-popover-list');
  if (listEl) listEl.innerHTML = '<div class="cs-popover-empty">読み込み中…</div>';
  var backdrop = document.getElementById('cs-user-popover-backdrop');
  if (backdrop) backdrop.style.display = '';
  var searchInput = document.getElementById('cs-user-popover-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = function () {
      csUserPopoverState.searchQ = searchInput.value.trim();
      applyUserPopoverFilter();
    };
  }

  // 並行 fetch: listeners + listAllTags + listAllTagAssignments
  Promise.all([
    api.listeners.list({ sort: 'lastSeen', limit: 1000, offset: 0 }),
    api.listeners.listAllTags(),
    api.listeners.listAllTagAssignments()
  ]).then(function (results) {
    var listenersResp = results[0];
    var allTagsResp = results[1];
    var assignmentsResp = results[2];
    if (!listenersResp || !listenersResp.ok) throw new Error('listeners fetch failed');
    var listeners = listenersResp.page.rows || [];
    // assignments を channel_id → tags[] に集約
    var tagsByChannel = {};
    if (assignmentsResp && assignmentsResp.ok) {
      var arr = assignmentsResp.assignments || [];
      for (var i = 0; i < arr.length; i++) {
        var a = arr[i];
        if (!tagsByChannel[a.channelId]) tagsByChannel[a.channelId] = [];
        tagsByChannel[a.channelId].push(a.tag);
      }
    }
    // listener オブジェクトに systemTag + userTags を merge
    csUserPopoverState.allListeners = listeners.map(function (l) {
      var entry = {
        channelId: l.channelId,
        displayName: l.displayName || '',
        nickname: l.nickname || '',
        username: l.username || '',
        iconUrl: l.iconUrl || '',
        firstSeenAt: l.firstSeenAt || 0,
        commentCount: l.commentCount || 0,
        superchatAmountJpy: l.superchatAmountJpy || 0,
        systemTag: computeSystemTag(l),
        userTags: tagsByChannel[l.channelId] || []
      };
      csCacheListenerFromPopover(entry);
      return entry;
    });
    csUserPopoverState.allTags = (allTagsResp && allTagsResp.ok) ? (allTagsResp.tags || []) : [];
    renderUserPopoverTagStrips();
    applyUserPopoverFilter();
  }).catch(function (err) {
    rendererLog.error('user popover load failed', err);
    if (listEl) listEl.innerHTML = '<div class="cs-popover-empty">読み込みに失敗しました</div>';
  });
}

function closeUserPopover() {
  var backdrop = document.getElementById('cs-user-popover-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function applyUserPopover() {
  // popover 状態を query に反映 (確定)
  commentSearchState.query.systemTags = Array.from(csUserPopoverState.systemTags);
  commentSearchState.query.userTags = Array.from(csUserPopoverState.userTags);
  commentSearchState.query.listenerChannelIds = Array.from(csUserPopoverState.individualSelected);
  updateUserPickerLabel();
  closeUserPopover();
  // 選択変更だけでは検索しない。ユーザーが「検索」ボタンをクリックして発火させる。
}

function clearUserPopoverState() {
  csUserPopoverState.systemTags.clear();
  csUserPopoverState.userTags.clear();
  csUserPopoverState.individualSelected.clear();
  renderUserPopoverTagStrips();
  applyUserPopoverFilter();
}

// システムタグ / ユーザータグ strip を描画 (アクティブ状態反映)
function renderUserPopoverTagStrips() {
  var systemContainer = document.getElementById('cs-user-popover-system-tags');
  var userContainer = document.getElementById('cs-user-popover-user-tags');
  if (systemContainer) {
    systemContainer.innerHTML = '';
    var systems = ['first-time', 'returning', 'regular', 'veteran'];
    // 各タグの該当数 (現在の検索 q + 他タグフィルタは無視、純粋に listener 母集団に対して)
    for (var i = 0; i < systems.length; i++) {
      var sys = systems[i];
      var label = systemTagLabel(sys);
      var count = csUserPopoverState.allListeners.filter(function (l) { return l.systemTag === sys; }).length;
      if (count === 0) continue;
      var tag = document.createElement('span');
      tag.className = 'cs-tag' + (csUserPopoverState.systemTags.has(sys) ? ' cs-active' : '');
      tag.textContent = label;
      var ct = document.createElement('span');
      ct.className = 'cs-tag-ct';
      ct.textContent = String(count);
      tag.appendChild(ct);
      (function (sysVal) {
        tag.addEventListener('click', function () {
          if (csUserPopoverState.systemTags.has(sysVal)) csUserPopoverState.systemTags.delete(sysVal);
          else csUserPopoverState.systemTags.add(sysVal);
          renderUserPopoverTagStrips();
          applyUserPopoverFilter();
        });
      }(sys));
      systemContainer.appendChild(tag);
    }
  }
  if (userContainer) {
    userContainer.innerHTML = '';
    if (csUserPopoverState.allTags.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'cs-tag-empty';
      empty.textContent = 'タグ未登録';
      userContainer.appendChild(empty);
    } else {
      for (var j = 0; j < csUserPopoverState.allTags.length; j++) {
        var t = csUserPopoverState.allTags[j];
        var tag2 = document.createElement('span');
        tag2.className = 'cs-tag' + (csUserPopoverState.userTags.has(t.tag) ? ' cs-active' : '');
        tag2.textContent = t.tag;
        var ct2 = document.createElement('span');
        ct2.className = 'cs-tag-ct';
        ct2.textContent = String(t.listenerCount);
        tag2.appendChild(ct2);
        (function (tagVal) {
          tag2.addEventListener('click', function () {
            if (csUserPopoverState.userTags.has(tagVal)) csUserPopoverState.userTags.delete(tagVal);
            else csUserPopoverState.userTags.add(tagVal);
            renderUserPopoverTagStrips();
            applyUserPopoverFilter();
          });
        }(t.tag));
        userContainer.appendChild(tag2);
      }
    }
  }
}

// 現在の searchQ + systemTags + userTags でフィルタした listener 配列を描画
function applyUserPopoverFilter() {
  var listeners = csUserPopoverState.allListeners;
  // 名前検索
  var q = csUserPopoverState.searchQ.toLowerCase();
  if (q) {
    listeners = listeners.filter(function (l) {
      return (l.displayName || '').toLowerCase().indexOf(q) >= 0
        || (l.nickname || '').toLowerCase().indexOf(q) >= 0
        || (l.username || '').toLowerCase().indexOf(q) >= 0;
    });
  }
  // システムタグ (OR)
  if (csUserPopoverState.systemTags.size > 0) {
    listeners = listeners.filter(function (l) { return csUserPopoverState.systemTags.has(l.systemTag); });
  }
  // ユーザータグ (OR)
  if (csUserPopoverState.userTags.size > 0) {
    listeners = listeners.filter(function (l) {
      for (var i = 0; i < l.userTags.length; i++) {
        if (csUserPopoverState.userTags.has(l.userTags[i])) return true;
      }
      return false;
    });
  }
  csUserPopoverState.filtered = listeners;
  renderUserPopoverList(listeners);
  renderUserPopoverBulkRow();
  renderUserPopoverCount();
}

function renderUserPopoverList(listeners) {
  var listEl = document.getElementById('cs-user-popover-list');
  if (!listEl) return;
  // change ハンドラは 1 度だけ attach (delegation)
  if (!listEl.dataset.listenerWired) {
    listEl.addEventListener('change', function (e) {
      if (e.target && e.target.tagName === 'INPUT') {
        var id = e.target.getAttribute('data-id');
        if (e.target.checked) csUserPopoverState.individualSelected.add(id);
        else csUserPopoverState.individualSelected.delete(id);
        renderUserPopoverCount();
      }
    });
    listEl.dataset.listenerWired = '1';
  }
  listEl.innerHTML = '';
  if (listeners.length === 0) {
    listEl.innerHTML = '<div class="cs-popover-empty">該当なし</div>';
    return;
  }
  var frag = document.createDocumentFragment();
  for (var i = 0; i < listeners.length; i++) {
    var l = listeners[i];
    var row = document.createElement('label');
    row.className = 'cs-popover-row';
    var checked = csUserPopoverState.individualSelected.has(l.channelId) ? 'checked' : '';
    var avatarHtml = l.iconUrl
      ? '<span class="cs-row-avatar"><img src="' + listenerMgrEscape(l.iconUrl) + '" alt=""></span>'
      : '<span class="cs-row-avatar">' + listenerMgrEscape((l.displayName || l.username || '?').charAt(0)) + '</span>';
    var primary = l.nickname || l.displayName || l.username || l.channelId;
    var secondary = (l.nickname && l.username ? l.username : '')
      + ((l.nickname && l.username && l.firstSeenAt) ? ' · ' : '')
      + (l.firstSeenAt ? '初コメ ' + listenerMgrFormatDate(l.firstSeenAt) : '');
    var stat = l.commentCount + ' 件 / ' + (l.superchatAmountJpy > 0 ? '<span class="cs-row-amber">' + listenerMgrFormatYen(l.superchatAmountJpy) + '</span>' : '—');
    var tagsHtml = '';
    if (l.systemTag) {
      var sysClass = 'cs-row-tag cs-row-tag-system';
      if (l.systemTag === 'first-time') sysClass += '-first';
      else if (l.systemTag === 'returning') sysClass += '-returning';
      else if (l.systemTag === 'veteran') sysClass += '-veteran';
      tagsHtml += '<span class="' + sysClass + '">' + systemTagLabel(l.systemTag) + '</span>';
    }
    for (var ti = 0; ti < l.userTags.length; ti++) {
      tagsHtml += '<span class="cs-row-tag cs-row-tag-user">' + listenerMgrEscape(l.userTags[ti]) + '</span>';
    }
    row.innerHTML =
      '<input type="checkbox" data-id="' + listenerMgrEscape(l.channelId) + '" ' + checked + '>' +
      avatarHtml +
      '<div class="cs-row-main">' +
        '<div class="cs-row-primary">' + listenerMgrEscape(primary) +
          (tagsHtml ? '<span class="cs-row-tags">' + tagsHtml + '</span>' : '') +
        '</div>' +
        (secondary ? '<div class="cs-row-secondary">' + listenerMgrEscape(secondary) + '</div>' : '') +
      '</div>' +
      '<span class="cs-row-stat">' + stat + '</span>';
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

function renderUserPopoverBulkRow() {
  var bulkEl = document.getElementById('cs-user-popover-bulk-row');
  var infoEl = document.getElementById('cs-user-popover-bulk-info');
  if (!bulkEl || !infoEl) return;
  var hasFilter = csUserPopoverState.systemTags.size > 0 || csUserPopoverState.userTags.size > 0;
  if (!hasFilter) {
    bulkEl.style.display = 'none';
    return;
  }
  bulkEl.style.display = '';
  var filtered = csUserPopoverState.filtered;
  var checkedInFilter = filtered.filter(function (l) { return csUserPopoverState.individualSelected.has(l.channelId); }).length;
  // ラベル: 「タグ『常連』 ∩ 『推し』 (= 9 件) のうち 2 件を選択中」
  var sysLabels = Array.from(csUserPopoverState.systemTags).map(systemTagLabel);
  var userLabels = Array.from(csUserPopoverState.userTags);
  var allLabels = sysLabels.concat(userLabels);
  var conjLabel = allLabels.length > 0 ? '「' + allLabels.join('」 ∩ 「') + '」' : '';
  infoEl.textContent = conjLabel + ' (= ' + filtered.length + ' 件) のうち ' + checkedInFilter + ' 件を選択中';
}

function renderUserPopoverCount() {
  var countEl = document.getElementById('cs-user-popover-count');
  if (!countEl) return;
  var n = csUserPopoverState.individualSelected.size;
  var totalListeners = csUserPopoverState.allListeners.length;
  var sysTagCount = csUserPopoverState.systemTags.size;
  var userTagCount = csUserPopoverState.userTags.size;
  var commitParts = [];
  if (sysTagCount > 0) commitParts.push('システム ' + sysTagCount);
  if (userTagCount > 0) commitParts.push('ユーザー ' + userTagCount);
  if (n > 0) commitParts.push(n + ' 人');
  var summary = commitParts.length > 0 ? '確定: ' + commitParts.join(' + ') : '未指定';
  countEl.textContent = summary + ' (全 ' + totalListeners + ' 人)';
  // bulk-row の情報も併せて更新
  renderUserPopoverBulkRow();
}

// 「このタグを全選択」: 現在のフィルタ結果を全部 individual に追加
function bulkSelectAllInFilter() {
  for (var i = 0; i < csUserPopoverState.filtered.length; i++) {
    csUserPopoverState.individualSelected.add(csUserPopoverState.filtered[i].channelId);
  }
  applyUserPopoverFilter();
}
// 「未選択を全選択」: 現在のフィルタ結果のうち未チェックのものを追加
function bulkSelectUnselectedInFilter() {
  for (var i = 0; i < csUserPopoverState.filtered.length; i++) {
    var id = csUserPopoverState.filtered[i].channelId;
    if (!csUserPopoverState.individualSelected.has(id)) {
      csUserPopoverState.individualSelected.add(id);
    }
  }
  applyUserPopoverFilter();
}

// --- 配信枠 popover (mock 仕様: タグ strip + bulk-row + アコーディオン風行) ---

var csStreamPopoverState = {
  streamTags: null,         // Set: active filter tags (also commit)
  individualSelected: null, // Set: checked stream ids
  searchQ: '',
  allStreams: [],           // [{videoId, title, startedAt, ...tags[]}]
  filtered: [],
  allTags: []               // [{tag, streamCount}]
};

function openStreamPopover() {
  csStreamPopoverState.streamTags = new Set(commentSearchState.query.streamTags || []);
  csStreamPopoverState.individualSelected = new Set(commentSearchState.query.streamIds || []);
  csStreamPopoverState.searchQ = '';
  csStreamPopoverState.allStreams = [];
  csStreamPopoverState.filtered = [];
  csStreamPopoverState.allTags = [];

  var listEl = document.getElementById('cs-stream-popover-list');
  if (listEl) listEl.innerHTML = '<div class="cs-popover-empty">読み込み中…</div>';
  var backdrop = document.getElementById('cs-stream-popover-backdrop');
  if (backdrop) backdrop.style.display = '';
  var searchInput = document.getElementById('cs-stream-popover-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = function () {
      csStreamPopoverState.searchQ = searchInput.value.trim();
      applyStreamPopoverFilter();
    };
  }

  Promise.all([
    api.listeners.streams({ sort: 'startedAt', limit: 1000, offset: 0 }),
    api.listeners.listAllStreamTags ? api.listeners.listAllStreamTags() : Promise.resolve({ ok: true, tags: [] }),
    api.listeners.listAllStreamTagAssignments ? api.listeners.listAllStreamTagAssignments() : Promise.resolve({ ok: true, assignments: [] })
  ]).then(function (results) {
    var streamsResp = results[0];
    var allTagsResp = results[1];
    var assignmentsResp = results[2];
    if (!streamsResp || !streamsResp.ok) throw new Error('streams fetch failed');
    var streams = streamsResp.page.rows || [];
    var tagsByVideo = {};
    if (assignmentsResp && assignmentsResp.ok) {
      var arr = assignmentsResp.assignments || [];
      for (var i = 0; i < arr.length; i++) {
        var a = arr[i];
        if (!tagsByVideo[a.videoId]) tagsByVideo[a.videoId] = [];
        tagsByVideo[a.videoId].push(a.tag);
      }
    }
    csStreamPopoverState.allStreams = streams.map(function (s) {
      var entry = {
        videoId: s.videoId,
        title: s.title || '',
        startedAt: s.startedAt || 0,
        endedAt: s.endedAt || 0,
        commentCount: s.commentCount || 0,
        superchatAmountJpy: s.superchatAmountJpy || 0,
        tags: tagsByVideo[s.videoId] || []
      };
      csCacheStreamFromList(s);
      return entry;
    });
    csStreamPopoverState.allTags = (allTagsResp && allTagsResp.ok) ? (allTagsResp.tags || []) : [];
    renderStreamPopoverTags();
    applyStreamPopoverFilter();
  }).catch(function (err) {
    rendererLog.error('stream popover load failed', err);
    if (listEl) listEl.innerHTML = '<div class="cs-popover-empty">読み込みに失敗しました</div>';
  });
}

function closeStreamPopover() {
  var backdrop = document.getElementById('cs-stream-popover-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function applyStreamPopover() {
  commentSearchState.query.streamTags = Array.from(csStreamPopoverState.streamTags);
  commentSearchState.query.streamIds = Array.from(csStreamPopoverState.individualSelected);
  renderStreamPickerChips();
  closeStreamPopover();
  // 選択変更だけでは検索しない。ユーザーが「検索」ボタンをクリックして発火させる。
}

function clearStreamPopoverState() {
  csStreamPopoverState.streamTags.clear();
  csStreamPopoverState.individualSelected.clear();
  renderStreamPopoverTags();
  applyStreamPopoverFilter();
}

function renderStreamPopoverTags() {
  var container = document.getElementById('cs-stream-popover-tags');
  if (!container) return;
  container.innerHTML = '';
  if (csStreamPopoverState.allTags.length === 0) {
    var empty = document.createElement('span');
    empty.className = 'cs-tag-empty';
    empty.style.cssText = 'font-size:10px;color:#5a6a78;padding:3px 4px';
    empty.textContent = 'タグ未登録 (配信詳細で付与可能)';
    container.appendChild(empty);
    return;
  }
  for (var i = 0; i < csStreamPopoverState.allTags.length; i++) {
    var t = csStreamPopoverState.allTags[i];
    var tag = document.createElement('span');
    tag.className = 'cs-tag' + (csStreamPopoverState.streamTags.has(t.tag) ? ' cs-active' : '');
    tag.textContent = t.tag;
    var ct = document.createElement('span');
    ct.className = 'cs-tag-ct';
    ct.textContent = String(t.streamCount);
    tag.appendChild(ct);
    (function (tagVal) {
      tag.addEventListener('click', function () {
        if (csStreamPopoverState.streamTags.has(tagVal)) csStreamPopoverState.streamTags.delete(tagVal);
        else csStreamPopoverState.streamTags.add(tagVal);
        renderStreamPopoverTags();
        applyStreamPopoverFilter();
      });
    }(t.tag));
    container.appendChild(tag);
  }
}

function applyStreamPopoverFilter() {
  var streams = csStreamPopoverState.allStreams;
  var q = csStreamPopoverState.searchQ.toLowerCase();
  if (q) {
    streams = streams.filter(function (s) {
      return (s.title || '').toLowerCase().indexOf(q) >= 0 || (s.videoId || '').toLowerCase().indexOf(q) >= 0;
    });
  }
  if (csStreamPopoverState.streamTags.size > 0) {
    streams = streams.filter(function (s) {
      for (var i = 0; i < s.tags.length; i++) {
        if (csStreamPopoverState.streamTags.has(s.tags[i])) return true;
      }
      return false;
    });
  }
  csStreamPopoverState.filtered = streams;
  renderStreamPopoverList(streams);
  renderStreamPopoverBulkRow();
  renderStreamPopoverCount();
}

function renderStreamPopoverList(streams) {
  var listEl = document.getElementById('cs-stream-popover-list');
  if (!listEl) return;
  if (!listEl.dataset.listenerWired) {
    listEl.addEventListener('change', function (e) {
      if (e.target && e.target.tagName === 'INPUT') {
        var id = e.target.getAttribute('data-id');
        if (e.target.checked) csStreamPopoverState.individualSelected.add(id);
        else csStreamPopoverState.individualSelected.delete(id);
        renderStreamPopoverCount();
      }
    });
    listEl.dataset.listenerWired = '1';
  }
  listEl.innerHTML = '';
  if (streams.length === 0) {
    listEl.innerHTML = '<div class="cs-popover-empty">該当なし</div>';
    return;
  }
  var frag = document.createDocumentFragment();
  for (var i = 0; i < streams.length; i++) {
    var s = streams[i];
    var row = document.createElement('label');
    row.className = 'cs-popover-row';
    var checked = csStreamPopoverState.individualSelected.has(s.videoId) ? 'checked' : '';
    var primary = s.title || s.videoId;
    var secondary = (s.startedAt ? listenerMgrFormatDateTime(s.startedAt) : '') + ' · ' + s.commentCount + ' 件';
    var stat = s.superchatAmountJpy > 0 ? '<span class="cs-row-amber">' + listenerMgrFormatYen(s.superchatAmountJpy) + '</span>' : '—';
    var tagsHtml = '';
    for (var ti = 0; ti < s.tags.length; ti++) {
      tagsHtml += '<span class="cs-row-tag cs-row-tag-user">' + listenerMgrEscape(s.tags[ti]) + '</span>';
    }
    row.innerHTML =
      '<input type="checkbox" data-id="' + listenerMgrEscape(s.videoId) + '" ' + checked + '>' +
      '<div class="cs-row-main">' +
        '<div class="cs-row-primary">' + listenerMgrEscape(primary) +
          (tagsHtml ? '<span class="cs-row-tags">' + tagsHtml + '</span>' : '') +
        '</div>' +
        '<div class="cs-row-secondary">' + listenerMgrEscape(secondary) + '</div>' +
      '</div>' +
      '<span class="cs-row-stat">' + stat + '</span>';
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

function renderStreamPopoverBulkRow() {
  var bulkEl = document.getElementById('cs-stream-popover-bulk-row');
  var infoEl = document.getElementById('cs-stream-popover-bulk-info');
  if (!bulkEl || !infoEl) return;
  if (csStreamPopoverState.streamTags.size === 0) {
    bulkEl.style.display = 'none';
    return;
  }
  bulkEl.style.display = '';
  var filtered = csStreamPopoverState.filtered;
  var checkedInFilter = filtered.filter(function (s) { return csStreamPopoverState.individualSelected.has(s.videoId); }).length;
  var labels = Array.from(csStreamPopoverState.streamTags);
  var label = labels.length > 0 ? '「' + labels.join('」 ∩ 「') + '」' : '';
  infoEl.textContent = label + ' (= ' + filtered.length + ' 件) のうち ' + checkedInFilter + ' 件を選択中';
}

function renderStreamPopoverCount() {
  var countEl = document.getElementById('cs-stream-popover-count');
  if (!countEl) return;
  var n = csStreamPopoverState.individualSelected.size;
  var total = csStreamPopoverState.allStreams.length;
  var tagCount = csStreamPopoverState.streamTags.size;
  var parts = [];
  if (tagCount > 0) parts.push('タグ ' + tagCount);
  if (n > 0) parts.push(n + ' 枠');
  var summary = parts.length > 0 ? '確定: ' + parts.join(' + ') : '未指定';
  countEl.textContent = summary + ' (全 ' + total + ' 枠)';
  renderStreamPopoverBulkRow();
}

function bulkSelectAllInStreamFilter() {
  for (var i = 0; i < csStreamPopoverState.filtered.length; i++) {
    csStreamPopoverState.individualSelected.add(csStreamPopoverState.filtered[i].videoId);
  }
  applyStreamPopoverFilter();
}
function bulkSelectUnselectedInStreamFilter() {
  for (var i = 0; i < csStreamPopoverState.filtered.length; i++) {
    var id = csStreamPopoverState.filtered[i].videoId;
    if (!csStreamPopoverState.individualSelected.has(id)) {
      csStreamPopoverState.individualSelected.add(id);
    }
  }
  applyStreamPopoverFilter();
}

// --- 期間 popover (preset + range fields + 2 ヶ月カレンダー + 年月ピッカー) ---

// state: 編集中の値 (popover 開いている間のみ有効)。確定で query に反映。
var csPeriodState = {
  fromMs: null,           // 編集中の開始 (epoch ms, 始端含む)
  toMs: null,             // 編集中の終了 (epoch ms, 終端含む)
  selectingEnd: false,    // false=次クリックで開始、true=次クリックで終了
  calLeftYear: 0,
  calLeftMonth: 0,        // 0-11
  ymPicker: null          // null | { side: 'left'|'right', year: number }
};

function openPeriodPopover() {
  // 現在の query から編集中値を初期化
  csPeriodState.fromMs = commentSearchState.query.periodFrom || null;
  csPeriodState.toMs = commentSearchState.query.periodTo
    ? commentSearchState.query.periodTo - 1 // periodTo は exclusive を inclusive 表現に直す
    : null;
  csPeriodState.selectingEnd = false;
  // カレンダーの初期表示月: 現状の to があればその月、無ければ今月
  var anchor = csPeriodState.toMs ? new Date(csPeriodState.toMs) : new Date();
  csPeriodState.calLeftYear = anchor.getFullYear();
  csPeriodState.calLeftMonth = anchor.getMonth() - 1;
  if (csPeriodState.calLeftMonth < 0) {
    csPeriodState.calLeftMonth += 12;
    csPeriodState.calLeftYear -= 1;
  }
  csPeriodState.ymPicker = null;
  // form input を反映
  var fromInput = document.getElementById('cs-period-input-from');
  var toInput = document.getElementById('cs-period-input-to');
  if (fromInput) fromInput.value = csPeriodState.fromMs ? msToDateInput(csPeriodState.fromMs) : '';
  if (toInput) toInput.value = csPeriodState.toMs ? msToDateInput(csPeriodState.toMs) : '';
  // カレンダー描画
  renderPeriodCalendars();
  hidePeriodYmPicker();
  updatePeriodSummary();
  // 表示
  var backdrop = document.getElementById('cs-period-backdrop');
  if (backdrop) backdrop.style.display = '';
}

function closePeriodPopover() {
  var backdrop = document.getElementById('cs-period-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function applyPeriodPopover() {
  // popover 内の編集値を query に反映 (periodTo は exclusive に変換)
  commentSearchState.query.periodFrom = csPeriodState.fromMs;
  commentSearchState.query.periodTo = csPeriodState.toMs ? csPeriodState.toMs + 1 : null;
  updatePeriodPickerLabel();
  closePeriodPopover();
  // 選択変更だけでは検索しない。ユーザーが「検索」ボタンをクリックして発火させる。
}

function clearPeriodPopover() {
  csPeriodState.fromMs = null;
  csPeriodState.toMs = null;
  csPeriodState.selectingEnd = false;
  var fromInput = document.getElementById('cs-period-input-from');
  var toInput = document.getElementById('cs-period-input-to');
  if (fromInput) fromInput.value = '';
  if (toInput) toInput.value = '';
  setActivePresetButton(null);
  renderPeriodCalendars();
  updatePeriodSummary();
}

function updatePeriodPickerLabel() {
  // F3 で chip 列に置き換え。互換維持のため関数名は残し、chip-row 描画にリダイレクト。
  renderPeriodPickerChips();
}

// preset ボタンを active 表示
function setActivePresetButton(preset) {
  var presetsRow = document.getElementById('cs-period-presets');
  if (!presetsRow) return;
  var btns = presetsRow.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].dataset.preset === preset);
  }
}

// preset を選択 → from/to を計算して state に反映
function selectPeriodPreset(preset) {
  var now = new Date();
  var todayStart = startOfDay(now);
  var f = null;
  var t = null;
  switch (preset) {
    case 'today':
      f = todayStart.getTime();
      t = endOfDay(now).getTime();
      break;
    case 'yesterday':
      var y = new Date(todayStart); y.setDate(y.getDate() - 1);
      f = y.getTime();
      t = endOfDay(y).getTime();
      break;
    case 'thisWeek':
      // 月曜起算
      var monday = new Date(todayStart);
      var dow = (monday.getDay() + 6) % 7; // 月=0
      monday.setDate(monday.getDate() - dow);
      f = monday.getTime();
      t = endOfDay(now).getTime();
      break;
    case 'thisMonth':
      f = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      t = endOfDay(now).getTime();
      break;
    case 'lastMonth':
      f = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
      t = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime();
      break;
    case 'last30':
      var d30 = new Date(todayStart); d30.setDate(d30.getDate() - 29);
      f = d30.getTime();
      t = endOfDay(now).getTime();
      break;
    case 'all':
      f = null; t = null;
      break;
  }
  csPeriodState.fromMs = f;
  csPeriodState.toMs = t;
  csPeriodState.selectingEnd = false;
  // input 反映
  var fromInput = document.getElementById('cs-period-input-from');
  var toInput = document.getElementById('cs-period-input-to');
  if (fromInput) fromInput.value = f ? msToDateInput(f) : '';
  if (toInput) toInput.value = t ? msToDateInput(t) : '';
  setActivePresetButton(preset);
  // カレンダー表示位置を適切な月に
  if (t) {
    var anchor = new Date(t);
    csPeriodState.calLeftYear = anchor.getFullYear();
    csPeriodState.calLeftMonth = anchor.getMonth() - 1;
    if (csPeriodState.calLeftMonth < 0) {
      csPeriodState.calLeftMonth += 12;
      csPeriodState.calLeftYear -= 1;
    }
  }
  renderPeriodCalendars();
  updatePeriodSummary();
}

function startOfDay(d) {
  var x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  var x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

// 2 ヶ月カレンダーを左右に描画
function renderPeriodCalendars() {
  var container = document.getElementById('cs-period-cals');
  if (!container) return;
  container.innerHTML = '';
  // 左 = calLeftYear/calLeftMonth、右 = +1 月
  var leftEl = buildMonthCalendar(csPeriodState.calLeftYear, csPeriodState.calLeftMonth, 'left');
  container.appendChild(leftEl);
  var rightYear = csPeriodState.calLeftYear;
  var rightMonth = csPeriodState.calLeftMonth + 1;
  if (rightMonth > 11) { rightMonth -= 12; rightYear += 1; }
  var rightEl = buildMonthCalendar(rightYear, rightMonth, 'right');
  container.appendChild(rightEl);
}

// 1 月分のミニカレンダー (週ヘッダ + 日付グリッド + 月ナビ)
function buildMonthCalendar(year, month, side) {
  var wrap = document.createElement('div');
  wrap.className = 'cs-month-cal';
  // ヘッダ (◀ Y/M ▶)。月名クリックで年月ピッカー。
  var head = document.createElement('div');
  head.className = 'cs-month-cal-h';
  if (side === 'left') {
    var prev = document.createElement('button');
    prev.className = 'cs-month-nav';
    prev.textContent = '◀';
    prev.title = '前の月';
    prev.addEventListener('click', function () {
      csPeriodState.calLeftMonth -= 1;
      if (csPeriodState.calLeftMonth < 0) {
        csPeriodState.calLeftMonth += 12;
        csPeriodState.calLeftYear -= 1;
      }
      renderPeriodCalendars();
    });
    head.appendChild(prev);
  } else {
    head.appendChild(document.createElement('span')); // spacer
  }
  var name = document.createElement('span');
  name.className = 'cs-month-name';
  name.textContent = year + ' / ' + (month + 1);
  name.addEventListener('click', function () { showPeriodYmPicker(side, year); });
  head.appendChild(name);
  if (side === 'right') {
    var next = document.createElement('button');
    next.className = 'cs-month-nav';
    next.textContent = '▶';
    next.title = '次の月';
    next.addEventListener('click', function () {
      csPeriodState.calLeftMonth += 1;
      if (csPeriodState.calLeftMonth > 11) {
        csPeriodState.calLeftMonth -= 12;
        csPeriodState.calLeftYear += 1;
      }
      renderPeriodCalendars();
    });
    head.appendChild(next);
  } else {
    head.appendChild(document.createElement('span')); // spacer
  }
  wrap.appendChild(head);

  // 日付グリッド (日〜土ヘッダ + 日付セル、当月以外は cs-other-month)
  var grid = document.createElement('div');
  grid.className = 'cs-month-cal-grid';
  var dows = ['日', '月', '火', '水', '木', '金', '土'];
  for (var di = 0; di < 7; di++) {
    var dh = document.createElement('span');
    dh.className = 'cs-dow' + (di === 0 ? ' cs-sun' : '') + (di === 6 ? ' cs-sat' : '');
    dh.textContent = dows[di];
    grid.appendChild(dh);
  }
  // 当月 1 日の曜日 → 前月末から前埋め
  var first = new Date(year, month, 1);
  var firstDow = first.getDay();
  // 前月の末日から逆算してパディング
  var lead = firstDow;
  var daysInPrev = new Date(year, month, 0).getDate();
  for (var p = 0; p < lead; p++) {
    var d = daysInPrev - lead + 1 + p;
    var cell = document.createElement('span');
    cell.className = 'cs-day cs-other-month';
    cell.textContent = String(d);
    grid.appendChild(cell);
  }
  // 当月の日付
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  for (var dd = 1; dd <= daysInMonth; dd++) {
    var cellEl = document.createElement('span');
    cellEl.className = 'cs-day';
    cellEl.textContent = String(dd);
    var cellDate = new Date(year, month, dd);
    var cellMs = cellDate.getTime();
    // 範囲表示 (cs-in-range / cs-range-end)
    var f = csPeriodState.fromMs;
    var t = csPeriodState.toMs;
    if (f && t && cellMs >= startOfDay(new Date(f)).getTime() && cellMs <= startOfDay(new Date(t)).getTime()) {
      cellEl.classList.add('cs-in-range');
    }
    if (f && cellMs === startOfDay(new Date(f)).getTime()) cellEl.classList.add('cs-range-end');
    if (t && cellMs === startOfDay(new Date(t)).getTime()) cellEl.classList.add('cs-range-end');
    (function (msVal) {
      cellEl.addEventListener('click', function () { onPeriodDayClick(msVal); });
    }(cellMs));
    grid.appendChild(cellEl);
  }
  // 後埋め (6 行 × 7 = 42 セル)
  var totalCells = 7 + lead + daysInMonth;
  var trailing = (totalCells % 7 === 0) ? 0 : (7 - (totalCells % 7));
  for (var tr = 1; tr <= trailing; tr++) {
    var tc = document.createElement('span');
    tc.className = 'cs-day cs-other-month';
    tc.textContent = String(tr);
    grid.appendChild(tc);
  }
  wrap.appendChild(grid);
  return wrap;
}

// 日付セルクリック: 開始 → 終了 → 開始 → ... の順で交互に設定
function onPeriodDayClick(ms) {
  var dayStart = startOfDay(new Date(ms)).getTime();
  var dayEnd = endOfDay(new Date(ms)).getTime();
  if (!csPeriodState.fromMs || (csPeriodState.fromMs && csPeriodState.toMs)) {
    // 新規選択開始
    csPeriodState.fromMs = dayStart;
    csPeriodState.toMs = null;
    csPeriodState.selectingEnd = true;
  } else {
    // 終了選択
    if (dayStart < csPeriodState.fromMs) {
      csPeriodState.toMs = endOfDay(new Date(csPeriodState.fromMs)).getTime();
      csPeriodState.fromMs = dayStart;
    } else {
      csPeriodState.toMs = dayEnd;
    }
    csPeriodState.selectingEnd = false;
  }
  // input 同期
  var fromInput = document.getElementById('cs-period-input-from');
  var toInput = document.getElementById('cs-period-input-to');
  if (fromInput) fromInput.value = csPeriodState.fromMs ? msToDateInput(csPeriodState.fromMs) : '';
  if (toInput) toInput.value = csPeriodState.toMs ? msToDateInput(csPeriodState.toMs) : '';
  setActivePresetButton(null);
  renderPeriodCalendars();
  updatePeriodSummary();
}

// input から手動編集 → state 反映
function onPeriodInputChange() {
  var fromInput = document.getElementById('cs-period-input-from');
  var toInput = document.getElementById('cs-period-input-to');
  if (fromInput) {
    csPeriodState.fromMs = fromInput.value ? Date.parse(fromInput.value + 'T00:00:00') : null;
  }
  if (toInput) {
    csPeriodState.toMs = toInput.value ? Date.parse(toInput.value + 'T23:59:59.999') : null;
  }
  setActivePresetButton(null);
  renderPeriodCalendars();
  updatePeriodSummary();
}

function updatePeriodSummary() {
  var sumEl = document.getElementById('cs-period-summary');
  if (!sumEl) return;
  var f = csPeriodState.fromMs;
  var t = csPeriodState.toMs;
  if (!f && !t) { sumEl.textContent = '期間未指定 (= 全期間)'; return; }
  var days = (f && t) ? Math.round((t - f) / (24 * 3600 * 1000)) + 1 : 0;
  sumEl.textContent = (f ? listenerMgrFormatDate(f) : '?') + ' – ' + (t ? listenerMgrFormatDate(t) : '?')
    + (days > 0 ? ' (' + days + ' 日間)' : '');
}

// 年月ピッカー (月名クリックで開く)
function showPeriodYmPicker(side, year) {
  csPeriodState.ymPicker = { side: side, year: year };
  var picker = document.getElementById('cs-period-ym-picker');
  if (!picker) return;
  picker.style.display = '';
  picker.innerHTML = '';
  // ヘッダ
  var head = document.createElement('div');
  head.className = 'cs-ym-h';
  var prev = document.createElement('button');
  prev.textContent = '◀';
  prev.addEventListener('click', function () {
    csPeriodState.ymPicker.year -= 1;
    showPeriodYmPicker(csPeriodState.ymPicker.side, csPeriodState.ymPicker.year);
  });
  head.appendChild(prev);
  var span = document.createElement('span');
  span.textContent = String(year) + ' 年';
  head.appendChild(span);
  var next = document.createElement('button');
  next.textContent = '▶';
  next.addEventListener('click', function () {
    csPeriodState.ymPicker.year += 1;
    showPeriodYmPicker(csPeriodState.ymPicker.side, csPeriodState.ymPicker.year);
  });
  head.appendChild(next);
  picker.appendChild(head);

  // 4×3 月グリッド
  var grid = document.createElement('div');
  grid.className = 'cs-ym-grid';
  for (var m = 0; m < 12; m++) {
    var cell = document.createElement('span');
    cell.className = 'cs-ym-cell';
    var isActive = (year === csPeriodState.calLeftYear && m === csPeriodState.calLeftMonth)
      || (side === 'right' && year === (csPeriodState.calLeftMonth === 11 ? csPeriodState.calLeftYear + 1 : csPeriodState.calLeftYear)
          && m === (csPeriodState.calLeftMonth + 1) % 12);
    if (isActive) cell.classList.add('active');
    cell.textContent = (m + 1) + ' 月';
    (function (mm, yy) {
      cell.addEventListener('click', function () {
        if (side === 'left') {
          csPeriodState.calLeftYear = yy;
          csPeriodState.calLeftMonth = mm;
        } else {
          // right を選んだ → left を 1 月戻す
          var lm = mm - 1;
          var ly = yy;
          if (lm < 0) { lm = 11; ly -= 1; }
          csPeriodState.calLeftYear = ly;
          csPeriodState.calLeftMonth = lm;
        }
        hidePeriodYmPicker();
        renderPeriodCalendars();
      });
    }(m, year));
    grid.appendChild(cell);
  }
  picker.appendChild(grid);
}

function hidePeriodYmPicker() {
  csPeriodState.ymPicker = null;
  var picker = document.getElementById('cs-period-ym-picker');
  if (picker) picker.style.display = 'none';
}

// (F1 までは form 直下にユーザータグ pill 行があり、ここでフェッチして再描画していた。
//  F2 でユーザータグ strip は popover 内に集約され、popover 開く度に最新を fetch する
//  ようになったので、この関数は呼び出し互換のための no-op として残してある。
//  外部 (listener detail のタグ編集 / open*Manager 等) からの呼び出し点は将来削除予定。)
function refreshUserTagPills() { /* no-op: popover が fetch する */ }

// form の値を query state に取り込む
function readCommentSearchForm() {
  var q = commentSearchState.query;
  var bodyEl = document.getElementById('cs-body-q');
  var titleEl = document.getElementById('cs-stream-title-q');
  var nameEl = document.getElementById('cs-name-q');
  var scopeEl = document.getElementById('cs-scope');
  q.bodyQ = bodyEl ? bodyEl.value.trim() : '';
  q.streamTitleQ = titleEl ? titleEl.value.trim() : '';
  q.nameQ = nameEl ? nameEl.value.trim() : '';
  q.scope = scopeEl ? scopeEl.value : 'own';
  // periodFrom / periodTo は期間 popover (applyPeriodPopover) で直書き済み
  // 種別 (multi-checkbox)。「ギフト」pill は 3 種展開する (readCommentTypesFromForm)。
  q.commentTypes = readCommentTypesFromForm();
  // systemTags / userTags / listenerChannelIds / streamIds はユーザー popover で
  // commentSearchState.query に直書き済み (この関数では触らない)
}

function readCheckboxRow(rowId) {
  var row = document.getElementById(rowId);
  if (!row) return [];
  var checks = row.querySelectorAll('input[type="checkbox"]:checked');
  var out = [];
  for (var i = 0; i < checks.length; i++) out.push(checks[i].value);
  return out;
}

// cs-form の「ギフト」pill (value="gift") は UI 上の意味 = 「お金を投げる行為すべて」
// (= superchat + sticker + (membership_)gift)。DB の comment_type "gift" は実際には
// membership_gift しか指さないので、フォーム → クエリ送出時に展開する。
// 「メンバー加入」(membership) は別 pill で扱う (= money throw ではないので分離)。
// classify_comment_type (core/src/engine/listener_manager.rs:4226) と合わせる。
var CS_GIFT_PILL_EXPANSION = ['superchat', 'sticker', 'gift'];
function readCommentTypesFromForm() {
  var raw = readCheckboxRow('cs-type-row');
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] === 'gift') {
      for (var j = 0; j < CS_GIFT_PILL_EXPANSION.length; j++) out.push(CS_GIFT_PILL_EXPANSION[j]);
    } else {
      out.push(raw[i]);
    }
  }
  return out;
}
// 保存検索ロード時の逆変換。commentTypes に superchat / sticker / gift のいずれかが
// 含まれていればギフト pill を check する (= 細かい区別は失うが、pill を統合した時点で
// やむなしの設計トレードオフ)。
function setCommentTypesOnForm(types) {
  var arr = Array.isArray(types) ? types : [];
  var hasGift = arr.some(function (t) { return CS_GIFT_PILL_EXPANSION.indexOf(t) >= 0; });
  var others = arr.filter(function (t) { return CS_GIFT_PILL_EXPANSION.indexOf(t) < 0; });
  var values = others.slice();
  if (hasGift) values.push('gift');
  setRowChecks('cs-type-row', values);
}

function clearCommentSearchForm() {
  ['cs-body-q', 'cs-stream-title-q', 'cs-name-q'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var typeRow = document.getElementById('cs-type-row');
  if (typeRow) {
    var typeChecks = typeRow.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < typeChecks.length; i++) typeChecks[i].checked = false;
  }
  // popover で選択された値もクリア
  commentSearchState.query.listenerChannelIds = [];
  commentSearchState.query.streamIds = [];
  commentSearchState.query.systemTags = [];
  commentSearchState.query.userTags = [];
  commentSearchState.query.streamTags = [];
  commentSearchState.query.periodFrom = null;
  commentSearchState.query.periodTo = null;
  commentSearchState.query.scope = 'own';
  var scopeEl = document.getElementById('cs-scope');
  if (scopeEl) scopeEl.value = 'own';
  updateUserPickerLabel();
  updatePickerLabel('stream');
  updatePeriodPickerLabel();
}

function runCommentSearch() {
  if (!api.listeners) return;
  readCommentSearchForm();
  var q = commentSearchState.query;
  // 検索 API リクエスト (新仕様: include_kpi で KPI 集計を要求)
  var query = {
    bodyQ: q.bodyQ || null,
    streamTitleQ: q.streamTitleQ || null,
    nameQ: q.nameQ || null,
    commentTypes: q.commentTypes || [],
    streamIds: q.streamIds || [],
    listenerChannelIds: q.listenerChannelIds || [],
    systemTags: q.systemTags || [],
    userTags: q.userTags || [],
    streamTags: q.streamTags || [],
    periodFrom: q.periodFrom,
    periodTo: q.periodTo,
    scope: q.scope || 'own',
    includeKpi: true,
    limit: 500,
    offset: 0
  };
  showCommentSearchState('loading');
  api.listeners.searchComments(query).then(function (resp) {
    if (!resp || !resp.ok) {
      showCommentSearchState('error', resp && resp.error ? resp.error : 'unknown');
      return;
    }
    commentSearchState.lastResult = resp.page;
    renderCommentSearchResults(resp.page);
    // 検索成功 → form を畳んで applied-chips に切り替え
    collapseSearchForm();
  }).catch(function (err) {
    rendererLog.error('searchComments failed', err);
    showCommentSearchState('error', err && err.message ? err.message : String(err));
  });
}

// 状態カードの表示切替: 'initial' / 'loading' / 'error' / 'empty' / 'results'
// applied-chips は collapse/expand 側で管理するためここでは触らない
// (= 0 件状態でも前回の chips が見えていたほうが「何を検索したか」分かる)
function showCommentSearchState(state, errorMsg) {
  var ids = ['cs-initial-state', 'cs-loading-state', 'cs-error-state', 'cs-empty-state'];
  ids.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var summary = document.getElementById('cs-summary-card');
  var listEl = document.getElementById('cs-stream-list');
  if (state !== 'results') {
    if (summary) summary.style.display = 'none';
    if (listEl) listEl.style.display = 'none';
  } else {
    if (listEl) listEl.style.display = '';
  }
  if (state === 'initial') {
    var iel = document.getElementById('cs-initial-state'); if (iel) iel.style.display = '';
  } else if (state === 'loading') {
    var lel = document.getElementById('cs-loading-state'); if (lel) lel.style.display = '';
  } else if (state === 'error') {
    var eel = document.getElementById('cs-error-state'); if (eel) eel.style.display = '';
    var detail = document.getElementById('cs-error-detail');
    if (detail) detail.textContent = errorMsg || '';
  } else if (state === 'empty') {
    var emptyHint = document.querySelector('#cs-empty-state .cs-state-hint');
    if (emptyHint) {
      var scope = (commentSearchState.query && commentSearchState.query.scope) || 'own';
      emptyHint.textContent = scope === 'own'
        ? '自チャンネルの記録済みコメント内で、条件を緩めるか別のキーワードを試してください'
        : scope === 'other'
          ? '他チャンネルの表示用コメント内で、条件を緩めるか別のキーワードを試してください'
          : '記録済みコメント全体で、条件を緩めるか別のキーワードを試してください';
    }
    var emp = document.getElementById('cs-empty-state'); if (emp) emp.style.display = '';
  }
}

// KPI summary card を更新
function renderCommentSearchKpi(kpi, streamCount) {
  var card = document.getElementById('cs-summary-card');
  if (!card) return;
  if (!kpi || (kpi.totalCount === 0 && streamCount === 0)) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  // 件数
  setHtml('cs-kpi-count', String(kpi.totalCount) + '<span class="unit">件</span>');
  // 平均 = totalCount / streamCount
  var avgCount = kpi.streamCount > 0 ? (kpi.totalCount / kpi.streamCount).toFixed(1) : '0';
  setHtml('cs-kpi-count-avg', '<span class="k">avg</span><span class="v2">' + avgCount + '</span> 件/枠');

  // 金額
  setText('cs-kpi-amount', listenerMgrFormatYen(kpi.totalAmountJpy || 0));
  var avgAmount = kpi.streamCount > 0 ? Math.round((kpi.totalAmountJpy || 0) / kpi.streamCount) : 0;
  setHtml('cs-kpi-amount-avg', '<span class="k">avg</span><span class="v2 amber">' + listenerMgrFormatYen(avgAmount) + '</span>/枠');

  // コメントリスナー数 (各枠ユニーク数の平均)
  setHtml('cs-kpi-listeners', String(kpi.uniqueListeners) + '<span class="unit">人</span>');
  var avgUnique = (kpi.avgUniqueListenersPerStream || 0).toFixed(1);
  setHtml('cs-kpi-listeners-avg', '<span class="k">avg</span><span class="v2">' + avgUnique + '</span> 人/枠');

  // いいね
  setHtml('cs-kpi-likes', String(kpi.totalLikes || 0));
  var avgLikes = (kpi.avgLikesPerStream || 0);
  var avgLikesStr = avgLikes >= 1000 ? Math.round(avgLikes).toLocaleString() : avgLikes.toFixed(1);
  setHtml('cs-kpi-likes-avg', '<span class="k">avg</span><span class="v2">' + avgLikesStr + '</span> /枠');

  // ピーク同接 (= 全マッチ枠中の最大値、= 最も盛り上がった枠の同接)
  setHtml('cs-kpi-peak', String(kpi.maxPeakViewers || 0));
  var avgPeak = (kpi.avgPeakViewersPerStream || 0);
  var avgPeakStr = avgPeak >= 1000 ? Math.round(avgPeak).toLocaleString() : avgPeak.toFixed(1);
  setHtml('cs-kpi-peak-avg', '<span class="k">avg</span><span class="v2">' + avgPeakStr + '</span> /枠');

  // 配信
  setHtml('cs-kpi-streams', String(kpi.streamCount) + '<span class="unit">枠</span>');
  if (kpi.periodFrom && kpi.periodTo) {
    var fromStr = listenerMgrFormatDate(kpi.periodFrom);
    var toStr = listenerMgrFormatDate(kpi.periodTo);
    setHtml('cs-kpi-period-range', '<span class="k">range</span> ' + fromStr + ' – ' + toStr);
  } else {
    setText('cs-kpi-period-range', '');
  }
}

// 配信単位アコーディオン + コメントセル (= buildCommentItem 流用)。
// page.streams (絞込みにマッチする全枠) を一次ソースに使い、page.rows (limit:500) で
// 流れてきた範囲のコメントを各枠に充填。limit を超えて取れなかった枠は
// プレースホルダ表示し、展開時に該当枠だけ追加 fetch する。
function renderCommentSearchResults(page) {
  var listEl = document.getElementById('cs-stream-list');
  if (!listEl) return;

  // streams 配列を csStreamCache に取り込んでから chip 列を再描画
  // (picker-pill chip がタイトル等を引けるように)
  if (Array.isArray(page.streams)) {
    for (var sCache = 0; sCache < page.streams.length; sCache++) {
      csCacheStreamFromKpi(page.streams[sCache]);
    }
  }
  renderStreamPickerChips();

  // 既存の virtualization controller を破棄してから DOM をリセット
  // (= 検索リロード時に古い controller が dataRows 配列を握り続けないように)
  destroyAllVirtualLists();

  var hasStreams = Array.isArray(page.streams) && page.streams.length > 0;
  if (!hasStreams) {
    // 0 件: empty state を表示し summary / list は隠す
    listEl.innerHTML = '';
    showCommentSearchState('empty');
    return;
  }
  // 結果あり: 状態カードを全部隠して結果エリアを出す
  showCommentSearchState('results');
  var summaryEl = document.getElementById('cs-summary-card');
  if (summaryEl) summaryEl.style.display = '';
  // KPI summary を更新 (結果モードで初めて呼ぶ)
  renderCommentSearchKpi(page.kpi, (page.streams || []).length);

  // page.rows を stream_id でグループ化 (posted_at DESC 順を維持)
  var groups = {};
  for (var r = 0; r < page.rows.length; r++) {
    var row = page.rows[r];
    var sid = row.streamId || '';
    if (!groups[sid]) groups[sid] = [];
    groups[sid].push(row);
  }

  // 既存 DOM クリア (検索結果は user-action 駆動なので innerHTML='' OK)
  listEl.innerHTML = '';
  // 先に row を持っている枠を最初に open する (=「この検索の主役」)
  var firstStreamWithRows = -1;
  for (var s = 0; s < page.streams.length; s++) {
    if (groups[page.streams[s].streamId] && groups[page.streams[s].streamId].length > 0) {
      firstStreamWithRows = s;
      break;
    }
  }
  for (var g = 0; g < page.streams.length; g++) {
    var streamKpi = page.streams[g];
    var rows = groups[streamKpi.streamId] || [];
    var streamEl = buildCommentSearchStreamCard(streamKpi.streamId, streamKpi, rows, g === firstStreamWithRows);
    listEl.appendChild(streamEl);
  }
  // 各 stream card 内部で setupLazyCommentRender が走った時、body はまだ DOM に
  // attach されていないので bodyRect.height=0 で初期レンダリングがスキップされる
  // (= 「検索後スクロールするまで何も出ない」)。append 完了後の次フレームで
  // 全 controller の updateWindow を一度叩いて初期描画を起こす。
  requestAnimationFrame(function () {
    csActiveVirtualLists.forEach(function (ctrl) { ctrl.updateWindow(); });
  });
}

// 完全 virtualization: top spacer + 描画 window + bottom spacer の構造で、
// スクロール位置に応じて DOM を再生成する。20K 行でも常時 ~150 行分の DOM 量に
// 抑える (= 大量結果でもメモリが膨らまない)。
//
// 仕組み:
//   - dataRows に全データを保持 (DOM ではない、JS array)。
//   - bodyEl の中身を [topSpacer, ...visibleRows, bottomSpacer] の構造に。
//   - スクロールコンテナ (#main-area) の visible 範囲から index 帯を計算し、
//     viewport ± BUFFER の範囲だけ DOM ノードを実体化、それ以外は spacer の
//     高さで scrollHeight を確保する (= スクロールバーが正しい長さを示す)。
//   - スクロール / リサイズ毎に rAF debounce で再計算 → 範囲外は remove、
//     範囲内に入った行を append。
//
// 多 stream 対応: csActiveVirtualLists Set に全 controller を登録し、単一の
// scroll listener で一括処理する (= scroll event 1 個 / フレーム)。
var csActiveVirtualLists = new Set();
var csVirtualScrollHandler = null;
var csVirtualScrollContainer = null;
function ensureGlobalVirtualScrollHandler() {
  if (csVirtualScrollHandler) return;
  // UI 整理 Phase 2-6: cl-frame > .cs-panel をスクロール container に。
  // cs-panel は class="cl-tab-panel listener-mgr-tab-panel cs-panel" + .active で
  // overflow-y: auto。virtual scroll の getBoundingClientRect 基準もこの panel 内になる。
  csVirtualScrollContainer = document.querySelector('.cl-tab-panel.cs-panel');
  // フォールバック (= cs-panel が DOM に無いケース。理屈上はあり得ないが安全装置)
  if (!csVirtualScrollContainer) csVirtualScrollContainer = document.querySelector('main');
  var rafScheduled = false;
  csVirtualScrollHandler = function () {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      csActiveVirtualLists.forEach(function (ctrl) { ctrl.updateWindow(); });
    });
  };
  if (csVirtualScrollContainer) {
    csVirtualScrollContainer.addEventListener('scroll', csVirtualScrollHandler, { passive: true });
  } else {
    window.addEventListener('scroll', csVirtualScrollHandler, { passive: true });
  }
  window.addEventListener('resize', csVirtualScrollHandler, { passive: true });
}
function destroyAllVirtualLists() {
  csActiveVirtualLists.forEach(function (ctrl) {
    if (ctrl.destroy) ctrl.destroy();
  });
  csActiveVirtualLists.clear();
}

function setupLazyCommentRender(bodyEl, dataRows, options) {
  options = options || {};
  // options.streamIsOwn: この virtualization が表示する全コメは同じ枠 (= 同じ
  // owner) に属する前提で、buildCommentItem に渡す自枠判定。stream-detail-modal
  // 等で過去枠の owner_channel_id を解決して set する。未指定なら buildCommentItem
  // 側で global isOwnStream にフォールバック。
  // options.scrollContainer: スクロール検出に使う要素。未指定なら global
  // csVirtualScrollContainer (= cs-panel) → 無ければ window にフォールバック。
  // listener 詳細モーダル等、別 scroll 領域で使うときに渡す。
  var scrollContainer = options.scrollContainer || csVirtualScrollContainer;
  var BUFFER_ROWS = 30;          // viewport 上下にこの行数だけ余分に描画 (スクロール先回り)
  var DEFAULT_HEIGHT = 56;       // 未測定行の暫定高さ (px)、measuredHeights の平均で逐次更新

  // 各行の measured height (index → px)。未測定行は defaultHeight を使う。
  var heightCache = [];
  var defaultHeight = DEFAULT_HEIGHT;
  var measuredSum = 0;
  var measuredCount = 0;
  // prefixSum[i] = sum of heights[0..i-1] (= row i の上端 offset)
  // 高さキャッシュが変わった時に prefixSumDirty = true で再構築される。
  var prefixSum = [0];
  var prefixSumDirty = true;

  function rowHeight(i) {
    return heightCache[i] !== undefined ? heightCache[i] : defaultHeight;
  }

  function rebuildPrefixSum() {
    var n = dataRows.length;
    prefixSum = new Array(n + 1);
    prefixSum[0] = 0;
    for (var i = 0; i < n; i++) {
      prefixSum[i + 1] = prefixSum[i] + rowHeight(i);
    }
    prefixSumDirty = false;
  }

  function ensurePrefixSum() {
    if (prefixSumDirty || prefixSum.length !== dataRows.length + 1) rebuildPrefixSum();
  }

  // 二分探索: target px 位置にある行の index を返す
  function findRowAtOffset(target) {
    ensurePrefixSum();
    var lo = 0, hi = dataRows.length;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (prefixSum[mid + 1] <= target) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, dataRows.length - 1);
  }

  // top + bottom spacer
  var topSpacer = document.createElement('div');
  topSpacer.className = 'cs-virt-spacer';
  topSpacer.style.height = '0px';
  bodyEl.appendChild(topSpacer);
  var bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'cs-virt-spacer';
  bottomSpacer.style.height = '0px';
  bodyEl.appendChild(bottomSpacer);

  var renderedStart = 0;
  var renderedEnd = -1; // -1 = まだ何も描画してない

  function getVisibleRange() {
    if (dataRows.length === 0) return [0, -1];
    var bodyRect = bodyEl.getBoundingClientRect();
    if (bodyRect.height === 0) return [0, -1]; // collapsed (display:none)
    var viewTop, viewBottom;
    if (scrollContainer) {
      var cRect = scrollContainer.getBoundingClientRect();
      viewTop = cRect.top;
      viewBottom = cRect.bottom;
    } else {
      viewTop = 0;
      viewBottom = window.innerHeight;
    }
    var localTop = Math.max(0, viewTop - bodyRect.top);
    var localBottom = Math.max(0, viewBottom - bodyRect.top);
    if (localBottom <= 0) return [0, -1];
    ensurePrefixSum();
    var totalH = prefixSum[dataRows.length];
    if (localTop >= totalH) return [0, -1];
    var first = Math.max(0, findRowAtOffset(localTop) - BUFFER_ROWS);
    var last = Math.min(dataRows.length - 1, findRowAtOffset(localBottom) + BUFFER_ROWS);
    if (first > last) return [0, -1];
    return [first, last];
  }

  function clearRenderedRows() {
    var node = topSpacer.nextSibling;
    while (node && node !== bottomSpacer) {
      var next = node.nextSibling;
      bodyEl.removeChild(node);
      node = next;
    }
  }

  // 描画した行の offsetHeight を測定して heightCache に保存。
  // defaultHeight は measured rows の平均で running update。
  function measureRenderedRows() {
    if (renderedEnd < renderedStart) return;
    var node = topSpacer.nextSibling;
    var idx = renderedStart;
    var changed = false;
    while (node && node !== bottomSpacer && idx <= renderedEnd) {
      var h = node.offsetHeight;
      if (h > 0) {
        var prev = heightCache[idx];
        if (prev !== h) {
          if (prev === undefined) {
            measuredSum += h;
            measuredCount += 1;
          } else {
            measuredSum += (h - prev);
          }
          heightCache[idx] = h;
          changed = true;
        }
      }
      node = node.nextSibling;
      idx++;
    }
    if (changed) {
      if (measuredCount > 0) defaultHeight = measuredSum / measuredCount;
      prefixSumDirty = true;
    }
  }

  function updateSpacers() {
    ensurePrefixSum();
    var totalH = prefixSum[dataRows.length];
    var topH = renderedStart > 0 ? prefixSum[renderedStart] : 0;
    var bottomH = (renderedEnd >= 0 && renderedEnd + 1 <= dataRows.length)
      ? (totalH - prefixSum[renderedEnd + 1])
      : totalH;
    topSpacer.style.height = topH + 'px';
    bottomSpacer.style.height = bottomH + 'px';
  }

  function updateWindow() {
    var range = getVisibleRange();
    var newStart = range[0], newEnd = range[1];
    if (newStart !== renderedStart || newEnd !== renderedEnd) {
      clearRenderedRows();
      if (newEnd >= newStart && newEnd >= 0) {
        var frag = document.createDocumentFragment();
        for (var i = newStart; i <= newEnd; i++) {
          var rowNode = buildCommentItem(commentRowToCellData(dataRows[i]), options);
          // options.rowDecorator: row DOM が生成された直後に呼ばれる装飾フック。
          // listener 詳細「全コメ」タブで data-stream-id + title 属性を当てるのに使う。
          if (typeof options.rowDecorator === 'function') {
            options.rowDecorator(rowNode, dataRows[i]);
          }
          frag.appendChild(rowNode);
        }
        bodyEl.insertBefore(frag, bottomSpacer);
      }
      renderedStart = newStart;
      renderedEnd = newEnd;
      measureRenderedRows(); // 新規描画行の高さを測定 → defaultHeight 更新 + prefixSum dirty
    }
    // spacer は range が同じでも dataRows.length 変動 / 高さ変動で常に再計算
    updateSpacers();
  }

  var controller = {
    updateWindow: updateWindow,
    notifyDataExtended: function () {
      // データ追加 = prefixSum 再計算が必要
      prefixSumDirty = true;
      // 初回データ着信 or viewport 内に新規データが入った場合は updateWindow
      if (renderedEnd === -1 || getVisibleRange()[1] > renderedEnd) {
        updateWindow();
      } else {
        updateSpacers();
      }
    },
    destroy: function () {
      csActiveVirtualLists.delete(controller);
    }
  };
  csActiveVirtualLists.add(controller);
  ensureGlobalVirtualScrollHandler();
  return controller;
}

// 1 配信枠 = 1 アコーディオン要素を作る。openInitially=true なら初期展開。
function buildCommentSearchStreamCard(streamId, streamKpi, rows, openInitially) {
  var stream = document.createElement('div');
  stream.className = 'cs-stream' + (openInitially ? '' : ' cs-collapsed');
  stream.dataset.streamId = streamId;

  // ヘッダ (1 行目: arrow + title + date / 2 行目: 4 KPI)
  var head = document.createElement('div');
  head.className = 'cs-stream-h';

  var arrow = document.createElement('span');
  arrow.className = 'cs-arrow';
  arrow.textContent = '▼';
  head.appendChild(arrow);

  var titleEl = document.createElement('span');
  titleEl.className = 'cs-title';
  titleEl.textContent = (streamKpi && streamKpi.title) ? streamKpi.title : streamId;
  head.appendChild(titleEl);

  var dateEl = document.createElement('span');
  dateEl.className = 'cs-date';
  if (streamKpi && streamKpi.startedAt) {
    var dateStr = listenerMgrFormatDateTime(streamKpi.startedAt);
    if (streamKpi.endedAt && streamKpi.endedAt > streamKpi.startedAt) {
      dateStr += ' – ' + listenerMgrFormatTime(streamKpi.endedAt);
    }
    dateEl.textContent = dateStr;
  }
  head.appendChild(dateEl);

  // 4 KPI 行 (枠ごとは平均不要 = 単一値表示)
  var kpiRow = document.createElement('div');
  kpiRow.className = 'cs-kpi-row';
  function appendKpi(label, value, valueClass) {
    var k = document.createElement('div');
    k.className = 'cs-kpi';
    var lab = document.createElement('span');
    lab.className = 'cs-kpi-k';
    lab.textContent = label;
    var v = document.createElement('span');
    v.className = 'cs-kpi-v' + (valueClass ? ' ' + valueClass : '');
    v.textContent = value;
    k.appendChild(lab);
    k.appendChild(v);
    kpiRow.appendChild(k);
  }
  // 数値色は配信ログ V3 列色と統一 (eac5536): コメ=cyan(default) / SC=amber /
  // peak=green / like=pink / 時間=dim。コメントリスナー数は対応列が無いので dim。
  appendKpi('コメント', String(streamKpi ? streamKpi.commentCount : rows.length) + ' 件');
  appendKpi('金額', streamKpi ? listenerMgrFormatYen(streamKpi.amountJpy) : '—', 'amber');
  appendKpi('コメントリスナー数', String(streamKpi ? streamKpi.uniqueListeners : '—') + ' 人');
  appendKpi('いいね', streamKpi ? String(streamKpi.likes || 0) : '—', 'pink');
  appendKpi('ピーク同接', streamKpi ? String(streamKpi.peakViewers || 0) : '—', 'green');
  var dur = '—';
  if (streamKpi && streamKpi.startedAt && streamKpi.endedAt && streamKpi.endedAt > streamKpi.startedAt) {
    var ms = streamKpi.endedAt - streamKpi.startedAt;
    var totalMin = Math.floor(ms / 60000);
    var hh = Math.floor(totalMin / 60);
    var mm = totalMin % 60;
    dur = hh + ':' + (mm < 10 ? '0' + mm : String(mm));
  }
  appendKpi('配信時間', dur, 'white');
  head.appendChild(kpiRow);

  // 配信ボディ: 常に virtualization 経由で描画する。
  // dataRows に初期 page rows をそのまま入れ、setupLazyCommentRender が
  // viewport 内の行だけを実体化。totalForStream に満たない場合は展開時に
  // 残り (offset = dataRows.length) を chunk fetch して dataRows を伸ばす。
  var body = document.createElement('div');
  body.className = 'cs-stream-body';
  var totalForStream = streamKpi ? streamKpi.commentCount : rows.length;
  // dataRows: 検索結果由来の rows をベースにした mutable 配列
  // (chunk fetch で push されて伸びる)
  var dataRows = rows.slice();
  // 進捗 placeholder (取得未完了時のみ。fetch 完了で削除)
  var fetchPlaceholder = null;
  if (dataRows.length < totalForStream) {
    fetchPlaceholder = document.createElement('div');
    fetchPlaceholder.className = 'cs-stream-placeholder';
    fetchPlaceholder.style.cssText = 'padding:8px 4px;font-size:11px;color:#5a6a78;text-align:center';
    fetchPlaceholder.textContent = (dataRows.length === 0
      ? ('全 ' + totalForStream + ' 件 — 展開で読み込みます')
      : ('残り ' + (totalForStream - dataRows.length) + ' 件 — 展開で残りを読み込みます'));
    body.appendChild(fetchPlaceholder);
  }
  // この配信枠が自分の配信か判定して「対応済み」トグルの表示可否を決める。
  // streamKpi.ownerChannelId は SQL で SELECT s.owner_channel_id した値 (yt-UC...)。
  var streamIsOwn = streamKpi
    ? isOwnerChannelConfigured(streamKpi.ownerChannelId)
    : false;
  // virtualization セットアップ (常時)。collapsed 中は描画されない (bodyRect.height=0)。
  var lazy = setupLazyCommentRender(body, dataRows, { streamIsOwn: streamIsOwn });
  lazy.notifyDataExtended();

  // 残り未取得かどうか
  var fetched = dataRows.length >= totalForStream;

  function fetchRemaining() {
    if (fetched) return;
    fetched = true;
    // placeholder を「読み込み中」に
    if (fetchPlaceholder && fetchPlaceholder.parentNode === body) {
      fetchPlaceholder.textContent = '読み込み中…';
    }
    fetchStreamCommentChunks(streamId, dataRows, lazy, fetchPlaceholder, totalForStream, dataRows.length);
  }

  head.addEventListener('click', function () {
    stream.classList.toggle('cs-collapsed');
    var isOpen = !stream.classList.contains('cs-collapsed');
    if (isOpen && !fetched) fetchRemaining();
    if (isOpen) lazy.updateWindow();
  });
  stream.appendChild(head);
  stream.appendChild(body);
  // 初期展開なら即時 fetch (= 検索直後トップに見える枠の補完)
  if (openInitially && !fetched) {
    setTimeout(fetchRemaining, 0);
  }
  return stream;
}

// 該当枠の残りコメントを startOffset から chunk fetch (limit:5000) でループ取得し、
// dataRows に push して lazy.notifyDataExtended() で virtualization に反映する。
// dataRows / lazy は呼び出し側で setupLazyCommentRender 済みのものを共有。
function fetchStreamCommentChunks(streamId, dataRows, lazy, placeholderEl, expectedTotal, startOffset) {
  if (!api.listeners || !streamId) return;
  var q = commentSearchState.query;
  var CHUNK_SIZE = 5000;

  function fetchChunk(offset) {
    var query = {
      bodyQ: q.bodyQ || null,
      streamTitleQ: q.streamTitleQ || null,
      nameQ: q.nameQ || null,
      commentTypes: q.commentTypes || [],
      streamIds: [streamId],
      listenerChannelIds: q.listenerChannelIds || [],
      systemTags: q.systemTags || [],
      userTags: q.userTags || [],
      streamTags: q.streamTags || [],
      periodFrom: q.periodFrom,
      periodTo: q.periodTo,
      scope: q.scope || 'own',
      includeKpi: false,
      limit: CHUNK_SIZE,
      offset: offset
    };
    return api.listeners.searchComments(query).then(function (resp) {
      if (!resp || !resp.ok) {
        if (placeholderEl) placeholderEl.textContent = '読み込みに失敗しました';
        return null;
      }
      return resp.page;
    });
  }

  function loop(offset) {
    if (placeholderEl) {
      var totalLabel = expectedTotal && expectedTotal > 0 ? String(expectedTotal) : '?';
      placeholderEl.textContent = '取得中… (' + dataRows.length + ' / ' + totalLabel + ')';
    }
    return fetchChunk(offset).then(function (page) {
      if (!page) return;
      for (var i = 0; i < page.rows.length; i++) dataRows.push(page.rows[i]);
      lazy.notifyDataExtended();
      var got = page.rows.length;
      if (got >= CHUNK_SIZE && dataRows.length < (expectedTotal || page.total || 0)) {
        return loop(offset + CHUNK_SIZE);
      }
      // 完了: 進捗 placeholder 撤去
      if (placeholderEl && placeholderEl.parentNode) {
        placeholderEl.parentNode.removeChild(placeholderEl);
      }
    });
  }

  loop(startOffset).catch(function (err) {
    rendererLog.error('chunk fetch failed', err);
    if (placeholderEl) placeholderEl.textContent = '読み込みに失敗しました';
  });
}

// CommentRow (DB row) → buildCommentItem が期待する RawComment 形式へ変換。
// raw 列に元 RawComment を保存しているので、そこから値を取り出して fallback で
// 行の確定値で埋める。
// 重要: row.id は DB に yt- prefix 付きで保存されているが (= record_comment が
// with_yt_prefix で正規化)、SSE 経由のライブコメは prefix なし (= 生 id)。renderer
// 全域で id 形式を揃えるため、ここで yt- を剥がして prefix なしに統一する。
// これによって gift tab の loadedGiftIds dedup や addComment の data-id 比較が
// 正しく動作する (= 過去枠再接続時にギフトが二重表示されるバグの修正)。
// Rust 側 (api.comments.setResponded 等) は with_yt_prefix で再正規化するので
// prefix なしでも動作する。
function commentRowToCellData(row) {
  // raw は flat 形式で統一 (= 2026-05-16 Rust 側 import_from_onecomme で flat 化)。
  // 互換 unwrap は廃止: 過去 wrapper 形式コメは 同セッションで全削除 + 再 import 済。
  var raw = row && row.raw && typeof row.raw === 'object' ? row.raw : {};
  var normalizedId = row && row.id ? String(row.id).replace(/^yt-/, '') : '';
  // listenerChannelId は CommentRow.listener_channel_id (= "yt-UC..." 形式)。
  // showCommentDetail → openListenerDetail 経路で `data.userId` を見て channel_id を
  // 取得するため、prefix を剥がして渡す必要がある (= 取れないと fallbackDetail 経路に
  // 倒れて recentComments が 1 件のみになる、2026-05-13)。
  var listenerChannelId = row && row.listenerChannelId
    ? String(row.listenerChannelId).replace(/^yt-/, '')
    : '';
  return {
    id: normalizedId,
    userId: listenerChannelId || raw.userId || '',
    name: raw.name || raw.displayName || '',
    profileImage: raw.profileImage || '',
    comment: row.body || raw.comment || '',
    commentHtml: raw.commentHtml || '',
    timestamp: raw.timestamp,
    hasGift: !!raw.hasGift,
    amount: raw.amount || 0,
    currency: raw.currency || '',
    amountDisplay: raw.amountDisplay || '',
    superchatTier: raw.superchatTier || '',
    tierColor: raw.tierColor || '',
    isMember: !!raw.isMember,
    memberMonths: raw.memberMonths || 0,
    isMembership: !!raw.isMembership,
    membershipHeader: raw.membershipHeader || '',
    isMembershipGift: !!raw.isMembershipGift,
    giftCount: raw.giftCount || 0,
    stickerImage: raw.stickerImage || '',
    isModerator: !!raw.isModerator,
    isOwner: !!raw.isOwner,
    listenerStatus: raw.listenerStatus || '',
    listenerTag: raw.listenerTag || '',
    listenerCurrentStreamCommentCount: raw.listenerCurrentStreamCommentCount || 0,
    // リモート閲覧 redesign §3.2: 「対応済み」状態。row.respondedAt は server-side で
    // CommentRow.responded_at を camelCase シリアライズしたもの。0 で未対応。
    respondedAt: row.respondedAt || 0
  };
}

// epoch ms → "MM/DD" / "MM/DD (曜) HH:mm" 等のフォーマッタ。
// listener-mgr が定義する formatTime / formatDate と被らないよう listener-mgr-* 命名
// を継続利用、不足分はここに追加。
function listenerMgrFormatDate(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  var mo = d.getMonth() + 1;
  var dd = d.getDate();
  return (mo < 10 ? '0' + mo : mo) + '/' + (dd < 10 ? '0' + dd : dd);
}
function listenerMgrFormatDateTime(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  var mo = d.getMonth() + 1;
  var dd = d.getDate();
  var hh = d.getHours();
  var mm = d.getMinutes();
  var dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return (mo < 10 ? '0' + mo : mo) + '/' + (dd < 10 ? '0' + dd : dd) +
    ' (' + dow + ') ' +
    (hh < 10 ? '0' + hh : hh) + ':' + (mm < 10 ? '0' + mm : mm);
}

// イベント結線
document.addEventListener('DOMContentLoaded', function () {
  // 起動時に自チャンネル一覧を populate する。Phase 1 でリスナーマネージャの
  // 開くボタンが撤去されたため、refreshListenerOwnerStatus が走る経路が
  // 「設定モーダルを開く / 自チャンネル変更」に限られて、起動直後の
  // listenerMgrState.ownerChannels が [] のままになっていた。
  // stream-detail-modal の「対応済み」トグル表示 (= isOwnerChannelConfigured) や
  // 「未対応のみ」フィルタ等の自枠依存判定がこれを参照するので、起動時に
  // 一度だけ取得しておく。
  if (typeof refreshListenerOwnerStatus === 'function') {
    refreshListenerOwnerStatus();
  }
  // cl-tabs「現在配信」グループの接続状態 class を初期化 (= 起動時は切断中)
  updateClTabsLiveState();
  // 同じく Phase 1 で取りこぼされた cs-panel の picker chip 列 (リスナー / 配信枠 /
  // 期間)。起動時に cs-tab が active な (= 前回終了時の状態を復元している) 場合、
  // tab click イベントは飛ばないため、ここで初期描画しておく。
  if (typeof renderUserPickerChips === 'function') renderUserPickerChips();
  if (typeof renderStreamPickerChips === 'function') renderStreamPickerChips();
  if (typeof renderPeriodPickerChips === 'function') renderPeriodPickerChips();

  // リスナータブのミニタブ (全て / 未対応 / 新規 / 再訪 / 復帰 / 新メンバー) を結線。
  // 起動時は disconnect 状態なので件数 0 表示。接続後に refreshListenerMiniTabCounts
  // で実数が反映される。
  var miniTabsRow = document.getElementById('listener-mgr-mini-tabs');
  if (miniTabsRow) {
    var miniTabs = miniTabsRow.querySelectorAll('.lm-mtab');
    for (var fp = 0; fp < miniTabs.length; fp++) {
      miniTabs[fp].addEventListener('click', function () {
        selectListenerMiniTab(this.getAttribute('data-mtab'));
      });
    }
    if (typeof refreshListenerMiniTabs === 'function') refreshListenerMiniTabs();
  }

  // === 以下 3 つは UI 整理 Phase 1 で対応 DOM を撤去済 (= null guard で no-op)。
  //     今後 UI を再編して再導入する場合に備えて、ハンドラ本体は残置する:
  //     - #ponout-ui-open-btn       (= ポン出し画面を別ウィンドウで開く動線)
  //     - #listener-mgr-open-btn    (= リスナーマネージャを開く旧動線。
  //                                   現在は cl-frame タブで代替)
  //     - #listener-mgr-close       (= 同マネージャの閉じるボタン旧動線)
  //     再利用時は index.html に対応 DOM を戻すだけで動く。 ===
  var ponoutOpenBtn = document.getElementById('ponout-ui-open-btn');
  if (ponoutOpenBtn && api.ponout && api.ponout.open) {
    ponoutOpenBtn.addEventListener('click', function () { api.ponout.open(); });
  }

  var openBtn = document.getElementById('listener-mgr-open-btn');
  if (openBtn) openBtn.addEventListener('click', openListenerManager);
  var closeBtn = document.getElementById('listener-mgr-close');
  if (closeBtn) closeBtn.addEventListener('click', closeListenerManager);

  // === 以下 3 つの結線は全選択 / 一括削除バー撤去 (= ピルフィルター置換) で対応 DOM
  //     を撤去済 (= null guard で no-op)。再導入する場合に備えてハンドラ本体は残置:
  //     - #listener-mgr-bulk-delete  (= 選択リスナー一括削除)
  //     - #listener-mgr-bulk-clear   (= 選択解除)
  //     - #listener-mgr-select-all   (= 全選択チェックボックス)
  //     index.html に該当 DOM を戻すだけで動く。 ===
  var bulkDeleteBtn = document.getElementById('listener-mgr-bulk-delete');
  if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', bulkDeleteListeners);
  var bulkClearBtn = document.getElementById('listener-mgr-bulk-clear');
  if (bulkClearBtn) bulkClearBtn.addEventListener('click', function () {
    if (listenerMgrState.selectedIds) listenerMgrState.selectedIds.clear();
    refreshListenerList();
  });
  var selectAllEl = document.getElementById('listener-mgr-select-all');
  if (selectAllEl) selectAllEl.addEventListener('change', function () {
    toggleSelectAllListeners(this.checked);
  });

  // 終了時 export の進捗モーダル (close 抑制中に表示)
  if (api.listeners && api.listeners.onShutdownExportProgress) {
    api.listeners.onShutdownExportProgress(function (payload) {
      if (!payload) return;
      if (payload.phase === 'started') showShutdownExportModal();
      else if (payload.phase === 'done') hideShutdownExportModal();
    });
  }

  // UI 整理 Phase 1: cl-tab クリックで cl-frame タブ切替 (= active class + panel display)
  var clTabs = document.querySelectorAll('.cl-tab');
  for (var ti = 0; ti < clTabs.length; ti++) {
    clTabs[ti].addEventListener('click', function () {
      activateClTab(this.getAttribute('data-cl-tab'));
    });
  }

  // 配信ログ
  var streamsSortEl = document.getElementById('streams-sort');
  if (streamsSortEl) streamsSortEl.addEventListener('change', function () {
    streamsState.page.offset = 0;
    refreshStreamsList();
  });
  var streamsScopeEl = document.getElementById('streams-scope');
  if (streamsScopeEl) streamsScopeEl.addEventListener('change', function () {
    streamsState.page.offset = 0;
    refreshStreamsList();
  });
  var streamsRefreshBtn = document.getElementById('streams-refresh');
  if (streamsRefreshBtn) streamsRefreshBtn.addEventListener('click', function () {
    streamsState.page.offset = 0;
    refreshStreamsList();
    // 「更新」で、タイトル等が未取得の自チャ過去枠があれば resolver で再取得を試みる
    // (= backend は対象を SELECT、無ければ no-op)。補完できた枠は SSE stream-metadata-updated
    // で順次反映される。視認中の枠に未取得があればボタン文言で手応えを出す (= 自己完結、
    // refresh の streams-count 更新と競合しない)。
    if (api.listeners && api.listeners.backfillStreamMeta) {
      api.listeners.backfillStreamMeta();
      var rows = (streamsState.page && streamsState.page.rows) || [];
      var missing = rows.filter(function (r) { return !r.title || !String(r.title).trim(); }).length;
      if (missing > 0) {
        rendererLog.info('user: streams-backfill-trigger, visibleMissing=' + missing);
        var origText = streamsRefreshBtn.textContent;
        streamsRefreshBtn.textContent = '再取得中…';
        setTimeout(function () { streamsRefreshBtn.textContent = origText; }, 3000);
      }
    }
  });
  var streamsEditBtn = document.getElementById('streams-edit-toggle');
  if (streamsEditBtn) streamsEditBtn.addEventListener('click', function () {
    setStreamsEditMode(!streamsState.editMode);
  });
  var streamsDeleteSelectedBtn = document.getElementById('streams-delete-selected');
  if (streamsDeleteSelectedBtn) streamsDeleteSelectedBtn.addEventListener('click', deleteSelectedStreamLogs);
  var streamsEditCancelBtn = document.getElementById('streams-edit-cancel');
  if (streamsEditCancelBtn) streamsEditCancelBtn.addEventListener('click', function () {
    setStreamsEditMode(false);
  });
  var sdcClose = document.getElementById('sdc-close');
  if (sdcClose) sdcClose.addEventListener('click', closeStreamDeleteConfirm);
  var sdcCancel = document.getElementById('sdc-cancel');
  if (sdcCancel) sdcCancel.addEventListener('click', closeStreamDeleteConfirm);
  var sdcConfirm = document.getElementById('sdc-confirm');
  if (sdcConfirm) sdcConfirm.addEventListener('click', confirmStreamDelete);
  var sdcModal = document.getElementById('stream-delete-confirm-modal');
  if (sdcModal) {
    sdcModal.addEventListener('click', function (e) {
      if (e.target === sdcModal) closeStreamDeleteConfirm();
    });
  }
  // 表示密度切替 (大/中/小)。再 fetch せず現ページを再描画する。
  var streamsDensitySeg = document.getElementById('streams-density-seg');
  if (streamsDensitySeg) {
    var streamsDensityBtns = streamsDensitySeg.querySelectorAll('.seg-btn');
    streamsDensityBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var d = btn.getAttribute('data-density') || 'l';
        if (streamsState.density === d) return;
        streamsState.density = d;
        streamsDensityBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        if (streamsState.page) renderStreamsList(streamsState.page);
      });
    });
  }
  var streamsPrev = document.getElementById('streams-prev');
  if (streamsPrev) streamsPrev.addEventListener('click', function () {
    var p = streamsState.page;
    streamsState.page.offset = Math.max(0, p.offset - p.limit);
    refreshStreamsList();
  });
  var streamsNext = document.getElementById('streams-next');
  if (streamsNext) streamsNext.addEventListener('click', function () {
    var p = streamsState.page;
    if ((p.offset + p.limit) < p.total) {
      streamsState.page.offset = p.offset + p.limit;
      refreshStreamsList();
    }
  });
  var streamDetailClose = document.getElementById('stream-detail-close');
  if (streamDetailClose) streamDetailClose.addEventListener('click', closeStreamDetailModal);
  var streamDetailModal = document.getElementById('stream-detail-modal');
  if (streamDetailModal) {
    streamDetailModal.addEventListener('click', function (e) {
      if (e.target === streamDetailModal) closeStreamDetailModal();
    });
  }

  // コメント検索 (Phase C 新 UI)
  var csRunBtn = document.getElementById('cs-run-btn');
  if (csRunBtn) csRunBtn.addEventListener('click', runCommentSearch);
  var csClearBtn = document.getElementById('cs-clear-btn');
  if (csClearBtn) csClearBtn.addEventListener('click', function () {
    clearCommentSearchForm();
    // クリア後は結果も消し、初期状態カードに戻す
    var listEl = document.getElementById('cs-stream-list');
    if (listEl) listEl.innerHTML = '';
    destroyAllVirtualLists();
    showCommentSearchState('initial');
  });
  var csScope = document.getElementById('cs-scope');
  if (csScope) csScope.addEventListener('change', function () {
    commentSearchState.query.scope = csScope.value || 'own';
    commentSearchState.query.streamIds = [];
    updatePickerLabel('stream');
  });
  // 状態カード内のアクション
  var csStateClearBtn = document.getElementById('cs-state-clear-btn');
  if (csStateClearBtn) csStateClearBtn.addEventListener('click', function () {
    clearCommentSearchForm();
    var listEl = document.getElementById('cs-stream-list');
    if (listEl) listEl.innerHTML = '';
    destroyAllVirtualLists();
    showCommentSearchState('initial');
    expandSearchForm();
  });
  var csStateEditBtn = document.getElementById('cs-state-edit-btn');
  if (csStateEditBtn) csStateEditBtn.addEventListener('click', expandSearchForm);
  var csStateRetryBtn = document.getElementById('cs-state-retry-btn');
  if (csStateRetryBtn) csStateRetryBtn.addEventListener('click', runCommentSearch);
  // Enter キーでも検索
  ['cs-body-q', 'cs-stream-title-q', 'cs-name-q'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runCommentSearch();
    });
  });

  // ユーザー popover の各ボタン (popover trigger は chip 列内の「+ 追加」)
  var csUserPopoverApply = document.getElementById('cs-user-popover-apply');
  if (csUserPopoverApply) csUserPopoverApply.addEventListener('click', applyUserPopover);
  var csUserPopoverCancel = document.getElementById('cs-user-popover-cancel');
  if (csUserPopoverCancel) csUserPopoverCancel.addEventListener('click', closeUserPopover);
  var csUserPopoverClear = document.getElementById('cs-user-popover-clear');
  if (csUserPopoverClear) csUserPopoverClear.addEventListener('click', clearUserPopoverState);
  var csUserPopoverBulkSelectTag = document.getElementById('cs-user-popover-bulk-select-tag');
  if (csUserPopoverBulkSelectTag) csUserPopoverBulkSelectTag.addEventListener('click', bulkSelectAllInFilter);
  var csUserPopoverBulkSelectUnsel = document.getElementById('cs-user-popover-bulk-select-unselected');
  if (csUserPopoverBulkSelectUnsel) csUserPopoverBulkSelectUnsel.addEventListener('click', bulkSelectUnselectedInFilter);
  var csUserPopoverBackdrop = document.getElementById('cs-user-popover-backdrop');
  if (csUserPopoverBackdrop) csUserPopoverBackdrop.addEventListener('click', function (e) {
    if (e.target === csUserPopoverBackdrop) closeUserPopover();
  });
  // 配信枠 popover trigger は chip 列内の「+ 追加」(JS で動的に生成)。
  // 期間 popover trigger も同様に chip 列内 (renderPeriodPickerChips が生成)。
  // 配信枠 popover の各ボタン
  var csStreamPopoverApply = document.getElementById('cs-stream-popover-apply');
  if (csStreamPopoverApply) csStreamPopoverApply.addEventListener('click', applyStreamPopover);
  var csStreamPopoverCancel = document.getElementById('cs-stream-popover-cancel');
  if (csStreamPopoverCancel) csStreamPopoverCancel.addEventListener('click', closeStreamPopover);
  var csStreamPopoverClear = document.getElementById('cs-stream-popover-clear');
  if (csStreamPopoverClear) csStreamPopoverClear.addEventListener('click', clearStreamPopoverState);
  var csStreamPopoverBulkSelectTag = document.getElementById('cs-stream-popover-bulk-select-tag');
  if (csStreamPopoverBulkSelectTag) csStreamPopoverBulkSelectTag.addEventListener('click', bulkSelectAllInStreamFilter);
  var csStreamPopoverBulkSelectUnsel = document.getElementById('cs-stream-popover-bulk-select-unselected');
  if (csStreamPopoverBulkSelectUnsel) csStreamPopoverBulkSelectUnsel.addEventListener('click', bulkSelectUnselectedInStreamFilter);
  var csStreamPopoverBackdrop = document.getElementById('cs-stream-popover-backdrop');
  if (csStreamPopoverBackdrop) csStreamPopoverBackdrop.addEventListener('click', function (e) {
    if (e.target === csStreamPopoverBackdrop) closeStreamPopover();
  });
  var csPeriodApply = document.getElementById('cs-period-apply');
  if (csPeriodApply) csPeriodApply.addEventListener('click', applyPeriodPopover);
  var csPeriodCancel = document.getElementById('cs-period-cancel');
  if (csPeriodCancel) csPeriodCancel.addEventListener('click', closePeriodPopover);
  var csPeriodClear = document.getElementById('cs-period-clear');
  if (csPeriodClear) csPeriodClear.addEventListener('click', clearPeriodPopover);
  var csPeriodBackdrop = document.getElementById('cs-period-backdrop');
  if (csPeriodBackdrop) csPeriodBackdrop.addEventListener('click', function (e) {
    if (e.target === csPeriodBackdrop) closePeriodPopover();
  });
  // 期間 input fields の手動編集 → state 反映
  var csPeriodFromInput = document.getElementById('cs-period-input-from');
  if (csPeriodFromInput) csPeriodFromInput.addEventListener('change', onPeriodInputChange);
  var csPeriodToInput = document.getElementById('cs-period-input-to');
  if (csPeriodToInput) csPeriodToInput.addEventListener('change', onPeriodInputChange);
  // preset ボタン (event delegation)
  var csPeriodPresets = document.getElementById('cs-period-presets');
  if (csPeriodPresets) csPeriodPresets.addEventListener('click', function (e) {
    if (e.target.tagName === 'BUTTON' && e.target.dataset.preset) {
      selectPeriodPreset(e.target.dataset.preset);
    }
  });
  // ESC で期間 popover 閉じる
  document.addEventListener('keydown', function (e) {
    var backdrop = document.getElementById('cs-period-backdrop');
    if (e.key === 'Escape' && backdrop && backdrop.style.display !== 'none') {
      closePeriodPopover();
    }
  });
  // popover フッタボタン
  var csPopoverApply = document.getElementById('cs-popover-apply');
  if (csPopoverApply) csPopoverApply.addEventListener('click', applyPickerPopover);
  var csPopoverClear = document.getElementById('cs-popover-clear');
  if (csPopoverClear) csPopoverClear.addEventListener('click', clearPickerPopover);
  // backdrop クリックで閉じる (popover 自体のクリックは伝播停止)
  var csPopoverBackdrop = document.getElementById('cs-popover-backdrop');
  if (csPopoverBackdrop) csPopoverBackdrop.addEventListener('click', function (e) {
    if (e.target === csPopoverBackdrop) closePickerPopover();
  });
  // ESC で開いている popover / dialog を閉じる
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (csPopoverState.type) { closePickerPopover(); return; }
    var userBd = document.getElementById('cs-user-popover-backdrop');
    if (userBd && userBd.style.display !== 'none') { closeUserPopover(); return; }
    var streamBd = document.getElementById('cs-stream-popover-backdrop');
    if (streamBd && streamBd.style.display !== 'none') { closeStreamPopover(); return; }
    var saveBd = document.getElementById('cs-save-dialog-backdrop');
    if (saveBd && saveBd.style.display !== 'none') { closeSaveDialog(); return; }
    var tagBd = document.getElementById('cs-tag-admin-backdrop');
    if (tagBd && tagBd.style.display !== 'none') { closeTagAdminModal(); return; }
  });
  // タブ切替時にユーザータグ pill / 保存検索ストリップ / picker chip 列を refresh
  // (UI 整理 Phase 1: 旧 .listener-mgr-tab[data-tab="comments"] → .cl-tab[data-cl-tab="cs"])
  // picker chip 列 (リスナー / 配信枠 / 期間) は旧 openListenerManager で初期描画
  // されていたが、Phase 1 でその経路が消えたので cs-tab activate 時に自前で初期化
  // する (空でも「+ 選択」ボタンを表示する必要がある)。
  var commentTab = document.querySelector('.cl-tab[data-cl-tab="cs"]');
  if (commentTab) commentTab.addEventListener('click', function () {
    refreshUserTagPills();
    refreshSavedSearchStrip();
    renderUserPickerChips();
    renderStreamPickerChips();
    renderPeriodPickerChips();
  });

  // 「条件を変更」 / 「閉じる」 / 「保存」 ボタン
  var csToggleFormBtn = document.getElementById('cs-toggle-form-btn');
  if (csToggleFormBtn) csToggleFormBtn.addEventListener('click', expandSearchForm);
  var csCollapseFormBtn = document.getElementById('cs-collapse-form-btn');
  if (csCollapseFormBtn) csCollapseFormBtn.addEventListener('click', collapseSearchForm);
  var csSaveCurrentBtn = document.getElementById('cs-save-current-btn');
  if (csSaveCurrentBtn) csSaveCurrentBtn.addEventListener('click', saveCurrentSearch);
  // 保存ダイアログ (F4)
  var csSaveCancel = document.getElementById('cs-save-cancel');
  if (csSaveCancel) csSaveCancel.addEventListener('click', closeSaveDialog);
  var csSaveConfirm = document.getElementById('cs-save-confirm');
  if (csSaveConfirm) csSaveConfirm.addEventListener('click', confirmSaveDialog);
  var csSaveBackdrop = document.getElementById('cs-save-dialog-backdrop');
  if (csSaveBackdrop) csSaveBackdrop.addEventListener('click', function (e) {
    if (e.target === csSaveBackdrop) closeSaveDialog();
  });
  var csSaveNameInput = document.getElementById('cs-save-name-input');
  if (csSaveNameInput) csSaveNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') confirmSaveDialog();
  });
  // タグ管理 modal (F4)
  var csTagAdminBtn = document.getElementById('cs-tag-admin-btn');
  if (csTagAdminBtn) csTagAdminBtn.addEventListener('click', openTagAdminModal);
  var csTagAdminClose = document.getElementById('cs-tag-admin-close');
  if (csTagAdminClose) csTagAdminClose.addEventListener('click', closeTagAdminModal);
  var csTagAdminBackdrop = document.getElementById('cs-tag-admin-backdrop');
  if (csTagAdminBackdrop) csTagAdminBackdrop.addEventListener('click', function (e) {
    if (e.target === csTagAdminBackdrop) closeTagAdminModal();
  });
  // タブ切替
  var csTagAdminTabs = document.getElementById('cs-tag-admin-tabs');
  if (csTagAdminTabs) csTagAdminTabs.addEventListener('click', function (e) {
    if (e.target && e.target.classList.contains('cs-tag-admin-tab')) {
      var t = e.target.dataset.target;
      if (t) switchTagAdminTab(t);
    }
  });

  // インポート / エクスポート
  var ioExportBtn = document.getElementById('io-export-btn');
  if (ioExportBtn) ioExportBtn.addEventListener('click', runExportJsonl);
  var ioImportBtn = document.getElementById('io-import-btn');
  if (ioImportBtn) ioImportBtn.addEventListener('click', runImportJsonl);
  var ioOnecommeBtn = document.getElementById('io-onecomme-import-btn');
  if (ioOnecommeBtn) ioOnecommeBtn.addEventListener('click', runImportFromOnecomme);
  var ioOnecommeExportBtn = document.getElementById('io-onecomme-export-btn');
  if (ioOnecommeExportBtn) ioOnecommeExportBtn.addEventListener('click', runExportToOnecomme);
  var ioOnecommeSyncBtn = document.getElementById('io-onecomme-sync-btn');
  if (ioOnecommeSyncBtn) ioOnecommeSyncBtn.addEventListener('click', runBidirectionalSync);

  // 未設定警告バナー内の「設定」リンク → 設定画面のリスナー管理セクションを開く
  var ownerWarnLink = document.getElementById('listener-mgr-owner-warn-link');
  if (ownerWarnLink) ownerWarnLink.addEventListener('click', function () { openSettings('listener'); });

  // 検索 q が変わると 6 タブの母集団絞り込みも変わるので件数バッジも更新。
  // ソート変更は順序だけで母集団は変わらないので件数は更新しない。
  // 更新ボタンは「全部最新化」の意図なので件数も併せて更新。
  var refreshBtn = document.getElementById('listener-mgr-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', function () {
    listenerMgrState.page.offset = 0;
    refreshListenerList();
    if (typeof refreshListenerMiniTabCounts === 'function') refreshListenerMiniTabCounts();
  });
  var sortEl = document.getElementById('listener-mgr-sort');
  if (sortEl) sortEl.addEventListener('change', function () {
    listenerMgrState.page.offset = 0;
    refreshListenerList();
  });
  var searchEl = document.getElementById('listener-mgr-search');
  if (searchEl) {
    var searchTimer = null;
    searchEl.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        listenerMgrState.page.offset = 0;
        refreshListenerList();
        if (typeof refreshListenerMiniTabCounts === 'function') refreshListenerMiniTabCounts();
      }, 250);
    });
  }

  // 表示密度切替 (大 / 中 / 小)。再 fetch せず現ページを再描画するだけ。
  var densitySeg = document.getElementById('listener-mgr-density-seg');
  if (densitySeg) {
    var densityBtns = densitySeg.querySelectorAll('.seg-btn');
    densityBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var d = btn.getAttribute('data-density') || 'm';
        if (listenerMgrState.density === d) return;
        listenerMgrState.density = d;
        densityBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        if (listenerMgrState.page) renderListenerList(listenerMgrState.page);
      });
    });
  }
  var prevBtn = document.getElementById('listener-mgr-prev');
  if (prevBtn) prevBtn.addEventListener('click', function () {
    var p = listenerMgrState.page;
    listenerMgrState.page.offset = Math.max(0, p.offset - p.limit);
    refreshListenerList();
  });
  var nextBtn = document.getElementById('listener-mgr-next');
  if (nextBtn) nextBtn.addEventListener('click', function () {
    var p = listenerMgrState.page;
    if ((p.offset + p.limit) < p.total) {
      listenerMgrState.page.offset = p.offset + p.limit;
      refreshListenerList();
    }
  });
  var detailCloseBtn = document.getElementById('listener-detail-close');
  if (detailCloseBtn) detailCloseBtn.addEventListener('click', closeListenerDetailModal);
  var detailModal = document.getElementById('listener-detail-modal');
  if (detailModal) {
    detailModal.addEventListener('click', function (e) {
      if (e.target === detailModal) closeListenerDetailModal();
    });
  }
});

// ─── 配信情報パネル ─────────────────────────────────────────
// stream-metadata-updated イベントで Rust から push されたメタデータを受け取って描画。
// 配信時間カウンターは renderer 側 setInterval で 1 秒更新 (DB は触らない)。

var streamInfoState = {
  startedAt: 0,        // unix ms
  elapsedHandle: null, // setInterval ハンドル
};

// 接続後は URL 入力欄を隠して縦スペースを節約する。
// CSS クラス + !important で確実に hide (他箇所からの inline style 衝突回避)。
function setUrlInputVisible(visible) {
  var ig = document.querySelector('#conn-frame .conn-url');
  if (!ig) return;
  if (visible) ig.classList.remove('is-hidden');
  else ig.classList.add('is-hidden');
}

// 「接続中」のステータス行 (パネル外) は、stream-info パネルが表示中なら
// パネル内 status と二重になるので隠す。
function setOuterStatusRowVisible(visible) {
  var sr = document.getElementById('status-row');
  if (!sr) return;
  if (visible) sr.classList.remove('is-hidden');
  else sr.classList.add('is-hidden');
}

// stream-info 内の切断ボタンは、メイン connect-btn と同じ disconnect API を呼ぶ。
// (見た目上は別ボタンだが動作は等価)
(function () {
  var btn = document.getElementById('stream-info-disconnect-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      rendererLog.info('user: disconnect-click (stream-info button)');
      if (window.api && window.api.disconnect) window.api.disconnect();
    });
  }
  // 概要欄 summary (= モック合意で <details> から inline link 化) の click で
  // 本文の表示/非表示を切替。`▶`/`▼` はテキスト先頭文字を差し替えるだけ。
  var summary = document.getElementById('stream-info-summary');
  var body = document.getElementById('stream-info-description');
  if (summary && body) {
    body.style.display = 'none';
    function toggleDescription() {
      var isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      summary.textContent = (isOpen ? '▶' : '▼') + ' 概要欄';
    }
    summary.addEventListener('click', toggleDescription);
    summary.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDescription();
      }
    });
  }
})();

function streamFmtNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '-';
  return n.toLocaleString('ja-JP');
}

function streamFmtElapsed(startedAtMs) {
  if (!startedAtMs) return '--:--:--';
  var sec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

function streamFmtAbsTime(unixMs) {
  if (!unixMs) return '-';
  try {
    var d = new Date(Number(unixMs));
    return d.toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) { return '-'; }
}

function showStreamInfoPanel() {
  var panel = document.getElementById('stream-info');
  if (panel) panel.style.display = '';
  // パネル内 status を見せるので、パネル外 status-row は隠す
  setOuterStatusRowVisible(false);
}

function hideStreamInfoPanel() {
  var panel = document.getElementById('stream-info');
  if (panel) panel.style.display = 'none';
  if (streamInfoState.elapsedHandle) {
    clearInterval(streamInfoState.elapsedHandle);
    streamInfoState.elapsedHandle = null;
  }
  streamInfoState.startedAt = 0;
}

function startStreamElapsedTimer() {
  if (streamInfoState.elapsedHandle) return;
  streamInfoState.elapsedHandle = setInterval(function () {
    var el = document.getElementById('stream-info-elapsed');
    if (el) el.textContent = streamFmtElapsed(streamInfoState.startedAt);
  }, 1000);
}

function renderStreamInfo(stream) {
  if (!stream) return;
  showStreamInfoPanel();

  // 静的: title / channel / icon / description
  if (stream.title) {
    var titleEl = document.getElementById('stream-info-title');
    if (titleEl) titleEl.textContent = stream.title;
  }
  // partial update セマンティクス:
  //   undefined → このフィールドは送られていないので現状維持 (= 動的 poll で潰されない)
  //   空文字 → 明示的に「無し」(= ephemeral でクリア指示)
  //   URL → 表示 + 更新
  var iconEl = document.getElementById('stream-info-icon');
  if (iconEl && stream.channelIconUrl !== undefined) {
    if (stream.channelIconUrl) {
      iconEl.src = stream.channelIconUrl;
      iconEl.style.display = '';
    } else {
      iconEl.style.display = 'none';
    }
  }
  if (stream.channelName) {
    var nameEl = document.getElementById('stream-info-channel-name');
    if (nameEl) nameEl.textContent = stream.channelName;
  }
  if (typeof stream.description === 'string' && stream.description.length > 0) {
    var descEl = document.getElementById('stream-info-description');
    if (descEl) descEl.textContent = stream.description;
  }

  // 動的: subscriber / viewers / peak / likes / comments / sc
  // 「typeof === 'number' の時だけ更新」だと、新枠 metadata に当該フィールドが
  // 無い (= ephemeral 経路) 場合、前枠の値が残る。常時上書き + undefined は '-'
  // フォールバックで統一する (= 枠切替時の leftover バグ防止)。
  var subEl = document.getElementById('stream-info-subscribers');
  if (subEl) {
    if (typeof stream.subscriberCount === 'number' && stream.subscriberCount > 0) {
      subEl.textContent = '登録 ' + streamFmtNumber(stream.subscriberCount) + ' 人';
    } else {
      subEl.textContent = '';
    }
  }
  var viewEl = document.getElementById('stream-info-viewers');
  if (viewEl) viewEl.textContent = streamFmtNumber(stream.currentViewers);
  var peakEl = document.getElementById('stream-info-peak');
  if (peakEl) peakEl.textContent = streamFmtNumber(stream.peakConcurrentViewers);
  var likeEl = document.getElementById('stream-info-likes');
  if (likeEl) likeEl.textContent = streamFmtNumber(stream.likes);
  // 「コメント」「SC」: 自枠 (= path 2 / detail.stream / DB 集計) と他枠 (= path 1 /
  // ephemeral / MainSession.live_stream_stats) のどちらでも Rust 側で payload に値を
  // 乗せて来る。renderer は viewers / peak / likes と同じく常時上書き + undefined
  // フォールバックで描画するだけ。
  var commentsEl = document.getElementById('stream-info-comments');
  if (commentsEl) commentsEl.textContent = streamFmtNumber(stream.commentCount);
  var scEl = document.getElementById('stream-info-sc');
  if (scEl) {
    if (typeof stream.superchatAmountJpy === 'number') {
      scEl.textContent = stream.superchatAmountJpy > 0
        ? listenerMgrFormatYen(stream.superchatAmountJpy)
        : '¥0';
    } else {
      scEl.textContent = '-';
    }
  }

  // 配信開始時刻 → 開始表示 + elapsed timer
  if (stream.startedAt && stream.startedAt > 0) {
    streamInfoState.startedAt = stream.startedAt;
    var startedEl = document.getElementById('stream-info-started');
    if (startedEl) startedEl.textContent = streamFmtAbsTime(stream.startedAt);
    var elEl = document.getElementById('stream-info-elapsed');
    if (elEl) elEl.textContent = streamFmtElapsed(stream.startedAt);
    startStreamElapsedTimer();
  }
}

if (window.api && window.api.onStreamMetadataUpdated) {
  window.api.onStreamMetadataUpdated(function (stream) {
    // 切断後の遅延 push 対策は main.js 側 (streamMetadataState 検証) で行うので、
    // renderer 側はガードしない (isConnected が立つ前に最初の fetch が完了する
    // ケースで stream-info が出なくなるのを防ぐため)。
    renderStreamInfo(stream);
    // 配信ログ一覧 (streams タブ) にも反映 (= 起動時 repair pass で補完された
    // title / channelName が、 タブを開いたまま 自動更新される)
    updateStreamLogRowInPlace(stream);
  });
}

// 起動時自動 sync (= わんコメ書き戻し) の進捗をフッタに常駐表示。
// わんコメ DB が大きいと数秒〜数分かかるので、 ユーザーが「いま何が動いているか」
// 認識できないと「ハブが固まった?」 と誤解されるため必須。
//
// 表示は画面下端の固定フッタ。 startup-sync-progress (= major phase) と
// import-progress (= import 中の細かい N/M progress) の 2 経路を 1 つの UI に統合。
var syncFooter = null;
var importPhaseLabels = {
  'started': 'わんコメ書き戻し import 開始',
  'read': 'わんコメ DB 読み取り完了',
  'repair': 'メタデータ補完中',
  'pass2': 'コメ解析中',
  'flush-listeners': 'リスナー書き込み中',
  'flush-streams': '配信ログ書き込み中',
  'flush-comments': 'コメント書き込み中',
  'done': 'import 完了'
};

function ensureSyncFooter() {
  if (syncFooter) return syncFooter;
  var el = document.createElement('div');
  el.className = 'sync-footer';
  el.innerHTML =
    '<div class="sync-footer-row">' +
      '<span class="sync-icon">⏳</span>' +
      '<span class="sync-text">準備中...</span>' +
      '<div class="sync-bar-track kh-progress-bar-track">' +
        '<div class="sync-bar-fill kh-progress-bar-fill"></div>' +
      '</div>' +
      '<span class="sync-percent">--</span>' +
      '<span class="sync-count"></span>' +
    '</div>';
  document.body.appendChild(el);

  var iconEl = el.querySelector('.sync-icon');
  var textEl = el.querySelector('.sync-text');
  var fillEl = el.querySelector('.sync-bar-fill');
  var pctEl = el.querySelector('.sync-percent');
  var cntEl = el.querySelector('.sync-count');

  function setStatus(status) {
    // status: '' (進行中シアン) / 'done' (緑) / 'error' (赤) / 'warn' (オレンジ)
    var statusClasses = ['is-done', 'is-error', 'is-warn'];
    statusClasses.forEach(function (c) {
      iconEl.classList.remove(c);
      fillEl.classList.remove(c);
      pctEl.classList.remove(c);
    });
    if (status) {
      var cls = 'is-' + status;
      iconEl.classList.add(cls);
      fillEl.classList.add(cls);
      pctEl.classList.add(cls);
    }
  }

  var dismissTimer = null;
  syncFooter = {
    el: el,
    show: function () {
      el.style.opacity = '1';
      el.style.display = 'block';
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    },
    setIcon: function (icon, status) {
      iconEl.textContent = icon;
      setStatus(status || '');
    },
    setText: function (text) { textEl.textContent = text; },
    /**
     * 進捗バー更新。 overall (= phase 重み付け済 0-100) を渡せばそれをバーに反映、
     * current/total はカウンタ表示用 (= "158,243 / 203,000")。
     * overall が null/undefined の時は current/total から % を計算 (= 旧挙動互換)。
     */
    setProgress: function (current, total, overall) {
      if (typeof overall === 'number' && !isNaN(overall)) {
        var p = Math.max(0, Math.min(100, Math.round(overall)));
        fillEl.style.width = p + '%';
        pctEl.textContent = p + '%';
      } else if (total > 0) {
        var p2 = Math.max(0, Math.min(100, Math.round(current * 100 / total)));
        fillEl.style.width = p2 + '%';
        pctEl.textContent = p2 + '%';
      } else {
        fillEl.style.width = '0%';
        pctEl.textContent = '--';
      }
      if (total > 0 && current >= 0) {
        cntEl.textContent = Number(current).toLocaleString() + ' / ' + Number(total).toLocaleString();
      } else {
        cntEl.textContent = '';
      }
    },
    setIndeterminate: function () {
      fillEl.style.width = '100%';
      pctEl.textContent = '';
      cntEl.textContent = '';
    },
    scheduleDismiss: function (ms) {
      if (dismissTimer) clearTimeout(dismissTimer);
      dismissTimer = setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.style.display = 'none'; }, 450);
      }, ms || 5000);
    }
  };
  return syncFooter;
}

if (window.api && window.api.onStartupSyncProgress) {
  window.api.onStartupSyncProgress(function (data) {
    if (!data) return;
    // 起動時 sync 中に window close が要求されてモーダルが開いている場合は、
    // sync-footer ではなくモーダルへ大マイルストーンラベルを反映する。
    if (_activeShutdownModal && typeof _activeShutdownModal.update === 'function') {
      _activeShutdownModal.update(data, STARTUP_SYNC_MODAL_LABELS);
      return;
    }
    var f = ensureSyncFooter();
    f.show();
    switch (data.phase) {
      case 'started':
        f.setIcon('⏳', '');
        f.setText('わんコメと同期を開始しています...');
        f.setIndeterminate();
        break;
      case 'import-started':
        f.setIcon('⏳', '');
        f.setText('わんコメから取り込み中...');
        f.setIndeterminate();
        break;
      case 'import-completed': {
        var s = data.summary || {};
        var msg = 'わんコメ取り込み完了';
        if (s.streamsNew || s.commentsInserted) {
          msg += ' (新 ' + (s.streamsNew || 0) + ' 配信 / ' + (s.commentsInserted || 0) + ' コメ)';
        }
        f.setText(msg);
        f.setProgress(0, 0, 100);
        break;
      }
      case 'import-failed':
        f.setIcon('❌', 'error');
        f.setText('取り込み失敗: ' + (data.error || 'unknown'));
        f.scheduleDismiss(10000);
        break;
      case 'export-started':
        f.setIcon('⏳', '');
        f.setText('わんコメへ書き戻し中...');
        f.setIndeterminate();
        break;
      case 'export-completed':
        f.setText('わんコメ書き戻し完了');
        f.setProgress(0, 0, 100);
        break;
      case 'export-aborted':
        f.setIcon('ℹ️', 'warn');
        f.setText('わんコメ書き戻しスキップ (= 配信中 or わんコメ起動中)');
        f.scheduleDismiss(6000);
        break;
      case 'export-failed':
        f.setIcon('❌', 'error');
        f.setText('書き戻し失敗: ' + (data.error || 'unknown'));
        f.scheduleDismiss(10000);
        break;
      case 'done':
        f.setIcon('✅', 'done');
        f.setText('わんコメ同期完了');
        f.setProgress(0, 0, 100);
        f.scheduleDismiss(5000);
        break;
      case 'error':
        f.setIcon('❌', 'error');
        f.setText('同期エラー: ' + (data.error || 'unknown'));
        f.scheduleDismiss(10000);
        break;
    }
  });
}

if (window.api && window.api.onImportProgress) {
  window.api.onImportProgress(function (data) {
    if (!data) return;
    // 起動時 sync 中の close でモーダルが開いている場合はモーダルへリダイレクト
    if (_activeShutdownModal && typeof _activeShutdownModal.update === 'function') {
      _activeShutdownModal.update(data, importPhaseLabels);
      return;
    }
    var f = ensureSyncFooter();
    f.show();
    f.setIcon('⏳', '');
    var label = importPhaseLabels[data.phase] || data.phase;
    var msg = label;
    if (data.message) msg += ' - ' + data.message;
    f.setText(msg);
    // overallPercent (= Rust 側で phase 重み付け済 0-100) があればバーに反映、
    // current/total は N/M カウンタ用に渡す (= overall が支配)。
    var overall = (typeof data.overallPercent === 'number') ? data.overallPercent : null;
    if (overall != null) {
      f.setProgress(data.current || 0, data.total || 0, overall);
    } else if (data.total > 0) {
      f.setProgress(data.current || 0, data.total);
    } else {
      f.setIndeterminate();
    }
    if (data.phase === 'done') {
      f.setIcon('✅', 'done');
      // done は startup-sync-progress 側 の 'done' で dismiss されるので ここでは触らない
    }
  });
}

// export_to_onecomme の中間進捗 (= 起動時 sync の export phase / 終了時 shutdown export 両方で来る)。
// active な shutdown モーダルがあれば優先でそちらを更新、 なければ sync-footer に流す。
if (window.api && window.api.onExportProgress) {
  window.api.onExportProgress(function (data) {
    if (!data) return;
    // 1) 終了時モーダルが開いている → モーダルを更新
    if (_activeShutdownModal && typeof _activeShutdownModal.update === 'function') {
      _activeShutdownModal.update(data);
      return;
    }
    // 2) なければ起動時 sync の export phase → sync-footer を更新
    var f = ensureSyncFooter();
    f.show();
    var iconStatus = '';
    if (data.phase === 'done') iconStatus = 'done';
    else if (data.phase === 'aborted') iconStatus = 'warn';
    f.setIcon(iconStatus === 'done' ? '✅' : (iconStatus === 'warn' ? 'ℹ️' : '⏳'), iconStatus);
    var label = EXPORT_PHASE_LABELS[data.phase] || data.phase;
    var msg = label;
    if (data.message) msg += ' — ' + data.message;
    f.setText(msg);
    var overall = (typeof data.overallPercent === 'number') ? data.overallPercent : null;
    if (overall != null) {
      f.setProgress(data.current || 0, data.total || 0, overall);
    } else if (data.total > 0) {
      f.setProgress(data.current || 0, data.total);
    } else {
      f.setIndeterminate();
    }
  });
}

// stream-metadata-updated で渡された stream meta を、 配信ログ一覧 streamsState.page.rows
// の該当 row に in-place マージして再描画する。 タブ未表示 / 該当 row 不在では no-op。
function updateStreamLogRowInPlace(stream) {
  if (!stream || !stream.videoId) return;
  if (!streamsState || !streamsState.page || !Array.isArray(streamsState.page.rows)) return;
  var rows = streamsState.page.rows;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].videoId === stream.videoId) {
      // repair pass で埋まる対象 (title / channelName / channelIconUrl) のみマージ
      // (= 他の field = comment_count 等は streams 一覧の最新値を保つ)
      if (stream.title) rows[i].title = stream.title;
      if (stream.channelName) rows[i].channelName = stream.channelName;
      if (stream.channelIconUrl) rows[i].channelIconUrl = stream.channelIconUrl;
      renderStreamsList(streamsState.page);
      return;
    }
  }
}
