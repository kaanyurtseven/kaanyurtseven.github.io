/*! uncertainty-field.js v1.1.0 - the particle engine of the uncertainty field on the home page.
 *
 * Vanilla JS, no dependencies, one IIFE: window.UncertaintyField. Data: hero-shapes.json.
 *
 * Every particle has two fixed ranks (u, v) from a deterministic two-dimensional
 * low-discrepancy set. The particles ARE the shape:
 *   area layout  x = Q(u), y = v * kappa * f(Q(u)): they fill the area under the density
 *                uniformly; atoms at a wall become compact piles of the same area. A column
 *                height belongs to the particle's rank, never to its drifted position, so
 *                the gentle drift never makes a particle jump at a density step;
 *   cloud layout x = F_forecast^-1(u), y = Q(v | x): the correlated forecast-outcome cloud.
 * Area-to-area morphs are rank-preserving displacement interpolations,
 * x_s(u) = (1 - s) Q_a(u) + s Q_b(u), whose density 1 / ((1 - s) / f_a + s / f_b) sets the
 * heights, so the filled area is exact in every frame (with the stagger, its own stretch
 * term is added, see _morphAA). Nothing is drawn that is not a particle or derived from the
 * particles of the same frame (the optional Gaussian ghost is moment-matched to them).
 *
 * Motion: one shared clock (one requestAnimationFrame loop) for every field, at most
 * 30 fps while anything morphs and 10 fps while all rest; stops when paused, off-screen and
 * in a hidden tab; under prefers-reduced-motion one complete still is drawn and no loop
 * runs. The pause choice lives in localStorage 'ky-motion' (the page wires its button
 * through UncertaintyField.motion). Positions are a pure function of each field's local
 * time, so the same seed and the same calls give the same frames.
 *
 * Rendering: a built-in canvas 2D renderer (DPR-aware; one path of discs per field by
 * default, or a pre-rendered soft sprite through drawImage), or the page's own draw
 * callback, which receives typed arrays of normalized and pixel positions; an affine
 * transform places a field on an oblique panel. toSVG() exports the current frame.
 */
(function (global) {
  'use strict';

  var VERSION = '1.1.0';
  var doc = global.document;
  var MOTION_KEY = 'ky-motion';
  var GRID = 2048;                      // display grid: cells of 1/2048 over [0, 1]
  var FRAME_MS = 1000 / 30;             // the 30 fps cap
  var TWO_PI = 2 * Math.PI;
  var DRIFT_RANKS = 16;                 // horizontal wander never exceeds this many ranks
  // R2 sequence (Roberts): 1 / rho and 1 / rho^2, rho = plastic number.
  var R2A = 0.7548776662466927, R2B = 0.5698402909980532;
  var ROOT2 = Math.SQRT2;

  /* ───────────────────────────── utilities ───────────────────────────── */

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function frac(x) { return x - Math.floor(x); }
  // sin for the drift: range reduction to [-pi/2, pi/2] and the Taylor series to x^9
  // (|error| < 4e-6, plain arithmetic, so it is deterministic and about four times cheaper).
  var HALF_PI = Math.PI / 2;
  function fsin(x) {
    x -= 6.283185307179586 * Math.round(x / 6.283185307179586);
    if (x > HALF_PI) x = Math.PI - x; else if (x < -HALF_PI) x = -Math.PI - x;
    var x2 = x * x;
    return x * (1 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * 2.755731922398589e-6))));
  }
  function smooth5(p) { return p * p * p * (p * (p * 6 - 15) + 10); }            // smootherstep
  function smooth5d(p) { var q = p * (1 - p); return 30 * q * q; }               // its derivative
  function fmix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B);
    h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35);
    h ^= h >>> 16; return h >>> 0;
  }
  // Deterministic uniform in [0, 1) from (seed, i, k).
  function hash01(seed, i, k) {
    return fmix32(Math.imul(seed + 0x632BE5AB, 0x9E3779B1) ^ Math.imul(i + 1, 0x85EBCA77) ^ Math.imul(k + 1, 0xC2B2AE3D)) / 4294967296;
  }
  var B64 = (function () {
    var t = new Uint8Array(128), s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var i = 0; i < s.length; i++) t[s.charCodeAt(i)] = i;
    return t;
  })();
  // base64 of little-endian uint16 -> Uint16Array (byte order fixed, independent of the CPU)
  function decodeU16(str) {
    var len = str.length, pad = str.charAt(len - 1) === '=' ? (str.charAt(len - 2) === '=' ? 2 : 1) : 0;
    var nbytes = (len * 3 >> 2) - pad, bytes = new Uint8Array(nbytes), j = 0, i, n;
    for (i = 0; i < len; i += 4) {
      n = (B64[str.charCodeAt(i)] << 18) | (B64[str.charCodeAt(i + 1)] << 12) |
        (B64[str.charCodeAt(i + 2)] << 6) | B64[str.charCodeAt(i + 3)];
      if (j < nbytes) bytes[j++] = (n >>> 16) & 255;
      if (j < nbytes) bytes[j++] = (n >>> 8) & 255;
      if (j < nbytes) bytes[j++] = n & 255;
    }
    var out = new Uint16Array(nbytes >> 1);
    for (i = 0; i < out.length; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    return out;
  }
  // Standard normal quantile (Acklam's rational approximation, relative error < 1.2e-9).
  function normInv(p) {
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
    var b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    var c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    var d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    var q, r;
    if (p < 0.02425) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - 0.02425) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function assign(dst) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) dst[k] = s[k];
    }
    return dst;
  }
  function store(key, value) {
    try { if (value === null) global.localStorage.removeItem(key); else global.localStorage.setItem(key, value); } catch (e) { /* storage blocked: this page only */ }
  }
  function load(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function mq(q) { return global.matchMedia ? global.matchMedia(q) : { matches: false }; }
  function onMQ(m, fn) { if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn); }

  /* ──────────────────────────────── shapes ──────────────────────────────── */

  // One parsed hero-shapes.json, with its decoded tables cached on it (shared by every field).
  function Shapes(json) {
    if (!json || json.schema !== 1 || !json.states) throw new Error('UncertaintyField: hero-shapes.json (schema 1) expected');
    this.json = json;
    this.meta = json.meta;
    this.techs = json.techs;
    this.ids = Object.keys(json.states);
    this._area = {};
    this._cloud = {};
  }
  function shapesOf(x) {
    if (x instanceof Shapes) return x;
    if (x && x.__ufShapes) return x.__ufShapes;
    var s = new Shapes(x);
    try { Object.defineProperty(x, '__ufShapes', { value: s }); } catch (e) { /* frozen: no cache */ }
    return s;
  }
  Shapes.prototype.state = function (id) {
    var s = this.json.states[id];
    if (!s) throw new Error('UncertaintyField: unknown state "' + id + '"');
    return s;
  };

  // The display distribution of an area state on GRID cells: the continuous density from the
  // 512-cell table (normalized to 1 - p0 - p1) plus each wall atom spread as a uniform pile
  // against its wall, stacked on the density there (same density scale, so its area is the
  // atom's probability). Pile rule: the pile is the narrowest width w in
  // [pile.min, pile.max] pu for which the density under it plus p / w stays at or below
  // pile.height times the shape's own continuous peak; if even pile.max is too narrow, it is
  // pile.max wide and taller (a pile never gets wider than pile.max).
  Shapes.prototype.area = function (id, pile) {
    var key = id + '|' + pile.height + '|' + pile.min + '|' + pile.max;
    if (this._area[key]) return this._area[key];
    var st = this.state(id);
    if (st.kind !== 'area') throw new Error('UncertaintyField: "' + id + '" is not an area state');
    var t = decodeU16(st.dens), n = t.length, ratio = GRID / n, tot = 0, k;
    for (k = 0; k < n; k++) tot += t[k];
    var p0 = +st.p0 || 0, p1 = +st.p1 || 0, pc = 1 - p0 - p1;
    var dens = new Float64Array(GRID), cpeak = 0;
    for (k = 0; k < GRID; k++) {
      dens[k] = tot > 0 ? t[(k / ratio) | 0] / tot * n * pc : 0;
      if (dens[k] > cpeak) cpeak = dens[k];
    }
    if (!(cpeak > 0)) cpeak = 1;
    var piles = [0, 0];
    function addPile(p, side) {
      if (!(p > 0)) return;
      var cmin = Math.max(1, Math.round(pile.min * GRID)), cmax = Math.max(cmin, Math.round(pile.max * GRID));
      var cap = pile.height * cpeak, cells = cmin, under = 0, c;
      for (c = 0; c < cmin; c++) under = Math.max(under, dens[side ? GRID - 1 - c : c]);
      while (cells < cmax && under + p / (cells / GRID) > cap) {
        under = Math.max(under, dens[side ? GRID - 1 - cells : cells]);
        cells++;
      }
      var add = p / (cells / GRID);
      for (c = 0; c < cells; c++) dens[side ? GRID - 1 - c : c] += add;
      piles[side] = cells / GRID;
    }
    addPile(p0, 0); addPile(p1, 1);
    var cdf = new Float64Array(GRID + 1);
    for (k = 0; k < GRID; k++) cdf[k + 1] = cdf[k] + dens[k] / GRID;
    var total = cdf[GRID], peak = 0, f32 = new Float32Array(GRID);
    for (k = 0; k < GRID; k++) { dens[k] /= total; f32[k] = dens[k]; if (dens[k] > peak) peak = dens[k]; }
    for (k = 0; k <= GRID; k++) cdf[k] /= total;
    cdf[GRID] = 1;
    var A = { id: id, tech: st.tech, dens: f32, cdf: cdf, peak: peak, floor: peak * 1e-4, p0: p0, p1: p1,
      pile0: piles[0], pile1: piles[1], mean: st.mean, sd: st.sd };
    this._area[key] = A;
    return A;
  };
  // Display quantile: x with cdf(x) = u, exact for the piecewise-uniform grid. Returns the
  // cell index through out[0] (for the density at x).
  function areaQuantile(A, u, out) {
    var cdf = A.cdf, lo = 0, hi = GRID, mid, m, x;
    if (u <= 0) u = 1e-12;
    if (u >= 1) u = 1 - 1e-12;
    while (hi - lo > 1) { mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid; else hi = mid; }
    m = cdf[lo + 1] - cdf[lo];
    x = (lo + (m > 0 ? (u - cdf[lo]) / m : 0)) / GRID;
    if (out) out[0] = lo;
    return x;
  }

  // The forecast-outcome cloud: forecast marginal (weights n^temper, uniform inside each
  // forecast bin) and per bin a 64-point conditional outcome quantile table.
  Shapes.prototype.cloud = function (id, temper) {
    var key = id + '|' + temper;
    if (this._cloud[key]) return this._cloud[key];
    var st = this.state(id);
    if (st.kind !== 'cloud') throw new Error('UncertaintyField: "' + id + '" is not a cloud state');
    var nb = st.bins.count, w = st.bins.width, lo = st.bins.lo, lastHi = st.bins.last_hi;
    var raw = decodeU16(st.q), nq = raw.length / nb, q = new Float32Array(raw.length), b, j;
    for (j = 0; j < raw.length; j++) q[j] = raw[j] / 65535;
    var e0 = new Float64Array(nb), e1 = new Float64Array(nb), c = new Float64Array(nb), cdf = new Float64Array(nb + 1);
    var has = new Uint8Array(nb), p0 = new Float32Array(nb), p1 = new Float32Array(nb);
    for (b = 0; b < nb; b++) {
      e0[b] = lo + b * w; e1[b] = b === nb - 1 ? lastHi : Math.min(lo + (b + 1) * w, lastHi);
      c[b] = (e0[b] + e1[b]) / 2;
      has[b] = st.n[b] > 0 ? 1 : 0;
      p0[b] = st.p0[b] || 0; p1[b] = st.p1[b] || 0;
      cdf[b + 1] = cdf[b] + (has[b] ? Math.pow(st.n[b], temper) : 0);
    }
    for (b = 0; b <= nb; b++) cdf[b] /= cdf[nb];
    var C = { id: id, tech: st.tech, nb: nb, nq: nq, q: q, e0: e0, e1: e1, c: c, cdf: cdf, has: has, p0: p0, p1: p1, vx: null, qx: null, nx: 0 };
    // Optional tail quantiles beyond the table (tail_v, q_tail). Without them the outermost
    // ranks (v < 1/(2 nq) or v > 1 - 1/(2 nq), 1.6% of the particles) are clamped onto the
    // table's first and last value, which pulls the cloud's outliers in. With them each bin
    // has one table on the merged rank grid vx (tails + midpoints).
    var tv = st.tail_v, rt = st.q_tail ? decodeU16(st.q_tail) : null;
    if (tv && tv.length && rt && rt.length === nb * tv.length) {
      var nt = tv.length, tLo = [], tHi = [], vx = [], qx, nx, o, k2;
      for (j = 0; j < nt; j++) { if (tv[j] < 0.5 / nq) tLo.push(j); else if (tv[j] > 1 - 0.5 / nq) tHi.push(j); }
      for (j = 0; j < tLo.length; j++) vx.push(tv[tLo[j]]);
      for (j = 0; j < nq; j++) vx.push((j + 0.5) / nq);
      for (j = 0; j < tHi.length; j++) vx.push(tv[tHi[j]]);
      nx = vx.length; qx = new Float32Array(nb * nx);
      for (b = 0; b < nb; b++) {
        o = b * nx; k2 = 0;
        for (j = 0; j < tLo.length; j++) qx[o + k2++] = rt[b * nt + tLo[j]] / 65535;
        for (j = 0; j < nq; j++) qx[o + k2++] = q[b * nq + j];
        for (j = 0; j < tHi.length; j++) qx[o + k2++] = rt[b * nt + tHi[j]] / 65535;
      }
      C.vx = new Float64Array(vx); C.qx = qx; C.nx = nx;
    }
    this._cloud[key] = C;
    return C;
  };
  function cloudX(C, u) {
    var cdf = C.cdf, lo = 0, hi = C.nb, mid, m;
    while (hi - lo > 1) { mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid; else hi = mid; }
    m = cdf[lo + 1] - cdf[lo];
    return C.e0[lo] + (m > 0 ? (u - cdf[lo]) / m : 0.5) * (C.e1[lo] - C.e0[lo]);
  }
  function binQ(C, b, v) {
    if (C.qx) {   // merged grid with tails: piecewise linear in v, held beyond the outermost rank
      var vx = C.vx, n = C.nx, o = b * n, lo = 0, hi = n - 1, mid;
      if (v <= vx[0]) return C.qx[o];
      if (v >= vx[n - 1]) return C.qx[o + n - 1];
      while (hi - lo > 1) { mid = (lo + hi) >> 1; if (vx[mid] <= v) lo = mid; else hi = mid; }
      return C.qx[o + lo] + (v - vx[lo]) / (vx[hi] - vx[lo]) * (C.qx[o + hi] - C.qx[o + lo]);
    }
    var f = v * C.nq - 0.5, j = Math.floor(f), t, base = b * C.nq;
    if (j < 0) return C.q[base];
    if (j >= C.nq - 1) return C.q[base + C.nq - 1];
    t = f - j;
    return C.q[base + j] + t * (C.q[base + j + 1] - C.q[base + j]);
  }
  // Outcome at forecast x and rank v: displacement interpolation between the two nearest
  // forecast bins with data; wall atoms spread over a thin band (band, in field heights).
  function cloudY(C, x, v, band) {
    var b = clamp(Math.floor((x - C.e0[0]) / (C.e1[0] - C.e0[0])), 0, C.nb - 1), a, t, y, z0, z1;
    while (b > 0 && !C.has[b]) b--;
    while (b < C.nb - 1 && !C.has[b]) b++;
    a = x < C.c[b] ? b - 1 : b + 1;
    if (a < 0 || a >= C.nb || !C.has[a]) { y = binQ(C, b, v); z0 = C.p0[b]; z1 = C.p1[b]; }
    else {
      t = clamp((x - C.c[b]) / (C.c[a] - C.c[b]), 0, 1);
      y = (1 - t) * binQ(C, b, v) + t * binQ(C, a, v);
      z0 = (1 - t) * C.p0[b] + t * C.p0[a]; z1 = (1 - t) * C.p1[b] + t * C.p1[a];
    }
    if (z0 > 0 && v < z0) y = Math.max(y, band * v / z0);
    if (z1 > 0 && v > 1 - z1) y = Math.min(y, 1 - band * (1 - v) / z1);
    return clamp(y, 0, 1);
  }

  /* ─────────────────────────────── particles ─────────────────────────────── */

  function reverseBits(x) {
    x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
    x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
    x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4);
    x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
    return ((x >>> 16) | (x << 16)) >>> 0;
  }
  // Nested uniform (Owen) scramble of a base-2 radical inverse, hash-based (Laine-Karras
  // permutation with Vegdahl's constants): owenVdc(i) = reverse(lk(i)) / 2^32.
  function lkHash(x, seed) {
    x = (x ^ Math.imul(x, 0x3d20adea)) >>> 0;
    x = (x + seed) >>> 0;
    x = Math.imul(x, (seed >>> 16) | 1) >>> 0;
    x = (x ^ Math.imul(x, 0x05526c56)) >>> 0;
    x = (x ^ Math.imul(x, 0x53a22864)) >>> 0;
    return x;
  }
  function owenVdc(i, seed) { return reverseBits(lkHash(i >>> 0, seed >>> 0)) / 4294967296; }
  // Sobol' second dimension (primitive polynomial x + 1): direction numbers v_k = v_{k-1} ^ (v_{k-1} >> 1).
  var SOBOL2 = (function () { var v = new Uint32Array(32), k; v[0] = 0x80000000; for (k = 1; k < 32; k++) v[k] = (v[k - 1] ^ (v[k - 1] >>> 1)) >>> 0; return v; })();
  function sobol2(i) { var x = 0, k = 0; while (i) { if (i & 1) x ^= SOBOL2[k]; i >>>= 1; k++; } return x >>> 0; }
  function owenSobol2(i, seed) { return reverseBits(lkHash(reverseBits(sobol2(i)), seed >>> 0)) / 4294967296; }

  // 2-D point sets (n points, [a, b] in [0, 1)^2), selected by the `ranks` option.
  function rankPoints(n, seed, kind) {
    var pts = new Array(n), i, r1 = hash01(seed, 0, 1), r2 = hash01(seed, 0, 2);
    var s1 = fmix32(seed * 2 + 1), s2 = fmix32(seed * 2 + 2);
    for (i = 0; i < n; i++) {
      if (kind === 'r2') pts[i] = [frac(r1 + (i + 1) * R2A), frac(r2 + (i + 1) * R2B), i];
      else if (kind === 'jr2') {
        // R2 with each point jittered inside its own lattice cell (about 1/sqrt(n) across)
        var c = 0.7 / Math.sqrt(n);
        pts[i] = [frac(r1 + (i + 1) * R2A + c * (hash01(seed, i, 21) - 0.5)), frac(r2 + (i + 1) * R2B + c * (hash01(seed, i, 22) - 0.5)), i];
      } else if (kind === 'hammersley') pts[i] = [(i + 0.5) / n, owenVdc(i, s1), i];
      else pts[i] = [owenVdc(i, s1), owenSobol2(i, s2), i];     // 'sobol': scrambled Sobol' (0,2)-sequence
    }
    return pts;
  }

  // Fixed ranks: n points of a scrambled two-dimensional low-discrepancy set, sorted by their
  // first coordinate; particle i gets u = (i + 0.5) / n exactly and keeps that point's second
  // coordinate as v. Particles are stored in rank order (index = rank).
  function makeParticles(n, seed, kind) {
    var pts = rankPoints(n, seed, kind || 'sobol'), i;
    pts.sort(function (p, q) { return p[0] - q[0] || p[2] - q[2]; });
    var P = { n: n, u: new Float32Array(n), v: new Float32Array(n),
      wx: new Float32Array(n), wy: new Float32Array(n), fx: new Float32Array(n), fy: new Float32Array(n) };
    for (i = 0; i < n; i++) {
      P.u[i] = (i + 0.5) / n;
      P.v[i] = pts[i][1];
      // drift: each particle on two slow sinusoids, periods 14-40 s, independent phases
      P.wx[i] = TWO_PI / (14 + 26 * hash01(seed, i, 11));
      P.wy[i] = TWO_PI / (14 + 26 * hash01(seed, i, 12));
      P.fx[i] = TWO_PI * hash01(seed, i, 13);
      P.fy[i] = TWO_PI * hash01(seed, i, 14);
    }
    return P;
  }
  // Ghost particles: their own scrambled Sobol' pairs (another seed), as standard normal scores.
  function makeGhost(n, seed) {
    var G = { n: n, z1: new Float32Array(n), z2: new Float32Array(n), v: new Float32Array(n), pdf: new Float32Array(n) };
    var pts = rankPoints(n, seed, 'sobol'), i, a, b;
    for (i = 0; i < n; i++) {
      a = clamp(pts[i][0], 1e-4, 1 - 1e-4);
      b = pts[i][1];
      G.z1[i] = normInv(a);
      G.z2[i] = normInv(clamp(b, 1e-4, 1 - 1e-4));
      G.v[i] = b;
      G.pdf[i] = Math.exp(-0.5 * G.z1[i] * G.z1[i]) / Math.sqrt(TWO_PI);
    }
    return G;
  }

  /* ──────────────────────────────── colors ──────────────────────────────── */

  var probe = null;
  // "var(--x, fallback)" -> the custom property's value on el (or the fallback); else as is.
  function resolveVar(spec, el) {
    var s = String(spec == null ? '' : spec).trim(), m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(s);
    if (!m) return s;
    var v = el && global.getComputedStyle ? getComputedStyle(el).getPropertyValue(m[1]).trim() : '';
    return v || (m[2] || '').trim();
  }
  function resolveNumber(spec, el, dflt) { var v = parseFloat(resolveVar(spec, el)); return isFinite(v) ? v : dflt; }
  // Resolve a color (any CSS color, or "var(--x, fallback)") against an element.
  function resolveColor(spec, el) {
    var s = resolveVar(spec, el) || '#888';
    if (!probe) probe = doc.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000'; probe.fillStyle = s;
    var c = probe.fillStyle, r = 0, g = 0, b = 0, a = 1, mm;
    if (c.charAt(0) === '#') { r = parseInt(c.substr(1, 2), 16); g = parseInt(c.substr(3, 2), 16); b = parseInt(c.substr(5, 2), 16); }
    else if ((mm = /rgba?\(([^)]+)\)/.exec(c))) {
      var p = mm[1].split(',').map(parseFloat); r = p[0]; g = p[1]; b = p[2]; a = p.length > 3 ? p[3] : 1;
    }
    return { r: r, g: g, b: b, a: a, css: 'rgb(' + r + ',' + g + ',' + b + ')' };
  }
  function rgba(c, a) { return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (+a).toFixed(4) + ')'; }

  // The sprite: a round dot with a firm core and a soft edge, pre-rendered at device pixels.
  // Profile shared with toSVG (radial gradient stops).
  var SPRITE_STOPS = [[0, 1], [0.42, 0.96], [0.7, 0.55], [1, 0]];
  function makeSprite(color, diameter, dpr) {
    var R = diameter * dpr * 0.5 * 1.35, S = Math.max(3, Math.ceil(2 * R + 2)), cv = doc.createElement('canvas');
    cv.width = cv.height = S;
    var c = cv.getContext('2d'), m = S / 2, g = c.createRadialGradient(m, m, 0, m, m, R);
    for (var i = 0; i < SPRITE_STOPS.length; i++) g.addColorStop(SPRITE_STOPS[i][0], rgba(color, SPRITE_STOPS[i][1]));
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    return { canvas: cv, size: S, half: S / 2, radiusCss: R / dpr };
  }

  /* ───────────────────────────────── clock ───────────────────────────────── */

  function Ring(n) { this.a = new Float64Array(n); this.n = 0; this.i = 0; }
  Ring.prototype.push = function (v) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; if (this.n < this.a.length) this.n++; };
  Ring.prototype.summary = function () {
    var arr = Array.prototype.slice.call(this.a, 0, this.n).sort(function (x, y) { return x - y; });
    var q = function (p) { return arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0; };
    var sum = 0; arr.forEach(function (x) { sum += x; });
    return { n: arr.length, mean: arr.length ? sum / arr.length : 0, p50: q(0.5), p95: q(0.95), max: arr.length ? arr[arr.length - 1] : 0 };
  };

  // The one loop. A frame is drawn when the most urgent active field wants one: every 1/30 s
  // while any field morphs, at its restFps while all rest (drift moves a particle about
  // 0.1 px per 1/10 s, so this is invisible), and always right at the start of a morph.
  // Between frames a timer sleeps, so no animation-frame callback runs in between.
  var Clock = {
    fields: [], running: false, raf: 0, timer: 0, last: 0, isManual: false, frames: 0, rafCalls: 0, due: FRAME_MS,
    compute: new Ring(900), draw: new Ring(900), total: new Ring(900),
    anyActive: function () {
      for (var i = 0; i < this.fields.length; i++) if (this.fields[i]._wantsFrames()) return true;
      return false;
    },
    nextDue: function () {
      var d = Infinity, i, f;
      for (i = 0; i < this.fields.length; i++) { f = this.fields[i]; if (f._wantsFrames()) d = Math.min(d, f._interval()); }
      return d === Infinity ? FRAME_MS : Math.max(FRAME_MS, d);
    },
    wake: function () {
      if (this.isManual || this.running || !this.anyActive()) return;
      this.running = true;
      this.due = FRAME_MS;
      this.last = now() - FRAME_MS;
      this._req();
    },
    _req: function () { this.rafCalls++; this.raf = global.requestAnimationFrame(Clock._frame); },
    _frame: function (t) {
      var C = Clock;
      C.raf = 0;
      if (!C.running) return;
      var since = t - C.last;
      if (since < C.due - 3) { C._req(); return; }            // not due yet (at most 30 fps)
      C.last = t;
      C.tick(Math.min(since, Math.max(100, C.due + 50)));
      if (!C.anyActive()) { C.running = false; return; }
      C.due = C.nextDue();
      // Sleep until shortly before the next frame is due, so the callbacks in between are skipped.
      var wait = Math.max(0, C.due - (now() - t) - 9);
      C.timer = setTimeout(function () { C.timer = 0; if (C.running) C._req(); }, wait);
    },
    stop: function () {
      this.running = false;
      if (this.raf) global.cancelAnimationFrame(this.raf);
      if (this.timer) clearTimeout(this.timer);
      this.raf = this.timer = 0;
    },
    refresh: function () { if (this.anyActive()) this.wake(); else this.stop(); },
    // One frame for every active field: advance local time, compute, then paint each host once.
    tick: function (dt) {
      var t0 = now(), i, f, hosts = [], tc;
      for (i = 0; i < this.fields.length; i++) {
        f = this.fields[i];
        if (!f._wantsFrames()) continue;
        f._advance(dt);
        f._compute();
        if (hosts.indexOf(f.host) < 0) hosts.push(f.host);
      }
      tc = now();
      for (i = 0; i < hosts.length; i++) hosts[i].paint();
      var t1 = now();
      this.frames++;
      this.compute.push(tc - t0); this.draw.push(t1 - tc); this.total.push(t1 - t0);
    },
    manual: function (on) {
      this.isManual = !!on;
      if (on) this.stop(); else this.refresh();
    },
    // Advance every active field by ms of local time, in frames of at most step ms.
    advance: function (ms, step) {
      step = step || FRAME_MS;
      var left = ms;
      while (left > 1e-9) { var d = Math.min(step, left); this.tick(d); left -= d; }
    }
  };
  if (doc) doc.addEventListener('visibilitychange', function () { Clock.refresh(); });

  /* ───────────────────────────────── hosts ───────────────────────────────── */

  // A host is what fields paint into and what is observed for visibility: a canvas (shared
  // by any number of fields, cleared once per frame) or, for draw-callback fields without a
  // canvas, an observed element.
  function Host(canvas, el, opts) {
    this.canvas = canvas || null;
    this.el = el || canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.fields = [];
    this.maxDpr = (opts && opts.maxDpr) || 2;
    this.fixed = opts && opts.width ? { w: opts.width, h: opts.height } : null;
    this.dpr = 1; this.w = 1; this.h = 1;
    this.onScreen = true;
    this.measure();
    var self = this;
    if (this.el && global.IntersectionObserver) {
      this.onScreen = false;   // until the observer reports
      this.io = new IntersectionObserver(function (en) {
        self.onScreen = en[en.length - 1].isIntersecting;
        Clock.refresh();
      }, { threshold: 0 });
      this.io.observe(this.el);
    }
    if (this.el && global.ResizeObserver) {
      this.ro = new ResizeObserver(function () {
        if (self.measure()) { self.fields.forEach(function (f) { f._layout(); f._compute(); }); self.paint(); }
      });
      this.ro.observe(this.el);
    }
  }
  Host.prototype.measure = function () {
    var w, h, r;
    if (this.fixed) { w = this.fixed.w; h = this.fixed.h; }
    else if (this.el && this.el.getBoundingClientRect) { r = this.el.getBoundingClientRect(); w = r.width; h = r.height; }
    w = Math.max(1, Math.round(w || 1)); h = Math.max(1, Math.round(h || 1));
    var dpr = Math.min(global.devicePixelRatio || 1, this.maxDpr), changed = w !== this.w || h !== this.h || dpr !== this.dpr;
    this.w = w; this.h = h; this.dpr = dpr;
    if (this.canvas) {
      var W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (this.canvas.width !== W) this.canvas.width = W;
      if (this.canvas.height !== H) this.canvas.height = H;
    }
    return changed;
  };
  Host.prototype.paint = function () {
    var c = this.ctx, i;
    if (c) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, this.canvas.width, this.canvas.height); }
    for (i = 0; i < this.fields.length; i++) this.fields[i]._paint(c);
  };
  Host.prototype.remove = function (f) {
    var i = this.fields.indexOf(f);
    if (i >= 0) this.fields.splice(i, 1);
    if (!this.fields.length) { if (this.io) this.io.disconnect(); if (this.ro) this.ro.disconnect(); if (this.canvas) this.canvas.__ufHost = null; }
  };
  function hostFor(canvas, el, opts) {
    if (canvas) {
      if (!canvas.__ufHost) canvas.__ufHost = new Host(canvas, null, opts);
      return canvas.__ufHost;
    }
    return new Host(null, el, opts);
  }

  /* ─────────────────────────────── choreography ─────────────────────────────── */

  // Default tours, one per technology: mostly broad shapes, one skewed shape pressed toward
  // each wall, the correlated cloud twice per tour. Left out: the states tagged 'narrow'
  // (offshore-94, onshore-05, solar-07) and the deep wall pile offshore-07, which on their
  // own read as a thin column with empty space above. goTo or a custom sequence can show them.
  var TOURS = {
    offshore: ['offshore-47', 'offshore-58', 'offshore-70', 'offshore-82', 'offshore-70', 'offshore-cloud',
      'offshore-36', 'offshore-25', 'offshore-15', 'offshore-25', 'offshore-cloud'],
    onshore: ['onshore-40', 'onshore-50', 'onshore-60', 'onshore-70', 'onshore-50', 'onshore-cloud',
      'onshore-30', 'onshore-21', 'onshore-13', 'onshore-21', 'onshore-cloud'],
    solar: ['solar-30', 'solar-40', 'solar-50', 'solar-57', 'solar-64', 'solar-50', 'solar-cloud',
      'solar-21', 'solar-13', 'solar-21', 'solar-cloud']
  };
  function defaultSequence(shapesJson, techs) {
    var S = shapesOf(shapesJson), list = [], k, i, t, tour;
    techs = techs && techs.length ? techs : Object.keys(S.techs);
    var tours = techs.map(function (tt) {
      var tl = (TOURS[tt] || []).filter(function (id) { return S.json.states[id]; });
      if (!tl.length && S.techs[tt]) tl = S.techs[tt].states.concat([S.techs[tt].cloud]);
      return tl;
    });
    if (tours.length === 1) return tours[0].slice();
    // Several technologies: alternate blocks of three steps, so each stays a moment.
    var pos = tours.map(function () { return 0; }), longest = Math.max.apply(null, tours.map(function (x) { return x.length; }));
    for (k = 0; k < longest; k += 3) {
      for (t = 0; t < tours.length; t++) {
        tour = tours[t];
        for (i = 0; i < 3 && pos[t] < tour.length; i++) list.push(tour[pos[t]++]);
      }
    }
    return list;
  }

  /* ───────────────────────────────── fields ───────────────────────────────── */

  var DEFAULTS = {
    count: 2000,
    seed: 1,
    ranks: 'sobol',        // the 2-D low-discrepancy set: 'sobol' (scrambled), 'hammersley', 'r2', 'jr2'
    sequence: null,        // null: the default tour of `techs`; or an array of ids / {state, rest, morph}
    techs: null,           // technologies for the default tour (default: all)
    start: null,           // first state (default: the first step)
    rest: 5000,            // ms at rest on an area state
    cloudRest: 6500,       // ms at rest on a cloud
    morph: 2600,           // ms of an area-to-area morph
    cloudMorph: 3200,      // ms of a morph to or from a cloud
    stagger: 0.25,         // 0..0.6: share of a morph over which the start is staggered by rank
    drift: 2.2,            // px: gentle wander at rest (0 = off)
    restFps: 10,           // frames per second while every field rests (morphs always get 30)
    primitive: 'disc',     // 'disc': one path of discs, one fill (the cheap default); 'sprite': drawImage of a pre-rendered soft dot; 'rect'
    fill: 0.88,            // the tallest point of an area state, as a share of the field height
    pile: { height: 1.1, min: 0.012, max: 0.08 },
    cloudTemper: 0.6,      // exponent on the forecast marginal of the cloud (1 = as measured)
    cloudBand: 0.012,      // field heights: thickness of an atom row in the cloud
    insets: null,          // {left, right, top, bottom} px inside the host (default 0)
    frame: null,           // {x, y, width, height} px inside the host (overrides insets)
    transform: null,       // [a, b, c, d, e, f]: affine map applied after the frame
    ghost: 'none',         // 'none' | 'outline' | 'particles' | 'both'
    ghostCount: 0.3,       // ghost particles, as a share of count
    ghostSpill: 0.25,      // the ghost is clipped to the field rectangle grown by this share of its
                           // width and height on every side (null, false or Infinity: not clipped)
    render: 'builtin',     // 'builtin' (alias 'sprite'): the engine draws; or function (frame, ctx) draws
    // Style of the built-in renderer. Each may be a value or "var(--prop, fallback)" (read
    // from the canvas element, again on every themechange).
    color: 'var(--uf-particle, #b8742a)',
    ghostColor: 'var(--uf-ghost, #7a8794)',
    size: 'var(--uf-size, 2.4)',        // px: particle diameter
    alpha: 'var(--uf-alpha, 0.9)',
    blend: 'var(--uf-blend, source-over)',  // 'lighter' glows on dark grounds
    ghostAlpha: 'var(--uf-ghost-alpha, 0.55)',
    ghostWidth: 1.1,
    ghostDash: [3, 4],
    maxDpr: 2,
    autoplay: true,
    respectStoredPause: true
  };

  var fieldSeq = 0;

  function Field(opts) {
    if (!doc) throw new Error('UncertaintyField needs a document');
    opts = assign({}, DEFAULTS, opts || {});
    opts.pile = assign({}, DEFAULTS.pile, opts.pile || {});
    if (!opts.shapes) throw new Error('UncertaintyField.create: shapes (the parsed hero-shapes.json) is required');
    this.id = ++fieldSeq;
    this.opts = opts;
    this.S = shapesOf(opts.shapes);
    this.N = Math.max(1, opts.count | 0);
    this.P = makeParticles(this.N, opts.seed | 0, opts.ranks);
    this.GH = makeGhost(Math.max(0, Math.round(this.N * opts.ghostCount)), (opts.seed | 0) + 101);
    this._cache = {};
    this._ev = {};
    var N = this.N, GN = this.GH.n;
    // frame buffers
    this.x = new Float32Array(N); this.y = new Float32Array(N);
    this.px = new Float32Array(N); this.py = new Float32Array(N);
    this._t1 = new Float32Array(N); this._t2 = new Float32Array(N); this._t3 = new Float32Array(N); this._t4 = new Float32Array(N); this._delays = new Float32Array(N);
    this.gx = new Float32Array(GN); this.gy = new Float32Array(GN); this.gpx = new Float32Array(GN); this.gpy = new Float32Array(GN);
    this.line = new Float32Array(2 * 97); this.linePx = new Float32Array(2 * 97);
    this.ell = new Float32Array(2 * 65); this.ellPx = new Float32Array(2 * 65);
    this.ghostInfo = { mode: opts.ghost, alpha1: 0, alpha2: 0, mean: 0, sd: 0, kappa: 0, cov: null };
    this.T = 0;                          // local time, ms (advances only while running)
    this.paused = false;
    this.reduced = mq('(prefers-reduced-motion: reduce)').matches;
    this.destroyed = false;
    this.lastCompute = 0;
    this.host = hostFor(opts.canvas || null, opts.observe || null, { maxDpr: opts.maxDpr, width: opts.width, height: opts.height });
    this.host.fields.push(this);
    this._layout();
    this._style();
    var steps = this._normSteps(opts.sequence || defaultSequence(this.S, opts.techs));
    this.steps = steps;
    var startId = opts.start || steps[0].state, k = 0;
    for (var i = 0; i < steps.length; i++) if (steps[i].state === startId) { k = i; break; }
    if (steps[k].state !== startId) { steps.splice(0, 0, this._transient(startId)); k = 0; }
    this.k = k;                           // index of the current (or target) step
    this.cur = this._endpoint(startId);
    this.morph = null;
    this.phase = 'rest';
    this.phaseT0 = 0;
    this.hold = false;
    if (opts.respectStoredPause && motion.isPaused()) this.paused = true;
    if (!opts.autoplay) this.paused = true;
    Clock.fields.push(this);
    this._compute();
    this.host.paint();
    Clock.refresh();
  }

  Field.prototype._step = function (s) {
    var o = this.opts, st;
    if (typeof s === 'string') s = { state: s };
    st = this.S.state(s.state);
    return {
      state: s.state,
      rest: s.rest != null ? s.rest : st.kind === 'cloud' ? o.cloudRest : o.rest,
      morph: s.morph != null ? s.morph : null
    };
  };
  Field.prototype._normSteps = function (list) {
    var self = this;
    if (!list || !list.length) throw new Error('UncertaintyField: empty sequence');
    return list.map(function (s) { return self._step(s); });
  };
  // A state that is not in the sequence (goTo, reset or setSequence away from it) gets a
  // transient step: the field visits it once and the step is dropped when the field moves on,
  // so the sequence itself never changes.
  Field.prototype._transient = function (id) { var s = this._step(id); s.transient = true; return s; };
  // Leaving the current step for step `target`: drop the current step if it is transient;
  // returns `target`, corrected for the removal.
  Field.prototype._dropTransient = function (target) {
    var k = this.k, s = this.steps[k];
    if (s && s.transient && k !== target && this.steps.length > 1) {
      this.steps.splice(k, 1);
      if (target > k) target--;
    }
    return target;
  };
  // Index of state `id` in the sequence, searching cyclically from index `from` (-1 if absent).
  Field.prototype._indexOf = function (id, from) {
    var n = this.steps.length, i, j;
    for (i = 0; i < n; i++) { j = ((from || 0) + i) % n; if (j < 0) j += n; if (this.steps[j].state === id) return j; }
    return -1;
  };
  Field.prototype._morphMs = function (fromId, step) {
    if (step.morph != null) return step.morph;
    var a = this.S.state(fromId).kind, b = this.S.state(step.state).kind;
    return a === 'area' && b === 'area' ? this.opts.morph : this.opts.cloudMorph;
  };

  // Geometry: the field rectangle in host CSS px, and the affine map after it.
  Field.prototype._layout = function () {
    var o = this.opts, h = this.host, r;
    if (o.frame) r = { x: o.frame.x || 0, y: o.frame.y || 0, w: o.frame.width, h: o.frame.height };
    else {
      // insets in px, or strings like '6%' (of the host width for left/right, height for top/bottom)
      var ins = assign({ left: 0, right: 0, top: 0, bottom: 0 }, o.insets || {});
      var px = function (v, of) { return typeof v === 'string' && /%$/.test(v) ? parseFloat(v) / 100 * of : +v || 0; };
      var L = px(ins.left, h.w), R = px(ins.right, h.w), T = px(ins.top, h.h), B = px(ins.bottom, h.h);
      r = { x: L, y: T, w: Math.max(1, h.w - L - R), h: Math.max(1, h.h - T - B) };
    }
    this.rect = r;
    var T = o.transform;
    this.M = T && T.length === 6 ? T.slice() : [1, 0, 0, 1, 0, 0];
    // drift amplitude in field widths and heights; capped at 0.05 so that a field laid out at
    // (almost) zero size never throws particles out of [0, 1] (at the default drift of 2.2 px
    // the cap only applies below 44 px)
    this.ax = Math.min(o.drift / Math.max(r.w, 1), 0.05);
    this.ay = Math.min(o.drift / Math.max(r.h, 1), 0.05);
    if (typeof this.opts.render !== 'function' && this.col) this._sprites();
  };
  // Resolve the style options (all of them, or only the keys set in `only`). Each may be a
  // value or "var(--prop, fallback)" read from the canvas (or observed element).
  Field.prototype._style = function (only) {
    var o = this.opts, el = this.host.canvas || this.host.el || doc.documentElement, all = !only;
    var sty = this.sty || (this.sty = { size: 2.4, alpha: 0.9, blend: 'source-over', ghostAlpha: 0.55 }), blend;
    if (all || only.color) this.col = resolveColor(o.color, el);
    if (all || only.ghostColor) this.gcol = resolveColor(o.ghostColor, el);
    if (all || only.size) sty.size = Math.max(0.5, resolveNumber(o.size, el, 2.4));
    if (all || only.alpha) sty.alpha = clamp(resolveNumber(o.alpha, el, 0.9), 0, 1);
    if (all || only.blend) { blend = resolveVar(o.blend, el); sty.blend = blend === 'lighter' || blend === 'screen' || blend === 'multiply' ? blend : 'source-over'; }
    if (all || only.ghostAlpha) sty.ghostAlpha = clamp(resolveNumber(o.ghostAlpha, el, 0.55), 0, 1);
    if (typeof o.render !== 'function' && (all || only.color || only.ghostColor || only.size)) this._sprites();
  };
  // Pre-rendered dots, only for primitive 'sprite' (the default 'disc' needs none, so a
  // style change is cheap enough to make on every frame).
  Field.prototype._sprites = function () {
    if (this.opts.primitive !== 'sprite') { this.sprite = this.gsprite = null; return; }
    var d = this.host.dpr;
    this.sprite = makeSprite(this.col, this.sty.size, d);
    this.gsprite = makeSprite(this.gcol, this.sty.size * 0.9, d);
  };

  // An endpoint: what a layout is computed from. Area and cloud states cache, per field,
  // every particle's rest position (and, for areas, the display density there).
  Field.prototype._endpoint = function (id) {
    var c = this._cache[id], P = this.P, N = this.N, i, cell = [0];
    if (c) return c;
    var st = this.S.state(id);
    if (st.kind === 'area') {
      var A = this.S.area(id, this.opts.pile), X = new Float32Array(N), D = new Float32Array(N);
      for (i = 0; i < N; i++) { X[i] = areaQuantile(A, P.u[i], cell); D[i] = A.dens[cell[0]]; }
      c = { type: 'area', id: id, A: A, X: X, D: D, kappa: this.opts.fill / A.peak };
    } else {
      var C = this.S.cloud(id, this.opts.cloudTemper), CX = new Float32Array(N), CY = new Float32Array(N);
      for (i = 0; i < N; i++) { CX[i] = cloudX(C, P.u[i]); CY[i] = cloudY(C, CX[i], P.v[i], this.opts.cloudBand); }
      c = { type: 'cloud', id: id, C: C, X: CX, Y: CY };
    }
    this._cache[id] = c;
    return c;
  };

  /* ── time and the state machine (phase boundaries are exact, so positions are a pure
        function of local time for a given series of API calls) ── */

  Field.prototype._wantsFrames = function () {
    return !this.destroyed && !this.paused && !this.reduced && this.host.onScreen && !(doc && doc.hidden);
  };
  // Milliseconds until this field next wants a frame (see Clock).
  Field.prototype._interval = function () {
    if (this.phase === 'morph') return FRAME_MS;
    var rest = 1000 / clamp(this.opts.restFps, 1, 30);
    if (!this.hold) rest = Math.min(rest, Math.max(1, this.phaseT0 + Math.max(1, this.steps[this.k].rest) - this.T));
    return rest;
  };
  Field.prototype._advance = function (dt) {
    this.T += dt;
    this._settle();
  };
  Field.prototype._settle = function () {
    var guard = 0;
    while (guard++ < 64) {
      if (this.phase === 'rest' && !this.hold) {
        var restMs = Math.max(1, this.steps[this.k].rest);
        if (this.T - this.phaseT0 < restMs) return;
        var next = (this.k + 1) % this.steps.length;
        if (this.steps[next].state === this.cur.id) { this.k = this._dropTransient(next); this.phaseT0 += restMs; continue; }  // no morph to itself
        this._beginMorph(this.cur, next, this.phaseT0 + restMs, this._morphMs(this.cur.id, this.steps[next]));
      } else if (this.phase === 'morph') {
        var m = this.morph;
        if (this.T - m.t0 < m.dur) return;
        this._arrive(m.t0 + m.dur);
      } else return;
    }
  };
  Field.prototype._beginMorph = function (from, k, t0, dur) {
    k = this._dropTransient(k);
    var to = this._endpoint(this.steps[k].state), prev = this.cur;
    this.k = k;
    this.morph = this._plan(from, to, t0, Math.max(1, dur));
    this.phase = 'morph';
    this.phaseT0 = t0;
    this._emit('morphstart', { from: from.id || null, to: to.id, duration: dur, field: this });
    return prev;
  };
  Field.prototype._arrive = function (t) {
    var m = this.morph, prev = this.cur;
    this.cur = m.to;
    this.morph = null;
    this.phase = 'rest';
    this.phaseT0 = t;
    this._emit('state', { state: this.cur.id, previous: prev.id || null, field: this });
  };
  // A morph plan: the endpoints, the rank delays of the stagger and the vertical scales.
  // Stagger rule: delay(u) proportional to -integral_0^u d(w) dw, with d = X_to - X_from the
  // displacement of rank w, normalized to [0, tau]. Then delay'(u) d(u) <= 0: the particle in
  // front (in the direction it moves) always starts first, so no rank overtakes another
  // (x stays monotone in u at every frame). For a translation the front leaves first and
  // the shape stretches in transit, like a stream.
  Field.prototype._plan = function (from, to, t0, dur) {
    var N = this.N, i, d, phi = 0, lo = 0, hi = 0, maxd = 0, delays = this._delays, PH = this._t4;
    for (i = 0; i < N; i++) {
      d = to.X[i] - from.X[i];
      PH[i] = phi;
      phi -= d / N;
      if (PH[i] < lo) lo = PH[i];
      if (PH[i] > hi) hi = PH[i];
      if (Math.abs(d) > maxd) maxd = Math.abs(d);
    }
    // Full stagger for displacements of 0.1 to 0.15; less for smaller ones (nothing to stream)
    // and, between two areas, for larger ones, so a long move travels more as one body instead
    // of stretching flat in transit.
    var aa = from.type === 'area' && to.type === 'area';
    var tau = clamp(this.opts.stagger, 0, 0.6) * Math.min(1, maxd / 0.1) * (aa ? Math.min(1, 0.15 / Math.max(maxd, 1e-9)) : 1), span = hi - lo, k = 0;
    if (tau > 1e-4 && span > 1e-9) {
      for (i = 0; i < N; i++) delays[i] = tau * (PH[i] - lo) / span;
      k = tau / ((1 - tau) * span);
    } else { tau = 0; delays.fill(0); }
    return {
      from: from, to: to, t0: t0, dur: dur, tau: tau, inv: 1 / (1 - tau), delays: delays, stagK: k,
      kind: from.type === 'area' && to.type === 'area' ? 'aa' : 'mix'
    };
  };

  /* ── layouts ── */

  Field.prototype._compute = function () {
    var t0 = now();
    if (this.phase === 'morph') {
      var m = this.morph, g = clamp((this.T - m.t0) / m.dur, 0, 1);
      if (m.kind === 'aa') this._morphAA(m, g); else this._morphMix(m, g);
      this.progress = g;
    } else {
      if (this.cur.type === 'area') this._restArea(this.cur, this.T / 1000);
      else if (this.cur.type === 'cloud') this._restCloud(this.cur, this.T / 1000);
      else this._restSnap(this.cur);
      this.progress = 1;
    }
    this._ghost();
    this._project();
    this.lastCompute = now() - t0;
  };

  // Drifted area positions of one endpoint into (X, Yh): x and the column height kappa f(Q(u)).
  // Horizontal wander: drift px, but never more than DRIFT_RANKS ranks of the particle's own
  // density (so at rest the x-distribution stays within a Kolmogorov-Smirnov distance of
  // about DRIFT_RANKS / N of Q; in a dense peak the wander is mostly vertical). The column
  // height is the density at the particle's own rest position Q(u), not at its drifted x: the
  // display density is a step function (512 table cells, and the wall piles), so a height
  // read at the drifted x would jump whenever a particle drifts across a step.
  Field.prototype._areaAt = function (E, t, kappa, OX, OH) {
    var P = this.P, N = this.N, A = E.A, fl = A.floor, ax = this.ax, i, x, f, a;
    var X = E.X, D = E.D, wx = P.wx, fx = P.fx, mr = DRIFT_RANKS / N;
    for (i = 0; i < N; i++) {
      f = D[i]; if (f < fl) f = fl;
      if (ax) { a = mr / f; if (a > ax) a = ax; x = X[i] + a * fsin(wx[i] * t + fx[i]); } else x = X[i];
      if (x < 0) x = -x; else if (x > 1) x = 2 - x;
      OX[i] = x; OH[i] = kappa * f;
    }
  };
  // Heights from column heights: v drifts inside its own column (at most drift px).
  Field.prototype._heights = function (H, t, OY) {
    var P = this.P, N = this.N, ay = this.ay, i, h, dv;
    var v = P.v, wy = P.wy, fy = P.fy;
    var z;
    for (i = 0; i < N; i++) {
      h = H[i];
      if (ay && h > 0) { dv = ay * fsin(wy[i] * t + fy[i]) / h; if (dv > 0.5) dv = 0.5; else if (dv < -0.5) dv = -0.5; }
      else dv = 0;
      z = v[i] + dv;                               // in [-0.5, 1.5): one reflection folds it
      if (z < 0) z = -z; else if (z > 1) z = 2 - z;
      OY[i] = z * h;
    }
  };
  Field.prototype._restArea = function (E, t) {
    this._areaAt(E, t, E.kappa, this.x, this._t1);
    this._heights(this._t1, t, this.y);
    this.kappa = E.kappa;
    this.layoutMix = 0;
  };
  Field.prototype._cloudAt = function (E, t, OX, OY) {
    var P = this.P, N = this.N, ax = this.ax, ay = this.ay, X = E.X, Y = E.Y, i, x, y;
    for (i = 0; i < N; i++) {
      x = X[i]; y = Y[i];
      if (ax) { x += ax * fsin(P.wx[i] * t + P.fx[i]); if (x < 0) x = -x; else if (x > 1) x = 2 - x; }
      if (ay) { y += ay * fsin(P.wy[i] * t + P.fy[i]); if (y < 0) y = -y; else if (y > 1) y = 2 - y; }
      OX[i] = x; OY[i] = y;
    }
  };
  Field.prototype._restCloud = function (E, t) {
    this._cloudAt(E, t, this.x, this.y);
    this.kappa = 0;
    this.layoutMix = 1;
  };
  Field.prototype._restSnap = function (E) {
    this.x.set(E.X); this.y.set(E.Y);
    this.layoutMix = E.mix || 0;
  };
  // Area to area: rank-preserving displacement interpolation with the exact density
  //   1 / x'(u) = 1 / ((1 - s) / f_a + s / f_b + s'(u) d(u)),
  // where s'(u) d(u) >= 0 is the stagger's own stretch (zero without stagger). The vertical
  // scale moves geometrically between the two states' scales (which keeps a plain morph at or
  // below the field top); if a staggered frame would still exceed it, the frame is scaled down.
  Field.prototype._morphAA = function (m, g) {
    var P = this.P, N = this.N, t = this.T / 1000, a = m.from, b = m.to, i;
    var Xa = a.X, Xb = b.X, Da = a.D, Db = b.D, fla = a.A.floor, flb = b.A.floor;
    var ax = this.ax, mr = DRIFT_RANKS / N, del = m.delays, inv = m.inv, k = m.stagK, X = this.x, DEN = this._t1;
    var e = smooth5(g), kap = Math.exp((1 - e) * Math.log(a.kappa) + e * Math.log(b.kappa));
    var maxD = 0, xa, xb, fa, fb, p, s, d, dx, den, aa, ab;
    for (i = 0; i < N; i++) {
      p = (g - del[i]) * inv; p = p < 0 ? 0 : p > 1 ? 1 : p;
      s = p * p * p * (p * (p * 6 - 15) + 10);
      // densities at the rank's own rest positions Q_a(u), Q_b(u) (see _areaAt)
      fa = Da[i]; if (fa < fla) fa = fla;
      fb = Db[i]; if (fb < flb) fb = flb;
      if (ax) {
        aa = mr / fa; if (aa > ax) aa = ax;
        ab = mr / fb; if (ab > ax) ab = ax;
        dx = (aa + s * (ab - aa)) * fsin(P.wx[i] * t + P.fx[i]);   // amplitude moves with the particle
      } else dx = 0;
      xa = Xa[i] + dx; if (xa < 0) xa = -xa; else if (xa > 1) xa = 2 - xa;
      xb = Xb[i] + dx; if (xb < 0) xb = -xb; else if (xb > 1) xb = 2 - xb;
      d = Xb[i] - Xa[i];
      den = 1 / ((1 - s) / fa + s / fb + (k ? smooth5d(p) * k * d * d : 0));
      X[i] = xa + s * (xb - xa);
      DEN[i] = den;
      if (den > maxD) maxD = den;
    }
    if (kap * maxD > 0.985) kap = 0.985 / maxD;
    for (i = 0; i < N; i++) DEN[i] *= kap;
    this._heights(DEN, t, this.y);
    this.kappa = kap;
    this.layoutMix = 0;
  };
  // Every other morph (area and cloud, cloud and cloud, from an interrupted frame): each
  // endpoint is laid out as at rest and every particle moves on a straight line with its own
  // eased, rank-staggered progress (the same stagger rule, so x stays monotone in u).
  Field.prototype._morphMix = function (m, g) {
    var N = this.N, t = this.T / 1000, i, p, s, del = m.delays, inv = m.inv;
    var X0 = this._t1, Y0 = this._t2, X1 = this._t3, Y1 = this._t4, a = m.from, b = m.to;
    this._endpointAt(a, t, X0, Y0);
    this._endpointAt(b, t, X1, Y1);
    var X = this.x, Y = this.y;
    for (i = 0; i < N; i++) {
      p = (g - del[i]) * inv; p = p < 0 ? 0 : p > 1 ? 1 : p;
      s = p * p * p * (p * (p * 6 - 15) + 10);
      X[i] = X0[i] + s * (X1[i] - X0[i]);
      Y[i] = Y0[i] + s * (Y1[i] - Y0[i]);
    }
    var e = smooth5(g), ma = a.type === 'cloud' ? 1 : a.mix || 0, mb = b.type === 'cloud' ? 1 : b.mix || 0;
    this.layoutMix = ma + e * (mb - ma);
    // (a snapshot keeps the vertical scale of the frame it was taken from)
    this.kappa = (a.type === 'cloud' ? 0 : a.kappa || 0) * (1 - e) + (b.type === 'cloud' ? 0 : b.kappa || 0) * e;
  };
  Field.prototype._endpointAt = function (E, t, OX, OY) {
    if (E.type === 'area') {
      var H = this._tmpH || (this._tmpH = new Float32Array(this.N));
      this._areaAt(E, t, E.kappa, OX, H);
      this._heights(H, t, OY);
    } else if (E.type === 'cloud') this._cloudAt(E, t, OX, OY);
    else { OX.set(E.X); OY.set(E.Y); }
  };

  /* ── the Gaussian ghost: moment-matched to the particles of this frame ── */

  Field.prototype._ghost = function () {
    var gi = this.ghostInfo, mode = this.opts.ghost;
    gi.mode = mode;
    if (mode === 'none') { gi.alpha1 = gi.alpha2 = 0; return; }
    var N = this.N, X = this.x, Y = this.y, i, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, mx, my, vx, vy, cxy;
    for (i = 0; i < N; i++) { sx += X[i]; sy += Y[i]; }
    mx = sx / N; my = sy / N;
    for (i = 0; i < N; i++) {
      var ddx = X[i] - mx, ddy = Y[i] - my;
      sxx += ddx * ddx; syy += ddy * ddy; sxy += ddx * ddy;
    }
    vx = sxx / N; vy = syy / N; cxy = sxy / N;
    var sd = Math.sqrt(Math.max(vx, 1e-10)), mix = this.layoutMix || 0;
    gi.mean = mx; gi.sd = sd; gi.alpha1 = 1 - mix; gi.alpha2 = mix; gi.kappa = this.kappa;
    // 1-D: the normal curve on the field's vertical scale, +-4 sd (spills past the walls).
    var L = this.line, j, z, kap = this.kappa || 0;
    for (j = 0; j <= 96; j++) {
      z = -4 + j / 12;
      L[2 * j] = mx + z * sd;
      L[2 * j + 1] = kap * Math.exp(-0.5 * z * z) / (sd * Math.sqrt(TWO_PI));
    }
    // 2-D: the moment-matched bivariate normal's 2-sigma ellipse (cloud).
    var a11 = Math.sqrt(Math.max(vx, 1e-12)), a21 = cxy / a11, a22 = Math.sqrt(Math.max(vy - a21 * a21, 1e-12)), E = this.ell, th;
    for (j = 0; j <= 64; j++) {
      th = TWO_PI * j / 64;
      var c = 2 * Math.cos(th), s = 2 * Math.sin(th);
      E[2 * j] = mx + a11 * c;
      E[2 * j + 1] = my + a21 * c + a22 * s;
    }
    gi.cov = [vx, cxy, vy];
    // Ghost particles: 1-D under the normal curve, 2-D from the bivariate normal; blended.
    var GH = this.GH, gx = this.gx, gy = this.gy, n = GH.n;
    for (i = 0; i < n; i++) {
      var x1 = mx + sd * GH.z1[i], y1 = GH.v[i] * kap * GH.pdf[i] / sd;
      var x2 = mx + a11 * GH.z1[i], y2 = my + a21 * GH.z1[i] + a22 * GH.z2[i];
      gx[i] = x1 + mix * (x2 - x1); gy[i] = y1 + mix * (y2 - y1);
    }
  };

  /* ── projection to host px ── */

  Field.prototype._project = function () {
    var r = this.rect, M = this.M, N = this.N, i, lx, ly;
    var a = M[0], b = M[1], c = M[2], d = M[3], e = M[4], f = M[5];
    var X = this.x, Y = this.y, PX = this.px, PY = this.py;
    for (i = 0; i < N; i++) {
      lx = r.x + X[i] * r.w; ly = r.y + (1 - Y[i]) * r.h;
      PX[i] = a * lx + c * ly + e; PY[i] = b * lx + d * ly + f;
    }
    if (this.ghostInfo.mode !== 'none') {
      var gi = this.ghostInfo, j;
      proj(this.line, this.linePx, 97); proj(this.ell, this.ellPx, 65);
      for (i = 0; i < this.GH.n; i++) {
        lx = r.x + this.gx[i] * r.w; ly = r.y + (1 - this.gy[i]) * r.h;
        this.gpx[i] = a * lx + c * ly + e; this.gpy[i] = b * lx + d * ly + f;
      }
      gi.rect = r;
    }
    function proj(S, D, n) {
      for (j = 0; j < n; j++) {
        lx = r.x + S[2 * j] * r.w; ly = r.y + (1 - S[2 * j + 1]) * r.h;
        D[2 * j] = a * lx + c * ly + e; D[2 * j + 1] = b * lx + d * ly + f;
      }
    }
  };

  // The ghost's clip region: the field rectangle grown by ghostSpill of its width and height
  // on every side, through the affine map; 4 corners in host CSS px, or null (no clip). In a
  // cloud the moment-matched normal reaches far past the field; unclipped it can cover the
  // content around it.
  Field.prototype._clipPoly = function () {
    var sp = this.opts.ghostSpill, r = this.rect, M = this.M, C = this._clip || (this._clip = new Float32Array(8)), j, lx, ly;
    if (sp == null || sp === false || !(sp >= 0) || !isFinite(sp)) return null;
    var xs = [r.x - sp * r.w, r.x + r.w * (1 + sp)], ys = [r.y - sp * r.h, r.y + r.h * (1 + sp)], c = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (j = 0; j < 4; j++) {
      lx = xs[c[j][0]]; ly = ys[c[j][1]];
      C[2 * j] = M[0] * lx + M[2] * ly + M[4]; C[2 * j + 1] = M[1] * lx + M[3] * ly + M[5];
    }
    return C;
  };

  /* ── painting ── */

  Field.prototype.frameInfo = function () {
    var h = this.host;
    return {
      field: this, n: this.N, x: this.x, y: this.y, px: this.px, py: this.py, u: this.P.u, v: this.P.v,
      ghost: { mode: this.ghostInfo.mode, alphaCurve: this.ghostInfo.alpha1, alphaEllipse: this.ghostInfo.alpha2,
        mean: this.ghostInfo.mean, sd: this.ghostInfo.sd, curve: this.linePx, curveNorm: this.line, ellipse: this.ellPx,
        ellipseNorm: this.ell, n: this.GH.n, px: this.gpx, py: this.gpy, x: this.gx, y: this.gy,
        clip: this.ghostInfo.mode !== 'none' ? this._clipPoly() : null },
      state: this.phase === 'morph' ? this.morph.to.id : this.cur.id,
      from: this.phase === 'morph' ? this.morph.from.id || null : this.cur.id,
      to: this.phase === 'morph' ? this.morph.to.id : this.cur.id,
      phase: this.phase, progress: this.phase === 'morph' ? smooth5(this.progress) : 1, linear: this.progress,
      cloudness: this.layoutMix || 0, kappa: this.kappa, time: this.T,
      width: h.w, height: h.h, dpr: h.dpr, rect: this.rect, transform: this.M
    };
  };
  Field.prototype._paint = function (ctx) {
    if (typeof this.opts.render === 'function') {
      if (ctx) { ctx.save(); ctx.setTransform(this.host.dpr, 0, 0, this.host.dpr, 0, 0); }
      this.opts.render(this.frameInfo(), ctx);
      if (ctx) ctx.restore();
      return;
    }
    if (!ctx) return;
    var t0 = now(), dpr = this.host.dpr, gi = this.ghostInfo, i, sp, hs, j, cp;
    if (gi.mode !== 'none') {
      ctx.save();
      if ((cp = this._clipPoly())) {
        ctx.beginPath();
        for (j = 0; j < 4; j++) { if (j) ctx.lineTo(cp[2 * j] * dpr, cp[2 * j + 1] * dpr); else ctx.moveTo(cp[0] * dpr, cp[1] * dpr); }
        ctx.closePath();
        ctx.clip();
      }
      if (gi.mode === 'outline' || gi.mode === 'both') {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = this.gcol.css;
        ctx.lineWidth = this.opts.ghostWidth;
        ctx.setLineDash(this.opts.ghostDash || []);
        if (gi.alpha1 > 0.01) {
          ctx.globalAlpha = this.sty.ghostAlpha * gi.alpha1;
          ctx.beginPath();
          for (j = 0; j < 97; j++) { if (j) ctx.lineTo(this.linePx[2 * j], this.linePx[2 * j + 1]); else ctx.moveTo(this.linePx[0], this.linePx[1]); }
          ctx.stroke();
        }
        if (gi.alpha2 > 0.01) {
          ctx.globalAlpha = this.sty.ghostAlpha * gi.alpha2;
          ctx.beginPath();
          for (j = 0; j < 65; j++) { if (j) ctx.lineTo(this.ellPx[2 * j], this.ellPx[2 * j + 1]); else ctx.moveTo(this.ellPx[0], this.ellPx[1]); }
          ctx.stroke();
        }
        ctx.restore();
      }
      if (gi.mode === 'particles' || gi.mode === 'both') {
        ctx.globalAlpha = this.sty.ghostAlpha * 0.6;
        if (this.opts.primitive === 'sprite') {
          sp = this.gsprite; hs = sp.half;
          for (i = 0; i < this.GH.n; i++) ctx.drawImage(sp.canvas, this.gpx[i] * dpr - hs, this.gpy[i] * dpr - hs);
        } else pathDots(ctx, this.gpx, this.gpy, this.GH.n, this.sty.size * 0.45 * dpr, dpr, this.gcol.css, this.opts.primitive);
      }
      ctx.restore();
    }
    ctx.globalCompositeOperation = this.sty.blend;
    ctx.globalAlpha = this.sty.alpha;
    var PX = this.px, PY = this.py, prim = this.opts.primitive, N = this.N;
    if (prim === 'sprite') {
      sp = this.sprite; hs = sp.half;
      var cv = sp.canvas;
      for (i = 0; i < N; i++) ctx.drawImage(cv, PX[i] * dpr - hs, PY[i] * dpr - hs);
    } else {
      // one path, one fill: far cheaper per particle than drawImage (overlaps unite, they do not add up)
      pathDots(ctx, PX, PY, N, this.sty.size * 0.5 * dpr, dpr, this.col.css, prim);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.lastDraw = now() - t0;
  };
  function pathDots(ctx, PX, PY, n, r, dpr, css, prim) {
    var i, x, y, d2 = 2 * r;
    ctx.fillStyle = css;
    ctx.beginPath();
    if (prim === 'rect') for (i = 0; i < n; i++) ctx.rect(PX[i] * dpr - r, PY[i] * dpr - r, d2, d2);
    else for (i = 0; i < n; i++) { x = PX[i] * dpr; y = PY[i] * dpr; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TWO_PI); }
    ctx.fill();
  }

  /* ── public field API ── */

  Field.prototype.play = function () {
    if (this.destroyed) return this;
    if (this.paused) { this.paused = false; this._emit('play', { field: this }); }
    Clock.refresh();
    return this;
  };
  Field.prototype.pause = function () {
    if (this.destroyed) return this;
    if (!this.paused) { this.paused = true; this._emit('pause', { field: this }); }
    Clock.refresh();
    return this;
  };
  Field.prototype.isPaused = function () { return this.paused; };
  Field.prototype.isRunning = function () { return Clock.running && this._wantsFrames(); };
  // Go to a state: morph there (or jump with {instant: true}, and always under reduced
  // motion). By default the field then holds there until resume(); {hold: false} rejoins
  // the sequence at that step (or right after it).
  // The next occurrence of `id` after the current step is used (tours repeat states), a
  // state outside the sequence is visited once (transient step), and a goTo to the state the
  // field is already at or already morphing to does not restart the morph.
  Field.prototype.goTo = function (id, o) {
    this.S.state(id);
    var idx = this._indexOf(id, this.k + 1);
    if (idx < 0) { this.steps.splice(this.k + 1, 0, this._transient(id)); idx = this.k + 1; }
    return this._goToIndex(idx, o);
  };
  Field.prototype._goToIndex = function (idx, o) {
    o = o || {};
    var id = this.steps[idx].state, instant = o.instant || this.reduced, prev, from;
    this.hold = o.hold !== false;
    if (instant) {
      prev = this.cur.id || null;
      this.k = this._dropTransient(idx); this.cur = this._endpoint(id); this.morph = null; this.phase = 'rest'; this.phaseT0 = this.T;
      this._emit('state', { state: id, previous: prev, field: this });
    } else if (this.phase === 'morph' ? this.morph.to.id === id : this.cur.id === id) {
      // already there, or on the way there: nothing to start
    } else {
      from = this.phase === 'morph' ? this._snapshot() : this.cur;
      this._beginMorph(from, idx, this.T, o.morph != null ? o.morph : this._morphMs(from.id || id, this.steps[idx]));
    }
    this._redraw();
    return this;
  };
  // Restart the timeline: local time 0, at rest on `id` (default: the first step), no hold.
  // Positions are then a pure function of the local time that follows. Transient steps are
  // dropped first.
  Field.prototype.reset = function (id) {
    this.steps = this.steps.filter(function (s) { return !s.transient; });
    id = id || this.steps[0].state;
    this.S.state(id);
    var k = this._indexOf(id, 0);
    if (k < 0) { this.steps.splice(0, 0, this._transient(id)); k = 0; }
    this.k = k; this.cur = this._endpoint(id); this.morph = null; this.phase = 'rest';
    this.T = 0; this.phaseT0 = 0; this.hold = false;
    this._redraw();
    return this;
  };
  // Morph to the next step of the sequence (by position) and continue.
  Field.prototype.next = function (o) {
    var n = this.steps.length, here = this.state(), j, k = -1;
    for (j = 1; j <= n; j++) { k = (this.k + j) % n; if (this.steps[k].state !== here) break; }
    if (k < 0 || this.steps[k].state === here) { this.hold = false; return this; }
    return this._goToIndex(k, assign({ hold: false }, o || {}));
  };
  // Leave a hold: rest out the current step, then continue the sequence.
  Field.prototype.resume = function () { if (this.hold) { this.hold = false; if (this.phase === 'rest') this.phaseT0 = this.T; } return this; };
  // Replace the sequence. The field carries on from its current (or target) state: if that
  // state is in the new list it continues from there; if not, it rests out there once and
  // then starts the new list from its first step. {startAt: id} morphs to id at once (or
  // jumps, with instant).
  Field.prototype.setSequence = function (list, o) {
    o = o || {};
    this.steps = this._normSteps(list);
    var id = this.phase === 'morph' ? this.morph.to.id : this.cur.id, k = this._indexOf(id, 0);
    if (k < 0) { this.steps.splice(0, 0, this._transient(id)); k = 0; }
    this.k = k;
    this.hold = false;
    if (o.startAt) return this.goTo(o.startAt, { hold: false, instant: o.instant });
    return this;
  };
  Field.prototype.getSequence = function () { return this.steps.map(function (s) { return assign({}, s); }); };
  Field.prototype.state = function () { return this.phase === 'morph' ? this.morph.to.id : this.cur.id; };
  Field.prototype.setGhost = function (mode) { this.opts.ghost = mode || 'none'; this._redraw(); return this; };
  // Change style options. Only the keys given are re-resolved; with {redraw: false} the
  // change shows with the next frame instead of an extra paint now, which makes it cheap to
  // call from the page's own animation (for example a color that follows the time of day).
  Field.prototype.setStyle = function (o, opt) {
    var self = this, only = {};
    ['color', 'ghostColor', 'size', 'alpha', 'blend', 'ghostAlpha', 'ghostWidth', 'ghostDash'].forEach(function (k) { if (o && o[k] !== undefined) { self.opts[k] = o[k]; only[k] = true; } });
    this._style(only);
    if (!(opt && opt.redraw === false)) this._redraw();
    return this;
  };
  Field.prototype.refreshStyle = function () { this._style(); this._redraw(); return this; };
  Field.prototype.setTransform = function (T) { this.opts.transform = T; this._layout(); this._redraw(); return this; };
  Field.prototype.setFrame = function (fr) { this.opts.frame = fr; this._layout(); this._redraw(); return this; };
  Field.prototype.resize = function () { this.host.measure(); this.host.fields.forEach(function (f) { f._layout(); }); this._redraw(); return this; };
  Field.prototype._redraw = function () { if (this.destroyed) return; this._compute(); this.host.paint(); Clock.refresh(); };
  Field.prototype._snapshot = function () {
    return { type: 'snap', id: null, X: Float32Array.from(this.x), Y: Float32Array.from(this.y), mix: this.layoutMix || 0, kappa: this.kappa || 0 };
  };
  Field.prototype.on = function (name, fn) { (this._ev[name] || (this._ev[name] = [])).push(fn); return this; };
  Field.prototype.off = function (name, fn) { var l = this._ev[name]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; };
  Field.prototype._emit = function (name, detail) {
    var l = this._ev[name];
    if (!l) return;
    l.slice().forEach(function (fn) { try { fn(detail); } catch (e) { if (global.console) console.error(e); } });
  };
  // Copies of the current frame, as plain arrays.
  Field.prototype.frame = function () {
    var fi = this.frameInfo();
    return {
      n: this.N, x: Array.from(this.x), y: Array.from(this.y), px: Array.from(this.px), py: Array.from(this.py),
      u: Array.from(this.P.u), v: Array.from(this.P.v), state: fi.state, from: fi.from, to: fi.to, phase: fi.phase,
      progress: fi.progress, linear: fi.linear, cloudness: fi.cloudness, kappa: fi.kappa, time: this.T, rect: this.rect,
      ghost: { mean: this.ghostInfo.mean, sd: this.ghostInfo.sd, curve: Array.from(this.linePx), ellipse: Array.from(this.ellPx) },
      tau: this.morph ? this.morph.tau : 0, delays: this.morph ? Array.from(this.morph.delays) : null, stagK: this.morph ? this.morph.stagK : 0
    };
  };
  // The current frame as standalone SVG (CSS px of the host), for no-JS stills.
  Field.prototype.toSVG = function (o) {
    o = o || {};
    var h = this.host, W = h.w, H = h.h, p = o.precision != null ? o.precision : 1, f = Math.pow(10, p), i, j;
    var R = (this.sprite ? this.sprite.radiusCss : this.sty.size * 0.675), gid = 'uf-dot-' + this.id;
    var r = function (x) { return Math.round(x * f) / f; };
    var out = [];
    if (o.standalone !== false) out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"' + (o.title ? ' role="img"' : ' aria-hidden="true"') + '>');
    if (o.title) out.push('<title>' + String(o.title).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</title>');
    if (o.background) out.push('<rect width="100%" height="100%" fill="' + o.background + '"/>');
    var gi = this.ghostInfo, cp = o.ghost !== false && gi.mode !== 'none' ? this._clipPoly() : null, cid = 'uf-clip-' + this.id;
    out.push('<defs><radialGradient id="' + gid + '">');
    SPRITE_STOPS.forEach(function (s) { out.push('<stop offset="' + s[0] + '" stop-color="' + this.col.css + '" stop-opacity="' + s[1] + '"/>'); }, this);
    out.push('</radialGradient>');
    if (cp) out.push('<clipPath id="' + cid + '"><path d="M' + r(cp[0]) + ' ' + r(cp[1]) + ' L' + r(cp[2]) + ' ' + r(cp[3]) + ' L' + r(cp[4]) + ' ' + r(cp[5]) + ' L' + r(cp[6]) + ' ' + r(cp[7]) + ' Z"/></clipPath>');
    out.push('</defs>');
    if (cp) out.push('<g clip-path="url(#' + cid + ')">');
    if (o.ghost !== false && gi.mode !== 'none' && (gi.mode === 'outline' || gi.mode === 'both')) {
      var dash = (this.opts.ghostDash || []).join(' ');
      var path = function (P, n) { var s = 'M'; for (j = 0; j < n; j++) s += (j ? ' L' : '') + r(P[2 * j]) + ' ' + r(P[2 * j + 1]); return s; };
      if (gi.alpha1 > 0.01) out.push('<path d="' + path(this.linePx, 97) + '" fill="none" stroke="' + this.gcol.css + '" stroke-width="' + this.opts.ghostWidth + '" stroke-opacity="' + r(this.sty.ghostAlpha * gi.alpha1) + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>');
      if (gi.alpha2 > 0.01) out.push('<path d="' + path(this.ellPx, 65) + '" fill="none" stroke="' + this.gcol.css + '" stroke-width="' + this.opts.ghostWidth + '" stroke-opacity="' + r(this.sty.ghostAlpha * gi.alpha2) + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>');
    }
    var prim = this.opts.primitive, blendCss = this.sty.blend === 'lighter' ? ' style="mix-blend-mode:plus-lighter"' : '';
    // Sprites: per-dot gradient circles, each blended on its own (like drawImage). Discs and
    // rects: one group with group opacity (like the one-path fill, where overlaps unite).
    var dots = function (PXs, PYs, n, rad, fill, alpha, kind) {
      var rr = r(rad), d = r(2 * rad), k;
      out.push('<g fill="' + fill + '" ' + (kind === 'sprite' ? 'fill-opacity' : 'opacity') + '="' + r(alpha) + '"' + blendCss + '>');
      for (k = 0; k < n; k++) {
        if (kind === 'rect') out.push('<rect x="' + r(PXs[k] - rad) + '" y="' + r(PYs[k] - rad) + '" width="' + d + '" height="' + d + '"/>');
        else out.push('<circle cx="' + r(PXs[k]) + '" cy="' + r(PYs[k]) + '" r="' + rr + '"/>');
      }
      out.push('</g>');
    };
    if (o.ghost !== false && (gi.mode === 'particles' || gi.mode === 'both')) {
      if (prim === 'sprite') dots(this.gpx, this.gpy, this.GH.n, this.gsprite ? this.gsprite.radiusCss : this.sty.size * 0.6, this.gcol.css, this.sty.ghostAlpha * 0.6 * 0.7, 'sprite');
      else dots(this.gpx, this.gpy, this.GH.n, this.sty.size * 0.45, this.gcol.css, this.sty.ghostAlpha * 0.6, prim);
    }
    if (cp) out.push('</g>');
    if (prim === 'sprite') dots(this.px, this.py, this.N, R, 'url(#' + gid + ')', this.sty.alpha, 'sprite');
    else dots(this.px, this.py, this.N, this.sty.size * 0.5, this.col.css, this.sty.alpha, prim);
    if (o.standalone !== false) out.push('</svg>');
    return out.join('');
  };
  Field.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    var i = Clock.fields.indexOf(this);
    if (i >= 0) Clock.fields.splice(i, 1);
    this.host.remove(this);
    if (this.host.fields.length) this.host.paint();
    else if (this.host.ctx) this.host.ctx.clearRect(0, 0, this.host.canvas.width, this.host.canvas.height);
    Clock.refresh();
  };

  /* ───────────────────────── motion: reduced motion, Pause ───────────────────────── */

  var mqReduce = mq('(prefers-reduced-motion: reduce)');
  // The page's pause state lives in memory and is mirrored to localStorage when that works,
  // so Pause can be undone even with storage blocked (private windows, blocked site data).
  var memPaused = load(MOTION_KEY) === 'paused';
  var motion = {
    KEY: MOTION_KEY,
    reduced: function () { return mqReduce.matches; },
    isPaused: function () { return memPaused; },
    // Remember the choice ('paused' is stored; playing removes the key) and apply it.
    setPaused: function (p) {
      memPaused = !!p;
      store(MOTION_KEY, memPaused ? 'paused' : null);
      Clock.fields.forEach(function (f) { if (memPaused) f.pause(); else f.play(); });
      motion._sync();
      motion._notify('setPaused');
      return memPaused;
    },
    // A click flips what the button shows: paused if the choice says so or every field is paused.
    _shown: function () { return memPaused || (Clock.fields.length > 0 && !Clock.fields.some(function (f) { return !f.paused; })); },
    toggle: function () { return motion.setPaused(!motion._shown()); },
    // Listen for changes of the pause choice or of prefers-reduced-motion, so the page's own
    // animations stop and start with the field. fn receives {paused, reduced, source};
    // returns a function that removes the listener. The same detail is dispatched on
    // document as the 'motionchange' event.
    _listeners: [],
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      motion._listeners.push(fn);
      return function () { var i = motion._listeners.indexOf(fn); if (i >= 0) motion._listeners.splice(i, 1); };
    },
    _notify: function (source) {
      var d = { paused: memPaused, reduced: mqReduce.matches, source: source };
      motion._listeners.slice().forEach(function (fn) { try { fn(d); } catch (e) { if (global.console) console.error(e); } });
      if (doc && typeof global.CustomEvent === 'function') doc.dispatchEvent(new CustomEvent('motionchange', { detail: d }));
    },
    _buttons: [],
    // Wire a Pause button: aria-pressed="true" while paused; click toggles. Optional labels.
    bindButton: function (btn, o) {
      if (!btn) return;
      o = o || {};
      motion._buttons.push({ el: btn, o: o });
      btn.addEventListener('click', function () { motion.toggle(); });
      motion._sync();
    },
    _sync: function () {
      var p = motion._shown();
      motion._buttons.forEach(function (b) {
        b.el.setAttribute('aria-pressed', String(p));
        if (b.o.pausedLabel && b.o.playingLabel) {
          var t = b.o.labelTarget ? b.el.querySelector(b.o.labelTarget) : b.el;
          if (t) t.textContent = p ? b.o.pausedLabel : b.o.playingLabel;
        }
        if (b.o.hideWhenReduced) b.el.hidden = mqReduce.matches;
      });
    }
  };
  onMQ(mqReduce, function () {
    var r = mqReduce.matches;
    Clock.fields.forEach(function (f) {
      f.reduced = r;
      if (r && f.phase === 'morph') f._arrive(f.T);
      f._compute(); f.host.paint();
    });
    motion._sync();
    Clock.refresh();
    motion._notify('reduced-motion');
  });
  // Another tab changed the choice (or cleared storage): follow it.
  if (global.addEventListener) global.addEventListener('storage', function (e) {
    if (e.key !== MOTION_KEY && e.key !== null) return;
    var p = load(MOTION_KEY) === 'paused';
    if (p === memPaused) return;
    memPaused = p;
    Clock.fields.forEach(function (f) { if (p) f.pause(); else f.play(); });
    motion._sync();
    motion._notify('storage');
  });

  // Theme changes: re-read CSS colors of every field (site.js fires 'themechange').
  function restyleAll() { Clock.fields.forEach(function (f) { if (!f.destroyed) { f._style(); f._compute(); f.host.paint(); } }); }
  // (setTimeout, not requestAnimationFrame: no animation frame is ever requested under reduced motion)
  if (doc) doc.addEventListener('themechange', function () { setTimeout(restyleAll, 0); });
  onMQ(mq('(prefers-color-scheme: dark)'), function () { setTimeout(restyleAll, 0); });

  /* ─────────────────────────────── public API ─────────────────────────────── */

  var api = {
    VERSION: VERSION,
    create: function (opts) { return new Field(opts); },
    load: function (url) {
      return fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('UncertaintyField.load: HTTP ' + r.status + ' for ' + url);
        return r.json();
      });
    },
    states: function (shapesJson, filter) {
      var S = shapesOf(shapesJson);
      return S.ids.filter(function (id) {
        var s = S.json.states[id];
        if (!filter) return true;
        if (filter.tech && s.tech !== filter.tech) return false;
        if (filter.kind && s.kind !== filter.kind) return false;
        if (filter.tag && (!s.tags || s.tags.indexOf(filter.tag) < 0)) return false;
        return true;
      });
    },
    defaultSequence: defaultSequence,
    tours: TOURS,
    pauseAll: function () { Clock.fields.forEach(function (f) { f.pause(); }); motion._sync(); },
    playAll: function () { Clock.fields.forEach(function (f) { f.play(); }); motion._sync(); },
    fields: function () { return Clock.fields.slice(); },
    motion: motion,
    clock: {
      fps: 30,
      frames: function () { return Clock.frames; },
      running: function () { return Clock.running; },
      // Whether any field wants frames now (not paused, not reduced, on screen, tab visible).
      // With manual(true) a page can drive the engine from its own loop: call advance(dt) each
      // frame while active() is true.
      active: function () { return Clock.anyActive(); },
      rafCalls: function () { return Clock.rafCalls; },
      manual: function (on) { Clock.manual(on); },
      advance: function (ms, step) { Clock.advance(ms, step); },
      stats: function () { return { compute: Clock.compute.summary(), draw: Clock.draw.summary(), total: Clock.total.summary(), frames: Clock.frames }; },
      resetStats: function () { Clock.compute = new Ring(900); Clock.draw = new Ring(900); Clock.total = new Ring(900); }
    },
    // Helpers outside the field API: the display distribution of an area state, the uint16
    // table decoder, and per-frame compute and paint timings.
    _qa: {
      displayQuantile: function (shapesJson, id, u, pile) {
        var A = shapesOf(shapesJson).area(id, assign({}, DEFAULTS.pile, pile || {}));
        return areaQuantile(A, u);
      },
      display: function (shapesJson, id, pile) {
        var A = shapesOf(shapesJson).area(id, assign({}, DEFAULTS.pile, pile || {}));
        return { dens: Array.from(A.dens), peak: A.peak, pile0: A.pile0, pile1: A.pile1, p0: A.p0, p1: A.p1, grid: GRID };
      },
      decodeU16: function (s) { return Array.from(decodeU16(s)); },
      // Time n computes of a field at its current plan (precise per-frame compute cost).
      bench: function (field, n) {
        n = n || 200;
        var t0 = now(), T0 = field.T, i;
        for (i = 0; i < n; i++) { field.T = T0 + i * 0.001; field._compute(); }
        var dt = (now() - t0) / n;
        field.T = T0; field._compute();
        return dt;
      },
      benchPaint: function (field, n) {
        n = n || 100;
        var t0 = now(), i;
        for (i = 0; i < n; i++) field.host.paint();
        return (now() - t0) / n;
      }
    }
  };
  global.UncertaintyField = api;
})(typeof window !== 'undefined' ? window : this);
