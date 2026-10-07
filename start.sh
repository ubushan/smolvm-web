#!/bin/sh
# smolvm-web launcher for macOS / Linux.
cd "$(dirname "$0")" && exec node server.js --autostart "$@"
