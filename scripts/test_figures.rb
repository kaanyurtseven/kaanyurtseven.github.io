#!/usr/bin/env ruby
# frozen_string_literal: true

# Tests for scripts/lib/conditioning.rb and scripts/build_figures.rb.
# Ruby standard library only. Usage: ruby scripts/test_figures.rb
#
# The build also runs on a fixed snapshot of assets/data/wind.json
# (scripts/fixtures/wind-2026-10-09.json) and its output is checked against
# fixed values, verified independently with numpy (scripts/check_stats_numpy.py).

require 'json'
require 'open3'
require 'rbconfig'
require 'tmpdir'
require_relative 'lib/conditioning'
require_relative 'build_figures'

$checks = 0
$failed = []

def check(name, condition, detail = nil)
  $checks += 1
  $failed << "#{name}#{" (#{detail})" if detail}" unless condition
end

def close(name, actual, expected, tol)
  check(name, actual.is_a?(Numeric) && (actual - expected).abs <= tol, "got #{actual.inspect}, want #{expected} +- #{tol}")
end

C = Conditioning
cell = ->(a, b, w = 1.0) { C::Cell.new(a, b, w) }

# ── Distribution: hand-computable cases ──────────────────────────────────────

d = C::Distribution.new([cell.(0.2, 0.4)])
close 'uniform mean', d.mean, 0.3, 1e-12
close 'uniform sd', d.sd, 0.2 / Math.sqrt(12), 1e-12
close 'uniform P5', d.quantile(0.05), 0.21, 1e-12
close 'uniform P50', d.quantile(0.5), 0.3, 1e-12
close 'uniform lower CVaR5', d.lower_tail_mean(0.05), 0.205, 1e-12
close 'uniform upper CVaR95', d.upper_tail_mean(0.05), 0.395, 1e-12
close 'uniform cdf', d.cdf(0.25), 0.25, 1e-12
check 'uniform has no atoms', d.atom0.zero? && d.atom1.zero?

d = C::Distribution.new([cell.(-0.01, 0.01)])
close 'wall cell atom at 0', d.atom0, 0.5, 1e-12
close 'wall cell P25 sits on the atom', d.quantile(0.25), 0.0, 1e-12
close 'wall cell P75', d.quantile(0.75), 0.005, 1e-9
close 'wall cell mean', d.mean, 0.0025, 1e-12
close 'wall cell lower CVaR5 is 0', d.lower_tail_mean(0.05), 0.0, 1e-12
close 'wall cell upper tail mean of half', d.upper_tail_mean(0.5), 0.005, 1e-9
close 'wall cell variance with atom', d.variance, 0.5 * 0.0025**2 + 0.5 * (0.01**2 / 3.0 - 0.0025 * 0.01) + 0.5 * 0.0025**2, 1e-15

d = C::Distribution.new([cell.(0.98, 1.02, 3.0), cell.(0.5, 0.52, 1.0)])
close 'capacity atom', d.atom1, 0.375, 1e-12
close 'P95 on the capacity atom', d.quantile(0.95), 1.0, 1e-12
close 'upper CVaR95 on the atom', d.upper_tail_mean(0.05), 1.0, 1e-12
close 'P20 inside the low cell', d.quantile(0.2), 0.516, 1e-9
close 'mixture mean', d.mean, 0.25 * 0.51 + 0.375 * 0.99 + 0.375, 1e-12

d = C::Distribution.new([cell.(-0.05, -0.03)])
check 'all-atom distribution', d.atom0 == 1.0 && d.quantile(0.5).zero? && d.lower_tail_mean(0.05).zero? &&
                               d.upper_tail_mean(0.05).zero? && d.peak_density.zero?
check 'no step path without a continuous part', BuildFigures::Frame.step_path(d.steps, d.peak_density).nil?

d = C::Distribution.new([cell.(0.0, 0.02, 1.0), cell.(0.02, 0.04, 1.0), cell.(0.06, 0.08, 2.0)])
check 'gap kept as zero density', d.segments.none? { |x0, x1, _| x0 >= 0.04 - 1e-12 && x1 <= 0.06 + 1e-12 }
close 'quantile jumps the gap', d.quantile(0.5), 0.04, 1e-9
close 'continuous mass between', d.mass_between(0.01, 0.07), 0.125 + 0.25 + 0.25, 1e-12
close 'peak density', d.peak_density, 0.5 / 0.02, 1e-9

# ── Gaussian and Beta helpers ────────────────────────────────────────────────

close 'Phi(0)', C.norm_cdf(0.0), 0.5, 1e-15
close 'Phi(-z95)', C.norm_cdf(-C::Z95), 0.05, 1e-12
close 'CVaR constant', C::CVAR_K, Math.exp(-0.5 * C::Z95**2) / Math.sqrt(2 * Math::PI) / 0.05, 1e-12
# forecast.js's digamma (3-term asymptotic series from x >= 6) is accurate to about 3e-9.
close 'digamma(1)', C.digamma(1.0), -0.5772156649015329, 1e-8
close 'digamma(0.5)', C.digamma(0.5), -1.9635100260214235, 1e-8
close 'inv_digamma', C.inv_digamma(C.digamma(3.7)), 3.7, 1e-8
close 'Beta pdf integrates to 1', (0...10_000).sum { |i| C.beta_pdf((i + 0.5) / 10_000, 2.0, 5.0) } / 10_000, 1.0, 1e-6
check 'Beta pdf wall limits', C.beta_pdf(0.0, 0.7, 3.0).infinite? && C.beta_pdf(0.0, 2.0, 3.0).zero?

close 'lgamma(0.5)', C.lgamma(0.5), Math.log(Math.sqrt(Math::PI)), 1e-14

# ── Exact sufficient statistics of the Beta fit ──────────────────────────────

# Uniform on [0.2, 0.4]: E ln x = (F(0.4) - F(0.2)) / 0.2 with F(x) = x ln x - x.
e1, e2 = C::Distribution.new([cell.(0.2, 0.4)]).log_moments(C::BETA_CLIP)
close 'E ln x, uniform', e1, ((0.4 * Math.log(0.4) - 0.4) - (0.2 * Math.log(0.2) - 0.2)) / 0.2, 1e-14
close 'E ln(1 - x), uniform', e2, ((0.6 - 0.6 * Math.log(0.6)) - (0.8 - 0.8 * Math.log(0.8))) / 0.2, 1e-14
# Uniform on [0, 0.02] with an atom of 1/3 at 0: x~ = 0.005 below 0.005.
g1m = ->(x) { (1.0 - x) - (1.0 - x) * Math.log(1.0 - x) } # antiderivative of ln(1 - x)
e1, e2 = C::Distribution.new([cell.(-0.01, 0.02, 1.5)]).log_moments(C::BETA_CLIP)
w_lo = 1.0 / 3 + (2.0 / 3) * 0.005 / 0.02 # mass at x~ = 0.005
close 'E ln x~ with the clip and an atom', e1,
      w_lo * Math.log(0.005) + (2.0 / 3) / 0.02 * ((0.02 * Math.log(0.02) - 0.02) - (0.005 * Math.log(0.005) - 0.005)), 1e-13
close 'E ln(1 - x~) with the clip and an atom', e2,
      w_lo * Math.log(0.995) + (2.0 / 3) / 0.02 * (g1m.(0.02) - g1m.(0.005)), 1e-13

# ── Beta MLE: Newton, with Minka's fixed point as the fallback ───────────────

# A fine histogram of Beta(2, 5) is fitted back to about (2, 5).
fine = C::Distribution.new((0...1000).map { |i| a = i / 1000.0; cell.(a, a + 0.001, C.beta_pdf(a + 0.0005, 2.0, 5.0)) })
beta = C.fit_beta(fine)
check 'Beta fit converges (Newton)', beta && beta[:method] == 'newton' && beta[:iterations] <= 20, beta.inspect
close 'Beta fit alpha', beta[:alpha], 2.0, 0.005
close 'Beta fit beta', beta[:beta], 5.0, 0.01
pab = C.digamma(beta[:alpha] + beta[:beta])
close 'likelihood equation for alpha holds', C.digamma(beta[:alpha]) - pab, beta[:s1], 1e-12
close 'likelihood equation for beta holds', C.digamma(beta[:beta]) - pab, beta[:s2], 1e-12
fp = C.beta_fixed_point(beta[:s1], beta[:s2], 1.0, 1.0)
check 'fixed point reaches the same maximum', fp && (fp[:alpha] / beta[:alpha] - 1).abs < 1e-9 && (fp[:beta] / beta[:beta] - 1).abs < 1e-9, fp.inspect
# J-shaped data near 0 MW (alpha < 1) and a concentrated bell (alpha, beta in the hundreds).
j = C.fit_beta(C::Distribution.new([cell.(-0.02, 0.0, 3.0), cell.(0.0, 0.02, 4.0), cell.(0.02, 0.04, 2.0), cell.(0.04, 0.2, 1.0)]))
check 'J-shaped fit has alpha < 1', j && j[:alpha] < 1.0 && j[:method] == 'newton', j.inspect
b = C.fit_beta(C::Distribution.new([cell.(0.49, 0.51, 1.0), cell.(0.47, 0.49, 0.2), cell.(0.51, 0.53, 0.2)]))
check 'concentrated fit converges', b && b[:alpha] > 100 && b[:method] == 'newton', b.inspect
check 'no fit when all mass sits on one wall', C.fit_beta(C::Distribution.new([cell.(-0.05, -0.03)])).nil?

# ── Regularized incomplete beta, its inverse, Beta and Gaussian CVaR ─────────

close 'I_x(1, 1) = x', C.beta_inc(1.0, 1.0, 0.3), 0.3, 1e-15
close 'I_x(a, 1) = x^a', C.beta_inc(2.5, 1.0, 0.4), 0.4**2.5, 1e-15
close 'I_x(1, b) = 1 - (1 - x)^b', C.beta_inc(1.0, 3.0, 0.2), 1.0 - 0.8**3, 1e-15
close 'I_0.5(a, a) = 0.5', C.beta_inc(67.0, 67.0, 0.5), 0.5, 1e-13
close 'I_x(2, 3) = 6x^2 - 8x^3 + 3x^4', C.beta_inc(2.0, 3.0, 0.35), 6 * 0.35**2 - 8 * 0.35**3 + 3 * 0.35**4, 1e-15
[[0.05, 0.3, 12.0], [0.95, 0.7, 14.0], [0.05, 2.0, 5.0], [0.95, 393.0, 385.0], [0.05, 13.9, 0.67]].each do |p, a, bb|
  q = C.beta_quantile(p, a, bb)
  close "I(Q(#{p})) = #{p} for Beta(#{a}, #{bb})", C.beta_inc(a, bb, q), p, 1e-12
end
# Tail means by midpoint quadrature of the quantile function Q(u), against the
# closed form a/(a+b) I_q(a+1, b) / alpha.
[[2.0, 5.0], [0.7, 14.0], [22.1, 2.04]].each do |a, bb|
  m  = 20_000
  lo = (0...m).sum { |i| C.beta_quantile(0.05 * (i + 0.5) / m, a, bb) } / m
  hi = (0...m).sum { |i| C.beta_quantile(0.95 + 0.05 * (i + 0.5) / m, a, bb) } / m
  close "Beta(#{a}, #{bb}) lower CVaR5", C.beta_cvar_lower(a, bb, 0.05), lo, 1e-6
  close "Beta(#{a}, #{bb}) upper CVaR95", C.beta_cvar_upper(a, bb, 0.05), hi, 1e-6
end
st = C.statistics(C::Distribution.new([cell.(0.2, 0.4)]), beta: true)
close 'Gaussian CVaR95 is mirror of CVaR5', st[:gauss_cvar95] - st[:mean], st[:mean] - st[:gauss_cvar05], 1e-15
check 'statistics carries the Beta CVaR', st[:beta_cvar05] < st[:p05] && st[:beta_cvar95] > st[:p95], st.slice(:beta_cvar05, :beta_cvar95).inspect

# ── Window mode follows forecast.js's rule ───────────────────────────────────

grid  = C::ErrorGrid.new(-1.0, 1.0, 100)
mkbin = ->(i, n, counts) { { 'lo' => (i * 0.02).round(2), 'hi' => ((i + 1) * 0.02).round(2), 'n' => n, 'hist_counts' => counts } }
one   = ->(j, n) { Array.new(100, 0).tap { |c| c[j] = n } }
bins  = (0...50).map { |i| mkbin.(i, 0, Array.new(100, 0)) }
bins[20] = mkbin.(20, 300, one.(50, 300)) # center 0.41
bins[23] = mkbin.(23, 300, one.(49, 300)) # center 0.47
dist, info = C.window(bins, 0.41, grid)
close 'window widens to reach n 500', info[:half_width], 0.06, 1e-9
check 'window n', info[:n] == 600, info[:n].to_s
# Both histograms are shifted by f = 0.41: cells [0.41, 0.43] and [0.39, 0.41],
# so P25 = 0.40 (shifting by the bin centers would put the second cell at 0.45-0.47).
close 'window shifts by the forecast, not the bin center', dist.quantile(0.25), 0.40, 1e-9
inward = C.window(bins, 0.9, grid)[1]
check 'window widens inward from a high forecast', inward[:n] == 600 && (inward[:hi] - 1.0).abs < 1e-12, inward.inspect
# Bins weigh by n, cells by their share of the bin: 300 + 600 quarter-hours put
# 2/3 of the mass in [0.39, 0.41] (bin 23) and 1/3 in [0.41, 0.43] (bin 20).
heavy = bins.dup
heavy[23] = mkbin.(23, 600, one.(49, 600))
dist = C.window(heavy, 0.41, grid)[0]
close 'window weights are proportional to n', dist.cdf(0.41), 2.0 / 3, 1e-9
close 'window quantile from the proportional weights', dist.quantile(1.0 / 3), 0.40, 1e-9
# A rare cell (1 count in 4,000) keeps its weight: no sample allocation trims the tail.
rare = (0...50).map { |i| mkbin.(i, 0, Array.new(100, 0)) }
rare[20] = mkbin.(20, 4000, one.(50, 3999).tap { |c| c[10] = 1 })
dist = C.window(rare, 0.41, grid)[0]
close 'a single count in the tail keeps its mass', dist.atom0, 1.0 / 4000, 1e-12
lone = (0...50).map { |i| mkbin.(i, 0, Array.new(100, 0)) }
lone[20] = mkbin.(20, 300, one.(50, 300))
fallback = C.window(lone, 0.41, grid)[1]
check 'window falls back below 500 after reaching 1 pu', fallback[:fallback] && fallback[:n] == 300 && fallback[:half_width] > 1.0, fallback.inspect
# Exactly 500 is enough (n >= 500): 300 + 200 quarter-hours stop the widening at 0.06 pu.
at500 = bins.dup
at500[23] = mkbin.(23, 200, one.(49, 200))
at500 = C.window(at500, 0.41, grid)[1]
check 'window stops at exactly n 500', at500[:n] == 500 && (at500[:half_width] - 0.06).abs < 1e-9 && !at500[:fallback], at500.inspect

# ── Brussels time (EU rule) ──────────────────────────────────────────────────

{
  [2026, 3, 29, 0, 59] => ['2026-03-29T01:59+01:00', 'CET'],
  [2026, 3, 29, 1, 0] => ['2026-03-29T03:00+02:00', 'CEST'],
  [2026, 10, 25, 0, 59] => ['2026-10-25T02:59+02:00', 'CEST'],
  [2026, 10, 25, 1, 0] => ['2026-10-25T02:00+01:00', 'CET'],
  [2026, 10, 9, 20, 45] => ['2026-10-09T22:45+02:00', 'CEST'],
  [2024, 3, 31, 1, 0] => ['2024-03-31T03:00+02:00', 'CEST'],
  [2027, 1, 1, 0, 0] => ['2027-01-01T01:00+01:00', 'CET']
}.each do |utc, want|
  got = BuildFigures.brussels(Time.utc(*utc))
  check "brussels #{utc.inspect}", got == want, got.inspect
end

# ── Paths ────────────────────────────────────────────────────────────────────

F = BuildFigures::Frame
check 'frame maps 0 pu to x 100', F.x(0.0).round(9) == 100.0
check 'frame maps 1 pu to x 1100', F.x(1.0).round(9) == 1100.0
check 'numbers drop .0', F.num(1200) == '120' && F.num(1205) == '120.5' && F.num(-5) == '-0.5'
path = F.step_path([[0.0, 0.01, 2.0], [0.01, 0.03, 4.0], [0.05, 0.07, 4.0]], 4.0)
check 'step path', path == 'M100 0V50H110V100H130V0H150V100H170V0H1100', path
gpath = BuildFigures.gauss_path({ mean: 0.5, sd: 0.1 }, Conditioning.gauss_pdf(0.5, 0.5, 0.1))
check 'gauss path starts and ends on the baseline', gpath.start_with?('M') && gpath.match?(/\AM[\d.]+ 0L/) && gpath.end_with?(' 0'), gpath[0, 40]
check 'gauss path peaks at 100', gpath.include?('600 100'), gpath

# ── The Tools figure and glyph (ToolsFx) ─────────────────────────────────────

T = BuildFigures::ToolsFx
check 'f1 rounds the exact value up past a tie', T.f1(450.8500000000003) == '450.9', T.f1(450.8500000000003)
check 'f1 rounds the exact value down below a tie', [T.f1(0.35), T.f1(0.15), T.f1(0.45)] == ['0.3', '0.1', '0.5']
check 'f1 ties to even and keeps the sign', [T.f1(0.25), T.f1(-0.04), T.f1(8), T.f1(209.5)] == ['0.2', '-0.0', '8.0', '209.5']
check 'py_round', [T.py_round(0.5), T.py_round(1.5), T.py_round(17.12), T.py_round(2.675, 2), T.py_round(16.5 / 600 * 100, 2)] ==
                  [0, 2, 17, 2.67, 2.75]

current = BuildFigures.validate(BuildFigures.load(BuildFigures::INPUT))
# The window rule (+-0.04 pu, widened by 0.02 until n >= 500) written out independently: it must
# select the same bins and n as Conditioning.window_select at both levels
window_rule = lambda do |bins, f|
  bw = 0.04
  loop do
    sel = bins.select { |b| ((b['lo'] + b['hi']) / 2.0 - f).abs <= bw + 1e-9 }
    n = sel.sum { |b| b['n'] }
    return [sel, n] if n >= 500 || bw >= 1

    bw = (bw + 0.02).round(10)
  end
end
[T::FIG_LEVEL, T::GLYPH_LEVEL].each do |level|
  sel, n = C.window_select(current[:bins], level)
  msel, mn = window_rule.(current[:bins], level)
  check "window at #{level} selects the rule's bins", sel.map { |b| b['lo'] } == msel.map { |b| b['lo'] } && n == mn,
        "#{sel.map { |b| b['lo'] }.inspect} n #{n}, rule #{msel.map { |b| b['lo'] }.inspect} n #{mn}"
end
fx = T.build(current)
check 'tools figure parts', fx['figure_open'].start_with?('<svg class="fx-figure"') && !fx['figure_open'].include?('<title') &&
                            fx['figure_body'].start_with?('<path class="fx-spill"') && fx['figure_body'].end_with?('</svg>')
check 'tools glyph', fx['glyph'].start_with?('<svg class="fx-glyph"') && fx['glyph'].end_with?('</svg>')
check 'tools right tick', fx['tick_right_pct'] == (100 - fx['walls_pct'][1]).round(2)
check 'tools meta', fx['meta'].values_at('data_generated', 'data_generated_iso', 'data_date') ==
                    [current[:generated], current[:generated].sub('Z', ':00Z'), current[:generated][0, 10]], fx['meta'].inspect

# ── CLI: failures exit non-zero and never leave a partial file ───────────────

script = File.expand_path('build_figures.rb', __dir__)
run = ->(*args) { Open3.capture3(RbConfig.ruby, script, *args) }
Dir.mktmpdir do |dir|
  out = File.join(dir, 'out.json')
  File.write(out, 'previous')
  _o, e, s = run.('--input', File.join(dir, 'missing.json'), '--output', out)
  check 'missing input exits 1', s.exitstatus == 1 && e.include?('input not found'), e
  File.write(File.join(dir, 'bad.json'), '{"meta": ')
  _o, e, s = run.('--input', File.join(dir, 'bad.json'), '--output', out)
  check 'invalid JSON exits 1', s.exitstatus == 1 && e.include?('not valid JSON'), e
  File.write(File.join(dir, 'nogroup.json'), JSON.generate('meta' => { 'generated' => '2026-10-09T21:17 UTC' }, 'groups' => {}))
  _o, e, s = run.('--input', File.join(dir, 'nogroup.json'), '--output', out)
  check 'malformed input exits 1', s.exitstatus == 1 && e.include?('malformed input'), e
  check 'failed runs leave the old output alone', File.read(out) == 'previous'
  check 'no temp files left behind', Dir.children(dir).none? { |f| f.include?('.tmp-') }, Dir.children(dir).inspect
end

# ── Regression on a fixed snapshot of wind.json (9 October 2026) ───────────

snapshot_path = File.expand_path('fixtures/wind-2026-10-09.json', __dir__)
if File.file?(snapshot_path)
  Dir.mktmpdir do |dir|
    input = snapshot_path
    out   = File.join(dir, 'out.json')
    _o, e, s = run.('--input', input, '--output', out)
    check 'snapshot build succeeds', s.success?, e
    doc = JSON.parse(File.read(out))
    r23 = doc['ridges25'][23]
    b43 = doc['bins'][43]
    lt  = doc['latest']
    check 'snapshot data_generated', doc.dig('meta', 'data_generated') == '2026-10-09T21:17Z'
    check 'snapshot n_total', doc.dig('meta', 'n_total') == 103_812
    check 'ridge 92-96% n', r23['n'] == 5020
    close 'ridge 92-96% Gaussian above capacity', r23['gauss_above'], 0.1252, 1e-4
    check 'default ridge', doc.dig('defaults', 'ridge') == 23
    close 'ridge 0-4% at 0 MW', doc['ridges25'][0]['at0'], 0.3572, 1e-4
    [0.2451, 0.0247, 0.0036, 0.0311, 0.1321].each_with_index do |v, i|
      close "pool #{i} Gaussian outside", doc['pools5'][i]['gauss_outside'], v, 1e-4
    end
    check 'bin 0.86-0.88', [b43['n'], b43['p05'], b43['p95'], b43['cvar05']] == [2568, 1548, 2133, 1342], b43.slice('n', 'p05', 'p95', 'cvar05').inspect
    check 'bin 0.86-0.88 reserve', b43['reserve'] == { 'p05' => { 'data' => 420, 'gauss' => 365 }, 'cvar05' => { 'data' => 626, 'gauss' => 444 } }
    # Exact window mode (no sampling): P5 1,525 MW and CVaR5 1,245 MW.
    check 'latest', [lt['ts_brussels'], lt['forecast'], lt['measured'], lt['n'], lt['p05'], lt['p95'], lt['cvar05']] ==
                    ['2026-10-09T22:45+02:00', 1963, 1698, 8374, 1525, 2153, 1245],
          lt.slice('ts_brussels', 'forecast', 'measured', 'n', 'p05', 'p95', 'cvar05').inspect
    # Converged Beta MLE from the exact sufficient statistics (scripts/check_stats_numpy.py
    # agrees within the rounding).
    check 'pool 0-10% Beta', doc['pools5'][0]['beta'] == { 'alpha' => 0.725, 'beta' => 16.113 }, doc['pools5'][0]['beta'].inspect
    check 'snapshot within budget', File.size(out) <= BuildFigures::MAX_BYTES
    tools = File.join(dir, BuildFigures::TOOLS_FILE)
    check 'snapshot tools figure written beside the output', File.file?(tools)
    tfx = File.file?(tools) ? JSON.parse(File.read(tools)) : {}
    check 'snapshot tools figure', tfx.dig('meta', 'data_generated') == '2026-10-09T21:17Z' && tfx['level_pct'] == 96 &&
                                   tfx['n'].to_i >= 500 && tfx['glyph'].to_s.start_with?('<svg'), tfx.reject { |k, _| k.start_with?('fig', 'gly') }.inspect
  end
else
  puts 'skipped: snapshot regression (scripts/fixtures/wind-2026-10-09.json missing)'
end

if $failed.empty?
  puts "ok: #{$checks} checks passed"
else
  puts "FAILED #{$failed.size} of #{$checks} checks:"
  $failed.each { |f| puts "  - #{f}" }
  exit 1
end
