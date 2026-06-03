(function () {
  'use strict';

  function toElement(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    if (target.nodeType === 1) return target;
    return null;
  }

  function applyState(element, options) {
    options = options || {};
    if (!element) return null;
    element.classList.add('lcv-marquee');
    if (options.duration != null) {
      element.style.setProperty('--lcv-marquee-duration', String(options.duration));
    }
    if (options.gap != null) {
      element.style.setProperty('--lcv-marquee-gap', String(options.gap));
    }
    return {
      element: element,
      stop: function () {
        element.classList.remove('lcv-marquee');
      },
      start: function () {
        element.classList.add('lcv-marquee');
      },
      destroy: function () {
        element.classList.remove('lcv-marquee');
        element.style.removeProperty('--lcv-marquee-duration');
        element.style.removeProperty('--lcv-marquee-gap');
      }
    };
  }

  var api = {
    create: function (target, options) {
      return applyState(toElement(target), options);
    },
    start: function (target, options) {
      var handle = applyState(toElement(target), options);
      return handle || null;
    },
    stop: function (target) {
      var element = target && target.element ? target.element : toElement(target);
      if (element) element.classList.remove('lcv-marquee');
    }
  };

  window.OneMarquee = api;
  window.oneMarquee = api;
})();
