#!/usr/bin/env ruby
# frozen_string_literal: true

# How current the explorer's data is, for the data workflows
# (.github/workflows/update-elia-data.yml and elia-chain-restart.yml).
#
#   ruby scripts/data_status.rb end FILE      the end of the newest measured wind quarter-hour
#                                             of the group that is furthest behind, in seconds
#                                             since 1970 (FILE is a wind.json; - reads standard
#                                             input)
#   ruby scripts/data_status.rb same FILE...  exit 0 when every FILE equals its version at git
#                                             HEAD apart from meta.generated, else exit 1
#
# wind.json timestamps are the start of each quarter-hour, in UTC. A group with
# no measured value counts as 0 (1970), so it reads as very old.
# Exit status 2: a missing file, or not a wind.json with groups.
# Ruby standard library only.

require 'json'
require 'open3'

module DataStatus
  QUARTER = 15 * 60
  USAGE   = 'Usage: ruby scripts/data_status.rb end FILE | same FILE...'

  class Error < StandardError; end

  module_function

  def load(path)
    JSON.parse(path == '-' ? $stdin.read : File.read(path, encoding: 'UTF-8'))
  end

  # The end of one group's newest measured quarter-hour, or 0 without one.
  def group_end(group)
    rec = group.is_a?(Hash) ? group['recent'] : nil
    return 0 unless rec.is_a?(Hash) && rec['timestamps'].is_a?(Array) && rec['measured'].is_a?(Array)

    i = rec['measured'].rindex { |v| v.is_a?(Numeric) }
    m = i && rec['timestamps'][i].to_s.match(/\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
    m ? Time.utc(*m.captures.map(&:to_i)).to_i + QUARTER : 0
  end

  def stalest_end(doc)
    groups = doc.is_a?(Hash) ? doc['groups'] : nil
    raise Error, 'no groups' unless groups.is_a?(Hash) && !groups.empty?

    groups.values.map { |g| group_end(g) }.min
  end

  def without_generated(doc)
    return doc unless doc.is_a?(Hash) && doc['meta'].is_a?(Hash)

    doc.merge('meta' => doc['meta'].reject { |k, _| k == 'generated' })
  end

  def same_as_head?(path)
    old, _err, status = Open3.capture3('git', 'show', "HEAD:#{path}")
    return false unless status.success?

    without_generated(JSON.parse(old)) == without_generated(load(path))
  rescue JSON::ParserError, SystemCallError
    false
  end

  def main(argv)
    cmd, *files = argv
    case cmd
    when 'end'
      raise Error, USAGE unless files.size == 1

      puts stalest_end(load(files.first))
      0
    when 'same'
      raise Error, USAGE if files.empty?

      files.all? { |f| same_as_head?(f) } ? 0 : 1
    else
      raise Error, USAGE
    end
  rescue Error, JSON::ParserError, SystemCallError => e
    warn "data_status: #{e.message}"
    2
  end
end

exit(DataStatus.main(ARGV)) if $PROGRAM_NAME == __FILE__
