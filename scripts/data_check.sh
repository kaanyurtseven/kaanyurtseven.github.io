#!/usr/bin/env bash
# Checks the chain of data runs (.github/workflows/update-elia-data.yml) and the
# data the site serves, and repairs the chain when it has stopped. Run by
# elia-data-watch.yml (25 minutes after the chain last moved) and by the
# scheduled elia-chain-restart.yml.
#
#   bash scripts/data_check.sh repair   problems are written as warnings
#   bash scripts/data_check.sh alert    the first run that finds a problem fails,
#                                       so that GitHub notifies the owner; later
#                                       runs that find the same problem only warn
#
# Each run:
#   - cancels a data run that is still active 75 minutes after it was created
#     (a chained run is active for about 15, at most about 65);
#   - starts a data run when none is active; it runs at once and continues the
#     chain;
#   - checks the site's data, judged by the group that is furthest behind:
#     wind more than 60 minutes old, solar more than 20 hours old (solar is
#     measured in daylight only), or a file that cannot be read;
#   - while the data is current, checks for data runs that keep failing (at
#     least 4 in 2 hours, the newest one included).
# Needs GH_TOKEN (actions: write), GITHUB_REPOSITORY, RUNNER_TEMP, and CNAME and
# scripts/data_status.rb in the working directory.
set -uo pipefail

mode=${1:-repair}
runs="repos/$GITHUB_REPOSITORY/actions/workflows"
now=$(date -u +%s)
problem=""
since=0

# Adds a problem; since keeps the latest start among the current problems.
report() {
  problem="${problem:+$problem; }$1"
  if [ "$2" -gt "$since" ]; then since=$2; fi
}

iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# Data runs that have not finished, and runs held for approval:
# "id created_at conclusion" per line.
listed=1
if ! active=$(gh api -X GET "$runs/update-elia-data.yml/runs" -f per_page=30 --jq \
      '.workflow_runs[] | select(.status == "queued" or .status == "pending" or .status == "waiting" or .status == "requested" or .status == "in_progress" or .conclusion == "action_required") | "\(.id) \(.created_at) \(.conclusion // "-")"'); then
  echo "::warning title=Chain not checked::the data runs could not be listed"
  listed=0
  active=""
fi
live=0
while read -r id created conclusion; do
  [ -n "$id" ] || continue
  created_s=$(date -u -d "$created" +%s)
  if [ "$conclusion" = "action_required" ]; then
    report "data run $id is waiting for approval in the Actions tab" "$created_s"
    continue
  fi
  age=$(( now - created_s ))
  if [ "$age" -gt 4500 ]; then
    echo "::warning title=Stuck data run::run $id has been active for $(( age / 60 )) min: canceling it"
    gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/force-cancel" > /dev/null || true
  else
    live=$(( live + 1 ))
  fi
done <<< "$active"
if [ "$listed" -eq 1 ] && [ "$live" -eq 0 ]; then
  started=0
  for attempt in 1 2 3 4 5 6; do
    if timeout 45 gh workflow run update-elia-data.yml --repo "$GITHUB_REPOSITORY" --ref main; then
      started=1
      break
    fi
    if [ "$attempt" -lt 6 ]; then sleep 60; fi
  done
  if [ "$started" -eq 1 ]; then
    echo "No data run was active: started one, which continues the chain."
  else
    echo "::warning title=Chain not restarted::the workflow_dispatch request failed 6 times"
  fi
elif [ "$listed" -eq 1 ]; then
  echo "The chain is running ($live active data run(s))."
fi

site="https://$(tr -d '[:space:]' < CNAME)"
for spec in wind:60 solar:1200; do
  tech=${spec%%:*}
  limit=${spec##*:}
  file="$RUNNER_TEMP/$tech.json"
  if ! curl -fsS --max-time 30 --retry 3 --retry-delay 5 -o "$file" "$site/assets/data/$tech.json?t=$now"; then
    report "$site/assets/data/$tech.json could not be downloaded" $(( now - 21600 ))
  elif ! end=$(ruby scripts/data_status.rb end "$file"); then
    report "$site/assets/data/$tech.json could not be read" $(( now - 21600 ))
  elif [ "$end" -eq 0 ]; then
    report "a $tech group on the site has no measured value" $(( now - 21600 ))
  else
    age=$(( (now - end) / 60 ))
    echo "The site's $tech data is $age min old."
    if [ "$age" -gt "$limit" ]; then
      report "the site's $tech data is $age min old (limit $limit)" $(( end + limit * 60 - 900 ))
    fi
  fi
done

# Data runs that keep failing while the site's data is current (the state not
# saved, the chain stopped by its guard, the figures failing).
if [ -z "$problem" ] \
   && nfail=$(gh api -X GET "$runs/update-elia-data.yml/runs" -f status=failure \
                -f created=">=$(iso $(( now - 7200 )))" --jq .total_count) \
   && [ "${nfail:-0}" -ge 4 ] \
   && last=$(gh api -X GET "$runs/update-elia-data.yml/runs" -f status=completed -f per_page=1 \
               --jq '.workflow_runs[0].conclusion // ""') \
   && [ "$last" = "failure" ]; then
  report "$nfail data runs failed in the last 2 hours" $(( now - 21600 ))
fi

if [ -z "$problem" ]; then exit 0; fi
if [ "$mode" != "alert" ]; then
  echo "::warning title=Data problem::$problem"
  exit 0
fi
failed=$(gh api -X GET "$runs/elia-chain-restart.yml/runs" -f status=failure \
           -f created=">=$(iso "$since")" --jq .total_count) || failed=0
if [ "${failed:-0}" -gt 0 ]; then
  echo "::warning title=Data problem::$problem (already reported)"
  exit 0
fi
echo "::error title=Data problem::$problem"
exit 1
