#!/usr/bin/env python3
"""Browser parity check of the explorer's statistics.

forecast.js, running in headless Edge, against scripts/lib/conditioning.rb.

Usage, from the repository root (local tooling, not part of the site build):

    python -I scripts/test_stats_parity.py [--ruby PATH] [--reference PATH]
        [--wind PATH] [--solar PATH] [--json OUT]

1. Runs scripts/stats_reference.rb (unless --reference names its output):
   every wind group (5) and solar group (14), all three forecast types, at
   0, capacity, 19 levels in between, the window-widening levels of a
   1/200 pu scan and the latest measured quarter-hour.
2. Loads the real assets/js/forecast.js into a blank page and calls the
   read-only hook window.KYForecastStats.compute for every case.
3. Passes when n and the window agree exactly, every MW value (mean, sd,
   P5, P50, P95, CVaR5, CVaR95, Gaussian and Beta CVaR) within 0.5 MW, and
   alpha and beta within 1e-6 (relative); when the same call returns the
   same numbers twice; and when one recompute takes at most 5 ms.

Needs Python 3 with Playwright and Microsoft Edge (channel "msedge").
Exit status 0 when every check passes, 1 otherwise.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MW_TOL = 0.5
REL_TOL = 1e-6
FRAC_TOL = 1e-9
MS_LIMIT = 5.0

# reference key -> path in the JS result
MW_KEYS = {
    'mean': ('mean',), 'sd': ('sd',), 'p05': ('p05',), 'p50': ('p50',), 'p95': ('p95',),
    'cvar05': ('cvar05',), 'cvar95': ('cvar95',),
    'gauss_cvar05': ('gauss', 'cvar05'), 'gauss_cvar95': ('gauss', 'cvar95'),
}
BETA_MW_KEYS = {'beta_cvar05': 'cvar05', 'beta_cvar95': 'cvar95'}

JS_RUN = r"""
(arg) => {
  const S = window.KYForecastStats;
  const data = { wind: arg.wind, solar: arg.solar };
  const out = [];
  for (const c of arg.cases) {
    const d = data[c.tech];
    const r = S.compute(d.groups[c.group], d.meta, c.forecast, c.fMW);
    const r2 = S.compute(d.groups[c.group], d.meta, c.forecast, c.fMW);
    const same = JSON.stringify(r) === JSON.stringify(r2);
    out.push(r ? {
      same: same, n: r.n, half_width: r.cond.bandwidth, bins_used: r.cond.binsUsed.length,
      fallback: r.cond.fallback, mean: r.mean, sd: r.sd, p05: r.p05, p50: r.p50, p95: r.p95,
      cvar05: r.cvar05, cvar95: r.cvar95, at0: r.at0, atcap: r.atcap,
      gauss: r.gauss, beta: r.beta, bars_sum: r.bars.reduce((s, v) => s + v, 0)
    } : { same: same, none: true });
  }
  // Timing: every case recomputed REPS times (the statistics behind one hover).
  const REPS = 20, times = [];
  for (const c of arg.cases) {
    const d = data[c.tech], g = d.groups[c.group];
    const t0 = performance.now();
    for (let i = 0; i < REPS; i++) S.compute(g, d.meta, c.forecast, c.fMW);
    times.push((performance.now() - t0) / REPS);
  }
  return { results: out, times: times };
}
"""

# Synthetic edge cases, run in the browser only (expected values by hand).
JS_EDGE = r"""
() => {
  const S = window.KYForecastStats, meta = { hist_min: -1, hist_max: 1, hist_n_bins: 100 };
  const bins = (fill) => Array.from({ length: 50 }, (_, i) => {
    const lo = Math.round(i * 2) / 100, hi = Math.round((i + 1) * 2) / 100;
    const c = new Array(100).fill(0); let n = 0;
    if (fill) n = fill(i, c);
    return { lo: lo, hi: hi, n: n, hist_counts: c };
  });
  const g = (fill) => ({ capacity: 1000, cond_quantiles: { dayahead11h: bins(fill) } });
  const time = (f) => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };
  const out = {};
  out.empty = S.compute(g(null), meta, 'dayahead11h', 500);
  // every error 0.9 pu below the forecast: all mass beyond the 0 MW wall at f = 0.41
  let [wall, ms] = time(() => S.compute(g((i, c) => { c[5] = 600; return 600; }), meta, 'dayahead11h', 410));
  out.wall = { at0: wall.at0, p05: wall.p05, p95: wall.p95, cvar05: wall.cvar05, cvar95: wall.cvar95,
               beta: wall.beta, ms: ms };
  // half the mass beyond each wall: U-shaped, the Beta fit still exists
  const both = S.compute(g((i, c) => { c[5] = 300; c[96] = 300; return 600; }), meta, 'dayahead11h', 500);
  out.both = { at0: both.at0, atcap: both.atcap, p05: both.p05, p95: both.p95, cvar05: both.cvar05,
               cvar95: both.cvar95, beta: both.beta && { alpha: both.beta.alpha, beta: both.beta.beta } };
  out.nometa = S.compute(g((i, c) => { c[50] = 600; return 600; }), null, 'dayahead11h', 500);
  // exactly 500 is enough (n >= 500): 300 + 200 quarter-hours stop the widening at 0.06 pu
  const at500 = S.compute(g((i, c) => {
    if (i === 20) { c[50] = 300; return 300; }
    if (i === 23) { c[49] = 200; return 200; }
    return 0;
  }), meta, 'dayahead11h', 410);
  out.at500 = { n: at500.n, bw: at500.cond.bandwidth, fallback: at500.cond.fallback };
  return out;
}
"""


def run_reference(ruby, wind, solar, out_path):
    cmd = [ruby, os.path.join(ROOT, 'scripts', 'stats_reference.rb'), '--output', out_path,
           '--wind', wind, '--solar', solar]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'test_stats_parity: stats_reference.rb failed: {proc.stderr.strip()}')
    print(proc.stdout.strip())


def dig(obj, path):
    for p in path:
        if obj is None:
            return None
        obj = obj.get(p)
    return obj


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--ruby', default='ruby')
    ap.add_argument('--reference')
    ap.add_argument('--wind', default=os.path.join(ROOT, 'assets', 'data', 'wind.json'))
    ap.add_argument('--solar', default=os.path.join(ROOT, 'assets', 'data', 'solar.json'))
    ap.add_argument('--json', help='write the per-case comparison here')
    args = ap.parse_args()

    script = os.path.join(ROOT, 'assets', 'js', 'forecast.js')
    src = open(script, encoding='utf-8').read()
    stats_part = src[src.index('// ── Hard rectangular conditioning'):src.index('// ── Legend visibility persistence')]
    failures = []
    if re.search(r'Math\.random', re.sub(r'//[^\n]*', '', stats_part)):
        failures.append('Math.random appears in the statistics section of forecast.js; the statistics must be exact')

    ref_path = args.reference
    tmp = None
    if not ref_path:
        tmp = tempfile.TemporaryDirectory()
        ref_path = os.path.join(tmp.name, 'reference.json')
        run_reference(args.ruby, args.wind, args.solar, ref_path)
    cases = json.load(open(ref_path, encoding='utf-8'))['cases']
    wind = json.load(open(args.wind, encoding='utf-8'))
    solar = json.load(open(args.solar, encoding='utf-8'))

    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content('<!doctype html><html lang="en"><head><title>stats</title></head><body></body></html>')
        page.add_script_tag(path=script)
        if not page.evaluate('() => !!(window.KYForecastStats && window.KYForecastStats.compute)'):
            sys.exit('test_stats_parity: window.KYForecastStats is missing (page errors: %s)' % errors)
        version = page.evaluate('() => navigator.userAgent')
        js_cases = [{k: c[k] for k in ('tech', 'group', 'forecast', 'fMW')} for c in cases]
        got = page.evaluate(JS_RUN, {'wind': wind, 'solar': solar, 'cases': js_cases})
        edge = page.evaluate(JS_EDGE)
        browser.close()
    if errors:
        failures.append(f'page errors: {errors}')

    # Edge cases: no data; all mass beyond one wall (no Beta maximum, found at
    # once); half the mass beyond each wall (P5 0, P95 capacity, CVaR at the walls);
    # n exactly 500 (the window threshold is n >= 500; no reference level has n = 500).
    a5 = edge['at500']
    if not (a5['n'] == 500 and abs(a5['bw'] - 0.06) < 1e-9 and not a5['fallback']):
        failures.append(f'n = 500 exactly should stop the widening at 0.06 pu: {a5}')
    if edge['empty'] is not None or edge['nometa'] is not None:
        failures.append(f"no-data cases should give null: {edge['empty']!r}, {edge['nometa']!r}")
    w = edge['wall']
    if not (w['at0'] == 1 and w['p05'] == 0 and w['p95'] == 0 and w['cvar05'] == 0 and w['cvar95'] == 0
            and w['beta'] is None and w['ms'] < MS_LIMIT):
        failures.append(f'all-at-0 case wrong: {w}')
    b = edge['both']
    if not (abs(b['at0'] - 0.5) < 1e-12 and abs(b['atcap'] - 0.5) < 1e-12 and b['p05'] == 0
            and b['p95'] == 1000 and b['cvar05'] == 0 and b['cvar95'] == 1000 and b['beta']
            and b['beta']['alpha'] < 1 and b['beta']['beta'] < 1):
        failures.append(f'two-wall case wrong: {b}')

    worst = {}
    rows = []

    def track(key, delta, case):
        if key not in worst or delta > worst[key][0]:
            worst[key] = (delta, case)

    for c, r in zip(cases, got['results']):
        ref = c['stats']
        label = f"{c['tech']} {c['group']} {c['forecast']} f={c['fMW']:.1f} MW ({c['kind']})"
        if not r['same']:
            failures.append(f'{label}: two calls gave different numbers')
        if ref is None or r.get('none'):
            if not (ref is None and r.get('none')):
                failures.append(f'{label}: one side has no distribution')
            continue
        if r['n'] != ref['n'] or r['bins_used'] != ref['bins_used'] or r['fallback'] != ref['fallback'] \
                or abs(r['half_width'] - ref['half_width']) > 1e-9:
            failures.append(f"{label}: window differs (JS n {r['n']} hw {r['half_width']}, Ruby n {ref['n']} hw {ref['half_width']})")
        row = {'case': label}
        for key, path in MW_KEYS.items():
            delta = abs(dig(r, path) - ref[key])
            row[key] = delta
            track(key, delta, label)
            if not delta <= MW_TOL:
                failures.append(f'{label}: {key} differs by {delta:.3f} MW')
        for key in ('at0', 'atcap'):
            delta = abs(r[key] - ref[key])
            track(key, delta, label)
            if not delta <= FRAC_TOL:
                failures.append(f'{label}: {key} differs by {delta:.2e}')
        rb, jb = ref['beta'], r['beta']
        if (rb is None) != (jb is None):
            failures.append(f'{label}: Beta fit exists on one side only')
        elif rb is not None:
            for key in ('alpha', 'beta'):
                rel = abs(jb[key] - rb[key]) / abs(rb[key])
                row[key] = rel
                track(key, rel, label)
                if not rel <= REL_TOL:
                    failures.append(f'{label}: {key} differs by {rel:.2e} (relative)')
            for key, jkey in BETA_MW_KEYS.items():
                delta = abs(jb[jkey] - rb[jkey])
                row[key] = delta
                track(key, delta, label)
                if not delta <= MW_TOL:
                    failures.append(f'{label}: {key} differs by {delta:.3f} MW')
        rows.append(row)

    times = sorted(got['times'])
    t_med = times[len(times) // 2]
    t_p95 = times[int(len(times) * 0.95)]
    t_max = times[-1]
    if t_max > MS_LIMIT:
        failures.append(f'slowest recompute {t_max:.2f} ms is over {MS_LIMIT} ms')

    groups = {(c['tech'], c['group']) for c in cases}
    combos = {(c['tech'], c['group'], c['forecast']) for c in cases}
    per_combo = {}
    for c in cases:
        per_combo[(c['tech'], c['group'], c['forecast'])] = per_combo.get((c['tech'], c['group'], c['forecast']), 0) + 1
    print(f'browser: {version}')
    print(f"cases: {len(cases)} ({len([g for g in groups if g[0] == 'wind'])} wind groups, "
          f"{len([g for g in groups if g[0] == 'solar'])} solar groups, {len(combos)} group/forecast pairs, "
          f'{min(per_combo.values())}-{max(per_combo.values())} levels each, '
          f"{sum(1 for c in cases if c['kind'] == 'widened')} window-widening cases)")
    print('largest |JS - Ruby|:')
    units = {'alpha': '(relative)', 'beta': '(relative)', 'at0': '(fraction)', 'atcap': '(fraction)'}
    for key in list(MW_KEYS) + ['beta_cvar05', 'beta_cvar95', 'at0', 'atcap', 'alpha', 'beta']:
        if key in worst:
            d, where = worst[key]
            print(f"  {key:<13} {d:.3e} {units.get(key, 'MW')}   at {where}")
    print(f'recompute time per call: median {t_med:.3f} ms, p95 {t_p95:.3f} ms, max {t_max:.3f} ms '
          f'(average of 20 calls per case)')
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as fh:
            json.dump({'rows': rows, 'times_ms': got['times']}, fh)
    if tmp:
        tmp.cleanup()
    if failures:
        print(f'FAILED: {len(failures)} problems')
        for f in failures[:40]:
            print('  - ' + f)
        return 1
    print('ok: forecast.js and conditioning.rb agree on every case')
    return 0


if __name__ == '__main__':
    sys.exit(main())
