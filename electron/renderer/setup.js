// renderer.log 用ロガー (= 詳細: docs/logging.md)
var setupLog = (window.api && window.api.log && window.api.log.create)
  ? window.api.log.create('Setup')
  : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

var currentPort = 11280;
var selectedSceneId = 'chat';
var setupState = null;
var activeStage = 'connect';
var connected = false;
var ownerChannels = [];
var onecommeStatus = null;
var lastUrlValue = '';
var urlDraftValue = '';
var listenerImporting = false;
var listenerImportResult = null;
var listenerImportError = '';

var STAGES = [
  { id: 'connect', label: '1. 配信に接続' },
  { id: 'obs', label: '2. OBS に表示' },
  { id: 'listenerHistory', label: '3. リスナー履歴' }
];

function now() {
  return Date.now();
}

function stageData(stageId) {
  return (setupState && setupState.stages && setupState.stages[stageId]) || {};
}

function obsStageDone() {
  var st = stageData('obs');
  return !!st.userConfirmedAt;
}

function normalizeActiveStage(stageId) {
  var known = STAGES.some(function (stage) { return stage.id === stageId; });
  var next = known ? stageId : 'connect';
  if (!connected && !obsStageDone() && next !== 'connect') return 'connect';
  return next;
}

function localUrl(path) {
  return 'http://localhost:' + currentPort + path;
}

function selectedTemplatePath() {
  return '/templates/' + selectedSceneId + '/selected/';
}

function commentUrl() {
  return localUrl(selectedTemplatePath());
}

function effectsUrl() {
  return localUrl('/effects/' + selectedSceneId + '/');
}

function patchState(patch) {
  return window.api.onboarding.setState(patch || {}).then(function (state) {
    setupState = state;
    activeStage = normalizeActiveStage(state.lastActiveStage || activeStage || 'connect');
    render();
    return state;
  });
}

function markStage(stageId, fields) {
  var patch = { stages: {} };
  patch.stages[stageId] = fields || {};
  return patchState(patch);
}

function setStage(stageId) {
  // 観点 I: 初期セットアップウィザードのステージ切替 (= 1.配信接続 → 2.OBS →
  // 3.リスナー履歴) を user 操作として記録。 詳細: docs/logging.md
  setupLog.info('user: setup-stage-switch, from=' + activeStage + ', to=' + stageId);
  activeStage = stageId;
  if (stageId === 'listenerHistory') refreshListenerStatus();
  return patchState({ lastActiveStage: stageId });
}

function statusOf(stageId) {
  var st = stageData(stageId);
  if (st.skipped) return 'skipped';
  if (stageId === 'connect') return (connected || (obsStageDone() && st.completedAt)) ? 'done' : 'todo';
  if (stageId === 'obs') return st.userConfirmedAt ? 'done' : 'todo';
  if (stageId === 'listenerHistory') {
    if (st.wantsListenerHistory === false || st.skipped) return 'skipped';
    if (st.completedAt || (st.wantsListenerHistory === true && ownerChannels.length > 0)) return 'done';
    return 'todo';
  }
  return 'todo';
}

function statusLabel(status) {
  if (status === 'done') return '完了';
  if (status === 'skipped') return 'スキップ';
  return '未完了';
}

function doneCount() {
  return STAGES.reduce(function (n, stage) {
    var s = statusOf(stage.id);
    return n + ((s === 'done' || s === 'skipped') ? 1 : 0);
  }, 0);
}

function activeStageIndex() {
  return Math.max(0, STAGES.findIndex(function (stage) { return stage.id === activeStage; }));
}

function stageAtOffset(offset) {
  var nextIndex = activeStageIndex() + offset;
  if (nextIndex < 0 || nextIndex >= STAGES.length) return null;
  return STAGES[nextIndex];
}

function btn(text, fn) {
  var el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  el.addEventListener('click', fn);
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderSteps() {
  var nav = document.getElementById('setup-steps');
  clear(nav);
  STAGES.forEach(function (stage) {
    var status = statusOf(stage.id);
    var el = document.createElement('div');
    el.className = 'step ' + status + (stage.id === activeStage ? ' active' : '');
    el.textContent = stage.label;
    var small = document.createElement('span');
    small.className = 'step-status';
    small.textContent = statusLabel(status);
    el.appendChild(small);
    nav.appendChild(el);
  });
  document.getElementById('setup-progress').textContent = 'ステップ ' + (activeStageIndex() + 1) + ' / ' + STAGES.length;
}

function goNext() {
  var next = stageAtOffset(1);
  if (next) return setStage(next.id);
  return Promise.resolve();
}

function goBack() {
  var prev = stageAtOffset(-1);
  if (prev) return setStage(prev.id);
  return Promise.resolve();
}

function appendBackAction(actions) {
  if (activeStageIndex() > 0) actions.appendChild(btn('戻る', goBack));
}

function urlRow(label, url, field) {
  var row = document.createElement('div');
  row.className = 'row url-row';
  var labelEl = document.createElement('div');
  labelEl.className = 'label';
  labelEl.textContent = label;
  var value = document.createElement('div');
  value.className = 'value draggable-url';
  value.textContent = url;
  value.title = 'OBS にドラッグ&ドロップで追加 / クリックでコピー / 開くでブラウザ確認';
  value.draggable = true;
  value.addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('text/uri-list', url);
    e.dataTransfer.setData('text/plain', url);
    e.dataTransfer.effectAllowed = 'copy';
  });
  value.addEventListener('click', function () {
    navigator.clipboard.writeText(url);
    var patch = {};
    patch[field] = now();
    markStage('obs', patch);
  });
  row.appendChild(labelEl);
  row.appendChild(value);
  row.appendChild(btn('コピー', function () {
    navigator.clipboard.writeText(url);
    var patch = {};
    patch[field] = now();
    markStage('obs', patch);
  }));
  row.appendChild(btn('開く', function () {
    window.api.openExternal(url);
    markStage('obs', { openedPreviewAt: now() });
  }));
  return row;
}

function renderConnect(detail) {
  detail.appendChild(title('配信に接続する'));
  detail.appendChild(text(connected
    ? '接続できています。次は OBS に表示する URL を確認します。'
    : 'まずは動作確認です。自分の配信でなくても構いません。現在ライブ中の YouTube 配信を開き、その URL を貼り付けて接続してみてください。コメント取得だけなら YouTube ログインは不要です。'));
  var form = document.createElement('div');
  form.className = 'inline-form';
  var input = document.createElement('input');
  input.placeholder = 'YouTube Live URL';
  input.value = urlDraftValue || lastUrlValue || '';
  input.addEventListener('input', function () {
    urlDraftValue = input.value;
  });
  form.appendChild(input);
  form.appendChild(btn(connected ? '切断' : '接続', function () {
    if (connected) {
      window.api.disconnect();
      return;
    }
    var url = input.value.trim();
    if (url) window.api.connect(url);
  }));
  detail.appendChild(form);
  var actions = actionsEl();
  if (connected) actions.appendChild(btn('次へ', goNext));
  detail.appendChild(actions);
}

function renderObs(detail) {
  detail.appendChild(title('OBS に表示する'));
  detail.appendChild(text('OBS を使う場合は、コメント表示 URL と演出 URL を OBS のブラウザソースへドラッグ&ドロップします。まだ OBS を使わない場合でも、「開く」でブラウザに表示して動作を確認できます。'));
  var browserNote = document.createElement('div');
  browserNote.className = 'note obs-note';
  browserNote.textContent = 'ブラウザ確認では、コメント表示 URL と演出 URL をそれぞれ開き、前のステップで接続した配信のコメントやテスト表示が出るか確認してください。';
  detail.appendChild(browserNote);
  detail.appendChild(urlRow('コメント', commentUrl(), 'copiedCommentUrlAt'));
  detail.appendChild(urlRow('演出', effectsUrl(), 'copiedEffectsUrlAt'));
  var note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'OBS への追加やブラウザ確認はアプリから自動検出できないため、確認できたら完了ボタンを押してください。';
  detail.appendChild(note);
  var actions = actionsEl();
  appendBackAction(actions);
  actions.appendChild(btn('表示を確認しました', function () {
    markStage('obs', { userConfirmedAt: now() }).then(goNext);
  }));
  detail.appendChild(actions);
}

function refreshListenerStatus() {
  var jobs = [];
  if (window.api.listeners && window.api.listeners.getOwnerChannels) {
    jobs.push(window.api.listeners.getOwnerChannels().then(function (resp) {
      ownerChannels = resp && Array.isArray(resp.ownerChannels) ? resp.ownerChannels : [];
    }).catch(function () { ownerChannels = []; }));
  }
  if (window.api.listeners && window.api.listeners.getOnecommeStatus) {
    jobs.push(window.api.listeners.getOnecommeStatus().then(function (status) {
      onecommeStatus = status || null;
    }).catch(function () { onecommeStatus = null; }));
  }
  return Promise.all(jobs).then(render);
}

function renderListenerHistory(detail) {
  detail.appendChild(title('リスナー履歴を使う'));
  detail.appendChild(text('初見歓迎、常連判定、わんコメ連携を使う場合は自チャンネル設定が必要です。'));
  var note = document.createElement('div');
  note.className = 'note';
  var onecomme = onecommeStatus && onecommeStatus.hasDirectory ? 'わんコメ: フォルダ検出済み' : 'わんコメ: 未検出';
  if (onecommeStatus && onecommeStatus.running) onecomme += ' / 起動中';
  note.textContent = '自チャンネル: ' + (ownerChannels.length || '未設定') + ' / ' + onecomme;
  detail.appendChild(note);
  if (ownerChannels.length === 0) {
    var ownerNote = document.createElement('div');
    ownerNote.className = 'note obs-note';
    ownerNote.textContent = 'わんコメ履歴のコメントは自チャンネル設定を基準に取り込みます。先に自分のチャンネルを追加してください。';
    detail.appendChild(ownerNote);
  }

  var form = document.createElement('div');
  form.className = 'inline-form';
  var input = document.createElement('input');
  input.placeholder = '@handle または UC...';
  form.appendChild(input);
  form.appendChild(btn('追加', function () {
    var raw = input.value.trim();
    if (!raw || !window.api.listeners) return;
    window.api.listeners.resolveChannelInfo(raw).then(function (resp) {
      if (!resp || !resp.ok || !resp.channelId) return;
      var next = ownerChannels.concat([{ channelId: resp.channelId, handle: resp.handle || '' }]);
      window.api.listeners.setOwnerChannels(next).then(refreshListenerStatus);
    });
  }));
  detail.appendChild(form);
  renderListenerImportResult(detail);

  var actions = actionsEl();
  appendBackAction(actions);
  var importBtn = btn(listenerImporting ? 'インポート中...' : 'わんコメから初回インポート', function () {
    if (!window.api.listeners || !window.api.listeners.importFromOnecomme) return;
    if (ownerChannels.length === 0 || listenerImporting) return;
    listenerImporting = true;
    listenerImportResult = null;
    listenerImportError = '';
    markStage('listenerHistory', { wantsListenerHistory: true, wantsOneComme: true });
    window.api.listeners.importFromOnecomme().then(function (resp) {
      listenerImportResult = resp || null;
      if (resp && resp.ok) {
        markStage('listenerHistory', { firstImportCompletedAt: now(), completedAt: now() });
      } else if (resp && resp.canceled) {
        listenerImportError = 'キャンセルしました。';
      } else {
        listenerImportError = 'インポートに失敗しました。' + (resp && resp.error ? ' ' + resp.error : '');
      }
      refreshListenerStatus();
    }).catch(function (err) {
      listenerImportError = 'インポートに失敗しました: ' + (err && err.message ? err.message : err);
    }).finally(function () {
      listenerImporting = false;
      render();
    });
  });
  importBtn.disabled = listenerImporting || ownerChannels.length === 0;
  actions.appendChild(importBtn);
  actions.appendChild(btn('今は使わない', function () {
    markStage('listenerHistory', {
      wantsListenerHistory: false,
      wantsOneComme: false,
      skipped: true
    }).then(function () {
      window.close();
    });
  }));
  if (ownerChannels.length > 0) {
    actions.appendChild(btn('完了して閉じる', function () {
      markStage('listenerHistory', { wantsListenerHistory: true, completedAt: now() }).then(function () {
        window.close();
      });
    }));
  }
  detail.appendChild(actions);
}

function renderListenerImportResult(detail) {
  if (!listenerImporting && !listenerImportResult && !listenerImportError) return;
  var box = document.createElement('div');
  box.className = 'note obs-note';
  if (listenerImporting) {
    box.textContent = 'わんコメ DB を読み込んでいます...';
  } else if (listenerImportError) {
    box.textContent = listenerImportError;
  } else if (listenerImportResult && listenerImportResult.ok && listenerImportResult.summary) {
    var s = listenerImportResult.summary;
    box.textContent =
      'インポート完了: リスナー 新規 ' + s.listenersNew + ' / 更新 ' + s.listenersUpdated +
      '、配信 新規 ' + s.streamsNew + ' / 更新 ' + s.streamsUpdated +
      '、コメント 新規 ' + s.commentsInserted + ' / 重複 ' + s.commentsSkipped +
      ' / 自チャンネル外 ' + s.commentsFilteredOtherChannel + ' / 不正 ' + s.commentsInvalid;
  } else if (listenerImportResult && listenerImportResult.canceled) {
    box.textContent = 'キャンセルしました。';
  } else {
    box.textContent = 'インポート結果を確認できませんでした。';
  }
  detail.appendChild(box);
}

function title(value) {
  var h = document.createElement('h2');
  h.textContent = value;
  return h;
}

function text(value) {
  var p = document.createElement('p');
  p.textContent = value;
  return p;
}

function actionsEl() {
  var el = document.createElement('div');
  el.className = 'actions';
  return el;
}

function renderDetail() {
  var detail = document.getElementById('setup-detail');
  clear(detail);
  if (activeStage === 'connect') renderConnect(detail);
  else if (activeStage === 'obs') renderObs(detail);
  else if (activeStage === 'listenerHistory') renderListenerHistory(detail);
}

function render() {
  if (!setupState) return;
  activeStage = normalizeActiveStage(activeStage);
  renderSteps();
  renderDetail();
}

function init() {
  window.api.onLastUrl(function (url) {
    lastUrlValue = url || '';
    if (!urlDraftValue) urlDraftValue = lastUrlValue;
    render();
  });
  window.api.getLastUrl();
  window.api.onboarding.getState().then(function (state) {
    setupState = state;
    activeStage = normalizeActiveStage(state.lastActiveStage || 'connect');
    return Promise.all([
      window.api.getSelectedScene().then(function (sceneId) { selectedSceneId = sceneId || 'chat'; }).catch(function (err) { setupLog.debug('getSelectedScene rejected (catch swallow):', err); }),
      refreshListenerStatus()
    ]);
  }).then(render);
}

window.api.onPort(function (port) {
  currentPort = port || currentPort;
  render();
});

window.api.onStatus(function (data) {
  connected = !!(data && data.connected);
  if (!connected && setupState && !obsStageDone()) {
    activeStage = 'connect';
  }
  if (connected && setupState && !stageData('connect').completedAt) {
    markStage('connect', { completedAt: now() });
  } else {
    render();
  }
});

if (window.api.onCoreReady) {
  window.api.onCoreReady(function () {
    window.api.getSelectedScene().then(function (sceneId) {
      selectedSceneId = sceneId || selectedSceneId;
    }).catch(function (err) { setupLog.debug("promise rejected (catch swallow):", err); }).then(render);
  });
}

init();
