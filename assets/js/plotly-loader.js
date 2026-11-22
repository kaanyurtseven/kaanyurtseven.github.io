/* Lazy loader for the Uncertainty Explorer.
   Injects data-fx-plotly-src, then data-fx-explorer-src, once #forecast-explorer is within 600 px
   of the viewport or the URL hash targets it; skips whatever the page already loads. */
(function (w, d) {
  'use strict';
  var me = d.currentScript || d.querySelector('script[data-fx-loader]');
  var sec = d.getElementById('forecast-explorer');
  if (!me || !sec || w.__fxLoader) return;
  w.__fxLoader = 1;
  var io = null, done = false;

  function has(re) {
    for (var s = d.scripts, i = 0; i < s.length; i++) {
      if (!s[i].hasAttribute('data-fx-loader') && re.test(s[i].src)) return true;
    }
    return false;
  }
  function add(src, onerror, onload) {
    var s = d.createElement('script');
    s.src = src;
    s.async = false;                            // run in insertion order: Plotly first
    if (onerror) s.onerror = onerror;
    if (onload) s.onload = onload;
    d.head.appendChild(s);
  }
  function ready() {                            // forecast.js may already be waiting
    if (w.__fxExplorer && w.__fxExplorer.start) w.__fxExplorer.start();
  }
  function state(s) {                           // same hook and event as forecast.js
    sec.setAttribute('data-fx-state', s);
    try { sec.dispatchEvent(new CustomEvent('explorer:state', { bubbles: true, detail: { state: s } })); }
    catch (e) { /* the attribute is set */ }
  }
  function fail() {
    var l = d.getElementById('forecast-loading'), e = d.getElementById('forecast-error');
    if (l) l.hidden = true;
    if (e) { e.textContent = 'Could not load the charting library.'; e.style.display = 'flex'; }
    state('error');
  }
  function start() {
    if (done) return;
    done = true;
    if (io) io.disconnect();
    w.removeEventListener('hashchange', onHash);
    if (!sec.hasAttribute('data-fx-state')) {
      var l = d.getElementById('forecast-loading');
      if (l) l.hidden = false;
      state('loading');
    }
    if (!w.Plotly && !has(/plotly[\w.-]*\.js([?#]|$)/i)) add(me.getAttribute('data-fx-plotly-src'), fail, ready);
    if (!w.__fxExplorer && !has(/\/forecast\.js([?#]|$)/)) add(me.getAttribute('data-fx-explorer-src'));
  }
  function targeted() {
    var id = location.hash.slice(1), t;
    try { id = decodeURIComponent(id); } catch (e) { /* keep the raw hash */ }
    t = id && d.getElementById(id);
    return !!t && (t === sec || sec.contains(t));
  }
  function onHash() { if (targeted()) start(); }

  if (targeted()) return start();
  w.addEventListener('hashchange', onHash);
  if (!('IntersectionObserver' in w)) return start();
  io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) return start();
  }, { rootMargin: '600px 0px' });
  io.observe(sec);
})(window, document);
