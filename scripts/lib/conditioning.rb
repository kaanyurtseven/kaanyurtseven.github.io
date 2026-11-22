# frozen_string_literal: true

# Conditional forecast-error statistics for the build-time figures.
#
# The same definitions as the explorer (assets/js/forecast.js, "Exact
# statistics"): this file and forecast.js must agree to 0.5 MW on every MW
# value and to 1e-6 (relative) on the Beta parameters, which
# scripts/test_stats_parity.py checks in headless Edge. Ruby standard
# library only; Ruby 3.3 (CI) and 3.4 compatible. Used by
# scripts/build_figures.rb and scripts/stats_reference.rb.
#
# Input: one group of assets/data/wind.json (or solar.json), produced by
# scripts/fetch_elia_data.rb. cond_quantiles[<forecast>] holds 50 forecast
# bins of 0.02 pu ({lo, hi, n, hist_counts}); hist_counts is a histogram of
# error_pu = (measured - forecast) / capacity in meta.hist_n_bins cells over
# [meta.hist_min, meta.hist_max] (100 cells of 0.02 pu over [-1, 1]).
#
# Both modes build the distribution of measured output in per unit (pu) of
# capacity and compute every statistic exactly from it (no sampling):
#
#   Bin mode (figures): pool a stated range of forecast bins. Each bin's
#   error histogram is shifted by that bin's own center, and each bin is
#   weighted by its n.
#
#   Window mode (explorer): select the bins whose center lies within
#   +-0.04 pu of the forecast (window clipped to [0, 1]); widen by 0.02
#   until the selected n >= 500. Every selected histogram is shifted by the
#   forecast itself, and error cell j of bin b weighs n_b * c_bj / sum_j c_bj.
#
# In both modes each error cell is uniform across its width, and the result
# is clipped to [0, 1] pu (= [0 MW, capacity]); mass beyond a wall is kept as
# an atom at that wall.

module Conditioning
  # Window rule (forecast.js "Hard rectangular conditioning").
  BW_START = 0.04
  BW_STEP  = 0.02
  BW_MAX   = 1.00
  MIN_N    = 500

  CVAR_ALPHA = 0.05

  # Beta fit (forecast.js fitBeta). The MLE of Beta(alpha, beta) on [0, 1] pu
  # given the exact sufficient statistics E[ln x~] and E[ln(1 - x~)] of the
  # conditioned distribution, x~ = clip(x, BETA_CLIP, 1 - BETA_CLIP).
  # Newton's method on the log-likelihood (strictly concave in alpha, beta)
  # with a backtracking (Armijo) line search; the test allows for rounding in
  # lgamma (NEWTON_ROUNDING times the size of the terms), so that near the
  # optimum it never rejects a step on noise. Minka's fixed point, run to a
  # tight tolerance, is the fallback. A fit with alpha or beta <= BETA_MIN is
  # reported as no fit, and so is one above BETA_MAX: the likelihood then has
  # no maximum (all mass at one point, which a 0.02 pu cell rules out; on the
  # explorer's data alpha and beta stay below 400).
  BETA_CLIP          = 0.005
  BETA_MIN           = 0.01
  BETA_MAX           = 1e6
  NEWTON_MAX_ITER    = 100
  NEWTON_TOL         = 1e-12 # relative step
  NEWTON_DEC_TOL     = 1e-20 # Newton decrement g'(-H^-1)g: converged below this
  NEWTON_ARMIJO      = 1e-4
  NEWTON_ROUNDING    = 1e-12
  NEWTON_MIN_STEP    = 1e-10
  FIXED_POINT_MAX_ITER = 50_000
  FIXED_POINT_TOL      = 1e-13 # relative step

  # Regularized incomplete beta (continued fraction) and its inverse.
  BETACF_MAX_ITER = 10_000
  BETACF_EPS      = 1e-15
  BETACF_FPMIN    = 1e-300
  BETA_Q_MAX_ITER = 200
  BETA_Q_TOL      = 1e-14

  Z95    = 1.6448536269514722 # standard normal quantile at 0.95
  CVAR_K = 2.0627128075074257 # phi(Z95) / 0.05: Gaussian lower CVaR5 = mu - CVAR_K * sigma

  # Cell edges are snapped to 1e-9 pu so that edges that differ only by
  # floating-point noise coincide.
  SNAP = 1_000_000_000

  # A uniform cell of the unclipped distribution: [a, b] in pu with weight w.
  Cell = Struct.new(:a, :b, :w)

  # Geometry of the error histogram (meta.hist_min, meta.hist_max, meta.hist_n_bins).
  class ErrorGrid
    attr_reader :min, :max, :count, :width

    def initialize(min, max, count)
      @min   = Float(min)
      @max   = Float(max)
      @count = Integer(count)
      raise ArgumentError, 'error histogram needs hist_max > hist_min and hist_n_bins > 0' unless @max > @min && @count.positive?

      @width = (@max - @min) / @count
    end

    # Center of error cell j in pu.
    def centre(j)
      @min + (j + 0.5) * @width
    end
  end

  # Distribution of measured output on [0, 1] pu: atoms at both walls plus a
  # piecewise-constant density on non-overlapping segments [x0, x1] with mass m.
  # Masses are normalized (atoms + segment masses = 1).
  class Distribution
    attr_reader :atom0, :atom1, :segments

    def initialize(cells)
      cells = cells.select { |c| c.w.positive? && c.b > c.a }
      raise ArgumentError, 'distribution has no mass' if cells.empty?

      atom0 = 0.0
      atom1 = 0.0
      delta = Hash.new(0.0)
      cells.each do |c|
        width = c.b - c.a
        below = (-c.a).clamp(0.0, width)
        above = (c.b - 1.0).clamp(0.0, width)
        atom0 += c.w * below / width
        atom1 += c.w * above / width
        inside = c.w * (width - below - above) / width
        lo = (c.a.clamp(0.0, 1.0) * SNAP).round
        hi = (c.b.clamp(0.0, 1.0) * SNAP).round
        next unless inside.positive? && hi > lo

        dens = inside / (hi - lo)
        delta[lo] += dens
        delta[hi] -= dens
      end

      keys = delta.keys.sort
      tol  = delta.values.map(&:abs).max.to_f * 1e-9
      segs = []
      dens = 0.0
      keys.each_cons(2) do |k0, k1|
        dens += delta[k0]
        segs << [k0, k1, dens * (k1 - k0)] if dens > tol
      end
      mass = atom0 + atom1 + segs.sum { |s| s[2] }
      @atom0    = atom0 / mass
      @atom1    = atom1 / mass
      @segments = segs.map { |k0, k1, m| [k0.fdiv(SNAP), k1.fdiv(SNAP), m / mass].freeze }.freeze
    end

    def mean
      @mean ||= @segments.sum { |x0, x1, m| m * (x0 + x1) / 2.0 } + @atom1
    end

    def variance
      @variance ||= begin
        mu = mean
        v = @segments.sum do |x0, x1, m|
          d0 = x0 - mu
          d1 = x1 - mu
          m * (d0 * d0 + d0 * d1 + d1 * d1) / 3.0
        end
        v + @atom0 * mu * mu + @atom1 * (1.0 - mu)**2
      end
    end

    # Population standard deviation.
    def sd
      Math.sqrt([variance, 0.0].max)
    end

    # P(X <= x).
    def cdf(x)
      return 0.0 if x.negative?
      return 1.0 if x >= 1.0

      @atom0 + @segments.sum do |x0, x1, m|
        next 0.0 if x <= x0

        x >= x1 ? m : m * (x - x0) / (x1 - x0)
      end
    end

    # Quantile Q(u) = inf { x : F(x) >= u }, 0 < u < 1.
    def quantile(u)
      return 0.0 if @atom0.positive? && u <= @atom0

      c = @atom0
      @segments.each do |x0, x1, m|
        return x0 + (x1 - x0) * ((u - c) / m).clamp(0.0, 1.0) if c + m >= u

        c += m
      end
      return 1.0 if @atom1.positive?

      @segments.empty? ? 0.0 : @segments.last[1]
    end

    # Mean of the lowest alpha of the distribution (lower-tail CVaR, the
    # Rockafellar-Uryasev value): (1/alpha) * integral_0^alpha Q(u) du.
    # Atoms are split exactly.
    def lower_tail_mean(alpha)
      rem = alpha - [@atom0, alpha].min # the atom at 0 contributes 0
      acc = 0.0
      @segments.each do |x0, x1, m|
        break unless rem.positive?

        if m <= rem
          acc += m * (x0 + x1) / 2.0
          rem -= m
        else
          xq = x0 + (x1 - x0) * rem / m
          acc += rem * (x0 + xq) / 2.0
          rem = 0.0
        end
      end
      acc += rem if rem.positive? # what is left sits in the atom at 1
      acc / alpha
    end

    # Mean of the highest alpha of the distribution (upper-tail CVaR):
    # (1/alpha) * integral_{1-alpha}^1 Q(u) du.
    def upper_tail_mean(alpha)
      take = [@atom1, alpha].min
      acc  = take
      rem  = alpha - take
      @segments.reverse_each do |x0, x1, m|
        break unless rem.positive?

        if m <= rem
          acc += m * (x0 + x1) / 2.0
          rem -= m
        else
          xq = x1 - (x1 - x0) * rem / m
          acc += rem * (xq + x1) / 2.0
          rem = 0.0
        end
      end
      acc / alpha # any remainder sits in the atom at 0 and adds 0
    end

    # [E ln x~, E ln(1 - x~)] with x~ = clip(x, clip, 1 - clip), integrated
    # exactly over every segment (the Beta fit's sufficient statistics).
    def log_moments(clip)
      lo  = clip
      hi  = 1.0 - clip
      llo = Math.log(lo)
      lhi = Math.log(hi)
      e1 = @atom0 * llo + @atom1 * lhi
      e2 = @atom0 * lhi + @atom1 * llo
      @segments.each do |x0, x1, m|
        dens = m / (x1 - x0)
        b = [x1, lo].min
        if b > x0
          e1 += dens * (b - x0) * llo
          e2 += dens * (b - x0) * lhi
        end
        a = [x0, lo].max
        b = [x1, hi].min
        if b > a
          e1 += dens * (Conditioning.int_log(b) - Conditioning.int_log(a))
          e2 += dens * (Conditioning.int_log1m(b) - Conditioning.int_log1m(a))
        end
        a = [x0, hi].max
        next unless x1 > a

        e1 += dens * (x1 - a) * lhi
        e2 += dens * (x1 - a) * llo
      end
      [e1, e2]
    end

    # Largest density of the continuous part, per pu.
    def peak_density
      @segments.map { |x0, x1, m| m / (x1 - x0) }.max || 0.0
    end

    # [[x0, x1, density per pu], ...] of the continuous part.
    def steps
      @segments.map { |x0, x1, m| [x0, x1, m / (x1 - x0)] }
    end

    # Continuous mass inside [e0, e1] (atoms excluded).
    def mass_between(e0, e1)
      @segments.sum do |x0, x1, m|
        overlap = [x1, e1].min - [x0, e0].max
        overlap.positive? ? m * overlap / (x1 - x0) : 0.0
      end
    end
  end

  # Antiderivatives used by log_moments: integral of ln x and of ln(1 - x).
  def self.int_log(x)
    x * Math.log(x) - x
  end

  def self.int_log1m(x)
    y = 1.0 - x
    y - y * Math.log(y)
  end

  # ── Modes ──────────────────────────────────────────────────────────────────

  # Bin center used for the bin-mode shift. The pipeline's last bin is
  # [0.98, 1.01) so that forecasts at exactly capacity are included; its
  # forecast range is 0.98-1.00 pu and its center is taken as 0.99.
  def self.bin_centre(bin)
    (Float(bin['lo']) + [Float(bin['hi']), 1.0].min) / 2.0
  end

  # Bin mode: pool bins[indices]. Returns [Distribution, n] or nil when the
  # range holds no data.
  def self.pool(bins, indices, grid)
    cells = []
    n = 0
    indices.each do |i|
      bin    = bins.fetch(i)
      counts = bin['hist_counts']
      total  = counts.sum
      next if total.zero? || bin['n'].zero?

      n += bin['n']
      centre = bin_centre(bin)
      counts.each_with_index do |c, j|
        next if c.zero?

        x = centre + grid.centre(j)
        cells << Cell.new(x - grid.width / 2.0, x + grid.width / 2.0, bin['n'] * c.to_f / total)
      end
    end
    return nil if cells.empty?

    [Distribution.new(cells), n]
  end

  # The window rule alone: [selected bins, their n, half-width, lo, hi].
  def self.window_select(bins, f_pu)
    bw = BW_START
    selected = []
    total_n  = 0
    lo = hi = nil
    while bw <= BW_MAX + 1e-9
      lo = [0.0, f_pu - bw].max
      hi = [1.0, f_pu + bw].min
      selected = bins.select do |bin|
        centre = (bin['lo'] + bin['hi']) / 2.0 # forecast.js getBinsInWindow (no nominal-center rule here)
        centre >= lo && centre <= hi && bin['n'].positive? && bin['hist_counts']
      end
      total_n = selected.sum { |bin| bin['n'] }
      break if total_n >= MIN_N

      bw += BW_STEP
    end
    [selected, total_n, bw, lo, hi]
  end

  # Window mode at forecast f_pu (forecast MW / capacity): forecast.js
  # conditionDistribution. Returns [Distribution, info] or nil.
  def self.window(bins, f_pu, grid)
    selected, total_n, bw, lo, hi = window_select(bins, f_pu)
    return nil if selected.empty?

    # Every selected histogram is shifted by the same forecast, so the cells
    # coincide: add up their weights first (in bin order, as forecast.js).
    weights = Array.new(grid.count, 0.0)
    selected.each do |bin|
      counts = bin['hist_counts']
      total  = counts.sum
      next if total.zero?

      counts.each_with_index { |c, j| weights[j] += bin['n'] * c.to_f / total if c.positive? }
    end
    cells = []
    weights.each_with_index do |w, j|
      next unless w.positive?

      x = f_pu + grid.centre(j)
      cells << Cell.new(x - grid.width / 2.0, x + grid.width / 2.0, w)
    end
    return nil if cells.empty?

    info = {
      n: total_n,
      half_width: bw,
      lo: lo,
      hi: hi,
      bins_used: selected.size,
      fallback: total_n < MIN_N
    }
    [Distribution.new(cells), info]
  end

  # ── Statistics ─────────────────────────────────────────────────────────────

  def self.norm_cdf(z)
    0.5 * Math.erfc(-z / Math.sqrt(2.0))
  end

  def self.gauss_pdf(x, mu, sd)
    z = (x - mu) / sd
    Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2.0 * Math::PI))
  end

  def self.lgamma(x)
    Math.lgamma(x)[0]
  end

  def self.log_beta_fn(a, b)
    lgamma(a) + lgamma(b) - lgamma(a + b)
  end

  # Beta(a, b) density on [0, 1] pu, with its limits at the walls.
  def self.beta_pdf(x, a, b, log_b = log_beta_fn(a, b))
    return wall_limit(a, b, log_b) if x <= 0.0
    return wall_limit(b, a, log_b) if x >= 1.0

    Math.exp((a - 1.0) * Math.log(x) + (b - 1.0) * Math.log(1.0 - x) - log_b)
  end

  # Density at a wall: infinite when the near shape parameter is below 1,
  # zero above 1, and 1 / B(a, b) when it equals 1.
  def self.wall_limit(near, _far, log_b)
    return Float::INFINITY if near < 1.0
    return 0.0 if near > 1.0

    Math.exp(-log_b)
  end

  # Every statistic of one distribution, unrounded: values in pu of capacity,
  # probabilities as fractions. beta: also fit the Beta MLE (and its CVaR).
  def self.statistics(dist, beta: false)
    mu = dist.mean
    sd = dist.sd
    below, above = if sd.positive?
                     [norm_cdf(-mu / sd), norm_cdf((mu - 1.0) / sd)]
                   else
                     [mu.negative? ? 1.0 : 0.0, mu > 1.0 ? 1.0 : 0.0]
                   end
    stats = {
      mean: mu,
      sd: sd,
      p05: dist.quantile(0.05),
      p50: dist.quantile(0.50),
      p95: dist.quantile(0.95),
      q20: (1..20).map { |i| dist.quantile((i - 0.5) / 20.0) },
      cvar05: dist.lower_tail_mean(CVAR_ALPHA),
      cvar95: dist.upper_tail_mean(CVAR_ALPHA),
      at0: dist.atom0,
      atcap: dist.atom1,
      gauss_below: below,
      gauss_above: above,
      gauss_p05: mu - Z95 * sd,
      gauss_cvar05: mu - CVAR_K * sd,
      gauss_cvar95: mu + CVAR_K * sd
    }
    if beta
      fit = fit_beta(dist)
      stats[:beta] = fit
      stats[:beta_cvar05] = fit && beta_cvar_lower(fit[:alpha], fit[:beta], CVAR_ALPHA)
      stats[:beta_cvar95] = fit && beta_cvar_upper(fit[:alpha], fit[:beta], CVAR_ALPHA)
    end
    stats
  end

  # ── Digamma family (the same series as forecast.js) ─────────────────────────

  def self.digamma(x)
    return digamma(x + 1) - 1.0 / x if x < 6

    ix  = 1.0 / x
    ix2 = ix * ix
    Math.log(x) - 0.5 * ix - ix2 * (1.0 / 12 - ix2 * (1.0 / 120 - ix2 / 252))
  end

  def self.trigamma(x)
    return trigamma(x + 1) + 1.0 / (x * x) if x < 6

    ix  = 1.0 / x
    ix2 = ix * ix
    ix + 0.5 * ix2 + ix2 * ix * (1.0 / 6 - ix2 * (1.0 / 30 - ix2 / 42))
  end

  def self.inv_digamma(y)
    x = y >= -2.22 ? Math.exp(y) + 0.5 : -1.0 / (y - 0.5772156649)
    8.times do
      x -= (digamma(x) - y) / trigamma(x)
      x = 1e-8 if x <= 0
    end
    x
  end

  # ── Beta MLE ───────────────────────────────────────────────────────────────

  # Fit Beta(alpha, beta) on [0, 1] pu to the conditioned distribution by
  # maximum likelihood. Returns { alpha:, beta:, iterations:, method:, s1:, s2: }
  # or nil (no maximum found, alpha or beta <= BETA_MIN or > BETA_MAX).
  def self.fit_beta(dist)
    # x~ at one point (all mass at or beyond one clip value): no maximum.
    at_lo = dist.cdf(BETA_CLIP)
    return nil if dist.mass_between(BETA_CLIP, 1.0 - BETA_CLIP) <= 0.0 && (at_lo <= 1e-12 || at_lo >= 1.0 - 1e-12)

    s1, s2 = dist.log_moments(BETA_CLIP)
    # Starting point: the moment estimate (as forecast.js).
    mu = dist.mean.clamp(0.005, 0.995)
    c0 = mu * (1.0 - mu) / [dist.variance, 1e-8].max - 1.0
    c0 = 1.0 if c0 <= 0
    a0 = mu * c0
    b0 = (1.0 - mu) * c0
    fit = beta_newton(s1, s2, a0, b0) || beta_fixed_point(s1, s2, a0, b0)
    return nil unless fit && fit[:alpha].finite? && fit[:beta].finite?
    return nil if fit[:alpha] <= BETA_MIN || fit[:beta] <= BETA_MIN
    return nil if fit[:alpha] > BETA_MAX || fit[:beta] > BETA_MAX

    fit.merge(s1: s1, s2: s2)
  end

  # [l(a, b), size of its terms] for l = (a - 1) s1 + (b - 1) s2 - ln B(a, b).
  def self.beta_loglik(a, b, s1, s2)
    la  = lgamma(a)
    lb  = lgamma(b)
    lab = lgamma(a + b)
    t1  = (a - 1.0) * s1
    t2  = (b - 1.0) * s2
    [t1 + t2 - (la + lb - lab), 1.0 + t1.abs + t2.abs + la.abs + lb.abs + lab.abs]
  end

  # Newton's method on l(a, b). l is strictly concave, so -H is positive
  # definite and the Newton step is an ascent direction. Returns nil when it
  # does not converge.
  def self.beta_newton(s1, s2, a, b)
    ll, scale = beta_loglik(a, b, s1, s2)
    NEWTON_MAX_ITER.times do |it|
      pab = digamma(a + b)
      tab = trigamma(a + b)
      ga  = s1 - digamma(a) + pab
      gb  = s2 - digamma(b) + pab
      haa = tab - trigamma(a)
      hbb = tab - trigamma(b)
      det = haa * hbb - tab * tab
      return nil unless det.finite? && det.positive? && haa.negative?

      da  = (tab * gb - hbb * ga) / det # d = -H^-1 g
      db  = (tab * ga - haa * gb) / det
      dec = ga * da + gb * db
      return nil unless dec.finite?
      return { alpha: a, beta: b, iterations: it, method: 'newton' } if dec < NEWTON_DEC_TOL

      t = 1.0
      an = bn = lln = scn = nil
      loop do
        an = a + t * da
        bn = b + t * db
        if an.positive? && bn.positive?
          lln, scn = beta_loglik(an, bn, s1, s2)
          break if lln.finite? && lln >= ll + NEWTON_ARMIJO * t * dec - NEWTON_ROUNDING * scale
        end
        t *= 0.5
        return nil if t < NEWTON_MIN_STEP
      end
      step = [(an - a).abs / an, (bn - b).abs / bn].max
      a = an
      b = bn
      return nil if a > BETA_MAX || b > BETA_MAX # heading to infinity: no maximum
      return { alpha: a, beta: b, iterations: it + 1, method: 'newton' } if step < NEWTON_TOL

      ll = lln
      scale = scn
    end
    nil
  end

  # Minka's fixed point, psi(a) = psi(a + b) + s1 and psi(b) = psi(a + b) + s2,
  # run to a relative step of FIXED_POINT_TOL (the fallback).
  def self.beta_fixed_point(s1, s2, a, b)
    FIXED_POINT_MAX_ITER.times do |it|
      pab = digamma(a + b)
      an  = inv_digamma(pab + s1)
      bn  = inv_digamma(pab + s2)
      return nil unless an.finite? && bn.finite? && an.positive? && bn.positive?

      step = [(an - a).abs / an, (bn - b).abs / bn].max
      a = an
      b = bn
      return nil if a > BETA_MAX || b > BETA_MAX
      return { alpha: a, beta: b, iterations: it + 1, method: 'fixed_point' } if step < FIXED_POINT_TOL
    end
    nil
  end

  # ── Regularized incomplete beta and Beta CVaR ───────────────────────────────

  # The continued fraction of I_x(a, b) (DLMF 8.17.22): I_x(a, b) = x^a (1 - x)^b / (a B(a, b)) / F, where
  # F = 1 + t1 / (1 + t2 / (1 + t3 / ...)) with the terms
  #   t(2k + 1) = -(a + k)(a + b + k) x / ((a + 2k)(a + 2k + 1)),   t(2k) = k (b - k) x / ((a + 2k - 1)(a + 2k)),
  # evaluated forward by the modified Lentz method (Thompson and Barnett, J. Comput. Phys. 64, 1986). Returns 1 / F.
  # The same steps as betaCF in assets/js/forecast.js.
  def self.betacf(a, b, x)
    tiny = BETACF_FPMIN
    f = 1.0
    num = 1.0
    den = 0.0
    (1..(2 * BETACF_MAX_ITER)).each do |j|
      k = j >> 1
      t = if j.odd?
            -(a + k) * (a + b + k) * x / ((a + 2 * k) * (a + 2 * k + 1))
          else
            k * (b - k) * x / ((a + 2 * k - 1) * (a + 2 * k))
          end
      den = 1.0 + t * den
      den = tiny if den.abs < tiny
      num = 1.0 + t / num
      num = tiny if num.abs < tiny
      den = 1.0 / den
      ratio = num * den
      f *= ratio
      break if (ratio - 1.0).abs <= BETACF_EPS
    end
    1.0 / f
  end

  # Regularized incomplete beta function I_x(a, b) = P(X <= x), X ~ Beta(a, b).
  def self.beta_inc(a, b, x)
    return 0.0 if x <= 0.0
    return 1.0 if x >= 1.0

    bt = Math.exp(a * Math.log(x) + b * Math.log(1.0 - x) - log_beta_fn(a, b))
    if x < (a + 1.0) / (a + b + 2.0)
      bt * betacf(a, b, x) / a
    else
      1.0 - bt * betacf(b, a, 1.0 - x) / b
    end
  end

  # Quantile of Beta(a, b): the x with I_x(a, b) = p. Halley's method inside
  # a bracket that always holds the root, with bisection when a step leaves it.
  def self.beta_quantile(p, a, b)
    return 0.0 if p <= 0.0
    return 1.0 if p >= 1.0

    x = beta_quantile_guess(p, a, b)
    lo = 0.0
    hi = 1.0
    log_b = log_beta_fn(a, b)
    BETA_Q_MAX_ITER.times do
      err = beta_inc(a, b, x) - p
      return x if err.zero?

      if err.negative?
        lo = x
      else
        hi = x
      end
      pdf = Math.exp((a - 1.0) * Math.log(x) + (b - 1.0) * Math.log(1.0 - x) - log_b)
      xn = nil
      if pdf.finite? && pdf.positive?
        u = err / pdf
        corr = [1.0, u * ((a - 1.0) / x - (b - 1.0) / (1.0 - x))].min
        step = u / (1.0 - 0.5 * corr)
        xn = x - step if step.finite?
      end
      xn = 0.5 * (lo + hi) unless xn && xn > lo && xn < hi
      return xn if (xn - x).abs <= BETA_Q_TOL * xn || hi - lo <= BETA_Q_TOL * hi

      x = xn
    end
    x
  end

  # Starting value for beta_quantile, as betaQuantileGuess in forecast.js: in each tail the leading term of the
  # series of I_x(a, b) (DLMF 8.17.7) gives I_x ~ x^a / (a B(a, b)) near 0 and 1 - I_x ~ (1 - x)^b / (b B(a, b))
  # near 1; between them the mean a / (a + b).
  def self.beta_quantile_guess(p, a, b)
    lb = log_beta_fn(a, b)
    mean = a / (a + b)
    lo = Math.exp((Math.log(p) + Math.log(a) + lb) / a)
    hi = 1.0 - Math.exp((Math.log(1.0 - p) + Math.log(b) + lb) / b)
    x = if lo < mean then lo
        elsif hi > mean then hi
        else mean
        end
    x.finite? && x.positive? && x < 1.0 ? x : 0.5
  end

  # Mean of the lowest alpha of Beta(a, b) on [0, 1]:
  # (1/alpha) * E[X; X <= q] = (1/alpha) * a/(a+b) * I_q(a+1, b), q = Q(alpha).
  def self.beta_cvar_lower(a, b, alpha)
    q = beta_quantile(alpha, a, b)
    a / (a + b) * beta_inc(a + 1.0, b, q) / alpha
  end

  # Mean of the highest alpha of Beta(a, b) on [0, 1]: 1 - X ~ Beta(b, a), so
  # it is 1 minus the lower-tail mean of Beta(b, a). Working near 0 keeps the
  # quantile representable when it lies within 1e-16 of 1.
  def self.beta_cvar_upper(a, b, alpha)
    1.0 - beta_cvar_lower(b, a, alpha)
  end
end
