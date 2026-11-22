/* The spotlight on Home's four theme cards (hint.css). Inserts a frame in each card (aria-hidden); one animation frame per
   pointer move (and per scroll) sets each frame's light (--x, --y, the pointer relative to the frame); nothing runs at rest. */
(function () {
  'use strict';
  var d = document, grid = d.querySelector('.theme-grid');
  if (!grid) return;
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.theme'));
  cards.forEach(function (c) { c.insertAdjacentHTML('afterbegin', '<span class="hc-spot" aria-hidden="true"></span>'); });
  var raf = 0, px = -9999, py = -9999;
  function light() {
    raf = 0;
    cards.forEach(function (c) {
      var s = c.querySelector('.hc-spot'), r = s.getBoundingClientRect();
      s.style.setProperty('--x', Math.round(px - r.left) + 'px');
      s.style.setProperty('--y', Math.round(py - r.top) + 'px');
    });
  }
  function ask() { if (!raf) raf = window.requestAnimationFrame(light); }
  d.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    px = e.clientX; py = e.clientY; ask();
  }, { passive: true });
  window.addEventListener('scroll', ask, { passive: true });
})();
