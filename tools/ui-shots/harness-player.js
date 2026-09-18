(function () {
  'use strict';
  var q = new URLSearchParams(window.location.search);
  var viewer = q.get('harnessViewer') || 'linked';
  document.getElementById('video').setAttribute('data-bg', q.get('bg') || 'night');

  var obs = document.getElementById('obs');
  if (q.get('obs') === '0') obs.remove();
  else obs.src = './obs.html';

  // The parameters Twitch itself appends to a video overlay iframe.
  var ext = new URLSearchParams({ anchor: 'video_overlay', language: 'ru', mode: 'viewer', platform: 'web', state: 'released' });
  ext.set('harnessViewer', viewer);
  document.getElementById('ext').src = './video_overlay.html?' + ext.toString();
})();
