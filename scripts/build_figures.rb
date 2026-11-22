#!/usr/bin/env ruby
# frozen_string_literal: true

# Build the figure data in _data/figures/ (site.data.figures in Liquid; no JS
# library):
#
#   _data/figures/offshore_da11.json  statistics per forecast bin (bins), per
#     pair of bins (ridges25), for five pooled ranges (pools5) and at the
#     latest quarter-hour (latest), with density paths in one frame (Frame).
#     Statistics come from scripts/lib/conditioning.rb.
#   _data/figures/tools_fx.json       the Tools page's figure (what the explorer
#     shows at a 96 % forecast) and the Tools list's glyph (at 80 %), as SVG
#     strings (module ToolsFx below).
#
# Both from group Offshore|Federal|Elia, forecast dayahead11h (Elia's day-ahead
# forecast issued at 11:00), in assets/data/wind.json.
#
# Usage: ruby scripts/build_figures.rb [--input PATH] [--output PATH]
#                                      [--tools-output PATH] [--force]
# (--tools-output defaults to tools_fx.json beside --output.)
#
# Exits non-zero with a message on missing or malformed input and never
# leaves a partial file (writes a temp file, then renames it); both outputs
# are computed before either is written. When only meta.generated would
# change, an existing file is left as it is (--force rewrites it anyway).
# Ruby standard library only; Ruby 3.3 compatible.

require 'date'
require 'fileutils'
require 'json'
require 'optparse'
require 'yaml'
require_relative 'lib/conditioning'

module BuildFigures
  ROOT        = File.expand_path('..', __dir__)
  INPUT       = File.join(ROOT, 'assets', 'data', 'wind.json')
  OUTPUT      = File.join(ROOT, '_data', 'figures', 'offshore_da11.json')
  TOOLS_FILE  = 'tools_fx.json' # written beside OUTPUT (ToolsFx)
  GROUP       = 'Offshore|Federal|Elia'
  FORECAST    = 'dayahead11h'
  FIELD       = 'dayahead11hforecast'
  SOURCE      = 'Elia Open Data, ODS031, CC BY 4.0'
  SOURCE_URL  = 'https://opendata.elia.be/explore/dataset/ods031/'
  LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/'
  SCHEMA      = 1
  BIN_COUNT   = 50
  BIN_WIDTH   = 0.02
  MAX_BYTES   = 60_000
  # pools5: inclusive forecast-bin ranges for 0-10%, 20-30%, 44-56%, 70-80%
  # and 90-100% of capacity (5, 5, 6, 5 and 5 bins).
  POOLS = [[0, 4], [10, 14], [22, 27], [35, 39], [45, 49]].freeze
  UNITS = 'MW values are integers rounded to 1 MW. at0, atcap and gauss_below/above/outside are ' \
          'fractions of 1 with 4 decimals. lo, hi and half_width are per unit (pu) of capacity. ' \
          'beta is Beta(alpha, beta) on [0, capacity]. Paths use the frame below.'

  class Error < StandardError; end

  # One normalized frame for every path: x 0..1200 is -0.10..1.10 pu of
  # capacity (0 MW at x 100, capacity at x 1100); y 0..100 is density 0 up to
  # the block's own continuous peak (atoms excluded), y pointing up.
  # Coordinates are rounded to 0.1.
  module Frame
    PU_MIN = -0.10
    PU_MAX = 1.10
    WIDTH  = 1200
    HEIGHT = 100
    TOL    = 2.5 # largest vertical error of a curve path, in tenths (0.25 units)
    Y_CAP  = 999.9 # curves taller than about 10x the peak are cut here
    # Gaussian curves are sampled a little past the frame (x -50 to 1250), so
    # that figures showing slightly more than -0.10..1.10 pu still get a curve.
    GAUSS_PU = [-0.15, 1.15].freeze

    module_function

    def x(pu)
      (pu - PU_MIN) * WIDTH / (PU_MAX - PU_MIN)
    end

    # Value in integer tenths of a frame unit.
    def tenths(value)
      (value * 10).round
    end

    def num(tenth)
      (tenth % 10).zero? ? (tenth / 10).to_s : format('%.1f', tenth / 10.0)
    end

    # Stepped outline of a piecewise-constant density: starts on the baseline
    # at the 0 MW wall (x 100), ends on the baseline at the capacity wall
    # (x 1100). steps: [[x0_pu, x1_pu, density], ...] sorted, non-overlapping.
    # Returns nil when there is no continuous density to draw.
    def step_path(steps, peak)
      return nil unless peak.positive?

      wall0 = tenths(x(0.0))
      wall1 = tenths(x(1.0))
      out   = +"M#{num(wall0)} 0"
      cur_x = wall0
      cur_y = 0
      pend  = nil
      flush = lambda do
        if pend && pend > cur_x
          out << "H#{num(pend)}"
          cur_x = pend
        end
        pend = nil
      end
      steps.each do |x0, x1, density|
        a = tenths(x(x0))
        b = tenths(x(x1))
        y = tenths(HEIGHT * density / peak)
        next unless b > a

        if a > (pend || cur_x)
          unless cur_y.zero?
            flush.call
            out << 'V0'
            cur_y = 0
          end
          pend = a
        end
        unless y == cur_y
          flush.call
          out << "V#{num(y)}"
          cur_y = y
        end
        pend = b
      end
      unless cur_y.zero?
        flush.call
        out << 'V0'
      end
      pend = wall1 if (pend || cur_x) < wall1
      flush.call
      out
    end

    # Polyline of a density curve sampled between pu_from and pu_to: a 0.02 pu
    # grid plus anchors, refined where the chord misses the curve by more than
    # TOL, then thinned (Ramer-Douglas-Peucker on vertical distance). The
    # polyline is trimmed to where the curve is visible (y >= 0.1) and always
    # starts and ends on the baseline, so appending "Z" closes it as an area.
    # Returns nil when nothing is visible.
    def curve_path(pu_from, pu_to, peak, anchors = [], &density)
      return nil unless peak.positive?

      f = lambda do |pu|
        v = HEIGHT * density.call(pu) / peak
        v.nan? ? 0.0 : [v, Y_CAP].min
      end
      grid = ((pu_from * 50).ceil..(pu_to * 50).floor).map { |i| i / 50.0 }
      xs   = (grid + anchors + [pu_from, pu_to]).select { |p| p >= pu_from && p <= pu_to }.uniq.sort
      pts  = xs.map { |p| [p, f.call(p)] }
      dense = [pts.first]
      pts.each_cons(2) do |(a, ya), (b, yb)|
        refine(a, ya, b, yb, f, dense, 0)
        dense << [b, yb]
      end
      frame = dense.map { |p, v| [tenths(x(p)), tenths(v)] }.chunk_while { |p, q| p == q }.map(&:first)
      first = frame.index { |_, y| y.positive? }
      return nil unless first

      last = frame.rindex { |_, y| y.positive? }
      frame = frame[[first - 1, 0].max..[last + 1, frame.size - 1].min]
      frame.unshift([frame[0][0], 0]) if frame[0][1].positive?
      frame.push([frame[-1][0], 0]) if frame[-1][1].positive?
      kept = thin(frame)
      "M#{num(kept[0][0])} #{num(kept[0][1])}L" + kept.drop(1).map { |px, py| "#{num(px)} #{num(py)}" }.join(' ')
    end

    def refine(a, ya, b, yb, f, out, depth)
      return if depth >= 12 || (b - a) < 0.001

      m  = (a + b) / 2.0
      ym = f.call(m)
      return if (ym - (ya + yb) / 2.0).abs * 10 <= TOL

      refine(a, ya, m, ym, f, out, depth + 1)
      out << [m, ym]
      refine(m, ym, b, yb, f, out, depth + 1)
    end

    def thin(pts)
      return pts if pts.size <= 2

      keep = Array.new(pts.size, false)
      keep[0] = keep[-1] = true
      stack = [[0, pts.size - 1]]
      until stack.empty?
        i, j = stack.pop
        next if j <= i + 1

        x0, y0 = pts[i]
        x1, y1 = pts[j]
        best = nil
        best_d = TOL
        (i + 1...j).each do |k|
          xk, yk = pts[k]
          line = x1 == x0 ? y0 : y0 + (y1 - y0) * (xk - x0).fdiv(x1 - x0)
          d = (yk - line).abs
          if d > best_d
            best = k
            best_d = d
          end
        end
        next unless best

        keep[best] = true
        stack << [i, best] << [best, j]
      end
      pts.select.with_index { |_, k| keep[k] }
    end
  end

  # ── The Tools figure and the Tools list's glyph ────────────────────────────
  #
  # Draws the distribution of measured output at one forecast level between
  # its two walls (0 MW and installed capacity) and, on the figure, the
  # Gaussian with the same mean and standard deviation, dashed, with its part
  # past capacity filled.
  #
  # The window is the explorer's (Conditioning.window_select: +-0.04 pu around
  # the level, widened by 0.02 until n >= 500). Unlike Conditioning.window,
  # each error cell weighs by its count, is shifted by the level, spread
  # uniformly over its 0.02 pu and drawn on a grid of its own (25 cells for
  # the glyph, 50 for the figure); the mass past a wall is that wall's atom;
  # the moments are those of the unclipped shifted errors (each cell at its
  # center). Nothing random. The figure's <title> is not in the output:
  # Liquid fills _data/tools.yml explorer.figure.title with level_pct and
  # gauss_above_pct and prints it between figure_open and figure_body.
  module ToolsFx
    FIG_LEVEL   = 0.96 # the Tools page's figure
    GLYPH_LEVEL = 0.80 # the Tools list's glyph
    FIG_CELLS   = 50
    GLYPH_CELLS = 25

    module_function

    # x rounded half to even on its exact binary value, to nd decimals.
    def py_round(x, nd = 0)
      q = (x.to_r * 10**nd).round(half: :even)
      nd.zero? ? q : Rational(q, 10**nd).to_f
    end

    # x to one decimal, rounded half to even on its exact binary value. Not
    # format('%.1f'): on Windows Ruby's sprintf rounds a 15-digit decimal
    # (450.8500000000003 gives "450.8").
    def f1(x)
      q = (x.to_r * 10).round(half: :even)
      neg = q.negative? || (q.zero? && (x.negative? || (x.zero? && (1.0 / x).negative?)))
      d = q.abs.to_s.rjust(2, '0')
      "#{'-' if neg}#{d[0..-2]}.#{d[-1]}"
    end

    # Histogram of measured output at forecast level f (pu) on nb cells, the
    # wall atoms, and the mean and sd of the unclipped shifted errors.
    def measured(input, f, nb)
      sel, n, bw = Conditioning.window_select(input[:bins], f)
      hmin = input[:grid].min
      hw   = input[:grid].width
      h    = Array.new(nb, 0.0)
      at0 = atc = tot = s1 = s2 = 0.0
      sel.each do |b|
        b['hist_counts'].each_with_index do |c, k|
          next if c.zero?

          e0 = hmin + k * hw
          mc = f + e0 + hw / 2
          s1 += c * mc
          s2 += c * mc * mc
          tot += c
          m0 = f + e0
          m1 = f + e0 + hw
          if m1 <= 0
            at0 += c
            next
          end
          if m0 >= 1
            atc += c
            next
          end
          if m0 < 0
            at0 += c * (0 - m0) / hw
            m0 = 0.0
          end
          if m1 > 1
            atc += c * (m1 - 1) / hw
            m1 = 1.0
          end
          ([(m0 * nb).floor, 0].max...[(m1 * nb).ceil, nb].min).each do |j|
            ov = [m1, (j + 1).fdiv(nb)].min - [m0, j.fdiv(nb)].max
            h[j] += c * ov / hw if ov > 0
          end
        end
      end
      raise Error, "no data in the window at #{f} pu" unless tot.positive?

      mu = s1 / tot
      sd = Math.sqrt([s2 / tot - mu * mu, 1e-12].max)
      { n: n, bw: bw, dens: h.map { |v| v / tot * nb }, at0: at0 / tot, atc: atc / tot, mu: mu, sd: sd }
    end

    def phi(u, mu, sd)
      Math.exp(-0.5 * ((u - mu) / sd)**2) / (sd * Math.sqrt(2 * Math::PI))
    end

    def gauss_above(mu, sd)
      0.5 * Math.erfc((1 - mu) / (sd * Math.sqrt(2)))
    end

    def area_path(dens, xf, yf, nb, yb)
      p = +"M#{f1(xf.call(0))} #{f1(yb)}"
      dens.each_with_index { |d, j| p << "V#{f1(yf.call(d))}H#{f1(xf.call((j + 1).fdiv(nb)))}" }
      p << "V#{f1(yb)}Z"
    end

    # The Tools list's glyph, 72 x 44.
    def glyph(r, w = 72, h = 44, pad = 2)
      nb  = r[:dens].size
      top = r[:dens].max
      x0 = pad + 0.5
      x1 = w - pad - 0.5
      yb = h - pad - 0.5
      yt = pad + 2
      xf = ->(u) { x0 + (x1 - x0) * u }
      yf = ->(d) { yb - (yb - yt) * d / top }
      %(<svg class="fx-glyph" viewBox="0 0 #{w} #{h}" width="#{w}" height="#{h}" aria-hidden="true" focusable="false">) +
        %(<path class="fx-mass" d="#{area_path(r[:dens], xf, yf, nb, yb)}"/>) +
        %(<path class="fx-base" d="M0 #{f1(yb)}H#{w}"/>) +
        %(<path class="fx-wall" d="M#{f1(x0)} #{f1(yb)}V#{f1(pad - 0.5)}M#{f1(x1)} #{f1(yb)}V#{f1(pad - 0.5)}"/></svg>)
    end

    # The Tools page's figure, viewBox 600 x 220: [the <svg> start tag, the
    # rest after the <title>, the walls' places in percent of the width].
    def figure(r, w = 600, h = 220)
      nb  = r[:dens].size
      mu  = r[:mu]
      sd  = r[:sd]
      top = [r[:dens].max, phi(mu, mu, sd)].max
      padl = 16
      padr = 72 # room right of the wall for the Gaussian's whole spill
      padt = 12
      padb = 10
      x0 = padl + 0.5
      x1 = w - padr - 0.5
      yb = h - padb - 0.5
      yt = padt
      xf = ->(u) { x0 + (x1 - x0) * u }
      yf = ->(d) { yb - (yb - yt) * d / top }
      stop = 1 + (padr - 4) / (x1 - x0)
      pts = []
      u = -0.02
      while u <= stop
        pts << [xf.call(u), yf.call(phi(u, mu, sd))]
        u += 0.005
      end
      # only where the curve stands off the baseline (at zero density it would
      # draw the axis dashed), one point either side; y is compared in tenths,
      # rounded half to even as f1 prints it
      base = (yb.to_r * 10).round(half: :even)
      off  = pts.each_index.select { |i| (pts[i][1].to_r * 10).round(half: :even) < base }
      raise Error, 'the Gaussian never leaves the baseline' if off.empty?

      pts = pts[[off[0] - 1, 0].max...(off[-1] + 2)]
      q = pts.each_with_index.map { |(x, y), i| "#{i.zero? ? 'M' : 'L'}#{f1(x)} #{f1(y)}" }
      # the Gaussian's part past the capacity wall, filled
      sp = ["M#{f1(xf.call(1))} #{f1(yb)}"]
      u = 1.0
      while u <= stop
        sp << "L#{f1(xf.call(u))} #{f1(yf.call(phi(u, mu, sd)))}"
        u += 0.005
      end
      sp << "L#{f1(xf.call(u - 0.005))} #{f1(yb)}Z"
      open = %(<svg class="fx-figure" viewBox="0 0 #{w} #{h}" role="img" aria-labelledby="fx-fig-t">)
      body = %(<path class="fx-spill" d="#{sp.join}"/>) +
             %(<path class="fx-mass" d="#{area_path(r[:dens], xf, yf, nb, yb)}"/>) +
             %(<path class="fx-gauss" d="#{q.join}"/>) +
             %(<path class="fx-base" d="M0 #{f1(yb)}H#{w}"/>) +
             %(<path class="fx-wall" d="M#{f1(x0)} #{f1(yb + 6)}V#{f1(padt - 4)}M#{f1(x1)} #{f1(yb + 6)}V#{f1(padt - 4)}"/></svg>)
      [open, body, [py_round(x0 / w * 100, 2), py_round(x1 / w * 100, 2)]]
    end

    def build(input, now: Time.now)
      fig = measured(input, FIG_LEVEL, FIG_CELLS)
      raise Error, 'the figure\'s window must lie within capacity' unless FIG_LEVEL + fig[:bw] <= 1 + 1e-9

      open, body, walls = figure(fig)
      gen = input[:generated] # YYYY-MM-DDTHH:MMZ
      {
        'meta' => {
          'schema' => SCHEMA,
          'generated' => BuildFigures.iso_utc(now),
          'data_generated' => gen,
          'data_generated_iso' => gen.sub(/Z\z/, ':00Z'),
          'data_date' => gen[0, 10],
          'group' => GROUP,
          'forecast' => FORECAST
        },
        'level_pct' => py_round(FIG_LEVEL * 100),
        'gauss_above_pct' => py_round(gauss_above(fig[:mu], fig[:sd]) * 100),
        'n' => fig[:n],
        'window_pu' => py_round(fig[:bw], 2),
        'walls_pct' => walls,
        'tick_right_pct' => (100 - walls[1]).round(2),
        'glyph' => glyph(measured(input, GLYPH_LEVEL, GLYPH_CELLS)),
        'figure_open' => open,
        'figure_body' => body
      }
    end
  end

  module_function

  # ── Input ──────────────────────────────────────────────────────────────────

  def load(path)
    raise Error, "input not found: #{path}" unless File.file?(path)

    JSON.parse(File.read(path, encoding: 'UTF-8'))
  rescue JSON::ParserError => e
    raise Error, "input is not valid JSON (#{path}): #{e.message.lines.first.to_s.strip[0, 160]}"
  end

  def check(condition, message)
    raise Error, "malformed input: #{message}" unless condition
  end

  def numeric?(v)
    v.is_a?(Numeric) && v.to_f.finite?
  end

  # Returns the parts the build needs, or raises Error.
  def validate(data)
    check(data.is_a?(Hash), 'top level is not an object')
    meta = data['meta']
    check(meta.is_a?(Hash), 'meta missing')
    generated = meta['generated'].to_s.match(/\A(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}) UTC\z/)
    check(generated, "meta.generated is not 'YYYY-MM-DDTHH:MM UTC' (#{meta['generated'].inspect})")
    %w[hist_start hist_end].each do |k|
      check(meta[k].to_s.match?(/\A\d{4}-\d{2}-\d{2}\z/), "meta.#{k} is not YYYY-MM-DD")
    end
    check(numeric?(meta['hist_min']) && numeric?(meta['hist_max']) && meta['hist_n_bins'].is_a?(Integer),
          'meta.hist_min, hist_max or hist_n_bins missing')
    grid = begin
      Conditioning::ErrorGrid.new(meta['hist_min'], meta['hist_max'], meta['hist_n_bins'])
    rescue ArgumentError => e
      raise Error, "malformed input: #{e.message}"
    end

    group = data.dig('groups', GROUP)
    check(group.is_a?(Hash), "group #{GROUP} missing")
    capacity = group['capacity']
    check(numeric?(capacity) && capacity.positive?, "#{GROUP} capacity missing or not positive")
    bins = group.dig('cond_quantiles', FORECAST)
    check(bins.is_a?(Array) && bins.size == BIN_COUNT, "cond_quantiles.#{FORECAST} is not #{BIN_COUNT} bins")
    bins.each_with_index do |bin, i|
      where = "cond_quantiles.#{FORECAST}[#{i}]"
      check(bin.is_a?(Hash), "#{where} is not an object")
      check(numeric?(bin['lo']) && numeric?(bin['hi']) && bin['hi'] > bin['lo'], "#{where} lo/hi")
      check((bin['lo'] - i * BIN_WIDTH).abs < 1e-6, "#{where}.lo is not #{(i * BIN_WIDTH).round(2)}")
      check(bin['n'].is_a?(Integer) && !bin['n'].negative?, "#{where}.n")
      counts = bin['hist_counts']
      check(counts.is_a?(Array) && counts.size == grid.count, "#{where}.hist_counts is not #{grid.count} counts")
      check(counts.all? { |c| c.is_a?(Integer) && !c.negative? }, "#{where}.hist_counts holds a non-count")
      check(counts.sum <= bin['n'], "#{where}.hist_counts sum exceeds n")
    end
    check(bins.sum { |b| b['n'] }.positive?, 'no historical data in any bin')

    { meta: meta, generated: "#{generated[1]}T#{generated[2]}Z", grid: grid,
      capacity: capacity.to_f, bins: bins, recent: group['recent'] }
  end

  # ── Output helpers ─────────────────────────────────────────────────────────

  def mw(pu, capacity)
    (pu * capacity).round
  end

  def frac(p)
    p.round(4)
  end

  def iso_utc(time)
    time.utc.strftime('%Y-%m-%dT%H:%MZ')
  end

  # EU rule: UTC+2 from 01:00 UTC on the last Sunday of March to 01:00 UTC on
  # the last Sunday of October, otherwise UTC+1.
  def brussels(time_utc)
    y     = time_utc.year
    start = Time.utc(y, 3, last_sunday(y, 3), 1)
    stop  = Time.utc(y, 10, last_sunday(y, 10), 1)
    hours = time_utc >= start && time_utc < stop ? 2 : 1
    local = time_utc + hours * 3600
    [local.strftime('%Y-%m-%dT%H:%M') + format('+%02d:00', hours), hours == 2 ? 'CEST' : 'CET']
  end

  def last_sunday(year, month)
    d = Date.new(year, month, -1)
    (d - d.wday).day
  end

  def range_fields(lo, hi, capacity)
    { 'lo' => lo.round(2), 'hi' => hi.round(2), 'lo_mw' => mw(lo, capacity), 'hi_mw' => mw(hi, capacity) }
  end

  # Nominal forecast range of bins[first..last] in pu (the last pipeline bin
  # ends at 1.01 so that forecasts at exactly capacity are included).
  def nominal_range(bins, first, last)
    [bins[first]['lo'].to_f, [bins[last]['hi'].to_f, 1.0].min]
  end

  STAT_KEYS = %w[mean sd p05 p50 p95 cvar05 cvar95 at0 atcap gauss_below gauss_above].freeze
  FRAC_KEYS = %w[at0 atcap gauss_below gauss_above].freeze

  def stat_fields(stats, capacity, keys = STAT_KEYS)
    keys.to_h do |k|
      v = stats.fetch(k.to_sym)
      [k, FRAC_KEYS.include?(k) ? frac(v) : mw(v, capacity)]
    end
  end

  # fit_beta returns nil when the likelihood has no maximum it can reach (or
  # alpha or beta <= 0.01), so a fit that is printed is always converged.
  def beta_fields(beta, label)
    warn "build_figures: warning: no Beta fit for #{label}" unless beta
    beta && { 'alpha' => beta[:alpha].round(3), 'beta' => beta[:beta].round(3) }
  end

  def gauss_path(stats, peak)
    mu = stats[:mean]
    sd = stats[:sd]
    return nil unless sd.positive?

    anchors = [0.0, 1.0] + (-3..3).map { |k| mu + k * sd }
    Frame.curve_path(*Frame::GAUSS_PU, peak, anchors) { |pu| Conditioning.gauss_pdf(pu, mu, sd) }
  end

  def beta_path(beta, peak)
    return nil unless beta

    a = beta[:alpha]
    b = beta[:beta]
    log_b = Conditioning.log_beta_fn(a, b)
    anchors = a > 1 && b > 1 ? [(a - 1) / (a + b - 2)] : []
    Frame.curve_path(0.0, 1.0, peak, anchors) { |pu| Conditioning.beta_pdf(pu, a, b, log_b) }
  end

  # ── Blocks ─────────────────────────────────────────────────────────────────

  def bins_block(input)
    cap = input[:capacity]
    input[:bins].each_index.map do |i|
      lo, hi = nominal_range(input[:bins], i, i)
      mid = mw((lo + hi) / 2.0, cap)
      entry = range_fields(lo, hi, cap).merge('mid_mw' => mid)
      dist, n = Conditioning.pool(input[:bins], [i], input[:grid])
      next entry.merge('n' => 0) unless dist

      stats = Conditioning.statistics(dist)
      fields = stat_fields(stats, cap)
      g05 = mw(stats[:gauss_p05], cap)
      gcv = mw(stats[:gauss_cvar05], cap)
      entry.merge('n' => n).merge(fields).merge(
        'gauss_p05' => g05,
        'gauss_cvar05' => gcv,
        'q20' => stats[:q20].map { |q| mw(q, cap) },
        'reserve' => {
          'p05' => { 'data' => mid - fields['p05'], 'gauss' => mid - g05 },
          'cvar05' => { 'data' => mid - fields['cvar05'], 'gauss' => mid - gcv }
        }
      )
    end
  end

  def ridges_block(input)
    cap = input[:capacity]
    (0...BIN_COUNT / 2).map do |k|
      first = 2 * k
      lo, hi = nominal_range(input[:bins], first, first + 1)
      entry = range_fields(lo, hi, cap)
      dist, n = Conditioning.pool(input[:bins], [first, first + 1], input[:grid])
      next entry.merge('n' => 0) unless dist

      stats = Conditioning.statistics(dist)
      peak  = dist.peak_density
      entry.merge('n' => n).merge(stat_fields(stats, cap)).merge(
        'paths' => { 'step' => Frame.step_path(dist.steps, peak), 'gauss' => gauss_path(stats, peak) }
      ).merge('_gauss_above' => stats[:gauss_above])
    end
  end

  def pools_block(input)
    cap = input[:capacity]
    edges = (0..BIN_COUNT).map { |k| k * BIN_WIDTH }
    POOLS.map do |first, last|
      lo, hi = nominal_range(input[:bins], first, last)
      entry = range_fields(lo, hi, cap)
      dist, n = Conditioning.pool(input[:bins], (first..last).to_a, input[:grid])
      next entry.merge('n' => 0) unless dist

      stats = Conditioning.statistics(dist, beta: true)
      hist  = edges.each_cons(2).map { |e0, e1| [e0, e1, dist.mass_between(e0, e1) / (e1 - e0)] }
      peak  = hist.map(&:last).max
      entry.merge('n' => n).merge(stat_fields(stats, cap)).merge(
        'gauss_outside' => frac(stats[:gauss_below] + stats[:gauss_above]),
        'beta' => beta_fields(stats[:beta], "pools5 #{lo.round(2)}-#{hi.round(2)}"),
        'paths' => {
          'hist' => Frame.step_path(hist, peak),
          'gauss' => gauss_path(stats, peak),
          'beta' => beta_path(stats[:beta], peak)
        }
      )
    end
  end

  # Latest quarter-hour with both a DA11 forecast and a measurement.
  def latest_block(input)
    recent = input[:recent]
    return [nil, 'recent trajectory missing'] unless recent.is_a?(Hash)

    ts = recent['timestamps']
    fc = recent[FIELD]
    ms = recent['measured']
    unless [ts, fc, ms].all?(Array) && ts.size == fc.size && ts.size == ms.size
      return [nil, "recent.timestamps, #{FIELD} and measured are missing or of unequal length"]
    end

    idx = (ts.size - 1).downto(0).find { |i| numeric?(fc[i]) && numeric?(ms[i]) }
    return [nil, 'no quarter-hour has both a forecast and a measurement'] unless idx

    stamp = ts[idx].to_s.match(/\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})\z/)
    raise Error, "malformed input: recent.timestamps[#{idx}] is #{ts[idx].inspect}" unless stamp

    cap  = input[:capacity]
    time = Time.utc(*stamp.captures.map(&:to_i))
    f_pu = fc[idx].to_f / cap
    dist, info = Conditioning.window(input[:bins], f_pu, input[:grid])
    return [nil, 'window mode found no bins'] unless dist

    stats = Conditioning.statistics(dist, beta: true)
    peak  = dist.peak_density
    bin   = input[:bins].index { |b| f_pu >= b['lo'] && f_pu < b['hi'] } || (f_pu.negative? ? 0 : BIN_COUNT - 1)
    local, tz = brussels(time)
    block = {
      'ts_utc' => iso_utc(time),
      'ts_brussels' => local,
      'tz' => tz,
      'forecast' => fc[idx].round,
      'measured' => ms[idx].round,
      'bin' => bin,
      'ridge' => bin / 2,
      'n' => info[:n],
      'window' => {
        'half_width' => info[:half_width].round(2),
        'lo_mw' => mw(info[:lo], cap),
        'hi_mw' => mw(info[:hi], cap),
        'bins' => info[:bins_used]
      }
    }.merge(stat_fields(stats, cap)).merge(
      'gauss_p05' => mw(stats[:gauss_p05], cap),
      'gauss_cvar05' => mw(stats[:gauss_cvar05], cap),
      'q20' => stats[:q20].map { |q| mw(q, cap) },
      'beta' => beta_fields(stats[:beta], 'latest'),
      'paths' => {
        'step' => Frame.step_path(dist.steps, peak),
        'gauss' => gauss_path(stats, peak),
        'beta' => beta_path(stats[:beta], peak)
      }
    )
    [block, nil]
  end

  # ── Document ───────────────────────────────────────────────────────────────

  def build(input, now: Time.now)
    bins   = bins_block(input)
    ridges = ridges_block(input)
    leaks  = ridges.map { |r| r.delete('_gauss_above') }
    best   = ridges.each_index.select { |k| ridges[k]['n'] >= 1000 }.max_by { |k| [leaks[k], -k] }
    latest, why = latest_block(input)
    warn "build_figures: warning: latest is null (#{why})" unless latest
    meta = input[:meta]
    {
      'meta' => {
        'schema' => SCHEMA,
        'generated' => iso_utc(now),
        'data_generated' => input[:generated],
        'hist_start' => meta['hist_start'],
        'hist_end' => meta['hist_end'],
        'group' => GROUP,
        'forecast' => FORECAST,
        'capacity' => input[:capacity].round,
        'n_total' => input[:bins].sum { |b| b['n'] },
        'bin_width_pu' => BIN_WIDTH,
        'source' => SOURCE,
        'source_url' => SOURCE_URL,
        'licence_url' => LICENCE_URL,
        'frame' => { 'width' => Frame::WIDTH, 'height' => Frame::HEIGHT, 'pu' => [Frame::PU_MIN, Frame::PU_MAX] },
        'units' => UNITS
      },
      'defaults' => { 'ridge' => best },
      'latest' => latest,
      'bins' => bins,
      'ridges25' => ridges,
      'pools5' => pools_block(input)
    }
  end

  # Compact JSON with one block per line and one array entry per line, so a
  # data refresh shows up in git diffs entry by entry.
  def render(doc)
    lines = ['{']
    doc.each_with_index do |(key, value), i|
      comma = i < doc.size - 1 ? ',' : ''
      if value.is_a?(Array) && value.first.is_a?(Hash)
        lines << "#{JSON.generate(key)}:["
        value.each_with_index { |e, j| lines << JSON.generate(e) + (j < value.size - 1 ? ',' : '') }
        lines << "]#{comma}"
      else
        lines << "#{JSON.generate(key)}:#{JSON.generate(value)}#{comma}"
      end
    end
    lines << '}'
    "#{lines.join("\n")}\n"
  end

  def without_generated(doc)
    return nil unless doc.is_a?(Hash) && doc['meta'].is_a?(Hash)

    doc.merge('meta' => doc['meta'].reject { |k, _| k == 'generated' })
  end

  def write(text, output, force:)
    parsed = JSON.parse(text)
    # Jekyll 3 reads _data/*.json with SafeYAML: the text must mean the same as YAML.
    raise Error, 'output does not round-trip through YAML' unless YAML.safe_load(text) == parsed
    raise Error, "output is #{text.bytesize} bytes, over the #{MAX_BYTES}-byte budget" if text.bytesize > MAX_BYTES

    if !force && File.file?(output)
      old = begin
        JSON.parse(File.read(output, encoding: 'UTF-8'))
      rescue JSON::ParserError
        nil
      end
      return :unchanged if without_generated(old) == without_generated(parsed)
    end

    FileUtils.mkdir_p(File.dirname(output))
    tmp = "#{output}.tmp-#{Process.pid}"
    begin
      File.binwrite(tmp, text)
      File.rename(tmp, output)
    ensure
      File.delete(tmp) if File.exist?(tmp)
    end
    :written
  end

  def main(argv)
    opts = { input: INPUT, output: OUTPUT, tools_output: nil, force: false }
    OptionParser.new do |o|
      o.banner = 'Usage: ruby scripts/build_figures.rb [--input PATH] [--output PATH] [--tools-output PATH] [--force]'
      o.on('--input PATH', "wind.json to read (default #{INPUT.sub("#{ROOT}/", '')})") { |v| opts[:input] = v }
      o.on('--output PATH', "JSON to write (default #{OUTPUT.sub("#{ROOT}/", '')})") { |v| opts[:output] = v }
      o.on('--tools-output PATH', "the Tools figure's JSON (default #{TOOLS_FILE} beside --output)") { |v| opts[:tools_output] = v }
      o.on('--force', 'write even when only meta.generated would change') { opts[:force] = true }
    end.parse!(argv)
    raise Error, "unexpected argument: #{argv.first}" unless argv.empty?

    opts[:tools_output] ||= File.join(File.dirname(opts[:output]), TOOLS_FILE)
    input = validate(load(opts[:input]))
    now   = Time.now
    # both documents are built before either is written
    texts = [[render(build(input, now: now)), opts[:output]],
             [render(ToolsFx.build(input, now: now)), opts[:tools_output]]]
    texts.each do |text, output|
      result = write(text, output, force: opts[:force])
      verb   = result == :written ? 'wrote' : 'unchanged:'
      puts "build_figures: #{verb} #{output} (#{text.bytesize} bytes, data as of #{input[:generated]})"
    end
    0
  rescue Error, OptionParser::ParseError, SystemCallError => e
    # SystemCallError: the input or output path cannot be read or written
    # (the temp file is removed and any previous output is left as it was).
    warn "build_figures: error: #{e.message}"
    1
  end
end

exit(BuildFigures.main(ARGV)) if $PROGRAM_NAME == __FILE__
