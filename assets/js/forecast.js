/**
 * Forecast Error Uncertainty Explorer — kaanyurtseven.com
 *
 * Two-row linked visualization of Belgian wind/solar generation uncertainty.
 *
 * Top panel    — conditioned empirical forecast error distribution in power space.
 *                X = generation (MW), Y = probability density.
 *                Overlays: moment-matched Gaussian (unbounded), Beta MLE (bounded).
 *
 * Bottom panel — recent 7-day trajectory at 15-min resolution. Hovering it, the
 *                range input or the Earlier / Later / Latest buttons select the
 *                operating point; a click or the Lock button locks it.
 *
 * Conditioning:
 *   Hard rectangular filter: select bins whose center ∈ [f_pu ± bw].
 *   Start bw = COND_BW_START, widen by COND_BW_STEP (at most COND_BW_MAX)
 *   until the selected bins hold at least COND_MIN_N historical samples.
 *
 * Statistics ("Exact statistics" below): quantiles, CVaR, moments and the
 *   Beta fit are computed exactly from the conditioned histogram, with no
 *   sampling, so the same point always shows the same numbers.
 *
 * Data: static JSON written by the GitHub Actions data workflow.
 */

(function () {
  'use strict';

  // Included twice (a page tag and the lazy loader)? Initialize only once.
  if (window.__fxExplorer) return;
  window.__fxExplorer = { version: 2 };

  // ── State ──────────────────────────────────────────────────────────────────
  var state = {
    tech:       'wind',
    forecast:   'dayahead11h',
    showApprox: true,
    tz:         'brussels',   // 'brussels' | 'utc'
    wind:  { offon: 'Offshore', region: 'Federal', grid: 'Elia' },
    solar: { region: 'Belgium' },
    hoveredIdx: -1,
    lockedIdx:  -1
  };

  var cache       = { wind: null, solar: null };
  var statsCache = {};
  var baseUrl = (typeof window !== 'undefined' && window.SITE_BASEURL) ? window.SITE_BASEURL : '';

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var el = {};
  function getEls() {
    el.section      = document.getElementById('forecast-explorer');
    el.panelDist    = document.getElementById('forecast-distribution');
    el.panelTraj    = document.getElementById('forecast-trajectory');
    el.errorOverlay = document.getElementById('forecast-error');
    el.loading      = document.getElementById('forecast-loading');
    el.stats        = document.getElementById('forecast-stats');
    el.statSource   = document.getElementById('stat-source');
    el.windFilters  = document.getElementById('wind-filters');
    el.solarFilters = document.getElementById('solar-filters');
    el.approxToggle = document.getElementById('show-gaussian');
    el.filterOffOn  = document.getElementById('filter-offon');
    el.filterRegion = document.getElementById('filter-region');
    el.filterGrid   = document.getElementById('filter-grid');
    el.filterSolarR = document.getElementById('filter-solar-region');
    el.distLabel    = document.getElementById('dist-point-label');
    el.metricsPanel = document.getElementById('forecast-metrics');
    el.tzBrussels   = document.getElementById('tz-brussels');
    el.tzUtc        = document.getElementById('tz-utc');
    // Metrics value elements
    el.fmTime        = document.getElementById('fm-time');
    el.fmForecast    = document.getElementById('fm-forecast');
    el.fmMeasured    = document.getElementById('fm-measured');
    el.fmCapacity    = document.getElementById('fm-capacity');
    el.fmCvarEmpL    = document.getElementById('fm-cvar-emp-lo');
    el.fmCvarGaussL  = document.getElementById('fm-cvar-gauss-lo');
    el.fmCvarBetaL   = document.getElementById('fm-cvar-beta-lo');
    el.fmCvarEmpH    = document.getElementById('fm-cvar-emp-hi');
    el.fmCvarGaussH  = document.getElementById('fm-cvar-gauss-hi');
    el.fmCvarBetaH   = document.getElementById('fm-cvar-beta-hi');
    // Text alternatives and the keyboard / single-pointer path (all optional)
    el.distSummary   = document.getElementById('fx-dist-summary');
    el.trajSummary   = document.getElementById('fx-traj-summary');
    el.range         = document.getElementById('fc-range');
    el.stepEarlier   = document.getElementById('fc-step-earlier');
    el.stepLater     = document.getElementById('fc-step-later');
    el.stepLatest    = document.getElementById('fc-step-latest');
    el.lockBtn       = document.getElementById('fc-lock');
  }

  // ── Forecast field mapping ─────────────────────────────────────────────────
  var FORECAST_FIELDS = {
    dayahead11h: 'dayahead11hforecast',
    dayahead6pm: 'dayaheadforecast',
    mostrecent:  'mostrecentforecast'
  };

  var FORECAST_LABELS = {
    dayahead11h: 'Day Ahead 11AM',
    dayahead6pm: 'Day Ahead 6PM',
    mostrecent:  'Most Recent'
  };

  // ── Timezone helpers ──────────────────────────────────────────────────────

  var BRUSSELS_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Brussels',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  var BRUSSELS_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Brussels', hour: 'numeric', hour12: false
  });

  // Convert a UTC timestamp string "YYYY-MM-DDTHH:MM" to Brussels local time.
  // Uses Intl.DateTimeFormat so CET/CEST switching is handled automatically.
  function utcToBrussels(tsStr) {
    var d = new Date(tsStr + ':00Z');
    var parts = {};
    BRUSSELS_FMT.formatToParts(d).forEach(function (x) { parts[x.type] = x.value; });
    var h = parseInt(parts.hour, 10) % 24; // guard against Intl "24" for midnight
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + pad(h) + ':' + parts.minute;
  }

  // Brussels UTC offset in hours (+1 CET, +2 CEST) at instant d (default: now).
  function brusselsOffsetHours(d) {
    d = d || new Date();
    var utcH = d.getUTCHours();
    var bH = parseInt(BRUSSELS_HOUR_FMT.format(d), 10) % 24;
    var diff = ((bH - utcH) + 24) % 24;
    return diff > 12 ? diff - 24 : diff; // normalize to ±12
  }

  // Short timezone label for the selected TZ, e.g. "CEST (UTC+2)". Given a UTC
  // timestamp string, the label is the one in force at that instant: the
  // trajectory can span a daylight-saving change.
  function tzShortLabel(utcTsStr) {
    if (state.tz === 'utc') return 'UTC';
    var off = brusselsOffsetHours(utcTsStr ? new Date(utcTsStr + ':00Z') : new Date());
    return off === 2 ? 'CEST (UTC+2)' : 'CET (UTC+1)';
  }

  // Axis title for a series of UTC timestamps.
  function axisTzLabel(ts) {
    if (state.tz === 'utc') return 'UTC';
    if (!ts.length) return tzShortLabel();
    var a = tzShortLabel(ts[0]), b = tzShortLabel(ts[ts.length - 1]);
    return a === b ? a : 'Belgian local time';
  }

  // Convert an array of UTC timestamp strings; return as-is for UTC mode.
  function applyTz(tsArr) {
    if (state.tz === 'utc') return tsArr;
    return tsArr.map(function (ts) { return ts ? utcToBrussels(ts) : ts; });
  }

  // The autumn change repeats an hour of local time. A repeat is drawn 59 s
  // later ("…T02:30:59"; the hover shows minutes), so every point has its own
  // x: Plotly rounds positions to 0.01 px, and on a tie it hovers the later point.
  function uniqueTimes(arr) {
    var seen = {};
    return arr.map(function (s) {
      if (!s) return s;
      if (!seen[s]) { seen[s] = 1; return s; }
      return s + ':' + (60 - seen[s]++);
    });
  }

  // Format a UTC timestamp string for text display with timezone suffix.
  function formatTimeDisplay(utcTsStr) {
    var displayed = state.tz === 'brussels' ? utcToBrussels(utcTsStr) : utcTsStr;
    return displayed.replace('T', ' ').slice(0, 16) + ' ' + tzShortLabel(utcTsStr);
  }

  // ── Wind filter dependency logic ───────────────────────────────────────────
  var WIND_COMBOS = [
    { offon: 'Offshore', region: 'Federal',  grid: 'Elia' },
    { offon: 'Onshore',  region: 'Flanders', grid: 'Elia' },
    { offon: 'Onshore',  region: 'Flanders', grid: 'Dso'  },
    { offon: 'Onshore',  region: 'Wallonia', grid: 'Elia' },
    { offon: 'Onshore',  region: 'Wallonia', grid: 'Dso'  }
  ];

  // Option text for a grid value (the values stay as the data names them).
  var GRID_LABELS = { Elia: 'Elia', Dso: 'DSO' };
  function gridLabel(g) { return GRID_LABELS[g] || g; }

  function validRegions(offon) {
    return WIND_COMBOS
      .filter(function (c) { return c.offon === offon; })
      .map(function (c) { return c.region; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
  }
  function validGrids(offon, region) {
    return WIND_COMBOS
      .filter(function (c) { return c.offon === offon && c.region === region; })
      .map(function (c) { return c.grid; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
  }

  function syncWindFilters() {
    var offon = el.filterOffOn.value;
    var vr    = validRegions(offon);
    el.filterRegion.innerHTML = '';
    vr.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      el.filterRegion.appendChild(opt);
    });
    el.filterRegion.value = (vr.indexOf(state.wind.region) !== -1) ? state.wind.region : vr[0];
    var vg = validGrids(offon, el.filterRegion.value);
    el.filterGrid.innerHTML = '';
    vg.forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g; opt.textContent = gridLabel(g);
      el.filterGrid.appendChild(opt);
    });
    el.filterGrid.value = (vg.indexOf(state.wind.grid) !== -1) ? state.wind.grid : vg[0];
    state.wind.offon  = offon;
    state.wind.region = el.filterRegion.value;
    state.wind.grid   = el.filterGrid.value;
  }

  // ── Data loading ───────────────────────────────────────────────────────────
  function loadData(tech, callback) {
    if (cache[tech]) { callback(cache[tech]); return; }
    showLoading(true);
    // no-cache: the browser checks its copy with the site (a conditional
    // request) instead of reusing it for up to 10 minutes; the data changes
    // every 15 minutes.
    fetch(baseUrl + '/assets/data/' + tech + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { cache[tech] = d; callback(d); })
      .catch(function (e) {
        showLoading(false);
        showError('Could not load the ' + tech + ' data (' + e.message + ').');
        setFxState('error');
      });
  }

  // The overlay is shown and hidden with the hidden attribute.
  function showLoading(on) {
    if (!el.loading) return;
    el.loading.style.display = '';
    el.loading.hidden = !on;
  }
  function showError(msg) {
    if (!el.errorOverlay) return;
    el.errorOverlay.textContent = msg;
    el.errorOverlay.style.display = 'flex';
  }
  function clearError() {
    if (!el.errorOverlay) return;
    el.errorOverlay.style.display = 'none';
    el.errorOverlay.textContent = '';
  }

  // section[data-fx-state] = loading | ready | error, plus a bubbling
  // 'explorer:state' event, so styles and scripts can follow the loading state.
  function setFxState(s) {
    if (!el.section || el.section.getAttribute('data-fx-state') === s) return;
    el.section.setAttribute('data-fx-state', s);
    try {
      el.section.dispatchEvent(new CustomEvent('explorer:state', { bubbles: true, detail: { state: s } }));
    } catch (e) { /* CustomEvent unsupported: the attribute still changed */ }
  }

  // ── Group key ──────────────────────────────────────────────────────────────
  function groupKey() {
    if (state.tech === 'wind') return [state.wind.offon, state.wind.region, state.wind.grid].join('|');
    return state.solar.region;
  }

  // ── Hard rectangular conditioning ──────────────────────────────────────────
  // For hovered forecast f_pu, select bins whose center falls within ±bw.
  // Start bw = COND_BW_START, widen by COND_BW_STEP until totalN ≥ COND_MIN_N
  // or bw reaches COND_BW_MAX.
  // Each selected bin contributes in proportion to its sample count (no kernel weight).

  var COND_BW_START = 0.04;
  var COND_BW_STEP  = 0.02;
  var COND_BW_MAX   = 1.00;
  var COND_MIN_N    = 500;

  // lo/hi are the explicit window bounds in pu space [0, 1].
  function getBinsInWindow(bins, lo, hi) {
    return bins.filter(function (bin) {
      var center = (bin.lo + bin.hi) / 2;
      return center >= lo && center <= hi && bin.n > 0 && bin.hist_counts;
    });
  }

  // ── Exact statistics ───────────────────────────────────────────────────────
  // The conditioned distribution is computed, not sampled. Each conditioning
  // bin stores hist_counts: a meta.hist_n_bins-cell histogram of
  // error_pu = (measured - forecast) / capacity over [meta.hist_min,
  // meta.hist_max]. Every selected bin's histogram is shifted by the hovered
  // forecast f_pu; error cell j of bin b weighs n_b * c_bj / sum_j c_bj and is
  // uniform across its width. The result is clipped to [0, 1] pu
  // (= [0 MW, capacity]): mass beyond a wall becomes an atom at that wall.
  //
  // Every number is computed exactly from that piecewise-uniform-plus-atoms
  // distribution, with no Math.random: the same inputs always give the same
  // numbers. scripts/lib/conditioning.rb implements the same definitions for
  // the build-time figures (_data/figures/offshore_da11.json), and
  // scripts/test_stats_parity.py checks in headless Edge that the two agree.
  // All values are in pu of capacity until conditionedStats() converts them.

  var CVAR_ALPHA = 0.05;
  var CVAR_K     = 2.0627128075074257;   // phi(z_0.95) / 0.05: Gaussian CVaR = mu -/+ CVAR_K * sigma

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Conditioned distribution at forecast f_pu: { atom0, atom1, segs, cond },
  // segs = [[x0, x1, mass], ...] sorted, masses normalized with the atoms.
  function conditionDistribution(bins, meta, f_pu) {
    var bw = COND_BW_START, lo = 0, hi = 1, selected = null, totalN = 0;

    // Asymmetric window: cap at [0, 1] so boundary forecasts widen only inward.
    // Example: f_pu=0.9, bw=0.20 → [0.70, 1.0]; next step → [0.68, 1.0]; etc.
    while (bw <= COND_BW_MAX + 1e-9) {
      lo = Math.max(0, f_pu - bw);
      hi = Math.min(1, f_pu + bw);
      selected = getBinsInWindow(bins, lo, hi);
      totalN   = selected.reduce(function (s, b) { return s + b.n; }, 0);
      if (totalN >= COND_MIN_N) break;
      bw += COND_BW_STEP;
    }
    if (!selected || selected.length === 0) return null;

    // Every selected histogram is shifted by the same forecast, so the cells
    // coincide: add up their weights first.
    var nCells  = meta.hist_n_bins;
    var histMin = meta.hist_min;
    var width   = (meta.hist_max - histMin) / nCells;
    var w = [], j;
    for (j = 0; j < nCells; j++) w.push(0);
    selected.forEach(function (bin) {
      var counts = bin.hist_counts, total = 0, k;
      for (k = 0; k < counts.length; k++) total += counts[k];
      if (total === 0) return;
      for (k = 0; k < nCells; k++) if (counts[k] > 0) w[k] += bin.n * counts[k] / total;
    });

    var atom0 = 0, atom1 = 0, mass = 0, segs = [];
    for (j = 0; j < nCells; j++) {
      if (!(w[j] > 0)) continue;
      var x  = f_pu + (histMin + (j + 0.5) * width);   // cell center, measured pu
      var a  = x - width / 2, b = x + width / 2, cw = b - a;
      var below  = clamp(-a, 0, cw), above = clamp(b - 1, 0, cw);
      var inside = w[j] * (cw - below - above) / cw;
      atom0 += w[j] * below / cw;
      atom1 += w[j] * above / cw;
      var x0 = clamp(a, 0, 1), x1 = clamp(b, 0, 1);
      if (inside > 0 && x1 > x0) segs.push([x0, x1, inside]);
    }
    mass = atom0 + atom1;
    for (j = 0; j < segs.length; j++) mass += segs[j][2];
    if (!(mass > 0)) return null;
    for (j = 0; j < segs.length; j++) segs[j][2] /= mass;

    return {
      atom0: atom0 / mass,
      atom1: atom1 / mass,
      segs:  segs,
      cond: {
        bandwidth: bw,
        fallback:  totalN < COND_MIN_N,
        totalN:    totalN,
        lo: lo, hi: hi,
        binsUsed:  selected.map(function (b) { return { lo: b.lo, hi: b.hi, n: b.n }; })
      }
    };
  }

  function distMean(d) {
    var m = 0;
    for (var i = 0; i < d.segs.length; i++) { var s = d.segs[i]; m += s[2] * (s[0] + s[1]) / 2; }
    return m + d.atom1;
  }

  // Population variance, atoms included.
  function distVariance(d, mu) {
    var v = 0;
    for (var i = 0; i < d.segs.length; i++) {
      var s = d.segs[i], d0 = s[0] - mu, d1 = s[1] - mu;
      v += s[2] * (d0 * d0 + d0 * d1 + d1 * d1) / 3;
    }
    return v + d.atom0 * mu * mu + d.atom1 * (1 - mu) * (1 - mu);
  }

  // Quantile Q(u) = inf { x : F(x) >= u }. An atom holds every quantile in it.
  function distQuantile(d, u) {
    if (d.atom0 > 0 && u <= d.atom0) return 0;
    var c = d.atom0;
    for (var i = 0; i < d.segs.length; i++) {
      var s = d.segs[i];
      if (c + s[2] >= u) return s[0] + (s[1] - s[0]) * clamp((u - c) / s[2], 0, 1);
      c += s[2];
    }
    if (d.atom1 > 0) return 1;
    return d.segs.length ? d.segs[d.segs.length - 1][1] : 0;
  }

  // Lower-tail CVaR (Rockafellar-Uryasev): (1/alpha) * integral_0^alpha Q(u) du,
  // the mean of the lowest alpha of outcomes with atoms split exactly.
  function distLowerTailMean(d, alpha) {
    var rem = alpha - Math.min(d.atom0, alpha);   // the atom at 0 adds 0
    var acc = 0;
    for (var i = 0; i < d.segs.length && rem > 0; i++) {
      var s = d.segs[i];
      if (s[2] <= rem) {
        acc += s[2] * (s[0] + s[1]) / 2;
        rem -= s[2];
      } else {
        var xq = s[0] + (s[1] - s[0]) * rem / s[2];
        acc += rem * (s[0] + xq) / 2;
        rem = 0;
      }
    }
    if (rem > 0) acc += rem;                       // the rest sits in the atom at 1
    return acc / alpha;
  }

  // Upper-tail CVaR: (1/alpha) * integral_{1-alpha}^1 Q(u) du.
  function distUpperTailMean(d, alpha) {
    var take = Math.min(d.atom1, alpha);
    var acc = take, rem = alpha - take;
    for (var i = d.segs.length - 1; i >= 0 && rem > 0; i--) {
      var s = d.segs[i];
      if (s[2] <= rem) {
        acc += s[2] * (s[0] + s[1]) / 2;
        rem -= s[2];
      } else {
        var xq = s[1] - (s[1] - s[0]) * rem / s[2];
        acc += rem * (xq + s[1]) / 2;
        rem = 0;
      }
    }
    return acc / alpha;                            // any rest sits at 0 and adds 0
  }

  // [E ln x~, E ln(1 - x~)], x~ = clip(x, clip, 1 - clip), integrated exactly
  // over every segment: the Beta fit's sufficient statistics.
  function intLog(x)   { return x * Math.log(x) - x; }           // integral of ln x
  function intLog1m(x) { var y = 1 - x; return y - y * Math.log(y); } // integral of ln(1 - x)

  function distLogMoments(d, clip) {
    var lo = clip, hi = 1 - clip, llo = Math.log(lo), lhi = Math.log(hi);
    var e1 = d.atom0 * llo + d.atom1 * lhi;
    var e2 = d.atom0 * lhi + d.atom1 * llo;
    for (var i = 0; i < d.segs.length; i++) {
      var s = d.segs[i], x0 = s[0], x1 = s[1], dens = s[2] / (x1 - x0), a, b;
      b = Math.min(x1, lo);
      if (b > x0) { e1 += dens * (b - x0) * llo; e2 += dens * (b - x0) * lhi; }
      a = Math.max(x0, lo); b = Math.min(x1, hi);
      if (b > a) { e1 += dens * (intLog(b) - intLog(a)); e2 += dens * (intLog1m(b) - intLog1m(a)); }
      a = Math.max(x0, hi);
      if (x1 > a) { e1 += dens * (x1 - a) * lhi; e2 += dens * (x1 - a) * llo; }
    }
    return [e1, e2];
  }

  // Continuous mass inside [e0, e1] (atoms excluded).
  function distMassBetween(d, e0, e1) {
    var m = 0;
    for (var i = 0; i < d.segs.length; i++) {
      var s = d.segs[i], ov = Math.min(s[1], e1) - Math.max(s[0], e0);
      if (ov > 0) m += s[2] * ov / (s[1] - s[0]);
    }
    return m;
  }

  // Mass of nBars equal bars over [0, 1] pu. The first bar also holds the atom
  // at 0 and the last bar the atom at capacity, so both walls are drawn the
  // same way and the bars sum to 1 (Plotly's density then matches the curves).
  function distBars(d, nBars) {
    var bars = [], k;
    for (k = 0; k < nBars; k++) bars.push(0);
    bars[0] += d.atom0;
    bars[nBars - 1] += d.atom1;
    for (var i = 0; i < d.segs.length; i++) {
      var s = d.segs[i], dens = s[2] / (s[1] - s[0]);
      var k0 = Math.max(0, Math.floor(s[0] * nBars));
      var k1 = Math.min(nBars - 1, Math.floor(s[1] * nBars));
      for (k = k0; k <= k1; k++) {
        var ov = Math.min(s[1], (k + 1) / nBars) - Math.max(s[0], k / nBars);
        if (ov > 0) bars[k] += dens * ov;
      }
    }
    return bars;
  }

  // ── Special functions ─────────────────────────────────────────────────────

  function digamma(x) {
    if (x < 6) return digamma(x + 1) - 1.0 / x;
    var ix = 1.0 / x, ix2 = ix * ix;
    return Math.log(x) - 0.5 * ix - ix2 * (1.0/12 - ix2 * (1.0/120 - ix2/252));
  }

  function trigamma(x) {
    if (x < 6) return trigamma(x + 1) + 1.0 / (x * x);
    var ix = 1.0 / x, ix2 = ix * ix;
    return ix + 0.5 * ix2 + ix2 * ix * (1.0/6 - ix2 * (1.0/30 - ix2/42));
  }

  function invDigamma(y) {
    var x = y >= -2.22 ? Math.exp(y) + 0.5 : -1.0 / (y - 0.5772156649);
    for (var i = 0; i < 8; i++) {
      x -= (digamma(x) - y) / trigamma(x);
      if (x <= 0) x = 1e-8;
    }
    return x;
  }

  // ln Gamma(x), x > 0 (Lanczos, g = 7, n = 9; relative error about 1e-15).
  var LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
                 771.32342877765313, -176.61502916214059, 12.507343278686905,
                 -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function logGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
    x -= 1;
    var s = LANCZOS[0], t = x + 7.5;
    for (var i = 1; i < 9; i++) s += LANCZOS[i] / (x + i);
    return 0.918938533204672742 + (x + 0.5) * Math.log(t) - t + Math.log(s);   // 0.9189... = ln sqrt(2 pi)
  }

  function logBeta(a, b) { return logGamma(a) + logGamma(b) - logGamma(a + b); }

  // ── Beta MLE ───────────────────────────────────────────────────────────────
  // Maximum likelihood for Beta(alpha, beta) on [0, 1] pu given the exact
  // sufficient statistics s1 = E[ln x~], s2 = E[ln(1 - x~)]. Newton's method
  // on l = (alpha - 1) s1 + (beta - 1) s2 - ln B(alpha, beta), which is
  // strictly concave, with an Armijo line search that allows for rounding in
  // lgamma; Minka's fixed point, run to a tight tolerance, is the fallback.
  // A fit with alpha or beta <= BETA_MIN counts as no fit, and so does one
  // above BETA_MAX: the likelihood then has no maximum (all mass at one point,
  // which a 0.02 pu cell rules out; on this data alpha and beta stay in the hundreds).
  //
  // BETA_CLIP sets the smallest pu value passed to log(). A clip as small as 1e-7
  // makes mean(log(x)) hyper-sensitive to a few outcomes at 0 MW
  // (log(1e-7) = -16.1) and gives alpha < 1 for bell-shaped distributions.
  // 0.005 gives log(BETA_CLIP) = -5.3, robust to a small mass at the walls while
  // still detecting J-shaped and U-shaped distributions near 0 or 1 pu.
  var BETA_CLIP = 0.005;
  var BETA_MIN  = 0.01;
  var BETA_MAX  = 1e6;
  var NEWTON_MAX_ITER = 100, NEWTON_TOL = 1e-12, NEWTON_DEC_TOL = 1e-20;
  var NEWTON_ARMIJO = 1e-4, NEWTON_ROUNDING = 1e-12, NEWTON_MIN_STEP = 1e-10;
  var FIXED_POINT_MAX_ITER = 50000, FIXED_POINT_TOL = 1e-13;

  // [l(a, b), size of its terms] (the size scales the rounding allowance).
  function betaLogLik(a, b, s1, s2) {
    var la = logGamma(a), lb = logGamma(b), lab = logGamma(a + b);
    var t1 = (a - 1) * s1, t2 = (b - 1) * s2;
    return [t1 + t2 - (la + lb - lab),
            1 + Math.abs(t1) + Math.abs(t2) + Math.abs(la) + Math.abs(lb) + Math.abs(lab)];
  }

  function betaNewton(s1, s2, a, b) {
    var cur = betaLogLik(a, b, s1, s2);
    for (var it = 0; it < NEWTON_MAX_ITER; it++) {
      var pab = digamma(a + b), tab = trigamma(a + b);
      var ga  = s1 - digamma(a) + pab;
      var gb  = s2 - digamma(b) + pab;
      var haa = tab - trigamma(a), hbb = tab - trigamma(b);
      var det = haa * hbb - tab * tab;
      if (!(isFinite(det) && det > 0 && haa < 0)) return null;
      var da  = (tab * gb - hbb * ga) / det;       // d = -H^-1 g
      var db  = (tab * ga - haa * gb) / det;
      var dec = ga * da + gb * db;
      if (!isFinite(dec)) return null;
      if (dec < NEWTON_DEC_TOL) return { alpha: a, beta: b, iterations: it, method: 'newton' };
      var t = 1, an, bn, next = null;
      for (;;) {
        an = a + t * da; bn = b + t * db;
        if (an > 0 && bn > 0) {
          next = betaLogLik(an, bn, s1, s2);
          if (isFinite(next[0]) &&
              next[0] >= cur[0] + NEWTON_ARMIJO * t * dec - NEWTON_ROUNDING * cur[1]) break;
        }
        t *= 0.5;
        if (t < NEWTON_MIN_STEP) return null;
      }
      var step = Math.max(Math.abs(an - a) / an, Math.abs(bn - b) / bn);
      a = an; b = bn;
      if (a > BETA_MAX || b > BETA_MAX) return null;   // heading to infinity: no maximum
      if (step < NEWTON_TOL) return { alpha: a, beta: b, iterations: it + 1, method: 'newton' };
      cur = next;
    }
    return null;
  }

  // Minka's fixed point: psi(a) = psi(a + b) + s1, psi(b) = psi(a + b) + s2.
  function betaFixedPoint(s1, s2, a, b) {
    for (var it = 0; it < FIXED_POINT_MAX_ITER; it++) {
      var pab = digamma(a + b);
      var an  = invDigamma(pab + s1), bn = invDigamma(pab + s2);
      if (!(isFinite(an) && isFinite(bn) && an > 0 && bn > 0)) return null;
      var step = Math.max(Math.abs(an - a) / an, Math.abs(bn - b) / bn);
      a = an; b = bn;
      if (a > BETA_MAX || b > BETA_MAX) return null;
      if (step < FIXED_POINT_TOL) return { alpha: a, beta: b, iterations: it + 1, method: 'fixed_point' };
    }
    return null;
  }

  function fitBeta(d, mean, variance) {
    // x~ at one point (all mass at or beyond one clip value): no maximum.
    var atLo = d.atom0 + distMassBetween(d, 0, BETA_CLIP);
    if (distMassBetween(d, BETA_CLIP, 1 - BETA_CLIP) <= 0 && (atLo <= 1e-12 || atLo >= 1 - 1e-12)) return null;
    var lm = distLogMoments(d, BETA_CLIP);
    // Starting point: the moment estimate.
    var mu = clamp(mean, 0.005, 0.995);
    var c0 = mu * (1 - mu) / Math.max(variance, 1e-8) - 1;
    if (c0 <= 0) c0 = 1.0;
    var a0 = mu * c0, b0 = (1 - mu) * c0;
    var fit = betaNewton(lm[0], lm[1], a0, b0) || betaFixedPoint(lm[0], lm[1], a0, b0);
    if (!fit || !isFinite(fit.alpha) || !isFinite(fit.beta) ||
        fit.alpha <= BETA_MIN || fit.beta <= BETA_MIN ||
        fit.alpha > BETA_MAX || fit.beta > BETA_MAX) return null;
    fit.s1 = lm[0];
    fit.s2 = lm[1];
    return fit;
  }

  // ── Regularized incomplete beta, its inverse and Beta CVaR ────────────────

  var BETACF_MAX_ITER = 10000, BETACF_EPS = 1e-15, BETACF_FPMIN = 1e-300;
  var BETA_Q_MAX_ITER = 200, BETA_Q_TOL = 1e-14;

  // The continued fraction of I_x(a, b) (DLMF 8.17.22): I_x(a, b) = x^a (1 - x)^b / (a B(a, b)) / F, where
  // F = 1 + t1 / (1 + t2 / (1 + t3 / ...)) with the terms
  //   t(2k + 1) = -(a + k)(a + b + k) x / ((a + 2k)(a + 2k + 1)),   t(2k) = k (b - k) x / ((a + 2k - 1)(a + 2k)),
  // evaluated forward by the modified Lentz method (Thompson and Barnett, J. Comput. Phys. 64, 1986). Returns 1 / F.
  function betaCF(a, b, x) {
    var tiny = BETACF_FPMIN, f = 1, num = 1, den = 0;
    for (var j = 1; j <= 2 * BETACF_MAX_ITER; j++) {
      var k = j >> 1;
      var t = j % 2 === 1
        ? -(a + k) * (a + b + k) * x / ((a + 2 * k) * (a + 2 * k + 1))
        : k * (b - k) * x / ((a + 2 * k - 1) * (a + 2 * k));
      den = 1 + t * den; if (Math.abs(den) < tiny) den = tiny;
      num = 1 + t / num; if (Math.abs(num) < tiny) num = tiny;
      den = 1 / den;
      var ratio = num * den;
      f *= ratio;
      if (Math.abs(ratio - 1) <= BETACF_EPS) break;
    }
    return 1 / f;
  }

  // I_x(a, b) = P(X <= x) for X ~ Beta(a, b).
  function betaInc(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
    if (x < (a + 1) / (a + b + 2)) return bt * betaCF(a, b, x) / a;
    return 1 - bt * betaCF(b, a, 1 - x) / b;
  }

  // Starting value for betaQuantile. In each tail the leading term of the series of I_x(a, b) (DLMF 8.17.7) gives
  // I_x ~ x^a / (a B(a, b)) near 0 and 1 - I_x ~ (1 - x)^b / (b B(a, b)) near 1; between them the mean a / (a + b).
  function betaQuantileGuess(p, a, b) {
    var lb = logBeta(a, b), mean = a / (a + b);
    var lo = Math.exp((Math.log(p) + Math.log(a) + lb) / a);
    var hi = 1 - Math.exp((Math.log(1 - p) + Math.log(b) + lb) / b);
    var x = lo < mean ? lo : hi > mean ? hi : mean;
    return isFinite(x) && x > 0 && x < 1 ? x : 0.5;
  }

  // The x with I_x(a, b) = p: Halley's method inside a bracket that always
  // holds the root, bisecting whenever a step would leave it.
  function betaQuantile(p, a, b) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    var x = betaQuantileGuess(p, a, b), lo = 0, hi = 1, lb = logBeta(a, b);
    for (var it = 0; it < BETA_Q_MAX_ITER; it++) {
      var err = betaInc(a, b, x) - p;
      if (err === 0) return x;
      if (err < 0) lo = x; else hi = x;
      var pdf = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lb);
      var xn = NaN;
      if (isFinite(pdf) && pdf > 0) {
        var u = err / pdf;
        var step = u / (1 - 0.5 * Math.min(1, u * ((a - 1) / x - (b - 1) / (1 - x))));
        if (isFinite(step)) xn = x - step;
      }
      if (!(xn > lo && xn < hi)) xn = 0.5 * (lo + hi);
      if (Math.abs(xn - x) <= BETA_Q_TOL * xn || hi - lo <= BETA_Q_TOL * hi) return xn;
      x = xn;
    }
    return x;
  }

  // Mean of the lowest alpha of Beta(a, b) on [0, 1]:
  // (1/alpha) * a/(a+b) * I_q(a+1, b) with q = Q(alpha).
  function betaCvarLower(a, b, alpha) {
    var q = betaQuantile(alpha, a, b);
    return a / (a + b) * betaInc(a + 1, b, q) / alpha;
  }

  // Mean of the highest alpha: 1 - X ~ Beta(b, a), so it is 1 minus the lower
  // tail mean of Beta(b, a) (working near 0 keeps the quantile representable).
  function betaCvarUpper(a, b, alpha) {
    return 1 - betaCvarLower(b, a, alpha);
  }

  // ── Everything the explorer shows at one forecast, in MW ──────────────────
  // group: one entry of data.groups; meta: data.meta; forecastType: a key of
  // group.cond_quantiles ('dayahead11h', 'dayahead6pm', 'mostrecent').
  // Returns null when there is no capacity or no conditioning data.
  function conditionedStats(group, meta, forecastType, fMW) {
    var capacity = group && group.capacity;
    var bins = group && group.cond_quantiles && group.cond_quantiles[forecastType];
    if (!capacity || !bins || !bins.length || !meta || !(meta.hist_n_bins > 0)) return null;
    var d = conditionDistribution(bins, meta, fMW / capacity);
    if (!d) return null;

    var mu  = distMean(d);
    var vr  = distVariance(d, mu);
    var muMW = mu * capacity;
    var sdMW = Math.sqrt(Math.max(vr * capacity * capacity, 1e-10));
    var fit  = fitBeta(d, mu, vr);
    return {
      fMW:      fMW,
      capacity: capacity,
      n:        d.cond.totalN,
      cond:     d.cond,
      mean:     muMW,
      sd:       sdMW,
      p05:      distQuantile(d, 0.05) * capacity,
      p50:      distQuantile(d, 0.50) * capacity,
      p95:      distQuantile(d, 0.95) * capacity,
      cvar05:   distLowerTailMean(d, CVAR_ALPHA) * capacity,
      cvar95:   distUpperTailMean(d, CVAR_ALPHA) * capacity,
      at0:      d.atom0,
      atcap:    d.atom1,
      bars:     distBars(d, 50),
      gauss: {
        mu: muMW, sigma: sdMW,
        cvar05: muMW - CVAR_K * sdMW,
        cvar95: muMW + CVAR_K * sdMW
      },
      beta: fit ? {
        alpha: fit.alpha, beta: fit.beta, iterations: fit.iterations, method: fit.method,
        s1: fit.s1, s2: fit.s2,
        cvar05: betaCvarLower(fit.alpha, fit.beta, CVAR_ALPHA) * capacity,
        cvar95: betaCvarUpper(fit.alpha, fit.beta, CVAR_ALPHA) * capacity
      } : null
    };
  }

  // ── Curves for the overlays ────────────────────────────────────────────────

  // Gaussian PDF with the moment-matched mean and sd, unbounded (it extends
  // beyond [0, capacity] deliberately).
  function buildGaussianCurve(mu, sigmaIn, nPts) {
    var sigma = Math.max(sigmaIn, 1e-6);
    var xMin  = mu - 4.5 * sigma;
    var xMax  = mu + 4.5 * sigma;
    var xs = [], ys = [];
    var norm = 1.0 / (Math.sqrt(2 * Math.PI) * sigma);
    for (var j = 0; j < nPts; j++) {
      var x = xMin + j * (xMax - xMin) / (nPts - 1);
      var z = (x - mu) / sigma;
      xs.push(x);
      ys.push(norm * Math.exp(-0.5 * z * z));
    }
    return { x: xs, y: ys, mu: mu, sigma: sigma };
  }

  // Beta density on [0, capacity] on a midpoint grid x = (j + 0.5) / nPts,
  // which avoids the walls where alpha < 1 or beta < 1 are singular. The
  // density is evaluated in log space and normalized exactly by B(alpha, beta),
  // so concentrated fits (alpha, beta in the hundreds) neither underflow nor
  // overflow.
  function buildBetaCurve(params, capacity, nPts) {
    if (!params || !capacity) return null;
    var a = params.alpha, b = params.beta, lb = logBeta(a, b);
    var xs = [], ys = [];
    for (var j = 0; j < nPts; j++) {
      var x = (j + 0.5) / nPts;
      xs.push(x * capacity);
      ys.push(Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lb) / capacity);
    }
    return { x: xs, y: ys, alpha: a, beta: b };
  }

  // ── Legend visibility persistence ──────────────────────────────────────────

  function getTraceVisibility() {
    if (!el.panelDist || !el.panelDist.data) return {};
    var vis = {};
    el.panelDist.data.forEach(function (trace) {
      if (trace.visible === 'legendonly') {
        vis[trace.name] = 'legendonly';
      }
    });
    return vis;
  }

  // ── Theme tokens (--fx-*) ──────────────────────────────────────────────────
  // Colors, line styles and fonts come from CSS custom properties, read
  // through a hidden probe span inside the section (so tokens may be set on
  // :root, on .forecast-section or per technology via the section's
  // [data-fx-tech="wind" | "solar"] attribute). Every token is optional and
  // falls back to its default in TOKENS. Paper and plot share one color, so
  // the chart has no seam.
  var TECH_COLORS = { wind: '#1c3d5a', solar: '#c47a1e' };

  // [key, custom property, kind, default]. A null default is derived in readTheme().
  var TOKENS = [
    ['paper',         '--fx-paper',                'color',  '#ffffff'],
    ['ink',           '--fx-ink',                  'color',  '#5a5a5a'],
    ['ink2',          '--fx-ink-2',                'color',  '#5a5a5a'],
    ['grid',          '--fx-grid',                 'color',  '#e0ddd9'],
    ['axis',          '--fx-axis',                 'color',  '#e0ddd9'],
    ['axisWidth',     '--fx-axis-width',           'number', 0],
    ['empirical',     '--fx-empirical',            'color',  null],
    ['empSolar',      '--fx-empirical-solar',      'color',  null],
    ['empOpacity',    '--fx-empirical-opacity',    'number', 0.70],
    ['empLine',       '--fx-empirical-line',       'color',  null],
    ['empLineWidth',  '--fx-empirical-line-width', 'number', 0.4],
    ['gauss',         '--fx-gauss',                'color',  'rgba(185,90,20,0.88)'],
    ['gaussDash',     '--fx-gauss-dash',           'dash',   'solid'],
    ['gaussWidth',    '--fx-gauss-width',          'number', 2.5],
    ['beta',          '--fx-beta',                 'color',  'rgba(20,120,100,0.90)'],
    ['betaWidth',     '--fx-beta-width',           'number', 2],
    ['measured',      '--fx-measured',             'color',  '#7c3aed'],
    ['forecast',      '--fx-forecast',             'color',  '#2a5580'],
    ['forecastDash',  '--fx-forecast-dash',        'dash',   'dot'],
    ['bound',         '--fx-bound',                'color',  '#b03a2e'],
    ['boundWidth',    '--fx-bound-width',          'number', 2],
    ['infeasible',    '--fx-infeasible',           'color',  'rgba(192,57,43,0.07)'],
    ['hatch',         '--fx-hatch',                'color',  'rgba(176,58,46,0.35)'],
    ['hatchShape',    '--fx-hatch-shape',          'shape',  '/'],
    ['hatchSize',     '--fx-hatch-size',           'number', 8],
    ['hatchSolidity', '--fx-hatch-solidity',       'number', 0.15],
    ['tailTint',      '--fx-tail-tint',            'color',  'rgba(0,0,0,0)'],
    ['lock',          '--fx-lock',                 'color',  '#7c3aed'],
    ['lockSymbol',    '--fx-lock-symbol',          'symbol', 'circle'],
    ['lockSize',      '--fx-lock-size',            'number', 10],
    ['lockLine',      '--fx-lock-line',            'color',  null],
    ['lockLineWidth', '--fx-lock-line-width',      'number', 2],
    ['labelBg',       '--fx-label-bg',             'color',  null],
    ['legend',        '--fx-legend',               'flag',   true],
    ['font',          '--fx-font',                 'font',   'Schibsted Grotesk, Arial, sans-serif'],
    ['fontNum',       '--fx-font-num',             'font',   null],
    ['fontSize',      '--fx-font-size',            'number', 13],
    ['tickSize',      '--fx-tick-size',            'number', 13]
  ];

  // [min, max] for numeric tokens. Plotly text never goes below 13 px.
  var NUM_LIMITS = {
    axisWidth: [0, 4], empOpacity: [0, 1], empLineWidth: [0, 8], gaussWidth: [0, 8],
    betaWidth: [0, 8], boundWidth: [0, 8], hatchSize: [2, 64], hatchSolidity: [0, 1],
    lockSize: [4, 32], lockLineWidth: [0, 8], fontSize: [13, 24], tickSize: [13, 24]
  };

  var HATCH_SHAPES = {
    '/': '/', '\\': '\\', '\\\\': '\\', 'x': 'x', '-': '-', '|': '|', '+': '+', '.': '.',
    'forward': '/', 'back': '\\', 'cross': 'x', 'horizontal': '-', 'vertical': '|',
    'plus': '+', 'dots': '.', 'none': ''
  };

  var theme = null;
  var probe = null;
  var colorCtx = null;

  function getProbe() {
    if (probe && probe.isConnected) return probe;
    probe = document.createElement('span');
    probe.className = 'fx-probe';
    probe.hidden = true;
    probe.setAttribute('aria-hidden', 'true');
    (el.section || document.body).appendChild(probe);
    return probe;
  }

  function rgbParts(c) {
    var m = /^#([0-9a-f]{3,8})$/i.exec(c);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.replace(/./g, '$&$&');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
              h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]*)\)$/i.exec(c);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3) return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return null;
  }
  function alphaOf(c) { var p = rgbParts(c); return p ? p[3] : 1; }
  function withAlpha(c, a) {
    var p = rgbParts(c);
    return p ? 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')' : c;
  }

  // Any CSS color → a string Plotly 2.35 parses (hex or rgb()/rgba()).
  // oklch(), lab() or color() serializations go through a 1×1 canvas.
  function resolveColor(p, raw) {
    p.style.color = '';
    p.style.color = raw;
    if (!p.style.color) return null;            // not a valid color
    var c = window.getComputedStyle(p).color;
    if (/^rgba?\(/i.test(c)) return c;
    try {
      if (!colorCtx) {
        var cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        colorCtx = cv.getContext('2d', { willReadFrequently: true });
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = c;
      colorCtx.fillRect(0, 0, 1, 1);
      var d = colorCtx.getImageData(0, 0, 1, 1).data;
      return 'rgba(' + d[0] + ',' + d[1] + ',' + d[2] + ',' + (d[3] / 255).toFixed(3) + ')';
    } catch (e) {
      return null;
    }
  }

  function parseToken(p, kind, raw) {
    var v = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
    switch (kind) {
      case 'color':  return resolveColor(p, raw);
      case 'number': var n = parseFloat(v); return isFinite(n) ? n : null;
      case 'font':   return raw || null;
      case 'symbol': return /^[a-z0-9-]+$/i.test(v) ? v.toLowerCase() : null;
      case 'shape':  return Object.prototype.hasOwnProperty.call(HATCH_SHAPES, v) ? HATCH_SHAPES[v] : null;
      case 'flag':   return !/^(none|hide|hidden|off|false|0)$/i.test(v);
      case 'dash':
        if (/^(solid|dot|dash|longdash|dashdot|longdashdot)$/.test(v)) return v;
        var parts = v.split(/[\s,]+/).filter(Boolean);
        if (parts.length && parts.every(function (s) { return /^\d+(\.\d+)?(px|%)?$/.test(s); })) {
          return parts.map(function (s) { return /(px|%)$/.test(s) ? s : s + 'px'; }).join(',');
        }
        return null;
    }
    return null;
  }

  function readTheme() {
    var p = getProbe();
    var cs = window.getComputedStyle(p);
    var t = {};
    TOKENS.forEach(function (tok) {
      var key = tok[0], raw = (cs.getPropertyValue(tok[1]) || '').trim();
      var v = raw ? parseToken(p, tok[2], raw) : null;
      t[key] = (v === null || v === undefined) ? tok[3] : v;
      var lim = NUM_LIMITS[key];
      if (lim && typeof t[key] === 'number') t[key] = Math.min(lim[1], Math.max(lim[0], t[key]));
    });
    p.style.color = '';
    // Solar uses --fx-empirical-solar, else --fx-empirical; both fall back to TECH_COLORS.
    if (state.tech === 'solar' && t.empSolar) t.empirical = t.empSolar;
    if (!t.empirical) t.empirical = TECH_COLORS[state.tech] || TECH_COLORS.wind;
    if (!t.empLine)   t.empLine   = t.paper;
    if (!t.lockLine)  t.lockLine  = t.paper;
    if (!t.labelBg)   t.labelBg   = withAlpha(t.paper, 0.85);
    if (!t.fontNum)   t.fontNum   = t.font;
    t.tailTintOn   = alphaOf(t.tailTint) > 0;
    t.infeasibleOn = alphaOf(t.infeasible) > 0;
    t.hatchOn      = !!t.hatchShape && alphaOf(t.hatch) > 0;
    return t;
  }

  function themeKey(t) { return t ? JSON.stringify(t) : ''; }

  // Re-read the tokens after 'themechange', an OS color-scheme change or an
  // html[data-theme] change, and redraw with Plotly.react. uirevision keeps
  // zoom; the lock is part of state and is redrawn.
  var themeFrame = 0;
  function scheduleRetheme() {
    if (themeFrame) return;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    themeFrame = raf(function () {
      themeFrame = 0;
      var next = readTheme();
      if (themeKey(next) === themeKey(theme)) return;
      theme = next;
      redraw();
    });
  }

  function redraw() {
    var data = cache[state.tech];
    var group = data && data.groups && data.groups[groupKey()];
    if (group && group.recent) renderTrajectory(group);
  }

  function watchTheme() {
    document.addEventListener('themechange', scheduleRetheme);
    window.addEventListener('themechange', scheduleRetheme);
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', scheduleRetheme);
      else if (mq.addListener) mq.addListener(scheduleRetheme);
    } catch (e) { /* no matchMedia */ }
    if (window.MutationObserver) {
      new MutationObserver(scheduleRetheme).observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }
  }

  // The first render waits for the chart fonts (Plotly measures text when it
  // lays out the legend and labels), with a timeout so a slow font never
  // blocks the charts.
  var FONT_WAIT_MS = 2000;
  function whenFontsReady(cb) {
    var done = false;
    function go() { if (!done) { done = true; cb(); } }
    var fonts = document.fonts;
    if (!fonts || !fonts.ready || typeof Promise === 'undefined') { go(); return; }
    setTimeout(go, FONT_WAIT_MS);
    var loads = [];
    [theme.font, theme.fontNum].forEach(function (f, i, a) {
      if (!f || a.indexOf(f) !== i || !fonts.load) return;
      try { loads.push(fonts.load(theme.fontSize + 'px ' + f).catch(function () {})); }
      catch (e) { /* not a valid font shorthand: fonts.ready still applies */ }
    });
    Promise.all(loads).then(function () { return fonts.ready; }).then(go, go);
  }

  // ── Plotly configuration ───────────────────────────────────────────────────
  // Touch screens without hover (phones, tablets): Plotly would show its mode bar
  // all the time, over the legend and the annotations, and a finger drag would
  // draw a zoom box with no easy way back. There the charts show no mode bar and
  // do not zoom; taps still pick and lock points.
  var TOUCH_ONLY = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  var MODEBAR = TOUCH_ONLY ? false : 'hover';

  var PLOTLY_CONFIG = {
    responsive:  true,
    displaylogo: false,
    showTips:    false,
    displayModeBar: MODEBAR,
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines',
                             'hoverCompareCartesian', 'hoverClosestCartesian']
  };

  // Bumped by the distribution's reset button (and double-click) so the next
  // render gets a new uirevision and drops any zoom.
  var distRev = 0;

  function resetDistribution() {
    var activeIdx = state.lockedIdx >= 0 ? state.lockedIdx : state.hoveredIdx;
    distRev++;
    if (activeIdx >= 0) updateDistribution(activeIdx);
  }

  function distResetButton() {
    return {
      name: 'resetView', title: 'Reset axes', icon: Plotly.Icons.home,
      click: resetDistribution
    };
  }
  // Built in init(), once Plotly exists (it needs Plotly.Icons).
  var PLOTLY_CONFIG_DIST = null;
  function buildDistConfig() {
    PLOTLY_CONFIG_DIST = {
      responsive:  true,
      displaylogo: false,
      showTips:    false,
      doubleClick: false,
      displayModeBar: MODEBAR,
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'resetScale2d',
                               'toggleSpikelines', 'hoverCompareCartesian', 'hoverClosestCartesian'],
      modeBarButtonsToAdd: [distResetButton()]
    };
  }

  function baseLayout(overrides) {
    var t = theme;
    var layout = {
      paper_bgcolor: t.paper,
      plot_bgcolor:  t.paper,
      font:    { family: t.font, size: t.fontSize, color: t.ink },
      legend:  { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0, font: { size: t.fontSize, color: t.ink } },
      shapes:  [],
      autosize: true
    };
    // Only ever switch the legend off: Plotly's default (shown for 2+ traces) stays.
    if (!t.legend) layout.showlegend = false;
    if (TOUCH_ONLY) layout.dragmode = false;   // no zoom box under a finger (see MODEBAR)
    Object.keys(overrides).forEach(function (k) { layout[k] = overrides[k]; });
    return layout;
  }

  // Narrow charts (phones): the legend moves above the plot and the day ticks
  // turn vertical, so 13 px text still fits.
  var NARROW_PX = 520;
  var lastNarrow = null;
  function isNarrow() {
    var w = el.panelDist ? el.panelDist.clientWidth : 0;
    return w > 0 && w < NARROW_PX;
  }
  function narrowLegend(layout) {
    layout.legend.orientation = 'h';
    layout.legend.x = 0;
    layout.legend.xanchor = 'left';
    layout.legend.y = 1;
    layout.legend.yanchor = 'bottom';
  }
  // Wide charts: Plotly's mode bar (top right, while hovering) would sit on the
  // first legend entry, so the legend starts MODEBAR_CLEAR px below the plot top.
  var MODEBAR_CLEAR = 12;
  function legendBelowModebar(layout, plotH) {
    if (MODEBAR) layout.legend.y = 1 - MODEBAR_CLEAR / plotH;
  }
  function watchWidth() {
    var timer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var n = isNarrow();
        if (lastNarrow !== null && n !== lastNarrow) redraw();
      }, 150);
    });
    // Plotly's responsive option follows the window only; a chart container can
    // also change size on its own (a label wrapping, a CSS layout change).
    // Plots.resize is deferred by Plotly, so this cannot loop.
    if (window.ResizeObserver && Plotly.Plots && Plotly.Plots.resize) {
      var ro = new ResizeObserver(function (entries) {
        entries.forEach(function (e) {
          var r = e.contentRect;
          if (!e.target.data || !e.target._fullLayout || !r || !r.width || !r.height) return;
          var pr = Plotly.Plots.resize(e.target);   // rejects for a hidden div
          if (pr && pr.catch) pr.catch(function () {});
        });
      });
      if (el.panelDist) ro.observe(el.panelDist);
      if (el.panelTraj) ro.observe(el.panelTraj);
    }
  }

  function axisBase(extra) {
    var t = theme;
    var a = {
      gridcolor: t.grid,
      linecolor: t.axis,
      tickcolor: t.axis,
      tickfont:  { size: t.tickSize, family: t.fontNum, color: t.ink2 },
      zeroline:  false
    };
    if (t.axisWidth > 0) {
      a.showline = true; a.linewidth = t.axisWidth;
      a.ticks = 'outside'; a.ticklen = 4; a.tickwidth = t.axisWidth;
    }
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return a;
  }

  // ── Overlays at the extension point ────────────────────────────────────────
  // Hatching over the physically infeasible regions (below 0 MW, above
  // capacity), drawn as scatter traces with fillpattern so the hatch sits
  // under the Gaussian and Beta curves. They are prepended: the bar layer is
  // separate, and within the scatter layer earlier traces draw underneath.
  function addCustomOverlays(traces, condResult, fMW, capacity, frame) {
    var t = theme;
    if (!t.hatchOn || !(capacity > 0)) return;
    var span = 2 * capacity;                     // generous, so zooming out stays covered
    var yTop = frame.yMax * 4;
    function region(x0, x1, name) {
      return {
        x: [x0, x1, x1, x0, x0], y: [0, 0, yTop, yTop, 0],
        type: 'scatter', mode: 'lines', fill: 'toself',
        fillcolor: 'rgba(0,0,0,0)',
        fillpattern: { shape: t.hatchShape, fgcolor: t.hatch, bgcolor: 'rgba(0,0,0,0)',
                       size: t.hatchSize, solidity: t.hatchSolidity },
        line: { width: 0, color: 'rgba(0,0,0,0)' },
        name: name, showlegend: false, hoverinfo: 'skip'
      };
    }
    traces.unshift(region(frame.xMin - span, 0, 'Below 0 MW'),
                   region(capacity, frame.xMax + span, 'Above capacity'));
  }

  // ── Top panel: conditioned distribution ────────────────────────────────────
  function updateDistribution(pointIdx) {
    if (!cache[state.tech]) return;
    var data  = cache[state.tech];
    var gk    = groupKey();
    var group = data.groups && data.groups[gk];
    if (!group || !group.recent) return;

    var recent   = group.recent;
    var capacity = group.capacity || 0;
    var fcField  = FORECAST_FIELDS[state.forecast];
    var ts       = recent.timestamps || [];
    var forecast = recent[fcField]   || [];
    var measured = recent.measured   || [];
    var n        = ts.length;
    if (n === 0) return;

    var idx = (pointIdx < 0 || pointIdx >= n) ? n - 1 : pointIdx;
    var fMW = forecast[idx];
    if (fMW === null || fMW === undefined) {
      for (var k = idx - 1; k >= 0; k--) {
        if (forecast[k] !== null && forecast[k] !== undefined) { fMW = forecast[k]; idx = k; break; }
      }
    }
    if (fMW === null || fMW === undefined) return;

    var N_CURVE = 300;

    var cacheKey = groupKey() + '|' + state.forecast + '|' + idx + '|' + (state.showApprox ? '1' : '0');
    var cached   = statsCache[cacheKey];
    if (!cached) {
      var st = conditionedStats(group, data.meta, state.forecast, fMW);
      if (!st) {
        setDistLabel('Distribution at ' + (ts[idx] ? formatTimeDisplay(ts[idx]) : '—') +
                     ', no historical data', state.lockedIdx >= 0);
        updateMetrics({
          time: ts[idx] ? formatTimeDisplay(ts[idx]) : null,
          fMW: fMW, mMW: measured[idx], capacity: capacity,
          cvarLo: { emp: null, gauss: null, beta: null },
          cvarHi: { emp: null, gauss: null, beta: null }
        });
        updateDistSummary(null);
        return;
      }
      // Exact statistics (no sampling). The Gaussian and Beta read-outs are
      // shown only with the overlays.
      var approx = state.showApprox;
      cached = {
        bars:        st.bars,
        atcap:       st.atcap,
        gaussCurve:  approx ? buildGaussianCurve(st.gauss.mu, st.gauss.sigma, N_CURVE) : null,
        betaCurve:   approx && st.beta ? buildBetaCurve(st.beta, capacity, N_CURVE) : null,
        cvarEmpLo:   st.cvar05,
        cvarEmpHi:   st.cvar95,
        cvarGaussLo: approx ? st.gauss.cvar05 : null,
        cvarGaussHi: approx ? st.gauss.cvar95 : null,
        cvarBetaLo:  approx && st.beta ? st.beta.cvar05 : null,
        cvarBetaHi:  approx && st.beta ? st.beta.cvar95 : null
      };
      // Kept so the extension point and the text summary see the same
      // conditioning result on cache hits.
      cached.cond  = { bandwidth: st.cond.bandwidth, fallback: st.cond.fallback,
                       totalN: st.cond.totalN, binsUsed: st.cond.binsUsed };
      cached.quant = { p05: st.p05, p50: st.p50, p95: st.p95 };
      statsCache[cacheKey] = cached;
    }

    var gaussCurve  = cached.gaussCurve;
    var betaCurve   = cached.betaCurve;
    var cvarEmpLo   = cached.cvarEmpLo;
    var cvarEmpHi   = cached.cvarEmpHi;
    var cvarGaussLo = cached.cvarGaussLo;
    var cvarGaussHi = cached.cvarGaussHi;
    var cvarBetaLo  = cached.cvarBetaLo;
    var cvarBetaHi  = cached.cvarBetaHi;

    // Save legend visibility before re-rendering
    var savedVis = getTraceVisibility();

    var t     = theme;
    var color = t.empirical;
    var fs    = t.fontSize;

    var narrow = isNarrow();
    lastNarrow = narrow;
    // Narrow: "0 MW" and "Capacity" get their own row above the plot, under the legend.
    var wallRow = narrow ? fs + 12 : 0;
    var margin = narrow ? { t: 40 + wallRow, r: 12, b: 56, l: 70 } : { t: 16, r: 20, b: 56, l: 70 };
    // Plot size in px; on wide charts the legend at the right is estimated generously.
    var legendW = !narrow && t.legend && state.showApprox ? 0.62 * fs * 9 + 48 : 0;
    var plotW  = Math.max(80, (el.panelDist.clientWidth || 600) - margin.l - margin.r - legendW);
    var plotH  = Math.max(80, (el.panelDist.clientHeight || 300) - margin.t - margin.b);

    // X-axis range
    var xMin = -0.08 * capacity;
    var xMax =  1.08 * capacity;
    if (gaussCurve) {
      xMin = Math.min(xMin, gaussCurve.x[0]);
      xMax = Math.max(xMax, gaussCurve.x[gaussCurve.x.length - 1]);
    }
    // Wide: "0 MW" sits left of its wall, so the band below 0 MW is at least as
    // wide as that label (8% of capacity is not, on a mid-width chart).
    if (!narrow) {
      var room = Math.min(0.5, (0.62 * fs * 4 + 16) / plotW);
      xMin = Math.min(xMin, -room * xMax / (1 - room));
    }

    // Explicit bin size for stable histogram rendering across hover updates
    var binSize = capacity > 0 ? capacity / 50 : 1;

    // Build traces
    var traces = [];

    // The histogram's bars carry the exact mass of each bin (y, summed by
    // Plotly, one value per bin center).
    var bars = cached.bars, barX = [];
    for (var bi = 0; bi < bars.length; bi++) barX.push((bi + 0.5) * binSize);
    traces.push({
      x:        barX,
      y:        bars,
      type:     'histogram',
      histfunc: 'sum',
      histnorm: 'probability density',
      xbins:    { start: 0, end: capacity, size: binSize },
      name:     'Empirical',
      marker:   { color: color, opacity: t.empOpacity, line: { color: t.empLine, width: t.empLineWidth } },
      hovertemplate: '%{x:.0f} MW<extra></extra>'
    });

    if (gaussCurve) {
      traces.push({
        x: gaussCurve.x, y: gaussCurve.y,
        type: 'scatter', mode: 'lines',
        name: 'Gaussian',
        line: { color: t.gauss, width: t.gaussWidth, dash: t.gaussDash },
        hovertemplate: '%{x:.0f} MW<extra></extra>'
      });
    }

    if (betaCurve) {
      traces.push({
        x: betaCurve.x, y: betaCurve.y,
        type: 'scatter', mode: 'lines',
        name: 'Beta',
        line: { color: t.beta, width: t.betaWidth },
        hovertemplate: '%{x:.0f} MW<extra></extra>'
      });
    }

    // y-axis range: based on histogram peak only.
    // The Gaussian and Beta curves can peak higher (narrow sigma near boundaries),
    // and including them in yMax would flatten the histogram bars. Curves that
    // exceed yMax are clipped at the top by Plotly.
    // The bars already hold both wall atoms (first and last bar).
    var histPeak = 0;
    for (var bk = 0; bk < bars.length; bk++) histPeak = Math.max(histPeak, bars[bk]);
    histPeak /= binSize;
    var yMax = histPeak > 1e-6 ? histPeak * 1.35 : 0.01;

    // Extension point: addCustomOverlays(traces, condResult, fMW, capacity, frame).
    addCustomOverlays(traces, cached.cond, fMW, capacity,
                      { xMin: xMin, xMax: xMax, yMax: yMax, quant: cached.quant });

    // Restore legend visibility
    traces.forEach(function (tr) {
      if (savedVis[tr.name]) tr.visible = 'legendonly';
    });

    var layout = baseLayout({
      margin:    margin,
      barmode:   'overlay',
      hovermode: false,
      // Same point (a theme change) keeps the user's zoom; a new point, the
      // overlay toggle or the reset button starts from the computed ranges.
      uirevision: cacheKey + '|' + distRev,
      xaxis: axisBase({
        title: { text: 'Generation (MW)', font: { size: fs } },
        range: [xMin, xMax],
        zeroline: false
      }),
      yaxis: axisBase({
        title:    { text: 'Probability density', font: { size: fs } },
        range:    [0, yMax],
        zeroline: false, showgrid: true
      })
    });
    if (narrow) {
      narrowLegend(layout);
      layout.legend.y = 1 + wallRow / plotH;
    } else {
      legendBelowModebar(layout, plotH);
    }
    // Plotly counts showlegend:false traces (the hatch) toward its "2+ traces"
    // default, so decide here: no legend for the histogram alone.
    var legendEntries = traces.filter(function (tr) { return tr.showlegend !== false; }).length;
    if (legendEntries < 2) layout.showlegend = false;

    var span = 2 * capacity;

    // Tails beyond the 5% and 95% quantiles (only when --fx-tail-tint is set)
    if (t.tailTintOn && cached.quant && cached.quant.p05 !== null) {
      layout.shapes.push(
        { type: 'rect', layer: 'below', x0: xMin - span, x1: cached.quant.p05, yref: 'paper', y0: 0, y1: 1,
          fillcolor: t.tailTint, line: { width: 0 } },
        { type: 'rect', layer: 'below', x0: cached.quant.p95, x1: xMax + span, yref: 'paper', y0: 0, y1: 1,
          fillcolor: t.tailTint, line: { width: 0 } }
      );
    }

    // Infeasible region shading (flat band; the hatch is added at the extension point)
    if (t.infeasibleOn) {
      layout.shapes.push(
        { type: 'rect', layer: 'below', x0: xMin - span, x1: 0,  yref: 'paper', y0: 0, y1: 1,
          fillcolor: t.infeasible, line: { width: 0 } },
        { type: 'rect', layer: 'below', x0: capacity, x1: xMax + span, yref: 'paper', y0: 0, y1: 1,
          fillcolor: t.infeasible, line: { width: 0 } }
      );
    }

    // Physical bounds and forecast reference
    layout.shapes.push(
      { type: 'line', x0: 0,        x1: 0,        yref: 'paper', y0: 0, y1: 1,
        line: { color: t.bound, width: t.boundWidth } },
      { type: 'line', x0: capacity, x1: capacity, yref: 'paper', y0: 0, y1: 1,
        line: { color: t.bound, width: t.boundWidth } },
      { type: 'line', x0: fMW, x1: fMW, yref: 'paper', y0: 0, y1: 1,
        line: { color: t.forecast, dash: t.forecastDash, width: 1.5 } }
    );

    // A label anchors away from a wall once a centered label would reach it (in
    // pixels), so it never crosses a wall line or covers "0 MW" or "Capacity".
    var pxPerMW = plotW / (xMax - xMin);
    function anchorFor(x, text) {
      if (!(capacity > 0)) return 'center';
      var half = 0.31 * fs * text.length + 6;    // half a label box, generously
      if (x * pxPerMW < half) return 'left';
      if ((capacity - x) * pxPerMW < half) return 'right';
      return 'center';
    }
    // Wide: the wall labels sit at the top of the plot, outside the walls.
    // Narrow: there is no room outside the walls; they sit above the plot, inside them.
    var wallAnchorY = narrow ? 'bottom' : 'top';

    layout.annotations = [
      { xref: 'x', x: 0,        yref: 'paper', y: 1.0, yanchor: wallAnchorY, xanchor: narrow ? 'left' : 'right',
        text: '0 MW', showarrow: false,
        font: { size: fs, color: t.bound }, bgcolor: t.labelBg },
      { xref: 'x', x: capacity, yref: 'paper', y: 1.0, yanchor: wallAnchorY, xanchor: narrow ? 'right' : 'left',
        text: 'Capacity', showarrow: false,
        font: { size: fs, color: t.bound }, bgcolor: t.labelBg },
      { xref: 'x', x: fMW,      yref: 'paper', y: 0.97, yanchor: 'top', xanchor: anchorFor(fMW, 'Forecast'),
        text: 'Forecast', showarrow: false,
        font: { size: fs, color: t.forecast }, bgcolor: t.labelBg }
    ];

    // Measured value marker (shown only when a non-null measured value exists)
    var mMW_dist = measured[idx];
    if (mMW_dist !== null && mMW_dist !== undefined) {
      layout.shapes.push({
        type: 'line', x0: mMW_dist, x1: mMW_dist, yref: 'paper', y0: 0, y1: 1,
        line: { color: t.measured, width: 1.5 }
      });
      layout.annotations.push({
        xref: 'x', x: mMW_dist, yref: 'paper', y: 0.97, yshift: -(fs + 10), yanchor: 'top',
        xanchor: anchorFor(mMW_dist, 'Measured'),
        text: 'Measured', showarrow: false,
        font: { size: fs, color: t.measured }, bgcolor: t.labelBg
      });
    }

    Plotly.react(el.panelDist, traces, layout, PLOTLY_CONFIG_DIST);

    if (el.panelDist.removeAllListeners) el.panelDist.removeAllListeners('plotly_doubleclick');
    el.panelDist.on('plotly_doubleclick', resetDistribution);

    // Update label
    var timeStr = ts[idx] ? formatTimeDisplay(ts[idx]) : '—';
    setDistLabel('Distribution at ' + timeStr, state.lockedIdx >= 0);

    // Update metrics panel
    var mMW = measured[idx];
    updateMetrics({
      time: ts[idx] ? formatTimeDisplay(ts[idx]) : null, fMW: fMW, mMW: mMW, capacity: capacity,
      cvarLo: { emp: cvarEmpLo, gauss: cvarGaussLo, beta: cvarBetaLo },
      cvarHi: { emp: cvarEmpHi, gauss: cvarGaussHi, beta: cvarBetaHi }
    });

    updateDistSummary({
      time: ts[idx] ? formatTimeDisplay(ts[idx]) : null, fMW: fMW, mMW: mMW, capacity: capacity,
      quant: cached.quant, cvarLo: cvarEmpLo, cvarHi: cvarEmpHi
    });
  }

  // ── Bottom panel: 15-min trajectory ────────────────────────────────────────
  // The arrays of the series on screen, reused by the step controls.
  var traj = { ts: [], tsDisplay: [], measured: [], forecast: [] };

  function renderTrajectory(group) {
    var t        = theme;
    var recent   = group.recent;
    var capacity = group.capacity || 0;
    var fcField  = FORECAST_FIELDS[state.forecast];
    var fcLabel  = FORECAST_LABELS[state.forecast];
    var ts        = recent.timestamps || [];
    var tsDisplay = uniqueTimes(applyTz(ts));   // converted to selected timezone for display
    var measured  = recent.measured   || [];
    var forecast  = recent[fcField]   || [];
    var mValid    = measured.filter(function (v) { return v !== null && v !== undefined; });
    var yMax      = Math.max(capacity, mValid.length ? Math.max.apply(null, mValid) : 0) * 1.10;
    var fs        = t.fontSize;

    traj = { ts: ts, tsDisplay: tsDisplay, measured: measured, forecast: forecast };

    var narrow = isNarrow();
    var margin = narrow ? { t: 40, r: 12, b: 84, l: 56 } : { t: 16, r: 16, b: 62, l: 64 };
    var layout = baseLayout({
      margin:    margin,
      uirevision: groupKey() + '|' + state.forecast + '|' + state.tz,
      // Wide charts keep the day ticks flat unless Plotly finds they collide. The hover line marking
      // the selected time is a thin solid line (the dots belong to the forecast, the dashes to capacity).
      xaxis:     axisBase({ type: 'date', dtick: 86400000, tickformat: '%b %d',
                            tickangle: narrow ? -90 : 'auto',
                            spikecolor: t.ink2, spikedash: 'solid', spikethickness: 1,
                            title: { text: axisTzLabel(ts), font: { size: fs }, standoff: 2 } }),
      yaxis:     axisBase({
        title:    { text: 'MW', font: { size: fs } },
        range:    [0, yMax],
        zeroline: true, zerolinecolor: t.axis
      }),
      hovermode: 'x unified'
    });
    if (narrow) narrowLegend(layout);
    else legendBelowModebar(layout, Math.max(80, (el.panelTraj.clientHeight || 300) - margin.t - margin.b));

    // Installed capacity: dashed, in the color of the physical limits (the walls of the distribution above).
    if (capacity > 0) {
      layout.shapes.push({
        type: 'line', xref: 'paper', x0: 0, x1: 1,
        yref: 'y', y0: capacity, y1: capacity,
        line: { color: t.bound, dash: 'dash', width: 1.5 }
      });
      layout.annotations = [{
        xref: 'paper', x: 0.01, xanchor: 'left',
        yref: 'y', y: capacity, yanchor: 'bottom',
        text: 'Capacity', showarrow: false,
        font: { size: fs, color: t.bound }
      }];
    }

    // Hover events come from the forecast trace alone (it has a value at every quarter-hour), and
    // Plotly draws no label: showTipAt() draws the box, with the measured value of that same
    // quarter-hour only. A hoverable Measured trace would let the unified label pick the nearest
    // earlier measurement for times after the last one, and Plotly's own label would put both
    // values beside the forecast's key.
    var traces = [
      { x: tsDisplay, y: measured, type: 'scatter', mode: 'lines', name: 'Measured',
        line: { color: t.measured, width: 1.5 }, hoverinfo: 'skip' },
      { x: tsDisplay, y: forecast, type: 'scatter', mode: 'lines', name: fcLabel,
        line: { color: t.forecast, width: 1.5, dash: t.forecastDash }, opacity: 0.55, hoverinfo: 'none' }
    ];
    // A lock survives redraws (forecast-type switch, time zone, theme).
    if (state.lockedIdx >= 0 && state.lockedIdx < ts.length) {
      traces.push(lockTrace(state.lockedIdx));
    } else if (state.lockedIdx >= ts.length) {
      state.lockedIdx = -1;
    }

    Plotly.react(el.panelTraj, traces, layout, PLOTLY_CONFIG);

    if (el.panelTraj.removeAllListeners) {
      el.panelTraj.removeAllListeners('plotly_hover');
      el.panelTraj.removeAllListeners('plotly_unhover');
      el.panelTraj.removeAllListeners('plotly_click');
    }
    hideTrajTip();

    el.panelTraj.on('plotly_hover', function (evt) {
      if (!evt.points || !evt.points.length) return;
      showTipAt(evt.points[0].pointIndex);
      if (state.lockedIdx >= 0) return;
      state.hoveredIdx = evt.points[0].pointIndex;
      updateDistribution(state.hoveredIdx);
      syncStepper();
    });

    el.panelTraj.on('plotly_unhover', hideTrajTip);

    // A tap selects its quarter-hour without a plotly_hover (Plotly moves its hover line only), so the
    // click draws the box too. A tap can arrive as two clicks on the same point; the second is ignored,
    // or it would undo the lock at once. Unlocking by a click selects the clicked time.
    el.panelTraj.on('plotly_click', function (evt) {
      if (!evt.points || !evt.points.length) return;
      var clickIdx = evt.points[0].pointIndex;
      var now = Date.now();
      if (clickIdx === lastClick.idx && now - lastClick.time < 400) return;
      lastClick = { idx: clickIdx, time: now };
      showTipAt(clickIdx);
      if (state.lockedIdx >= 0) {
        unlock();
        state.hoveredIdx = clickIdx;
        updateDistribution(clickIdx);
        syncStepper();
      } else {
        lockAt(clickIdx);
      }
    });

    var initIdx = ts.length > 0 ? ts.length - 1 : 0;
    if (state.hoveredIdx < 0 || state.hoveredIdx >= ts.length) state.hoveredIdx = initIdx;
    updateDistribution(state.hoveredIdx);
    updateTrajSummary(group);
    syncStepper();
  }

  // ── Trajectory hover box ───────────────────────────────────────────────────
  // The time, then the measured value (only when that quarter-hour has one) and the forecast,
  // each after the key of its own line (.fc-tip__key in explorer.css). Built with text nodes only.
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var trajTip = null;
  var lastClick = { idx: -1, time: 0 };

  function tipTime(s) {   // 'YYYY-MM-DD HH:MM' (the displayed time zone) → 'Nov 19 17:30'
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(s || '');
    return m ? MONTHS[+m[2] - 1] + ' ' + m[3] + ' ' + m[4] : (s || '');
  }

  function tipRow(kind, label, value) {
    var row = document.createElement('div');
    row.className = 'fc-tip__row';
    var key = document.createElement('span');
    key.className = 'fc-tip__key fc-tip__key--' + kind;
    var b = document.createElement('b');
    b.textContent = Math.round(value) + ' MW';
    row.appendChild(key);
    row.appendChild(document.createTextNode(label + ' '));
    row.appendChild(b);
    return row;
  }

  // The box for quarter-hour idx, from hovering, tapping, the range input or the step buttons.
  function showTipAt(idx) {
    var panel = el.panelTraj && el.panelTraj.parentNode;
    var fl = el.panelTraj && el.panelTraj._fullLayout;
    var xa = fl && fl.xaxis, ya = fl && fl.yaxis;
    if (!panel || !xa || !ya || !(idx >= 0) || idx >= traj.ts.length) { hideTrajTip(); return; }
    if (!trajTip || !trajTip.isConnected) {
      trajTip = document.createElement('div');
      trajTip.className = 'fc-tip';
      trajTip.setAttribute('aria-hidden', 'true');   // the distribution label and summary announce the same values
      trajTip.hidden = true;
      panel.appendChild(trajTip);
    }
    var mVal = traj.measured[idx], fVal = traj.forecast[idx];
    trajTip.textContent = '';
    var time = document.createElement('div');
    time.className = 'fc-tip__time';
    time.textContent = tipTime(traj.tsDisplay[idx]);
    trajTip.appendChild(time);
    if (mVal != null) trajTip.appendChild(tipRow('measured', 'Measured', mVal));
    if (fVal != null) trajTip.appendChild(tipRow('forecast', FORECAST_LABELS[state.forecast], fVal));
    trajTip.hidden = false;

    // Wide charts: beside the selected time, on whichever side has room, at the top of the plot.
    // Narrow charts, or no room beside it: under the plot, over the day labels (the box gives the
    // day itself), so it never covers the lines at the selected time, the legend or the controls.
    var W = el.panelTraj.clientWidth, w = trajTip.offsetWidth, gap = 14;
    var x = xa._offset + xa.d2p(traj.tsDisplay[idx]);
    if (!isFinite(x)) x = W / 2;
    var left, top = ya._offset + 8;
    if (!isNarrow() && x + gap + w <= W) left = x + gap;
    else if (!isNarrow() && x - gap - w >= 0) left = x - gap - w;
    else {
      left = Math.min(Math.max(0, x - w / 2), Math.max(0, W - w));
      top = ya._offset + ya._length + 4;
    }
    trajTip.style.transform = 'translate(' + Math.round(left + el.panelTraj.offsetLeft) + 'px,' +
                              Math.round(top + el.panelTraj.offsetTop) + 'px)';
  }

  function hideTrajTip() {
    if (trajTip) trajTip.hidden = true;
  }

  // ── Lock marker on trajectory ──────────────────────────────────────────────
  function lockTrace(idx) {
    var t = theme, mVal = traj.measured[idx], fVal = traj.forecast[idx];
    return {
      x: [traj.tsDisplay[idx]], y: [mVal != null ? mVal : fVal],
      type: 'scatter', mode: 'markers',
      marker: { color: t.lock, size: t.lockSize, symbol: t.lockSymbol,
                line: { color: t.lockLine, width: t.lockLineWidth } },
      name: 'Locked', showlegend: false, hoverinfo: 'skip'
    };
  }

  function showLockMarker(idx) {
    if (!el.panelTraj || !el.panelTraj.data) return;
    removeLockMarker();
    Plotly.addTraces(el.panelTraj, lockTrace(idx));
  }

  function removeLockMarker() {
    if (!el.panelTraj || !el.panelTraj.data) return;
    var idxs = [];
    el.panelTraj.data.forEach(function (tr, i) { if (tr.name === 'Locked') idxs.push(i); });
    if (idxs.length) Plotly.deleteTraces(el.panelTraj, idxs);
  }

  function updateLockLabel(locked) {
    setDistLabel(null, locked);
  }

  function lockAt(idx) {
    state.lockedIdx = idx;
    state.hoveredIdx = idx;
    updateDistribution(idx);
    showLockMarker(idx);
    updateLockLabel(true);
    syncStepper();
  }

  function unlock() {
    state.lockedIdx = -1;
    removeLockMarker();
    updateLockLabel(false);
    syncStepper();
  }

  // ── Keyboard and single-pointer path (WCAG 2.1.1, 2.5.7) ──────────────────
  // The range input and the Earlier / Later / Latest / Lock buttons drive the
  // same update and lock functions as hovering and clicking the trajectory.
  function activeIdx() {
    return state.lockedIdx >= 0 ? state.lockedIdx : state.hoveredIdx;
  }

  function selectIndex(i) {
    var n = traj.ts.length;
    if (!n || isNaN(i)) return;
    i = Math.max(0, Math.min(n - 1, i));
    if (i === activeIdx()) { syncStepper(); return; }
    if (state.lockedIdx >= 0) {
      state.lockedIdx = i;
      state.hoveredIdx = i;
      updateDistribution(i);
      showLockMarker(i);
    } else {
      state.hoveredIdx = i;
      updateDistribution(i);
    }
    showHoverAt(i);
    showTipAt(i);
    syncStepper();
  }

  function step(delta) {
    var i = activeIdx();
    if (i < 0) i = traj.ts.length - 1;
    selectIndex(i + delta);
  }

  // Move Plotly's hover line to index i, as a mouse hover would (the box is
  // showTipAt's). A programmatic Fx.hover does not emit plotly_hover, so
  // nothing runs twice. Point i's own x (unique, see uniqueTimes) picks that
  // point, not a repeat.
  function showHoverAt(i) {
    if (!window.Plotly || !Plotly.Fx || !Plotly.Fx.hover || !el.panelTraj) return;
    var xs = traj.tsDisplay[i];
    var xval = xs ? Date.parse(xs + (xs.length === 16 ? ':00' : '') + 'Z') : NaN;
    if (!isFinite(xval)) return;
    try { Plotly.Fx.hover(el.panelTraj, { xval: xval }, 'xy'); } catch (e) { /* label only */ }
  }

  function setAriaDisabled(btn, off) {
    if (btn) btn.setAttribute('aria-disabled', off ? 'true' : 'false');
  }

  function syncStepper() {
    var n = traj.ts.length;
    var i = activeIdx();
    if (i < 0 || i >= n) i = n - 1;
    if (el.range) {
      el.range.max = String(Math.max(0, n - 1));
      el.range.value = String(Math.max(0, i));
      el.range.disabled = n === 0;
      el.range.setAttribute('aria-valuetext', n && traj.ts[i] ? formatTimeDisplay(traj.ts[i]) : '');
    }
    // aria-disabled, not disabled: a focused button must keep focus at the ends.
    setAriaDisabled(el.stepEarlier, !n || i <= 0);
    setAriaDisabled(el.stepLater,   !n || i >= n - 1);
    setAriaDisabled(el.stepLatest,  !n || i >= n - 1);
    if (el.lockBtn) {
      var locked = state.lockedIdx >= 0;
      el.lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
      el.lockBtn.classList.toggle('fc-step--active', locked);
    }
  }

  function initStepper() {
    if (el.range) {
      el.range.addEventListener('input', function () { selectIndex(parseInt(el.range.value, 10)); });
    }
    if (el.stepEarlier) el.stepEarlier.addEventListener('click', function () { step(-1); });
    if (el.stepLater)   el.stepLater.addEventListener('click',   function () { step(1); });
    if (el.stepLatest)  el.stepLatest.addEventListener('click',  function () { selectIndex(traj.ts.length - 1); });
    if (el.lockBtn) {
      el.lockBtn.addEventListener('click', function () {
        var n = traj.ts.length;
        if (!n) return;
        if (state.lockedIdx >= 0) unlock();
        else lockAt(state.hoveredIdx >= 0 && state.hoveredIdx < n ? state.hoveredIdx : n - 1);
      });
    }
  }

  // ── Live label (#dist-point-label, aria-live=polite) ───────────────────────
  // Writes are throttled to one per LIVE_MIN_MS so hovering does not flood a
  // screen reader; the latest text is always written last.
  var LIVE_MIN_MS = 300;
  var liveLabel = { base: null, locked: false, last: 0, timer: 0 };

  function lockedWord() {
    var w = el.section && el.section.getAttribute('data-label-locked');
    return w || 'locked';
  }

  function writeDistLabel() {
    liveLabel.timer = 0;
    liveLabel.last = Date.now();
    if (!el.distLabel || liveLabel.base === null) return;
    var text = liveLabel.base + (liveLabel.locked ? ', ' + lockedWord() : '');
    if (el.distLabel.textContent !== text) el.distLabel.textContent = text;
  }

  function setDistLabel(base, locked) {
    if (typeof base === 'string') liveLabel.base = base;
    if (typeof locked === 'boolean') liveLabel.locked = locked;
    if (liveLabel.timer) return;
    var wait = LIVE_MIN_MS - (Date.now() - liveLabel.last);
    if (wait <= 0) writeDistLabel();
    else liveLabel.timer = setTimeout(writeDistLabel, wait);
  }

  // ── Text alternatives (aria-describedby targets of the two charts) ─────────
  function mwText(v) {
    return v !== null && v !== undefined && isFinite(v) ? v.toFixed(0) + ' MW' : '—';
  }
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function updateDistSummary(s) {
    if (!el.distSummary) return;
    if (!s) { setText(el.distSummary, 'No historical data for this point.'); return; }
    var parts = [];
    parts.push((s.time ? 'At ' + s.time + ', the ' : 'The ') + FORECAST_LABELS[state.forecast] +
               ' forecast is ' + mwText(s.fMW) + '.');
    parts.push(s.mMW !== null && s.mMW !== undefined ? 'The measured generation is ' + mwText(s.mMW) + '.'
                                                     : 'No measurement for this time.');
    if (s.quant && s.quant.p05 !== null) {
      parts.push('The conditioned distribution puts 90% of outcomes between ' + mwText(s.quant.p05) +
                 ' and ' + mwText(s.quant.p95) + ' (5th to 95th percentile).');
    }
    if (s.cvarLo !== null && s.cvarLo !== undefined) {
      parts.push('CVaR 5%, the mean of the lowest 5% of outcomes, is ' + mwText(s.cvarLo) + '.');
    }
    if (s.cvarHi !== null && s.cvarHi !== undefined) {
      parts.push('CVaR 95%, the mean of the highest 5%, is ' + mwText(s.cvarHi) + '.');
    }
    parts.push('Capacity is ' + mwText(s.capacity) + '.');
    setText(el.distSummary, parts.join(' '));
  }

  function updateTrajSummary(group) {
    if (!el.trajSummary) return;
    var ts = traj.ts, measured = traj.measured, n = ts.length;
    if (!n) { setText(el.trajSummary, 'No recent data for this selection.'); return; }
    var what = state.tech === 'wind'
      ? state.wind.offon + ' wind, ' + state.wind.region + ', ' + gridLabel(state.wind.grid) + ' grid'
      : 'solar, ' + state.solar.region;
    var text = 'Measured generation and the ' + FORECAST_LABELS[state.forecast] + ' forecast for ' + what +
               ', between ' + formatTimeDisplay(ts[0]) + ' and ' + formatTimeDisplay(ts[n - 1]) +
               ', in 15-minute steps' + (state.tech === 'solar' ? ' with night hours excluded' : '') + '.' +
               ' Capacity is ' + mwText(group.capacity) + '.';
    for (var i = n - 1; i >= 0; i--) {
      if (measured[i] !== null && measured[i] !== undefined) {
        text += ' The latest measurement is ' + mwText(measured[i]) + ' at ' + formatTimeDisplay(ts[i]) + '.';
        break;
      }
    }
    setText(el.trajSummary, text);
  }

  // ── Metrics panel ─────────────────────────────────────────────────────────
  function updateMetrics(m) {
    if (!el.metricsPanel) return;

    // A minus is U+2212; a value that rounds to zero prints unsigned ("0.0").
    var num = function (v, digits) {
      var s = v.toFixed(digits);
      if (Number(s) === 0) return (0).toFixed(digits);
      return s.charAt(0) === '-' ? '\u2212' + s.slice(1) : s;
    };
    var signed = function (v, digits) {
      var s = num(v, digits);
      return v > 0 && Number(s) !== 0 ? '+' + s : s;
    };
    var fmt = function (v) {
      return v !== null && v !== undefined && isFinite(v) ? num(v, 1) : '—';
    };
    // Show parametric CVaR as "X.X MW" with difference vs empirical expressed
    // as percentage of capacity, so Gaussian and Beta deviations are always
    // comparable on the same scale regardless of operating point.
    var fmtModel = function (model, emp, capacity) {
      if (model === null || !isFinite(model)) return '—';
      var mwStr = num(model, 1) + ' MW';
      var deltaStr = null;
      if (emp !== null && isFinite(emp) && capacity && capacity > 0) {
        var diff = model - emp;
        var pct  = (diff / capacity) * 100;
        deltaStr = signed(diff, 1) + ' MW (' + signed(pct, 1) + '% cap)';
      }
      if (deltaStr) {
        return '<span class="fm-val-mw">' + mwStr + '</span>' +
               '<span class="fm-val-delta">' + deltaStr + '</span>';
      }
      return mwStr;
    };

    if (el.fmTime)     el.fmTime.textContent      = m.time || '—';
    if (el.fmForecast) el.fmForecast.textContent  = num(m.fMW, 0) + ' MW';
    if (el.fmMeasured) el.fmMeasured.textContent  = (m.mMW !== null && m.mMW !== undefined) ? num(m.mMW, 0) + ' MW' : '—';
    if (el.fmCapacity) el.fmCapacity.textContent   = num(m.capacity, 0) + ' MW';

    // Lower tail
    if (el.fmCvarEmpL)   el.fmCvarEmpL.textContent   = fmt(m.cvarLo.emp);
    if (el.fmCvarGaussL) el.fmCvarGaussL.innerHTML = fmtModel(m.cvarLo.gauss, m.cvarLo.emp, m.capacity);
    if (el.fmCvarBetaL)  el.fmCvarBetaL.innerHTML  = fmtModel(m.cvarLo.beta,  m.cvarLo.emp, m.capacity);

    // Upper tail
    if (el.fmCvarEmpH)   el.fmCvarEmpH.textContent  = fmt(m.cvarHi.emp);
    if (el.fmCvarGaussH) el.fmCvarGaussH.innerHTML = fmtModel(m.cvarHi.gauss, m.cvarHi.emp, m.capacity);
    if (el.fmCvarBetaH)  el.fmCvarBetaH.innerHTML  = fmtModel(m.cvarHi.beta,  m.cvarHi.emp, m.capacity);
  }

  // ── Provenance strip ───────────────────────────────────────────────────────
  // "Data as of <generated> UTC. History <start> to <end>. Latest measurement
  // <ts>." Sentence templates come from data-text-* attributes on the section
  // ({placeholders} filled here).
  var STATUS_DEFAULTS = {
    asOf:    'Data as of {generated} UTC.',
    history: 'History {hist_start} to {hist_end}.',
    latest:  'Latest measurement {latest}.'
  };

  function sectionAttr(name) {
    return el.section ? (el.section.getAttribute(name) || '').trim() : '';
  }

  function fillTemplate(tpl, values) {
    return tpl.replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m;
    });
  }

  // meta.generated is '%Y-%m-%dT%H:%M UTC'.
  function parseGenerated(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
  }

  function updateStats(data) {
    if (!el.stats) return;
    var meta = data && data.meta;
    if (el.statSource) {
      var parts = [];
      if (meta) {
        var genMs = parseGenerated(meta.generated);
        var genText = isFinite(genMs)
          ? new Date(genMs).toISOString().slice(0, 16).replace('T', ' ')
          : String(meta.generated || '').replace(/\s*UTC$/i, '');
        if (genText) parts.push(fillTemplate(sectionAttr('data-text-as-of') || STATUS_DEFAULTS.asOf, { generated: genText }));
        if (meta.hist_start && meta.hist_end) {
          parts.push(fillTemplate(sectionAttr('data-text-history') || STATUS_DEFAULTS.history,
                                  { hist_start: meta.hist_start, hist_end: meta.hist_end }));
        }
        var latestTs = null;
        Object.keys(data.groups || {}).forEach(function (gk) {
          var rec = data.groups[gk].recent;
          if (!rec || !rec.timestamps || !rec.measured) return;
          for (var i = rec.timestamps.length - 1; i >= 0; i--) {
            if (rec.measured[i] != null) {
              if (!latestTs || rec.timestamps[i] > latestTs) latestTs = rec.timestamps[i];
              break;
            }
          }
        });
        if (latestTs) {
          parts.push(fillTemplate(sectionAttr('data-text-latest') || STATUS_DEFAULTS.latest,
                                  { latest: formatTimeDisplay(latestTs) }));
        }
      }
      el.statSource.textContent = parts.join(' ') || '—';
    }
    el.stats.style.visibility = '';
    if (el.stats.style.display === 'none') el.stats.style.display = '';
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function render(resetHover) {
    if (resetHover !== false) { state.hoveredIdx = -1; state.lockedIdx = -1; }
    statsCache = {};
    clearError();
    var tech = state.tech;
    loadData(tech, function (data) {
      if (tech !== state.tech) return;          // a newer switch is already drawn
      var gk    = groupKey();
      var group = data.groups && data.groups[gk];
      if (!group || !group.recent) {
        showLoading(false);
        showError('No data for the selected combination.');
        setFxState('error');
        return;
      }
      updateStats(data);
      renderTrajectory(group);
      showLoading(false);
      setFxState('ready');
    });
  }

  // ── Event handlers ─────────────────────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll('[data-tech]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-tech]').forEach(function (b) {
          b.classList.remove('fc-tab--active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('fc-tab--active');
        btn.setAttribute('aria-pressed', 'true');
        state.tech = btn.dataset.tech;
        if (el.section) el.section.setAttribute('data-fx-tech', state.tech);
        theme = readTheme();                    // per-technology tokens
        el.windFilters.style.display  = state.tech === 'wind'  ? 'flex' : 'none';
        el.solarFilters.style.display = state.tech === 'solar' ? 'flex' : 'none';
        render();
      });
    });

    document.querySelectorAll('[data-forecast]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-forecast]').forEach(function (b) {
          b.classList.remove('fc-tab--active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('fc-tab--active');
        btn.setAttribute('aria-pressed', 'true');
        state.forecast = btn.dataset.forecast;
        render(false);
      });
    });

    el.filterOffOn.addEventListener('change', function () { syncWindFilters(); render(); });
    el.filterRegion.addEventListener('change', function () {
      state.wind.region = el.filterRegion.value;
      var vg = validGrids(state.wind.offon, state.wind.region);
      el.filterGrid.innerHTML = '';
      vg.forEach(function (g) {
        var opt = document.createElement('option');
        opt.value = g; opt.textContent = gridLabel(g);
        el.filterGrid.appendChild(opt);
      });
      el.filterGrid.value = (vg.indexOf(state.wind.grid) !== -1) ? state.wind.grid : vg[0];
      state.wind.grid = el.filterGrid.value;
      render();
    });
    el.filterGrid.addEventListener('change', function () { state.wind.grid = el.filterGrid.value; render(); });
    el.filterSolarR.addEventListener('change', function () { state.solar.region = el.filterSolarR.value; render(); });

    if (el.approxToggle) {
      el.approxToggle.addEventListener('change', function () {
        state.showApprox = el.approxToggle.checked;
        var data = cache[state.tech];
        if (data) {
          var group = data.groups && data.groups[groupKey()];
          if (group && group.recent && group.recent.timestamps) {
            var n = group.recent.timestamps.length;
            var activeIdx = state.lockedIdx >= 0 ? state.lockedIdx : state.hoveredIdx;
            updateDistribution(activeIdx < 0 ? n - 1 : activeIdx);
          }
        }
      });
    }

    // Timezone toggle
    function setTz(tz) {
      state.tz = tz;
      if (el.tzBrussels) {
        el.tzBrussels.classList.toggle('fc-tz-btn--active', tz === 'brussels');
        el.tzBrussels.setAttribute('aria-pressed', tz === 'brussels' ? 'true' : 'false');
      }
      if (el.tzUtc) {
        el.tzUtc.classList.toggle('fc-tz-btn--active', tz === 'utc');
        el.tzUtc.setAttribute('aria-pressed', tz === 'utc' ? 'true' : 'false');
      }
      // Re-render trajectory (preserving hover position) and update distribution label + metrics
      var data = cache[state.tech];
      if (data) {
        updateStats(data);
        var group = data.groups && data.groups[groupKey()];
        if (group && group.recent) renderTrajectory(group);
      }
    }
    if (el.tzBrussels) el.tzBrussels.addEventListener('click', function () { setTz('brussels'); });
    if (el.tzUtc)      el.tzUtc.addEventListener('click',      function () { setTz('utc'); });
  }

  // ── Guide callout dismiss ──────────────────────────────────────────────────
  function initGuide() {
    var guide = document.getElementById('fc-guide');
    var close = document.getElementById('fc-guide-close');
    if (!guide || !close) return;
    close.addEventListener('click', function () {
      guide.hidden = true;
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  var PLOTLY_WAIT_MS   = 200;
  var PLOTLY_MAX_WAITS = 150;                   // give up after 30 s
  var plotlyWaits = 0;
  var plotlyTimer = 0;
  var prepared = false;
  var started  = false;

  // Is a Plotly script on the page (loading or loaded)? The loader's own tag
  // does not count.
  function plotlyRequested() {
    for (var s = document.scripts, i = 0; i < s.length; i++) {
      if (!s[i].hasAttribute('data-fx-loader') && /plotly[\w.-]*\.js([?#]|$)/i.test(s[i].src)) return true;
    }
    return false;
  }

  function init() {
    if (started) return;
    if (!document.getElementById('forecast-distribution')) return;
    if (!prepared) {
      prepared = true;
      getEls();
      // The lazy loader injects this file right after the Plotly bundle; if that
      // download failed, the loader has already shown the error. Keep it, rather
      // than flipping back to "loading" and polling for the failed tag for 30 s.
      if (el.section && el.section.getAttribute('data-fx-state') === 'error') return;
      showLoading(true);
      setFxState('loading');
    }
    if (typeof Plotly === 'undefined') {
      clearTimeout(plotlyTimer);
      // Not requested yet: the lazy loader calls window.__fxExplorer.start()
      // once it has loaded Plotly. Poll only while a Plotly script is on its way.
      if (!plotlyRequested()) return;
      if (++plotlyWaits > PLOTLY_MAX_WAITS) {
        showLoading(false);
        showError('Could not load the charting library.');
        setFxState('error');
        return;
      }
      plotlyTimer = setTimeout(init, PLOTLY_WAIT_MS);
      return;
    }
    started = true;
    clearError();
    buildDistConfig();
    if (el.section) el.section.setAttribute('data-fx-tech', state.tech);
    theme = readTheme();
    syncWindFilters();
    bindEvents();
    initGuide();
    initStepper();
    watchTheme();
    watchWidth();
    whenFontsReady(function () { render(); });
  }

  // Called by assets/js/plotly-loader.js when the Plotly script has loaded.
  window.__fxExplorer.start = init;

  // Read-only test hook: the statistics as pure functions of the data, for
  // scripts/test_stats_parity.py. Nothing on the page reads it, and it
  // neither reads nor changes the explorer's state.
  // compute(group, meta, forecastType, fMW) returns what the explorer shows
  // at forecast fMW: n, cond, mean, sd, p05, p50, p95, cvar05, cvar95, at0,
  // atcap, bars, gauss {mu, sigma, cvar05, cvar95} and beta {alpha, beta,
  // cvar05, cvar95, ...} or null. Means, standard deviations, quantiles and
  // CVaR are in MW; at0, atcap and bars are probability masses.
  window.KYForecastStats = Object.freeze({
    version: 1,
    compute: conditionedStats,
    betaInc: betaInc,
    betaQuantile: betaQuantile,
    logGamma: logGamma
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
