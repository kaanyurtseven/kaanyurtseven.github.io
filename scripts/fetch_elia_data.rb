#!/usr/bin/env ruby
# Fetch Elia Open Data for the Uncertainty Explorer on kaanyurtseven.com.
#
# Datasets (Elia Open Data Platform, Opendatasoft Explore API v2.1):
#   Wind   history ODS031, near-real-time ODS086.
#   Solar  history ODS032 up to 2026-10-25T22:45Z (frozen by Elia), ODS209 from
#          2026-10-25T23:00Z (= 26 Oct 2026 00:00 Brussels); near-real-time
#          ODS210.
#   ODS209/ODS210 publish one row per region and grid connection type (TSO, DSO,
#   Total), name the regions differently from ODS032 and leave out the
#   Flanders/Wallonia aggregates. The solar adapter (solar_rows_from_new) uses
#   each region's Total row (TSO + DSO only when Total is missing) and maps the
#   regions to the 14 legacy (ODS032) groups, so solar.json has the same schema
#   and group keys on both sides of SOLAR_CUTOVER.
#
# Architecture — rolling 3-year FIFO:
#   Accumulator files (wind_acc.json, solar_acc.json) store per-day per-bin
#   pu_error arrays. Each run:
#     1. If no accumulator: fetch HIST_DAYS (3 years) from scratch.
#     2. If accumulator exists: re-fetch the last stored day (its last
#        local-midnight quarter-hours are published a day later) and fetch the
#        missing days after it, oldest first, at most MAX_GAP_DAYS new days per
#        run (a longer outage is caught up over consecutive runs without holes).
#     3. Replace the re-fetched day, append new day-buckets, drop days older
#        than HIST_DAYS.
#     4. Recompute histograms from accumulated errors.
#     5. Write output JSON (wind.json, solar.json) + updated accumulators.
#
# Failure isolation: each technology runs on its own. Its files are written
# only after every request for it has succeeded, so a failing technology leaves
# its files untouched while the others are still written (and committed by CI).
# Exit status: 1 when a technology failed and its output is older than
# STALE_FAIL_HOURS (or of unknown age), else 0.
#
# Accumulator JSON schema:
#   {
#     "version": 3,
#     "days": [
#       {
#         "date": "2026-03-24",
#         "groups": {
#           "Onshore|Flanders|Elia": {
#             "dayahead11h": [[bin0_err1, ...], [bin1_err1, ...], ...50 bins],
#             ...
#           }
#         }
#       }
#     ]
#   }
#
# Output JSON schema:
#   { meta: {...}, groups: { "GroupKey": { capacity, recent, cond_quantiles } } }
#
# Usage: ruby scripts/fetch_elia_data.rb
#        ELIA_API_KEY=<token> ruby scripts/fetch_elia_data.rb
#        ELIA_DATA_DIR=<dir> ruby scripts/fetch_elia_data.rb   # read/write <dir> instead of assets/data

require 'net/http'
require 'uri'
require 'json'
require 'date'
require 'fileutils'
require 'time'

# ── Configuration ─────────────────────────────────────────────────────────────

HIST_DAYS         = 1095    # 3-year rolling window
RECENT_DAYS       = 7       # days of recent trajectory shown in chart
MAX_GAP_DAYS      = 14      # maximum days to fetch in a single catch-up run
STALE_FAIL_HOURS  = 6       # a failed technology fails the run once its output is older than this
BASE_URL          = 'https://opendata.elia.be/api/explore/v2.1/catalog/datasets'
OUT_DIR           = if ENV['ELIA_DATA_DIR'] && !ENV['ELIA_DATA_DIR'].strip.empty?
                      File.expand_path(ENV['ELIA_DATA_DIR'])
                    else
                      File.join(__dir__, '..', 'assets', 'data')
                    end
ACC_VERSION       = 3
RECENT_ACC_VERSION = 1      # version for the recent-trajectory accumulator

# Per-unit bins (forecast level): 50 fine bins of width 0.02 pu.
BINS = (0...50).map { |i| [i * 0.02, (i + 1) * 0.02].map { |v| v.round(3) } }
               .tap { |b| b[-1][1] = 1.01 }.freeze

# Histogram bins for the error_pu distribution shipped to the browser.
# error_pu = (measured - forecast) / capacity, centered at 0.
HIST_MIN    = -1.0
HIST_MAX    =  1.0
HIST_N_BINS = 100     # 100 bins × 0.02 pu, covers full physical range

# Forecast type label → API field name
FORECAST_TYPES = {
  'dayahead11h' => 'dayahead11hforecast',
  'dayahead6pm' => 'dayaheadforecast',
  'mostrecent'  => 'mostrecentforecast'
}.freeze

WIND_HIST_SELECT   = 'datetime,measured,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,offshoreonshore,region,gridconnectiontype'
WIND_RECENT_SELECT = 'datetime,realtime,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,offshoreonshore,region,gridconnectiontype'

# Solar, ODS032 (frozen history up to SOLAR_CUTOVER): already in the legacy shape.
SOLAR_LEGACY_SELECT = 'datetime,measured,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity,region'
# Solar, ODS209 (history) and ODS210 (near-real-time). The measurement is
# `measured_upscaled` in ODS209 and `measured` in ODS210.
SOLAR_HIST_SELECT   = 'datetime,region,gridconnectiontype,measured_upscaled,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity'
SOLAR_RECENT_SELECT = 'datetime,region,gridconnectiontype,measured,dayahead11hforecast,dayaheadforecast,mostrecentforecast,monitoredcapacity'

# ODS032 ends at 2026-10-25T22:45Z; ODS209 starts at SOLAR_CUTOVER. Rows are
# taken from ODS032 strictly before it and from ODS209 from it onward.
SOLAR_CUTOVER          = '2026-10-25T23:00'
SOLAR_LEGACY_LAST_DATE = Date.new(2026, 10, 25)   # UTC date of the last ODS032 quarter-hour

# ODS209/ODS210 region name → legacy (ODS032) group key.
SOLAR_REGION_NAMES = {
  'Antwerpen'      => 'Antwerp',
  'Belgium'        => 'Belgium',
  'BrabantWallon'  => 'Walloon-Brabant',
  'Brussel'        => 'Brussels',
  'Hainaut'        => 'Hainaut',
  'Liege'          => 'Liège',
  'Limburg'        => 'Limburg',
  'Luxembourg'     => 'Luxembourg',
  'Namur'          => 'Namur',
  'OostVlaanderen' => 'East-Flanders',
  'VlaamsBrabant'  => 'Flemish-Brabant',
  'WestVlaanderen' => 'West-Flanders'
}.freeze

# Aggregates that ODS209/ODS210 do not publish, derived as the sums of their
# provinces. In ODS032 the aggregates equal these sums (0.000 MW difference for
# measured, all forecasts and capacity over 26 Sep–25 Oct 2026).
SOLAR_DERIVED_REGIONS = {
  'Flanders' => %w[Antwerp East-Flanders Flemish-Brabant Limburg West-Flanders],
  'Wallonia' => %w[Hainaut Liège Luxembourg Namur Walloon-Brabant]
}.freeze

SOLAR_GROUP_KEYS = (SOLAR_REGION_NAMES.values + SOLAR_DERIVED_REGIONS.keys).sort.freeze
WIND_GROUP_KEYS  = ['Offshore|Federal|Elia', 'Onshore|Flanders|Dso', 'Onshore|Flanders|Elia',
                    'Onshore|Wallonia|Dso', 'Onshore|Wallonia|Elia'].freeze

GRID_TOTAL      = 'Total'
GRID_COMPONENTS = %w[TSO DSO].freeze
# Values carried by a legacy-shaped solar row.
SOLAR_VALUE_FIELDS = (['measured'] + FORECAST_TYPES.values + ['monitoredcapacity']).freeze

# ── Logging ───────────────────────────────────────────────────────────────────

# Hours since an output file's meta.generated ('%Y-%m-%dT%H:%M UTC'); nil when unreadable.
def output_age_hours(path)
  gen = JSON.parse(File.read(path))['meta']['generated'].to_s
  t = Time.strptime(gen, '%Y-%m-%dT%H:%M UTC')
  t = Time.utc(t.year, t.month, t.day, t.hour, t.min)
  (Time.now.utc - t) / 3600.0
rescue StandardError
  nil
end

# GitHub Actions workflow command (shows on the run page even if the job passes).
def gh_annotation(level, title, message)
  return unless ENV['GITHUB_ACTIONS'] == 'true'
  esc = ->(s) { s.to_s.gsub('%', '%25').gsub("\r", '%0D').gsub("\n", '%0A') }
  puts "::#{level} title=#{esc.call(title).gsub(',', '%2C').gsub(':', '%3A')}::#{esc.call(message)}"
end

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
    detail = resp.body.to_s.gsub(/\s+/, ' ')[0, 300]
    raise "HTTP #{resp.code} for #{uri}#{detail.empty? ? '' : " — #{detail}"}"
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

def compute_histograms_from_acc(acc)
  hist_width = (HIST_MAX - HIST_MIN).to_f / HIST_N_BINS

  acc.transform_values do |by_type|
    by_type.transform_values do |bins_array|
      bins_array.each_with_index.map do |sorted, i|
        counts = Array.new(HIST_N_BINS, 0)
        sorted.each do |err|
          idx = ((err - HIST_MIN) / hist_width).floor
          next if idx < 0 || idx >= HIST_N_BINS   # exclude out-of-range; no boundary clamping
          counts[idx] += 1
        end
        {
          'lo'          => BINS[i][0],
          'hi'          => BINS[i][1].round(2),
          'n'           => sorted.length,
          'hist_counts' => counts
        }
      end
    end
  end
end

# Accumulate historical API rows into a per-day, per-group, per-bin structure.
# Returns: { "2026-03-24" => { "GroupKey" => { "dayahead11h" => [[errs...] * 50 bins], ... } } }
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
# Returns: { "GroupKey" => { "dayahead11h" => [[sorted_errs] * 50 bins], ... } }
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

  # Sort each bin's error array
  acc.each_value do |by_type|
    by_type.each_value do |bins_array|
      bins_array.each { |errs| errs.sort! }
    end
  end

  acc
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

# ── Solar adapter for ODS209 / ODS210 ─────────────────────────────────────────

def solar_name_key(name)
  name.to_s.unicode_normalize(:nfkd).gsub(/[^A-Za-z]/, '').downcase
end

# Lookup by normalized name: accepts ODS209/ODS210 and legacy (ODS032) region names.
SOLAR_NAME_LOOKUP = begin
  h = {}
  SOLAR_REGION_NAMES.each { |new_name, legacy| h[solar_name_key(new_name)] = legacy; h[solar_name_key(legacy)] = legacy }
  h.freeze
end

def solar_region_name(raw)
  SOLAR_NAME_LOOKUP[solar_name_key(raw)]
end

def to_num(v)
  return v.to_f if v.is_a?(Numeric)
  return nil if v.nil?
  Float(v)
rescue ArgumentError, TypeError
  nil
end

# One value per region and quarter-hour from the grid-connection-type rows.
# Elia publishes Total = TSO + DSO (checked: 0.000 MW for measured, ≤ 0.01 MW
# for forecasts, ≤ 0.001 MW for capacity), so the Total row is used and the
# TSO + DSO sum is the fallback when a Total row is absent. Summing all three
# rows would double every value.
def combine_grid_types(by_gct, field, check)
  total = by_gct[GRID_TOTAL]
  tv    = total && to_num(total[field])
  comps = GRID_COMPONENTS.map { |g| (r = by_gct[g]) && to_num(r[field]) }
  csum  = comps.any?(&:nil?) ? nil : comps.sum
  if check && tv && csum
    check[:compared] += 1
    check[:mismatch] += 1 if (tv - csum).abs > [1.0, 0.005 * tv.abs].max
  end
  tv.nil? ? csum : tv
end

# Convert ODS209/ODS210 rows to the legacy solar row shape used by the rest of
# the pipeline: { datetime, region (legacy key), measured, dayahead11hforecast,
# dayaheadforecast, mostrecentforecast, monitoredcapacity }.
#   measured_field: 'measured_upscaled' (ODS209) or 'measured' (ODS210).
#   check: optional { compared:, mismatch:, unknown: } counters.
def solar_rows_from_new(raw, measured_field, check = nil)
  parts = {}                          # [datetime, legacy region] => { gct => row }
  raw.each do |r|
    dt  = r['datetime']&.strip
    reg = solar_region_name(r['region'])
    unless reg
      check[:unknown][r['region'].to_s] += 1 if check
      next
    end
    next unless dt
    gct = r['gridconnectiontype'].to_s.strip
    gct = GRID_TOTAL if gct.casecmp?(GRID_TOTAL)
    gct = gct.upcase if GRID_COMPONENTS.include?(gct.upcase)
    (parts[[dt, reg]] ||= {})[gct] = r
  end

  rows = {}
  parts.each do |(dt, reg), by_gct|
    row = { 'datetime' => dt, 'region' => reg }
    SOLAR_VALUE_FIELDS.each do |f|
      row[f] = combine_grid_types(by_gct, f == 'measured' ? measured_field : f, check)
    end
    rows[[dt, reg]] = row
  end

  parts.keys.map(&:first).uniq.each do |dt|
    SOLAR_DERIVED_REGIONS.each do |name, members|
      member_rows = members.map { |m| rows[[dt, m]] }
      next if member_rows.any?(&:nil?)
      row = { 'datetime' => dt, 'region' => name }
      SOLAR_VALUE_FIELDS.each do |f|
        vals = member_rows.map { |m| m[f] }
        row[f] = vals.any?(&:nil?) ? nil : vals.sum.round(5)
      end
      rows[[dt, name]] = row
    end
  end

  rows.values.sort_by { |r| [r['datetime'], r['region']] }
end

# Fill forecasts that are null in `rows` from `donor_rows` (same region and
# quarter-hour). Never touches measured or capacity. Returns counts per field.
def fill_missing_forecasts(rows, donor_rows)
  idx = {}
  donor_rows.each do |d|
    qk = quarter_key(d['datetime'].to_s)
    idx["#{d['region']}|#{qk}"] = d if qk
  end
  filled = Hash.new(0)
  rows.each do |r|
    d = idx["#{r['region']}|#{quarter_key(r['datetime'].to_s)}"]
    next unless d
    FORECAST_TYPES.each_value do |f|
      next unless r[f].nil? && !d[f].nil?
      r[f] = d[f]
      filled[f] += 1
    end
  end
  filled
end

def report_solar_check(check, dataset)
  if check[:compared] > 0
    puts "    #{dataset}: Total vs TSO+DSO compared on #{check[:compared]} values, " \
         "#{check[:mismatch]} differ by more than max(1 MW, 0.5 %)"
  end
  if check[:mismatch] > 0
    gh_annotation('warning', "#{dataset} grid types disagree",
                  "#{check[:mismatch]} of #{check[:compared]} Total values differ from TSO+DSO by more than max(1 MW, 0.5 %). Total was used.")
  end
  return if check[:unknown].empty?
  warn "    #{dataset}: unknown regions skipped: #{check[:unknown]}"
  gh_annotation('warning', "#{dataset} unknown regions", "Skipped rows for regions #{check[:unknown].keys.join(', ')}; update SOLAR_REGION_NAMES.")
end

def new_check
  { compared: 0, mismatch: 0, unknown: Hash.new(0) }
end

# ── Data sources per technology ───────────────────────────────────────────────
#
# hist: ->(where, from_date, to_date, order_by) { rows }  validated history, legacy shape
# nrt:  ->(where) { rows }  near-real-time rows; the measurement is in 'measured'

def wind_sources
  {
    hist_label: 'ODS031',
    nrt_label:  'ODS086',
    hist: lambda do |where, _from, _to, order_by|
      fetch_json(export_url('ods031', where: where, select: WIND_HIST_SELECT, order_by: order_by))
    end,
    nrt: lambda do |where|
      rows = fetch_json(export_url('ods086', where: where, select: WIND_RECENT_SELECT, order_by: 'datetime ASC'))
      rows.each { |r| r['measured'] = r.delete('realtime') if r.key?('realtime') }
      rows
    end
  }
end

def solar_sources
  nrt_cache = {}
  nrt = lambda do |where|
    nrt_cache[where] ||= begin
      raw   = fetch_json(export_url('ods210', where: where, select: SOLAR_RECENT_SELECT, order_by: 'datetime ASC'))
      check = new_check
      rows  = solar_rows_from_new(raw, 'measured', check)
      report_solar_check(check, 'ODS210')
      rows
    end
    nrt_cache[where].map(&:dup)   # callers keep rows in the recent accumulator
  end

  hist = lambda do |where, from, to, order_by|
    rows = []
    if from <= SOLAR_LEGACY_LAST_DATE
      legacy = fetch_json(export_url('ods032', where: where, select: SOLAR_LEGACY_SELECT, order_by: order_by))
      rows.concat(legacy.select { |r| (q = quarter_key(r['datetime'].to_s)) && q < SOLAR_CUTOVER })
    end
    if to >= SOLAR_LEGACY_LAST_DATE
      raw   = fetch_json(export_url('ods209', where: where, select: SOLAR_HIST_SELECT, order_by: order_by))
      check = new_check
      new_rows = solar_rows_from_new(raw, 'measured_upscaled', check)
                   .select { |r| (q = quarter_key(r['datetime'].to_s)) && q >= SOLAR_CUTOVER }
      report_solar_check(check, 'ODS209')
      # ODS209 can hold null forecasts that Elia backfills later. ODS210 carries
      # the same published forecasts (identical on every common slot) from today
      # (Brussels) to D+10, so null forecasts of today's and later rows are
      # filled from it.
      filled = fill_missing_forecasts(new_rows, nrt.call(where))
      unless filled.empty?
        puts "    ODS209 forecasts filled from ODS210: " + filled.map { |f, n| "#{f}=#{n}" }.join(', ')
      end
      rows.concat(new_rows)
    end
    rows
  end

  # frozen_through: a stored day up to this date is never re-fetched, so the
  # catch-up never needs the frozen ODS032.
  { hist_label: 'ODS209', nrt_label: 'ODS210', hist: hist, nrt: nrt,
    frozen_through: SOLAR_LEGACY_LAST_DATE }
end

# ── Accumulator helpers ───────────────────────────────────────────────────────

# Write via a temporary file so an interrupted run never leaves a truncated file.
def write_atomic(path, data)
  tmp = "#{path}.tmp"
  File.write(tmp, data)
  File.rename(tmp, path)
end

def load_acc(path)
  return nil unless File.exist?(path)
  data = JSON.parse(File.read(path))
  return nil unless data['version'] == ACC_VERSION
  data
rescue
  nil
end

def save_acc(path, days)
  write_atomic(path, JSON.generate({ 'version' => ACC_VERSION, 'days' => days }))
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
# Stores 15-min measured slots fetched from the near-real-time datasets
# (ODS086 wind, ODS210 solar) so they survive after Elia removes them from the
# real-time API. Solar rows are stored in the legacy shape (legacy region names).
# Schema: { "version": 1, "rows": [ <normalized row hashes> ... ] }

def load_recent_acc(path)
  return { 'version' => RECENT_ACC_VERSION, 'rows' => [] } unless File.exist?(path)
  data = JSON.parse(File.read(path))
  return { 'version' => RECENT_ACC_VERSION, 'rows' => [] } unless data['version'] == RECENT_ACC_VERSION
  data
rescue
  { 'version' => RECENT_ACC_VERSION, 'rows' => [] }
end

def save_recent_acc(path, acc)
  write_atomic(path, JSON.generate(acc))
end

# Upsert rt_rows (already with measured, not realtime) into the accumulator.
# Deduplicates by (group_key, quarter_key); only stores rows with a measured value.
# The latest near-real-time row replaces a cached one: Elia's value for the
# current quarter-hour is a running average that is completed by later runs.
def upsert_recent_acc(acc, rt_rows, group_key_fn)
  existing = {}
  acc['rows'].each_with_index do |r, i|
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    existing["#{gk}|#{qk}"] = i if gk && qk
  end
  rt_rows.each do |r|
    next unless r['measured']
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    next unless gk && qk
    if (i = existing["#{gk}|#{qk}"])
      acc['rows'][i] = r
    else
      existing["#{gk}|#{qk}"] = acc['rows'].length
      acc['rows'] << r
    end
  end
end

# Remove slots older than cutoff_str (inclusive lower bound, e.g. "2026-03-19")
def prune_recent_acc(acc, cutoff_str)
  acc['rows'].select! do |r|
    qk = quarter_key(r['datetime']&.strip || '')
    qk && qk >= cutoff_str
  end
end

# ── Process one technology ────────────────────────────────────────────────────
#
# Fetches and computes everything first; files are written only at the end
# (Step 7), so an exception leaves this technology's files untouched.

def process_tech(tech_name, src, group_key_fn, paths, source_label, win,
                 expected_groups: nil, postprocess: nil)
  hist_start, hist_end = win[:hist_start], win[:hist_end]
  recent_start, recent_end, recent_where = win[:recent_start], win[:recent_end], win[:recent_where]

  puts "\n=== #{tech_name.upcase} (#{src[:hist_label]} + #{src[:nrt_label]}) ==="

  # ── Step 1: load or build accumulator ──────────────────────────────────────

  acc = load_acc(paths[:acc])

  if acc.nil?
    puts "  No accumulator found — performing full #{HIST_DAYS}-day historical fetch…"
    hist_where = "datetime >= '#{hist_start}' AND datetime <= '#{hist_end}'"
    puts "  Fetching…"
    hist_rows = src[:hist].call(hist_where, hist_start, hist_end, nil)
    puts "  #{hist_rows.length} rows"

    day_buckets   = rows_to_day_buckets(hist_rows, group_key_fn)
    acc_days      = day_buckets_to_acc_entries(day_buckets)
    cap_from_rows = median_capacity_from_rows(hist_rows, group_key_fn)
    puts "  Groups: #{cap_from_rows.keys.sort.join(', ')}"
  else
    # Determine gap. Missing days are fetched oldest first, MAX_GAP_DAYS per run,
    # so an outage longer than MAX_GAP_DAYS is caught up over consecutive runs.
    # The last stored day is fetched again with them and its bucket replaced:
    # a UTC day is stored before its last local-midnight quarter-hours are
    # published (the next Brussels day), and Elia may backfill it.
    existing_dates = acc['days'].map { |d| d['date'] }.sort
    last_date      = existing_dates.last ? Date.parse(existing_dates.last) : hist_start - 1
    first_new      = [last_date + 1, hist_start].max
    refetch        = last_date >= hist_start &&
                     (src[:frozen_through].nil? || last_date > src[:frozen_through])
    gap_start      = refetch ? last_date : first_new
    gap_end        = hist_end

    if gap_start > gap_end
      puts "  Accumulator is up to date (last date: #{last_date})."
      acc_days      = acc['days']
      cap_from_rows = nil
    else
      fetch_end  = [gap_end, first_new + MAX_GAP_DAYS - 1].min
      fetch_days = (fetch_end - gap_start).to_i + 1
      puts "  Accumulator up to #{last_date}. Fetching #{gap_start} → #{fetch_end} (#{fetch_days} days" \
           "#{refetch ? ", #{last_date} again" : ''})…"
      if fetch_end < gap_end
        puts "  #{(gap_end - fetch_end).to_i} more day(s) to catch up in the following runs."
      end
      gap_where = "datetime >= '#{gap_start}' AND datetime <= '#{fetch_end}'"
      gap_rows = src[:hist].call(gap_where, gap_start, fetch_end, nil)
      puts "  #{gap_rows.length} rows"

      new_buckets = rows_to_day_buckets(gap_rows, group_key_fn)
      new_entries = day_buckets_to_acc_entries(new_buckets)
      puts "  New day-buckets: #{new_entries.map { |e| e['date'] }.join(', ')}" unless new_entries.empty?
      # A fetched day replaces its stored bucket; a stored day the fetch
      # returned no measurement for is kept.
      new_dates   = new_entries.map { |e| e['date'] }
      acc_days    = (acc['days'].reject { |d| new_dates.include?(d['date']) } + new_entries)
                      .sort_by { |d| d['date'] }
      # Capacity from the fetched rows only when they include a new day; a run that only
      # re-fetched the last stored day takes it from the recent rows (Step 5).
      cap_from_rows = fetch_end >= first_new ? median_capacity_from_rows(gap_rows, group_key_fn) : nil
    end
  end

  # ── Step 2: prune old days ──────────────────────────────────────────────────

  cutoff   = hist_start
  acc_days = prune_days(acc_days, cutoff)
  puts "  Accumulator: #{acc_days.length} day-buckets (cutoff: #{cutoff})"

  # meta.hist_start/hist_end state the days the statistics actually cover.
  if acc_days.empty?
    stored_start, stored_end = hist_start.to_s, hist_end.to_s
    warn '  WARNING: the accumulator holds no day; meta states the requested window.'
    gh_annotation('warning', "#{tech_name} history empty", 'The accumulator holds no day.')
  else
    stored_start, stored_end = acc_days.first['date'], acc_days.last['date']
    lag = (hist_end - Date.parse(stored_end)).to_i
    if lag > 2
      warn "  WARNING: history ends on #{stored_end}, #{lag} days before #{hist_end}."
      gh_annotation('warning', "#{tech_name} history behind",
                    "The accumulator ends on #{stored_end}, #{lag} days before #{hist_end}.")
    end
  end

  # ── Step 3: compute histograms from accumulator ────────────────────────────

  merged    = merge_days(acc_days)
  quantiles = compute_histograms_from_acc(merged)
  puts "  Groups in quantiles: #{quantiles.keys.sort.join(', ')}"

  # ── Step 4: capacity from the fetched history rows ─────────────────────────

  # Capacity is not stored in the accumulator: take the median over the rows
  # fetched for new days, else over the recent rows (Step 5).
  capacity_map = {}
  if cap_from_rows && !cap_from_rows.empty?
    capacity_map = cap_from_rows
  end

  # ── Step 5: fetch recent trajectory ────────────────────────────────────────
  #
  # Three-layer merge strategy:
  #   Layer 1 — history dataset (ODS031 / ODS209; validated, published once a
  #             day for the previous Brussels day). Highest priority.
  #   Layer 2 — recent_acc (accumulated from ODS086 / ODS210 on every run).
  #             Fills gaps for slots not yet measured in the history dataset.
  #   Layer 3 — live ODS086 / ODS210 query. Today's new measured slots are
  #             upserted into recent_acc and persist after Elia removes them.
  #
  # Merge rule: the history dataset wins over acc for any slot it has measured.

  puts "  Fetching recent #{RECENT_DAYS}-day trajectory…"

  # Layer 1: fetch from historical dataset
  hist_recent_rows = src[:hist].call(recent_where, recent_start, recent_end, 'datetime ASC')
  puts "  Recent rows (#{src[:hist_label]}): #{hist_recent_rows.length}"

  # Layer 3: fetch live real-time rows and accumulate
  # Split: rows with a measurement (for the accumulator) vs. forecast-only future
  # slots (used only for the trajectory's forward-looking horizon).
  rt_rows                 = src[:nrt].call(recent_where)
  rt_measured             = rt_rows.reject { |r| r['measured'].nil? }
  rt_future_forecast_rows = rt_rows.select { |r| r['measured'].nil? }
  puts "  Recent rows (#{src[:nrt_label]}): measured=#{rt_measured.length} forecast-only=#{rt_future_forecast_rows.length}"

  # Load, upsert and prune the recent accumulator (measured slots only); saved in Step 7
  recent_acc = load_recent_acc(paths[:recent_acc])
  upsert_recent_acc(recent_acc, rt_measured, group_key_fn)
  prune_recent_acc(recent_acc, recent_start.to_s)
  puts "  Recent acc: #{recent_acc['rows'].length} cached slots"

  # Build (gk|qk) index of history slots that already have a validated measured value.
  # The history dataset returns rows for today (forecasts populated) but `measured`
  # is null on the trailing slots while it backfills. It takes precedence over
  # recent_acc only where its measured is non-null, so today's near-real-time
  # measurements in recent_acc are kept.
  hist_index = {}
  hist_recent_rows.each do |r|
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    hist_index["#{gk}|#{qk}"] = true if gk && qk && r['measured']
  end

  # Layer 2: add acc rows for slots not yet measured in the history dataset
  gap_rows = recent_acc['rows'].reject do |r|
    gk = group_key_fn.call(r)
    qk = quarter_key(r['datetime']&.strip || '')
    hist_index["#{gk}|#{qk}"]
  end
  puts "  Gap rows from acc (not measured in #{src[:hist_label]}): #{gap_rows.length}"

  recent_rows = hist_recent_rows + gap_rows + rt_future_forecast_rows

  recent_data = build_recent(recent_rows, group_key_fn)

  # Trim each group's trajectory to: last measured slot + up to 12 h (48 quarters) of
  # forward-looking forecasts. This drops the long tail of forecast-only slots that
  # the history dataset carries beyond the look-ahead horizon.
  recent_data.each do |_gk, rec|
    next unless rec
    ts   = rec['timestamps'] || []
    meas = rec['measured']   || []
    last_meas_idx = nil
    (ts.length - 1).downto(0) do |i|
      if meas[i]
        last_meas_idx = i
        break
      end
    end
    next unless last_meas_idx
    cut = [last_meas_idx + 48, ts.length - 1].min
    (['timestamps', 'measured'] + FORECAST_TYPES.values).each do |field|
      arr = rec[field]
      rec[field] = arr[0..cut] if arr.is_a?(Array)
    end
  end

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
      'hist_start'     => stored_start,
      'hist_end'       => stored_end,
      'recent_start'   => recent_start.to_s,
      'recent_end'     => recent_end.to_s,
      'bins'           => BINS,
      'hist_min'    => HIST_MIN,
      'hist_max'    => HIST_MAX,
      'hist_n_bins' => HIST_N_BINS,
      'source'         => source_label,
      'license'        => 'CC BY 4.0 (Elia Open Data Licence)',
      'license_url'    => 'https://creativecommons.org/licenses/by/4.0/',
      'attribution'    => 'Elia Transmission Belgium SA',
      'unit'           => 'MW'
    },
    'groups' => groups
  }

  postprocess&.call(out_json)

  if expected_groups
    missing = expected_groups - groups.keys
    extra   = groups.keys - expected_groups
    no_recent = expected_groups.select { |gk| groups[gk] && groups[gk]['recent'].nil? }
    problems = []
    problems << "missing groups #{missing.join(', ')}" unless missing.empty?
    problems << "unexpected groups #{extra.join(', ')}" unless extra.empty?
    problems << "no recent trajectory for #{no_recent.join(', ')}" unless no_recent.empty?
    unless problems.empty?
      warn "  WARNING: #{problems.join('; ')}"
      gh_annotation('warning', "#{tech_name} output groups", problems.join('; '))
    end
  end

  # ── Step 7: write output and accumulators ──────────────────────────────────

  write_atomic(paths[:out], JSON.generate(out_json))
  puts "  Written #{paths[:out]} (#{(File.size(paths[:out]) / 1024.0).round(1)} KB)"

  save_acc(paths[:acc], acc_days)
  puts "  Written #{paths[:acc]} (#{(File.size(paths[:acc]) / 1024.0).round(1)} KB)"

  save_recent_acc(paths[:recent_acc], recent_acc)
  puts "  Written #{paths[:recent_acc]} (#{recent_acc['rows'].length} slots)"
end

# ── Group keys ────────────────────────────────────────────────────────────────

WIND_GROUP_FN = lambda do |row|
  oo   = row['offshoreonshore']&.strip
  reg  = row['region']&.strip
  grid = normalise_grid(row['gridconnectiontype'])
  return nil if oo.nil? || reg.nil? || grid.nil?
  "#{oo}|#{reg}|#{grid}"
end

SOLAR_GROUP_FN = lambda { |row| row['region']&.strip }

# Solar: drop night slots (measured and every forecast below 1 MW) from the
# recent trajectory.
def filter_solar_night(out_json)
  out_json['groups'].each do |_gk, g|
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
  puts '  Solar night-hours filtered.'
end

# ── Run ───────────────────────────────────────────────────────────────────────

def run_all
  # Unbuffered stdout, so progress lines and the warnings on stderr appear in
  # order in the CI log (stdout is a buffered pipe there).
  $stdout.sync = true
  FileUtils.mkdir_p(OUT_DIR)

  today        = Time.now.utc.to_date   # windows are in UTC, like the API queries
  hist_end     = today - 1
  hist_start   = today - 1 - HIST_DAYS
  recent_end   = today + 1      # include today + tomorrow so the forecast look-ahead from ODS086/ODS210 is fetched
  recent_start = today - RECENT_DAYS

  win = {
    hist_start: hist_start, hist_end: hist_end,
    recent_start: recent_start, recent_end: recent_end,
    recent_where: "datetime >= '#{recent_start}' AND datetime < '#{recent_end + 1}'"
  }

  puts "Today:           #{today}"
  puts "Historical range: #{hist_start} → #{hist_end}"
  puts "Recent range:     #{recent_start} → #{recent_end}"
  puts "Data directory:   #{File.expand_path(OUT_DIR)}"

  techs = [
    {
      name: 'Wind', sources: wind_sources, group_fn: WIND_GROUP_FN,
      paths: { acc: 'wind_acc.json', out: 'wind.json', recent_acc: 'wind_recent_acc.json' },
      source_label: 'Elia Open Data Platform (ODS031, ODS086)', expected: WIND_GROUP_KEYS
    },
    {
      name: 'Solar', sources: solar_sources, group_fn: SOLAR_GROUP_FN,
      paths: { acc: 'solar_acc.json', out: 'solar.json', recent_acc: 'solar_recent_acc.json' },
      source_label: 'Elia Open Data Platform (ODS032 until 25 October 2026, ODS209, ODS210)', expected: SOLAR_GROUP_KEYS,
      postprocess: method(:filter_solar_night)
    }
  ]

  results = {}
  techs.each do |t|
    paths = t[:paths].transform_values { |f| File.join(OUT_DIR, f) }
    process_tech(t[:name], t[:sources], t[:group_fn], paths, t[:source_label], win,
                 expected_groups: t[:expected], postprocess: t[:postprocess])
    results[t[:name]] = nil
  rescue StandardError => e
    results[t[:name]] = e
    warn "\n  #{t[:name].upcase} FAILED — its files were left unchanged."
    warn "  #{e.class}: #{e.message}"
    (e.backtrace || []).first(6).each { |l| warn "    #{l}" }
    gh_annotation('error', "#{t[:name]} data not updated", "#{e.class}: #{e.message}")
  end

  puts "\nSummary:"
  results.each do |name, err|
    puts "  #{name}: #{err ? "FAILED (#{err.class}: #{err.message[0, 160]})" : 'updated'}"
  end

  # A failed technology fails the run (GitHub then sends a failure notification) only
  # once its output is older than STALE_FAIL_HOURS; before that it stays an annotation,
  # so a single failed request does not send a notification on every scheduled run.
  failed = results.select { |_name, err| err }.keys
  unless failed.empty?
    stale = failed.select do |name|
      out = File.join(OUT_DIR, techs.find { |t| t[:name] == name }[:paths][:out])
      age = output_age_hours(out)
      warn "  #{name}: #{age ? format('output last generated %.1f h ago', age) : 'output age unknown'}."
      age.nil? || age > STALE_FAIL_HOURS
    end
    warn "#{failed.join(' and ')} failed (#{failed.length} of #{results.length})."
    exit 1 unless stale.empty?
    gh_annotation('warning', 'Run partly failed',
                  "#{failed.join(' and ')} failed; output is newer than #{STALE_FAIL_HOURS} h, so the run stays green.")
  end
  puts "\nDone."
end

run_all if File.expand_path($PROGRAM_NAME) == File.expand_path(__FILE__)
