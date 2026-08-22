#!/usr/bin/env bash
# Build the static demo site (GitHub Pages payload).
# Usage: bash scripts/build-site.sh [outdir]   (default: _site)
# Single source of truth for the demo build — pages.yml and ci.yml both call this.
set -euo pipefail

out="${1:-_site}"

# Run from the repository root so relative paths work from anywhere.
cd -- "$(dirname -- "$0")/.."

bun build apps/showcase/index.html   --outdir="$out"/showcase --minify
bun build examples/lyrics/index.html --outdir="$out"/lyrics   --minify
bun build examples/hello/index.html  --outdir="$out"/hello    --minify
bun build examples/model/index.html  --outdir="$out"/model    --minify
bun build examples/game/index.html   --outdir="$out"/game     --minify
cp apps/site/index.html "$out"/index.html
