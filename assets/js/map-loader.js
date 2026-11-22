/* Research Footprint Map loader (IIFE, ES2017, no dependencies).
   Included by _includes/map.html. When #research-map comes within 400 px of
   the viewport (or the URL targets the map), it injects Leaflet 1.9.4 and
   Leaflet.markercluster 1.5.3 from /assets/vendor/leaflet/ unless the page
   already loaded them, then map.js, then calls window.KYMap.init(). It also
   fetches the 1:110m basemap (data-basemap, {scale} = 110m) at the same
   time, so the land is usually there when the map starts; map.js gets that
   file and the 1:50m one through KYMapLoader.basemap(scale). Everything
   comes from this site. Vendor CSS goes before the site's stylesheets, so
   site rules win ties.
   --------------------------------------------------------------------- */
(function () {
  'use strict';

  var el = document.getElementById('research-map');
  if (!el || window.KYMapLoader) return;

  var base = el.getAttribute('data-vendor') || '/assets/vendor/leaflet/';
  var mapSrc = el.getAttribute('data-map-src') || '/assets/js/map.js';
  var basemapSrc = el.getAttribute('data-basemap');
  var basemapJobs = {};
  var started = false;

  window.KYMapLoader = { start: start, basemap: basemap };

  /* GeoJSON of one basemap scale ('110m' or '50m'), fetched once. The
     caller handles a failure; the map then runs without outlines. */
  function basemap(scale) {
    if (!basemapJobs[scale]) {
      basemapJobs[scale] = !basemapSrc || !window.fetch
        ? Promise.reject(new Error('No basemap source'))
        : fetch(basemapSrc.replace('{scale}', scale), { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) throw new Error('Basemap ' + scale + ': HTTP ' + r.status);
          return r.json();
        });
      basemapJobs[scale].catch(function () {});
    }
    return basemapJobs[scale];
  }

  function hasSheet(name) {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute('href') || '').indexOf(name) !== -1) return true;
    }
    return false;
  }

  /* Resolves when the stylesheet has loaded or failed: a missing stylesheet
     degrades the look but must not stop the map. */
  function addSheet(name) {
    return new Promise(function (resolve) {
      if (hasSheet(name)) { resolve(); return; }
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = base + name;
      link.onload = link.onerror = function () { resolve(); };
      var head = document.head;
      head.insertBefore(link, head.querySelector('link[rel="stylesheet"], style'));
    });
  }

  /* async = false keeps execution in insertion order while downloads run
     in parallel (Leaflet, then map.js; markercluster follows Leaflet). */
  function addScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.body.appendChild(s);
    });
  }

  function fail() {
    if (el.querySelector('.map-fallback')) return;
    var p = document.createElement('p');
    p.className = 'map-fallback';
    p.textContent = 'The map could not load. Every place is in the list below the map.';
    el.appendChild(p);
  }

  function start() {
    if (started) return;
    started = true;
    basemap('110m');
    var jobs = [addSheet('leaflet.css'), addSheet('MarkerCluster.css')];
    var leaflet = window.L ? Promise.resolve() : addScript(base + 'leaflet.js');
    if (!(window.KYMap && window.KYMap.init)) jobs.push(addScript(mapSrc));
    /* markercluster calls L.* as soon as it runs, so it is added once Leaflet
       has loaded (a failed Leaflet would otherwise throw inside it). Without
       markercluster the map still works, only without clusters. */
    jobs.push(leaflet.then(function () {
      if (!window.L.markerClusterGroup) {
        return addScript(base + 'leaflet.markercluster.js').catch(function () {});
      }
    }));
    Promise.all(jobs).then(function () {
      if (!(window.KYMap && window.KYMap.init && window.KYMap.init())) fail();
    }, fail);
  }

  var hash = location.hash;
  if (hash === '#research-footprint' || hash === '#research-map' ||
      !('IntersectionObserver' in window)) {
    start();
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) {
        io.disconnect();
        start();
        return;
      }
    }
  }, { rootMargin: '400px 0px' });
  io.observe(el);
}());
