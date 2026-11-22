/* The header's grid drawing (skin.css). Pointing at a menu item (mouse or pen, resting 120 ms, so a sweep across the bar
   closes nothing) or focusing it with the keyboard closes its bay's breaker: that page's load is connected. One page at a
   time: the latest of the pointer and the keyboard; when it is let go, the one still held (if any) takes over. From 1180 px
   the drawing then shows what that changes: GRID.loads holds, for one unit of load at each page, the change on every line,
   busbar section and feeder that changes (positive in the way its path is drawn: e lines, h the substation's busbar sections,
   b<page>.<i> a page bus's, f the feeder; generated with the drawing and written between the GRID markers). Each is drawn
   in ink over its quiet line, its width proportional to the change, from its upstream end, all at once, with its arrowhead.
   The page you are on is in service: pointing at it keeps its breaker closed and draws the flows that serve it, the same
   unit. While the Tools list is open (it covers the drawing) only the Tools breaker closes. No timers at rest, no animation
   frames, no scroll listeners; writes nothing to storage. */
(function () {
  'use strict';
  /* GRID: */ var GRID = {"loads":{"about":{"b1.2":0.125,"b2.0":0.125,"b2.1":0.125,"b2.2":0.375,"b3.0":0.375,"b3.1":0.375,"b3.2":1.0,"b4.0":1.0,"e1":0.125,"e2":0.375,"e3":1.0,"e5":0.125,"e6":0.25,"e7":0.625,"f1":1.0,"f2":1.0,"h0":1.0,"h1":0.875,"h2":0.625},"cv":{"b1.2":0.125,"b2.0":0.125,"b2.1":0.125,"b2.2":0.375,"b3.0":0.375,"b3.1":0.375,"b3.2":1.0,"b4.0":1.0,"b4.1":1.0,"b5.0":1.0,"e1":0.125,"e2":0.375,"e3":1.0,"e4":1.0,"e5":0.125,"e6":0.25,"e7":0.625,"f1":1.0,"f2":1.0,"h0":1.0,"h1":0.875,"h2":0.625},"news":{"b1.2":0.125,"b2.0":0.125,"b2.1":0.125,"b2.2":0.375,"b3.0":0.375,"b3.1":-0.625,"e1":0.125,"e2":0.375,"e5":0.125,"e6":0.25,"e7":0.625,"f1":1.0,"f2":1.0,"h0":1.0,"h1":0.875,"h2":0.625},"publications":{"b1.2":0.25,"b2.0":0.25,"b2.1":-0.75,"b2.2":-0.25,"b3.0":-0.25,"b3.1":-0.25,"e1":0.25,"e2":-0.25,"e5":0.25,"e6":0.5,"e7":0.25,"f1":1.0,"f2":1.0,"h0":1.0,"h1":0.75,"h2":0.25},"research":{"b0.0":-1.0,"b1.0":-1.0,"b1.1":-1.0,"b1.2":-0.375,"b2.0":-0.375,"b2.1":-0.375,"b2.2":-0.125,"b3.0":-0.125,"b3.1":-0.125,"e0":-1.0,"e1":-0.375,"e2":-0.125,"e5":0.625,"e6":0.25,"e7":0.125,"f1":1.0,"f2":1.0,"h0":1.0,"h1":0.375,"h2":0.125},"tools":{"b1.1":-1.0,"b1.2":-0.375,"b2.0":-0.375,"b2.1":-0.375,"b2.2":-0.125,"b3.0":-0.125,"b3.1":-0.125,"e1":-0.375,"e2":-0.125,"e5":0.625,"e6":0.25,"e7":0.125,"f1":1.0,"f2":1.0,"h0":1.0,"h1":0.375,"h2":0.125}}}; /* :GRID */
  var d = document, fig = d.querySelector('.site-header .bar-fig');
  if (!fig) return;
  var desk = window.matchMedia('(min-width: 1000px)'), wide = window.matchMedia('(min-width: 1180px)');
  var mesh = d.querySelector('.page-head .g-mesh');
  var runs = mesh ? Array.prototype.slice.call(fig.querySelectorAll('[data-run]')).concat(Array.prototype.slice.call(mesh.querySelectorAll('[data-run]'))) : [];
  var tools = d.querySelector('.nav-has-list'), panel = tools && tools.querySelector('.nav-list');
  var held = [], shown = '', drawn = '';
  function key(li) {
    var a = li.querySelector('.nav-a');
    return a ? (a.getAttribute('href') || '').replace(/[#?].*$/, '').replace(/\/$/, '').split('/').pop() : '';
  }
  function bay(k) { return fig.querySelector('g[data-feed="' + k + '"]'); }
  function clear() {
    runs.forEach(function (e) { e.classList.remove('is-flow', 'is-rev'); e.style.removeProperty('--w'); });
    drawn = '';
  }
  function draw(k) {
    if (drawn === k) return;
    clear();
    var row = GRID.loads && GRID.loads[k];
    if (!row || !mesh || !wide.matches) return;
    var on = [];
    runs.forEach(function (e) {
      var v = row[e.getAttribute('data-run')];
      if (!v) return;
      e.classList.toggle('is-rev', v < 0);
      e.style.setProperty('--w', Math.max(0.75, 3.5 * Math.abs(v)).toFixed(2) + 'px');
      on.push(e);
    });
    void fig.getBoundingClientRect();   // a reversed run takes its start first, so each draws from its upstream end
    on.forEach(function (e) { e.classList.add('is-flow'); });
    drawn = k;
  }
  // the one page shown: the latest still held; its breaker closed (already, for the page you are on), every other pointed one open
  function sync() {
    var k = held.length ? held[held.length - 1] : '';
    if (k !== shown) {
      if (shown) { var o = bay(shown); if (o) o.classList.remove('is-on'); }
      if (k) { var g = bay(k); if (g && !g.classList.contains('is-live')) g.classList.add('is-on'); }
      shown = k;
    }
    if (k && !(k === 'tools' && panel && panel.classList.contains('is-open'))) draw(k); else clear();
  }
  function hold(k, on) {
    var g = bay(k);
    if (!g) return;
    var i = held.indexOf(k);
    if (i >= 0) held.splice(i, 1);
    if (on) held.push(k);
    sync();
  }
  Array.prototype.forEach.call(d.querySelectorAll('.site-nav .nav-items > li'), function (li) {
    var t = 0, k = key(li), hov = false, foc = false;
    function upd() { hold(k, hov || foc || (li === tools && !!panel && panel.classList.contains('is-open'))); }
    li.addEventListener('pointerenter', function (e) {
      if ((e.pointerType !== 'mouse' && e.pointerType !== 'pen') || !desk.matches) return;
      clearTimeout(t);
      t = setTimeout(function () { hov = true; upd(); }, 120);
    });
    li.addEventListener('pointerleave', function () { clearTimeout(t); if (hov) { hov = false; upd(); } });
    li.addEventListener('focusin', function (e) {
      if (!desk.matches || !e.target.matches(':focus-visible')) return;
      foc = true; upd();
    });
    li.addEventListener('focusout', function (e) {
      if (li.contains(e.relatedTarget)) return;
      if (foc) { foc = false; upd(); }
    });
    if (li === tools && panel && window.MutationObserver) new MutationObserver(upd).observe(panel, { attributes: true, attributeFilter: ['class'] });
  });
})();
