/* Research Footprint Map — Leaflet-based interactive map
   IIFE, reads window.MAP_PINS injected by map.html Liquid template.
   Uses Leaflet.js with CartoDB Positron tiles.
   --------------------------------------------------------------------- */
(function () {
  'use strict';

  /* ── Configuration ──────────────────────────────────────────────── */

  var HOME = [50.882, 4.700];          /* KU Leuven */
  var INITIAL_CENTER = [48, 10];       /* Europe-ish */
  var INITIAL_ZOOM = 4;
  var MOBILE_ZOOM = 2;
  var MOBILE_BP = 640;

  var TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  var TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  var PIN_COLOR = '#b45309';
  var COLORS = {
    home:          '#be185d',
    education:     '#2563eb',
    publication:   '#059669',
    talk:          '#ca8a04',
    training:      '#0891b2',
    visit:         '#7c3aed',
    data:          '#0284c7',
    award:         '#dc2626'
  };

  var LABELS = {
    home:          'Research Base',
    education:     'Education',
    publication:   'Conference',
    talk:          'Talk / Poster',
    training:      'Training',
    visit:         'Visit',
    data:          'Data source',
    award:         'Recognition'
  };

  /* ── State ──────────────────────────────────────────────────────── */

  var map, markers = [], arcs = [], clusterGroup = null;
  var activeDetail = null;
  var mapActivated = false;
  var hintShown = false;
  var pins = window.MAP_PINS || [];

  /* ── DOM refs ───────────────────────────────────────────────────── */

  var mapEl      = document.getElementById('research-map');
  var preview    = document.getElementById('map-preview');
  var mpType     = document.getElementById('mp-type');
  var mpLabel    = document.getElementById('mp-label');
  var mpSummary  = document.getElementById('mp-summary');
  var mpPhoto    = document.getElementById('mp-photo');
  var detail     = document.getElementById('map-detail');
  var closeBtn   = document.getElementById('map-detail-close');
  var mdType     = document.getElementById('md-type');
  var mdYear     = document.getElementById('md-year');
  var mdLabel    = document.getElementById('md-label');
  var mdLocation = document.getElementById('md-location');
  var mdVenue    = document.getElementById('md-venue');
  var mdPaper    = document.getElementById('md-paper');
  var mdDesc     = document.getElementById('md-desc');
  var mdImage    = document.getElementById('md-image');
  var mdTags     = document.getElementById('md-tags');
  var mdActions  = document.getElementById('md-actions');
  var hintEl     = document.getElementById('map-hint');

  /* ── Utilities ──────────────────────────────────────────────────── */

  function isMobile() { return window.innerWidth < MOBILE_BP; }

  function hexToRgb(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return r + ',' + g + ',' + b;
  }

  /** Haversine distance in km — used for stagger sort */
  function haversine(a, b) {
    var R = 6371;
    var dLat = (b[0] - a[0]) * Math.PI / 180;
    var dLng = (b[1] - a[1]) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  /** Generate curved polyline points approximating a great-circle arc */
  function generateCurve(from, to, n) {
    var points = [];
    var lat1 = from[0] * Math.PI / 180, lng1 = from[1] * Math.PI / 180;
    var lat2 = to[0] * Math.PI / 180,   lng2 = to[1] * Math.PI / 180;

    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var d = Math.acos(
        Math.sin(lat1) * Math.sin(lat2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1)
      );
      /* If points are nearly co-located, straight line */
      if (d < 0.001) {
        points.push([
          from[0] + f * (to[0] - from[0]),
          from[1] + f * (to[1] - from[1])
        ]);
        continue;
      }
      var A = Math.sin((1 - f) * d) / Math.sin(d);
      var B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
      var y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
      var z = A * Math.sin(lat1) + B * Math.sin(lat2);
      points.push([
        Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI,
        Math.atan2(y, x) * 180 / Math.PI
      ]);
    }
    return points;
  }

  /* ── Initialization ─────────────────────────────────────────────── */

  function init() {
    if (!mapEl || typeof L === 'undefined') return;

    var mobile = isMobile();

    map = L.map('research-map', {
      scrollWheelZoom: false,
      zoomControl: false,
      attributionControl: true,
      maxZoom: 12,
      minZoom: 2,
      worldCopyJump: true
    });

    /* Initial view — Europe centred, global context visible */
    map.setView(mobile ? [30, 10] : [28, 10], mobile ? 1 : 2);

    var zoomCtrl = L.control.zoom({ position: mobile ? 'bottomright' : 'topright' });
    zoomCtrl.addTo(map);

    /* Reset-view button — appended to the same bar as +/− */
    var resetBtn = L.DomUtil.create('a', 'leaflet-control-zoom-reset', zoomCtrl.getContainer());
    resetBtn.innerHTML = '⌂';
    resetBtn.href = '#';
    resetBtn.title = 'Reset to overview';
    resetBtn.setAttribute('role', 'button');
    resetBtn.setAttribute('aria-label', 'Reset to overview');
    L.DomEvent.on(resetBtn, 'click', function (e) {
      L.DomEvent.stop(e);
      resetView();
    });

    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTR,
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

    /* Scroll-zoom activation */
    map.on('click', function (e) {
      if (!mapActivated) {
        map.scrollWheelZoom.enable();
        mapActivated = true;
        hideHint();
      }
    });

    /* Show hint on first scroll attempt over map */
    mapEl.addEventListener('wheel', function () {
      if (!mapActivated && !hintShown) {
        hintShown = true;
        if (hintEl) {
          hintEl.classList.add('map-hint--visible');
          setTimeout(function () {
            hintEl.classList.remove('map-hint--visible');
          }, 2000);
        }
      }
    }, { passive: true });

    /* Sort pins by distance from home for staggered animation */
    var sortedPins = pins.map(function (p, i) {
      return { pin: p, idx: i, dist: haversine(HOME, [p.lat, p.lng]) };
    }).sort(function (a, b) { return a.dist - b.dist; });

    /* Build markers and arcs */
    sortedPins.forEach(function (item, order) {
      var pin = item.pin;
      var color = COLORS[pin.type] || COLORS.publication;
      var isHome = pin.type === 'home';
      var size = isHome ? 14 : 10;

      var dotHtml = '<span class="map-marker__dot' +
                    (isHome ? ' map-marker__dot--home' : '') +
                    '" style="' +
                    'width:' + size + 'px;height:' + size + 'px;' +
                    'background:' + color + ';' +
                    'box-shadow: 0 0 0 3px rgba(' + hexToRgb(color) + ',0.18), 0 1px 4px rgba(0,0,0,0.2);' +
                    '"></span>';

      var icon = L.divIcon({
        className: 'map-marker',
        html: dotHtml,
        iconSize: [size + 8, size + 8],
        iconAnchor: [(size + 8) / 2, (size + 8) / 2]
      });

      var marker = L.marker([pin.lat, pin.lng], {
        icon: icon,
        opacity: 0,
        keyboard: true,
        title: pin.label
      });

      /* Stagger fade-in */
      (function (m, delay) {
        setTimeout(function () {
          m.setOpacity(1);
          var el = m.getElement();
          if (el) {
            el.classList.add('map-marker--enter');
          }
        }, delay);
      })(marker, 200 + order * 80);

      /* Hover */
      marker.on('mouseover', function (e) { showPreview(pin, e); });
      marker.on('mouseout', function ()    { hidePreview(); });

      /* Click */
      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        showDetail(pin, item.idx);
      });

      marker.addTo(map);

      markers.push(marker);

      /* Draw arc from home (skip home itself and nearby Belgium pins) */
      if (!isHome && haversine(HOME, [pin.lat, pin.lng]) > 80) {
        var curvePoints = generateCurve(HOME, [pin.lat, pin.lng], 50);
        var arc = L.polyline(curvePoints, {
          color: '#6b8caa',
          weight: 2,
          dashArray: '5 7',
          opacity: 0,
          interactive: false
        }).addTo(map);

        /* Fade arcs in after pins for global-reach effect */
        (function (a, delay) {
          setTimeout(function () {
            a.setStyle({ opacity: 0.6 });
          }, delay + 400);
        })(arc, 200 + order * 80);

        arcs.push({ line: arc, pinIdx: item.idx, color: color });
      }
    });

    /* Close detail on Escape */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideDetail();
    });

    /* Hide hover preview on any map movement so it doesn't get stranded */
    map.on('movestart zoomstart', function () { hidePreview(); });

    /* Enable clustering once the user zooms in past the initial overview */
    map.on('zoomend', function () {
      if (map.getZoom() > 2) enableClustering();
    });

    /* Close detail on map click (if no marker was clicked) */
    map.on('click', function () {
      if (activeDetail !== null) hideDetail();
    });

    initOffscreenIndicators();
  }

  /* ── Hover preview ──────────────────────────────────────────────── */

  function showPreview(pin, event) {
    if (isMobile() || !preview) return;

    var label = LABELS[pin.type] || pin.type;
    mpType.textContent = label;
    mpType.style.color = COLORS[pin.type] || COLORS.publication;
    mpLabel.textContent = pin.label;

    var summary = '';
    if (pin.city && pin.country) summary = pin.city + ', ' + pin.country;
    else if (pin.city) summary = pin.city;
    if (pin.year) summary += (summary ? ' · ' : '') + pin.year;
    mpSummary.textContent = summary;
    if (mpPhoto) mpPhoto.hidden = !pin.image;

    preview.hidden = false;

    /* Position near cursor */
    var mapRect = mapEl.getBoundingClientRect();
    var pt = event.containerPoint || map.latLngToContainerPoint(event.latlng);
    var left = pt.x + 16;
    var top = pt.y - 10;

    /* Keep within map bounds */
    var pw = preview.offsetWidth || 200;
    var ph = preview.offsetHeight || 80;
    if (left + pw + 8 > mapEl.offsetWidth) left = pt.x - pw - 16;
    if (top + ph + 8 > mapEl.offsetHeight) top = mapEl.offsetHeight - ph - 8;
    if (top < 8) top = 8;

    preview.style.left = left + 'px';
    preview.style.top = top + 'px';

    /* Highlight corresponding arc */
    highlightArc(pins.indexOf(pin), true);
  }

  function hidePreview() {
    if (preview) preview.hidden = true;
    /* Reset all arcs; if a detail panel is open, restore the active pin's highlight. */
    resetArcs();
    if (activeDetail !== null) highlightArc(activeDetail, true);
  }

  /* ── Detail panel ───────────────────────────────────────────────── */

  function showDetail(pin, idx) {
    if (!detail) return;

    activeDetail = idx;
    hidePreview();
    resetArcs();
    highlightArc(idx, true);

    /* Populate */
    var label = LABELS[pin.type] || pin.type;
    mdType.textContent = label;
    mdType.className = 'map-detail__badge map-detail__badge--' + pin.type;
    mdYear.textContent = pin.year || '';
    mdLabel.textContent = pin.label || '';

    var loc = '';
    if (pin.city) loc += pin.city;
    if (pin.country) loc += (loc ? ', ' : '') + pin.country;
    mdLocation.textContent = loc;
    mdLocation.style.display = loc ? '' : 'none';

    mdVenue.textContent = pin.venue || '';
    mdVenue.style.display = pin.venue ? '' : 'none';

    if (pin.paper_title) {
      mdPaper.textContent = '"' + pin.paper_title + '"';
      mdPaper.style.display = '';
    } else {
      mdPaper.style.display = 'none';
    }

    var desc = (pin.description || '').trim();
    mdDesc.textContent = desc;
    mdDesc.style.display = desc ? '' : 'none';

    /* Image — ensure root-relative path */
    if (pin.image && mdImage) {
      var imgSrc = pin.image;
      if (imgSrc.charAt(0) !== '/' && imgSrc.indexOf('http') !== 0) {
        imgSrc = '/' + imgSrc;
      }
      mdImage.src = imgSrc;
      mdImage.alt = pin.label || '';
      mdImage.hidden = false;
    } else if (mdImage) {
      mdImage.hidden = true;
      mdImage.src = '';
    }

    /* Tags */
    mdTags.innerHTML = '';
    if (pin.tags && pin.tags.length) {
      pin.tags.forEach(function (tag) {
        var span = document.createElement('span');
        span.className = 'map-detail__tag';
        span.textContent = tag;
        mdTags.appendChild(span);
      });
    }

    /* Actions */
    mdActions.innerHTML = '';
    if (pin.paper_doi) {
      var a = document.createElement('a');
      a.href = 'https://doi.org/' + pin.paper_doi;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'btn btn--secondary btn--sm';
      a.textContent = 'View paper';
      mdActions.appendChild(a);
    }
    if (pin.link) {
      var a2 = document.createElement('a');
      a2.href = pin.link;
      a2.target = '_blank';
      a2.rel = 'noopener noreferrer';
      a2.className = 'btn btn--ghost btn--sm';
      a2.textContent = 'Visit site';
      mdActions.appendChild(a2);
    }

    /* Show panel */
    detail.hidden = false;
    /* Force reflow, then animate */
    detail.offsetHeight; // eslint-disable-line no-unused-expressions
    detail.setAttribute('data-visible', 'true');
  }

  function hideDetail() {
    if (!detail) return;
    activeDetail = null;
    detail.setAttribute('data-visible', 'false');

    /* Wait for transition, then hide */
    setTimeout(function () {
      if (detail.getAttribute('data-visible') === 'false') {
        detail.hidden = true;
      }
    }, 280);

    resetArcs();
  }

  function hideHint() {
    if (hintEl) hintEl.classList.remove('map-hint--visible');
  }

  /* ── Arc highlighting ───────────────────────────────────────────── */

  function highlightArc(pinIdx, highlight) {
    arcs.forEach(function (a) {
      if (a.pinIdx === pinIdx && highlight) {
        a.line.setStyle({
          color: a.color,
          weight: 3,
          dashArray: null,
          opacity: 0.8
        });
        a.line.bringToFront();
      }
    });
  }

  function resetArcs() {
    arcs.forEach(function (a) {
      a.line.setStyle({
        color: '#6b8caa',
        weight: 2,
        dashArray: '5 7',
        opacity: 0.55
      });
    });
  }

  /* ── View reset ─────────────────────────────────────────────────── */

  function resetView() {
    /* Dismantle cluster group so pristine pin+arc view is restored */
    if (clusterGroup) {
      map.removeLayer(clusterGroup);
      markers.forEach(function (marker) { marker.addTo(map); });
      clusterGroup = null;
    }
    if (activeDetail !== null) hideDetail();
    resetArcs();
    map.setView(isMobile() ? [30, 10] : [28, 10], isMobile() ? 1 : 2);
  }

  /* ── Clustering — activated on first map click ──────────────────── */

  function enableClustering() {
    if (clusterGroup || typeof L.markerClusterGroup === 'undefined') return;

    clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: false,   /* handled manually for smooth fly */
      iconCreateFunction: function (cluster) {
        return L.divIcon({
          html: '<div class="map-cluster"><span>' + cluster.getChildCount() + '</span></div>',
          className: 'map-cluster-icon',
          iconSize: L.point(36, 36),
          iconAnchor: L.point(18, 18)
        });
      }
    });

    /* Zoom 3 levels past current — enough to split the cluster, won't overshoot to street level */
    clusterGroup.on('clusterclick', function (e) {
      L.DomEvent.stop(e.originalEvent);
      map.flyToBounds(e.layer.getBounds(), {
        padding:  [60, 60],
        animate:  true,
        duration: 0.7,
        maxZoom:  map.getZoom() + 3
      });
    });

    markers.forEach(function (marker) {
      map.removeLayer(marker);
      clusterGroup.addLayer(marker);
    });

    clusterGroup.addTo(map);
  }

  /* ── Off-screen indicators ──────────────────────────────────────── */

  var offscreenWrap = null;

  var OSI_DEFS = [
    { key: 'n',  arrow: '↑', cls: 'map-osi--n'  },
    { key: 'ne', arrow: '↗', cls: 'map-osi--ne' },
    { key: 'e',  arrow: '→', cls: 'map-osi--e'  },
    { key: 'se', arrow: '↘', cls: 'map-osi--se' },
    { key: 's',  arrow: '↓', cls: 'map-osi--s'  },
    { key: 'sw', arrow: '↙', cls: 'map-osi--sw' },
    { key: 'w',  arrow: '←', cls: 'map-osi--w'  },
    { key: 'nw', arrow: '↖', cls: 'map-osi--nw' }
  ];

  function getOsiDef(key) {
    for (var i = 0; i < OSI_DEFS.length; i++) {
      if (OSI_DEFS[i].key === key) return OSI_DEFS[i];
    }
    return OSI_DEFS[0];
  }

  function getOffscreenDir(center, latlng) {
    var dy = latlng.lat - center.lat;
    var dx = latlng.lng - center.lng;
    var angle = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    if (angle >= 337.5 || angle < 22.5)  return 'n';
    if (angle < 67.5)  return 'ne';
    if (angle < 112.5) return 'e';
    if (angle < 157.5) return 'se';
    if (angle < 202.5) return 's';
    if (angle < 247.5) return 'sw';
    if (angle < 292.5) return 'w';
    return 'nw';
  }

  function updateOffscreenIndicators() {
    if (!offscreenWrap) return;
    offscreenWrap.innerHTML = '';

    var bounds = map.getBounds();
    var center = map.getCenter();
    var groups = {};

    markers.forEach(function (marker) {
      var ll = marker.getLatLng();
      if (!bounds.contains(ll)) {
        var dir = getOffscreenDir(center, ll);
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push(ll);
      }
    });

    var dirs = Object.keys(groups);
    dirs.forEach(function (dir) {
      var group = groups[dir];
      var def = getOsiDef(dir);
      var btn = document.createElement('button');
      btn.className = 'map-osi ' + def.cls;
      btn.setAttribute('aria-label', group.length + ' pin' + (group.length > 1 ? 's' : '') + ' off screen');
      btn.innerHTML = def.arrow + ' <span>' + group.length + '</span>';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var lb = L.latLngBounds(group);
        map.flyToBounds(lb, { padding: [60, 60], maxZoom: 6 });
      });
      offscreenWrap.appendChild(btn);
    });
  }

  function initOffscreenIndicators() {
    offscreenWrap = document.createElement('div');
    offscreenWrap.className = 'map-offscreen-wrap';
    mapEl.appendChild(offscreenWrap);
    map.on('moveend zoomend', updateOffscreenIndicators);
    updateOffscreenIndicators();
  }

  /* ── Bootstrap ──────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Close button — document delegation bypasses all Leaflet/bubbling issues.
     hideDetail is a function declaration so it is hoisted and safe to call here. */
  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'map-detail-close') {
      hideDetail();
    }
  });
}());
