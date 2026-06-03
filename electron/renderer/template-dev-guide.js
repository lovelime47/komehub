(function () {
  'use strict';

  var DOC_LIST_NODE = document.getElementById('doc-list');
  var TOC_NODE = document.getElementById('toc');
  var ARTICLE_NODE = document.getElementById('article');
  var CONTENT_NODE = document.getElementById('content');

  var docsState = {
    list: [],
    byId: {},
    byFile: {},
    currentDocId: null
  };

  // marked のグローバル設定
  if (typeof marked !== 'undefined' && marked.setOptions) {
    marked.setOptions({
      breaks: false,
      gfm: true,
      headerIds: true
    });
  }

  function reportError(message) {
    ARTICLE_NODE.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'loading';
    p.textContent = '読み込みに失敗しました: ' + message;
    ARTICLE_NODE.appendChild(p);
  }

  function classifyDoc(doc) {
    if (doc.id.indexOf('example-') === 0) return 'examples';
    if (doc.id === 'authoring' || doc.id === 'runtime' || doc.id === 'onecomme') return 'main';
    return 'other';
  }

  function buildDocList(docs) {
    DOC_LIST_NODE.innerHTML = '';
    var groups = { main: [], examples: [], other: [] };
    docs.forEach(function (doc) {
      groups[classifyDoc(doc)].push(doc);
    });

    function appendGroup(label, items) {
      if (items.length === 0) return;
      var labelEl = document.createElement('div');
      labelEl.className = 'group-label';
      labelEl.textContent = label;
      DOC_LIST_NODE.appendChild(labelEl);
      items.forEach(function (doc) {
        var a = document.createElement('a');
        a.href = '#';
        a.textContent = doc.title;
        a.dataset.docId = doc.id;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          loadDoc(doc.id);
        });
        DOC_LIST_NODE.appendChild(a);
      });
    }

    appendGroup('ガイド', groups.main);
    appendGroup('チュートリアル', groups.examples);
    appendGroup('その他', groups.other);
  }

  function highlightSelected(docId) {
    var links = DOC_LIST_NODE.querySelectorAll('a[data-doc-id]');
    links.forEach(function (a) {
      if (a.dataset.docId === docId) {
        a.classList.add('selected');
      } else {
        a.classList.remove('selected');
      }
    });
  }

  function buildToc() {
    var headings = ARTICLE_NODE.querySelectorAll('h2, h3');
    if (headings.length === 0) {
      TOC_NODE.hidden = true;
      TOC_NODE.innerHTML = '';
      return;
    }
    TOC_NODE.hidden = false;
    TOC_NODE.innerHTML = '';
    var label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = '目次';
    TOC_NODE.appendChild(label);

    headings.forEach(function (h) {
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      if (h.tagName === 'H3') a.className = 'toc-h3';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var target = document.getElementById(h.id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      TOC_NODE.appendChild(a);
    });
  }

  // 内部リンク (= 同フォルダ内の別 .md or 別 example の .md) を判定して loadDoc に振る
  function resolveDocFromHref(href, currentFile) {
    if (!href || href.charAt(0) === '#') return null;
    if (/^https?:\/\//i.test(href)) return null;
    // currentFile から相対 path を解決
    var parts = currentFile.split('/');
    parts.pop(); // remove filename
    var hrefParts = href.split('/');
    hrefParts.forEach(function (part) {
      if (part === '..') {
        parts.pop();
      } else if (part !== '.' && part !== '') {
        parts.push(part);
      }
    });
    var resolved = parts.join('/');
    // hash を分離
    var hashIndex = resolved.indexOf('#');
    var hash = '';
    if (hashIndex >= 0) {
      hash = resolved.substring(hashIndex);
      resolved = resolved.substring(0, hashIndex);
    }
    var doc = docsState.byFile[resolved];
    if (doc) return { docId: doc.id, hash: hash };
    return null;
  }

  function interceptLinks(currentFile) {
    var links = ARTICLE_NODE.querySelectorAll('a[href]');
    links.forEach(function (a) {
      a.addEventListener('click', function (e) {
        var href = a.getAttribute('href');
        if (!href) return;

        // 同 doc 内の anchor
        if (href.charAt(0) === '#') {
          e.preventDefault();
          var target = document.getElementById(href.substring(1));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }

        // 外部 URL は openExternal 委譲
        if (/^https?:\/\//i.test(href)) {
          e.preventDefault();
          if (window.api && window.api.openExternal) {
            window.api.openExternal(href);
          }
          return;
        }

        // 内部別 doc への参照
        var resolved = resolveDocFromHref(href, currentFile);
        if (resolved) {
          e.preventDefault();
          loadDoc(resolved.docId, resolved.hash ? resolved.hash.substring(1) : null);
          return;
        }

        // それ以外はリンク無効化 (= 配布対象外の path、迷子防止)
        e.preventDefault();
      });
    });
  }

  function loadDoc(docId, anchorId) {
    var doc = docsState.byId[docId];
    if (!doc) {
      reportError('未知のドキュメント: ' + docId);
      return;
    }
    docsState.currentDocId = docId;
    highlightSelected(docId);
    ARTICLE_NODE.innerHTML = '<p class="loading">読み込み中…</p>';

    window.api.templateDevGuide.read(doc.file).then(function (markdown) {
      var html = (typeof marked !== 'undefined') ? marked.parse(markdown) : escapeHtml(markdown);
      ARTICLE_NODE.innerHTML = html;
      buildToc();
      interceptLinks(doc.file);
      // anchor 指定があればスクロール、なければ top
      if (anchorId) {
        var target = document.getElementById(anchorId);
        if (target) {
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
          return;
        }
      }
      CONTENT_NODE.scrollTop = 0;
    }).catch(function (err) {
      reportError(err && err.message ? err.message : String(err));
    });
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function init() {
    if (!window.api || !window.api.templateDevGuide) {
      reportError('テンプレ開発ガイド API が利用できません');
      return;
    }
    window.api.templateDevGuide.list().then(function (docs) {
      docsState.list = docs;
      docs.forEach(function (doc) {
        docsState.byId[doc.id] = doc;
        docsState.byFile[doc.file] = doc;
      });
      buildDocList(docs);
      var first = docs[0];
      if (first) loadDoc(first.id);
    }).catch(function (err) {
      reportError(err && err.message ? err.message : String(err));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
