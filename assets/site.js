/* Theme switch and phone Menu on every page; the explorer's hover label after a theme switch; on Home the headline's
   fit and the studio: Pause, theme highlights and the story text in the theme cards. */
(function () {
  'use strict';
  var d = document, root = d.documentElement;

  // ── Theme: System / Light / Dark, localStorage 'ky-theme', html[data-theme], 'themechange' ──
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() {
    try { var t = localStorage.getItem('ky-theme'); return t === 'light' || t === 'dark' ? t : 'system'; }
    catch (e) { return root.getAttribute('data-theme') || 'system'; }
  }
  function effective(choice) { return choice === 'light' || choice === 'dark' ? choice : (media && media.matches ? 'dark' : 'light'); }
  function sync(choice) {
    var bs = d.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].getAttribute('data-theme-choice') === choice));
  }
  function apply(choice) {
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice); else root.removeAttribute('data-theme');
    try { if (choice === 'light' || choice === 'dark') localStorage.setItem('ky-theme', choice); else localStorage.removeItem('ky-theme'); } catch (e) { /* this page only */ }
    sync(choice);
    if (window.__scene) window.__scene();
    d.dispatchEvent(new CustomEvent('themechange', { detail: { choice: choice, theme: effective(choice) } }));
  }
  var current = root.getAttribute('data-theme') || stored();
  sync(current);
  d.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-theme-choice]') : null;
    if (!b) return;
    current = b.getAttribute('data-theme-choice');
    apply(current);
  });
  if (media && media.addEventListener) media.addEventListener('change', function () {
    if (window.__scene) window.__scene();
    if (current === 'system') d.dispatchEvent(new CustomEvent('themechange', { detail: { choice: 'system', theme: effective('system') } }));
  });

  // ── Menu (phones) ──
  var toggle = d.querySelector('.nav-toggle'), nav = d.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        toggle.setAttribute('aria-expanded', 'false'); nav.classList.remove('is-open'); toggle.focus();
      }
    });
  }

  // The h1 is set in its display lines (wide and tablet widths; phones wrap freely). The CSS size fits
  // the headline at every width; if a line is still wider than the column, the headline and its second
  // line (.dek) scale down to fit.
  function fitTitle() {
    var top = d.querySelector('.hero-top'), h = d.getElementById('h1');
    if (!top || !h) return;
    top.style.removeProperty('--h1');
    if (window.matchMedia('(min-width: 761px)').matches) {
      var ls = h.querySelectorAll('.h1-l'), cw = h.getBoundingClientRect().width;
      // WCAG 1.4.12: the display lines may wrap (site.css), so they are measured unwrapped (.h1-fit)
      h.classList.add('h1-fit');
      var w = Array.prototype.map.call(ls, function (l) { var r = d.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect().width; });
      h.classList.remove('h1-fit');
      var fs = parseFloat(getComputedStyle(h).fontSize), widest = Math.max.apply(null, w);
      if (widest > cw) top.style.setProperty('--h1', (fs * cw / widest * 0.985).toFixed(1) + 'px');
    }
    fitHero(top);
  }
  // The hero's height cap (site.css) needs the headline block's height. site.css estimates it from the font sizes and line
  // heights (a one-line byline, the h1's two lines, a one-line second line or none), which fails for a second line that wraps,
  // a headline that fitTitle scales down or a reader's own text spacing. From 900 px the block's measured height is set as
  // --hero-block on .hero, so the cap is exact; the estimate stays for the first paint and for the page without JS. Called by
  // fitTitle: on load (fonts.ready) and on a resize.
  function fitHero(top) {
    var hero = d.querySelector('.hero');
    if (!hero) return;
    if (window.matchMedia('(min-width: 900px)').matches) hero.style.setProperty('--hero-block', (Math.round(top.getBoundingClientRect().height * 64) / 64) + 'px');
    else hero.style.removeProperty('--hero-block');
  }
  if (d.getElementById('h1')) {
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(fitTitle); else fitTitle();
    var rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(fitTitle, 120); });
  }

  // ── The explorer's label box after a theme switch ──
  // forecast.js redraws its charts on a theme change and keeps a locked point, but Plotly leaves the trajectory's hover
  // label (the box at the active point and its spike lines) as drawn in the old theme until the next hover: a light box
  // inside the dark instrument, or a dark box on the light paper. Where a label is on show, it is drawn again at the same
  // point in the frame after forecast.js's redraw (which runs in the frame after 'themechange').
  // A programmatic hover emits no plotly_hover, so the explorer's state is untouched.
  var traj = d.getElementById('forecast-trajectory');
  if (traj) d.addEventListener('themechange', function () {
    var lay = traj.querySelector('.hoverlayer'), hd = traj._hoverdata, x = lay && lay.childNodes.length && hd && hd.length ? hd[0].x : null;
    if (x == null) return;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () {
      raf(function () {
        var P = window.Plotly, xa = traj._fullLayout && traj._fullLayout.xaxis;
        if (!P || !P.Fx || !P.Fx.hover || !xa) return;
        try { P.Fx.hover(traj, { xval: xa.d2c(x) }, 'xy'); } catch (e) { /* the label only */ }
      });
    });
  });

  // ── Home: the studio ──
  var studio = d.getElementById('studio');
  if (!studio || !window.Studio || !window.UncertaintyField) return;
  var M = window.Studio.mount(studio, { engine: studio.getAttribute('data-engine') || undefined });
  window.__studio = M;   // the mounted model, for inspection from the browser console (its qa* fields)
  var pause = d.getElementById('studio-pause');
  if (pause) {
    pause.hidden = false;
    window.UncertaintyField.motion.bindButton(pause, { hideWhenReduced: true });
  }
  // Hover or keyboard focus on a theme highlights its counterpart in the model (no text moves).
  var themes = d.querySelectorAll('[data-theme-key]'), active = null;
  function hl(el) {
    var key = el ? el.getAttribute('data-theme-key') : null;
    if (active) active.classList.remove('is-hl');
    active = el;
    if (el) el.classList.add('is-hl');
    if (M && M.setHighlight) M.setHighlight(key);
  }
  Array.prototype.forEach.call(themes, function (el) {
    el.addEventListener('mouseenter', function () { hl(el); });
    el.addEventListener('mouseleave', function () { if (active === el) hl(null); });
    el.addEventListener('focusin', function () { hl(el); });
    el.addEventListener('focusout', function (e) { if (!el.contains(e.relatedTarget) && active === el) hl(null); });
  });

  // ── The story text in the hovered or focused theme card (html[data-story]: text | swap | none) ──
  // The model tells the story; the card says it in a few words, beat by beat, on the story's own clock (studio.js: each
  // story's say list; M.onSay reports a change of beat). Every beat of a card sits in the same grid cell of its
  // .theme-say, so the box is as tall as its longest beat at every width and nothing moves when a beat changes. text: the
  // box is a reserved line under the copy; swap: the box lies over the copy, which fades out while a beat shows. Escape
  // hides the beats until the card is left (WCAG 1.4.13; needed for swap, which replaces content). The box is
  // aria-hidden: the figure's text alternative already tells both stories, and the beats would only repeat it.
  // Touch screens (hover: none) get no beats: a tap plays the story on a model that is then scrolled off (CSS). Nor does
  // a card while less than a quarter of the figure is in view (SAY_VIS): off-screen the model stands still.
  var says = {}, sayOn = null, sayCard = null, sayEsc = false, sayKey = null, sayVis = true, mqNoHover = window.matchMedia ? window.matchMedia('(hover: none)') : null;
  function sayAdd(k, text) {
    var S = says[k];
    if (!S) return null;
    if (!S.spans[text]) { var s = d.createElement('span'); s.className = 'say-b'; s.textContent = text; S.box.appendChild(s); S.spans[text] = s; }
    return S.spans[text];
  }
  function sayBuild() {
    Array.prototype.forEach.call(themes, function (el) {
      var k = el.getAttribute('data-theme-key'), box = el.querySelector('.theme-say');
      if (!box || !M || !M.sayFor) return;
      box.textContent = '';
      says[k] = { el: el, box: box, spans: {} };
      M.sayFor(k).forEach(function (b) { sayAdd(k, b[1]); });
    });
    if (sayCard) sayCard.classList.remove('is-say');
    sayOn = null; sayCard = null;
  }
  function sayShow() {
    var ev = M && M.sayNow, mode = root.getAttribute('data-story');
    var span = ev && ev.key && ev.text && mode !== 'none' && !sayEsc && sayVis && !(mqNoHover && mqNoHover.matches) ? sayAdd(ev.key, ev.text) : null, card = span ? says[ev.key].el : null;
    if (span !== sayOn) {
      if (sayOn) sayOn.classList.remove('is-on');
      if (span) span.classList.add('is-on');
      sayOn = span;
    }
    if (card !== sayCard) {
      if (sayCard) sayCard.classList.remove('is-say');
      if (card) card.classList.add('is-say');
      sayCard = card;
    }
  }
  if (M && M.onSay) {
    sayBuild();
    M.onSay(function (ev) { if (ev.key !== sayKey) { sayEsc = false; sayKey = ev.key; } sayShow(); });
    // Escape also works before a story's first beat shows (some stories' first beat comes 0.6 s after the hover or focus)
    d.addEventListener('keydown', function (e) { if ((e.key === 'Escape' || e.key === 'Esc') && (sayCard || (M && M.hl))) { sayEsc = true; sayShow(); } });
    var fig = studio.querySelector('.st-frame');
    var SAY_VIS = 0.25;
    if (fig && window.IntersectionObserver) new IntersectionObserver(function (en) { var e = en[en.length - 1]; sayVis = e.isIntersecting && e.intersectionRatio >= SAY_VIS - 1e-3; sayShow(); }, { threshold: [0, SAY_VIS] }).observe(fig);
    // Tab to a theme link: the browser centers the link, which at 1440 x 900 scrolls the figure out of view, so neither
    // the story nor its beats would be seen. With story text on, the page is scrolled instead so that the card's bottom
    // sits 24 px above the window's bottom, when the whole card then fits and at least a quarter of the figure shows;
    // otherwise the browser's own scroll stands. The link stays fully in view (WCAG 2.4.11).
    Array.prototype.forEach.call(themes, function (el) {
      el.addEventListener('focusin', function (e) {
        var a = e.target;
        if (root.getAttribute('data-story') === 'none' || (mqNoHover && mqNoHover.matches) || !fig || !a.matches || !a.matches(':focus-visible')) return;
        window.requestAnimationFrame(function () {
          if (d.activeElement !== a) return;
          var c = el.getBoundingClientRect(), f = fig.getBoundingClientRect(), H = window.innerHeight, dy = c.bottom + 24 - H;
          var shown = function (off) { return Math.max(0, Math.min(H, f.bottom - off) - Math.max(0, f.top - off)) / Math.max(1, f.height); };
          if (shown(0) >= SAY_VIS || c.height + 48 > H || c.top - dy < 0 || shown(dy) < SAY_VIS) return;
          window.scrollBy(0, dy);
        });
      });
    });
  }
})();
