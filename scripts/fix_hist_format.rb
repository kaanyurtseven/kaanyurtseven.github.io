#!/usr/bin/env ruby
# One-off conversion: measured_pu accumulator → error_pu histograms.
#
# The locally-stored wind_acc.json / solar_acc.json contain measured_pu values
# bucketed into 50 conditioning bins of 0.02 pu each (version 5 accumulator).
# This script converts them to error_pu = measured_pu - bin_center_pu and
# rewrites wind.json / solar.json with hist_min=-0.5, hist_max=+0.5.
#
# The existing recent trajectory in the JSON files is preserved as-is.
#
# Usage: ruby scripts/fix_hist_format.rb

require 'json'

OUT_DIR   = File.join(__dir__, '..', 'assets', 'data')
HIST_MIN  = -1.0
HIST_MAX  =  1.0
HIST_N    = 100     # 100 bins × 0.02 pu, covers full physical range
HIST_W    = (HIST_MAX - HIST_MIN).to_f / HIST_N

COND_N    = 50
COND_W    = 0.02
COND_BINS = (0...COND_N).map { |i| [(i * COND_W).round(3), ((i + 1) * COND_W).round(3)] }
                         .tap { |b| b[-1][1] = 1.01 }

def histogram(error_vals)
  counts = Array.new(HIST_N, 0)
  error_vals.each do |err|
    idx = ((err - HIST_MIN) / HIST_W).floor
    next if idx < 0 || idx >= HIST_N   # exclude out-of-range; no boundary clamping
    counts[idx] += 1
  end
  counts
end

def convert(acc_path, out_path, label)
  puts "\n=== #{label} ==="

  acc = JSON.parse(File.read(acc_path))
  puts "  Accumulator version: #{acc['version']}, days: #{acc['days'].length}"

  # Merge all days into { gk => { ft => [[measured_pu ...] * COND_N] } }
  merged = {}
  acc['days'].each do |day|
    (day['groups'] || {}).each do |gk, by_type|
      merged[gk] ||= {}
      by_type.each do |ft, bins|
        merged[gk][ft] ||= Array.new(COND_N) { [] }
        bins.each_with_index do |vals, i|
          merged[gk][ft][i].concat(vals) if vals && i < COND_N
        end
      end
    end
  end

  # Compute error histograms per conditioning bin
  cond_quantiles = {}
  merged.each do |gk, by_type|
    cond_quantiles[gk] = {}
    by_type.each do |ft, bins_array|
      cond_quantiles[gk][ft] = bins_array.each_with_index.map do |m_vals, i|
        bin_center = (i + 0.5) * COND_W
        err_vals   = m_vals.map { |m| m - bin_center }
        {
          'lo'          => COND_BINS[i][0],
          'hi'          => COND_BINS[i][1].round(2),
          'n'           => m_vals.length,
          'hist_counts' => histogram(err_vals)
        }
      end
    end
  end

  # Load existing output JSON (preserve recent trajectory + capacity)
  out = JSON.parse(File.read(out_path))

  # Update meta
  out['meta']['hist_min']    = HIST_MIN
  out['meta']['hist_max']    = HIST_MAX
  out['meta']['hist_n_bins'] = HIST_N
  out['meta']['bins']        = COND_BINS

  # Update cond_quantiles per group
  out['groups'].each do |gk, g|
    if cond_quantiles[gk]
      g['cond_quantiles'] = cond_quantiles[gk]
      puts "  #{gk}: updated"
    else
      puts "  #{gk}: WARNING — no accumulator data"
    end
  end

  File.write(out_path, JSON.generate(out))
  puts "  Written #{out_path} (#{(File.size(out_path) / 1024.0).round(1)} KB)"
end

convert(
  File.join(OUT_DIR, 'wind_acc.json'),
  File.join(OUT_DIR, 'wind.json'),
  'WIND'
)

convert(
  File.join(OUT_DIR, 'solar_acc.json'),
  File.join(OUT_DIR, 'solar.json'),
  'SOLAR'
)

puts "\nDone."
