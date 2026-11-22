#!/usr/bin/env ruby
# frozen_string_literal: true

# Build the self-hosted basemap of the Research Footprint Map:
#
#   assets/data/basemap/world-110m.json   zoom 2-3, loaded with the map
#   assets/data/basemap/world-50m.json    zoom 4-7, loaded on the first zoom
#
# from Natural Earth v5.1.2 GeoJSON (public domain). Sources, license and the
# download commands are in assets/data/basemap/README.md.
#
# Usage: ruby scripts/build_basemap.rb SOURCE_DIR [--output DIR] [--no-verify]
#
# SOURCE_DIR holds the six Natural Earth files named in SOURCES. Each is
# checked against its SHA-256 before it is read (--no-verify skips the check,
# for a newer Natural Earth release; then update SOURCES and the README).
# The files are parsed as JSON data only. Ruby standard library only; Ruby
# 3.3 compatible. Each output is written to a temp file, then renamed. The
# output depends only on the inputs and the constants below.
#
# Per scale:
#   1. Land and lake polygons; land boundary lines, split into "border"
#      (Natural Earth class "International boundary (verify)") and
#      "border-disputed" (every other class: disputed, line of control,
#      indefinite, indeterminant frontier, claim boundary).
#   2. Visvalingam-Whyatt simplification by effective area, measured in Web
#      Mercator pixels at the scale's ref_zoom (the highest zoom map.js draws
#      it at). Poleward of LAT_REF the threshold grows with the square of the
#      Mercator stretch (cos LAT_REF / cos lat), so the Arctic and Antarctica,
#      which Web Mercator magnifies, do not take most of the bytes. Never
#      removed: vertices on the antimeridian (the pieces Natural Earth cut at
#      180 degrees still meet), line endpoints, and the two vertices of the
#      coast or lake-shore segment where a boundary line ends (so boundaries
#      still end on the coast).
#   3. Coordinates rounded to the scale's :decimals decimal places; repeated
#      points dropped; rings smaller than the scale's :min_area (px^2 at
#      ref_zoom) dropped (an outer ring takes its holes with it), as are small
#      rings that come out as slivers or self-intersecting.
#   4. One FeatureCollection, four features in drawing order: land, lake,
#      border, border-disputed (property "class"), as MultiPolygon and
#      MultiLineString geometries, plus a "meta" member.

require 'digest'
require 'fileutils'
require 'json'
require 'optparse'
require 'set'
require 'stringio'
require 'zlib'

module BuildBasemap
  ROOT    = File.expand_path('..', __dir__)
  OUTPUT  = File.join(ROOT, 'assets', 'data', 'basemap')
  RELEASE = 'Natural Earth v5.1.2'
  COMMIT  = 'f1890d9f152c896d250a77557a5751a93d494776' # tag v5.1.2 of github.com/nvkelso/natural-earth-vector

  # File name => SHA-256 of the file as published at COMMIT (geojson/ folder)
  SOURCES = {
    'ne_110m_land.geojson'                        => '9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9',
    'ne_110m_lakes.geojson'                       => 'eb02ecc86c82004fccbf979058bfabbbd6c2d07968c7844d38eb1c9152d2ffc9',
    'ne_110m_admin_0_boundary_lines_land.geojson' => 'd42479fd79552cca4eec7f85fcdca717a790d29ff06be7676f1af0568c6d3f7c',
    'ne_50m_land.geojson'                         => 'e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b',
    'ne_50m_lakes.geojson'                        => 'd350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52',
    'ne_50m_admin_0_boundary_lines_land.geojson'  => '2faac4f6b34386f3d21b6e018cf151f241f00e5c936d44dd17d7d9bfb147fa48'
  }.freeze

  # ref_zoom: highest zoom the file is drawn at (map.js: 110m up to zoom 3,
  # 50m from zoom 4 to maxZoom 7). area: Visvalingam threshold per class, in
  # px^2 at ref_zoom. min_area: smallest ring kept, px^2 at ref_zoom.
  # detail: threshold multiplier inside DETAIL_BOXES.
  SCALES = [
    { name: '110m', ref_zoom: 3, decimals: 2, detail: 0.4,
      area: { land: 6.0, lake: 6.0, line: 8.0 }, min_area: { land: 2.0, lake: 3.0 } },
    { name: '50m', ref_zoom: 7, decimals: 2, detail: 0.2,
      area: { land: 190.0, lake: 380.0, line: 120.0 }, min_area: { land: 60.0, lake: 380.0 } }
  ].freeze

  # Finer detail around the map's pins, where cluster and off-screen moves
  # land: thresholds inside a box are multiplied by the scale's :detail,
  # rising linearly to 1 over RAMP degrees outside it. Boxes as
  # [west, south, east, north]; a pin added far from them gets the standard
  # detail until the boxes are extended and the files rebuilt.
  DETAIL_BOXES = [
    [-11.0, 35.0, 30.0, 59.0],    # Europe, the Mediterranean, the Aegean coast
    [124.0, 33.0, 131.0, 39.0],   # Korea
    [172.0, -40.0, 177.5, -34.0], # Auckland and the north of New Zealand
    [-117.0, 31.0, -103.0, 43.0]  # US Southwest
  ].freeze
  RAMP = 4.0
  LAT_REF = 50.0      # thresholds grow poleward of this latitude ...
  STRETCH_CAP = 3.0   # ... by at most this factor
  ANGLE_K = 0.7       # weighted Visvalingam: area x (1 - K cos angle), spikes go first
  THIN = 0.12         # a small ring with 4 pi A / P^2 below this is a sliver: dropped
  SNAP_DEG = 0.01     # a boundary endpoint this close to a coast segment locks it
  BUDGET = { initial: 150_000, initial_gzip: 60_000, total: 500_000 }.freeze # bytes

  INTERNATIONAL = 'International boundary (verify)'
  MAX_LAT = 85.0511287798 # Web Mercator limit (Leaflet's SphericalMercator)

  class Error < StandardError; end

  module_function

  def run(argv)
    opts = { output: OUTPUT, verify: true }
    parser = OptionParser.new do |o|
      o.banner = 'Usage: ruby scripts/build_basemap.rb SOURCE_DIR [--output DIR] [--no-verify]'
      o.on('--output DIR', 'Output directory (default assets/data/basemap)') { |v| opts[:output] = v }
      o.on('--no-verify', 'Skip the SHA-256 check of the source files') { opts[:verify] = false }
    end
    args = parser.parse(argv)
    raise Error, parser.banner if args.size != 1

    src = args.first
    verify_sources(src) if opts[:verify]
    FileUtils.mkdir_p(opts[:output])
    total = 0
    SCALES.each_with_index do |scale, i|
      json, stats = build_scale(src, scale)
      path = File.join(opts[:output], "world-#{scale[:name]}.json")
      write_atomic(path, json)
      total += json.bytesize
      gz = gzip_size(json)
      report(path, json.bytesize, gz, stats)
      next unless i.zero? && (json.bytesize > BUDGET[:initial] || gz > BUDGET[:initial_gzip])

      warn "WARNING: #{File.basename(path)} is over the initial-download budget " \
           "(#{BUDGET[:initial]} bytes raw, #{BUDGET[:initial_gzip]} gzip)"
    end
    puts format('total %d bytes raw (budget %d)', total, BUDGET[:total])
    warn 'WARNING: the basemap files are over the total budget' if total > BUDGET[:total]
  end

  def verify_sources(src)
    SOURCES.each do |name, sha|
      path = File.join(src, name)
      raise Error, "Missing #{path}" unless File.file?(path)

      got = Digest::SHA256.file(path).hexdigest
      raise Error, "#{name}: SHA-256 #{got} does not match #{RELEASE} (#{sha})" unless got == sha
    end
  end

  def load_features(src, name)
    path = File.join(src, name)
    raise Error, "Missing #{path}" unless File.file?(path)

    features = JSON.parse(File.read(path, encoding: 'UTF-8'))['features']
    raise Error, "#{name}: no features array" unless features.is_a?(Array)

    features
  end

  # Polygons of a feature as [[outer, hole, ...], ...]
  def polygons_of(geom)
    case geom && geom['type']
    when 'Polygon' then [geom['coordinates']]
    when 'MultiPolygon' then geom['coordinates']
    else []
    end
  end

  def lines_of(geom)
    case geom && geom['type']
    when 'LineString' then [geom['coordinates']]
    when 'MultiLineString' then geom['coordinates']
    else []
    end
  end

  def build_scale(src, scale)
    n = scale[:name]
    ctx = scale.merge(world: 256.0 * (2**scale[:ref_zoom]))
    stats = Hash.new(0)

    land = load_features(src, "ne_#{n}_land.geojson").flat_map { |f| polygons_of(f['geometry']) }
    lakes = load_features(src, "ne_#{n}_lakes.geojson").flat_map { |f| polygons_of(f['geometry']) }
    borders = []
    disputed = []
    load_features(src, "ne_#{n}_admin_0_boundary_lines_land.geojson").each do |f|
      cls = (f['properties'] || {})['FEATURECLA']
      (cls == INTERNATIONAL ? borders : disputed).concat(lines_of(f['geometry']))
    end

    locks = shore_locks([land, lakes], borders + disputed)
    stats[:locked] = locks.values.sum(&:size)

    features = [
      feature('land', 'MultiPolygon', simplify_polygons(land, ctx, stats, :land, locks)),
      feature('lake', 'MultiPolygon', simplify_polygons(lakes, ctx, stats, :lake, locks)),
      feature('border', 'MultiLineString', simplify_lines(borders, ctx, stats, :border)),
      feature('border-disputed', 'MultiLineString', simplify_lines(disputed, ctx, stats, :disputed))
    ]
    meta = { 'source' => "#{RELEASE} (public domain), naturalearthdata.com", 'scale' => "1:#{n}",
             'build' => 'scripts/build_basemap.rb', 'ref_zoom' => scale[:ref_zoom], 'decimals' => scale[:decimals] }
    json = +'{"type":"FeatureCollection","meta":' << JSON.generate(meta) << ',"features":['
    json << features.join(',') << "]}\n"
    [json, stats]
  end

  def feature(cls, type, coords)
    +'{"type":"Feature","properties":{"class":"' << cls << '"},"geometry":{"type":"' << type <<
      '","coordinates":' << coords << '}}'
  end

  # ── Geometry ─────────────────────────────────────────────────────────

  def project(pt, world)
    lng = pt[0].to_f
    lat = pt[1].to_f.clamp(-MAX_LAT, MAX_LAT)
    s = Math.sin(lat * Math::PI / 180.0)
    [(lng + 180.0) / 360.0 * world, (0.5 - (Math.log((1 + s) / (1 - s)) / (4 * Math::PI))) * world]
  end

  def antimeridian?(pt)
    (pt[0].to_f.abs - 180.0).abs < 1e-9
  end

  # Threshold multiplier at a latitude: (cos LAT_REF / cos lat)^2 poleward of
  # LAT_REF, at most STRETCH_CAP
  def stretch2(lat)
    a = [lat.to_f.abs, 89.0].min
    return 1.0 if a <= LAT_REF

    [(Math.cos(LAT_REF * Math::PI / 180) / Math.cos(a * Math::PI / 180))**2, STRETCH_CAP].min
  end

  # Threshold multiplier from DETAIL_BOXES: detail inside a box, 1 from RAMP
  # degrees outside every box
  def region(pt, detail)
    return 1.0 if detail >= 1.0

    t = DETAIL_BOXES.map do |west, south, east, north|
      dx = [west - pt[0], pt[0] - east, 0.0].max
      dy = [south - pt[1], pt[1] - north, 0.0].max
      Math.hypot(dx, dy) / RAMP
    end.min
    detail + ((1.0 - detail) * [t, 1.0].min)
  end

  def weight(pt, ctx)
    stretch2(pt[1]) * region(pt, ctx[:detail])
  end

  # Ring vertices that must survive simplification: for every boundary-line
  # endpoint within SNAP_DEG of a land or lake segment, both vertices of the
  # nearest such segment. Returns { ring.object_id => Set[index, ...] }.
  def shore_locks(polygon_sets, lines)
    grid = Hash.new { |h, k| h[k] = [] }
    polygon_sets.each do |polys|
      polys.each do |poly|
        poly.each do |ring|
          ring.each_cons(2).with_index do |(a, b), i|
            x0, x1 = [a[0], b[0]].minmax
            y0, y1 = [a[1], b[1]].minmax
            (x0.floor..x1.floor).each { |cx| (y0.floor..y1.floor).each { |cy| grid[[cx, cy]] << [ring, i] } }
          end
        end
      end
    end
    locks = Hash.new { |h, k| h[k] = Set.new }
    lines.each do |line|
      [line.first, line.last].each do |e|
        best = SNAP_DEG
        hit = nil
        cx = e[0].floor
        cy = e[1].floor
        (cx - 1..cx + 1).each do |gx|
          (cy - 1..cy + 1).each do |gy|
            grid.fetch([gx, gy], []).each do |ring, i|
              d = seg_dist_deg(e, ring[i], ring[i + 1])
              if d < best
                best = d
                hit = [ring, i]
              end
            end
          end
        end
        next unless hit

        ring, i = hit
        locks[ring.object_id] << i << (i + 1)
      end
    end
    locks
  end

  def seg_dist_deg(p, a, b)
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    len2 = (dx * dx) + (dy * dy)
    t = len2.zero? ? 0.0 : ((((p[0] - a[0]) * dx) + ((p[1] - a[1]) * dy)) / len2).clamp(0.0, 1.0)
    Math.hypot(a[0] + (t * dx) - p[0], a[1] + (t * dy) - p[1])
  end

  # Triangle area at b, weighted by the angle there: a spike (small angle)
  # counts less, so it is removed before a gentle bend of the same area
  def tri_area(px, a, b, c)
    ax = px[a][0] - px[b][0]
    ay = px[a][1] - px[b][1]
    cx = px[c][0] - px[b][0]
    cy = px[c][1] - px[b][1]
    area = ((ax * cy) - (ay * cx)).abs / 2.0
    la = Math.hypot(ax, ay)
    lc = Math.hypot(cx, cy)
    return area if la.zero? || lc.zero?

    area * (1.0 - (ANGLE_K * (((ax * cx) + (ay * cy)) / (la * lc))))
  end

  # Visvalingam-Whyatt by effective area. pts is a line, or a closed ring
  # (first == last); returns the indices to keep, in order. locked: Set of
  # indices never removed. A ring keeps at least three vertices.
  def visvalingam(pts, threshold, ctx, locked)
    n = pts.size
    closed = n > 3 && pts.first == pts.last
    m = closed ? n - 1 : n
    return (0...n).to_a if m <= (closed ? 3 : 2)

    px = pts.first(m).map { |p| project(p, ctx[:world]) }
    prev = Array.new(m) { |i| i - 1 }
    nxt = Array.new(m) { |i| i + 1 }
    if closed
      prev[0] = m - 1
      nxt[m - 1] = 0
    end
    fixed = Array.new(m) { |i| locked.include?(i) || antimeridian?(pts[i]) }
    fixed[0] ||= locked.include?(n - 1) if closed # the closing point is vertex 0
    unless closed
      fixed[0] = true
      fixed[m - 1] = true
    end
    scale = pts.first(m).map { |p| weight(p, ctx) }
    area = Array.new(m, Float::INFINITY)
    heap = MinHeap.new
    m.times do |i|
      next if fixed[i]

      area[i] = tri_area(px, prev[i], i, nxt[i]) / scale[i]
      heap.push(area[i], i)
    end
    removed = Array.new(m, false)
    left = m
    while (top = heap.pop)
      a, i = top
      next if removed[i] || a != area[i] # stale entry

      break if a >= threshold || (closed && left <= 3)

      removed[i] = true
      left -= 1
      p = prev[i]
      q = nxt[i]
      nxt[p] = q
      prev[q] = p
      [p, q].each do |j|
        next if fixed[j]

        area[j] = [tri_area(px, prev[j], j, nxt[j]) / scale[j], a].max
        heap.push(area[j], j)
      end
    end
    kept = (0...m).reject { |i| removed[i] }
    kept << kept.first if closed
    kept
  end

  # Binary min-heap of [key, value] (Ruby has none in the standard library)
  class MinHeap
    def initialize
      @k = []
      @v = []
    end

    def push(key, val)
      @k << key
      @v << val
      i = @k.size - 1
      while i.positive?
        p = (i - 1) >> 1
        break if @k[p] <= @k[i]

        swap(i, p)
        i = p
      end
    end

    def pop
      return nil if @k.empty?

      top = [@k[0], @v[0]]
      lk = @k.pop
      lv = @v.pop
      unless @k.empty?
        @k[0] = lk
        @v[0] = lv
        sift_down
      end
      top
    end

    private

    def sift_down
      i = 0
      n = @k.size
      loop do
        l = (2 * i) + 1
        r = l + 1
        s = i
        s = l if l < n && @k[l] < @k[s]
        s = r if r < n && @k[r] < @k[s]
        break if s == i

        swap(i, s)
        i = s
      end
    end

    def swap(a, b)
      @k[a], @k[b] = @k[b], @k[a]
      @v[a], @v[b] = @v[b], @v[a]
    end
  end

  def quantize(pts, decimals)
    out = []
    pts.each do |p|
      q = [p[0].to_f.round(decimals), p[1].to_f.round(decimals)]
      out << q unless out.last == q
    end
    out
  end

  # Shoelace area (px^2) and perimeter (px) at the reference zoom
  def area_perimeter_px(ring, world)
    px = ring.map { |p| project(p, world) }
    sum = 0.0
    perimeter = 0.0
    px.each_cons(2) do |(x1, y1), (x2, y2)|
      sum += (x1 * y2) - (x2 * y1)
      perimeter += Math.hypot(x2 - x1, y2 - y1)
    end
    [(sum / 2.0).abs, perimeter]
  end

  # True when two non-adjacent edges of a closed ring cross (small rings only)
  def self_intersecting?(ring)
    edges = ring.each_cons(2).to_a
    n = edges.size
    (0...n).any? do |i|
      ((i + 2)...n).any? do |j|
        next false if i.zero? && j == n - 1 # first and last edge share a vertex

        segments_cross?(*edges[i], *edges[j])
      end
    end
  end

  def segments_cross?(p1, p2, p3, p4)
    d1 = orient(p3, p4, p1)
    d2 = orient(p3, p4, p2)
    d3 = orient(p1, p2, p3)
    d4 = orient(p1, p2, p4)
    ((d1.positive? && d2.negative?) || (d1.negative? && d2.positive?)) &&
      ((d3.positive? && d4.negative?) || (d3.negative? && d4.positive?))
  end

  def orient(a, b, c)
    ((b[0] - a[0]) * (c[1] - a[1])) - ((b[1] - a[1]) * (c[0] - a[0]))
  end

  def simplify_ring(ring, ctx, stats, kind, locked)
    stats[:"#{kind}_in"] += ring.size
    kept = visvalingam(ring, ctx[:area][kind], ctx, locked).map { |i| ring[i] }
    q = quantize(kept, ctx[:decimals])
    q.pop while q.size > 1 && q.last == q.first # drop the closing point, then close once
    q << q.first
    return nil if q.size < 4

    xs, ys = q.transpose
    min_area = ctx[:min_area][kind] * weight([(xs.min + xs.max) / 2.0, (ys.min + ys.max) / 2.0], ctx)
    area, perimeter = area_perimeter_px(q, ctx[:world])
    return nil if area < min_area
    # A small ring that came out as a sliver or a bow-tie is noise at this scale
    if area < 8 * min_area
      return nil if 4 * Math::PI * area / (perimeter**2) < THIN
      return nil if q.size <= 16 && self_intersecting?(q)
    end

    stats[:"#{kind}_out"] += q.size
    q
  end

  def simplify_polygons(polys, ctx, stats, kind, locks)
    out = []
    polys.each do |poly|
      outer = simplify_ring(poly[0], ctx, stats, kind, locks.fetch(poly[0].object_id, Set.new))
      unless outer
        stats[:"#{kind}_dropped"] += 1
        next
      end
      holes = poly[1..].map { |h| simplify_ring(h, ctx, stats, kind, locks.fetch(h.object_id, Set.new)) }.compact
      out << [outer, *holes]
    end
    stats[:"#{kind}_rings"] = out.sum(&:size)
    encode(out, ctx[:decimals])
  end

  def simplify_lines(lines, ctx, stats, kind)
    out = []
    lines.each do |line|
      stats[:"#{kind}_in"] += line.size
      q = quantize(visvalingam(line, ctx[:area][:line], ctx, Set.new).map { |i| line[i] }, ctx[:decimals])
      next if q.size < 2

      stats[:"#{kind}_out"] += q.size
      out << q
    end
    stats[:"#{kind}_rings"] = out.size
    encode(out, ctx[:decimals])
  end

  # ── Output ───────────────────────────────────────────────────────────

  def num(v)
    v == v.to_i ? v.to_i.to_s : v.to_s
  end

  # Compact JSON for nested coordinate arrays, numbers without trailing zeros
  def encode(value, decimals)
    if value.is_a?(Array) && value.first.is_a?(Numeric)
      +'[' << num(value[0].round(decimals)) << ',' << num(value[1].round(decimals)) << ']'
    elsif value.is_a?(Array)
      +'[' << value.map { |v| encode(v, decimals) }.join(',') << ']'
    else
      raise Error, "unexpected coordinate value #{value.inspect}"
    end
  end

  def write_atomic(path, text)
    tmp = "#{path}.tmp"
    File.binwrite(tmp, text)
    File.rename(tmp, path)
  end

  def gzip_size(text)
    io = StringIO.new
    gz = Zlib::GzipWriter.new(io, Zlib::BEST_COMPRESSION)
    gz.write(text)
    gz.close
    io.string.bytesize
  end

  def report(path, raw, gz, stats)
    puts format('%-16s %8d bytes raw, %7d gzip, %d shore vertices locked', File.basename(path), raw, gz, stats[:locked])
    %i[land lake border disputed].each do |k|
      dropped = stats[:"#{k}_dropped"]
      puts format('  %-9s %6d -> %6d points, %4d rings/lines%s', k, stats[:"#{k}_in"], stats[:"#{k}_out"],
                  stats[:"#{k}_rings"], dropped.positive? ? ", #{dropped} outer rings dropped" : '')
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    BuildBasemap.run(ARGV)
  rescue BuildBasemap::Error, OptionParser::ParseError, JSON::ParserError => e
    warn "build_basemap: #{e.message}"
    exit 1
  end
end
