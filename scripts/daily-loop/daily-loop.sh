#!/bin/bash
# scripts/daily-loop/daily-loop.sh — launchd entry point for the recurring engineering loop.
# Wraps run.mjs so launchd only needs one fixed path + a sane PATH/HOME env (launchd jobs get a
# minimal environment by default — node/claude/gh must be reachable explicitly).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/cjay1107/.local/bin:/usr/bin:/bin"
export HOME="/Users/cjay1107"
cd "/Users/cjay1107/Desktop/clawd-local/Clawd Projects/sizmo-ghl-cli"
exec node scripts/daily-loop/run.mjs
