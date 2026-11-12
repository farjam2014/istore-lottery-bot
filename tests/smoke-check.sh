#!/usr/bin/env bash
set -euo pipefail
node --check src/index.js
node --check tests/unit-smoke.js
node tests/unit-smoke.js
