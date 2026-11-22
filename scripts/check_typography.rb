#!/usr/bin/env ruby
# frozen_string_literal: true

# Typography check of a built site. The pages' no-wrap pass (_includes/nowrap.html) works from a
# fixed list, _data/typography.yml `nowrap`, because Liquid has no regular expressions. This script
# applies the rules behind that list (NOWRAP_RE and JOIN_RE below) to the visible text of every
# built page and lists:
#   - a compound of letters joined by hyphens, a "d Month yyyy" date, a "yyyy–yyyy" range, hyphenated
#     initials ("J.-F."), "N-1", "AC/DC", "(B-KUL-H0P08A)" that is not inside a span.nw (add a row
#     to typography.yml: from the words, to "<span class=\"nw\">the words</span>");
#   - 15-minute, near-real-time, EUR-ACE, N-SIDE without the word joiner (U+2060) after each hyphen
#     (add a row whose "to" has U+2060 after each hyphen);
#   - a straight quote or apostrophe left in the text (store the typographic form in _data).
# The text checked is what the pass covers: <main> of each inner page, Home from its Latest section
# on, without the parts between <!--nowrap:off--> and <!--nowrap:on--> (the explorer's tool),
# scripts and styles; quotes are not checked inside <code>.
#
# Usage: ruby scripts/check_typography.rb <built site folder>      (exit status 1 when it lists anything)

site = ARGV[0] or abort 'usage: ruby scripts/check_typography.rb <built site folder>'
abort "#{site} is not a folder" unless File.directory?(site)

MONTHS = %w[January February March April May June July August September October November December].freeze
NOWRAP_WORDS = %w[non-Gaussian Non-Gaussian Co-supervisor co-supervisor balancing-aware Balancing-aware Risk-management
                  risk-management risk-based Risk-based day-ahead Day-ahead N-1 AC/DC].freeze
COMPOUND_RE = /(?<![\p{L}\p{N}\-])\p{L}+(?:-\p{L}+)+(?![\p{L}\p{N}\-])/
JOIN_WORDS = %w[15-minute near-real-time EUR-ACE N-SIDE].freeze
JOIN_RE = Regexp.union(JOIN_WORDS.map { |w| /(?<![\w-])#{Regexp.escape(w)}(?![\w-])/ })
NOWRAP_RE = Regexp.union(
  /\(B-KUL-H0P08A\)/,
  /(?<![\p{L}.])\p{Lu}\.(?:-\p{Lu}\.)+/,
  /\b\d{1,2} (?:#{MONTHS.join('|')}) \d{4}\b/,
  /\b\d{4}–\d{4}\b/,
  *NOWRAP_WORDS.sort_by { |w| -w.size }.map { |w| /(?<![\w-])#{Regexp.escape(w)}(?![\w-])/ },
  COMPOUND_RE
)
# &nbsp; decodes to U+00A0 (no-break space), not to an ordinary space.
def decode(text)
  text.gsub('&quot;', '"').gsub('&#39;', "'").gsub('&#x27;', "'").gsub('&amp;', '&').gsub('&nbsp;', " ")
end

def region(rel, html)
  a = html.index('<main id="main">') or return nil
  b = html.index('</main>', a) or return nil
  a += '<main id="main">'.length
  if rel == 'index.html'
    a = html.index('<section class="sec sec--home" id="latest"', a) || b
  end
  body = html[a...b]
  # the pass drops its markers from the output; without them the explorer is cut from its section
  # to the end of its loader script
  if !body.include?('<!--nowrap:off-->') && (t0 = body.index('<section class="forecast-section"'))
    t1 = body.index('</script>', body.index('plotly-loader.js', t0) || t0) || t0
    body = body[0...t0] + body[(t1 + '</script>'.length)..]
  end
  body.gsub(/<!--nowrap:off-->.*?<!--nowrap:on-->/m, '')
end

found = 0
pages = Dir.glob(File.join(site, '**', '*.html')).sort
pages.each do |path|
  rel = path.delete_prefix(site).delete_prefix('/').delete_prefix('\\').tr('\\', '/')
  html = File.read(path, encoding: 'utf-8')
  body = region(rel, html) or next
  notes = []
  in_nw = false
  in_code = 0
  body.split(%r{(<script\b.*?</script>|<style\b.*?</style>|<!--.*?-->|<[^>]+>)}m).each do |part|
    next if part.empty?
    if part.start_with?('<')
      next if part.start_with?('<script', '<style', '<!--')
      if part.start_with?('<span class="nw">') then in_nw = true
      elsif in_nw && part.start_with?('</span') then in_nw = false
      elsif part.match?(/\A<code\b/) then in_code += 1
      elsif part.start_with?('</code') then in_code -= 1
      end
      next
    end
    text = decode(part)
    unless in_nw
      text.scan(NOWRAP_RE) { notes << "no-wrap missing: #{Regexp.last_match(0)}" }
    end
    text.scan(JOIN_RE) { notes << "word joiner missing: #{Regexp.last_match(0)}" }
    if in_code.zero? && text =~ /["']/
      text.to_enum(:scan, /["']/).each do
        i = Regexp.last_match.begin(0)
        notes << "straight quote: …#{text[[i - 30, 0].max, 60].gsub(/\s+/, ' ')}…"
      end
    end
  end
  next if notes.empty?
  found += notes.size
  puts rel
  notes.uniq.each { |n| puts "  #{n}" }
end
puts found.zero? ? "#{pages.size} files checked: nothing to add" : "#{found} findings"
exit(found.zero? ? 0 : 1)
