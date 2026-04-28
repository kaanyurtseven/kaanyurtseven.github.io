/**
 * Forecast Error Uncertainty Explorer — kaanyurtseven.github.io
 *
 * Two-row linked visualization of Belgian wind/solar generation uncertainty.
 *
 * Top panel    — conditioned empirical forecast error distribution in power space.
 *                X = generation (MW), Y = probability density.
 *                Overlays: Gaussian MLE (unbounded), Beta MLE (bounded).
 *
 * Bottom panel — recent 7-day trajectory at 15-min resolution.
 *
 * Conditioning:
 *   Hard rectangular filter: select bins where center ∈ [f_pu ± bw].
 *   Start bw=0.20, expand by 0.05 to max 1.0 until N ≥ 1000 samples.
 *
 * Data: static JSON refreshed daily by GitHub Actions.
 */

(function () {
  'use strict';

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
  var sampleCache = {};
  var baseUrl = (typeof window !== 'undefined' && window.SITE_BASEURL) ? window.SITE_BASEURL : '';

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var el = {};
  function getEls() {
    el.panelDist    = document.getElementById('forecast-distribution');
    el.panelTraj    = document.getElementById('forecast-trajectory');
    el.errorOverlay = document.getElementById('forecast-error');
    el.loading      = document.getElementById('forecast-loading');
    el.stats        = document.getElementById('forecast-stats');
    el.statTime     = document.getElementById('stat-time');
    el.statForecast = document.getElementById('stat-forecast');
    el.statSource   = document.getElementById('stat-source');
    el.lastUpdated  = document.getElementById('fc-last-updated');
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

  // Convert a UTC timestamp string "YYYY-MM-DDTHH:MM" to Brussels local time.
  // Uses Intl.DateTimeFormat so CET/CEST switching is handled automatically.
  function utcToBrussels(tsStr) {
    var d = new Date(tsStr + ':00Z');
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Brussels',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    var parts = {};
    fmt.formatToParts(d).forEach(function (x) { parts[x.type] = x.value; });
    var h = parseInt(parts.hour, 10) % 24; // guard against Intl "24" for midnight
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + pad(h) + ':' + parts.minute;
  }

  // Current Brussels UTC offset in hours (+1 CET, +2 CEST).
  function brusselsOffsetHours() {
    var now = new Date();
    var utcH = now.getUTCHours();
    var bFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Brussels', hour: 'numeric', hour12: false });
    var bH = parseInt(bFmt.format(now), 10) % 24;
    var diff = ((bH - utcH) + 24) % 24;
    return diff > 12 ? diff - 24 : diff; // normalise to ±12
  }

  // Short timezone label for the currently selected TZ, e.g. "CEST (UTC+2)".
  function tzShortLabel() {
    if (state.tz === 'utc') return 'UTC';
    var off = brusselsOffsetHours();
    return off === 2 ? 'CEST (UTC+2)' : 'CET (UTC+1)';
  }

  // Convert an array of UTC timestamp strings; return as-is for UTC mode.
  function applyTz(tsArr) {
    if (state.tz === 'utc') return tsArr;
    return tsArr.map(function (ts) { return ts ? utcToBrussels(ts) : ts; });
  }

  // Format a UTC timestamp string for text display with timezone suffix.
  function formatTimeDisplay(utcTsStr) {
    var displayed = state.tz === 'brussels' ? utcToBrussels(utcTsStr) : utcTsStr;
    return displayed.replace('T', ' ').slice(0, 16) + '\u00a0' + tzShortLabel();
  }

  // ── Wind filter dependency logic ───────────────────────────────────────────
  var WIND_COMBOS = [
    { offon: 'Offshore', region: 'Federal',  grid: 'Elia' },
    { offon: 'Onshore',  region: 'Flanders', grid: 'Elia' },
    { offon: 'Onshore',  region: 'Flanders', grid: 'Dso'  },
    { offon: 'Onshore',  region: 'Wallonia', grid: 'Elia' },
    { offon: 'Onshore',  region: 'Wallonia', grid: 'Dso'  }
  ];

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
      opt.value = g; opt.textContent = g;
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
    fetch(baseUrl + '/assets/data/' + tech + '.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { cache[tech] = d; showLoading(false); callback(d); })
      .catch(function (e) { showLoading(false); showError('Could not load ' + tech + ' data: ' + e.message); });
  }

  function showLoading(on) {
    if (!el.loading) return;
    el.loading.style.display = on ? 'flex' : 'none';
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

  // ── Group key ──────────────────────────────────────────────────────────────
  function groupKey() {
    if (state.tech === 'wind') return [state.wind.offon, state.wind.region, state.wind.grid].join('|');
    return state.solar.region;
  }

  // ── Hard rectangular conditioning ──────────────────────────────────────────
  // For hovered forecast f_pu, select bins whose center falls within ±bw.
  // Start bw=0.06, widen by 0.02 until totalN ≥ COND_MIN_N or bw reaches 1.0.
  // Each selected bin contributes proportional to its sample count (no kernel weight).

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

  function getConditionedSamples(group, fMW, n) {
    var capacity = group.capacity;
    var bins     = group.cond_quantiles && group.cond_quantiles[state.forecast];
    if (!capacity || !bins || !bins.length) return null;

    var f_pu   = fMW / capacity;
    var bw     = COND_BW_START;
    var selected, totalN;
    var fallback = false;

    // Asymmetric window: cap at [0, 1] so boundary forecasts widen only inward.
    // Example: f_pu=0.9, bw=0.20 → [0.70, 1.0]; next step → [0.65, 1.0]; etc.
    while (bw <= COND_BW_MAX + 1e-9) {
      var lo = Math.max(0, f_pu - bw);
      var hi = Math.min(1, f_pu + bw);
      selected = getBinsInWindow(bins, lo, hi);
      totalN   = selected.reduce(function (s, b) { return s + b.n; }, 0);
      if (totalN >= COND_MIN_N) break;
      bw += COND_BW_STEP;
    }

    if (!selected || selected.length === 0) return null;
    if (totalN < COND_MIN_N) fallback = true;

    var samples = [];
    selected.forEach(function (bin) {
      var count = Math.max(1, Math.round(n * bin.n / totalN));
      var s = buildHistSamples(bin, fMW, capacity, count);
      for (var i = 0; i < s.length; i++) samples.push(s[i]);
    });

    if (samples.length === 0) return null;

    return {
      samples:   samples,
      bandwidth: bw,
      fallback:  fallback,
      totalN:    totalN,
      binsUsed:  selected.map(function (b) {
        return { lo: b.lo, hi: b.hi, n: b.n };
      })
    };
  }

  // ── Sample generation from histogram bins ─────────────────────────────────
  //
  // Each conditioning bin stores hist_counts: a 50-element array of error_pu
  // histogram counts over [-0.5, +0.5].  Shift each bin center by f_pu to get
  // the measured-space position, clip to [0, capacity], and draw proportional
  // samples with uniform within-bin jitter for smooth rendering.

  function buildHistSamples(histBin, fMW, capacity, n) {
    var counts    = histBin.hist_counts;
    var meta      = cache[state.tech].meta;
    var histMin   = meta.hist_min;        // -0.5
    var histMax   = meta.hist_max;        // +0.5
    var nBins     = meta.hist_n_bins;     // 50
    var histWidth = (histMax - histMin) / nBins;
    var f_pu      = fMW / capacity;

    var total = 0;
    for (var j = 0; j < counts.length; j++) total += counts[j];
    if (total === 0) return [];

    var samples = [];
    for (var j = 0; j < counts.length; j++) {
      if (counts[j] === 0) continue;
      var errCenter_pu  = histMin + (j + 0.5) * histWidth;
      var measCenter_mw = (f_pu + errCenter_pu) * capacity;
      var count = Math.max(0, Math.round(n * counts[j] / total));
      for (var k = 0; k < count; k++) {
        var jitter = (Math.random() - 0.5) * histWidth * capacity;
        samples.push(Math.max(0, Math.min(capacity, measCenter_mw + jitter)));
      }
    }
    return samples;
  }

  // ── Distribution fitting ───────────────────────────────────────────────────

  function sampleMoments(arr) {
    var n = arr.length;
    if (n < 2) return { mu: arr[0] || 0, sigma: 0 };
    var mu = 0;
    for (var i = 0; i < n; i++) mu += arr[i];
    mu /= n;
    var m2 = 0;
    for (var i = 0; i < n; i++) {
      var d = arr[i] - mu;
      m2 += d * d;
    }
    m2 /= n;
    return { mu: mu, sigma: Math.sqrt(Math.max(m2, 1e-10)) };
  }

  // Gaussian PDF — MLE, unbounded (extends beyond [0, capacity] deliberately)
  function buildGaussianCurve(samples, nPts) {
    var mom   = sampleMoments(samples);
    var mu    = mom.mu;
    var sigma = Math.max(mom.sigma, 1e-6);
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

  // ── Beta MLE via Minka's fixed-point algorithm ─────────────────────────────

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

  function fitBetaMLE(puSamples) {
    var n = puSamples.length;
    if (n < 4) return null;
    // CLIP controls the minimum pu value passed to log().  A value of 1e-7 makes
    // mean(log(x)) hyper-sensitive to even a handful of samples clamped to 0 MW
    // (log(1e-7) = -16.1), causing the MLE to produce alpha < 1 for distributions
    // that are genuinely bell-shaped.  0.005 gives log(CLIP) = -5.3, which is
    // robust to a small fraction of boundary samples while still detecting true
    // J-shaped / U-shaped distributions near the 0 or 1 pu boundaries.
    var CLIP = 0.005;
    var s1 = 0, s2 = 0, mu = 0, vv = 0;
    for (var i = 0; i < n; i++) {
      var x = Math.max(CLIP, Math.min(1 - CLIP, puSamples[i]));
      s1  += Math.log(x);
      s2  += Math.log(1 - x);
      mu  += puSamples[i];
    }
    s1 /= n; s2 /= n; mu /= n;
    for (var i = 0; i < n; i++) { var d = puSamples[i] - mu; vv += d * d; }
    vv /= n;
    mu = Math.max(0.005, Math.min(0.995, mu));
    var c0 = mu * (1 - mu) / Math.max(vv, 1e-8) - 1;
    if (c0 <= 0) c0 = 1.0;
    var alpha = mu * c0;
    var beta  = (1 - mu) * c0;
    for (var iter = 0; iter < 50; iter++) {
      var psiAB = digamma(alpha + beta);
      var aNew  = invDigamma(psiAB + s1);
      var bNew  = invDigamma(psiAB + s2);
      if (!isFinite(aNew) || !isFinite(bNew) || aNew <= 0 || bNew <= 0) break;
      var delta = Math.abs(aNew - alpha) + Math.abs(bNew - beta);
      alpha = aNew; beta = bNew;
      if (delta < 1e-9) break;
    }
    if (!isFinite(alpha) || !isFinite(beta) || alpha <= 0.01 || beta <= 0.01) return null;
    return { alpha: alpha, beta: beta };
  }

  function buildBetaCurve(samples, capacity, nPts) {
    if (!capacity || samples.length < 4) return null;
    var puSamples = samples.map(function (s) {
      return Math.max(1e-9, Math.min(1 - 1e-9, s / capacity));
    });
    var params = fitBetaMLE(puSamples);
    if (!params) return null;
    var alpha = params.alpha, beta = params.beta;

    // Midpoint grid: x = (j + 0.5) / nPts avoids evaluating at the exact
    // boundaries where alpha<1 or beta<1 produce singularities.
    //
    // Log-sum-exp normalisation: for concentrated Bell-shaped distributions
    // (e.g. Belgium solar at 0.5 pu, alpha≈beta≈67), the unnormalized PDF
    // B(alpha,beta) ≈ 2e-41 which underflows the old "sum < 1e-12" guard and
    // caused buildBetaCurve to return null even when the fit was perfect.
    // Subtracting maxLogY before exp() keeps all values in [0,1] so the sum
    // is always on the order of 1 regardless of alpha,beta magnitude.
    var dx_pu = 1.0 / nPts;
    var logYs = new Array(nPts);
    var maxLogY = -Infinity;
    for (var j = 0; j < nPts; j++) {
      var x_pu = (j + 0.5) / nPts;
      var lv = (alpha - 1) * Math.log(x_pu) + (beta - 1) * Math.log(1 - x_pu);
      logYs[j] = isFinite(lv) ? lv : -Infinity;
      if (logYs[j] > maxLogY) maxLogY = logYs[j];
    }
    if (!isFinite(maxLogY)) return null;
    var ys = new Array(nPts), sum = 0;
    for (var j = 0; j < nPts; j++) {
      var y = Math.exp(logYs[j] - maxLogY);
      ys[j] = y;
      sum += y * dx_pu;
    }
    if (sum < 1e-12) return null;
    var xs = [];
    for (var j = 0; j < nPts; j++) {
      xs.push((j + 0.5) * dx_pu * capacity);
      ys[j] /= (sum * capacity);
    }
    return { x: xs, y: ys, alpha: alpha, beta: beta };
  }

  // ── CVaR computation ───────────────────────────────────────────────────────

  // Lower-tail CVaR: average of worst alpha fraction (lowest values)
  function computeEmpiricalCVaR(samples, alpha) {
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    var k = Math.max(1, Math.ceil(sorted.length * alpha));
    var sum = 0;
    for (var i = 0; i < k; i++) sum += sorted[i];
    return sum / k;
  }

  // Upper-tail CVaR: average of worst alpha fraction (highest values)
  function computeEmpiricalCVaRUpper(samples, alpha) {
    var sorted = samples.slice().sort(function (a, b) { return b - a; });
    var k = Math.max(1, Math.ceil(sorted.length * alpha));
    var sum = 0;
    for (var i = 0; i < k; i++) sum += sorted[i];
    return sum / k;
  }

  // Sample n values from a PDF curve (xs, ys) via inverse transform sampling.
  // xs must be uniformly spaced. Used for parametric CVaR.
  function sampleFromCurve(xs, ys, n) {
    var len = xs.length;
    if (len < 2) return [];
    var dx = xs[1] - xs[0];
    var cdf = new Array(len), cum = 0;
    for (var i = 0; i < len; i++) { cum += ys[i] * dx; cdf[i] = cum; }
    var total = cdf[len - 1];
    if (total < 1e-12) return [];
    for (var i = 0; i < len; i++) cdf[i] /= total;
    var out = [];
    for (var s = 0; s < n; s++) {
      var u = Math.random(), lo = 0, hi = len - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
      if (lo === 0) { out.push(xs[0]); }
      else {
        var dC = cdf[lo] - cdf[lo - 1];
        var t  = dC < 1e-12 ? 0 : (u - cdf[lo - 1]) / dC;
        out.push(xs[lo - 1] + t * (xs[lo] - xs[lo - 1]));
      }
    }
    return out;
  }

  // Sample n values from N(mu, sigma) via Box-Muller. Used for Gaussian CVaR.
  function sampleGaussian(mu, sigma, n) {
    var out = [];
    for (var i = 0; i < n; i += 2) {
      var u1 = Math.max(1e-12, Math.random()), u2 = Math.random();
      var r  = Math.sqrt(-2 * Math.log(u1));
      out.push(mu + sigma * r * Math.cos(2 * Math.PI * u2));
      if (i + 1 < n) out.push(mu + sigma * r * Math.sin(2 * Math.PI * u2));
    }
    return out;
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

  // ── Plotly theme ───────────────────────────────────────────────────────────
  var THEME = {
    bg:          '#f8f7f5',
    surface:     '#ffffff',
    border:      '#e0ddd9',
    text:        '#1a1a1a',
    muted:       '#5a5a5a',
    accent:      '#1c3d5a',
    accentLight: '#2a5580',
    wind:        '#1c3d5a',
    solar:       '#c47a1e',
    gauss:       'rgba(185,90,20,0.88)',
    beta:        'rgba(20,120,100,0.90)',
    infeasible:  'rgba(192,57,43,0.07)',
    boundLine:   '#b03a2e',
    forecastLine:'#2a5580',
    fontFamily:  'IBM Plex Sans, system-ui, sans-serif'
  };

  var PLOTLY_CONFIG = {
    responsive:  true,
    displaylogo: false,
    showTips:    false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines',
                             'hoverCompareCartesian', 'hoverClosestCartesian']
  };

  function distResetButton() {
    return {
      name: 'resetView', title: 'Reset axes', icon: Plotly.Icons.home,
      click: function () {
        var activeIdx = state.lockedIdx >= 0 ? state.lockedIdx : state.hoveredIdx;
        if (activeIdx >= 0) updateDistribution(activeIdx);
      }
    };
  }
  var PLOTLY_CONFIG_DIST = {
    responsive:  true,
    displaylogo: false,
    showTips:    false,
    doubleClick: false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'resetScale2d',
                             'toggleSpikelines', 'hoverCompareCartesian', 'hoverClosestCartesian'],
    modeBarButtonsToAdd: [distResetButton()]
  };

  function baseLayout(overrides) {
    var layout = {
      paper_bgcolor: THEME.bg,
      plot_bgcolor:  THEME.surface,
      font:    { family: THEME.fontFamily, size: 12, color: THEME.muted },
      legend:  { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0, font: { size: 11 } },
      shapes:  [],
      autosize: true
    };
    Object.keys(overrides).forEach(function (k) { layout[k] = overrides[k]; });
    return layout;
  }

  function axisBase(extra) {
    var a = {
      gridcolor: THEME.border,
      linecolor: THEME.border,
      tickcolor: THEME.border,
      tickfont:  { size: 11 },
      zeroline:  false
    };
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return a;
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

    var N_SAMPLES  = 2000;
    var N_CURVE    = 300;
    var CVAR_ALPHA = 0.05;
    var N_CVAR     = 10000;

    var cacheKey = groupKey() + '|' + state.forecast + '|' + idx + '|' + (state.showApprox ? '1' : '0');
    var cached   = sampleCache[cacheKey];
    if (!cached) {
      var condResult = getConditionedSamples(group, fMW, N_SAMPLES);
      if (!condResult) {
        if (el.distLabel) el.distLabel.textContent = 'Distribution — no historical data available';
        updateMetrics({
          time: ts[idx] ? formatTimeDisplay(ts[idx]) : null,
          fMW: fMW, mMW: measured[idx], capacity: capacity,
          cvarLo: { emp: null, gauss: null, beta: null },
          cvarHi: { emp: null, gauss: null, beta: null }
        });
        return;
      }
      var _samples    = condResult.samples;
      var _gaussCurve = state.showApprox ? buildGaussianCurve(_samples, N_CURVE) : null;
      var _betaCurve  = state.showApprox ? buildBetaCurve(_samples, capacity, N_CURVE) : null;
      var _gSamples   = _gaussCurve ? sampleGaussian(_gaussCurve.mu, _gaussCurve.sigma, N_CVAR) : null;
      var _bSamples   = _betaCurve  ? sampleFromCurve(_betaCurve.x, _betaCurve.y, N_CVAR)       : null;
      cached = {
        samples:     _samples,
        gaussCurve:  _gaussCurve,
        betaCurve:   _betaCurve,
        cvarEmpLo:   computeEmpiricalCVaR(_samples, CVAR_ALPHA),
        cvarEmpHi:   computeEmpiricalCVaRUpper(_samples, CVAR_ALPHA),
        cvarGaussLo: _gSamples ? computeEmpiricalCVaR(_gSamples, CVAR_ALPHA)      : null,
        cvarGaussHi: _gSamples ? computeEmpiricalCVaRUpper(_gSamples, CVAR_ALPHA) : null,
        cvarBetaLo:  _bSamples ? computeEmpiricalCVaR(_bSamples, CVAR_ALPHA)      : null,
        cvarBetaHi:  _bSamples ? computeEmpiricalCVaRUpper(_bSamples, CVAR_ALPHA) : null
      };
      sampleCache[cacheKey] = cached;
    }

    var samples     = cached.samples;
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

    var color = state.tech === 'wind' ? THEME.wind : THEME.solar;

    // X-axis range
    var xMin = -0.08 * capacity;
    var xMax =  1.08 * capacity;
    if (gaussCurve) {
      xMin = Math.min(xMin, gaussCurve.x[0]);
      xMax = Math.max(xMax, gaussCurve.x[gaussCurve.x.length - 1]);
    }

    // Explicit bin size for stable histogram rendering across hover updates
    var binSize = capacity > 0 ? capacity / 50 : 1;

    // Build traces
    var traces = [];

    traces.push({
      x:        samples,
      type:     'histogram',
      histnorm: 'probability density',
      xbins:    { start: 0, end: capacity, size: binSize },
      name:     'Empirical',
      marker:   { color: color, opacity: 0.70, line: { color: THEME.bg, width: 0.4 } },
      hovertemplate: '%{x:.0f} MW<extra></extra>'
    });

    if (gaussCurve) {
      traces.push({
        x: gaussCurve.x, y: gaussCurve.y,
        type: 'scatter', mode: 'lines',
        name: 'Gaussian',
        line: { color: THEME.gauss, width: 2.5 },
        hovertemplate: '%{x:.0f} MW<extra></extra>'
      });
    }

    if (betaCurve) {
      traces.push({
        x: betaCurve.x, y: betaCurve.y,
        type: 'scatter', mode: 'lines',
        name: 'Beta',
        line: { color: THEME.beta, width: 2 },
        hovertemplate: '%{x:.0f} MW<extra></extra>'
      });
    }

    // EXTENSION POINT: addCustomOverlays(traces, samples, fMW, capacity);

    // Restore legend visibility
    traces.forEach(function (t) {
      if (savedVis[t.name]) t.visible = 'legendonly';
    });

    // y-axis range: based on histogram peak only.
    // The Gaussian and Beta curves can peak higher (narrow sigma near boundaries)
    // and including them in yMax made the histogram bars invisible. Curves that
    // exceed yMax are simply clipped at the top by Plotly.
    var histBins = {};
    for (var si = 0; si < samples.length; si++) {
      var bIdx = Math.floor(samples[si] / binSize);
      histBins[bIdx] = (histBins[bIdx] || 0) + 1;
    }
    var histKeys = Object.keys(histBins);
    var histPeak = 0;
    for (var hi = 0; hi < histKeys.length; hi++) {
      var density = histBins[histKeys[hi]] / (samples.length * binSize);
      if (density > histPeak) histPeak = density;
    }
    var yMax = histPeak > 1e-6 ? histPeak * 1.35 : 0.01;

    var layout = baseLayout({
      margin:    { t: 16, r: 20, b: 52, l: 64 },
      barmode:   'overlay',
      hovermode: false,
      xaxis: axisBase({
        title: { text: 'Generation (MW)', font: { size: 11 } },
        range: [xMin, xMax],
        zeroline: false
      }),
      yaxis: axisBase({
        title:    { text: 'Probability density', font: { size: 11 } },
        range:    [0, yMax],
        zeroline: false, showgrid: true
      })
    });

    // Infeasible region shading
    layout.shapes.push(
      { type: 'rect', layer: 'below', x0: xMin, x1: 0,        yref: 'paper', y0: 0, y1: 1,
        fillcolor: THEME.infeasible, line: { width: 0 } },
      { type: 'rect', layer: 'below', x0: capacity, x1: xMax, yref: 'paper', y0: 0, y1: 1,
        fillcolor: THEME.infeasible, line: { width: 0 } }
    );

    // Physical bounds and forecast reference
    layout.shapes.push(
      { type: 'line', x0: 0,        x1: 0,        yref: 'paper', y0: 0, y1: 1,
        line: { color: THEME.boundLine, width: 2 } },
      { type: 'line', x0: capacity, x1: capacity, yref: 'paper', y0: 0, y1: 1,
        line: { color: THEME.boundLine, width: 2 } },
      { type: 'line', x0: fMW, x1: fMW, yref: 'paper', y0: 0, y1: 1,
        line: { color: THEME.forecastLine, dash: 'dot', width: 1.5 } }
    );

    layout.annotations = [
      { xref: 'x', x: 0,        yref: 'paper', y: 1.0, yanchor: 'top', xanchor: 'right',
        text: '<b>0 MW</b>', showarrow: false,
        font: { size: 10, color: THEME.boundLine }, bgcolor: 'rgba(248,247,245,0.85)' },
      { xref: 'x', x: capacity, yref: 'paper', y: 1.0, yanchor: 'top', xanchor: 'left',
        text: '<b>Capacity</b>', showarrow: false,
        font: { size: 10, color: THEME.boundLine }, bgcolor: 'rgba(248,247,245,0.85)' },
      { xref: 'x', x: fMW,      yref: 'paper', y: 0.97, yanchor: 'top', xanchor: 'center',
        text: 'Forecast', showarrow: false,
        font: { size: 9, color: THEME.forecastLine }, bgcolor: 'rgba(248,247,245,0.82)' }
    ];

    // Measured value marker (shown only when a non-null measured value exists)
    var mMW_dist = measured[idx];
    if (mMW_dist !== null && mMW_dist !== undefined) {
      layout.shapes.push({
        type: 'line', x0: mMW_dist, x1: mMW_dist, yref: 'paper', y0: 0, y1: 1,
        line: { color: '#7c3aed', width: 1.5 }
      });
      layout.annotations.push({
        xref: 'x', x: mMW_dist, yref: 'paper', y: 0.90, yanchor: 'top', xanchor: 'center',
        text: 'Measured', showarrow: false,
        font: { size: 9, color: '#7c3aed' }, bgcolor: 'rgba(248,247,245,0.82)'
      });
    }

    Plotly.react(el.panelDist, traces, layout, PLOTLY_CONFIG_DIST);

    if (el.panelDist.removeAllListeners) el.panelDist.removeAllListeners('plotly_doubleclick');
    el.panelDist.on('plotly_doubleclick', function () {
      var activeIdx = state.lockedIdx >= 0 ? state.lockedIdx : state.hoveredIdx;
      if (activeIdx >= 0) updateDistribution(activeIdx);
    });

    // Update label
    var timeStr = ts[idx] ? formatTimeDisplay(ts[idx]) : '—';
    if (el.distLabel) el.distLabel.textContent = 'Distribution at ' + timeStr;

    // Update metrics panel
    var mMW = measured[idx];
    updateMetrics({
      time: ts[idx] ? formatTimeDisplay(ts[idx]) : null, fMW: fMW, mMW: mMW, capacity: capacity,
      cvarLo: { emp: cvarEmpLo, gauss: cvarGaussLo, beta: cvarBetaLo },
      cvarHi: { emp: cvarEmpHi, gauss: cvarGaussHi, beta: cvarBetaHi }
    });
  }

  // ── Bottom panel: 15-min trajectory ────────────────────────────────────────
  function renderTrajectory(group) {
    var recent   = group.recent;
    var capacity = group.capacity || 0;
    var color    = state.tech === 'wind' ? THEME.wind : THEME.solar;
    var fcField  = FORECAST_FIELDS[state.forecast];
    var fcLabel  = FORECAST_LABELS[state.forecast];
    var ts        = recent.timestamps || [];
    var tsDisplay = applyTz(ts);                // converted to selected timezone for display
    var measured  = recent.measured   || [];
    var forecast  = recent[fcField]   || [];
    var mValid    = measured.filter(function (v) { return v !== null && v !== undefined; });
    var yMax      = Math.max(capacity, mValid.length ? Math.max.apply(null, mValid) : 0) * 1.10;

    var layout = baseLayout({
      margin:    { t: 16, r: 16, b: 52, l: 64 },
      xaxis:     axisBase({ type: 'date', dtick: 86400000, tickformat: '%b %d',
                            tickangle: -30, title: { text: tzShortLabel(), font: { size: 10 }, standoff: 2 } }),
      yaxis:     axisBase({
        title:    { text: 'MW', font: { size: 11 } },
        range:    [0, yMax],
        zeroline: true, zerolinecolor: THEME.border
      }),
      hovermode: 'x unified'
    });

    if (capacity > 0) {
      layout.shapes.push({
        type: 'line', xref: 'paper', x0: 0, x1: 1,
        yref: 'y', y0: capacity, y1: capacity,
        line: { color: THEME.boundLine, dash: 'dot', width: 1, opacity: 0.6 }
      });
      layout.annotations = [{
        xref: 'paper', x: 0.01, xanchor: 'left',
        yref: 'y', y: capacity, yanchor: 'bottom',
        text: 'Capacity', showarrow: false,
        font: { size: 9, color: THEME.boundLine }
      }];
    }

    Plotly.react(el.panelTraj, [
      { x: tsDisplay, y: measured, type: 'scatter', mode: 'lines', name: 'Measured',
        line: { color: color, width: 1.5 },
        hovertemplate: '%{x|%b %d %H:%M} ' + tzShortLabel() + '<br>Measured: %{y:.0f} MW<extra></extra>' },
      { x: tsDisplay, y: forecast, type: 'scatter', mode: 'lines', name: fcLabel,
        line: { color: color, width: 1.5, dash: 'dot' }, opacity: 0.55,
        hovertemplate: '%{x|%b %d %H:%M} ' + tzShortLabel() + '<br>' + fcLabel + ': %{y:.0f} MW<extra></extra>' }
    ], layout, PLOTLY_CONFIG);

    if (el.panelTraj.removeAllListeners) {
      el.panelTraj.removeAllListeners('plotly_hover');
      el.panelTraj.removeAllListeners('plotly_click');
    }

    el.panelTraj.on('plotly_hover', function (evt) {
      if (!evt.points || !evt.points.length) return;
      if (state.lockedIdx >= 0) return;
      state.hoveredIdx = evt.points[0].pointIndex;
      updateDistribution(state.hoveredIdx);
    });

    el.panelTraj.on('plotly_click', function (evt) {
      if (!evt.points || !evt.points.length) return;
      var clickIdx = evt.points[0].pointIndex;
      if (state.lockedIdx >= 0) {
        state.lockedIdx = -1;
        removeLockMarker();
        updateLockLabel(false);
      } else {
        state.lockedIdx = clickIdx;
        state.hoveredIdx = clickIdx;
        updateDistribution(clickIdx);
        showLockMarker(clickIdx, tsDisplay, measured, forecast, color);
        updateLockLabel(true);
      }
    });

    var initIdx = ts.length > 0 ? ts.length - 1 : 0;
    if (state.hoveredIdx < 0) state.hoveredIdx = initIdx;
    updateDistribution(state.hoveredIdx);
  }

  // ── Lock marker on trajectory ──────────────────────────────────────────────
  function showLockMarker(idx, tsDisplay, measured, forecast, color) {
    if (!el.panelTraj || !el.panelTraj.data) return;
    var mVal = measured[idx], fVal = forecast[idx];
    Plotly.addTraces(el.panelTraj, {
      x: [tsDisplay[idx]], y: [mVal != null ? mVal : fVal],
      type: 'scatter', mode: 'markers',
      marker: { color: '#7c3aed', size: 10, symbol: 'circle', line: { color: '#fff', width: 2 } },
      name: 'Locked', showlegend: false, hoverinfo: 'skip'
    });
  }

  function removeLockMarker() {
    if (!el.panelTraj || !el.panelTraj.data) return;
    if (el.panelTraj.data.length > 2) Plotly.deleteTraces(el.panelTraj, el.panelTraj.data.length - 1);
  }

  function updateLockLabel(locked) {
    if (!el.distLabel) return;
    var text = el.distLabel.textContent.replace(/\s*\u2014\s*Locked$/, '');
    if (locked) text += ' \u2014 Locked';
    el.distLabel.textContent = text;
  }

  // ── Metrics panel ─────────────────────────────────────────────────────────
  function updateMetrics(m) {
    if (!el.metricsPanel) return;

    var fmt = function (v) {
      return v !== null && v !== undefined && isFinite(v) ? v.toFixed(1) : '—';
    };
    // Show parametric CVaR as "X.X MW" with difference vs empirical expressed
    // as percentage of capacity, so Gaussian and Beta deviations are always
    // comparable on the same scale regardless of operating point.
    var fmtModel = function (model, emp, capacity) {
      if (model === null || !isFinite(model)) return '—';
      var mwStr = model.toFixed(1) + '\u00a0MW';
      var deltaStr = null;
      if (emp !== null && isFinite(emp) && capacity && capacity > 0) {
        var diff = model - emp;
        var pct  = (diff / capacity) * 100;
        var sign = diff >= 0 ? '+' : '';
        deltaStr = sign + diff.toFixed(1) + '\u00a0MW\u00a0\u00b7\u00a0' + sign + pct.toFixed(1) + '%\u00a0cap';
      }
      if (deltaStr) {
        return '<span class="fm-val-mw">' + mwStr + '</span>' +
               '<span class="fm-val-delta">' + deltaStr + '</span>';
      }
      return mwStr;
    };

    if (el.fmTime)     el.fmTime.textContent      = m.time || '—';
    if (el.fmForecast) el.fmForecast.textContent  = m.fMW.toFixed(0) + ' MW';
    if (el.fmMeasured) el.fmMeasured.textContent  = (m.mMW !== null && m.mMW !== undefined) ? m.mMW.toFixed(0) + ' MW' : '—';
    if (el.fmCapacity) el.fmCapacity.textContent   = m.capacity.toFixed(0) + ' MW';

    // Lower tail
    if (el.fmCvarEmpL)   el.fmCvarEmpL.textContent   = fmt(m.cvarLo.emp);
    if (el.fmCvarGaussL) el.fmCvarGaussL.innerHTML = fmtModel(m.cvarLo.gauss, m.cvarLo.emp, m.capacity);
    if (el.fmCvarBetaL)  el.fmCvarBetaL.innerHTML  = fmtModel(m.cvarLo.beta,  m.cvarLo.emp, m.capacity);

    // Upper tail
    if (el.fmCvarEmpH)   el.fmCvarEmpH.textContent  = fmt(m.cvarHi.emp);
    if (el.fmCvarGaussH) el.fmCvarGaussH.innerHTML = fmtModel(m.cvarHi.gauss, m.cvarHi.emp, m.capacity);
    if (el.fmCvarBetaH)  el.fmCvarBetaH.innerHTML  = fmtModel(m.cvarHi.beta,  m.cvarHi.emp, m.capacity);
  }

  // ── Provenance strip — source + historical interval only ───────────────────
  function updateStats(data) {
    if (!el.stats) return;
    var meta = data && data.meta;
    if (el.statSource) {
      var src = ((meta && meta.source) || 'Elia Open Data Platform').replace(/\s*\(ODS\d+\)/, '');
      var text = 'Source: ' + src;
      if (meta) {
        text += '\u00a0\u00b7\u00a0hist.\u00a0' + meta.hist_start + '\u2013' + meta.hist_end;
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
          text += '\u00a0\u00b7\u00a0Latest\u00a0measurement:\u00a0' + formatTimeDisplay(latestTs);
        }
      }
      el.statSource.textContent = text;
    }
    el.stats.style.display = 'flex';
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function render(resetHover) {
    if (resetHover !== false) { state.hoveredIdx = -1; state.lockedIdx = -1; }
    sampleCache = {};
    clearError();
    loadData(state.tech, function (data) {
      var gk    = groupKey();
      var group = data.groups && data.groups[gk];
      if (!group || !group.recent) {
        showError('No data for the selected combination.');
        return;
      }
      updateStats(data);
      renderTrajectory(group);
    });
  }

  // ── Event handlers ─────────────────────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll('[data-tech]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-tech]').forEach(function (b) { b.classList.remove('fc-tab--active'); });
        btn.classList.add('fc-tab--active');
        state.tech = btn.dataset.tech;
        el.windFilters.style.display  = state.tech === 'wind'  ? 'flex' : 'none';
        el.solarFilters.style.display = state.tech === 'solar' ? 'flex' : 'none';
        render();
      });
    });

    document.querySelectorAll('[data-forecast]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-forecast]').forEach(function (b) { b.classList.remove('fc-tab--active'); });
        btn.classList.add('fc-tab--active');
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
        opt.value = g; opt.textContent = g;
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
      if (el.tzBrussels) el.tzBrussels.classList.toggle('fc-tz-btn--active', tz === 'brussels');
      if (el.tzUtc)      el.tzUtc.classList.toggle('fc-tz-btn--active',      tz === 'utc');
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

  // ── Info icon tooltip (fixed-position, escapes overflow:hidden) ────────────
  function initTooltips() {
    var tip = document.createElement('div');
    tip.className = 'fm-tooltip';
    document.body.appendChild(tip);

    document.querySelectorAll('.fm-info').forEach(function (icon) {
      function show(e) {
        tip.textContent = icon.dataset.tooltip || '';
        tip.style.display = 'block';
        position(e.target || icon);
      }
      function position(target) {
        var rect = target.getBoundingClientRect();
        var tipH = tip.offsetHeight || 80;
        var top  = rect.top - tipH - 8;
        var left = rect.left + rect.width / 2 - 110;
        if (top < 8) top = rect.bottom + 8;
        tip.style.top  = top + 'px';
        tip.style.left = Math.max(8, left) + 'px';
      }
      function hide() { tip.style.display = 'none'; }

      icon.addEventListener('mouseenter', show);
      icon.addEventListener('mouseleave', hide);
      icon.addEventListener('focus',      show);
      icon.addEventListener('blur',       hide);
    });
  }

  // ── Guide callout dismiss ──────────────────────────────────────────────────
  function initGuide() {
    var guide = document.getElementById('fc-guide');
    var close = document.getElementById('fc-guide-close');
    if (!guide) return;
    close.addEventListener('click', function () {
      guide.hidden = true;
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (!document.getElementById('forecast-distribution')) return;
    if (typeof Plotly === 'undefined') { setTimeout(init, 200); return; }
    getEls();
    syncWindFilters();
    bindEvents();
    initTooltips();
    initGuide();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
