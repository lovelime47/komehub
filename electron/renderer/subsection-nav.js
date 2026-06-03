// subsection-nav.js — app-frame サブ画面の共通 navigation framework
//
// 目的: 全 subsection (= app-frame に editing class を付ける section) の画面遷移を
// 統一する。 親解決式の階層管理 / scroll 保持 / back button text 自動生成 / 親再描画
// hook を提供。 設計詳細は docs/architecture/subsection-navigation.md を参照。
//
// 使い方:
//   SubsectionNav.register({ id, parentId, title, scrollSelector, adopt, onReturn });
//   SubsectionNav.open('xxx-section');
//   SubsectionNav.close();        // 現在 top を 1 階層 close
//   SubsectionNav.refreshTitle('xxx-section');  // 動的 title 更新時

(function () {
  'use strict';

  var _registry = {};       // sectionId → 設定
  var _openStack = [];      // 現在表示中の section ID 配列 (= 浅い→深い)
  var _scrollMemory = {};   // sectionId → 直前の scrollTop

  // renderer.log 用ロガー (= framework 自己診断、 詳細: docs/logging.md)
  var subnavLog = (window.api && window.api.log && window.api.log.create)
    ? window.api.log.create('SubsectionNav')
    : { trace: function () {}, debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  function resolveTitle(entry) {
    if (typeof entry.title === 'function') {
      try { return entry.title() || ''; }
      catch (e) { subnavLog.warn('SubsectionNav: title fn threw', entry.id, e); return ''; }
    }
    return entry.title || '';
  }

  function resolveScrollEl(entry) {
    if (entry.scrollSelector) return document.querySelector(entry.scrollSelector);
    return document.getElementById(entry.id);
  }

  function resolveBackBtn(entry) {
    if (entry.adopt && entry.adopt.backBtnId) {
      return document.getElementById(entry.adopt.backBtnId);
    }
    var sec = document.getElementById(entry.id);
    return sec ? sec.querySelector('.subsection-back-btn') : null;
  }

  function resolveTitleEl(entry) {
    if (entry.adopt && entry.adopt.titleId) {
      return document.getElementById(entry.adopt.titleId);
    }
    var sec = document.getElementById(entry.id);
    return sec ? sec.querySelector('.subsection-title') : null;
  }

  function buildBackText(entry) {
    if (!entry.parentId) return '◀ 戻る';
    var parentEntry = _registry[entry.parentId];
    if (!parentEntry) return '◀ 戻る';
    var parentTitle = resolveTitle(parentEntry);
    if (!parentTitle) return '◀ 戻る';
    return '◀ ' + parentTitle + 'に戻る';
  }

  function saveScroll(entry) {
    var el = resolveScrollEl(entry);
    if (el) _scrollMemory[entry.id] = el.scrollTop;
  }

  function restoreScroll(entry) {
    var el = resolveScrollEl(entry);
    if (!el) return;
    var saved = _scrollMemory[entry.id];
    if (typeof saved !== 'number') return;
    // section を display:'' に変えた直後は layout 確定前なので rAF 1 回挟む
    requestAnimationFrame(function () {
      el.scrollTop = saved;
    });
  }

  function showSection(entry) {
    var sec = document.getElementById(entry.id);
    if (sec) sec.style.display = '';
  }

  function hideSection(entry) {
    var sec = document.getElementById(entry.id);
    if (sec) sec.style.display = 'none';
  }

  function updateHeader(entry) {
    var titleEl = resolveTitleEl(entry);
    if (titleEl) titleEl.textContent = resolveTitle(entry);
    var backBtn = resolveBackBtn(entry);
    if (backBtn) backBtn.textContent = buildBackText(entry);
  }

  function enterIfFirst() {
    if (_openStack.length === 1 && typeof window.enterAppFrameSubsection === 'function') {
      window.enterAppFrameSubsection();
    }
  }

  function leaveIfEmpty() {
    if (_openStack.length === 0 && typeof window.leaveAppFrameSubsection === 'function') {
      window.leaveAppFrameSubsection();
    }
  }

  function bindBackBtn(id) {
    var entry = _registry[id];
    if (!entry) return;
    var backBtn = resolveBackBtn(entry);
    if (!backBtn) return;
    // adopt 経由の場合、 既存 close button にハンドラが既に bind されている可能性がある。
    // 既存ハンドラの onclick (= property) は上書き、 addEventListener 経由のものは
    // 残ったままだが、 移行時に呼び出し側で IIFE を削除するので問題ない。
    backBtn.addEventListener('click', function () { close(id); });
  }

  function register(opts) {
    if (!opts || !opts.id) {
      subnavLog.warn('SubsectionNav.register: id required');
      return;
    }
    if (_registry[opts.id]) {
      subnavLog.warn('SubsectionNav.register: id already registered', opts.id);
      return;
    }
    _registry[opts.id] = {
      id: opts.id,
      parentId: opts.parentId || null,
      title: opts.title,
      scrollSelector: opts.scrollSelector || null,
      adopt: opts.adopt || null,
      onReturn: opts.onReturn || null,
    };
    bindBackBtn(opts.id);
  }

  function open(id) {
    var entry = _registry[id];
    if (!entry) {
      subnavLog.warn('SubsectionNav.open: not registered', id);
      return;
    }
    // 既に開いていれば header 更新 (= 動的 title 変更想定) して no-op 復帰
    if (_openStack.indexOf(id) >= 0) {
      updateHeader(entry);
      return;
    }

    var parentId = entry.parentId;
    var stackTop = _openStack.length > 0 ? _openStack[_openStack.length - 1] : null;

    // 通常 case: 親が stack top にいる (= 直系の子を開く) or 親が null で stack 空
    // 異常 case: 親が stack の途中にいる / stack top と親が違う → stack 巻き戻し + 親 chain を順次開く
    if (parentId !== stackTop) {
      // stack を全部 close してから新 chain を順に開く
      while (_openStack.length > 0) {
        closeTop();
      }
      if (parentId) {
        open(parentId);  // 再帰で親を先に開く
      }
    }

    // 親を hide + scroll save
    if (parentId) {
      var parentEntry = _registry[parentId];
      if (parentEntry) {
        saveScroll(parentEntry);
        hideSection(parentEntry);
      }
    }

    showSection(entry);
    _openStack.push(id);
    enterIfFirst();
    updateHeader(entry);
    restoreScroll(entry);
    // 観点 I: 画面遷移 (= ユーザー操作) を renderer.log に記録。
    // 詳細仕様: docs/logging.md。
    subnavLog.info('subsection: open, id=' + id + (entry.parentId ? ', parent=' + entry.parentId : ''));
  }

  // 内部用: stack top を pop して close する (= onReturn callback も呼ぶ)
  function closeTop() {
    if (_openStack.length === 0) return;
    var topId = _openStack[_openStack.length - 1];
    var entry = _registry[topId];
    if (!entry) {
      _openStack.pop();
      return;
    }

    saveScroll(entry);
    hideSection(entry);
    _openStack.pop();
    // 観点 I: 画面遷移 (= 戻る) を renderer.log に記録
    subnavLog.info('subsection: close, id=' + topId);

    if (entry.parentId) {
      var parentEntry = _registry[entry.parentId];
      if (parentEntry) {
        showSection(parentEntry);
        updateHeader(parentEntry);
        restoreScroll(parentEntry);
      }
    }

    if (entry.onReturn) {
      try { entry.onReturn(); }
      catch (e) { subnavLog.warn('SubsectionNav: onReturn threw', topId, e); }
    }

    leaveIfEmpty();
  }

  function close(id) {
    if (_openStack.length === 0) return;
    if (!id) {
      closeTop();
      return;
    }
    // 指定 id が top にいない場合、 stack を巻き戻して指定 id まで close
    if (_openStack[_openStack.length - 1] !== id) {
      subnavLog.warn('SubsectionNav.close: id not at top, unwinding', id);
      while (_openStack.length > 0 && _openStack[_openStack.length - 1] !== id) {
        closeTop();
      }
    }
    closeTop();
  }

  function refreshTitle(id) {
    var entry = _registry[id];
    if (!entry) return;
    updateHeader(entry);
    // 子 section の back text も影響する (= 親 title を参照しているため)
    Object.keys(_registry).forEach(function (childId) {
      if (_registry[childId].parentId === id) {
        var childEntry = _registry[childId];
        var backBtn = resolveBackBtn(childEntry);
        if (backBtn) backBtn.textContent = buildBackText(childEntry);
      }
    });
  }

  window.SubsectionNav = {
    register: register,
    open: open,
    close: close,
    refreshTitle: refreshTitle,
    // debug 用 (= 触らない)
    _registry: _registry,
    _openStack: _openStack,
    _scrollMemory: _scrollMemory,
  };
})();
