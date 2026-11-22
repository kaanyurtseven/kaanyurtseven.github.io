/*! studio.js - the Home model: a lit model of a generic power system on a plinth, with four
 * uncertainty fields (offshore wind, onshore wind, solar and the loading of the line D-I): the line
 * field's particles are drawn by the uncertainty engine (assets/engine/), the three source fields' by
 * this file's own view (HybridPanel) from the engine's outcome tables.
 *
 * The grid is drawn from assets/net.js (COMPACT is the layout for phones): nine substations as fenced
 * compounds with double busbars (a single busbar at F and G), bays (bus disconnectors, breaker, line
 * disconnector), line-entry gantries and transformers; an EHV backbone on lattice portals and
 * double-circuit towers, an HV level on tubular poles, one wire per circuit; two HVDC links with
 * converters at both ends; the thermal plant as a generator, the industry and the town as loads. Flow
 * lights run along the circuits and cables from a DC power flow on the same network. The theme cards
 * start the model's stories (switching, balancing, HVDC).
 *
 * One small 3D renderer serves three purposes, so the picture is the same everywhere:
 *  - its SVG writers (Studio.svgStatic, svgHighlights, svgLive) write the static model, the highlight
 *    layers and a complete still of every moving part as SVG (the no-JS picture in
 *    _includes/home/stage-*.html);
 *  - the page draws only the moving parts on one canvas (rotors, trackers and their glint, the
 *    battery's charge bars, disconnector blades, converter lights, the flow light), plus the few
 *    static objects that stand in front of them (occluders, found automatically), depth-sorted;
 *  - the particles of the four fields are drawn on the same canvas.
 * Everything runs on the engine's one clock (a 1-particle "hook" field with a draw callback),
 * so Pause, the off-screen and hidden-tab stops and reduced motion apply to all of it.
 *
 * World: x to the right, y up, z away from the viewer (the sea is at the back). Units are
 * model units; the camera is fitted to the layout's viewBox. Nothing here is a real place.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var VERSION = '8.0.0-2';

  /* ───────────────────────────── vectors ───────────────────────────── */

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function nrm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function rotY(p, ang) { var c = Math.cos(ang), s = Math.sin(ang); return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]]; }
  function centroid(pts) { var c = [0, 0, 0]; for (var i = 0; i < pts.length; i++) c = add(c, pts[i]); return mul(c, 1 / pts.length); }
  function newell(p) {
    var n = [0, 0, 0], i, a, b;
    for (i = 0; i < p.length; i++) {
      a = p[i]; b = p[(i + 1) % p.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return nrm(n);
  }
  function d2(a, b) { var dx = a[0] - b[0], dz = a[1] - b[1]; return Math.sqrt(dx * dx + dz * dz); }
  function unit2(a, b) { var l = d2(a, b) || 1; return [(b[0] - a[0]) / l, 0, (b[1] - a[1]) / l]; }
  // deterministic pseudo-random in [0, 1) (no Math.random anywhere: the static render must be repeatable)
  function rnd(seed) { var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  // 2-D convex hull (monotone chain) of [x, z] points
  function hull2(pts) {
    var p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }), lo = [], up = [], i;
    function cr(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    for (i = 0; i < p.length; i++) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop(); lo.push(p[i]); }
    for (i = p.length - 1; i >= 0; i--) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop(); up.push(p[i]); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  /* ───────────────────────────── color ───────────────────────────── */

  function hexRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function rgbHex(c) { return '#' + c.map(function (v) { v = Math.round(clamp(v, 0, 255)); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function toLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function toSrgb(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return clamp(c, 0, 1) * 255; }
  function oklab(hex) {
    var c = hexRgb(hex).map(toLin), r = c[0], g = c[1], b = c[2];
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function fromOklab(o) {
    var l = o[0] + 0.3963377774 * o[1] + 0.2158037573 * o[2], m = o[0] - 0.1055613458 * o[1] - 0.0638541728 * o[2], s = o[0] - 0.0894841775 * o[1] - 1.2914855480 * o[2];
    l = l * l * l; m = m * m * m; s = s * s * s;
    return rgbHex([toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)]);
  }
  function mixHex(a, b, t) { return fromOklab(mix3(oklab(a), oklab(b), t)); }

  // Material tone ramps: 16 levels from the darkest face (level 0) to a face square to the key
  // light (level 15), per palette. la: the light theme, a daylight model under a strong key light in a
  // cool light gallery; dark: the dark theme, the studio after hours.
  var LEVELS = 16;
  var PALETTES = ['la', 'dark'];
  var MATERIALS = {
    bs: { dark: ['#08090a', '#2d3136'], la: ['#141518', '#3d4045'] },    // plinth
    cd: { dark: ['#15181b', '#737a82'], la: ['#68645b', '#ffffff'] },    // card: land, buildings, towers
    yd: { dark: ['#101316', '#596067'], la: ['#625e56', '#e2ddd4'] },    // yards (gravel)
    se: { dark: ['#0d1317', '#25333b'], la: ['#56707b', '#bccdd5'] },    // sea (tinted acrylic)
    pv: { dark: ['#0b0f14', '#3e4b5f'], la: ['#2c3441', '#93a2b6'] },    // solar glass
    mt: { dark: ['#33373c', '#80878e'], la: ['#4a4843', '#a29e94'] },    // metal: towers, posts, gantries
    dk: { dark: ['#202429', '#454b53'], la: ['#30353c', '#7f8892'] },    // dark parts: tanks, breakers
    ac: { dark: ['#2c2478', '#c4bbff'], la: ['#30239a', '#d8d1ff'] }     // cut edges of the violet acrylic
  };
  var MAT_KEYS = Object.keys(MATERIALS);
  function tone(mat, k, pal) { var a = MATERIALS[mat][pal]; return mixHex(a[0], a[1], Math.pow(k / (LEVELS - 1), 0.9)); }
  // Flat colors (not ramped), per palette. Among them the components' details and night lights
  // (win: window glass; winLit: a lit window, dark only; glaze: lit glazing of the turbine hall and the
  // works; seam: the light seam under a valve hall's eaves; deck: platform deck lights; plume: the
  // stacks' vapor; charge/chargeTrack: the battery's charge bar, teal-green; pvGrid: the module grid
  // on the solar trackers). Warm lights are pale gold, so the seam is warm white, not blue.
  var FLAT = {
    dark: {
      wall: '#131517', wall2: '#0e1012', ink: '#e7e9ec', wire: '#a3aab1', wireHV: '#8a9198', bus: '#b3b9bf', cable: '#8b98a3', shadow: '#000000', ao: '#000000',
      off: '#7d858d', glint: '#eef3ff', led: '#f1f3f6', ledOff: '#2d3237', lamp: '#fff4dc', window: '#f2d9a4', ring: '#e7e9ec',
      acFace: 'rgba(28,26,44,0.34)', acTint: 'rgba(167,155,255,0.08)', acTop: '#b4a9ff', acSide: '#7b69f5', acBot: '#4f3fc7',
      acEdge: '#a79bff', acHi: 'rgba(220,214,255,0.75)', acShadow: '#7b69f5', wallLine: 'rgba(167,155,255,0.34)', particle: '#a79bff',
      lampHalo: '0.18', glintA: '0.5', glow: '0.55',
      beamLo: '#e2b866', beamCore: '#fff7ea', beamHalo: '#f0c466', beamHot: '#ff7a4a', beamHotCore: '#ffc6ad', beamCoreA: '0.92', beamHaloA: '0.30',
      beamCoreW: '0.9', beamHaloW: '3.6', beamBlend: 'lighter', beamGlow: '0.16', beamGlowHalo: '0.07',
      poolCheap: '#4fdcb6', poolCheapLine: '#4fdcb6', poolDear: '#ee5cc4', poolA: '0.55', flash: '#f4f2ff', flashBlend: 'lighter', spot: '#000000', spotA: '0.20', dip: '#000000',
      warm: '#ff9a6b', limit: '#eef0f3', tailA: '0.34',
      win: '#191d22', winLit: '#ffd28c', door: '#121518', glaze: '#ffe1a6', glazeA: '0.82', seam: '#fff0d2', seamA: '0.75',
      deck: '#ffdca6', deckA: '0.95', plume: '#e3e9ef', plumeA: '1', charge: '#7deccb', chargeTrack: '#2a2f35', chargeHi: '#e6fff6', pvGrid: 'rgba(190,210,255,0.16)', nightGlow: '1',
      rail: '#a79bff', edgeLight: '#d8d2ff', edgeBlend: 'lighter', haze: '0', volGlow: '#8c7cff', beamA0: '0.30', beamA1: '0.03', colA: '0.16', puckA: '0.85', threadA: '0.7',
      decFill: '#4fdcb6', decLine: '#4fdcb6', decDeep: '#2b8a72', decA: '0.58', wasteFill: '#ff6659', wasteLine: '#ff7a6e', wasteA: '0.16', wasteHatchA: '0.80',
      bidBat: '#4fdcb6', bidBio: '#e8b257', bidGas: '#d85ab8',
      dcBody: '#82c8d2', dcBodyA: '0.75', dcPulse: '#e2fbff', dcBodyW: '2.0', dcPulseW: '1.1', dcTail: '0.38', dcPulseLo: '0.75', dcEdge: '#82c8d2', dcEdgeW: '0', glideP: '1'
    },
    la: {
      wall: '#e6e7e8', wall2: '#d6d8db', ink: '#151619', wire: '#2e3135', wireHV: '#45484c', bus: '#2e3135', cable: '#26313a', shadow: '#16140f', ao: '#100f0c',
      off: '#8a867e', glint: '#ffffff', led: '#151619', ledOff: '#b5b1a8', lamp: '#151619', window: '#7d848c', ring: '#151619',
      acFace: 'rgba(22,19,42,0.58)', acTint: 'rgba(124,108,255,0.13)', acTop: '#cfc7ff', acSide: '#7a68f4', acBot: '#4a3bc0',
      acEdge: '#a69aff', acHi: 'rgba(240,236,255,0.92)', acShadow: '#4b35d4', wallLine: 'rgba(196,188,255,0.42)', particle: '#d8d1ff',
      lampHalo: '0', glintA: '0.75', glow: '0.65',
      beamLo: '#e3b84e', beamCore: '#fffaf0', beamHalo: '#e2ab2c', beamHot: '#d2511c', beamHotCore: '#ffd2bd', beamCoreA: '1', beamHaloA: '0.42',
      beamCoreW: '0.72', beamHaloW: '3.8', beamBlend: 'source-over', beamGlow: '0.30', beamGlowHalo: '0',
      poolCheap: '#1d9a7e', poolCheapLine: '#18876e', poolDear: '#c8238f', poolA: '0.62', flash: '#ffffff', flashBlend: 'source-over', spot: '#14130f', spotA: '0.13', dip: '#14130f',
      warm: '#d2511c', limit: '#1d1f23', tailA: '0.38',
      win: '#4a5562', winLit: '#4a5562', door: '#343b44', glaze: '#3a4552', glazeA: '0.85', seam: '#3a4552', seamA: '0.55',
      deck: '#ffdca6', deckA: '0', plume: '#fbfcfd', plumeA: '1', charge: '#1d9a7e', chargeTrack: '#c4c0b7', chargeHi: '#d9fff1', pvGrid: 'rgba(255,255,255,0.5)', nightGlow: '0',
      rail: '#6b57f0', edgeLight: '#5b45e6', edgeBlend: 'source-over', haze: '1', volGlow: '#6e5cf5', beamA0: '0.22', beamA1: '0.03', colA: '0.12', puckA: '0.75', threadA: '0.6',
      decFill: '#1d9a7e', decLine: '#18876e', decDeep: '#0f6150', decA: '0.62', wasteFill: '#d32f2f', wasteLine: '#b71c1c', wasteA: '0.12', wasteHatchA: '0.80',
      bidBat: '#18876e', bidBio: '#b36f12', bidGas: '#8f1c69',
      dcBody: '#0f789b', dcBodyA: '1', dcPulse: '#eaf8fc', dcBodyW: '3.0', dcPulseW: '2.0', dcTail: '0.20', dcPulseLo: '1', dcEdge: '#0a5570', dcEdgeW: '0.45', glideP: '2'
    }
  };
  // Balancing chart tokens (CHART7). decFill / decLine / decDeep: the coordinated decision (its activated
  // energy and settlement, its price line, its column; decDeep the column's redispatch foot), decA the fill's
  // alpha. wasteFill / wasteLine: the cheapest redispatch's extra cost (the band between the two clearing prices
  // and the dashed column's excess over the solid one), drawn as red hatch lines (CHART7.str wLw wide, wGap
  // apart); at wasteHatchA 0.8 each line holds 3:1 or more against the ground. wasteFill and wasteA fill the
  // column's excess under the hatch only when CHART7.str.wFill is 1. bidBat / bidBio / bidGas: the bids by kind,
  // each the color of its unit in the model (the battery park's teal, amber for the biomass power station, plum
  // for the gas-fired plant); each holds 3:1 or more against the page's ground (#e6e7e8 / #121416) in both
  // themes. The battery park's bids and the decision are one color family and stay apart by form: the bids are
  // hollow steps (crisp tops, faint sides), the decision a filled area with its price line. Everything else on
  // the chart is neutral ink.
  // HVDC hover light (not used elsewhere). dcBody: an even body along each DC pole at alpha dcBodyA
  // (source-over); dcPulse: the traveling brightness inside it, in the beams' blend (source-over in light,
  // additive in dark). Widths: dcBodyW and dcPulseW x BEAM.KIND_W.dc x the map scale (the body also
  // x 0.75 + 0.5 x load). dcTail: the pulse's tail, as a share of its wavelength; dcPulseLo: the pulse's
  // strength at low power. dcEdge, dcEdgeW: a thin dark edge under the light theme's body (dcEdgeW x KIND_W.dc each
  // side; none in dark), which closes the hairline between the two poles and keeps the link visible against the
  // receded ground. glideP: the exponent of the switching restart's curve for the switched line (M.glC = M.glK ^ glideP),
  // so the line returns in step with the chart's points.
  // The light values above are for fields without an acrylic sheet (light volumes and the floating band: deep
  // violet dots on the light model, an ink limit rail, a deeper warm, the edge light drawn over the model). With
  // sheets (html[data-panels="r4"]) the fields sit on smoked acrylic and the light theme takes these paler values;
  // dark is the same for every panel style. Written before the dark blocks in tones.css, so dark wins.
  var FLAT_R4 = { la: { warm: '#ffa073', limit: '#f4f2ff', tailA: '0.36', edgeLight: '#ece8ff', edgeBlend: 'lighter', rail: '#a69aff' } };
  var SHADOW_ALPHA = { dark: 0.62, la: 0.5 }, AO_ALPHA = { dark: 0.7, la: 0.48 }, PANEL_SHADOW_ALPHA = { dark: 0.2, la: 0.22 };
  var FALL = { dark: ['#000000', 0.62], la: ['#2a2720', 0.3] };

  function pad2(k) { return (k < 10 ? '0' : '') + k; }
  // paletteCSS() returns the CSS held in assets/tones.css: every tone as a custom property per palette, the
  // selectors that pick a palette (light is the base, so it applies without JS and in system light; dark
  // in system dark unless the light theme is chosen, and when the dark theme is chosen), and the classes.
  function paletteCSS() {
    function vars(pal) {
      var out = [];
      MAT_KEYS.forEach(function (m) { for (var k = 0; k < LEVELS; k++) out.push('--t-' + m + '-' + pad2(k) + ':' + tone(m, k, pal)); });
      var F = FLAT[pal];
      Object.keys(F).forEach(function (k) { out.push('--s-' + k + ':' + F[k]); });
      out.push('--s-shadow-a:' + SHADOW_ALPHA[pal], '--s-ao-a:' + AO_ALPHA[pal], '--s-pshadow-a:' + PANEL_SHADOW_ALPHA[pal]);
      out.push('--s-fall:' + FALL[pal][0], '--s-fall-a:' + FALL[pal][1]);
      return out.join(';');
    }
    var r4 = Object.keys(FLAT_R4.la).map(function (k) { return '--s-' + k + ':' + FLAT_R4.la[k]; }).join(';');
    var css = ['/* tones and flat colors of the model per palette (light, dark), computed from MATERIALS and FLAT in assets/studio.js */',
      ':root{' + vars('la') + '}',
      ':root[data-panels="r4"]{' + r4 + '}',
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){' + vars('dark') + '}}',
      ':root[data-theme="dark"]{' + vars('dark') + '}'];
    var cls = [];
    MAT_KEYS.forEach(function (m) { for (var k = 0; k < LEVELS; k++) cls.push('.' + m + pad2(k) + '{--c:var(--t-' + m + '-' + pad2(k) + ')}'); });
    css.push(cls.join(''));
    return css.join('\n');
  }

  /* ───────────────────────────── camera and light ───────────────────────────── */

  function Camera(o) {
    var F = nrm([Math.sin(o.yaw) * Math.cos(o.pitch), -Math.sin(o.pitch), Math.cos(o.yaw) * Math.cos(o.pitch)]);
    var R = nrm(cross([0, 1, 0], F)), U = cross(F, R);
    this.F = F; this.R = R; this.U = U;
    this.C = sub(o.target, mul(F, o.dist));
    this.f = o.f || 1; this.cx = o.cx || 0; this.cy = o.cy || 0;
  }
  Camera.prototype.p = function (q) {
    var d = sub(q, this.C), z = dot(d, this.F);
    return [this.cx + this.f * dot(d, this.R) / z, this.cy - this.f * dot(d, this.U) / z, z];
  };
  Camera.prototype.depth = function (q) { return dot(sub(q, this.C), this.F); };
  Camera.prototype.sees = function (pt, n) { return dot(n, sub(this.C, pt)) > 0; };

  // Intensity of a face with outward normal n: ambient + key light + a little sky.
  function intensity(n, L) {
    var d = Math.max(0, dot(n, L));
    return clamp(0.16 + 0.66 * d + 0.20 * Math.max(0, n[1]), 0, 1);
  }
  function level(I) { return clamp(Math.round(I * (LEVELS - 1)), 0, LEVELS - 1); }
  // The key light is a spotlight on the model: full at the pool's center, falling off toward
  // the plinth's corners. Applied through the tone level, so the SVG and the canvas agree.
  function falloff(S, p) {
    var P = S.layout.pool;
    if (!P) return 1;
    var dx = (p[0] - P[0]) / P[2], dz = (p[2] - P[1]) / P[3];
    return 1 - P[4] * Math.min(1, dx * dx + dz * dz);
  }

  /* ───────────────────────────── objects ───────────────────────────── */

  // An object is the unit of depth sorting: faces (filled polygons), lines (strokes) and
  // spheres. kind 'ground' objects are drawn first, in the order they are made.
  function Obj(scene, id, o) {
    this.id = id; this.kind = 'solid'; this.theme = null; this.live = false; this.layer = 'obj';
    this.faces = []; this.lines = []; this.spheres = []; this.shadow = []; this.ao = [];
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) this[k] = o[k];
    this.scene = scene;
    scene.objs.push(this);
  }
  // A face: points (any winding) and the outward hint (a point inside the solid), or a normal.
  Obj.prototype.face = function (pts, mat, inside, extra) {
    var n = newell(pts);
    if (inside && dot(n, sub(centroid(pts), inside)) < 0) n = mul(n, -1);
    this.faces.push({ p: pts, m: mat, n: n, x: extra || null });
    return this;
  };
  Obj.prototype.faceN = function (pts, mat, n, extra) { this.faces.push({ p: pts, m: mat, n: nrm(n), x: extra || null }); return this; };
  Obj.prototype.line = function (pts, cls, w) { this.lines.push({ p: pts, c: cls, w: w || 1 }); return this; };
  Obj.prototype.sphere = function (c, r, mat) { this.spheres.push({ c: c, r: r, m: mat }); return this; };

  function Scene(name) { this.name = name; this.objs = []; this.panels = []; this.live = { lamps: [] }; this.ground = 0; this.lanes = []; this.blades = {}; }
  Scene.prototype.obj = function (id, o) { return new Obj(this, id, o || {}); };

  // Box from (x0, y0, z0) to (x1, y1, z1), axis-aligned.
  function box(o, x0, y0, z0, x1, y1, z1, mat, skip) {
    var c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    var P = function (x, y, z) { return [x, y, z]; };
    skip = skip || {};
    if (!skip.top) o.faceN([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], mat, [0, 1, 0]);
    if (!skip.front) o.faceN([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], mat, [0, 0, -1]);
    if (!skip.back) o.faceN([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], mat, [0, 0, 1]);
    if (!skip.left) o.faceN([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], mat, [-1, 0, 0]);
    if (!skip.right) o.faceN([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], mat, [1, 0, 0]);
    o.anchor = o.anchor || [c[0], y0, c[2]];
    return c;
  }
  // Box with a yaw: center of the base (cx, y0, cz), width w (local x), depth d (local z), height h.
  function obox(o, cx, y0, cz, w, d, h, yaw, mat) {
    var corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(function (q) { var r = rotY([q[0], 0, q[1]], yaw); return [cx + r[0], cz + r[2]]; });
    var b = corners.map(function (q) { return [q[0], y0, q[1]]; }), t = corners.map(function (q) { return [q[0], y0 + h, q[1]]; });
    var inside = [cx, y0 + h / 2, cz];
    o.face(t.slice(), mat, inside);
    for (var i = 0; i < 4; i++) { var j = (i + 1) % 4; o.face([b[i], b[j], t[j], t[i]], mat, inside); }
    o.anchor = o.anchor || [cx, y0, cz];
    return { base: b, top: t };
  }
  // Tapered prism (towers, posts, tanks): n sides, radius r0 at y0, r1 at y1.
  function prism(o, cx, cz, y0, y1, r0, r1, n, mat, capTop) {
    var ring0 = [], ring1 = [], i, a;
    for (i = 0; i < n; i++) { a = (i + 0.5) / n * TAU; ring0.push([cx + r0 * Math.cos(a), y0, cz + r0 * Math.sin(a)]); ring1.push([cx + r1 * Math.cos(a), y1, cz + r1 * Math.sin(a)]); }
    var inside = [cx, (y0 + y1) / 2, cz];
    for (i = 0; i < n; i++) { var j = (i + 1) % n; o.face([ring0[i], ring0[j], ring1[j], ring1[i]], mat, inside); }
    if (capTop !== false) o.faceN(ring1.slice(), mat, [0, 1, 0]);
    o.anchor = o.anchor || [cx, y0, cz];
  }
  // Pitched-roof house, ridge along x, yaw about its base center.
  function house(o, cx, y0, cz, w, d, wall, ridge, yaw, mat) {
    var L = function (x, y, z) { var r = rotY([x, 0, z], yaw); return [cx + r[0], y0 + y, cz + r[2]]; };
    var hw = w / 2, hd = d / 2, inside = L(0, wall / 2, 0);
    o.face([L(-hw, 0, -hd), L(hw, 0, -hd), L(hw, wall, -hd), L(-hw, wall, -hd)], mat, inside);
    o.face([L(-hw, 0, hd), L(hw, 0, hd), L(hw, wall, hd), L(-hw, wall, hd)], mat, inside);
    o.face([L(-hw, 0, -hd), L(-hw, 0, hd), L(-hw, wall, hd), L(-hw, ridge, 0), L(-hw, wall, -hd)], mat, inside);
    o.face([L(hw, 0, -hd), L(hw, 0, hd), L(hw, wall, hd), L(hw, ridge, 0), L(hw, wall, -hd)], mat, inside);
    o.face([L(-hw - 1, wall - 0.6, -hd - 1), L(hw + 1, wall - 0.6, -hd - 1), L(hw + 1, ridge, 0), L(-hw - 1, ridge, 0)], mat, L(0, wall * 0.5, 0));
    o.face([L(-hw - 1, wall - 0.6, hd + 1), L(hw + 1, wall - 0.6, hd + 1), L(hw + 1, ridge, 0), L(-hw - 1, ridge, 0)], mat, L(0, wall * 0.5, 0));
    o.anchor = [cx, y0, cz];
  }

  // Shadow of a set of points (an object's vertices) on the plane y = g, along the light.
  function shadowPoly(pts, g, L) {
    var flat = pts.map(function (p) { var t = (p[1] - g) / L[1]; return [p[0] - L[0] * t, p[2] - L[2] * t]; });
    return hull2(flat).map(function (q) { return [q[0], g, q[1]]; });
  }
  function allPoints(o) {
    var pts = [];
    o.faces.forEach(function (f) { pts = pts.concat(f.p); });
    o.lines.forEach(function (l) { pts = pts.concat(l.p); });
    o.spheres.forEach(function (s) { pts.push(add(s.c, [0, s.r, 0]), add(s.c, [s.r, 0, 0]), add(s.c, [-s.r, 0, 0]), add(s.c, [0, 0, s.r]), add(s.c, [0, 0, -s.r])); });
    return pts;
  }
  function footprint(o, g, grow) {
    var pts = allPoints(o).filter(function (p) { return p[1] <= g + 1.5; });
    if (pts.length < 3) return null;
    var h = hull2(pts.map(function (p) { return [p[0], p[2]]; })), c = [0, 0];
    h.forEach(function (q) { c[0] += q[0] / h.length; c[1] += q[1] / h.length; });
    return h.map(function (q) { var dx = q[0] - c[0], dz = q[1] - c[1], l = Math.sqrt(dx * dx + dz * dz) || 1; return [q[0] + dx / l * grow, g + 0.05, q[1] + dz / l * grow]; });
  }
  function castShadow(o, g, L, alpha) {
    var s = shadowPoly(allPoints(o), g, L);
    if (s.length >= 3) o.shadow.push({ p: s, a: alpha == null ? 1 : alpha });
    var f = footprint(o, g, 1.2);
    if (f) o.ao.push({ p: f, a: 1 });
  }
  function postShadow(o, q, h, r, g, a) {
    o.shadow.push({ p: shadowPoly([[q[0] - r, g, q[1] - r], [q[0] + r, g, q[1] + r], [q[0] - r * 0.7, g + h, q[1]], [q[0] + r * 0.7, g + h, q[1]]], g, LIGHT), a: a == null ? 0.4 : a });
  }

  /* ───────────────────────────── terrain, sea, turbines ───────────────────────────── */

  var LIGHT = nrm([-0.46, 0.72, -0.52]);   // toward the key light: upper left, in front

  function coastZ(x, L) { return L.coast + 16 * Math.sin(x / 230 + 0.6) + 7 * Math.sin(x / 83 + 2.1); }

  function plinthAndPlates(S, L) {
    var g = S.ground, x0 = L.x0, x1 = L.x1, z0 = L.z0, z1 = L.z1, m = L.plateMargin;
    var pl = S.obj('plinth', { layer: 'ground', kind: 'ground' });
    box(pl, x0 - m, -L.plinthH, z0 - m, x1 + m, 0, z1 + m, 'bs');
    var land = S.obj('land', { layer: 'ground', kind: 'ground' }), top = [], x, steps = 48;
    for (var i = 0; i <= steps; i++) { x = x0 + (x1 - x0) * i / steps; top.push([x, g, coastZ(x, L)]); }
    var poly = [[x0, g, z0], [x1, g, z0]].concat(top.slice().reverse());
    land.faceN(poly, 'cd', [0, 1, 0]);
    land.faceN([[x0, 0, z0], [x1, 0, z0], [x1, g, z0], [x0, g, z0]], 'cd', [0, 0, -1]);
    land.faceN([[x0, 0, z0], [x0, 0, coastZ(x0, L)], [x0, g, coastZ(x0, L)], [x0, g, z0]], 'cd', [-1, 0, 0]);
    land.faceN([[x1, 0, z0], [x1, 0, coastZ(x1, L)], [x1, g, coastZ(x1, L)], [x1, g, z0]], 'cd', [1, 0, 0]);
    var sea = S.obj('sea', { layer: 'ground', kind: 'ground' }), sy = L.seaY;
    sea.faceN([[x0, sy, z1], [x1, sy, z1]].concat(top.map(function (p) { return [p[0], sy, p[2]]; }).reverse()), 'se', [0, 1, 0], { sea: true });
    sea.faceN([[x0, 0, coastZ(x0, L)], [x0, 0, z1], [x0, sy, z1], [x0, sy, coastZ(x0, L)]], 'se', [-1, 0, 0]);
    sea.faceN([[x1, 0, coastZ(x1, L)], [x1, 0, z1], [x1, sy, z1], [x1, sy, coastZ(x1, L)]], 'se', [1, 0, 0]);
    var step = S.obj('coast-shadow', { layer: 'ground', kind: 'ground' }), sh = [];
    top.forEach(function (p) { sh.push([p[0], sy + 0.05, p[2]]); });
    var back = top.map(function (p) { return [p[0] + 3, sy + 0.05, p[2] + 6]; }).reverse();
    step.shadow.push({ p: sh.concat(back), a: 0.9 });
    S.coastTop = top;
  }

  function inPoly(x, z, ring) {
    var c = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  // Terrain as stacked contour layers (the model maker's foam board).
  function hill(S, id, cx, cz, r, h, seed, flat) {
    var o = S.obj(id, { layer: 'ground', kind: 'ground' }), g = S.ground, layers = 3, step = h / layers, n = 30, blobs = [], i, l;
    flat = flat || 0.6;
    for (l = 0; l < layers; l++) {
      var rl = r * (1 - l * 0.3), ring = [], ox = l * 7, oz = -l * 4;
      for (i = 0; i < n; i++) {
        var a = i / n * TAU, w = 1 + 0.09 * Math.sin(a * 2 + seed + l * 1.7) + 0.05 * Math.sin(a * 3 + seed * 2.1 - l);
        ring.push([cx + ox + Math.cos(a) * rl * w, cz + oz + Math.sin(a) * rl * w * flat]);
      }
      blobs.push(ring);
      var y0 = g + l * step, y1 = y0 + step, c3 = [cx + ox, y0 + step / 2, cz + oz];
      o.faceN(ring.map(function (q) { return [q[0], y1, q[1]]; }), 'cd', [0, 1, 0]);
      for (i = 0; i < n; i++) {
        var j = (i + 1) % n;
        o.face([[ring[i][0], y0, ring[i][1]], [ring[j][0], y0, ring[j][1]], [ring[j][0], y1, ring[j][1]], [ring[i][0], y1, ring[i][1]]], 'cd', c3);
      }
    }
    o.heightAt = function (x, z) { for (var k = layers - 1; k >= 0; k--) if (inPoly(x, z, blobs[k])) return g + (k + 1) * step; return g; };
    return o;
  }

  // A wind turbine: tower, nacelle and a three-bladed rotor that faces the wind.
  function turbine(S, id, x, z, base, hub, R, o) {
    o = o || {};
    var t = S.obj(id, { kind: 'turbine', live: true, theme: 'renewables' });
    var r0 = hub * 0.035, r1 = hub * 0.018, wind = o.wind;
    if (o.offshore) {
      prism(t, x, z, S.seaY - 2, S.seaY + hub * 0.12, r0 * 1.5, r0 * 1.4, 10, 'cd');
      base = S.seaY + hub * 0.12;
    }
    prism(t, x, z, base, base + hub, r0, r1, 10, 'cd', false);
    var top = [x, base + hub, z];
    var back = mul(wind, -1), side = nrm(cross([0, 1, 0], back)), nl = hub * 0.13, nw = hub * 0.035, nh = hub * 0.04;
    var c0 = add(top, mul(wind, hub * 0.025)), c1 = add(top, mul(back, nl));
    var q = function (c, sx, sy) { return add(add(c, mul(side, sx)), [0, sy, 0]); };
    var nacelle = [q(c0, -nw, -nh), q(c0, nw, -nh), q(c0, nw, nh), q(c0, -nw, nh), q(c1, -nw, -nh), q(c1, nw, -nh), q(c1, nw, nh), q(c1, -nw, nh)];
    var nin = mix3(c0, c1, 0.5);
    [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]].forEach(function (f) { t.face(f.map(function (i) { return nacelle[i]; }), 'cd', nin); });
    t.rotor = {
      hub: add(top, mul(wind, hub * 0.06)), n: wind, R: R, e1: side, e2: [0, 1, 0],
      phase: o.phase || 0, period: o.period || 6, rootW: R * 0.075, tipW: R * 0.022
    };
    t.anchor = [x, base, z];
    t.groundY = o.offshore ? S.seaY : base;
    var g = t.groundY;
    t.shadow.push({ p: shadowPoly([[x - r0, base, z], [x + r0, base, z], [x - r1, base + hub, z], [x + r1, base + hub, z]], g, LIGHT), a: 0.9 });
    var disc = [], k;
    for (k = 0; k < 24; k++) { var a = k / 24 * TAU; disc.push(add(t.rotor.hub, add(mul(side, Math.cos(a) * R), [0, Math.sin(a) * R, 0]))); }
    t.shadow.push({ p: shadowPoly(disc, g, LIGHT), a: 0.16 });
    var f = [[x - r0 * 1.6, g + 0.05, z - r0 * 1.6], [x + r0 * 1.6, g + 0.05, z - r0 * 1.6], [x + r0 * 1.6, g + 0.05, z + r0 * 1.6], [x - r0 * 1.6, g + 0.05, z + r0 * 1.6]];
    t.ao.push({ p: f, a: 1 });
    return t;
  }

  // A conductor span between two attachment points (catenary-like sag), as a polyline.
  function span(a, b, sag, n) {
    var pts = [];
    n = n || 12;
    for (var i = 0; i <= n; i++) { var t = i / n, p = mix3(a, b, t); p[1] -= sag * 4 * t * (1 - t); pts.push(p); }
    return pts;
  }

  /* ───────────────────────────── the network: yards, bays, towers, corridors ───────────────────────────── */

  // Heights and sizes per voltage level, in model units.
  var YH = {
    EHV: { bus: 15, cond: 10.5, post: 10, brk: 8.5, brkW: 2.8, len: 22, beam: 27, ganW: 8.5, ins: 4.5, every: 14, tr: 1.35, sag: 1 },
    HV: { bus: 11, cond: 7.8, post: 7.5, brk: 6.2, brkW: 2.2, len: 13, beam: 18.5, ganW: 5.2, ins: 3, every: 10, tr: 0.95, sag: 0.8 }
  };
  // The line that switches in the animation: the spine L-AD, which the switching story's decision opens.
  var ANIMATED = ['L-AD'];
  var THEME_OF_LINE = { 'L-AD': 'switching', 'L-DI': 'balancing' };
  var WATCHED = 'L-DI';   // the line field shows this line's loading; its wire carries a soft glow (.l.watch)

  // A ground path (x, z points) that may cross the coast: points on the sea plate or the land, with
  // a vertical step at the shore (cables run engraved on both plates).
  function groundPath(S, pts, lift) {
    var L = S.layout, out = [], g = S.ground, sy = S.seaY;
    lift = lift || 0.12;
    function yAt(p) { return p[1] > coastZ(p[0], L) ? sy + lift : g + lift; }
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (i > 0) {
        var q = pts[i - 1], aSea = q[1] > coastZ(q[0], L), bSea = p[1] > coastZ(p[0], L);
        if (aSea !== bSea) {
          // bisect for the shore crossing
          var lo = 0, hi = 1;
          for (var k = 0; k < 24; k++) { var m = (lo + hi) / 2, x = lerp(q[0], p[0], m), z = lerp(q[1], p[1], m); if ((z > coastZ(x, L)) === aSea) lo = m; else hi = m; }
          var xs = lerp(q[0], p[0], lo), zs = lerp(q[1], p[1], lo);
          out.push([xs, aSea ? sy + lift : g + lift, zs], [xs, aSea ? g + lift : sy + lift, zs]);
        }
      }
      out.push([p[0], yAt(p), p[1]]);
    }
    return out;
  }
  // Offset a 2-D polyline sideways by d (left normal), for parallel cables laid together.
  function offsetPath(pts, d) {
    return pts.map(function (p, i) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      var dx = b[0] - a[0], dz = b[1] - a[1], l = Math.sqrt(dx * dx + dz * dz) || 1;
      return [p[0] - dz / l * d, p[1] + dx / l * d];
    });
  }

  // A transformer: tank, radiators, an HV and an LV bushing along "toward" (unit, LV to HV side).
  function xfmr(S, id, pos, s, toward, theme) {
    var o = S.obj(id, { kind: 'solid', theme: theme || null }), g = S.ground;
    var yaw = Math.atan2(-toward[2], toward[0]);
    obox(o, pos[0], g, pos[1], 9 * s, 6.4 * s, 6.6 * s, yaw, 'dk');
    var side = [-toward[2], 0, toward[0]];
    var rc = [pos[0] + side[0] * 4.6 * s, pos[1] + side[2] * 4.6 * s];
    obox(o, rc[0], g + 0.8 * s, rc[1], 6.4 * s, 1.6 * s, 5 * s, yaw, 'mt');      // radiator bank on one side
    var hv = [pos[0] + toward[0] * 2.8 * s, pos[1] + toward[2] * 2.8 * s], lv = [pos[0] - toward[0] * 2.8 * s, pos[1] - toward[2] * 2.8 * s];
    var hvTop = [hv[0], g + 12 * s, hv[1]], lvTop = [lv[0], g + 9.6 * s, lv[1]];
    o.line([[hv[0], g + 6.6 * s, hv[1]], hvTop], 'mt04', 1.1);
    o.line([[lv[0], g + 6.6 * s, lv[1]], lvTop], 'mt04', 0.9);
    o.anchor = [pos[0], g, pos[1]];
    castShadow(o, g, LIGHT, 1);
    return { o: o, hv: hvTop, lv: lvTop, pos: pos };
  }

  // Line-entry gantry: two lattice posts and a laced beam across the line; the circuit ends on the
  // beam through a strain insulator pointing toward the line (dir: unit vector to the line).
  function gantryLine(S, id, q, dir, lvl, theme) {
    var H = YH[lvl], o = S.obj(id, { kind: 'pylon', theme: theme || null }), g = S.ground;
    var ac = [-dir[2], 0, dir[0]], w = H.ganW, yb = H.beam, top = yb + (lvl === 'EHV' ? 3.2 : 2.4);
    var P = function (a, y, b) { b = b || 0; return [q[0] + ac[0] * a + dir[0] * b, g + y, q[1] + ac[2] * a + dir[2] * b]; };
    [-w, w].forEach(function (a) {
      var f0 = P(a, 0, -1.6), b0 = P(a, 0, 1.6), f1 = P(a, top, -0.6), b1 = P(a, top, 0.6);
      o.line([f0, f1], 'mt05', 1.0); o.line([b0, b1], 'mt07', 0.7);
      for (var k = 0; k < 3; k++) o.line([mix3(f0, f1, k / 3), mix3(b0, b1, (k + 1) / 3)], 'mt08', 0.4);
    });
    o.line([P(-w, yb, 0), P(w, yb, 0)], 'mt05', 1.0);
    o.line([P(-w, top, 0), P(w, top, 0)], 'mt06', 0.7);
    for (var k = 0; k < 4; k++) o.line([P(-w + k * w / 2, yb, 0), P(-w + (k + 0.5) * w / 2, top, 0), P(-w + (k + 1) * w / 2, yb, 0)], 'mt08', 0.4);
    var beam = P(0, yb, 0), att = P(0, yb - 0.3, H.ins);
    o.line([beam, att], 'mt04', 0.9);
    o.anchor = [q[0], g, q[1]];
    [-w, w].forEach(function (a) { postShadow(o, [P(a, 0)[0], P(a, 0)[2]], top, 1.2, g, 0.36); });
    return { att: att, beam: beam, q: q, dir: dir, o: o };
  }

  // EHV single-circuit lattice portal: two lattice legs across the line and a laced beam; the
  // circuit hangs from the beam center on a V-string.
  function towerPortal(S, id, pos, dir, theme) {
    var o = S.obj(id, { kind: 'pylon', theme: theme || null }), g = S.ground, ac = [-dir[2], 0, dir[0]];
    var P = function (a, y, b) { b = b || 0; return [pos[0] + ac[0] * a + dir[0] * b, g + y, pos[1] + ac[2] * a + dir[2] * b]; };
    var yb = 58, wl = 12.5, wt = 10;
    [-1, 1].forEach(function (s) {
      var f0 = P(s * wl, 0, -3), b0 = P(s * wl, 0, 3), f1 = P(s * wt, yb, -1.2), b1 = P(s * wt, yb, 1.2);
      o.line([f0, f1], 'mt05', 1.05); o.line([b0, b1], 'mt07', 0.8);
      for (var k = 0; k < 5; k++) o.line([mix3(f0, f1, k / 5), mix3(b0, b1, (k + 1) / 5)], 'mt08', 0.42);
    });
    var bl = P(-wt - 2.5, yb), br = P(wt + 2.5, yb), tl = P(-wt - 1.5, yb + 4.5), tr = P(wt + 1.5, yb + 4.5);
    o.line([bl, br], 'mt05', 1.05); o.line([tl, tr], 'mt06', 0.8);
    for (var k = 0; k < 6; k++) o.line([mix3(bl, br, k / 6), mix3(tl, tr, (k + 0.5) / 6), mix3(bl, br, (k + 1) / 6)], 'mt08', 0.42);
    var att = P(0, 51.5);
    o.line([P(-3.6, yb), att, P(3.6, yb)], 'mt04', 0.85);
    o.anchor = [pos[0], g, pos[1]];
    o.shadow.push({ p: shadowPoly([P(-wl, 0), P(wl, 0), P(-wt - 1.5, yb + 4.5), P(wt + 1.5, yb + 4.5)], g, LIGHT), a: 0.26 });
    [-1, 1].forEach(function (s) { o.ao.push({ p: [P(s * wl - 2, 0.05, -3.6), P(s * wl + 2, 0.05, -3.6), P(s * wl + 2, 0.05, 3.6), P(s * wl - 2, 0.05, 3.6)], a: 0.6 }); });
    return { c: att };
  }
  // EHV double-circuit lattice tower (T shape): a tapered mast, one cross-arm, one circuit at each
  // arm tip on an I-string. nv: the unit vector across the line that points north (+z side).
  function towerDouble(S, id, pos, dir, nv, theme) {
    var o = S.obj(id, { kind: 'pylon', theme: theme || null }), g = S.ground, ac = nv;
    var P = function (a, y, b) { b = b || 0; return [pos[0] + ac[0] * a + dir[0] * b, g + y, pos[1] + ac[2] * a + dir[2] * b]; };
    var h = 72, w0 = 7, w1 = 1.9, legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]], lv = [0, 0.3, 0.55, 0.78], ya = 56;
    legs.forEach(function (s) { o.line([P(s[0] * w0, 0, s[1] * w0 * 0.75), P(s[0] * w1, ya + 3, s[1] * w1 * 0.75)], 'mt05', 1.0); });
    for (var i = 0; i < lv.length - 1; i++) {
      var ya0 = h * lv[i], yb0 = h * lv[i + 1], wa = lerp(w0, w1, lv[i] / 0.82), wb = lerp(w0, w1, lv[i + 1] / 0.82);
      o.line([P(-wa, ya0, -wa * 0.75), P(wb, yb0, -wb * 0.75)], 'mt07', 0.5);
      o.line([P(wa, ya0, -wa * 0.75), P(-wb, yb0, -wb * 0.75)], 'mt07', 0.5);
      o.line([P(-wa, ya0, -wa * 0.75), P(-wb, yb0, wb * 0.75)], 'mt08', 0.45);
      o.line([P(wa, ya0, -wa * 0.75), P(wb, yb0, wb * 0.75)], 'mt06', 0.45);
    }
    var arm = 16;
    o.line([P(-arm, ya), P(arm, ya)], 'mt05', 1.05);
    o.line([P(-arm, ya), P(-w1, ya + 4), P(w1, ya + 4), P(arm, ya)], 'mt06', 0.6);
    o.line([P(0, ya + 3), P(0, h)], 'mt05', 1.0);
    var n = P(arm - 0.6, ya - 5.5), s2 = P(-arm + 0.6, ya - 5.5);
    o.line([P(arm - 0.6, ya), n], 'mt04', 0.85); o.line([P(-arm + 0.6, ya), s2], 'mt04', 0.85);
    o.anchor = [pos[0], g, pos[1]];
    o.shadow.push({ p: shadowPoly([P(-w0, 0), P(w0, 0), P(-arm, ya), P(arm, ya), P(0, h)], g, LIGHT), a: 0.3 });
    o.ao.push({ p: [P(-w0 * 1.2, 0.05, -w0), P(w0 * 1.2, 0.05, -w0), P(w0 * 1.2, 0.05, w0), P(-w0 * 1.2, 0.05, w0)], a: 0.6 });
    return { north: n, south: s2 };
  }
  // HV tubular steel pole with a short arm (one circuit) or two arms (two circuits).
  function poleHV(S, id, pos, dir, nv, two, theme) {
    var o = S.obj(id, { kind: 'pylon', theme: theme || null }), g = S.ground, h = 40, ya = 37, arm = 7.5;
    prism(o, pos[0], pos[1], g, g + h, 1.4, 0.85, 6, 'mt');
    var P = function (a, y) { return [pos[0] + nv[0] * a, g + y, pos[1] + nv[2] * a]; };
    var out = {};
    (two ? [1, -1] : [1]).forEach(function (s) {
      o.line([P(0, ya), P(s * arm, ya)], 'mt05', 1.0);
      o.line([P(0, ya - 3), P(s * arm * 0.7, ya)], 'mt06', 0.5);
      var a = P(s * arm, ya - 3.6);
      o.line([P(s * arm, ya), a], 'mt04', 0.8);
      out[s > 0 ? 'north' : 'south'] = a;
    });
    out.c = out.north;
    o.anchor = [pos[0], g, pos[1]];
    postShadow(o, pos, h, 1.4, g, 0.4);
    o.ao.push({ p: [[pos[0] - 2.2, g + 0.05, pos[1] - 2.2], [pos[0] + 2.2, g + 0.05, pos[1] - 2.2], [pos[0] + 2.2, g + 0.05, pos[1] + 2.2], [pos[0] - 2.2, g + 0.05, pos[1] + 2.2]], a: 0.6 });
    return out;
  }
  function towerKind(s) {
    if (/double-circuit tower/.test(s)) return 'dct';
    if (/double-circuit pole/.test(s)) return 'pole2';
    if (/pole/.test(s)) return 'pole';
    return 'portal';
  }
  function northOf(dir) { var a = [-dir[2], 0, dir[0]]; if (a[2] < -1e-9 || (Math.abs(a[2]) < 1e-9 && a[0] < 0)) a = mul(a, -1); return a; }

  // The yards of one substation: gravel surface, fence, busbars on posts, bays with their
  // equipment. Returns the bays with their terminal points; connections are made after the
  // transformers and gantries exist (buildNet, step 4).
  function yardDraw(S, Y, subst, opts) {
    var g = S.ground, H = YH[Y.level], F = Y.fence, ax = Y.axis;
    var W = ax === 'x' ? function (a, p) { return [a, p]; } : function (a, p) { return [p, a]; };
    var P3 = function (a, p, y) { var q = W(a, p); return [q[0], g + y, q[1]]; };
    var perpDir = ax === 'x' ? [0, 0, 1] : [1, 0, 0];
    var bus = Y.bus_at.slice().sort(function (a, b) { return a - b; }), busMid = (bus[0] + bus[bus.length - 1]) / 2;
    var pE0 = ax === 'x' ? F[1] : F[0], pE1 = ax === 'x' ? F[3] : F[2], aMin = ax === 'x' ? F[0] : F[1], aMax = ax === 'x' ? F[2] : F[3];
    var yth = opts.yardTheme || null;
    // the yard: gravel and fence, engraved on the ground
    var gr = S.obj('yard-' + Y.id, { layer: 'ground', kind: 'ground', theme: yth });
    gr.faceN([[F[0], g + 0.22, F[1]], [F[2], g + 0.22, F[1]], [F[2], g + 0.22, F[3]], [F[0], g + 0.22, F[3]]], 'yd', [0, 1, 0]);
    gr.line([[F[0], g + 0.3, F[1]], [F[2], g + 0.3, F[1]], [F[2], g + 0.3, F[3]], [F[0], g + 0.3, F[3]], [F[0], g + 0.3, F[1]]], 'fence', 0.7);
    // busbars (a gated bay moves no busbar end and no post)
    var ats = Y.bays.filter(function (b) { return !b.gate; }).map(function (b) { return b.at; });
    var a0 = Math.max(aMin + 2.5, Math.min.apply(null, ats) - 5), a1 = Math.min(aMax - 2.5, Math.max.apply(null, ats) + 5);
    var sect = Y.bays.filter(function (b) { return b.kind === 'sectionaliser'; })[0];
    var bb = S.obj('busbar-' + Y.id, { kind: 'solid', theme: yth });
    bus.forEach(function (p) {
      var segs = sect ? [[a0, sect.at - 2.6], [sect.at + 2.6, a1]] : [[a0, a1]];
      segs.forEach(function (sg) { bb.line([P3(sg[0], p, H.bus), P3(sg[1], p, H.bus)], 'bus', 1); });
      var n = Math.max(1, Math.round((a1 - a0) / (H.every * 2.2)));
      for (var k = 0; k <= n; k++) {
        var a = lerp(a0, a1, k / n);
        if (k > 0 && k < n && ats.some(function (x) { return Math.abs(x - a) < 5; })) continue;
        bb.line([P3(a, p, 0), P3(a, p, H.bus)], 'mt07', 0.7);
        bb.line([P3(a - 1.6, p, H.bus - 1.2), P3(a + 1.6, p, H.bus - 1.2)], 'mt07', 0.5);
      }
    });
    bb.anchor = P3((a0 + a1) / 2, busMid, 0);
    var out = [];
    Y.bays.forEach(function (bay) {
      var th = bay.theme || yth;
      var o = S.obj('bay-' + bay.id, { kind: 'solid', theme: th, gate: bay.gate || null });
      if (bay.kind === 'coupler' || bay.kind === 'sectionaliser') {
        var pc = bay.kind === 'coupler' ? busMid : bus[0], h0 = H.brk * 0.85;
        var c = W(bay.at, pc);
        if (bay.kind === 'coupler') box(o, c[0] - H.brkW / 2, g, c[1] - H.brkW / 2, c[0] + H.brkW / 2, g + h0, c[1] + H.brkW / 2, 'dk');
        else { var q2 = W(bay.at, pc); box(o, q2[0] - H.brkW / 2, g, q2[1] - H.brkW / 2, q2[0] + H.brkW / 2, g + h0, q2[1] + H.brkW / 2, 'dk'); }
        if (bay.kind === 'coupler') bus.forEach(function (p) { o.line([P3(bay.at, p, H.bus), P3(bay.at, pc, h0 + 0.3)], 'drop', 0.7); });
        else [-2.6, 2.6].forEach(function (da) { o.line([P3(bay.at + da, pc, H.bus), P3(bay.at, pc, h0 + 0.3)], 'drop', 0.7); });
        o.anchor = P3(bay.at, pc, 0);
        castShadow(o, g, LIGHT, 0.8);
        return;
      }
      // which side of the busbars the bay runs to
      var perpExit = ax === 'x' ? (bay.exit === 'n' || bay.exit === 's') : (bay.exit === 'e' || bay.exit === 'w');
      // a transformer or generator bay that leaves at a busbar end stands on its transformer's side, so the
      // connections do not cross
      var xfTgt = (bay.kind === 'transformer' || bay.kind === 'generator') && opts.xfPos ? opts.xfPos[bay.branch] : null;
      var tgt = bay.gantry || (bay.to && bay.to.pos) || xfTgt || null, sgn;
      if (perpExit) sgn = (bay.exit === 'n' || bay.exit === 'e') ? 1 : -1;
      else {
        var tp = tgt ? (ax === 'x' ? tgt[1] : tgt[0]) : busMid;
        sgn = (opts.endSide && opts.endSide[bay.id]) || (tp > busMid + 0.6 ? 1 : tp < busMid - 0.6 ? -1 : -1);
      }
      var p0 = sgn > 0 ? bus[bus.length - 1] : bus[0], pIn = sgn > 0 ? bus[0] : bus[bus.length - 1], edge = sgn > 0 ? pE1 : pE0;
      var avail = Math.abs(edge - p0);
      var onEdge = perpExit && bay.gantry && Math.abs((ax === 'x' ? bay.gantry[1] : bay.gantry[0]) - edge) < 1.5;
      var Lb = onEdge ? Math.max(4, avail - 2.4) : Math.max(4, Math.min(H.len, avail - 1.6));
      var dp = function (t) { return p0 + sgn * t; };
      // bus disconnectors: a post under each busbar, joined to the bay conductor
      bus.forEach(function (p) {
        o.line([P3(bay.at, p, 0), P3(bay.at, p, H.bus - 2.2)], 'mt05', 0.95);
        o.line([P3(bay.at, p, H.bus - 2.2), P3(bay.at, p, H.bus)], 'blade', 1.1);
      });
      // the bay conductor, from under the inner busbar to the terminal
      o.line([P3(bay.at, pIn, H.cond), P3(bay.at, dp(Lb), H.cond)], 'drop', 0.75);
      // circuit breaker (a dark pole on a frame) and the line or transformer disconnector
      var bq = W(bay.at, dp(0.4 * Lb)), bw = H.brkW;
      box(o, bq[0] - bw / 2, g, bq[1] - bw / 2, bq[0] + bw / 2, g + H.brk, bq[1] + bw / 2, 'dk');
      o.line([[bq[0], g + H.brk, bq[1]], [bq[0], g + H.cond, bq[1]]], 'drop', 0.6);
      var animated = bay.kind === 'line' && ANIMATED.indexOf(bay.branch) >= 0;
      // the switched line's disconnector is drawn about 1.6 times longer, as a model maker exaggerates a working
      // part (its bus-side post moves toward the breaker, so the blade spans 0.38 of the bay instead of 0.24)
      var q1 = dp((animated ? 0.54 : 0.68) * Lb), q2b = dp(0.92 * Lb);
      [q1, q2b].forEach(function (pp) { o.line([P3(bay.at, pp, 0), P3(bay.at, pp, H.post)], 'mt05', 0.9); });
      var pivot = P3(bay.at, q1, H.post + 0.4), tip = P3(bay.at, q2b, H.post + 0.4);
      if (animated) {
        // the blade is drawn live (canvas): hinged at the bus-side post, it swings up to open
        var key = bay.branch;
        var bl = S.obj('blade-' + bay.id, { kind: 'breaker', live: true, theme: 'switching' });
        bl.blades = [{ pivot: pivot, dir: nrm(sub(tip, pivot)), len: Math.abs(q2b - q1) }];
        bl.brk = [bq[0], g + H.brk * 0.7, bq[1]];   // the breaker's light (both ends, one event)
        bl.br = key; bl.anchor = mix3(pivot, tip, 0.5); bl.anchor[1] = g;
        (S.blades[key] = S.blades[key] || []).push(bl);
      } else o.line([pivot, tip], 'blade', 0.9);
      o.anchor = P3(bay.at, dp(Lb * 0.5), 0);
      o.shadow.push({ p: shadowPoly([[bq[0] - bw, g, bq[1] - bw], [bq[0] + bw, g, bq[1] + bw], [bq[0], g + H.brk, bq[1]]], g, LIGHT), a: 0.5 });
      o.ao.push({ p: [[bq[0] - bw, g + 0.05, bq[1] - bw], [bq[0] + bw, g + 0.05, bq[1] - bw], [bq[0] + bw, g + 0.05, bq[1] + bw], [bq[0] - bw, g + 0.05, bq[1] + bw]], a: 0.7 });
      var Lt = Lb;
      if (perpExit && bay.kind === 'transformer' && opts.xfPos && opts.xfPos[bay.branch]) {
        var xp = opts.xfPos[bay.branch], tpp = ax === 'x' ? xp[1] : xp[0];
        if ((tpp - edge) * sgn > 0) { Lt = Math.max(Lb, avail - 1.5); o.line([P3(bay.at, dp(Lb), H.cond), P3(bay.at, dp(Lt), H.cond)], 'drop', 0.75); }
      }
      var T = P3(bay.at, dp(Lt), H.cond);
      out.push({ bay: bay, Y: Y, sub: subst, T: T, T2: W(bay.at, dp(Lt)), inner: P3(bay.at, pIn, H.cond), sgn: sgn, perp: mul(perpDir, sgn), o: o, H: H, onEdge: onEdge, th: th });
    });
    return out;
  }

  // Build the whole network of one layout from its data (assets/net.js for wide, COMPACT for
  // phones). Returns lookups the scenery uses (bus terminals, transformers, ...).
  function buildNet(S, N, opts) {
    var g = S.ground;
    opts = opts || {};
    var br = {}; global.StudioNet.branches.forEach(function (b) { br[b.id] = b; });
    var busYard = {}; global.StudioNet.buses.forEach(function (b) { busYard[b.id] = b.yard; });
    var bays = [], subOfYard = {};
    // themes per bay
    N.substations.forEach(function (s) {
      s.yards.forEach(function (Y) {
        subOfYard[Y.id] = s.id;
        Y.bays.forEach(function (b) {
          if (b.kind === 'line') b.theme = THEME_OF_LINE[b.branch] || null;
          // the HVDC theme covers both links and all their converters (DC-2's bay, bank and gantry at C too); it only
          // lights them: DC-2 keeps its scheduled exchange, a fixed input
          else if (b.kind === 'converter') b.theme = 'hvdc';
          else if (b.kind === 'battery' || b.kind === 'generator') b.theme = 'balancing';
        });
      });
    });
    // 1. yards and bays (transformer positions first: a bay may run on to the fence toward one)
    var xfPos = {};
    N.substations.forEach(function (s) { (s.equipment || []).forEach(function (e) { if (e.id && e.pos) xfPos[e.id] = e.pos; }); });
    N.substations.forEach(function (s) {
      s.yards.forEach(function (Y) {
        var yt = (opts.yardTheme && opts.yardTheme[Y.id]) || null;
        bays = bays.concat(yardDraw(S, Y, s, { endSide: opts.endSide, yardTheme: yt, xfPos: xfPos }));
      });
    });
    var bayById = {}; bays.forEach(function (b) { bayById[b.bay.id] = b; });
    // 2. transformers (EHV/HV, HV/MV, generator step-up, battery), oriented LV to HV side
    var XF = {};
    N.substations.forEach(function (s) {
      (s.equipment || []).forEach(function (e) {
        if (!e.pos) return;
        var isBank = /converter transformer bank/.test(e.kind);
        var id = e.id || (s.id + '-bank-' + e.pos.join('-'));
        var conn = bays.filter(function (b) { return isBank ? (b.bay.kind === 'converter' && b.sub.id === s.id) : b.bay.branch === e.id; });
        if (isBank) conn = conn.sort(function (a, b) { return d2(a.bay.gantry, e.pos) - d2(b.bay.gantry, e.pos); }).slice(0, 1);
        var hvSide = null, lvSide = null;
        conn.forEach(function (c) {
          var lv = c.Y.level === 'EHV' ? 0 : 1;
          if (isBank || e.id === 'T-GSU' || /T-(F|G|J|BESS)/.test(e.id || '')) hvSide = c;
          else if (lv === 0) hvSide = c; else lvSide = c;
        });
        var toward;
        if (isBank) toward = unit2(e.pos, conn[0] ? conn[0].bay.gantry : [e.pos[0], e.pos[1] - 1]);
        else if (hvSide && lvSide) toward = unit2(lvSide.T2, hvSide.T2);
        else if (hvSide) toward = unit2(e.pos, hvSide.T2);
        else toward = [1, 0, 0];
        // square to the yard
        if (!isBank) toward = Math.abs(toward[0]) >= Math.abs(toward[2]) ? [toward[0] >= 0 ? 1 : -1, 0, 0] : [0, 0, toward[2] >= 0 ? 1 : -1];
        var s0 = isBank ? 1.25 : e.id === 'T-GSU' ? 1.45 : (hvSide && hvSide.Y.level === 'EHV') ? YH.EHV.tr : YH.HV.tr;
        if (/T-(F|G|J|BESS)/.test(e.id || '') && !e.gate) s0 = YH.HV.tr * 0.85;   // not the gated T-GE (an EHV step-up)
        if (opts.trScale) s0 *= opts.trScale;
        var th = isBank ? 'hvdc' : e.id === 'T-GSU' || e.id === 'T-BESS' || e.gate ? 'balancing' : null;   // any gated step-up (T-GE, T-BM); every converter bank, DC-2's too
        var n0 = S.objs.length;
        XF[id] = xfmr(S, 'tr-' + id, e.pos, s0, toward, th);
        if (e.gate) for (var gi = n0; gi < S.objs.length; gi++) S.objs[gi].gate = e.gate;   // the gated equipment
        XF[id].hvBay = hvSide; XF[id].lvBay = lvSide; XF[id].bank = isBank; XF[id].e = e;
      });
    });
    // 3. corridors: towers, gantries and one wire per circuit
    var gantryOfBay = {};
    N.corridors.forEach(function (C) {
      var tk = towerKind(C.tower), lvl = C.level, th = null;
      C.circuits.forEach(function (c) { if (THEME_OF_LINE[c]) th = THEME_OF_LINE[c]; });
      var path = C.path;
      var segDir = function (i) { return unit2(path[i], path[i + 1]); };
      // towers with their direction (angle towers bisect)
      var T = C.towers.map(function (t, i) {
        var best = 0, bd = 1e9;
        for (var k = 0; k < path.length - 1; k++) {
          var a = path[k], b = path[k + 1], vx = b[0] - a[0], vz = b[1] - a[1], l2 = vx * vx + vz * vz || 1;
          var u = clamp(((t.pos[0] - a[0]) * vx + (t.pos[1] - a[1]) * vz) / l2, 0, 1);
          var dd = d2(t.pos, [a[0] + vx * u, a[1] + vz * u]);
          if (dd < bd - 1e-6) { bd = dd; best = k; }
        }
        var dir = segDir(best);
        if (t.type === 'angle') {
          var k2 = d2(t.pos, path[best]) < 1 ? best - 1 : best + 1;
          if (k2 >= 0 && k2 < path.length - 1) dir = nrm(add(segDir(best), segDir(k2)));
        }
        var nv = northOf(dir), id = C.id + '-t' + i, att;
        if (tk === 'portal') att = towerPortal(S, id, t.pos, dir, th);
        else if (tk === 'dct') att = towerDouble(S, id, t.pos, dir, nv, th);
        else att = poleHV(S, id, t.pos, dir, nv, tk === 'pole2', th);
        return { pos: t.pos, att: att, dir: dir, nv: nv };
      });
      C.circuits.forEach(function (cid) {
        var b = br[cid], arm = b.arm || 'c';
        if (tk === 'portal' || tk === 'pole') arm = 'c';
        var ends = bays.filter(function (x) { return x.bay.kind === 'line' && x.bay.branch === cid; });
        var start = null, end = null;
        ends.forEach(function (x) { if (d2(x.bay.gantry, path[0]) < d2(x.bay.gantry, path[path.length - 1])) start = x; else end = x; });
        var cth = THEME_OF_LINE[cid] || null;
        function gantryFor(x, first) {
          var toward = T.length ? T[first ? 0 : T.length - 1].pos : path[first ? path.length - 1 : 0];
          var dir = unit2(x.bay.gantry, toward);
          var G = gantryLine(S, 'gantry-' + x.bay.id, x.bay.gantry, dir, lvl, cth || x.th);
          gantryOfBay[x.bay.id] = G;
          return G;
        }
        var chain = [];
        if (start) chain.push(gantryFor(start, true).att);
        T.forEach(function (t) { chain.push(t.att[arm] || t.att.c); });
        if (end) chain.push(gantryFor(end, false).att);
        else {
          // the tie leaves the plinth at its edge: the wire stops at the cut face
          var last = T[T.length - 1], lp = last.att[arm] || last.att.c, ep = path[path.length - 1];
          chain.push([ep[0] + (lp[0] - last.pos[0]), lp[1] - 3, ep[1] + (lp[2] - last.pos[1])]);
        }
        var wcls = lvl === 'EHV' ? 'w-ehv' : 'w-hv', w = S.obj('wire-' + cid, { kind: 'wire', theme: cth, sw: ANIMATED.indexOf(cid) >= 0 ? cid : null, watch: cid === WATCHED });
        var pts = [];
        for (var i = 0; i < chain.length - 1; i++) {
          var L = d2([chain[i][0], chain[i][2]], [chain[i + 1][0], chain[i + 1][2]]);
          var sp = span(chain[i], chain[i + 1], (lvl === 'EHV' ? 3 : 2) + L * 0.022, Math.max(6, Math.round(L / 6)));
          w.line(sp, wcls, 1);
          pts = pts.concat(i ? sp.slice(1) : sp);
        }
        w.anchor = mix3([path[0][0], g, path[0][1]], [path[path.length - 1][0], g, path[path.length - 1][1]], 0.5);
        // flow lane: + along the drawn wire is from the start bay's bus to the end
        var startBus = start ? busOfYard(start.Y.id) : null;
        var sign = startBus === b.a ? 1 : startBus === b.b ? -1 : 1;
        S.lanes.push({ id: cid, src: { type: 'branch', br: cid, sign: sign }, pts: pts, w: lvl === 'EHV' ? 'ehv' : 'hv', theme: cth });
      });
    });
    function busOfYard(yid) { var r = null; global.StudioNet.buses.forEach(function (b) { if (b.yard === yid && !/_mv|_gen/.test(b.id)) r = r || b.id; }); return r; }
    // 4. connections from the bays to their gantries, transformers, cables
    var dr = function (id, th) { return S.obj(id, { kind: 'wire', theme: th || null }); };
    S.gatedLanes = S.gatedLanes || [];
    bays.forEach(function (x) {
      var b = x.bay, o = dr('conn-' + b.id, x.th), H = x.H;
      o.anchor = [x.T[0], g, x.T[2]];
      if (b.gate) o.gate = b.gate;
      // the span from the line disconnector to the gantry is on the line side: dashed with the wire when the line is out
      if (b.kind === 'line' && ANIMATED.indexOf(b.branch) >= 0) o.sw = b.branch;
      if (b.kind === 'line') {
        var G = gantryOfBay[b.id];
        if (!G) return;
        o.line(span(x.T, G.beam, 0.6, 6), 'drop', 0.75);
      } else if (b.kind === 'converter') {
        var G2 = gantryLine(S, 'gantry-' + b.id, b.gantry, [0, 0, x.sgn > 0 ? 1 : -1], x.Y.level, x.th);   // the bay's own theme (hvdc for both links)
        o.line(span(x.T, G2.beam, 0.5, 5), 'drop', 0.75);
        var bank = null;
        Object.keys(XF).forEach(function (k) { if (XF[k].bank && XF[k].hvBay === x) bank = XF[k]; });
        if (bank) o.line(span(G2.att, bank.hv, 0.8, 6), 'drop', 0.75);
      } else if (b.kind === 'transformer' || b.kind === 'generator') {
        var X = XF[b.branch];
        if (!X) return;
        var tp = X.hvBay === x ? X.hv : X.lv;
        // a gated generator bay whose step-up transformer stands more than 30 units from its terminal (bay I20 and the
        // biomass power station's T-BM) ends in a cable sealing end; the station draws the EHV cable on from there
        if (b.kind === 'generator' && b.gate && d2(x.T2, X.pos) > 30) { o.line([[x.T[0], g, x.T[2]], x.T], 'mt05', 1.0); x.cableStart = [x.T2[0], x.T2[1]]; }
        else o.line(span(x.T, tp, 0.8, 8), 'drop', 0.75);
        // the thermal plant's output enters E along its generator bay (flow lights; from the fence to the busbars);
        // a gated generator bay (GATED_GEN: the gas-engine plant at I, the biomass power station's bay I20) keeps its
        // lane aside, and the layout adds it last
        if (b.kind === 'generator' && b.gate && GATED_GEN[b.gate]) S.gatedLanes.push({ id: GATED_GEN[b.gate].bay, src: { type: 'el', el: GATED_GEN[b.gate].el, share: 1, sign: 1, cap: 300 }, pts: [x.T, x.inner], w: 'cable', theme: 'balancing', gate: b.gate });
        else if (b.kind === 'generator') S.lanes.push({ id: 'gen-' + b.id, src: { type: 'el', el: 'thermal', share: 1, sign: 1, cap: 850 }, pts: [x.T, x.inner], w: 'cable', theme: 'balancing' });
      } else if (b.kind === 'battery' || b.kind === 'feeder') {
        // a cable sealing end at the terminal; the cable runs on (engraved) from there
        o.line([[x.T[0], g, x.T[2]], x.T], 'mt05', 1.0);
        x.cableStart = [x.T2[0], x.T2[1]];
      }
    });
    bays.forEach(function (x) {
      if (x.bay.kind !== 'battery' || !XF['T-BESS']) return;
      var tb = XF['T-BESS'];
      cableObj(S, 'hv-battery', [x.T2, [tb.hv[0], tb.hv[2]]], 'feeder', 1.0, 'balancing', { id: 'hv-battery', src: { type: 'el', el: 'battery', share: 1, sign: -1, cap: 250 }, w: 'cable' });
      var r = dr('riser-bess', 'balancing'); r.line([[tb.hv[0], g + 0.2, tb.hv[2]], tb.hv], 'drop', 0.7); r.anchor = [tb.hv[0], g, tb.hv[2]];
    });
    // HV/MV units: the MV side drops to the ground (cables onward)
    Object.keys(XF).forEach(function (k) {
      var X = XF[k];
      if (!X.lvBay && !X.bank) { var o = dr('lvdrop-' + k, X.o.theme); o.line([X.lv, [X.lv[0], g + 0.2, X.lv[2]]], 'drop', 0.7); o.anchor = [X.lv[0], g, X.lv[2]]; if (X.e && X.e.gate) o.gate = X.e.gate; }
    });
    return { bays: bayById, XF: XF, gantry: gantryOfBay };
  }

  /* ───────────────────────────── scenery ───────────────────────────── */

  // engraved cable on the ground (or the sea plate), with an optional flow lane
  function cableObj(S, id, pts2, cls, w, theme, lane) {
    var o = S.obj(id, { layer: 'ground', kind: 'ground', theme: theme || null }), p3 = groundPath(S, pts2);
    o.line(p3, cls, w);
    if (lane) { lane.pts = p3; lane.theme = lane.theme || theme || null; S.lanes.push(lane); }
    return o;
  }

  // ── Recognizable components: each exaggerates the one feature it is known by. Details that light up
  // at night (windows, glazing, seams, deck lights) are quads or points attached to their object
  // (o.fxq, o.fxc), so they sort with it, appear in the highlight layers, and are drawn again on the
  // canvas when the object is an occluder. Night colors come from the palette (dark only).
  function fxOf(S) { return S.fx || (S.fx = { stacks: [] }); }
  function fxq(o, cls, pts) { (o.fxq || (o.fxq = [])).push({ c: cls, p: pts }); }
  function fxRect(o, cls, x0, y0, x1, y1, z) { fxq(o, cls, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]]); }
  function fxPt(o, cls, p, r) { (o.fxc || (o.fxc = [])).push({ c: cls, p: p, r: r }); }

  // A low-pitched roof along x over a box (x0..x1, z0..z1) at eave height y, ridge rise r.
  function roofX(o, x0, x1, z0, z1, y, r, mat) {
    var zm = (z0 + z1) / 2, inside = [(x0 + x1) / 2, y - 1, zm];
    o.face([[x0 - 0.6, y, z0 - 0.6], [x1 + 0.6, y, z0 - 0.6], [x1 + 0.6, y + r, zm], [x0 - 0.6, y + r, zm]], mat, inside);
    o.face([[x0 - 0.6, y, z1 + 0.6], [x1 + 0.6, y, z1 + 0.6], [x1 + 0.6, y + r, zm], [x0 - 0.6, y + r, zm]], mat, inside);
    o.face([[x0, y, z0], [x0, y, z1], [x0, y + r, zm]], mat, inside);
    o.face([[x1, y, z0], [x1, y, z1], [x1, y + r, zm]], mat, inside);
  }

  // CONVERTER STATION: the valve halls are the tallest boxes on the coast, with a parapet, scored
  // cladding and a thin seam of light under the eaves (the valves inside; warm white in dark, a dark
  // reveal in light).
  function converterHall(S, id, b, h, theme, scored) {
    var o = S.obj(id, { kind: 'solid', theme: theme }), g = S.ground;
    box(o, b[0], g, b[1], b[2], g + h, b[3], 'cd');
    if (scored) for (var x = b[0] + 4; x < b[2] - 1; x += 5) o.line([[x, g + 1, b[1] - 0.3], [x, g + h - 1, b[1] - 0.3]], 'cd09', 0.45);
    o.line([[b[0], g + h * 0.72, b[1] - 0.3], [b[2], g + h * 0.72, b[1] - 0.3]], 'cd08', 0.55);
    o.line([[b[0], g + h + 1.2, b[1]], [b[2], g + h + 1.2, b[1]]], 'cd12', 0.7);
    if (scored) fxRect(o, 'fx-seam', b[0] + 1.5, g + h - 6.5, b[2] - 1.5, g + h - 4.8, b[1] - 0.35);
    castShadow(o, g, LIGHT, 1);
    return o;
  }
  // the converter transformers' valve-side bushings, entering the valve hall's wall
  function bushings(S, id, banks, wallZ, theme) {
    var g = S.ground, o = S.obj(id, { kind: 'solid', theme: theme === undefined ? 'hvdc' : theme });
    banks.forEach(function (p) { [-2.6, 2.6].forEach(function (dx) { o.line([[p[0] + dx, g + 11.5, p[1] + 2.5], [p[0] + dx * 0.6, g + 21, wallZ - 0.2]], 'mt04', 1.15); }); });
    o.anchor = [banks[0][0], g, wallZ - 4];
  }

  // OFFSHORE PLATFORMS: jacket legs with cross bracing, a box topside, a pedestal crane; on the
  // converter platform an octagonal helideck cantilevered past the right edge with its touchdown ring
  // (a ring, no letter); a row of small deck lights (dark only). Returns the status lamp's position.
  function platform(S, id, px, pz, w, d, h, sea, big) {
    var o = S.obj(id, { kind: 'solid', theme: 'hvdc' });
    [[-w * 0.36, -d * 0.34], [w * 0.36, -d * 0.34], [w * 0.36, d * 0.34], [-w * 0.36, d * 0.34]].forEach(function (q) { o.line([[px + q[0], sea, pz + q[1]], [px + q[0] * 0.8, sea + h, pz + q[1] * 0.8]], 'mt05', 1.3); });
    o.line([[px - w * 0.36, sea + h * 0.3, pz - d * 0.34], [px + w * 0.29, sea + h * 0.8, pz - d * 0.27]], 'mt07', 0.6);
    o.line([[px + w * 0.36, sea + h * 0.3, pz - d * 0.34], [px - w * 0.29, sea + h * 0.8, pz - d * 0.27]], 'mt07', 0.6);
    box(o, px - w / 2, sea + h, pz - d / 2, px + w / 2, sea + h + (big ? 36 : 22), pz + d / 2, 'cd');
    if (big) {
      box(o, px - w / 2 + 4, sea + h + 36, pz - d / 2 + 6, px + 2, sea + h + 46, pz + d / 2 - 6, 'cd');
      box(o, px + 6, sea + h + 36, pz - d / 2 + 4, px + w / 2 + 4, sea + h + 39, pz + d / 2 - 4, 'cd');
    }
    o.anchor = [px, sea, pz];
    castShadow(o, sea, LIGHT, 1);
    var top = sea + h + (big ? 36 : 22), kit = S.obj(id + '-kit', { kind: 'solid', theme: 'hvdc' });
    kit.line([[px - w * 0.36, sea + h * 0.05, pz - d * 0.34], [px + w * 0.3, sea + h * 0.55, pz - d * 0.3]], 'mt07', 0.55);
    kit.line([[px + w * 0.36, sea + h * 0.05, pz - d * 0.34], [px - w * 0.3, sea + h * 0.55, pz - d * 0.3]], 'mt07', 0.55);
    var cb = [px - w / 2 + 5, top, pz - d / 2 + 4];
    kit.line([cb, add(cb, [0, 12, 0])], 'mt05', 1.3);
    kit.line([add(cb, [0, 11, 0]), add(cb, [-16, 26, -2])], 'mt05', 1.0);
    kit.line([add(cb, [0, 13, 0]), add(cb, [-16, 26, -2])], 'mt07', 0.5);
    if (big) {
      var hc = [px + w / 2 + 6, top + 4.2, pz + 2], oc = [], ring = [];
      for (var i = 0; i < 8; i++) { var a = (i + 0.5) / 8 * TAU; oc.push([hc[0] + 12 * Math.cos(a), hc[1], hc[2] + 12 * Math.sin(a)]); }
      kit.faceN(oc, 'cd', [0, 1, 0]);
      kit.faceN(oc.map(function (p) { return [p[0], p[1] - 1.2, p[2]]; }), 'cd', [0, -1, 0]);
      for (var j = 0; j <= 20; j++) { var a2 = j / 20 * TAU; ring.push([hc[0] + 7 * Math.cos(a2), hc[1] + 0.05, hc[2] + 7 * Math.sin(a2)]); }
      kit.line(ring, 'dk05', 0.7);
      kit.line([[hc[0] - 9, hc[1] - 1.2, hc[2] - 4], [px + w / 2 - 2, top - 8, hc[2] - 4]], 'mt06', 0.6);
    }
    kit.anchor = [px, sea, pz - d / 2];
    var n = big ? 7 : 4;
    for (var k = 0; k < n; k++) fxPt(kit, 'fx-deck', [px - w / 2 + 4 + k * (w - 8) / (n - 1), sea + h + 2.2, pz - d / 2 - 0.3], 0.8);
    return [px - w * 0.18, sea + h + (big ? 48 : 24), pz - d * 0.1];
  }
  function trees(S, list) {
    var g = S.ground;
    list.forEach(function (q, i) {
      var tr = S.obj('tree-' + i, { kind: 'tree' });
      tr.line([[q[0], g, q[1]], [q[0], g + q[2] * 0.9, q[1]]], 'mt06', 1);
      tr.sphere([q[0], g + q[2] * 1.45, q[1]], q[2] * 0.75, 'cd');
      tr.anchor = [q[0], g, q[1]];
      castShadow(tr, g, LIGHT, 0.9);
    });
  }
  function solarField(S, rows, z0, z1, w, postsN) {
    var g = S.ground;
    var tracks = S.obj('trackers', { kind: 'trackers', live: true, theme: 'renewables' }), rowsT = [];
    rows.forEach(function (tx, i) {
      rowsT.push({ x: tx, z0: z0, z1: z1, y: g + 6, w: w, seg: 3 });
      var posts = S.obj('tr-posts-' + i, { kind: 'solid', theme: 'renewables' });
      for (var q = 0; q < postsN; q++) { var zz = lerp(z0 + 6, z1 - 6, q / (postsN - 1)); posts.line([[tx, g, zz], [tx, g + 5.4, zz]], 'mt05', 1); }
      posts.anchor = [tx, g, (z0 + z1) / 2];
    });
    tracks.rows = rowsT; tracks.anchor = [(rows[0] + rows[rows.length - 1]) / 2, g, (z0 + z1) / 2];
    var trSh = S.obj('tr-shadow', { layer: 'ground', kind: 'ground' });
    rowsT.forEach(function (r) { trSh.shadow.push({ p: [[r.x - 5, g + 0.05, r.z0 + 6], [r.x + 12, g + 0.05, r.z0 + 6], [r.x + 12, g + 0.05, r.z1 + 6], [r.x - 5, g + 0.05, r.z1 + 6]], a: 0.5 }); });
    return tracks;
  }

  // BATTERY PARK: rows of identical low enclosures, each with its cooling unit at the right end (the
  // battery icon's terminal nub) and one continuous charge bar along its front, teal-green, filling and
  // draining with the battery's state (live: o.bars). One bar, not five cells: separate cells read as
  // house windows.
  function batteryPark(S, cols, rowsZ, cw, cd, ch) {
    var g = S.ground, bat = S.obj('battery', { kind: 'battery', live: true, theme: 'balancing' }), bars = [];
    ch = ch || 9.5;
    var bh = Math.min(5.4, ch * 0.45), by = g + (ch - bh) * 0.5;
    rowsZ.forEach(function (z0, ri) {
      cols.forEach(function (x0, c) {
        var o = S.obj('bat-' + ri + '-' + c, { kind: 'solid', theme: 'balancing' });
        box(o, x0, g + 0.6, z0, x0 + cw, g + ch, z0 + cd, 'cd');
        box(o, x0 + 1, g, z0 + 1, x0 + cw - 1, g + 0.6, z0 + cd - 1, 'dk');                 // plinth shadow gap
        box(o, x0 + cw, g + 2.2, z0 + 2.2, x0 + cw + 2.8, g + ch - 2.6, z0 + cd - 2.2, 'dk');  // cooling unit: the nub
        o.line([[x0 + 0.4, g + ch + 0.05, z0 - 0.05], [x0 + cw - 0.4, g + ch + 0.05, z0 - 0.05]], 'cd07', 0.5);
        castShadow(o, g, LIGHT, 1);
        bars.push({ x0: x0 + 2.2, x1: x0 + cw - 2.2, y0: by, y1: by + bh, z: z0 - 0.15, row: ri, i: c });
      });
    });
    bat.cells = bars; bat.bars = bars; bat.anchor = [(cols[0] + cols[cols.length - 1] + cw) / 2, g, rowsZ[0]];
    return bat;
  }

  // TOWN: gable-fronted houses turned to face the viewer, steep roofs, rows along streets, a few flat-roofed
  // blocks with window grids. Windows are dark glass by day; at night a share of them is lit, and that share
  // follows the town's load (each window carries a tier w1..w3, lit while the stage's data-load is at least
  // its tier; w0 never lights; doors never light).
  var TOWN = {
    wide: {
      houses: [
        // front row along the plinth edge (under the cable fan)
        [1419, 52], [1436, 50], [1453, 52], [1470, 50], [1487, 52], [1504, 50], [1521, 51], [1583, 50],
        // the middle, between the town substations
        [1478, 142], [1496, 140], [1514, 142], [1532, 138],
        [1488, 162], [1506, 160],
        // back row along the street
        [1420, 180], [1438, 182], [1474, 180], [1492, 182], [1510, 180], [1528, 182], [1546, 180], [1564, 182], [1582, 180]
      ],
      blocks: [[1540, 96, 20, 16, 34], [1576, 104, 18, 18, 28], [1574, 138, 18, 14, 22]],
      streets: [[[1412, 170], [1592, 170]], [[1468, 170], [1468, 128]], [[1526, 170], [1526, 124], [1532, 80]]]
    },
    compact: {
      houses: [[334, 40], [350, 44], [366, 40], [382, 44], [398, 40], [414, 44], [430, 40], [446, 44], [462, 40], [478, 44], [494, 40]],
      blocks: [[352, 82, 16, 14, 26], [404, 86, 16, 14, 32], [452, 88, 14, 12, 22]],
      streets: [[[326, 60], [500, 60]]]
    }
  };
  // the town's load tiers (MW drawn): up to 800 one tier, up to 1050 two, above that three
  var LOAD_TIERS = [800, 1050];
  function loadTier(mw) { return mw > LOAD_TIERS[1] ? 3 : mw > LOAD_TIERS[0] ? 2 : 1; }
  function winCls(i) { var r = rnd(i * 1.37 + 0.3); return 'fx-win w' + (r < 0.35 ? 1 : r < 0.55 ? 2 : r < 0.75 ? 3 : 0); }
  function town(S, T, compact) {
    var g = S.ground, k = compact ? 0.8 : 1;
    var rd = S.obj('town-streets', { layer: 'ground', kind: 'ground' });
    (T.streets || []).forEach(function (p) { rd.line(p.map(function (q) { return [q[0], g + 0.08, q[1]]; }), 'road', 2.4); });
    T.houses.forEach(function (q, i) {
      var o = S.obj('house-' + i, { kind: 'solid', theme: null });
      var w = (13 + (i % 3)) * k, d = (17 + (i % 2) * 3) * k, wall = (8.5 + (i % 4) * 0.8) * k, ridge = wall + w * 0.72;
      house(o, q[0], g, q[1], d, w, wall, ridge, Math.PI / 2, 'cd');
      var zf = q[1] - d / 2 - 0.12;
      fxRect(o, 'fx-door', q[0] - 1.1 * k, g, q[0] + 1.1 * k, g + 4.6 * k, zf);
      fxRect(o, winCls(i * 3 + 1), q[0] - w / 2 + 1.8 * k, g + 4.6 * k, q[0] - w / 2 + 4.6 * k, g + 7.2 * k, zf);
      fxRect(o, winCls(i * 3 + 2), q[0] + w / 2 - 4.6 * k, g + 4.6 * k, q[0] + w / 2 - 1.8 * k, g + 7.2 * k, zf);
      fxRect(o, winCls(i * 3 + 3), q[0] - 1.2 * k, g + wall + 1.6 * k, q[0] + 1.2 * k, g + wall + 4 * k, zf);
      castShadow(o, g, LIGHT, 1);
    });
    T.blocks.forEach(function (q, i) {
      var o = S.obj('block-' + i, { kind: 'solid', theme: null }), x0 = q[0] - q[2] / 2, x1 = q[0] + q[2] / 2, z0 = q[1] - q[3] / 2, z1 = q[1] + q[3] / 2, h = q[4];
      box(o, x0, g, z0, x1, g + h, z1, 'cd');
      box(o, x0 + 3, g + h, z0 + 3, x0 + 8, g + h + 3, z0 + 7, 'cd');   // roof plant room
      for (var r = 0; r < Math.floor((h - 4) / 5.5); r++) for (var c = 0; c < 4; c++) {
        var wx = x0 + 2 + c * (q[2] - 4) / 4;
        fxRect(o, winCls(400 + i * 50 + r * 4 + c), wx + 0.5, g + 3 + r * 5.5, wx + (q[2] - 4) / 4 - 0.7, g + 5.6 + r * 5.5, z0 - 0.12);
      }
      castShadow(o, g, LIGHT, 1);
    });
  }
  // a small HV/MV substation in the town: fence, gravel, three small transformers, a switch room
  function townSub(S, id, pos, w, d) {
    var g = S.ground, F = [pos[0] - w / 2, pos[1] - d / 2, pos[0] + w / 2, pos[1] + d / 2];
    var gr = S.obj(id + '-yard', { layer: 'ground', kind: 'ground' });
    gr.faceN([[F[0], g + 0.22, F[1]], [F[2], g + 0.22, F[1]], [F[2], g + 0.22, F[3]], [F[0], g + 0.22, F[3]]], 'yd', [0, 1, 0]);
    gr.line([[F[0], g + 0.3, F[1]], [F[2], g + 0.3, F[1]], [F[2], g + 0.3, F[3]], [F[0], g + 0.3, F[3]], [F[0], g + 0.3, F[1]]], 'fence', 0.6);
    for (var k = 0; k < 3; k++) xfmr(S, id + '-t' + k, [F[0] + w * (0.2 + 0.24 * k), pos[1] - d * 0.12], 0.5, [0, 0, 1], null);
    var o = S.obj(id + '-room', { kind: 'solid' });
    box(o, F[2] - w * 0.2, g, F[1] + 1.5, F[2] - 1.5, g + 6, F[3] - 1.5, 'cd');
    castShadow(o, g, LIGHT, 1);
  }

  // THERMAL PLANT: a two-unit combined-cycle gas plant (850 MW, with a 300 MW stable minimum).
  // It reads from its silhouette: two tall slender stacks behind two tall boiler blocks (heat-recovery
  // steam generators, gas-turbine inlets in front), a long gabled turbine hall with a band of high
  // windows (lit at night), and the air-cooled condenser as a raised table of fans. No cooling tower (it
  // reads as nuclear or coal), no smoke, no obstruction lights (red is the over-limit color); the
  // page draws a faint vapor trace from each stack whose strength follows the plant's output (S.fx.stacks).
  function thermalPlant(S, Z, gsu, compact) {
    var g = S.ground, k = compact ? 0.62 : 1, x0 = Z[0], z0 = Z[1], fx = fxOf(S);
    var sx = compact ? [10, 30] : [21, 45];
    (compact ? [[2, 20], [22, 40]] : [[12, 30], [36, 54]]).forEach(function (b, i) {
      var o = S.obj('plant-hrsg-' + i, { kind: 'solid', theme: 'balancing' });
      box(o, x0 + b[0] * k, g, z0 + 14 * k, x0 + b[1] * k, g + 46 * k, z0 + 44 * k, 'cd');
      box(o, x0 + (b[0] + 3) * k, g + 46 * k, z0 + 22 * k, x0 + (b[1] - 3) * k, g + 51 * k, z0 + 38 * k, 'cd');
      box(o, x0 + (b[0] + 4) * k, g, z0 + 4 * k, x0 + (b[1] - 4) * k, g + 18 * k, z0 + 14 * k, 'cd');   // inlet duct / gas-turbine enclosure
      [22, 30, 38].forEach(function (yy) { o.line([[x0 + b[0] * k, g + yy * k, z0 + 14 * k - 0.2], [x0 + b[1] * k, g + yy * k, z0 + 14 * k - 0.2]], 'cd08', 0.45); });
      castShadow(o, g, LIGHT, 1);
    });
    sx.forEach(function (x, i) {
      var cx = x0 + x * k, cz = z0 + 52 * k, H = (compact ? 112 : 136) * k, r0 = 6.6 * k, r1 = 5.2 * k;
      var o = S.obj('plant-stack-' + i, { kind: 'solid', theme: 'balancing' });
      prism(o, cx, cz, g, g + H, r0, r1, 16, 'cd', false);
      var rb = r1 + (r0 - r1) * 9 / 136 + 0.4 * k;
      prism(o, cx, cz, g + H - 10 * k, g + H - 4 * k, rb, rb, 16, 'dk', false);
      var ring = []; for (var a = 0; a < 16; a++) { var an = (a + 0.5) / 16 * TAU; ring.push([cx + r1 * Math.cos(an), g + H, cz + r1 * Math.sin(an)]); }
      o.faceN(ring, 'dk', [0, 1, 0]);
      o.anchor = [cx, g, cz];
      castShadow(o, g, LIGHT, 1);
      fx.stacks.push({ top: [cx, g + H, cz], r: r1, phase: i * 0.41 });
    });
    var hx0 = x0 + (compact ? 44 : 60) * k, hx1 = x0 + (compact ? 96 : 126) * k, hz0 = z0 + 10 * k, hz1 = z0 + 44 * k, hh = 26 * k;
    var th = S.obj('plant-hall', { kind: 'solid', theme: 'balancing' });
    box(th, hx0, g, hz0, hx1, g + hh, hz1, 'cd', { top: true });
    roofX(th, hx0, hx1, hz0, hz1, g + hh, 6 * k, 'cd');
    castShadow(th, g, LIGHT, 1);
    fxRect(th, 'fx-glaze', hx0 + 4 * k, g + hh - 8 * k, hx1 - 4 * k, g + hh - 4.5 * k, hz0 - 0.2);
    if (!compact) {
      var ac = S.obj('plant-acc', { kind: 'solid', theme: 'balancing' }), ax0 = x0 + 131, ax1 = x0 + 159, az0 = z0 + 8, az1 = z0 + 46, ay = 18;
      [[ax0 + 1, az0 + 1], [ax1 - 1, az0 + 1], [ax1 - 1, az1 - 1], [ax0 + 1, az1 - 1], [(ax0 + ax1) / 2, az0 + 1]].forEach(function (q) { ac.line([[q[0], g, q[1]], [q[0], g + ay, q[1]]], 'mt05', 1.1); });
      box(ac, ax0, g + ay, az0, ax1, g + ay + 3, az1, 'dk');
      box(ac, ax0, g + ay + 3, az0, ax1, g + ay + 9, az0 + 0.8, 'cd');
      box(ac, ax0, g + ay + 3, az1 - 0.8, ax1, g + ay + 9, az1, 'cd');
      box(ac, ax0, g + ay + 3, az0, ax0 + 0.8, g + ay + 9, az1, 'cd');
      box(ac, ax1 - 0.8, g + ay + 3, az0, ax1, g + ay + 9, az1, 'cd');
      for (var i = 0; i < 2; i++) for (var j = 0; j < 3; j++) {
        var cx = ax0 + 6 + i * 16, cz = az0 + 7 + j * 12, ring2 = [], ring3 = [];
        for (var a2 = 0; a2 <= 18; a2++) { ring2.push([cx + 5.2 * Math.cos(a2 / 18 * TAU), g + ay + 3.15, cz + 5.2 * Math.sin(a2 / 18 * TAU)]); ring3.push([cx + 1.2 * Math.cos(a2 / 18 * TAU), g + ay + 3.2, cz + 1.2 * Math.sin(a2 / 18 * TAU)]); }
        ac.line(ring2, 'mt10', 0.7); ac.line(ring3, 'mt10', 0.6);
      }
      ac.anchor = [(ax0 + ax1) / 2, g, az0];
      castShadow(ac, g, LIGHT, 1);
    }
    // the generator's bus duct to the step-up transformer (engraved); it carries the plant's whole output, so it has a
    // flow lane, its id prefixed 'gen-' so the balancing story tints it with the generator's lane
    if (gsu) {
      var bd = S.obj('plant-duct', { layer: 'ground', kind: 'ground', theme: 'balancing' }), dp = [[hx1, g + 0.2, z0 + 26 * k], [gsu.lv[0], g + 0.2, gsu.lv[2]]];
      bd.line(dp, 'cable', 1.4);
      S.lanes.push({ id: 'gen-duct', src: { type: 'el', el: 'thermal', share: 1, sign: 1, cap: 850 }, pts: dp, w: 'cable', theme: 'balancing' });
    }
  }

  // GAS-ENGINE PLANT (gate 'b6', drawn only while html[data-bal] is "b6"): a small flexible plant in front of I on the
  // battery park's side of D-I (StudioNet zone engine_plant, 300 MW). It reads as a power plant and clearly not as the
  // two-unit gas plant: a row of three low engine halls (16 units tall against the turbine hall's 26) with a dark louver
  // band across each front and a band of high windows (lit at night), radiator coolers on the roofs, and behind each hall
  // three short slender stacks (56 units tall, base radius 2.4, against the gas plant's 136 and 6.6), so the row of
  // nine stacks is its mark. No red lights and no vapor. Its two lanes (the bus duct to the step-up transformer, the
  // generator bay) are added after every other lane of the layout.
  var ENGINES = {
    wide: { halls: [[1170, 1202], [1206, 1238], [1242, 1274]], z0: 48, z1: 76, h: 16, stacks: [0.2, 0.5, 0.8], stackZ: 81, stackH: 56, r: [2.4, 1.9], k: 1, unit: [1222, 62] },
    compact: { halls: [[409, 421], [424, 436]], z0: 93, z1: 106, h: 9, stacks: [0.28, 0.72], stackZ: 108.5, stackH: 32, r: [1.5, 1.2], k: 0.6, unit: [423, 100] }
  };
  function enginePlant(S, E, gsu) {
    var g = S.ground, k = E.k, gate = 'b6', z0 = E.z0, z1 = E.z1, h = E.h, mid = null;
    E.halls.forEach(function (x, i) {
      var o = S.obj('eng-hall-' + i, { kind: 'solid', theme: 'balancing', gate: gate }), x0 = x[0], x1 = x[1], w = x1 - x0;
      box(o, x0, g, z0, x1, g + h, z1, 'mt');   // metal cladding (the battery park's enclosures next to it are card-white)
      // a dark louver band across the front (the engines' air intakes, so a hall does not read as a container) and a band
      // of high windows
      box(o, x0 + 1.5 * k, g + h * 0.2, z0 - 0.7 * k, x1 - 1.5 * k, g + h * 0.5, z0, 'dk', { back: true });
      [0.3, 0.4].forEach(function (f) { o.line([[x0 + 1.8 * k, g + h * f, z0 - 0.8 * k], [x1 - 1.8 * k, g + h * f, z0 - 0.8 * k]], 'mt08', 0.45); });
      fxRect(o, 'fx-glaze', x0 + 2.5 * k, g + h - 4.2 * k, x1 - 2.5 * k, g + h - 2.2 * k, z0 - 0.2);
      // radiator coolers on the roof: two low dark tables with fan rings
      [[0.12, 0.46], [0.54, 0.88]].forEach(function (f) {
        var a0 = x0 + w * f[0], a1 = x0 + w * f[1], b0 = z0 + (z1 - z0) * 0.2, b1 = z0 + (z1 - z0) * 0.8, yy = g + h + 1.6 * k;
        box(o, a0, g + h, b0, a1, yy, b1, 'dk');
        for (var j = 0; j < 2; j++) {
          var cx = (a0 + a1) / 2, cz = b0 + (b1 - b0) * (j + 0.5) / 2, rr = Math.min(a1 - a0, (b1 - b0) / 2) * 0.36, ring = [];
          for (var q = 0; q <= 16; q++) ring.push([cx + rr * Math.cos(q / 16 * TAU), yy + 0.05, cz + rr * Math.sin(q / 16 * TAU)]);
          o.line(ring, 'mt10', 0.55);
        }
      });
      o.anchor = [(x0 + x1) / 2, g, z0];
      castShadow(o, g, LIGHT, 1);
      // short slender stacks behind the hall (three per hall on wide screens)
      E.stacks.forEach(function (f, j) {
        var cx = x0 + w * f, cz = E.stackZ, H = E.stackH, st = S.obj('eng-stack-' + i + '-' + j, { kind: 'solid', theme: 'balancing', gate: gate });
        prism(st, cx, cz, g, g + H, E.r[0], E.r[1], 12, 'cd', false);
        prism(st, cx, cz, g + H - 3.2 * k, g + H - 1.4 * k, E.r[1] + 0.35 * k, E.r[1] + 0.35 * k, 12, 'dk', false);
        var top = []; for (var a = 0; a < 12; a++) { var an = (a + 0.5) / 12 * TAU; top.push([cx + E.r[1] * Math.cos(an), g + H, cz + E.r[1] * Math.sin(an)]); }
        st.faceN(top, 'dk', [0, 1, 0]);
        st.anchor = [cx, g, cz];
        castShadow(st, g, LIGHT, 1);
      });
      if (i === Math.floor(E.halls.length / 2)) mid = [(x0 + x1) / 2, z1];
    });
    // the halls' collector duct along their backs, and the bus duct to the step-up transformer's MV side (engraved)
    var hx = E.halls.map(function (x) { return (x[0] + x[1]) / 2; }), zc = z1 + 1.8 * k;
    var du = S.obj('eng-duct', { layer: 'ground', kind: 'ground', theme: 'balancing', gate: gate });
    du.line([[hx[0], g + 0.2, zc], [hx[hx.length - 1], g + 0.2, zc]], 'cable', 1.1);
    E.halls.forEach(function (x, i) { du.line([[hx[i], g + 0.2, z1], [hx[i], g + 0.2, zc]], 'cable', 1.1); });
    if (gsu) {
      var lv = [gsu.lv[0], g + 0.2, gsu.lv[2]], p0 = [lv[0], g + 0.2, zc];
      du.line([p0, lv], 'cable', 1.4);
      S.gatedLanes.push({ id: 'eng-duct', src: { type: 'el', el: 'engines', share: 1, sign: 1, cap: 300 }, pts: [[mid[0], g + 0.2, zc], p0, lv], w: 'cable', theme: 'balancing', gate: gate });
    }
  }
  // the gated lanes come after every other lane of the layout (so no other lane changes its index, its beam phase or its
  // flow) and carry no light unless their gate is open: b6's first, in their own order, then b7's (the biomass power
  // station's bay, duct and cable), so b6's lanes keep their indices
  function gatedLanes(S) {
    var L = S.gatedLanes || [], order = ['b6', 'b7'];
    order.forEach(function (gk) { L.forEach(function (ln) { if (ln.gate === gk) S.lanes.push(ln); }); });
    L.forEach(function (ln) { if (order.indexOf(ln.gate) < 0) S.lanes.push(ln); });
    S.gatedLanes = [];
  }
  // the lanes of a gated generator bay, per gate (b6 the gas-engine plant, b7 the biomass power station)
  var GATED_GEN = { b6: { bay: 'eng-bay', el: 'engines' }, b7: { bay: 'bm-bay', el: 'biomass' } };

  // BIOMASS POWER STATION (gate 'b7'): a 300 MW biomass-fired steam station (a converted coal unit burning wood pellets) on
  // the free front strip between D and I, in front of the congested line D-I and far from the battery park (StudioNet zone
  // biomass_plant, x 918-1130, z 44-112). It reads as a power station and as nothing else on the plinth: a natural-draft
  // cooling tower (the only curved form with a waist), two fuel domes and a slanted conveyor (the fuel store), a boiler
  // house with a dark window band (never lit) and one chimney, a turbine hall with a louver band; its step-up transformer
  // T-BM (buildNet) and an EHV cable to bay I20. No lit windows and no obstruction lights (red is "over a limit"); a faint
  // plume rises from the tower while it runs (S.fx.stacks, drawVapour). Every object, shadow and lane carries gate 'b7'
  // (model.css hides it while html[data-bal] has any other value). Phones: the boiler house, chimney and tower only, at
  // the gas-engine plant's compact spot.
  var BIOMASS = {
    wide: { domes: [[936, 66, 14], [962, 90, 12]], transfer: [941, 74, 951, 84, 20], conveyor: [[946, 20, 79], [986, 36, 79], 4, 3],
      boiler: [986, 58, 1018, 100, 44], chimney: [1026, 106, 3.4, 2.8, 60], hall: [1018, 62, 1050, 96, 22],
      tower: { c: [1078, 74], H: 62, rb: 22, rt: 12, y0: 40, top: 15.5, n: 28 },
      duct: [[1050, 90], [1050, 104], [1106, 104]], cable: [[1176, 92]], unit: [1078, 12, 74], foot: 66, arrow: [1108, -8, 34] },
    // phones: the boiler house and chimney stand clear of the town block block-1, and the duct leaves the boiler house's
    // east face, clear of the block
    compact: { domes: [], transfer: null, conveyor: null, boiler: [404, 94, 413, 110, 22], chimney: [408.5, 112, 1.7, 1.4, 30], hall: null,
      tower: { c: [425, 99], H: 31, rb: 11, rt: 6, y0: 20, top: 7.75, n: 24 },
      duct: [[413, 96], [413, 86], [443, 86]], cable: null, unit: [425, 7, 99], foot: 34, arrow: [439, 0, 45] }
  };
  // the cooling tower's radius at height y: two hyperbola branches meeting at the throat (rt at y0), rb at the base, top at H
  function towerR(T, y) {
    var c = y <= T.y0 ? T.y0 / Math.sqrt(Math.pow(T.rb / T.rt, 2) - 1) : (T.H - T.y0) / Math.sqrt(Math.pow(T.top / T.rt, 2) - 1);
    return T.rt * Math.sqrt(1 + Math.pow((y - T.y0) / c, 2));
  }
  function biomassPlant(S, B, gsu, bay) {
    var g = S.ground, gate = 'b7', fx = fxOf(S);
    var mk = function (id) { return S.obj(id, { kind: 'solid', theme: 'balancing', gate: gate }); };
    // the fuel domes (hemispheres as stacked bands) and the transfer tower and conveyor gallery (the fuel store, west)
    B.domes.forEach(function (D, i) {
      var o = mk('bm-dome-' + i), lat = [0, 20, 40, 60, 75, 88].map(function (a) { return a * Math.PI / 180; }), k, ring = [];
      for (k = 0; k < lat.length - 1; k++) prism(o, D[0], D[1], g + D[2] * Math.sin(lat[k]), g + D[2] * Math.sin(lat[k + 1]), D[2] * Math.cos(lat[k]), D[2] * Math.cos(lat[k + 1]), 24, 'cd', false);
      for (k = 0; k < 24; k++) { var an = (k + 0.5) / 24 * TAU, rr = D[2] * Math.cos(lat[5]); ring.push([D[0] + rr * Math.cos(an), g + D[2] * Math.sin(lat[5]), D[1] + rr * Math.sin(an)]); }
      o.faceN(ring, 'cd', [0, 1, 0]);
      o.anchor = [D[0], g, D[1]];
      castShadow(o, g, LIGHT, 1);
    });
    if (B.transfer) {
      var tt = B.transfer, tw = mk('bm-transfer');
      box(tw, tt[0], g, tt[1], tt[2], g + tt[4], tt[3], 'mt');
      castShadow(tw, g, LIGHT, 1);
    }
    if (B.conveyor) {
      // a slanted gallery: four quads along its axis and two ends
      var cv = B.conveyor, a = cv[0], b = cv[1], hw = cv[2] / 2, ht = cv[3], cg = mk('bm-conveyor');
      var P = function (q, dz, dy) { return [q[0], g + q[1] + dy, q[2] + dz]; };
      var A0 = P(a, -hw, 0), A1 = P(a, hw, 0), A2 = P(a, hw, ht), A3 = P(a, -hw, ht), B0 = P(b, -hw, 0), B1 = P(b, hw, 0), B2 = P(b, hw, ht), B3 = P(b, -hw, ht);
      var inside = [(a[0] + b[0]) / 2, g + (a[1] + b[1]) / 2 + ht / 2, a[2]];
      cg.face([A3, B3, B2, A2], 'mt', inside); cg.face([A0, B0, B3, A3], 'mt', inside); cg.face([A1, B1, B2, A2], 'mt', inside);
      cg.face([A0, B0, B1, A1], 'mt', inside); cg.face([A0, A1, A2, A3], 'mt', inside); cg.face([B0, B1, B2, B3], 'mt', inside);
      cg.anchor = [(a[0] + b[0]) / 2, g, a[2] - hw];
      castShadow(cg, g, LIGHT, 0.8);
    }
    // the boiler house with a dark window band on its front (never lit) and the one chimney behind it
    var bh = B.boiler, bo = mk('bm-boiler'), H = bh[4];
    box(bo, bh[0], g, bh[1], bh[2], g + H, bh[3], 'cd');
    box(bo, bh[0] + 2, g + H * 0.7, bh[1] - 0.6, bh[2] - 2, g + H * 0.78, bh[1], 'dk', { back: true });
    castShadow(bo, g, LIGHT, 1);
    var ch = B.chimney, co = mk('bm-chimney');
    prism(co, ch[0], ch[1], g, g + ch[4], ch[2], ch[3], 16, 'cd', false);
    var rb = ch[3] + (ch[2] - ch[3]) * 6 / ch[4] + 0.3 * (ch[2] / 3.4);
    prism(co, ch[0], ch[1], g + ch[4] - 6 * ch[4] / 60, g + ch[4] - 2 * ch[4] / 60, rb, rb, 16, 'dk', false);
    var top = []; for (var q = 0; q < 16; q++) { var aq = (q + 0.5) / 16 * TAU; top.push([ch[0] + ch[3] * Math.cos(aq), g + ch[4], ch[1] + ch[3] * Math.sin(aq)]); }
    co.faceN(top, 'dk', [0, 1, 0]);
    co.anchor = [ch[0], g, ch[1]];
    castShadow(co, g, LIGHT, 1);
    // the turbine hall (flat roof, metal) with a dark louver band
    if (B.hall) {
      var hh = B.hall, ho = mk('bm-hall');
      box(ho, hh[0], g, hh[1], hh[2], g + hh[4], hh[3], 'mt');
      box(ho, hh[0] + 2, g + hh[4] * 0.55, hh[1] - 0.6, hh[2] - 2, g + hh[4] * 0.65, hh[1], 'dk', { back: true });
      castShadow(ho, g, LIGHT, 1);
    }
    // the natural-draft cooling tower: a surface of revolution of 13 bands, and its dark opening
    var T = B.tower, to = mk('bm-tower'), yk = [], rk = [], j;
    for (j = 0; j <= 13; j++) { yk.push(T.H * j / 13); rk.push(towerR(T, T.H * j / 13)); }
    for (j = 0; j < 13; j++) prism(to, T.c[0], T.c[1], g + yk[j], g + yk[j + 1], rk[j], rk[j + 1], T.n, 'cd', false);
    var op = []; for (j = 0; j < T.n; j++) { var aj = (j + 0.5) / T.n * TAU; op.push([T.c[0] + T.top * 0.97 * Math.cos(aj), g + T.H, T.c[1] + T.top * 0.97 * Math.sin(aj)]); }
    to.faceN(op, 'dk', [0, 1, 0]);
    to.anchor = [T.c[0], g, T.c[1]];
    castShadow(to, g, LIGHT, 1);
    // its plume while it runs (drawVapour: its own level, eased toward the shown MW / cap, times a)
    fx.stacks.push({ top: [T.c[0], g + T.H, T.c[1]], r: T.top, phase: 0.2, el: 'biomass', cap: 300, gate: gate, a: 0.5, aA: 1.2, rim: 1 });
    // the generator's bus duct to the step-up transformer's LV side, and (wide) the EHV cable from its HV side to bay I20,
    // engraved on the ground, each with its lane (gated, after every other lane)
    if (gsu) {
      var lv = [gsu.lv[0], g + 0.2, gsu.lv[2]], dp = B.duct.map(function (q) { return [q[0], g + 0.2, q[1]]; }).concat([lv]);
      var du = S.obj('bm-duct', { layer: 'ground', kind: 'ground', theme: 'balancing', gate: gate });
      du.line(dp, 'cable', 1.4);
      S.gatedLanes.push({ id: 'bm-duct', src: { type: 'el', el: 'biomass', share: 1, sign: 1, cap: 300 }, pts: dp, w: 'cable', theme: 'balancing', gate: gate });
      if (B.cable && bay) {
        var cp = [[gsu.hv[0], g + 0.2, gsu.hv[2]]].concat(B.cable.map(function (q) { return [q[0], g + 0.2, q[1]]; })).concat([[bay.T2[0], g + 0.2, bay.T2[1]]]);
        var cb = S.obj('bm-cable', { layer: 'ground', kind: 'ground', theme: 'balancing', gate: gate });
        cb.line(cp, 'cable', 1.4);
        var rs = S.obj('bm-riser', { kind: 'wire', theme: 'balancing', gate: gate });
        rs.line([[gsu.hv[0], g + 0.2, gsu.hv[2]], gsu.hv], 'drop', 0.7); rs.anchor = [gsu.hv[0], g, gsu.hv[2]];
        S.gatedLanes.push({ id: 'bm-cable', src: { type: 'el', el: 'biomass', share: 1, sign: 1, cap: 300 }, pts: cp, w: 'cable', theme: 'balancing', gate: gate });
      }
    }
  }

  // INDUSTRY: the sawtooth-roof works (the pictogram of a factory) with bold teeth whose glazed faces are
  // dark by day and lit at night, loading doors, two squat tanks with conical roofs and a pipe bridge.
  // No chimney: in the model a stack always marks a power plant.
  function industrySite(S, b, tanks, compact) {
    var g = S.ground, f = S.obj('factory', { kind: 'solid' }), x0 = b[0], x1 = b[2], z0 = b[1], z1 = b[3], h = compact ? 9 : 12, rise = compact ? 7 : 9.5, n = compact ? 4 : 6, i;
    box(f, x0, g, z0, x1, g + h, z1, 'cd', { top: true });
    for (i = 0; i < n; i++) {
      var a = x0 + (x1 - x0) * i / n, c = x0 + (x1 - x0) * (i + 1) / n;
      f.face([[a, g + h, z0], [a, g + h, z1], [c, g + h + rise, z1], [c, g + h + rise, z0]], 'cd', [c, g, (z0 + z1) / 2]);
      f.faceN([[c, g + h, z0], [c, g + h, z1], [c, g + h + rise, z1], [c, g + h + rise, z0]], 'dk', [1, 0, 0]);
      f.faceN([[a, g + h, z0], [c, g + h, z0], [c, g + h + rise, z0]], 'cd', [0, 0, -1]);
      fxq(f, 'fx-glaze', [[c + 0.1, g + h + 1, z0 + 1], [c + 0.1, g + h + 1, z1 - 1], [c + 0.1, g + h + rise - 1, z1 - 1], [c + 0.1, g + h + rise - 1, z0 + 1]]);
    }
    for (i = 0; i < (compact ? 2 : 3); i++) { var dx = x0 + (x1 - x0) * (0.18 + i * 0.3); fxRect(f, 'fx-glaze fx-dim', dx - 3, g + 0.4, dx + 3, g + 6.5, z0 - 0.2); }
    f.anchor = [(x0 + x1) / 2, g, z0];
    castShadow(f, g, LIGHT, 1);
    tanks.forEach(function (q, j) {
      var t = S.obj('tank-' + j, { kind: 'solid' }), r = q[2], ht = q[3], ring = [], top = [q[0], g + ht + r * 0.42, q[1]];
      prism(t, q[0], q[1], g, g + ht, r, r, 18, 'cd', false);
      for (var a3 = 0; a3 < 18; a3++) { var an = (a3 + 0.5) / 18 * TAU; ring.push([q[0] + r * Math.cos(an), g + ht, q[1] + r * Math.sin(an)]); }
      for (var a4 = 0; a4 < 18; a4++) t.face([ring[a4], ring[(a4 + 1) % 18], top], 'cd', [q[0], g + ht * 0.5, q[1]]);
      t.line(ring.concat([ring[0]]).map(function (p) { return [p[0], g + ht * 0.62, p[2]]; }).filter(function (p) { return p[2] <= q[1] + 0.2; }), 'cd06', 0.6);
      t.anchor = [q[0], g, q[1]];
      castShadow(t, g, LIGHT, 1);
    });
    if (!compact && tanks.length) {
      var pr = S.obj('pipe-bridge', { kind: 'solid' }), zz = (tanks[0][1] + tanks[tanks.length - 1][1]) / 2;
      pr.line([[x1, g + 9, zz], [tanks[0][0] - 2, g + 9, zz]], 'mt05', 1.3);
      pr.line([[x1 + 3.5, g, zz], [x1 + 3.5, g + 9, zz]], 'mt06', 0.9);
      pr.anchor = [x1 + 3, g, zz];
    }
  }

  // TRANSFORMER radiators: vertical fins on the front of each grid transformer's tank (visible at 2x).
  function xfmrFins(S) {
    S.objs.forEach(function (o) {
      if (!/^tr-/.test(o.id) || !o.faces.length) return;
      var t = o.faces[0].p, g = S.ground, top = t[0][1], xs = t.map(function (p) { return p[0]; }), zs = t.map(function (p) { return p[2]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), z0 = Math.min.apply(null, zs), n = Math.max(3, Math.round((x1 - x0) / 1.8));
      for (var i = 1; i < n; i++) { var x = x0 + (x1 - x0) * i / n; o.line([[x, g + 1.2, z0 - 0.12], [x, top - 1, z0 - 0.12]], 'mt12', 0.4); }
    });
  }

  /* ───────────────────────────── layouts ───────────────────────────── */

  var LAYOUTS = {
    wide: {
      view: [1440, 486], margin: { l: 50, r: 50, t: 6, b: 8 },
      cam: { pitch: 0.74, yaw: 0.02, dist: 5200, target: [800, 70, 300] },
      pool: [700, 300, 1000, 560, 0.24],
      x0: 0, x1: 1600, z0: 34, z1: 680, coast: 440, seaY: 3, plinthH: 40, groundY: 7, plateMargin: 9
    },
    compact: {
      view: [390, 352], margin: { l: 8, r: 8, t: 4, b: 6 },
      cam: { pitch: 0.62, yaw: 0.06, dist: 2600, target: [280, 60, 300] },
      pool: [260, 300, 430, 480, 0.24],
      x0: 0, x1: 560, z0: 20, z1: 640, coast: 380, seaY: 3, plinthH: 30, groundY: 7, plateMargin: 7
    }
  };

  function cableLanes(S, cables, bays) {
    // engraved cables with their flow lanes (radial: the flow is the injection behind them; cap is
    // the group's total rating, so a lane's loading is |injection| / cap)
    var cab = {}; cables.forEach(function (c) { cab[c.id] = c.paths; });
    var feeders = Object.keys(bays).map(function (k) { return bays[k]; }).filter(function (b) { return b.bay.kind === 'feeder'; });
    var put = function (id, paths, el, sign, cap, theme, cls, w, join) {
      (paths || []).forEach(function (p, i) {
        var pts = p.slice();
        if (join) {
          // the town cables start at their feeder bay's sealing end inside I's HV yard
          var best = null, bd = 1e9;
          feeders.forEach(function (f) { var dd = d2(f.T2, pts[0]); if (dd < bd) { bd = dd; best = f; } });
          if (best && bd < 24) pts.unshift(best.T2);
        }
        cableObj(S, id + '-' + i, pts, cls || 'feeder', w || 0.8, theme, { id: id + '-' + i, src: { type: 'el', el: el, share: 1 / paths.length, sign: sign, cap: cap }, w: 'cable', theme: theme });
      });
    };
    put('mv-wind', cab['MV-wind'], 'onshore_wind', -1, 400, 'renewables');
    put('mv-solar', cab['MV-solar'], 'solar', -1, 500, 'renewables');
    put('mv-industry', cab['MV-industry'], 'industry', -1, 420, null);
    put('mv-battery', cab['MV-battery'], 'battery', -1, 250, 'balancing');
    put('hv-town', cab['HV-town'], 'town', -1, 2400, null, 'feeder', 1.0, true);
  }

  // The line sheet: the field of the congested line D-I (wide: D-I runs from x 900 to 1150 at z about 137; compact: from
  // x 318 to 422 at z 128). Wide: 340 x 190 over the coast strip between the two converter stations (x 940, z 310), its
  // field about as large on screen as the offshore one; there it leaves the east square, the spine L-AD, D-I, C's EHV
  // yard and the coastal corridor K-AC clear, and its puck and beam rise from the east square behind D-I. Compact:
  // 196 x 104, larger on screen than the onshore and solar fields.
  var LINE_SHEET = {
    wide: { tech: 'line', x: 940, z: 310, y: 10, w: 340, h: 190, yaw: -0.2, rods: [-0.28, 0.28], theme: 'balancing', themes: ['switching', 'balancing'] },
    compact: { tech: 'line', x: 358, z: 214, y: 22, w: 196, h: 104, yaw: -0.12, rods: [-0.26, 0.2], theme: 'balancing', themes: ['switching', 'balancing'] }
  };

  // The panel styles (html[data-panels]; panelDefault when it is "auto" or unset). The 'r4' sheets define the camera fit
  // and the source fields, so the model is exactly as large in every style.
  //  - volumes: no sheet, no rod. A lit puck at the source (emitter [x, z]; on the sea for offshore, on the hill for
  //    onshore; on phones the solar puck stands in the field's row gap, clear of C's HV yard), a soft beam from the puck's
  //    rim to the middle 60% of the field's floor, a faint column of light over the field and, in the light theme, a white
  //    haze behind the dots. The source fields are the sheets' own; the line's volume is raised 24 units so its beam rises
  //    from the ground behind D-I.
  //  - band: four frameless fields in one row beyond the plinth's far edge (z), facing the camera, between two screen
  //    heights (view units), each tied to its source by a thread of light ending in a lit point.
  var PANEL_VARIANTS = ['volumes', 'band', 'r4'];
  function panelDefault(name) { return name === 'wide' ? 'volumes' : 'band'; }
  var VOL = {
    wide: { emit: { onshore: [212, 402], offshore: [700, 508], solar: [1491, 318], line: [1000, 176] }, R: 12, Rline: 9, lineRaise: 24 },
    compact: { emit: { onshore: [146, 360], offshore: [262, 486], solar: [503, 312], line: [370, 176] }, R: 12, Rline: 9, lineRaise: 24 }
  };
  var BAND = {
    wide: { z: 760, w: 330, top: 8, bot: 104, x: { onshore: 230, offshore: 630, line: 1030, solar: 1430 },
      src: { onshore: [212, 26, 398], offshore: [700, 1, 560], line: [1025, 51, 137], solar: [1491, 8, 330] } },
    // on phones the line's frame is wider than the sources' (142 against 110), since its distribution is a narrow spike on
    // its axis; the row keeps its ends (21 to 529) and its 12-unit gaps
    compact: { z: 700, w: 110, wt: { line: 142 }, top: 6, bot: 96, x: { onshore: 76, offshore: 198, line: 336, solar: 474 },
      src: { onshore: [146, 22, 350], offshore: [262, 1, 470], line: [370, 48, 128], solar: [514, 8, 300] } }
  };

  function buildWide(S, L) {
    var g = S.ground, sea = S.seaY, NET = global.StudioNet;
    plinthAndPlates(S, L);
    var wind = nrm([-0.18, 0, -1]);
    // ── the network ──
    var net = buildNet(S, NET, { endSide: { G1: -1, G5: -1, I18: -1, I7: -1 } });
    // ── offshore wind farm, collector and converter platforms, array and export cables ──
    var k = 0, OFF = NET.offshore;
    OFF.rows.forEach(function (r) { r[1].forEach(function (x) { turbine(S, 'tb-off-' + (k++), x, r[0], sea, 92, 56, { offshore: true, wind: wind, phase: rnd(k * 7.1) * TAU, period: 8.0 + 1.6 * rnd(k * 3.3) }); }); });
    var col = OFF.collector, cvp = OFF.converter;
    OFF.rows.forEach(function (r, i) {
      var pts = r[1].map(function (x) { return [x, r[0]]; }).concat([[col[0] - 14, col[1] + (i - 1) * 5]]);
      cableObj(S, 'array-' + i, pts, 'array', 0.8, 'renewables', { id: 'array-' + i, src: { type: 'el', el: 'offshore_wind', share: 1 / 3, sign: 1, cap: 2000 }, w: 'cable' });
    });
    platform(S, 'collector', col[0], col[1], 30, 24, 30, sea, false);
    S.live.lamps.push(platform(S, 'converter-off', cvp[0], cvp[1], 66, 46, 36, sea, true));
    var cab = {}; NET.cables.forEach(function (c) { cab[c.id] = c.paths; });
    cab['AC-offshore'].forEach(function (p, i) { cableObj(S, 'ac-export-' + i, p, 'cable', 0.9, 'hvdc', { id: 'ac-export-' + i, src: { type: 'el', el: 'offshore_wind', share: 0.5, sign: 1, cap: 2000 }, w: 'cable' }); });
    // ── HVDC: DC link 1 (bipole: pole +, metallic return, pole -) and DC link 2 (two cables) ──
    // the metallic return is in service but carries no current in balanced bipolar operation, so its lane has no flow
    // (el 'none'): it keeps the glow floor of every conductor in service and never carries a beam
    var dc1 = NET.hvdc[0], dc2 = NET.hvdc[1];
    [-3.2, 0, 3.2].forEach(function (o, i) {
      cableObj(S, 'dc1-' + i, offsetPath(dc1.cable, o), 'cable', 1.05, 'hvdc', i === 1 ? { id: 'dc1-1', src: { type: 'el', el: 'none', share: 1, sign: 1, cap: 2000 }, w: 'dc' } : { id: 'dc1-' + i, src: { type: 'el', el: 'offshore_wind', share: 0.5, sign: 1, cap: 2000 }, w: 'dc' });
    });
    [-1.8, 1.8].forEach(function (o, i) {
      cableObj(S, 'dc2-' + i, offsetPath(dc2.cable, o), 'cable', 1.05, 'hvdc', { id: 'dc2-' + i, src: { type: 'el', el: 'dc_interconnector', share: 0.5, sign: -1, cap: 1400 }, w: 'dc' });
    });
    // ── converter stations: A (two valve halls and a DC hall), C (one valve hall and a DC hall) ──
    // the valve halls are 46 tall, the tallest boxes on the coast, with a light seam
    converterHall(S, 'conv-a1', [656, 352, 682, 398], 46, 'hvdc', true);
    converterHall(S, 'conv-a2', [688, 352, 714, 398], 46, 'hvdc', true);
    converterHall(S, 'conv-a-dc', [722, 356, 780, 402], 26, 'hvdc', false);
    // C's converter station (the interconnector DC-2's) carries the hvdc theme, so the HVDC hover lights both links and
    // every converter hall; its status lamp is lit with A's
    converterHall(S, 'conv-c1', [1090, 352, 1124, 398], 46, 'hvdc', true);
    converterHall(S, 'conv-c-dc', [1130, 356, 1188, 402], 26, 'hvdc', false);
    bushings(S, 'bushings-a', [[668, 342], [684, 342]], 352);
    bushings(S, 'bushings-c', [[1106, 342]], 352);
    S.live.lamps.push([751, g + 27.5, 356], [1159, g + 27.5, 356]);
    // ── onshore wind on low hills, the MV collector cables to F ──
    var h1 = hill(S, 'hill-a', 128, 396, 92, 30, 3, 0.56), h2 = hill(S, 'hill-b', 284, 396, 62, 22, 11, 0.6);
    S.hills = [h1, h2];
    [[96, 392, h1], [170, 410, h1], [262, 402, h2], [312, 384, h2]].forEach(function (q, i) {
      turbine(S, 'tb-on-' + i, q[0], q[1], q[2].heightAt(q[0], q[1]), 76, 46, { wind: wind, phase: rnd(40 + i) * TAU, period: 6.8 + 1.2 * rnd(i * 5.7) });
    });
    var mvb = S.obj('f-mv', { kind: 'solid', theme: 'renewables' }); box(mvb, 192, g, 302, 204, g + 9, 334, 'cd'); castShadow(mvb, g, LIGHT, 1);
    var gmv = S.obj('g-mv', { kind: 'solid', theme: 'renewables' }); box(gmv, 1344, g, 200, 1351, g + 8, 252, 'cd'); castShadow(gmv, g, LIGHT, 1);
    // the MV side of each collector transformer reaches its MV switchgear building (an engraved MV cable)
    [['T-F1', 204], ['T-F2', 204], ['T-G1', 1344], ['T-G2', 1344]].forEach(function (q) {
      // the link carries half the field's output (two transformers), from the switchgear to the transformer, so it has a
      // lane like the other MV cables
      var X = net.XF[q[0]], wnd = q[0].charAt(2) === 'F';
      if (X) cableObj(S, 'mv-link-' + q[0], [[X.lv[0], X.lv[2]], [q[1], X.lv[2]]], 'feeder', 0.8, 'renewables',
        { id: 'mv-link-' + q[0], src: { type: 'el', el: wnd ? 'onshore_wind' : 'solar', share: 0.5, sign: -1, cap: wnd ? 400 : 500 }, w: 'cable' });
    });
    // ── solar field on single-axis trackers (rows along z) ──
    solarField(S, [1416, 1446, 1476, 1506, 1536, 1566], 214, 400, 15, 5);
    // ── battery park at I: two rows of two enclosures with charge bars, and inverter skids (StudioNet's MV-battery cables
    // end at the skids) ──
    batteryPark(S, [1311, 1355], [54, 71], 35, 11, 12.5);
    var sk = S.obj('bat-skids', { kind: 'solid', theme: 'balancing' });
    box(sk, 1326, g, 86, 1338, g + 7, 94, 'dk'); box(sk, 1350, g, 86, 1360, g + 7, 94, 'dk'); castShadow(sk, g, LIGHT, 1);
    // ── loads: the town (gable houses, blocks, streets, three HV/MV substations) and the works ──
    NET.town_substations.forEach(function (t) { townSub(S, 'ts-' + t.id, t.pos, 22, 14); });
    town(S, TOWN.wide, false);
    industrySite(S, [570, 50, 632, 84], [[646, 56, 6.5, 12], [646, 78, 6.5, 12]], false);
    thermalPlant(S, [400, 40, 560, 98], net.XF['T-GSU'], false);
    xfmrFins(S);
    // ── engraved cables: MV collectors, the town's HV cables, the battery link ──
    cableLanes(S, NET.cables, net.bays);
    // ── roads and trees ──
    var rd = S.obj('roads', { layer: 'ground', kind: 'ground' });
    [[[0, 204], [300, 210], [470, 200], [700, 192], [900, 198], [1120, 194], [1290, 188], [1412, 178]],
      [[540, 199], [540, 174]], [[830, 195], [830, 174]], [[1250, 189], [1250, 168]], [[1140, 194], [1150, 260]]].forEach(function (p) {
      rd.line(p.map(function (q) { return [q[0], g + 0.08, q[1]]; }), 'road', 3.2);
    });
    trees(S, [[560, 236, 8], [584, 248, 6], [640, 230, 7], [880, 222, 8], [904, 232, 6], [1000, 214, 7], [1070, 224, 6], [40, 250, 8], [60, 262, 6],
      [250, 250, 7], [1270, 258, 7], [1380, 200, 6], [1590, 200, 7], [24, 300, 6], [320, 104, 7], [340, 92, 6]]);
    // ── the acrylic panels ──
    var yawP = -0.2;
    panel(S, 'pn-onshore', { tech: 'onshore', x: 214, z: 394, y: 150, w: 270, h: 150, yaw: yawP });
    panel(S, 'pn-offshore', { tech: 'offshore', x: 700, z: 506, y: 150, w: 370, h: 180, yaw: yawP, foot: sea, rods: [-0.2, 0.2] });
    // the solar sheet: its field about as large on screen as the onshore one
    panel(S, 'pn-solar', { tech: 'solar', x: 1466, z: 330, y: 134, w: 248, h: 176, yaw: yawP });
    // the sheet of the congested line D-I (LINE_SHEET)
    panel(S, 'pn-line', LINE_SHEET.wide);
    // the gated plants (the gas-engine plant b6, the biomass power station b7), their lanes after every other lane
    enginePlant(S, ENGINES.wide, net.XF['T-GE']);
    biomassPlant(S, BIOMASS.wide, net.XF['T-BM'], net.bays.I20);
    gatedLanes(S);
  }

  // Phones and portrait tablets: the same topology on the narrower, deeper compact plinth (the same ladder with slanted
  // rungs; one bay with a breaker per line end, couplers kept where they fit). Hand-placed.
  var COMPACT = {
    substations: [
      { id: 'B', yards: [
        { id: 'B-EHV', level: 'EHV', fence: [42, 254, 98, 282], axis: 'x', bus_at: [264, 272], bays: [
          { id: 'B1', kind: 'transformer', branch: 'T-B1', at: 52, exit: 'n' }, { id: 'B3', kind: 'line', branch: 'L-BE', at: 64, exit: 's', gantry: [64, 254] },
          { id: 'Bc', kind: 'coupler', at: 72 }, { id: 'B4', kind: 'transformer', branch: 'T-B2', at: 82, exit: 'n' }, { id: 'B5', kind: 'line', branch: 'L-BA', at: 90, exit: 'e', gantry: [98, 268] }] },
        { id: 'B-HV', level: 'HV', fence: [44, 292, 96, 314], axis: 'x', bus_at: [300, 306], bays: [
          { id: 'B6', kind: 'line', branch: 'L-BF', at: 50, exit: 'w', gantry: [44, 297] }, { id: 'B7', kind: 'transformer', branch: 'T-B1', at: 58, exit: 's' },
          { id: 'B8', kind: 'coupler', at: 70 }, { id: 'B9', kind: 'transformer', branch: 'T-B2', at: 82, exit: 's' }] }],
        equipment: [{ id: 'T-B1', kind: 'EHV/HV transformer', pos: [55, 287] }, { id: 'T-B2', kind: 'EHV/HV transformer', pos: [82, 287] }] },
      { id: 'A', yards: [
        { id: 'A-EHV', level: 'EHV', fence: [202, 254, 258, 282], axis: 'x', bus_at: [264, 272], bays: [
          { id: 'A1', kind: 'line', branch: 'L-BA', at: 208, exit: 'w', gantry: [202, 268] }, { id: 'A5', kind: 'line', branch: 'L-AD', at: 216, exit: 's', gantry: [216, 254] },
          { id: 'A2', kind: 'converter', branch: 'DC-1', at: 222, exit: 'n', gantry: [222, 282] }, { id: 'A4', kind: 'coupler', at: 230 },
          { id: 'A3', kind: 'converter', branch: 'DC-1', at: 238, exit: 'n', gantry: [238, 282] }, { id: 'A6', kind: 'line', branch: 'L-AC2', at: 244, exit: 's', gantry: [244, 254] },
          { id: 'A7', kind: 'line', branch: 'L-AC1', at: 252, exit: 's', gantry: [252, 254] }] }],
        equipment: [{ kind: 'converter transformer bank, pole 1', pos: [222, 290] }, { kind: 'converter transformer bank, pole 2', pos: [238, 290] }] },
      { id: 'C', yards: [
        { id: 'C-EHV', level: 'EHV', fence: [362, 254, 418, 282], axis: 'x', bus_at: [264, 272], bays: [
          { id: 'C1', kind: 'line', branch: 'L-AC1', at: 366, exit: 's', gantry: [366, 254] }, { id: 'C2', kind: 'line', branch: 'L-AC2', at: 374, exit: 's', gantry: [374, 254] },
          { id: 'C3', kind: 'coupler', at: 382 }, { id: 'C4', kind: 'converter', branch: 'DC-2', at: 390, exit: 'n', gantry: [390, 282] },
          { id: 'C5', kind: 'line', branch: 'L-CI', at: 398, exit: 's', gantry: [398, 254] }, { id: 'C6', kind: 'transformer', branch: 'T-C1', at: 406, exit: 'e' },
          { id: 'C7', kind: 'transformer', branch: 'T-C2', at: 414, exit: 'e' }] },
        { id: 'C-HV', level: 'HV', fence: [430, 262, 464, 292], axis: 'x', bus_at: [273, 281], bays: [
          { id: 'C8', kind: 'transformer', branch: 'T-C1', at: 436, exit: 'w' }, { id: 'C9', kind: 'transformer', branch: 'T-C2', at: 444, exit: 'w' },
          { id: 'C10', kind: 'coupler', at: 451 }, { id: 'C11', kind: 'line', branch: 'L-CG', at: 458, exit: 'e', gantry: [464, 280] }] }],
        equipment: [{ id: 'T-C1', kind: 'EHV/HV transformer', pos: [424, 262] }, { id: 'T-C2', kind: 'EHV/HV transformer', pos: [424, 284] }, { kind: 'converter transformer bank', pos: [390, 290] }] },
      { id: 'E', yards: [
        { id: 'E-EHV', level: 'EHV', fence: [102, 114, 158, 142], axis: 'x', bus_at: [124, 132], bays: [
          { id: 'E1', kind: 'line', branch: 'L-X1', at: 108, exit: 'w', gantry: [102, 134] }, { id: 'E2', kind: 'line', branch: 'L-X2', at: 114, exit: 'w', gantry: [102, 122] },
          { id: 'E3', kind: 'line', branch: 'L-BE', at: 124, exit: 'n', gantry: [124, 142] }, { id: 'E4', kind: 'generator', branch: 'T-GSU', at: 134, exit: 's' },
          { id: 'E5', kind: 'coupler', at: 142 }, { id: 'E6', kind: 'line', branch: 'L-ED', at: 152, exit: 'e', gantry: [158, 128] }] }],
        equipment: [{ id: 'T-GSU', kind: 'generator step-up transformer', pos: [134, 103] }] },
      { id: 'D', yards: [
        { id: 'D-EHV', level: 'EHV', fence: [262, 114, 318, 142], axis: 'x', bus_at: [124, 132], bays: [
          { id: 'D1', kind: 'line', branch: 'L-ED', at: 268, exit: 'w', gantry: [262, 128] }, { id: 'D3', kind: 'line', branch: 'L-AD', at: 276, exit: 'n', gantry: [276, 142] },
          { id: 'D2', kind: 'transformer', branch: 'T-D1', at: 284, exit: 's' }, { id: 'D4', kind: 'coupler', at: 292 },
          { id: 'D5', kind: 'transformer', branch: 'T-D2', at: 300, exit: 's' }, { id: 'D6', kind: 'line', branch: 'L-DI', at: 312, exit: 'e', gantry: [318, 128] }] },
        { id: 'D-HV', level: 'HV', fence: [268, 62, 312, 92], axis: 'x', bus_at: [74, 80], bays: [
          { id: 'D7', kind: 'line', branch: 'L-DJ1', at: 274, exit: 'w', gantry: [268, 82] }, { id: 'D8', kind: 'line', branch: 'L-DJ2', at: 280, exit: 'w', gantry: [268, 70] },
          { id: 'D9', kind: 'transformer', branch: 'T-D1', at: 288, exit: 'n' }, { id: 'D10', kind: 'coupler', at: 295 }, { id: 'D11', kind: 'transformer', branch: 'T-D2', at: 302, exit: 'n' }] }],
        equipment: [{ id: 'T-D1', kind: 'EHV/HV transformer', pos: [286, 103] }, { id: 'T-D2', kind: 'EHV/HV transformer', pos: [302, 103] }] },
      { id: 'I', yards: [
        { id: 'I-EHV', level: 'EHV', fence: [422, 114, 478, 142], axis: 'x', bus_at: [124, 132], bays: [
          { id: 'I1', kind: 'line', branch: 'L-DI', at: 428, exit: 'w', gantry: [422, 128] }, { id: 'I2', kind: 'coupler', at: 436 },
          { id: 'I4', kind: 'transformer', branch: 'T-I1', at: 446, exit: 'e' }, { id: 'I3', kind: 'line', branch: 'L-CI', at: 458, exit: 'n', gantry: [458, 142] },
          { id: 'I5', kind: 'transformer', branch: 'T-I2', at: 466, exit: 'e' }, { id: 'I6', kind: 'transformer', branch: 'T-I3', at: 474, exit: 'e' },
          // the gas-engine plant's generator bay (gate b6; listed last, so no other bay moves), at 443, west of I4, whose
          // connection to T-I1 runs east along the front fence
          { id: 'I19', kind: 'generator', branch: 'T-GE', at: 443, exit: 's', gate: 'b6' },
          // the biomass power station's generator bay (gate b7; listed last), at the same place
          { id: 'I20', kind: 'generator', branch: 'T-BM', at: 443, exit: 's', gate: 'b7' }] },
        { id: 'I-HV', level: 'HV', fence: [490, 100, 532, 156], axis: 'z', bus_at: [504, 512], bays: [
          { id: 'I8', kind: 'feeder', branch: 'town cable 3a', at: 104, exit: 'e' }, { id: 'I9', kind: 'transformer', branch: 'T-I1', at: 108, exit: 'w' },
          { id: 'I10', kind: 'feeder', branch: 'town cable 3b', at: 112, exit: 'e' }, { id: 'I12', kind: 'feeder', branch: 'town cable 2a', at: 120, exit: 'e' },
          { id: 'I13', kind: 'transformer', branch: 'T-I2', at: 124, exit: 'w' }, { id: 'I14', kind: 'feeder', branch: 'town cable 2b', at: 128, exit: 'e' },
          { id: 'I15', kind: 'feeder', branch: 'town cable 1a', at: 136, exit: 'e' }, { id: 'I16', kind: 'transformer', branch: 'T-I3', at: 140, exit: 'w' },
          { id: 'I17', kind: 'feeder', branch: 'town cable 1b', at: 144, exit: 'e' }, { id: 'I7', kind: 'battery', branch: 'T-BESS', at: 151, exit: 'e' },
          { id: 'I18', kind: 'line', branch: 'L-GI', at: 152, exit: 'n', gantry: [508, 156] }] }],
        equipment: [{ id: 'T-I1', kind: 'EHV/HV transformer', pos: [484, 108] }, { id: 'T-I2', kind: 'EHV/HV transformer', pos: [484, 124] }, { id: 'T-I3', kind: 'EHV/HV transformer', pos: [484, 140] },
          { id: 'T-BESS', kind: 'HV/MV transformer of the battery park', pos: [540, 162] },
          { id: 'T-GE', kind: 'generator step-up transformer of the gas-engine plant', pos: [443, 103], gate: 'b6' },
          { id: 'T-BM', kind: 'generator step-up transformer of the biomass power station', pos: [443, 103], gate: 'b7' }] },
      { id: 'F', yards: [
        { id: 'F-HV', level: 'HV', fence: [4, 330, 40, 364], axis: 'x', bus_at: [342], bays: [
          { id: 'F2', kind: 'transformer', branch: 'T-F1', at: 12, exit: 'n' }, { id: 'F1', kind: 'line', branch: 'L-BF', at: 22, exit: 's', gantry: [22, 330] },
          { id: 'F3', kind: 'transformer', branch: 'T-F2', at: 32, exit: 'n' }] }],
        equipment: [{ id: 'T-F1', kind: 'HV/MV transformer', pos: [12, 358] }, { id: 'T-F2', kind: 'HV/MV transformer', pos: [32, 358] }] },
      { id: 'G', yards: [
        { id: 'G-HV', level: 'HV', fence: [490, 196, 532, 234], axis: 'z', bus_at: [506], bays: [
          { id: 'G5', kind: 'line', branch: 'L-GI', at: 200, exit: 's', gantry: [506, 196] }, { id: 'G4', kind: 'transformer', branch: 'T-G2', at: 207, exit: 'e' },
          { id: 'G3', kind: 'sectionaliser', at: 215 }, { id: 'G2', kind: 'transformer', branch: 'T-G1', at: 223, exit: 'e' },
          { id: 'G1', kind: 'line', branch: 'L-CG', at: 230, exit: 'n', gantry: [506, 234] }] }],
        equipment: [{ id: 'T-G1', kind: 'HV/MV transformer', pos: [526, 223] }, { id: 'T-G2', kind: 'HV/MV transformer', pos: [526, 207] }] },
      { id: 'J', yards: [
        { id: 'J-HV', level: 'HV', fence: [196, 56, 232, 88], axis: 'x', bus_at: [70, 76], bays: [
          { id: 'J1', kind: 'transformer', branch: 'T-J1', at: 200, exit: 'w' }, { id: 'J2', kind: 'transformer', branch: 'T-J2', at: 207, exit: 's' },
          { id: 'J3', kind: 'coupler', at: 213 }, { id: 'J4', kind: 'transformer', branch: 'T-J3', at: 219, exit: 's' },
          { id: 'J5', kind: 'line', branch: 'L-DJ1', at: 224, exit: 'e', gantry: [232, 82] }, { id: 'J6', kind: 'line', branch: 'L-DJ2', at: 228, exit: 'e', gantry: [232, 70] }] }],
        equipment: [{ id: 'T-J1', kind: 'HV/MV transformer', pos: [192, 62] }, { id: 'T-J2', kind: 'HV/MV transformer', pos: [207, 50] }, { id: 'T-J3', kind: 'HV/MV transformer', pos: [219, 50] }] }
    ],
    corridors: [
      { id: 'K-BA', level: 'EHV', tower: 'EHV single-circuit portal', circuits: ['L-BA'], path: [[98, 268], [202, 268]], towers: [{ pos: [150, 268], type: 'suspension' }] },
      { id: 'K-AC', level: 'EHV', tower: 'EHV double-circuit tower', circuits: ['L-AC1', 'L-AC2'], path: [[248, 254], [262, 240], [356, 240], [370, 254]],
        towers: [{ pos: [262, 240], type: 'angle' }, { pos: [309, 240], type: 'suspension' }, { pos: [356, 240], type: 'angle' }] },
      { id: 'K-AD', level: 'EHV', tower: 'EHV single-circuit portal', circuits: ['L-AD'], path: [[216, 254], [276, 142]], towers: [{ pos: [246, 198], type: 'suspension' }] },
      { id: 'K-BE', level: 'EHV', tower: 'EHV single-circuit portal', circuits: ['L-BE'], path: [[64, 254], [124, 142]], towers: [{ pos: [94, 198], type: 'suspension' }] },
      { id: 'K-ED', level: 'EHV', tower: 'EHV single-circuit portal', circuits: ['L-ED'], path: [[158, 128], [262, 128]], towers: [{ pos: [210, 128], type: 'suspension' }] },
      { id: 'K-DI', level: 'EHV', tower: 'EHV single-circuit portal', circuits: ['L-DI'], path: [[318, 128], [422, 128]], towers: [{ pos: [370, 128], type: 'suspension' }] },
      { id: 'K-CI', level: 'EHV', tower: 'EHV single-circuit portal', circuits: ['L-CI'], path: [[398, 254], [458, 142]], towers: [{ pos: [428, 198], type: 'suspension' }] },
      { id: 'K-X', level: 'EHV', tower: 'EHV double-circuit tower', circuits: ['L-X1', 'L-X2'], path: [[102, 128], [0, 128]], towers: [{ pos: [66, 128], type: 'suspension' }, { pos: [28, 128], type: 'suspension' }] },
      { id: 'K-BF', level: 'HV', tower: 'HV single-circuit pole', circuits: ['L-BF'], path: [[44, 297], [30, 316], [22, 330]], towers: [{ pos: [30, 316], type: 'angle' }] },
      { id: 'K-CG', level: 'HV', tower: 'HV single-circuit pole', circuits: ['L-CG'], path: [[464, 280], [474, 248], [506, 234]], towers: [{ pos: [474, 248], type: 'angle' }] },
      { id: 'K-GI', level: 'HV', tower: 'HV single-circuit pole', circuits: ['L-GI'], path: [[506, 196], [508, 156]], towers: [{ pos: [507, 176], type: 'suspension' }] },
      { id: 'K-DJ', level: 'HV', tower: 'HV double-circuit pole', circuits: ['L-DJ1', 'L-DJ2'], path: [[268, 76], [232, 76]], towers: [{ pos: [250, 76], type: 'suspension' }] }
    ],
    cables: [
      { id: 'MV-wind', paths: [[[40, 352], [96, 352], [128, 348]], [[40, 358], [120, 366], [174, 344]]] },
      { id: 'MV-solar', paths: [[[532, 218], [544, 250]], [[532, 226], [520, 252]]] },
      { id: 'MV-industry', paths: [[[190, 62], [186, 62]], [[207, 48], [186, 48]], [[219, 48], [214, 43], [186, 43]]] },
      // the MV cable runs in front of the second enclosure into the gap between the two
      { id: 'MV-battery', paths: [[[540, 166], [536.5, 167], [536.5, 172]]] },
      { id: 'HV-battery', paths: [[[527, 151], [538, 158]]] },
      // the three cables to the second town substation (TS2, z 40 to 52) end inside its fence, at z 50
      { id: 'HV-town', paths: [[[532, 104], [540, 96], [540, 50]], [[532, 112], [546, 100], [546, 50]], [[532, 120], [552, 108], [552, 50]],
        [[532, 128], [534, 98], [508, 66]], [[532, 136], [536, 100], [512, 66]], [[532, 144], [538, 102], [516, 66]]] }
    ],
    town_substations: [{ id: 'TS1', pos: [512, 60] }, { id: 'TS2', pos: [546, 46] }],
    offshore: { rows: [[440, [90, 190, 290, 390]], [520, [140, 240, 340]]], collector: [452, 512], converter: [500, 560] },
    hvdc: [{ cable: [[492, 540], [430, 476], [330, 422], [270, 342]] }, { cable: [[418, 342], [436, 372], [500, 404], [560, 414]] }]
  };

  function buildCompact(S, L) {
    var g = S.ground, sea = S.seaY, C = COMPACT, NET = global.StudioNet;
    plinthAndPlates(S, L);
    var wind = nrm([-0.18, 0, -1]);
    var net = buildNet(S, C, { endSide: { B5: -1, A1: -1, I18: -1, G1: -1, G5: -1, I7: 1 }, trScale: 0.72 });
    var k = 0;
    C.offshore.rows.forEach(function (r) { r[1].forEach(function (x) { turbine(S, 'tb-off-' + (k++), x, r[0], sea, 84, 50, { offshore: true, wind: wind, phase: rnd(k * 7.1) * TAU, period: 8.0 + 1.6 * rnd(k * 3.3) }); }); });
    var col = C.offshore.collector, cvp = C.offshore.converter;
    C.offshore.rows.forEach(function (r, i) {
      var pts = r[1].map(function (x) { return [x, r[0]]; }).concat([[col[0] - 12, col[1] + (i - 0.5) * 6]]);
      cableObj(S, 'array-' + i, pts, 'array', 0.8, 'renewables', { id: 'array-' + i, src: { type: 'el', el: 'offshore_wind', share: 0.5, sign: 1, cap: 2000 }, w: 'cable' });
    });
    platform(S, 'collector', col[0], col[1], 24, 20, 26, sea, false);
    S.live.lamps.push(platform(S, 'converter-off', cvp[0], cvp[1], 54, 38, 32, sea, true));
    cableObj(S, 'ac-export-0', [[col[0] + 12, col[1] + 8], [cvp[0] - 22, cvp[1] - 10]], 'cable', 0.9, 'hvdc', { id: 'ac-export-0', src: { type: 'el', el: 'offshore_wind', share: 1, sign: 1, cap: 2000 }, w: 'cable' });
    [-3, 0, 3].forEach(function (o, i) {
      cableObj(S, 'dc1-' + i, offsetPath(C.hvdc[0].cable, o), 'cable', 1.05, 'hvdc', i === 1 ? { id: 'dc1-1', src: { type: 'el', el: 'none', share: 1, sign: 1, cap: 2000 }, w: 'dc' } : { id: 'dc1-' + i, src: { type: 'el', el: 'offshore_wind', share: 0.5, sign: 1, cap: 2000 }, w: 'dc' });
    });
    [-1.7, 1.7].forEach(function (o, i) {
      cableObj(S, 'dc2-' + i, offsetPath(C.hvdc[1].cable, o), 'cable', 1.05, 'hvdc', { id: 'dc2-' + i, src: { type: 'el', el: 'dc_interconnector', share: 0.5, sign: -1, cap: 1400 }, w: 'dc' });
    });
    converterHall(S, 'conv-a1', [212, 298, 232, 336], 40, 'hvdc', true);
    converterHall(S, 'conv-a2', [234, 298, 254, 336], 40, 'hvdc', true);
    converterHall(S, 'conv-a-dc', [258, 300, 286, 334], 22, 'hvdc', false);
    converterHall(S, 'conv-c1', [378, 298, 402, 336], 40, 'hvdc', true);
    converterHall(S, 'conv-c-dc', [406, 300, 432, 334], 22, 'hvdc', false);
    S.live.lamps.push([272, g + 23.5, 300], [419, g + 23.5, 300]);
    var h1 = hill(S, 'hill-a', 146, 350, 56, 26, 3, 0.56);
    S.hills = [h1];
    [[124, 348], [172, 344]].forEach(function (q, i) {
      turbine(S, 'tb-on-' + i, q[0], q[1], h1.heightAt(q[0], q[1]), 70, 42, { wind: wind, phase: rnd(40 + i) * TAU, period: 6.8 + 1.2 * rnd(i * 5.7) });
    });
    solarField(S, [492, 514, 536], 256, 348, 13, 4);
    batteryPark(S, [517, 538], [168], 18, 8, 9);
    C.town_substations.forEach(function (t) { townSub(S, 'ts-' + t.id, t.pos, 18, 12); });
    town(S, TOWN.compact, true);
    industrySite(S, [146, 36, 184, 62], [[160, 80, 5.5, 10], [176, 80, 5.5, 10]], true);
    thermalPlant(S, [8, 34, 100, 96], net.XF['T-GSU'], true);
    xfmrFins(S);
    cableLanes(S, C.cables, net.bays);
    trees(S, [[180, 200, 7], [200, 214, 6], [330, 200, 7], [350, 186, 6], [20, 260, 6], [470, 340, 6], [540, 140, 6]]);
    var yawP = -0.12;
    panel(S, 'pn-onshore', { tech: 'onshore', x: 140, z: 352, y: 112, w: 190, h: 100, yaw: yawP, rods: [-0.26, 0.26] });
    panel(S, 'pn-offshore', { tech: 'offshore', x: 262, z: 486, y: 150, w: 280, h: 140, yaw: yawP, foot: sea, rods: [-0.393, 0.393] });
    // the solar sheet: its field about as large on screen as the onshore one
    panel(S, 'pn-solar', { tech: 'solar', x: 464, z: 300, y: 100, w: 186, h: 106, yaw: yawP, rods: [-0.28, 0.3] });
    panel(S, 'pn-line', LINE_SHEET.compact);
    enginePlant(S, ENGINES.compact, net.XF['T-GE']);   // gated (b6), its lanes last
    biomassPlant(S, BIOMASS.compact, net.XF['T-BM'], net.bays.I20);   // gated (b7), its lanes after b6's
    gatedLanes(S);
  }

  // Rounded rectangle, counter-clockwise, local x in [-w/2, w/2], y in [0, h].
  function roundRect(w, h, r, n) {
    var pts = [], cs = [[w / 2 - r, r, -Math.PI / 2], [w / 2 - r, h - r, 0], [-w / 2 + r, h - r, Math.PI / 2], [-w / 2 + r, r, Math.PI]];
    cs.forEach(function (c) { for (var i = 0; i <= n; i++) { var a = c[2] + i / n * Math.PI / 2; pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); } });
    return pts;
  }

  // Acrylic panel on two steel rods, standing at (cx, cz), bottom edge at height yb.
  function panel(S, id, spec) {
    var yaw = spec.yaw, w = spec.w, h = spec.h, t = spec.t || 12, cx = spec.x, cz = spec.z, yb = spec.y, g = spec.foot != null ? spec.foot : S.ground;
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var L = function (x, y, z) { var r = rotY([x, 0, z], yaw); return [cx + r[0], yb + y, cz + r[2]]; };
    var ring = roundRect(w, h, spec.r || 9, 4);
    var P = {
      id: id, tech: spec.tech, spec: spec,
      fl: L(-w / 2, 0, -t / 2), fr: L(w / 2, 0, -t / 2), tl: L(-w / 2, h, -t / 2), tr: L(w / 2, h, -t / 2),
      bl: L(-w / 2, 0, t / 2), br: L(w / 2, 0, t / 2), btl: L(-w / 2, h, t / 2), btr: L(w / 2, h, t / 2),
      front: ring.map(function (q) { return L(q[0], q[1], -t / 2); }),
      hiTop: [L(-w / 2 + 12, h, -t / 2), L(w / 2 - 12, h, -t / 2)]
    };
    // the line sheet belongs to two stories: switching and congestion management. The sheet and its rods are the 'r4'
    // panel style (pv 'r4'); they define the camera fit and the fields in every style
    var o = S.obj(id, { kind: 'panel', theme: spec.theme || 'renewables', themes: spec.themes || null, pv: 'r4' });
    o.panel = P;
    o.anchor = L(0, 0, 0);
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / l, ny = -dx / l;
      o.faceN([L(a[0], a[1], -t / 2), L(b[0], b[1], -t / 2), L(b[0], b[1], t / 2), L(a[0], a[1], t / 2)], 'ac', [cy * nx, ny, -sy * nx]);
    }
    var rods = S.obj(id + '-rods', { kind: 'rods', theme: spec.theme || 'renewables', themes: spec.themes || null, pv: 'r4' });
    (spec.rods || [-0.3, 0.3]).forEach(function (u) {
      var top = L(u * w, 0, 0), foot = [top[0], g, top[2]];
      rods.line([foot, top], 'rod', 1.6);
      rods.ao.push({ p: [[foot[0] - 3, g + 0.05, foot[2] - 2], [foot[0] + 3, g + 0.05, foot[2] - 2], [foot[0] + 3, g + 0.05, foot[2] + 2], [foot[0] - 3, g + 0.05, foot[2] + 2]], a: 1 });
      rods.shadow.push({ p: shadowPoly([[foot[0] - 0.7, g, foot[2]], [foot[0] + 0.7, g, foot[2]], [top[0] - 0.7, top[1], top[2]], [top[0] + 0.7, top[1], top[2]]], g, LIGHT), a: 0.5 });
      var cl = [L(u * w - 4.5, -5, -t / 2 - 2.2), L(u * w + 4.5, -5, -t / 2 - 2.2), L(u * w + 4.5, 7, -t / 2 - 2.2), L(u * w - 4.5, 7, -t / 2 - 2.2),
        L(u * w - 4.5, -5, t / 2 + 2.2), L(u * w + 4.5, -5, t / 2 + 2.2), L(u * w + 4.5, 7, t / 2 + 2.2), L(u * w - 4.5, 7, t / 2 + 2.2)];
      var cin = L(u * w, 1, 0);
      [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]].forEach(function (f) { rods.face(f.map(function (k) { return cl[k]; }), 'mt', cin); });
    });
    rods.anchor = L(0, 0, -t * 1.6);
    o.tint = shadowPoly(P.front.concat(ring.map(function (q) { return L(q[0], q[1], t / 2); })), g, LIGHT);
    S.panels.push(o);
    return o;
  }

  /* ───────────────────────────── projection ───────────────────────────── */

  function fmt(n) { var r = Math.round(n * 10) / 10; return (r === Math.round(r) ? String(Math.round(r)) : r.toFixed(1)).replace(/^-0$/, '0'); }
  function pathOf(pts) { var s = 'M' + fmt(pts[0][0]) + ' ' + fmt(pts[0][1]); for (var i = 1; i < pts.length; i++) s += 'L' + fmt(pts[i][0]) + ' ' + fmt(pts[i][1]); return s; }

  function build(name) {
    var L = LAYOUTS[name], S = new Scene(name);
    S.layout = L; S.ground = L.groundY; S.seaY = L.seaY; S.light = LIGHT;
    if (name === 'wide') buildWide(S, L); else buildCompact(S, L);
    // the switched spine is part of the balancing story's second act, so everything of the switching theme (the spine's
    // wire, bays, gantries, line-side spans, towers and blades) is lit in that highlight too
    S.objs.forEach(function (o) { if (o.theme === 'switching' && !(o.themes && o.themes.indexOf('balancing') >= 0)) o.themes = (o.themes || []).concat(['balancing']); });
    var cam = new Camera(Object.assign({}, L.cam));
    var pts = [];
    S.objs.forEach(function (o) {
      if (o.id === 'plinth') o.faces.forEach(function (f) { pts = pts.concat(f.p); });
      else if (o.kind === 'panel') pts = pts.concat([o.panel.tl, o.panel.tr, o.panel.btl, o.panel.btr]);
      else if (o.kind === 'turbine') pts.push(add(o.rotor.hub, [0, o.rotor.R, 0]));
    });
    var pr = pts.map(function (p) { return cam.p(p); });
    var minX = Math.min.apply(null, pr.map(function (q) { return q[0]; })), maxX = Math.max.apply(null, pr.map(function (q) { return q[0]; }));
    var minY = Math.min.apply(null, pr.map(function (q) { return q[1]; })), maxY = Math.max.apply(null, pr.map(function (q) { return q[1]; }));
    var VW = L.view[0], VH = L.view[1], M = L.margin;
    var f = Math.min((VW - M.l - M.r) / (maxX - minX), (VH - M.t - M.b) / (maxY - minY));
    cam.f = f; cam.cx = M.l + (VW - M.l - M.r) / 2 - f * (minX + maxX) / 2; cam.cy = VH - M.b - f * maxY;
    S.cam = cam;
    S.fit = { w: f * (maxX - minX), h: f * (maxY - minY) };
    S.objs.forEach(function (o) {
      if (o.kind !== 'trackers') return;
      var xs = o.rows.map(function (r) { return r.x; }), c = [(Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, o.rows[0].y, (o.rows[0].z0 + o.rows[0].z1) / 2];
      var V = nrm(sub(cam.C, c)), sp = Math.max.apply(null, xs) - Math.min.apply(null, xs) + o.rows[0].w;
      o.rim = add(c, mul(nrm([-V[0], V[1], -V[2]]), sp * GLINT.rimDist));
    });
    panelVariants(S);
    project(S);
    return S;
  }

  // The light volume and the band frame of every panel, made after the camera fit (the band is placed by screen height).
  // Neither enters the fit, so the model is as large in every panel style.
  function panelVariants(S) {
    var V = VOL[S.name], B = BAND[S.name], cam = S.cam, g = S.ground, sea = S.seaY;
    var groundAt = function (x, z) { var y = g; (S.hills || []).forEach(function (h) { y = Math.max(y, h.heightAt(x, z)); }); return y; };
    var yAt = function (x, z, sy) { var lo = -400, hi = 1600; for (var i = 0; i < 50; i++) { var m = (lo + hi) / 2; if (cam.p([x, m, z])[1] > sy) lo = m; else hi = m; } return (lo + hi) / 2; };
    S.panels.forEach(function (po) {
      var P = po.panel, tech = P.tech, e = V.emit[tech], up = [0, tech === 'line' ? V.lineRaise : 0, 0];
      var ey = tech === 'offshore' ? sea + 0.5 : groundAt(e[0], e[1]) + 1;
      P.vol = { e: [e[0], ey, e[1]], R: tech === 'line' ? V.Rline : V.R, fl: add(P.fl, up), fr: add(P.fr, up), tl: add(P.tl, up), tr: add(P.tr, up) };
      var vo = S.obj(P.id + '-vol', { kind: 'vol', theme: po.theme, themes: po.themes, pv: 'vol' });
      vo.pn = P; vo.anchor = P.vol.e;
      var bw = (B.wt && B.wt[tech]) || B.w, x = B.x[tech], ya = yAt(x, B.z, B.bot), yb = yAt(x, B.z, B.top), hw = bw / 2, s = B.src[tech];
      P.band = { fl: [x - hw, ya, B.z], fr: [x + hw, ya, B.z], tl: [x - hw, yb, B.z], tr: [x + hw, yb, B.z], w: bw, h: yb - ya,
        src: [s[0], (tech === 'offshore' ? sea : g) + s[1], s[2]] };
      var bo = S.obj(P.id + '-band', { kind: 'band', theme: po.theme, themes: po.themes, pv: 'band' });
      bo.pn = P; bo.anchor = [x, ya, B.z];
    });
  }

  function project(S) {
    var cam = S.cam, L = S.light;
    S.objs.forEach(function (o) {
      o.depth = cam.depth(o.anchor || [0, 0, 0]);
      o.fall = falloff(S, o.anchor || [0, 0, 0]);
      o.pf = [];
      o.faces.forEach(function (f) {
        var c = centroid(f.p);
        if (!cam.sees(c, f.n)) return;
        var sp = f.p.map(function (p) { return cam.p(p); });
        f.d = dot(sub(c, cam.C), cam.F);
        f.sp = sp; f.k = level(intensity(f.n, L) * falloff(S, c));
        o.pf.push(f);
      });
      o.pf.sort(function (a, b) { return b.d - a.d; });
      o.pl = o.lines.map(function (l) { return { sp: l.p.map(function (p) { return cam.p(p); }), c: l.c, w: l.w }; });
      o.ps = o.spheres.map(function (s) { var c = cam.p(s.c); return { c: c, r: s.r * cam.f / c[2], m: s.m, k: level(0.86 * falloff(S, s.c)) }; });
      o.psh = o.shadow.map(function (s) { return { sp: s.p.map(function (p) { return cam.p(p); }), a: s.a }; });
      o.pao = o.ao.map(function (s) { return { sp: s.p.map(function (p) { return cam.p(p); }), a: s.a }; });
      o.bb = bboxOf(o);
    });
    S.objs.forEach(function (o) {
      if (o.kind === 'turbine') {
        var c = cam.p(o.rotor.hub), r = o.rotor.R * cam.f / c[2] * 1.04;
        o.bb = unionBB(o.bb, [c[0] - r, c[1] - r, c[0] + r, c[1] + r]);
      } else if (o.kind === 'trackers') {
        // a screen box per row as well (o.bbs), so objects beside a row are not taken for occluders
        var b = null;
        o.bbs = [];
        o.rows.forEach(function (r) {
          var rb = null;
          [r.z0, r.z1].forEach(function (z) { [-1, 1].forEach(function (s) { var q = cam.p([r.x + s * r.w * 0.55, r.y + r.w * 0.45, z]), q2 = cam.p([r.x + s * r.w * 0.55, r.y - r.w * 0.45, z]); rb = unionBB(rb, [q[0], q[1], q[0], q[1]]); rb = unionBB(rb, [q2[0], q2[1], q2[0], q2[1]]); }); });
          b = unionBB(b, rb);
          // the row's swept outline on screen (its panel edges at tilt -amp, 0 and +amp, a convex hull), so the
          // occluder test can be exact for the trackers: the town's gables touch the rows' boxes but not the panels
          var hp = [], hw = r.w / 2;
          [-TRACK.amp, 0, TRACK.amp].forEach(function (a) { [r.z0, r.z1].forEach(function (z) { [-1, 1].forEach(function (s) { var q = cam.p([r.x + s * hw * Math.cos(a), r.y + s * hw * Math.sin(a), z]); hp.push([q[0], q[1]]); }); }); });
          var hull = hull2(hp);
          o.bbs.push(bbOfPts(hull)); (o.hulls || (o.hulls = [])).push(hull);
        });
        o.bb = b;
      } else if (o.kind === 'battery') {
        var bb = null;
        o.cells.forEach(function (c) { [[c.x0, c.y0], [c.x1, c.y1]].forEach(function (q) { var s = cam.p([q[0], q[1], c.z]); bb = unionBB(bb, [s[0] - 2, s[1] - 2, s[0] + 2, s[1] + 2]); }); });
        o.bb = bb;
      } else if (o.kind === 'breaker') {
        var bbk = null;
        o.blades.forEach(function (bl) {
          [bl.pivot, add(bl.pivot, mul(bl.dir, bl.len)), add(bl.pivot, [0, bl.len, 0])].forEach(function (q) { var s = cam.p(q); bbk = unionBB(bbk, [s[0], s[1], s[0], s[1]]); });
        });
        o.bb = [bbk[0] - 3, bbk[1] - 3, bbk[2] + 3, bbk[3] + 3];
      }
    });
    S.panels.forEach(function (o) {
      var P = o.panel, sp = {};
      ['fl', 'fr', 'tl', 'tr', 'bl', 'br', 'btl', 'btr'].forEach(function (k) { sp[k] = cam.p(P[k]); });
      P.sp = sp;
      P.spFront = P.front.map(function (p) { return cam.p(p); });
      P.spHi = P.hiTop.map(function (p) { return cam.p(p); });
      // the particle field on the sheet (base insets), and one field per panel style: the 'r4' sheet's, the light
      // volume's (the sheet's for the sources; raised for the line) and the band frame's
      P.field = fieldOf(P, cam, INSETS.base);
      P.fields = { r4: P.field, volumes: P.tech === 'line' ? fieldOf({ fl: P.vol.fl, fr: P.vol.fr, tl: P.vol.tl, tr: P.vol.tr, spec: P.spec }, cam, INSETS.base) : P.field,
        band: fieldOf({ fl: P.band.fl, fr: P.band.fr, tl: P.band.tl, tr: P.band.tr, spec: { w: P.band.w, h: P.band.h } }, cam, INSETS.band) };
      P.affineError = Math.max(P.field.err, P.fields.volumes.err, P.fields.band.err);
      P.walls = P.field.walls; P.base = P.field.base;
      P.tint = o.tint.map(function (p) { return cam.p(p); });
      o.bb = unionBB(o.bb, bbOfPts([sp.fl, sp.fr, sp.tl, sp.tr, sp.btl, sp.btr]));
    });
    // flow lanes on screen: the polyline and its cumulative length (view units)
    S.lanes.forEach(function (ln) {
      var sp = ln.pts.map(function (p) { return cam.p(p); }), cum = [0];
      for (var i = 1; i < sp.length; i++) cum.push(cum[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]));
      ln.sp = sp; ln.cum = cum; ln.len = cum[cum.length - 1];
    });
    occluders(S);
    laneOcclusion(S);
  }

  // The flow light is drawn on the canvas above the whole static model, while the SVG draws the conductors in depth order,
  // so where a lane passes behind a house, a block, a stack, a battery enclosure, a transformer, the biomass station's
  // cooling tower or a turbine tower that stands in front of it on screen, the light would run over that object's walls
  // and roof. Each lane's hidden stretches: arc positions along its projected polyline (view units, as ln.cum) sampled
  // every OCC.step; the world point under each (perspective-correct along its 3D segment) is hidden when it lies on screen
  // inside a front face of a solid that is nearer the camera there (the face's plane against the camera ray) by more than
  // OCC.eps; each stretch's ends are refined by bisection (OCC.iter halvings), so the light stops at the object's edge.
  // Not occluders: the ground layer, wires, the acrylic panels with their volumes and bands, moving parts other than the
  // turbines (their towers and nacelles are static; the rotors are not), and a line's own towers (its conductors hang on
  // them, and the SVG draws them over their own tower too). A gated object (the gas-engine plant, the biomass station)
  // hides light only while its gate is open: ln.occ[''] holds the stretches hidden by ungated objects, ln.occ.b6 and
  // ln.occ.b7 those hidden with that gate open as well, ln.occ.hvc those hidden by the converter sites the HVDC story's
  // day keeps lit. Beams.layout cuts the light there (to the sub-segment).
  var OCC = { step: 0.5, eps: 0.3, iter: 12, cell: 24 };
  function laneOcclusion(S) {
    var cam = S.cam, CC = cam.C, cs = OCC.cell, G = {};
    var cand = S.objs.filter(function (o) { return o.layer !== 'ground' && o.kind !== 'wire' && !/^(panel|rods|vol|band)$/.test(o.kind) && (!o.live || o.kind === 'turbine') && o.pf && o.pf.length; });
    cand.forEach(function (o) {
      var bit = !o.gate ? 1 : o.gate === 'b6' ? 2 : o.gate === 'b7' ? 4 : 0;
      if (!bit) return;
      if (bit === 1 && HVC_RE.test(o.id)) bit = 9;   // a converter site the HVDC story's day keeps lit (bit 8, key hvc)
      o.pf.forEach(function (f) {
        var b = bbOfPts(f.sp), q = { f: f, o: o, b: b, bit: bit };
        for (var gx = Math.floor(b[0] / cs); gx <= Math.floor(b[2] / cs); gx++) for (var gy = Math.floor(b[1] / cs); gy <= Math.floor(b[3] / cs); gy++) (G[gx + ',' + gy] = G[gx + ',' + gy] || []).push(q);
      });
    });
    // the gate bits of the objects in front of world point q: 1 an ungated object, 2 the gas-engine plant (b6), 4 the
    // biomass station (b7), 8 a converter site the HVDC story's day keeps lit (always with 1); an object is skipped once
    // all its bits are set
    function front(q, own) {
      var s = cam.p(q), cell = G[Math.floor(s[0] / cs) + ',' + Math.floor(s[1] / cs)], m = 0, d = null;
      if (!cell) return 0;
      for (var i = 0; i < cell.length; i++) {
        var e = cell[i], b = e.b;
        if ((m & e.bit) === e.bit || s[0] < b[0] || s[0] > b[2] || s[1] < b[1] || s[1] > b[3] || (own && own.test(e.o.id)) || !inPoly(s[0], s[1], e.f.sp)) continue;
        if (!d) { var u = (s[0] - cam.cx) / cam.f, v = (cam.cy - s[1]) / cam.f; d = add(add(cam.F, mul(cam.R, u)), mul(cam.U, v)); }
        var nd = dot(e.f.n, d);
        if (Math.abs(nd) < 1e-9) continue;
        if (dot(e.f.n, sub(e.f.p[0], CC)) / nd < s[2] - OCC.eps) m |= e.bit;
      }
      return m;
    }
    var KEYS = [['', 1], ['b6', 3], ['b7', 5], ['hvc', 8]];   // hvc: the stretches hidden by the kept converter sites
    S.lanes.forEach(function (ln) {
      var P = ln.pts, sp = ln.sp, cum = ln.cum, len = ln.len, own = /^L-([A-Z]+)\d*$/.exec(ln.id), ownRe = own ? new RegExp('^K-' + own[1] + '-t\\d+$') : null;
      if (!(len > 0)) return;
      // the world point at arc position a (view units): perspective-correct along the 3D segment under it
      var at = function (a) {
        var i = 0; while (i < cum.length - 2 && cum[i + 1] < a) i++;
        var l = cum[i + 1] - cum[i] || 1, u = clamp((a - cum[i]) / l, 0, 1), z0 = sp[i][2], z1 = sp[i + 1][2], t = (u / z1) / ((1 - u) / z0 + u / z1);
        return [lerp(P[i][0], P[i + 1][0], t), lerp(P[i][1], P[i + 1][1], t), lerp(P[i][2], P[i + 1][2], t)];
      };
      var N = Math.max(1, Math.ceil(len / OCC.step)), A = [], Mk = [], k, any = 0;
      for (k = 0; k <= N; k++) { A.push(len * k / N); Mk.push(front(at(A[k]), ownRe)); any |= Mk[k]; }
      if (!any) return;
      var occ = {};
      KEYS.forEach(function (K) {
        var hid = function (m) { return (m & K[1]) !== 0; }, out = [], a0 = null;
        var edge = function (lo, hi, inHid) {   // the arc position between lo and hi where hidden turns to inHid
          for (var r = 0; r < OCC.iter; r++) { var mid = (lo + hi) / 2; if (hid(front(at(mid), ownRe)) === inHid) hi = mid; else lo = mid; }
          return (lo + hi) / 2;
        };
        for (k = 0; k <= N; k++) {
          var h = hid(Mk[k]);
          if (h && a0 === null) a0 = k ? edge(A[k - 1], A[k], true) : 0;
          if (!h && a0 !== null) { out.push([a0, edge(A[k - 1], A[k], false)]); a0 = null; }
        }
        if (a0 !== null) out.push([a0, len]);
        if (out.length) occ[K[0]] = out;
      });
      ln.occ = occ;
    });
  }

  // Field rectangles on a sheet (share of the sheet's width and height left free on each side).
  var INSETS = {
    base: { l: 0.035, r: 0.035, t: 0.10, b: 0.07 },
    band: { l: 0, r: 0, t: 0.02, b: 0.02 }    // the band frame is the field (no sheet around it)
  };
  // The affine map of a field (local px: x right, y down from the top) onto the view, fitted to
  // the projected corners, its walls and floor, and the fit error.
  function fieldOf(P, cam, ins) {
    var w = P.spec.w, h = P.spec.h;
    var at = function (u, v) { return cam.p(mix3(mix3(P.fl, P.fr, u), mix3(P.tl, P.tr, u), v)); };
    var A = at(ins.l, 1 - ins.t), B = at(1 - ins.r, 1 - ins.t), C = at(ins.l, ins.b), D = at(1 - ins.r, ins.b);
    var fw = w * (1 - ins.l - ins.r), fh = h * (1 - ins.t - ins.b);
    var ex = [((B[0] - A[0]) + (D[0] - C[0])) / 2, ((B[1] - A[1]) + (D[1] - C[1])) / 2];
    var ey = [((C[0] - A[0]) + (D[0] - B[0])) / 2, ((C[1] - A[1]) + (D[1] - B[1])) / 2];
    var mc = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4];
    var o0 = [mc[0] - ex[0] / 2 - ey[0] / 2, mc[1] - ex[1] / 2 - ey[1] / 2];
    var A2 = o0, B2 = [o0[0] + ex[0], o0[1] + ex[1]], C2 = [o0[0] + ey[0], o0[1] + ey[1]], D2 = [o0[0] + ex[0] + ey[0], o0[1] + ex[1] + ey[1]];
    var err = Math.max.apply(null, [[A, A2], [B, B2], [C, C2], [D, D2]].map(function (q) { return Math.sqrt(Math.pow(q[0][0] - q[1][0], 2) + Math.pow(q[0][1] - q[1][1], 2)); }));
    return { w: fw, h: fh, M: [ex[0] / fw, ex[1] / fw, ey[0] / fh, ey[1] / fh, o0[0], o0[1]], walls: [[A2, C2], [B2, D2]], base: [C2, D2], err: err };
  }

  function bbOfPts(pts) { var b = null; pts.forEach(function (q) { b = unionBB(b, [q[0], q[1], q[0], q[1]]); }); return b; }
  function unionBB(a, b) { if (!a) return b; if (!b) return a; return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }
  function bboxOf(o) {
    var b = null;
    o.pf.forEach(function (f) { b = unionBB(b, bbOfPts(f.sp)); });
    o.pl.forEach(function (l) { b = unionBB(b, bbOfPts(l.sp)); });
    o.ps.forEach(function (s) { b = unionBB(b, [s.c[0] - s.r, s.c[1] - s.r, s.c[0] + s.r, s.c[1] + s.r]); });
    return b;
  }
  function overlap(a, b) { return a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }
  // separating-axis test of two convex polygons on screen ([x, y] points)
  function convexOverlap(A, B) {
    var polys = [A, B];
    for (var pi = 0; pi < 2; pi++) {
      var P = polys[pi];
      for (var i = 0; i < P.length; i++) {
        var a = P[i], b = P[(i + 1) % P.length], nx = a[1] - b[1], ny = b[0] - a[0], amin = 1e9, amax = -1e9, bmin = 1e9, bmax = -1e9, k, v;
        for (k = 0; k < A.length; k++) { v = A[k][0] * nx + A[k][1] * ny; amin = Math.min(amin, v); amax = Math.max(amax, v); }
        for (k = 0; k < B.length; k++) { v = B[k][0] * nx + B[k][1] * ny; bmin = Math.min(bmin, v); bmax = Math.max(bmax, v); }
        if (amax <= bmin || bmax <= amin) return false;
      }
    }
    return true;
  }
  // does object o overlap the moving object s on screen? Boxes, except for the trackers' rows, where any face of
  // o must overlap a row's swept outline
  function overlapObj(o, s) {
    if (!s.bbs) return overlap(o.bb, s.bb);
    for (var k = 0; k < s.bbs.length; k++) {
      if (!overlap(o.bb, s.bbs[k])) continue;
      if (!s.hulls) return true;
      for (var f = 0; f < o.pf.length; f++) if (overlap(bbOfPts(o.pf[f].sp), s.bbs[k]) && convexOverlap(o.pf[f].sp, s.hulls[k])) return true;
      for (var l = 0; l < o.pl.length; l++) if (overlap(bbOfPts(o.pl[l].sp), s.bbs[k])) return true;
      for (var c = 0; c < o.ps.length; c++) { var q = o.ps[c]; if (overlap([q.c[0] - q.r, q.c[1] - q.r, q.c[0] + q.r, q.c[1] + q.r], s.bbs[k])) return true; }
    }
    return false;
  }

  // Static objects in front of a moving part that overlap it on screen are drawn again on the
  // canvas, in depth order (and, transitively, whatever stands in front of those). Thin wires are
  // never occluders (a switched wire's state lives in the SVG; occlusion by a wire is invisible).
  // Two lists: canvasList for the 'r4' panel style (the sheets and their rods are objects in front of live parts, cached as
  // bitmaps); canvasListFree for the light volumes and the band, which have no sheet and no rod (their light is static SVG
  // and never covers a moving part).
  function occluders(S) {
    S.canvasList = occList(S, true);
    S.canvasListFree = occList(S, false);
  }
  function occList(S, sheets) {
    // a gated object is never an occluder, so the canvas lists are the same whichever gate is open (a gated object must
    // therefore stand clear of every moving part on screen)
    var live = S.objs.filter(function (o) { return o.live && !o.gate; });
    var cand = S.objs.filter(function (o) { return !o.live && !o.gate && o.layer !== 'ground' && o.kind !== 'wire' && o.bb && (sheets || (o.kind !== 'panel' && o.kind !== 'rods')); });
    var set = live.slice(), changed = true, guard = 0, occ = cand.map(function () { return false; });
    while (changed && guard++ < 20) {
      changed = false;
      cand.forEach(function (o, j) {
        if (occ[j]) return;
        for (var i = 0; i < set.length; i++) {
          var s = set[i];
          if (o.depth < s.depth - 0.5 && overlapObj(o, s)) { occ[j] = true; set.push(o); changed = true; break; }
        }
      });
    }
    return set.slice().sort(function (a, b) { return b.depth - a.depth; });
  }

  /* ───────────────────────────── SVG output ───────────────────────────── */

  // Lines of one object are merged per class and width into one path (much smaller markup).
  function groupLines(pl) {
    var groups = {}, order = [];
    pl.forEach(function (l) { var k = l.c + '|' + l.w; if (!groups[k]) { groups[k] = { c: l.c, w: l.w, d: '' }; order.push(k); } groups[k].d += pathOf(l.sp); });
    return order.map(function (k) { return groups[k]; });
  }
  function svgObj(o) {
    var out = [];
    o.pf.forEach(function (f) {
      if (f.x && f.x.sea) out.push('<path class="f sea se' + pad2(f.k) + '" d="' + pathOf(f.sp) + 'Z"/>');
      else out.push('<path class="f ' + f.m + pad2(f.k) + '" d="' + pathOf(f.sp) + 'Z"/>');
    });
    if (o.watch) {
      // the watched line (D-I) glows softly in the line sheet's color under its wire
      out.push('<path class="l watch" d="' + o.pl.map(function (l) { return pathOf(l.sp); }).join('') + '"/>');
    }
    if (o.sw) {
      // a switchable wire: the in-service and the out-of-service style, toggled by CSS on the stage
      var d = o.pl.map(function (l) { return pathOf(l.sp); }).join(''), c = o.pl[0].c;
      out.push('<path class="l ' + c + ' sw-on" data-br="' + o.sw + '" d="' + d + '"/>');
      out.push('<path class="l ' + c + ' sw-off" data-br="' + o.sw + '" d="' + d + '"/>');
    } else groupLines(o.pl).forEach(function (gp) { out.push('<path class="l ' + gp.c + '" d="' + gp.d + '"' + (gp.w !== 1 ? ' style="stroke-width:' + fmt2(gp.w) + '"' : '') + '/>'); });
    o.ps.forEach(function (s) { out.push('<circle class="sph cd' + pad2(s.k) + '" cx="' + fmt(s.c[0]) + '" cy="' + fmt(s.c[1]) + '" r="' + fmt(s.r) + '"/>'); });
    var cam = o.scene.cam;
    if (o.fxq) o.fxq.forEach(function (q) { out.push('<path class="' + q.c + '" d="' + pathOf(q.p.map(function (p) { return cam.p(p); })) + 'Z"/>'); });
    if (o.fxc) o.fxc.forEach(function (q) { var c = cam.p(q.p); out.push('<circle class="' + q.c + '" cx="' + fmt(c[0]) + '" cy="' + fmt(c[1]) + '" r="' + fmt2(q.r) + '"/>'); });
    return out.join('');
  }
  function fmt2(n) { return String(Math.round(n * 100) / 100); }

  function svgPanel(o) {
    var P = o.panel, out = [];
    o.pf.forEach(function (f) { out.push('<path class="f ac' + pad2(f.k) + '" d="' + pathOf(f.sp) + 'Z"/>'); });
    var face = pathOf(P.spFront) + 'Z';
    out.push('<path class="ac-glow" d="' + face + '"/>');
    out.push('<path class="ac-face" d="' + face + '"/>');
    out.push('<path class="ac-tint" d="' + face + '"/>');
    out.push('<path class="ac-sheen" d="' + face + '" fill="url(#ac-sheen-' + o.scene.name + ')"/>');
    out.push('<path class="ac-edge" d="' + face + '"/>');
    out.push('<path class="ac-hi" d="' + pathOf(P.spHi) + '"/>');
    return out.join('');
  }
  // The furniture lines of a field: a source field's floor (no output) and ceiling (full output), the line field's floor
  // and its limit rail. The panel style picks the field and the classes: a lit rail in the styles without a sheet, the
  // thin base line on the 'r4' sheets.
  function svgFieldLines(o, variant) {
    var P = o.panel, F = P.fields[variant], out = [], free = variant !== 'r4';
    var floor = pathOf([mapPt(F, 0, F.h), mapPt(F, F.w, F.h)]), ceil = pathOf([mapPt(F, 0, 0), mapPt(F, F.w, 0)]);
    if (P.tech === 'line') {
      var lim = LINE_LIMIT(), a = mapPt(F, lim * F.w, F.h), b = mapPt(F, lim * F.w, 0);
      out.push('<path class="' + (free ? 'ac-rail' : 'ac-base') + '" d="' + floor + '"/>');
      out.push('<path class="ac-limit" d="' + pathOf([a, b]) + '"/>');
    } else if (free) out.push('<path class="ac-rail" d="' + floor + '"/><path class="ac-rail-fine" d="' + ceil + '"/>');
    else out.push('<path class="ac-base" d="' + floor + ceil + '"/>');
    return out.join('');
  }
  function mapPt(F, lx, ly) { var M = F.M; return [M[0] * lx + M[2] * ly + M[4], M[1] * lx + M[3] * ly + M[5]]; }

  function svgRods(o) {
    var out = [];
    o.pl.forEach(function (l) { out.push('<path class="rod" d="' + pathOf(l.sp) + '"/>'); });
    o.pf.forEach(function (f) { out.push('<path class="f mt' + pad2(f.k) + '" d="' + pathOf(f.sp) + 'Z"/>'); });
    return out.join('');
  }

  // The static light of the panel styles, projected at output. A light volume: the faint column over its field, the white
  // haze behind the dots (light theme only, --s-haze), the beam from the puck's rim to the middle 60% of the floor, the
  // puck and its glow. A band frame: its haze; its thread of light (a gentle curve from the middle of the floor down to
  // the source) and the lit point at the source are drawn above the model (svgThreads). The gradients live in the static
  // layer's defs; the highlight copies use the same ids.
  function hazeOf(c) {
    var cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
    return '<ellipse class="pv-haze" cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" rx="' + fmt(Math.abs(c[1][0] - c[0][0]) * 0.62) + '" ry="' + fmt(Math.abs(c[0][1] - c[3][1]) * 0.75) + '" fill="url(#haze-' + c.layout + ')"/>';
  }
  function volGeom(o) {
    var P = o.pn, V = P.vol, cam = o.scene.cam, F = P.fields.volumes, e = V.e, R = V.R, ring = [], k;
    for (k = 0; k < 28; k++) { var a = k / 28 * TAU; ring.push(cam.p([e[0] + R * Math.cos(a), e[1], e[2] + R * 0.8 * Math.sin(a)])); }
    var f0 = mapPt(F, 0, F.h), f1 = mapPt(F, F.w, F.h), c0 = mapPt(F, 0, 0), c1 = mapPt(F, F.w, 0);
    var b0 = mapPt(F, 0.2 * F.w, F.h), b1 = mapPt(F, 0.8 * F.w, F.h), pl = cam.p([e[0] - R * 0.8, e[1], e[2]]), pr = cam.p([e[0] + R * 0.8, e[1], e[2]]);
    var quad = [f0, f1, c1, c0]; quad.layout = o.scene.name;
    return { ring: ring, col: quad, beam: [pl, b0, b1, pr], pe: cam.p(e), floorY: Math.min(b0[1], b1[1]), botY: Math.max(f0[1], f1[1]), topY: Math.min(c0[1], c1[1]) };
  }
  function bandGeom(o) {
    var P = o.pn, F = P.fields.band, cam = o.scene.cam;
    var quad = [mapPt(F, 0, F.h), mapPt(F, F.w, F.h), mapPt(F, F.w, 0), mapPt(F, 0, 0)]; quad.layout = o.scene.name;
    var a = mapPt(F, F.w / 2, F.h), sp = cam.p(P.band.src), dy = sp[1] - a[1];
    return { quad: quad, a: a, sp: sp, thread: 'M' + fmt(a[0]) + ' ' + fmt(a[1]) + 'C' + fmt(a[0]) + ' ' + fmt(a[1] + dy * 0.5) + ' ' + fmt(sp[0]) + ' ' + fmt(sp[1] - dy * 0.4) + ' ' + fmt(sp[0]) + ' ' + fmt(sp[1]) };
  }
  function gid(o, k) { return k + '-' + o.scene.name + '-' + o.pn.tech; }
  function svgVol(o) {
    var G = volGeom(o);
    return '<path class="pv-col" d="' + pathOf(G.col) + 'Z" fill="url(#' + gid(o, 'vc') + ')"/>' + hazeOf(G.col) +
      '<path class="pv-beam" d="' + pathOf(G.beam) + 'Z" fill="url(#' + gid(o, 'vb') + ')"/>' +
      '<path class="pv-puck-glow" d="' + pathOf(G.ring) + 'Z"/><path class="pv-puck" d="' + pathOf(G.ring) + 'Z"/>';
  }
  function svgBand(o) { return hazeOf(bandGeom(o).quad); }
  function svgThreads(list) {
    return list.map(function (o) {
      var G = bandGeom(o);
      return '<path class="pv-thread-glow" d="' + G.thread + '"/><path class="pv-thread" d="' + G.thread + '"/><circle class="pv-pt" cx="' + fmt(G.sp[0]) + '" cy="' + fmt(G.sp[1]) + '" r="1.8"/>';
    }).join('');
  }
  function pvDefs(S) {
    var out = ['<radialGradient id="haze-' + S.name + '"><stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.65" stop-color="#fff" stop-opacity="0.32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'];
    S.objs.forEach(function (o) {
      if (o.kind !== 'vol') return;
      var G = volGeom(o);
      // the line field's cone is what ties it to D-I (beside C's converter hall the chart could read as the HVDC link's),
      // so its beam is lit more strongly (model.css --s-lineBeamK)
      var k0 = o.pn.tech === 'line' ? 'calc(var(--s-beamA0) * var(--s-lineBeamK, 1))' : 'var(--s-beamA0)';
      out.push('<linearGradient id="' + gid(o, 'vb') + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + fmt(G.pe[1]) + '" x2="0" y2="' + fmt(G.floorY) + '">' +
        '<stop offset="0" style="stop-color:var(--s-volGlow);stop-opacity:' + k0 + '"/><stop offset="1" style="stop-color:var(--s-volGlow);stop-opacity:var(--s-beamA1)"/></linearGradient>');
      out.push('<linearGradient id="' + gid(o, 'vc') + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + fmt(G.botY) + '" x2="0" y2="' + fmt(G.topY) + '">' +
        '<stop offset="0" style="stop-color:var(--s-volGlow);stop-opacity:var(--s-colA)"/><stop offset="1" style="stop-color:var(--s-volGlow);stop-opacity:0"/></linearGradient>');
    });
    return out.join('');
  }
  // an object's group classes: its theme, its panel style (pv-*, shown by CSS on html[data-panels]) and its gate
  // (gate-*, which model.css hides unless that gate is open)
  function objCls(o) { return 'o' + (o.theme ? ' th-' + o.theme : '') + (o.pv ? ' pv pv-' + o.pv : '') + (o.gate ? ' gate-' + o.gate : ''); }
  function gateWrap(o, body) { return o.gate ? '<g class="gate-' + o.gate + '">' + body + '</g>' : body; }
  function objBody(o) {
    if (o.kind === 'panel') return svgPanel(o);
    if (o.kind === 'rods') return svgRods(o);
    if (o.kind === 'vol') return svgVol(o);
    if (o.kind === 'band') return svgBand(o);
    return svgObj(o);
  }

  // The static model: ground, shadows, contact shadows, objects (far to near).
  function svgStatic(S) {
    var out = [], grounds = [], objs = [];
    S.objs.forEach(function (o) { if (o.layer === 'ground') grounds.push(o); else if (!o.live) objs.push(o); });
    objs.sort(function (a, b) { return b.depth - a.depth; });
    out.push('<defs>' + defs(S) + pvDefs(S) + '</defs>');
    var pl = S.objs.filter(function (o) { return o.id === 'plinth'; })[0];
    if (pl) {
      var b = pl.bb;
      out.push('<g class="st-sh" filter="url(#blur-l-' + S.name + ')"><rect x="' + fmt(b[0] + 12) + '" y="' + fmt(b[3] - 16) + '" width="' + fmt(b[2] - b[0] - 4) + '" height="20" rx="10"/></g>');
    }
    out.push('<g class="g-ground">');
    grounds.forEach(function (o) { out.push(gateWrap(o, o.theme ? '<g class="th-' + o.theme + '">' + svgObj(o) + '</g>' : svgObj(o))); });
    out.push('</g>');
    var fall = [];
    grounds.forEach(function (o) { if (o.id === 'plinth' || o.id === 'land' || o.id === 'sea') o.pf.forEach(function (f) { fall.push('<path d="' + pathOf(f.sp) + 'Z"/>'); }); });
    out.push('<g class="st-fall" fill="url(#fall-' + S.name + ')">' + fall.join('') + '</g>');
    var sh = [], ao = [], tint = [], sh4 = [], ao4 = [], shG = {}, aoG = {};
    S.objs.forEach(function (o) {
      // a gated object's shadows go into its own gated group (inside the same blurred layer, last)
      var s1 = o.gate ? (shG[o.gate] = shG[o.gate] || []) : o.pv ? sh4 : sh, a1 = o.gate ? (aoG[o.gate] = aoG[o.gate] || []) : o.pv ? ao4 : ao;
      (o.psh || []).forEach(function (s) { if (s.sp.length > 2) s1.push('<path d="' + pathOf(s.sp) + 'Z" opacity="' + fmt(s.a) + '"/>'); });
      (o.pao || []).forEach(function (s) { if (s.sp.length > 2) a1.push('<path d="' + pathOf(s.sp) + 'Z" opacity="' + fmt(s.a) + '"/>'); });
    });
    S.panels.forEach(function (o) { tint.push('<path d="' + pathOf(o.panel.tint) + 'Z"/>'); });
    // the rods' shadows and the sheets' violet tints belong to the 'r4' panel style only
    if (sh4.length) sh.push('<g class="pv pv-r4">' + sh4.join('') + '</g>');
    if (ao4.length) ao.push('<g class="pv pv-r4">' + ao4.join('') + '</g>');
    Object.keys(shG).forEach(function (k) { sh.push('<g class="gate-' + k + '">' + shG[k].join('') + '</g>'); });
    Object.keys(aoG).forEach(function (k) { ao.push('<g class="gate-' + k + '">' + aoG[k].join('') + '</g>'); });
    var top = [];
    grounds.forEach(function (o) { if (o.id === 'plinth' || o.id === 'land' || o.id === 'sea') o.pf.forEach(function (f) { if (f.n[1] > 0.9) top.push('<path d="' + pathOf(f.sp) + 'Z"/>'); }); });
    out.push('<clipPath id="clip-top-' + S.name + '">' + top.join('') + '</clipPath>');
    out.push('<g clip-path="url(#clip-top-' + S.name + ')">');
    out.push('<g class="st-sh" filter="url(#blur-m-' + S.name + ')">' + sh.join('') + '</g>');
    out.push('<g class="st-tint pv pv-r4" filter="url(#blur-l-' + S.name + ')">' + tint.join('') + '</g>');
    out.push('<g class="st-ao" filter="url(#blur-s-' + S.name + ')">' + ao.join('') + '</g>');
    out.push('</g>');
    out.push('<g class="g-obj">');
    objs.forEach(function (o) {
      var cls = objCls(o);
      if (o.kind === 'panel') out.push('<g class="' + cls + ' pn" data-id="' + o.id + '">' + svgPanel(o) + '</g>');
      else if (o.kind === 'rods') out.push('<g class="' + cls + ' rods">' + svgRods(o) + '</g>');
      else out.push('<g class="' + cls + '">' + objBody(o) + '</g>');
    });
    out.push('</g>');
    out.push('<g class="pv pv-band pv-threads">' + svgThreads(objs.filter(function (o) { return o.kind === 'band'; })) + '</g>');
    return out.join('');
  }

  function defs(S) {
    var n = S.name, P = S.layout.pool, g = S.ground, cam = S.cam;
    var c0 = cam.p([P[0], g, P[1]]), cx = cam.p([P[0] + P[2], g, P[1]]), cz = cam.p([P[0], g, P[1] + P[3]]);
    var rx = Math.abs(cx[0] - c0[0]), ry = Math.max(Math.abs(cz[1] - c0[1]), rx * 0.32);
    return '<radialGradient id="fall-' + n + '" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(' + fmt(c0[0]) + ' ' + fmt(c0[1]) + ') scale(' + fmt(rx) + ' ' + fmt(ry * 1.6) + ')">' +
      '<stop offset="0" style="stop-color:var(--s-fall);stop-opacity:0"/><stop offset="0.42" style="stop-color:var(--s-fall);stop-opacity:0"/><stop offset="1" style="stop-color:var(--s-fall);stop-opacity:var(--s-fall-a)"/></radialGradient>' +
      '<filter id="blur-s-' + n + '" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="1.4"/></filter>' +
      '<filter id="blur-m-' + n + '" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="3.2"/></filter>' +
      '<filter id="blur-l-' + n + '" x="-10%" y="-20%" width="120%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>' +
      '<filter id="glow-' + n + '" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>' +
      '<linearGradient id="ac-sheen-' + n + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.32" stop-color="#fff" stop-opacity="0.06"/><stop offset="0.58" stop-color="#fff" stop-opacity="0"/><stop offset="0.8" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>';
  }

  // The balancing units' room as pools of light on the ground: teal-green around the battery park (the cheap group, the
  // battery's own hue), magenta with a stronger rim around the thermal plant (the dear group). A projected circle of the
  // full radius (550 MW of room); the page scales it about its center (radius proportional to the square root of the
  // room) and fades it, only during the balancing hover. Drawn in the highlight layer under every theme's objects, so the
  // units stand in their pools.
  var POOLS = { wide: { r: 92, bat: [1352, 72], gen: [480, 69] }, compact: { r: 50, bat: [536.5, 172], gen: [54, 65] }, full: 550 };
  // the gas-engine plant's unit point (ENGINES unit: its rings and arrow; it offers no balancing room, so no pool)
  function poolGeom(S) {
    var P = POOLS[S.name], cam = S.cam, g = S.ground, out = {};
    var E = ENGINES[S.name], eu = E ? cam.p([E.unit[0], g + 12 * (S.name === 'wide' ? 1 : 0.7), E.unit[1]]) : null;
    if (eu) out.eng = { unit: [eu[0], eu[1]] };
    // the biomass power station: the ring at the cooling tower's base, the arrow's foot just above its top (BM.foot)
    var BM = BIOMASS[S.name];
    // where BM.arrow is given, the arrow's foot stands there instead (wide: on the plinth's front face, right of the tower
    // and left of T-BM)
    if (BM) { var bu = cam.p([BM.unit[0], g + BM.unit[1], BM.unit[2]]), bf = BM.arrow ? cam.p([BM.arrow[0], g + BM.arrow[1], BM.arrow[2]]) : cam.p([BM.unit[0], g + BM.foot, BM.unit[2]]); out.bio = { unit: [bu[0], bu[1]], foot: [bf[0], bf[1]] }; }
    ['bat', 'gen'].forEach(function (k) {
      var c = P[k], ring = [];
      for (var i = 0; i < 48; i++) { var a = TAU * i / 48; ring.push(cam.p([c[0] + P.r * Math.cos(a), g + 0.4, c[1] + P.r * Math.sin(a)])); }
      var cc = cam.p([c[0], g + 0.4, c[1]]), top = cam.p([c[0], g + 12, c[1]]);
      out[k] = { ring: ring, c: [cc[0], cc[1]], unit: [top[0], top[1]], bb: bbOfPts(ring) };
    });
    return out;
  }
  function svgPools(S) {
    var G = poolGeom(S), n = S.name, grad = function (id, v) {
      return '<radialGradient id="' + id + '-' + n + '" cx="0.5" cy="0.5" r="0.5"><stop offset="0" style="stop-color:var(--s-' + v + ');stop-opacity:var(--s-poolA)"/>' +
        '<stop offset="0.62" style="stop-color:var(--s-' + v + ');stop-opacity:calc(var(--s-poolA) * 0.72)"/><stop offset="1" style="stop-color:var(--s-' + v + ');stop-opacity:0"/></radialGradient>';
    };
    var pool = function (k, cls, id) {
      var q = G[k], d = pathOf(q.ring) + 'Z';
      return '<g class="pool ' + cls + '" data-c="' + fmt(q.c[0]) + ' ' + fmt(q.c[1]) + '"><path class="pool-fill" fill="url(#' + id + '-' + n + ')" d="' + d + '"/>' +
        (k === 'gen' ? '<path class="pool-rim" d="' + d + '"/>' : '') + '</g>';
    };
    return '<defs>' + grad('pool-cheap', 'poolCheap') + grad('pool-dear', 'poolDear') + '</defs><g class="pools">' + pool('bat', 'pool-cheap', 'pool-cheap') + pool('gen', 'pool-dear', 'pool-dear') + '</g>';
  }

  // Highlight layers: the static objects of each theme, drawn again above the dimmed studio (every panel style, each
  // shown by CSS like the static layer; the band's threads above the theme's objects).
  function svgHighlights(S) {
    var out = [svgPools(S)];
    ['renewables', 'switching', 'hvdc', 'balancing'].forEach(function (th) {
      var parts = [], list = S.objs.filter(function (o) { return (o.theme === th || (o.themes && o.themes.indexOf(th) >= 0)) && !o.live; });
      var gnd = list.filter(function (o) { return o.layer === 'ground'; }), ob = list.filter(function (o) { return o.layer !== 'ground'; }).sort(function (a, b) { return b.depth - a.depth; });
      gnd.forEach(function (o) { parts.push(gateWrap(o, svgObj(o))); });
      ob.forEach(function (o) {
        var body = objBody(o);
        if (o.pv) parts.push('<g class="pv pv-' + o.pv + (o.kind === 'panel' ? ' pn' : '') + '">' + body + '</g>');
        else parts.push(gateWrap(o, body));   // a gated object in its gate's group
      });
      var bands = ob.filter(function (o) { return o.kind === 'band'; });
      if (bands.length) parts.push('<g class="pv pv-band pv-threads">' + svgThreads(bands) + '</g>');
      out.push('<g class="hl" data-hl="' + th + '">' + parts.join('') + '</g>');
    });
    return out.join('');
  }

  /* ───────────────────────────── moving parts: geometry at time t ───────────────────────────── */

  function rotorBlades(o, t) {
    var r = o.rotor, out = [], base = r.phase + TAU * t / r.period;
    for (var i = 0; i < 3; i++) {
      var th = base + i * TAU / 3, c = Math.cos(th), s = Math.sin(th);
      var b = add(mul(r.e2, c), mul(r.e1, s)), w = add(mul(r.e2, -s), mul(r.e1, c));
      var h = add(r.hub, mul(r.n, 0.6));
      var r0 = r.R * 0.06;
      var p = [add(add(h, mul(b, r0)), mul(w, r.rootW)), add(add(h, mul(b, r.R * 0.3)), mul(w, r.rootW * 0.9)), add(add(h, mul(b, r.R)), mul(w, r.tipW * 0.3)),
        add(add(h, mul(b, r.R)), mul(w, -r.tipW)), add(add(h, mul(b, r.R * 0.25)), mul(w, -r.rootW * 0.55)), add(add(h, mul(b, r0)), mul(w, -r.rootW * 0.6))];
      var nb = nrm(add(mul(r.n, 0.92), mul(w, 0.38)));
      out.push({ p: p, n: nb });
    }
    return out;
  }
  // Trackers sweep east to west and back in 44 s, starting mid-swing; a back light makes a glint travel across the rows
  // twice per sweep, never at t = 0.
  var TRACK = { amp: 0.84, period: 44, phase: -0.714 };
  // The glint: specular exponent k 120 and strength a 0.5 make a soft sheen that crosses the rows in about 2 s (a sharp
  // exponent lights one row at a time at full white, which reads as flicker).
  var GLINT = { k: 120, rimDist: 4.2, min: 0.02, a: 0.5 };
  function trackerAngle(t) { return TRACK.amp * Math.sin(TAU * t / TRACK.period + TRACK.phase); }
  function trackerQuads(o, t, cam, a0) {
    var a = a0 == null ? trackerAngle(t) : a0, ca = Math.cos(a), sa = Math.sin(a), out = [];   // a0: a given angle (the HVDC hover's day)
    var n = [-sa, ca, 0];
    o.rows.forEach(function (r) {
      var hw = r.w / 2, segL = (r.z1 - r.z0) / r.seg, gap = 2.4;
      for (var k = 0; k < r.seg; k++) {
        var za = r.z0 + k * segL + gap / 2, zb = r.z0 + (k + 1) * segL - gap / 2;
        var p = [[r.x - hw * ca, r.y - hw * sa, za], [r.x + hw * ca, r.y + hw * sa, za], [r.x + hw * ca, r.y + hw * sa, zb], [r.x - hw * ca, r.y - hw * sa, zb]];
        var mid = [r.x, r.y, (za + zb) / 2], V = nrm(sub(cam.C, mid)), H = nrm(add(o.rim ? nrm(sub(o.rim, mid)) : LIGHT, V));
        var spec = Math.pow(Math.max(0, dot(n, H)), GLINT.k);
        out.push({ p: p, n: n, spec: spec, fall: o.scene ? falloff(o.scene, mid) : 1, d: dot(sub(mid, cam.C), cam.F) });
      }
    });
    out.sort(function (x, y) { return y.d - x.d; });
    return out;
  }

  // ── The hero loop and the theme stories ──
  // Every state is a story state of StudioNet.stories (net.js): balanced at every bus, within limits, N-1 secure where
  // claimed, every imbalance covered in-zone, the AC tie and the DC interconnector on their schedules. The page solves them
  // with its own DC power flow.
  // The hero loop (48 s on the scene's own clock): the market schedule with D-I over its rating; at 8.0 s the spine L-AD is
  // switched out (the breakers at both ends, the blades 1.1 s later); at 10.5 s the rest of the same decision, the
  // redispatch pair (battery +200, thermal -200); from 12.0 s the delivered hour runs through four outcomes of the decided
  // state (4.5 s apart, each eased over 1.5 s), the spine dark and still; over 28.4-29.6 s the calm hour's schedule comes
  // in (DC-2 1100 to 0 MW, the wind and the rest with it) with the spine still open, so it is complete before the blades
  // close at 30.0 s and the interconnector never reads as acting with the operator; the breakers close at 31.2 s (the spine
  // back in service); from 44.0 s the schedule moves toward the next windy hour. The line goes back in only once the calm
  // schedule is in place, because reclosing on the windy outcomes would not be N-1 secure. All lanes move together between
  // two balanced states (the hour changes as a whole), so Kirchhoff's laws hold in every frame; HERO_QUIET's second window
  // starts at 28.4 s.
  // keys: [t, state, eased over (s), open lines, group] (group: 'wind' or 'rest' when only those lanes move; none: all).
  var HERO = {
    period: 48,
    keys: [[8.0, 'switched', 0.6, ['L-AD']], [10.5, 'aware', 0.6, ['L-AD']], [12.0, 'o50', 1.5, ['L-AD']], [16.5, 'o25', 1.5, ['L-AD']],
      [21.0, 'o10', 1.5, ['L-AD']], [25.5, 'o75', 1.5, ['L-AD']], [28.4, 'calm_open', 1.2, ['L-AD']], [31.2, 'calm', 0.3, []],
      [44.0, 'market', 3.2, []]],
    line: [[0, 'market'], [8.0, 'switched'], [10.5, 'aware'], [28.4, 'calm'], [44.0, 'market']],   // the line field's states
    rings: [[10.5, 22]],          // the operator's pair: a thin ring at both units (radius in CSS px at 1440)
    cut: 0.3                      // a line switched out (or back in) reaches its changed flow within 0.3 s
  };
  // the spine's breakers and blades in the hero: breakers open 8.0-31.2 s, blades up 9.1-9.9 s, down 30.0-30.8 s (switching
  // order: out, breakers then blades; in, blades then breakers)
  var SCHED = { period: HERO.period, events: [{ br: 'L-AD', open: 8.0, close: 30.0 }], bladeLag: 1.1, swing: 0.8, breakerLag: 1.2,
    // the rings of the operator's pair live 1.3 s and hold before they fade
    ringT: 1.3 };
  // reduced motion, Pause and the no-JS still show the decided state: the spine out, the pair done, D-I cool
  var DECIDED = { state: 'aware', open: ['L-AD'], line: 'aware' };
  // The theme stories, on a clock h that starts with the hover or focus. brk: the spine's breakers [h, open, light (0..1),
  // sweep]; the blades follow 1.1 s after an opening (0.8 s swing); rings: the operator's acts; pools: the balancing units'
  // upward room [h, battery MW, thermal MW, eased over]; tint: a unit's own connection takes its pool's color while the
  // pool drains [h0, h1, 'bat' | 'gen']; dip: the plinth's light dips to 70 % to cut back to the same afternoon [h0, h1];
  // spot: the follow-spot rises over [h0, h1] (switching only).
  function switchStory(lead) {
    return { key: 'switching', lead: lead,
      // lead 2.0 (a hover after the hero's own switch): the model first returns to the schedule (an open spine closes
      // again: blades, then breakers, about 0.85 s), so only then is the line over its rating; the first beat starts at 0.6 s
      say: [[lead >= 2.0 ? 0.6 : 0, 'The market\'s schedule overloads one line.'], [lead + 0.7, 'The operator switches another line out; power reroutes.'],
        [lead + 3.1, 'The same decision shifts two units: one up, one down.'], [lead + 6.5, 'Decided in advance, the line stays out as the wind varies.']],
      keys: [[0, 'market', 0.8, []], [lead, 'switched', 0.6, ['L-AD']], [lead + 2.5, 'aware', 0.6, ['L-AD']]],
      line: [[0, 'market'], [lead, 'switched'], [lead + 2.5, 'aware']],
      brk: [[0, false, 0, false], [lead, true, 1, true]], rings: [[lead + 2.5, 22]], spot: [lead - 1.2, lead], end: lead + 3.5 };
  }
  // The switching story's modes, picked by html[data-sw] (pushloop by default; 's3' plays switchStory above, with its
  // follow-spot). cam: the camera pushes in on the switched corridor (the stage's SVG layers and canvas move together; at
  // rest the canvas is redrawn at the zoomed scale, so it stays crisp); iso: the corridor keeps full light while the rest
  // of the model sinks into the page, and the battery park and the gas plant come up into the light when they make the
  // pair; loop: the act replays every `loop` s while the card stays hovered (push: once, then hold). T (s on the hover's
  // clock h): the line opens at `lead` (selected from `sel` before), the pair follows `pair` s later; `units`: the light on
  // the two units rises over that many s before the pair's rings.
  // In a replay the camera keeps the decision framing (frameView's decCam), so every pass is the same act in the same
  // frame, and nothing is shown switching back: no breaker light, no blade swing (BACK).
  var SWX = {
    push: { cam: 1, iso: 1, loop: 0 }, isolate: { cam: 0, iso: 1, loop: 9.0 }, pushloop: { cam: 1, iso: 1, loop: 9.0 },
    T: { lead: 1.1, sel: 0.8, pair: 2.2, units: 0.4, isoIn: 0.45, isoOut: 0.5, camIn: 0.9, camOut: 0.7,
      // the decision framing (camFit's dec): from 0.9 s before the pair, over 0.8 s, so both units are in frame before the
      // pair's rings (the reroute sweep ends 1.15 s after the opening, before this framing starts and 1.05 s before the pair)
      dec: [0.9, 0.8] },
    // the camera: the largest zoom that holds the corridor, the line field over D-I and both units of the pair, at most
    // zmax, fitted into the part of the stage that is on screen (under minVis px of it, no camera; under zCore with the
    // units, the corridor and the line field alone)
    CAM: { zmax: { wide: 1.9, compact: 1.6 }, margin: 26, below: 34, unit: [64, 30], minVis: 150, zCore: 1.25, zField: 0.85, zDec: 0.65 },
    // the corridor (the ladder the spine belongs to), how much the rest sinks (alpha of the page color over it), the sweep
    LANES: /^L-(AD|DI|ED|BE|AC1|AC2|CI|BA)$/, UNIT_LANES: /^(gen-|hv-battery|mv-battery-)/,
    SINK: { a: 0.72, dark: 0.7, beams: 0.16, dots: 0.15 }, SWEEP: { gain: 1.6, dur: 1.0, delay: 0.15 }, GAP: 0.11,
    // BACK: the replay's restart, [start, end] on each pass's clock (s): one smoothstep crossfade from the decided state to
    // the schedule (the glide), which settles 1.4 s before the next opening (the next pass starts at the loop's period).
    // The blades are not shown swinging closed: at the model's scale that alone could read as a reclosing.
    BACK: [7.5, 8.7]
  };
  // the switching mode: html[data-sw], pushloop by default
  function swMode() { var v = global.document ? global.document.documentElement.getAttribute('data-sw') : null; return /^(s3|isolate|push|pushloop)$/.test(v || '') ? v : 'pushloop'; }
  function switchStoryR6(mode) {
    var X = SWX[mode], T = SWX.T, lead = T.lead, pr = lead + T.pair, P = X.loop;
    var D = { key: 'switching', lead: lead, r6: { mode: mode, cam: X.cam, iso: X.iso, loop: P, pair: pr },
      keys: [[0, 'market', 0.5, []], [lead, 'switched', 0.6, ['L-AD']], [pr, 'aware', 0.6, ['L-AD']]],
      line: [[0, 'market'], [lead, 'switched'], [pr, 'aware']],
      brk: [[0, false, 0, false], [lead, true, 1, true]], rings: [[pr, 22]], sel: [lead - T.sel, lead], end: pr + 1.3 };
    // The story text for these modes, timed with a reading rule: a beat starts with or after the act it names, is fully
    // readable 0.38 s after its start (fade 140 + 240 ms) while its cue is still on screen, and stays at least 0.25 s a
    // word plus 0.4 s. h 0: D-I red (and its field past the rail); lead + 0.55: after the opening at lead (breaker light to
    // lead + 1.1, D-I cool by lead + 0.3, the sweep to lead + 1.15); pr + 0.25: the rings (they live pr to pr + 1.3);
    // pr + 3.15: the decided state, held. A replayed story (loop) runs its beats on h modulo the loop; its last beat comes
    // with the restart back to the schedule, and a replay opens on it (sayTick); held still, it shows the decided state's
    // beat (sayHold).
    var S3 = switchStory(lead).say;
    D.say = [[0, 'The schedule overloads one line.'], [lead + 0.55, 'The operator switches another line out.'], [pr + 0.25, S3[2][1]], [pr + 3.15, S3[3][1]]];
    if (P) {
      // D.back: the restart window [t0, t1] on each pass's clock (SWX.BACK): one crossfade from the decided state to the
      // schedule, the glide (the line field's points glide back, the flow light and the switched line's conductor fill
      // back, its dashes fade, the open blades fade out over the closed ones, no breaker light). ms: the line field's
      // morph, the whole window from its start. The next pass starts at P from the schedule, as the first; the replay beat
      // starts with the restart.
      var BKw = SWX.BACK;
      D.back = { mode: 'glide', t0: BKw[0], t1: BKw[1], ms: Math.round(1000 * (BKw[1] - BKw[0])) };
      D.say = D.say.slice(0, 3).concat([[BKw[0], 'Once more, from the schedule.']]); D.sayHold = 2;
    }
    return D;
  }
  var BAL_STORY = { key: 'balancing',
    // b1: the first beat starts at 0.6 s, when the overloaded schedule is on screen also after the hero's own switch (an
    // open spine closes first)
    say: [[0.6, 'One line overloads. A pool shows cheap room.'], [3.0, 'First remedy, redispatch alone: the cheap room is used up.'],
      [6.5, 'Next day, the wind falls short.'], [8.4, 'The shortfall drains the costly room at the gas-fired plant.'],
      [11.5, 'Rewind. Second remedy: switch a line out, redispatch less.'], [16.6, 'The same shortfall now drains the cheap room instead.'],
      [19.6, 'Keeping the cheap room makes the same shortfall cheaper.']],
    keys: [[0, 'market', 0.8, []], [3.0, 'blind', 0.7, []], [6.5, 'blind_miss', 1.5, [], 'wind'], [8.0, 'blind_miss', 2.0, [], 'rest'],
      [11.8, 'market', 0, []], [12.5, 'switched', 0.6, ['L-AD']], [13.3, 'aware', 0.6, ['L-AD']],
      [15.5, 'aware_miss', 1.0, ['L-AD'], 'wind'], [16.5, 'aware_miss', 2.0, ['L-AD'], 'rest']],
    line: [[0, 'market'], [3.0, 'blind'], [11.8, 'market'], [12.5, 'switched'], [13.3, 'aware']],
    brk: [[0, false, 0, false], [12.5, true, 1, false]], rings: [[3.0, 22], [13.3, 16]],
    pools: [[0, 500, 50, 0.8], [3.0, 0, 550, 0.7], [8.0, 0, 350, 2.0], [11.8, 500, 50, 0], [13.3, 300, 250, 0.7], [16.5, 100, 250, 2.0]],
    rim: [8.0, 10.0], tint: [[8.0, 10.0, 'gen'], [16.5, 18.5, 'bat']], dip: [11.5, 12.5], end: 19.0 };
  // The story text in the hovered or focused theme card (outside the figure; shown when html[data-story] is text or swap).
  // Each story carries say: [[h, text], ...] on its own clock h (s since the hover or focus): the beat in force is the last
  // one with h <= now; when the model is still (reduced motion, Pause) the last beat, which describes the hold state the
  // model then shows. The renewables hover (and the HVDC hover with html[data-hv] r8) changes no state (it only lights
  // its parts), so it has no story; its two beats run on the same clock from the hover. sayFor(th): the beats a hover on
  // th plays (the card reserves room for all).
  var HOVER_SAY = {
    renewables: { key: 'renewables', say: [[0, 'Over each farm, points of light show tomorrow\'s possible output.'],
      [3.5, 'Between no output and full output, the spread is rarely symmetric.']] },
    hvdc: { key: 'hvdc', say: [[0, 'Converter stations set how much each direct-current link carries.'],
      // beat 2: the hover lights both links, and the interconnector DC-2 keeps its agreed exchange, a fixed input that does
      // not move
      [3.5, 'Both links are lit; the interconnector keeps its agreed exchange.']] }
  };
  // The HVDC hover (html[data-hv] day, the default; r8 lights the parts only, with HOVER_SAY.hvdc and the hero held) plays
  // one periodic day of market hours on the two links: the 96 quarter-hour knots day0..day95 (u = j x q h), each a balanced
  // state with the network's DC power flow, N-1 secure with the spine in service; the page blends two consecutive knots
  // linearly, one weight for every injection, so every frame adds up. The hover's clock h (s since the hover or focus): the
  // day is entered at knot j0 (22:30) at h0 and loops; a quarter hour lasts base s, the two either side of each DC-2
  // reversal (slowU: :45 to :15 around 00:00, 06:00, 16:00 and 21:00) slow s, so each reversal is seen to slow, go out and
  // turn over 1.4 s; the period P is 27.6 s and at h0 + kP the state is knot j0 again, so the loop is seamless. entry: the
  // snapshot crossfade from the state shown to knot j0, started entry[0] s late and lasting entry[1] s; red: the overload
  // red (the beams' hot, D-I's glow) out over that many s from h 0; col: the HVDC color in from col[0] over col[1] s; trk:
  // the trackers from the hero's sweep to their held angle over trk[1] s from trk[0] (trkMode 'hold'); out: the color and
  // the trackers back after the hover; still: the knot held in reduced motion and Pause (09:30, DC-1 1450 MW ashore, DC-2
  // 700 MW export).
  // light: the HVDC light (Beams' hc). lam: the pulse's wavelength (CSS px, wide and compact); its speed v0 x min(1,
  // load / full) + vk x load (CSS px/s, load = |P| / rating), so the pulse slows to zero only as its light goes out at a
  // reversal; full: the load from which the pulse is at full strength (the body stays at full strength at any power); tauV,
  // tauA: the DC poles' easing (s) while the color is on, so the light reaches zero with the set-point.
  var DAYX = { n: 96, q: 0.25, j0: 90, h0: 0.75, still: 38, base: 0.25, slow: 0.70, slowU: [23.75, 0, 5.75, 6, 15.75, 16, 20.75, 21],
    entry: [0.25, 0.5], red: 0.25, col: [0.75, 0.6], trk: [0.75, 0.8], out: { col: 0.6, trk: 0.8 }, trkMode: 'hold',
    light: { lam: { wide: 80, compact: 48 }, v0: 18, vk: 40, full: 0.10, tauV: 0.08, tauA: 0.05, sub: 6, lv: 24, bodyK: { wide: 1, compact: 1.3 }, one: { wide: false, compact: true } } };
  // v0: the pulse's base speed, high enough for its direction to read at night-time powers on every pole; bodyK: the body's
  // width factor per layout (the edge and the pulse keep theirs), 1.3 on phones, where DC-2's two poles otherwise read as
  // two thin lines under 3:1 contrast; sub: the pulse sampled that many times per flow-light segment (BEAM.DS, 6 px, so 1 px
  // samples), so a short dash slides smoothly instead of stepping cell by cell; lv: the pulse's own number of levels, so
  // its tail fades smoothly from the head; one: a link carries one pulse (on its first pole) in that layout (on phones the
  // two poles lie 1 to 4 px apart and read as one band, which two pulses side by side would pale under 3:1)
  // HVC_RE: the converter sites the day keeps at full light (the sink's keep part 'hvc', and laneOcclusion's key hvc: the
  // stretches of a lane that only these hide)
  var HVC_RE = /^(converter-off|conv-a|conv-c|bushings-a|bushings-c|tr-A-bank|tr-C-bank)/;
  // the clock: dur[j], the seconds of the quarter hour from knot j to j + 1, and the period
  (function () { var d = [], P = 0; for (var j = 0; j < DAYX.n; j++) { var u = j * DAYX.q, s = DAYX.slowU.some(function (v) { return Math.abs(v - u) < 1e-9; }); d.push(s ? DAYX.slow : DAYX.base); P += d[j]; } DAYX.dur = d; DAYX.P = P; })();
  // the day at hover time h: knot j, the fraction f toward j + 1 and the day time u (h); before h0, knot j0 itself
  function dayAt(h) {
    if (!(h >= DAYX.h0)) return { j: DAYX.j0, f: 0, u: DAYX.j0 * DAYX.q };
    var x = (h - DAYX.h0) % DAYX.P, j = DAYX.j0, k = 0;
    while (x >= DAYX.dur[j] && k++ < DAYX.n) { x -= DAYX.dur[j]; j = (j + 1) % DAYX.n; }
    var f = clamp(x / DAYX.dur[j], 0, 1);
    return { j: j, f: f, u: ((j + f) * DAYX.q) % 24 };
  }
  // the trackers' angle at day time u (h): toward the sun, negative facing east (the world's +x), flat at 13:30, at most TRACK.amp,
  // and flat outside 07:30 to 19:30 (they turn in over 1.5 h after sunrise and stow over 1.5 h before sunset)
  function sunAngle(u) { return clamp((u - 13.5) * Math.PI / 12, -TRACK.amp, TRACK.amp) * smooth((u - 7.5) / 1.5) * smooth((19.5 - u) / 1.5); }
  // the story text for html[data-story] text and swap: at least 0.25 s a word plus 0.4 s, each beat with or after the act
  // it names; the say clock wraps with the day (storyH), so the beats come at the same day times in every loop; before h0
  // no beat
  var DAY_SAY = [[0.75, 'Only the two HVDC links stay lit, in a color of their own.'],
    [4.40, 'The interconnector keeps each hour\'s agreed exchange and reverses only between hours.'],
    [7.80, 'The offshore link always carries the wind farm\'s power ashore, rising and falling with the wind.'],
    [20.90, 'At some hour changes the interconnector\'s flow slows, stops and turns.']];
  function hvMode() { var v = global.document ? global.document.documentElement.getAttribute('data-hv') : null; return v === 'r8' ? 'r8' : 'day'; }
  // open0: the spine was open at the hover's start (it returns to service once, at h0, under the full sink: no breaker light, no blade
  // swing); line0: the line field's state shown then (the field goes out over the sink's rise and shows no other state)
  function dayStory(open0, line0) {
    var ln = line0 || 'market', o = open0 ? [ANIMATED[0]] : [];
    return { key: 'hvdc', open0: !!open0, r6: { mode: 'day', cam: 0, iso: 1, loop: 0, pair: null },
      day: { P: DAYX.P, h0: DAYX.h0, j0: DAYX.j0, still: DAYX.still, entry: DAYX.entry, red: DAYX.red, col: DAYX.col, trk: DAYX.trk },
      keys: [[0, 'day' + DAYX.j0, 0.01, o]],   // a fallback only: frameView evaluates dayAt() in mode 'day'
      line: [[0, ln]], brk: open0 ? [[-10, true, 0, false, true], [DAYX.h0, false, 0, false, true]] : [[0, false, 0, false, true]],   // -10: the open spine's blades stay open (a key at 0 would put them at 0 and swing them)
      rings: [], holdSrc: 1, hold: { state: 'day' + DAYX.still, open: [], line: ln }, say: DAY_SAY, sayHold: 0, end: DAYX.P };
  }
  // the definition a hover on th plays (the switching mode of html[data-sw], the balancing story of data-bal, the HVDC
  // hover of data-hv)
  function storyFor(th) { return th === 'switching' ? (swMode() === 's3' ? switchStory(1.2) : switchStoryR6(swMode())) : th === 'balancing' ? balStory() : th === 'hvdc' && hvMode() === 'day' ? dayStory() : HOVER_SAY[th]; }
  function sayFor(th) { var D = storyFor(th); return D && D.say ? D.say : []; }
  // the story clock of a definition: a replayed story runs on h modulo its loop; the day's on h0 + (h - h0) mod P
  function storyH(D, h) { if (D && D.day) return h < D.day.h0 + D.day.P ? h : D.day.h0 + (h - D.day.h0) % D.day.P; var P = D && D.r6 && D.r6.loop; return P && h >= P ? h % P : h; }
  function sayAt(say, h, still) { var i = -1; if (!say || !say.length) return i; if (still) return say.length - 1; for (var j = 0; j < say.length; j++) if (say[j][0] <= h) i = j; return i; }
  // the lanes that carry the wind's output (they dim first when the wind falls short)
  var WIND_LANE = /^(array-|ac-export-|dc1-|mv-wind-|mv-link-T-F|L-BF$)/;
  function smooth(x) { x = x !== x ? 1 : clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  // the keys of one lane group at time tt: the state shown before the last key (a, oa), the last key's (b, ob), and how
  // far the change has gone (k; kc for a line switched out or back in). period: cyclic (the hero); none: a story
  function evalKeys(keys, tt, group, period) {
    var list = [], i = -1, j;
    for (j = 0; j < keys.length; j++) if (!keys[j][4] || keys[j][4] === group) list.push(keys[j]);
    for (j = 0; j < list.length; j++) if (list[j][0] <= tt) i = j;
    if (i < 0) i = period ? list.length - 1 : 0;
    var cur = list[i], prev = period ? list[(i - 1 + list.length) % list.length] : list[Math.max(0, i - 1)], dt = tt - cur[0];
    if (dt < 0) dt += period || 0;
    return { a: prev[1], oa: prev[3], b: cur[1], ob: cur[3], k: smooth(dt / Math.max(1e-3, cur[2])), kc: smooth(dt / Math.max(1e-3, Math.min(cur[2], HERO.cut))) };
  }
  function stepAt(list, tt, period) {   // the entry of a step list [[t, ...], ...] in force at tt (cyclic with a period)
    var r = period ? list[list.length - 1] : list[0];
    for (var j = 0; j < list.length; j++) if (list[j][0] <= tt) r = list[j];
    return r;
  }
  function heroT(t) { return ((t % HERO.period) + HERO.period) % HERO.period; }
  function breakerOpen(br, t) {
    var tt = heroT(t), r = false;
    SCHED.events.forEach(function (e) { if (e.br === br && tt >= e.open && tt < e.close + SCHED.breakerLag) r = true; });
    return r;
  }
  function bladeOpenness(br, t) {
    var tt = heroT(t), v = 0;
    SCHED.events.forEach(function (e) {
      if (e.br !== br) return;
      var a = e.open + SCHED.bladeLag, sw = SCHED.swing;
      if (tt >= a && tt < a + sw) v = (tt - a) / sw;
      else if (tt >= a + sw && tt < e.close) v = 1;
      else if (tt >= e.close && tt < e.close + sw) v = 1 - (tt - e.close) / sw;
    });
    return v;
  }
  // the hero at time t: the flows' keys, the line field, the spine's breakers and blades
  function heroAt(t) {
    var tt = heroT(t), w = evalKeys(HERO.keys, tt, 'wind', HERO.period);
    return { tt: tt, wind: w, rest: w, line: stepAt(HERO.line, tt, HERO.period)[1], brk: breakerOpen('L-AD', t), blade: bladeOpenness('L-AD', t) };
  }
  function storyP(state) { var N = global.StudioNet, s = N && N.stories && N.stories.states[state]; return s ? s.p : null; }

  // ── The balancing stories, picked by html[data-bal] (b7 by default; b1 is BAL_STORY above). The same story states
  // (StudioNet.stories: market, switched, blind, blind_miss, aware, aware_miss), the same clock h and the same fields as b1
  // (keys, line, brk, rings, pools, rim, tint), plus:
  //   hot: [[h0, h1], ...]  a red-orange halo pulses along D-I in these windows, only while D-I's shown loading is over its
  //                         rating (red-orange means over a limit and nothing else)
  //   pair: [[h, MW], ...]  the operator's redispatch pair: an up arrow at the battery park and a down arrow at the gas
  //                         plant, drawn at the same moment and equally long (total generation unchanged; length by MW),
  //                         crisp, in the operator's ink, with the rings of the same act
  //   cf: [h0, h1, MW]      b4 only: the counterfactual pair, dashed (the remedy not taken: no ring, no change of flows)
  //   merit: the zone's upward balancing merit order as a chart shape, no words, cheapest offers first: the room each
  //     cost group offers, cheap first (the battery park, teal) and then dear (the gas plant, magenta), each flat and then
  //     steep near its end. Across: upward balancing energy; the zone's total upward room is 550 MW in every story state
  //     (a redispatch pair moves room between the groups), so the width is fixed. Up: the price. room: [[h, state, ease]]
  //     (StudioNet.stories.room); fill: [[h, MW, ease]] the activated energy, cheapest first (the story's miss is 200 MW
  //     short in both decisions); ghost: [[h, state, MW, ease]] a dashed outline of that fill under another decision's
  //     room (b4: the counterfactual, b5: act 1's record).
  //   say: the optional story text for the theme card, [h, words]
  function balStory() { var v = global.document ? global.document.documentElement.getAttribute('data-bal') : null; return v === 'b1' ? BAL_STORY : BAL_VARIANTS[v] || BAL_VARIANTS.b7; }   // b7 by default
  var BAL_VARIANTS = {
    // b4, the pair and the price: one decision forward, then its counterfactual on the chart. sink: the rest of the model
    // sinks; cam: a camera push; timed so that each beat of its story text is readable (0.25 s a word + 0.4 s) while its
    // cue shows: the switch at 2.5 (D-I cools there), the pair 1.9 s later (the switched-only state is a short step inside
    // one decision), the shortfall at 7.1, its cheap cover 8.1-10.1, the counterfactual from 11.7, its dashed outline
    // rising 12.1-13.3. instant: the hover's first frame takes the schedule at once, as the switching push-in does (the
    // spine back in service in that frame, no breaker light; the line field on the market hour), so the overload is on
    // screen with its first beat.
    b4: { key: 'balancing', variant: 'b4', sink: 1, cam: 1, instant: 1,
      keys: [[0, 'market', 0.8, []], [2.5, 'switched', 0.6, ['L-AD']], [4.4, 'aware', 0.6, ['L-AD']],
        [7.1, 'aware_miss', 1.0, ['L-AD'], 'wind'], [8.1, 'aware_miss', 2.0, ['L-AD'], 'rest']],
      line: [[0, 'market'], [2.5, 'switched'], [4.4, 'aware']],
      brk: [[0, false, 0, false], [2.5, true, 1, false]], rings: [[4.4, 22]],
      pools: [[0, 500, 50, 0.8], [4.4, 300, 250, 0.7], [8.1, 100, 250, 2.0]], rim: [-9, -9], tint: [[8.1, 10.1, 'bat']],
      hot: [[0, 2.5]], pair: [[4.4, 200]], cf: [11.7, 14.7, 500],
      merit: { room: [[0, 'market', 0.01], [4.4, 'aware', 0.7]], fill: [[0, 0, 0.01], [8.1, 200, 2.0]], ghost: [[12.1, 'blind', 200, 1.2]] },
      // the story text: each beat held at least 0.25 s a word + 0.4 s and readable 0.38 s after its start while its cue
      // shows
      say: [[0, 'The schedule overloads one line.'], [2.5, 'The operator switches a line out.'],
        [4.4, 'One unit up, one down: less cheap room left.'], [7.1, 'Next day, the wind falls short.'],
        [9.0, 'Cheap balancing energy covers it, at a low price.'], [11.7, 'Redispatch alone would have used up that cheap room.'],
        [14.4, 'The same shortfall would then settle higher.']],
      end: 15.1 },
    // b5, two remedies, one record (b1 on a chart): act 1, its fill kept as a dashed record, back to the market state
    // without a dissolve, act 2 under the record
    b5: { key: 'balancing', variant: 'b5', instant: 1,   // the schedule at once, as b4
      keys: [[0, 'market', 0.8, []], [3.0, 'blind', 0.7, []], [6.5, 'blind_miss', 1.5, [], 'wind'], [8.0, 'blind_miss', 2.0, [], 'rest'],
        [11.4, 'market', 0.9, []], [13.0, 'switched', 0.6, ['L-AD']], [13.8, 'aware', 0.6, ['L-AD']],
        [16.0, 'aware_miss', 1.0, ['L-AD'], 'wind'], [17.0, 'aware_miss', 2.0, ['L-AD'], 'rest']],
      line: [[0, 'market'], [3.0, 'blind'], [11.4, 'market'], [13.0, 'switched'], [13.8, 'aware']],
      brk: [[0, false, 0, false], [13.0, true, 1, false]], rings: [[3.0, 22], [13.8, 16]],
      pools: [[0, 500, 50, 0.8], [3.0, 0, 550, 0.7], [8.0, 0, 350, 2.0], [11.4, 500, 50, 0.9], [13.8, 300, 250, 0.7], [17.0, 100, 250, 2.0]],
      rim: [8.0, 10.0], tint: [[8.0, 10.0, 'gen'], [17.0, 19.0, 'bat']],
      hot: [[0, 3.0], [11.4, 13.0]], pair: [[3.0, 500], [13.8, 200]],
      merit: { room: [[0, 'market', 0.01], [3.0, 'blind', 0.7], [11.4, 'market', 0.9], [13.8, 'aware', 0.7]],
        fill: [[0, 0, 0.01], [8.0, 200, 2.0], [10.8, 0, 0.6], [17.0, 200, 2.0]], ghost: [[10.8, 'blind', 200, 0.6]] },
      // the story text, timed with the reading rule: the first remedy's beat names its result (the line cools, the cheap
      // room goes) in one line, so each beat can stay long enough
      say: [[0, 'The schedule overloads one line.'], [3.0, 'Redispatch alone cools it but uses up the cheap room.'],
        [6.5, 'Next day, the wind falls short.'], [8.4, 'Balancing energy then comes from the costly gas-fired plant.'],
        [11.4, 'The same afternoon, a coordinated decision.'], [13.3, 'A line is switched out, with less redispatch.'],
        [16.0, 'The same shortfall next day.'], [17.7, 'Cheap balancing energy covers it, at a lower price.']],
      end: 19.6 },
    // b6, redispatch alone, chosen with balancing in mind: with the topology fixed, the decision buys part of the up move
    // from a dearer unit (the gas-engine plant, drawn only in this story) and so keeps the battery park's cheap room for
    // the shortfall. States b6_aware, b6_aware_miss and the counterfactual b6_blind (StudioNet.stories). As b4: the rest
    // sinks, a camera push, the chart; plus:
    //   pair6: [[h, [[unit, MW], ...]]]  the operator's redispatch as arrows proportional to MW (PAIR6.k): up at the
    //          gas-engine plant and, smaller, at the battery park; down at the gas plant, as long as the two together
    //   cf6: [h0, h1, [[unit, MW], ...]] the counterfactual (the cheapest redispatch alone), dashed, no ring
    //   merit.total: the chart's span (the zone's upward room in b6_aware: 300 cheap + 550 dear); merit.cols: two columns
    //          on the chart's floor, the decision's (solid) and the counterfactual's (dashed): redispatch in the operator's
    //          ink at the foot, the balancing energy of the shortfall above it in its group's color, on one scale, so the
    //          totals compare on one baseline (the aware decision pays more for redispatch, less for balancing, less in all)
    //   hold: the state reduced motion and Pause show (the spine stays in service)
    b6: { key: 'balancing', variant: 'b6', sink: 1, cam: 1, instant: 1, eng: 1,
      keys: [[0, 'market', 0.8, []], [2.4, 'b6_aware', 0.6, []],
        [7.5, 'b6_aware_miss', 1.0, [], 'wind'], [8.5, 'b6_aware_miss', 2.0, [], 'rest']],
      line: [[0, 'market'], [2.4, 'b6_aware']],
      brk: [[0, false, 0, false]], rings: [[2.4, 22, ['bat', 'gen', 'eng']]],
      pools: [[0, 500, 50, 0.8], [2.4, 300, 550, 0.7], [8.5, 100, 550, 2.0]], rim: [-9, -9], tint: [[8.5, 10.5, 'bat']],
      hot: [[0, 2.4]], pair6: [[2.4, [['eng', 300], ['bat', 200], ['gen', -500]]]], cf6: [12.1, 15.1, [['bat', 500], ['gen', -500]]],
      merit: { total: 850, room: [[0, 'market', 0.01], [2.4, 'b6_aware', 0.7]], fill: [[0, 0, 0.01], [8.5, 200, 2.0]],
        ghost: [[12.5, 'b6_blind', 200, 1.2]], cols: { dec: [2.4, 0.5], cf: [12.1, 0.5] } },
      // the story text: each beat held at least 0.25 s a word + 0.4 s and readable 0.38 s after its start while its cue
      // shows. Beat 3 refers to the gas-engine plant's redispatch, not the dear balancing group; in b6 both decisions are
      // redispatch alone (the topology fixed), so beat 6 calls the counterfactual the cheapest redispatch (b6_blind)
      say: [[0, 'The schedule overloads one line.'], [2.4, 'Two units up, one down: the line cools.'],
        [4.8, 'Using a dearer unit keeps cheap room for later.'], [7.5, 'Next day, the wind falls short.'],
        [9.4, 'Cheap balancing energy covers it, at a low price.'], [12.1, 'The cheapest redispatch would cost less but use that room.'],
        [15.0, 'The same shortfall would settle higher, the total too.']],
      hold: { state: 'b6_aware_miss', open: [], line: 'b6_aware', pools: [100, 550] },
      end: 15.7 },
    // b7, switching, three units, bids and the clearing price: the operator switches the spine out (as b4) and moves three
    // units in one decision, the battery park and the biomass power station up and the gas plant down by as much (b7_aware
    // in StudioNet.stories; the station is drawn only in this story). A chart of discrete bids shows each unit's offers
    // change with its own move; after the shortfall the battery park's cheap bids are activated cheapest first and the
    // whole volume settles at the price of the last bid used (one rectangle, its top carried past the price wall); dashed,
    // the cheapest redispatch (b7_blind) and its shortfall settling higher; two columns compare redispatch + settlement.
    // Each unit's bids take its own color (FLAT bidBat, bidBio, bidGas); only activated and settled energy is filled; no
    // payer is shown.
    // The chart stands on the left (CHART7.side), over the sunk west of the plinth; the decision's activated energy,
    // settlement, price mark and column are green, the cheapest redispatch's extra cost (the band between the two clearing
    // prices and its column's excess over the decision's) a light red hatch that comes only with the counterfactual; each
    // unit's bids in its own color (FLAT decFill ... bidGas)
    //   cam 'wall': b7's own framing (wallFit), kept under reduced motion (a cut) and on Pause; bm: the station kept lit
    //   under the sink; pairK: the arrows' view units per MW at 1440 (0.6, so 50 MW is 30 long); ladder: the chart's beats
    //   (ladderAt); the station's arrow stands on the plinth's front face right of the cooling tower (poolGeom bio), its
    //   tip level with the tower's top and under D-I (above the tower it would cut D-I during the relief beat)
    // The three moves come 1.1 s apart, so each arrow links to its chart change: each arrow drawn while its own unit's bids
    // change and its ring pulses, the other bids stepping back for that moment (ladder.focus); the three arrows held
    // together and gone together (pairEnd: one decision); the flows and the line field cross over the whole decision
    // (3.0 s, lineMs); the source panels hold still for the story (holdSrc), so the solar panel's day wave is not taken for
    // the shortfall's cause; the wind's lanes step back as the wind falls short (windDim); the cover follows the miss at
    // once; the counterfactual's dashed arrows come with its dashed ladder and lighter (cfA), so they do not read as a
    // second act. They are gone by 12.8 and the red (hatch, the dashed column cols.cf) starts at 12.9, so the red never
    // grows while any arrow is on screen.
    b7: { key: 'balancing', variant: 'b7', sink: 1, cam: 'wall', instant: 1, bm: 1, pairK: 0.6, holdSrc: 1,
      keys: [[0, 'market', 0.8, []], [0.2, 'switched', 0.6, ['L-AD']], [1.2, 'b7_aware', 3.0, ['L-AD']],
        [6.0, 'b7_aware_miss', 1.6, ['L-AD'], 'wind'], [6.3, 'b7_aware_miss', 1.6, ['L-AD'], 'rest']],
      line: [[0, 'market'], [0.2, 'switched'], [1.2, 'b7_aware', 2800]],
      brk: [[0, false, 0, false], [0.2, true, 1, false]], hot: [[0, 0.2]],
      rings: [[1.0, 22, ['bat', 'bio', 'gen']]],
      pair6: [[1.2, [['bat', 50]]], [2.3, [['bio', 100]]], [3.4, [['gen', -150]]]], pairEnd: 5.8,   // one decision, three arrows 1.1 s apart
      cf6: [10.0, 12.2, [['bat', 170], ['gen', -170]]], cfA: 0.75,                                // dashed, no ring, no change of flows; gone by 12.8
      tint: [[6.3, 7.9, 'bat']], windDim: [6.0, 1.6, 0.33],
      ladder: { show: [0.3, 0.6],
        steps: [[1.5, 'battery'], [2.6, 'biomass'], [3.7, 'thermal']], ease: 0.5, pulse: 0.9, focus: [0.15, 1.0, 0.45], ring: 0.8,
        fill: [6.3, 200, 1.6], flat: [8.2, 0.7], price: [8.8, 0.4], dim: [9.6, 0.22, 0.4],
        cf: [10.0, 'b7_blind', 0.8], cfFill: [10.8, 200, 1.2], cfFlat: [12.1, 0.6], hatch: [12.9, 0.6], cfPrice: [12.5, 0.4],
        cols: { rd: [[1.5, 'battery', 0.4], [2.6, 'biomass', 0.4]], set: [8.2, 0.7], cf: [12.9, 0.6] } },
      hold: { state: 'b7_aware_miss', open: ['L-AD'], line: 'b7_aware' },
      // the story text: each beat held at least 0.25 s a word + 0.4 s and readable 0.38 s after its start while its cue
      // shows; beat 5 says "most of those offers" (the blind decision leaves 80 of 250 MW)
      say: [[0.2, 'The operator switches a line out and shifts three units.'],
        [3.1, 'Each unit\'s move changes its own offers.'], [5.8, 'Next day, the wind falls short.'],
        [7.7, 'Cheap offers cover it, at a low price.'], [10.1, 'The cheapest redispatch would have used most of those offers.'],
        [13.0, 'The same shortfall would settle higher, the total too.']],
      end: 14.0 }
  };
  // The bid chart's geometry in base units (b7): the slot (stage px = base units x the stage's scale; its floor 30 above
  // the visible band's bottom), the plot inside it (price wall at x 10, floor at y 176 from x 10 to 286, top at y 6; 0 to
  // 650 MW over 270 units; price 0 to 5.0 over 170 units), the two cost columns and the strokes (str). The fallback anchors
  // (no b7 camera: phones, a short window, a fit under zField) stand on the plinth as b4's chart (MERIT.wide.at), 274 x 145
  // view units wide, 132 x 70 on phones; the inner layout scales uniformly by the slot's width / 352. On the wall the slot
  // grows upward into the free wall as far as the visible band allows (hmax 250 base units, 24 under the band's top; the
  // price axis stretches with it, the width and the x scale stay).
  // side 'left' puts the slot on the left of the stage (edge 28 from the stage's left), over the sunk west of the plinth
  // and above the balancing card; the framing mirrors (wallFit): the units, their arrows, D-I, the spine and the line field
  // fill the stage right of the slot, with the gap 16 to the slot and 16 (left) to the stage's right edge. side 'right'
  // puts it on the wall right of the plinth (28 from the stage's right, 16 clear of the plinth on its left). align puts the
  // slot's left edge on the hovered card's left edge (the content column) when that costs under 3 % of the zoom, else edge
  // 28; topFit takes the offshore turbines' tops into the framed box while its zoom stays at topMin or more (zField, under
  // which there is no camera at all), so the whole model stays in view; the phones' fallback anchor stands on the plinth's
  // front, over substations D and J and the factory's feeders, off the switched spine L-AD and every unit and arrow.
  var CHART7 = { w: 352, h: 186, hmax: 250, top: 24, right: 28, gap: 16, left: 16, below: 30, pad: 22, side: 'left', edge: 28, align: true, topFit: true, topMin: 0.8,
    plot: { x0: 10, x1: 286, yb: 176, yt: 6, mw: 650, kx: 270 / 650, ky: 34, pmax: 5.0, foot: 10 }, cols: { x: [295, 324], w: 23, h: 0.86 },
    // casing: CSS px of the chart's ground on each side of a bid's top (drawLadder)
    str: { floor: 1.6, wall: 1.2, top: 2.8, side: 1.2, sideA: 0.42, riser: 1.2, end: 1.4, cfTop: 2.6, cfRiser: 1.8, dash: [7, 4], price: 3.0, cfPrice: 2.8, dot: 3.6, wLw: 1.2, wGap: 8, wFill: 0, casing: 1 },
    fall: { wide: { at: [198, 50], w: 274 }, compact: { at: [250, -40], w: 132 } }, zField: 0.8, zFull: 1.06, zmax: 1.9 };
  // the plot for a slot h base units tall: the floor 10 above its bottom, the top at 6, price 0 to 5.0 over the height between
  function chartPlot(h) {
    var P = CHART7.plot, yb = h - P.foot;
    return { x0: P.x0, x1: P.x1, yb: yb, yt: P.yt, mw: P.mw, kx: P.kx, ky: (yb - P.yt) / P.pmax, h: h };
  }
  // b7's strokes (CHART7.str) with the two rules for a bid shown at less than full alpha: its top thinner by up to thin
  // (2.8 to 1.7 base units) and its sides, risers and the end wall at most sideThin fainter; its color never fades
  // (drawLadder)
  var LADK = (function () { var o = {}, k; for (k in CHART7.str) o[k] = CHART7.str[k]; o.thin = 0.4; o.sideThin = 0.3; return o; })();
  var B7U = { battery: 'bat', biomass: 'bio', thermal: 'gen' };
  // the chart at story time h (b7 only; StudioNet.stories.b7): every bid of every unit in price order with its width (MW),
  // position and alpha; the activated energy, the settlement rectangle and the price mark; the counterfactual's dashed
  // ladder, outline, hatch and price mark; the two columns (illustrative price units; never shown)
  function ladderAt(D, h) {
    var L = D.ladder, B = global.StudioNet && global.StudioNet.stories && global.StudioNet.stories.b7;
    if (!L || !B) return null;
    var sm = function (t0, dur) { return h <= t0 ? 0 : smooth((h - t0) / Math.max(1e-3, dur)); };
    var stepT = {}; L.steps.forEach(function (q) { stepT[q[1]] = q[0]; });
    var bm = B.ladders.market, ba = B.ladders.b7_aware, x = 0, V = L.fill[1] * sm(L.fill[0], L.fill[2]), Vend = L.fill[1];
    var kd = sm(L.dim[0], L.dim[2]), bids = [];
    // while a unit's own bids change (from its moment for focus[1] s, in over focus[0], out over focus[2]) the other units'
    // bids step back to 0.4 of their alpha, so the change reads as that unit's
    var win = function (a, b, up, dn) { return h < a || h > b + dn ? 0 : h < a + up ? smooth((h - a) / up) : h <= b ? 1 : 1 - smooth((h - b) / dn); };
    var foc = {}; L.steps.forEach(function (q) { foc[q[1]] = L.focus ? win(q[0], q[0] + L.focus[1], L.focus[0], L.focus[2]) : 0; });
    ba.forEach(function (q, i) {
      var u = q[0], T = stepT[u], k = sm(T, L.ease), w = lerp(bm[i][2], q[2], k), ch = Math.abs(bm[i][2] - q[2]) > 1e-6;
      var pu = ch && h >= T && h < T + L.pulse ? (h - T < 0.1 ? (h - T) / 0.1 : 1 - smooth((h - T - 0.1) / (L.pulse - 0.1))) : 0;
      var used = x + w <= Vend + 0.5, fo = 0;
      Object.keys(foc).forEach(function (v) { if (v !== u) fo = Math.max(fo, foc[v]); });
      bids.push({ u: u, j: q[1], p: q[3], w: w, x0: x, x1: x + w, pulse: pu, a: (used ? 1 : lerp(1, L.dim[1], kd)) * (1 - 0.6 * fo) });
      x += w;
    });
    var out = { a: sm(L.show[0], L.show[1]), bids: bids, end: x, V: V, flat: sm(L.flat[0], L.flat[1]), price: sm(L.price[0], L.price[1]),
      mip: B.miss.aware.mip, steps: stepT, cf: null, cols: null };
    var kc = sm(L.cf[0], L.cf[2]);
    if (h >= L.cf[0]) {
      var bb = B.ladders[L.cf[1]], xc = 0, cb = [];
      bb.forEach(function (q) { cb.push({ u: q[0], j: q[1], p: q[3], w: q[2], x0: xc, x1: xc + q[2] }); xc += q[2]; });
      out.cf = { k: kc, bids: cb, end: xc, V: L.cfFill[1] * sm(L.cfFill[0], L.cfFill[2]), flat: sm(L.cfFlat[0], L.cfFlat[1]),
        hatch: sm(L.hatch[0], L.hatch[1]), price: sm(L.cfPrice[0], L.cfPrice[1]), mip: B.miss.blind.mip };
    }
    // the columns: the decision's redispatch grows with each up move's own moment (MW x its redispatch price), its settlement
    // with the rectangle; the counterfactual's column (redispatch and settlement) at once, dashed
    var pr = B.prices.redispatch, pa = B.pairs.aware, rdA = 0;
    L.cols.rd.forEach(function (q) { var u = q[1]; rdA += (pa[u] || 0) * (pr[u + '_up'] || 0) * sm(q[0], q[2]); });
    var kcf = sm(L.cols.cf[0], L.cols.cf[1]), kset = sm(L.cols.set[0], L.cols.set[1]);
    out.focus = foc;
    // the redispatch foot stays light (an outline, a faint fill) until its settlement block grows on it
    out.cols = { max: B.cols.max, dec: { rd: rdA, set: B.miss.aware.settlement * kset, k: kset },
      cf: kcf > 0 ? { rd: B.miss.blind.redispatch * kcf, set: B.miss.blind.settlement * kcf, k: kcf } : null };
    return out;
  }
  // b6: the redispatch arrows are proportional to MW (k view units per MW at 1440), so the gas plant's down arrow is as
  // long as the two up arrows together (300 MW: 90, 200 MW: 60, 500 MW: 150, as long as b4's dashed 500 MW arrow)
  var PAIR6 = { k: 0.3, dx: { bat: -16, gen: 0, eng: 0 } };
  // the merit-order chart: its foot on the plinth (world x, z), its size in view units, the zone's total upward room and
  // the illustrative price shape per group (price = a + b u + c u^8 over the group's own room, u 0..1: flat, then steep
  // near the end; the dear group starts above the cheap group's end, so the stack rises monotonically). wide: 274 x 200
  // view units at 1440, tall enough that the low cheap fill and the high dashed outline stand clearly apart, its right edge
  // clear of the gas plant's stacks; compact: 124 x 76
  var MERIT = { wide: { at: [198, 50], w: 274, h: 200 }, compact: { at: [196, 30], w: 124, h: 76 }, total: 550,
    cheap: [1, 0.2, 0.8], dear: [2.6, 0.5, 2.4], pmax: 5.8,
    // cols (b6): the cost columns' zone at the chart's right end (view units at 1440), their width, gap and the tallest
    // column's share of the chart's height
    cols: { zone: 66, w: 21, gap: 9, h: 0.86 } };
  function meritGroup(g, u) { u = clamp(u, 0, 1); return g[0] + g[1] * u + g[2] * Math.pow(u, 8); }
  function meritPrice(mw, Rb, Rt) { return mw <= Rb && Rb > 0 ? meritGroup(MERIT.cheap, mw / Rb) : meritGroup(MERIT.dear, Rt > 0 ? (mw - Rb) / Rt : 1); }
  // the chart at story time h: the room per group (eased between decisions), the activated energy and the ghosts
  function meritAt(D, h, ROOM) {
    var G = D.merit;
    if (!G) return null;
    var at = function (list, val) {
      var i = 0; list.forEach(function (q, j) { if (q[0] <= h) i = j; });
      var cur = list[i], prev = list[Math.max(0, i - 1)];
      return [val(prev), val(cur), smooth((h - cur[0]) / Math.max(1e-3, cur[cur.length - 1]))];
    };
    var rm = function (s) { var r = ROOM[s] || {}; return [r.battery_up || 0, r.thermal_up || 0]; };
    var r = at(G.room, function (q) { return rm(q[1]); }), f = at(G.fill, function (q) { return q[1]; });
    var out = { Rb: lerp(r[0][0], r[1][0], r[2]), Rt: lerp(r[0][1], r[1][1], r[2]), V: lerp(f[0], f[1], f[2]), ghosts: [], a: 1 };
    (G.ghost || []).forEach(function (q) { if (h >= q[0]) { var g = rm(q[1]); out.ghosts.push({ Rb: g[0], Rt: g[1], V: q[2], k: smooth((h - q[0]) / Math.max(1e-3, q[3])) }); } });
    if (G.total) out.total = G.total;   // b6: the chart's own span
    if (G.cols) out.cols = meritCols(G.cols, h, out, G.ghost && G.ghost[0] ? G.ghost[0][2] : 200);
    return out;
  }
  // b6: the two cost columns at time h, in illustrative price units (StudioNet.stories.b6; never shown as numbers):
  // redispatch = the pair's MW at the redispatch prices; balancing = the area under the shown merit curve of the energy
  // activated so far, cheapest first (the decision's fill; the counterfactual's outline, as it rises). max: the
  // counterfactual's full total, the columns' common scale.
  function meritArea(Rb, Rt, V) {
    var gi = function (g, U) { return g[0] * U + g[1] * U * U / 2 + g[2] * Math.pow(U, 9) / 9; }, a = Math.min(V, Rb), b = Math.max(0, V - Rb);
    return (a > 0 && Rb > 0 ? Rb * gi(MERIT.cheap, a / Rb) : 0) + (b > 0 && Rt > 0 ? Rt * gi(MERIT.dear, Math.min(1, b / Rt)) : 0);
  }
  function meritRd(k) {
    var B = global.StudioNet && global.StudioNet.stories && global.StudioNet.stories.b6;
    if (!B) return 0;
    var p = B.prices.redispatch, d = B.pairs[k];
    return (d.battery || 0) * p.battery_up + (d.engines || 0) * p.engines_up - (d.thermal || 0) * p.thermal_down;
  }
  function meritCols(C, h, m, mw) {
    var g = m.ghosts[0], rdA = meritRd('aware'), rdB = meritRd('blind'), kd = h >= C.dec[0] ? smooth((h - C.dec[0]) / C.dec[1]) : 0;
    var kc = h >= C.cf[0] ? smooth((h - C.cf[0]) / C.cf[1]) : 0, ROOM = (global.StudioNet && global.StudioNet.stories && global.StudioNet.stories.room) || {}, rb = ROOM.b6_blind || {};
    var max = rdB + meritArea(rb.battery_up || 0, rb.thermal_up || 0, mw);
    return { max: max, dec: { rd: rdA * kd, bal: meritArea(m.Rb, m.Rt, m.V), grp: m.V > m.Rb + 0.5 ? 'dear' : 'cheap', k: kd },
      cf: kc > 0 ? { rd: rdB * kc, bal: g ? meritArea(g.Rb, g.Rt, g.V) * g.k : 0, grp: g && g.V > g.Rb ? 'dear' : 'cheap', k: kc } : null };
  }
  // the redispatch arrows: length (view units at 1440) = base + k x MW, 60 + 0.18 x MW (200 MW: 96; the 500 MW
  // counterfactual 150, kept under the solar field); drawn on in 0.35 s, held, faded over its last 0.6 s; shaft 7.5 wide
  // (dashed 4.5), head 30 wide and 20 long; the battery park's arrow 16 units left of its unit point, clear of the solar
  // field's corner; it lives 3.1 s so its beat is read while it shows (and it is gone before b5's second cover starts,
  // 13.8 + 3.1 < 17.0)
  var PAIR = { life: 3.1, draw: 0.35, fade: 0.6, base: 60, k: 0.18, gap: 28, w: 7.5, wd: 4.5, hw: 15, hl: 20, dx: { bat: -16, gen: 0 } };
  // b7's heads 24 wide and 16 long, so the station's arrow, standing between its cooling tower and T-BM, keeps its head
  // clear of the tower's rim and its tip under D-I
  var PAIR7 = { hw: 12, hl: 16 };
  // The battery's charge meters: the rate follows the set-point's MW, rising while it charges, falling while it discharges,
  // piecewise linear over the hero loop and normalized so that the level closes on itself. All containers follow the park's
  // set-point together, so after a reversal none charges while another discharges; they differ only by a fixed offset of
  // their level (cell: the spread).
  var BAT = { lo: 0.22, hi: 0.86, cell: 0.12, rate: 0.03, still: 0.58 };
  var batSegs = null;
  function batteryLevel(t, i) {
    var P = HERO.period, tt = ((t % P) + P) % P, off = BAT.cell * ((((i || 0) * 5) % 8) / 7 - 0.5);
    if (!batSegs) {
      var K = HERO.keys; batSegs = [];
      // each key's set-point eases in as the flows do (8 steps over the key's ease), so the meters turn with the shown
      // set-point rather than at the key's start
      var push = function (t0, t1, mw) {
        if (t1 <= t0) return;
        if (t0 >= P) { t0 -= P; t1 -= P; }
        if (t1 > P) { batSegs.push({ t0: t0, t1: P, mw: mw }); batSegs.push({ t0: 0, t1: t1 - P, mw: mw }); } else batSegs.push({ t0: t0, t1: t1, mw: mw });
      };
      K.forEach(function (k, j) {
        var t0 = k[0], t1 = j + 1 < K.length ? K[j + 1][0] : K[0][0] + P, mw = (storyP(k[1]) || {}).battery || 0;
        var m0 = (storyP(K[(j - 1 + K.length) % K.length][1]) || {}).battery || 0, e = Math.min(k[2], t1 - t0);
        for (var q = 0; q < 8; q++) push(t0 + e * q / 8, t0 + e * (q + 1) / 8, lerp(m0, mw, smooth((q + 0.5) / 8)));
        push(t0 + e, t1, mw);
      });
      batSegs.sort(function (a, b) { return a.t0 - b.t0; });
    }
    var up = 0, dn = 0;
    batSegs.forEach(function (q) { if (q.mw < 0) up -= q.mw * (q.t1 - q.t0); else dn += q.mw * (q.t1 - q.t0); });
    if (!up || !dn) return (BAT.lo + BAT.hi) / 2;
    var span = BAT.hi - BAT.lo, L = 0, Lmin = 0, at = 0;
    batSegs.forEach(function (q) {
      var r = q.mw < 0 ? -q.mw * span / up : -q.mw * span / dn;
      if (tt >= q.t0 && tt < q.t1) at = L + r * (tt - q.t0);
      L += r * (q.t1 - q.t0); Lmin = Math.min(Lmin, L);
    });
    return clamp(BAT.lo + at - Lmin + off, 0.12, 0.92);
  }
  // The module grid on a tracker segment: three lines across, one along (3D endpoints).
  function pvGrid(P) {
    var gl = [];
    [0.25, 0.5, 0.75].forEach(function (u) { gl.push([mix3(P[0], P[3], u), mix3(P[1], P[2], u)]); });
    gl.push([mix3(P[0], P[1], 0.5), mix3(P[3], P[2], 0.5)]);
    return gl;
  }
  function bladeTip(bl, op) { var ang = op * 1.15; return add(bl.pivot, add(mul(bl.dir, Math.cos(ang) * bl.len), [0, Math.sin(ang) * bl.len, 0])); }
  function lampLevel(t) { return 0.5 + 0.5 * Math.cos(TAU * t / 3.6); }

  /* ───────────────────────────── DC power flow (the flow lights) ───────────────────────────── */

  // A DC power flow on StudioNet's network: B theta = P with the neighboring grid X as the reference bus (it closes the
  // balance). Injections in MW, reactances in pu on 100 MVA; flows in MW. open: branch ids out of service.
  function dcFlow(NET, p, open) {
    open = open || [];
    var ids = NET.buses.map(function (b) { return b.id; }), idx = {}, n = ids.length, i, j, k;
    ids.forEach(function (id, q) { idx[id] = q; });
    var P = new Array(n).fill(0);
    NET.elements.forEach(function (e) { P[idx[e.bus]] += (p[e.id] || 0); });
    var brs = NET.branches.filter(function (b) { return open.indexOf(b.id) < 0; });
    var B = []; for (i = 0; i < n; i++) B.push(new Array(n).fill(0));
    brs.forEach(function (b) { var a = idx[b.a], c = idx[b.b], y = 1 / b.x_pu; B[a][a] += y; B[c][c] += y; B[a][c] -= y; B[c][a] -= y; });
    var ref = idx.X, keep = ids.map(function (_, q) { return q; }).filter(function (q) { return q !== ref; }), m = keep.length;
    var A = keep.map(function (r) { return keep.map(function (c) { return B[r][c]; }).concat([P[r]]); });
    for (k = 0; k < m; k++) {
      var piv = k; for (i = k + 1; i < m; i++) if (Math.abs(A[i][k]) > Math.abs(A[piv][k])) piv = i;
      var tmp = A[k]; A[k] = A[piv]; A[piv] = tmp;
      if (Math.abs(A[k][k]) < 1e-12) throw new Error('dcFlow: islanded network');
      for (i = k + 1; i < m; i++) { var f = A[i][k] / A[k][k]; if (f) for (j = k; j <= m; j++) A[i][j] -= f * A[k][j]; }
    }
    var x = new Array(m);
    for (i = m - 1; i >= 0; i--) { var s = A[i][m]; for (j = i + 1; j < m; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    var th = new Array(n).fill(0); keep.forEach(function (q, r) { th[q] = x[r]; });
    var F = {}, kcl = P.slice();
    brs.forEach(function (b) { var fl = (th[idx[b.a]] - th[idx[b.b]]) / b.x_pu; F[b.id] = fl; kcl[idx[b.a]] -= fl; kcl[idx[b.b]] += fl; });
    NET.branches.forEach(function (b) { if (F[b.id] == null) F[b.id] = 0; });
    var worst = 0; kcl.forEach(function (v, q) { if (q !== ref) worst = Math.max(worst, Math.abs(v)); });
    return { flows: F, kcl: worst, p: p };
  }
  /* ───────────────────────────── the line field: what the decisions mean for a line ───────────────────────────── */

  // The congested line D-I under tomorrow's uncertainty, for each decision of the story hour (the story states of
  // StudioNet.stories). The three renewables are drawn from the engine's states (the panels' shapes); the forecast error
  // (outcome minus forecast, summed) is covered in-zone by the balancing units in merit order (upward: the battery, then
  // the thermal plant; downward: the thermal plant, then the battery), so the AC tie and the DC interconnector keep their
  // schedules. Offshore and onshore outcomes are tied by a Gaussian copula (rho 0.5, an illustrative assumption); solar is
  // independent. Computed offline (computeLine) into assets/views.js.
  var LINE = {
    watch: 'L-DI', balance: 'in-zone', rho: 0.5, K: 8192, axis: [0.2, 1.15], cells: 512,
    renew: { offshore: 'offshore_wind', onshore: 'onshore_wind', solar: 'solar' },
    units: { battery: { min: -250, max: 250 }, thermal: { min: 300, max: 850 } }, merit: { up: ['battery', 'thermal'], down: ['thermal', 'battery'] },
    // b6_aware: the decision of the b6 story (the topology fixed; the gas-engine plant at 300 MW, which offers no balancing
    // energy, so the outcomes are covered by the battery park and the gas plant as everywhere)
    order: ['market', 'switched', 'aware', 'blind', 'calm', 'b6_aware', 'b7_aware'],
    situations: {
      // b7_aware: the decision of the b7 story (the spine out; the biomass power station at 100 MW). bids 'b7': its
      // outcomes are covered over b7's offered bids in price order (activateBids; StudioNet.stories.b7.units), a surplus
      // thermal, battery, biomass to its stable minimum
      b7_aware: { like: 'market', open: ['L-AD'], fixed: { thermal: 650, battery: -200, biomass: 100 }, bids: 'b7', down: ['thermal', 'battery', 'biomass'] },
      b6_aware: { like: 'market', fixed: { thermal: 300, battery: -50, engines: 300 } },
      market: { states: { offshore: 'offshore-82', onshore: 'onshore-40', solar: 'solar-30' }, forecast: { offshore: 0.82, onshore: 0.40, solar: 0.30 },
        fixed: { thermal: 800, battery: -250, town: -1100, industry: -400, dc_interconnector: -1100 }, open: [] },
      switched: { like: 'market', open: ['L-AD'] },
      aware: { like: 'market', open: ['L-AD'], fixed: { thermal: 600, battery: -50 } },
      blind: { like: 'market', fixed: { thermal: 300, battery: 250 } },
      calm: { states: { offshore: 'offshore-25', onshore: 'onshore-21', solar: 'solar-21' }, forecast: { offshore: 0.25, onshore: 0.21, solar: 0.21 },
        fixed: { thermal: 450, battery: 150, town: -900, industry: -400, dc_interconnector: 0 }, open: [] }
    }
  };
  function lineSituation(key) {
    var s = LINE.situations[key];
    if (!s.like) return s;
    var b = LINE.situations[s.like];
    var r = Object.assign({}, b, { open: s.open || b.open, fixed: Object.assign({}, b.fixed, s.fixed || {}) });
    if (s.bids) { r.bids = s.bids; r.down = s.down; }   // b7: covered over the offered bids
    return r;
  }
  // the injections of a situation at the forecast (MW per element)
  function situationP(NET, key) {
    var s = lineSituation(key), p = Object.assign({}, s.fixed), cap = {};
    NET.elements.forEach(function (e) { cap[e.id] = e.cap; });
    Object.keys(LINE.renew).forEach(function (t) { var el = LINE.renew[t]; p[el] = (p[el] || 0) + cap[el] * s.forecast[t]; });
    return p;
  }
  // in-zone balancing: cover a shortfall (MW, + short) with the balancing units in merit order from the set-points q;
  // returns the activation per unit and what no unit could take (uncovered)
  function activateInZone(q, short) {
    var order = short > 0 ? LINE.merit.up : LINE.merit.down, rest = short, act = { battery: 0, thermal: 0, uncovered: 0 };
    order.forEach(function (u) {
      if (Math.abs(rest) < 1e-9) return;
      var U = LINE.units[u], room = rest > 0 ? U.max - q[u] : q[u] - U.min, a = Math.max(0, Math.min(Math.abs(rest), room)) * (rest > 0 ? 1 : -1);
      act[u] = a; rest -= a;
    });
    act.uncovered = rest;
    return act;
  }

  // b7: a shortfall covered over the zone's offered bids, cheapest first (each unit offers the part of each bid above its
  // set-point; a unit with a stable minimum offers nothing while it is off; ties: unit order, then output); a surplus in
  // the order 'down', each unit to its minimum (a running unit with a stable minimum to it). Returns the activation per
  // unit and what no unit could take (uncovered), as activateInZone
  function activateBids(U, down, q, short) {
    var act = { battery: 0, thermal: 0, biomass: 0, uncovered: 0 }, order = Object.keys(U), rest = short;
    if (short > 1e-9) {
      var bids = [];
      order.forEach(function (u, ui) {
        var P = q[u] || 0, X = U[u];
        if (X.run_min != null && P < X.run_min - 1e-9) return;
        X.up.forEach(function (b, j) { var lo = Math.max(b[0], P); if (b[1] > lo + 1e-9) bids.push([b[2], ui, j, u, b[1] - lo]); });
      });
      bids.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
      bids.forEach(function (b) { if (rest <= 1e-9) return; var a = Math.min(rest, b[4]); act[b[3]] += a; rest -= a; });
    } else if (short < -1e-9) {
      down.forEach(function (u) {
        if (rest >= -1e-9) return;
        var P = q[u] || 0, X = U[u], lo = X.run_min != null ? (P >= X.run_min - 1e-9 ? X.run_min : P) : X.min, a = Math.max(0, Math.min(-rest, P - lo));
        act[u] -= a; rest += a;
      });
    }
    act.uncovered = rest;
    return act;
  }

  // Low-discrepancy draws (the engine's own construction: Owen-scrambled van der Corput and
  // Sobol' points), and the normal quantile and cdf for the copula. Deterministic.
  function fmix32(h) { h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16; return h >>> 0; }
  function hash01(seed, i, k) { return fmix32(Math.imul(seed + 0x632BE5AB, 0x9E3779B1) ^ Math.imul(i + 1, 0x85EBCA77) ^ Math.imul(k + 1, 0xC2B2AE3D)) / 4294967296; }
  function reverseBits(x) {
    x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1); x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
    x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4); x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
    return ((x >>> 16) | (x << 16)) >>> 0;
  }
  function lkHash(x, seed) {
    x = (x ^ Math.imul(x, 0x3d20adea)) >>> 0; x = (x + seed) >>> 0; x = Math.imul(x, (seed >>> 16) | 1) >>> 0;
    x = (x ^ Math.imul(x, 0x05526c56)) >>> 0; x = (x ^ Math.imul(x, 0x53a22864)) >>> 0; return x;
  }
  function owenVdc(i, seed) { return reverseBits(lkHash(i >>> 0, seed >>> 0)) / 4294967296; }
  function halton3(i) { var f = 1, r = 0; while (i > 0) { f /= 3; r += f * (i % 3); i = Math.floor(i / 3); } return r; }
  var SOBOL2 = (function () { var v = [], k; v[0] = 0x80000000; for (k = 1; k < 32; k++) v[k] = (v[k - 1] ^ (v[k - 1] >>> 1)) >>> 0; return v; })();
  function sobol2(i) { var x = 0, k = 0; while (i) { if (i & 1) x ^= SOBOL2[k]; i >>>= 1; k++; } return x >>> 0; }
  function owenSobol2(i, seed) { return reverseBits(lkHash(reverseBits(sobol2(i)), seed >>> 0)) / 4294967296; }
  function normInv(p) {
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    var b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    var c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    var e = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416], q, r, pl = 0.02425;
    p = clamp(p, 1e-12, 1 - 1e-12);
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((e[0] * q + e[1]) * q + e[2]) * q + e[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((e[0] * q + e[1]) * q + e[2]) * q + e[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z)), y = 0.3989422804014327 * Math.exp(-z * z / 2);
    var p = 1 - y * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? p : 1 - p;
  }
  // Fixed particle ranks like the engine's (scrambled (0,2)-sequence sorted by the first coordinate) plus two slow drift
  // phases: for the hybrid view's fans, which place particles themselves.
  function ranks(n, seed) {
    var s1 = fmix32(seed * 2 + 1), s2 = fmix32(seed * 2 + 2), pts = new Array(n), i;
    for (i = 0; i < n; i++) pts[i] = [owenVdc(i, s1), owenSobol2(i, s2), i];
    pts.sort(function (p, q) { return p[0] - q[0] || p[2] - q[2]; });
    var R = { n: n, u: new Float32Array(n), v: new Float32Array(n), w1: new Float32Array(n), w2: new Float32Array(n), f1: new Float32Array(n), f2: new Float32Array(n) };
    for (i = 0; i < n; i++) {
      R.u[i] = (i + 0.5) / n; R.v[i] = pts[i][1];
      R.w1[i] = TAU / (14000 + 26000 * hash01(seed, i, 11)); R.w2[i] = TAU / (14000 + 26000 * hash01(seed, i, 12));
      R.f1[i] = TAU * hash01(seed, i, 13); R.f2[i] = TAU * hash01(seed, i, 14);
    }
    return R;
  }

  // PTDFs of every branch in service (MW per MW injected at a bus and taken at the reference X).
  function ptdfOf(NET, open) {
    open = open || [];
    var ids = NET.buses.map(function (b) { return b.id; }), idx = {}, n = ids.length, i, j, k;
    ids.forEach(function (id, q) { idx[id] = q; });
    var brs = NET.branches.filter(function (b) { return open.indexOf(b.id) < 0; });
    var B = []; for (i = 0; i < n; i++) B.push(new Array(n).fill(0));
    brs.forEach(function (b) { var a = idx[b.a], c = idx[b.b], y = 1 / b.x_pu; B[a][a] += y; B[c][c] += y; B[a][c] -= y; B[c][a] -= y; });
    var keep = ids.map(function (_, q) { return q; }).filter(function (q) { return q !== idx.X; }), m = keep.length;
    var A = keep.map(function (r, ri) { return keep.map(function (c) { return B[r][c]; }).concat(keep.map(function (_, ci) { return ri === ci ? 1 : 0; })); });
    for (k = 0; k < m; k++) {
      var piv = k; for (i = k + 1; i < m; i++) if (Math.abs(A[i][k]) > Math.abs(A[piv][k])) piv = i;
      var tmp = A[k]; A[k] = A[piv]; A[piv] = tmp;
      var f = A[k][k]; if (Math.abs(f) < 1e-12) throw new Error('ptdfOf: islanded network');
      for (j = 0; j < 2 * m; j++) A[k][j] /= f;
      for (i = 0; i < m; i++) if (i !== k && A[i][k]) { var g = A[i][k]; for (j = 0; j < 2 * m; j++) A[i][j] -= g * A[k][j]; }
    }
    var Xi = []; for (i = 0; i < n; i++) Xi.push(new Array(n).fill(0));
    keep.forEach(function (r, ri) { keep.forEach(function (c, ci) { Xi[r][c] = A[ri][m + ci]; }); });
    var rows = {};
    brs.forEach(function (b) { var a = idx[b.a], c = idx[b.b]; rows[b.id] = ids.map(function (_, q) { return (Xi[a][q] - Xi[c][q]) / b.x_pu; }); });
    return { ids: ids, idx: idx, rows: rows, branches: brs };
  }
  function b64u16(u16) {
    var s = '', i;
    for (i = 0; i < u16.length; i++) s += String.fromCharCode(u16[i] & 255, u16[i] >> 8);
    return global.btoa(s);
  }
  // Loadings (share of the rating) to an engine area state on the axis [x0, x1]: a 512-cell
  // density table, lightly smoothed (Gaussian, 2.5 cells, reflected at both ends).
  function areaFromLoad(load, x0, x1) {
    var G = LINE.cells, h = new Float64Array(G), i, k, j, n = load.length, p1 = 0, mean = 0, sq = 0;
    for (i = 0; i < n; i++) {
      var x = (load[i] - x0) / (x1 - x0); mean += x; sq += x * x;
      if (x >= 1) p1++; else h[Math.max(0, Math.floor(x * G))]++;
    }
    mean /= n;
    var sd = Math.sqrt(Math.max(0, sq / n - mean * mean)), s = 2.5, w = [], sm = new Float64Array(G), peak = 0;
    for (k = -8; k <= 8; k++) w.push(Math.exp(-k * k / (2 * s * s)));
    for (i = 0; i < G; i++) for (k = -8; k <= 8; k++) { j = i + k; if (j < 0) j = -1 - j; if (j >= G) j = 2 * G - 1 - j; sm[j] += h[i] * w[k + 8]; }
    for (i = 0; i < G; i++) if (sm[i] > peak) peak = sm[i];
    var u = new Uint16Array(G); for (i = 0; i < G; i++) u[i] = Math.round(sm[i] / peak * 65535);
    return { tech: 'line', kind: 'area', p0: 0, p1: p1 / n, mean: +mean.toFixed(5), sd: +sd.toFixed(5), dens: b64u16(u) };
  }
  // Offline only (needs the engine's display quantiles; its output is the line part of assets/views.js): K joint draws per
  // situation through the DC flow; returns the line's area states, the statistics and the checks.
  function computeLine(shapes, NET, UF) {
    var dq = UF._qa.displayQuantile, K = LINE.K, X0 = LINE.axis[0], X1 = LINE.axis[1], rho = LINE.rho, cap = {}, bus = {}, rate = {};
    NET.elements.forEach(function (e) { cap[e.id] = e.cap; bus[e.id] = e.bus; });
    NET.branches.forEach(function (b) { rate[b.id] = b.rate_mva; });
    var out = { axis: LINE.axis, limit: +((1 - X0) / (X1 - X0)).toFixed(6), watch: LINE.watch, states: {}, stats: {}, situations: {} };
    LINE.order.forEach(function (key) {
      var S = lineSituation(key), m = ptdfOf(NET, S.open), ids = m.ids, row = m.rows[LINE.watch];
      var base = new Float64Array(ids.length), load = new Float64Array(K), P = new Float64Array(ids.length), tie0 = 0;
      var p0 = situationP(NET, key); NET.elements.forEach(function (e) { tie0 -= p0[e.id] || 0; });
      Object.keys(S.fixed).forEach(function (el) { base[m.idx[bus[el]]] += S.fixed[el]; });
      var actMin = { battery: 1e9, thermal: 1e9, biomass: 1e9 }, actMax = { battery: -1e9, thermal: -1e9, biomass: -1e9 }, kcl = 0, agree = 0, other = {}, over = 0, spill = 0, dear = 0, tieMax = 0, i, k, t;
      m.branches.forEach(function (b) { other[b.id] = 0; });
      for (i = 0; i < K; i++) {
        // offshore and onshore: the two dimensions of an Owen-scrambled Sobol' (0,2)-sequence; solar: a
        // rotated base-3 Halton sequence (two scrambles of one base-2 sequence would share their
        // leading digits, so they are not independent)
        var a = owenVdc(i, 0x9E3779B1), b2 = owenSobol2(i, 0x85EBCA77), c = (halton3(i + 1) + 0.3819660113) % 1;
        var u = { offshore: a, onshore: normCdf(rho * normInv(a) + Math.sqrt(1 - rho * rho) * normInv(b2)), solar: c };
        var dev = 0, p = Object.assign({}, S.fixed);
        for (k = 0; k < ids.length; k++) P[k] = base[k];
        for (t in LINE.renew) {
          var el = LINE.renew[t], mw = cap[el] * dq(shapes, S.states[t], u[t]);
          P[m.idx[bus[el]]] += mw; dev += mw - cap[el] * S.forecast[t]; p[el] = (p[el] || 0) + mw;
        }
        // the deviation is covered in-zone (the battery, then the thermal plant upward; the thermal plant, then the battery
        // downward); only what both units cannot take is left to the reference bus X (counted as uncoveredShare)
        var act = S.bids ? activateBids(NET.stories.b7.units, S.down, S.fixed, -dev) : activateInZone(S.fixed, -dev);   // b7: over the offered bids
        if (Math.abs(act.uncovered) > 1e-6) spill++;
        (S.bids ? ['battery', 'thermal', 'biomass'] : ['battery', 'thermal']).forEach(function (u) {
          P[m.idx[bus[u]]] += act[u]; p[u] = S.fixed[u] + act[u];
          actMin[u] = Math.min(actMin[u], act[u]); actMax[u] = Math.max(actMax[u], act[u]);
        });
        if ((dev < 0 && act.thermal > 1) || (dev > 0 && act.battery < -1)) dear++;
        var f = 0; for (k = 0; k < ids.length; k++) f += row[k] * P[k];
        load[i] = Math.abs(f) / rate[LINE.watch];
        if (load[i] > 1) over++;
        m.branches.forEach(function (br) {
          if (br.id === LINE.watch) return;
          var r = m.rows[br.id], s = 0; for (var q = 0; q < ids.length; q++) s += r[q] * P[q];
          other[br.id] = Math.max(other[br.id], Math.abs(s) / rate[br.id]);
        });
        if (i % 512 === 0) {   // the full DC flow (independent solve) agrees with the PTDFs, and balances
          var res = dcFlow(NET, p, S.open), xi = 0;
          kcl = Math.max(kcl, res.kcl); agree = Math.max(agree, Math.abs(res.flows[LINE.watch] - f));
          NET.elements.forEach(function (e) { xi -= p[e.id] || 0; });
          if (Math.abs(act.uncovered) < 1e-6) tieMax = Math.max(tieMax, Math.abs(xi - tie0));
        }
      }
      var sorted = Array.from(load).sort(function (x, y) { return x - y; }), mean = 0;
      sorted.forEach(function (v) { mean += v; }); mean /= K;
      var worst = Object.keys(other).sort(function (x, y) { return other[y] - other[x]; })[0];
      var pct = function (q) { return +(sorted[Math.min(K - 1, Math.floor(q * K))] * 100).toFixed(1); };
      out.stats[key] = { overShare: +(over / K * 100).toFixed(2), mean: +(mean * 100).toFixed(1), p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
        max: +(sorted[K - 1] * 100).toFixed(1), min: +(sorted[0] * 100).toFixed(1),
        battery: [Math.round(actMin.battery), Math.round(actMax.battery)], thermal: [Math.round(actMin.thermal), Math.round(actMax.thermal)],
        dearShare: +(dear / K * 100).toFixed(2), uncoveredShare: +(spill / K * 100).toFixed(2), tieShift: +tieMax.toFixed(6),
        worstOther: [worst, +(other[worst] * 100).toFixed(1)], kcl: kcl, ptdfVsSolve: agree };
      out.states['line-' + key] = areaFromLoad(load, X0, X1);
      out.situations[key] = { states: S.states, forecast: S.forecast, fixed: S.fixed, open: S.open };
    });
    out.spec = { balance: LINE.balance, rho: LINE.rho, K: K };
    return out;
  }

  // per lane: [MW along the drawn direction, loading as a share of the rating]
  function laneFlow(ln, res, rate) {
    var s = ln.src;
    if (s.type === 'branch') { var f = res.flows[s.br] || 0; return [f * s.sign, Math.abs(f) / rate[s.br]]; }
    var e = res.p[s.el] || 0;
    var v = e * s.share;
    return [v * s.sign, Math.abs(e) / s.cap];
  }

  /* ───────────────────────────── still (no-JS) SVG of the moving parts ───────────────────────────── */

  function svgLive(S, t) {
    var out = [], cam = S.cam;
    S.canvasList.forEach(function (o) {
      if (o.kind === 'turbine') {
        out.push('<g class="o th-renewables">' + svgObj(o));
        rotorBlades(o, t).forEach(function (b) { out.push('<path class="f cd' + pad2(level(intensity(b.n, LIGHT) * o.fall)) + '" d="' + pathOf(b.p.map(function (p) { return cam.p(p); })) + 'Z"/>'); });
        var hc = cam.p(add(o.rotor.hub, mul(o.rotor.n, 1))), hr = o.rotor.R * 0.055 * cam.f / hc[2];
        out.push('<circle class="f cd13" cx="' + fmt(hc[0]) + '" cy="' + fmt(hc[1]) + '" r="' + fmt(hr) + '"/></g>');
      } else if (o.kind === 'trackers') {
        out.push('<g class="o th-renewables">');
        trackerQuads(o, t, cam).forEach(function (q) {
          var sp = q.p.map(function (p) { return cam.p(p); });
          out.push('<path class="f pv' + pad2(level(intensity(q.n, LIGHT) * q.fall)) + '" d="' + pathOf(sp) + 'Z"/>');
          if (q.spec > GLINT.min) out.push('<path class="glint" style="opacity:' + fmt(Math.min(1, q.spec * 1.4) * 0.85 * GLINT.a) + '" d="' + pathOf(sp) + 'Z"/>');
          out.push('<path class="pv-grid" d="' + pvGrid(q.p).map(function (l) { return pathOf([cam.p(l[0]), cam.p(l[1])]); }).join('') + '"/>');
        });
        out.push('</g>');
      } else if (o.kind === 'battery') {
        out.push('<g class="o th-balancing">');
        o.bars.forEach(function (c, i) {
          var lv = BAT.still, xm = lerp(c.x0, c.x1, lv);   // the decided state's level (no motion)
          var Q = function (a, b) { return pathOf([cam.p([a, c.y0, c.z]), cam.p([b, c.y0, c.z]), cam.p([b, c.y1, c.z]), cam.p([a, c.y1, c.z])]) + 'Z'; };
          out.push('<path class="bar-track" d="' + Q(c.x0, c.x1) + '"/><path class="bar-fill" d="' + Q(c.x0, xm) + '"/>');
        });
        out.push('</g>');
      } else if (o.kind === 'breaker') {
        var op = DECIDED.open.indexOf(o.br) >= 0 ? 1 : 0;   // the decided state, the spine out
        out.push('<g class="o th-switching">');
        o.blades.forEach(function (bl) { out.push('<path class="blade" d="' + pathOf([cam.p(bl.pivot), cam.p(bladeTip(bl, op))]) + '"/>'); });
        out.push('</g>');
      } else if (o.kind === 'panel') {
        out.push('<g class="o th-' + o.theme + ' pn pv pv-r4">' + svgPanel(o) + '</g>');
      } else if (o.kind === 'rods') {
        out.push('<g class="o th-' + o.theme + ' rods pv pv-r4">' + svgRods(o) + '</g>');
      } else {
        out.push('<g class="o' + (o.theme ? ' th-' + o.theme : '') + '">' + svgObj(o) + '</g>');
      }
    });
    S.live.lamps.forEach(function (p) {
      var q = cam.p(p);
      out.push('<g class="o th-hvdc"><circle class="lamp-halo" cx="' + fmt(q[0]) + '" cy="' + fmt(q[1]) + '" r="4.2"/><circle class="lamp" cx="' + fmt(q[0]) + '" cy="' + fmt(q[1]) + '" r="1.6"/></g>');
    });
    return out.join('');
  }

  /* ───────────────────────────── the page: one live canvas on the engine's clock ───────────────────────────── */

  var ENGINE = '/assets/engine/';
  var PARTICLES = {
    wide: { offshore: { count: 1050, seed: 11 }, onshore: { count: 650, seed: 12 }, solar: { count: 560, seed: 13 }, line: { count: 760, seed: 14 }, size: 2.1, drift: 1.4 },
    compact: { offshore: { count: 560, seed: 11 }, onshore: { count: 340, seed: 12 }, solar: { count: 320, seed: 13 }, line: { count: 380, seed: 14 }, size: 1.9, drift: 1.2 }
  };
  var TECHS = ['offshore', 'onshore', 'solar'];
  // ── Flow light: continuous light along the conductors and cables ──
  // Profile "stream" (default): overlapping soft streaks, a bright head and a fading tail, so the light is continuous and
  // its direction reads even in a still frame; "current" (html[data-beam] current): a lit conductor whose brightness swells
  // travel along it. Direction is the sign of the DC flow on the lane, brightness and speed follow its loading. For the
  // stories:
  //   - every conductor in service keeps a faint steady glow, even at zero flow; only a line switched out is dark;
  //   - a branch over its rating draws its halo in the over-limit warm (crossfaded as the loading crosses the rating);
  //   - a reroute sweep: one band of extra brightness (+60 %) runs once along a lane in the flow direction;
  //   - a tint: a lane takes a balancing unit's pool color while that pool drains;
  //   - light behind a panel's field is dimmed.
  // Cost model: each lane cut once into segments of about 6 CSS px; per frame each segment's brightness quantized to 12
  // levels and appended to the Path2D of its (kind, warm, level) bucket; each bucket stroked twice (a halo, faint levels
  // skipped, and a core whose color warms with the level); the paths rebuilt at most 15 times a second (every frame at
  // rest); the glow floor's paths are rebuilt only when a lane's glow level changes. Palette: warm white to pale gold,
  // never the over-limit red-orange.
  var BEAM = {
    LEVELS: 12, LUT_N: 512, DS: 6.0, HALO_MIN: 3, REBUILD: 15, GLOW_LV: 3,
    KIND_W: { ehv: 1.7, hv: 1.15, dc: 1.3, cable: 1.05 }, KINDS: ['ehv', 'hv', 'dc', 'cable'],
    PROFILES: {
      current: { lambda: 112, v0: 8, vk: 26, floor: 0.36, symmetric: true, f: function (x) { var c = 0.5 + 0.5 * Math.cos(2 * Math.PI * x); return c * c; } },
      stream: { lambda: 80, v0: 9, vk: 28, floor: 0.24, tau: 0.38, head: 0.07, symmetric: false, f: function (x) {
        var tail = Math.exp(-x / 0.38);
        if (x > 1 - 0.07) { var k = (x - (1 - 0.07)) / 0.07; k = k * k * (3 - 2 * k); return lerp(tail, 1, k); }
        return tail;
      } }
    },
    // the flows are eased by the timeline (0.3 s cut, 0.6 s reroute); the renderer adds only a little smoothing
    EASE: { tauV: 0.25, tauA: 0.12, tauG: 0.1, minLoad: 0.012, vmaxLoad: 1.15, endFade: 8, flipV: 4, hotBand: 0.02 },
    SWEEP: { gain: 0.6, width: 0.16, minW: 26 }
  };
  // ── The HVDC light against AC (html[data-dc]: same | held | pair | drift), form only ──
  // same: the DC poles carry the traveling streaks like every AC conductor.
  // held: the DC cables (lanes of kind 'dc'; the bipole's metallic return carries no current and keeps only the glow floor)
  // carry an even, steady light at their loading, with no traveling texture: a direct current, the same along the whole
  // cable and constant in time, at the level the converters hold. The level changes only when the set-point does (DC-1 with
  // the wind farm's output, DC-2 at the hour's schedule), eased as the flows are; it never reacts to a switching. The
  // converter stations' status lamps stop pulsing.
  // pair: held, and each link's two poles (+ and -) are drawn apart on screen to a half gap of DCL.gap CSS px with a
  // narrower halo, so a link reads as two steady lines (the bipole's return stays dim between them).
  // drift: pair, plus a faint ripple (depth DCL.rip of the level) that moves in the direction power flows at the AC lanes'
  // speed law, so the direction and speed cue stays.
  // level: the even light's brightness (of the profile's peak); a0: its strength at zero loading, rising linearly to 1 at
  // the pole's rating (the AC lanes' 0.30 + 0.70 x load/0.85 would hide DC-1's steps with the wind); gap: the pair's half
  // gap (CSS px); halo: the pair's halo width in dark (additive), haloA in the light theme; levelR: the calibrated level
  // (0.85 to 1.12 x the light of 'same' at the same loading, on both links and in both themes), used for the modes named in
  // DCL.cal (all three by default; '' keeps level everywhere)
  var DCL = { level: 0.95, a0: 0.15, gap: 2.0, halo: 0.42, haloA: 0.8, rip: 0.3, levelR: 0.7, cal: 'held,pair,drift' };
  function dcModeOf(v) { return v === 'held' || v === 'pair' || v === 'drift' ? v : v === 'same' ? null : 'pair'; }   // pair by default
  function dcPairOf(m) { return m === 'pair' || m === 'drift'; }
  // pair: each DC link's two poles pushed apart in screen space (CSS px) along their own spacing, about their middle
  function dcPairs(lanes, s, ox, oy, G) {
    var by = {}, out = {};
    lanes.forEach(function (L) { var ln = L.ln; if (ln.w === 'dc' && ln.src && ln.src.el !== 'none') (by[ln.id.replace(/-\d+$/, '')] = by[ln.id.replace(/-\d+$/, '')] || []).push(ln); });
    Object.keys(by).forEach(function (k) {
      var P = by[k];
      if (P.length !== 2 || P[0].sp.length !== P[1].sp.length) return;
      var A = [], B = [];
      for (var i = 0; i < P[0].sp.length; i++) {
        var a = [P[0].sp[i][0] * s + ox, P[0].sp[i][1] * s + oy], b = [P[1].sp[i][0] * s + ox, P[1].sp[i][1] * s + oy];
        var cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l < 1e-6 || l >= 2 * G) { A.push(a); B.push(b); continue; }
        A.push([cx - dx / l * G, cy - dy / l * G]); B.push([cx + dx / l * G, cy + dy / l * G]);
      }
      out[P[0].id] = A; out[P[1].id] = B;
    });
    return out;
  }
  function Beams(lanes, profile) {
    this.P = BEAM.PROFILES[profile] || BEAM.PROFILES.stream;
    this.profile = BEAM.PROFILES[profile] ? profile : 'stream';
    this.lanes = lanes.map(function (ln, i) {
      // deterministic start offsets (no Math.random): spread the phases of neighboring lanes
      var h = Math.sin((i + 1) * 12.9898) * 43758.5453; h = h - Math.floor(h);
      return { ln: ln, v: 0, a: 0, g: 0, off: h * 400, init: false, kind: Math.max(0, BEAM.KINDS.indexOf(ln.w)), hot: 0, sw: null, tint: null };
    });
    var P = this.P;
    this.lut = new Float32Array(BEAM.LUT_N + 1);
    for (var k = 0; k <= BEAM.LUT_N; k++) this.lut[k] = P.floor + (1 - P.floor) * P.f(k / BEAM.LUT_N);
    this.cache = null; this.lastBuild = -1; this.stats = { segs: 0, strokes: 0, builds: 0 };
    // the HVDC hover's pulse always takes the stream profile's shape (floor removed), whatever html[data-beam] is, with the
    // palette's own tail (dcTail; the stream's 0.38 until the palette is read)
    this.hcTail = BEAM.PROFILES.stream.tau; this.hcLut = hcProfile(this.hcTail);
    // a link's two poles carry the HVDC pulse in one phase (hcOff: one offset per link, from 0, moved by the link's first
    // pole), so the pair reads as one cable with its light side by side
    this.hcOff = {}; this.lanes.forEach(function (L) { L.lkey = L.ln.w === 'dc' && L.ln.src && L.ln.src.el !== 'none' ? L.ln.id.replace(/-\d+$/, '') : null; });
  }
  // the HVDC pulse's profile: the stream profile's shape (a sharp head over its last head share, an exponential tail) with
  // tail tau (of the wavelength): the stream's own 0.38 in dark, a short dash in the light theme (dcTail)
  function hcProfile(tau) {
    var lut = new Float32Array(BEAM.LUT_N + 1), hd = BEAM.PROFILES.stream.head;
    for (var k = 0; k <= BEAM.LUT_N; k++) {
      var x = k / BEAM.LUT_N, tail = Math.exp(-x / tau), v = tail;
      if (x > 1 - hd) { var q = (x - (1 - hd)) / hd; q = q * q * (3 - 2 * q); v = lerp(tail, 1, q); }
      lut[k] = v;
    }
    return lut;
  }
  // the palette from the scene's flat colors (--s-beam*)
  Beams.prototype.palette = function (s) {
    var L = BEAM.LEVELS, num = function (k, d) { var v = parseFloat(s[k]); return isFinite(v) ? v : d; };
    this.pal = { blend: s.beamBlend === 'lighter' ? 'lighter' : 'source-over', halo: s.beamHalo, hot: s.beamHot, hotCore: s.beamHotCore,
      coreA: num('beamCoreA', 1), haloA: num('beamHaloA', 0.3), coreW: num('beamCoreW', 0.8), haloW: num('beamHaloW', 3.6),
      glow: num('beamGlow', 0.2), glowHalo: num('beamGlowHalo', 0), core: s.beamCore, cheap: s.poolCheap, dear: s.poolDear };
    // the HVDC hover's light (tones --s-dcBody, dcBodyA, dcPulse, dcBodyW, dcPulseW)
    this.pal.dc = { body: s.dcBody || '#0f789b', bodyA: num('dcBodyA', 1), pulse: s.dcPulse || '#eaf8fc', bodyW: num('dcBodyW', 2.6), pulseW: num('dcPulseW', 0.8),
      tail: num('dcTail', 0.38), lo: num('dcPulseLo', 0.5), edge: s.dcEdge || '#0a5570', edgeW: num('dcEdgeW', 0) };   // the pulse's tail, its strength at low power, the body's dark edge
    if (this.pal.dc.tail !== this.hcTail) { this.hcTail = this.pal.dc.tail; this.hcLut = hcProfile(this.hcTail); this.cache = null; }
    this.coreCol = [];
    for (var lv = 0; lv < L; lv++) this.coreCol.push(mixHex(s.beamLo, s.beamCore, Math.pow(lv / (L - 1), 0.85)));
    this.cache = null;
  };
  // the HVDC light's mode (see DCL); call before layout (pair moves the poles' light)
  Beams.prototype.dcMode = function (v) {
    var m = this.dcm = dcModeOf(v);
    this.lanes.forEach(function (L) { L.held = !!m && L.ln.w === 'dc'; });
    // drift keeps the held light's mean, so its ripple adds direction, not light (mean of the profile's shape)
    for (var k = 0, sm = 0, fl = this.P.floor; k < BEAM.LUT_N; k++) sm += (this.lut[k] - fl) / (1 - fl);
    this.ripMean = sm / BEAM.LUT_N;
    this.cache = null; this.glow = null;
  };
  // Cut every lane into segments in CSS px; a static factor per segment: a fade at the lane's ends, dimmed behind a panel's
  // field (covers: screen rings in view units, behind: the factor). gate ('', 'b6' or 'b7', the open gate of
  // html[data-bal]) picks the lanes' hidden stretches (ln.occ, made by laneOcclusion): a segment wholly inside one carries
  // no light (F 0); a segment cut by one keeps only its visible pieces (L.part[j]: [[u0, u1], ...] in the segment's own
  // 0..1), drawn as their own sub-paths, so the light stops at the edge
  Beams.prototype.layout = function (map, covers, behind, occl, gate) {
    var s = map.s, ox = map.ox, oy = map.oy, total = 0, DS = BEAM.DS, EF = BEAM.EASE.endFade;
    this.scale = s; this.cache = null; this.glow = null;
    // a cover may be { ring, ex }: the lanes ex matches keep their full light behind it
    var cv = covers.map(function (c) {
      var ring = c.ring || c, r = ring.map(function (p) { return [p[0] * s + ox, p[1] * s + oy]; }), bb = bbOfPts(r);
      return { ring: r, bb: bb, ex: c.ex || null };
    });
    // occl.faces (view units) hide the lanes that occl.re matches: the HVDC cables end inside the converter halls, and the
    // light (drawn above the model) must not run over a hall's walls and roof
    var oc = occl ? occl.faces.map(function (ring) { var r = ring.map(function (p) { return [p[0] * s + ox, p[1] * s + oy]; }); return { ring: r, bb: bbOfPts(r) }; }) : [];
    var PS = dcPairOf(this.dcm) ? dcPairs(this.lanes, s, ox, oy, DCL.gap) : null;   // pair and drift: the poles' own screen paths
    this.lanes.forEach(function (L) {
      var sp = (PS && PS[L.ln.id]) || L.ln.sp.map(function (p) { return [p[0] * s + ox, p[1] * s + oy]; }), cum = [0], i;
      for (i = 1; i < sp.length; i++) cum.push(cum[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]));
      var len = cum[cum.length - 1], n = Math.max(1, Math.round(len / DS)), X = new Float32Array(n + 1), Y = new Float32Array(n + 1), F = new Float32Array(n), j = 0;
      for (i = 0; i <= n; i++) {
        var at = len * i / n;
        while (j < cum.length - 2 && cum[j + 1] < at) j++;
        var sg = cum[j + 1] - cum[j] || 1, u = clamp((at - cum[j]) / sg, 0, 1);
        X[i] = sp[j][0] + (sp[j + 1][0] - sp[j][0]) * u; Y[i] = sp[j][1] + (sp[j + 1][1] - sp[j][1]) * u;
      }
      var hid = occl && occl.re.test(L.ln.id), H = new Uint8Array(n);
      // the lane's hidden stretches for the open gate, as fractions of its length (the HVDC pair's poles are a little
      // longer on screen than their conductors), then per segment: H 1 when wholly hidden, part[j] when cut
      var oq = L.ln.occ ? L.ln.occ[gate || ''] || null : null, part = null;   // occ.b6 and occ.b7 include the ungated stretches
      if (oq && L.ln.len > 0) {
        var fr = oq.map(function (q) { return [q[0] / L.ln.len * n, q[1] / L.ln.len * n]; });   // in segment units
        for (i = 0; i < n; i++) {
          var vis = [[0, 1]];
          fr.forEach(function (q) {
            var h0 = q[0] - i, h1 = q[1] - i;
            if (h1 <= 0 || h0 >= 1) return;
            var nx = [];
            vis.forEach(function (v) { if (h0 > v[0]) nx.push([v[0], Math.min(v[1], h0)]); if (h1 < v[1]) nx.push([Math.max(v[0], h1), v[1]]); });
            vis = nx.filter(function (v) { return v[1] - v[0] > 1e-4; });
          });
          if (!vis.length) H[i] = 1;
          else if (vis.length > 1 || vis[0][0] > 1e-4 || vis[0][1] < 1 - 1e-4) (part = part || {})[i] = vis;
        }
      }
      // a DC pole also keeps, per segment, its factor before any hiding (Fb) and whether a converter hall hides it (Hh)
      var dcL = L.ln.w === 'dc' && !!L.ln.src && L.ln.src.el !== 'none', Hh = dcL ? new Uint8Array(n) : null, Fb = dcL ? new Float32Array(n) : null;
      for (i = 0; i < n; i++) {
        var mid = len * (i + 0.5) / n, mx = (X[i] + X[i + 1]) / 2, my = (Y[i] + Y[i + 1]) / 2, bh = false;
        for (var c = 0; c < cv.length && !bh; c++) { var b = cv[c].bb; bh = !(cv[c].ex && cv[c].ex.test(L.ln.id)) && mx > b[0] && mx < b[2] && my > b[1] && my < b[3] && inPoly(mx, my, cv[c].ring); }
        if (hid) for (var e = 0; e < oc.length && !H[i]; e++) { var ob = oc[e].bb; H[i] = mx > ob[0] && mx < ob[2] && my > ob[1] && my < ob[3] && inPoly(mx, my, oc[e].ring) ? 1 : 0; }
        F[i] = H[i] ? 0 : Math.min(1, mid / EF, (len - mid) / EF) * (bh ? behind : 1);
        if (dcL) {
          if (hid) for (var e2 = 0; e2 < oc.length && !Hh[i]; e2++) { var ob2 = oc[e2].bb; Hh[i] = mx > ob2[0] && mx < ob2[2] && my > ob2[1] && my < ob2[3] && inPoly(mx, my, oc[e2].ring) ? 1 : 0; }
          // Fb is not dimmed behind a panel's field, so the HVDC hover's pulse reads the same along the whole link (its
          // body is not dimmed either, and the fields are held at 0.15 under the day's sink)
          Fb[i] = Math.min(1, mid / EF, (len - mid) / EF);
        }
      }
      var path = new global.Path2D(), pen = false;
      for (i = 0; i < n; i++) {
        if (H[i]) { pen = false; continue; }
        var pc = part && part[i];
        if (pc) {   // only the visible pieces of a cut segment
          pc.forEach(function (v) { path.moveTo(X[i] + (X[i + 1] - X[i]) * v[0], Y[i] + (Y[i + 1] - Y[i]) * v[0]); path.lineTo(X[i] + (X[i + 1] - X[i]) * v[1], Y[i] + (Y[i + 1] - Y[i]) * v[1]); });
          pen = pc[pc.length - 1][1] >= 1 - 1e-4;
          continue;
        }
        if (!pen) { path.moveTo(X[i], Y[i]); pen = true; } path.lineTo(X[i + 1], Y[i + 1]);
      }
      L.X = X; L.Y = Y; L.F = F; L.n = n; L.len = len; L.ds = len / n; L.path = path; L.part = part;
      // the HVDC hover's light on a DC pole (body and pulse) has its own path: it stops inside the converter halls
      // (occl.faces) and behind the converter sites the day keeps lit (ln.occ.hvc), and runs over everything else in front
      // of the cable, which sinks under the day's cover (on phones a turbine tower stands before DC-1, and the opaque body
      // cut there would read as a broken cable)
      L.hcF = null; L.hcPart = null; L.hcPath = null;
      if (dcL) {
        var oh = L.ln.occ && L.ln.len > 0 ? L.ln.occ.hvc || null : null, fh = oh ? oh.map(function (q) { return [q[0] / L.ln.len * n, q[1] / L.ln.len * n]; }) : null;
        var F2 = new Float32Array(n), part2 = null, path2 = new global.Path2D(), pen2 = false;
        for (i = 0; i < n; i++) {
          var vis2 = [[0, 1]];
          if (fh) fh.forEach(function (q) {
            var h0 = q[0] - i, h1 = q[1] - i;
            if (h1 <= 0 || h0 >= 1) return;
            var nx = [];
            vis2.forEach(function (v) { if (h0 > v[0]) nx.push([v[0], Math.min(v[1], h0)]); if (h1 < v[1]) nx.push([Math.max(v[0], h1), v[1]]); });
            vis2 = nx.filter(function (v) { return v[1] - v[0] > 1e-4; });
          });
          var hide2 = Hh[i] || !vis2.length;
          F2[i] = hide2 ? 0 : Fb[i];
          if (hide2) { pen2 = false; continue; }
          if (vis2.length > 1 || vis2[0][0] > 1e-4 || vis2[0][1] < 1 - 1e-4) {
            (part2 = part2 || {})[i] = vis2;
            vis2.forEach(function (v) { path2.moveTo(X[i] + (X[i + 1] - X[i]) * v[0], Y[i] + (Y[i + 1] - Y[i]) * v[0]); path2.lineTo(X[i] + (X[i + 1] - X[i]) * v[1], Y[i] + (Y[i + 1] - Y[i]) * v[1]); });
            pen2 = vis2[vis2.length - 1][1] >= 1 - 1e-4;
            continue;
          }
          if (!pen2) { path2.moveTo(X[i], Y[i]); pen2 = true; } path2.lineTo(X[i + 1], Y[i + 1]);
        }
        L.hcF = F2; L.hcPart = part2; L.hcPath = path2;
      }
      total += n;
    });
    this.stats.segs = total;
  };
  // flows: per lane [MW along the drawn direction, loading]; live: per lane in service (a line switched out: false). tauH
  // (optional): the warm core over a rating eases in over tauH s instead of following the load at once (the switching
  // replay's glide passes it, so the overload comes back with the crossfade)
  Beams.prototype.update = function (dt, flows, live, still, tauH) {
    var P = this.P, E = BEAM.EASE, kv = 1 - Math.exp(-dt / E.tauV), ka = 1 - Math.exp(-dt / E.tauA), kg = 1 - Math.exp(-dt / E.tauG), kh = tauH && !still ? 1 - Math.exp(-dt / tauH) : 1;
    // while the HVDC color is on (hc > 0) a DC pole's light moves at DAYX.light's speed law and follows its set-point
    // closely (tauV, tauA); redK takes the over-limit warm out (the HVDC hover's day, DAYX.red; 1 everywhere else)
    var hc = this.hc || 0, HL = DAYX.light, kvD = 1 - Math.exp(-dt / HL.tauV), kaD = 1 - Math.exp(-dt / HL.tauA), rk = this.redK == null ? 1 : this.redK;
    for (var i = 0; i < this.lanes.length; i++) {
      var L = this.lanes[i], fl = flows[i] || [0, 0], load = fl[1], g = live[i] ? 1 : 0;
      var hcD = hc > 0 && L.ln.w === 'dc' && !!L.ln.src && L.ln.src.el !== 'none';
      var tv = load < E.minLoad ? 0 : (fl[0] >= 0 ? 1 : -1) * (hcD ? lerp(P.v0, HL.v0 * Math.min(1, load / HL.full), hc) + lerp(P.vk, HL.vk, hc) * Math.min(E.vmaxLoad, load) : P.v0 + P.vk * Math.min(E.vmaxLoad, load));
      var ta = load < E.minLoad ? 0 : L.held ? DCL.a0 + (1 - DCL.a0) * Math.min(1, load) : 0.30 + 0.70 * Math.min(1, load / 0.85);   // held DC: linear in the loading
      if (!L.init || still) { L.v = tv; L.a = ta; L.g = g; L.ld = load; L.init = true; }
      else if (hcD) { L.v += (tv - L.v) * kvD; L.a += (ta - L.a) * kaD; L.g += (g - L.g) * kg; L.ld += (load - L.ld) * kaD; }
      else { L.v += (tv - L.v) * kv; L.a += (ta - L.a) * ka; L.g += (g - L.g) * kg; L.ld = load; }
      // a line switched out carries no current from the frame its breakers open, so its light goes out in that frame
      // instead of easing out; the other lanes still ease
      if (!live[i]) { L.a = 0; L.g = 0; }
      if (!still) L.off += L.v * dt;
      // red-orange means over a limit and nothing else, so the warm core starts at the rating (a band centered on it would
      // show part of the over-limit warm on a line at 99 to 100 % of its rating)
      var hot9 = L.ln.src && L.ln.src.type === 'branch' ? clamp((load - 1) / E.hotBand, 0, 1) * rk : 0;   // x redK (the HVDC hover's day takes the red out)
      L.hot = kh < 1 && L.hot != null ? L.hot + (hot9 - L.hot) * kh : hot9;   // eased over tauH in the glide
    }
    // each link's shared HVDC pulse offset (hcOff) moves with its first pole's speed
    if (!still) for (var i9 = 0, seen9 = {}; i9 < this.lanes.length; i9++) { var L9 = this.lanes[i9]; if (!L9.lkey || seen9[L9.lkey]) continue; seen9[L9.lkey] = 1; this.hcOff[L9.lkey] = (this.hcOff[L9.lkey] || 0) + L9.v * dt; }
  };
  // a reroute sweep on lane i from time t0 (s) over dur (s)
  Beams.prototype.sweep = function (i, t0, dur, gain) { if (this.lanes[i]) this.lanes[i].sw = { t0: t0, dur: dur, g: gain }; };
  // tint lane i with a pool's color ('cheap' | 'dear') at strength k (0 removes it)
  Beams.prototype.tint = function (i, col, k) { if (this.lanes[i]) this.lanes[i].tint = k > 0.01 ? { col: col, k: k } : null; };
  // laneK (optional): a per-lane factor, e.g. a highlight's dimming: function (lane) -> 0..1
  Beams.prototype.build = function (t, laneK, hcOnly) {   // hcOnly: only the DC poles' HVDC pulse paths (L.hc)
    var P = this.P, lut = this.lut, lam = P.lambda, B = {}, LV = BEAM.LEVELS, Lm1 = LV - 1, NL = BEAM.LUT_N, SW = BEAM.SWEEP, GL = BEAM.GLOW_LV;
    // the HVDC hover's light (hc > 0): the DC poles' pulse paths by level (below); every other lane rests, its brightness
    // eased to the profile's mean by hc, an even glow with no traveling streaks (acRest)
    var hcK = this.hc || 0, lutMean = P.floor + (1 - P.floor) * (this.ripMean || 0.4), hcLam = this.hcLam || lam, hl = this.hcLut, hfl = BEAM.PROFILES.stream.floor;
    var HLm1 = (DAYX.light.lv || LV) - 1;   // the HVDC pulse's own number of levels
    var gsig = '', glk = [], i;
    for (i = 0; i < this.lanes.length; i++) {
      var L = this.lanes[i];
      if (!L.n || (hcOnly && !L.lkey)) continue;
      var lk = laneK ? laneK(L.ln) : 1;
      // the glow floor: every conductor in service, steady, at three strengths (its paths are kept until a level changes)
      var gl = L.g > 0.02 ? Math.max(1, Math.round(L.g * lk * GL)) : 0;
      glk.push(gl); gsig += gl;
      var hcLane = hcK > 0 && L.ln.w === 'dc' && !!L.ln.src && L.ln.src.el !== 'none';
      L.hc = null;
      if (hcLane) {
        // the pulse inside the body: the stream profile (sharp head, exponential tail, floor removed) with the wavelength
        // hcLam, moving with the lane's own offset (its speed, DAYX.light), oriented by the flow and cross-faded near zero
        // speed (flipV), so a reversal never flips it in one frame; segments of one level joined into one path per level
        var wq = clamp(0.5 + L.v / (2 * BEAM.EASE.flipV), 0, 1), hcP = {}, xq = ((L.lkey && this.hcOff[L.lkey] != null ? this.hcOff[L.lkey] : L.off) - 0.5 * L.ds) / hcLam, stq = L.ds / hcLam, runq = -1, pq = null, hnq = 1 / (1 - hfl);
        var hF = L.hcF || L.F, hPt = L.hcF ? L.hcPart : L.part;   // the HVDC light's own segments
        xq -= Math.floor(xq);
        // each segment sampled DAYX.light.sub times (a cut segment once), so a short dash slides smoothly
        for (var jq = 0; jq < L.n; jq++) {
          var cutq = hPt && hPt[jq], nsq = cutq ? 1 : DAYX.light.sub || 1, x0q = L.X[jq], y0q = L.Y[jq], dxq = L.X[jq + 1] - x0q, dyq = L.Y[jq + 1] - y0q;
          for (var sq = 0; sq < nsq; sq++) {
            var bq;
            if (wq >= 1) bq = hl[(xq * NL) | 0];
            else { var xmq = 1 - xq; if (xmq >= 1) xmq -= 1; bq = wq <= 0 ? hl[(xmq * NL) | 0] : wq * hl[(xq * NL) | 0] + (1 - wq) * hl[(xmq * NL) | 0]; }
            xq -= stq / nsq; if (xq < 0) xq += 1;
            var lq = Math.min(HLm1, (Math.max(0, (bq - hfl) * hnq) * hF[jq] * HLm1 + 0.5) | 0);
            if (lq <= 0) { runq = -1; continue; }
            if (cutq) {
              var pcq = cutq;
              pq = hcP[lq] || (hcP[lq] = new global.Path2D());
              for (var rq = 0; rq < pcq.length; rq++) { pq.moveTo(x0q + dxq * pcq[rq][0], y0q + dyq * pcq[rq][0]); pq.lineTo(x0q + dxq * pcq[rq][1], y0q + dyq * pcq[rq][1]); }
              runq = pcq[pcq.length - 1][1] >= 1 - 1e-4 ? lq : -1;
              continue;
            }
            if (lq !== runq) { pq = hcP[lq] || (hcP[lq] = new global.Path2D()); var e9 = 0.5 / Math.max(1e-6, Math.hypot(dxq, dyq)); pq.moveTo(x0q + dxq * (sq / nsq - e9), y0q + dyq * (sq / nsq - e9)); runq = lq; }   // half a px of overlap
            pq.lineTo(x0q + dxq * (sq + 1) / nsq, y0q + dyq * (sq + 1) / nsq);
          }
        }
        L.hc = { P: hcP, keys: Object.keys(hcP).map(Number), lk: lk };
      }
      if (hcOnly || L.a < 0.01) continue;
      // an asymmetric profile follows the sign of the speed; near zero speed the two orientations cross-fade, so a
      // reversal never flips the streaks in one frame
      var w = P.symmetric ? 1 : clamp(0.5 + L.v / (2 * BEAM.EASE.flipV), 0, 1), a = L.a * lk * Lm1 * (hcLane ? 1 - hcK : 1);   // a DC pole's flow light gives way to the HVDC light
      var hot = L.hot, parts = hot <= 0 ? [[0, 1]] : hot >= 1 ? [[1, 1]] : [[0, 1 - hot], [1, hot]];
      var X = L.X, Y = L.Y, F = L.F, n = L.n, step = L.ds / lam, x0 = (L.off - 0.5 * L.ds) / lam, Pt = L.part;
      x0 -= Math.floor(x0);
      // the sweep: a soft band moving from the upstream end to the downstream end
      var sw = L.sw, sc = -1, sww = 0, swd = 1;
      if (sw) { var u = (t - sw.t0) / sw.dur; if (u > 1.2) L.sw = null; else if (u >= 0) { sww = Math.max(SW.minW, SW.width * L.len); sc = -sww + u * (L.len + 2 * sww); swd = L.v >= 0 ? 1 : -1; } }
      var hb = L.held ? (DCL.cal.indexOf(this.dcm) >= 0 ? DCL.levelR : DCL.level) : -1;   // a held DC pole is even along its length (no traveling texture)
      var hr = hb >= 0 && this.dcm === 'drift' ? DCL.rip : 0, hf = P.floor, hn = 1 / (1 - hf);   // drift's ripple depth
      if (hr) hb /= 1 - hr * (1 - this.ripMean);   // the same mean light as held
      var acRest = hcK > 0 && L.ln.w !== 'dc' ? hcK : 0;   // an AC lane at rest in the HVDC hover
      for (var q = 0; q < parts.length; q++) {
        var keyBase = (L.kind * 2 + parts[q][0]) * LV, ak = a * parts[q][1], run = -1, path = null, xp = x0;
        for (var j = 0; j < n; j++) {
          var b;
          if (hb >= 0 && !hr) b = hb;
          else if (w >= 1) b = lut[(xp * NL) | 0];
          else { var xm = 1 - xp; if (xm >= 1) xm -= 1; b = w <= 0 ? lut[(xm * NL) | 0] : w * lut[(xp * NL) | 0] + (1 - w) * lut[(xm * NL) | 0]; }
          if (hr) b = hb * (1 - hr + hr * (b - hf) * hn);   // drift: the streak shape at depth hr, moving with the flow
          if (acRest) b += (lutMean - b) * acRest;
          xp -= step; if (xp < 0) xp += 1;
          if (sc > -sww) { var sj = swd > 0 ? (j + 0.5) * L.ds : L.len - (j + 0.5) * L.ds, dz = (sj - sc) / sww; b *= 1 + (sw.g || SW.gain) * Math.exp(-dz * dz); }
          var lv = Math.min(Lm1, (b * ak * F[j] + 0.5) | 0);
          if (lv <= 0) { run = -1; continue; }
          if (Pt && Pt[j]) {   // a segment cut by a hidden stretch: its visible pieces only
            var pc = Pt[j], dx = X[j + 1] - X[j], dy = Y[j + 1] - Y[j];
            path = B[keyBase + lv] || (B[keyBase + lv] = new global.Path2D());
            for (var r = 0; r < pc.length; r++) { path.moveTo(X[j] + dx * pc[r][0], Y[j] + dy * pc[r][0]); path.lineTo(X[j] + dx * pc[r][1], Y[j] + dy * pc[r][1]); }
            run = pc[pc.length - 1][1] >= 1 - 1e-4 ? lv : -1;
            continue;
          }
          if (lv !== run) {
            path = B[keyBase + lv] || (B[keyBase + lv] = new global.Path2D());
            path.moveTo(X[j], Y[j]);
            run = lv;
          }
          path.lineTo(X[j + 1], Y[j + 1]);
        }
      }
    }
    if (hcOnly) return;
    if (!this.glow || this.glow.sig !== gsig) {
      var G = {}, j = 0;
      for (i = 0; i < this.lanes.length; i++) {
        var Lg = this.lanes[i];
        if (!Lg.n) continue;
        var g2 = glk[j++];
        if (g2) { var gk = Lg.kind * (GL + 1) + g2; (G[gk] || (G[gk] = new global.Path2D())).addPath(Lg.path); }
      }
      this.glow = { sig: gsig, G: G, gkeys: Object.keys(G).map(Number) };
    }
    this.cache = { B: B, keys: Object.keys(B).map(Number).sort(function (x, y) { return x - y; }), G: this.glow.G, gkeys: this.glow.gkeys };
    this.stats.builds++;
  };
  // t: seconds (the rebuild rate and the sweeps); laneK: see build
  Beams.prototype.draw = function (ctx, dpr, t, laneK) {
    if (!this.pal) return;
    // rebuilt also at once when the overload red has just gone out (redK 0), so no warm stroke outlives it in the cache
    var rkNow = this.redK == null ? 1 : this.redK, rkGone = rkNow === 0 && this.redKb !== 0 && this.redKb != null;
    if (!this.cache || rkGone || t - this.lastBuild >= 1 / BEAM.REBUILD - 0.004 || t < this.lastBuild) { this.build(t, laneK); this.lastBuild = t; this.lastHc = t; this.redKb = rkNow; }
    // while the HVDC color is up, the four DC poles' pulse paths are rebuilt at 30/s on their own (hcOnly), so the HVDC
    // light glides; the rest of the flow light keeps its 15 rebuilds a second
    else if (this.hc > 0 && t - (this.lastHc || 0) >= 1 / 30 - 0.004) { this.build(t, laneK, true); this.lastHc = t; }
    var pal = this.pal, s = this.scale, C = this.cache, LV = BEAM.LEVELS, Lm1 = LV - 1, GL = BEAM.GLOW_LV, strokes = 0, q, kk, kind;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = pal.blend;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    // the glow floor (steady): a faint core, and in dark a faint halo
    for (var gp = 0; gp < 2 && !this.dcOnly; gp++) {
      if (!gp && pal.glowHalo <= 0) continue;
      for (q = 0; q < C.gkeys.length; q++) {
        kk = C.gkeys[q]; var gl = kk % (GL + 1); kind = BEAM.KINDS[(kk - gl) / (GL + 1)];
        ctx.lineWidth = BEAM.KIND_W[kind] * s * (gp ? pal.coreW : pal.haloW);
        ctx.strokeStyle = gp ? this.coreCol[2] : pal.halo;
        ctx.globalAlpha = (gp ? pal.glow : pal.glowHalo) * gl / GL;
        ctx.stroke(C.G[kk]); strokes++;
      }
    }
    for (var pass = 0; pass < 2 && !this.dcOnly; pass++) {
      for (q = 0; q < C.keys.length; q++) {
        kk = C.keys[q]; var lvl = kk % LV, kh = (kk - lvl) / LV, hot = kh % 2;
        kind = BEAM.KINDS[(kh - hot) / 2];
        if (!pass && lvl < BEAM.HALO_MIN) continue;
        ctx.lineWidth = BEAM.KIND_W[kind] * s * (pass ? pal.coreW : pal.haloW * (dcPairOf(this.dcm) && kind === 'dc' ? (pal.blend === 'lighter' ? DCL.halo : DCL.haloA) : 1));
        ctx.strokeStyle = pass ? (hot ? pal.hotCore : this.coreCol[lvl]) : (hot ? pal.hot : pal.halo);
        ctx.globalAlpha = Math.min(1, (pass ? pal.coreA : pal.haloA * (hot ? 1.5 : 1)) * lvl / Lm1);
        ctx.stroke(C.B[kk]); strokes++;
      }
    }
    // The HVDC hover's light on each DC pole, over the flow light: an even body in the HVDC color along the pole's path
    // (opaque in the light theme, source-over), its width from the pole's power, then the pale pulse inside it (the beams'
    // blend), brighter on the link that carries more; no halo. The body stays at full strength at any power, so the
    // interconnector does not blink at a reversal (it would read as a switch thrown); only the pulse fades out near zero
    // power. Edges, then bodies, then pulses, each over all the poles, so no pole's body covers its partner's pulse where
    // the two lie close (phones)
    var hcK = this.hc || 0, dcp = pal.dc, HL = DAYX.light, HLm1 = (HL.lv || LV) - 1, hcD = [];
    this.qaHc = hcK > 0 ? [] : null;
    if (hcK > 0 && dcp) for (var ih = 0; ih < this.lanes.length; ih++) {
      var Lh = this.lanes[ih];
      if (!Lh.hc || !(Lh.hcPath || Lh.path)) continue;
      var ldh = clamp(Lh.ld || 0, 0, 1), obq = hcK * Lh.hc.lk, opq = obq * clamp(ldh / HL.full, 0, 1), bwq = dcp.bodyW * (0.75 + 0.5 * ldh) * (this.hcBodyK || 1);
      this.qaHc.push([Lh.ln.id, +ldh.toFixed(5), +Lh.v.toFixed(3), +opq.toFixed(4), Lh.hc.keys.length ? Math.max.apply(null, Lh.hc.keys) : 0, +obq.toFixed(4)]);
      if (obq >= 0.004) hcD.push([Lh, ldh, obq, opq, bwq]);
    }
    if (hcD.length) {
      // a link's two poles take one body path (one stroke), so where they lie close (phones) a translucent body (dark) is not drawn twice
      // over itself and the pair reads as one cable
      var wq = BEAM.KIND_W.dc * s, pq9, Dq, G9 = {}, gk9 = [];
      for (pq9 = 0; pq9 < hcD.length; pq9++) { Dq = hcD[pq9]; var k9 = Dq[0].lkey || Dq[0].ln.id; if (!G9[k9]) { G9[k9] = { p: new global.Path2D(), d: Dq }; gk9.push(k9); } G9[k9].p.addPath(Dq[0].hcPath || Dq[0].path); }
      ctx.globalCompositeOperation = 'source-over';
      // in the light theme a thin dark edge under the body (dcEdge, dcEdgeW x KIND_W.dc x the map scale each side), so the
      // link stays at 3:1 or more against the receded ground as the eye averages it, its pale light included; dark has none
      // (dcEdgeW 0)
      if (dcp.edgeW > 0) for (pq9 = 0; pq9 < gk9.length; pq9++) { Dq = G9[gk9[pq9]].d; ctx.lineWidth = wq * (Dq[4] + 2 * dcp.edgeW); ctx.strokeStyle = dcp.edge; ctx.globalAlpha = Math.min(1, Dq[2] * dcp.bodyA); ctx.stroke(G9[gk9[pq9]].p); strokes++; }
      for (pq9 = 0; pq9 < gk9.length; pq9++) { Dq = G9[gk9[pq9]].d; ctx.lineWidth = wq * Dq[4]; ctx.strokeStyle = dcp.body; ctx.globalAlpha = Math.min(1, Dq[2] * dcp.bodyA); ctx.stroke(G9[gk9[pq9]].p); strokes++; }
      // on phones (DAYX.light.one) a link carries one pulse, on its first pole, so the band the two poles form reads as one
      // cable with one light and stays at 3:1 against the receded ground as the eye averages it (two pulses side by side
      // would pale it)
      ctx.globalCompositeOperation = pal.blend; ctx.lineWidth = wq * dcp.pulseW; ctx.strokeStyle = dcp.pulse;
      var one9 = {};
      for (pq9 = 0; pq9 < hcD.length; pq9++) {
        Dq = hcD[pq9];
        if (Dq[3] < 0.004) continue;
        if (this.hcOne && Dq[0].lkey) { if (one9[Dq[0].lkey]) continue; one9[Dq[0].lkey] = 1; }
        var brq = dcp.lo + (1 - dcp.lo) * Math.min(1, Dq[1] / 0.7);   // from dcPulseLo up
        for (var kq = 0; kq < Dq[0].hc.keys.length; kq++) {
          var lvq = Dq[0].hc.keys[kq];
          ctx.globalAlpha = Math.min(1, Dq[3] * Math.min(1, 1.15 * lvq / HLm1) * brq); ctx.stroke(Dq[0].hc.P[lvq]); strokes++;
        }
      }
    }
    ctx.globalCompositeOperation = pal.blend;
    // tints: the lane takes the pool's color while it drains
    for (var i = 0; i < this.lanes.length && !this.dcOnly; i++) {
      var L = this.lanes[i];
      if (!L.tint || !L.path) continue;
      var col = L.tint.col === 'dear' ? pal.dear : pal.cheap, w = BEAM.KIND_W[BEAM.KINDS[L.kind]] * s, lk = laneK ? laneK(L.ln) : 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = w * pal.haloW * 1.1; ctx.globalAlpha = 0.45 * L.tint.k * lk; ctx.stroke(L.path);
      ctx.lineWidth = w * pal.coreW * 1.2; ctx.globalAlpha = 0.95 * L.tint.k * lk; ctx.stroke(L.path);
      strokes += 2;
    }
    ctx.restore();
    this.stats.strokes = strokes;
  };

  function LINE_LIMIT() { var V = global.StudioViews; return V && V.line ? V.line.limit : (1 - LINE.axis[0]) / (LINE.axis[1] - LINE.axis[0]); }

  // The hybrid view's fans: forecast profiles per unit of full output, as hourly knots 00..24 (the wind days are
  // illustrative, the solar days real); the spread around them is measured (the engine's cloud tables).
  function bell(pk, cl, side) {
    var out = [], h, s, m;
    for (h = 0; h <= 24; h++) {
      s = (h - 5.5) / 16; s = s <= 0 || s >= 1 ? 0 : Math.pow(Math.sin(Math.PI * s), 1.5);
      m = side === 0 ? 1 : side > 0 ? (h < 13.5 ? cl + (1 - cl) * Math.max(0, (h - 9) / 4.5) : 1) : (h > 13.5 ? Math.max(0.55, 1 - (h - 13.5) / 9) : 1);
      out.push(+(pk * s * m).toFixed(3));
    }
    return out;
  }
  var DAYS = {
    offshore: [
      [0.30, 0.28, 0.25, 0.22, 0.20, 0.18, 0.17, 0.17, 0.18, 0.20, 0.24, 0.30, 0.38, 0.47, 0.56, 0.65, 0.73, 0.79, 0.83, 0.85, 0.86, 0.86, 0.85, 0.84, 0.83],   // a front arrives
      [0.83, 0.84, 0.85, 0.85, 0.84, 0.83, 0.81, 0.79, 0.76, 0.72, 0.68, 0.64, 0.61, 0.59, 0.58, 0.58, 0.59, 0.61, 0.63, 0.66, 0.68, 0.70, 0.71, 0.72, 0.72],   // windy, easing
      [0.72, 0.70, 0.67, 0.64, 0.60, 0.55, 0.50, 0.45, 0.40, 0.35, 0.31, 0.27, 0.24, 0.21, 0.19, 0.17, 0.16, 0.15, 0.15, 0.16, 0.18, 0.20, 0.22, 0.24, 0.25],   // calming
      [0.42, 0.44, 0.46, 0.48, 0.50, 0.51, 0.50, 0.48, 0.45, 0.42, 0.40, 0.39, 0.40, 0.42, 0.45, 0.48, 0.51, 0.53, 0.54, 0.53, 0.51, 0.48, 0.45, 0.43, 0.42],   // moderate
      [0.36, 0.38, 0.41, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.74, 0.78, 0.81, 0.84, 0.86, 0.88, 0.90, 0.91, 0.92, 0.93, 0.93, 0.93, 0.93, 0.92, 0.92, 0.91],   // a storm builds
      [0.88, 0.80, 0.70, 0.58, 0.46, 0.35, 0.26, 0.19, 0.14, 0.10, 0.07, 0.05, 0.05, 0.05, 0.06, 0.07, 0.09, 0.11, 0.14, 0.17, 0.20, 0.23, 0.26, 0.28, 0.30],   // it passes at night; calm by noon
      [0.32, 0.40, 0.50, 0.60, 0.68, 0.74, 0.77, 0.78, 0.78, 0.76, 0.73, 0.70, 0.66, 0.62, 0.58, 0.54, 0.50, 0.46, 0.43, 0.40, 0.37, 0.35, 0.33, 0.31, 0.30]    // a gale in the small hours, easing
    ],
    onshore: [
      [0.12, 0.11, 0.10, 0.10, 0.10, 0.11, 0.12, 0.14, 0.17, 0.21, 0.26, 0.31, 0.36, 0.41, 0.46, 0.50, 0.54, 0.57, 0.59, 0.60, 0.60, 0.59, 0.58, 0.57, 0.56],
      [0.56, 0.55, 0.54, 0.53, 0.51, 0.49, 0.46, 0.43, 0.40, 0.38, 0.36, 0.35, 0.34, 0.34, 0.35, 0.36, 0.37, 0.38, 0.38, 0.37, 0.35, 0.33, 0.31, 0.29, 0.28],
      [0.28, 0.27, 0.26, 0.25, 0.24, 0.23, 0.22, 0.21, 0.20, 0.19, 0.18, 0.17, 0.16, 0.15, 0.14, 0.13, 0.13, 0.12, 0.12, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17],
      [0.20, 0.22, 0.24, 0.27, 0.30, 0.33, 0.35, 0.36, 0.36, 0.35, 0.33, 0.31, 0.30, 0.30, 0.31, 0.33, 0.36, 0.39, 0.41, 0.42, 0.41, 0.39, 0.36, 0.33, 0.30],
      [0.28, 0.25, 0.22, 0.19, 0.16, 0.13, 0.11, 0.09, 0.08, 0.07, 0.06, 0.05, 0.05, 0.04, 0.04, 0.04, 0.05, 0.06, 0.08, 0.10, 0.13, 0.16, 0.19, 0.22, 0.25],   // still, high pressure
      [0.25, 0.25, 0.26, 0.27, 0.28, 0.30, 0.32, 0.35, 0.39, 0.44, 0.50, 0.57, 0.64, 0.71, 0.77, 0.81, 0.82, 0.79, 0.72, 0.62, 0.50, 0.38, 0.27, 0.18, 0.12],   // a squall line in the afternoon
      [0.12, 0.14, 0.17, 0.21, 0.26, 0.32, 0.39, 0.47, 0.55, 0.62, 0.67, 0.70, 0.71, 0.70, 0.67, 0.62, 0.56, 0.49, 0.42, 0.35, 0.29, 0.24, 0.19, 0.15, 0.12]    // a fresh westerly by day
    ],
    // Seven real days with different skies (Elia, region Belgium, 2026): the day-ahead forecast issued at 11:00 (the
    // forecast type of the engine's cloud tables), per unit of the installed capacity in the data (11,763.7 MW for
    // 26 Apr, 3 May and 11 May; 12,128.3 MW for the other four), on Brussels local time (Elia's timestamps are UTC),
    // as hourly knots: each knot is the mean of the forecast's four quarter-hours from h - 0:30 to h + 0:15, an hourly
    // mean centered on the hour. Peaks stay within the measured table (its last bin with data is 0.73). Each day folds
    // at an hour where it is telling (HYB_HOURS).
    solar: [
      [0, 0, 0, 0, 0, 0, 0, 0.016, 0.085, 0.229, 0.386, 0.508, 0.611, 0.675, 0.683, 0.642, 0.558, 0.448, 0.297, 0.121, 0.026, 0.001, 0, 0, 0],   // 26 Apr 2026: clear spring day (peak 0.68 at 14 h)
      [0, 0, 0, 0, 0, 0, 0, 0.02, 0.069, 0.117, 0.151, 0.173, 0.185, 0.185, 0.172, 0.169, 0.169, 0.148, 0.113, 0.073, 0.028, 0.002, 0, 0, 0],    // 3 May 2026: overcast all day, low and flat (0.19)
      [0, 0, 0, 0, 0, 0, 0, 0, 0.011, 0.054, 0.11, 0.181, 0.267, 0.331, 0.371, 0.395, 0.364, 0.286, 0.161, 0.042, 0, 0, 0, 0, 0],                // 20 Sep 2026: morning cloud clearing, sun in the afternoon (0.40 at 15 h)
      [0, 0, 0, 0, 0, 0, 0, 0.004, 0.058, 0.161, 0.254, 0.299, 0.271, 0.226, 0.181, 0.147, 0.117, 0.089, 0.061, 0.033, 0.008, 0, 0, 0, 0],      // 29 Aug 2026: clouding over from late morning (0.30 at 11 h)
      [0, 0, 0, 0, 0, 0, 0, 0, 0.001, 0.099, 0.266, 0.397, 0.484, 0.515, 0.495, 0.444, 0.349, 0.217, 0.073, 0, 0, 0, 0, 0, 0],               // 14 Oct 2026: clear autumn day, short (0.52 at 13 h)
      [0, 0, 0, 0, 0, 0, 0.008, 0.042, 0.115, 0.219, 0.284, 0.275, 0.231, 0.204, 0.211, 0.267, 0.331, 0.346, 0.3, 0.19, 0.073, 0.024, 0.001, 0, 0],      // 2 Jul 2026: showers around noon, two humps (0.28 at 10 h, 0.35 at 17 h)
      [0, 0, 0, 0, 0, 0, 0.001, 0.029, 0.086, 0.174, 0.272, 0.353, 0.399, 0.39, 0.331, 0.272, 0.256, 0.256, 0.218, 0.129, 0.047, 0.007, 0, 0, 0]       // 11 May 2026: broken cloud, a peak at noon, a ragged afternoon (0.40)
    ]
  };

  function smooth5(p) { p = clamp(p, 0, 1); return p * p * p * (p * (p * 6 - 15) + 10); }
  // base64 of little-endian uint16 (hero-shapes.json) to a Uint16Array
  function decodeU16(s) {
    var b = global.atob(s), n = b.length >> 1, out = new Uint16Array(n), i;
    for (i = 0; i < n; i++) out[i] = b.charCodeAt(2 * i) | (b.charCodeAt(2 * i + 1) << 8);
    return out;
  }
  // The cloud's conditional outcome tables, read as the engine reads them: per forecast bin a
  // 64-point outcome quantile table extended by the 12 tail ranks; interpolation in the forecast.
  function cloudTable(shapes, id) {
    var st = shapes.states[id], nb = st.bins.count, w = st.bins.width, lo = st.bins.lo, lastHi = st.bins.last_hi;
    var raw = decodeU16(st.q), nq = raw.length / nb, tv = st.tail_v || [], rt = st.q_tail ? decodeU16(st.q_tail) : null, b, j;
    var vx = [], tLo = [], tHi = [];
    if (rt) for (j = 0; j < tv.length; j++) { if (tv[j] < 0.5 / nq) tLo.push(j); else if (tv[j] > 1 - 0.5 / nq) tHi.push(j); }
    tLo.forEach(function (k) { vx.push(tv[k]); });
    for (j = 0; j < nq; j++) vx.push((j + 0.5) / nq);
    tHi.forEach(function (k) { vx.push(tv[k]); });
    var nx = vx.length, qx = new Float32Array(nb * nx), c = new Float32Array(nb), has = new Uint8Array(nb), o, k2;
    for (b = 0; b < nb; b++) {
      o = b * nx; k2 = 0;
      tLo.forEach(function (k) { qx[o + k2++] = rt[b * tv.length + k] / 65535; });
      for (j = 0; j < nq; j++) qx[o + k2++] = raw[b * nq + j] / 65535;
      tHi.forEach(function (k) { qx[o + k2++] = rt[b * tv.length + k] / 65535; });
      c[b] = lo + (b + 0.5) * w; if (b === nb - 1) c[b] = (lo + b * w + lastHi) / 2;
      has[b] = st.n[b] > 0 ? 1 : 0;
    }
    return { nb: nb, w: w, lo: lo, lastHi: lastHi, vx: vx, nx: nx, qx: qx, c: c, has: has, n: st.n };
  }
  function binQ(T, b, v) {
    var vx = T.vx, n = T.nx, o = b * n, lo = 0, hi = n - 1, mid;
    if (v <= vx[0]) return T.qx[o];
    if (v >= vx[n - 1]) return T.qx[o + n - 1];
    while (hi - lo > 1) { mid = (lo + hi) >> 1; if (vx[mid] <= v) lo = mid; else hi = mid; }
    return T.qx[o + lo] + (v - vx[lo]) / (vx[hi] - vx[lo]) * (T.qx[o + hi] - T.qx[o + lo]);
  }
  // outcome (0..1) at forecast f for outcome rank v; below the first bin with data (solar at night)
  // the outcome falls linearly to 0 with the forecast
  function cloudQ(T, f, v) {
    var b0 = 0; while (b0 < T.nb - 1 && !T.has[b0]) b0++;
    if (f <= T.c[b0]) { var y0 = binQ(T, b0, v); return T.c[b0] > 0 ? y0 * clamp(f / T.c[b0], 0, 1) : y0; }
    var b = clamp(Math.floor((f - T.lo) / T.w), 0, T.nb - 1), a, t;
    while (b > 0 && !T.has[b]) b--;
    a = f < T.c[b] ? b - 1 : b + 1;
    if (a < 0 || a >= T.nb || !T.has[a]) return binQ(T, b, v);
    t = clamp((f - T.c[b]) / (T.c[a] - T.c[b]), 0, 1);
    return (1 - t) * binQ(T, b, v) + t * binQ(T, a, v);
  }
  // Monotone cubic (Fritsch-Carlson) through the hourly knots, tabulated every 0.05 h.
  function tabulate(knots) {
    var n = knots.length, dl = [], m = [], k, out = new Float32Array(481), i, h, t, a, b;
    for (k = 0; k < n - 1; k++) dl.push(knots[k + 1] - knots[k]);
    m[0] = dl[0]; m[n - 1] = dl[n - 2];
    for (k = 1; k < n - 1; k++) m[k] = dl[k - 1] * dl[k] <= 0 ? 0 : (dl[k - 1] + dl[k]) / 2;
    for (k = 0; k < n - 1; k++) {
      if (dl[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
      a = m[k] / dl[k]; b = m[k + 1] / dl[k];
      if (a * a + b * b > 9) { var tt = 3 / Math.sqrt(a * a + b * b); m[k] = tt * a * dl[k]; m[k + 1] = tt * b * dl[k]; }
    }
    for (i = 0; i <= 480; i++) {
      h = i / 20; k = Math.min(23, Math.floor(h)); t = h - k;
      out[i] = Math.max(0, (2 * t * t * t - 3 * t * t + 1) * knots[k] + (t * t * t - 2 * t * t + t) * m[k] + (-2 * t * t * t + 3 * t * t) * knots[k + 1] + (t * t * t - t * t) * m[k + 1]);
    }
    return out;
  }
  function fAt(tab, hour) { var x = clamp(hour, 0, 24) * 20, i = Math.min(479, Math.floor(x)), t = x - i; return tab[i] + t * (tab[i + 1] - tab[i]); }

  // ── The hybrid view, "fold and turn".
  //
  // Each source field shows the day ahead as a fan of particles (x: the hour, y: output; the brighter core is the
  // ranks 0.1-0.9, the P10-P90 band). Now and then one panel's fan folds onto one hour: every particle keeps its
  // outcome rank and slides to that hour's column, where the particles stack sideways into that hour's
  // distribution (output still vertical). The stack then makes a rigid quarter turn about its center and lands as
  // an upright distribution (output across: no output at the left wall, full output at the right wall). In some
  // slots it then rises into the forecast-outcome cloud: x stays the outcome, the stack height becomes the forecast
  // level. Everything runs back the same way. The field's own edges turn with the particles (the fan's floor and
  // ceiling become the two walls, the stack's base the floor) and glow where particles press on them. No word,
  // cursor or marker.
  //
  // Rank roles: in the fan a particle's u is its time rank and v its outcome rank; in the distribution v stays the
  // outcome rank and 1 - u becomes its height in the stack; in the cloud 1 - u becomes its forecast rank. Each move
  // keeps one coordinate's meaning. Deterministic (ranks(), no Math.random).
  //
  // HYB, the slot timetable (extend, phase): one panel moves at a time, six slots (offshore, onshore, solar, twice;
  // cloud in every second slot of each panel, onshore first). After its slot a panel changes its day (a 3.4 s wave
  // from morning to night) and the scene rests 2.6 s before the next panel. Durations in s. The hour each slot folds
  // onto is HYB_HOURS[tech][day].
  var HYB = { start: 6.0, wave: 3.4, rest: 2.6, fold: 2.8, turn: 2.4, pdf: 6.5, pdfB1: 3.4, rise: 3.0, cloud: 5.0, fall: 3.0, pdfB2: 2.4, stagger: 0.35, cells: 40, days: 4 };
  var HYB_ORDER = [['offshore', false], ['onshore', true], ['solar', false], ['offshore', true], ['onshore', false], ['solar', true]];
  // Seven days per panel (a prime number, so the folds visit every day whatever the number of day waves between two
  // folds). Each day folds at an hour where it is telling: the last three wind days fold near full output (offshore
  // 0.93; onshore 0.82), near no output (0.05; 0.04) and high (0.78; 0.70); the solar days fold at 13.5 (clear
  // spring, 0.68), 12.5 (overcast, 0.19), 15.0 (the afternoon after the morning cloud cleared, 0.40), 16.0 (the
  // afternoon after it clouded over, 0.12), 13.0 (the clear autumn day at its peak, 0.52), 13.0 (the showers' midday
  // dip, 0.20) and 12.0 (broken cloud, the noon peak, 0.40)
  var HYB_HOURS = { offshore: [20.5, 13.0, 17.5, 16.0, 19.0, 12.0, 8.0], onshore: [19.5, 13.0, 17.0, 19.0, 14.0, 16.0, 11.0], solar: [13.5, 12.5, 15.0, 16.0, 13.0, 13.0, 12.0] };
  var HYB_MOVES = { fold: 1, turn: 1, rise: 1, fall: 1, unturn: 1, unfold: 1 };
  // HYB6 (extend6, phase6):
  //  - each fan changes its day on its own clock (solar every 12 s, onshore 14 s, offshore 16 s, start to start, when
  //    free): a 3.0 s wave, never two waves at once, never on the panel that is folded, never in the hero's windows; a
  //    wave may run while another panel folds or holds (it is small: the fan reshapes in place);
  //  - the moves: fold 2.4 s, turn 2.2 s, rise and fall 2.6 s; the holds: the distribution 4.6 s, the cloud 4.2 s;
  //    1.2 s between slots and no wave inside the slot sequence; one large move (fold, turn, rise, fall and back) at
  //    a time;
  //  - the solar panel folds first (13 s).
  var HYB6 = { start: 13.0, fold: 2.4, turn: 2.2, pdf: 4.6, pdfB1: 2.6, rise: 2.6, cloud: 4.2, fall: 2.6, pdfB2: 2.0, rest: 1.2,
    wave: 3.0, gap: 0.4, clock: { solar: 12.0, onshore: 14.0, offshore: 16.0 }, first: { onshore: 1.0, offshore: 14.0, solar: 27.0 } };
  var HYB6_ORDER = [['solar', false], ['offshore', true], ['onshore', false], ['solar', true], ['offshore', false], ['onshore', true]];
  var HYB_TECHS = ['solar', 'onshore', 'offshore'];
  function hybDays(tech) { return DAYS[tech].length; }
  // HYB7 (extend7, phase7):
  //  - the offshore field leads the order and folds at once (first: 0.8 s after the figure is on screen);
  //  - a day change sweeps across the day with a visible front, morning first (each particle changes within 35 % of the
  //    wave and the front crosses the day in the rest), in 2.2 s;
  //  - the offshore fan changes its day once it has been still for 4.5 s (idle), or earlier (from idleMin, 2 s) when
  //    that keeps it clear of a quiet window or of its own next slot, and 2.5 s (after) after its own slot ends; the
  //    last day change before a quiet window ends just before it; its holds (the distribution, the cloud) never last
  //    longer than holdMax (offshore 7.6 s): a slot whose hold a quiet window would stretch further starts later, and
  //    the fan changes its day meanwhile; a slot that would end too close before a window for a day change to follow
  //    holds a little longer and ends just before it. The days of each fan follow DAY_ORDER7;
  //  - onshore and solar change their day on their own clocks (11 s) when the offshore fan does not need the turn
  //    (offshore wins a tie within lead, 1.5 s); one large move at a time, never two waves at once, nothing in the
  //    hero's quiet windows;
  //  - nothing else changes before the offshore fold has closed; a panel's day change ends at least gapSlot (1.5 s)
  //    before its own fold, and keeps clear (by `clear`) of the other panels' large moves: onshore and solar wait for
  //    them while still for less than `starve` s, and then go ahead of offshore's lead; offshore moves within its cap
  //    when it can;
  //  - the second slot waits until after the hero's second window (defer1), so that stretch carries day waves, one
  //    panel at a time; solar's first day change does not wait for the offshore turn (force); on a tie the panel that
  //    has been still longer goes first (tieStill).
  // Deterministic: a pure function of the scene's time.
  var HYB7 = { fold: 2.4, turn: 2.2, pdf: 4.6, pdfB1: 2.6, rise: 2.6, cloud: 4.2, fall: 2.6, pdfB2: 2.0, rest: 1.2,
    wave: 2.2, front: 0.65, gap: 0.3, gapSlot: 1.5, after: 2.5, lead: 1.5, holdMax: { offshore: 7.6, onshore: 9.6, solar: 9.6 },
    first: 0.8, firstWave: { offshore: 0, onshore: 17.6, solar: 3.4 }, idle: 4.5, idleMin: 2.0, clock: { onshore: 11.0, solar: 11.0 },
    clear: 0.2, starve: 18.0, defer1: 35.8, force: { solar: true }, tieStill: true };
  // offshore leads; each panel folds in every third slot (about every 80 s), the cloud in every second slot of each panel
  var HYB7_ORDER = [['offshore', false], ['solar', false], ['onshore', true], ['offshore', true], ['solar', true], ['onshore', false]];
  // the order in which a fan walks through its days: consecutive days far apart (the offshore order keeps the mean
  // difference of consecutive days' forecasts at 0.29 of full output or more, the onshore one at 0.17 or more); the
  // solar fan opens on the broken-cloud day 11 May (day 6)
  var DAY_ORDER7 = { offshore: [0, 1, 2, 4, 3, 5, 6], onshore: [0, 6, 3, 4, 5, 2, 1], solar: [6, 0, 1, 5, 2, 3, 4] };
  // HYB8, the default timetable (extend8, phase8): one fixed timetable that repeats every HYB8.period s (two hero
  // loops, so the hero's windows fall at the same places in every period), a precomputed table that meets these
  // rules:
  //  - every panel changes (a fold, turn, unturn, unfold, rise, fall or a day wave) at least every 8.0 s: no hold and no
  //    rest lasts longer; the offshore field folds at 0.8 s and holds its distribution through the first switching;
  //    onshore and solar change their day by 2.6 and 4.8 s;
  //  - every panel folds into its distribution three times a period and first lands by 24 s (offshore 5.4, solar
  //    19.2, onshore 23.7 s);
  //  - at most two panels move at once (a day wave counts), starts of motion of different panels are at least 1 s
  //    apart, and never are all three out of their fan at once (checked every 0.1 s), so one panel always shows its day;
  //  - nothing moves in the hero's quiet windows HYB8.quiet: [7.0, 12.3] of the 48 s loop (a second of calm before the
  //    breakers open at 8.0 s, the blades, the pair at 10.5 s and its rings to 11.8 s, then half a second) and [28.4,
  //    31.6] (the calm hour's ramp 28.4-29.6 s, the blades closing 30.0-30.8 s, the breakers 31.2 s); a panel holds its PDF
  //    through every switching and pair;
  //  - a day wave starts at least 1 s after its panel's unfold and ends at least 1.5 s before its fold;
  //  - the cloud sits on the solar field's second slot, once a period, with a PDF held before (3.1 s) and after (8.0 s).
  // Within those rules it keeps a distribution on screen as much of the time as it can (55 %), and then prefers less
  // time with two panels in large moves at once.
  // Day waves sweep with a front of 0.65 in 2.2 s. Deterministic: a pure function of the scene's time (no
  // Math.random). The timetable ignores M.setHybridQuiet (its windows are part of the table). The days: each fan
  // walks DAY_ORDER8, one day per wave; a slot folds the day shown.
  // blocks: one period per panel, "kind+start" in s: A a fold (2.4) and turn (2.2), then its PDF until the next block;
  // R a rise into the cloud, then the cloud until the next block; L a fall back, then the PDF; B an unturn (2.2) and
  // unfold (2.4); W a day wave (2.2). (A block may run past the period's end: solar's last unfold ends at 98.5 s.)
  var HYB8 = { period: 96, fold: 2.4, turn: 2.2, unturn: 2.2, unfold: 2.4, rise: 2.6, fall: 2.6, wave: 2.2, front: 0.65,
    quiet: { period: 48, windows: [[7.0, 12.3], [28.4, 31.6]] },
    blocks: {
      offshore: 'A0.8 B13.4 W20.1 W25.1 A34.8 B43.4 W50.1 W60.3 A67.1 B79.6 W87.6 W91.2',
      onshore: 'W2.6 W12.3 A19.1 B31.6 W40.1 A48.8 B61.4 W71.8 A81.1 B89.9',
      solar: 'W4.8 A14.6 B23.8 W32.6 A38.6 R46.3 L52.3 B62.9 W74.1 A84.2 B93.9'
    },
    // rest12 (alt8): the same rules, except that a resting fan (not a held distribution) may rest up to 12 s,
    // and the table then has fewer day waves: two panels move at once 32 % of the time (blocks: 40 %), a
    // distribution on screen 57 % (blocks: 55 %)
    rest12: {
      offshore: 'A0.8 B13.4 W20.8 A34.8 B43.9 W60.3 A67.1 B79.7 W88.1',
      onshore: 'W4.8 A19 B31.6 W41.6 A48.7 B61.3 W71.7 A81.1 B89.9',
      solar: 'W2.6 A12.3 B23.8 W32.6 A38.6 R46.3 L52.3 B62.9 W74 A84.3 B92.9'
    } };
  var DAY_ORDER8 = DAY_ORDER7;
  // The line field's fresh outcomes (every timetable but HYB). Six times per 48 s of the hero clock, outside its windows
  // (6-13 s, 28.4-33 s) and the line's own morph into the market hour (44-47 s), the field's outcomes are drawn anew from
  // the same distribution: a second engine field with its own scrambled Sobol' points (seed + 7) takes over particle by
  // particle over 1.8 s (each particle fades over 0.4 s at its own moment, a hash of its index, independent of its
  // rank); the next time the first field takes over again. The state, the shape and the share past the limit stay;
  // only which equally likely outcomes are shown changes. Not while a story or its crossfade runs, paused or reduced.
  var LINE_RD = { period: 48, at: [1.5, 15.0, 20.5, 26.0, 35.0, 40.5], dur: 1.8, fade: 0.4, seed: 7, levels: 4 };
  // The veil (html[data-veil] 1, the default; 0: none). In the light volumes the offshore field stands in the farm and
  // the rotors cover most of it on screen, so every field without a sheet (volumes and band) mutes what lies behind it:
  // a soft-edged fill in the board's own tone, after the live parts and the flow light and before the dots, so the
  // blades behind read faintly through it. Opacity at the center per field; the edge fades over grow (share of the
  // field's size) on either side of the field's outline.
  // The line field stands over DC-1's land cable and C's converter hall; a veil there would mute DC-1's drift form and
  // the hall, so the line field has none (0); its cone stays.
  var VEIL = { a: { offshore: 0.8, onshore: 0.6, solar: 0.3, line: 0 }, grow: 0.12, steps: 10 };
  // the lanes that keep their full light behind the line field (DC-1's land cable runs under half of it); beamsLayout
  // dims every other lane behind a field to 0.45, and all of them when this is null
  var BEAM_EX = { line: /^dc[12]-/ };
  // The hero's event windows, in s of the 48 s hero clock (the switching event at 8.0 and the redispatch pair at 10.5;
  // the calm hour's ramp from 28.4 and the line's return at 30.0-31.2). No panel moves (fold, turn, rise, fall, unturn,
  // unfold, day wave) inside them; a hold simply lasts longer. The hero clock runs on the hook's local time (t mod
  // period, as here); M.setHybridQuiet({ period, windows }) sets other windows.
  var HERO_QUIET = { period: 48, windows: [[6.0, 13.0], [28.4, 33.0]] };

  // The hybrid's timetable, a pure function of t built forward on demand and cached. Under HYB (extend, phase): slots
  // in HYB_ORDER, each move placed at the earliest time that keeps it clear of the quiet windows.
  function HybridSchedule(quiet, pace) {
    this.q = quiet && quiet.windows && quiet.windows.length ? quiet : null;
    this.cursor = HYB.start; this.k = 0; this.slots = []; this.byTech = { offshore: [], onshore: [], solar: [] };
    // the pace picks the timetable: HYB8 by default or HYB8.rest12, on the same code (p8, alt8); HYB7 or HYB6, which
    // keep the fans' day waves in their own list (this.waves); or HYB, which places a wave after each slot
    this.pace = pace === 'r5' ? 'r5' : pace === 'r6' ? 'r6' : pace === 'r7' ? 'r7' : pace === 'r8b' ? 'r8b' : 'r8';
    this.p8 = this.pace === 'r8' || this.pace === 'r8b'; this.alt8 = this.pace === 'r8b';
    if (this.p8) { this.waves = [];this.wavesBy = { offshore: [], onshore: [], solar: [] }; this.k8 = 0; this.pos8 = { offshore: 0, onshore: 0, solar: 0 }; return; }
    if (this.pace !== 'r5') {
      this.cursor = this.pace === 'r7' ? HYB7.first : HYB6.start; this.waves = []; this.wavesBy = { offshore: [], onshore: [], solar: [] };
      this.due = Object.assign({}, this.pace === 'r7' ? HYB7.firstWave : HYB6.first); this.wEnd = -1e9; this.nextW = null; this.wH = -1e9; this.done6 = -1e9;
    }
  }
  // the earliest s >= a such that [s, s + len] meets no quiet window
  HybridSchedule.prototype.free = function (a, len) {
    var q = this.q, P, moved = true, guard = 0, k, j, w0, w1;
    if (!q) return a;
    P = q.period;
    while (moved && guard++ < 100) {
      moved = false;
      for (k = Math.floor(a / P) - 1; k <= Math.floor((a + len) / P) + 1; k++) {
        for (j = 0; j < q.windows.length; j++) {
          w0 = k * P + q.windows[j][0]; w1 = k * P + q.windows[j][1];
          if (a < w1 && a + len > w0) { a = w1; moved = true; }
        }
      }
    }
    return a;
  };
  HybridSchedule.prototype.extend = function (until) {
    if (this.p8) return this.extend8(until);
    if (this.pace === 'r7') return this.extend7(until);
    if (this.pace === 'r6') return this.extend6(until);
    while (this.cursor <= until + 1) {
      var o = HYB_ORDER[this.k % HYB_ORDER.length], tech = o[0], cloud = o[1], segs = [], self = this;
      var push = function (name, a, b) { segs.push([name, a, b]); };
      var s = this.free(this.cursor, HYB.fold + HYB.turn), c;
      push('fold', s, s + HYB.fold); push('turn', s + HYB.fold, s + HYB.fold + HYB.turn);
      c = s + HYB.fold + HYB.turn;
      if (cloud) {
        var r0 = self.free(c + HYB.pdfB1, HYB.rise); push('pdf', c, r0); push('rise', r0, r0 + HYB.rise);
        var f0 = self.free(r0 + HYB.rise + HYB.cloud, HYB.fall); push('cloud', r0 + HYB.rise, f0); push('fall', f0, f0 + HYB.fall);
        c = f0 + HYB.fall;
        var u0 = self.free(c + HYB.pdfB2, HYB.turn + HYB.fold); push('pdf', c, u0); c = u0;
      } else {
        var u1 = self.free(c + HYB.pdf, HYB.turn + HYB.fold); push('pdf', c, u1); c = u1;
      }
      push('unturn', c, c + HYB.turn); push('unfold', c + HYB.turn, c + HYB.turn + HYB.fold);
      var end = c + HYB.turn + HYB.fold, w0 = this.free(end, HYB.wave);
      var sl = { tech: tech, cloud: cloud, segs: segs, t0: s, t1: end, w0: w0, w1: w0 + HYB.wave, n: this.byTech[tech].length };
      this.slots.push(sl); this.byTech[tech].push(sl);
      this.cursor = sl.w1 + HYB.rest; this.k++;
    }
  };
  // the phase of a panel at time t (s): its segment and progress k, the day shown (and the previous day during the
  // day's wave), whether the slot has the cloud
  HybridSchedule.prototype.phase = function (tech, t) {
    if (this.p8) return this.phase8(tech, t);
    if (this.pace === 'r7') return this.phase7(tech, t);
    if (this.pace === 'r6') return this.phase6(tech, t);
    this.extend(t);
    var L = this.byTech[tech], nd = HYB.days, lo = 0, hi = L.length - 1, i = -1, mid;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (L[mid].t0 <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0) return { seg: 'fan', k: 1, day: 0, prev: 0, wave: 1, cloud: false };
    var sl = L[i], d = sl.n % nd, dn = (sl.n + 1) % nd, j;
    if (t < sl.t1) {
      for (j = 0; j < sl.segs.length; j++) if (t < sl.segs[j][2]) break;
      j = Math.min(j, sl.segs.length - 1);
      var g = sl.segs[j];
      return { seg: g[0], k: clamp((t - g[1]) / Math.max(1e-6, g[2] - g[1]), 0, 1), day: d, prev: d, wave: 1, cloud: sl.cloud };
    }
    if (t < sl.w0) return { seg: 'fan', k: 1, day: d, prev: d, wave: 1, cloud: false };
    if (t < sl.w1) return { seg: 'fan', k: 1, day: dn, prev: d, wave: (t - sl.w0) / HYB.wave, cloud: false };
    return { seg: 'fan', k: 1, day: dn, prev: dn, wave: 1, cloud: false };
  };
  // The HYB6 timetable: the slots as extend builds them (HYB6 durations and order, no wave after a slot; a slot's
  // w0 = w1 = its end), then the day waves: repeatedly the panel whose next wave can start earliest (due on its own
  // clock, after the last wave and the gap, clear of the quiet windows and of its own slots) gets it. Then the days:
  // each panel folds its days in turn (the day after its previous fold's), and the waves between two of its folds walk
  // through other days and end on the next fold's day (counting waves alone would lock onto the 144 s slot cycle and
  // fold the same two days for ever). Slots are built 200 s ahead and waves 140 s ahead, so every wave before t has
  // its days; built in time order, the timetable stays a pure function of t.
  HybridSchedule.prototype.extend6 = function (until) {
    var H = HYB6, self = this, k;
    if (until <= this.done6) return;
    while (this.cursor <= until + 200) {
      var o = HYB6_ORDER[this.k % HYB6_ORDER.length], tech = o[0], cloud = o[1], segs = [];
      var push = function (name, a, b) { segs.push([name, a, b]); };
      var s = this.free(this.cursor, H.fold + H.turn), c;
      push('fold', s, s + H.fold); push('turn', s + H.fold, s + H.fold + H.turn);
      c = s + H.fold + H.turn;
      if (cloud) {
        var r0 = self.free(c + H.pdfB1, H.rise); push('pdf', c, r0); push('rise', r0, r0 + H.rise);
        var f0 = self.free(r0 + H.rise + H.cloud, H.fall); push('cloud', r0 + H.rise, f0); push('fall', f0, f0 + H.fall);
        c = f0 + H.fall;
        var u0 = self.free(c + H.pdfB2, H.turn + H.fold); push('pdf', c, u0); c = u0;
      } else {
        var u1 = self.free(c + H.pdf, H.turn + H.fold); push('pdf', c, u1); c = u1;
      }
      push('unturn', c, c + H.turn); push('unfold', c + H.turn, c + H.turn + H.fold);
      var end = c + H.turn + H.fold;
      var sl = { tech: tech, cloud: cloud, segs: segs, t0: s, t1: end, w0: end, w1: end, n: this.byTech[tech].length };
      this.slots.push(sl); this.byTech[tech].push(sl);
      this.cursor = end + H.rest; this.k++;
    }
    for (;;) {
      if (!this.nextW) {
        var best = null, bt = Infinity;
        for (k = 0; k < HYB_TECHS.length; k++) {
          var a = this.waveAt(HYB_TECHS[k], Math.max(this.due[HYB_TECHS[k]], this.wEnd + H.gap));
          if (a < bt - 1e-9) { bt = a; best = HYB_TECHS[k]; }
        }
        this.nextW = { tech: best, t: bt };
      }
      if (this.nextW.t > until + 140) break;
      var w = this.nextW;
      this.waves.push({ tech: w.tech, w0: w.t, w1: w.t + H.wave }); this.wavesBy[w.tech].push([w.t, w.t + H.wave, null, null]);
      this.wEnd = w.t + H.wave; this.due[w.tech] = w.t + H.clock[w.tech]; this.nextW = null;
    }
    this.wH = until + 140;
    HYB_TECHS.forEach(function (tk) { self.assign6(tk); });
    this.done6 = until;
  };
  // the days of a panel's waves and folds, up to its last fold whose waves are all placed (this.wH)
  HybridSchedule.prototype.assign6 = function (tech) {
    var L = this.byTech[tech], W = this.wavesBy[tech], nd = hybDays(tech), st = this.asg || (this.asg = {}), A, i;
    A = st[tech] || (st[tech] = { slot: 0, wave: 0, day: 0, fold: -1 });
    while (A.slot < L.length && L[A.slot].t0 <= this.wH) {
      var sl = L[A.slot], j = A.wave;
      while (j < W.length && W[j][0] < sl.t0) j++;
      var n = j - A.wave, Fn = (A.fold + 1) % nd, cur = A.day;
      if (n === 1 && Fn === cur) Fn = (Fn + 1) % nd;
      for (i = 0; i < n; i++) { var to = i === n - 1 ? Fn : (Fn + 1 + i) % nd; W[A.wave + i][2] = cur; W[A.wave + i][3] = to; cur = to; }
      sl.day = cur; A.fold = cur; A.day = cur; A.wave = j; A.slot++;
    }
  };
  // the earliest start >= a for a day wave of this panel: clear (by the gap) of the quiet windows and of its own slots
  // (H is HYB6 or HYB7; after its own slot a wave waits H.after, or H.gap when there is none)
  HybridSchedule.prototype.waveAt = function (tech, a, H) {
    H = H || HYB6;
    var L = this.byTech[tech], moved = true, guard = 0, i, b, af = H.after != null ? H.after : H.gap, ep = H === HYB6 ? 0 : 1e-6;
    while (moved && guard++ < 100) {
      moved = false;
      b = this.free(a - H.gap + ep, H.wave + 2 * H.gap - 2 * ep) + H.gap - ep;   // (HYB7: a wave may end exactly its gap before a window)
      if (b > a + 1e-9) { a = b; moved = true; }
      for (i = L.length - 1; i >= 0 && L[i].t1 + af > a - 60; i--) {
        if (a - af < L[i].t1 && a + H.wave + (H.gapSlot != null ? H.gapSlot : H.gap) > L[i].t0 + ep) { a = L[i].t1 + af; moved = true; }
      }
    }
    return a;
  };
  HybridSchedule.prototype.phase6 = function (tech, t) {
    this.extend6(t);
    var L = this.byTech[tech], W = this.wavesBy[tech], lo = 0, hi = L.length - 1, i = -1, m = 0, mid, j, g2 = 0;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (L[mid].t0 <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    lo = 0; hi = W.length - 1;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (W[mid][0] <= t) { m = mid + 1; lo = mid + 1; } else hi = mid - 1; }
    while (m > 0 && W[m - 1][3] == null && g2++ < 8) this.extend6(this.done6 + 150);   // its next fold is further than usual
    var d = m > 0 ? W[m - 1][3] : 0;
    if (i >= 0 && t < L[i].t1) {
      var sl = L[i];
      for (j = 0; j < sl.segs.length; j++) if (t < sl.segs[j][2]) break;
      j = Math.min(j, sl.segs.length - 1);
      var g = sl.segs[j];
      return { seg: g[0], k: clamp((t - g[1]) / Math.max(1e-6, g[2] - g[1]), 0, 1), day: sl.day, prev: sl.day, wave: 1, cloud: sl.cloud };
    }
    if (m > 0 && t < W[m - 1][1]) return { seg: 'fan', k: 1, day: d, prev: W[m - 1][2], wave: (t - W[m - 1][0]) / HYB6.wave, cloud: false };
    return { seg: 'fan', k: 1, day: d, prev: d, wave: 1, cloud: false };
  };
  // The HYB7 timetable. Slots in HYB7_ORDER, each placed by fit7 (the earliest start from the
  // cursor at which every move is clear of the quiet windows and no hold lasts longer than its panel's holdMax); then
  // the day waves, one at a time in time order (waveAt7); then the days (assign7). Built ahead as extend6 (slots 200 s, waves
  // 140 s), so the timetable stays a pure function of t.
  HybridSchedule.prototype.extend7 = function (until) {
    var H = HYB7, self = this, k;
    if (until <= this.done6) return;
    while (this.cursor <= until + 200) {
      var o = HYB7_ORDER[this.k % HYB7_ORDER.length], tech = o[0], cloud = o[1];
      // the second slot starts no earlier than HYB7.defer1 (after the hero's second quiet window)
      var segs = this.fit7(tech, cloud, this.k === 1 && H.defer1 != null ? Math.max(this.cursor, H.defer1) : this.cursor), end = segs[segs.length - 1][2];
      var sl = { tech: tech, cloud: cloud, segs: segs, t0: segs[0][1], t1: end, w0: end, w1: end, n: this.byTech[tech].length };
      this.slots.push(sl); this.byTech[tech].push(sl);
      this.cursor = end + H.rest; this.k++;
    }
    for (;;) {
      if (!this.nextW) {
        var best = null, bt = Infinity, bk = Infinity, ao = Infinity;
        for (k = 0; k < HYB_TECHS.length; k++) {
          // (an onshore or solar fan still for H.starve s goes ahead of offshore's lead)
          var tk = HYB_TECHS[k], a = this.waveAt7(tk), key = a - (tk === 'offshore' ? H.lead : a - this.lastEnd7(tk, a) > H.starve ? 2 * H.lead : 0);
          if (tk === 'offshore') ao = a;
          // tieStill: on a tie the panel that has been still longer goes first
          if (key < bk - 1e-9 || (H.tieStill && best && key <= bk + 1e-9 && this.lastEnd7(tk, a) < this.lastEnd7(best, bt) - 1e-9)) { bk = key; bt = a; best = tk; }
        }
        // an offshore wave moved forward to stay clear of a quiet window (waveAt7's urgent case) is not taken away by
        // another panel's wave that would end too late for it: that wave goes after it (and so does a wave after
        // which the offshore fan's next change would come later than its cap, HYB7.holdMax.offshore)
        if (best !== 'offshore' && bt + H.wave + H.gap > ao + 1e-9) {
          var u = this.urgent7, we = this.wEnd, a2, le = this.lastEnd7('offshore', ao), L = this.byTech.offshore, i;
          if (!u) {
            this.wEnd = bt + H.wave; a2 = this.waveAt7('offshore'); this.wEnd = we;
            for (i = L.length - 1; i >= 0 && L[i].t0 > le - 1e-9; i--) a2 = Math.min(a2, L[i].t0);   // or its next fold
            u = a2 - le > H.holdMax.offshore + 1e-9;
          }
          if (u) { best = 'offshore'; bt = ao; }
        }
        this.nextW = { tech: best, t: bt };
      }
      if (this.nextW.t > until + 140) break;
      var w = this.nextW;
      this.waves.push({ tech: w.tech, w0: w.t, w1: w.t + H.wave }); this.wavesBy[w.tech].push([w.t, w.t + H.wave, null, null]);
      this.wEnd = w.t + H.wave; this.due[w.tech] = w.tech === 'offshore' ? w.t + H.wave + H.idle : w.t + H.clock[w.tech]; this.nextW = null;
    }
    this.wH = until + 140;
    HYB_TECHS.forEach(function (tk) { self.assign7(tk); });
    this.done6 = until;
  };
  // a slot's segments from the earliest start >= a at which its moves miss the quiet windows and its holds stay within
  // holdMax (a hold is stretched when a window pushes the move after it); null from place7 when a hold is too long
  HybridSchedule.prototype.fit7 = function (tech, cloud, a) {
    var H = HYB7, segs, s, n, P, w1, k, j;
    for (n = 0; n < 900; n++) {
      s = this.free(a, H.fold + H.turn);
      // an offshore fold starts right at a quiet window's end, or late enough for a day change and gapSlot
      // before it (else the fan would be still from before the window to the fold)
      if (tech === 'offshore' && this.q) {
        for (P = this.q.period, w1 = -Infinity, k = Math.floor(s / P) - 1; k <= Math.floor(s / P); k++) for (j = 0; j < this.q.windows.length; j++) if (k * P + this.q.windows[j][1] <= s + 1e-9) w1 = Math.max(w1, k * P + this.q.windows[j][1]);
        if (s > w1 + 1e-9 && s < w1 + H.gap + H.wave + H.gapSlot - 1e-9) { a = w1 + H.gap + H.wave + H.gapSlot; continue; }
      }
      segs = this.place7(s, cloud, H.holdMax[tech], tech);
      if (segs) return segs;
      a = s + 0.1;
    }
    return this.place7(this.free(a, H.fold + H.turn), cloud, Infinity, tech);
  };
  HybridSchedule.prototype.place7 = function (s, cloud, hm, tech) {
    var H = HYB7, segs = [], ok = true, self = this, c;
    var hold = function (from, len, next) { var b = self.free(from + len, next); if (b - from > hm + 1e-9) ok = false; segs.push(['pdf', from, b]); return b; };
    segs.push(['fold', s, s + H.fold]); segs.push(['turn', s + H.fold, s + H.fold + H.turn]);
    c = s + H.fold + H.turn;
    if (cloud) {
      var r0 = hold(c, H.pdfB1, H.rise); segs.push(['rise', r0, r0 + H.rise]);
      var f0 = hold(r0 + H.rise, H.cloud, H.fall); segs[segs.length - 1][0] = 'cloud'; segs.push(['fall', f0, f0 + H.fall]);
      c = hold(f0 + H.fall, H.pdfB2, H.turn + H.fold);
    } else c = hold(c, H.pdf, H.turn + H.fold);
    // offshore: a slot that would end too close before a quiet window for a day wave to follow holds a little longer
    // and ends just before the window, so the fan is not still on both sides of it
    var e = c + H.turn + H.fold, Q = tech === 'offshore' ? this.nextQuiet(e) : null, last = segs[segs.length - 1];
    if (Q && Q[0] > e + 1e-9 && e + H.after + H.wave + H.gap > Q[0] && Q[0] - 0.05 - e + (c - last[1]) <= hm) { c = Q[0] - 0.05 - H.turn - H.fold; last[2] = c; }
    segs.push(['unturn', c, c + H.turn]); segs.push(['unfold', c + H.turn, c + H.turn + H.fold]);
    return ok ? segs : null;
  };
  // the first quiet window that starts at or after a, as [start, end] ([Infinity, Infinity] without windows)
  HybridSchedule.prototype.nextQuiet = function (a) {
    var q = this.q, best = [Infinity, Infinity], k, j, w0;
    if (!q) return best;
    for (k = Math.floor(a / q.period); k <= Math.floor(a / q.period) + 1; k++) for (j = 0; j < q.windows.length; j++) { w0 = k * q.period + q.windows[j][0]; if (w0 >= a - 1e-9 && w0 < best[0]) best = [w0, k * q.period + q.windows[j][1]]; }
    return best;
  };
  // the end of this panel's last change (a wave, or its slot that started before a, even if it ends after a)
  HybridSchedule.prototype.lastEnd7 = function (tech, a) {
    var W = this.wavesBy[tech], L = this.byTech[tech], e = W.length ? W[W.length - 1][1] : 0, i;
    for (i = L.length - 1; i >= 0; i--) if (L[i].t0 <= a + 1e-9) { e = Math.max(e, L[i].t1); break; }
    return e;
  };
  // the start of this panel's next day wave (HYB7): onshore and solar when due on their own clocks (as extend6). Offshore when
  // its fan has been still for HYB7.idle s; if a quiet window or its own slot would push that wave later, at the latest
  // earlier start (still HYB7.idleMin s after its last change) that is clear; and the last wave before a quiet window
  // ends just before it (its gap) when no other wave fits in between, but no later than halfway between the fan's last
  // change and the window's end, so the stillness on either side of the window stays as short as it can be. Such a
  // placed wave is marked urgent: another panel's wave that would end too late for it goes after it (extend7).
  HybridSchedule.prototype.waveAt7 = function (tech) {
    var H = HYB7, a0 = Math.max(this.due[tech], this.wEnd + H.gap), a = this.waveAt(tech, a0, H), c = a, lo, s, n, e;
    if (tech !== 'offshore') {
      if (H.force && H.force[tech] && !this.wavesBy[tech].length) return a;   // H.force: its first day change does not wait
      // an onshore or solar day change waits until no other panel makes a large move, while its fan has been
      // still for less than H.starve s; else it takes its first start
      for (lo = this.lastEnd7(tech, a), s = a, n = 0; n < 50 && s <= lo + H.starve + 1e-9; n++) { e = this.busy7(tech, s, H.wave); if (!e) return s; s = this.waveAt(tech, e + H.clear, H); }
      return a;
    }
    this.urgent7 = false;
    if (a > a0 + 1e-9) {
      lo = Math.max(this.lastEnd7(tech, a0) + H.idleMin, this.wEnd + H.gap);
      for (n = 0, s = Math.max(a0 - 0.1, lo); s >= lo - 1e-9 && s < a - 1e-9; s = Math.max(a0 - 0.1, lo) - 0.1 * ++n) {
        if (this.waveAt(tech, s, H) <= s + 1e-9) { this.urgent7 = true; c = s; break; }
      }
    }
    var Q = this.nextQuiet(c), late = Q[0] - H.gap - H.wave;
    if (late > c + 1e-9 && late < c + H.wave + H.idleMin - 1e-9) {
      s = Math.floor(10 * Math.max(c, Math.min(late, (this.lastEnd7(tech, c) + Q[1] + H.gap - H.wave) / 2)) + 1e-6) / 10;
      if (s > c + 1e-9 && this.waveAt(tech, s, H) <= s + 1e-9) { this.urgent7 = true; c = s; }
    }
    // a day change that meets another panel's large move moves (nearest first, earlier on a tie) to a clear
    // start, if the stillness before it, and after it across the next quiet window when it is the last change before
    // that window, stays within the cap (HYB7.holdMax.offshore); else it stays
    if (!this.urgent7 && this.busy7(tech, c, H.wave)) {
      e = this.lastEnd7(tech, a0); lo = Math.max(e + H.idleMin, this.wEnd + H.gap);
      for (n = 1; n <= 120 && c === a; n++) {
        s = Math.round(10 * (a + (n % 2 ? -1 : 1) * 0.1 * Math.ceil(n / 2))) / 10;
        if (s < lo - 1e-9 || s > e + H.holdMax.offshore + 1e-9 || this.waveAt(tech, s, H) > s + 1e-9 || this.busy7(tech, s, H.wave)) continue;
        Q = this.nextQuiet(s);
        if (Q[0] - H.gap - H.wave < s + H.wave + H.idleMin - 1e-9 && Q[1] + H.gap - s - H.wave > H.holdMax.offshore + 1e-9) continue;
        c = s;
      }
    }
    return c;
  };
  // the end of the last large move (fold, turn, rise, fall, unturn, unfold) of another panel that meets
  // [a - H.clear, a + len + H.clear]; 0 when there is none
  HybridSchedule.prototype.busy7 = function (tech, a, len) {
    var H = HYB7, e = 0, k, i, j, L, g;
    for (k = 0; k < HYB_TECHS.length; k++) {
      if (HYB_TECHS[k] === tech) continue;
      L = this.byTech[HYB_TECHS[k]];
      for (i = L.length - 1; i >= 0 && L[i].t1 > a - H.clear; i--) {
        if (L[i].t0 >= a + len + H.clear) continue;
        for (j = 0; j < L[i].segs.length; j++) { g = L[i].segs[j]; if (HYB_MOVES[g[0]] && g[1] < a + len + H.clear - 1e-6 && g[2] > a - H.clear + 1e-6) e = Math.max(e, g[2]); }
      }
    }
    return e;
  };
  // the days of a panel's waves and folds (HYB7): its folds visit DAY_ORDER7 in turn; the waves between two folds walk
  // through the order (skipping the next fold's day) and the last one lands on the next fold's day, so every wave
  // changes the day, however many waves there are (assign6 assumes at most a few)
  HybridSchedule.prototype.assign7 = function (tech) {
    var L = this.byTech[tech], W = this.wavesBy[tech], ord = DAY_ORDER7[tech], nd = ord.length, st = this.asg || (this.asg = {}), A, i;
    A = st[tech] || (st[tech] = { slot: 0, wave: 0, pos: 0, fold: -1 });
    while (A.slot < L.length && L[A.slot].t0 <= this.wH) {
      var sl = L[A.slot], j = A.wave;
      while (j < W.length && W[j][0] < sl.t0) j++;
      var n = j - A.wave, pf = (A.fold + 1) % nd, p = A.pos, to;
      if (n === 1 && pf === p) pf = (pf + 1) % nd;
      for (i = 0; i < n; i++) {
        if (i === n - 1) to = pf;
        else { to = (p + 1) % nd; if (to === pf) to = (to + 1) % nd; }
        W[A.wave + i][2] = ord[p]; W[A.wave + i][3] = ord[to]; p = to;
      }
      sl.day = ord[p]; A.fold = p; A.pos = p; A.wave = j; A.slot++;
    }
  };
  // as phase6; a wave carries its front (st: the share of the wave over which the front crosses the day)
  HybridSchedule.prototype.phase7 = function (tech, t) {
    this.extend7(t);
    var L = this.byTech[tech], W = this.wavesBy[tech], lo = 0, hi = L.length - 1, i = -1, m = 0, mid, j, g2 = 0;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (L[mid].t0 <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    lo = 0; hi = W.length - 1;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (W[mid][0] <= t) { m = mid + 1; lo = mid + 1; } else hi = mid - 1; }
    while (m > 0 && W[m - 1][3] == null && g2++ < 8) this.extend7(this.done6 + 150);
    var d = m > 0 ? W[m - 1][3] : DAY_ORDER7[tech][0];
    if (i >= 0 && t < L[i].t1) {
      var sl = L[i];
      for (j = 0; j < sl.segs.length; j++) if (t < sl.segs[j][2]) break;
      j = Math.min(j, sl.segs.length - 1);
      var g = sl.segs[j];
      return { seg: g[0], k: clamp((t - g[1]) / Math.max(1e-6, g[2] - g[1]), 0, 1), day: sl.day, prev: sl.day, wave: 1, cloud: sl.cloud };
    }
    if (m > 0 && t < W[m - 1][1]) return { seg: 'fan', k: 1, day: d, prev: W[m - 1][2], wave: (t - W[m - 1][0]) / HYB7.wave, cloud: false, st: HYB7.front };
    return { seg: 'fan', k: 1, day: d, prev: d, wave: 1, cloud: false };
  };
  // The HYB8 timetable. HYB8.blocks is one period of each panel's blocks of motion (see HYB8); period k
  // repeats them k * HYB8.period s later. Built a period ahead of t and in time order per panel, so the days are known
  // at once: a wave turns the fan from DAY_ORDER8[pos] to the next day of the order, a slot folds the day shown.
  // alt picks HYB8.rest12
  function hyb8Blocks(tech, alt) {
    var C = HYB8.parsed || (HYB8.parsed = {}), key = (alt ? 'rest12:' : '') + tech;
    if (!C[key]) C[key] = (alt ? HYB8.rest12 : HYB8.blocks)[tech].trim().split(/\s+/).map(function (s) { return [s.charAt(0), parseFloat(s.slice(1))]; });
    return C[key];
  }
  HybridSchedule.prototype.extend8 = function (until) {
    var H = HYB8, P = H.period, self = this;
    while (this.k8 * P <= until + P) {
      var base = this.k8 * P, slots = [], waves = [];
      HYB_TECHS.forEach(function (tech) {
        var B = hyb8Blocks(tech, self.alt8), ord = DAY_ORDER8[tech], nd = ord.length, cur = null, i;
        for (i = 0; i < B.length; i++) {
          var k = B[i][0], t = base + B[i][1], nx = base + (i + 1 < B.length ? B[i + 1][1] : P + B[0][1]);
          if (k === 'W') {
            var w = [t, t + H.wave, ord[self.pos8[tech] % nd], ord[(self.pos8[tech] + 1) % nd]];
            self.pos8[tech]++; waves.push({ tech: tech, w0: w[0], w1: w[1], d: w });
          } else if (k === 'A') {
            cur = { tech: tech, cloud: false, day: ord[self.pos8[tech] % nd], segs: [['fold', t, t + H.fold], ['turn', t + H.fold, t + H.fold + H.turn], ['pdf', t + H.fold + H.turn, nx]] };
          } else if (k === 'R') {
            cur.cloud = true; cur.segs.push(['rise', t, t + H.rise], ['cloud', t + H.rise, nx]);
          } else if (k === 'L') {
            cur.segs.push(['fall', t, t + H.fall], ['pdf', t + H.fall, nx]);
          } else if (k === 'B') {
            cur.segs.push(['unturn', t, t + H.unturn], ['unfold', t + H.unturn, t + H.unturn + H.unfold]);
            cur.t0 = cur.segs[0][1]; cur.t1 = t + H.unturn + H.unfold; cur.w0 = cur.w1 = cur.t1; slots.push(cur); cur = null;
          }
        }
      });
      slots.sort(function (a, b) { return a.t0 - b.t0; }); waves.sort(function (a, b) { return a.w0 - b.w0; });
      slots.forEach(function (sl) { sl.n = self.byTech[sl.tech].length; self.slots.push(sl); self.byTech[sl.tech].push(sl); });
      waves.forEach(function (w) { self.waves.push({ tech: w.tech, w0: w.w0, w1: w.w1 }); self.wavesBy[w.tech].push(w.d); });
      this.k8++;
    }
  };
  // as phase7 (a wave carries its front)
  HybridSchedule.prototype.phase8 = function (tech, t) {
    this.extend8(t);
    var L = this.byTech[tech], W = this.wavesBy[tech], lo = 0, hi = L.length - 1, i = -1, m = 0, mid, j;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (L[mid].t0 <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    lo = 0; hi = W.length - 1;
    while (lo <= hi) { mid = (lo + hi) >> 1; if (W[mid][0] <= t) { m = mid + 1; lo = mid + 1; } else hi = mid - 1; }
    var d = m > 0 ? W[m - 1][3] : DAY_ORDER8[tech][0];
    if (i >= 0 && t < L[i].t1) {
      var sl = L[i];
      for (j = 0; j < sl.segs.length; j++) if (t < sl.segs[j][2]) break;
      j = Math.min(j, sl.segs.length - 1);
      var g = sl.segs[j];
      return { seg: g[0], k: clamp((t - g[1]) / Math.max(1e-6, g[2] - g[1]), 0, 1), day: sl.day, prev: sl.day, wave: 1, cloud: sl.cloud };
    }
    if (m > 0 && t < W[m - 1][1]) return { seg: 'fan', k: 1, day: d, prev: W[m - 1][2], wave: (t - W[m - 1][0]) / HYB8.wave, cloud: false, st: HYB8.front };
    return { seg: 'fan', k: 1, day: d, prev: d, wave: 1, cloud: false };
  };
  // is anything moving in this phase (side: the stack never turns or rises)
  function hybMoving(P, side) {
    if (P.wave < 1) return true;
    if (P.seg === 'fold' || P.seg === 'unfold') return true;
    return !side && !!HYB_MOVES[P.seg];
  }
  // a large move (not a day wave): under HYB8 it sets the frame rate (HYB_FPS8)
  function hybLarge(P, side) {
    if (P.seg === 'fold' || P.seg === 'unfold') return true;
    return !side && !!HYB_MOVES[P.seg];
  }

  // the forecast marginal of a cloud (tempered n^0.6 like the engine's cloudTemper; solar's night bin excluded)
  function forecastInv(T, exclude) {
    var wts = [], tot = 0, b;
    for (b = 0; b < T.nb; b++) { var x = exclude.indexOf(b) >= 0 ? 0 : Math.pow(T.n[b] || 0, 0.6); wts.push(x); tot += x; }
    return function (p) {
      var acc = 0, target = clamp(p, 0, 0.99999) * tot;
      for (b = 0; b < T.nb; b++) {
        if (acc + wts[b] >= target && wts[b] > 0) {
          var lo = T.lo + b * T.w, hi = b === T.nb - 1 ? T.lastHi : lo + T.w;
          return lo + (target - acc) / wts[b] * (hi - lo);
        }
        acc += wts[b];
      }
      return T.lastHi;
    };
  }

  // One source field of the hybrid view: n particles with ranks (u, v), the field's size F (local px = model
  // units of the field: x right, y down from the top), the cloud's conditional tables T.
  function HybridPanel(tech, n, seed, table, F, side) {
    this.tech = tech; this.n = n; this.T = table; this.F = F; this.side = !!side;
    this.days = DAYS[tech].map(tabulate);
    this.h0 = tech === 'solar' ? 5.25 : 0; this.h1 = tech === 'solar' ? 21.75 : 24;   // solar: daylight only
    this.fInv = forecastInv(table, tech === 'solar' ? [0] : []);
    this.R = ranks(n, seed);
    this.core = new Uint8Array(n);
    var ci = [], ti = [];
    for (var i = 0; i < n; i++) { this.core[i] = this.R.v[i] >= 0.1 && this.R.v[i] < 0.9 ? 1 : 0; (this.core[i] ? ci : ti).push(i); }
    this.coreIdx = new Uint16Array(ci); this.tailIdx = new Uint16Array(ti);
    this.cache = {};
    this.LX = new Float32Array(n); this.LY = new Float32Array(n); this.O = new Float32Array(n);   // local px and the output (edge light)
    this.X = new Float32Array(n); this.Y = new Float32Array(n);                                   // canvas px (drawing)
    this.segs = [];
  }
  // the fan of a day: x = hour, output = the measured outcome quantile at that hour's forecast level
  HybridPanel.prototype.fan = function (d) {
    var key = 'fan' + d; if (this.cache[key]) return this.cache[key];
    var n = this.n, F = this.F, tab = this.days[d], R = this.R, x = new Float32Array(n), o = new Float32Array(n), i;
    for (i = 0; i < n; i++) {
      var hr = this.h0 + R.u[i] * (this.h1 - this.h0), f = fAt(tab, hr);
      o[i] = f < 0.004 ? 0.004 * R.v[i] : cloudQ(this.T, f, R.v[i]);
      x[i] = hr / 24 * F.w;
    }
    return (this.cache[key] = { x: x, o: o });
  };
  // the distribution at the fold hour of a day: output o_i = Q(v_i | f(h*)), the atoms (exactly no output or full
  // output) spread into thin piles against their wall, and the density g (1 = the shape's own peak) for the stack
  HybridPanel.prototype.star = function (d) {
    var key = 'star' + d; if (this.cache[key]) return this.cache[key];
    var n = this.n, F = this.F, R = this.R, hs = HYB_HOURS[this.tech][d], f = fAt(this.days[d], hs), i, PW = 0.03, NB = 90;
    var o = new Float32Array(n), g = new Float32Array(n), oc = new Float32Array(n);
    var Mq = 4096, q = new Float32Array(Mq), p0 = 0, p1 = 0;
    for (i = 0; i < Mq; i++) { q[i] = cloudQ(this.T, f, (i + 0.5) / Mq); if (q[i] <= 1e-4) p0++; if (q[i] >= 1 - 1e-4) p1++; }
    p0 /= Mq; p1 /= Mq;
    var pile = function (val, v) {
      if (val <= 1e-4 && p0 > 0) return PW * clamp(v / p0, 0, 1);
      if (val >= 1 - 1e-4 && p1 > 0) return 1 - PW * clamp((1 - v) / p1, 0, 1);
      return val;
    };
    var hist = new Float32Array(NB), sm = new Float32Array(NB), b, k;
    for (i = 0; i < Mq; i++) { var y = pile(q[i], (i + 0.5) / Mq); hist[clamp(Math.floor(y * NB), 0, NB - 1)]++; }
    for (b = 0; b < NB; b++) { var s = 0, ws = 0; for (k = -2; k <= 2; k++) { var bb = b + k; if (bb < 0 || bb >= NB) continue; var wk = Math.exp(-0.5 * k * k / 1.1); s += wk * hist[bb]; ws += wk; } sm[b] = s / ws; }
    var nPile = Math.ceil(PW * NB) + 1, peak = 1e-9;
    for (b = nPile; b < NB - nPile; b++) peak = Math.max(peak, sm[b]);
    for (i = 0; i < n; i++) {
      var val = cloudQ(this.T, f, R.v[i]);
      o[i] = pile(val, R.v[i]);
      oc[i] = val <= 1e-4 ? 0 : val >= 1 - 1e-4 ? 1 : o[i];
      var bi = clamp(Math.floor(o[i] * NB), 0, NB - 1), fr = o[i] * NB - bi - 0.5, bj = clamp(bi + (fr > 0 ? 1 : -1), 0, NB - 1);
      g[i] = Math.min(1.1, lerp(sm[bi], sm[bj], Math.abs(fr)) / peak);
    }
    var xs = hs / 24 * F.w, om = 0, bm = 0;
    for (i = 0; i < n; i++) { om += o[i]; bm += (1 - R.u[i]) * g[i]; }
    // the turn's pivot: the stack's center (mean output, mean stack height), so the shape turns in place
    return (this.cache[key] = { o: o, oc: oc, g: g, hour: hs, f: f, xs: xs, D: Math.min(0.88 * F.h, xs - 3), H: 0.86 * F.h, p0: p0, p1: p1, om: om / n, bm: bm / n });
  };
  // the forecast-outcome cloud: forecast rank 1 - u (the stack height of the distribution), outcome rank v
  HybridPanel.prototype.cloud = function () {
    if (this.cache.cloud) return this.cache.cloud;
    var n = this.n, R = this.R, o = new Float32Array(n), fc = new Float32Array(n), i;
    for (i = 0; i < n; i++) { fc[i] = this.fInv(1 - R.u[i]); o[i] = cloudQ(this.T, fc[i], R.v[i]); }
    return (this.cache.cloud = { o: o, f: fc });
  };
  // positions at time t (s) in local px, the output per particle, and the bounds (this.segs: m 0 no output,
  // m 1 full output, m 2 the stack's base) for the furniture and the edge light
  HybridPanel.prototype.compute = function (t, drift, sched) {
    var P = sched.phase(this.tech, t), F = this.F, n = this.n, i, X = this.LX, Y = this.LY, O = this.O, R = this.R, u = R.u, side = this.side;
    var fanA = this.fan(P.prev), fanB = this.fan(P.day), S = this.star(P.day), seg = P.seg, k = P.k;
    var cl = !side && (seg === 'rise' || seg === 'cloud' || seg === 'fall'), C = cl ? this.cloud() : null;
    var xs = S.xs, D = S.D, Hd = S.H, om = S.om, bm = S.bm;
    // the quarter turn: angle, pivot (the stack's center, from its place in the column to its place in the
    // distribution), output length, stack scale; the shape draws in a little while it turns (kc), so a broad
    // distribution never reaches past the field at 45 degrees
    var e = side ? 0 : seg === 'turn' ? smooth5(k) : seg === 'unturn' ? 1 - smooth5(k) : (seg === 'pdf' || cl) ? 1 : 0;
    // smooth5 can round a hair above 1, so an unturn's last frame can give e = -2.2e-16, which is neither the folded
    // column (e === 0) nor the turned stack (e > 0), and the panel would flash its whole day for one frame
    e = clamp(e, 0, 1);
    var th = e * Math.PI / 2, cs = Math.cos(th), sn = Math.sin(th), kc = 1 - 0.35 * Math.sin(Math.PI * e);
    var Lout = lerp(F.h, F.w, e) * kc, bsc = lerp(D, Hd, e) * kc;
    var pvx = lerp(xs - bm * D, om * F.w, e), pvy = lerp(F.h - om * F.h, F.h - bm * Hd, e);
    // G maps a particle's offset in stack units (a: across the stack, b: output) to local px: G = R(th) diag(bsc, Lout)
    var G = [cs * bsc, -sn * Lout, sn * bsc, cs * Lout];
    // The field is a sheared plane on screen, so a quarter turn in its own coordinates would squash the shape into a
    // wedge with its walls at odd angles half way. The turn runs in screen space instead: the whole move B = L A L^-1
    // (A: the field's quarter turn with its change of scale; L: the field's linear map to the screen) is split into its
    // rotation R(phi) and stretch P (polar decomposition), and the shape turns rigidly on screen, R(e phi) ((1 - e) I
    // + e P), drawing in by at most 15 %. The start and end are those of G above; only the path between them differs.
    if (e > 0 && e < 1 && F.L) {
      var L = F.L, la = L[0], lb = L[1], lc = L[2], ld = L[3], det = la * ld - lb * lc;
      if (Math.abs(det) > 1e-9) {
        var sx = Hd / D, sy = F.w / F.h;
        // A = [[0, -sy], [sx, 0]] (x' = -b, y' = a in the code's turn); B = L A L^-1 (L = [[la, lc], [lb, ld]])
        var A00 = 0, A01 = -sy, A10 = sx, A11 = 0;
        var LA00 = la * A00 + lc * A10, LA01 = la * A01 + lc * A11, LA10 = lb * A00 + ld * A10, LA11 = lb * A01 + ld * A11;
        var i00 = ld / det, i01 = -lc / det, i10 = -lb / det, i11 = la / det;
        var B00 = LA00 * i00 + LA01 * i10, B01 = LA00 * i01 + LA01 * i11, B10 = LA10 * i00 + LA11 * i10, B11 = LA10 * i01 + LA11 * i11;
        var phi = Math.atan2(B10 - B01, B00 + B11), pc = Math.cos(phi), ps = Math.sin(phi);
        var P00 = pc * B00 + ps * B10, P01 = pc * B01 + ps * B11, P10 = -ps * B00 + pc * B10, P11 = -ps * B01 + pc * B11;
        var ec = Math.cos(e * phi), es = Math.sin(e * phi), dk = 1 - 0.15 * Math.sin(Math.PI * e);
        var Q00 = (1 - e) + e * P00, Q01 = e * P01, Q10 = e * P10, Q11 = (1 - e) + e * P11;
        var S00 = (ec * Q00 - es * Q10) * dk, S01 = (ec * Q01 - es * Q11) * dk, S10 = (es * Q00 + ec * Q10) * dk, S11 = (es * Q01 + ec * Q11) * dk;
        // A_e = L^-1 S L, applied to the start offsets (stack units times D across, F.h along the output)
        var SL00 = S00 * la + S01 * lb, SL01 = S00 * lc + S01 * ld, SL10 = S10 * la + S11 * lb, SL11 = S10 * lc + S11 * ld;
        var E00 = i00 * SL00 + i01 * SL10, E01 = i00 * SL01 + i01 * SL11, E10 = i10 * SL00 + i11 * SL10, E11 = i10 * SL01 + i11 * SL11;
        G = [E00 * D, E01 * F.h, E10 * D, E11 * F.h];
      }
    }
    var fold = seg === 'fold' ? k : seg === 'unfold' ? 1 - k : seg === 'fan' ? 0 : 1, st = HYB.stagger;
    var ws = P.st != null ? P.st : st;   // a day wave's front (HYB7 and HYB8 waves carry their own; the others the stagger)
    var rise = cl ? (seg === 'rise' ? k : seg === 'fall' ? 1 - k : 1) : 0, tm = t * 1000, x, y, out, vx, vy, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (i = 0; i < n; i++) {
      var fo = P.wave < 1 ? lerp(fanA.o[i], fanB.o[i], smooth5((P.wave - ws * u[i]) / (1 - ws))) : fanB.o[i];
      var fx = fanB.x[i], fy = (1 - fo) * F.h;
      if (fold > 0 && e === 0) {
        // fan <-> column: the particles near the fold hour move first, the far ones follow (a hand fan closing)
        var pf = smooth5((fold - st * Math.abs(fx - xs) / F.w) / (1 - st));
        x = lerp(fx, xs - (1 - u[i]) * D * S.g[i], pf); y = lerp(fy, (1 - S.o[i]) * F.h, pf); out = lerp(fo, S.oc[i], pf);
      } else if (e > 0) {
        // column -> distribution: the stack turned clockwise by th about its center
        vx = -((1 - u[i]) * S.g[i] - bm); vy = -(S.o[i] - om);
        x = pvx + G[0] * vx + G[1] * vy; y = pvy + G[2] * vx + G[3] * vy; out = S.oc[i];
        if (rise > 0) {
          var pr = smooth5((rise - 0.3 * (1 - u[i])) / 0.7);
          x = lerp(x, C.o[i] * F.w, pr); y = lerp(y, (1 - C.f[i]) * F.h, pr); out = lerp(out, C.o[i], pr);
        }
      } else { x = fx; y = fy; out = fo; }
      X[i] = x; Y[i] = y; O[i] = out;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // while the fan folds and the stack turns, the shape (and its bounds) slides back by its overhang, so it never
    // leaves the field (a long tail would otherwise be clipped); continuous, because the shape's extent changes
    // continuously. The fan, the landed distribution and the cloud are inside by construction.
    var dx = 0, dy = 0, fs = 1, fcx = 0, fcy = 0;
    // the bounds, in local px: in the fan the floor (no output) and the ceiling (full output), shrinking with the
    // fold to the stack's width; then they turn with the particles and stand up as the two walls, and the stack's
    // base appears as the floor
    var fl = smooth5((fold - 0.1) / 0.9);
    if (e === 0) {
      var a0 = lerp(0, xs - D, fl), a1 = lerp(F.w, xs, fl);
      this.segs = [{ m: 0, a: [a0, F.h], b: [a1, F.h] }, { m: 1, a: [a0, 0], b: [a1, 0] }];
    } else {
      var BU = lerp(1, F.h / Hd, e);
      var pl = function (oo, bu) { var qx = -(bu - bm), qy = -(oo - om); return [pvx + G[0] * qx + G[1] * qy, pvy + G[2] * qx + G[3] * qy]; };
      this.segs = [{ m: 0, a: pl(0, 0), b: pl(0, BU) }, { m: 1, a: pl(1, 0), b: pl(1, BU) }, { m: 2, a: pl(0, 0), b: pl(1, 0), alpha: e }];
      // in the forecast-outcome cloud the vertical is the forecast, bounded by full output, so the field's top is a
      // bound too: a fine ceiling closes the box while the cloud stands (the highest forecasts sit in the top corner,
      // and without it they would read as escaping the frame)
      if (rise > 0) this.segs.push({ m: 1, a: [0, 0], b: [F.w, 0], alpha: rise });
    }
    // while it turns the frame counts with the particles (else the walls and the floor reach past the field and are
    // cut by its clip): the shape and its walls draw in together, stay whole inside the field and turn as one object,
    // and the floor is drawn as strongly as the walls
    if (e > 0 && e < 1) {
      this.segs.forEach(function (g) { [g.a, g.b].forEach(function (q) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }); });
      this.segs[2].alpha = smooth5(Math.min(1, 3 * e));
    }
    // Turned rigidly on screen, a broad shape can be longer than the field in the field's own coordinates half way
    // through the turn; it then draws in uniformly about its center (uniform, so it stays rigid on screen) before the
    // slide below keeps it inside. Under HYB8 the 3 % margin eases out over the last 15 % of the turn (and in over the
    // first 15 % of an unturn), so the shape reaches the landed distribution's size continuously; the other
    // timetables keep a fixed 0.97.
    if (e > 0 && e < 1) {
      var fm = sched.p8 ? lerp(0.97, 1, smooth5((e - 0.85) / 0.15)) : 0.97;
      fs = Math.min(1, fm * F.w / Math.max(1e-6, x1 - x0), fm * F.h / Math.max(1e-6, y1 - y0));
      if (fs < 1) {
        fcx = (x0 + x1) / 2; fcy = (y0 + y1) / 2;
        for (i = 0; i < n; i++) { X[i] = fcx + (X[i] - fcx) * fs; Y[i] = fcy + (Y[i] - fcy) * fs; }
        x0 = fcx + (x0 - fcx) * fs; x1 = fcx + (x1 - fcx) * fs; y0 = fcy + (y0 - fcy) * fs; y1 = fcy + (y1 - fcy) * fs;
      }
    }
    if ((e === 0 && fold > 0) || (e > 0 && e < 1)) {
      dx = x1 - x0 > F.w ? (F.w - x0 - x1) / 2 : x0 < 0 ? -x0 : x1 > F.w ? F.w - x1 : 0;
      dy = y1 - y0 > F.h ? (F.h - y0 - y1) / 2 : y0 < 0 ? -y0 : y1 > F.h ? F.h - y1 : 0;
    }
    for (i = 0; i < n; i++) {
      x = X[i] + dx; y = Y[i] + dy;
      if (drift) {
        x += drift * Math.sin(R.w1[i] * tm + R.f1[i]); y += drift * Math.sin(R.w2[i] * tm + R.f2[i]);
        // the bounds hold: a drifting particle is reflected back into the field (the fan: floor and ceiling; the
        // landed distribution and the cloud: the two walls, the floor and the top)
        if (e === 0) { if (y > F.h) y = 2 * F.h - y; else if (y < 0) y = -y; }
        else if (e === 1) { if (x < 0) x = -x; else if (x > F.w) x = 2 * F.w - x; if (y > F.h) y = 2 * F.h - y; else if (y < 0) y = -y; }
      }
      X[i] = x; Y[i] = y;
    }
    if (fs < 1) this.segs.forEach(function (g) { g.a = [fcx + (g.a[0] - fcx) * fs, fcy + (g.a[1] - fcy) * fs]; g.b = [fcx + (g.b[0] - fcx) * fs, fcy + (g.b[1] - fcy) * fs]; });
    if (dx || dy) this.segs.forEach(function (g) { g.a = [g.a[0] + dx, g.a[1] + dy]; g.b = [g.b[0] + dx, g.b[1] + dy]; });
    this.P = P;
    return P;
  };

  function readPalette(el) {
    var cs = global.getComputedStyle(el), pal = { t: {}, s: {} };
    MAT_KEYS.forEach(function (m) { pal.t[m] = []; for (var k = 0; k < LEVELS; k++) pal.t[m].push(cs.getPropertyValue('--t-' + m + '-' + pad2(k)).trim() || '#888888'); });
    Object.keys(FLAT.la).forEach(function (k) { pal.s[k] = cs.getPropertyValue('--s-' + k).trim() || FLAT.la[k]; });
    pal.sheen = [[0, 0.55], [0.32, 0.06], [0.58, 0], [0.8, 0.12], [1, 0]];
    var num = function (n, d) { var v = parseFloat(cs.getPropertyValue(n)); return isFinite(v) ? v : d; };
    pal.dot = { color: cs.getPropertyValue('--uf-particle').trim() || '#4b35d4', alpha: num('--uf-alpha', 0.9), blend: cs.getPropertyValue('--uf-blend').trim() || 'source-over' };
    pal.mono = cs.getPropertyValue('--mono').trim() || 'monospace';
    return pal;
  }
  function lineStyle(c, pal) {
    var m = /^([a-z]{2})(\d\d)$/.exec(c);
    if (m) return [pal.t[m[1]][+m[2]], 1, null];
    if (c === 'w-ehv') return [pal.s.wire, 1, 1.7];
    if (c === 'w-hv') return [pal.s.wireHV, 1, 1.15];
    if (c === 'bus') return [pal.s.bus, 1, 1.05];
    if (c === 'drop') return [pal.s.wire, 0.9, null];
    if (c === 'blade') return [pal.s.ink, 1, 0.9];
    if (c === 'cable') return [pal.s.cable, 0.85, null];
    if (c === 'array') return [pal.s.wire, 0.3, null];
    if (c === 'fence') return [pal.t.mt[9], 1, 0.7];
    if (c === 'feeder') return [pal.s.cable, 0.45, null];
    if (c === 'road') return [pal.t.cd[10], 0.55, 3.2];
    if (c === 'rod') return [pal.t.mt[6], 1, 1.6];
    return [pal.s.wire, 1, null];
  }
  function p2d(sp, close) { var p = new global.Path2D(); p.moveTo(sp[0][0], sp[0][1]); for (var i = 1; i < sp.length; i++) p.lineTo(sp[i][0], sp[i][1]); if (close) p.closePath(); return p; }

  function opsOf(o) {
    var ops = [], cam = o.scene.cam;
    o.pf.forEach(function (f) { ops.push({ t: 'f', p: p2d(f.sp, true), m: f.m, k: f.k }); });
    o.pl.forEach(function (l) { ops.push({ t: 'l', p: p2d(l.sp, false), c: l.c, w: l.w }); });
    o.ps.forEach(function (s) { ops.push({ t: 's', x: s.c[0], y: s.c[1], r: s.r, k: s.k }); });
    (o.fxq || []).forEach(function (q) { ops.push({ t: 'q', p: p2d(q.p.map(function (p) { return cam.p(p); }), true), c: q.c }); });
    (o.fxc || []).forEach(function (q) { var c = cam.p(q.p); ops.push({ t: 'c', x: c[0], y: c[1], r: q.r, c: q.c }); });
    return ops;
  }
  // color and alpha of a night-light quad or point (as model.css draws them in the SVG); load: the
  // town's load tier (lit windows of tier <= load, dark only through winLit)
  function fxStyle(c, pal, load) {
    var num = function (v, d) { var x = parseFloat(v); return isFinite(x) ? x : d; };
    if (c.indexOf('fx-door') >= 0) return [pal.s.door, 0.9];
    var m = /fx-win w(\d)/.exec(c);
    if (m) { var k = +m[1]; return [k > 0 && k <= (load || 2) ? pal.s.winLit : pal.s.win, 0.9]; }
    if (c.indexOf('fx-glaze') >= 0) return [pal.s.glaze, num(pal.s.glazeA, 0.85) * (c.indexOf('fx-dim') >= 0 ? 0.8 : 1)];
    if (c.indexOf('fx-seam') >= 0) return [pal.s.seam, num(pal.s.seamA, 0.6)];
    if (c.indexOf('fx-deck') >= 0) return [pal.s.deck, num(pal.s.deckA, 0)];
    return null;
  }
  function drawOps(ctx, ops, pal, load) {
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.t === 'f') { ctx.fillStyle = ctx.strokeStyle = pal.t[op.m][op.k]; ctx.lineWidth = 0.45; ctx.fill(op.p); ctx.stroke(op.p); }
      else if (op.t === 'l') {
        var st = lineStyle(op.c, pal), a0 = ctx.globalAlpha;
        ctx.strokeStyle = st[0]; ctx.globalAlpha = a0 * st[1]; ctx.lineWidth = st[2] || op.w; ctx.stroke(op.p); ctx.globalAlpha = a0;
      } else if (op.t === 's') {
        ctx.beginPath(); ctx.arc(op.x, op.y, op.r, 0, TAU); ctx.fillStyle = pal.t.cd[op.k]; ctx.fill(); ctx.strokeStyle = pal.t.cd[Math.max(0, op.k - 3)]; ctx.lineWidth = 0.5; ctx.stroke();
      } else if (op.t === 'q' || op.t === 'c') {
        var fs = fxStyle(op.c, pal, load);
        if (!fs || fs[1] <= 0) continue;
        var a1 = ctx.globalAlpha; ctx.globalAlpha = a1 * fs[1]; ctx.fillStyle = fs[0];
        if (op.t === 'q') ctx.fill(op.p); else { ctx.beginPath(); ctx.arc(op.x, op.y, op.r, 0, TAU); ctx.fill(); }
        ctx.globalAlpha = a1;
      }
    }
  }
  // Dots at CSS px X[i], Y[i] where pick(i) (or all): one path, one fill (squares at DPR < 1.5,
  // like the engine's 'rect' primitive, discs otherwise).
  function dots(ctx, X, Y, n, r, color, alpha, pick, square) {
    var i, x, y, d2 = 2 * r;
    ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath();
    for (i = 0; i < n; i++) {
      if (pick && !pick(i)) continue;
      x = X[i]; y = Y[i];
      if (square) ctx.rect(x - r, y - r, d2, d2); else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
    }
    ctx.fill(); ctx.globalAlpha = 1;
  }

  function mount(root, opts) {
    opts = opts || {};
    var UF = global.UncertaintyField, d = global.document, html = d.documentElement;
    if (!UF || !root || !global.StudioNet) return null;
    var engine = opts.engine || ENGINE;
    var mqWide = global.matchMedia('(min-width: 900px)'), mqReduce = global.matchMedia('(prefers-reduced-motion: reduce)');
    var M = { root: root, fields: {}, list: [], hl: null, pal: null, state: {}, ready: false, frames: 0 };
    var DIM_MS = 220;
    M.dim = { from: null, t0: 0, snap: true, done: true };
    function inTheme(o, th) { return o.theme === th || !!(o.themes && o.themes.indexOf(th) >= 0); }
    // a hover dims the other themes flatly (0.28), except the switching hover (its follow-spot darkens the model around
    // the ladder), the balancing hover with a sink (M.balSink) and the HVDC hover with its day (M.hvSink), which dim by
    // their own means
    function dimAlpha(h, o) { return h && h !== 'switching' && !(h === 'balancing' && M.balSink) && !(h === 'hvdc' && M.hvSink) && !(typeof o === 'string' ? o === h : inTheme(o, h)) ? 0.28 : 1; }
    function dimK() {
      if (M.dim.snap) return 1;
      var k = clamp((global.performance.now() - M.dim.t0) / DIM_MS, 0, 1);
      return 1 - (1 - k) * (1 - k);
    }
    M.version = VERSION;
    // the panel variant: html[data-panels] when it names one, else light volumes on wide screens and the floating
    // band on phones
    function variantNow(name) { var v = html.getAttribute('data-panels'); return PANEL_VARIANTS.indexOf(v) >= 0 ? v : panelDefault(name); }
    // html[data-pace] picks the hybrid's timetable, HYB8 by default (see HybridSchedule);
    // html[data-veil]: 1 (the default) or 0 (see VEIL)
    function paceNow() { var p = html.getAttribute('data-pace'); return p === 'r5' || p === 'r6' || p === 'r7' || p === 'r8b' ? p : 'r8'; }
    function veilOn() { return html.getAttribute('data-veil') !== '0'; }
    // html[data-herocue]: 1 (the default) or 0 (none), the hero's two gentle switching cues
    function heroCue() { return html.getAttribute('data-herocue') !== '0'; }
    // the hybrid view's timetable, clear of the hero's event windows (M.setHybridQuiet sets others)
    M.sched = new HybridSchedule(HERO_QUIET, paceNow());

    // ── the flows: DC power flow per (state, open lines), cached; the states are NET.states and the story states
    // (net.js, StudioNet.stories) ──
    var NET = global.StudioNet, RATE = {}, STATES = {};
    var ROOMS = (NET.stories && NET.stories.room) || {};   // the upward room per story state, for the merit chart
    NET.branches.forEach(function (b) { RATE[b.id] = b.rate_mva; });
    NET.states.forEach(function (s) { STATES[s.id] = s.p; });
    Object.keys((NET.stories && NET.stories.states) || {}).forEach(function (k) { STATES[k] = NET.stories.states[k].p; });
    var flowCache = {};
    function variant(state, open) {
      var key = state + '|' + open.slice().sort().join(',');
      if (!flowCache[key]) flowCache[key] = dcFlow(NET, STATES[state], open);
      return flowCache[key];
    }
    M.variant = variant;
    M.flowsOn = function () { return html.getAttribute('data-flows') === 'on'; };

    function stageFor(name) { return root.querySelector('.st-stage[data-layout="' + name + '"]'); }
    function mapping() {
      var b = M.stage.getBoundingClientRect(), V = M.S.layout.view;
      var s = Math.min(b.width / V[0], b.height / V[1]);
      M.map = { s: s, ox: (b.width - s * V[0]) / 2, oy: b.height - s * V[1], w: b.width, h: b.height };
      // the base mapping; while the switching camera rests pushed in, the canvas draws at its mapping
      M.map0 = M.map;
      if (M.cam && M.cam.crisp) M.map = camMap(M.cam.e);
    }
    // a field's local px (x right, y down) to canvas CSS px
    function fieldTransform(F) {
      var m = M.map, T = F.M;
      return [m.s * T[0], m.s * T[1], m.s * T[2], m.s * T[3], m.s * T[4] + m.ox, m.s * T[5] + m.oy];
    }
    function fieldNow(P) { return P.fields[M.pv] || P.field; }   // M.pv: the panel layout in effect (M.variant is the flow solver)
    function teardown() {
      Object.keys(M.fields).forEach(function (k) { M.fields[k].destroy(); });
      M.fields = {}; M.hyb = null;
      if (M.hook) { M.hook.destroy(); M.hook = null; }
      if (M.ro) { M.ro.disconnect(); M.ro = null; }
      if (M.cam && M.stage) { M.cam.crisp = false; camReset(); }   // the switching camera leaves the old stage as it was
      M.cam = null; M.swMask = null;
      if (M.ladCv && M.ladCv.parentNode) M.ladCv.parentNode.removeChild(M.ladCv);   // the bid-ladder chart's own canvas
      M.ladCv = null; M.ladA = 0; M.ladLast = null; M.ladRect = null; M.qaLadder = null;
      // a layout change during a dissolve leaves the old stage whole and unpromoted (no opacity, no will-change)
      if (M.stage) { M.stage.style.opacity = ''; M.stage.style.willChange = ''; }
      M.dipOp = ''; M.stageWc = ''; M.glK = 1; M.glC = 1; M.swOn = null; M.swCv = false;
      // the switched line's own fade and the card's replay cue are reset as well
      if (M.cutCss) { Array.prototype.forEach.call(root.querySelectorAll('[data-br]'), function (el) { el.style.strokeOpacity = ''; }); M.cutCss = ''; }
      if (M.ruleCard) { M.ruleCard.removeAttribute('data-rk'); M.ruleCard = null; M.ruleQ = ''; }
      if (M.lnCss) { Array.prototype.forEach.call(root.querySelectorAll('.st-static .o.th-balancing.pv'), function (el) { el.style.opacity = ''; }); M.lnCss = ''; }
      root.classList.remove('st-on');
    }
    function lineShapes() {
      // the line sheet's states (assets/views.js) join the engine's shapes once
      var V = global.StudioViews;
      if (!V || !V.line || M.shapes.__lineAdded) return;
      Object.keys(V.line.states).forEach(function (k) { M.shapes.states[k] = V.line.states[k]; });
      try { Object.defineProperty(M.shapes, '__lineAdded', { value: true }); } catch (e) { M.shapes.__lineAdded = true; }
    }

    function setup() {
      teardown();
      var name = mqWide.matches ? 'wide' : 'compact';
      M.name = name;
      M.pv = variantNow(name);
      M.stage = stageFor(name);
      if (!M.stage) return;
      M.S = build(name);
      if (opts.dev) devRender(M.stage, M.S);
      M.canvas = M.stage.querySelector('canvas.st-live');
      if (!M.canvas) { M.canvas = d.createElement('canvas'); M.canvas.className = 'st-live'; M.canvas.setAttribute('aria-hidden', 'true'); M.stage.appendChild(M.canvas); }
      M.pal = readPalette(root);
      mapping();
      // the sheet panels (M.pv 'r4') occlude with their sheets and rods; the volumes and the band have no occluders
      M.list = (M.pv === 'r4' ? M.S.canvasList : M.S.canvasListFree).map(function (o) { return { o: o, ops: o.kind === 'panel' ? null : opsOf(o) }; });
      M.panels = M.S.panels.slice();
      M.linePo = M.panels.filter(function (po) { return po.panel.tech === 'line'; })[0] || null;
      M.lineShare = 0;
      M.cacheKey = null;
      M.lamps = M.S.live.lamps.map(function (p) { return M.S.cam.p(p); });
      M.lampTh = M.S.live.lamps.map(function () { return 'hvdc'; });   // every lamp belongs to the HVDC theme
      M.state = { bat: { mode: 0, since: null }, open: '', lastT: null };
      laneSetup();
      M.hook = UF.create({
        canvas: M.canvas, shapes: M.shapes, count: 1, seed: 3, drift: 0, restFps: 15,
        sequence: [{ state: 'offshore-47', rest: 1e9 }], render: draw
      });
      setupView();
      beamsSetup();
      // under reduced motion (or a page that starts on Pause) the shared canvas is painted only when a field is
      // created, and the hook field is created before the hybrid panels exist: one more paint of the whole canvas.
      M.hook.refreshStyle();
      if (global.ResizeObserver) {
        M.ro = new global.ResizeObserver(function () { relayout(); });
        M.ro.observe(M.stage);
      }
      M.ready = true;
      root.classList.add('st-on');
      root.setAttribute('data-open', M.state.open || '');   // the first paint (reduced motion: the only one) has set it already
      if (opts.onReady) opts.onReady(M);
    }

    // ── the particle fields: the line field (the engine; its loading against the limit) and the hybrid view's
    // source panels (drawn by the scene's own draw callback, on the same canvas and clock) ──
    function setupView() {
      var spec = PARTICLES[M.name], size = Math.max(1.5, spec.size * M.map.s), side = html.getAttribute('data-hybrid') === 'side', tables = {};
      var first = mqReduce.matches || (UF.motion && UF.motion.isPaused()) ? DECIDED.line : heroAt(0).line;
      M.applied = {};
      M.dotR = size * 0.5;
      M.hyb = [];
      M.panels.forEach(function (po) {
        var P = po.panel, tech = P.tech, ps = spec[tech], F = fieldNow(P);
        if (tech === 'line') {
          lineShapes();
          var f = UF.create({ canvas: M.canvas, shapes: M.shapes, count: ps.count, seed: ps.seed, drift: spec.drift, restFps: 15,
            frame: { x: 0, y: 0, width: F.w, height: F.h }, transform: fieldTransform(F), size: size, primitive: primitive(),
            sequence: LINE.order.map(function (k) { return { state: 'line-' + k, rest: 1e9 }; }), start: 'line-' + first, render: drawLineDots });
          f.__tech = 'line'; M.fields.line = f; M.applied.line = 'line-' + first;
          // the second draw of the same outcomes (its own seed), shown in turn with the first (LINE_RD)
          M.rd = { cur: 0, on: -1, skip: false }; M.rdNow = null; M.lsh = [[0, 0], [0, 0]];
          if (paceNow() !== 'r5') {
            var fb = UF.create({ canvas: M.canvas, shapes: M.shapes, count: ps.count, seed: ps.seed + LINE_RD.seed, drift: spec.drift, restFps: 15,
              frame: { x: 0, y: 0, width: F.w, height: F.h }, transform: fieldTransform(F), size: size, primitive: primitive(),
              sequence: LINE.order.map(function (k) { return { state: 'line-' + k, rest: 1e9 }; }), start: 'line-' + first, render: drawLineDotsB });
            fb.__tech = 'lineB'; M.fields.lineB = fb;
          }
          return;
        }
        tables[tech] = tables[tech] || cloudTable(M.shapes, tech + '-cloud');
        var H = new HybridPanel(tech, ps.count, ps.seed + 20, tables[tech], { w: F.w, h: F.h, L: [F.M[0], F.M[1], F.M[2], F.M[3]] }, side);
        M.hyb.push({ po: po, P: P, F: F, obj: H, T: fieldTransform(F) });
      });
    }

    function primitive() { return (global.devicePixelRatio || 1) >= 1.5 ? 'disc' : 'rect'; }
    function relayout() {
      if (!M.S) return;
      var prim = primitive();
      Object.keys(M.fields).forEach(function (k) { var f = M.fields[k]; if (f.opts.primitive !== prim) { f.opts.primitive = prim; f.refreshStyle(); } });
      var old = M.map; mapping();
      if (old && Math.abs(old.w - M.map.w) < 0.5 && Math.abs(old.h - M.map.h) < 0.5) return;
      if (M.cam) { camReset(); mapping(); }   // a resize puts the switching camera back at once
      remap();
    }
    // the canvas's drawings at the current M.map (relayout and the switching camera's swaps)
    function remap() {
      var spec = PARTICLES[M.name], size = Math.max(1.5, spec.size * M.map.s);
      M.dotR = size * 0.5;
      if (M.fields.line && M.linePo) { M.fields.line.setStyle({ size: size }); M.fields.line.setTransform(fieldTransform(fieldNow(M.linePo.panel))); }
      if (M.fields.lineB && M.linePo) { M.fields.lineB.setStyle({ size: size }); M.fields.lineB.setTransform(fieldTransform(fieldNow(M.linePo.panel))); }
      (M.hyb || []).forEach(function (H) { H.T = fieldTransform(H.F); });
      beamsLayout();
      if (M.hook) M.hook.refreshStyle();
    }

    // ── what the model shows at time t ──
    // The source is the hero loop, or a theme's story while its card is hovered or focused (M.story: { def, t0 }).
    // Every frame resolves it into the flows per lane (MW along the drawn direction), the injections (the battery
    // meters, the vapor, the town's windows), the spine's breakers and blades (switchTick keeps the TSO order through
    // any jump), the line field's state and the cues. A hover's start and end crossfade from what was shown (M.xf); a
    // hero event that falls in the crossfade after a hover is skipped (no breaker light, sweep or ring). Reduced motion
    // and Pause show the DECIDED state (or the story's hold state while a theme is highlighted).
    function laneSetup() {
      var L = M.S.lanes;
      M.laneIdx = {};
      L.forEach(function (ln, i) { M.laneIdx[ln.id] = i; ln.__i = i; });
      M.laneWind = L.map(function (ln) { return WIND_LANE.test(ln.id); });
      M.laneBr = L.map(function (ln) { return ln.src.type === 'branch' ? ln.src.br : null; });
      M.laneScale = L.map(function (ln) { var s = ln.src; return s.type === 'branch' ? 1 / RATE[s.br] : 1 / (Math.abs(s.share || 1) * s.cap); });
      M.laneFl = L.map(function () { return [0, 0]; });
      M.laneLive = L.map(function () { return true; });
      M.shownF = new Float64Array(L.length); M.tmpF = new Float64Array(L.length); M.shownP = {}; M.tmpP = {};
      M.flowKeys = {};
      M.sw = { brk: false, blade: 0, lit: false, flash: null, glint: -10 };
      M.xf = null; M.story = null; M.quietUntil = -1e9; M.spotLv = 0; M.poolA = 0; M.poolRoom = [500, 50]; M.rimK = 0; M.poolKey = null; M.tinted = false;
      // the merit chart's place (its foot projected; a screen-aligned chart standing there) and fade
      var MG = MERIT[M.name], mq = M.S.cam.p([MG.at[0], M.S.ground, MG.at[1]]);
      M.meritG = { x0: mq[0] - MG.w / 2, yb: mq[1], W: MG.w, H: MG.h }; M.meritA = 0; M.meritLast = null;
      // the lanes a sweep runs on when the spine opens: non-wind lanes at 4 % of their rating or more whose flow rises by
      // more than 10 %
      var a = laneFlows('market', []), b = laneFlows('switched', ['L-AD']);
      M.sweepLanes = [];
      L.forEach(function (ln, i) { if (!M.laneWind[i] && Math.abs(b[i]) * M.laneScale[i] >= 0.04 && Math.abs(b[i]) > 1.10 * Math.abs(a[i])) M.sweepLanes.push(i); });
      // each story's lanes (the beams of the other lanes dim during that hover)
      var set = function (re) { return L.map(function (ln) { return re.test(ln.id); }); };
      M.laneSwitch = set(/^L-(AD|DI|ED|BE|AC1|AC2|CI|BA)$/);
      M.laneUnits = set(SWX.UNIT_LANES);   // the pair's own lanes (the gas plant's and the battery park's)
      // the lanes of a gated part (the gas-engine plant's bay and duct, the biomass station's bay, duct and cable) carry no
      // light and no glow unless html[data-bal] opens their gate (applyFlows); with the gate open they keep full light under
      // the sink (beamLaneK)
      M.laneGate = L.map(function (ln) { return ln.gate || null; });
      // the biomass power station's lanes are out of service while it is off (its generator breaker open), so
      // they carry no light and no glow in the hero and before its start in the hover
      M.laneBm = L.map(function (ln) { return ln.src.type === 'el' && ln.src.el === 'biomass'; });
      M.laneBal = set(/^(L-(AD|DI|ED|BE|AC1|AC2|CI|BA|BF)$|gen-|hv-battery|mv-battery-|array-|ac-export-|dc1-|mv-wind-|mv-link-T-F)/);
      M.laneTint = { gen: [], bat: [] };
      L.forEach(function (ln, i) { if (/^gen-/.test(ln.id)) M.laneTint.gen.push(i); if (/^(hv-battery|mv-battery-)/.test(ln.id)) M.laneTint.bat.push(i); });
      // the plinth's top and faces (the follow-spot's clip, so it reaches only the model), the pools and the units, the
      // follow-spot's center: the spine's end at D (the spine / D-I junction), an ellipse of radius R model units (260
      // wide, 120 compact)
      var path = new global.Path2D();
      M.S.objs.forEach(function (o) { if (o.id === 'plinth' || o.id === 'land' || o.id === 'sea') (o.pf || []).forEach(function (f) { path.addPath(p2d(f.sp, true)); }); });
      M.plinthPath = path;
      M.poolG = poolGeom(M.S);
      var ad = L[M.laneIdx['L-AD']], di = L[M.laneIdx['L-DI']], cam = M.S.cam, g = M.S.ground, D = null;
      if (ad && di) {
        var ends = [ad.pts[0], ad.pts[ad.pts.length - 1]], de = [di.pts[0], di.pts[di.pts.length - 1]];
        var dd = function (p) { return Math.min(d2([p[0], p[2]], [de[0][0], de[0][2]]), d2([p[0], p[2]], [de[1][0], de[1][2]])); };
        D = dd(ends[0]) < dd(ends[1]) ? ends[0] : ends[1];
        var R = (M.name === 'wide' ? 260 : 120), c0 = cam.p([D[0], g, D[2]]), cx = cam.p([D[0] + R, g, D[2]]), cz = cam.p([D[0], g, D[2] + R]);
        M.spotG = { c: [c0[0], c0[1]], rx: Math.abs(cx[0] - c0[0]), ry: Math.max(Math.abs(cz[1] - c0[1]), 0.3 * Math.abs(cx[0] - c0[0])) };
      }
      M.flashR = M.name === 'wide' ? 17 : 11;
      var hlSvg = M.stage.querySelector('svg.st-hl');
      M.poolEls = hlSvg ? { cheap: hlSvg.querySelector('.pool-cheap'), dear: hlSvg.querySelector('.pool-dear'), rim: hlSvg.querySelector('.pool-rim') } : null;
    }
    function laneFlows(state, open) {
      var key = state + '|' + open.join(','), F = M.flowKeys[key];
      if (!F) { var res = variant(state, open); F = M.flowKeys[key] = M.S.lanes.map(function (ln) { return laneFlow(ln, res, RATE)[0]; }); }
      return F;
    }
    function fixedEv(state, open) { var e = { a: state, oa: open, b: state, ob: open, k: 1, kc: 1 }; return { wind: e, rest: e }; }
    function window01(h, a, b, up, down) { return h < a || h > b + down ? 0 : h < a + up ? smooth((h - a) / up) : h <= b ? 1 : 1 - smooth((h - b) / down); }
    function dipAt(h, D) { if (!D || h < D[0] || h > D[1]) return 0; var u = h - D[0], L = D[1] - D[0]; return u < 0.2 ? u / 0.2 : u < L - 0.4 ? 1 : (L - u) / 0.4; }
    // the operator selects the line before the breakers open: the spine is traced in the operator's ink over the last
    // 0.9 s (lead: s until the opening)
    function selAt(lead) { return lead > 0 && lead <= 0.9 ? smooth((0.9 - lead) / 0.45) : 0; }
    function frameView(t, still) {
      var st = M.story, ev, tgt, line, cues = { rings: [], pools: null, rim: 0, tint: null, dip: 0, spot: 0, sel: 0 };
      if (still) {
        // a balancing or HVDC story with a hold state (def.hold) shows it; a balancing story without one shows aware_miss,
        // anything else the DECIDED state
        var bal = st && st.def.key === 'balancing', HD = (bal || (st && st.def.key === 'hvdc')) && st.def.hold;
        ev = HD ? fixedEv(HD.state, HD.open) : fixedEv(bal ? 'aware_miss' : DECIDED.state, DECIDED.open);
        var hdOpen = !!HD && openIn(HD.open);   // whether the hold keeps the spine out
        tgt = HD ? { brk: hdOpen, blade: hdOpen ? 1 : 0, instant: true } : { brk: true, blade: 1, instant: true };
        line = HD ? HD.line : DECIDED.line;
        if (bal && (!HD || HD.pools)) cues.pools = { room: HD ? HD.pools : [100, 250], a: 1 };   // a hold without pools draws none
        if (bal && st.def.merit) cues.merit = meritAt(st.def, st.def.end, ROOMS);   // the merit chart's hold state
        if (bal && st.def.ladder) cues.ladder = ladderAt(st.def, st.def.end);   // the bid ladder's hold, complete
        if (bal && st.def.windDim) cues.windK = st.def.windDim[2];   // the hold keeps the wind's lanes stepped back
        if (st && st.def.spot) cues.spot = 1;
        if (st && st.def.r6) { cues.iso = 1; cues.units = 1; cues.r6 = st.def.r6; }
        if (st && st.def.r6 && st.def.r6.mode === 'day') { cues.units = 0; cues.hcL = 1; cues.trL = 1; cues.u = DAYX.still * DAYX.q; cues.redK = 0; }   // the HVDC day's still (09:30)
        if (bal && st.def.sink) { cues.iso = 1; cues.units = 1; cues.bsink = true; }   // the balancing sink, held
        return { src: st ? st.def.key : 'decided', ev: ev, tgt: tgt, line: line, cues: cues };
      }
      if (st) {
        var h = t - st.t0, D = st.def, R = D.r6, h0 = h;
        // a replayed story runs on h modulo its loop (the first pass from the hover's start)
        if (R && R.loop && h >= R.loop) h = h % R.loop;
        // the glide: the switching replay's restart from D.back.t0 to the end of the pass, one crossfade of the DECIDED state
        // into the schedule (smoothstep over [t0, t1]). The events (the selection, the breaker light, the sweep, the rings) stay on h
        // and none of them plays on the way back
        var BK = D.back && h >= D.back.t0 ? D.back : null, u9 = BK ? clamp((h - BK.t0) / (BK.t1 - BK.t0), 0, 1) : 0, lineMsAll = 0;
        var b = stepAt(D.brk, h);
        ev = { wind: evalKeys(D.keys, h, 'wind'), rest: evalKeys(D.keys, h, 'rest') };
        // the HVDC hover's day: the two knots around the day time at h (dayAt), one weight for every injection, in the
        // topology dayStory's brk shows (the spine open until h0 if it was open at the hover's start)
        if (R && R.mode === 'day') { var dy = dayAt(h0), dop = D.open0 && h0 < DAYX.h0 ? [ANIMATED[0]] : [], de = { a: 'day' + dy.j, b: 'day' + ((dy.j + 1) % DAYX.n), k: dy.f, kc: dy.f, oa: dop, ob: dop }; ev = { wind: de, rest: de }; }
        tgt = { brk: b[1], blade: b[1] ? clamp((h - b[0] - SCHED.bladeLag) / SCHED.swing, 0, 1) : 0, light: b[2], sweep: b[3], closeLight: 0, instant: !!b[4] };
        if (BK) {
          // the breakers close at the restart's first frame, out of sight (instant: no breaker light, no sweep, no glint); every lane's
          // light, the units' light, the line field, the switched line's dashes, conductor and light, and D-I's glow follow one ease
          // (cues.glide); the open blades fade out over the closed ones (draw), so nothing returns ahead of the rest and no single frame
          // puts the line back
          var gk9 = smooth(u9), k09 = D.keys[D.keys.length - 1], k19 = D.keys[0], e9 = { a: k09[1], oa: k09[3], b: k19[1], ob: k19[3], k: gk9, kc: gk9 };
          ev = { wind: e9, rest: e9 }; cues.glide = gk9;
          tgt.brk = false; tgt.blade = 0; tgt.light = 0; tgt.sweep = false; tgt.instant = true; lineMsAll = BK.ms;
          cues.back = u9 < 1 ? 1 : 0;   // the card's replay cue (cutTick)
          cues.glideTail = 1;   // from the restart's start to the end of the pass: D-I's glow comes back softly (drawActR6)
        }
        if (R) {
          var T6 = SWX.T;
          cues.iso = smooth(h0 / T6.isoIn);
          // a story without a redispatch pair (the HVDC hover) has no units to light and no decision framing
          cues.units = R.pair == null ? 0 : smooth((h - (R.pair - T6.units)) / T6.units) * (cues.glide != null ? 1 - cues.glide : 1);
          // the HVDC day's cues: the HVDC color's and the trackers' progress (linear; draw eases them), the day time for the
          // trackers, the overload red's factor (out over DAYX.red from the hover's start)
          if (R.mode === 'day') { cues.hcL = clamp((h0 - DAYX.col[0]) / DAYX.col[1], 0, 1); cues.trL = clamp((h0 - DAYX.trk[0]) / DAYX.trk[1], 0, 1); cues.u = dy.u; cues.redK = 1 - smooth(h0 / DAYX.red); }
          // the decision framing: a replayed act keeps it from the first pass's pair on (no camera move in the restart and none
          // before the next pair)
          cues.decCam = R.pair != null && ((R.loop && h0 >= R.pair - T6.dec[0]) || h >= R.pair - T6.dec[0]) ? 1 : 0;
          // the hover's first frame takes the schedule at once (the spine closed, the line field on the market hour)
          cues.r6 = R; cues.lineInstant = !!b[4] || !st.began; tgt.sw6 = SWX.SWEEP;
          if (!st.began) { tgt.instant = true; st.began = true; }
          if (D.sel) cues.sel = h >= D.sel[0] && h < D.sel[1] ? smooth((h - D.sel[0]) / (0.55 * (D.sel[1] - D.sel[0]))) : 0;
        }
        // a story with D.instant starts from the schedule at once, as the switching push-in does
        if (D.instant && !R) { if (!st.began) { tgt.instant = true; cues.lineInstant = true; st.began = true; } }
        var lst = stepAt(D.line, h), lineMs = lst[2] || 0; line = lst[1];   // a line entry's own morph time (ms)
        if (BK) line = D.line[0][1];   // the restart takes the line field to the schedule at its start
        D.rings.forEach(function (r) { var age = h - r[0]; if (age >= 0 && age < SCHED.ringT) cues.rings.push(r[2] ? [age, r[1], r[2]] : [age, r[1]]); });   // r[2]: the ring's units, if any
        if (D.pools) {
          var pi = 0;
          D.pools.forEach(function (q, j) { if (q[0] <= h) pi = j; });
          var cur = D.pools[pi], prev = D.pools[Math.max(0, pi - 1)], k = smooth((h - cur[0]) / Math.max(1e-3, cur[3]));
          cues.pools = { room: [lerp(prev[1], cur[1], k), lerp(prev[2], cur[2], k)], a: smooth(h / 0.8) };
          cues.rim = window01(h, D.rim[0], D.rim[1], 0.4, 0.6);
          cues.tint = D.tint.map(function (w) { return [w[2], window01(h, w[0], w[1], 0.3, 0.6)]; });
          cues.dip = dipAt(h, D.dip);
        } else if (D.tint) cues.tint = D.tint.map(function (w) { return [w[2], window01(h, w[0], w[1], 0.3, 0.6)]; });   // a story without pools
        if (D.spot) cues.spot = smooth((h - D.spot[0]) / (D.spot[1] - D.spot[0]));
        // D-I's halo, the redispatch arrows ([age, MW, dashed, alpha]) and the merit chart
        if (D.hot) { cues.hot = 0; D.hot.forEach(function (w) { cues.hot = Math.max(cues.hot, window01(h, w[0], w[1], 0.3, 0.6)); }); }
        if (D.pair) {
          cues.pairs = [];
          D.pair.forEach(function (q) { var age = h - q[0]; if (age >= 0 && age < PAIR.life) cues.pairs.push([age, q[1], false, 1]); });
          if (D.cf) { var cw = window01(h, D.cf[0], D.cf[1], 0.5, 0.6); if (cw > 0.004) cues.pairs.push([h - D.cf[0], D.cf[2], true, cw]); }
        }
        // the redispatch as arrows proportional to MW at several units ([age, 0, dashed, alpha, [[unit, MW], ...]])
        if (D.pair6) {
          cues.pairs = [];
          // with pairEnd every arrow of the decision lives until that moment, so they go together
          D.pair6.forEach(function (q) { var age = h - q[0], life = D.pairEnd ? D.pairEnd - q[0] : PAIR.life; if (age >= 0 && age < life) cues.pairs.push([age, 0, false, 1, q[1], D.pairK || 0, life]); });
          if (D.cf6) { var cw6 = window01(h, D.cf6[0], D.cf6[1], 0.5, 0.6) * (D.cfA || 1); if (cw6 > 0.004) cues.pairs.push([h - D.cf6[0], 0, true, cw6, D.cf6[2], D.pairK || 0]); }
        }
        // the counterfactual (D.cf) is redispatch alone: while its dashed pair shows, the opened spine's dash steps back.
        // The model keeps showing the decision taken; only the emphasis changes
        cues.cfK = D.cf ? window01(h, D.cf[0], D.cf[1], 0.5, 0.6) : 0;
        if (D.merit) { cues.merit = meritAt(D, h, ROOMS); cues.merit.a = smooth(h / 0.8); }
        // the bid ladder, and each unit's ring pulses when its own bids change
        if (D.ladder) {
          var rT = D.ladder.ring || 0.4;   // the ring's pulse lasts as long as its unit's change (D.ladder.ring, 0.4 s by default)
          cues.ladder = ladderAt(D, h); cues.pulses = [];
          D.ladder.steps.forEach(function (q) { var age = h - q[0]; if (age >= 0 && age < rT) cues.pulses.push([B7U[q[1]], age, rT]); });
        }
        // the wind's lanes step back as the wind falls short (their light times 1 - windDim[2] x the ease)
        if (D.windDim) cues.windK = smooth((h - D.windDim[0]) / D.windDim[1]) * D.windDim[2];
        // D.sink: the rest of the model sinks as in the switching push (in over isoIn), the units lit
        if (D.sink) { cues.iso = smooth(h0 / SWX.T.isoIn); cues.units = 1; cues.bsink = true; }
        D.brk.forEach(function (q) { if (q[1] && q[2] > 0) cues.sel = Math.max(cues.sel, selAt(q[0] - h)); });
        return { src: D.key, h: h, ev: ev, tgt: tgt, line: line, lineMs: lineMs, lineMsAll: lineMsAll, cues: cues };
      }
      // while the HVDC theme is highlighted the hero holds the moment the hover began (M.heroHold), so nothing changes
      // under it: DC-2 keeps its exchange (it changes with the hour), no line is switched and no unit moves; a held hero
      // draws no rings and no selection. On leaving, it crossfades to its own clock
      var tH = M.heroHold ? M.heroHold.t : t, H = heroAt(tH), T0 = tH - H.tt, quiet = t < M.quietUntil;
      tgt = { brk: H.brk, blade: H.blade, light: quiet ? 0 : 1, sweep: !quiet, closeLight: quiet ? 0 : 0.4 };
      if (M.swSnap) tgt.instant = true;   // the first frame after leaving the HVDC day
      if (!M.heroHold) HERO.rings.forEach(function (r) { var age = H.tt - r[0]; if (age >= 0 && age < SCHED.ringT && T0 + r[0] >= M.quietUntil) cues.rings.push([age, r[1]]); });
      if (!quiet && !M.heroHold) SCHED.events.forEach(function (e) { cues.sel = Math.max(cues.sel, selAt(e.open - H.tt)); });
      return { src: 'hero', h: H.tt, ev: { wind: H.wind, rest: H.rest }, tgt: tgt, line: H.line, cues: cues };
    }
    // the spine's breakers (both ends, one event) and its blades: out, breakers first and the blades after; in, the
    // blades first and the breakers after; the blades never swing faster than the schedule's 0.8 s
    function switchTick(t, dt, tg) {
      var s = M.sw;
      if (tg.instant) { s.brk = tg.brk; s.blade = tg.blade; s.flash = null; return; }
      if (tg.brk && !s.brk) {
        s.brk = true; s.lit = tg.light > 0;
        if (tg.light > 0) s.flash = { t: t, a: tg.light };
        var S6 = tg.sw6;   // a stronger, slightly longer reroute sweep in the switching hover
        if (tg.sweep && M.beams) M.sweepLanes.forEach(function (i) { M.beams.sweep(i, t + (S6 ? S6.delay : 0.2), S6 ? S6.dur : 0.8, S6 ? S6.gain : undefined); });
      }
      var want = s.brk && tg.brk ? tg.blade : 0, prev = s.blade, mx = dt / SCHED.swing + 1e-6;
      s.blade = prev + clamp(want - prev, -mx, mx);
      if (prev < 0.52 && s.blade >= 0.52 && s.lit) s.glint = t;
      if (!tg.brk && s.brk && s.blade <= 1e-6) {
        s.brk = false; s.blade = 0; s.lit = false;
        if (tg.closeLight > 0) s.flash = { t: t, a: tg.closeLight };
      }
    }
    function openIn(list) { return !!list && list.indexOf(ANIMATED[0]) >= 0; }
    function resolveFlows(ev, out) {
      var n = out.length, c = {}, i;
      ['wind', 'rest'].forEach(function (k) { var g = ev[k]; c[k] = [laneFlows(g.a, g.oa), laneFlows(g.b, g.ob)]; });
      for (i = 0; i < n; i++) {
        var gk = M.laneWind[i] ? 'wind' : 'rest', g = ev[gk], br = M.laneBr[i];
        var cut = br && ((g.oa.indexOf(br) >= 0) !== (g.ob.indexOf(br) >= 0));
        out[i] = lerp(c[gk][0][i], c[gk][1][i], cut ? g.kc : g.k);
      }
    }
    function resolveP(ev, out) {
      var r = ev.rest, w = ev.wind, pa = STATES[r.a] || {}, pb = STATES[r.b] || {};
      Object.keys(pb).forEach(function (k) { out[k] = lerp(pa[k] || 0, pb[k], r.k); });
      ['offshore_wind', 'onshore_wind'].forEach(function (k) { out[k] = lerp((STATES[w.a] || {})[k] || 0, (STATES[w.b] || {})[k] || 0, w.k); });
    }
    // the flows and injections shown: the source, crossfaded from a snapshot after a hover's start or end; no light
    // on a line whose breakers are open
    function applyFlows(t, V, still) {
      var n = M.shownF.length, F = M.tmpF, P = M.tmpP, i;
      resolveFlows(V.ev, F); resolveP(V.ev, P);
      var brk = M.sw.brk, exact = false;
      if (M.xf) {
        var c = still ? 1 : smooth((t - M.xf.t0) / M.xf.dur);
        if (c >= 1) M.xf = null;
        else {
          for (i = 0; i < n; i++) F[i] = lerp(M.xf.F[i], F[i], c);
          Object.keys(P).forEach(function (k) { if (M.xf.P[k] != null) P[k] = lerp(M.xf.P[k], P[k], c); });
          if (M.xf.open !== brk) exact = true;
        }
      }
      // a blend of two flow patterns adds up only when both have the topology the breakers show.
      // While a line is switched out or back in (or a crossfade spans both topologies), the flows are the DC power flow
      // of the shown injections with the breakers' actual state: they change in the frame the breakers operate (the
      // light itself eases over about 0.3 s) and Kirchhoff holds in every frame.
      ['wind', 'rest'].forEach(function (k) { var g = V.ev[k]; if (openIn(g.ob) !== brk || ((g.k < 1 || g.kc < 1) && openIn(g.oa) !== brk)) exact = true; });
      // the glide is a crossfade of two computed states (the DECIDED state, the spine open, and the schedule): each
      // lane's light is the blend of its two DC power flows with the blended injections, so every bus balances in every frame, and the
      // switched line's light fills back with its conductors (drawBeams); it is a picture dissolving into the other, not a third flow.
      // The exact flow is skipped as well while that dissolve runs on after the hover is left (M.glK < 1, draw), into the next
      // source's flows
      if (exact && !(V.cues && V.cues.glide != null) && !(M.glK < 1)) {
        var res = dcFlow(NET, P, brk ? ANIMATED : []);
        for (i = 0; i < n; i++) F[i] = laneFlow(M.S.lanes[i], res, RATE)[0];
      }
      var gateOpen = html.getAttribute('data-bal');   // a gated lane is out of service unless its gate is open
      for (i = 0; i < n; i++) {
        var lg = M.laneGate[i], br = M.laneBr[i], dead = !!(br && M.sw.brk && ANIMATED.indexOf(br) >= 0) || (!!lg && lg !== gateOpen) || (M.laneBm[i] && Math.abs(P.biomass || 0) < 0.5), f = dead ? 0 : F[i];
        M.shownF[i] = f; M.laneFl[i][0] = f; M.laneFl[i][1] = Math.abs(f) * M.laneScale[i]; M.laneLive[i] = !dead;
      }
      Object.keys(P).forEach(function (k) { M.shownP[k] = P[k]; });
    }
    function snapshot(t, dur) { M.xf = { F: Float64Array.from(M.shownF), P: Object.assign({}, M.shownP), t0: t, dur: dur, open: M.sw.brk }; }
    // the line field follows the source (morphs of 0.7 s into a decision, 1.4 s out of one: the calm hour, a story's
    // cut back, leaving a hover; 3 s for a new hour; instant when still). The short morph into a decision keeps the field in
    // step with D-I's cooling after the opening
    var LINE_MORPH = { dec: 700, out: 1400, hour: 3000 };
    function lineTick(key, instant, msIn, msAll) {
      var f = M.fields.line, id = 'line-' + key;
      if (!f || M.applied.line === id) return;
      var into = /^(switched|aware|blind|b6_aware|b7_aware)$/.test(key), dec = into || /-(switched|aware|blind|b6_aware|b7_aware)$/.test(M.applied.line || '');   // b6_aware and b7_aware are decisions too
      // msAll: the switching restart's own morph time, in either direction
      var ms = msAll || (into && msIn ? msIn : into ? LINE_MORPH.dec : dec ? LINE_MORPH.out : LINE_MORPH.hour);
      M.applied.line = id;
      global.Promise.resolve().then(function () { if (!f.destroyed) f.goTo(id, { hold: true, morph: ms, instant: !!instant }); });
      var fb = M.fields.lineB;   // the second draw follows in step
      if (fb) global.Promise.resolve().then(function () { if (!fb.destroyed) fb.goTo(id, { hold: true, morph: ms, instant: !!instant }); });
    }
    // the line field's redraw at time t (LINE_RD): M.rdNow is { n, u, from, to } while a window runs, else
    // null; after a window the other draw is shown (M.rd.cur). A window that starts during a story or its crossfade is
    // skipped (the shown draw stays); Pause or reduced motion show the first draw.
    function rdFrame(t, still) {
      var R = M.rd;
      if (!R || !M.fields.lineB) { M.rdNow = null; return; }
      if (still) { M.rdNow = null; R.cur = 0; R.on = -1; return; }
      var P = LINE_RD.period, c = Math.floor(t / P), tt = t - c * P, n = -1, u = 0, j;
      for (j = 0; j < LINE_RD.at.length; j++) if (tt >= LINE_RD.at[j] && tt < LINE_RD.at[j] + LINE_RD.dur) { n = c * LINE_RD.at.length + j; u = (tt - LINE_RD.at[j]) / LINE_RD.dur; }
      if (R.on >= 0 && n !== R.on) { if (!R.skip) R.cur = 1 - R.cur; R.on = -1; }
      if (n >= 0 && R.on < 0) { R.on = n; R.skip = !!(M.story || M.xf); }
      M.rdNow = n >= 0 && !R.skip ? { n: n, u: u, from: R.cur, to: 1 - R.cur } : null;
    }
    // each particle's weight in draw f during a window: it swaps at its own moment s_i (a hash of its index) and fades over
    // LINE_RD.fade; cached per window and per progress
    function rdWeights(R, f, n) {
      var S = M.rd, i, fd = LINE_RD.fade / LINE_RD.dur;
      if (!S.s || S.sn !== R.n || S.s.length !== n) {
        S.s = new Float32Array(n); for (i = 0; i < n; i++) S.s[i] = hash01(R.n + 101, i, 5) * (1 - fd);
        S.sn = R.n; S.w = [new Float32Array(n), new Float32Array(n)]; S.wu = -1;
      }
      if (S.wu !== R.u) { for (i = 0; i < n; i++) { var x = clamp((R.u - S.s[i]) / fd, 0, 1); S.w[R.to][i] = x; S.w[R.from][i] = 1 - x; } S.wu = R.u; }
      return S.w[f];
    }
    // the battery meters during a story follow the shown set-point from where they were (rate by MW, integrated each
    // frame, so they turn with the shown set-point); after it, each meter keeps its offset from the
    // hero's level and closes it only while that adds to its own motion (never against the set-point)
    function storyBattery(t, V, still, dt) {
      var b = M.state.bat, i;
      if (still) return;
      if (M.story) {
        if (!b.mode || !b.lv) { b.lv = [0, 1, 2, 3, 4, 5, 6, 7].map(function (q) { return batteryAt(t, q); }); b.mode = 1; b.off = null; }
        var d = M.story.def.day ? 0 : BAT.rate * (M.shownP.battery || 0) / 250 * (dt || 0);   // the HVDC day holds the meters
        for (i = 0; i < b.lv.length; i++) b.lv[i] = clamp(b.lv[i] - d, 0.12, 0.92);
      } else if (b.off) {
        var mw = M.shownP.battery || 0, dir = Math.abs(mw) > 5 ? -Math.sign(mw) : 0, step = BAT.rate * (dt || 0), any = false;
        for (i = 0; i < b.off.length; i++) {
          if (dir && b.off[i] * dir < 0) b.off[i] = Math.sign(b.off[i]) * Math.max(0, Math.abs(b.off[i]) - step);
          if (Math.abs(b.off[i]) > 1e-4) any = true;
        }
        if (!any) b.off = null;
      }
    }
    function leaveBattery(t) {
      var b = M.state.bat;
      if (!b.mode) return;
      var now = [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) { return batteryAt(t, i); });
      b.off = now.map(function (v, i) { return v - batteryLevel(t, i); });
      b.mode = 0; b.since = null; b.mw = null; b.lv = null;
    }

    // per-frame dimming of the dots (custom renderers): sources follow "renewables", the line sheet
    // stays lit for its own two stories
    function dotDim(kind) {
      var kd = M.dimNow ? M.dimNow.kd : 1, h0 = M.dim.from, h1 = M.hl;
      var r6 = M.view && M.view.cues && M.view.cues.r6;   // the source panels sink with the model in the corridor light
      // under a story's sink the source dots sink to SWX.SINK.dots, so the source panels' folds and day waves do not
      // compete with the story; their clock runs on
      var f = function (h) { if (!h) return 1; if (h === 'hvdc' && M.hvSink) return kind === 'line' ? 1 : SWX.SINK.dots;   // the line field is scaled by M.lnK instead
        if (kind === 'line') return h === 'switching' || h === 'balancing' ? 1 : 0.25; return h === 'renewables' ? 1 : h === 'switching' ? (r6 ? SWX.SINK.dots : 0.5) : h === 'balancing' && M.balSink ? SWX.SINK.dots : 0.25; };
      return lerp(f(h0), f(h1), kd) * (kind === 'line' ? (M.lnK == null ? 1 : M.lnK) : 1);   // M.lnK: the HVDC day's line factor
    }
    function square() { return primitive() === 'rect'; }
    function drawLineDots(fr, ctx) {
      if (!ctx) return;
      // with two draws, only the one shown draws (or both, by weight, while a redraw runs)
      if (M.fields.lineB && (M.rdNow || M.rd.cur !== 0)) return drawLineSet(fr, ctx, 0);
      var p = M.pal.dot, X = fr.x, lim = LINE_LIMIT(), a = p.alpha * dotDim('line'), sq = square(), r = M.dotR, over = 0, i;
      ctx.globalCompositeOperation = p.blend;
      dots(ctx, fr.px, fr.py, fr.n, r, p.color, a, function (i) { return X[i] <= lim; }, sq);
      ctx.globalCompositeOperation = 'source-over';
      // past the limit: a warm color (the only second color of the particles), composited source-over, not with the dots' blend
      dots(ctx, fr.px, fr.py, fr.n, r * 1.08, M.pal.s.warm, Math.min(1, a * 1.05), function (i) { return X[i] > lim; }, sq);
      // the share past the limit warms the rail and lets warm light leak past it (next frame's furniture)
      for (i = 0; i < fr.n; i++) if (X[i] > lim) over++;
      M.lineShare = fr.n ? over / fr.n : 0;
      if (M.lsh) M.lsh[0] = [over, fr.n];
    }
    function drawLineDotsB(fr, ctx) { if (ctx) drawLineSet(fr, ctx, 1); }
    // one draw of the line field with its particles' weights (LINE_RD): a draw not shown and not in a
    // redraw draws nothing; while a redraw runs each particle is drawn at its weight, in a few alpha levels (one fill per
    // level and color). The share past the limit is the weighted share over both draws.
    function drawLineSet(fr, ctx, f) {
      var R = M.rdNow, X = fr.x, lim = LINE_LIMIT(), over = 0, ws = 0, i, q;
      if (!R && f !== M.rd.cur) { M.lsh[f] = [0, 0]; return; }
      var p = M.pal.dot, a = p.alpha * dotDim('line'), sq = square(), r = M.dotR, LV = LINE_RD.levels;
      var w = R ? rdWeights(R, f, fr.n) : null, lv = function (i) { return w ? (w[i] <= 0.001 ? 0 : Math.ceil(w[i] * LV)) : LV; };
      ctx.globalCompositeOperation = p.blend;
      for (q = 1; q <= LV; q++) { if (!w && q < LV) continue; dots(ctx, fr.px, fr.py, fr.n, r, p.color, a * q / LV, function (i) { return X[i] <= lim && lv(i) === q; }, sq); }
      ctx.globalCompositeOperation = 'source-over';
      for (q = 1; q <= LV; q++) { if (!w && q < LV) continue; dots(ctx, fr.px, fr.py, fr.n, r * 1.08, M.pal.s.warm, Math.min(1, a * 1.05) * q / LV, function (i) { return X[i] > lim && lv(i) === q; }, sq); }
      for (i = 0; i < fr.n; i++) { var wi = w ? w[i] : 1; ws += wi; if (X[i] > lim) over += wi; }
      M.lsh[f] = [over, ws];
      var W = M.lsh[0][1] + M.lsh[1][1];
      M.lineShare = W ? (M.lsh[0][0] + M.lsh[1][0]) / W : 0;
    }

    function draw(frame, ctx) {
      if (!ctx || !M.S) return;
      var t = frame.time / 1000, pal = M.pal, m = M.map, cam = M.S.cam, hl = M.hl, kd = dimK(), hl0 = M.dim.from;
      M.dimNow = { kd: kd };
      if (!M.dim.done) {
        if (kd >= 1) { M.dim.done = true; if (M.hook) M.hook.opts.restFps = 15; }
      }
      // reduced motion, or Pause: the DECIDED state, or the highlighted story's hold state
      var reduced = mqReduce.matches, still = reduced || !!(UF.motion && UF.motion.isPaused());
      M.stillNow = still;
      var dt = M.state.lastT == null ? 0 : clamp(t - M.state.lastT, 0, 0.25);
      M.state.lastT = t;
      M.t = t;
      rdFrame(t, still);   // the line field's redraw, before its two draws paint
      var V = frameView(t, still);
      M.view = V;
      sayTick(t, still);   // the story text's beat, from the view just framed
      var T6 = M.swTiming ? global.performance.now() : 0;   // profiling: M.swTiming = { ms: 0, n: 0 } times the switching code
      camTick(dt, V, still);   // the switching camera (may move the canvas's mapping)
      m = M.map;
      if (M.swTiming) M.swTiming.ms += global.performance.now() - T6;
      // the HVDC hover's day. hcL, trL: the HVDC color's and the trackers' progress (linear; hcK, trK their smoothstep):
      // from the story's cues while it runs (never below what a leave left), back over DAYX.out after it, 1 in its still; trU the day
      // time the trackers face; redK the overload red's factor (1 outside the day); lnK the line field's (dots, rail, wash, volume and
      // furniture): out with the day's sink (1 - its rise), back over isoOut after it, 0 in its still
      var dS = V.src === 'hvdc' && !!V.cues.r6 && V.cues.r6.mode === 'day', trK0 = M.trK || 0;
      if (still) { M.hcL = dS ? 1 : 0; M.trL = dS ? 1 : 0; M.lnK = dS ? 0 : 1; }
      else {
        M.hcL = Math.max(dS ? V.cues.hcL : 0, Math.max(0, (M.hcL || 0) - dt / DAYX.out.col));
        M.trL = Math.max(dS ? V.cues.trL : 0, Math.max(0, (M.trL || 0) - dt / DAYX.out.trk));
        M.lnK = dS ? 1 - (V.cues.iso || 0) : Math.min(1, (M.lnK == null ? 1 : M.lnK) + dt / SWX.T.isoOut);
      }
      M.hcK = smooth(M.hcL); M.trK = smooth(M.trL);
      if (dS) M.trU = V.cues.u;
      M.redK = dS ? V.cues.redK : 1;
      // the trackers hold still in the HVDC day (dayTrackerA). A day that starts from the hero's sweep (trK 0 before it: fresh)
      // slows that sweep to a stop and holds it; one that starts while they still return from a day just left keeps the angle
      // held then
      if (dS && M.trSt !== M.story) { M.trSt = M.story; M.trFresh = !(trK0 > 0) || M.trHoldA == null; }
      if (!dS) M.trSt = null;
      M.trDay = dS; M.trH = dS && M.story ? Math.max(0, t - M.story.t0) : 0; M.trT0 = dS && M.story ? M.story.t0 : 0;
      M.trAng = dayTrackerA(t);
      // the switching replay's restart as shown (M.glK; 1: none): the story's own while it dissolves; when still at
      // once 1. The switched line's conductor fills back with it (drawSwOn, cutTick), its dashes and open blades fade out over the solid
      // line and closed blades (drawActR6, the breakers below) and its flow light comes up with it (drawBeams).
      // Left mid-restart (or a card changed), the dissolve runs on to the state the next source shows over 0.6 s:
      // on to the schedule when its spine is closed, or back to the open line when it shows the spine open (the hero's own switching
      // state, 8.0 to 31.2 s of its loop). The breakers stay closed inside that dissolve and open out of sight at its end, once the
      // leave's flow crossfade is done (no light, no blade swing)
      var glv = V.src === 'switching' && V.cues.glide != null && !still ? V.cues.glide : null, gl0 = M.glK == null ? 1 : M.glK;
      if (glv != null) M.glK = glv;
      else if (still || gl0 >= 1) M.glK = 1;
      else if (V.tgt.brk) {
        M.glK = Math.max(0, gl0 - dt / 0.6);
        if (M.glK <= 0 && !M.xf) { M.glK = 1; V.tgt = { brk: true, blade: V.tgt.blade, instant: true }; }
        else V.tgt = { brk: false, blade: 0, instant: true };
      } else M.glK = Math.min(1, gl0 + dt / 0.6);
      if (M.qaGlK != null) M.glK = M.qaGlK;   // test hook: M.qaGlK holds the dissolve at a value
      // the switched line's conductor, its flow light and its closed blades come back by glC, and its dashes and open blades go by
      // 1 - glC, glC = glK ^ glideP (the palette: light 2, dark 1). Over a light ground a dark line reads as solid from a third of its
      // alpha and a fading dash as gone well before its alpha is, so at glK alone the line would run ahead of the chart's points; a
      // light line over the dark ground keeps step at glK
      M.glC = Math.pow(M.glK, parseFloat(M.pal && M.pal.s && M.pal.s.glideP) || 1);
      // M.swCv: the canvas holds the switched line's conductor (drawSwOn) and the static copy stays at 0 (cutTick), from a
      // restart's first frame until the switching story has ended, the dissolve is done and the camera rests at the hero's
      // framing. The two copies differ in their anti-aliasing at the push-in's zoom (the static layer is scaled by CSS, the
      // canvas is drawn at the zoom); unzoomed they agree, so the copy goes back to the static layer only there. Within the
      // hover the conductor then leaves only at an opening
      if (V.src === 'switching' && V.cues.glide != null && !still) M.swCv = true;
      else if (M.swCv && (still || (V.src !== 'switching' && M.glK >= 1 && (!M.cam || !M.cam.fit || M.cam.u <= 0)))) M.swCv = false;
      cutTick(V, still);   // the switched line's conductors in the glide and the card's rule in a replay's restart
      dayLineCss();   // the line field's static groups with the HVDC day's line factor
      switchTick(t, dt, V.tgt);
      M.swSnap = false;   // M.swSnap lasts one frame, the first after leaving the HVDC day
      applyFlows(t, V, still);
      storyBattery(t, V, still, dt);
      // which lines are out of service: the stage's CSS shows them dashed (both SVG layers)
      var openKey = M.sw.brk ? ANIMATED.join(' ') : '';
      if (openKey !== M.state.open) { M.state.open = openKey; root.setAttribute('data-open', openKey); }
      ctx.save();
      ctx.setTransform(frame.dpr * m.s, 0, 0, frame.dpr * m.s, frame.dpr * m.ox, frame.dpr * m.oy);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      // the town's lit windows follow its load (dark): #studio[data-load] for the SVG, the load tier
      // in the canvas caches for occluding houses
      var tier = loadTier(-(M.shownP.town || 0));
      if (tier !== M.loadTier) { M.loadTier = tier; root.setAttribute('data-load', String(tier)); }
      var dpr = frame.dpr, key = dpr + '|' + m.s + '|' + m.ox + '|' + m.oy + '|' + M.palVersion + '|' + M.loadTier;
      if (M.cacheKey !== key) { buildCaches(dpr); M.cacheKey = key; }
      for (var i = 0; i < M.list.length; i++) {
        var it = M.list[i], o = it.o;
        ctx.globalAlpha = lerp(dimAlpha(hl0, o), dimAlpha(hl, o), kd);
        if (it.cv) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(it.cv, it.cx, it.cy);
          ctx.setTransform(dpr * m.s, 0, 0, dpr * m.s, dpr * m.ox, dpr * m.oy);
        }
        if (o.kind === 'turbine') drawRotor(ctx, o, t, pal, cam);
        else if (o.kind === 'trackers') drawTrackers(ctx, o, t, pal, cam);
        else if (o.kind === 'battery') drawBattery(ctx, o, t, pal, cam);
        else if (o.kind === 'breaker') {
          // in the glide the open blades fade out over the closed ones, no swing
          if (M.glK < 1 && !M.sw.brk) { var ga9 = ctx.globalAlpha, gc9 = M.glC == null ? M.glK : M.glC; ctx.globalAlpha = ga9 * (1 - gc9); drawBlade(ctx, o, 1, t, pal, cam); ctx.globalAlpha = ga9 * gc9; drawBlade(ctx, o, M.sw.blade, t, pal, cam); }   // weighted by glC
          else drawBlade(ctx, o, M.sw.blade, t, pal, cam);
        }
      }
      drawLamps(ctx, t, pal, hl0, hl, kd);
      ctx.globalAlpha = lerp(dimAlpha(hl0, 'balancing'), dimAlpha(hl, 'balancing'), kd);
      drawVapour(ctx, t, dt, pal, still, cam);
      ctx.globalAlpha = 1;
      // the follow-spot of the switching hover darkens the model around the spine's end at D (over the live parts
      // too, so the canvas copies of occluders match the SVG below)
      M.spotLv = V.src === 'switching' ? V.cues.spot : Math.max(0, M.spotLv - dt / 1.0);
      if (still && V.src !== 'switching') M.spotLv = 0;
      if (M.spotLv > 0.005) drawSpot(ctx, pal, M.spotLv);
      // the corridor light (the rest sinks into the page), and the act drawn on the lines themselves; a balancing story
      // with a sink sinks the rest of the model the same way (its own keep set: D-I, its line field, the spine, the units;
      // the chart and the arrows are drawn over the sink)
      var r6 = V.src === 'switching' && V.cues.r6, bs = V.src === 'balancing' && V.cues.bsink, hv = V.src === 'hvdc' && V.cues.r6;   // hv: the HVDC hover's day
      T6 = M.swTiming ? global.performance.now() : 0;
      M.cfK = bs && V.cues.cfK ? V.cues.cfK : 0;
      // the keep sets (M.sinkSet): 'sw' (switching), 'bal', 'bal6' (with the gas-engine plant), 'bal7' (with the biomass station)
      // and 'hvc' (the HVDC hover's day: only the converter sites, the offshore converter platform and A's and C's converter
      // stations). A story that follows another story with a sink starts its sink from the level shown (s0)
      var s0 = (r6 || bs || hv) && !still && M.story && M.story.sink0, hk = s0 ? V.cues.iso : 1;
      if (r6 || bs || hv) { M.isoLv = s0 && hk < 1 ? s0.lv + (1 - s0.lv) * hk : V.cues.iso; M.isoU = V.cues.units; M.sinkSet = hv ? 'hvc' : bs ? (M.story && M.story.def.eng ? 'bal6' : M.story && M.story.def.bm ? 'bal7' : 'bal') : 'sw'; } else M.isoLv = still ? 0 : Math.max(0, (M.isoLv || 0) - dt / SWX.T.isoOut);
      // the kept set's cover has no dip (sinkDip 0)
      var sDip = 0;
      M.sinkDip = sDip;
      if (s0 && hk < 1) drawSinkFrom(ctx, s0, hk, r6 ? V.cues.units : M.isoU || 0, sDip, M.sinkSet);
      else if (M.isoLv > 0.004) drawSink(ctx, M.isoLv, r6 ? V.cues.units : M.isoU || 0, sDip, M.sinkSet);
      var balSet = M.sinkSet === 'bal' || M.sinkSet === 'bal6' || M.sinkSet === 'bal7';
      // in the HVDC hover's day D-I's glow goes out over DAYX.red (M.redK); after it the hero's own cue comes back.
      // The day draws the spine and D-I's glow as the hero's gentle cue does (the dash at its full gap, the glow
      // at half strength), at the sink's own level (hvVis, 1 - its cover), so a spine open at the hover's start recedes with the model and
      // turns solid under the sink at h0; the switching hover's dash (over the sink, its end gaps opening) is never drawn in it. While the
      // day's sink lifts after a leave, the hero's cue comes back at that same level, with the model
      var hvVis = M.sinkSet === 'hvc' ? 1 - (html.getAttribute('data-scene') === 'dark' ? SWX.SINK.dark : SWX.SINK.a) * (M.isoLv || 0) : 1;
      if (hv && heroCue()) drawActR6(ctx, pal, 1, still, 0.5, hvVis);
      else if (r6 || (M.isoLv > 0.004 && !balSet && M.sinkSet !== 'hvc')) drawActR6(ctx, pal, M.isoLv, still, 1);
      else if (bs || (M.isoLv > 0.004 && balSet)) drawActR6(ctx, pal, 1, still, 0);   // a balancing sink: the firm dash, no glow (drawHot)
      // data-herocue (on unless "0"): the hero's two gentle cues, D-I's glow at half strength while it is over its rating
      // and the opened spine with the firmer dash (8.0 to 31.2 s); no camera, corridor light or replay. The cues sink with
      // the rest of the model while another theme (HVDC, renewables) is highlighted, as the static layer's dashed spine does
      else if (V.src === 'hero' && !still && heroCue()) drawActR6(ctx, pal, 1, still, 0.5, lerp(dimAlpha(hl0, 'switching'), dimAlpha(hl, 'switching'), kd) * hvVis);
      else {
        if (M.swAct) { M.swAct = ''; root.removeAttribute('data-sw-act'); }
        M.swHot = 0;
      }
      if (M.swTiming) { M.swTiming.ms += global.performance.now() - T6; M.swTiming.n++; }
      drawCues(ctx, t, V, pal, cam, still);
      if (V.cues.hot != null || M.hotLv) drawHot(ctx, pal, V);   // under the beams
      ctx.restore();
      // a still (reduced motion, Pause) is painted once per change, at the same scene time, so the flow light would keep the paths
      // it built for the previous still; entering or leaving the HVDC hover's hold (the day's 09:30) changes the flows, so its
      // paths are built afresh then
      if (still && M.beams) { var sbk = V.src; if (sbk !== M.stillBeamKey && (/^hvdc/.test(sbk) || /^hvdc/.test(M.stillBeamKey || ''))) M.beams.cache = null; M.stillBeamKey = sbk; }
      // with data-flows off the HVDC hover still draws its own light on the two links (the hover's subject), no AC light
      if (M.flowsOn() || M.hcK > 0) drawBeams(ctx, frame, t, dt, still, V, hl0, hl, kd, !M.flowsOn());
      if (M.pv !== 'r4' && veilOn()) drawVeils(ctx, frame, hl0, hl, kd);   // under the fields' furniture and dots
      ctx.save();
      ctx.setTransform(frame.dpr * m.s, 0, 0, frame.dpr * m.s, frame.dpr * m.ox, frame.dpr * m.oy);
      drawLineFurniture(ctx, pal, hl0, hl, kd);
      ctx.restore();
      drawHybrid(ctx, frame, still, hl0, hl, kd);
      drawBal(ctx, frame, V, dt, still);   // the merit chart and the redispatch arrows, over the model
      drawPools(V, dt, still);
      if ((M.glK < 1 || M.swCv) && !M.sw.brk) drawSwOn(ctx, frame, hl0, hl, kd);   // the switched line's conductor from a restart on, under all of the above
      // a story's dip (cues.dip) dissolves the whole figure (to 28 %) with the state change inside it
      var op = V.cues.dip > 0.005 ? 1 - 0.72 * smooth(V.cues.dip) : 1;
      var dipOp = op < 1 ? op.toFixed(3) : '';
      if (dipOp !== (M.dipOp || '')) { M.stage.style.opacity = dipOp; M.dipOp = dipOp; }
      M.frames++;
      if (M.cam && ((M.cam.u > 0 && M.cam.u < 1) || (M.cam.w > 0 && M.cam.w < 1)) && M.hook) M.hook.opts.restFps = 30;
      if (M.hcK > 0 && !still && M.hook) M.hook.opts.restFps = 30;   // the HVDC light glides at 30 frames/s, not 15
      lineTick(V.line, still || !!V.cues.lineInstant, V.lineMs, V.lineMsAll);
      // test hook: M.qaDay records what the HVDC hover's day showed this frame, while it runs or its color is up, and one frame
      // more to record the color gone
      if (dS || M.hcK > 0 || (M.qaDay && M.qaDay.hcK > 0)) {
        var P10 = M.shownP, tie10 = 0, iD10 = M.laneIdx['L-DI'], dy10 = dS && !still ? dayAt(V.h) : null;
        Object.keys(P10).forEach(function (k) { tie10 -= P10[k] || 0; });
        M.qaDay = { t: t, h: V.h, u: dS ? (still ? DAYX.still * DAYX.q : V.cues.u) : null, j: dy10 ? dy10.j : null, f: dy10 ? dy10.f : null, dc1: P10.offshore_wind || 0,
          dc2: P10.dc_interconnector || 0, tie: tie10, open: M.sw.brk ? ANIMATED.slice() : [], blade: M.sw.blade, hcK: M.hcK, trK: M.trK, trA: M.qaTrA, iso: M.isoLv || 0,
          redK: M.redK, lineA: M.lnK == null ? 1 : M.lnK, lineCss: M.lnCss || '', thrCss: M.thrCss || '', DI: iD10 != null ? M.laneFl[iD10][1] : null, hot: M.qaGlow ? M.qaGlow.hot : 0,
          rings: (V.cues.rings || []).length, sel: V.cues.sel || 0, camZ: M.cam && M.cam.u > 0 && M.cam.fit ? camMap(M.cam.e).s / M.map0.s : 1,
          dcl: M.beams && M.beams.qaHc ? M.beams.qaHc.slice() : null, sink: M.sinkSet, still: !!still };
      }
    }
    // (1) The switched line's static conductors (solid and dashed, in every layer: [data-br] paths) are held at stroke-opacity 0
    // while the switching restart dissolves (M.glK < 1) and while the canvas holds the conductor after it (M.swCv); over that
    // time the canvas draws the solid conductor at M.glC (drawSwOn). Every change of the static drawing repaints the page around
    // the model's large inline SVG, so the static copy is restyled twice a hover. (2) The replay cue: the hovered card's rule
    // (.theme::before) empties and fills again with each replay's restart (cues.back), as it fills when the hover starts, so
    // each replay reads as the story starting over. The restart's start sets data-rk on the card (a and b in turn), which runs
    // a compositor animation of the rule (site.css) as long as the restart (--rk-d on the card); the attribute stays until the
    // story ends. Stepping the rule from script every frame would repaint the page each time
    function cutTick(V, still) {
      var gk = M.glK == null ? 1 : M.glK, v = gk < 1 || M.swCv ? '0' : '';
      if (v !== (M.cutCss || '')) {
        M.cutCss = v;
        Array.prototype.forEach.call(root.querySelectorAll('[data-br="' + ANIMATED[0] + '"]'), function (el) { el.style.strokeOpacity = v; });
      }
      var R = V.cues && V.cues.r6, card = null, q = '';
      if (R && R.loop && !still && V.src === 'switching') {
        card = M.ruleCard && M.ruleKey === V.src ? M.ruleCard : d.querySelector('.theme-grid > [data-theme-key="' + V.src + '"]');
        var BKd = M.story && M.story.def.back, inDip = !!V.cues.back;
        if (inDip && !M.ruleIn) { M.ruleN = (M.ruleN || 0) + 1; M.ruleSt = M.story; }   // a restart (inDip) starts: the animation afresh
        var rkd = BKd ? (BKd.t1 - BKd.t0).toFixed(2) + 's' : '';
        if (card && rkd !== (card.style.getPropertyValue('--rk-d') || '')) { if (rkd) card.style.setProperty('--rk-d', rkd); else card.style.removeProperty('--rk-d'); }
        M.ruleIn = inDip;
        q = M.ruleSt && M.ruleSt === M.story ? (M.ruleN % 2 ? 'a' : 'b') : '';
      } else M.ruleIn = false;
      if (M.ruleCard && M.ruleCard !== card) { M.ruleCard.removeAttribute('data-rk'); M.ruleCard = null; M.ruleQ = ''; }
      if (card && q !== (M.ruleQ || '')) { if (q) card.setAttribute('data-rk', q); else card.removeAttribute('data-rk'); M.ruleCard = q ? card : null; M.ruleKey = q ? V.src : ''; M.ruleQ = q; }
    }
    // the line field's static groups (its light volume, the band's line field, the sheet panel) go out and come back
    // with the day's line factor (M.lnK), in quarters: every change of the static drawing repaints the page around the model's large
    // inline SVG, so it changes 4 times on the way out and 4 on the way back
    function dayLineCss() {
      var k = M.lnK == null ? 1 : M.lnK, v = k < 0.999 ? Math.round(4 * k) / 4 : 1;
      // the floating band's threads and source points (static SVG, under the sink at about 0.28) recede further,
      // with the band's dots (held at SWX.SINK.dots): to half their opacity under the day's sink, in quarters (two restyles each way)
      var tv = k < 0.999 ? Math.round(4 * (1 - 0.5 * (1 - k))) / 4 : 1;
      tv = tv >= 1 ? '' : String(tv);
      if (tv !== (M.thrCss || '')) { M.thrCss = tv; Array.prototype.forEach.call(root.querySelectorAll('.st-static .pv-threads'), function (el) { el.style.opacity = tv; }); }
      v = v >= 1 ? '' : String(v);
      if (v === (M.lnCss || '')) return;
      M.lnCss = v;
      Array.prototype.forEach.call(root.querySelectorAll('.st-static .o.th-balancing.pv'), function (el) { el.style.opacity = v; });
    }
    function drawSpot(ctx, pal, lv) {
      var G = M.spotG;
      if (!G) return;
      var c = hexRgb(pal.s.spot.charAt(0) === '#' ? pal.s.spot : '#000000').join(','), A = (parseFloat(pal.s.spotA) || 0.15) * lv;
      ctx.save();
      ctx.clip(M.plinthPath);
      ctx.translate(G.c[0], G.c[1]); ctx.scale(1, G.ry / G.rx);
      var gr = ctx.createRadialGradient(0, 0, G.rx * 0.5, 0, 0, G.rx);
      gr.addColorStop(0, 'rgba(' + c + ',0)'); gr.addColorStop(1, 'rgba(' + c + ',' + A.toFixed(3) + ')');
      ctx.globalAlpha = 1; ctx.fillStyle = gr; ctx.fillRect(-4 * G.rx, -4 * G.rx * G.rx / G.ry, 8 * G.rx, 8 * G.rx * G.rx / G.ry);
      ctx.restore();
    }

    // ── The switching camera, the corridor light and the act on the line ──
    // The camera: progress u (linear in the scene's time, eased to e); the fit holds the corridor, the line field over
    // D-I (not in the 'band' panel layout, where the field stays in its row) and both units of the pair. The SVG layers
    // carry a CSS transform; the canvas carries the same one while the camera moves and, at rest, is drawn at the pushed-in
    // mapping instead (crisp). The swaps run in a microtask after the frame's drawing, as remap() repaints the canvas.
    function fieldCorners(F) { var T = F.M; return [[0, 0], [F.w, 0], [F.w, F.h], [0, F.h]].map(function (q) { return [T[0] * q[0] + T[2] * q[1] + T[4], T[1] * q[0] + T[3] * q[1] + T[5]]; }); }
    // The camera of the balancing story with the merit chart (wallFit frames the one with the bid ladder). It holds the chart
    // with its ground, the units with their arrows and rings, D-I, the spine and the whole line field, fitted into the part
    // of the stage on screen as the switching camera is; when that leaves a zoom under 1.06 (the card well in view, or a
    // phone), no camera: the sink and the larger chart and arrows carry the hover. The two units sit at opposite ends, so
    // the zoom stays modest and neither unit is cropped.
    function balFit() {
      var C = SWX.CAM, V = M.S.layout.view, G = M.meritG, sc = M.name === 'wide' ? 1 : 0.55, xs = [], ys = [], m = C.margin;
      if (!G || !M.poolG) return null;
      // with def.pair6 the units and their arrows' reach come from the story (arrows proportional to MW)
      var D6 = M.story && M.story.def, ext = { bat: PAIR.base + PAIR.k * 200, gen: PAIR.base + PAIR.k * 200 }, extCf = { bat: PAIR.base + PAIR.k * 500, gen: PAIR.base + PAIR.k * 500 };
      if (D6 && D6.pair6) {
        ext = {}; extCf = {};
        D6.pair6.forEach(function (q) { q[1].forEach(function (e) { ext[e[0]] = Math.max(ext[e[0]] || 0, PAIR6.k * Math.abs(e[1])); }); });
        if (D6.cf6) D6.cf6[2].forEach(function (e) { extCf[e[0]] = PAIR6.k * Math.abs(e[1]); });
        Object.keys(ext).forEach(function (k) { extCf[k] = Math.max(extCf[k] || 0, ext[k]); });
      }
      xs.push(G.x0 - 24 * sc, G.x0 + G.W + 30 * sc); ys.push(G.yb - G.H - 24 * sc, G.yb + 12 * sc);
      Object.keys(ext).forEach(function (k) { var q = M.poolG[k] && M.poolG[k].unit; if (!q) return; xs.push(q[0] - 40 * sc, q[0] + 40 * sc); ys.push(q[1] - (PAIR.gap + ext[k]) * sc - 8, q[1] + 30 * sc); });
      M.S.lanes.forEach(function (ln) { if (/^L-(DI|AD)$/.test(ln.id)) ln.sp.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); }); });
      if (M.linePo && M.pv !== 'band') fieldCorners(fieldNow(M.linePo.panel)).forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
      var x0 = Math.min.apply(null, xs) - m, x1 = Math.max.apply(null, xs) + m, y0 = Math.min.apply(null, ys) - m, y1 = Math.max.apply(null, ys) + 0.4 * m;
      var b = M.map0, r = M.stage.getBoundingClientRect(), v0 = clamp(-r.top, 0, b.h), v1 = clamp((global.innerHeight || b.h) - r.top, 0, b.h);
      if (v1 - v0 < C.minVis) return null;
      var VH = Math.min((v1 - v0) / b.s, V[1]), Z = Math.min(C.zmax[M.name] || 1.6, V[0] / (x1 - x0), VH / (y1 - y0));
      if (Z < 1.06 && v1 - v0 < b.h - 1) {
        // the stage partly off screen (the card scrolled further than into view): hold the chart, both units with all
        // their arrows (the dashed 500 MW ones too), D-I and the line field's floor, pulled back as far as zField (as the
        // switching camera does for its field); below that, no camera
        var ys2 = [G.yb - G.H - 12 * sc, G.yb + 12 * sc];
        Object.keys(extCf).forEach(function (k) { var q = M.poolG[k] && M.poolG[k].unit; if (!q) return; ys2.push(q[1] - (PAIR.gap + extCf[k]) * sc - 8, q[1] + 30 * sc); });
        M.S.lanes.forEach(function (ln) { if (ln.id === 'L-DI') ln.sp.forEach(function (p) { ys2.push(p[1]); }); });
        if (M.linePo && M.pv !== 'band') { var fq = fieldCorners(fieldNow(M.linePo.panel)); ys2.push(Math.max(fq[2][1], fq[3][1]) - 10); }
        var yb0 = Math.min.apply(null, ys2) - 8, yb1 = Math.max.apply(null, ys2) + 8, Z2 = Math.min(C.zmax[M.name] || 1.6, V[0] / (x1 - x0), VH / (yb1 - yb0));
        if (Z2 < C.zField) return null;
        y0 = yb0; y1 = yb1; Z = Z2;
      } else if (Z < 1.06) return null;
      var hw = V[0] / (2 * Z), hh = VH / (2 * Z);
      return { Z: Z, f: [Z < 1 ? V[0] / 2 : clamp((x0 + x1) / 2, hw, V[0] - hw), clamp((y0 + y1) / 2, hh, V[1] - hh)], a: (v0 + v1) / 2, box: [x0, y0, x1, y1], bal: true };
    }
    // The 'wall' framing of the balancing story with the bid ladder (def.cam 'wall'), measured once per hover: the three
    // units with every arrow (the dashed ones too), the biomass station's whole box, D-I, the spine and the line field.
    // With CHART7.side 'left' the chart's slot stands on the left of the stage and the box fills the stage right of it;
    // with 'right' the box's right bound is the plinth's front-right corner, kept left of the slot on the free wall right of
    // the plinth. The full box (with the whole line field) if its zoom is at least zFull or the whole stage is in view,
    // else the reduced box (the field's floor, D-I and the spine); under zField (or on phones) no camera, and the chart
    // stands at its fallback anchor. Vertically, the box is centered in the visible band. The fit's 'wall' flag marks this
    // framing (a cut under reduced motion, held on Pause, the page's background on the stage).
    function wallFit() {
      var C = CHART7, V = M.S.layout.view, D = M.story && M.story.def, PG = M.poolG, cam = M.S.cam, g = M.S.ground;
      if (M.name !== 'wide' || !PG || !PG.bio || !D) return null;
      var b = M.map0, s = b.s, W = b.w, r = M.stage.getBoundingClientRect(), v0 = clamp(-r.top, 0, b.h), v1 = clamp((global.innerHeight || b.h) - r.top, 0, b.h);
      if (v1 - v0 < SWX.CAM.minVis) return null;
      var k = D.pairK || PAIR6.k, reach = {}, tops = [];
      (D.pair6 || []).forEach(function (q) { q[1].forEach(function (e) { reach[e[0]] = Math.max(reach[e[0]] || 0, k * Math.abs(e[1])); }); });
      if (D.cf6) D.cf6[2].forEach(function (e) { reach[e[0]] = Math.max(reach[e[0]] || 0, k * Math.abs(e[1])); });
      Object.keys(reach).forEach(function (u) { if (!PG[u]) return; var foot = u === 'bio' ? PG.bio.foot[1] : PG[u].unit[1] - PAIR.gap; tops.push(foot - reach[u] - 8); });
      var sb = null; M.S.objs.forEach(function (o) { if (o.gate === 'b7' && o.bb && o.layer !== 'ground') sb = unionBB(sb, o.bb); });
      var ybot = Math.max(PG.gen.unit[1], PG.bat.unit[1], sb ? sb[3] : 0) + 30;
      var fq = M.linePo && M.pv !== 'band' ? fieldCorners(fieldNow(M.linePo.panel)) : null, ly = [], lx = [];
      M.S.lanes.forEach(function (ln) { if (/^L-(DI|AD)$/.test(ln.id)) ln.sp.forEach(function (p) { ly.push(p[1]); lx.push(p[0]); }); });
      var x0, x1, free0, free1, sx, P = null, left = C.side === 'left';
      if (left) {
        // the chart on the left. The box spans the story's parts only: the three units with their rings and arrows (40 view
        // units either side of each unit point), the station, D-I, the spine and the line field, with the margin 26 on both
        // sides; it fills the stage right of the slot (gap 16), 16 from the stage's right edge. The west of the plinth (the AC
        // tie, the hills, the onshore farm: sunk, no part in this story) lies under the chart; the east beyond the battery park
        // (the town, the solar field: sunk) may leave the frame on the right
        var xa = [PG.gen.unit[0] - 40, PG.bat.unit[0] - 40, PG.bio.unit[0] - 40].concat(lx), xb = [PG.gen.unit[0] + 40, PG.bat.unit[0] + 40, PG.bio.unit[0] + 40].concat(lx);
        if (sb) { xa.push(sb[0]); xb.push(sb[2]); }
        if (fq) fq.forEach(function (p) { xa.push(p[0]); xb.push(p[0]); });
        x0 = Math.min.apply(null, xa) - 26; x1 = Math.max.apply(null, xb) + 26;
        sx = C.edge * s; free0 = sx + (C.w + C.gap) * s; free1 = W - C.left * s;
        // the hovered card's left edge on the stage (CHART7.align), and the offshore turbines' tops in view units
        // (CHART7.topFit): the tip of a blade standing straight up (hub + R; the towers' faces end 20 view units lower)
        var ce = d.querySelector('.theme-grid > [data-theme-key="' + D.key + '"]'), ax = ce ? ce.getBoundingClientRect().left - r.left : -1, tb = 1e9;
        if (C.topFit) M.S.objs.forEach(function (o) { if (/^tb-off/.test(o.id) && o.rotor) { var hb = o.rotor.hub; tb = Math.min(tb, cam.p([hb[0], hb[1] + o.rotor.R, hb[2]])[1]); } });
      } else {
        // the plinth's right edge on screen: the rightmost point of its projected outline (its front-right corner stands at
        // x1 + the plate margin and its foot below the ground, so the outline reaches past the top corner at x 1600)
        x0 = Math.min(PG.gen.unit[0] - 40, sb ? sb[0] : 1e9) - 26; P = cam.p([1600, g, 34])[0];
        M.S.objs.forEach(function (o) { if (o.id === 'plinth') (o.pf || []).forEach(function (f) { f.sp.forEach(function (q) { P = Math.max(P, q[0]); }); }); });
        x1 = P; sx = W - (C.right + C.w) * s; free0 = C.left * s; free1 = sx - C.gap * s;
      }
      var full = [Math.min.apply(null, tops.concat(fq ? [Math.min.apply(null, fq.map(function (p) { return p[1]; }))] : [])) - 26, ybot + 0.4 * 26];
      var red = [Math.min.apply(null, tops.concat(fq ? [Math.max(fq[2][1], fq[3][1]) - 10] : []).concat(ly)) - 8, ybot + 8];
      var VH = Math.min((v1 - v0) / s, V[1]);
      // the fit for a slot at sx0 (stage px): the zoom the free width allows, the full box (with the turbines' tops while its
      // zoom stays at topMin or more) or the reduced box
      var fitAt = function (sx0) {
        var f0 = left ? sx0 + (C.w + C.gap) * s : free0, f1 = free1, Zw = (f1 - f0) / (s * (x1 - x0));
        var zOf = function (y) { return Math.min(C.zmax, VH / (y[1] - y[0]), Zw); }, fl = full;
        if (left && tb < full[0] + 8) { var ft = [tb - 8, full[1]]; if (zOf(ft) >= (C.topMin || C.zFull)) fl = ft; }
        var Zf = zOf(fl), use = Zf >= C.zFull || v1 - v0 >= b.h - 1 || (fl !== full && Zf >= (C.topMin || C.zFull)) ? fl : red;
        return { sx: sx0, f0: f0, f1: f1, Zw: Zw, Zf: Zf, Zr: zOf(red), use: use, full: use === fl, top: use === fl && fl !== full, Z: zOf(use) };
      };
      // the slot on the card's left edge (CHART7.align) when that costs under 3 % of the zoom
      var F0 = fitAt(sx), F1 = left && C.align && ax > sx + 0.5 ? fitAt(ax) : null, Fc = F1 && F1.Z >= 0.97 * F0.Z ? F1 : F0;
      var use = Fc.use, Z = Fc.Z;
      M.qaWall = { Zfull: Fc.Zf, Zred: Fc.Zr, Zw: Fc.Zw, Zv: VH / (use[1] - use[0]), use: Fc.full ? 'full' : 'reduced', box: [x0, use[0], x1, use[1]], v: [v0, v1], side: left ? 'left' : 'right',
        top: Fc.top, aligned: Fc === F1, cardX: left ? ax : null, Zplain: F0.Z, Zalign: F1 ? F1.Z : null, turbineTop: left && tb < 1e9 ? tb : null };
      if (Z < C.zField) return null;
      var xL = Fc.f0 + Math.max(0, (Fc.f1 - Fc.f0 - s * Z * (x1 - x0)) / 2);
      // the slot's height grows from C.h up to C.hmax base units, C.top under the visible band's top
      var floor = v1 - C.below * s, hS = clamp((floor - v0) / s - C.top, C.h, C.hmax);
      return { Z: Z, f: [x0 + (W / 2 - xL) / (s * Z), (use[0] + use[1]) / 2], a: (v0 + v1) / 2, box: [x0, use[0], x1, use[1]], bal: true, wall: true,
        full: Fc.full, slot: [Fc.sx, floor - hS * s, C.w * s, hS * s], plinthX: P, side: left ? 'left' : 'right' };
    }
    function camFit() {
      if (M.story && M.story.def.key === 'balancing') return M.story.def.cam === 'wall' ? wallFit() : balFit();
      var C = SWX.CAM, V = M.S.layout.view, xs = [], ys = [], y1 = -1e9;
      M.S.lanes.forEach(function (ln) { if (SWX.LANES.test(ln.id)) ln.sp.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); y1 = Math.max(y1, p[1] + C.below); }); });
      if (!xs.length) return null;
      // the corridor alone, the last fallback below
      var K = [Math.min.apply(null, xs), Math.max.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, ys)];
      var fc = M.linePo && M.pv !== 'band' ? fieldCorners(fieldNow(M.linePo.panel)) : null;
      if (fc) fc.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
      var yc = Math.max.apply(null, ys);   // the corridor and the line field without the units (the fallback below)
      if (M.poolG) ['bat', 'gen'].forEach(function (k) { var q = M.poolG[k].unit; xs.push(q[0] - C.unit[0], q[0] + C.unit[0]); ys.push(q[1]); y1 = Math.max(y1, q[1] + C.unit[1]); });
      var m = C.margin, x0 = Math.min.apply(null, xs) - m, x1 = Math.max.apply(null, xs) + m, y0 = Math.min.apply(null, ys) - m;
      y1 = Math.max(y1, Math.max.apply(null, ys)) + 0.4 * m;
      // fit into the part of the stage that is on screen, not the whole stage: with the card in view the model's top may be
      // scrolled off, and a fit to the whole stage would push the corridor off the top. The fit's center comes to the middle
      // of the visible part (anchor a); if the units leave too little zoom there (under zCore), the corridor and the line
      // field alone are fitted (the pair's rings may then fall outside; D-I's field still shows the relief).
      var b = M.map0, r = M.stage.getBoundingClientRect(), v0 = clamp(-r.top, 0, b.h), v1 = clamp((global.innerHeight || b.h) - r.top, 0, b.h);
      if (v1 - v0 < C.minVis) return null;
      var VH = Math.min((v1 - v0) / b.s, V[1]), zm = Math.min(C.zmax[M.name] || 1.6, V[0] / (x1 - x0));
      var Z = Math.min(zm, VH / (y1 - y0)), Zc = Math.min(zm, VH / (yc + 0.4 * m - y0));
      if (Z < C.zCore && Zc > Z && v1 - v0 < b.h - 1) { y1 = yc + 0.4 * m; Z = Zc; }
      // The line field stands high (behind the upper row of the grid), so with the card in view the corridor and the field
      // together fit only at a zoom near 1. The field shows the relief, so it stays inside the frame whenever that costs at
      // most a pull-back to zField; only below that is the corridor alone fitted (the spine and D-I in view and larger; D-I's
      // own glow carries the relief)
      var Zk = Math.min(C.zmax[M.name] || 1.6, V[0] / (K[1] - K[0] + 2 * m), VH / (K[3] - K[2] + 1.4 * m)), held = !!fc;
      if (held && Z < 1 && v1 - v0 < b.h - 1) {
        // the field and the corridor with tight margins (8 view units), pulled back as far as zField
        var yt = Math.min.apply(null, fc.map(function (p) { return p[1]; })), Zf = Math.min(zm, VH / (yc + 16 - yt));
        if (Zf >= C.zField) { y0 = yt - 8; y1 = yc + 8; Z = Zf; } else held = false;
      }
      if ((!held || Z < C.zField) && Z < C.zCore && Zk > Z && v1 - v0 < b.h - 1) { x0 = K[0] - m; x1 = K[1] + m; y0 = K[2] - m; y1 = K[3] + 0.4 * m; Z = Zk; held = false; }
      Z = held && Z < 1 && Z >= C.zField ? Z : Math.max(1, Z);
      if (Z <= 1.02 && Z >= 1 && b.oy + b.s * y0 >= v0 - 1 && b.oy + b.s * y1 <= v1 + 1) return null;   // on screen already, too little to zoom
      var hw = V[0] / (2 * Z), hh = VH / (2 * Z);
      var F = { Z: Z, f: [Z < 1 ? V[0] / 2 : clamp((x0 + x1) / 2, hw, V[0] - hw), clamp((y0 + y1) / 2, hh, V[1] - hh)], a: (v0 + v1) / 2, box: [x0, y0, x1, y1], field: held };
      // The decision is the opened spine and the redispatch pair together (the switched state alone is not N-1 secure).
      // When the fit above leaves the units outside the visible part, a second framing (dec) holds the corridor, both units
      // and the whole line field, pulled back as far as zDec; only below that the corridor and the units at zField or more
      // (the field's lower part in view). The camera eases to it as the units come up for the pair (SWX.T.dec) and holds it
      // (camTick, camMap)
      if (M.poolG) {
        var ux = [], uy = [];
        ['bat', 'gen'].forEach(function (k) { var q = M.poolG[k].unit; ux.push(q[0] - C.unit[0], q[0] + C.unit[0]); uy.push(q[1] - C.unit[1], q[1] + C.unit[1]); });
        var uin = Math.min.apply(null, ux) >= F.f[0] - hw && Math.max.apply(null, ux) <= F.f[0] + hw && Math.min.apply(null, uy) >= F.f[1] - hh && Math.max.apply(null, uy) <= F.f[1] + hh;
        if (!uin) {
          var dx0 = Math.min(K[0], Math.min.apply(null, ux)) - m, dx1 = Math.max(K[1], Math.max.apply(null, ux)) + m, dy1 = Math.max(K[3], Math.max.apply(null, uy)) + 8;
          var tops = fc ? [Math.min.apply(null, fc.map(function (p) { return p[1]; })) - 8, K[2] - m] : [K[2] - m], floors = fc ? [C.zDec, C.zField] : [C.zField];
          for (var ti = 0; ti < tops.length && !F.dec; ti++) {
            var Zd = Math.min(Z, zm, V[0] / (dx1 - dx0), VH / (dy1 - tops[ti]));
            if (Zd >= floors[ti]) {
              var hwd = V[0] / (2 * Zd), hhd = VH / (2 * Zd);
              F.dec = { Z: Zd, f: [Zd < 1 ? V[0] / 2 : clamp((dx0 + dx1) / 2, hwd, V[0] - hwd), clamp((tops[ti] + dy1) / 2, hhd, V[1] - hhd)], box: [dx0, tops[ti], dx1, dy1], field: ti === 0 && !!fc };
            }
          }
        }
      }
      return F;
    }
    // the mapping at camera progress e (zoom geometric, center linear from the stage's center to the fit's; the screen
    // point the center comes to moves linearly from the stage's middle to the visible part's middle, F.a); with a second
    // framing (F.dec) the fit itself is blended toward it by the camera's we (0..1)
    function camMap(e) {
      var b = M.map0, F = M.cam.fit, W = F.dec ? M.cam.we || 0 : 0, Zw = W > 0 ? Math.pow(F.Z, 1 - W) * Math.pow(F.dec.Z, W) : F.Z;
      var fx = W > 0 ? lerp(F.f[0], F.dec.f[0], W) : F.f[0], fy = W > 0 ? lerp(F.f[1], F.dec.f[1], W) : F.f[1];
      var z = Math.pow(Zw, e), c0x = (b.w / 2 - b.ox) / b.s, c0y = (b.h / 2 - b.oy) / b.s;
      var cx = lerp(c0x, fx, e), cy = lerp(c0y, fy, e), s = b.s * z, ay = lerp(b.h / 2, F.a == null ? b.h / 2 : F.a, e);
      return { s: s, ox: b.w / 2 - s * cx, oy: ay - s * cy, w: b.w, h: b.h };
    }
    function camLayers() { return Array.prototype.filter.call(M.stage.children, function (el) { return /^(svg|canvas)$/i.test(el.tagName) && !/\bst-chart\b/.test(el.className); }); }   // not the bid ladder's canvas (st-chart)
    function camCss(C) {
      var css = '';
      if (C.u > 0) { var m = camMap(C.e), b = M.map0, z = m.s / b.s; css = 'matrix(' + z.toFixed(5) + ',0,0,' + z.toFixed(5) + ',' + (m.ox - z * b.ox).toFixed(2) + ',' + (m.oy - z * b.oy).toFixed(2) + ')'; }
      var key = css + '|' + C.crisp + '|' + (C.u > 0 && C.u < 1);
      if (key === C.key) return;
      C.key = key;
      M.stage.style.overflow = C.u > 0 ? 'hidden' : '';
      // while the 'wall' framing shows stage area beyond the SVG layers, the stage takes the page's own background (no seam)
      M.stage.style.backgroundColor = C.u > 0 && C.fit && C.fit.wall ? pageBg() : '';
      camLayers().forEach(function (el) {
        var cv = /canvas/i.test(el.tagName);
        el.style.transformOrigin = C.u > 0 ? '0 0' : '';
        el.style.transform = cv && C.crisp ? '' : css;
        el.style.willChange = C.u > 0 && C.u < 1 ? 'transform' : '';
      });
    }
    function camSwap(crisp) {
      var C = M.cam;
      C.pending = false;
      if (!M.S || C.crisp === crisp) return;
      var T0 = M.swTiming ? global.performance.now() : 0;
      C.crisp = crisp;
      M.map = crisp ? camMap(1) : M.map0;
      camCss(C);
      remap();
      if (M.swTiming) { M.swTiming.swaps = (M.swTiming.swaps || 0) + 1; M.swTiming.swapMs = (M.swTiming.swapMs || 0) + global.performance.now() - T0; }
    }
    function camTick(dt, V, still) {
      var C = M.cam || (M.cam = { u: 0, e: 0, crisp: false, fit: null, key: null, pending: false });
      var D6 = M.story && M.story.def, r6 = V.src === 'switching' && D6 && D6.r6;
      var wall = V.src === 'balancing' && !!D6 && D6.cam === 'wall';   // the 'wall' framing holds under reduced motion and Pause
      var want = ((r6 && r6.cam) || (V.src === 'balancing' && D6 && D6.cam)) && (wall || !still) ? 1 : 0;   // the balancing story's camera too
      // a fit belongs to one story (switching or balancing); another story's hover first lets the camera go back
      if (want && C.fit != null && C.fitKey !== D6.key) { if (C.u > 0) want = 0; else C.fit = null; }
      if (want && C.fit == null) { C.fit = camFit() || false; C.fitKey = D6.key; }   // measured once per hover (false: no camera this time)
      if (!want && C.fit === false) C.fit = null;
      if (!C.fit) { if (C.u > 0) camReset(); return; }
      var u = still ? (wall && want ? 1 : 0) : clamp(C.u + (want ? dt / SWX.T.camIn : -dt / SWX.T.camOut), 0, 1);   // a cut when still
      // the second framing (camFit's dec) from SWX.T.dec[0] s before the pair, over dec[1] s, while the view's decCam cue
      // holds; the canvas is crisp only while the camera rests at either framing
      var w = C.w || 0;
      if (C.fit.dec) w = still ? 0 : clamp(w + (want && V.cues && V.cues.decCam ? dt : -dt) / SWX.T.dec[1], 0, 1);
      var rest = function () { return C.u >= 1 && (!C.fit || !C.fit.dec || C.w <= 0 || C.w >= 1); };
      if (u === C.u && w === (C.w || 0) && !C.pending && C.crisp === rest()) return;
      C.u = u; C.e = smooth(u); C.w = w; C.we = smooth(w);
      if (C.crisp !== rest() && !C.pending) { C.pending = true; global.Promise.resolve().then(function () { camSwap(rest()); }); }
      camCss(C);
      if (u <= 0 && !want) { C.fit = null; C.w = 0; C.we = 0; }   // the next hover fits again (the panel layout may have changed)
    }
    function camReset() {
      var C = M.cam;
      if (!C) return;
      C.u = 0; C.e = 0; C.pending = false; C.fit = null; C.w = 0; C.we = 0;
      if (C.crisp) { C.crisp = false; if (M.map0) { M.map = M.map0; remap(); } }
      C.key = null; camCss(C);
    }
    // the corridor light: the page's own color laid over the model outside the corridor (and, until the pair, outside
    // the two units), with soft edges; bitmaps in view units, built once per layout and palette. The corridor is
    // the ladder's lines with their towers, the EHV yards at their ends, and the line field over D-I with its beam.
    var SW_YARDS = /^yard-[ABCDEI]-EHV$/;
    function swShapes(g, part, grow) {
      var L = M.S.lanes, poly = function (P, dy) { g.beginPath(); P.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1] + dy); else g.moveTo(p[0], p[1] + dy); }); g.closePath(); };
      if (part === 'corr') {
        g.lineWidth = 36 + 2 * grow;
        L.forEach(function (ln) {
          if (!SWX.LANES.test(ln.id)) return;
          g.beginPath(); ln.sp.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1] + 12); else g.moveTo(p[0], p[1] + 12); }); g.stroke();
        });
        g.lineWidth = 12 + 2 * grow;
        M.S.objs.forEach(function (o) { if (SW_YARDS.test(o.id)) (o.pf || []).forEach(function (f) { [0, -26].forEach(function (dy) { poly(f.sp, dy); g.fill(); g.stroke(); }); }); });
        if (M.linePo) {
          var c = fieldCorners(fieldNow(M.linePo.panel)), di = L[M.laneIdx['L-DI']], yb = di ? Math.max.apply(null, di.sp.map(function (p) { return p[1]; })) : c[2][1];
          var xs = c.map(function (p) { return p[0]; }), x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
          g.lineWidth = 16 + 2 * grow; poly(c, 0); g.fill(); g.stroke();
          if (M.pv !== 'band') { poly([[x0, c[3][1]], [x1, c[2][1]], [x1, yb], [x0, yb]], 0); g.fill(); g.stroke(); }
        }
      } else if (part === 'bal') {
        // what the balancing story keeps in full light besides the units: D-I and the spine with the EHV yards at their ends,
        // and the line field over D-I with its beam (as in the corridor)
        g.lineWidth = 36 + 2 * grow;
        L.forEach(function (ln) {
          if (!/^L-(AD|DI)$/.test(ln.id)) return;
          g.beginPath(); ln.sp.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1] + 12); else g.moveTo(p[0], p[1] + 12); }); g.stroke();
        });
        g.lineWidth = 12 + 2 * grow;
        M.S.objs.forEach(function (o) { if (/^yard-[ADI]-EHV$/.test(o.id)) (o.pf || []).forEach(function (f) { [0, -26].forEach(function (dy) { poly(f.sp, dy); g.fill(); g.stroke(); }); }); });
        if (M.linePo) {
          var cb = fieldCorners(fieldNow(M.linePo.panel)), dib = L[M.laneIdx['L-DI']], ybb = dib ? Math.max.apply(null, dib.sp.map(function (p) { return p[1]; })) : cb[2][1];
          var xsb = cb.map(function (p) { return p[0]; }), xb0 = Math.min.apply(null, xsb), xb1 = Math.max.apply(null, xsb);
          g.lineWidth = 16 + 2 * grow; poly(cb, 0); g.fill(); g.stroke();
          if (M.pv !== 'band') { poly([[xb0, cb[3][1]], [xb1, cb[2][1]], [xb1, ybb], [xb0, ybb]], 0); g.fill(); g.stroke(); }
        }
      } else if (part === 'bm') {
        // the biomass power station (every object of gate 'b7' off the ground: tower, boiler house, chimney, hall, domes,
        // conveyor, bay, transformer), a rounded box over its screen box, and the reach of its plume above the tower
        var bb7 = null, mg7 = 16 + grow;
        M.S.objs.forEach(function (o) { if (o.gate === 'b7' && o.bb && o.layer !== 'ground') bb7 = unionBB(bb7, o.bb); });
        var st7 = ((M.S.fx && M.S.fx.stacks) || []).filter(function (q) { return q.gate === 'b7'; })[0];
        if (st7) { var c0 = M.S.cam.p(st7.top), c1 = M.S.cam.p(add(st7.top, [0.16 * PLUME.drift, 4 + PLUME.rise, PLUME.drift])), rr7 = st7.r * 1.2; bb7 = unionBB(bb7, [Math.min(c0[0], c1[0]) - rr7, Math.min(c0[1], c1[1]) - rr7, Math.max(c0[0], c1[0]) + rr7, Math.max(c0[1], c1[1])]); }
        if (bb7) { g.beginPath(); if (g.roundRect) g.roundRect(bb7[0] - mg7, bb7[1] - mg7, bb7[2] - bb7[0] + 2 * mg7, bb7[3] - bb7[1] + 2 * mg7, 10 + grow); else g.rect(bb7[0] - mg7, bb7[1] - mg7, bb7[2] - bb7[0] + 2 * mg7, bb7[3] - bb7[1] + 2 * mg7); g.fill(); }
      } else if (part === 'hvc') {
        // what the HVDC day keeps in full light: only the converter sites (the offshore converter platform, A's valve halls and
        // DC hall, C's valve hall and DC hall, their bushings and converter transformer banks), faces and lines, with a soft
        // edge; the cables, the ground under them, the offshore AC collector platform and its export cables sink with the rest
        g.lineWidth = 4 + 2 * grow;
        M.S.objs.forEach(function (o) {
          if (o.layer === 'ground' || !HVC_RE.test(o.id)) return;
          (o.pf || []).forEach(function (f) { poly(f.sp, 0); g.fill(); g.stroke(); });
          (o.pl || []).forEach(function (l) { g.beginPath(); l.sp.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.stroke(); });
        });
      } else if (part === 'eng') {
        // the gas-engine plant (gate 'b6'), its halls, stacks, bay and step-up transformer (a rounded box over its screen box)
        var eb = null, mg = 16 + grow;
        M.S.objs.forEach(function (o) { if (o.gate === 'b6' && o.bb && o.layer !== 'ground') eb = unionBB(eb, o.bb); });
        if (eb) { g.beginPath(); if (g.roundRect) g.roundRect(eb[0] - mg, eb[1] - mg, eb[2] - eb[0] + 2 * mg, eb[3] - eb[1] + 2 * mg, 10 + grow); else g.rect(eb[0] - mg, eb[1] - mg, eb[2] - eb[0] + 2 * mg, eb[3] - eb[1] + 2 * mg); g.fill(); }
      } else if (M.poolG) {
        // the gas plant (its stacks rise above its unit point) and the battery park's containers
        var k = M.name === 'wide' ? 1 : 0.6, E = { gen: [0, -22, 64, 50], bat: [-2, 10, 50, 24] };
        ['bat', 'gen'].forEach(function (n) { var q = M.poolG[n].unit, e = E[n]; g.beginPath(); g.ellipse(q[0] + k * e[0], q[1] + k * e[1], k * e[2] + grow, k * e[3] + grow, 0, 0, TAU); g.fill(); });
      }
    }
    function swMasks() {
      var key = M.palVersion + '|' + M.pv + '|' + M.name;
      if (M.swMask && M.swMask.key === key) return M.swMask;
      var V = M.S.layout.view, W = Math.ceil(V[0]), H = Math.ceil(V[1]), col = global.getComputedStyle(d.body).backgroundColor || M.pal.s.wall;
      var cnv = function () { var c = d.createElement('canvas'); c.width = W; c.height = H; var g = c.getContext('2d'); g.lineCap = 'round'; g.lineJoin = 'round'; return c; };
      var blur = 'filter' in cnv().getContext('2d');
      // the shapes at full strength; soft edges by a blur where the canvas has one, else by ten widening strokes
      var shapes = function (parts) {
        var c = cnv(), g = c.getContext('2d'), steps = blur ? [[0, 1]] : [[27, 0.1], [24, 0.12], [21, 0.14], [18, 0.16], [15, 0.19], [12, 0.22], [9, 0.26], [6, 0.32], [3, 0.42], [0, 1]];
        g.fillStyle = g.strokeStyle = '#000';
        steps.forEach(function (st) { g.globalAlpha = st[1]; parts.forEach(function (pt) { swShapes(g, pt, st[0]); }); });
        return c;
      };
      var put = function (g, c) { if (blur) g.filter = 'blur(11px)'; g.drawImage(c, 0, 0); if (blur) g.filter = 'none'; };
      var mk = function (fill, cut) {
        var c = cnv(), g = c.getContext('2d');
        if (fill === 'all') { g.fillStyle = col; g.fillRect(0, 0, W, H); }
        else { put(g, shapes([].concat(fill))); g.globalCompositeOperation = 'source-in'; g.fillStyle = col; g.fillRect(0, 0, W, H); }   // fill may list parts
        if (cut.length) { g.globalCompositeOperation = 'destination-out'; put(g, shapes(cut)); }
        return c;
      };
      // all: the model outside the corridor; units: the two units outside the corridor; now: all with the units lifted by
      // the pair's light (composed when that light changes: all x (1 - k units), so soft edges never thin the sink)
      M.swMask = { key: key, all: mk('all', ['corr']), units: mk('units', ['corr']), corr: mk('corr', []), now: cnv(), k: -1, V: V,
        bal: mk('all', ['bal', 'units']), mk: mk };   // bal: the model outside the balancing keep set and the two units
      return M.swMask;
    }
    function drawSink(ctx, lv, units, dip, set) {
      var S = swMasks(), A = (html.getAttribute('data-scene') === 'dark' ? SWX.SINK.dark : SWX.SINK.a) * lv, V = S.V, k = Math.round(clamp(units, 0, 1) * 50) / 50;
      if (set === 'bal') { ctx.save(); ctx.globalAlpha = A; ctx.drawImage(S.bal, 0, 0, V[0], V[1]); ctx.restore(); return; }   // the balancing keep set, the units always lit
      if (set === 'bal7') {   // with the biomass power station (its mask made on first use)
        if (!S.bal7) S.bal7 = S.mk('all', ['bal', 'units', 'bm']);
        ctx.save(); ctx.globalAlpha = A; ctx.drawImage(S.bal7, 0, 0, V[0], V[1]); ctx.restore(); return;
      }
      if (set === 'hvc') {   // the HVDC day: only the converter sites kept (its mask made on first use)
        if (!S.hvc) S.hvc = S.mk('all', ['hvc']);
        ctx.save(); ctx.globalAlpha = A; ctx.drawImage(S.hvc, 0, 0, V[0], V[1]); ctx.restore(); return;
      }
      if (set === 'bal6') {   // with the gas-engine plant (its mask made on first use)
        if (!S.bal6) S.bal6 = S.mk('all', ['bal', 'units', 'eng']);
        ctx.save(); ctx.globalAlpha = A; ctx.drawImage(S.bal6, 0, 0, V[0], V[1]); ctx.restore(); return;
      }
      if (k !== S.k) {
        var g = S.now.getContext('2d');
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, S.now.width, S.now.height); g.drawImage(S.all, 0, 0);
        if (k > 0) { g.globalCompositeOperation = 'destination-out'; g.globalAlpha = k; g.drawImage(S.units, 0, 0); }
        S.k = k;
      }
      ctx.save();
      ctx.globalAlpha = A; ctx.drawImage(S.now, 0, 0, V[0], V[1]);
      if (dip > 0.003) { ctx.globalAlpha = A * dip; ctx.drawImage(S.corr, 0, 0, V[0], V[1]); }
      ctx.restore();
    }
    // the sink of one story handed to the next. The previous keep set's cover goes down as the new one comes up (k, the
    // new story's own rise over isoIn); where both sink the model, the two covers compose to the level between them (lv0
    // to 1), so the model never flashes back to full light; where only one sinks, it fades in or out
    function drawSinkFrom(ctx, s0, k, units, dip, set) {
      var A = html.getAttribute('data-scene') === 'dark' ? SWX.SINK.dark : SWX.SINK.a, a1 = A * s0.lv * (1 - k), at = A * (s0.lv + (1 - s0.lv) * k);
      var a2 = a1 < 1 ? Math.max(0, 1 - (1 - at) / (1 - a1)) : at;
      if (a1 > 0.004) drawSink(ctx, s0.lv * (1 - k), s0.units, s0.dip, s0.set);
      if (a2 > 0.004) drawSink(ctx, a2 / A, units, dip, set);
      M.qaSink = { k: k, a1: a1, a2: a2, at: at, from: s0.set, to: set };   // for inspection: the handover this frame
    }
    // the act on the line itself: D-I glows red-orange while it is over its rating; once the spine is open, its two end
    // spans stand clear of the gantries (a visible break at both ends; the dashes stay in place between). glowK scales
    // D-I's glow (1: the switching hover; 0.5: the hero's gentle cue, core only; 0: none, the balancing hover has its own
    // halo); with glowK < 1 the dashed spine stands at its full gap (no corridor light).
    function drawActR6(ctx, pal, lv, still, glowK, aK) {
      if (glowK == null) glowK = 1;
      if (aK == null) aK = 1;   // aK: the cue's strength (below 1 for the hero's cues under another theme's highlight)
      M.qaActK = { t: M.t, k: glowK, aK: aK };   // for inspection: the cue's strength factor this frame
      var di = M.S.lanes[M.laneIdx['L-DI']], ad = M.S.lanes[M.laneIdx[ANIMATED[0]]], i = M.laneIdx['L-DI'];
      var load = i != null ? M.laneFl[i][1] : 0, hot = clamp((load - 1) / 0.02, 0, 1) * lv * (glowK > 0 ? 1 : 0);   // from the rating up, full at 2 % over it
      // in the glide (to the end of its pass, cues.glideTail) the glow comes back with the restart's dissolve, over about
      // 0.25 s (0.125 a frame at 30 frames/s), not within two frames as at an act; D-I warms with its line field crossing
      // the rail, not with the breakers
      var gT9 = M.view && M.view.src === 'switching' && M.view.cues && M.view.cues.glideTail ? 0.125 : 0.35;
      M.swHot = (M.swHot == null ? hot : M.swHot + (hot - M.swHot) * (still ? 1 : gT9));
      var rK = M.redK == null ? 1 : M.redK;   // the HVDC day takes the glow out over DAYX.red (1 everywhere else)
      M.qaGlow = { t: M.t, k: glowK, hot: glowK > 0 && M.swHot * rK > 0.01 ? M.swHot * rK : 0 };   // for inspection: D-I's glow this frame
      var dark = html.getAttribute('data-scene') === 'dark';
      if (di && M.swHot * rK > 0.01 && glowK > 0 && lanePart(ctx, di, 0, 1)) {
        ctx.lineCap = 'round'; ctx.strokeStyle = pal.s.warm;
        ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        if (glowK >= 1) {
          ctx.lineWidth = 9; ctx.globalAlpha = (dark ? 0.22 : 0.2) * M.swHot * rK; ctx.stroke();
          ctx.lineWidth = 4.2; ctx.globalAlpha = (dark ? 0.5 : 0.55) * M.swHot * rK; ctx.stroke();
        } else {   // the hero: half strength, no outer halo (core alpha 0.28)
          ctx.lineWidth = 4.2; ctx.globalAlpha = (dark ? 0.25 : 0.28) * M.swHot * aK * rK; ctx.stroke();   // out with the day's red (rK 1 elsewhere)
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      // the static layers' dashed spine gives way to this one while the corridor light is up, or while the hero's cue or
      // the balancing hover draws it (#studio[data-sw-act])
      var act = lv > 0.02 && (glowK >= 1 || M.sw.brk) ? '1' : '';
      if (act !== (M.swAct || '')) { M.swAct = act; if (act) root.setAttribute('data-sw-act', '1'); else root.removeAttribute('data-sw-act'); }
      var gd9 = !M.sw.brk && M.glK < 1 ? 1 - (M.glC == null ? M.glK : M.glC) : 0;   // in the restart the dashes fade out over the solid line (drawSwOn), by glC
      if (ad && (M.sw.brk || gd9 > 0.004)) {
        // the opened line in place, dashed, standing clear of both gantries: no light, an unlit tone, 2.4 view units wide so
        // the held decided state stays findable
        var g = SWX.GAP * (glowK >= 1 ? lv : 1);
        M.qaAct = { t: M.t, k: glowK, hot: M.swHot, dash: 2.4, gap: g, cf: M.cfK || 0 };   // for inspection: what drawActR6 drew this frame
        if (lanePart(ctx, ad, g, 1 - g)) {
          ctx.lineCap = 'butt'; ctx.setLineDash([7, 4.5]); ctx.strokeStyle = dark ? pal.s.wire : pal.s.ink; ctx.lineWidth = 2.4;
          ctx.globalAlpha = (dark ? 0.72 : 0.62) * (1 - 0.7 * (M.cfK || 0)) * aK * (M.sw.brk ? 1 : gd9); ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'round';   // the glide fades it
        }
      }
      ctx.globalAlpha = 1;
    }
    // the switched line's solid conductor while the restart dissolves (M.glK < 1, the breakers closed), at alpha M.glC
    // (else M.glK) in every frame, and after it while M.swCv holds (draw). It is drawn last, under everything the canvas
    // holds (destination-over), so it lies between the static layer and the canvas as the static layer's own copy does:
    // the live parts lie over it, and in dark the flow light composes over it as it does over the static layer, not added
    // to it. cutTick holds the static copy at stroke-opacity 0 meanwhile (two restyles a hover). Every switchable object
    // of the line is drawn (its spans, w-ehv, and the drops at both gantries, drop), in the scene's order, each with its
    // class's computed stroke, width and opacity from the static layer (per palette and layout)
    function drawSwOn(ctx, frame, hl0, hl, kd) {
      var key = M.palVersion + '|' + M.name, C = M.swOn;
      if (!C || C.key !== key) {
        var st = {}, items = [];
        if (M.stage) Array.prototype.forEach.call(M.stage.querySelectorAll('.st-static .sw-on[data-br="' + ANIMATED[0] + '"]'), function (el) {
          var c = (el.getAttribute('class') || '').split(/\s+/).filter(function (x) { return x !== 'l' && x !== 'sw-on'; })[0], cs = global.getComputedStyle(el);
          if (c && !st[c]) st[c] = { col: cs.stroke && cs.stroke !== 'none' ? cs.stroke : M.pal.s.wire, w: parseFloat(cs.strokeWidth) || 1, a: parseFloat(cs.opacity) };
        });
        M.S.objs.forEach(function (o) {
          if (o.sw !== ANIMATED[0] || !o.pl || !o.pl.length || !st[o.pl[0].c]) return;
          var p = new global.Path2D();
          o.pl.forEach(function (l) { l.sp.forEach(function (q, j) { if (j) p.lineTo(q[0], q[1]); else p.moveTo(q[0], q[1]); }); });
          items.push({ o: o, p: p, s: st[o.pl[0].c] });
        });
        C = M.swOn = { key: key, items: items };
      }
      if (!C.items.length || M.glK <= 0) return;
      var m = M.map;
      ctx.save();
      ctx.setTransform(frame.dpr * m.s, 0, 0, frame.dpr * m.s, frame.dpr * m.ox, frame.dpr * m.oy);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
      C.items.forEach(function (it) {
        ctx.globalAlpha = lerp(dimAlpha(hl0, it.o), dimAlpha(hl, it.o), kd) * (M.glC == null ? M.glK : M.glC) * (isNaN(it.s.a) ? 1 : it.s.a);
        ctx.strokeStyle = it.s.col; ctx.lineWidth = it.s.w; ctx.stroke(it.p);
      });
      ctx.restore();
    }
    // the cues of the operator's acts (crisp): the breaker light at both ends of the spine, a glint on each blade as it
    // passes about 0.6 rad, and the thin rings at both units of a redispatch pair. The market's balancing activation has
    // no cue of its own: it is the pools' slow drain (drawPools).
    // a stretch [f0, f1] (fractions of the length) of a lane's projected polyline, as the current path
    function lanePart(ctx, ln, f0, f1) {
      var sp = ln.sp, cum = ln.cum, L = ln.len, a = f0 * L, b = f1 * L, i, started = false;
      ctx.beginPath();
      for (i = 0; i < sp.length - 1; i++) {
        var c0 = cum[i], c1 = cum[i + 1];
        if (c1 < a || c0 > b || c1 <= c0) continue;
        var u0 = Math.max(0, (a - c0) / (c1 - c0)), u1 = Math.min(1, (b - c0) / (c1 - c0));
        var p = sp[i], q = sp[i + 1];
        if (!started) { ctx.moveTo(lerp(p[0], q[0], u0), lerp(p[1], q[1], u0)); started = true; }
        ctx.lineTo(lerp(p[0], q[0], u1), lerp(p[1], q[1], u1));
      }
      return started;
    }
    // the line itself carries the act. Before the opening the spine is traced in the operator's ink (selected); when the
    // breakers open the trace parts in the middle and runs back into both breakers (0.6 s), and two ripples leave each
    // breaker, so the event reads in the light theme as well as in dark.
    function drawTrace(ctx, pal, f0, f1, a, w) {
      var ln = M.S.lanes[M.laneIdx[ANIMATED[0]]];
      if (!ln || !ln.sp || a < 0.004) return;
      ctx.lineCap = 'round'; ctx.strokeStyle = pal.s.ring;
      [[0, f0], [f1, 1]].forEach(function (r) {
        if (r[1] - r[0] < 0.002) return;
        if (!lanePart(ctx, ln, r[0], r[1])) return;
        // an underlay in the board's own tone cuts the line out of the wires behind it, then the ink core
        ctx.strokeStyle = pal.s.wall; ctx.globalAlpha = 0.9 * a; ctx.lineWidth = 7.5 * w; ctx.stroke();
        ctx.strokeStyle = pal.s.ring; ctx.globalAlpha = 0.95 * a; ctx.lineWidth = 2.6 * w; ctx.stroke();
      });
    }
    function drawCues(ctx, t, V, pal, cam, still) {
      var s = M.sw, blades = M.S.blades[ANIMATED[0]] || [], a0 = ctx.globalAlpha, tw = (M.name === 'wide' ? 1 : 0.7) * (V.cues.r6 ? 1.35 : 1);
      if (!still && V.cues.sel > 0.004 && !s.brk) { drawTrace(ctx, pal, 0.5, 0.5, V.cues.sel, tw); M.qaTrace = t; }   // for inspection: the last frame with a selection trace
      // in the switching story's corridor-light modes (cues.r6) the selection ends at the opening: no ink runs back over the
      // opened spine (in dark the near-white ink would read as light on an opened line). The hero and the balancing stories
      // keep the run-back into both breakers.
      if (!still && s.flash && s.flash.a >= 1 && s.brk && !V.cues.r6) {
        var ra = t - s.flash.t;
        if (ra >= 0 && ra < 0.6) { var rk = smooth(ra / 0.6); drawTrace(ctx, pal, 0.5 - 0.5 * rk, 0.5 + 0.5 * rk, 1 - 0.6 * rk, tw); M.qaRun = t; }   // for inspection: the run-back
      }
      if (s.flash && !still) {
        var age = t - s.flash.t, e = age < 0 ? 0 : age < 0.2 ? age / 0.2 : Math.max(0, 1 - (age - 0.2) / 0.9);
        if (age > 1.1) s.flash = null;
        else if (e > 0.003) {
          var fc = hexRgb(pal.s.flash.charAt(0) === '#' ? pal.s.flash : '#ffffff').join(','), R = M.flashR, A = s.flash.a * e;
          ctx.globalCompositeOperation = pal.s.flashBlend === 'lighter' ? 'lighter' : 'source-over';
          blades.forEach(function (o) {
            if (!o.brk) return;
            var q = cam.p(o.brk), gr = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], R);
            gr.addColorStop(0, 'rgba(' + fc + ',' + (0.95 * A).toFixed(3) + ')'); gr.addColorStop(0.35, 'rgba(' + fc + ',' + (0.55 * A).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(' + fc + ',0)');
            ctx.globalAlpha = 1; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(q[0], q[1], R, 0, TAU); ctx.fill();
          });
          ctx.globalCompositeOperation = 'source-over';
          // a crisp ring in the operator's ink around each lit breaker (it carries the light on the light model)
          ctx.strokeStyle = pal.s.ring; ctx.lineWidth = 1.3;
          blades.forEach(function (o) { if (!o.brk) return; var q = cam.p(o.brk); ctx.globalAlpha = 0.7 * A; ctx.beginPath(); ctx.arc(q[0], q[1], R * (0.42 + 0.25 * Math.min(1, age / 1.1)), 0, TAU); ctx.stroke(); });
          // two ripples per breaker in the operator's ink (they carry the act on the light model), 1.9 wide: they leave the
          // breakers at once (ease-out), strongest in the opening's first 0.3 s, and are gone 1.05 s after it, so the act reads
          // before its effect
          ctx.lineWidth = 1.9;
          [0, 0.15].forEach(function (d0) {
            var ag = age - d0; if (ag < 0 || ag > 0.9) return;
            var u = ag / 0.9, eo = 1 - (1 - u) * (1 - u) * (1 - u);
            blades.forEach(function (o) { if (!o.brk) return; var q = cam.p(o.brk); ctx.globalAlpha = 0.95 * s.flash.a * Math.pow(1 - u, 1.4); ctx.beginPath(); ctx.arc(q[0], q[1], R * (0.5 + 1.9 * eo), 0, TAU); ctx.stroke(); });
          });
        }
      }
      if (!still && t - s.glint < 0.25 && t >= s.glint) {
        var gk = 1 - (t - s.glint) / 0.25;
        ctx.strokeStyle = pal.s.glint; ctx.lineCap = 'round';
        blades.forEach(function (o) {
          o.blades.forEach(function (bl) {
            var p0 = cam.p(bl.pivot), p1 = cam.p(bladeTip(bl, s.blade));
            ctx.globalAlpha = 0.9 * gk; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(lerp(p0[0], p1[0], 0.35), lerp(p0[1], p1[1], 0.35)); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
          });
        });
      }
      // the pair's rings: each holds before it fades (1 - u^3 over SCHED.ringT, 1.3 s) and sits on an underlay in the
      // board's own tone that cuts it out of the wires behind (as the trace does)
      if (V.cues.rings.length && M.poolG) {
        V.cues.rings.forEach(function (r) {
          var u = r[0] / SCHED.ringT, ha = 1 - u * u * u, rad = r[1] * (M.name === 'wide' ? 1 : 0.6) * (0.55 + 0.45 * smooth(Math.min(1, u * 1.4)));
          (r[2] || ['bat', 'gen']).forEach(function (k) {   // r[2]: the units to ring (default: the battery park and the gas plant)
            if (!M.poolG[k]) return;
            var q = M.poolG[k].unit;
            ctx.beginPath(); ctx.arc(q[0], q[1], rad, 0, TAU);
            ctx.strokeStyle = pal.s.wall; ctx.lineWidth = 5; ctx.globalAlpha = 0.75 * ha; ctx.stroke();
            ctx.strokeStyle = pal.s.ring; ctx.lineWidth = 2.1; ctx.globalAlpha = 0.95 * ha; ctx.stroke();
            ctx.lineWidth = 1.3; ctx.globalAlpha = 0.55 * (1 - u) * (1 - u); ctx.beginPath(); ctx.arc(q[0], q[1], rad * 1.45, 0, TAU); ctx.stroke();
          });
        });
      }
      // a unit's ring pulses at the moment its own bids change on the bid ladder
      M.qaPulse = [];
      if (V.cues.pulses && V.cues.pulses.length && M.poolG) {
        V.cues.pulses.forEach(function (pq) {
          var q = M.poolG[pq[0]] && M.poolG[pq[0]].unit; if (!q) return;
          // over the unit's whole change (pq[2] s, else 0.4) the ring swells 22 to 29 and back, heavier, with an echo ring
          // spreading out from it (as the decision's rings do), so the unit whose bids change is unmistakable
          var uu = clamp(pq[1] / (pq[2] || 0.4), 0, 1), sw = M.name === 'wide' ? 1 : 0.6, rad = (22 + 7 * Math.sin(Math.PI * uu)) * sw;
          ctx.beginPath(); ctx.arc(q[0], q[1], rad, 0, TAU);
          ctx.strokeStyle = pal.s.wall; ctx.lineWidth = 6; ctx.globalAlpha = 0.75; ctx.stroke();
          ctx.strokeStyle = pal.s.ring; ctx.lineWidth = 2.8; ctx.globalAlpha = 0.95; ctx.stroke();
          ctx.lineWidth = 1.4; ctx.globalAlpha = 0.6 * (1 - uu) * (1 - uu); ctx.beginPath(); ctx.arc(q[0], q[1], (22 + 18 * uu) * sw, 0, TAU); ctx.stroke();
          M.qaPulse.push([pq[0], rad, M.t]);
        });
      }
      ctx.globalAlpha = a0;
    }
    // the flow light: lanes dim with a highlight's membership (each story lights its own lanes), tints while a pool drains
    function beamLaneK(h) {
      if (!h) return null;
      if (h === 'switching') {
        // under the corridor light (cues.r6) the lanes outside the corridor sink with the model, and the pair's lanes come up
        // with the two units
        if (M.view && M.view.cues && M.view.cues.r6) return function (ln) { var i = ln.__i; return M.laneSwitch[i] ? 1 : M.laneUnits && M.laneUnits[i] ? lerp(SWX.SINK.beams, 1, M.isoU || 0) : lerp(0.5, SWX.SINK.beams, M.isoLv || 0); };
        return function (ln) { return M.laneSwitch[ln.__i] ? 1 : 0.5; };
      }
      // with the balancing sink, D-I, the spine, the units' lanes and the plants' own lanes keep full light, the ladder and
      // the wind's lanes (their dimming is the shortfall's cue) half light, the rest sinks with the model
      if (h === 'balancing' && M.balSink) return function (ln) { var i = ln.__i, k = M.isoLv || 0; return /^L-(DI|AD)$/.test(ln.id) || (M.laneUnits && M.laneUnits[i]) || /^(eng|bm)-/.test(ln.id) ? 1 : M.laneSwitch[i] ? lerp(1, 0.5, k) : M.laneWind[i] ? lerp(1, 0.6, k) * (1 - ((M.view && M.view.cues && M.view.cues.windK) || 0)) : lerp(0.35, SWX.SINK.beams, k); };
      if (h === 'balancing') return function (ln) { return M.laneBal[ln.__i] ? 1 : 0.35; };
      // the HVDC day keeps the DC poles in full light (they carry its own color, Beams' hc); every other lane sinks with
      // the model to SWX.SINK.beams and rests (Beams' acRest)
      if (h === 'hvdc' && M.hvSink) return function (ln) { return ln.w === 'dc' && ln.src && ln.src.el !== 'none' ? 1 : lerp(0.5, SWX.SINK.beams, M.isoLv || 0); };
      return function (ln) { return ln.theme === h ? 1 : 0.28; };
    }
    function drawBeams(ctx, frame, t, dt, still, V, hl0, hl, kd, dcOnly) {
      var B = M.beams;
      if (!B) return;
      var T0 = M.beamTiming ? global.performance.now() : 0;   // profiling: M.beamTiming = { ms: 0, n: 0 } times the flow light
      // the HVDC day's light (hc), the overload red's factor, the pulse's wavelength and body, only the HVDC light (dcOnly)
      B.hc = M.hcK || 0; B.redK = M.redK == null ? 1 : M.redK; B.hcLam = DAYX.light.lam[M.name] || DAYX.light.lam.wide; B.hcBodyK = DAYX.light.bodyK[M.name] || 1; B.dcOnly = !!dcOnly; B.hcOne = !!(DAYX.light.one && DAYX.light.one[M.name]);   // hcOne: one pulse per link on phones
      B.update(dt, M.laneFl, M.laneLive, still, M.view && M.view.src === 'switching' && M.view.cues && M.view.cues.glideTail ? 0.25 : 0);   // the restart's warm core eases in (the glide)
      var tint = V.cues.tint;
      if (tint || M.tinted) {
        ['gen', 'bat'].forEach(function (g) {
          var k = 0; (tint || []).forEach(function (w) { if (w[0] === g) k = Math.max(k, w[1]); });
          M.laneTint[g].forEach(function (i) { B.tint(i, g === 'gen' ? 'dear' : 'cheap', k); });
        });
        M.tinted = !!tint;
      }
      var f0 = beamLaneK(hl0), f1 = beamLaneK(hl), laneK = null;
      if (f0 || f1) laneK = function (ln) { return lerp(f0 ? f0(ln) : 1, f1 ? f1(ln) : 1, kd); };
      // in the switching replay's glide the switched line's own lanes come up with its conductors (M.glC, else M.glK), from
      // the frame it is back
      var gA9 = !M.sw.brk && M.glK < 1 ? (M.glC == null ? M.glK : M.glC) : 1;   // with the conductor (glC)
      if (gA9 < 1) { var lk1 = laneK; laneK = function (ln) { return (lk1 ? lk1(ln) : 1) * (M.laneBr[ln.__i] === ANIMATED[0] ? gA9 : 1); }; }
      B.draw(ctx, frame.dpr, t, laneK);
      if (M.beamTiming) { M.beamTiming.ms += global.performance.now() - T0; M.beamTiming.n++; }
    }
    // the pools (SVG, in the highlight layer): scaled about their centers by the square root of the room, faded in with
    // the balancing story and out over 0.6 s after it; the dear pool's rim brightens by 60 % while it drains
    function drawPools(V, dt, still) {
      var c = V.cues.pools, E = M.poolEls;
      if (!E || !E.cheap) return;
      if (c) { M.poolA = c.a; M.poolRoom = c.room; M.rimK = V.cues.rim; }
      else if (M.poolA > 0) M.poolA = still ? 0 : Math.max(0, M.poolA - dt / 0.6);
      var key = M.poolA.toFixed(3) + '|' + M.poolRoom[0].toFixed(1) + '|' + M.poolRoom[1].toFixed(1) + '|' + M.rimK.toFixed(2);
      if (key === M.poolKey) return;
      M.poolKey = key;
      [[E.cheap, M.poolRoom[0]], [E.dear, M.poolRoom[1]]].forEach(function (q) {
        var el = q[0], cc = (el.getAttribute('data-c') || '0 0').split(' ').map(Number), k = Math.sqrt(Math.max(0, q[1]) / POOLS.full);
        el.setAttribute('transform', 'translate(' + fmt2(cc[0]) + ' ' + fmt2(cc[1]) + ') scale(' + k.toFixed(4) + ') translate(' + fmt2(-cc[0]) + ' ' + fmt2(-cc[1]) + ')');
        el.style.opacity = k > 0.01 ? M.poolA.toFixed(3) : '0';
      });
      if (E.rim) E.rim.style.opacity = (0.5 * (1 + 0.6 * M.rimK)).toFixed(3);
    }
    // ── The cues of the balancing stories ──
    // D-I's congestion: a red-orange halo pulses along D-I (period 1.4 s) under its beam, only while the shown loading is
    // over the rating; it goes out as the line drops under its limit.
    function drawHot(ctx, pal, V) {
      var T0 = M.balTiming ? global.performance.now() : 0, i = M.laneIdx['L-DI'], ln = i == null ? null : M.S.lanes[i], k = V.cues.hot || 0;
      var over = ln ? clamp((M.laneFl[i][1] - 1) / 0.012, 0, 1) : 0;
      M.hotLv = ln && ln.sp && k >= 0.004 ? k * over : 0;   // the halo's strength this frame (0 when D-I is under its rating)
      if (M.hotLv >= 0.004 && lanePart(ctx, ln, 0, 1)) {
        var ph = 0.5 - 0.5 * Math.cos(TAU * (V.h || 0) / 1.4), A = M.hotLv * (0.4 + 0.6 * ph), w = M.name === 'wide' ? 1 : 0.7, lit = pal.s.beamBlend === 'lighter', a0 = ctx.globalAlpha;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = pal.s.beamHot;
        ctx.globalCompositeOperation = lit ? 'lighter' : 'source-over';
        ctx.globalAlpha = A * (lit ? 0.3 : 0.22); ctx.lineWidth = 12 * w; ctx.stroke();
        ctx.globalAlpha = A * (lit ? 0.5 : 0.4); ctx.lineWidth = 5 * w; ctx.stroke();
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a0;
      }
      if (M.balTiming) M.balTiming.ms += global.performance.now() - T0;
    }
    // the merit chart and the arrows, over the model (view units); the chart fades in with the story and out over 0.6 s
    // after it. Profiling: M.balTiming = { ms: 0, n: 0 } times this code and drawHot (n counts frames).
    function drawBal(ctx, frame, V, dt, still) {
      var T0 = M.balTiming ? global.performance.now() : 0, c = V.cues.merit || null, pairs = V.cues.pairs || [];
      if (c) { M.meritA = c.a; M.meritLast = c; }
      else if (M.meritA > 0) M.meritA = still ? 0 : Math.max(0, M.meritA - dt / 0.6);
      if ((M.meritA > 0.004 && M.meritLast) || pairs.length) {
        var m = M.map;
        ctx.save();
        ctx.setTransform(frame.dpr * m.s, 0, 0, frame.dpr * m.s, frame.dpr * m.ox, frame.dpr * m.oy);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (M.meritA > 0.004 && M.meritLast) drawMerit(ctx, M.pal, M.meritLast, M.meritA);
        pairs.forEach(function (q) { drawPair(ctx, M.pal, q); });
        ctx.restore();
      }
      // the bid ladder on its own canvas; it fades in with the story (ladderAt) and out over 0.6 s after it
      var lc = V.cues.ladder || null;
      if (lc) { M.ladA = lc.a; M.ladLast = lc; M.ladRect = ladderRect(); }
      else if (M.ladA > 0) M.ladA = still ? 0 : Math.max(0, M.ladA - dt / 0.6);
      if (M.ladA > 0.004 && M.ladLast && M.ladRect) drawLadder(frame.dpr, M.ladLast, M.ladA); else ladderHide();
      if (M.balTiming) { M.balTiming.ms += global.performance.now() - T0; M.balTiming.n++; }
    }
    // ── The bid ladder, on its own small canvas over the stage (st-chart), so it stays still on screen while the camera
    // moves (the main canvas carries the camera's CSS transform while it moves and then covers only the transformed stage).
    // Wall: the slot beside the framed model while the 'wall' framing holds (wallFit); anchor: no camera (phones, a short
    // window, a fit under zField), the chart stands on the plinth (CHART7.fall). Base units: the slot is 352 x 186
    // (CHART7); k CSS px per unit. No words, no numbers.
    function pageBg() { return global.getComputedStyle(d.body).backgroundColor || M.pal.s.wall; }
    // R.h is the slot's height in base units (the wall slot grows upward where the visible band allows; CHART7.h on
    // the fallback anchor)
    function ladderRect() {
      var F = M.cam && M.cam.fit;
      if (F && F.wall) { var kw = F.slot[2] / CHART7.w; return { x: F.slot[0], y: F.slot[1], k: kw, h: F.slot[3] / kw, mode: 'wall', side: F.side || 'right' }; }
      var A = CHART7.fall[M.name], m = M.map, q = M.S.cam.p([A.at[0], M.S.ground, A.at[1]]), wv = A.w, hv = wv * CHART7.h / CHART7.w;
      return { x: m.ox + m.s * (q[0] - wv / 2), y: m.oy + m.s * (q[1] - hv), k: m.s * wv / CHART7.w, h: CHART7.h, mode: 'anchor' };
    }
    function ladderCanvas(R, dpr) {
      var c = M.ladCv, P = CHART7.pad * R.k;
      if (!c || c.parentNode !== M.stage) {
        c = d.createElement('canvas'); c.className = 'st-chart'; c.setAttribute('aria-hidden', 'true');
        M.stage.appendChild(c); M.ladCv = c; M.ladKey = null;
      }
      var key = [R.x, R.y, R.k, R.h, dpr].map(function (v) { return v.toFixed(3); }).join('|');
      if (key !== M.ladKey) {
        M.ladKey = key;
        c.width = Math.ceil((CHART7.w * R.k + 2 * P) * dpr); c.height = Math.ceil((R.h * R.k + 2 * P) * dpr);
        var st = c.style;
        st.inset = 'auto'; st.left = (R.x - P).toFixed(2) + 'px'; st.top = (R.y - P).toFixed(2) + 'px';
        st.width = (c.width / dpr).toFixed(3) + 'px'; st.height = (c.height / dpr).toFixed(3) + 'px'; st.pointerEvents = 'none';
      }
      return c;
    }
    function ladderHide() { if (M.ladCv && M.ladCv.style.display !== 'none') { M.ladCv.style.display = 'none'; M.qaLadder = null; } }
    // strokes from LADK (CHART7.str); the counterfactual's faint fill drawn under the decision's fill; the price marked by
    // a dot on the price wall, no tick past it; the decision's redispatch foot light until its settlement block grows on
    // it; the counterfactual's dashed ladder clipped as it is drawn on
    function drawLadder(dpr, c, a) {
      var R = M.ladRect, cv = ladderCanvas(R, dpr), g = cv.getContext('2d'), Pd = CHART7.pad, s = M.pal.s, lit = s.beamBlend === 'lighter';
      var RH = R.h || CHART7.h, PL = chartPlot(RH), K = LADK, X = function (mw) { return PL.x0 + PL.kx * mw; }, Y = function (p) { return PL.yb - PL.ky * p; }, bg = pageBg();
      // each unit's bids in its own color (bidBat, bidBio, bidGas), each at full strength
      var col = function (u) { return u === 'battery' ? s.bidBat : u === 'biomass' ? s.bidBio : s.bidGas; }, ua = function () { return 1; };
      var fillA = parseFloat(s.decA) || (lit ? 0.55 : 0.6), wA = parseFloat(s.wasteA) || 0.12, wH = parseFloat(s.wasteHatchA) || 0.65, i;
      if (cv.style.display === 'none') cv.style.display = '';
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
      g.setTransform(dpr * R.k, 0, 0, dpr * R.k, dpr * R.k * Pd, dpr * R.k * Pd);
      g.lineCap = 'butt'; g.lineJoin = 'miter';
      var line = function (x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
      var rrect = function (x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
      var hatch = function (x0, y0, x1, y1, alpha, colr, lw, gap) {   // 45-degree lines 6 (or gap) apart, clipped to the box
        if (x1 - x0 < 0.3 || y1 - y0 < 0.3 || alpha < 0.004) return;
        g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
        g.strokeStyle = colr || s.ink; g.lineWidth = lw || 0.9; g.globalAlpha = alpha; g.setLineDash([]); g.beginPath();
        for (var t = x0 - (y1 - y0); t < x1; t += gap || 6) { g.moveTo(t, y1); g.lineTo(t + (y1 - y0), y0); }
        g.stroke(); g.restore();
      };
      // the extra cost of the cheapest redispatch, in red (k: its own fade, which only the counterfactual drives). The band
      // between the two clearing prices is red hatch lines on the chart's ground, no fill (band: true; its extent is the
      // dashed ink outline); the dashed column's excess too while K.wFill is 0 (1: a light fill under the hatch). The lines
      // are K.wLw CSS px wide at every desktop size (wider in base units when the chart is drawn smaller, up to 1.25 times),
      // so a line holds 3:1 against the ground; K.wGap apart. redQ: every red box drawn this frame (base units) with its
      // strength
      var redQ = [], wLw = K.wLw * Math.min(1.25, Math.max(1, 1 / R.k));
      var waste = function (x0, y0, x1, y1, k, band) {
        if (x1 - x0 < 0.3 || y1 - y0 < 0.3 || k < 0.004) return;
        if (!band && K.wFill) { g.fillStyle = s.wasteFill; g.globalAlpha = a * wA * k; g.fillRect(x0, y0, x1 - x0, y1 - y0); }
        hatch(x0, y0, x1, y1, a * wH * k, s.wasteLine, wLw, K.wGap);
        redQ.push([x0, y0, x1, y1, k]);
      };
      // the ground: three feathered rounded rects and an opaque one in the page's own tone, so nothing behind reads through
      g.fillStyle = bg;
      [[18, 0.26], [11, 0.32], [5, 0.44]].forEach(function (f) { g.globalAlpha = a * f[1] * (lit ? 0.95 : 1); rrect(-f[0], -f[0], CHART7.w + 2 * f[0], RH + 2 * f[0], f[0]); g.fill(); });
      g.globalAlpha = a; g.fillRect(2, 2, CHART7.w - 4, RH - 4);
      // the floor and the price wall
      g.strokeStyle = s.ink; g.lineWidth = K.floor; g.globalAlpha = a * 0.6; line(PL.x0, PL.yb, PL.x1, PL.yb);
      g.lineWidth = K.wall; g.globalAlpha = a * 0.4; line(PL.x0, PL.yb, PL.x0, PL.yt);
      var B = c.bids, qa = { t: M.t, mode: R.mode, k: R.k, h: RH, a: a, bids: [], end: c.end, V: c.V, flat: c.flat, price: c.price, cf: null, cols: null, ground: bg, focus: c.focus || null };
      // the counterfactual's activation as points (its outline rises over its own bids cheapest first, then flattens to its
      // clearing price); its faint ink fill goes under the decision's fill, so that stays clean
      var CF = c.cf, cpts = null;
      if (CF && CF.k > 0 && CF.V > 0.05) {
        cpts = [[X(0), PL.yb]];
        CF.bids.forEach(function (q) { if (q.w < 0.01 || q.x0 >= CF.V) return; var lv = q.p < CF.mip ? lerp(q.p, CF.mip, CF.flat) : q.p; cpts.push([X(q.x0), Y(lv)], [X(Math.min(q.x1, CF.V)), Y(lv)]); });
        cpts.push([X(CF.V), PL.yb]);
        g.fillStyle = s.ink; g.globalAlpha = a * 0.06; g.beginPath(); cpts.forEach(function (p, j) { if (j) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.closePath(); g.fill();
      }
      // the decision's activated energy (cheapest first under the battery park's bids), then flattened to the clearing price
      if (c.V > 0.05) {
        var dpts = [[X(0), PL.yb]];
        for (i = 0; i < B.length; i++) {
          var q = B[i]; if (q.w < 0.01 || q.x0 >= c.V) continue;
          var lvl = q.p < c.mip ? lerp(q.p, c.mip, c.flat) : q.p, xe = Math.min(q.x1, c.V);
          dpts.push([X(q.x0), Y(lvl)], [X(xe), Y(lvl)]);
        }
        dpts.push([X(c.V), PL.yb]);
        // the decision's activated energy, then its settlement, in green; its edge in the darker green (the fill alone is
        // light on the light ground; the edge holds 4.2:1)
        g.fillStyle = s.decFill; g.globalAlpha = a * fillA; g.beginPath(); dpts.forEach(function (p, j) { if (j) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.closePath(); g.fill();
        g.strokeStyle = s.decLine; g.lineWidth = 1.4; g.globalAlpha = a * 0.9; g.beginPath(); dpts.slice(1).forEach(function (p, j) { if (j) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.stroke();
      }
      // the counterfactual's extra settlement of the same shortfall: red hatch between the two clearing prices over the
      // shortfall's width (CF.hatch fades in as its rectangle flattens to its clearing price)
      if (CF && CF.hatch > 0) { waste(X(0), Y(CF.mip), X(CF.V > 0 ? Math.min(CF.V, 200) : 0), Y(c.mip), CF.hatch, true); qa.hatch = [X(0), Y(CF.mip), X(Math.min(CF.V, 200)), Y(c.mip), CF.hatch]; }
      // the decision's bids: hollow blocks (a crisp top at the price, faint sides to the floor), risers between neighbors, and
      // the end wall after the last bid (beyond every bid the price jumps); a changed bid's top pulses at its unit's moment
      var vis = B.filter(function (q) { return q.w > 0.05; });
      // a side that two neighboring bids share is stroked once: two strokes at one x would mix into a rule of a third
      // color the chart's full height. The cheaper bid's right side runs to the floor in its color; the pricier bid's left
      // side (with the riser, in its color) only from its top down to the cheaper bid's top (below).
      var shared = function (p0, p1) { return p0 && p1 && Math.abs(X(p1.x0) - X(p0.x1)) < 0.05; };
      // a bid's top may lie on the decision's fill, so every bid top is cut out of what lies under it by K.casing CSS px of
      // the chart's ground on each side (invisible on the bare ground), and a top reads against the ground's own tone
      // wherever it lies. The casings go down first, so they cut only what lies under the bids (the fill, its edge), never
      // a bid's own sides or risers.
      // A bid's alpha from ladderAt (0.22 for a bid the decision does not use; x 0.4 while another unit's bids change) does
      // not fade its color: every bid keeps its unit's color at full strength, so the three kinds stay apart. The alpha
      // thins its top instead (thin: 0 at full strength, 1 at 0.22 or less; the top from K.top to K.top x (1 - K.thin)) and
      // makes its sides and risers at most K.sideThin fainter
      var thin = function (q) { return clamp((1 - q.a) / (1 - 0.22), 0, 1); }, topW = function (q) { return K.top * (1 - K.thin * thin(q)) + 1.4 * q.pulse; };
      var sideA = function (q) { return a * ua(q.u) * K.sideA * (1 - K.sideThin * thin(q)); };
      var cas = K.casing / R.k;
      if (cas > 0) vis.forEach(function (q) {
        var y = Y(q.p);
        g.strokeStyle = bg; g.lineWidth = topW(q) + 2 * cas; g.globalAlpha = a * ua(q.u); line(X(q.x0), y, X(q.x1), y);
      });
      // The pricier bid's riser and left side stop 1 CSS px above the upper edge of the cheaper bid's top (half its width
      // above it), so the two colors never share a pixel at that corner either (antialiased, the corner pixel would mix them)
      var half = function (q) { return topW(q) / 2; }, gap = 1 / R.k;
      vis.forEach(function (q, j) {
        var y = Y(q.p), pv = vis[j - 1], nx = vis[j + 1];
        g.strokeStyle = col(q.u); g.lineWidth = K.side; g.globalAlpha = sideA(q);
        if (!shared(pv, q)) line(X(q.x0), y, X(q.x0), PL.yb);
        else if (Y(pv.p) - half(pv) - gap > y + 0.01) line(X(q.x0), y, X(q.x0), Y(pv.p) - half(pv) - gap);
        line(X(q.x1), shared(q, nx) ? y - half(q) : y, X(q.x1), PL.yb);   // (from the top's upper edge where the riser starts there)
        if (shared(q, nx) && Y(nx.p) < y - half(q) - gap) { g.strokeStyle = col(nx.u); g.lineWidth = K.riser; g.globalAlpha = sideA(nx); line(X(q.x1), y - half(q) - gap, X(q.x1), Y(nx.p)); }
        g.strokeStyle = col(q.u); g.lineWidth = topW(q); g.globalAlpha = a * ua(q.u);
        line(X(q.x0), y, X(q.x1), y);
      });
      B.forEach(function (q) { qa.bids.push({ u: q.u, j: q.j, w: q.w, x0: X(q.x0), x1: X(q.x1), y: Y(q.p), alpha: q.a, pulse: q.pulse, top: topW(q) }); });   // for inspection: every bid, zero-width too (top: its width)
      if (vis.length) { var lb = vis[vis.length - 1]; g.strokeStyle = s.ink; g.lineWidth = K.end; g.globalAlpha = a * 0.35 * (1 - K.sideThin * thin(lb)); line(X(c.end), Y(lb.p), X(c.end), PL.yt); }   // thinned as the sides
      // the counterfactual: its own ladder dashed, drawn left to right (clipped); then its outline over the activation
      if (CF && CF.k > 0) {
        var cvis = CF.bids.filter(function (q) { return q.w > 0.05; });
        // the clip starts at -Pd, so its width carries Pd too
        var clipR = X(0) + (X(CF.end) - X(0)) * CF.k + 2;
        g.save(); g.beginPath(); g.rect(-Pd, -Pd, Pd + clipR, RH + 2 * Pd); g.clip();
        g.setLineDash(K.dash);
        cvis.forEach(function (q, j) {
          var y = Y(q.p); g.strokeStyle = col(q.u); g.globalAlpha = a * 0.85 * ua(q.u); g.lineWidth = K.cfTop; line(X(q.x0), y, X(q.x1), y);
          var nx = cvis[j + 1]; if (nx) { g.strokeStyle = col(nx.u); g.globalAlpha = a * 0.85 * ua(nx.u); g.lineWidth = K.cfRiser; line(X(q.x1), y, X(q.x1), Y(nx.p)); }
        });
        if (cvis.length) { var lc = cvis[cvis.length - 1]; g.strokeStyle = col(lc.u); g.globalAlpha = a * 0.85 * ua(lc.u); g.lineWidth = K.cfRiser; line(X(CF.end), Y(lc.p), X(CF.end), PL.yt); }   // the end in its last bid's color, as the line it ends
        g.restore();
        if (cpts) {
          g.setLineDash(K.dash); g.lineWidth = K.cfTop;
          // the outline in ink: each bid's top edge, then the sides and the risers
          CF.bids.forEach(function (q) {
            if (q.w < 0.01 || q.x0 >= CF.V) return;
            var lv = q.p < CF.mip ? lerp(q.p, CF.mip, CF.flat) : q.p;
            g.strokeStyle = s.ink; g.globalAlpha = a * 0.95 * lerp(ua(q.u), 1, CF.flat);
            line(X(q.x0), Y(lv), X(Math.min(q.x1, CF.V)), Y(lv));
          });
          g.strokeStyle = s.ink; g.globalAlpha = a * 0.95;
          line(cpts[0][0], cpts[0][1], cpts[1][0], cpts[1][1]);   // the left side, then the risers between its bids, the right side
          for (i = 2; i + 1 < cpts.length - 1; i += 2) line(cpts[i][0], cpts[i][1], cpts[i + 1][0], cpts[i + 1][1]);
          line(X(CF.V), cpts[cpts.length - 2][1], X(CF.V), PL.yb);
          g.setLineDash([]);
        }
        qa.cf = { k: CF.k, V: CF.V, flat: CF.flat, hatch: CF.hatch, price: CF.price, end: X(CF.end), clipR: clipR, bids: cvis.map(function (q) { return { u: q.u, w: q.w, x0: X(q.x0), x1: X(q.x1), y: Y(q.p) }; }) };
      }
      // the price marks: the decision's (solid, in its line color, a filled dot on the price wall) and the counterfactual's
      // (ink, dashed, a hollow dot on the wall)
      if (c.price > 0) {
        var yp = Y(c.mip); g.strokeStyle = s.decLine; g.lineWidth = K.price; g.globalAlpha = a * c.price;
        line(X(0), yp, X(c.V), yp);
        g.fillStyle = s.decLine; g.beginPath(); g.arc(PL.x0, yp, K.dot * (0.6 + 0.4 * c.price), 0, TAU); g.fill();
        qa.priceY = yp;
      }
      if (CF && CF.price > 0) {
        var yq = Y(CF.mip), kp = CF.price;
        g.strokeStyle = s.ink; g.lineWidth = K.cfPrice; g.globalAlpha = a * kp; g.setLineDash(K.dash); line(X(0), yq, X(Math.min(CF.V, 200)), yq); g.setLineDash([]);
        g.fillStyle = bg; g.beginPath(); g.arc(PL.x0, yq, K.dot * (0.6 + 0.4 * kp), 0, TAU); g.fill(); g.lineWidth = 1.6; g.stroke();
        qa.cfPriceY = yq;
      }
      // the two columns, one scale (the counterfactual's total = 0.86 of the plot's height): the decision's solid (a foot
      // for the redispatch, a block for the settlement), the counterfactual's dashed (its foot, its settlement hatched)
      var C = c.cols, KC = CHART7.cols, sc = KC.h * (PL.yb - PL.yt) / C.max, x1 = KC.x[0], x2 = KC.x[1], w = KC.w;
      var dh1 = C.dec.rd * sc, dh2 = C.dec.set * sc, kf = C.dec.k == null ? 1 : C.dec.k;
      // the decision's column in green (its redispatch foot in the darker green, its settlement as the chart's fill,
      // outlined); the counterfactual's dashed column neutral, its part above the decision's total (its excess) in red
      if (dh1 > 0.05) {
        g.fillStyle = s.decDeep; g.globalAlpha = a * lerp(0.3, 0.9, kf); g.fillRect(x1, PL.yb - dh1, w, dh1);
        if (kf < 1) { g.strokeStyle = s.decDeep; g.lineWidth = 1.2; g.globalAlpha = a * 0.9 * (1 - kf); g.strokeRect(x1 + 0.6, PL.yb - dh1 + 0.6, w - 1.2, dh1 - 1.2); }
      }
      if (dh2 > 0.05) {
        g.fillStyle = s.decFill; g.globalAlpha = a * fillA; g.fillRect(x1, PL.yb - dh1 - dh2, w, dh2);
        g.strokeStyle = s.decLine; g.lineWidth = 1.2; g.globalAlpha = a * 0.9; g.strokeRect(x1 + 0.6, PL.yb - dh1 - dh2 + 0.6, w - 1.2, dh2 - 0.6);
        g.lineWidth = 1.8; g.globalAlpha = a; line(x1, PL.yb - dh1 - dh2, x1 + w, PL.yb - dh1 - dh2);
      }
      qa.cols = { x: [x1, x2], w: w, yb: PL.yb, scale: sc, dec: [dh1, dh2], footK: kf, cf: null };
      if (C.cf) {
        var ch1 = C.cf.rd * sc, ch2 = C.cf.set * sc, yd = PL.yb - dh1 - dh2, yt = PL.yb - ch1 - ch2;
        g.fillStyle = s.ink; g.globalAlpha = a * 0.2; g.fillRect(x2, PL.yb - ch1, w, ch1);
        // the gray hatch firmer in dark (0.36; 0.24 in light)
        hatch(x2, Math.max(yt, yd), x2 + w, PL.yb - ch1, a * (lit ? 0.36 : 0.24));
        if (yt < yd - 0.05) waste(x2, yt, x2 + w, Math.min(yd, PL.yb - ch1), 1);
        qa.cols.excess = yt < yd - 0.05 ? [x2, yt, x2 + w, Math.min(yd, PL.yb - ch1)] : null;
        g.setLineDash([5, 3.5]); g.strokeStyle = s.ink; g.lineWidth = 1.8; g.globalAlpha = a * 0.95;
        g.strokeRect(x2, PL.yb - ch1, w, ch1); g.strokeRect(x2, PL.yb - ch1 - ch2, w, ch2); g.setLineDash([]);
        // a solid ink rule across the dashed column at the decision's total, where its red excess begins, so the excess stands
        // apart from the column's gray part by form as well as by color (in deuteranopia and grayscale the two hatches differ
        // only by a small lightness step); it grows with the column (C.cf.k) and shows only when there is an excess
        if (yt < yd - 0.05 && yd < PL.yb - ch1 - 0.05) {
          g.strokeStyle = s.ink; g.lineWidth = 1.6; g.globalAlpha = a * 0.95 * (C.cf.k == null ? 1 : C.cf.k);
          line(x2 - 2, yd, x2 + w + 2, yd);
          qa.cols.rule = [x2 - 2, yd, x2 + w + 2];
        }
        qa.cols.cf = [ch1, ch2];
      }
      g.globalAlpha = 1;
      // the slot in viewport px (the chart's 352 x RH base box)
      var sr = M.stage.getBoundingClientRect();
      qa.rect = [sr.left + R.x, sr.top + R.y, sr.left + R.x + CHART7.w * R.k, sr.top + R.y + RH * R.k];
      qa.plot = PL; qa.red = redQ; qa.side = R.side || null;
      M.qaLadder = qa;
    }
    // The zone's upward merit order (no words): a floor and a faint price wall; the room each group offers, faint, under the
    // curve; the curve itself, crisp, teal over the cheap group's room and magenta over the dear group's; the activated
    // energy, cheapest first, as the lit area under the curve from the floor's start (its right edge: how deep it reached);
    // a ghost as a dashed outline of another decision's fill, rising from the floor.
    function drawMerit(ctx, pal, c, a) {
      var G = M.meritG, R = c.total || MERIT.total, sc = M.name === 'wide' ? 1 : 0.62, lit = pal.s.beamBlend === 'lighter';
      // with the cost columns the curve keeps the chart's left part and the columns its right end (MERIT.cols)
      var Wc = c.cols ? G.W - MERIT.cols.zone * sc : G.W;
      var X = function (mw) { return G.x0 + Wc * clamp(mw, 0, R) / R; }, Y = function (p) { return G.yb - G.H * p / MERIT.pmax; };
      var path = function (Rb, Rt, upto) {   // the curve from 0 to 'upto' MW as points (the cheap group, the step, the dear group)
        var P = [], j, mw, u;
        if (Rb > 0.5) for (j = 0; j <= 24; j++) { mw = Rb * j / 24; if (mw >= upto) { P.push([X(upto), Y(meritGroup(MERIT.cheap, upto / Rb))]); return P; } P.push([X(mw), Y(meritGroup(MERIT.cheap, j / 24))]); }
        for (j = 0; j <= 40; j++) { u = 1 - Math.pow(1 - j / 40, 1.7); mw = Rb + Rt * u; if (mw >= upto) { P.push([X(upto), Y(meritGroup(MERIT.dear, Rt > 0 ? (upto - Rb) / Rt : 1))]); return P; } P.push([X(mw), Y(meritGroup(MERIT.dear, u))]); }
        return P;
      };
      var under = function (P, k) { ctx.beginPath(); ctx.moveTo(P[0][0], G.yb); P.forEach(function (q) { ctx.lineTo(q[0], G.yb - (G.yb - q[1]) * k); }); ctx.lineTo(P[P.length - 1][0], G.yb); ctx.closePath(); };
      var line = function (P) { ctx.beginPath(); P.forEach(function (q, j) { if (j) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); };
      var split = X(c.Rb), top = G.yb - G.H - 6, hgt = G.H + 12;
      var byGroup = function (fn) {   // draw fn(color) clipped to each group's span of the chart
        [[G.x0 - 8, split, pal.s.poolCheap], [split, G.x0 + G.W + 8, pal.s.poolDear]].forEach(function (s) {
          if (s[1] - s[0] < 0.2) return;
          ctx.save(); ctx.beginPath(); ctx.rect(s[0], top, s[1] - s[0], hgt); ctx.clip(); fn(s[2]); ctx.restore();
        });
      };
      var full = path(c.Rb, c.Rt, R + 1);
      // a soft ground of the board's own tone (three feathered layers, no edge), so the chart reads over the model behind it
      // and the towers and conductors there do not read as lines of the chart
      ctx.fillStyle = pal.s.wall;
      [[18, 0.26], [11, 0.32], [5, 0.44]].forEach(function (f) {
        var p = f[0] * sc; ctx.globalAlpha = a * f[1] * (lit ? 0.95 : 1); ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(G.x0 - p - 4 * sc, G.yb - G.H - p - 4 * sc, G.W + 2 * p + 12 * sc, G.H + 2 * p + 6 * sc, p); else ctx.rect(G.x0 - p - 4 * sc, G.yb - G.H - p - 4 * sc, G.W + 2 * p + 12 * sc, G.H + 2 * p + 6 * sc);
        ctx.fill();
      });
      // the floor and the price wall
      ctx.strokeStyle = pal.s.ink; ctx.lineWidth = 1.4 * sc; ctx.globalAlpha = a * 0.6;
      ctx.beginPath(); ctx.moveTo(G.x0, G.yb); ctx.lineTo(G.x0 + G.W + 6 * sc, G.yb); ctx.stroke();
      ctx.globalAlpha = a * 0.32; ctx.beginPath(); ctx.moveTo(G.x0, G.yb); ctx.lineTo(G.x0, G.yb - G.H); ctx.stroke();
      // the room each group offers (faint), the curve (crisp)
      byGroup(function (col) { ctx.fillStyle = col; ctx.globalAlpha = a * (lit ? 0.16 : 0.14); under(full, 1); ctx.fill(); });
      byGroup(function (col) { ctx.strokeStyle = col; ctx.globalAlpha = a; ctx.lineWidth = 2.2 * sc; line(full); ctx.stroke(); });
      // the ghosts: another decision's fill, as a dashed outline rising from the floor (with a trace of its body)
      c.ghosts.forEach(function (g) {
        var P = path(g.Rb, g.Rt, g.V), col = g.V > g.Rb ? pal.s.poolDear : pal.s.poolCheap, A = a * g.k;
        if (A < 0.004 || P.length < 2) return;
        ctx.fillStyle = col; ctx.globalAlpha = A * 0.1; under(P, g.k); ctx.fill();
        ctx.setLineDash([6 * sc, 4 * sc]); ctx.strokeStyle = col; ctx.lineWidth = 2.4 * sc; ctx.globalAlpha = A * 0.95;
        ctx.beginPath(); ctx.moveTo(P[0][0], G.yb); P.forEach(function (q) { ctx.lineTo(q[0], G.yb - (G.yb - q[1]) * g.k); }); ctx.lineTo(P[P.length - 1][0], G.yb); ctx.stroke();
        // the rest of that decision's own merit order, dashed and fainter, from the outline's top to the chart's end, so
        // the outline sits under its own curve (the cheap step that decision used up is visibly missing); it fades in at
        // its own height while the outline rises to meet it
        var e0 = P[P.length - 1], Q = [e0].concat(path(g.Rb, g.Rt, R + 1).filter(function (q) { return q[0] > e0[0] + 0.5; })), gs = X(g.Rb);
        ctx.lineWidth = 1.8 * sc; ctx.globalAlpha = A * 0.7;
        [[G.x0 - 8, gs, pal.s.poolCheap], [gs, G.x0 + G.W + 8, pal.s.poolDear]].forEach(function (s) {
          if (s[1] - s[0] < 0.2) return;
          ctx.save(); ctx.beginPath(); ctx.rect(s[0], top, s[1] - s[0], hgt); ctx.clip(); ctx.strokeStyle = s[2];
          ctx.beginPath(); Q.forEach(function (q, j) { if (j) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke();
          ctx.restore();
        });
        ctx.setLineDash([]);
      });
      // the activated energy, cheapest first, lit under the curve; its top and its right edge (the depth reached) crisp
      if (c.V > 0.5) {
        var F = path(c.Rb, c.Rt, c.V), e = F[F.length - 1];
        byGroup(function (col) { ctx.fillStyle = col; ctx.globalAlpha = a * (lit ? 0.58 : 0.62); under(F, 1); ctx.fill(); });
        byGroup(function (col) { ctx.strokeStyle = col; ctx.globalAlpha = a; ctx.lineWidth = 3.2 * sc; line(F); ctx.stroke(); });
        ctx.strokeStyle = c.V > c.Rb ? pal.s.poolDear : pal.s.poolCheap; ctx.lineWidth = 2.6 * sc; ctx.globalAlpha = a;
        ctx.beginPath(); ctx.moveTo(e[0], G.yb); ctx.lineTo(e[0], e[1]); ctx.stroke();
      }
      if (c.cols) drawCols(ctx, pal, c.cols, a, sc);
      ctx.globalAlpha = 1;
    }
    // the two cost columns on the chart's floor, one scale (no words, no numbers): the decision's (solid) and the
    // counterfactual's (dashed). At each column's foot the redispatch in the operator's ink, above it the balancing energy
    // of the same shortfall in its group's color (the chart's own fill and outline, as cost). The aware decision's ink
    // block is the taller, its colored block the much shorter, its column the lower: it pays more for redispatch, less for
    // balancing and less in all.
    function drawCols(ctx, pal, C, a, sc) {
      var G = M.meritG, K = MERIT.cols, cw = K.w * sc, gap = K.gap * sc, xr = G.x0 + G.W, xs = [xr - 2 * cw - gap, xr - cw], s2 = G.H * K.h / C.max;
      M.qaCols = { t: M.t, x: xs, w: cw, yb: G.yb, s: s2, dec: C.dec, cf: C.cf };
      var block = function (x, y0, hgt, col, dashed, k) {
        if (hgt < 0.3) return;
        ctx.save();
        if (dashed) {
          ctx.fillStyle = col; ctx.globalAlpha = a * k * 0.12; ctx.fillRect(x, y0 - hgt, cw, hgt);
          ctx.setLineDash([5 * sc, 3.5 * sc]); ctx.strokeStyle = col; ctx.lineWidth = 2 * sc; ctx.globalAlpha = a * k * 0.95;
          ctx.strokeRect(x, y0 - hgt, cw, hgt);
        } else {
          ctx.fillStyle = col; ctx.globalAlpha = a * (col === pal.s.ring ? 0.78 : (pal.s.beamBlend === 'lighter' ? 0.58 : 0.62)); ctx.fillRect(x, y0 - hgt, cw, hgt);
          ctx.strokeStyle = col; ctx.lineWidth = 1.6 * sc; ctx.globalAlpha = a; ctx.beginPath(); ctx.moveTo(x, y0 - hgt); ctx.lineTo(x + cw, y0 - hgt); ctx.stroke();
        }
        ctx.restore();
      };
      [[C.dec, xs[0], false], [C.cf, xs[1], true]].forEach(function (q) {
        var c = q[0];
        if (!c) return;
        var k = q[2] ? c.k : 1, h1 = c.rd * s2, h2 = c.bal * s2;
        block(q[1], G.yb, h1, pal.s.ring, q[2], k);
        block(q[1], G.yb - h1, h2, c.grp === 'dear' ? pal.s.poolDear : pal.s.poolCheap, q[2], k);
      });
    }
    // One redispatch pair (q: [age s, MW, dashed, alpha, units, scale, life]): an up arrow over the battery park and a down
    // arrow over the gas plant, equally long. Solid: drawn on in 0.35 s (the head snaps on at the end), held, faded over
    // the last 0.6 s. Dashed: the counterfactual. Drawn in the units' own hues (200 MW on the wide layout: 96 view units
    // long, 7.5 wide, a filled head 30 wide): the battery park's arrow in its teal-green, the gas plant's in the operator's
    // neutral ink (never red-orange); in dark both carry a soft glow, in light an underlay of the board's own tone cuts
    // them out of the model behind.
    function drawPair(ctx, pal, q) {
      if (!M.poolG) return;
      var age = q[0], dashed = q[2], sc = M.name === 'wide' ? 1 : 0.55, P = PAIR;
      var life = q[6] || P.life, grow = dashed ? 1 : smooth(age / P.draw), A = dashed ? q[3] : 1 - smooth((age - (life - P.fade)) / P.fade);
      if (A < 0.004) return;
      var L = (P.base + P.k * q[1]) * sc, w = (dashed ? P.wd : P.w) * sc, hw = P.hw * sc, hl = P.hl * sc, lit = pal.s.beamBlend === 'lighter';
      // q[4] lists the units and their MW (up +, down -); each arrow's length is proportional to its MW (PAIR6.k, or q[5]),
      // the battery park's in its teal-green, the gas units' in the operator's neutral ink. q[5] (the bid ladder story) is
      // its own scale (0.6 view units per MW): the battery park's arrow in poolCheapLine (3.6:1 on the board in light), the
      // station's on the cooling tower's axis with its foot above the tower's top, heads scaled down on short arrows, and
      // the counterfactual's dashed arrows all in the operator's neutral ink, so none reads as the chart's green
      var K7 = q[5] || 0;
      // with q[5] the station's solid arrow takes its bids' amber (bidBio) and the gas plant's its bids' plum-magenta
      // (bidGas), so each unit's move and its bids' change share a color; the dashed ones stay ink
      var k7col = function (u) { return u === 'bat' ? pal.s.poolCheapLine : u === 'bio' ? pal.s.bidBio || pal.s.ring : u === 'gen' ? pal.s.bidGas || pal.s.ring : pal.s.ring; };
      var units = q[4] ? q[4].filter(function (e) { return M.poolG[e[0]]; }).map(function (e) { return [e[0], e[1] > 0 ? -1 : 1, K7 && !dashed ? k7col(e[0]) : e[0] === 'bat' && !(K7 && dashed) ? pal.s.poolCheap : pal.s.ring, PAIR6.dx[e[0]] || 0, (K7 || PAIR6.k) * Math.abs(e[1]) * sc]; })
        : [['bat', -1, pal.s.poolCheap, P.dx.bat, L], ['gen', 1, pal.s.ring, P.dx.gen, L]];
      units.forEach(function (u) {
        var L = u[4], p = M.poolG[u[0]].unit, ft = K7 && M.poolG[u[0]].foot, x = ft ? ft[0] : p[0] + u[3] * sc, yNear = ft ? ft[1] : p[1] - P.gap * sc, yFar = yNear - L, dir = u[1];
        if (K7) { hl = Math.min(PAIR7.hl * sc, 0.5 * L); hw = Math.min(PAIR7.hw * sc, 0.5 * L); }
        (M.qaPair || (M.qaPair = {}))[u[0] + (dashed ? '-cf' : '')] = { t: M.t, x: x, y0: yNear, y1: yFar, L: L, w: w, hw: hw, col: u[2], dashed: dashed };   // for inspection: each arrow this frame
        var y0 = dir < 0 ? yNear : yFar, y1 = dir < 0 ? yFar : yNear, tip = lerp(y0, y1, grow), showHead = grow > 0.97;
        var base = tip - dir * hl;   // the head's base; the shaft ends there
        var shaft = function () { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, showHead ? base : tip); };
        var head = function () { ctx.beginPath(); ctx.moveTo(x - hw, base); ctx.lineTo(x, tip); ctx.lineTo(x + hw, base); ctx.closePath(); };
        ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
        // the underlay (board tone) and, in dark, the glow
        ctx.strokeStyle = ctx.fillStyle = pal.s.wall; ctx.globalAlpha = (dashed ? 0.45 : 0.75) * A; ctx.lineWidth = w + 6 * sc;
        shaft(); ctx.stroke(); if (showHead) { head(); ctx.lineWidth = 6 * sc; ctx.stroke(); ctx.fill(); }
        if (lit) {
          ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = ctx.fillStyle = u[2]; ctx.globalAlpha = (dashed ? 0.08 : 0.2) * A; ctx.lineWidth = w + 9 * sc;
          shaft(); ctx.stroke(); if (showHead) { head(); ctx.lineWidth = 9 * sc; ctx.stroke(); }
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.strokeStyle = ctx.fillStyle = u[2]; ctx.globalAlpha = (dashed ? 0.9 : 1) * A; ctx.lineWidth = w;
        if (dashed) ctx.setLineDash([10 * sc, 7 * sc]);
        shaft(); ctx.stroke(); ctx.setLineDash([]);
        if (showHead) { head(); if (dashed) { ctx.lineWidth = 2.6 * sc; ctx.lineJoin = 'round'; ctx.stroke(); } else ctx.fill(); }
      });
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 1;
    }
    // The veils (VEIL) of the fields without a sheet, each a bitmap in device pixels made once per layout, panel layout
    // and palette (nested fills in the board's own tone from the field's outline grown by VEIL.grow to the outline shrunk
    // by it, so the opacity rises from 0 to VEIL.a across the edge) and blitted each frame, dimmed with its field
    function drawVeils(ctx, frame, hl0, hl, kd) {
      var dpr = frame.dpr, key = M.cacheKey + '|' + M.pv + '|' + M.palVersion, list = [];
      if (M.veilKey !== key) { M.veils = {}; M.veilKey = key; }
      var fs = lerp(dimAlpha(hl0, 'renewables'), dimAlpha(hl, 'renewables'), kd);
      // under the switching hover's corridor light the source fields sink with the model, so their veils give way to the
      // sink; the line field stays lit, veil and all
      fs *= 1 - (M.isoLv || 0);
      (M.hyb || []).forEach(function (H) { list.push([H.obj.tech, H.F, H.T, fs]); });
      if (M.linePo) { var po = M.linePo, LF = fieldNow(po.panel); list.push(['line', LF, fieldTransform(LF), lerp(dimAlpha(hl0, po), dimAlpha(hl, po), kd)]); }
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
      list.forEach(function (v) {
        // a field whose VEIL.a is 0 has no veil (tested against null: || 0.4 would turn 0 into 0.4)
        var a = VEIL.a[v[0]] != null ? VEIL.a[v[0]] : 0.4;
        if (!(a > 0)) return;
        var c = M.veils[v[0]] || (M.veils[v[0]] = veilBitmap(v[1], v[2], dpr, a));
        if (c) { ctx.globalAlpha = v[3]; ctx.drawImage(c.cv, c.x, c.y); }
      });
      ctx.restore();
    }
    function veilBitmap(F, T, dpr, a) {
      var g = VEIL.grow, n = VEIL.steps, la = 1 - Math.pow(1 - a, 1 / n), s, k;
      var quad = function (k) { var mx = F.w * g * k, my = F.h * g * k; return [tp(T, -mx, -my), tp(T, F.w + mx, -my), tp(T, F.w + mx, F.h + my), tp(T, -mx, F.h + my)]; };
      var o = quad(1), xs = o.map(function (q) { return q[0]; }), ys = o.map(function (q) { return q[1]; });
      var x0 = Math.floor(dpr * Math.min.apply(null, xs)) - 2, y0 = Math.floor(dpr * Math.min.apply(null, ys)) - 2;
      var w = Math.ceil(dpr * Math.max.apply(null, xs)) + 2 - x0, h = Math.ceil(dpr * Math.max.apply(null, ys)) + 2 - y0;
      if (!(w > 0 && h > 0)) return null;
      var cv = d.createElement('canvas'); cv.width = w; cv.height = h;
      var c2 = cv.getContext('2d');
      c2.setTransform(dpr, 0, 0, dpr, -x0, -y0); c2.fillStyle = M.pal.s.wall; c2.globalAlpha = la;
      for (s = 0; s < n; s++) {
        k = 1 - 2 * s / (n - 1); var q = quad(k);
        c2.beginPath(); c2.moveTo(q[0][0], q[0][1]); c2.lineTo(q[1][0], q[1][1]); c2.lineTo(q[2][0], q[2][1]); c2.lineTo(q[3][0], q[3][1]); c2.closePath(); c2.fill();
      }
      return { cv: cv, x: x0, y: y0 };
    }
    function warmRgba(pal, a) { var c = hexRgb(pal.s.warm.charAt(0) === '#' ? pal.s.warm : '#ff9a6b'); return 'rgba(' + c.join(',') + ',' + a + ')'; }
    // The line field's furniture (no words): its floor (a lit rail without a sheet, the thin wall line on a sheet) and
    // the limit rail in the field's own light, where the field has no wall, so it reads as a threshold. While particles
    // are past the limit, the rail's lower part warms with their share and warm light leaks past the rail as a gradient
    // that fades before the right edge (html[data-wash] '0' keeps only the warm particles and the warm rail). When the
    // spine opens and the particles move back, the warm light drains.
    function drawLineFurniture(ctx, pal, hl0, hl, kd) {
      var po = M.linePo;
      if (!po) return;
      var F = fieldNow(po.panel), Mx = F.M, free = M.pv !== 'r4', H = F.h, lim = LINE_LIMIT() * F.w;
      var pt = function (lx, ly) { return [Mx[0] * lx + Mx[2] * ly + Mx[4], Mx[1] * lx + Mx[3] * ly + Mx[5]]; };
      var seg = function (a, b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
      var a0 = lerp(dimAlpha(hl0, po), dimAlpha(hl, po), kd), wk = Math.min(1, (M.lineShare || 0) / 0.12);
      a0 *= M.lnK == null ? 1 : M.lnK;   // the rail, the limit and the wash go out with the day's line field
      var blend = pal.s.edgeBlend === 'lighter' ? 'lighter' : 'source-over';
      ctx.setLineDash([]); ctx.lineCap = 'butt';
      if (wk > 0.01 && html.getAttribute('data-wash') !== '0') {
        var g0 = pt(lim, 0), g1 = pt(F.w, 0), g2 = pt(F.w, H), g3 = pt(lim, H), gf = pt(lim + 0.6 * (F.w - lim), H);
        var gr = ctx.createLinearGradient(g3[0], g3[1], gf[0], gf[1]);
        gr.addColorStop(0, warmRgba(pal, 1)); gr.addColorStop(1, warmRgba(pal, 0));
        ctx.globalCompositeOperation = blend; ctx.globalAlpha = a0 * (blend === 'lighter' ? 0.22 : 0.16) * wk; ctx.fillStyle = gr;
        ctx.beginPath(); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(g1[0], g1[1]); ctx.lineTo(g2[0], g2[1]); ctx.lineTo(g3[0], g3[1]); ctx.closePath(); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      seg(pt(0, H), pt(F.w, H));
      if (free) { railStroke(ctx, pal, a0, 1, 1); }
      else { ctx.globalAlpha = a0; ctx.strokeStyle = pal.s.wallLine; ctx.lineWidth = 0.8; ctx.stroke(); }
      if (wk > 0.01) {
        seg(pt(lim, H), pt(lim, H * (1 - 0.86 * wk)));
        ctx.globalCompositeOperation = blend; ctx.globalAlpha = a0 * 0.35 * wk; ctx.strokeStyle = pal.s.warm; ctx.lineWidth = 4.5; ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
      seg(pt(lim, H), pt(lim, 0));
      ctx.globalAlpha = a0 * 0.95; ctx.strokeStyle = pal.s.limit; ctx.lineWidth = 1.25; ctx.stroke();   // ends at the floor
      ctx.globalAlpha = 1;
    }
    // a lit rail (the layouts without a sheet): a soft wide stroke under a crisp one, no shadowBlur per frame. The
    // current path; widths in the context's units times w (1 in view units, the map scale in CSS px)
    function railStroke(ctx, pal, a, lit, w) {
      ctx.strokeStyle = pal.s.rail;
      ctx.lineWidth = 4 * w; ctx.globalAlpha = a * lit * 0.16; ctx.stroke();
      ctx.lineWidth = 1.4 * w; ctx.globalAlpha = a * lit * 0.95; ctx.stroke();
    }

    // The hybrid view: per source panel, its positions at time t, clipped to its field (a little inflated for the drift):
    // the bounds, the edge light where particles press on a bound, then the dots (the outer ranks fainter). Reduced
    // motion: the fans of the first day without drift (t = 0).
    // CPU: the resting panels keep their edge light and dots in a bitmap, redrawn four times a second (their drift moves
    // a dot by less than 0.2 px in that time) and blitted each frame; the bounds are stroked every frame on the scene's
    // canvas. The scene runs at 15 frames/s at rest and at HYB_FPS while a panel moves; with the periodic timetable
    // (M.sched.p8, HYB8), where a panel moves most of the time, a panel in a fold, turn, rise or fall (or their way back)
    // runs it at HYB_FPS8 and a day wave alone at the rest rate, 15 (its front sweeps the day in 2.2 s; the moving panel
    // is still drawn afresh every frame)
    var EDGE_LV = 6, HYB_CACHE_DT = 0.25, HYB_FPS = 24, HYB_FPS8 = 20;
    // the scene time nearest to t at which a panel rests (its day, its distribution or the cloud): t itself when it
    // rests, else the nearer end of the move it is in (searched in 0.05 s steps, back and forward together)
    function hybRestNear(tech, side, t) {
      var mv = function (x) { return hybMoving(M.sched.phase(tech, x), side); }, dt;
      if (!mv(t)) return t;
      for (dt = 0.05; dt < 12; dt += 0.05) {
        if (t - dt >= 0 && !mv(t - dt)) return t - dt;
        if (!mv(t + dt)) return t + dt;
      }
      return t;
    }
    function tp(T, x, y) { return [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]]; }
    function drawHybrid(ctx, frame, still, hl0, hl, kd) {
      if (!M.hyb || !M.hyb.length) return;
      var T0 = M.selfTiming ? global.performance.now() : 0;   // profiling: M.selfTiming = { ms: 0, n: 0 } times this function
      var pal = M.pal, t = still ? 0 : frame.time / 1000, drift = still ? 0 : PARTICLES[M.name].drift, dpr = frame.dpr;
      // with the story's holdSrc the source panels hold the moment the story began while it plays (so the solar panel's day
      // wave does not read as the cause of the shortfall); their clock runs on, so they rejoin it as the model rises after
      // the hover. A panel caught in a move holds the nearer of the two shapes it rests in around that moment (M.srcHoldTj,
      // per panel), so the story never freezes a half-made shape; the first frame of the hover is a cut anyway (instant).
      // M.srcHoldT stays the hover's moment
      var hold = !still && M.story && M.story.def.holdSrc;
      if (hold) { if (M.srcHoldT == null) { M.srcHoldT = t; M.srcHoldTj = {}; } t = M.srcHoldT; } else { M.srcHoldT = null; M.srcHoldTj = null; }
      var dd = dotDim('src'), s = M.map.s, moving = false, big = false;
      var fa = lerp(dimAlpha(hl0, 'renewables'), dimAlpha(hl, 'renewables'), kd), free = M.pv !== 'r4', j;
      fa *= lerp(1, SWX.SINK.dots, M.isoLv || 0);   // the source panels' bounds sink with the model in the corridor light
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (j = 0; j < M.hyb.length; j++) {
        var Hh = M.hyb[j], o = Hh.obj, T = Hh.T, F = o.F;
        if (hold) { if (M.srcHoldTj[o.tech] == null) M.srcHoldTj[o.tech] = hybRestNear(o.tech, o.side, M.srcHoldT); t = M.srcHoldTj[o.tech]; }
        var P = M.sched.phase(o.tech, t);
        var mv = !still && !hold && (hybMoving(P, o.side) || hybMoving(M.sched.phase(o.tech, t + 0.16), o.side));
        moving = moving || mv;
        if (mv) big = big || hybLarge(P, o.side) || hybLarge(M.sched.phase(o.tech, t + 0.16), o.side);
        if (mv || still) {
          o.compute(t, drift, M.sched); hybToCss(o, T);
          var mg = 0.05 * F.h, c0 = tp(T, -mg, -mg), c1 = tp(T, F.w + mg, -mg), c2 = tp(T, F.w + mg, F.h + mg), c3 = tp(T, -mg, F.h + mg);
          ctx.save();
          ctx.beginPath(); ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]); ctx.closePath(); ctx.clip();
          drawBounds(ctx, o, T, pal, free, fa, s);
          hybDots(ctx, o, T, pal, fa, dd, s);
          ctx.restore();
          Hh.key = null;
          continue;
        }
        var key = M.cacheKey + '|' + M.pv + '|' + P.seg + P.day + (o.side ? 's' : '');
        // a held panel's time does not move, so its bitmap is also redrawn when its transform changes (the camera)
        var mk = hold ? T.join('|') : '';   // the panel's own transform (it follows the map a frame later)
        if (Hh.key !== key || (hold && Hh.mk !== mk) || !(t >= Hh.ct && t - Hh.ct < HYB_CACHE_DT)) { o.compute(t, drift, M.sched); hybToCss(o, T); hybCache(Hh, o, T, pal, s, dpr); Hh.key = key; Hh.ct = t; Hh.mk = mk; }
        drawBounds(ctx, o, T, pal, free, fa, s);
        if (Hh.cv) {
          ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = pal.dot.blend; ctx.globalAlpha = dd; ctx.drawImage(Hh.cv, Hh.cx, Hh.cy);
          ctx.restore();
        }
      }
      ctx.restore();
      M.hybMoving = moving; M.hybBig = big;
      if (M.hook && M.dim.done) M.hook.opts.restFps = moving ? (M.sched.p8 ? (big ? HYB_FPS8 : 15) : HYB_FPS) : 15;
      if (M.selfTiming) { M.selfTiming.ms += global.performance.now() - T0; M.selfTiming.n++; }
    }
    function hybToCss(o, T) {
      var LX = o.LX, LY = o.LY, X = o.X, Y = o.Y, i;
      for (i = 0; i < o.n; i++) { X[i] = T[0] * LX[i] + T[2] * LY[i] + T[4]; Y[i] = T[1] * LX[i] + T[3] * LY[i] + T[5]; }
    }
    // the edge light and the dots of one panel (ea: the edge light's alpha, da: the dots' dimming)
    function hybDots(ctx, o, T, pal, ea, da, s) {
      var p = pal.dot, tail = parseFloat(pal.s.tailA) || 0.36, sq = square(), r = M.dotR;
      edgeLight(ctx, o, T, pal, ea, s);
      ctx.globalCompositeOperation = p.blend;
      dotsIdx(ctx, o.X, o.Y, o.tailIdx, r, p.color, p.alpha * da * tail, sq);
      dotsIdx(ctx, o.X, o.Y, o.coreIdx, r, p.color, p.alpha * da, sq);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
    // a resting panel's bitmap: its field's box (with the clip's margin) in device pixels, at whole-pixel offsets so
    // the blit is not resampled; drawn at full strength (the theme dimming is applied when it is blitted)
    function hybCache(Hh, o, T, pal, s, dpr) {
      var F = o.F, mg = 0.05 * F.h, c = [tp(T, -mg, -mg), tp(T, F.w + mg, -mg), tp(T, F.w + mg, F.h + mg), tp(T, -mg, F.h + mg)];
      var xs = c.map(function (q) { return q[0]; }), ys = c.map(function (q) { return q[1]; });
      var x0 = Math.floor(dpr * Math.min.apply(null, xs)) - 2, y0 = Math.floor(dpr * Math.min.apply(null, ys)) - 2;
      var w = Math.ceil(dpr * Math.max.apply(null, xs)) + 2 - x0, h = Math.ceil(dpr * Math.max.apply(null, ys)) + 2 - y0;
      var cv = Hh.cv || (Hh.cv = d.createElement('canvas'));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      var g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h);
      g.setTransform(dpr, 0, 0, dpr, -x0, -y0);
      hybDots(g, o, T, pal, 1, 1, s);
      Hh.cx = x0; Hh.cy = y0;
    }
    // dots of the listed particles at canvas px X[i], Y[i]: one path, one fill
    function dotsIdx(ctx, X, Y, idx, r, color, alpha, sq) {
      var k, i, x, y, d2 = 2 * r;
      ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath();
      for (k = 0; k < idx.length; k++) { i = idx[k]; x = X[i]; y = Y[i]; if (sq) ctx.rect(x - r, y - r, d2, d2); else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); } }
      ctx.fill(); ctx.globalAlpha = 1;
    }
    // the bounds: on a sheet the thin wall line; without a sheet the no-output bound (and the stack's base, which
    // becomes the floor) as a lit rail, the full-output bound fine
    function drawBounds(ctx, o, T, pal, free, fa, s) {
      ctx.lineCap = 'butt';
      for (var k = 0; k < o.segs.length; k++) {
        var sg = o.segs[k], al = sg.alpha == null ? 1 : sg.alpha;
        if (al < 0.01) continue;
        var A = tp(T, sg.a[0], sg.a[1]), B = tp(T, sg.b[0], sg.b[1]);
        ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]);
        if (!free) { ctx.strokeStyle = pal.s.wallLine; ctx.lineWidth = 0.9 * s; ctx.globalAlpha = fa * al; ctx.stroke(); }
        else if (sg.m === 1) { ctx.strokeStyle = pal.s.rail; ctx.lineWidth = 0.8 * s; ctx.globalAlpha = fa * al * 0.55; ctx.stroke(); }
        else railStroke(ctx, pal, fa * al, sg.m === 2 ? 0.8 : 1, s);
      }
      ctx.globalAlpha = 1;
    }
    // The edge light: where particles sit exactly on a bound (outcome exactly no output or full output: the atoms
    // of the engine's data, solar at night), that stretch of the bound glows, brighter with more particles (40
    // cells per bound, from the particles of this frame). Cells are batched into a few brightness levels.
    function edgeLight(ctx, o, T, pal, fa, s) {
      var n = o.n, C = HYB.cells, segs = o.segs, i, j, lv;
      var cnt = o.cnt || (o.cnt = [new Float32Array(C), new Float32Array(C)]);
      cnt[0].fill(0); cnt[1].fill(0);
      var ax = [], ay = [], l2 = [];
      for (j = 0; j < 2; j++) { ax[j] = segs[j].b[0] - segs[j].a[0]; ay[j] = segs[j].b[1] - segs[j].a[1]; l2[j] = ax[j] * ax[j] + ay[j] * ay[j] || 1; }
      var any = false;
      for (i = 0; i < n; i++) {
        var v = o.O[i], m = v <= 0.0045 ? 0 : v >= 0.9955 ? 1 : -1;
        if (m < 0) continue;
        var q = ((o.LX[i] - segs[m].a[0]) * ax[m] + (o.LY[i] - segs[m].a[1]) * ay[m]) / l2[m];
        if (q < -0.02 || q > 1.02) continue;
        cnt[m][Math.min(C - 1, Math.max(0, Math.floor(q * C)))]++; any = true;
      }
      if (!any) return;
      var cap = Math.max(3, 0.5 * n / C), paths = [];
      for (j = 0; j < 2; j++) {
        var sg = segs[j];
        for (i = 0; i < C; i++) {
          if (!cnt[j][i]) continue;
          lv = Math.max(1, Math.ceil(Math.min(1, cnt[j][i] / cap) * EDGE_LV));
          var A = tp(T, lerp(sg.a[0], sg.b[0], i / C), lerp(sg.a[1], sg.b[1], i / C)), B = tp(T, lerp(sg.a[0], sg.b[0], (i + 1) / C), lerp(sg.a[1], sg.b[1], (i + 1) / C));
          var pth = paths[lv] || (paths[lv] = new global.Path2D());
          pth.moveTo(A[0], A[1]); pth.lineTo(B[0], B[1]);
        }
      }
      ctx.globalCompositeOperation = pal.s.edgeBlend === 'lighter' ? 'lighter' : 'source-over';
      ctx.strokeStyle = pal.s.edgeLight; ctx.lineCap = 'round';
      for (var pass = 0; pass < 2; pass++) {
        ctx.lineWidth = (pass ? 1.6 : 5.5) * s;
        for (lv = 1; lv <= EDGE_LV; lv++) {
          if (!paths[lv]) continue;
          ctx.globalAlpha = fa * (pass ? 0.85 : 0.28) * lv / EDGE_LV;
          ctx.stroke(paths[lv]);
        }
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
    function drawRotor(ctx, o, t, pal, c) {
      var bl = rotorBlades(o, t);
      for (var i = 0; i < 3; i++) {
        var q = bl[i].p, s0 = c.p(q[0]);
        ctx.beginPath(); ctx.moveTo(s0[0], s0[1]);
        for (var j = 1; j < q.length; j++) { var s = c.p(q[j]); ctx.lineTo(s[0], s[1]); }
        ctx.closePath();
        ctx.fillStyle = pal.t.cd[level(intensity(bl[i].n, LIGHT) * o.fall)];
        ctx.fill();
      }
      var hc = c.p(add(o.rotor.hub, mul(o.rotor.n, 1))), hr = o.rotor.R * 0.055 * c.f / hc[2];
      ctx.beginPath(); ctx.arc(hc[0], hc[1], hr, 0, TAU); ctx.fillStyle = pal.t.cd[13]; ctx.fill();
    }
    // the trackers' angle in and after the HVDC day (null: the hero's sweep). 'hold' (DAYX.trkMode): a fresh day runs the
    // hero's sweep on a clock that slows to a stop over DAYX.trk (tau = h before trk[0], then trk[0] + trk[1] x (x - x^3
    // + x^4 / 2), at most trk[0] + trk[1] / 2: the smoothstep's own slowing, so they never turn back) and holds that angle
    // (M.trHoldA); otherwise (leaving, or a day begun while they still return) the held angle eases into the hero's sweep
    // by trK. 'flat': eased to flat by trK. M.qaTrMode, if set, overrides DAYX.trkMode
    function dayTrackerA(t) {
      if ((M.qaTrMode || DAYX.trkMode) === 'flat') return M.trK > 0 ? lerp(trackerAngle(t), 0, M.trK) : null;
      if (M.trDay && M.trFresh) {
        var T = DAYX.trk, x = clamp((M.trH - T[0]) / T[1], 0, 1), x3 = x * x * x, tau = Math.min(M.trH, T[0]) + T[1] * (x - x3 + 0.5 * x3 * x);
        M.trHoldA = trackerAngle(M.trT0 + tau);
        return M.trHoldA;
      }
      return M.trK > 0 && M.trHoldA != null ? lerp(trackerAngle(t), M.trHoldA, M.trK) : null;
    }
    function drawTrackers(ctx, o, t, pal, c) {
      // in the HVDC day the trackers' angle is dayTrackerA's (M.trAng; null: the hero's sweep)
      var aT = M.trAng == null ? null : M.trAng;
      M.qaTrA = aT == null ? trackerAngle(t) : aT;
      var qs = trackerQuads(o, t, c, aT);
      for (var i = 0; i < qs.length; i++) {
        var q = qs[i], sp = q.p.map(function (p) { return c.p(p); });
        ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]); ctx.lineTo(sp[1][0], sp[1][1]); ctx.lineTo(sp[2][0], sp[2][1]); ctx.lineTo(sp[3][0], sp[3][1]); ctx.closePath();
        ctx.fillStyle = pal.t.pv[level(intensity(q.n, LIGHT) * q.fall)]; ctx.fill();
        if (q.spec > GLINT.min) { var a0 = ctx.globalAlpha; ctx.globalAlpha = a0 * Math.min(1, q.spec * 1.4) * (parseFloat(pal.s.glintA) || 0.85) * GLINT.a; ctx.fillStyle = pal.s.glint; ctx.fill(); ctx.globalAlpha = a0; }
      }
      // the module grid of every segment in one stroke (faint lines; the segments of a row hardly overlap)
      ctx.beginPath();
      for (var k = 0; k < qs.length; k++) {
        var gl = pvGrid(qs[k].p);
        for (var j = 0; j < gl.length; j++) { var g0 = c.p(gl[j][0]), g1 = c.p(gl[j][1]); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(g1[0], g1[1]); }
      }
      ctx.strokeStyle = pal.s.pvGrid; ctx.lineWidth = 0.35; ctx.stroke();
    }
    // the meters: the hero's closed loop (batteryLevel), a story's set-point from where they were (storyBattery), or the
    // decided state's level when still or paused
    function batteryAt(t, i) {
      var b = M.state.bat;
      if (M.stillNow) return BAT.still;
      var base = batteryLevel(t, i);
      if (!b.mode && !b.off) return base;
      if (b.mode) return b.lv ? b.lv[i] : base;
      return b.off ? clamp(base + b.off[i], 0.12, 0.92) : base;
    }
    function batteryDir() { var mw = M.shownP.battery || 0; return Math.abs(mw) < 5 ? 0 : -Math.sign(mw); }
    function drawBattery(ctx, o, t, pal, c) {
      var still = M.stillNow, a0 = ctx.globalAlpha, dir = still || (M.story && M.story.def.day) ? 0 : batteryDir(), glow = parseFloat(pal.s.nightGlow) || 0;   // the day holds the meters
      var quad = function (b, xa, xb) {
        var a = c.p([xa, b.y0, b.z]), b2 = c.p([xb, b.y0, b.z]), e = c.p([xb, b.y1, b.z]), f = c.p([xa, b.y1, b.z]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(e[0], e[1]); ctx.lineTo(f[0], f[1]); ctx.closePath();
        return [a, b2];
      };
      for (var i = 0; i < o.bars.length; i++) {
        var bar = o.bars[i], lv = batteryAt(t, i), xm = lerp(bar.x0, bar.x1, lv);
        quad(bar, bar.x0, bar.x1); ctx.fillStyle = pal.s.chargeTrack; ctx.fill();
        var ends = quad(bar, bar.x0, xm);
        if (glow > 0) { ctx.save(); ctx.shadowColor = pal.s.charge; ctx.shadowBlur = 3 * (M.map.s || 1); ctx.fillStyle = pal.s.charge; ctx.fill(); ctx.restore(); }
        else { ctx.fillStyle = pal.s.charge; ctx.fill(); }
        if (dir && xm - bar.x0 > 1) {
          // the highlight: a soft band a third of the fill wide, 2.4 s per pass, clipped to the fill
          var u = (((t / 2.4) + i * 0.23) % 1 + 1) % 1, pos = dir > 0 ? u : 1 - u;
          var gx0 = lerp(ends[0][0], ends[1][0], pos - 0.35), gx1 = lerp(ends[0][0], ends[1][0], pos + 0.35);
          var gy = (ends[0][1] + ends[1][1]) / 2, gr = ctx.createLinearGradient(gx0, gy, gx1, gy);
          gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, pal.s.chargeHi); gr.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.globalAlpha = a0 * 0.55; ctx.fillStyle = gr; ctx.fill(); ctx.globalAlpha = a0;
        }
      }
    }
    // The stacks' vapor trace: soft white puffs drifting back with the wind, their strength
    // the plant's output share (thermal MW / 850) in the shown state, eased over 2.5 s. Never at full
    // opacity, never gray-brown. Reduced motion: one static trace. Not in the no-JS still.
    var PLUME = { n: 8, period: 11, rise: 30, drift: 46, a: 0.62, tau: 2.5, cap: 850 };
    function drawVapour(ctx, t, dt, pal, still, cam) {
      var st = (M.S.fx && M.S.fx.stacks) || [];
      if (!st.length) return;
      var target = clamp((M.shownP.thermal || 0) / PLUME.cap, 0, 1);
      if (M.state.plume == null || still) M.state.plume = target;
      else M.state.plume += (target - M.state.plume) * (1 - Math.exp(-dt / PLUME.tau));
      // a stack of another element (the biomass power station's cooling tower) has its own level, eased the same
      // way toward its shown MW / cap, times its a; a gated stack draws only while html[data-bal] opens its gate
      var lvE = M.state.plumeEl || (M.state.plumeEl = {}), gateOpen = html.getAttribute('data-bal');
      st.forEach(function (q) {
        if (!q.el) return;
        var tg = q.gate && q.gate !== gateOpen ? 0 : clamp((M.shownP[q.el] || 0) / q.cap, 0, 1);
        if (lvE[q.el] == null || still) lvE[q.el] = tg; else lvE[q.el] += (tg - lvE[q.el]) * (1 - Math.exp(-dt / PLUME.tau));
      });
      M.qaPlume = { t: M.t, thermal: M.state.plume, el: Object.assign({}, lvE) };
      var share = M.state.plume, base = (parseFloat(pal.s.plumeA) || 0.5) * PLUME.a, a0 = ctx.globalAlpha, tt = still ? 0 : t, made = false;
      for (var s = 0; s < st.length; s++) {
        var S0 = st[s];
        if (S0.gate && S0.gate !== gateOpen) continue;
        // an element's stack may carry its own strength in the light theme (aA), so the station's plume reads there
        var A = S0.el ? base * lvE[S0.el] * (S0.aA != null && !(parseFloat(pal.s.nightGlow) || 0) ? S0.aA : S0.a == null ? 1 : S0.a) : base * share;
        if (A < 0.004) continue;
        if (!made) { if (!M.puff || M.puffKey !== pal.s.plume + pal.s.nightGlow) makePuff(pal); made = true; }
        for (var j = 0; j < PLUME.n; j++) {
          var u = (j + (((tt / PLUME.period) + S0.phase) % 1)) / PLUME.n;
          var p = add(S0.top, [0.16 * u * PLUME.drift + 2.5 * Math.sin(u * 5 + s), 4 + u * PLUME.rise, u * PLUME.drift]);
          var q = cam.p(p), r = S0.r * (0.85 + u * 2.4) * cam.f / q[2] * 1.7;
          var a = A * Math.min(1, u * 5) * Math.pow(1 - u, 1.4);
          if (a < 0.004) continue;
          ctx.globalAlpha = a0 * a;
          ctx.drawImage(S0.rim && M.puffR ? M.puffR : M.puff, q[0] - r, q[1] - r, 2 * r, 2 * r);
        }
      }
      ctx.globalAlpha = a0;
    }
    function makePuff(pal) {
      var cv = d.createElement('canvas'), N = 48; cv.width = cv.height = N;
      var g = cv.getContext('2d'), c = hexRgb(pal.s.plume.charAt(0) === '#' ? pal.s.plume : '#f0f3f6'), rgb = c.join(',');
      var gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
      gr.addColorStop(0, 'rgba(' + rgb + ',1)'); gr.addColorStop(0.45, 'rgba(' + rgb + ',0.7)');
      // the light theme: a faint cool rim, so white vapor reads on a white model
      if ((parseFloat(pal.s.nightGlow) || 0) === 0) { gr.addColorStop(0.72, 'rgba(120,132,146,0.22)'); gr.addColorStop(1, 'rgba(120,132,146,0)'); }
      else gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr; g.fillRect(0, 0, N, N);
      M.puff = cv; M.puffKey = pal.s.plume + pal.s.nightGlow;
      // light theme only: a second puff for a stack with rim (the biomass station's cooling tower), a firmer cool rim, so
      // its white vapor reads against the white tower and the pale board behind it
      M.puffR = null;
      if ((parseFloat(pal.s.nightGlow) || 0) === 0) {
        var cr = d.createElement('canvas'); cr.width = cr.height = N;
        var g2 = cr.getContext('2d'), gq = g2.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
        gq.addColorStop(0, 'rgba(' + rgb + ',1)'); gq.addColorStop(0.4, 'rgba(' + rgb + ',0.75)'); gq.addColorStop(0.66, 'rgba(120,132,146,0.42)'); gq.addColorStop(1, 'rgba(120,132,146,0)');
        g2.fillStyle = gq; g2.fillRect(0, 0, N, N); M.puffR = cr;
      }
    }
    // the spine's line disconnector blades
    function drawBlade(ctx, o, op, t, pal, c) {
      ctx.strokeStyle = pal.s.ink; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.beginPath();
      o.blades.forEach(function (bl) { var a = c.p(bl.pivot), b = c.p(bladeTip(bl, op)); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke();
    }
    function beamsSetup() {
      M.beams = new Beams(M.S.lanes, html.getAttribute('data-beam') === 'current' ? 'current' : 'stream');
      M.beams.dcMode(html.getAttribute('data-dc'));   // the DC light's mode (html[data-dc])
      M.beams.palette(M.pal.s);
      beamsLayout();
    }
    // the light dims behind a panel: the acrylic sheets and, without a sheet, the fields of the dots
    function beamsLayout() {
      if (!M.beams || !M.map) return;
      var covers, behind;
      if (M.pv === 'r4') { covers = M.panels.map(function (po) { return po.panel.spFront; }); behind = 0.25; }
      else {
        // the line field stands over half of DC-1's land cable (46-56 % of each conductor); behind it
        // the HVDC links keep their full light, so DC-1's drift form is not muted there (the field has no veil either)
        covers = M.panels.map(function (po) { var F = fieldNow(po.panel), T = F.M; var ring = [[0, 0], [F.w, 0], [F.w, F.h], [0, F.h]].map(function (q) { return [T[0] * q[0] + T[2] * q[1] + T[4], T[1] * q[0] + T[3] * q[1] + T[5]]; }); return po.panel.tech === 'line' && BEAM_EX.line ? { ring: ring, ex: BEAM_EX.line } : ring; });
        behind = 0.45;
      }
      var faces = [];
      M.S.objs.forEach(function (o) { if (/^conv-/.test(o.id)) (o.pf || []).forEach(function (f) { faces.push(f.sp); }); });
      // the open gate (html[data-bal] 'b6' or 'b7') decides whether the gas-engine plant or the biomass station hides
      // light behind it
      var bal = html.getAttribute('data-bal'), gate = bal === 'b6' || bal === 'b7' ? bal : '';
      M.beams.layout(M.map, covers, behind, { re: /^(dc[12]-|ac-export-)/, faces: faces }, gate);
    }
    function buildCaches(dpr) {
      var m = M.map;
      M.list.forEach(function (it) {
        var o = it.o;
        if (o.kind === 'trackers' || o.kind === 'battery' || o.kind === 'breaker') { it.cv = null; return; }
        var bb = o.kind === 'turbine' ? bbOfPts([].concat.apply([], o.pf.map(function (f) { return f.sp; }))) : (o.kind === 'panel' ? bbOfPts(o.panel.spFront.concat([].concat.apply([], o.pf.map(function (f) { return f.sp; })))) : o.bb);
        if (!bb) { it.cv = null; return; }
        var x0 = Math.floor(dpr * (m.s * bb[0] + m.ox)) - 3, y0 = Math.floor(dpr * (m.s * bb[1] + m.oy)) - 3;
        var x1 = Math.ceil(dpr * (m.s * bb[2] + m.ox)) + 3, y1 = Math.ceil(dpr * (m.s * bb[3] + m.oy)) + 3;
        var cv = it.cv || d.createElement('canvas');
        cv.width = Math.max(1, x1 - x0); cv.height = Math.max(1, y1 - y0);
        var g = cv.getContext('2d');
        g.setTransform(dpr * m.s, 0, 0, dpr * m.s, dpr * m.ox - x0, dpr * m.oy - y0);
        g.lineJoin = 'round'; g.lineCap = 'round';
        if (o.kind === 'panel') drawPanel(g, o, M.pal); else drawOps(g, it.ops, M.pal, M.loadTier);
        it.cv = cv; it.cx = x0; it.cy = y0;
      });
    }
    function drawPanel(ctx, o, pal) {
      var P = o.panel, a0 = ctx.globalAlpha;
      if (!o.__face) { o.__face = p2d(P.spFront, true); o.__edges = o.pf.map(function (f) { return { p: p2d(f.sp, true), k: f.k }; }); o.__bb = bbOfPts(P.spFront); }
      var glow = parseFloat(pal.s.glow) || 0;
      if (glow > 0) { ctx.save(); ctx.shadowColor = pal.s.acEdge; ctx.shadowBlur = 10 * (M.map.s || 1); ctx.globalAlpha = a0 * glow * 0.5; ctx.strokeStyle = pal.s.acEdge; ctx.lineWidth = 1.4; ctx.stroke(o.__face); ctx.restore(); }
      o.__edges.forEach(function (e) { ctx.fillStyle = ctx.strokeStyle = pal.t.ac[e.k]; ctx.lineWidth = 0.45; ctx.fill(e.p); ctx.stroke(e.p); });
      ctx.fillStyle = pal.s.acFace; ctx.fill(o.__face);
      ctx.fillStyle = pal.s.acTint; ctx.fill(o.__face);
      var bb = o.__bb, gr = ctx.createLinearGradient(bb[0], bb[1], bb[2], bb[3]);
      pal.sheen.forEach(function (s) { gr.addColorStop(s[0], 'rgba(255,255,255,' + (s[1] * 0.9) + ')'); });
      ctx.fillStyle = gr; ctx.fill(o.__face);
      ctx.globalAlpha = a0 * 0.8; ctx.strokeStyle = pal.s.acEdge; ctx.lineWidth = 0.8; ctx.stroke(o.__face); ctx.globalAlpha = a0;
      ctx.strokeStyle = pal.s.acHi; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(P.spHi[0][0], P.spHi[0][1]); ctx.lineTo(P.spHi[1][0], P.spHi[1][1]); ctx.stroke();
    }
    function drawLamps(ctx, t, pal, hl0, hl, kd) {
      // with a DC light mode set (dcModeOf of html[data-dc], 'pair' by default) or under reduced motion the converter
      // stations' status lamps are steady. Each lamp dims with its own theme (the HVDC theme for both links), so all
      // brighten with the HVDC hover
      var lv = mqReduce.matches || dcModeOf(html.getAttribute('data-dc')) ? 1 : lampLevel(t);
      M.lamps.forEach(function (q, i) {
        var th = M.lampTh ? M.lampTh[i] : 'hvdc', a0 = lerp(dimAlpha(hl0, th), dimAlpha(hl, th), kd), boost = M.hl === 'hvdc' && th ? 1.4 : 1;
        var halo = parseFloat(pal.s.lampHalo) || 0;
        ctx.fillStyle = pal.s.lamp;
        if (halo > 0) { ctx.globalAlpha = a0 * halo * (0.4 + 0.6 * lv) * boost; ctx.beginPath(); ctx.arc(q[0], q[1], 4.2, 0, TAU); ctx.fill(); }
        ctx.globalAlpha = a0 * Math.min(1, (0.35 + 0.6 * lv) * (halo > 0 ? 1 : boost)); ctx.beginPath(); ctx.arc(q[0], q[1], halo > 0 ? 1.8 : 1.4, 0, TAU); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    // ── highlights from the themes (the switching, balancing and HVDC themes play their stories) ──
    function setHighlight(th) {
      if (th === M.hl || !M.S) return;
      var t = M.t || 0, running = !!(M.hook && M.hook.isRunning()) && !mqReduce.matches;
      // the HVDC hover plays its day unless hvMode() (html[data-hv]) holds the hero instead
      var hvS = th === 'hvdc' && hvMode() === 'day', story = th === 'switching' || th === 'balancing' || hvS;
      if (story || M.story) snapshot(t, hvS ? DAYX.entry[1] : story ? 0.8 : 0.6);
      // the day's entry is the snapshot crossfade, started DAYX.entry[0] s late (after the overload red has gone)
      if (hvS && M.xf) M.xf.t0 = t + DAYX.entry[0];
      // the HVDC hover without its day holds the hero (frameView); leaving it crossfades back to the hero's clock, quiet
      // for 1.0 s (no breaker light while a held spine's blades swing back, 0.8 s)
      if (M.heroHold && th !== 'hvdc') { if (!story) { snapshot(t, 0.6); M.quietUntil = Math.max(M.quietUntil || 0, t + 1.0); } M.heroHold = null; }
      if (th === 'hvdc' && !story) M.heroHold = { t: t };
      // a change from a story with a sink to another story starts the new sink from the level shown and crossfades the two
      // keep sets (drawSinkFrom), so the model never flashes back to full light for a frame
      var sink0 = running && (M.isoLv || 0) > 0.004 && M.sinkSet && story ? { lv: M.isoLv, set: M.sinkSet, units: M.isoU || 0,
        dip: M.sinkDip || 0 } : null;   // the cover's own dip
      if (story) {
        // switching in mode 's3': if the hero has not switched yet the event comes at 1.2 s; after the switch the model first
        // returns quietly to the market schedule and the event comes at 2.0 s
        var H = heroAt(t), before = !M.sw.brk && (H.tt < SCHED.events[0].open || H.tt >= HERO.keys[HERO.keys.length - 1][0]);
        // the modes push, isolate and pushloop (html[data-sw]) start from the schedule at once and open the spine at 1.1 s
        var mode = th === 'switching' ? swMode() : null;
        // html[data-bal] picks the balancing story (balStory)
        // the HVDC day starts from the spine and the line field's state as shown
        M.story = { def: th === 'switching' ? (mode !== 's3' ? switchStoryR6(mode) : switchStory(M.story || !before ? 2.0 : 1.2)) : hvS ? dayStory(!!M.sw.brk, (M.applied.line || 'line-market').replace(/^line-/, '')) : balStory(), t0: t };
        if (sink0) M.story.sink0 = sink0;   // handed over by drawSinkFrom
        if (th === 'balancing') M.balSink = !!M.story.def.sink;   // no flat dim under the balancing sink
        M.state.bat.mw = null;
      } else if (M.story) {
        // the hero resumes on its own clock after a 0.6 s crossfade; its events in that time are skipped
        // leaving the HVDC day, the hero's spine (open half the time) comes back in the first frame with its blades at once,
        // under the sink (no swing over the lifting sink; frameView's hero branch, cleared after switchTick)
        if (M.story.def.r6 && M.story.def.r6.mode === 'day') M.swSnap = true;
        M.story = null; M.quietUntil = t + 0.6; leaveBattery(t);
      }
      var prevHl = M.hl;
      M.hl = th;
      M.hlT0 = t;
      root.setAttribute('data-hl', th || '');
      if (th === 'hvdc') M.hvSink = hvS;   // kept after leaving, so the leave's dim crossfade dims nothing flatly either
      if ((th === 'balancing' && M.balSink) || hvS) root.setAttribute('data-hl-sink', '1'); else root.removeAttribute('data-hl-sink');   // model.css keeps the static layer lit
      M.dim = { from: prevHl, to: th, t0: global.performance.now(), snap: !running, done: false };
      root.classList.toggle('st-snap', !running);
      if (running && M.hook) M.hook.opts.restFps = 30;
      if (!running) { M.xf = null; M.poolA = M.story && M.story.def.pools ? 1 : 0; }
      if (M.hook) M.hook.refreshStyle();
      Object.keys(M.fields).forEach(function (k) { M.fields[k].refreshStyle(); });
      sayTick(t, mqReduce.matches || !!(UF.motion && UF.motion.isPaused()));
    }
    // the beat of the highlighted theme's say list on the story clock h = t - M.hlT0 (the story's own
    // t0), or its last beat while the model is still; listeners (site.js) hear only a change of beat
    M.sayFns = []; M.sayNow = { key: null, i: -1, n: 0, text: null, still: false };
    function sayTick(t, still) {
      var th = M.hl, D = th ? (M.story ? M.story.def : HOVER_SAY[th]) : null, say = D && D.say, hh = t - (M.hlT0 || 0), i = say ? sayAt(say, storyH(D, hh), still) : -1;
      if (say && D.r6 && D.r6.loop && !still && hh >= D.r6.loop && i === 0) i = say.length - 1;   // a replay opens on its own beat
      if (say && still && D.sayHold != null) i = D.sayHold;   // held still: the decided state's beat
      var S = M.sayNow;
      if (S.key === (th || null) && S.i === i && S.still === !!still) return;
      M.sayNow = { key: th || null, i: i, n: say ? say.length : 0, text: i >= 0 ? say[i][1] : null, still: !!still };
      M.sayFns.forEach(function (fn) { try { fn(M.sayNow); } catch (e) { if (global.console) console.error(e); } });
    }
    M.onSay = function (fn) { M.sayFns.push(fn); };
    M.sayFor = sayFor;
    // Pause shows the decided state at once; playing again crossfades back to the loop over 0.6 s
    if (UF.motion && UF.motion.onChange) UF.motion.onChange(function (dd) {
      if (!M.S) return;
      if (!dd.paused && !dd.reduced) { snapshot(M.t || 0, 0.6); M.quietUntil = (M.t || 0) + 0.6; }
      if (M.hook) M.hook.refreshStyle();
      sayTick(M.t || 0, !!(dd.paused || dd.reduced));
    });

    function onTheme() { if (!M.S) return; M.pal = readPalette(root); M.palVersion = (M.palVersion || 0) + 1; M.puff = null; if (M.beams) M.beams.palette(M.pal.s); if (M.hook) M.hook.refreshStyle(); }
    d.addEventListener('themechange', onTheme);
    // a window resize puts the switching camera back before the canvas and the stage are measured
    global.addEventListener('resize', function () { if (M.S && M.cam && M.cam.u > 0) camReset(); });
    var mqDark = global.matchMedia('(prefers-color-scheme: dark)');
    (mqDark.addEventListener ? mqDark.addEventListener.bind(mqDark, 'change') : mqDark.addListener.bind(mqDark))(onTheme);
    (mqWide.addEventListener ? mqWide.addEventListener.bind(mqWide, 'change') : mqWide.addListener.bind(mqWide))(function () { if (M.shapes) setup(); });

    M.setHighlight = setHighlight;
    // the hybrid view keeps every move out of the hero's event windows. The hero clock runs on the hook's local time;
    // other windows may be passed here ({ period, windows: [[t0, t1], ...] }, in s of that clock, or null for none). The
    // timetable is rebuilt from t = 0, so call it at set-up.
    M.setHybridQuiet = function (spec) { M.sched = new HybridSchedule(spec, paceNow()); if (M.hook) M.hook.refreshStyle(); };
    M.hybridPhase = function (tech, t) { return M.sched.phase(tech, t == null ? M.t || 0 : t); };
    M.fieldsList = function () { return Object.keys(M.fields).map(function (k) { return M.fields[k]; }); };
    // what is shown now (the source, its keys, the spine, the line field, the shown flows and injections)
    M.currentVariant = function () {
      var V = M.view, r = V ? V.ev.rest : null;
      return { src: V ? V.src : null, h: V ? V.h : null, state: r ? (r.k >= 0.999 ? r.b : r.a + '>' + r.b) : null, wind: V ? V.ev.wind.b : null,
        open: M.sw.brk ? ANIMATED.slice() : [], blade: M.sw.blade, line: M.applied.line, crossfade: !!M.xf };
    };
    M.shown = function () { var f = {}; M.S.lanes.forEach(function (ln, i) { f[ln.id] = [M.laneFl[i][0], M.laneFl[i][1], M.laneLive[i]]; }); return { lanes: f, p: Object.assign({}, M.shownP) }; };
    M.heroAt = heroAt;
    M.laneFlows = function (state, open) { var F = laneFlows(state, open || []); var o = {}; M.S.lanes.forEach(function (ln, i) { o[ln.id] = F[i]; }); return o; };
    M.batteryAt = function (i) { return batteryAt(M.t || 0, i || 0); };
    UF.load(engine + 'hero-shapes.json').then(function (shapes) { M.shapes = shapes; setup(); }).catch(function (e) { if (global.console) console.error(e); });
    return M;
  }

  // opts.dev: render the static layers into the stage at run time (for a stage without pre-rendered SVG layers).
  function devRender(stage, S) {
    var V = S.layout.view, svg = function (cls, body) { return '<svg class="' + cls + '" viewBox="0 0 ' + V[0] + ' ' + V[1] + '" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">' + body + '</svg>'; };
    stage.querySelectorAll('svg').forEach(function (s) { s.remove(); });
    stage.insertAdjacentHTML('afterbegin', svg('st-static', svgStatic(S)) + svg('st-hl', svgHighlights(S)) + svg('st-still', svgLive(S, 0)));
  }

  /* ───────────────────────────── public ───────────────────────────── */

  var Studio = {
    VERSION: VERSION,
    LAYOUTS: LAYOUTS,
    COMPACT: COMPACT,
    build: build,
    paletteCSS: paletteCSS,
    svgStatic: svgStatic,
    svgHighlights: svgHighlights,
    svgLive: svgLive,
    mount: mount,
    dcFlow: dcFlow,
    laneFlow: laneFlow,
    PARTICLES: PARTICLES,
    SCHED: SCHED,
    HERO: HERO,
    DECIDED: DECIDED,
    BAL_STORY: BAL_STORY,
    switchStory: switchStory,
    switchStoryR6: switchStoryR6, SWX: SWX, storyFor: storyFor,
    HOVER_SAY: HOVER_SAY,
    sayFor: sayFor,
    sayAt: sayAt,
    heroAt: heroAt,
    evalKeys: evalKeys,
    POOLS: POOLS,
    BAL_VARIANTS: BAL_VARIANTS, MERIT: MERIT, meritAt: meritAt, meritPrice: meritPrice, PAIR: PAIR,
    CHART7: CHART7, ladderAt: ladderAt, BIOMASS: BIOMASS, PAIR6: PAIR6, activateBids: activateBids,
    DAYX: DAYX, dayStory: dayStory, dayAt: dayAt, sunAngle: sunAngle, DAY_SAY: DAY_SAY, hvMode: hvMode,
    BEAM: BEAM,
    Beams: Beams,
    DCL: DCL,
    LINE: LINE,
    LINE_SHEET: LINE_SHEET,
    INSETS: INSETS,
    PANEL_VARIANTS: PANEL_VARIANTS,
    panelDefault: panelDefault,
    VOL: VOL,
    BAND: BAND,
    HYB: HYB,
    HYB_ORDER: HYB_ORDER,
    HYB_HOURS: HYB_HOURS,
    HYB6: HYB6,
    HYB6_ORDER: HYB6_ORDER,
    HYB7: HYB7, HYB7_ORDER: HYB7_ORDER, DAY_ORDER7: DAY_ORDER7,
    HYB8: HYB8, DAY_ORDER8: DAY_ORDER8,
    LINE_RD: LINE_RD,
    VEIL: VEIL,
    BEAM_EX: BEAM_EX,
    DAYS: DAYS,
    HERO_QUIET: HERO_QUIET,
    HybridSchedule: HybridSchedule,
    HybridPanel: HybridPanel,
    cloudTable: cloudTable,
    computeLine: computeLine,
    situationP: situationP,
    ptdfOf: ptdfOf,
    svgFieldLines: svgFieldLines,
    activateInZone: activateInZone,
    ANIMATED: ANIMATED,
    _internal: { rotorBlades: rotorBlades, trackerQuads: trackerQuads, bladeOpenness: bladeOpenness, breakerOpen: breakerOpen, batteryLevel: batteryLevel, lampLevel: lampLevel, intensity: intensity, level: level, LIGHT: LIGHT, pathOf: pathOf, pad2: pad2, add: add, mul: mul, nrm: nrm, sub: sub, lerp: lerp, LEVELS: LEVELS, MAT_KEYS: MAT_KEYS, FLAT: FLAT, PALETTES: PALETTES }
  };
  global.Studio = Studio;
})(typeof window !== 'undefined' ? window : this);
