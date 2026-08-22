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

# 1) Single-file browser ESM bundle (all @yura/* workspaces inlined, minified).
bun build packages/yura/src/index.ts --target=browser --format=esm --minify \
  --outfile="$OUT/dist/index.js"
# ./three subpath: everything it exports is re-exported by the main entry.
cat > "$OUT/dist/three.js" <<'EOF'
export {
  yuraLayer, YuraThreeLayer, composeSwarmCamera, glProjectionToWebGPU,
  fovAspectFromProjection, eyeFromView, worldPositionOf, YURA_SHAPE_RADIUS,
} from './index.js'
EOF
# ./react subpath: transpile ONLY the hook module (--external '*' leaves every
# import external), then repoint its './app' import at the main bundle so
# YuraApp stays one shared module instance instead of a duplicated bundle.
# The bare 'react' import ships as-is: the CONSUMER's bundler resolves it
# (react is an optional peer dependency, see the manifest below).
bun build packages/yura/src/react.ts --target=browser --format=esm --minify \
  --external '*' --outfile="$OUT/dist/react.js"
bun -e '
  const file = process.argv[1]
  const src = await Bun.file(file).text()
  const out = src.replace(/(["\x27])\.\/app\1/g, "$1./index.js$1")
  if (out === src) throw new Error("dist/react.js: no ./app import found to repoint")
  await Bun.write(file, out)
' "$OUT/dist/react.js"

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
    "./three": { "types": "./dist/three.d.ts", "default": "./dist/three.js" },
    "./react": { "types": "./types/yura/src/react.d.ts", "default": "./dist/react.js" }
  },
  "files": ["dist", "types", "README.md"],
  "dependencies": { "@webgpu/types": "^0.1.44" },
  "peerDependencies": { "react": ">=17" },
  "peerDependenciesMeta": { "react": { "optional": true } },
  "keywords": ["webgpu", "webgl2", "particles", "creative-coding", "visualization", "bun", "graphics", "animation", "kinetic-typography", "threejs"],
  "repository": { "type": "git", "url": "git+https://github.com/tacyan/Yura.js.git" },
  "homepage": "https://tacyan.github.io/Yura.js/",
  "bugs": "https://github.com/tacyan/Yura.js/issues"
}
EOF
sed -e "s|from 'yura'|from 'yurayura'|g" -e "s|from 'yura/three'|from 'yurayura/three'|g" \
  -e "s|from 'yura/react'|from 'yurayura/react'|g" \
  README.md > "$OUT/README.md"
cp LICENSE "$OUT/LICENSE"

# 4) Consumer smoke test: a synthetic consumer must type-check against dist-npm.
bun scripts/check-dist-types.ts "$OUT"

echo "dist-npm ready: $(du -sh "$OUT" | cut -f1) (dist/index.js $(ls -lh "$OUT/dist/index.js" | awk '{print $5}'), dist/react.js $(ls -lh "$OUT/dist/react.js" | awk '{print $5}'))"
