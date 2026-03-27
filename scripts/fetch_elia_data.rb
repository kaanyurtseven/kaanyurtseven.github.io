#!/usr/bin/env ruby
# Fetch Elia Open Data for the Uncertainty Explorer on kaanyurtseven.github.io.
#
# Architecture — rolling 3-year FIFO:
#   Accumulator files (wind_acc.json, solar_acc.json) store per-day per-bin
#   pu_error arrays. Each daily run:
#     1. If no accumulator: fetch HIST_DAYS (3 years) from scratch.
#     2. If accumulator exists: fetch only the gap since the last recorded day
#        (capped at MAX_GAP_DAYS to avoid enormous catch-up fetches).
#     3. Append new day-buckets, drop days older than HIST_DAYS.
#     4. Recompute quantile structure from accumulated errors.
#     5. Write output JSON (wind.json, solar.json) + updated accumulator.
#
# Accumulator JSON schema:
#   {
#     "version": 2,
#     "days": [
#       {
#         "date": "2026-03-24",
#         "groups": {
#           "Onshore|Flanders|Elia": {
#             "dayahead11h": [[bin0_err1, ...], [bin1_err1, ...], ...20 bins],
#             ...
#           }
#         }
#       }
#     ]
#   }
#
# Output JSON schema (unchanged — same as before):
#   { meta: {...}, groups: { "GroupKey": { capacity, recent, cond_quantiles } } }
#
# Usage: ruby scripts/fetch_elia_data.rb
#        ELIA_API_KEY=<token> ruby scripts/fetch_elia_data.rb

require 'net/http'
require 'uri'
require 'json'
require 'date'
require 'fileutils'

# ── Configuration ─────────────────────────────────────────────────────────────

HIST_DAYS         = 1095    # 3-year rolling window
RECENT_DAYS       = 7       # days of recent trajectory shown in chart
MAX_GAP_DAYS      = 14      # maximum days to fetch in a single catch-up run
BASE_URL          = 'https://opendata.elia.be/api/explore/v2.1/catalog/datasets'
OUT_DIR           = File.join(__dir__, '..', 'assets', 'data')
ACC_VERSION       = 2
RECENT_ACC_VERSION = 1      # version for the recent-trajectory accumulator

# Per-unit bins (forecast level): 20 fine bins of width 0.05 pu.
BINS = (0...20).map { |i| [i * 0.05, (i + 1) * 0.05].map { |v| v.round(3) } }
               .tap { |b| b[-1][1] = 1.01 }.freeze

# Quantile probability levels stored in output JSON
Q_PROBS = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95].freeze

# Forecast type label → API field name
FORECAST_TYPES = {
  'dayahead11h' => 'dayahead11hforecast',
  'dayahead6pm' => 'dayaheadforecast',
  'mostrecent'  => 'mostrecentforecast'
}.freeze

WIND_HIST_SELECT   = 'datetime,measured,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,offshoreonshore,region,gridconnectiontype'
WIND_RECENT_SELECT = 'datetime,realtime,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,offshoreonshore,region,gridconnectiontype'
SOLAR_HIST_SELECT   = 'datetime,measured,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,region'
SOLAR_RECENT_SELECT = 'datetime,realtime,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,region'

FileUtils.mkdir_p(OUT_DIR)

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def api_headers
  key = ENV['ELIA_API_KEY']
  h = { 'Accept' => 'application/json' }
  h['Authorization'] = "Apikey #{key}" if key && !key.empty?
  h
end

def export_url(dataset, where:, select:, order_by: nil, timezone: 'UTC')
  params = { 'where' => where, 'select' => select, 'timezone' => timezone, 'limit' => '-1' }
  params['order_by'] = order_by if order_by
  uri = URI("#{BASE_URL}/#{dataset}/exports/json")
  uri.query = URI.encode_www_form(params)
  uri
end

def fetch_json(uri, attempt: 1, max_attempts: 3)
  resp = Net::HTTP.start(uri.hostname, uri.port,
                         use_ssl: uri.scheme == 'https',
                         open_timeout: 60, read_timeout: 360) do |http|
    req = Net::HTTP::Get.new(uri)
    api_headers.each { |k, v| req[k] = v }
    http.request(req)
  end

  case resp.code
  when '200' then JSON.parse(resp.body)
  when '301','302','303','307','308'
    fetch_json(URI(resp['Location']), attempt: attempt, max_attempts: max_attempts)
  else
    raise "HTTP #{resp.code} for #{uri}"
  end
rescue => e
  raise if attempt >= max_attempts
  wait = 2 ** attempt
  warn "  Attempt #{attempt} failed (#{e.message}), retrying in #{wait}s…"
  sleep wait
  fetch_json(uri, attempt: attempt + 1, max_attempts: max_attempts)
end

# ── Date helpers ──────────────────────────────────────────────────────────────

def quarter_key(dt_str)
  m = dt_str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)
  m ? m[1] : nil
end

def day_key(dt_str)
  m = dt_str.match(/^(\d{4}-\d{2}-\d{2})/)
  m ? m[1] : nil
end

# ── Data helpers ──────────────────────────────────────────────────────────────

def normalise_grid(val)
  return nil if val.nil?
  val.strip.upcase == 'DSO' ? 'Dso' : val.strip
end

def find_bin(pu)
  BINS.each_with_index { |(lo, hi), i| return i if pu >= lo && pu < hi }
  nil
end

def percentile(sorted, p)
  n = sorted.length
  return nil if n.zero?
  return sorted[0]  if p <= 0.0
  return sorted[-1] if p >= 1.0
  idx = p * (n - 1)
  lo, hi = idx.floor, idx.ceil
  lo == hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo])
end

# Accumulate historical API rows into a per-day, per-group, per-bin structure.
# Returns: { "2026-03-24" => { "GroupKey" => { "dayahead11h" => [[errs...] * 20 bins], ... } } }
def rows_to_day_buckets(rows, group_key_fn)
  days = {}

  rows.each do |row|
    dt = row['datetime']&.strip
    next unless dt
    dk = day_key(dt)
    next unless dk
    gk = group_key_fn.call(row)
    next unless gk

    cap = row['monitoredcapacity']
    cap = cap.is_a?(Numeric) ? cap.to_f : cap&.to_f
    next unless cap && cap >= 10.0

    m = row['measured']
    m = m.is_a?(Numeric) ? m.to_f : m&.to_f
    next unless m

    days[dk]       ||= {}
    days[dk][gk]   ||= {}

    FORECAST_TYPES.each do |label, api_field|
      f = row[api_field]
      f = f.is_a?(Numeric) ? f.to_f : f&.to_f
      next unless f

      f_pu  = f / cap
      bin_i = find_bin(f_pu)
      next unless bin_i

      pu_err = (m - f) / cap

      days[dk][gk][label]         ||= Array.new(BINS.length) { [] }
      days[dk][gk][label][bin_i]  << pu_err.round(5)
    end
  end

  days
end

# Merge per-day buckets into a flat per-group, per-forecast-type, per-bin error accumulator.
# Returns: { "GroupKey" => { "dayahead11h" => [[sorted_errs] * 20 bins], ... } }
def merge_days(day_list)
  acc = {}

  day_list.each do |day_entry|
    (day_entry['groups'] || {}).each do |gk, by_type|
      acc[gk] ||= {}
      by_type.each do |label, bins_array|
        acc[gk][label] ||= Array.new(BINS.length) { [] }
        bins_array.each_with_index do |errs, i|
          acc[gk][label][i].concat(errs) if errs && !errs.empty?
        end
      end
    end
  end

  # Sort each bin's error array for percentile computation
  acc.each_value do |by_type|
    by_type.each_value do |bins_array|
      bins_array.each { |errs| errs.sort! }
    end
  end

  acc
end

def compute_quantiles_from_acc(acc)
  acc.transform_values do |by_type|
    by_type.transform_values do |bins_array|
      bins_array.each_with_index.map do |sorted, i|
        {
          'lo' => BINS[i][0],
          'hi' => BINS[i][1].round(2),
          'n'  => sorted.length,
          'q'  => Q_PROBS.map { |p| sorted.empty? ? nil : percentile(sorted, p).round(5) }
        }
      end
    end
  end
end

# Median capacity across all days for each group
def median_capacity_from_rows(rows, group_key_fn)
  cap_acc = {}
  rows.each do |row|
    gk = group_key_fn.call(row)
    next unless gk
    cap = row['monitoredcapacity']
    cap = cap.is_a?(Numeric) ? cap.to_f : cap&.to_f
    next unless cap && cap >= 10.0
    cap_acc[gk] ||= []
    cap_acc[gk] << cap
  end
  cap_acc.transform_values do |vals|
    s = vals.sort
    s[s.length / 2].round(1)
  end
end

# Build recent 15-min trajectory from raw API rows.
def build_recent(rows, group_key_fn)
  by_slot = {}

  rows.each do |row|
    dt = row['datetime']&.strip
    next unless dt
    qk = quarter_key(dt)
    next unless qk
    gk = group_key_fn.call(row)
    next unless gk

    by_slot[gk]     ||= {}
    by_slot[gk][qk] ||= {}

    all_fields = ['measured', 'monitoredcapacity'] + FORECAST_TYPES.values
    all_fields.each do |field|
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
    ts = by_time.keys.sort
    entry = { 'timestamps' => ts }
    all_fields = ['measured'] + FORECAST_TYPES.values
    all_fields.each do |field|
      entry[field] = ts.map do |t|
        pair = by_time[t][field]
        pair && pair[1] > 0 ? (pair[0] / pair[1]).round(2) : nil
      end
    end
    result[gk] = entry
  end
  result
end

# ── Accumulator helpers ───────────────────────────────────────────────────────

def load_acc(path)
  return nil unless File.exist?(path)
  data = JSON.parse(File.read(path))
  return nil unless data['version'] == ACC_VERSION
  data
rescue
  nil
end

def save_acc(path, days)
  File.write(path, JSON.generate({ 'version' => ACC_VERSION, 'days' => days }))
end

# Prune days older than cutoff_date from the list
def prune_days(days, cutoff_date)
  cutoff = cutoff_date.to_s
  days.select { |d| d['date'] >= cutoff }
end

# Convert rows_to_day_buckets output into accumulator day entries
def day_buckets_to_acc_entries(day_buckets)
  day_buckets.map do |date, groups|
    {
      'date'   => date,
      'groups' => groups.transform_values do |by_type|
        by_type.transform_values { |bins| bins }
      end
    }
  end.sort_by { |e| e['date'] }
end

# ── Recent-trajectory accumulator helpers ─────────────────────────────────────
#
# Stores 15-min measured slots fetched from ODS086/ODS087 so they survive
# after Elia removes them from the real-time API (typically after ~2 days).
# Schema: { "version": 1, "rows": [ <normalised row hashes> ... ] }

def load_recent_acc(path)
  return { 'version' => RECENT_ACC_VERSION, 'rows' => [] } unless File.exist?(path)
  data = JSON.parse(File.read(path))
  return { 'version' => RECENT_ACC_VERSION, 'rows' => [] } unless data['version'] == RECENT_ACC_VERSION
  data
rescue
  { 'version' => RECENT_ACC_VERSION, 'rows' => [] }
end

def save_recent_acc(path, acc)
  File.write(path, JSON.generate(acc))
end

# Upsert rt_rows (already with measured, not realtime) into the accumulator.
# Deduplicates by (group_key, quarter_key); only stores rows with a measured value.
def upsert_recent_acc(acc, rt_rows, group_key_fn)
  existing = {}
  acc['rows'].each do |r|
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    existing["#{gk}|#{qk}"] = true if gk && qk
  end
  rt_rows.each do |r|
    next unless r['measured']
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    next unless gk && qk
    next if existing["#{gk}|#{qk}"]
    acc['rows'] << r
    existing["#{gk}|#{qk}"] = true
  end
end

# Remove slots older than cutoff_str (inclusive lower bound, e.g. "2026-03-19")
def prune_recent_acc(acc, cutoff_str)
  acc['rows'].select! do |r|
    qk = quarter_key(r['datetime']&.strip || '')
    qk && qk >= cutoff_str
  end
end

# ── Date window ───────────────────────────────────────────────────────────────

today        = Date.today
hist_end     = today - 1
hist_start   = today - 1 - HIST_DAYS
recent_end   = today          # include today's intraday data (refreshed every 30 min)
recent_start = today - RECENT_DAYS

recent_where = "datetime >= '#{recent_start}' AND datetime < '#{recent_end + 1}'"

puts "Today:           #{today}"
puts "Historical range: #{hist_start} → #{hist_end}"
puts "Recent range:     #{recent_start} → #{recent_end}"

# ── Process one technology ────────────────────────────────────────────────────

def process_tech(tech_name, dataset, hist_select, recent_select, group_key_fn,
                 acc_path, out_path, source_label,
                 hist_start, hist_end, recent_start, recent_end, recent_where,
                 recent_dataset: nil, recent_acc_path: nil)

  puts "\n=== #{tech_name.upcase} (#{dataset.upcase}) ==="

  # ── Step 1: load or build accumulator ──────────────────────────────────────

  acc = load_acc(acc_path)

  if acc.nil?
    puts "  No accumulator found — performing full #{HIST_DAYS}-day historical fetch…"
    hist_where = "datetime >= '#{hist_start}' AND datetime <= '#{hist_end}'"
    print "  Fetching… "
    $stdout.flush
    hist_rows = fetch_json(export_url(dataset, where: hist_where, select: hist_select))
    puts "#{hist_rows.length} rows"

    day_buckets   = rows_to_day_buckets(hist_rows, group_key_fn)
    acc_days      = day_buckets_to_acc_entries(day_buckets)
    cap_from_rows = median_capacity_from_rows(hist_rows, group_key_fn)
    puts "  Groups: #{cap_from_rows.keys.sort.join(', ')}"
  else
    # Determine gap
    existing_dates = acc['days'].map { |d| d['date'] }.sort
    last_date      = existing_dates.last ? Date.parse(existing_dates.last) : hist_start
    gap_start      = last_date + 1
    gap_end        = hist_end

    if gap_start > gap_end
      puts "  Accumulator is up to date (last date: #{last_date})."
      acc_days      = acc['days']
      cap_from_rows = nil
    else
      fetch_days = [gap_end - gap_start + 1, MAX_GAP_DAYS].min
      actual_gap_start = gap_end - fetch_days + 1
      puts "  Accumulator up to #{last_date}. Fetching #{actual_gap_start} → #{gap_end} (#{fetch_days} days)…"
      gap_where = "datetime >= '#{actual_gap_start}' AND datetime <= '#{gap_end}'"
      print "  Fetching… "
      $stdout.flush
      gap_rows = fetch_json(export_url(dataset, where: gap_where, select: hist_select))
      puts "#{gap_rows.length} rows"

      new_buckets = rows_to_day_buckets(gap_rows, group_key_fn)
      new_entries = day_buckets_to_acc_entries(new_buckets)
      acc_days    = acc['days'] + new_entries
      cap_from_rows = median_capacity_from_rows(gap_rows, group_key_fn)
    end
  end

  # ── Step 2: prune old days ──────────────────────────────────────────────────

  cutoff   = hist_start
  acc_days = prune_days(acc_days, cutoff)
  puts "  Accumulator: #{acc_days.length} day-buckets (cutoff: #{cutoff})"

  # ── Step 3: compute quantiles from accumulator ─────────────────────────────

  merged    = merge_days(acc_days)
  quantiles = compute_quantiles_from_acc(merged)
  puts "  Groups in quantiles: #{quantiles.keys.sort.join(', ')}"

  # ── Step 4: capacity — use latest available from accumulator ───────────────

  # Derive capacity from latest day in accumulator that has any data
  capacity_map = {}
  if cap_from_rows && !cap_from_rows.empty?
    capacity_map = cap_from_rows
  else
    # Reconstruct from accumulator: not stored directly; use bin counts to infer
    # groups. Capacity is not stored in the accumulator — carry it forward from
    # the merged quantile groups (we'll derive it from recent fetch below).
    capacity_map = {}
  end

  # ── Step 5: fetch recent trajectory ────────────────────────────────────────
  #
  # Three-layer merge strategy:
  #   Layer 1 — ODS031/ODS032 (official, validated, ~48 h lag). Highest priority.
  #   Layer 2 — recent_acc (accumulated from ODS086/ODS087 on every 30-min run).
  #             Fills gaps for days not yet in ODS031.
  #   Layer 3 — live ODS086/ODS087 query. Today's new measured slots are upserted
  #             into recent_acc and will persist even after Elia removes them.
  #
  # Merge rule: ODS031 wins over acc for any slot both have.

  puts "  Fetching recent #{RECENT_DAYS}-day trajectory…"

  # Layer 1: fetch from historical dataset
  hist_recent_rows = fetch_json(export_url(dataset, where: recent_where,
                                            select: hist_select, order_by: 'datetime ASC'))
  puts "  Recent rows (#{dataset}): #{hist_recent_rows.length}"

  # Layer 3: fetch live real-time rows and accumulate
  if recent_dataset && recent_acc_path
    rt_raw = fetch_json(export_url(recent_dataset, where: recent_where,
                                    select: recent_select, order_by: 'datetime ASC'))
    # Keep only rows with a measured (realtime) value — drop future forecast-only slots
    rt_raw.select! { |r| r['realtime'] != nil }
    # Normalise 'realtime' → 'measured'
    rt_raw.each { |r| r['measured'] = r.delete('realtime') if r.key?('realtime') }
    puts "  Recent rows (#{recent_dataset}, measured only): #{rt_raw.length}"

    # Load, upsert, prune, and save the recent accumulator
    recent_acc = load_recent_acc(recent_acc_path)
    upsert_recent_acc(recent_acc, rt_raw, group_key_fn)
    prune_recent_acc(recent_acc, recent_start.to_s)
    save_recent_acc(recent_acc_path, recent_acc)
    puts "  Recent acc: #{recent_acc['rows'].length} cached slots"
  else
    recent_acc = { 'version' => RECENT_ACC_VERSION, 'rows' => [] }
  end

  # Build (gk|qk) index of ODS031 rows — these take precedence
  hist_index = {}
  hist_recent_rows.each do |r|
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    hist_index["#{gk}|#{qk}"] = true if gk && qk
  end

  # Layer 2: add acc rows for slots not covered by ODS031
  gap_rows = recent_acc['rows'].reject do |r|
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    hist_index["#{gk}|#{qk}"]
  end
  puts "  Gap rows from acc (not in #{dataset}): #{gap_rows.length}"

  recent_rows = hist_recent_rows + gap_rows

  recent_data = build_recent(recent_rows, group_key_fn)

  # Fill capacity from recent rows if not available from hist fetch
  if capacity_map.empty?
    capacity_map = median_capacity_from_rows(recent_rows, group_key_fn)
  end

  # ── Step 6: assemble output JSON ───────────────────────────────────────────

  all_keys = (quantiles.keys | recent_data.keys).uniq
  groups   = {}
  all_keys.each do |gk|
    cap    = capacity_map[gk]
    recent = recent_data[gk]
    # Clamp all numeric values in recent trajectory to [0, capacity]
    if recent && cap && cap > 0
      (['measured'] + FORECAST_TYPES.values).each do |field|
        arr = recent[field]
        next unless arr.is_a?(Array)
        arr.map! { |v| v.is_a?(Numeric) ? v.clamp(0, cap) : v }
      end
    end
    groups[gk] = {
      'capacity'       => cap,
      'recent'         => recent,
      'cond_quantiles' => quantiles[gk]
    }
  end

  out_json = {
    'meta' => {
      'generated'      => Time.now.utc.strftime('%Y-%m-%dT%H:%M UTC'),
      'hist_start'     => hist_start.to_s,
      'hist_end'       => hist_end.to_s,
      'recent_start'   => recent_start.to_s,
      'recent_end'     => recent_end.to_s,
      'bins'           => BINS,
      'quantile_probs' => Q_PROBS,
      'source'         => source_label,
      'unit'           => 'MW'
    },
    'groups' => groups
  }

  # ── Step 7: write output and accumulator ───────────────────────────────────

  File.write(out_path, JSON.generate(out_json))
  puts "  Written #{out_path} (#{(File.size(out_path) / 1024.0).round(1)} KB)"

  save_acc(acc_path, acc_days)
  puts "  Written #{acc_path} (#{(File.size(acc_path) / 1024.0).round(1)} KB)"
end

# ── Wind group key ────────────────────────────────────────────────────────────

wind_group_fn = lambda do |row|
  oo   = row['offshoreonshore']&.strip
  reg  = row['region']&.strip
  grid = normalise_grid(row['gridconnectiontype'])
  return nil if oo.nil? || reg.nil? || grid.nil?
  "#{oo}|#{reg}|#{grid}"
end

solar_group_fn = lambda { |row| row['region']&.strip }

# ── Run ───────────────────────────────────────────────────────────────────────

process_tech(
  'Wind', 'ods031',
  WIND_HIST_SELECT, WIND_RECENT_SELECT,
  wind_group_fn,
  File.join(OUT_DIR, 'wind_acc.json'),
  File.join(OUT_DIR, 'wind.json'),
  'Elia Open Data Platform (ODS031)',
  hist_start, hist_end, recent_start, recent_end, recent_where,
  recent_dataset: 'ods086',
  recent_acc_path: File.join(OUT_DIR, 'wind_recent_acc.json')
)

# Solar: filter night hours from recent data
solar_acc_path = File.join(OUT_DIR, 'solar_acc.json')
solar_out_path = File.join(OUT_DIR, 'solar.json')

process_tech(
  'Solar', 'ods032',
  SOLAR_HIST_SELECT, SOLAR_RECENT_SELECT,
  solar_group_fn,
  solar_acc_path,
  solar_out_path,
  'Elia Open Data Platform (ODS032)',
  hist_start, hist_end, recent_start, recent_end, recent_where,
  recent_dataset: 'ods087',
  recent_acc_path: File.join(OUT_DIR, 'solar_recent_acc.json')
)

# Post-process solar: filter night hours from recent trajectory
solar_data = JSON.parse(File.read(solar_out_path))
solar_data['groups'].each do |_gk, g|
  next unless g['recent']
  ts   = g['recent']['timestamps'] || []
  meas = g['recent']['measured']   || []
  keep = ts.each_index.select do |i|
    m     = meas[i]
    fvals = FORECAST_TYPES.values.map { |f| g['recent'][f]&.[](i) }
    (m && m.abs >= 1.0) || fvals.any? { |v| v && v.abs >= 1.0 }
  end
  g['recent'] = {
    'timestamps' => keep.map { |i| ts[i] }
  }.tap do |r|
    (['measured'] + FORECAST_TYPES.values).each do |field|
      arr = g['recent'][field] || []
      r[field] = keep.map { |i| arr[i] }
    end
  end
end
File.write(solar_out_path, JSON.generate(solar_data))
puts "\n  Solar night-hours filtered. Written #{solar_out_path}"

puts "\nDone."
