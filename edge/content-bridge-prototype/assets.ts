export const YOUTUBE_PLAYER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>Canvas YouTube Player Prototype</title>
  <link rel="stylesheet" href="/assets/youtube-player.css">
  <script src="/assets/youtube-player.js" defer></script>
</head>
<body>
  <div id="player-shell"><div id="player"></div></div>
  <div id="status"><span id="status-text">Authorizing player…</span><button id="retry" type="button" hidden>Play</button></div>
</body>
</html>`;

export const YOUTUBE_PLAYER_CSS = `html, body { width: 100%; height: 100%; margin: 0; background: #000; color: #fff; overflow: hidden; }
body { display: flex; flex-direction: column; font: 500 16px/1.4 system-ui, sans-serif; }
#player-shell { flex: 1 1 auto; min-width: 200px; min-height: 200px; background: #000; }
#player { width: 100%; height: 100%; }
#status { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 44px; padding: 8px 16px; box-sizing: border-box; color: #fff; background: #151515; text-align: center; }
#status[hidden], #retry[hidden] { display: none; }
#retry { border: 1px solid #fff; border-radius: 5px; padding: 7px 14px; color: #fff; background: #272727; font: inherit; }
`;

export const YOUTUBE_PLAYER_JS = `'use strict';
(function () {
  const status = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const retryButton = document.getElementById('retry');
  const pathParts = window.location.pathname.split('/');
  const sessionId = pathParts[pathParts.length - 1] || '';
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const claimToken = fragment.get('claim') || '';
  window.history.replaceState(null, '', window.location.pathname);

  let candidates = [];
  let playbackId = '';
  let eventToken = '';
  let candidateIndex = 0;
  let reportedPlayingVideoId = '';
  let switchTimer = null;
  let switchingCandidate = false;
  let fatalPlayerError = false;
  let player;

  function currentVideoId() {
    return candidates[candidateIndex] || '';
  }

  function setStatus(message, retryable) {
    statusText.textContent = message || '';
    status.hidden = !message;
    retryButton.hidden = !retryable;
  }

  function report(event, detail) {
    if (!eventToken) return;
    const body = Object.assign({
      playback_id: playbackId,
      event: event,
      video_id: currentVideoId(),
      candidate_index: candidateIndex,
      candidate_count: candidates.length
    }, detail || {});
    fetch('/v1/youtube/' + encodeURIComponent(sessionId) + '/events', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + eventToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(function () {});
  }

  function tryNextCandidate(errorCode) {
    if (fatalPlayerError || switchingCandidate) return;
    switchingCandidate = true;
    report('candidate_error', { error_code: errorCode });
    if (candidateIndex + 1 >= candidates.length) {
      setStatus('No embeddable YouTube result could be played.', false);
      report('exhausted', { error_code: errorCode });
      return;
    }
    candidateIndex += 1;
    reportedPlayingVideoId = '';
    setStatus('Trying another YouTube result…', false);
    report('candidate_switch', { previous_error_code: errorCode });
    switchTimer = window.setTimeout(function () {
      switchTimer = null;
      if (fatalPlayerError) return;
      switchingCandidate = false;
      player.loadVideoById({ videoId: currentVideoId(), startSeconds: 0 });
    }, 250);
  }

  function loadIframeApi() {
    window.onYouTubeIframeAPIReady = function () {
      player = new YT.Player('player', {
        width: '100%',
        height: '100%',
        videoId: currentVideoId(),
        playerVars: {
          autoplay: 1,
          controls: 1,
          enablejsapi: 1,
          fs: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin
        },
        events: {
          onReady: function (event) {
            report('ready');
            event.target.playVideo();
          },
          onStateChange: function (event) {
            if (event.data === YT.PlayerState.PLAYING) {
              setStatus('', false);
              if (reportedPlayingVideoId !== currentVideoId()) {
                reportedPlayingVideoId = currentVideoId();
                report('playing');
              }
            } else if (event.data === YT.PlayerState.ENDED) {
              report('ended');
            }
          },
          onError: function (event) {
            const code = Number(event.data);
            if (code === 153) {
              fatalPlayerError = true;
              switchingCandidate = false;
              if (switchTimer !== null) {
                window.clearTimeout(switchTimer);
                switchTimer = null;
              }
              setStatus('YouTube client identity error 153. Check the player referrer configuration.', false);
              report('identity_error', { error_code: code });
              return;
            }
            if ([2, 5, 100, 101, 150].includes(code)) {
              tryNextCandidate(code);
              return;
            }
            setStatus('YouTube playback error ' + code, false);
            report('player_error', { error_code: code });
          },
          onAutoplayBlocked: function () {
            setStatus('YouTube blocked autoplay. Select Play to continue.', true);
            report('autoplay_blocked');
          }
        }
      });
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    document.head.appendChild(script);
  }

  retryButton.addEventListener('click', function () {
    retryButton.hidden = true;
    setStatus('Starting YouTube…', false);
    player.playVideo();
  });

  if (!claimToken || !sessionId) {
    setStatus('This player session is not authorized.', false);
    return;
  }

  fetch('/v1/youtube/' + encodeURIComponent(sessionId) + '/claim', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + claimToken,
      'Content-Type': 'application/json'
    },
    body: '{}'
  })
    .then(function (response) {
      if (!response.ok) throw new Error('claim failed');
      return response.json();
    })
    .then(function (config) {
      candidates = config.video_ids;
      playbackId = config.playback_id;
      eventToken = config.event_token;
      setStatus('Loading YouTube…', false);
      loadIframeApi();
    })
    .catch(function () {
      setStatus('This player session is unavailable or already claimed.', false);
    });
})();
`;
