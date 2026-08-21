# Yura.js

**Make the web move.** Five lines. One million particles.

Yura.js is a visual-first WebGPU framework: cinematic GPU visuals for every
web developer, with safe defaults, automatic quality governance, and graceful
fallbacks. It is not a general 3D engine — it is the shortest path from an
empty `<div>` to a finished, beautiful, interactive picture.

```ts
import { yura } from 'yura'

yura('#hero')
  .preset('neon-galaxy')
  .interactive()
  .run()
```

Or render a glTF model with PBR + IBL — Three.js `webgl_loader_gltf`-class
output, one line, zero setup:

```ts
yura('#hero').model('/DamagedHelmet.glb').look('studio').interactive().run()
```

Or build a **playable 3D game with zero assets** — procedural PBR primitives,
physics, input, collisions, follow camera, HUD:

```ts
const scene = yura('#game').scene({ gravity: -22, bounds: 12 })
scene.add('plane', { size: 24, material: 'checker' })
const ball = scene.add('sphere', { radius: 0.45, material: 'chrome', body: 'dynamic', shadow: true })
scene.add('sphere', { radius: 0.26, material: materials.neon('#22d3ee'), tag: 'orb', position: [3, 1, 0] })
scene.camera.follow(ball)
scene.onUpdate((dt, input) => { ball.velocity[0] += input.x * 26 * dt })
ball.onCollide((o) => { if (o.tag === 'orb') o.remove() })
```

## Quick start

```sh
bun install
bun dev        # opens the hello example (1M-particle neon galaxy)
bun run showcase   # flagship demo — type a word, a million particles obey
bun run bench      # honest benchmarks vs Three.js, measured on YOUR machine
bun run dev:model  # glTF PBR demo (DamagedHelmet, drag to orbit)
bun run dev:game   # ORB RUSH — a complete game in ~45 lines, zero assets
bun test       # unit tests
bun run typecheck
```

Best with a WebGPU-capable browser (Chrome/Edge 113+, Safari 26+,
Firefox 141+). Without WebGPU, particles fall back to a WebGL2 renderer
(transform-feedback simulation, same HDR pipeline); without that, a static
poster — never a white screen.

## What works today (v0.1 prototype)

- **WebGPU compute particles** — up to 1,000,000 particles simulated on the
  GPU (attraction fields, flow noise, swirl, pointer forces).
- **WebGL2 fallback** — the same visual system on transform feedback +
  point sprites for browsers without WebGPU, selected automatically (or
  forced with `backend: 'webgl2'`).
- **Shape morphing** — galaxy → text → vortex transitions with turbulence
  boosts mid-flight. `shapes.text('YURA')`, `shapes.image(url)`,
  `shapes.galaxy()`, `shapes.vortex()`, and more. Shapes carry a palette
  coordinate, so gradients sweep across letters and spiral arms.
- **Light trails** — the HDR buffer accumulates with framerate-independent
  decay, turning every morph into a comet swarm.
- **HDR pipeline** — rgba16float scene target, threshold bloom, anamorphic
  streaks, chromatic aberration, ACES tonemapping, vignette, film grain.
- **Deep-space backdrop** — procedural FBM nebula tinted by your palette and
  a twinkling starfield, generated in-shader (zero assets).
- **Interaction** — hover repels particles; click detonates a shockwave.
- **glTF 2.0 / PBR** — `.model('/file.glb')` loads GLB (meshes, hierarchy,
  metallic-roughness materials, normal/emissive/occlusion maps) and renders
  Cook-Torrance GGX with IBL from a procedural studio environment cubemap
  (roughness-indexed mip chain, analytic env BRDF, no LUT, no HDR files).
  Every lit mesh casts and receives a 2048² key-light shadow map with PCF
  filtering. Drag to orbit with inertia, scroll to zoom, auto-rotate when
  idle.
- **Procedural 3D + game kit** — `.scene()` gives asset-free primitives
  (sphere, box, torus, torus knot, cylinder, plane) with curated PBR
  materials (`chrome`, `gold`, `obsidian`, `checker`, `materials.neon(hex)`,
  …), gravity/ground/bounds physics, sphere collisions with callbacks,
  solid push-out, keyboard input, a smoothed follow camera, DOM HUD text,
  and automatic blob shadows.
- **Looks** — `cinematic`, `cyberpunk`, `aurora`, `neon`, `studio` curated
  presets covering exposure, bloom, trails, streaks, nebula, and twinkle.
- **Quality governor** — steps resolution and particle count under frame
  budget pressure, and climbs back when there is headroom (with probe
  backoff, vsync-aware thresholds, and hitch rejection so a GC pause never
  costs you quality). Surviving particles are intensity-compensated so
  governed frames keep the same light on screen.
- **Runtime morphing** — `app.morphNow('ANY WORD')` flies the running swarm
  into new text or any shape, mid-flight interruptions included.
- **Web-native behavior** — `prefers-reduced-motion` renders a settled static
  frame; the loop pauses offscreen and on hidden tabs; device-lost recovers.
- **Stable error codes** — every failure is a `YURA-xxx` with a fix snippet.

## Packages

| Package | Role |
| --- | --- |
| `yura` | Public chainable API, shapes, looks, presets |
| `@yura/core` | Math, capability detection, quality governor, lifecycle |
| `@yura/renderer-webgpu` | Compute simulation + HDR render pipeline |
| `@yura/renderer-webgl` | WebGL2 fallback: transform-feedback sim, same HDR post |

## Benchmarks & showcase

- `bun run showcase` — the flagship demo. One million particles, live look
  switching, and a prompt: type any word and the swarm forms it.
  `?backend=webgl2` forces the fallback renderer for comparison.
- `bun run bench` — honest, reproducible numbers measured in your browser:
  Yura (WebGPU and WebGL2, full HDR pipeline) against Three.js (typical
  CPU-simulated points and a hand-written GPU vertex path, both with no
  post-processing). Methodology and caveats are printed on the page;
  export to JSON or a Markdown table.

## Roadmap

Playground + share/fork (Hono), capture to MP4/WebM, framework adapters
(React/Vue/Svelte/Astro), golden-image CI.
See the product specification for the full 90-day plan.

## License

MIT
