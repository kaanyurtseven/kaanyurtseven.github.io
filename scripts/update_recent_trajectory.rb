#!/usr/bin/env ruby
# Rebuild the recent 7-day trajectory in wind.json/solar.json from the local
# recent-trajectory accumulators (wind_recent_acc.json, solar_recent_acc.json).
# Preserves all histogram/cond_quantiles data; only updates recent + meta dates.
#
# Usage: ruby scripts/update_recent_trajectory.rb

require 'json'
require 'date'

OUT_DIR     = File.join(__dir__, '..', 'assets', 'data')
RECENT_DAYS = 7

FORECAST_FIELDS = {
  'dayahead11h' => 'dayahead11hforecast',
  'dayahead6pm' => 'dayaheadforecast',
  'mostrecent'  => 'mostrecentforecast'
}.freeze

def normalise_grid(val)
  return nil unless val
  val.strip.upcase == 'DSO' ? 'Dso' : val.strip
end

def build_recent(rows, group_key_fn)
  by_slot = {}
  rows.each do |row|
    dt = row['datetime']&.strip
    next unless dt
    qk = dt[0, 16]                  # "YYYY-MM-DDTHH:MM"
    gk = group_key_fn.call(row)
    next unless gk
    by_slot[gk]     ||= {}
    by_slot[gk][qk] ||= {}
    (['measured', 'monitoredcapacity'] + FORECAST_FIELDS.values).each do |field|
      v = row[field]
      v = v.is_a?(Numeric) ? v.to_f : v&.to_f
      next unless v
      by_slot[gk][qk][field] ||= [0.0, 0]
      by_slot[gk][qk][field][0] += v
      by_slot[gk][qk][field][1] += 1
    end
  end

  result = {}
  by_slot.each do |gk, by_time|
    ts    = by_time.keys.sort
    entry = { 'timestamps' => ts }
    (['measured'] + FORECAST_FIELDS.values).each do |field|
      entry[field] = ts.map do |t|
        pair = by_time[t][field]
        pair && pair[1] > 0 ? (pair[0] / pair[1]).round(2) : nil
      end
    end
    result[gk] = entry
  end
  result
end

today        = Date.today
recent_start = today - RECENT_DAYS
recent_end   = today

puts "Recent window: #{recent_start} → #{recent_end}"

[
  {
    acc:   File.join(OUT_DIR, 'wind_recent_acc.json'),
    out:   File.join(OUT_DIR, 'wind.json'),
    label: 'WIND',
    key_fn: lambda { |row|
      oo   = row['offshoreonshore']&.strip
      reg  = row['region']&.strip
      grid = normalise_grid(row['gridconnectiontype'])
      next nil if oo.nil? || reg.nil? || grid.nil?
      "#{oo}|#{reg}|#{grid}"
    }
  },
  {
    acc:   File.join(OUT_DIR, 'solar_recent_acc.json'),
    out:   File.join(OUT_DIR, 'solar.json'),
    label: 'SOLAR',
    key_fn: lambda { |row| row['region']&.strip }
  }
].each do |cfg|
  puts "\n=== #{cfg[:label]} ==="

  acc  = JSON.parse(File.read(cfg[:acc]))
  rows = (acc['rows'] || []).select do |r|
    dt = r['datetime']&.strip
    next false unless dt
    date_str = dt[0, 10]
    date_str >= recent_start.to_s && date_str <= recent_end.to_s
  end
  puts "  Rows in window: #{rows.length}"

  recent_data = build_recent(rows, cfg[:key_fn])
  puts "  Groups found: #{recent_data.keys.sort.join(', ')}"

  out = JSON.parse(File.read(cfg[:out]))
  out['meta']['recent_start'] = recent_start.to_s
  out['meta']['recent_end']   = recent_end.to_s
  out['meta']['generated']    = Time.now.utc.strftime('%Y-%m-%dT%H:%M UTC')

  out['groups'].each do |gk, g|
    if recent_data[gk]
      cap = g['capacity'].to_f
      rec = recent_data[gk]
      # Clamp all numeric trajectory values to [0, capacity] — mirrors process_tech step 6
      if cap > 0
        (['measured'] + FORECAST_FIELDS.values).each do |field|
          arr = rec[field]
          next unless arr.is_a?(Array)
          arr.map! { |v| v.is_a?(Numeric) ? v.clamp(0, cap) : v }
        end
      end
      g['recent'] = rec
      puts "  #{gk}: #{g['recent']['timestamps']&.length || 0} slots"
    else
      puts "  WARNING: no recent data for #{gk}"
    end
  end

  File.write(cfg[:out], JSON.generate(out))
  puts "  Written #{cfg[:out]} (#{(File.size(cfg[:out]) / 1024.0).round(1)} KB)"
end

puts "\nDone."
