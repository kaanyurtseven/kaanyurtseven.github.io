#!/usr/bin/env python3
"""Independent check of the explorer's and the figures' statistics with numpy and scipy.

Usage, from the repository root (local tooling, not part of the site build):

    python -I scripts/check_stats_numpy.py [REFERENCE.json] [--figures FIG.json]
        [--wind PATH] [--solar PATH] [--every K] [--dx PU]

REFERENCE.json is the output of scripts/stats_reference.rb (the values that
forecast.js reproduces, see scripts/test_stats_parity.py). For every K-th
case, plus every case at 0, at capacity and the latest quarter-hour, this
script rebuilds the conditioned distribution from the raw histograms with its
own code and integrates it numerically instead of exactly:

- the window rule and the cell weights are re-implemented here;
- the density is evaluated on a grid of step DX pu (default 1e-6) from
  -1.2 to 2.2 pu, the mass outside [0, 1] becomes the two atoms;
- quantiles invert the cumulated grid, CVaR integrates the quantile function
  over 200,000 points, mean, sd and E[ln x~], E[ln(1 - x~)] are grid sums;
- the Beta MLE solves psi(a) - psi(a + b) = s1, psi(b) - psi(a + b) = s2 with
  scipy's digamma (scipy.optimize.root), and the Beta and Gaussian CVaR come
  from scipy.stats quantiles and adaptive quadrature (scipy.integrate.quad).

--figures FIG.json checks _data/figures/offshore_da11.json (built from --wind)
the same way: pools5 in bin mode (each bin shifted by its own center) and
latest in window mode, against the rounded values in the file.

Prints the largest differences and exits 1 if any MW value differs by more
than 0.5 MW (plus the file's rounding for --figures) or alpha or beta by more
than 1e-4 (relative). Needs numpy and scipy (for example Anaconda's Python).
"""

import argparse
import json
import os
import sys
import warnings

import numpy as np
from scipy import integrate, optimize, special, stats

# quad warns about roundoff on a few infinite Gaussian tails; a bad integral
# would still show up below as a difference from the exact value.
warnings.filterwarnings('ignore', category=integrate.IntegrationWarning)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALPHA = 0.05
CLIP = 0.005
POOLS = [(0, 4), (10, 14), (22, 27), (35, 39), (45, 49)]   # build_figures.rb pools5


def select(bins, f_pu):
    bw = 0.04
    while bw <= 1.0 + 1e-9:
        lo, hi = max(0.0, f_pu - bw), min(1.0, f_pu + bw)
        sel = [b for b in bins if lo <= (b['lo'] + b['hi']) / 2 <= hi and b['n'] > 0 and b['hist_counts']]
        n = sum(b['n'] for b in sel)
        if n >= 500:
            break
        bw += 0.02
    return sel, n, bw


def grid_density(parts, meta, dx):
    """parts: [(shift_pu, weights per error cell)]. Density on the grid, clipped."""
    k = meta['hist_n_bins']
    width = (meta['hist_max'] - meta['hist_min']) / k
    x = np.arange(-1.2 + dx / 2, 2.2, dx)                             # grid midpoints
    dens = np.zeros_like(x)
    total = 0.0
    for shift, w in parts:
        edges = shift + meta['hist_min'] + width * np.arange(k + 1)    # unclipped cell edges
        idx = np.searchsorted(edges, x, side='right') - 1
        dens += np.where((idx >= 0) & (idx < k), w[np.clip(idx, 0, k - 1)] / width, 0.0)
        total += w.sum()
    p = dens * dx / total
    inside = (x > 0) & (x < 1)
    return {'atom0': p[x <= 0].sum(), 'atom1': p[x >= 1].sum(), 'x': x[inside], 'p': p[inside]}


def window_distribution(bins, meta, f_pu, dx):
    sel, n, bw = select(bins, f_pu)
    w = np.zeros(meta['hist_n_bins'])
    for b in sel:
        c = np.asarray(b['hist_counts'], dtype=float)
        if c.sum() > 0:
            w += b['n'] * c / c.sum()
    g = grid_density([(f_pu, w)], meta, dx)
    g.update(n=n, bw=bw)
    return g


def pool_distribution(bins, meta, first, last, dx):
    parts, n = [], 0
    for b in bins[first:last + 1]:
        c = np.asarray(b['hist_counts'], dtype=float)
        if c.sum() == 0 or b['n'] == 0:
            continue
        n += b['n']
        parts.append(((b['lo'] + min(b['hi'], 1.0)) / 2, b['n'] * c / c.sum()))
    g = grid_density(parts, meta, dx)
    g.update(n=n)
    return g


def statistics(g):
    x, p, a0, a1 = g['x'], g['p'], g['atom0'], g['atom1']
    mean = (x * p).sum() + a1
    var = ((x - mean) ** 2 * p).sum() + a0 * mean ** 2 + a1 * (1 - mean) ** 2
    # CDF just after each grid cell; the atom at 0 comes first, the atom at 1 last.
    cdf = a0 + np.cumsum(p)
    right = x + (x[1] - x[0]) / 2

    def quantile(u):
        u = np.atleast_1d(u)
        q = np.interp(u, np.concatenate([[a0], cdf]), np.concatenate([[0.0], right]))
        q[u <= a0] = 0.0
        q[u > cdf[-1]] = 1.0
        return q

    m = 200_000
    lo_u = (np.arange(m) + 0.5) / m * ALPHA
    hi_u = 1 - ALPHA + (np.arange(m) + 0.5) / m * ALPHA
    xc = np.clip(x, CLIP, 1 - CLIP)
    s1 = (np.log(xc) * p).sum() + a0 * np.log(CLIP) + a1 * np.log(1 - CLIP)
    s2 = (np.log(1 - xc) * p).sum() + a0 * np.log(1 - CLIP) + a1 * np.log(CLIP)
    return {
        'mean': mean, 'sd': np.sqrt(var),
        'p05': quantile(0.05)[0], 'p50': quantile(0.5)[0], 'p95': quantile(0.95)[0],
        'cvar05': quantile(lo_u).mean(), 'cvar95': quantile(hi_u).mean(),
        'at0': a0, 'atcap': a1, 's1': s1, 's2': s2,
    }


def beta_mle(s1, s2, start):
    """Root of the likelihood equations in log parameters; converged when both
    equations hold to 1e-10."""
    def grad(v):
        a, b = np.exp(v)
        return [special.digamma(a) - special.digamma(a + b) - s1,
                special.digamma(b) - special.digamma(a + b) - s2]
    sol = optimize.root(grad, np.log(start), method='hybr', tol=1e-12)
    return np.exp(sol.x), max(abs(r) for r in grad(sol.x)) < 1e-10


def tail_means(dist, lo_q, hi_q, a=-np.inf, b=np.inf, scale=1.0):
    tol = dict(limit=500, epsabs=1e-12 * scale, epsrel=1e-11)
    lo = integrate.quad(lambda t: t * dist.pdf(t), a, lo_q, **tol)[0] / ALPHA
    hi = integrate.quad(lambda t: t * dist.pdf(t), hi_q, b, **tol)[0] / ALPHA
    return lo, hi


class Tally:
    def __init__(self):
        self.worst, self.problems = {}, []

    def see(self, key, delta, label, limit=None, detail=''):
        if key not in self.worst or delta > self.worst[key][0]:
            self.worst[key] = (delta, label)
        if limit is not None and not delta <= limit:
            self.problems.append(f'{label}: {key} {detail}(off by {delta:.3g})')

    def report(self, title):
        units = {'alpha': '(relative)', 'beta': '(relative)', 'at0': '(fraction)', 'atcap': '(fraction)'}
        print(title)
        for key in ('mean', 'sd', 'p05', 'p50', 'p95', 'cvar05', 'cvar95', 'gauss_cvar05', 'gauss_cvar95',
                    'beta_cvar05', 'beta_cvar95', 'at0', 'atcap', 'alpha', 'beta'):
            if key in self.worst:
                d, where = self.worst[key]
                print(f"  {key:<13} {d:.3e} {units.get(key, 'MW')}   at {where}")


def check_reference(path, data, every, dx, tally):
    cases = json.load(open(path, encoding='utf-8'))['cases']
    picked = [c for i, c in enumerate(cases)
              if i % every == 0 or c['kind'] in ('zero', 'capacity') or c['kind'].startswith('latest')]
    for c in picked:
        ref = c['stats']
        d = data[c['tech']]
        cap = c['capacity']
        g = window_distribution(d['groups'][c['group']]['cond_quantiles'][c['forecast']], d['meta'], c['fMW'] / cap, dx)
        s = statistics(g)
        label = f"{c['tech']} {c['group']} {c['forecast']} f={c['fMW']:.1f} MW ({c['kind']})"
        if g['n'] != ref['n'] or abs(g['bw'] - ref['half_width']) > 1e-9:
            tally.problems.append(f'{label}: window differs')
        got = {k: s[k] * cap for k in ('mean', 'sd', 'p05', 'p50', 'p95', 'cvar05', 'cvar95')}
        gauss = stats.norm(got['mean'], got['sd'])
        got['gauss_cvar05'], got['gauss_cvar95'] = tail_means(gauss, gauss.ppf(ALPHA), gauss.ppf(1 - ALPHA),
                                                              scale=cap)
        for key, v in got.items():
            tally.see(key, abs(v - ref[key]), label, 0.5)
        for key in ('at0', 'atcap'):
            tally.see(key, abs(s[key] - ref[key]), label)
        rb = ref['beta']
        if rb is None:
            tally.problems.append(f'{label}: no Beta fit in the reference')
            continue
        (a, b), ok = beta_mle(s['s1'], s['s2'], [rb['alpha'] * 1.3, rb['beta'] * 0.8])
        if not ok:
            tally.problems.append(f'{label}: scipy root finding did not converge')
        tally.see('alpha', abs(a - rb['alpha']) / rb['alpha'], label, 1e-4)
        tally.see('beta', abs(b - rb['beta']) / rb['beta'], label, 1e-4)
        bd = stats.beta(rb['alpha'], rb['beta'])          # the reference fit, scaled below
        lo, hi = tail_means(bd, bd.ppf(ALPHA), bd.ppf(1 - ALPHA), 0.0, 1.0)
        tally.see('beta_cvar05', abs(lo * cap - rb['cvar05']), label, 0.5)
        tally.see('beta_cvar95', abs(hi * cap - rb['cvar95']), label, 0.5)
    return len(picked), len(cases)


def check_figures(path, wind, dx, tally):
    fig = json.load(open(path, encoding='utf-8'))
    meta = wind['meta']
    group = wind['groups'][fig['meta']['group']]
    bins = group['cond_quantiles'][fig['meta']['forecast']]
    cap = float(group['capacity'])
    blocks = []
    for (first, last), block in zip(POOLS, fig['pools5']):
        blocks.append((f'pools5 {block["lo"]}-{block["hi"]}', pool_distribution(bins, meta, first, last, dx), block))
    lt = fig['latest']
    if lt:
        recent = group['recent']
        idx = recent['timestamps'].index(lt['ts_utc'].rstrip('Z'))
        f_mw = recent['dayahead11hforecast'] if fig['meta']['forecast'] == 'dayahead11h' else None
        g = window_distribution(bins, meta, f_mw[idx] / cap, dx)
        blocks.append((f"latest {lt['ts_utc']}", g, lt))
    for label, g, block in blocks:
        s = statistics(g)
        if g['n'] != block['n']:
            tally.problems.append(f'{label}: n {g["n"]} vs {block["n"]}')
        for key in ('mean', 'sd', 'p05', 'p50', 'p95', 'cvar05', 'cvar95'):
            tally.see(key, abs(s[key] * cap - block[key]), label, 0.5 + 0.02, f'{s[key] * cap:.2f} vs {block[key]} ')
        for key in ('at0', 'atcap'):
            tally.see(key, abs(s[key] - block[key]), label, 0.5e-4 + 1e-6, f'{s[key]:.6f} vs {block[key]} ')
        if block.get('beta'):
            (a, b), ok = beta_mle(s['s1'], s['s2'], [block['beta']['alpha'] * 1.3, block['beta']['beta'] * 0.8])
            if not ok:
                tally.problems.append(f'{label}: scipy root finding did not converge')
            for key, v in (('alpha', a), ('beta', b)):
                printed = block['beta'][key]
                tally.see(key, abs(v - printed) / printed, label, (0.5e-3 + 1e-4 * printed) / printed,
                          f'{v:.5f} vs {printed} ')
    return len(blocks)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('reference', nargs='?')
    ap.add_argument('--figures')
    ap.add_argument('--wind', default=os.path.join(ROOT, 'assets', 'data', 'wind.json'))
    ap.add_argument('--solar', default=os.path.join(ROOT, 'assets', 'data', 'solar.json'))
    ap.add_argument('--every', type=int, default=15)
    ap.add_argument('--dx', type=float, default=1e-6)
    args = ap.parse_args()
    if not args.reference and not args.figures:
        ap.error('give REFERENCE.json, --figures FIG.json or both')

    data = {'wind': json.load(open(args.wind, encoding='utf-8')),
            'solar': json.load(open(args.solar, encoding='utf-8'))}
    print(f'numpy {np.__version__}, scipy {__import__("scipy").__version__}; grid step {args.dx:g} pu')
    failed = False
    if args.reference:
        tally = Tally()
        n, total = check_reference(args.reference, data, args.every, args.dx, tally)
        tally.report(f'explorer (window mode): {n} of {total} reference cases; largest |numpy - exact|:')
        failed |= bool(tally.problems)
        for p in tally.problems[:40]:
            print('  - ' + p)
    if args.figures:
        tally = Tally()
        n = check_figures(args.figures, data['wind'], args.dx, tally)
        tally.report(f'figures ({args.figures}): {n} blocks; largest |numpy - printed| (printed values are rounded):')
        failed |= bool(tally.problems)
        for p in tally.problems[:40]:
            print('  - ' + p)
    if failed:
        print('FAILED')
        return 1
    print('ok: the numerical integration agrees with the exact values')
    return 0


if __name__ == '__main__':
    sys.exit(main())
