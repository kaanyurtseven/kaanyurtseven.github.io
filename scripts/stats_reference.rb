#!/usr/bin/env ruby
# frozen_string_literal: true

# Reference values of the explorer's statistics, computed with
# scripts/lib/conditioning.rb, for the browser parity check
# (scripts/test_stats_parity.py) and the independent numpy check
# (scripts/check_stats_numpy.py).
#
# Usage: ruby scripts/stats_reference.rb --output PATH
#          [--wind PATH] [--solar PATH] [--levels N]
#
# For every group of wind.json and solar.json and every forecast type, the
# forecast levels are 0, capacity, N - 1 levels in between, every level of a
# 1/200 pu scan where the window has to widen (at most 6, spread over the
# scan), and the latest quarter-hour with both a forecast and a measurement.
# Values are unrounded: MW, fractions for at0/atcap, pu for the window.
# Ruby standard library only.

require 'json'
require 'optparse'
require_relative 'lib/conditioning'

module StatsReference
  ROOT   = File.expand_path('..', __dir__)
  FIELDS = { 'dayahead11h' => 'dayahead11hforecast', 'dayahead6pm' => 'dayaheadforecast',
             'mostrecent' => 'mostrecentforecast' }.freeze
  SCAN   = 200
  WIDENED_MAX = 6

  module_function

  def levels(bins, capacity, count, recent, field)
    out = [[0.0, 'zero'], [capacity, 'capacity']]
    (1...count).each { |k| out << [capacity * k / count, 'grid'] }
    widened = (0..SCAN).select { |k| Conditioning.window_select(bins, k.fdiv(SCAN))[2] > Conditioning::BW_START + 1e-9 }
    unless widened.empty?
      pick = WIDENED_MAX >= widened.size ? widened : (0...WIDENED_MAX).map { |i| widened[(i * (widened.size - 1)).fdiv(WIDENED_MAX - 1).round] }
      pick.uniq.each { |k| out << [capacity * k / SCAN, 'widened'] }
    end
    if recent.is_a?(Hash) && recent[field].is_a?(Array) && recent['measured'].is_a?(Array)
      idx = (recent[field].size - 1).downto(0).find { |i| recent[field][i].is_a?(Numeric) && recent['measured'][i].is_a?(Numeric) }
      out << [recent[field][idx].to_f, "latest #{recent['timestamps'][idx]}"] if idx
    end
    out
  end

  def stats_for(bins, grid, capacity, f_mw)
    dist, info = Conditioning.window(bins, f_mw / capacity, grid)
    return nil unless dist

    s = Conditioning.statistics(dist, beta: true)
    beta = s[:beta]
    {
      'n' => info[:n],
      'half_width' => info[:half_width],
      'bins_used' => info[:bins_used],
      'fallback' => info[:fallback],
      'mean' => s[:mean] * capacity,
      'sd' => s[:sd] * capacity,
      'p05' => s[:p05] * capacity,
      'p50' => s[:p50] * capacity,
      'p95' => s[:p95] * capacity,
      'cvar05' => s[:cvar05] * capacity,
      'cvar95' => s[:cvar95] * capacity,
      'at0' => s[:at0],
      'atcap' => s[:atcap],
      'gauss_cvar05' => s[:gauss_cvar05] * capacity,
      'gauss_cvar95' => s[:gauss_cvar95] * capacity,
      'beta' => beta && {
        'alpha' => beta[:alpha], 'beta' => beta[:beta], 's1' => beta[:s1], 's2' => beta[:s2],
        'method' => beta[:method], 'iterations' => beta[:iterations],
        'cvar05' => s[:beta_cvar05] * capacity, 'cvar95' => s[:beta_cvar95] * capacity
      }
    }
  end

  def main(argv)
    opts = { wind: File.join(ROOT, 'assets', 'data', 'wind.json'),
             solar: File.join(ROOT, 'assets', 'data', 'solar.json'), output: nil, levels: 20 }
    OptionParser.new do |o|
      o.banner = 'Usage: ruby scripts/stats_reference.rb --output PATH [--wind PATH] [--solar PATH] [--levels N]'
      o.on('--wind PATH') { |v| opts[:wind] = v }
      o.on('--solar PATH') { |v| opts[:solar] = v }
      o.on('--output PATH') { |v| opts[:output] = v }
      o.on('--levels N', Integer) { |v| opts[:levels] = v }
    end.parse!(argv)
    raise OptionParser::MissingArgument, '--output' unless opts[:output]

    cases = []
    { 'wind' => opts[:wind], 'solar' => opts[:solar] }.each do |tech, path|
      data = JSON.parse(File.read(path, encoding: 'UTF-8'))
      meta = data['meta']
      grid = Conditioning::ErrorGrid.new(meta['hist_min'], meta['hist_max'], meta['hist_n_bins'])
      data['groups'].each do |gk, group|
        capacity = group['capacity'].to_f
        group['cond_quantiles'].each do |ft, bins|
          levels(bins, capacity, opts[:levels], group['recent'], FIELDS[ft]).each do |f_mw, kind|
            cases << { 'tech' => tech, 'group' => gk, 'forecast' => ft, 'fMW' => f_mw, 'kind' => kind,
                       'capacity' => capacity, 'stats' => stats_for(bins, grid, capacity, f_mw) }
          end
        end
      end
    end
    File.write(opts[:output], JSON.generate('generated_by' => 'scripts/stats_reference.rb', 'cases' => cases))
    puts "stats_reference: wrote #{cases.size} cases to #{opts[:output]}"
    0
  rescue OptionParser::ParseError, SystemCallError, JSON::ParserError => e
    warn "stats_reference: error: #{e.message}"
    1
  end
end

exit(StatsReference.main(ARGV)) if $PROGRAM_NAME == __FILE__
