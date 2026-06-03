(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;

  runtime.htmlFirst.start({
    mode: 'ticker',
    renderlessModel: true,
    padding: 24,
    maxComments: 10,
    travelSeconds: 8,
    config: {
      maxComments: true,
      cssVars: {
        fontSize: ['--font-size', 'px'],
        nameColor: '--name-color',
        textColor: '--text-color'
      },
      toggleClasses: {
        showBadge: 'show-badge'
      },
      callbacks: {
        positionY: function (value, _config, helpers) {
          if (value != null) runtime.config.setPxVar(helpers.container, 'bottom', value);
        },
        travelSeconds: function (value, _config, helpers) {
          if (value != null) helpers.setTravelSeconds(value);
        },
        fontSize: function (value, _config, helpers) {
          if (value != null) helpers.recalcTrack();
        }
      },
      customCss: true
    }
  });
})();
