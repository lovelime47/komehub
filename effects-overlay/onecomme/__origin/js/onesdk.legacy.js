(function () {
  'use strict';

  if (window.OneSDK) {
    return;
  }

  var current = document.currentScript;
  var src = '';

  try {
    src = current && current.src ? new URL('onesdk.js', current.src).toString() : 'onesdk.js';
  } catch (_err) {
    src = 'onesdk.js';
  }

  if (document.readyState === 'loading' && typeof document.write === 'function') {
    document.write('<script src="' + src + '"><\\/script>');
    return;
  }

  var script = document.createElement('script');
  script.src = src;
  (document.head || document.documentElement).appendChild(script);
})();
