/* Research Footprint Map: Leaflet controller (IIFE, ES2017).
   Reads window.MAP_PINS, injected by _includes/map.html. Usually loaded by
   assets/js/map-loader.js, which calls window.KYMap.init() once Leaflet and
   markercluster are present; a page without the loader initializes at DOM
   ready. Loading this file twice is harmless.

   Markers are <span class="map-glyph map-glyph--{type}"> drawn by CSS, arcs
   are SVG paths with class "map-arc" (+ "is-active"), arc geometry comes
   from the CSS custom property --map-arc-mode (geodesic | straight), fly
   duration from --map-fly-duration. The basemap is self-hosted Natural
   Earth GeoJSON drawn as SVG paths (.map-land, .map-lake, .map-border,
   .map-coast), so the map requests nothing from a third party. No colors
   live in this file.
   --------------------------------------------------------------------- */
(function () {
  'use strict';

  var KY = window.KYMap = window.KYMap || {};
  if (KY.init) {            /* second copy of this file: just (re)try init */
    if (!window.KYMapLoader) KY.init();
    return;
  }
  KY.init = init;

  /* ── Configuration ──────────────────────────────────────────────── */

  var MOBILE_BP = 640;
  var VIEW_DESKTOP = { center: [28, 10], zoom: 2 };
  var VIEW_MOBILE  = { center: [30, 10], zoom: 1 };   /* clamped to minZoom 2 */
  var CLUSTER_FROM_ZOOM = 3;      /* clustering starts on the first zoom past 2 */
  var SPREAD_GAP = 24;            /* at the overview, pins are pushed apart to this center distance */
  var LEADER_PX = 4;              /* a pin moved further than this gets a hairline to its place */
  var PANEL_CLEAR_PX = 64;        /* an open pin is panned this far clear of its panel */
  var ARC_POINTS = 50;
  var FLY_DEFAULT_S = 0.7;
  var FLY_MAX_S = 2;

  /* Every pin but the research base has an arc from the research base (the
     home pin): the arcs connect each place to the current base, they are not
     journeys, so events held online and the places of earlier years have one
     too. Pins dated before ERA_SPLIT_YEAR carry data-period="izmir" on their
     glyph, later ones "leuven" (a styling hook). */
  var ERA_SPLIT_YEAR = 2022;

  /* Basemap: Natural Earth land, lakes and land boundaries, self-hosted as
     GeoJSON in assets/data/basemap/ (scripts/build_basemap.rb). The URL
     template is data-basemap on #research-map, {scale} = 110m or 50m.
     1:110m is drawn up to zoom 3 and fetched with the map (map-loader.js
     starts it early); 1:50m is drawn from zoom 4 and fetched on the first
     zoom. Each file is one FeatureCollection whose features carry
     properties.class; the class picks the CSS classes of its SVG paths.
     Features are grouped into CHUNK_DEG cells, once per world copy, and
     only the chunks near the view are on the map: Leaflet projects every
     point of a layer on each zoom, so far-away land would cost time. */
  var MAX_ZOOM = 7;               /* where the 1:50m outlines still hold */
  var DETAIL_FROM_ZOOM = 4;       /* 1:50m from this zoom */
  var BASEMAP_PANE_Z = 200;       /* Leaflet's tile level: under arcs (400) and pins (600) */
  var BASEMAP_PADDING = 0.5;      /* drawn half a view beyond each edge, so drags stay filled */
  var BASEMAP_NEAR = 0.6;         /* chunks within 0.6 views of the view are on the map (drawn: 0.5) */
  var BASEMAP_REFRESH_MS = 120;   /* redrawn at most this often while dragging or flying */
  var CHUNK_DEG = 30;
  /* Drawing order (one SVG per class, stacked in this order) and CSS classes */
  var BASEMAP_ORDER = ['land', 'lake', 'coast', 'border', 'border-disputed'];
  var BASEMAP_CLASSES = {
    land: 'map-land',
    lake: 'map-lake',
    coast: 'map-coast',
    border: 'map-border',
    'border-disputed': 'map-border map-border--disputed'
  };
  var BASEMAP_ATTRIBUTION = '<a href="https://www.naturalearthdata.com/">Natural Earth</a>';

  /* Type names for the preview and the detail badge. A page may override
     single entries by setting window.MAP_LABELS before this file runs. */
  var LABELS = {
    home:          'Research Base',
    education:     'Education',
    publication:   'Conference',
    talk:          'Talk / Poster',
    training:      'Training',
    visit:         'Visit',
    data:          'Data source',
    award:         'Award'
  };

  var OSI_DEFS = [
    { key: 'n',  arrow: '↑', name: 'north' },
    { key: 'ne', arrow: '↗', name: 'northeast' },
    { key: 'e',  arrow: '→', name: 'east' },
    { key: 'se', arrow: '↘', name: 'southeast' },
    { key: 's',  arrow: '↓', name: 'south' },
    { key: 'sw', arrow: '↙', name: 'southwest' },
    { key: 'w',  arrow: '←', name: 'west' },
    { key: 'nw', arrow: '↖', name: 'northwest' }
  ];

  /* ── State ──────────────────────────────────────────────────────── */

  var map = null, pins = [], order = [];
  var markers = [], markerPins = [], markerByPin = {}, idxByKey = {};
  var arcs = [], arcModeInUse = null;
  var clusterGroup = null, offscreenWrap = null;
  var spreadKey = '', leaders = [], orderTimer = null;
  var activeDetail = null, hideTimer = null;
  var mapActivated = false, hintTimer = 0, moving = false;

  /* DOM refs, resolved in init() */
  var mapEl, preview, mpType, mpLabel, mpSummary, mpPhoto;
  var detail, mdType, mdYear, mdLabel, mdLocation, mdVenue, mdPaper;
  var mdDesc, mdImage, mdTags, mdActions, hintEl;

  /* ── Utilities ──────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  function isMobile() { return window.innerWidth < MOBILE_BP; }

  function mq(query) { return !!(window.matchMedia && window.matchMedia(query).matches); }

  function reducedMotion() { return mq('(prefers-reduced-motion: reduce)'); }

  function canHover() { return mq('(hover: hover) and (pointer: fine)'); }

  function cssVar(name) {
    try {
      return getComputedStyle(mapEl).getPropertyValue(name).trim().replace(/^["']|["']$/g, '');
    } catch (e) { return ''; }
  }

  function arcMode() { return cssVar('--map-arc-mode') === 'straight' ? 'straight' : 'geodesic'; }

  /* --map-fly-duration: "0.4s" or "400ms"; capped so nothing runs long */
  function flyDuration() {
    var v = cssVar('--map-fly-duration');
    var n = parseFloat(v);
    if (isNaN(n)) return FLY_DEFAULT_S;
    if (/ms$/.test(v)) n = n / 1000;
    return Math.min(Math.max(n, 0.05), FLY_MAX_S);
  }

  /* Longest transition (duration + delay) on an element, in ms */
  function transitionMs(el) {
    try {
      var cs = getComputedStyle(el);
      var d = cs.transitionDuration.split(','), l = cs.transitionDelay.split(',');
      var max = 0;
      for (var i = 0; i < d.length; i++) {
        var t = (parseFloat(d[i]) || 0) + (parseFloat(l[i % l.length]) || 0);
        if (t > max) max = t;
      }
      return Math.ceil(max * 1000);
    } catch (e) { return 0; }
  }

  function focusVisible(el) {
    try { return el.matches(':focus-visible'); } catch (e) { return true; }
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }

  /** Great-circle distance in km */
  function haversine(a, b) {
    var R = 6371;
    var dLat = (b[0] - a[0]) * Math.PI / 180;
    var dLng = (b[1] - a[1]) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  /** Polyline points along the great circle; longitudes unwrapped so an arc
      that crosses the antimeridian does not jump across the map */
  function generateCurve(from, to, n) {
    var k = Math.PI / 180;
    var lat1 = from[0] * k, lng1 = from[1] * k, lat2 = to[0] * k, lng2 = to[1] * k;
    var d = haversine(from, to) / 6371;
    if (d < 1e-6 || Math.abs(Math.sin(d)) < 1e-9) return [from, to];
    var points = [], prev = null;
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var A = Math.sin((1 - f) * d) / Math.sin(d);
      var B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
      var y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
      var z = A * Math.sin(lat1) + B * Math.sin(lat2);
      var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / k;
      var lng = Math.atan2(y, x) / k;
      if (prev !== null) {
        while (lng - prev > 180) lng -= 360;
        while (lng - prev < -180) lng += 360;
      }
      prev = lng;
      points.push([lat, lng]);
    }
    return points;
  }

  /** First four-digit year in "2017", "2014–2021", "2025, 2026", "2022–present" */
  function firstYear(pin) {
    var m = String(pin.year == null ? '' : pin.year).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : null;
  }

  function periodOf(pin) {
    var y = firstYear(pin);
    if (y === null) return '';
    return y < ERA_SPLIT_YEAR ? 'izmir' : 'leuven';
  }

  function pinKey(pin, idx) { return pin.id ? String(pin.id) : 'pin-' + idx; }

  /* Class-name token from data */
  function token(s) { return String(s == null ? '' : s).replace(/[^a-z0-9_-]/gi, ''); }

  function isTurkish(pin) { return /^(turkey|türkiye|turkiye)$/i.test(pin.country || ''); }

  function placeText(pin) {
    return [pin.city, pin.country].filter(Boolean).join(', ');
  }

  function accessibleName(pin) {
    return [pin.label, pin.city, pin.year].filter(Boolean).join(', ');
  }

  /* ── Basemap ────────────────────────────────────────────────────── */

  /* chunks[scale] = [{ cls, poly, items, box, dx, bounds, layer, on }], one
     per class, CHUNK_DEG cell and world copy (layer made on first use);
     coast chunks are made from the land chunks the first time CSS asks for
     coastlines. renderers[cls] = one SVG renderer per class. */
  var basemap = {
    pane: null, renderers: {}, copies: [0], chunks: {}, coastMade: {},
    scale: null, wantCoast: false, detailAsked: false
  };

  function loadBasemap(scale) {
    var loader = window.KYMapLoader;
    if (loader && loader.basemap) return loader.basemap(scale);
    var src = mapEl.getAttribute('data-basemap');
    if (!src || !window.fetch) return Promise.reject(new Error('No basemap source'));
    return fetch(src.replace('{scale}', scale), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('Basemap ' + scale + ': HTTP ' + r.status);
      return r.json();
    });
  }

  /* World copies either side of the main one, enough to fill the widest
     view at minZoom wherever worldCopyJump leaves the center: one on each
     side for a map up to 2048 px wide at zoom 2 */
  function worldCopies() {
    var worldPx = 256 * Math.pow(2, map.getMinZoom());
    var k = Math.max(1, Math.ceil((mapEl.clientWidth || 0) / 2 / worldPx));
    var out = [];
    for (var i = -k; i <= k; i++) out.push(i * 360);
    return out;
  }

  /* Bounding box [west, south, east, north] of a ring or a line */
  function bbox(pts) {
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < bb[0]) bb[0] = p[0];
      if (p[1] < bb[1]) bb[1] = p[1];
      if (p[0] > bb[2]) bb[2] = p[0];
      if (p[1] > bb[3]) bb[3] = p[1];
    }
    return bb;
  }

  function makeChunk(cls, poly, items, box, dx) {
    return {
      cls: cls, poly: poly, items: items, box: box, dx: dx, layer: null, on: false,
      bounds: L.latLngBounds([box[1], box[0] + dx], [box[3], box[2] + dx])
    };
  }

  /* Groups one file's polygons and lines by class and by the CHUNK_DEG cell
     of their box center, then repeats each group once per world copy */
  function buildChunks(scale, gj) {
    var cells = {}, keys = [];
    var features = gj && Array.isArray(gj.features) ? gj.features : [];
    features.forEach(function (f) {
      var cls = f && f.properties && f.properties['class'];
      var g = f && f.geometry;
      if (!g || !Array.isArray(g.coordinates) || !BASEMAP_CLASSES[cls] || cls === 'coast') return;
      var poly = g.type === 'MultiPolygon';
      if (!poly && g.type !== 'MultiLineString') return;
      g.coordinates.forEach(function (item) {
        var b = bbox(poly ? item[0] : item);
        if (!isFinite(b[0])) return;
        var key = cls + ' ' + Math.floor((b[0] + b[2]) / 2 / CHUNK_DEG) + ' ' +
                  Math.floor((b[1] + b[3]) / 2 / CHUNK_DEG);
        var cell = cells[key];
        if (!cell) {
          cell = cells[key] = { cls: cls, poly: poly, items: [], box: b.slice() };
          keys.push(key);
        }
        cell.items.push(item);
        cell.box = [Math.min(cell.box[0], b[0]), Math.min(cell.box[1], b[1]),
                    Math.max(cell.box[2], b[2]), Math.max(cell.box[3], b[3])];
      });
    });
    var chunks = [];
    keys.forEach(function (key) {
      var c = cells[key];
      basemap.copies.forEach(function (dx) { chunks.push(makeChunk(c.cls, c.poly, c.items, c.box, dx)); });
    });
    basemap.chunks[scale] = chunks;
  }

  /* Coastlines: the land rings without the edges Natural Earth adds along
     the antimeridian and the South Pole */
  function coastLines(polys) {
    var lines = [];
    polys.forEach(function (poly) {
      poly.forEach(function (ring) {
        var run = [];
        ring.forEach(function (p) {
          var q = run[run.length - 1];
          if (q && ((Math.abs(p[0]) === 180 && p[0] === q[0]) || (p[1] <= -89.99 && q[1] <= -89.99))) {
            if (run.length > 1) lines.push(run);
            run = [];
          }
          run.push(p);
        });
        if (run.length > 1) lines.push(run);
      });
    });
    return lines;
  }

  /* Coast chunks, made once per scale from its land chunks */
  function makeCoast(scale) {
    if (basemap.coastMade[scale] || !basemap.chunks[scale]) return;
    basemap.coastMade[scale] = true;
    var add = [];
    basemap.chunks[scale].forEach(function (c) {
      if (c.cls !== 'land') return;
      var lines = coastLines(c.items);
      if (lines.length) add.push(makeChunk('coast', false, lines, c.box, c.dx));
    });
    basemap.chunks[scale] = basemap.chunks[scale].concat(add);
  }

  /* The Leaflet layer of a chunk. The style options are unstyled fallbacks
     only: CSS sets the real fill and stroke through the classes. */
  function chunkLayer(c) {
    var dx = c.dx;
    var toLatLng = function (p) { return new L.LatLng(p[1], p[0] + dx); };
    var opts = { renderer: basemap.renderers[c.cls], className: BASEMAP_CLASSES[c.cls], interactive: false };
    if (c.poly) {
      return L.polygon(c.items.map(function (poly) {
        return poly.map(function (ring) { return ring.map(toLatLng); });
      }), L.extend(opts, { stroke: false, fill: true, fillColor: 'currentColor', fillOpacity: 0.08 }));
    }
    return L.polyline(c.items.map(function (line) { return line.map(toLatLng); }),
      L.extend(opts, { fill: false, color: 'currentColor', weight: 1, opacity: 0.25 }));
  }

  /* .map-coast is drawn only when CSS gives it a stroke: a probe path in
     the basemap pane reads the stylesheet's rules */
  function coastWanted() {
    if (!basemap.pane || !document.createElementNS) return false;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('class', 'map-coast');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.appendChild(path);
    basemap.pane.appendChild(svg);
    var stroke = '';
    try { stroke = getComputedStyle(path).stroke; } catch (e) { stroke = ''; }
    basemap.pane.removeChild(svg);
    return !!stroke && stroke !== 'none';
  }

  /* 1:50m from DETAIL_FROM_ZOOM once loaded, else whichever scale exists */
  function scaleForZoom(z) {
    var want = z >= DETAIL_FROM_ZOOM - 0.5 ? '50m' : '110m';
    if (basemap.chunks[want]) return want;
    return basemap.chunks['110m'] ? '110m' : (basemap.chunks['50m'] ? '50m' : null);
  }

  /* Puts on the map the chunks of this zoom's scale that lie within
     BASEMAP_NEAR views of the view, and takes the others off (only that,
     when dropOnly). Sets data-scale on the pane. */
  function syncBasemap(dropOnly) {
    if (!map || !basemap.pane) return;
    var scale = scaleForZoom(map.getZoom());
    if (scale && basemap.wantCoast) makeCoast(scale);
    var near = map.getBounds().pad(BASEMAP_NEAR);
    Object.keys(basemap.chunks).forEach(function (s) {
      basemap.chunks[s].forEach(function (c) {
        var want = s === scale && (c.cls !== 'coast' || basemap.wantCoast) && near.intersects(c.bounds);
        if (want === c.on || (want && dropOnly === true)) return;
        if (want) {
          if (!c.layer) c.layer = chunkLayer(c);
          map.addLayer(c.layer);
        } else {
          map.removeLayer(c.layer);
        }
        c.on = want;
      });
    });
    if (scale && scale !== basemap.scale) {
      basemap.scale = scale;
      basemap.pane.setAttribute('data-scale', scale);
    }
  }

  /* Leaflet redraws vector layers only when a move or zoom ends. While a
     drag or a fly runs, this redraws the basemap (and the arcs, once the
     zoom has changed) every BASEMAP_REFRESH_MS, so no blank water opens up
     at the edges and Reset does not shrink the land into the middle. Also
     run when a file arrives and when coastlines are switched. */
  function refreshBasemap() {
    if (!map || !basemap.pane || map._animatingZoom) return;
    syncBasemap();
    var zoom = map.getZoom();
    var zoomed = BASEMAP_ORDER.some(function (cls) {
      var r = basemap.renderers[cls];
      return r._map && Math.abs(zoom - r._zoom) > 1e-3;
    });
    BASEMAP_ORDER.forEach(function (cls) {
      var r = basemap.renderers[cls];
      if (!r._map) return;
      if (zoomed) r._reset(); else r._update();
    });
    var overlay = map._renderer;
    if (zoomed && overlay && overlay._map) overlay._reset();
  }

  function loadDetail() {
    if (basemap.detailAsked) return;
    basemap.detailAsked = true;
    loadBasemap('50m').then(function (gj) {
      buildChunks('50m', gj);
      refreshBasemap();
    }, function () { /* the 1:110m outlines stay */ });
  }

  function initBasemap() {
    basemap.pane = map.createPane('basemap');
    basemap.pane.style.zIndex = String(BASEMAP_PANE_Z);
    basemap.copies = worldCopies();

    /* Registered before the renderers join the map, so far chunks leave
       before Leaflet re-projects at zoomend, and near ones join at moveend,
       just before Leaflet redraws. */
    map.on('zoomend', function () { syncBasemap(true); });
    map.on('moveend', function () { syncBasemap(); });
    map.on('move', L.Util.throttle(refreshBasemap, BASEMAP_REFRESH_MS));
    /* The first zoom (or a start beyond the overview) fetches 1:50m */
    map.on('zoomstart', loadDetail);

    /* One SVG per class, added in drawing order so they stack that way */
    BASEMAP_ORDER.forEach(function (cls) {
      basemap.renderers[cls] = L.svg({ pane: 'basemap', padding: BASEMAP_PADDING });
      map.addLayer(basemap.renderers[cls]);
    });
    basemap.wantCoast = coastWanted();
    if (map.attributionControl) map.attributionControl.addAttribution(BASEMAP_ATTRIBUTION);

    loadBasemap('110m').then(function (gj) {
      buildChunks('110m', gj);
      refreshBasemap();
    }, function () { /* no outlines: pins, arcs and the list still work */ });
    if (map.getZoom() >= DETAIL_FROM_ZOOM - 1) loadDetail();
  }

  /* A theme change may turn coastlines on or off */
  function updateCoast() {
    var want = coastWanted();
    if (want === basemap.wantCoast) return;
    basemap.wantCoast = want;
    refreshBasemap();
  }

  /* ── Initialization ─────────────────────────────────────────────── */

  function init() {
    if (map) return true;
    mapEl = $('research-map');
    if (!mapEl || typeof L === 'undefined' || mapEl._leaflet_id) return false;

    preview    = $('map-preview');
    mpType     = $('mp-type');
    mpLabel    = $('mp-label');
    mpSummary  = $('mp-summary');
    mpPhoto    = $('mp-photo');
    detail     = $('map-detail');
    mdType     = $('md-type');
    mdYear     = $('md-year');
    mdLabel    = $('md-label');
    mdLocation = $('md-location');
    mdVenue    = $('md-venue');
    mdPaper    = $('md-paper');
    mdDesc     = $('md-desc');
    mdImage    = $('md-image');
    mdTags     = $('md-tags');
    mdActions  = $('md-actions');
    hintEl     = $('map-hint');

    pins = Array.isArray(window.MAP_PINS) ? window.MAP_PINS : [];
    if (window.MAP_LABELS) L.extend(LABELS, window.MAP_LABELS);

    var stale = mapEl.querySelector('.map-fallback');
    if (stale) stale.parentNode.removeChild(stale);

    var reduce = reducedMotion();
    var mobile = isMobile();

    map = L.map(mapEl, {
      scrollWheelZoom: true,        /* plain wheels reach it only once the map is active (below) */
      zoomControl: false,
      attributionControl: true,
      maxZoom: MAX_ZOOM,
      minZoom: 2,
      worldCopyJump: true,
      zoomAnimation: !reduce,
      fadeAnimation: !reduce,
      markerZoomAnimation: !reduce,
      inertia: !reduce
    });
    KY.map = map;

    /* Registered first, so later moveend handlers see the settled state */
    map.on('movestart', function () { moving = true; });
    map.on('moveend', function () { moving = false; });

    /* Reduced motion: every pan Leaflet makes (keyboard arrows, focus
       auto-pan, setView) jumps instead of gliding. */
    if (reduce) {
      var panBy = map.panBy;
      map.panBy = function (offset, options) {
        return panBy.call(this, offset, L.extend({}, options, { animate: false }));
      };
    }

    var view = initialView();
    map.setView(view.center, view.zoom, { animate: false });

    var zoomCtrl = L.control.zoom({ position: mobile ? 'bottomright' : 'topright' });
    zoomCtrl.addTo(map);

    /* Reset-view button, appended to the same bar as + and − */
    var resetBtn = L.DomUtil.create('a', 'leaflet-control-zoom-reset', zoomCtrl.getContainer());
    resetBtn.innerHTML = '<span aria-hidden="true">⌂</span>';
    resetBtn.href = '#';
    resetBtn.title = 'Reset to overview';
    resetBtn.setAttribute('role', 'button');
    resetBtn.setAttribute('aria-label', 'Reset to overview');
    L.DomEvent.on(resetBtn, 'click', function (e) {
      L.DomEvent.stop(e);
      resetView();
    });
    /* The bar's links act as buttons, so Space activates them too */
    L.DomEvent.on(zoomCtrl.getContainer(), 'keydown', function (e) {
      var t = e.target;
      if ((e.key === ' ' || e.key === 'Spacebar') && t && t.getAttribute('role') === 'button') {
        L.DomEvent.preventDefault(e);
        t.click();
      }
    });

    initBasemap();

    /* Scroll-zoom activation: a click or tap anywhere in the map (a pin, a
       control or the map itself) lets the plain wheel zoom; before that it
       scrolls the page and shows the hint, while Ctrl or Cmd with the wheel
       (and a trackpad pinch, which arrives as one) zoom at once */
    var activate = function () {
      if (mapActivated) return;
      mapActivated = true;
      hideHint();
    };
    mapEl.addEventListener('pointerdown', activate, true);
    map.on('click', function () {
      activate();
      if (activeDetail !== null) hideDetail();
    });
    if (hintEl) {
      var hintText = hintEl.querySelector('span') || hintEl;
      hintText.textContent = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
        ? 'Click the map, or hold \u2318 while scrolling, to zoom'
        : 'Click the map, or hold Ctrl while scrolling, to zoom';
    }
    var wheelWrap = mapEl.parentNode || mapEl;
    wheelWrap.addEventListener('wheel', function (e) {
      if (mapActivated || e.ctrlKey || e.metaKey || !mapEl.contains(e.target)) return;
      e.stopPropagation();          /* Leaflet never sees it; the page scrolls */
      showHint();
    }, { capture: true, passive: true });

    /* Tab order follows time: oldest first, ties in data order */
    order = pins.map(function (p, i) { return i; }).sort(function (a, b) {
      var ya = firstYear(pins[a]), yb = firstYear(pins[b]);
      if (ya === null) ya = 9999;
      if (yb === null) yb = 9999;
      return ya - yb || a - b;
    });

    buildMarkers();
    buildArcs();
    updateSpread();
    map.on('zoomend moveend', queueOrder);

    /* Escape closes the hover preview and the detail panel */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (preview && !preview.hidden) hidePreview();
      if (activeDetail !== null) hideDetail();
    });

    /* Close button: document delegation keeps it independent of Leaflet */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('#map-detail-close')) hideDetail();
    });

    /* Keyboard focus on a pin shows the same preview as hovering it */
    mapEl.addEventListener('focusin', function (e) {
      var idx = markerIdx(e.target);
      if (idx !== null && focusVisible(e.target)) showPreview(idx);
    });
    mapEl.addEventListener('focusout', function (e) {
      if (markerIdx(e.target) !== null) hidePreview();
    });

    /* Hide hover preview on any map movement so it doesn't get stranded */
    map.on('movestart zoomstart', function () { hidePreview(); });

    /* Enable clustering once the user zooms in past the initial overview */
    map.on('zoomend', function () {
      updateSpread();               /* first, so clustering starts from unshifted icons */
      if (map.getZoom() >= CLUSTER_FROM_ZOOM) enableClustering();
    });

    /* A theme change that alters --map-arc-mode or the .map-coast stroke
       rebuilds the arcs or the coastlines */
    var onTheme = function () {
      if (arcMode() !== arcModeInUse) buildArcs();
      updateCoast();
    };
    window.addEventListener('themechange', onTheme);
    document.addEventListener('themechange', onTheme);
    if (window.matchMedia) {
      var scheme = window.matchMedia('(prefers-color-scheme: dark)');
      if (scheme.addEventListener) scheme.addEventListener('change', onTheme);
    }

    initOffscreenIndicators();
    emit('kymap:ready', {});
    return true;
  }

  /* Clamped to the map's zoom limits: setView applies minZoom itself, but
     flyTo (Reset with motion allowed) does not, so Reset on a phone would
     otherwise land at zoom 1 instead of the initial zoom 2. */
  function initialView() {
    var v = isMobile() ? VIEW_MOBILE : VIEW_DESKTOP;
    var z = map ? Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), v.zoom)) : v.zoom;
    return { center: v.center, zoom: z };
  }

  function emit(name, detailObj) {
    try {
      mapEl.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detailObj }));
    } catch (e) { /* old browsers: no events */ }
  }

  /* ── Markers ────────────────────────────────────────────────────── */

  function glyphHtml(pin) {
    var period = periodOf(pin), year = firstYear(pin);
    return '<span class="map-glyph map-glyph--' + token(pin.type) + '"' +
           (pin.virtual ? ' data-virtual' : '') +
           (period ? ' data-period="' + period + '"' : '') +
           (year !== null ? ' data-year="' + year + '"' : '') +
           '></span>';
  }

  /* 24 x 24 hit area; the glyph inside is drawn by CSS. dx, dy move the icon
     off its place (the overview's fan-out). */
  function markerIcon(idx, dx, dy) {
    var pin = pins[idx];
    return L.divIcon({
      className: 'map-marker map-marker--' + token(pin.type),
      html: glyphHtml(pin),
      iconSize: [24, 24],
      iconAnchor: [12 - dx, 12 - dy]
    });
  }

  function buildMarkers() {
    order.forEach(function (idx) {
      var pin = pins[idx];
      if (typeof pin.lat !== 'number' || typeof pin.lng !== 'number') return;

      var marker = L.marker([pin.lat, pin.lng], { icon: markerIcon(idx, 0, 0), keyboard: true });

      /* Leaflet rebuilds the icon element whenever the marker is re-added
         (clustering, reset), so names and state are applied on every add. */
      marker.on('add', function () { decorateMarker(idx); });
      marker.on('mouseover', function () { if (canHover()) showPreview(idx); });
      marker.on('mouseout', function () { hidePreview(); });
      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        showDetail(idx);
      });
      marker.on('keydown', function (e) {
        var k = e.originalEvent && e.originalEvent.key;
        if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          L.DomEvent.preventDefault(e.originalEvent);
          showDetail(idx);
        }
      });

      markerByPin[idx] = marker;
      idxByKey[pinKey(pin, idx)] = idx;
      markers.push(marker);
      markerPins.push(idx);
      marker.addTo(map);
    });
  }

  function decorateMarker(idx) {
    var m = markerByPin[idx], el = m && m.getElement();
    if (!el) return;
    var pin = pins[idx];
    el.setAttribute('aria-label', accessibleName(pin));
    el.setAttribute('data-pin', pinKey(pin, idx));
    if (el.classList) el.classList.toggle('is-active', activeDetail === idx);
  }

  function setMarkerActive(idx, on) {
    var m = markerByPin[idx], el = m && m.getElement();
    if (el && el.classList) el.classList.toggle('is-active', !!on);
  }

  function markerIdx(el) {
    if (!el || !el.getAttribute || !el.classList || !el.classList.contains('map-marker')) return null;
    var key = el.getAttribute('data-pin');
    return key && Object.prototype.hasOwnProperty.call(idxByKey, key) ? idxByKey[key] : null;
  }

  /* Focus a marker, or the cluster that currently holds it, or the map */
  function focusMarker(marker) {
    var target = marker && marker.getElement && marker.getElement();
    if (!target && marker && clusterGroup) {
      var parent = clusterGroup.getVisibleParent(marker);
      target = parent && parent.getElement && parent.getElement();
    }
    focusEl(target && document.body.contains(target) ? target : mapEl);
  }

  /* Run `move`, then focus `marker` once the map and any re-clustering have
     settled. Listeners are armed only after the move has started: starting
     a fly stops any running pan, and that fires a stale moveend. */
  function moveThenFocus(marker, move) {
    var group = clusterGroup, done = false;
    function finish() {
      if (done) return;
      done = true;
      map.off('moveend', onEnd);
      if (group) group.off('animationend spiderfied', settle);
      focusMarker(marker);
    }
    function settle() { if (!moving) finish(); }
    function onEnd() { setTimeout(settle, clusterGroup && !reducedMotion() ? 350 : 0); }
    move();
    if (!marker) return;
    if (!moving) { setTimeout(finish, 0); return; }   /* instant move: already done */
    map.on('moveend', onEnd);
    if (group) group.on('animationend spiderfied', settle);
    setTimeout(finish, 2500);
  }

  function firstInOrder(list) {
    var best = null, bestPos = Infinity;
    list.forEach(function (m) {
      for (var idx in markerByPin) {
        if (markerByPin[idx] === m) {
          var pos = order.indexOf(+idx);
          if (pos < bestPos) { bestPos = pos; best = m; }
        }
      }
    });
    return best;
  }

  /* ── Stacks: pins on one spot at the overview ───────────────────── */

  function attr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /* Screen offset [dx, dy] of each marker (index into `markers`) that has to
     move at `zoom` so no two pins overlap: pairs closer than SPREAD_GAP are
     pushed apart along the line between them, half each (the research base
     stays put, its neighbor moves the whole way), until none overlaps.
     Pins move only as far as they must, so each stays by its place;
     coincident pins part in a fixed direction, so the layout is the same on
     every load. */
  function spreadOffsets(zoom) {
    var n = markers.length, pts = [], orig = [], fixed = [], it, i, j;
    markers.forEach(function (m, k) {
      var q = map.project(m.getLatLng(), zoom);
      pts.push([q.x, q.y]); orig.push([q.x, q.y]);
      fixed.push(pins[markerPins[k]].type === 'home');
    });
    for (it = 0; it < 300; it++) {
      var moved = false;
      for (i = 0; i < n; i++) {
        for (j = i + 1; j < n; j++) {
          var dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d >= SPREAD_GAP - 0.01 || (fixed[i] && fixed[j])) continue;
          if (d < 0.01) { var a = j * 2.399963; dx = Math.cos(a); dy = Math.sin(a); d = 0; }
          else { dx /= d; dy /= d; }
          var push = SPREAD_GAP - d;
          var wi = fixed[i] ? 0 : (fixed[j] ? 1 : 0.5), wj = fixed[j] ? 0 : (fixed[i] ? 1 : 0.5);
          pts[i][0] -= dx * push * wi; pts[i][1] -= dy * push * wi;
          pts[j][0] += dx * push * wj; pts[j][1] += dy * push * wj;
          moved = true;
        }
      }
      if (!moved) break;
    }
    var off = {};
    pts.forEach(function (q, k) {
      var ox = Math.round(q[0] - orig[k][0]), oy = Math.round(q[1] - orig[k][1]);
      if (ox || oy) off[k] = [ox, oy];
    });
    return off;
  }

  /* At the overview (not clustered, below CLUSTER_FROM_ZOOM) pins that
     would hide each other are pushed apart, each that moved visibly with a
     hairline to where it really is, so every pin shows and can be chosen;
     from CLUSTER_FROM_ZOOM the clusters take over. Rebuilt only when it
     changes. */
  function updateSpread() {
    if (!map) return;
    var zoom = map.getZoom();
    var off = clusterGroup || zoom >= CLUSTER_FROM_ZOOM ? {} : spreadOffsets(zoom);
    var key = Object.keys(off).map(function (k) { return k + ':' + off[k].join(','); }).join(' ');
    if (key) key = zoom + '|' + key;
    if (key === spreadKey) return;
    spreadKey = key;
    leaders.forEach(function (l) { map.removeLayer(l); });
    leaders = [];
    markers.forEach(function (m, k) {
      var o = off[k] || [0, 0], cur = m._kyOff || [0, 0];
      if (o[0] !== cur[0] || o[1] !== cur[1]) {
        var hadFocus = m.getElement() && m.getElement() === document.activeElement;
        m._kyOff = off[k] ? o : null;
        m.setIcon(markerIcon(markerPins[k], o[0], o[1]));
        decorateMarker(markerPins[k]);
        if (hadFocus && m.getElement()) m.getElement().focus();
      }
      if (off[k] && Math.abs(o[0]) + Math.abs(o[1]) > LEADER_PX) {
        var at = m.getLatLng();
        var shown = map.unproject(map.project(at, zoom).add(L.point(o[0], o[1])), zoom);
        leaders.push(L.polyline([at, shown], {
          className: 'map-leader', color: 'currentColor', weight: 1, opacity: 0.6, interactive: false
        }).addTo(map));
      }
    });
    queueOrder();
  }

  /* Where a marker's icon is drawn, in container pixels (its place plus its
     fan-out offset) */
  function markerPoint(m) {
    var pt = map.latLngToContainerPoint(m.getLatLng());
    return m._kyOff ? pt.add(L.point(m._kyOff[0], m._kyOff[1])) : pt;
  }

  /* ── Tab order ──────────────────────────────────────────────────── */

  /* The marker pane in time order, so Tab follows time: each pin at its
     place in `order`, a cluster just before its earliest pin. Leaflet
     appends icons, and markercluster adds and removes them as it clusters
     and fans out; z-index sets their stacking, so moving them changes the
     order only. The focused icon itself is never moved. */
  function queueOrder() {
    clearTimeout(orderTimer);
    orderTimer = setTimeout(orderPane, 0);
  }

  function orderPane() {
    var pane = map && map.getPane('markerPane');
    if (!pane) return;
    /* not while Leaflet or markercluster animates: the end queues it again */
    if (map._animatingZoom || /\bleaflet-cluster-anim\b/.test(map.getPane('mapPane').className)) return;
    var els = Array.prototype.slice.call(pane.children);
    var at = new Map(), rank = new Map();
    els.forEach(function (el, i) { at.set(el, i); });
    function put(layer, r) {
      var el = layer.getElement && layer.getElement();
      if (el && at.has(el)) rank.set(el, r);
    }
    markers.forEach(put);
    if (clusterGroup && clusterGroup._featureGroup) {
      clusterGroup._featureGroup.eachLayer(function (layer) {
        if (!layer.getAllChildMarkers) return;
        var first = Infinity;
        layer.getAllChildMarkers().forEach(function (m) {
          var k = markers.indexOf(m);
          if (k >= 0 && k < first) first = k;
        });
        put(layer, first - 0.5);
      });
    }
    var want = els.slice().sort(function (a, b) {
      var ra = rank.has(a) ? rank.get(a) : Infinity, rb = rank.has(b) ? rank.get(b) : Infinity;
      return ra - rb || at.get(a) - at.get(b);
    });
    if (want.every(function (el, i) { return el === els[i]; })) return;
    var fi = want.indexOf(document.activeElement), i;
    if (fi < 0) {
      want.forEach(function (el) { pane.appendChild(el); });
      return;
    }
    for (i = 0; i < fi; i++) pane.insertBefore(want[i], want[fi]);
    for (i = fi + 1; i < want.length; i++) pane.appendChild(want[i]);
  }

  /* ── Arcs ───────────────────────────────────────────────────────── */

  function buildArcs() {
    arcs.forEach(function (a) { map.removeLayer(a.line); });
    arcs = [];
    arcModeInUse = arcMode();

    var base = null;
    pins.forEach(function (p) { if (!base && p.type === 'home') base = p; });
    if (!base || typeof base.lat !== 'number' || typeof base.lng !== 'number') return;
    var from = [base.lat, base.lng];

    order.forEach(function (idx) {
      var pin = pins[idx];
      if (pin.type === 'home' || typeof pin.lat !== 'number' || typeof pin.lng !== 'number') return;
      var to = [pin.lat, pin.lng];
      if (haversine(from, to) < 0.5) return;   /* at the base itself: nothing to draw */

      var points = arcModeInUse === 'straight' ? [from, to] : generateCurve(from, to, ARC_POINTS);
      /* Style comes from CSS (.map-arc); these attributes are only the
         unstyled fallback, and CSS overrides presentation attributes. */
      var line = L.polyline(points, {
        className: 'map-arc map-arc--' + token(pin.type),
        color: 'currentColor',
        weight: 1,
        opacity: 0.5,
        interactive: false
      }).addTo(map);
      var path = line.getElement();
      if (path) path.setAttribute('data-pin', pinKey(pin, idx));
      arcs.push({ line: line, pinIdx: idx });
    });

    if (activeDetail !== null) highlightArc(activeDetail);
  }

  function highlightArc(pinIdx) {
    arcs.forEach(function (a) {
      if (a.pinIdx !== pinIdx) return;
      var el = a.line.getElement();
      if (el) L.DomUtil.addClass(el, 'is-active');
      a.line.bringToFront();
    });
  }

  function resetArcs() {
    arcs.forEach(function (a) {
      var el = a.line.getElement();
      if (el) L.DomUtil.removeClass(el, 'is-active');
    });
  }

  /* ── Hover preview ──────────────────────────────────────────────── */

  function showPreview(idx) {
    if (isMobile() || !preview || !map) return;
    var pin = pins[idx], marker = markerByPin[idx];
    if (!pin || !marker) return;

    mpType.textContent = LABELS[pin.type] || pin.type;
    mpType.className = 'map-preview__type map-preview__type--' + token(pin.type);
    mpLabel.textContent = pin.label || '';
    mpSummary.textContent = [placeText(pin), pin.year].filter(Boolean).join(', ');
    if (mpPhoto) {
      mpPhoto.hidden = !pin.image;
      mpPhoto.style.display = pin.image ? '' : 'none';
    }

    preview.hidden = false;

    /* Position next to the pin, inside the map */
    var pt = markerPoint(marker);
    var left = pt.x + 16;
    var top = pt.y - 10;
    var pw = preview.offsetWidth || 200;
    var ph = preview.offsetHeight || 80;
    if (left + pw + 8 > mapEl.offsetWidth) left = pt.x - pw - 16;
    if (top + ph + 8 > mapEl.offsetHeight) top = mapEl.offsetHeight - ph - 8;
    if (top < 8) top = 8;
    preview.style.left = (left + mapEl.offsetLeft) + 'px';
    preview.style.top = (top + mapEl.offsetTop) + 'px';

    resetArcs();
    highlightArc(idx);
    if (activeDetail !== null) highlightArc(activeDetail);
  }

  function hidePreview() {
    if (preview) preview.hidden = true;
    /* Reset all arcs; if a detail panel is open, restore the active pin's highlight. */
    resetArcs();
    if (activeDetail !== null) highlightArc(activeDetail);
  }

  /* ── Detail panel ───────────────────────────────────────────────── */

  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }

  function doiHref(doi) {
    doi = String(doi);
    return /^https?:/.test(doi) ? doi : 'https://doi.org/' + doi;
  }

  function addAction(href, text, external) {
    var a = document.createElement('a');
    a.href = href;
    a.className = 'map-detail__link';
    a.textContent = text;
    if (external) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    mdActions.appendChild(a);
  }

  function showDetail(idx) {
    var pin = pins[idx];
    if (!detail || !pin) return;

    var prev = activeDetail;
    activeDetail = idx;
    if (prev !== null && prev !== idx) setMarkerActive(prev, false);
    setMarkerActive(idx, true);
    if (preview) preview.hidden = true;
    resetArcs();
    highlightArc(idx);

    /* Populate */
    mdType.textContent = LABELS[pin.type] || pin.type;
    mdType.className = 'map-detail__badge map-detail__badge--' + token(pin.type);
    mdYear.textContent = pin.year || '';
    mdLabel.textContent = pin.label || '';

    mdLocation.textContent = '';
    if (pin.city) {
      var city = document.createElement('span');
      city.textContent = pin.city;
      if (isTurkish(pin)) city.lang = 'tr';
      mdLocation.appendChild(city);
    }
    if (pin.country) mdLocation.appendChild(document.createTextNode((pin.city ? ', ' : '') + pin.country));
    show(mdLocation, pin.city || pin.country);

    mdVenue.textContent = pin.venue || '';
    show(mdVenue, pin.venue);

    mdPaper.textContent = pin.paper_title ? '“' + pin.paper_title + '”' : '';
    show(mdPaper, pin.paper_title);

    var desc = String(pin.description || '').trim();
    mdDesc.textContent = desc;
    show(mdDesc, desc);

    /* Image: root-relative path, natural aspect ratio, alt from image_alt */
    if (mdImage) {
      if (pin.image) {
        var src = String(pin.image);
        if (src.charAt(0) !== '/' && src.indexOf('http') !== 0) src = '/' + src;
        mdImage.alt = pin.image_alt || pin.label || '';
        mdImage.src = src;
        mdImage.hidden = false;
        show(mdImage, true);
      } else {
        mdImage.hidden = true;
        show(mdImage, false);
        mdImage.removeAttribute('src');
        mdImage.alt = '';
      }
    }

    /* Tags */
    mdTags.textContent = '';
    if (pin.tags && pin.tags.length) {
      pin.tags.forEach(function (tag) {
        var span = document.createElement('span');
        span.className = 'map-detail__tag';
        span.textContent = tag;
        mdTags.appendChild(span);
      });
    }

    /* Actions: text links. `papers` ({doi, label} each) gives one link per
       paper under its label; otherwise paper_doi gives "View paper". */
    mdActions.textContent = '';
    var papers = Array.isArray(pin.papers) ? pin.papers.filter(function (p) { return p && p.doi; }) : [];
    if (papers.length) {
      papers.forEach(function (p) { addAction(doiHref(p.doi), p.label ? String(p.label) : 'View paper', true); });
    } else if (pin.paper_doi) {
      addAction(doiHref(pin.paper_doi), 'View paper', true);
    }
    if (pin.news) {
      var newsUrl = mapEl.getAttribute('data-news-url') || '/news/';
      addAction(newsUrl + '#' + encodeURIComponent(pin.news), 'Read the news entry', false);
    }
    if (pin.link) addAction(pin.link, 'Visit site', true);

    /* Show panel, then move focus to its heading */
    clearTimeout(hideTimer);
    detail.hidden = false;
    detail.removeAttribute('inert');
    detail.offsetHeight;   // a reflow, so the panel's entrance transition runs from its hidden state
    detail.setAttribute('data-visible', 'true');
    mdLabel.setAttribute('tabindex', '-1');
    focusEl(mdLabel);
    keepClear(idx);
    emit('kymap:open', { id: pinKey(pin, idx) });
  }

  /* A pin under its own open panel is panned clear of the panel's edge:
     sideways for a side panel, up for a bottom sheet (layout boxes, so the
     panel's entrance transform does not count) */
  function keepClear(idx) {
    if (moving) {                   /* e.g. Leaflet's pan to a focused pin: measure where it ends */
      map.once('moveend', function () { if (activeDetail === idx) keepClear(idx); });
      return;
    }
    var m = markerByPin[idx];
    if (!m || !m.getElement() || !detail.offsetParent || map._animatingZoom) return;
    var size = map.getSize();
    var l = detail.offsetLeft - mapEl.offsetLeft, t = detail.offsetTop - mapEl.offsetTop;
    var r = l + detail.offsetWidth, b = t + detail.offsetHeight;
    var pt = markerPoint(m), edge = 16;
    if (pt.x < l - edge || pt.x > r + edge || pt.y < t - edge || pt.y > b + edge) return;
    var to = L.point(pt.x, pt.y);
    if (l <= 1 && r >= size.x - 1 && t > 0 && b >= size.y - 1) {
      to.y = t - Math.min(PANEL_CLEAR_PX, t / 2);
    } else if (r >= size.x - 1 && l > 0 && t <= 1 && b >= size.y - 1) {
      to.x = l - Math.min(PANEL_CLEAR_PX, l / 2);
    } else if (l <= 1 && r < size.x && t <= 1 && b >= size.y - 1) {
      to.x = r + Math.min(PANEL_CLEAR_PX, (size.x - r) / 2);
    } else {
      return;
    }
    map.panBy(pt.subtract(to), { animate: !reducedMotion() });
  }

  function hideDetail() {
    if (!detail || activeDetail === null) return;
    var idx = activeDetail;
    var restore = detail.contains(document.activeElement);
    activeDetail = null;
    setMarkerActive(idx, false);
    resetArcs();

    /* Focus goes back to the pin, but only if it was inside the panel */
    if (restore) focusMarker(markerByPin[idx]);

    detail.setAttribute('data-visible', 'false');
    detail.setAttribute('inert', '');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (detail.getAttribute('data-visible') !== 'true') detail.hidden = true;
    }, transitionMs(detail));
    emit('kymap:close', { id: pinKey(pins[idx], idx) });
  }

  /* Shown on every plain wheel over the map while it is not active, for 2 s
     after the last one */
  function showHint() {
    if (!hintEl) return;
    hintEl.classList.add('map-hint--visible');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 2000);
  }

  function hideHint() {
    clearTimeout(hintTimer);
    if (hintEl) hintEl.classList.remove('map-hint--visible');
  }

  /* ── View changes ───────────────────────────────────────────────── */

  function moveToBounds(bounds, opts) {
    if (reducedMotion()) map.fitBounds(bounds, L.extend({ animate: false }, opts));
    else map.flyToBounds(bounds, L.extend({ duration: flyDuration() }, opts));
  }

  function resetView() {
    /* Dismantle cluster group so pristine pin+arc view is restored */
    if (clusterGroup) {
      map.removeLayer(clusterGroup);
      clusterGroup = null;
      markers.forEach(function (marker) { marker.addTo(map); });
      updateSpread();               /* now if already at the overview, else at zoomend */
      queueOrder();
    }
    if (activeDetail !== null) hideDetail();
    resetArcs();
    var view = initialView();
    if (reducedMotion()) map.setView(view.center, view.zoom, { animate: false });
    else map.flyTo(view.center, view.zoom, { duration: flyDuration() });
  }

  /* ── Clustering: activated on the first zoom past the overview ──── */

  function enableClustering() {
    if (clusterGroup || typeof L.markerClusterGroup === 'undefined') return;

    clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: false,   /* handled below */
      animate: !reducedMotion(),
      iconCreateFunction: function (cluster) {
        var n = cluster.getChildCount();
        var verb = spiderfies(cluster) ? 'Show ' : 'Zoom to ';
        return L.divIcon({
          html: '<div class="map-cluster"><span role="img" aria-label="' + verb + n +
                ' places">' + n + '</span></div>',
          className: 'map-cluster-icon',
          iconSize: L.point(36, 36),
          iconAnchor: L.point(18, 18)
        });
      }
    });

    /* Zoom 3 levels past current: enough to split the cluster, without
       overshooting. From the keyboard, focus then lands on its first place.
       A cluster that no zoom can split (places closer than the cluster
       radius at MAX_ZOOM) is fanned out by markercluster instead; moving the
       map would fold it again at zoomend, so the map stays put. */
    clusterGroup.on('clusterclick', function (e) {
      var oe = e.originalEvent;
      if (oe) L.DomEvent.stop(oe);
      var first = oe && oe.type === 'keydown' ? firstInOrder(e.layer.getAllChildMarkers()) : null;
      if (spiderfies(e.layer)) {
        if (first) setTimeout(function () { focusMarker(first); }, 0);
        return;
      }
      var bounds = e.layer.getBounds();
      moveThenFocus(first, function () {
        moveToBounds(bounds, { padding: [60, 60], maxZoom: map.getZoom() + 3 });
      });
    });

    /* Enter or Space on a focused cluster behaves like a click */
    clusterGroup.on('clusterkeydown', function (e) {
      var k = e.originalEvent && e.originalEvent.key;
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        L.DomEvent.preventDefault(e.originalEvent);
        e.layer.fire('click', { originalEvent: e.originalEvent }, true);
      }
    });

    clusterGroup.on('animationend spiderfied unspiderfied', queueOrder);

    var focused = markerIdx(document.activeElement);

    markers.forEach(function (marker) {
      map.removeLayer(marker);
      clusterGroup.addLayer(marker);
    });

    clusterGroup.addTo(map);
    updateSpread();
    queueOrder();
    /* Keep keyboard focus, but never pan the map to reach an off-screen pin */
    if (focused !== null) {
      var fm = markerByPin[focused];
      if (map.getBounds().contains(fm.getLatLng())) focusMarker(fm);
      else focusEl(mapEl);
    }
  }

  /* markercluster's own test (_zoomOrSpiderfy, spiderfyOnMaxZoom): the
     cluster holds the same places down to the deepest zoom level */
  function spiderfies(cluster) {
    var bottom = cluster;
    while (bottom._childClusters && bottom._childClusters.length === 1) bottom = bottom._childClusters[0];
    return !!clusterGroup && bottom._zoom === clusterGroup._maxZoom && bottom._childCount === cluster._childCount;
  }

  /* ── Off-screen indicators ──────────────────────────────────────── */

  function getOffscreenDir(center, latlng) {
    var dy = latlng.lat - center.lat;
    var dx = latlng.lng - center.lng;
    var angle = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    return OSI_DEFS[Math.round(angle / 45) % 8];
  }

  function updateOffscreenIndicators() {
    if (!offscreenWrap) return;
    var active = document.activeElement;
    var focusedDir = offscreenWrap.contains(active) ? active.getAttribute('data-dir') : null;
    offscreenWrap.innerHTML = '';

    var bounds = map.getBounds();
    var center = map.getCenter();
    var groups = {}, defs = {};

    markers.forEach(function (marker) {
      var ll = marker.getLatLng();
      if (!bounds.contains(ll)) {
        var def = getOffscreenDir(center, ll);
        if (!groups[def.key]) { groups[def.key] = []; defs[def.key] = def; }
        groups[def.key].push(marker);
      }
    });

    var refocus = null;
    Object.keys(groups).forEach(function (key) {
      var group = groups[key], def = defs[key], n = group.length;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-osi map-osi--' + key;
      btn.setAttribute('data-dir', key);
      btn.setAttribute('aria-label', 'Show ' + n + (n > 1 ? ' places' : ' place') + ' off screen to the ' + def.name);
      btn.innerHTML = '<span aria-hidden="true">' + def.arrow + '</span> <span>' + n + '</span>';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var first = document.activeElement === btn ? firstInOrder(group) : null;
        var bounds = L.latLngBounds(group.map(function (m) { return m.getLatLng(); }));
        moveThenFocus(first, function () {
          moveToBounds(bounds, { padding: [60, 60], maxZoom: 6 });
        });
      });
      offscreenWrap.appendChild(btn);
      if (key === focusedDir) refocus = btn;
    });

    if (focusedDir) focusEl(refocus || mapEl);
  }

  function initOffscreenIndicators() {
    offscreenWrap = document.createElement('div');
    offscreenWrap.className = 'map-offscreen-wrap';
    mapEl.appendChild(offscreenWrap);
    map.on('moveend zoomend', updateOffscreenIndicators);
    updateOffscreenIndicators();
  }

  /* ── Bootstrap ──────────────────────────────────────────────────── */

  /* With map-loader.js on the page, the loader decides when to initialize
     (lazily, near the viewport); otherwise initialize at DOM ready. */
  function boot() { if (!window.KYMapLoader) init(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
