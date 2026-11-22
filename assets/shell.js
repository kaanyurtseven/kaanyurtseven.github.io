/* The Tools list and the phone Menu's focus rule, on every page (loaded after site.js). Disclosure pattern: "Tools" is a
   link; the chevron button opens the panel. Pointer (mouse, pen): opens after 120 ms at rest on the link, the button or the
   panel, closes 250 ms after leaving all three. Keyboard: Enter or Space on the button; Escape closes and returns focus to
   the button; focus leaving the item closes. Touch: a tap on the button; a tap outside or Escape closes; a tap on "Tools"
   follows the link. WCAG 1.4.13: after Escape the panel stays closed while the pointer stays on the item. Below 1000 px the
   list is always shown inside the Menu (CSS). Writes nothing to storage. */
(function () {
  'use strict';
  var d = document, mqDesk = window.matchMedia('(min-width: 1000px)');

  // ── Phone Menu: when Tab leaves the open Menu it closes, so the focused link is never hidden under it (WCAG 2.4.11)
  var toggle = d.querySelector('.nav-toggle'), nav = d.getElementById('site-nav');
  if (toggle && nav) nav.addEventListener('focusout', function (e) {
    var t = e.relatedTarget;
    if (toggle.getAttribute('aria-expanded') === 'true' && t && !nav.contains(t) && t !== toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
    }
  });
  // Back or Forward restores a page from the back-forward cache as it was left: the Menu closes (focus inside it goes to the button)
  if (toggle && nav) window.addEventListener('pageshow', function (e) {
    if (!e.persisted || toggle.getAttribute('aria-expanded') !== 'true') return;
    var back = nav.contains(d.activeElement);
    toggle.setAttribute('aria-expanded', 'false');
    nav.classList.remove('is-open');
    if (back) toggle.focus();
  });

  // ── The Tools list ──
  var item = d.querySelector('.nav-has-list');
  if (!item) return;
  var link = item.querySelector('.nav-tools'), btn = item.querySelector('.nav-list-btn'), panel = item.querySelector('.nav-list');
  var bar = item.closest('.bar');
  if (!link || !btn || !panel) return;
  panel.hidden = false;                     // closed is visibility: hidden (base.css), so the panel can fade
  var open = false, tOpen = 0, tClose = 0, escHeld = false, inside = false;

  function measure() {                      // the panel's right edge on the content box's right edge
    if (!bar || !mqDesk.matches) return;
    var w = bar.getBoundingClientRect().right - item.getBoundingClientRect().left + 21;   // the item's left edge is the T of Tools
    // rounded: the T of Tools sits on a half pixel, so the panel ends 0.5 px past the content box; the exact width would
    // narrow the panel's measure by 0.5 px, which can wrap a description line
    panel.style.setProperty('--nl-w', Math.round(w) + 'px');
    // Home: where the model's Pause button stands under the panel's lower edge, the panel reaches 8 px below the button,
    // so it covers it whole instead of cutting it; width and rows stay the same
    panel.style.minHeight = '';
    var p = d.body.classList.contains('is-home') && d.getElementById('studio-pause');
    if (!p || p.hidden) return;
    var pr = p.getBoundingClientRect(), nb = panel.getBoundingClientRect(), top = bar.getBoundingClientRect().bottom;
    var bottom = top + panel.offsetHeight;
    if (pr.width && pr.left < nb.right && pr.right > nb.left && bottom > pr.top - 8 && bottom < pr.bottom + 8) {
      panel.style.minHeight = Math.ceil(pr.bottom + 8 - top) + 'px';
    }
  }
  function set(v) {
    clearTimeout(tOpen); clearTimeout(tClose);
    if (v === open) return;
    open = v;
    if (v) measure();
    btn.setAttribute('aria-expanded', String(v));
    panel.classList.toggle('is-open', v);
  }
  function isMouse(e) { return e.pointerType === 'mouse' || e.pointerType === 'pen'; }

  // pointer: hover intent and close grace (desktop only; the Menu shows the list without either)
  item.addEventListener('pointerenter', function (e) {
    if (!isMouse(e) || !mqDesk.matches) return;
    inside = true;
    clearTimeout(tClose);
    if (open || escHeld) return;
    tOpen = setTimeout(function () { set(true); }, 120);
  });
  item.addEventListener('pointerleave', function (e) {
    if (!isMouse(e)) return;
    inside = false;
    escHeld = false;
    clearTimeout(tOpen);
    if (!open || item.contains(d.activeElement) && d.activeElement !== link) return;
    tClose = setTimeout(function () { set(false); }, 250);
  });

  // keyboard and touch: the button toggles at once
  btn.addEventListener('click', function () {
    escHeld = false;
    set(!open);
  });
  // focus leaving the item closes (keyboard); a tap outside closes (touch, and a click anywhere else)
  item.addEventListener('focusout', function (e) {
    if (open && e.relatedTarget && !item.contains(e.relatedTarget) && !inside) set(false);
  });
  d.addEventListener('pointerdown', function (e) {
    if (open && !item.contains(e.target)) set(false);
  });
  d.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && open) {
      var back = panel.contains(d.activeElement);
      set(false);
      if (inside) escHeld = true;           // stays closed while the pointer stays on the item
      if (back) btn.focus();
    }
  });
  window.addEventListener('resize', function () { if (open) measure(); });
  mqDesk.addEventListener('change', function () { set(false); });
  // restored from the back-forward cache: the list closes (a link clicked in it kept it open, as it still had focus)
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var back = panel.contains(d.activeElement);
    inside = false; escHeld = false;
    set(false);
    if (back) btn.focus();
  });
})();

/* The color theme control at the end of the header's bar. One icon button opens a small group of three (System, Light,
   Dark); site.js handles a click on any [data-theme-choice] (it stores ky-theme and sets aria-pressed).
   The group closes after a choice, on Escape (focus back to the button) and on a click or tap outside it. Writes nothing itself. */
(function () {
  'use strict';
  var d = document, pick = d.querySelector('.theme-pick');
  if (!pick) return;
  var btn = pick.querySelector('.theme-btn'), menu = pick.querySelector('.theme-menu');
  if (!btn || !menu) return;
  var quiet = false;
  function set(v) {
    btn.setAttribute('aria-expanded', String(v));
    menu.hidden = !v;
  }
  btn.addEventListener('click', function () { set(menu.hidden); });
  menu.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-theme-choice]')) { set(false); if (!quiet) btn.focus(); }
  });
  d.addEventListener('pointerdown', function (e) { if (!menu.hidden && !pick.contains(e.target)) set(false); });
  pick.addEventListener('focusout', function (e) { if (!menu.hidden && e.relatedTarget && !pick.contains(e.relatedTarget)) set(false); });
  // in the capture phase, so one Escape closes the group alone: the open phone Menu under it stays open
  d.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && !menu.hidden) { e.stopPropagation(); set(false); btn.focus(); }
  }, true);
  // restored from the back-forward cache: the group closes, and a theme chosen meanwhile on another page is applied by site.js's own
  // handler (a click on that choice, as the reader's would be), so its state, the stored key and 'themechange' stay as site.js keeps them
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var back = menu.contains(d.activeElement), t = null;
    set(false);
    if (back) btn.focus();
    try { t = localStorage.getItem('ky-theme'); } catch (x) { return; }
    var want = t === 'light' || t === 'dark' ? t : 'system', now = d.documentElement.getAttribute('data-theme') || 'system';
    var c = want === now ? null : menu.querySelector('[data-theme-choice="' + want + '"]');
    if (c) { quiet = true; c.click(); quiet = false; }
  });
})();

/* Every [data-generated] status line (the explorer page, Tools) gets the data's age at the reader's time. The line ends
   ", updated N minutes ago" (or hours, or days); the light is green while the Elia data are at most 48 hours old and gray
   after that. Writes nothing. */
(function () {
  'use strict';
  var els = document.querySelectorAll('[data-generated]');
  if (!els.length) return;
  function ago(h) {
    if (h < 1) { var m = Math.max(1, Math.round(h * 60)); return m + (m === 1 ? ' minute ago' : ' minutes ago'); }
    if (h < 24) { var n = Math.round(h); return n + (n === 1 ? ' hour ago' : ' hours ago'); }
    var dd = Math.round(h / 24); return dd + (dd === 1 ? ' day ago' : ' days ago');
  }
  Array.prototype.forEach.call(els, function (el) {
    var t = Date.parse(el.getAttribute('data-generated'));
    if (isNaN(t)) return;
    var now = Date.now();
    var h = Math.max(0, (now - t) / 36e5), age = el.querySelector('.fx-age');
    el.setAttribute('data-feed', h <= 48 ? 'current' : 'old');
    if (age) age.textContent = ', updated ' + ago(h);
  });
})();

/* The phone Menu button reads "Close" while its menu is open; site.js toggles aria-expanded. */
(function () {
  'use strict';
  var t = document.querySelector('.nav-toggle');
  if (!t || !window.MutationObserver) return;
  function label() { t.textContent = t.getAttribute('aria-expanded') === 'true' ? 'Close' : 'Menu'; }
  new MutationObserver(label).observe(t, { attributes: true, attributeFilter: ['aria-expanded'] });
})();
