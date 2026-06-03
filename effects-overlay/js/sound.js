/**
 * 効果音再生
 */
var Sound = (function () {
  // OBSブラウザソースで音声を確実に出力するため、DOM上のaudio要素を使用
  var audioContainer = null;

  function ensureContainer() {
    if (!audioContainer) {
      audioContainer = document.createElement('div');
      audioContainer.id = 'sound-container';
      audioContainer.style.display = 'none';
      document.body.appendChild(audioContainer);
    }
  }

  return {
    play: function (url) {
      if (!url) return;
      ensureContainer();
      var audio = document.createElement('audio');
      audio.src = url;
      audio.volume = 0.5;
      audioContainer.appendChild(audio);
      audio.play().catch(function (e) {
        console.error('[Sound] Play failed:', url, e.message);
      });
      audio.addEventListener('ended', function () { audio.remove(); });
      audio.addEventListener('error', function () { audio.remove(); });
    }
  };
})();
