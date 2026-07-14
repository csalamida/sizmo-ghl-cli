#!/bin/bash
# scripts/daily-loop/daily-loop.sh — launchd entry point for the recurring engineering loop.
# Wraps run.mjs so launchd only needs one fixed path + a sane PATH/HOME env (launchd jobs get a
# minimal environment by default — node/claude/gh must be reachable explicitly).
#
# Self-locating, not hardcoded to one machine path — verified live 2026-07-15: the daemon's own
# clone lives OUTSIDE ~/Desktop on purpose (see below), and this same file also ships inside CJ's
# normal Desktop-nested working copy via git, so it must resolve correctly from either.
#
# Self-updates via git before each run — CJ's interactive copy gets fixes/improvements the moment
# they're pushed; the daemon's dedicated clone would otherwise run whatever version it was cloned
# from forever. reset --hard is safe here specifically because this clone is daemon-owned and never
# has local edits of its own — never do this to an interactive working copy.
#
# WHY a separate clone at all: launchd LaunchAgents run in a background daemon context that has
# never been granted macOS's Full Disk Access / Desktop-folder TCC permission — there is no UI
# moment for an unattended daemon to be prompted for it. A daemon trying to touch a real, physical
# ~/Desktop-nested path (this repo's normal home, since that's the correct place for CJ's
# interactive work per his own CLAUDE.md) gets silently, invisibly denied: no error in any log,
# no Discord ping, nothing — exactly the symptom that showed up here (runs=2 lifetime per
# `launchctl print`, both from manual testing, zero real scheduled fires in 9 days). Confirmed via
# `readlink -f ~/Desktop/clawd-local` returning a real physical path, not a symlink elsewhere.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/cjay1107/.local/bin:/usr/bin:/bin"
export HOME="/Users/cjay1107"
cd "$(dirname "$0")/../.."
git fetch origin main
git reset --hard origin/main
exec node scripts/daily-loop/run.mjs
