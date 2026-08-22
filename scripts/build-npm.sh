#!/usr/bin/env bash
# Build the publishable `yurayura` package into dist-npm/.
#
#   bun run build:npm      # assemble dist-npm/
#   cd dist-npm && npm publish --access public
#
# The workspace keeps its internal name `yura`; only the published package
# is named `yurayura`. All @yura/* workspace deps are bundled into one ESM
# file, and TypeScript declarations ship as a self-contained tree with
# workspace imports rewritten to relative paths.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(bun -e "console.log(JSON.parse(await Bun.file('packages/yura/package.json').text()).version)")
OUT=dist-npm
rm -rf "$OUT"
mkdir -p "$OUT/dist"

# 1) Single-file browser ESM bundle (all @yura/* workspaces inlined).
bun build packages/yura/src/index.ts --target=browser --format=esm \
  --outfile="$OUT/dist/index.js"
# ./three subpath: everything it exports is re-exported by the main entry.
cat > "$OUT/dist/three.js" <<'EOF'
export {
  yuraLayer, YuraThreeLayer, composeSwarmCamera, glProjectionToWebGPU,
  fovAspectFromProjection, eyeFromView, worldPositionOf, YURA_SHAPE_RADIUS,
} from './index.js'
EOF

# 2) Type declarations: emit for every workspace, keep the tree, rewrite
#    @yura/* imports to relative paths so the tree is self-contained.
bunx tsc -p tsconfig.json --emitDeclarationOnly --declaration \
  --noEmit false --outDir "$OUT/.types-tmp"
mkdir -p "$OUT/types"
cp -R "$OUT/.types-tmp/packages/core" "$OUT/types/core"
cp -R "$OUT/.types-tmp/packages/renderer-webgpu" "$OUT/types/renderer-webgpu"
cp -R "$OUT/.types-tmp/packages/renderer-webgl" "$OUT/types/renderer-webgl"
cp -R "$OUT/.types-tmp/packages/yura" "$OUT/types/yura"
rm -rf "$OUT/.types-tmp"
# Portable rewrite (Linux/macOS): @yura/* -> relative paths, TypedArray
# generics stripped, and the @webgpu/types reference prepended to every
# yura/src entry d.ts (index, three, ...) so subpath imports compile too.
bun scripts/rewrite-dts.ts "$OUT/types"
cat > "$OUT/dist/three.d.ts" <<'EOF'
export * from '../types/yura/src/three'
EOF

# 3) Manifest, README (import specifier -> yurajs), LICENSE.
cat > "$OUT/package.json" <<EOF
{
  "name": "yurayura",
  "version": "$VERSION",
  "description": "Make the web move. Two lines, one million GPU particles — WebGPU-first visuals, games, lyric motion, and an optional Three.js layer.",
  "license": "MIT",
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./types/yura/src/index.d.ts",
  "exports": {
    ".": { "types": "./types/yura/src/index.d.ts", "default": "./dist/index.js" },
    "./three": { "types": "./dist/three.d.ts", "default": "./dist/three.js" }
  },
  "files": ["dist", "types", "README.md"],
  "dependencies": { "@webgpu/types": "^0.1.44" },
  "keywords": ["webgpu", "webgl2", "particles", "creative-coding", "visualization", "bun", "graphics", "animation", "kinetic-typography", "threejs"],
  "repository": { "type": "git", "url": "git+https://github.com/tacyan/Yura.js.git" },
  "homepage": "https://tacyan.github.io/Yura.js/",
  "bugs": "https://github.com/tacyan/Yura.js/issues"
}
EOF
sed -e "s|from 'yura'|from 'yurayura'|g" -e "s|from 'yura/three'|from 'yurayura/three'|g" \
  README.md > "$OUT/README.md"
cp LICENSE "$OUT/LICENSE"

echo "dist-npm ready: $(du -sh "$OUT" | cut -f1)"
