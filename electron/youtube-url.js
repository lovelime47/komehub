/**
 * YouTube URL からビデオIDを抽出する
 */

function extractVideoId(url) {
  if (!url) return null;

  var patterns = [
    // https://www.youtube.com/watch?v=VIDEO_ID
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    // https://youtu.be/VIDEO_ID
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    // https://www.youtube.com/live/VIDEO_ID
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = url.match(patterns[i]);
    if (match) return match[1];
  }

  // 11文字のIDが直接入力された場合
  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) {
    return url.trim();
  }

  return null;
}

function buildChatUrl(videoId) {
  return 'https://www.youtube.com/live_chat?is_popout=1&v=' + videoId;
}

function buildWatchUrl(videoId) {
  return 'https://www.youtube.com/watch?v=' + videoId;
}

module.exports = { extractVideoId, buildChatUrl, buildWatchUrl };
