#!/usr/bin/env zsh
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.kiro-connect.agent.plist"

launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Kiro Connect LaunchAgent removed."
