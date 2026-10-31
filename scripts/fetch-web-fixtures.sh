#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$project_dir/scripts/fetch-web-fixtures.mjs" "$@"
